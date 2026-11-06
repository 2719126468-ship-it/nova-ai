import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, CirclePlus, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, Send, Sparkles, Trash2, UserRound } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, json } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ErrorNotice, Loading } from '../components/UI';

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
  const endRef = useRef(null);
  const activeConversation = conversations.find((item) => item.id === activeId);

  const loadConversations = useCallback(async () => {
    const data = await api('/api/conversations');
    setConversations(data.conversations);
    return data.conversations;
  }, []);
  const openConversation = useCallback(async (id) => {
    setActiveId(id); setError('');
    const data = await api(`/api/conversations/${id}`);
    setMessages(data.messages);
  }, []);
  useEffect(() => {
    loadConversations().then((items) => {
      if (items.length) return openConversation(items[0].id);
      setMessages([]);
    }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [loadConversations, openConversation]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages, sending]);

  async function createConversation() {
    try {
      const data = await api('/api/conversations', { method: 'POST', body: json({ title: '新对话' }) });
      await loadConversations();
      await openConversation(data.conversation.id);
      setDraft('');
    } catch (e) { setError(e.message); }
  }
  async function deleteConversation(id, event) {
    event.stopPropagation();
    if (!window.confirm('删除这段对话？此操作无法撤销。')) return;
    try {
      await api(`/api/conversations/${id}`, { method: 'DELETE' });
      const items = await loadConversations();
      if (activeId === id) {
        if (items.length) await openConversation(items[0].id);
        else { setActiveId(null); setMessages([]); }
      }
    } catch (e) { setError(e.message); }
  }
  async function sendMessage(event) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    setError(''); setSending(true);
    try {
      let conversationId = activeId;
      if (!conversationId) {
        const created = await api('/api/conversations', { method: 'POST', body: json({ title: content.slice(0, 42) }) });
        conversationId = created.conversation.id;
        setActiveId(conversationId);
      }
      const result = await api(`/api/conversations/${conversationId}/messages`, { method: 'POST', body: json({ content }) });
      setMessages((current) => [...current, result.userMessage, result.assistantMessage]);
      setDraft('');
      await loadConversations();
    } catch (e) {
      setError(e.code === 'AI_PROVIDER_NOT_CONFIGURED' ? 'NOVA 的模型接口尚未配置。你输入的内容没有被提交，也没有生成虚构回答；请配置服务端 AI_BASE_URL、AI_API_KEY 和 AI_MODEL 后重试。' : e.message);
    } finally { setSending(false); }
  }

  return <main className={`chat-workspace ${sidebarOpen ? '' : 'chat-sidebar-hidden'}`}>
    <aside className="chat-sidebar">
      <div className="chat-sidebar-head"><span>WORKSPACE</span><button className="icon-button" onClick={() => setSidebarOpen(false)} aria-label="收起侧边栏"><PanelLeftClose size={17} /></button></div>
      <button className="new-chat-button" onClick={createConversation}><CirclePlus size={17} /> 新建对话 <span>⌘ K</span></button>
      <div className="chat-history-label">最近对话</div>
      <div className="chat-history-list">{conversations.map((conversation) => <div key={conversation.id} className={`history-row ${activeId === conversation.id ? 'active' : ''}`}><button className="history-item" onClick={() => openConversation(conversation.id)}><MessageSquare size={15} /><span>{conversation.title || '新对话'}</span></button><button className="history-delete" aria-label="删除对话" onClick={(event) => deleteConversation(conversation.id, event)}><Trash2 size={13} /></button></div>)}
        {!conversations.length && !loading && <div className="history-empty">还没有对话记录。<br />创建一个新对话开始探索。</div>}
      </div>
      <div className="chat-sidebar-bottom"><div className="chat-user-avatar">{user?.name?.slice(0, 1) || 'N'}</div><div><strong>{user?.name}</strong><span>个人工作区</span></div><MoreHorizontal size={17} /></div>
    </aside>
    <section className="chat-main">
      <div className="chat-topbar"><div className="chat-topbar-left">{!sidebarOpen && <button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="展开侧边栏"><Menu size={18} /></button>}<div className="chat-model-badge"><span className="model-spark">✳</span><strong>NOVA Intelligence</strong><ChevronDown size={14} /></div><span className="chat-beta">PREVIEW</span></div><button className="chat-top-action" onClick={createConversation}><CirclePlus size={15} /> 新对话</button></div>
      <div className="chat-scroll-area">{loading ? <Loading label="正在加载对话…" /> : messages.length === 0 ? <div className="chat-welcome"><div className="chat-welcome-symbol">✳</div><span className="chat-welcome-overline">NOVA INTELLIGENCE</span><h1>你好，{user?.name || '探索者'}。<br /><span>今天想从哪里开始？</span></h1><p>写下一个问题、一个想法，或者你正在尝试解决的事情。</p><div className="prompt-suggestions"><button onClick={() => setDraft('帮我把一个复杂想法拆解成可以执行的步骤。')}>⌁ <span>拆解一个复杂问题</span></button><button onClick={() => setDraft('帮我梳理一个新产品的定位和核心功能。')}>✳ <span>构思一个新产品</span></button><button onClick={() => setDraft('解释一个我最近正在学习的技术概念。')}>⌘ <span>理解一个技术概念</span></button></div></div> : <div className="message-thread">{messages.map((message, index) => <div className={`chat-message chat-message-${message.role}`} key={message.id || `${message.role}-${index}`}><div className="message-avatar">{message.role === 'assistant' ? <span>✳</span> : <UserRound size={16} />}</div><div className="message-content"><div className="message-author">{message.role === 'assistant' ? 'NOVA' : user?.name || '你'}</div><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div></div></div>)}{sending && <div className="chat-message chat-message-assistant"><div className="message-avatar"><span>✳</span></div><div className="message-content"><div className="message-author">NOVA</div><div className="typing-indicator"><i /><i /><i /></div></div></div>}<div ref={endRef} /></div>}</div>
      <div className="chat-composer-wrap"><ErrorNotice>{error}</ErrorNotice><form className="chat-composer" onSubmit={sendMessage}><textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="向 NOVA 发送消息…" rows={1} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e); } }} /><div className="composer-bottom"><span><Sparkles size={13} /> 模型服务由服务器配置</span><button type="submit" disabled={!draft.trim() || sending} aria-label="发送消息"><Send size={17} /></button></div></form><div className="chat-disclaimer">NOVA 可能会出错。重要信息请自行核实。模型未配置时不会生成虚假回答。</div></div>
    </section>
  </main>;
}
