import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import Brand from '../components/Brand';
import { useAuth } from '../context/AuthContext';
import { Button, ErrorNotice, FormField } from '../components/UI';

export default function Auth() {
  const location = useLocation();
  const [mode, setMode] = useState(location.pathname === '/register' ? 'register' : 'login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { login, register } = useAuth();
  const navigate = useNavigate();
  async function submit(event) {
    event.preventDefault(); setError(''); setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, name);
      navigate(location.state?.from?.pathname || '/account', { replace: true });
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <main className="auth-layout"><div className="auth-aside"><Brand /><div className="auth-aside-art"><div className="auth-ring ring-a" /><div className="auth-ring ring-b" /><div className="auth-symbol">✳</div></div><div className="auth-aside-copy"><span>YOUR SPACE FOR IDEAS</span><h2>让每一个<br />好奇的念头，<br /><em>都有开始的地方。</em></h2></div><div className="auth-aside-footer">NOVA INTELLIGENCE PLATFORM / 2026</div></div>
    <div className="auth-main"><Link to="/" className="auth-back"><ArrowLeft size={15} /> 返回首页</Link><div className="auth-form-wrap"><div className="auth-icon"><LockKeyhole size={20} /></div><div className="auth-overline">NOVA ACCOUNT</div><h1>{mode === 'login' ? '欢迎回来。' : '创建你的账户。'}</h1><p className="auth-subtitle">{mode === 'login' ? '登录后继续你的探索。' : '建立账户，保存你的对话和项目。'}</p>
      <form className="form-stack" onSubmit={submit}>{mode === 'register' && <FormField label="姓名"><input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="你希望如何被称呼？" required maxLength={60} /></FormField>}
        <FormField label="邮箱"><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" required maxLength={254} /></FormField>
        <FormField label="密码" hint={mode === 'register' ? '至少 10 个字符。' : undefined}><div className="password-field"><input type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="输入密码" required minLength={mode === 'register' ? 10 : 1} maxLength={72} /><button type="button" aria-label="切换密码可见性" onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></FormField>
        <ErrorNotice>{error}</ErrorNotice><Button type="submit" disabled={busy} className="auth-submit">{busy ? '请稍候…' : mode === 'login' ? '登录账户' : '创建账户'} <ArrowUpRight size={16} /></Button>
      </form><div className="auth-switch">{mode === 'login' ? '还没有 NOVA 账户？' : '已经有账户了？'} <button onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}> {mode === 'login' ? '立即注册' : '返回登录'}</button></div><div className="auth-legal">继续即表示你同意遵守服务条款与隐私说明。当前项目为独立开发版本。</div></div></div>
  </main>;
}
