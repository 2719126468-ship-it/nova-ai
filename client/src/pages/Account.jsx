import { useEffect, useState } from 'react';
import { ArrowUpRight, BadgeCheck, FolderKanban, KeyRound, LogOut, Mail, ShieldCheck, UserRound } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api, json } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Button, ErrorNotice, FormField, Loading } from '../components/UI';

export default function Account() {
  const { user, logout, refresh } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState(user?.name || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [projects, setProjects] = useState([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => { setName(user?.name || ''); api('/api/projects').then((data) => setProjects(data.projects)).catch(() => {}).finally(() => setLoading(false)); }, [user]);
  async function updateProfile(event) {
    event.preventDefault(); setSaving(true); setError(''); setNotice('');
    try { await api('/api/auth/me', { method: 'PATCH', body: json({ name }) }); await refresh(); setNotice('账户资料已更新。'); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }
  async function updatePassword(event) {
    event.preventDefault(); setSaving(true); setError(''); setNotice('');
    try { await api('/api/auth/password', { method: 'PATCH', body: json({ currentPassword, newPassword }) }); await logout(); navigate('/login', { replace: true }); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }
  async function signOut() { await logout(); navigate('/', { replace: true }); }
  if (!user) return <main className="page-wrap container-wide"><Loading /></main>;
  return <main className="page-wrap container-wide account-page"><div className="account-heading"><div><span className="eyebrow">NOVA ACCOUNT / PERSONAL SPACE</span><h1>你的账户。</h1><p>在这里管理个人资料、安全设置与项目。</p></div><div className="account-avatar">{user.name.slice(0, 1).toUpperCase()}</div></div>
    <ErrorNotice>{error}</ErrorNotice>{notice && <div className="notice notice-success">{notice}</div>}
    <div className="account-grid"><aside className="account-nav"><div className="account-nav-user"><div className="account-avatar small">{user.name.slice(0, 1).toUpperCase()}</div><div><strong>{user.name}</strong><span>{user.email}</span></div></div><a href="#profile"><UserRound size={16} />个人资料</a><a href="#security"><ShieldCheck size={16} />安全设置</a><a href="#projects"><FolderKanban size={16} />我的项目</a><button onClick={signOut}><LogOut size={16} />退出登录</button></aside>
      <div className="account-content"><section id="profile" className="settings-card"><div className="settings-card-heading"><div className="settings-icon"><UserRound size={18} /></div><div><h2>个人资料</h2><p>更新你在 NOVA 中的显示信息。</p></div></div><form className="settings-form" onSubmit={updateProfile}><FormField label="显示名称"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></FormField><FormField label="邮箱地址"><div className="read-only-field"><Mail size={15} />{user.email}<span>不可更改</span></div></FormField><div className="settings-footer"><span><BadgeCheck size={14} />账户已创建</span><Button type="submit" disabled={saving || name.trim() === user.name}>保存资料</Button></div></form></section>
        <section id="security" className="settings-card"><div className="settings-card-heading"><div className="settings-icon"><KeyRound size={18} /></div><div><h2>安全设置</h2><p>定期更新密码，保护你的账户。</p></div></div><form className="settings-form" onSubmit={updatePassword}><FormField label="当前密码"><input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required /></FormField><FormField label="新密码" hint="至少 10 个字符。"><input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={72} required /></FormField><div className="settings-footer"><span>更改密码后，其他会话将被注销</span><Button type="submit" variant="outline" disabled={saving}>更新密码</Button></div></form></section>
        <section id="projects" className="settings-card"><div className="settings-card-heading"><div className="settings-icon"><FolderKanban size={18} /></div><div><h2>我的项目</h2><p>你在 Studio 中创建的内容。</p></div><Link to="/studio">打开 Studio <ArrowUpRight size={14} /></Link></div>{loading ? <Loading /> : projects.length ? <div className="account-project-list">{projects.slice(0, 5).map((project) => <Link to={`/studio/${project.id}`} key={project.id}><span>{project.title}</span><small>{new Date(`${project.updated_at.replace(' ', 'T')}Z`).toLocaleDateString()}</small><ArrowUpRight size={15} /></Link>)}</div> : <p className="account-empty">还没有项目。<Link to="/studio">创建第一个项目 ↗</Link></p>}</section>
        {user.role === 'admin' && <div className="admin-access-card"><ShieldCheck size={19} /><div><strong>管理员权限已启用</strong><span>你可以访问 NOVA 管理后台。</span></div><Link to="/admin">打开后台 <ArrowUpRight size={14} /></Link></div>}
      </div>
    </div>
  </main>;
}
