import { ArrowUpRight, Compass, HeartHandshake, ShieldCheck } from 'lucide-react';
import { Button, Eyebrow } from '../components/UI';

export default function About() {
  return <main className="page-wrap container-wide about-page"><Eyebrow>ABOUT NOVA / WHY WE BUILD</Eyebrow><h1>让智能，<br /><span>服务于人。</span></h1><p className="about-lead">NOVA 是一个独立开发中的 AI 产品平台，尝试把对话、研究与创作放进一套连贯、清晰、可扩展的工作方式。</p><div className="about-rule" /><div className="about-values"><div><Compass size={21} /><span>01 / CURIOSITY</span><h3>保持好奇</h3><p>从问题出发，不把技术能力本身当成最终目的。</p></div><div><ShieldCheck size={21} /><span>02 / TRUST</span><h3>值得信赖</h3><p>诚实呈现系统状态、数据边界与模型能力。</p></div><div><HeartHandshake size={21} /><span>03 / HUMANITY</span><h3>以人为本</h3><p>工具应该让人更有掌控感，而不是制造依赖。</p></div></div><div className="about-bottom"><p>这是一项持续演进的独立项目。研究文章的示例内容需要经过编辑审核，模型 API 与支付服务也需要由平台运营者自行配置。</p><Button to="/products">探索 NOVA 产品 <ArrowUpRight size={15} /></Button></div></main>;
}

export function NotFound() {
  return <main className="not-found container-wide"><Eyebrow>404 / PAGE NOT FOUND</Eyebrow><h1>这里还没有内容。</h1><p>你访问的页面可能不存在，或已经被移动。</p><Button to="/">返回 NOVA 首页 <ArrowUpRight size={15} /></Button></main>;
}
