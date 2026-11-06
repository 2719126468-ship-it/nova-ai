import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, FileText, FolderPlus, MoreHorizontal, Save, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, json } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Button, EmptyState, ErrorNotice, Loading, PageIntro } from '../components/UI';

export function Studio() {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  async function load() { const data = await api('/api/projects'); setProjects(data.projects); }
  useEffect(() => { if (user) load().catch((e) => setError(e.message)).finally(() => setLoading(false)); else setLoading(false); }, [user]);
  async function create(event) {
    event.preventDefault(); setError('');
    try { const data = await api('/api/projects', { method: 'POST', body: json({ title, description }) }); navigate(`/studio/${data.project.id}`); }
    catch (e) { setError(e.message); }
  }
  async function remove(id) {
    if (!window.confirm('删除此项目？此操作无法撤销。')) return;
    try { await api(`/api/projects/${id}`, { method: 'DELETE' }); await load(); } catch (e) { setError(e.message); }
  }
  if (!user) return <main className="page-wrap container-wide"><PageIntro eyebrow="NOVA STUDIO" title="让想法，开始成形。" description="登录后创建、编辑并保存你的项目。" /><Button to="/login">登录以打开 Studio <ArrowUpRight size={15} /></Button></main>;
  return <main className="page-wrap container-wide studio-page"><PageIntro eyebrow="NOVA STUDIO / YOUR WORKSPACE" title={<>让想法，<br />开始成形。</>} description="一个安静、持续保存的空间，用来组织你的创意与项目。" actions={<span className="workspace-chip"><span /> PRIVATE WORKSPACE</span>} />
    <div className="studio-create-panel"><div className="create-panel-icon"><FolderPlus size={21} /></div><div className="create-panel-copy"><h2>创建一个新项目</h2><p>从一个名字开始。你可以随时回来继续编辑。</p></div><form className="create-project-form" onSubmit={create}><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="项目名称" required maxLength={120} /><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="简短描述（可选）" maxLength={500} /><Button type="submit" disabled={!title.trim()}>创建项目 <ArrowUpRight size={15} /></Button></form></div>
    <div className="studio-list-heading"><div><span className="eyebrow">YOUR PROJECTS</span><h2>最近的项目 <span>{projects.length.toString().padStart(2, '0')}</span></h2></div><span className="studio-sort">按最近更新排序 ↓</span></div>
    <ErrorNotice>{error}</ErrorNotice>
    {loading ? <Loading label="正在读取项目…" /> : projects.length ? <div className="studio-project-grid">{projects.map((project) => <div className="studio-project-card" key={project.id}><Link to={`/studio/${project.id}`} className="project-card-main"><div className="project-card-art"><FileText size={25} /><span>NOVA / PROJECT {String(project.id).padStart(3, '0')}</span></div><div className="project-card-info"><div><h3>{project.title}</h3><p>{project.description || '还没有添加描述。'}</p></div><span>{new Date(`${project.updated_at.replace(' ', 'T')}Z`).toLocaleDateString()}</span></div></Link><div className="project-card-actions"><Link to={`/studio/${project.id}`}>打开编辑器 <ArrowUpRight size={14} /></Link><button onClick={() => remove(project.id)} aria-label="删除项目"><Trash2 size={14} /></button></div></div>)}</div> : <EmptyState icon={FileText} title="你的工作区还很安静" description="创建第一个项目，开始记录一个想法、计划或创作。" action={<Button onClick={() => document.querySelector('.create-project-form input')?.focus()} variant="outline">创建第一个项目</Button>} />}
  </main>;
}

export function StudioEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api(`/api/projects/${id}`).then(({ project: item }) => { setProject(item); setTitle(item.title); setDescription(item.description); setContent(item.content); }).catch((e) => setError(e.message)).finally(() => setLoading(false)); }, [id]);
  async function save(event) {
    event?.preventDefault(); setSaving(true); setError('');
    try { const data = await api(`/api/projects/${id}`, { method: 'PUT', body: json({ title, description, content }) }); setProject(data.project); setSavedAt(new Date()); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }
  if (loading) return <main className="page-wrap container-wide"><Loading label="正在打开项目…" /></main>;
  if (!project) return <main className="page-wrap container-wide"><ErrorNotice>{error || '项目不存在。'}</ErrorNotice><Button to="/studio" variant="outline"><ArrowLeft size={15} /> 返回 Studio</Button></main>;
  return <main className="editor-page container-wide"><div className="editor-topbar"><Link to="/studio" className="back-link"><ArrowLeft size={15} /> 所有项目</Link><div className="editor-save-state">{saving ? '正在保存…' : savedAt ? `已保存 · ${savedAt.toLocaleTimeString()}` : '所有更改需手动保存'}</div><Button onClick={save} disabled={saving || !title.trim()}><Save size={15} /> 保存项目</Button></div>
    <ErrorNotice>{error}</ErrorNotice><form className="project-editor" onSubmit={save}><div className="editor-meta"><span>PROJECT / {String(project.id).padStart(4, '0')}</span><span>PRIVATE DRAFT</span></div><input className="editor-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="未命名项目" maxLength={120} required /><input className="editor-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="添加一句描述…" maxLength={500} /><div className="editor-toolbar"><span><FileText size={15} /> 文档编辑器</span><span>MARKDOWN SUPPORTED IN CONTENT</span></div><textarea className="editor-content" value={content} onChange={(e) => setContent(e.target.value)} placeholder={'从这里开始写下你的想法…\n\n支持纯文本和 Markdown 源文。'} maxLength={200000} /><div className="editor-footer"><span>{content.length.toLocaleString()} / 200,000 characters</span><button type="submit" disabled={saving}><Save size={14} /> 保存更改</button></div></form></main>;
}
