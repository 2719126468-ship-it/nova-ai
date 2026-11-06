import { useEffect, useState } from 'react';
import { ArrowUpRight, BadgeCheck, Download, FolderKanban, KeyRound, LogOut, Mail, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api, json } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Button, ErrorNotice, FormField, Loading } from '../components/UI';

export default function Account() {
  const { user, logout, refresh } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState(user?.name || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [projects, setProjects] = useState([]);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
  async function exportData() {
    setExporting(true); setError(''); setNotice('');
    try {
      const data = await api('/api/v1/auth/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = window.URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = 'nova-account-export-' + user.id + '.json';
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      setNotice('个人数据导出已开始下载。导出文件请妥善保管。');
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(false);
    }
  }
  async function deleteAccount(event) {
    event.preventDefault();
    if (deleting) return;
    if (!window.confirm('确认永久删除 NOVA 账户？项目、对话、消息和登录会话都会删除，且无法撤销。')) return;
    setDeleting(true); setError(''); setNotice('');
    try {
      await api('/api/v1/auth/me', {
        method: 'DELETE',
        body: json({ currentPassword: deletePassword, confirmEmail }),
      });
      await logout().catch(() => {});
      navigate('/', { replace: true });
    } catch (e) {
      setError(e.message);
    } finally {
      setDeleting(false);
    }
  }
  async function signOut() { await logout(); navigate('/', { replace: true }); }
  if (!user) return <main className="page-wrap container-wide"><Loading /></main>;
  return <main className="page-wrap container-wide account-page"><div className="account-heading"><div><span className="eyebrow">NOVA ACCOUNT / PERSONAL SPACE</span><h1>你的账户。</h1><p>在这里管理个人资料、安全设置与项目。</p></div><div className="account-avatar">{user.name.slice(0, 1).toUpperCase()}</div></div>
    <ErrorNotice>{error}</ErrorNotice>{notice && <div className="notice notice-success">{notice}</div>}
    <div className="account-grid"><aside className="account-nav"><div className="account-nav-user"><div className="account-avatar small">{user.name.slice(0, 1).toUpperCase()}</div><div><strong>{user.name}</strong><span>{user.email}</span></div></div><a href="#profile"><UserRound size={16} />个人资料</a><a href="#security"><ShieldCheck size={16} />安全设置</a><a href="#projects"><FolderKanban size={16} />我的项目</a><a href="#data"><ShieldCheck size={16} />数据管理</a><button onClick={signOut}><LogOut size={16} />退出登录</button></aside>
      <div className="account-content"><section id="profile" className="settings-card"><div className="settings-card-heading"><div className="settings-icon"><UserRound size={18} /></div><div><h2>个人资料</h2><p>更新你在 NOVA 中的显示信息。</p></div></div><form className="settings-form" onSubmit={updateProfile}><FormField label="显示名称"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required /></FormField><FormField label="邮箱地址"><div className="read-only-field"><Mail size={15} />{user.email}<span>不可更改</span></div></FormField><div className="settings-footer"><span><BadgeCheck size={14} />账户已创建</span><Button type="submit" disabled={saving || name.trim() === user.name}>保存资料</Button></div></form></section>
        <section id="security" className="settings-card"><div className="settings-card-heading"><div className="settings-icon"><KeyRound size={18} /></div><div><h2>安全设置</h2><p>定期更新密码，保护你的账户。</p></div></div><form className="settings-form" onSubmit={updatePassword}><FormField label="当前密码"><input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" required /></FormField><FormField label="新密码" hint="至少 10 个字符。"><input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" minLength={10} maxLength={72} required /></FormField><div className="settings-footer"><span>更改密码后，其他会话将被注销</span><Button type="submit" variant="outline" disabled={saving}>更新密码</Button></div></form></section>
        <section id="projects" className="settings-card"><div className="settings-card-heading"><div className="settings-icon"><FolderKanban size={18} /></div><div><h2>我的项目</h2><p>你在 Studio 中创建的内容。</p></div><Link to="/studio">打开 Studio <ArrowUpRight size={14} /></Link></div>{loading ? <Loading /> : projects.length ? <div className="account-project-list">{projects.slice(0, 5).map((project) => <Link to={`/studio/${project.id}`} key={project.id}><span>{project.title}</span><small>{new Date(`${project.updated_at.replace(' ', 'T')}Z`).toLocaleDateString()}</small><ArrowUpRight size={15} /></Link>)}</div> : <p className="account-empty">还没有项目。<Link to="/studio">创建第一个项目 ↗</Link></p>}</section>
        <section id="data" className="settings-card account-data-card"><div className="settings-card-heading"><div className="settings-icon"><Download size={18} /></div><div><h2>个人数据</h2><p>导出你保存的内容，或永久删除账户与个人数据。</p></div></div>
          <div className="account-data-export"><div><strong>导出账户数据</strong><span>下载个人资料、项目、项目关联、对话、消息和你创建的 Research 文章。</span><small>不会包含密码哈希、登录令牌或 Provider API 密钥。</small></div><Button type="button" variant="outline" disabled={exporting} onClick={exportData}><Download size={14} />{exporting ? '正在准备…' : '导出 JSON'}</Button></div>
          <div className="account-delete-panel"><div className="account-delete-heading"><Trash2 size={16} /><strong>删除账户</strong></div><p>此操作会删除你的项目、对话、消息、项目关联和登录会话。已发布的 Research 内容会保留，但作者关联将清除。</p>
            <form className="settings-form" onSubmit={deleteAccount}><FormField label="当前密码"><input type="password" value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} autoComplete="current-password" required minLength={1} maxLength={72} /></FormField><FormField label="输入账户邮箱确认"><input type="email" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} placeholder={user.email} autoComplete="email" required maxLength={254} /></FormField><div className="settings-footer"><span>删除后无法恢复，请先导出需要保留的数据。</span><Button type="submit" variant="outline" disabled={deleting || !deletePassword || !confirmEmail} className="account-delete-button">{deleting ? '正在删除…' : '永久删除账户'}</Button></div></form>
          </div>
        </section>
        {user.role === 'admin' && <div className="admin-access-card"><ShieldCheck size={19} /><div><strong>管理员权限已启用</strong><span>你可以访问 NOVA 管理后台。</span></div><Link to="/admin">打开后台 <ArrowUpRight size={14} /></Link></div>}
      </div>
    </div>
  </main>;
}
