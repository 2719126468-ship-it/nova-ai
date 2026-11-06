import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronRight, LoaderCircle } from 'lucide-react';

export function Eyebrow({ children, light = false }) { return <div className={`eyebrow ${light ? 'eyebrow-light' : ''}`}>{children}</div>; }
export function PageIntro({ eyebrow, title, description, actions }) {
  return <div className="page-intro"><div><Eyebrow>{eyebrow}</Eyebrow><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="page-intro-actions">{actions}</div>}</div>;
}
export function Button({ children, to, variant = 'primary', onClick, type = 'button', disabled = false, className = '' }) {
  const classes = `button button-${variant} ${className}`;
  if (to) return <Link to={to} className={classes}>{children}</Link>;
  return <button type={type} className={classes} onClick={onClick} disabled={disabled}>{children}</button>;
}
export function CardLink({ to, icon: Icon, eyebrow, title, description, label = '探索产品' }) {
  return <Link to={to} className="feature-card">
    <div className="feature-card-top">{Icon && <span className="feature-icon"><Icon size={21} strokeWidth={1.7} /></span>}<span className="feature-card-arrow"><ArrowUpRight size={17} /></span></div>
    {eyebrow && <span className="feature-eyebrow">{eyebrow}</span>}<h3>{title}</h3><p>{description}</p><span className="feature-card-label">{label}<ChevronRight size={14} /></span>
  </Link>;
}
export function Loading({ label = '加载中…' }) { return <div className="loading-state"><LoaderCircle className="spin" size={20} />{label}</div>; }
export function ErrorNotice({ children }) { return children ? <div className="notice notice-error" role="alert">{children}</div> : null; }
export function EmptyState({ icon: Icon, title, description, action }) {
  return <div className="empty-state"><div className="empty-state-icon">{Icon && <Icon size={24} />}</div><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function FormField({ label, children, hint }) { return <label className="form-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
