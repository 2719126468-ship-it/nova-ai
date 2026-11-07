import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ArrowUpRight, Menu, Moon, Sun, X } from 'lucide-react';
import Brand from './Brand';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';

const links = [
  { to: '/products', label: '产品' },
  { to: '/research', label: '研究' },
  { to: '/studio', label: 'Studio' },
  { to: '/documents', label: '文档' },
  { to: '/project-context', label: '项目资料' },
  { to: '/models', label: '模型' },
  { to: '/developers', label: '开发者' },
];

export default function Shell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();
  const isProductApp = ['/chat', '/studio', '/documents', '/project-context', '/account', '/admin'].some((prefix) => location.pathname.startsWith(prefix));
  return <div className="app-shell">
    <header className={`site-header ${isProductApp ? 'site-header-product' : ''}`}>
      <div className="header-inner">
        <Brand />
        <button className="icon-button mobile-nav-toggle" onClick={() => setMenuOpen((value) => !value)} aria-label={menuOpen ? '关闭菜单' : '打开菜单'}>
          {menuOpen ? <X size={19} /> : <Menu size={19} />}
        </button>
        <nav className={`main-nav ${menuOpen ? 'main-nav-open' : ''}`} aria-label="主导航">
          {links.map((item) => <NavLink key={item.to} to={item.to} onClick={() => setMenuOpen(false)}>{item.label}</NavLink>)}
        </nav>
        <div className="header-actions">
          <button className="icon-button theme-toggle" onClick={toggleTheme} aria-label={theme === 'light' ? '切换深色模式' : '切换浅色模式'}>
            {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
          <Link className="header-account" to={user ? '/account' : '/login'}>{user ? user.name : '登录'}</Link>
          <Link className="header-cta" to="/chat">开始探索 <ArrowUpRight size={15} /></Link>
        </div>
      </div>
    </header>
    <div className="route-content"><Outlet /></div>
    <footer className="site-footer">
      <div className="footer-top"><Brand /><p>为好奇心而构建。<br />Intelligence for everyone.</p><div className="footer-links"><Link to="/research">研究</Link><Link to="/pricing">定价</Link><Link to="/developers">开发者</Link><Link to="/about">关于 NOVA</Link><Link to="/privacy">数据与隐私</Link></div></div>
      <div className="footer-bottom"><span>© {new Date().getFullYear()} NOVA AI. Independent product project.</span><span><Link to="/privacy">数据与第三方说明</Link> · Built for people who keep exploring.</span></div>
    </footer>
  </div>;
}
