import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Activity, ArrowUpRight, BookOpen, FileText, LayoutDashboard, Plus, RefreshCw, Server, ShieldCheck, Users, X } from 'lucide-react';
import { api, json } from '../lib/api';
import { Button, ErrorNotice, Loading, PageIntro } from '../components/UI';
import ProviderManagement from './ProviderManagement.jsx';

const blankArticle = { slug: '', title: '', category: 'AI 观察', summary: '', body: '', status: 'draft' };
export default function Admin() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(() => searchParams.get('tab') === 'providers' ? 'providers' : 'overview');
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [articles, setArticles] = useState([]);
  const [article, setArticle] = useState(blankArticle);
  const [showEditor, setShowEditor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [stats, memberData, articleData] = await Promise.all([
        api('/api/admin/overview'), api('/api/admin/users'), api('/api/admin/articles'),
      ]);
      setOverview(stats); setUsers(memberData.users); setArticles(articleData.articles);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function changeRole(member, role) {
    try { await api(`/api/admin/users/${member.id}/role`, { method: 'PATCH', body: json({ role }) }); await load(); }
    catch (e) { setError(e.message); }
  }
  function createArticle() { setArticle({ ...blankArticle, id: null }); setShowEditor(true); }
  function editArticle(item) { setArticle({ ...item, body: item.body || '' }); setShowEditor(true); }
  async function saveArticle(event) {
    event.preventDefault(); setSaving(true); setError('');
    try {
      await api(article.id ? `/api/research/${article.id}` : '/api/research', { method: article.id ? 'PUT' : 'POST', body: json(article) });
      setShowEditor(false); setArticle(blankArticle); await load();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }
  async function deleteArticle(item) {
    if (!window.confirm(`删除文章“${item.title}”？`)) return;
    try { await api(`/api/research/${item.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setError(e.message); }
  }
  const tabs = [{ id: 'overview', label: '概览', icon: LayoutDashboard }, { id: 'users', label: '用户', icon: Users }, { id: 'articles', label: '研究内容', icon: BookOpen }, { id: 'providers', label: '模型供应商', icon: Server }];
  return <main className="page-wrap container-wide admin-page"><PageIntro eyebrow="NOVA OPERATIONS / ADMIN CONSOLE" title="系统控制台。" description="查看平台运行数据、管理用户权限，并维护 NOVA Research 内容。" actions={<Button variant="outline" onClick={load}><RefreshCw size={15} /> 刷新数据</Button>} />
    <ErrorNotice>{error}</ErrorNotice>
    <div className="admin-shell"><aside className="admin-sidebar"><span className="admin-sidebar-title">MANAGEMENT</span>{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); setShowEditor(false); }}><Icon size={16} />{label}</button>)}<div className="admin-sidebar-footer"><ShieldCheck size={16} /><span>ADMIN ACCESS<br /><b>ROLE VERIFIED</b></span></div></aside>
      <section className="admin-main">{tab === 'providers' ? <ProviderManagement /> : loading ? <Loading label="正在读取管理数据…" /> : <>
        {tab === 'overview' && <><div className="admin-panel-heading"><div><span className="eyebrow">OVERVIEW / LIVE DATA</span><h2>平台概览</h2></div><span className="admin-live"><i /> DATABASE CONNECTED</span></div><div className="admin-stats-grid"><div><Users size={18} /><span>注册用户</span><strong>{overview?.stats.users ?? 0}</strong><small>所有账户</small></div><div><FileText size={18} /><span>创作项目</span><strong>{overview?.stats.projects ?? 0}</strong><small>用户工作区</small></div><div><Activity size={18} /><span>对话线程</span><strong>{overview?.stats.conversations ?? 0}</strong><small>已创建会话</small></div><div><BookOpen size={18} /><span>已发布文章</span><strong>{overview?.stats.articles ?? 0}</strong><small>Research 内容</small></div></div><div className="admin-table-card"><div className="admin-table-heading"><h3>最近注册用户</h3><button onClick={() => setTab('users')}>管理用户 <ArrowUpRight size={14} /></button></div><UserTable users={overview?.recentUsers || []} onRoleChange={changeRole} /></div></>}
        {tab === 'users' && <><div className="admin-panel-heading"><div><span className="eyebrow">IDENTITY / ACCESS</span><h2>用户管理</h2></div><span className="table-count">{users.length} USERS</span></div><UserTable users={users} onRoleChange={changeRole} /></>}
        {tab === 'articles' && <><div className="admin-panel-heading"><div><span className="eyebrow">RESEARCH / CMS</span><h2>研究内容</h2></div><Button onClick={createArticle}><Plus size={15} /> 新建文章</Button></div>{showEditor && <form className="cms-editor" onSubmit={saveArticle}><div className="cms-editor-heading"><h3>{article.id ? '编辑研究文章' : '创建研究文章'}</h3><button type="button" onClick={() => setShowEditor(false)}><X size={17} /></button></div><div className="cms-form-grid"><label>标题<input value={article.title} onChange={(e) => setArticle({ ...article, title: e.target.value, slug: article.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') })} required maxLength={180} /></label><label>URL 标识<input value={article.slug} onChange={(e) => setArticle({ ...article, slug: e.target.value })} required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>分类<input value={article.category} onChange={(e) => setArticle({ ...article, category: e.target.value })} required maxLength={50} /></label><label>状态<select value={article.status} onChange={(e) => setArticle({ ...article, status: e.target.value })}><option value="draft">草稿</option><option value="published">立即发布</option></select></label><label className="cms-full">摘要<textarea value={article.summary} onChange={(e) => setArticle({ ...article, summary: e.target.value })} rows={2} maxLength={500} /></label><label className="cms-full">正文（Markdown）<textarea value={article.body} onChange={(e) => setArticle({ ...article, body: e.target.value })} rows={10} required minLength={20} maxLength={50000} /></label></div><div className="cms-editor-actions"><Button type="submit" disabled={saving}>{saving ? '保存中…' : '保存文章'} <ArrowUpRight size={14} /></Button><Button variant="ghost" onClick={() => setShowEditor(false)}>取消</Button></div></form>}<div className="admin-article-list">{articles.map((item) => <div className="admin-article-row" key={item.id}><div><span>{item.category} · {item.status === 'published' ? '已发布' : '草稿'}</span><strong>{item.title}</strong><small>/{item.slug}</small></div><div className="admin-article-actions"><button onClick={() => editArticle(item)}>编辑</button><button onClick={() => deleteArticle(item)}>删除</button></div></div>)}</div></>}
      </>}</section>
    </div>
  </main>;
}

function UserTable({ users, onRoleChange }) {
  if (!users.length) return <div className="table-empty">目前没有用户记录。</div>;
  return <div className="admin-table-scroll"><table className="admin-table"><thead><tr><th>用户</th><th>邮箱</th><th>角色</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{users.map((member) => <tr key={member.id}><td><div className="table-user"><span>{member.name?.slice(0, 1)?.toUpperCase() || 'N'}</span><strong>{member.name}</strong></div></td><td>{member.email}</td><td><span className={`role-pill ${member.role}`}>{member.role}</span></td><td>{new Date(`${member.created_at.replace(' ', 'T')}Z`).toLocaleDateString()}</td><td><select aria-label={`更改 ${member.name} 角色`} value={member.role} onChange={(e) => onRoleChange(member, e.target.value)}><option value="user">user</option><option value="admin">admin</option></select></td></tr>)}</tbody></table></div>;
}
