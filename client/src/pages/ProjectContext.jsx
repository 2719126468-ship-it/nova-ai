import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, FileText, FolderOpen, LoaderCircle, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, json } from '../lib/api';
import { Button, EmptyState, ErrorNotice, Loading, PageIntro } from '../components/UI';

function formatBytes(value) {
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB';
  return (value / (1024 * 1024)).toFixed(2) + ' MiB';
}

export function ProjectContextIndex() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api('/api/v1/projects')
      .then((result) => { if (active) setProjects(result.projects || []); })
      .catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  return <main className="page-wrap container-wide project-context-page">
    <PageIntro
      eyebrow="NOVA WORKSPACE / PROJECT CONTEXT"
      title={<>给每个项目，<br />一份长期记忆。</>}
      description="为项目设置专属指令，并挑选需要进入 AI 对话的参考文件。文件默认不参与上下文，只有你主动启用才会被使用。"
    />
    <section className="project-context-list-heading">
      <div><span className="eyebrow">YOUR PROJECTS</span><h2>选择一个项目</h2></div>
      <Link to="/studio" className="back-link">打开 Studio <ArrowUpRight size={14} /></Link>
    </section>
    <ErrorNotice>{error}</ErrorNotice>
    {loading ? <Loading label="正在读取项目…" /> : projects.length ? <div className="project-context-grid">
      {projects.map((project) => <Link className="project-context-card" key={project.id} to={'/project-context/' + project.id}>
        <span className="project-context-card-icon"><FolderOpen size={18} /></span>
        <h3>{project.title}</h3>
        <p>{project.description || '为这个项目配置专属指令和参考资料。'}</p>
        <span className="project-context-card-open">管理项目资料 <ArrowUpRight size={13} /></span>
      </Link>)}
    </div> : <EmptyState icon={FolderOpen} title="还没有项目" description="先在 Studio 创建一个项目，再回来配置项目资料。" action={<Button to="/studio">前往 Studio</Button>} />}
  </main>;
}

