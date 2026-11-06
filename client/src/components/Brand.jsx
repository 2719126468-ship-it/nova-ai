import { Link } from 'react-router-dom';

export default function Brand({ compact = false }) {
  return <Link className={`brand-mark ${compact ? 'brand-mark-compact' : ''}`} to="/" aria-label="NOVA 首页">
    <span className="brand-symbol">✳</span><span>NOVA</span>
  </Link>;
}
