import { BrainCircuit, FlaskConical, Layers3, Code2, UserRound, CreditCard, ShieldCheck } from 'lucide-react';
import { CardLink, PageIntro } from '../components/UI';

export default function Products() {
  return <main className="page-wrap container-wide">
    <PageIntro eyebrow="NOVA ECOSYSTEM" title={<>为智能时代<br />打造的工作方式。</>} description="每个模块都有独立页面、数据入口和明确的使用场景。" />
    <div className="feature-grid products-grid">
      <CardLink to="/chat" icon={BrainCircuit} eyebrow="01 / INTELLIGENCE" title="NOVA Intelligence" description="在持久化对话空间中探索问题。连接模型 API 后，即可使用服务端 Provider Adapter 处理请求。" label="打开聊天工作区" />
      <CardLink to="/research" icon={FlaskConical} eyebrow="02 / KNOWLEDGE" title="NOVA Research" description="浏览文章分类、搜索主题、阅读详情。管理员可以在后台创建、编辑和发布内容。" label="浏览研究内容" />
      <CardLink to="/studio" icon={Layers3} eyebrow="03 / CREATION" title="NOVA Studio" description="创建项目，保存描述与正文，在个人工作区持续组织你的创作。" label="打开 Studio" />
      <CardLink to="/models" icon={BrainCircuit} eyebrow="04 / MODEL LAYER" title="Models" description="查看接入状态与当前模型信息。凭据只存在服务端环境变量，不会暴露到浏览器。" label="查看模型" />
      <CardLink to="/account" icon={UserRound} eyebrow="05 / IDENTITY" title="User Center" description="管理账户资料、查看个人项目入口，并安全退出当前会话。" label="进入个人中心" />
      <CardLink to="/pricing" icon={CreditCard} eyebrow="06 / PLANS" title="Pricing" description="了解当前免费体验方案和未来订阅能力。支付功能暂不启用，不会虚构扣款流程。" label="查看方案" />
      <CardLink to="/developers" icon={Code2} eyebrow="07 / DEVELOPERS" title="Developers" description="查看 API 路由、认证方式、环境配置与本地运行说明。" label="阅读文档" />
      <CardLink to="/admin" icon={ShieldCheck} eyebrow="08 / OPERATIONS" title="Admin" description="受角色权限保护的运营后台，查看用户、项目、对话和研究内容统计。" label="进入管理后台" />
    </div>
  </main>;
}