export function ProjectContextEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [files, setFiles] = useState([]);
  const [instructions, setInstructions] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState('');
  const dirty = Boolean(project) && instructions !== project.instructions;

  const load = useCallback(async () => {
    const result = await api('/api/v1/projects/' + id + '/context');
    setProject(result.project);
    setInstructions(result.project.instructions || '');
    setFiles(result.files || []);
    setConflict(false);
    setError('');
    setNotice('');
  }, [id]);

  useEffect(() => {
    let active = true;
    api('/api/v1/projects/' + id + '/context')
      .then((result) => {
        if (!active) return;
        setProject(result.project);
        setInstructions(result.project.instructions || '');
        setFiles(result.files || []);
      })
      .catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id]);

  async function saveInstructions() {
    if (!project || saving || !dirty) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await api('/api/v1/projects/' + id + '/context', {
        method: 'PUT',
        body: json({ instructions, expectedVersion: project.instructionsVersion }),
      });
      setProject(result.project);
      setInstructions(result.project.instructions);
      setNotice('项目指令已保存。');
      setConflict(false);
    } catch (cause) {
      if (cause.code === 'PROJECT_CONTEXT_VERSION_CONFLICT') setConflict(true);
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  }

  async function uploadFile(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError('单个文件不能超过 2 MiB。');
      return;
    }
    setUploading(true);
    setError('');
    setNotice('');
    setSelectedFileName(file.name);
    try {
      const response = await fetch('/api/v1/projects/' + id + '/files', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-App-Request': '1',
          'X-File-Name': encodeURIComponent(file.name),
        },
        body: new Blob([file], { type: 'application/octet-stream' }),
      });
      const result = await response.json();
      if (!response.ok) {
        const cause = new Error(result.message || '上传失败。');
        cause.code = result.error;
        throw cause;
      }
      setFiles((current) => [result.file, ...current]);
      setNotice('文件已上传。默认未加入 AI 上下文。');
    } catch (cause) {
      setError(cause.message);
    } finally {
      setUploading(false);
      setSelectedFileName('');
    }
  }

  async function toggleFile(file, includeInContext) {
    setError('');
    try {
      const result = await api('/api/v1/projects/' + id + '/files/' + file.id, {
        method: 'PATCH',
        body: json({ includeInContext }),
      });
      setFiles(result.files || []);
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function deleteFile(file) {
    if (!window.confirm('删除文件“' + file.name + '”？')) return;
    setError('');
    try {
      const result = await api('/api/v1/projects/' + id + '/files/' + file.id, { method: 'DELETE' });
      setFiles(result.files || []);
      setNotice('文件已删除。');
    } catch (cause) {
      setError(cause.message);
    }
  }

  if (loading) return <main className="page-wrap container-wide"><Loading label="正在读取项目资料…" /></main>;
  if (!project) return <main className="page-wrap container-wide"><ErrorNotice>{error || '项目不存在。'}</ErrorNotice><Button to="/project-context" variant="outline"><ArrowLeft size={14} /> 返回项目</Button></main>;

  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const includedCount = files.filter((file) => file.includeInContext).length;

  return <main className="page-wrap container-wide project-context-page">
    <div className="project-context-top"><Link to="/project-context" className="back-link"><ArrowLeft size={14} /> 所有项目</Link><Link to={'/studio/' + id} className="back-link">Studio 项目 <ArrowUpRight size={13} /></Link></div>
    <PageIntro
      eyebrow={'PROJECT CONTEXT / ' + String(project.id).padStart(5, '0')}
      title={project.title}
      description="项目指令用于保持回答方式一致；被启用的文件只作为参考资料，不会自动获得指令权限。"
    />
    <ErrorNotice>{error}</ErrorNotice>
    {notice && <div className="project-context-notice" role="status"><Check size={14} /> {notice}</div>}
    {conflict && <div className="project-context-conflict">
      <div><strong>项目指令已经在其他位置更新。</strong><p>你当前输入仍保留在这里。读取最新版本后再合并，或复制本地指令到安全位置。</p></div>
      <Button variant="outline" onClick={() => load().catch((cause) => setError(cause.message))}>读取最新版本</Button>
    </div>}
    <section className="project-context-panel">
      <div className="project-context-panel-heading">
        <div><span className="eyebrow">01 / PROJECT INSTRUCTIONS</span><h2>项目专属指令</h2></div>
        <span className="project-context-version">VERSION {project.instructionsVersion}</span>
      </div>
      <p className="project-context-help">写下这个项目的目标、术语、输出风格、约束和持续偏好。最多 16,000 个字符；保存时会检查版本，避免覆盖别处的新修改。</p>
      <textarea
        className="project-instructions-input"
        value={instructions}
        onChange={(event) => { setInstructions(event.target.value); setNotice(''); }}
        maxLength={16000}
        placeholder={'例如：\n- 项目目标：构建一个面向移动端的 AI 工作空间。\n- 回答方式：先给结论，再给实施步骤。\n- 技术约束：优先兼容 Android 和低内存设备。'}
        aria-label="项目专属指令"
      />
      <div className="project-context-actions">
        <span>{instructions.length.toLocaleString()} / 16,000</span>
        <Button onClick={saveInstructions} disabled={!dirty || saving || conflict}>
          {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
          {saving ? '正在保存…' : '保存项目指令'}
        </Button>
      </div>
    </section>
    <section className="project-context-panel">
      <div className="project-context-panel-heading">
        <div><span className="eyebrow">02 / PROJECT FILES</span><h2>项目参考文件</h2></div>
        <span className="project-context-version">{files.length} / 20 FILES</span>
      </div>
      <p className="project-context-help">支持 TXT、Markdown、CSV 和 JSON。单文件最大 2 MiB，项目总量 10 MiB。上传后默认关闭上下文使用；勾选后，文件节选才会随已关联此项目的对话发送给模型。</p>
      <label className={'project-file-upload' + (uploading ? ' is-uploading' : '')}>
        {uploading ? <LoaderCircle size={17} className="spin" /> : <Upload size={17} />}
        <span><strong>{uploading ? '正在上传 ' + selectedFileName : '选择文件上传'}</strong><small>UTF-8 文本 · .txt .md .csv .json · 最大 2 MiB</small></span>
        <input type="file" accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json" disabled={uploading || files.length >= 20} onChange={(event) => { uploadFile(event.target.files?.[0]); event.target.value = ''; }} />
      </label>
      <div className="project-file-usage"><span>{formatBytes(totalBytes)} / 10 MiB</span><span>{includedCount} 个文件已启用上下文</span></div>
      {files.length ? <div className="project-file-list">
        {files.map((file) => <div className="project-file-row" key={file.id}>
          <span className="project-file-icon"><FileText size={16} /></span>
          <div className="project-file-main">
            <strong>{file.name}</strong>
            <small>{formatBytes(file.sizeBytes)} · {file.extension.toUpperCase()} · {new Date(file.createdAt.replace(' ', 'T') + 'Z').toLocaleDateString()}</small>
          </div>
          <label className="project-file-toggle"><input type="checkbox" checked={file.includeInContext} onChange={(event) => toggleFile(file, event.target.checked)} /><span>加入上下文</span></label>
          <a className="project-file-action" href={'/api/v1/projects/' + id + '/files/' + file.id + '/download'} aria-label={'下载 ' + file.name}><ArrowUpRight size={15} /></a>
          <button type="button" className="project-file-action is-danger" onClick={() => deleteFile(file)} aria-label={'删除 ' + file.name}><X size={15} /></button>
        </div>)}
      </div> : <EmptyState icon={FileText} title="还没有参考文件" description="上传项目说明、CSV 数据或 Markdown 笔记，再决定哪些资料可以进入对话上下文。" />}
    </section>
    <div className="project-context-security"><ShieldCheck size={15} /><span>项目与文件始终按账户隔离。文件不会自动进入模型上下文；启用后也只发送受限长度的文本节选，并明确标记为不可信参考资料。</span></div>
  </main>;
}
