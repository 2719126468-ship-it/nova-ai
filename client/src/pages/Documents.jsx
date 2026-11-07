import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Clock3, Download, FilePlus2, FileText, FolderOpen, LoaderCircle, RefreshCw, Search, ShieldCheck, SplitSquareVertical, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, json } from '../lib/api';
import { Button, EmptyState, ErrorNotice, Loading, PageIntro } from '../components/UI';

function formatDate(value) {
  if (!value) return '刚刚';
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? '刚刚' : date.toLocaleString();
}

export function Documents() {
  const navigate = useNavigate();
  const [documents, setDocuments] = useState([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const fetchDocuments = useCallback(async () => {
    const result = await api('/api/v1/documents?limit=100');
    return Array.isArray(result.documents) ? result.documents : [];
  }, []);

  useEffect(() => {
    let active = true;
    fetchDocuments()
      .then((items) => { if (active) setDocuments(items); })
      .catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [fetchDocuments]);

  async function refreshDocuments() {
    setLoading(true);
    setError('');
    try {
      setDocuments(await fetchDocuments());
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading(false);
    }
  }

  async function createDocument() {
    if (creating) return;
    setCreating(true);
    setError('');
    try {
      const result = await api('/api/v1/documents', {
        method: 'POST',
        body: json({ title: '未命名文档', content: '' }),
      });
      navigate('/documents/' + result.document.id);
    } catch (cause) {
      setError(cause.message);
      setCreating(false);
    }
  }

  const visibleDocuments = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return documents;
    return documents.filter((document) => document.title.toLocaleLowerCase().includes(term));
  }, [documents, query]);

  return <main className="page-wrap container-wide documents-page">
    <PageIntro
      eyebrow="NOVA WORKSPACE / DOCUMENTS"
      title={<>把想法，<br />写成作品。</>}
      description="你的 Markdown 文档与项目一起保存。编辑会自动同步，版本冲突会被明确提示，不会悄悄覆盖。"
      actions={<span className="workspace-chip"><span /> PRIVATE DOCUMENTS</span>}
    />
    <section className="documents-toolbar">
      <div className="documents-toolbar-copy">
        <span className="eyebrow">YOUR LIBRARY</span>
        <h2>我的文档 <span>{documents.length.toString().padStart(2, '0')}</span></h2>
      </div>
      <div className="documents-toolbar-actions">
        <label className="documents-search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文档标题…" aria-label="搜索文档标题" />
        </label>
        <Button onClick={createDocument} disabled={creating}>
          {creating ? <LoaderCircle size={15} className="spin" /> : <FilePlus2 size={15} />}
          新建文档
        </Button>
        <button className="documents-icon-button" type="button" onClick={refreshDocuments} disabled={loading} aria-label="刷新文档列表"><RefreshCw size={15} /></button>
      </div>
    </section>
    <ErrorNotice>{error}</ErrorNotice>
    {loading ? <Loading label="正在读取你的文档…" /> : visibleDocuments.length ? <div className="documents-grid">
      {visibleDocuments.map((document) => <Link className="document-card" to={'/documents/' + document.id} key={document.id}>
        <div className="document-card-top"><span className="document-card-icon"><FileText size={18} /></span><span className="document-card-version">V{document.version}</span></div>
        <h3>{document.title}</h3>
        <p>{document.contentLength ? document.contentLength.toLocaleString() + ' 个字符' : '从空白开始写作'}</p>
        <div className="document-card-footer">
          <span>{document.projectId ? <><FolderOpen size={12} /> 项目 #{document.projectId}</> : '个人文档'}</span>
          <time>{formatDate(document.updatedAt)}</time>
        </div>
        <span className="document-card-open">打开文档 <ArrowUpRight size={13} /></span>
      </Link>)}
    </div> : <EmptyState
      icon={FileText}
      title={query ? '没有找到匹配的文档' : '你的文档空间还是空白'}
      description={query ? '换一个标题关键词试试。' : '新建一篇 Markdown 文档，记录计划、研究或下一次创作。'}
      action={<Button onClick={createDocument} disabled={creating}><FilePlus2 size={15} /> 创建第一篇文档</Button>}
    />}
    <div className="documents-privacy-note"><ShieldCheck size={14} /> 文档默认仅自己可见；关联项目不会改变文档的账户归属。</div>
  </main>;
}

const EMPTY_SNAPSHOT = JSON.stringify({ title: '', content: '', projectId: null });

function makeSnapshot(value) {
  return JSON.stringify({
    title: String(value.title || '').trim(),
    content: String(value.content || ''),
    projectId: value.projectId ? Number(value.projectId) : null,
  });
}

export function DocumentEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const numericId = Number(id);
  const [document, setDocument] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectLoadError, setProjectLoadError] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [projectId, setProjectId] = useState('');
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('saved');
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(null);
  const [retryKey, setRetryKey] = useState(0);
  const [preview, setPreview] = useState(false);
  const [copying, setCopying] = useState(false);

  const versionRef = useRef(0);
  const savedSnapshotRef = useRef(EMPTY_SNAPSHOT);
  const savingRef = useRef(false);
  const failedSnapshotRef = useRef(null);
  const currentDraft = { title, content, projectId: projectId ? Number(projectId) : null };
  const dirty = Boolean(document) && makeSnapshot(currentDraft) !== savedSnapshotRef.current;

  const loadDocument = useCallback(async () => {
    const result = await api('/api/v1/documents/' + numericId);
    const item = result.document;
    setDocument(item);
    setTitle(item.title);
    setContent(item.content);
    setProjectId(item.projectId ? String(item.projectId) : '');
    setVersion(item.version);
    versionRef.current = item.version;
    savedSnapshotRef.current = makeSnapshot(item);
    setLastSavedAt(item.updatedAt);
    setSaveStatus('saved');
    setConflict(null);
    setError('');
    return item;
  }, [numericId]);

  useEffect(() => {
    let active = true;
    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
      setError('文档编号无效。');
      setLoading(false);
      return () => { active = false; };
    }
    Promise.allSettled([
      api('/api/v1/documents/' + numericId),
      api('/api/projects'),
    ]).then(([documentResult, projectResult]) => {
      if (!active) return;
      if (documentResult.status !== 'fulfilled') throw documentResult.reason;
      const item = documentResult.value.document;
      setDocument(item);
      setTitle(item.title);
      setContent(item.content);
      setProjectId(item.projectId ? String(item.projectId) : '');
      setVersion(item.version);
      versionRef.current = item.version;
      savedSnapshotRef.current = makeSnapshot(item);
      setLastSavedAt(item.updatedAt);
      setSaveStatus('saved');
      if (projectResult.status === 'fulfilled') {
        setProjects(projectResult.value.projects || []);
      } else {
        setProjectLoadError('项目列表暂时无法读取；文档仍可编辑并自动保存，但暂时无法更改项目关联。');
      }
    }).catch((cause) => {
      if (active) setError(cause.message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [numericId]);

  const persist = useCallback(async (target) => {
    if (savingRef.current || !target.title.trim() || conflict) return;
    savingRef.current = true;
    setSaving(true);
    setSaveStatus('saving');
    setError('');
    try {
      const result = await api('/api/v1/documents/' + numericId, {
        method: 'PUT',
        body: json({ ...target, expectedVersion: versionRef.current }),
      });
      const saved = result.document;
      versionRef.current = saved.version;
      setVersion(saved.version);
      savedSnapshotRef.current = makeSnapshot(saved);
      failedSnapshotRef.current = null;
      setDocument(saved);
      setLastSavedAt(saved.updatedAt);
      setSaveStatus('saved');
    } catch (cause) {
      if (cause.code === 'DOCUMENT_VERSION_CONFLICT') {
        setConflict({ currentVersion: cause.currentVersion, message: cause.message });
        setSaveStatus('conflict');
      } else {
        failedSnapshotRef.current = makeSnapshot(target);
        setError(cause.message);
        setSaveStatus('error');
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [conflict, numericId]);

  useEffect(() => {
    if (!document || loading || !dirty || saving || conflict) return undefined;
    if (!title.trim()) {
      setSaveStatus('error');
      setError('文档标题不能为空，填写标题后即可自动保存。');
      return undefined;
    }
    const target = {
      title: title.trim(),
      content,
      projectId: projectId ? Number(projectId) : null,
    };
    if (failedSnapshotRef.current === makeSnapshot(target)) return undefined;
    setError('');
    setSaveStatus('pending');
    const timer = window.setTimeout(() => persist(target), 850);
    return () => window.clearTimeout(timer);
  }, [document, loading, dirty, title, content, projectId, saving, conflict, saveStatus, retryKey, persist]);

  useEffect(() => {
    if (!dirty && saveStatus === 'pending') setSaveStatus('saved');
  }, [dirty, saveStatus]);

  useEffect(() => {
    if (!dirty && !saving) return undefined;
    const warnBeforeLeaving = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [dirty, saving]);

  async function reloadLatest() {
    if (dirty && !window.confirm('读取最新版本会替换当前编辑器中的本地内容。建议先另存为副本。仍要继续吗？')) return;
    setLoading(true);
    try {
      await loadDocument();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading(false);
    }
  }

  async function saveAsCopy() {
    if (copying) return;
    setCopying(true);
    setError('');
    try {
      const result = await api('/api/v1/documents', {
        method: 'POST',
        body: json({
          title: title.trim().slice(0, 112) + '（副本）',
          content,
          projectId: projectId ? Number(projectId) : null,
        }),
      });
      navigate('/documents/' + result.document.id);
    } catch (cause) {
      setError(cause.message);
      setCopying(false);
    }
  }

  function downloadMarkdown() {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = (title.trim() || 'nova-document').replace(/[\\\\/:*?"<>|]/g, '_') + '.md';
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  async function deleteDocument() {
    if (!window.confirm('删除这篇文档？此操作无法撤销。')) return;
    try {
      await api('/api/v1/documents/' + numericId, { method: 'DELETE' });
      navigate('/documents');
    } catch (cause) {
      setError(cause.message);
    }
  }

  const statusLabel = saveStatus === 'saving' ? '正在保存…'
    : saveStatus === 'pending' ? '有未保存的更改'
      : saveStatus === 'conflict' ? '版本冲突'
        : saveStatus === 'error' ? '保存失败'
          : '已同步';
  const dirtyWarning = dirty && !saving;

  if (loading) return <main className="page-wrap container-wide"><Loading label="正在打开文档…" /></main>;
  if (!document) return <main className="page-wrap container-wide"><ErrorNotice>{error || '文档不存在。'}</ErrorNotice><Button to="/documents" variant="outline"><ArrowLeft size={15} /> 返回文档</Button></main>;

  return <main className="document-editor-page container-wide">
    <div className="document-editor-topbar">
      <Link to="/documents" className="back-link"><ArrowLeft size={15} /> 所有文档</Link>
      <div className={'document-save-state is-' + saveStatus} aria-live="polite">
        {saving ? <LoaderCircle size={13} className="spin" /> : saveStatus === 'saved' ? <Check size={13} /> : <Clock3 size={13} />}
        <span>{statusLabel}</span>
        {lastSavedAt && saveStatus === 'saved' && <small>{formatDate(lastSavedAt)}</small>}
      </div>
      <div className="document-editor-actions">
        <Button variant="outline" onClick={downloadMarkdown}><Download size={14} /> 导出 .md</Button>
        <Button variant="outline" onClick={saveAsCopy} disabled={copying || saving}><FilePlus2 size={14} /> 另存为副本</Button>
        <button type="button" className="documents-icon-button danger" onClick={deleteDocument} disabled={saving || dirty} aria-label="删除文档" title={saving || dirty ? '请先等待自动保存完成' : '删除文档'}><Trash2 size={15} /></button>
      </div>
    </div>
    <ErrorNotice>{error || projectLoadError}</ErrorNotice>
    {conflict && <div className="document-conflict-banner" role="alert">
      <div><strong>这篇文档已经在其他位置更新。</strong><p>{conflict.message} 你当前的本地内容仍保留在编辑器中。</p></div>
      <div><Button variant="outline" onClick={saveAsCopy} disabled={copying}>{copying ? '正在创建…' : '将本地内容另存为副本'}</Button><Button onClick={reloadLatest}>读取最新版本</Button></div>
    </div>}
    <section className="document-editor-shell">
      <div className="document-editor-meta">
        <span>DOCUMENT / {String(document.id).padStart(5, '0')}</span>
        <span>VERSION {version}</span>
      </div>
      <input className="document-title-input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} aria-label="文档标题" placeholder="给这篇文档起个名字…" />
      <div className="document-editor-subbar">
        <label className="document-project-select"><FolderOpen size={14} /><span>保存到项目</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={Boolean(projectLoadError)}>
            <option value="">个人文档</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
          </select>
        </label>
        <div className="document-mode-switch" role="group" aria-label="编辑模式">
          <button type="button" className={!preview ? 'is-active' : ''} onClick={() => setPreview(false)}>编辑</button>
          <button type="button" className={preview ? 'is-active' : ''} onClick={() => setPreview(true)}>预览</button>
        </div>
      </div>
      {preview ? <article className="document-markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content || '*这里会显示 Markdown 预览。*'}</ReactMarkdown></article> : <textarea
        className="document-markdown-input"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        maxLength={200000}
        spellCheck
        placeholder={'从这里开始写作…\n\n支持 Markdown、表格、列表和代码块。\n\n更改会在短暂暂停输入后自动保存。'}
        aria-label="Markdown 文档内容"
      />}
      <div className="document-editor-footer">
        <span>{content.length.toLocaleString()} / 200,000 字符{dirtyWarning ? ' · 待同步' : ''}</span>
        <span><SplitSquareVertical size={13} /> Markdown</span>
        {saveStatus === 'error' && <button type="button" onClick={() => { failedSnapshotRef.current = null; setSaveStatus('pending'); setRetryKey((value) => value + 1); }}>重试保存</button>}
        {saveStatus === 'pending' && <span>停止输入后自动保存</span>}
        {saveStatus === 'saved' && <span>所有更改已保存</span>}
      </div>
    </section>
    <div className="document-editor-bottom-note"><ShieldCheck size={14} /> 自动保存使用文档版本号校验；发生并发编辑时，NOVA 会保留本地草稿并让你选择读取新版本或另存为副本。</div>
  </main>;
}

