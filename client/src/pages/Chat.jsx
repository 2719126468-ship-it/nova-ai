import { Children, isValidElement, useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CirclePlus, Copy, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, Pencil, RefreshCw, Send, Sparkles, Square, Trash2, UserRound } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api, apiStream, json } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ErrorNotice, Loading } from '../components/UI';

function extractCodeText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(extractCodeText).join('');
  if (isValidElement(value)) return extractCodeText(value.props.children);
  return '';
}

function MarkdownCodeBlock({ children }) {
  const codeNode = Children.toArray(children).find(isValidElement);
  const codeChildren = codeNode?.props?.children ?? children;
  const className = codeNode?.props?.className || '';
  const language = className.match(/(?:^|\\s)language-([a-z0-9_-]+)/i)?.[1] || '';
  const codeText = extractCodeText(codeChildren);
  const [copyState, setCopyState] = useState('idle');
  const copyTimer = useRef(null);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  async function copyCode() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(codeText);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1600);
  }

  const languageLabel = language ? language.toUpperCase() : 'CODE';
  return <div className="markdown-code-block">
    <div className="markdown-code-toolbar">
      <span className="markdown-code-language">{languageLabel}</span>
      <button type="button" className="markdown-code-copy" onClick={copyCode}
        aria-label={copyState === 'copied' ? '代码已复制' : '复制代码块'}
        title={copyState === 'failed' ? '复制失败，请检查浏览器剪贴板权限' : '复制代码'}>
        {copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
        <span>{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制代码'}</span>
      </button>
    </div>
    <pre><code className={className}>{codeChildren}</code></pre>
  </div>;
}

export default function Chat() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const requestedConversationId = searchParams.get('conversation');
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modelInfo, setModelInfo] = useState(null);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [copiedMessageId, setCopiedMessageId] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const endRef = useRef(null);
  const abortRef = useRef(null);
  const pendingSequence = useRef(0);

  const loadConversations = useCallback(async () => {
    const data = await api('/api/v1/conversations');
    setConversations(data.conversations);
    return data.conversations;
  }, []);
  const openConversation = useCallback(async (id) => {
    abortRef.current?.abort();
    setActiveId(id);
    setEditingMessageId(null);
    setDraft('');
    setError('');
    const data = await api('/api/v1/conversations/' + id);
    setMessages(data.messages);
  }, []);
  useEffect(() => {
    loadConversations().then((items) => {
      const requestedId = Number(requestedConversationId);
      const requested = items.find((item) => item.id === requestedId);
      if (requested) return openConversation(requested.id);
      if (items.length) return openConversation(items[0].id);
      setMessages([]);
    }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [loadConversations, openConversation, requestedConversationId]);
  useEffect(() => { api('/api/v1/models').then((data) => { setModelInfo(data); setSelectedModelId(data.defaultModelId || ''); }).catch(() => setModelInfo(null)); }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, sending]);

  async function createConversation() {
    abortRef.current?.abort();
    try {
      const data = await api('/api/v1/conversations', { method: 'POST', body: json({ title: '新对话' }) });
      await loadConversations();
      await openConversation(data.conversation.id);
      setEditingMessageId(null);
      setDraft('');
    } catch (e) { setError(e.message); }
  }
  async function deleteConversation(id, event) {
    event.stopPropagation();
    if (!window.confirm('删除这段对话？此操作无法撤销。')) return;
    if (activeId === id) abortRef.current?.abort();
    try {
      await api('/api/v1/conversations/' + id, { method: 'DELETE' });
      const items = await loadConversations();
      if (activeId === id) {
        if (items.length) await openConversation(items[0].id);
        else { setActiveId(null); setMessages([]); }
      }
    } catch (e) { setError(e.message); }
  }
  async function renameConversation(id, event) {
    event.stopPropagation();
    const current = conversations.find((conversation) => conversation.id === id);
    const proposed = window.prompt('为这段对话设置新标题', current?.title || '新对话');
    if (proposed === null) return;
    const title = proposed.trim();
    if (!title) {
      setError('对话标题不能为空。');
      return;
    }
    try {
      const data = await api('/api/v1/conversations/' + id, {
        method: 'PATCH',
        body: json({ title }),
      });
      setConversations((items) => items.map((item) => item.id === id
        ? { ...item, title: data.conversation.title, updated_at: data.conversation.updated_at }
        : item));
    } catch (e) {
      setError(e.message);
    }
  }

  async function copyMessage(message) {
    try {
      await navigator.clipboard.writeText(message.content || '');
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId((current) => current === message.id ? null : current), 1200);
    } catch {
      setError('复制失败。请检查浏览器剪贴板权限，或手动选择文本复制。');
    }
  }

  function beginEditMessage(message) {
    if (sending || message.role !== 'user') return;
    setEditingMessageId(message.id);
    setDraft(message.content || '');
    setError('');
  }

  function cancelEditMessage() {
    setEditingMessageId(null);
    setDraft('');
  }

  async function submitMessage(contentValue, editId = null, retryId = null) {
    const content = contentValue.trim();
    if (!content || sending) return;
    if (editId && !activeId) {
      setError('请先打开这条消息所在的对话。');
      return;
    }

    setError('');
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const pendingId = 'pending-assistant-' + (++pendingSequence.current);
    let completed = false;
    const isEditing = Boolean(editId);
    const isRetry = Boolean(retryId);

    try {
      let conversationId = activeId;
      if (!conversationId && !editId) {
        const created = await api('/api/v1/conversations', { method: 'POST', body: json({ title: content.slice(0, 42) }) });
        conversationId = created.conversation.id;
        setActiveId(conversationId);
        setMessages([]);
        await loadConversations();
      }

      const streamPath = editId
        ? '/api/v1/conversations/' + conversationId + '/messages/' + editId + '/stream'
        : retryId
          ? '/api/v1/conversations/' + conversationId + '/messages/' + retryId + '/retry/stream'
          : '/api/v1/conversations/' + conversationId + '/messages/stream';
      for await (const packet of apiStream(streamPath, {
        method: editId ? 'PUT' : 'POST',
        body: json({ content, ...(selectedModelId ? { modelId: selectedModelId } : {}) }),
        signal: controller.signal,
      })) {
        if (packet.event === 'message_start') {
          if (editId) {
            setMessages((current) => {
              const targetIndex = current.findIndex((message) => String(message.id) === String(editId));
              const retained = targetIndex < 0 ? current : current.slice(0, targetIndex + 1);
              const updated = retained.map((message) => String(message.id) === String(editId)
                ? packet.data.userMessage
                : message);
              return [...updated, { id: pendingId, role: 'assistant', content: '', status: 'streaming' }];
            });
            setEditingMessageId(null);
          } else if (retryId) {
            setMessages((current) => {
              const targetIndex = current.findIndex((message) => String(message.id) === String(retryId));
              const retained = targetIndex < 0 ? current : current.slice(0, targetIndex);
              return [...retained, { id: pendingId, role: 'assistant', content: '', status: 'streaming' }];
            });
          } else {
            setMessages((current) => [...current, packet.data.userMessage, { id: pendingId, role: 'assistant', content: '', status: 'streaming' }]);
          }
        } else if (packet.event === 'message_delta') {
          const delta = packet.data?.delta || '';
          if (delta) {
            setMessages((current) => current.map((message) => message.id === pendingId
              ? { ...message, content: message.content + delta }
              : message));
          }
        } else if (packet.event === 'message_complete') {
          completed = true;
          setMessages((current) => current.map((message) => message.id === pendingId ? packet.data.assistantMessage : message));
          setEditingMessageId(null);
          if (!isRetry) setDraft('');
          await loadConversations();
        } else if (packet.event === 'message_error' || packet.event === 'message_cancelled') {
          completed = true;
          const cancelled = packet.event === 'message_cancelled';
          setError(packet.data?.message || (cancelled ? '生成已取消。' : '模型服务暂时无法完成请求。'));
          if (isEditing || isRetry) {
            const latest = await api('/api/v1/conversations/' + conversationId);
            setMessages(latest.messages);
            if (isEditing) {
              setEditingMessageId(editId);
              setDraft(content);
            }
          } else {
            setMessages((current) => current.map((message) => message.id === pendingId
              ? { ...message, status: cancelled ? 'cancelled' : 'failed', error_code: packet.data?.code || null }
              : message));
          }
        }
      }
    } catch (e) {
      if (e.name === 'AbortError' && (isEditing || isRetry)) {
        try {
          await new Promise((resolve) => window.setTimeout(resolve, 120));
          const latest = await api('/api/v1/conversations/' + activeId);
          setMessages(latest.messages);
          if (isEditing) {
            setEditingMessageId(editId);
            setDraft(content);
          }
        } catch {
          setError('已停止生成；原对话会在下次打开时重新同步。');
        }
      } else if (e.name === 'AbortError') {
        setMessages((current) => current.map((message) => message.id === pendingId
          ? { ...message, status: 'cancelled', error_code: 'AI_REQUEST_CANCELLED' }
          : message));
      } else {
        setMessages((current) => current.filter((message) => message.id !== pendingId));
      }
      if (e.name !== 'AbortError') {
        setError(e.code === 'AI_PROVIDER_NOT_CONFIGURED'
          ? 'NOVA 的模型接口尚未配置。当前输入没有生成虚假回答；请配置服务端 AI_BASE_URL、AI_API_KEY 和 AI_MODEL 后重试。'
          : e.message);
      }
    } finally {
      if (!completed && !controller.signal.aborted) setMessages((current) => current.filter((message) => message.id !== pendingId));
      if (abortRef.current === controller) abortRef.current = null;
      setSending(false);
    }
  }

  function sendMessage(event) {
    event.preventDefault();
    void submitMessage(draft, editingMessageId);
  }

  function regenerateMessage(userMessage) {
    if (!userMessage?.id || sending) return;
    void submitMessage(userMessage.content || '', userMessage.id);
  }

  function retryMessage(message, userMessage) {
    if (!message?.id || !userMessage?.id || sending) return;
    void submitMessage(userMessage.content || '', null, message.id);
  }

  const selectableModels = modelInfo?.models?.filter((model) => model.selectable) || [];
  const selectedModel = selectableModels.find((model) => model.id === selectedModelId)
    || selectableModels.find((model) => model.id === modelInfo?.defaultModelId)
    || null;
  const modelName = selectedModel?.name || (modelInfo ? '模型未配置' : 'NOVA Intelligence');

  return <main className={'chat-workspace ' + (sidebarOpen ? '' : 'chat-sidebar-hidden')}>
    <aside className="chat-sidebar">
      <div className="chat-sidebar-head"><span>WORKSPACE</span><button className="icon-button" onClick={() => setSidebarOpen(false)} aria-label="收起侧边栏"><PanelLeftClose size={17} /></button></div>
      <button className="new-chat-button" onClick={createConversation}><CirclePlus size={17} /> 新建对话 <span>⌘ K</span></button>
      <div className="chat-history-label">最近对话</div>
      <div className="chat-history-list">{conversations.map((conversation) => <div key={conversation.id} className={'history-row ' + (activeId === conversation.id ? 'active' : '')}><button className="history-item" onClick={() => openConversation(conversation.id)}><MessageSquare size={15} /><span>{conversation.title || '新对话'}</span></button><button className="history-rename" aria-label="重命名对话" title="重命名" onClick={(event) => renameConversation(conversation.id, event)}><Pencil size={13} /></button><button className="history-delete" aria-label="删除对话" onClick={(event) => deleteConversation(conversation.id, event)}><Trash2 size={13} /></button></div>)}
        {!conversations.length && !loading && <div className="history-empty">还没有对话记录。<br />创建一个新对话开始探索。</div>}
      </div>
      <div className="chat-sidebar-bottom"><div className="chat-user-avatar">{user?.name?.slice(0, 1) || 'N'}</div><div><strong>{user?.name}</strong><span>个人工作区</span></div><MoreHorizontal size={17} /></div>
    </aside>
    <section className="chat-main">
      <div className="chat-topbar"><div className="chat-topbar-left">{!sidebarOpen && <button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="展开侧边栏"><Menu size={18} /></button>}<div className="chat-model-badge"><span className="model-spark">✳</span>{selectableModels.length ? <select className="chat-model-select" aria-label="选择模型" value={selectedModel?.id || ''} onChange={(event) => setSelectedModelId(event.target.value)} disabled={sending}>{selectableModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select> : <strong>{modelName}</strong>}<ChevronDown size={14} /></div><span className="chat-beta">PREVIEW</span></div><button className="chat-top-action" onClick={createConversation}><CirclePlus size={15} /> 新对话</button></div>
      <div className="chat-scroll-area">{loading ? <Loading label="正在加载对话…" /> : messages.length === 0 ? <div className="chat-welcome"><div className="chat-welcome-symbol">✳</div><span className="chat-welcome-overline">NOVA INTELLIGENCE</span><h1>你好，{user?.name || '探索者'}。<br /><span>今天想从哪里开始？</span></h1><p>写下一个问题、一个想法，或者你正在尝试解决的事情。</p><div className="prompt-suggestions"><button onClick={() => setDraft('帮我把一个复杂想法拆解成可以执行的步骤。')}>⌁ <span>拆解一个复杂问题</span></button><button onClick={() => setDraft('帮我梳理一个新产品的定位和核心功能。')}>✳ <span>构思一个新产品</span></button><button onClick={() => setDraft('解释一个我最近正在学习的技术概念。')}>⌘ <span>理解一个技术概念</span></button></div></div> : <div className="message-thread">{messages.map((message, index) => <div className={'chat-message chat-message-' + message.role} key={message.id || (message.role + '-' + index)}><div className="message-avatar">{message.role === 'assistant' ? <span>✳</span> : <UserRound size={16} />}</div><div className="message-content"><div className="message-author">{message.role === 'assistant' ? 'NOVA' : user?.name || '你'}</div>{message.status && message.status !== 'complete' && <div className={'message-status message-status-' + message.status}>{message.status === 'streaming' ? '正在生成' : message.status === 'cancelled' ? '已停止生成' : '生成失败'}</div>}<div className="message-actions"><button type="button" onClick={() => copyMessage(message)} aria-label="复制消息" title="复制消息">{copiedMessageId === message.id ? <Check size={13} /> : <Copy size={13} />}<span>{copiedMessageId === message.id ? '已复制' : '复制'}</span></button>{!sending && message.role === 'user' && <button type="button" onClick={() => beginEditMessage(message)} aria-label="编辑消息" title="编辑消息"><Pencil size={13} /><span>编辑</span></button>}{!sending && index === messages.length - 1 && message.status === 'complete' && message.role === 'assistant' && messages[index - 1]?.role === 'user' && <button type="button" onClick={() => regenerateMessage(messages[index - 1])} aria-label="重新生成" title="重新生成"><RefreshCw size={13} /><span>重新生成</span></button>}{!sending && index === messages.length - 1 && message.role === 'assistant' && ['failed', 'cancelled'].includes(message.status) && messages[index - 1]?.role === 'user' && <button type="button" onClick={() => retryMessage(message, messages[index - 1])} aria-label="重试回答" title="重试回答"><RefreshCw size={13} /><span>重试</span></button>}</div><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ pre: MarkdownCodeBlock }}>{message.content}</ReactMarkdown></div></div></div>)}<div ref={endRef} /></div>}</div>
      <div className="chat-composer-wrap"><ErrorNotice>{error}</ErrorNotice><form className="chat-composer" onSubmit={sendMessage}>{editingMessageId && <div className="composer-edit-hint">重新生成成功后，会删除这条消息后面的对话内容；失败或停止会保留原对话。</div>}<textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={editingMessageId ? '编辑消息并重新生成…' : '向 NOVA 发送消息…'} rows={1} disabled={sending} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e); } }} /><div className="composer-bottom"><span><Sparkles size={13} /> {selectedModel?.configured && selectedModel?.status === 'unknown' ? '模型已配置 · 上游状态未验证' : selectedModel ? '已选择模型 · 上游状态未知' : '模型服务由服务器配置'}</span>{editingMessageId && !sending && <button className="composer-cancel" type="button" onClick={cancelEditMessage}>取消编辑</button>}{sending ? <button type="button" onClick={stopGeneration} aria-label="停止生成"><Square size={15} /></button> : <button type="submit" disabled={!draft.trim()} aria-label="发送消息"><Send size={17} /></button>}</div></form><div className="chat-disclaimer">NOVA 可能会出错。重要信息请自行核实。模型未配置时不会生成虚假回答。</div></div>
    </section>
  </main>;
}
