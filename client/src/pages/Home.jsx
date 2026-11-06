import { ArrowDownRight, ArrowUpRight, AudioLines, BrainCircuit, Command, FlaskConical, Layers3, ShieldCheck, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, CardLink, Eyebrow } from '../components/UI';

export default function Home() {
  return <main>
    <section className="hero-section">
      <div className="hero-grid container-wide">
        <div className="hero-copy">
          <Eyebrow>NOVA INTELLIGENCE PLATFORM <span className="eyebrow-dot" /></Eyebrow>
          <h1>更远的思考，<br /><span>从此刻开始。</span></h1>
          <p className="hero-description">一个为探索、创造与协作而构建的 AI 平台。把复杂的技术，变成每个人都能使用的力量。</p>
          <div className="hero-actions"><Button to="/chat">开始与 NOVA 对话 <ArrowUpRight size={16} /></Button><Link to="/research" className="text-link">探索研究 <ArrowDownRight size={15} /></Link></div>
          <div className="hero-footnote"><span className="status-indicator" />产品平台持续构建中 <span className="hero-footnote-divider" />模型 API 可由你自行配置</div>
        </div>
        <div className="hero-visual" aria-label="NOVA abstract intelligence artwork">
          <div className="visual-orbit orbit-one" /><div className="visual-orbit orbit-two" /><div className="visual-orbit orbit-three" />
          <div className="visual-core"><div className="core-inner"><span>✳</span></div></div>
          <div className="visual-label visual-label-top"><span>01 / INTELLIGENCE</span><span>36° 12' 08.4"</span></div>
          <div className="visual-label visual-label-bottom"><span>BUILT FOR CURIOSITY</span><span>NOVA SYSTEMS</span></div>
          <div className="visual-chip chip-left"><BrainCircuit size={15} /><span>Reasoning</span></div><div className="visual-chip chip-right"><AudioLines size={15} /><span>Multimodal</span></div>
        </div>
      </div>
      <div className="hero-marquee"><div>THINK DEEPER <span>✳</span> CREATE MORE <span>✳</span> EXPLORE FURTHER <span>✳</span> THINK DEEPER <span>✳</span> CREATE MORE <span>✳</span> EXPLORE FURTHER <span>✳</span></div></div>
    </section>

    <section className="section-block container-wide ecosystem-section">
      <div className="section-heading"><div><Eyebrow>THE NOVA ECOSYSTEM</Eyebrow><h2>一套工具，<br />打开更多可能。</h2></div><p>从一个问题开始，延伸到研究、创作与构建。每个模块都围绕真实任务设计，而不只是一个展示入口。</p></div>
      <div className="feature-grid">
        <CardLink to="/chat" icon={Sparkles} eyebrow="01 / THINK" title="Intelligence" description="用自然语言展开对话、梳理思路，并在模型接入后完成复杂任务。" label="进入对话" />
        <CardLink to="/research" icon={FlaskConical} eyebrow="02 / DISCOVER" title="Research" description="阅读技术文章、理解 AI 发展，并通过内容管理系统持续发布研究。" label="浏览研究" />
        <CardLink to="/studio" icon={Layers3} eyebrow="03 / MAKE" title="Studio" description="在一个持续保存的工作区中创建项目、编辑内容和组织想法。" label="打开工作区" />
        <CardLink to="/models" icon={BrainCircuit} eyebrow="04 / MODELS" title="Models" description="查看当前模型连接状态、能力信息与后续 Provider 配置入口。" label="查看模型" />
      </div>
    </section>

    <section className="manifesto-section"><div className="container-wide manifesto-inner"><Eyebrow light>OUR PRINCIPLE</Eyebrow><h2>技术应该放大<br /><span>人的可能性。</span></h2><div className="manifesto-bottom"><p>我们相信，好的人工智能体验不该制造距离。它应该清晰、可靠、可控制，并在真正需要的时候给出帮助。</p><Link to="/about">认识 NOVA <ArrowUpRight size={15} /></Link></div><div className="manifesto-stamp">N<br />✳<br />A</div></div></section>

    <section className="section-block container-wide build-section"><div className="build-intro"><Eyebrow>BUILT TO BE EXTENDED</Eyebrow><h2>你的平台。<br />你的模型。你的规则。</h2><p>核心功能独立运行，模型服务通过标准化 Provider Adapter 接入。API 地址、密钥和模型名称只需在服务器端配置。</p><Button to="/developers" variant="outline">查看开发者文档 <ArrowUpRight size={15} /></Button></div><div className="build-points"><div><span>01</span><div><ShieldCheck size={20} /><h3>安全优先</h3><p>服务端会话、权限隔离、请求校验与速率限制。</p></div></div><div><span>02</span><div><Command size={20} /><h3>开放接口</h3><p>前后端通过清晰的 REST API 协作，不绑死某一家模型。</p></div></div><div><span>03</span><div><Layers3 size={20} /><h3>可持续扩展</h3><p>SQLite 起步，模块边界清楚，后续可以平滑升级。</p></div></div></div></section>

    <section className="closing-cta"><div className="container-wide closing-inner"><div><Eyebrow light>YOUR NEXT IDEA STARTS HERE</Eyebrow><h2>准备好开始探索了吗？</h2></div><Button to="/chat" variant="light">开始使用 NOVA <ArrowUpRight size={16} /></Button></div></section>
  </main>;
}
