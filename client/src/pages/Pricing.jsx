import { ArrowUpRight, Check, Infinity as InfinityIcon, Sparkles } from 'lucide-react';
import { Button, Eyebrow, PageIntro } from '../components/UI';

const plans = [
  { name: 'Community', price: '$0', tag: 'CURRENT', description: '用于体验 NOVA 平台的基础功能。', features: ['研究文章阅读', '个人账户与项目管理', '基础对话工作区', '自带模型 API 配置'], action: '开始使用', to: '/login', featured: false },
  { name: 'Pro', price: '规划中', tag: 'COMING LATER', description: '为高频创作和复杂工作流准备。', features: ['更丰富的工作流工具', '团队协作与共享空间', '高级项目管理能力', '可配置的使用额度'], action: '了解开发计划', to: '/developers', featured: true },
];
export default function Pricing() {
  return <main className="page-wrap container-wide"><PageIntro eyebrow="NOVA PRICING / SIMPLE BY DESIGN" title={<>先把价值做好，<br />再谈价格。</>} description="当前 NOVA 是独立开发中的平台项目。账号和核心工作区可用于体验；付费、订阅与支付功能暂未启用。" />
    <div className="pricing-grid">{plans.map((plan) => <section className={`pricing-card ${plan.featured ? 'pricing-featured' : ''}`} key={plan.name}><div className="pricing-card-top"><span>{plan.tag}</span>{plan.featured && <Sparkles size={18} />}</div><h2>{plan.name}</h2><p>{plan.description}</p><div className="pricing-price">{plan.price}<small>{plan.name === 'Community' ? '/ 永久免费' : ''}</small></div><Button to={plan.to} variant={plan.featured ? 'primary' : 'outline'}>{plan.action} <ArrowUpRight size={15} /></Button><div className="pricing-features-title">包含内容</div><ul>{plan.features.map((feature) => <li key={feature}><Check size={15} />{feature}</li>)}</ul></section>)}</div>
    <div className="pricing-footnote"><InfinityIcon size={16} /><p>目前不提供真实支付、账单或订阅扣款。后续启用收费前，需要先接入支付服务、完善账单管理与退款政策。</p></div>
  </main>;
}
