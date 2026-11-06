import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, CirclePlus, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, Send, Sparkles, Square, Trash2, UserRound } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, apiStream, json } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ErrorNotice, Loading } from '../components/UI';

const messageStatusLabel = {
  streaming: '生成中…',
  failed: '生成失败 · 部分内容已保留',
  cancelled: '已停止 · 部分内容已保留',
};

export default function Chat() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modelInfo, setModelInfo] = useState(null);
  const endRef = useRef(null);
  const abortRef = useRef(null);
  const activeIdRef = useRef(null);
  const pendingSequence = useRef(0);

  const loadConversations = useCallback(async () => {
    const data = await api('/api/v1/conversations');
    setConversations(data.conversations);
    return data.conversations;
  }, []);

  const openConversation = useCallback(async (id) => {
    abortRef.current?.abort();
    activeIdRef.current = id;
    setActiveId(id);
    setError('');
    const data = await api('/api/v1/conversations/' + id);
    if (activeIdRef.current === id) setMessages(data.messages);
  }, []);

  useEffect(() => {
    loadConversations().then((items) => {
      if (items.length) return openConversation(items[0].id);
      activeIdRef.current = null;
      setMessages([]);
    }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [loadConversations, openConversation]);

  useEffect(() => {
    api('/api/v1/models').then(setModelInfo).catch(() => setModelInfo(null));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, sending]);

  async function createConversation() {
    abortRef.current?.abort();
    try {
      const data = await api('/api/v1/conversations', {
        method: 'POST', body: json({ title: '新对话' }),
      });
      await loadConversations();
      await openConversation(data.conversation.id);
      setDraft('');
    } catch (e) { setError(e.message); }
  }

  async function deleteConversation(id, event) {
    event.stopPropagation();
    if (!window.confirm('删除这段对话？此操作无法撤销。')) return;
    if (activeIdRef.current === id) abortRef.current?.abort();
    try {
      await api('/api/v1/conversations/' + id, { method: 'DELETE' });
      const items = await loadConversations();
      if (activeIdRef.current === id) {
        if (items.length) await openConversation(items[0].id);
        else {
          activeIdRef.current = null;
          setActiveId(null);
          setMessages([]);
        }
      }
    } catch (e) { setError(e.message); }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;

    setError('');
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const pendingKey = 'pending-assistant-' + (++pendingSequence.current);
    let conversationId = activeIdRef.current;
    let assistantMessageId = null;
    let terminalEventReceived = false;

    try {
      if (!conversationId) {
        const created = await api('/api/v1/conversations', {
          method: 'POST', body: json({ title: content.slice(0, 42) }),
        });
        conversationId = created.conversation.id;
        activeIdRef.current = conversationId;
        setActiveId(conversationId);
        setMessages([]);
        await loadConversations();
      }

      for await (const packet of apiStream('/api/v1/conversations/' + conversationId + '/messages/stream', {
        body: json({ content, modelId: modelInfo?.defaultModelId || undefined }),
        signal: controller.signal,
      })) {
        if (packet.event === 'message_start') {
          assistantMessageId = packet.data.assistantMessageId;
          if (activeIdRef.current === conversationId) {
            setMessages((current) => [
              ...current,
              packet.data.userMessage,
              { id: assistantMessageId, role: 'assistant', content: '', status: 'streaming' },
            ]);
          }
        } else if (packet.event === 'message_delta') {
          const delta = packet.data?.delta || '';
          if (activeIdRef.current === conversationId && delta) {
            setMessages((current) => current.map((message) => message.id === assistantMessageId
              ? { ...message, content: message.content + delta, status: 'streaming' }
              : message));
          }
        } else if (packet.event === 'message_complete') {
          terminalEventReceived = true;
          if (activeIdRef.current === conversationId) {
            setMessages((current) => current.map((message) => message.id === assistantMessageId
              ? packet.data.assistantMessage
              : message));
            setDraft('');
            await loadConversations();
          }
        } else if (packet.event === 'message_error') {
          terminalEventReceived = true;
          if (activeIdRef.current === conversationId) {
            setMessages((current) => current.map((message) => message.id === packet.data.messageId
              ? { ...message, status: 'failed', error_code: packet.data.code }
              : message));
            setError(packet.data.message || '模型服务暂时无法完成请求。');
          }
        } else if (packet.event === 'message_cancelled') {
          terminalEventReceived = true;
          if (activeIdRef.current === conversationId) {
            setMessages((current) => current.map((message) => message.id === packet.data.messageId
              ? { ...message, status: 'cancelled', error_code: packet.data.code }
              : message));
          }
        }
      }

      if (!terminalEventReceived && !controller.signal.aborted) {
        throw new Error('流式连接意外结束，消息状态尚未确认。');
      }
    } catch (e) {
      if (activeIdRef.current === conversationId) {
        if (assistantMessageId) {
          setMessages((current) => current.map((message) => message.id === assistantMessageId
            ? { ...message, status: 'cancelled' }
            : message));
        }
        if (e.name !== 'AbortError' && !controller.signal.aborted) {
          setError(e.code === 'AI_PROVIDER_NOT_CONFIGURED'
            ? 'NOVA 的模型接口尚未配置。当前输入没有生成虚假回答；请配置服务端 AI_BASE_URL、AI_API_KEY 和 AI_MODEL 后重试。'
            : e.message);
        }
      }
    } finally {
      if (activeIdRef.current === conversationId && conversationId) {
        try {
          const latest = await api('/api/v1/conversations/' + conversationId);
          setMessages(latest.messages);
        } catch {
          // Keep the last streamed UI state if history cannot be refreshed.
        }
      }
      if (abortRef.current === controller) abortRef.current = null;
      setSending(false);
      if (terminalEventReceived || controller.signal.aborted) loadConversations().catch(() => {});
    }
  }

  function stopGeneration() { abortRef.current?.abort(); }

  const modelName = modelInfo?.models?.[0]?.name || (modelInfo ? '模型未配置' : 'NOVA Intelligence');
  const modelStatusText = modelInfo?.configured
    ? '模型已配置 · 上游状态未验证'
    : '模型服务尚未配置';

  return <main className={'chat-workspace ' + (sidebarOpen ? '' : 'chat-sidebar-hidden')}>
    <aside className="chat-sidebar">
      <div className="chat-sidebar-head"><span>WORKSPACE</span><button className="icon-button" onClick={() => setSidebarOpen(false)} aria-label="收起侧边栏"><PanelLeftClose size={17} /></button></div>
      <button className="new-chat-button" onClick={createConversation}><CirclePlus size={17} /> 新建对话 <span>⌘ K</span></button>
      <div className="chat-history-label">最近对话</div>
      <div className="chat-history-list">
        {conversations.map((conversation) => <div key={conversation.id} className={'history-row ' + (activeId === conversation.id ? 'active' : '')}>
          <button className="history-item" onClick={() => openConversation(conversation.id)}><MessageSquare size={15} /><span>{conversation.title || '新对话'}</span></button>
          <button className="history-delete" aria-label="删除对话" onClick={(event) => deleteConversation(conversation.id, event)}><Trash2 size={13} /></button>
        </div>)}
        {!conversations.length && !loading && <div className="history-empty">还没有对话记录。<br />创建一个新对话开始探索。</div>}
      </div>
      <div className="chat-sidebar-bottom"><div className="chat-user-avatar">{user?.name?.slice(0, 1) || 'N'}</div><div><strong>{user?.name}</strong><span>个人工作区</span></div><MoreHorizontal size={17} /></div>
    </aside>
    <section className="chat-main">
      <div className="chat-topbar">
        <div className="chat-topbar-left">
          {!sidebarOpen && <button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="展开侧边栏"><Menu size={18} /></button>}
          <div className="chat-model-badge"><span className="model-spark">✳</span><strong>{modelName}</strong><ChevronDown size={14} /></div>
          <span className="chat-beta">PREVIEW</span>
        </div>
        <button className="chat-top-action" onClick={createConversation}><CirclePlus size={15} /> 新对话</button>
      </div>
      <div className="chat-scroll-area">
        {loading ? <Loading label="正在加载对话…" /> : messages.length === 0
          ? <div className="chat-welcome">
              <div className="chat-welcome-symbol">✳</div><span className="chat-welcome-overline">NOVA INTELLIGENCE</span>
              <h1>你好，{user?.name || '探索者'}。<br /><span>今天想从哪里开始？</span></h1>
              <p>写下一个问题、一个想法，或者你正在尝试解决的事情。</p>
              <div className="prompt-suggestions">
                <button onClick={() => setDraft('帮我把一个复杂想法拆解成可以执行的步骤。')}>⌁ <span>拆解一个复杂问题</span></button>
                <button onClick={() => setDraft('帮我梳理一个新产品的定位和核心功能。')}>✳ <span>构思一个新产品</span></button>
                <button onClick={() => setDraft('解释一个我最近正在学习的技术概念。')}>⌘ <span>理解一个技术概念</span></button>
              </div>
            </div>
          : <div className="message-thread">
              {messages.map((message, index) => <div className={'chat-message chat-message-' + message.role} key={message.id || (message.role + '-' + index)}>
                <div className="message-avatar">{message.role === 'assistant' ? <span>✳</span> : <UserRound size={16} />}</div>
                <div className="message-content">
                  <div className="message-author">{message.role === 'assistant' ? 'NOVA' : user?.name || '你'}</div>
                  <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
                  {message.role === 'assistant' && message.status && message.status !== 'complete' && <div className={'message-status message-status-' + message.status}>{messageStatusLabel[message.status] || message.status}</div>}
                </div>
              </div>)}
              <div ref={endRef} />
            </div>}
      </div>
      <div className="chat-composer-wrap">
        <ErrorNotice>{error}</ErrorNotice>
        <form className="chat-composer" onSubmit={sendMessage}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="向 NOVA 发送消息…" rows={1} disabled={sending} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e); } }} />
          <div className="composer-bottom">
            <span><Sparkles size={13} /> {modelStatusText}</span>
            {sending
              ? <button type="button" onClick={stopGeneration} aria-label="停止生成"><Square size={15} /></button>
              : <button type="submit" disabled={!draft.trim()} aria-label="发送消息"><Send size={17} /></button>}
          </div>
        </form>
        <div className="chat-disclaimer">NOVA 可能会出错。重要信息请自行核实。模型未配置时不会生成虚假回答。</div>
      </div>
    </section>
  </main>;
}
