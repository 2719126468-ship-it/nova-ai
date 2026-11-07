import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, CirclePlus, Copy, FilePlus2, History, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, Pencil, RefreshCw, Send, Sparkles, Square, Trash2, UserRound } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { api, apiStream, json } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { ErrorNotice, Loading } from '../components/UI';

const HighlightedMarkdown = lazy(() => import('../components/HighlightedMarkdown.jsx'));

const contextSourceLabels = {
  provider_reported: '上游回报',
  admin_configured: '管理员配置（未验证）',
  environment_configured: '服务器环境配置（未验证）',
  unknown: '未知',
};

function describeContextPolicy(policy) {
  if (!policy) return '';
  const parts = [];
  if (policy.historyTruncated) parts.push('已按预算缩短较早历史，本条问题完整保留');
  if (policy.projectContextIncluded) parts.push('已载入项目指令与 ' + (policy.projectFilesIncluded || 0) + ' 个已选文件');
  if (policy.projectContextOmitted) parts.push('项目上下文因本轮输入预算不足而暂未载入');
  if (policy.projectContextTruncated) parts.push('项目指令或文件内容已按安全上限截取');
  if (policy.modelContextWindowTokens) {
    parts.push('上下文窗口 ' + policy.modelContextWindowTokens.toLocaleString() + '（' + (contextSourceLabels[policy.modelContextWindowSource] || '未知来源') + '）');
  } else {
    parts.push('模型上下文窗口未知');
  }
  if (Number.isFinite(policy.estimatedInputTokens)) {
    const countLabel = policy.tokenEstimateSource === 'tokenizer_estimate'
      ? '本地分词估算'
      : policy.tokenEstimateSource === 'byte_upper_bound'
        ? 'UTF-8 字节保守上界'
        : '输入估算';
    parts.push(countLabel + ' ' + policy.estimatedInputTokens.toLocaleString() + ' tokens');
  } else {
    parts.push('Token 数未知');
  }
  if (Number.isFinite(policy.inputTokenBudget)) {
    parts.push('输入预算 ' + policy.inputTokenBudget.toLocaleString());
  }
  if (Number.isFinite(policy.outputReserveTokens)) parts.push((policy.outputLimitEnforced === false ? '回复空间预留' : '回复上限') + ' ' + policy.outputReserveTokens.toLocaleString() + (policy.outputLimitEnforced === false ? '（未向上游提交硬限制）' : '（已提交上游）'));
  return parts.join(' · ');
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
  const [modelLoading, setModelLoading] = useState(true);
  const [modelLoadError, setModelLoadError] = useState(null);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [contextNotice, setContextNotice] = useState('');
  const [copiedMessageId, setCopiedMessageId] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [versionMessageId, setVersionMessageId] = useState(null);
  const [versionsByMessage, setVersionsByMessage] = useState({});
  const [loadingVersionsId, setLoadingVersionsId] = useState(null);
  const [restoringVersionId, setRestoringVersionId] = useState(null);
  const [saveDocumentDialog, setSaveDocumentDialog] = useState(null);
  const [saveDocumentProjects, setSaveDocumentProjects] = useState([]);
  const [saveDocumentTitle, setSaveDocumentTitle] = useState('');
  const [saveDocumentProjectId, setSaveDocumentProjectId] = useState('');
  const [loadingSaveDocumentProjects, setLoadingSaveDocumentProjects] = useState(false);
  const [savingDocument, setSavingDocument] = useState(false);
  const [saveDocumentError, setSaveDocumentError] = useState('');
  const [savedDocumentsByMessage, setSavedDocumentsByMessage] = useState({});
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
    setVersionMessageId(null);
    setVersionsByMessage({});
    setDraft('');
    setError('');
    setContextNotice('');
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
  const loadModelInfo = useCallback(async () => {
    setModelLoading(true);
    setModelLoadError(null);
    try {
      const data = await api('/api/v1/models');
      if (!data || !Array.isArray(data.models)) {
        const invalidResponse = new Error('模型服务返回了无法识别的数据。');
        invalidResponse.kind = 'invalid_response';
        throw invalidResponse;
      }
      setModelInfo(data);
      setSelectedModelId((current) => {
        const available = data.models.filter((model) => model?.selectable && typeof model.id === 'string');
        if (available.some((model) => model.id === current)) return current;
        if (available.some((model) => model.id === data.defaultModelId)) return data.defaultModelId;
        return available[0]?.id || '';
      });
      return data;
    } catch (cause) {
      const status = Number.isInteger(cause?.status) ? cause.status : null;
      setModelInfo(null);
      setModelLoadError({
        kind: status === null ? 'network' : status >= 500 ? 'server' : 'request',
        message: status === null
          ? '无法连接 NOVA API 服务。请检查网络连接和服务端进程。'
          : status >= 500
            ? '模型配置服务暂时异常（HTTP ' + status + '）。'
            : cause.message || '模型配置请求失败。',
      });
      throw cause;
    } finally {
      setModelLoading(false);
    }
  }, []);
  useEffect(() => { void loadModelInfo().catch(() => {}); }, [loadModelInfo]);
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

  async function openSaveDocumentDialog(message, messageIndex) {
    if (!message?.id || message.role !== 'assistant' || message.status !== 'complete' || sending) return;
    const precedingPrompt = messages.slice(0, messageIndex).reverse().find((item) => item.role === 'user');
    const suggestedTitle = String(precedingPrompt?.content || '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'AI 回答';
    setSaveDocumentDialog({ messageId: message.id, content: message.content || '' });
    setSaveDocumentTitle(suggestedTitle);
    setSaveDocumentProjectId('');
    setSaveDocumentProjects([]);
    setSaveDocumentError('');
    setLoadingSaveDocumentProjects(true);
    try {
      const result = await api('/api/v1/projects');
      setSaveDocumentProjects(result.projects || []);
    } catch (cause) {
      setSaveDocumentError('项目列表读取失败：' + cause.message);
    } finally {
      setLoadingSaveDocumentProjects(false);
    }
  }

  async function saveAssistantDocument() {
    if (!saveDocumentDialog || savingDocument) return;
    const title = saveDocumentTitle.trim();
    const content = saveDocumentDialog.content;
    if (!title) {
      setSaveDocumentError('请先填写文档标题。');
      return;
    }
    if (title.length > 120) {
      setSaveDocumentError('文档标题不能超过 120 个字符。');
      return;
    }
    if (content.length > 200000) {
      setSaveDocumentError('这条回答超过文档 200000 字符的保存上限，请先缩短回答内容。');
      return;
    }
    setSavingDocument(true);
    setSaveDocumentError('');
    try {
      const result = await api('/api/v1/documents', {
        method: 'POST',
        body: json({
          title,
          content,
          projectId: saveDocumentProjectId ? Number(saveDocumentProjectId) : null,
        }),
      });
      setSavedDocumentsByMessage((current) => ({
        ...current,
        [saveDocumentDialog.messageId]: {
          id: result.document.id,
          title: result.document.title,
        },
      }));
      setSaveDocumentDialog(null);
      setSaveDocumentError('');
    } catch (cause) {
      setSaveDocumentError(cause.message || '文档保存失败，请重试。');
    } finally {
      setSavingDocument(false);
    }
  }

  async function toggleMessageVersions(message) {
    if (versionMessageId === message.id) {
      setVersionMessageId(null);
      return;
    }
    setVersionMessageId(message.id);
    if (Object.prototype.hasOwnProperty.call(versionsByMessage, message.id)) return;

    setLoadingVersionsId(message.id);
    try {
      const data = await api('/api/v1/conversations/' + activeId + '/messages/' + message.id + '/versions');
      setVersionsByMessage((current) => ({ ...current, [message.id]: data.versions || [] }));
    } catch (e) {
      setError(e.message);
      setVersionMessageId(null);
    } finally {
      setLoadingVersionsId(null);
    }
  }

  async function restoreAnswerVersion(message, version) {
    if (sending || restoringVersionId) return;
    const confirmed = window.confirm('恢复这个历史回答？当前回答也会保存到历史版本中，可以再次切换回来。');
    if (!confirmed) return;

    setRestoringVersionId(version.id);
    setError('');
    try {
      const data = await api(
        '/api/v1/conversations/' + activeId + '/messages/' + message.id + '/restore',
        { method: 'POST', body: json({ versionId: version.id }) },
      );
      setMessages((current) => current.map((item) => item.id === message.id ? data.message : item));
      setVersionsByMessage((current) => ({ ...current, [message.id]: data.versions || [] }));
    } catch (e) {
      setError(e.message);
    } finally {
      setRestoringVersionId(null);
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
    if (modelLoading) {
      setError('正在读取模型列表，请稍后再发送。');
      return;
    }
    if (modelLoadError) {
      setError('暂时无法读取模型配置。请先重试加载模型列表；当前输入不会丢失。');
      return;
    }
    if (!selectedModel) {
      setError('当前尚未配置可用 AI 模型。请查看配置说明，或联系 NOVA 管理员配置服务端 Provider。当前输入已保留。');
      return;
    }
    if (editId && !activeId) {
      setError('请先打开这条消息所在的对话。');
      return;
    }

    setError('');
    setContextNotice('');
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
          setContextNotice(describeContextPolicy(packet.data?.contextPolicy));
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
      if (e.contextPolicy) setContextNotice(describeContextPolicy(e.contextPolicy));
      if (e.name !== 'AbortError') {
        const message = e.code === 'AI_PROVIDER_NOT_CONFIGURED'
          ? 'NOVA 尚未配置可用 AI 模型。请配置服务端 AI_BASE_URL、AI_API_KEY、AI_MODEL，或 AI_PROVIDERS_JSON 后重试。当前输入已保留。'
          : !Number.isInteger(e.status)
            ? '网络连接失败，暂时无法联系 NOVA API。请检查网络或服务端进程后重试；当前输入已保留。'
            : e.status >= 500
              ? 'NOVA 服务端暂时发生错误（HTTP ' + e.status + '）。请稍后重试；当前输入已保留。'
              : e.message || '请求未能完成，请检查配置后重试。当前输入已保留。';
        setError(message);
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

  const selectableModels = modelInfo?.models?.filter((model) => model?.selectable && typeof model.id === 'string') || [];
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
      {saveDocumentDialog && <div className="chat-document-dialog-overlay">
        <section className="chat-document-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-document-dialog-title">
          <div className="chat-document-dialog-heading">
            <div><span className="eyebrow">NOVA WORKSPACE / DOCUMENTS</span><h2 id="chat-document-dialog-title">保存 AI 回答</h2></div>
            <button type="button" className="chat-document-dialog-close" onClick={() => setSaveDocumentDialog(null)} disabled={savingDocument} aria-label="关闭保存窗口">×</button>
          </div>
          <p className="chat-document-dialog-description">将这条完整 Markdown 回答保存到你的私人文档库。保存后仍可继续编辑。</p>
          <label className="chat-document-dialog-field">
            <span>文档标题</span>
            <input value={saveDocumentTitle} onChange={(event) => setSaveDocumentTitle(event.target.value)} maxLength={120} autoFocus placeholder="为这篇文档命名…" />
          </label>
          <label className="chat-document-dialog-field">
            <span>保存到项目</span>
            <select value={saveDocumentProjectId} onChange={(event) => setSaveDocumentProjectId(event.target.value)} disabled={loadingSaveDocumentProjects || savingDocument}>
              <option value="">个人文档（不关联项目）</option>
              {saveDocumentProjects.map((project) => <option key={project.id} value={String(project.id)}>{project.title}</option>)}
            </select>
            {loadingSaveDocumentProjects && <small>正在读取你的项目…</small>}
          </label>
          {saveDocumentDialog.content.length > 200000 && <p className="chat-document-dialog-error" role="alert">回答超过 Documents 的 200000 字符限制，无法直接保存。</p>}
          {saveDocumentError && <p className="chat-document-dialog-error" role="alert">{saveDocumentError}</p>}
          <div className="chat-document-dialog-actions">
            <button type="button" onClick={() => setSaveDocumentDialog(null)} disabled={savingDocument}>取消</button>
            <button type="button" className="primary" onClick={saveAssistantDocument} disabled={savingDocument || loadingSaveDocumentProjects || !saveDocumentTitle.trim() || saveDocumentDialog.content.length > 200000}>
              {savingDocument ? '正在保存…' : '保存到 Documents'}
            </button>
          </div>
        </section>
      </div>}
      <div className="chat-scroll-area">
        {modelLoading && <div className="chat-model-state" role="status">
          <strong>正在读取模型配置…</strong>
          <span>聊天记录和已输入内容不会受到影响。</span>
        </div>}
        {modelLoadError && <div className="chat-model-state is-error" role="alert">
          <div><strong>暂时无法读取模型配置</strong><span>{modelLoadError.message}</span></div>
          <div className="chat-model-state-actions">
            <button type="button" onClick={() => { void loadModelInfo().catch(() => {}); }} disabled={modelLoading}>{modelLoading ? "正在重试…" : "重试加载模型列表"}</button>
            <Link to="/models">查看配置说明</Link>
          </div>
        </div>}
        {!modelLoading && !modelLoadError && !selectedModel && <div className="chat-model-state is-unconfigured" role="status">
          <div><strong>当前尚未配置可用 AI 模型</strong><span>聊天记录仍可查看，输入内容也会保留。NOVA 需要管理员在服务端配置 AI Provider 后才能生成回复。</span></div>
          <div className="chat-model-state-actions">
            {user?.role === "admin"
              ? <Link to="/admin?tab=providers">管理 Provider 配置</Link>
              : <Link to="/models">查看 API 配置说明</Link>}
            <Link to="/models">配置方式与安全说明</Link>
          </div>
        </div>}
        <div className="chat-scroll-content">
{loading ? <Loading label="正在加载对话…" /> : messages.length === 0 ? <div className="chat-welcome"><div className="chat-welcome-symbol">✳</div><span className="chat-welcome-overline">NOVA INTELLIGENCE</span><h1>你好，{user?.name || '探索者'}。<br /><span>今天想从哪里开始？</span></h1><p>写下一个问题、一个想法，或者你正在尝试解决的事情。</p><div className="prompt-suggestions"><button onClick={() => setDraft('帮我把一个复杂想法拆解成可以执行的步骤。')}>⌁ <span>拆解一个复杂问题</span></button><button onClick={() => setDraft('帮我梳理一个新产品的定位和核心功能。')}>✳ <span>构思一个新产品</span></button><button onClick={() => setDraft('解释一个我最近正在学习的技术概念。')}>⌘ <span>理解一个技术概念</span></button></div></div> : <div className="message-thread">{messages.map((message, index) => <div className={'chat-message chat-message-' + message.role} key={message.id || (message.role + '-' + index)}><div className="message-avatar">{message.role === 'assistant' ? <span>✳</span> : <UserRound size={16} />}</div><div className="message-content"><div className="message-author">{message.role === 'assistant' ? 'NOVA' : user?.name || '你'}</div>{message.status && message.status !== 'complete' && <div className={'message-status message-status-' + message.status}>{message.status === 'streaming' ? '正在生成' : message.status === 'cancelled' ? '已停止生成' : '生成失败'}</div>}<div className="message-actions"><button type="button" onClick={() => copyMessage(message)} aria-label="复制消息" title="复制消息">{copiedMessageId === message.id ? <Check size={13} /> : <Copy size={13} />}<span>{copiedMessageId === message.id ? '已复制' : '复制'}</span></button>{!sending && message.role === 'user' && <button type="button" onClick={() => beginEditMessage(message)} aria-label="编辑消息" title="编辑消息"><Pencil size={13} /><span>编辑</span></button>}{!sending && index === messages.length - 1 && message.status === 'complete' && message.role === 'assistant' && messages[index - 1]?.role === 'user' && <button type="button" onClick={() => regenerateMessage(messages[index - 1])} aria-label="重新生成" title="重新生成"><RefreshCw size={13} /><span>重新生成</span></button>}{!sending && index === messages.length - 1 && message.role === 'assistant' && ['failed', 'cancelled'].includes(message.status) && messages[index - 1]?.role === 'user' && <button type="button" onClick={() => retryMessage(message, messages[index - 1])} aria-label="重试回答" title="重试回答"><RefreshCw size={13} /><span>重试</span></button>}{!sending && message.role === 'assistant' && (message.version_count || 0) > 0 && <button type="button" onClick={() => toggleMessageVersions(message)} aria-expanded={versionMessageId === message.id} aria-label="查看回答历史版本" title="查看回答历史版本"><History size={13} /><span>版本 {message.version_count}</span></button>}{!sending && message.role === 'assistant' && message.status === 'complete' && (savedDocumentsByMessage[message.id] ? <Link className="message-action-link" to={'/documents/' + savedDocumentsByMessage[message.id].id}>打开文档</Link> : <button type="button" onClick={() => openSaveDocumentDialog(message, index)} aria-label="保存回答为文档" title="保存回答为文档"><FilePlus2 size={13} /><span>保存为文档</span></button>)}</div>{versionMessageId === message.id && <div className="message-version-panel"><div className="message-version-heading"><History size={13} /><span>历史回答版本</span></div>{loadingVersionsId === message.id ? <div className="message-version-empty">正在读取版本…</div> : (versionsByMessage[message.id] || []).length ? (versionsByMessage[message.id] || []).map((version) => <div className="message-version-item" key={version.id}><div className="message-version-meta"><span>{version.source === 'edit_regeneration' ? '编辑前' : version.source === 'retry' ? '重试前' : '恢复前'}</span><time>{new Date(String(version.created_at).replace(' ', 'T') + 'Z').toLocaleString()}</time></div><div className="message-version-preview">{version.content || '（空回答）'}</div><button type="button" className="message-version-restore" disabled={sending || Boolean(restoringVersionId)} onClick={() => restoreAnswerVersion(message, version)}>{restoringVersionId === version.id ? '恢复中…' : '恢复此版本'}</button></div>) : <div className="message-version-empty">暂无历史版本。</div>}</div>}<div className="markdown-body">{/(^|\n)\s*`{3}/.test(message.content || '') ? (
          <Suspense fallback={<ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>}>
            <HighlightedMarkdown content={message.content} />
          </Suspense>
        ) : <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>}</div></div></div>)}<div ref={endRef} /></div>}</div></div>      <div className="chat-composer-wrap"><ErrorNotice>{error}</ErrorNotice>{contextNotice && <div className="context-budget-notice" role="status">{contextNotice}</div>}<form className="chat-composer" onSubmit={sendMessage}>{editingMessageId && <div className="composer-edit-hint">重新生成成功后，会删除这条消息后面的对话内容；失败或停止会保留原对话。</div>}<textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={editingMessageId ? '编辑消息并重新生成…' : '向 NOVA 发送消息…'} rows={1} disabled={sending} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e); } }} /><div className="composer-bottom"><span><Sparkles size={13} /> {selectedModel?.configured && selectedModel?.status === 'unknown' ? '模型已配置 · 上游状态未验证' : selectedModel ? '已选择模型 · 上游状态未知' : '模型服务由服务器配置'}</span>{editingMessageId && !sending && <button className="composer-cancel" type="button" onClick={cancelEditMessage}>取消编辑</button>}{sending ? <button type="button" onClick={stopGeneration} aria-label="停止生成"><Square size={15} /></button> : <button type="submit" disabled={!draft.trim()} aria-label="发送消息"><Send size={17} /></button>}</div></form><div className="chat-disclaimer">NOVA 可能会出错。重要信息请自行核实。模型未配置时不会生成虚假回答。</div></div>
    </section>
  </main>;
}
