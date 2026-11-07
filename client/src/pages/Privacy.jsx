import { ArrowUpRight, Database, FileText, ShieldCheck, Server } from 'lucide-react';
import { Button, Eyebrow, PageIntro } from '../components/UI';

const SECTIONS = [
  {
    icon: Server,
    title: '哪些内容会发送给第三方模型服务',
    body: [
      '当你发送一条消息时，NOVA 会把当前输入、本轮之前已完成的对话历史、你启用的项目指令，以及你显式勾选“加入上下文”的项目资料节选，一并发送给管理员配置的模型 Provider（OpenAI-compatible 接口）。',
      '模型服务由部署者选择与配置，可能位于其他司法辖区。NOVA 不控制第三方的日志保留、训练使用或滥用审查策略；具体条款以该 Provider 的公开政策为准。',
      'NOVA 不会把 API Key、其他账户的对话、未勾选的项目文件或未启用的资料发送给模型。',
    ],
  },
  {
    icon: Database,
    title: 'NOVA 自己保存什么',
    body: [
      '账户信息（邮箱、姓名、bcrypt 密码哈希）、会话摘要（SHA-256，不含明文令牌）、项目与文档、对话与消息、项目资料文件，以及模型调用用量记录（Provider、模型、耗时、状态、上游返回的 Token 数）。',
      '用量记录不保存提示词或回答正文；管理员审计日志只保存操作者、动作、目标与前后值，密钥、密文、Provider 地址和用户正文在写入前被丢弃。',
      '导出：账户页可下载完整 JSON 数据；删除：需当前密码与完整邮箱确认，删除后项目、文档、项目文件、对话、消息、版本历史、用量与登录会话一并级联删除。已发布的公开 Research 文章会保留，作者关联被清空。',
    ],
  },
  {
    icon: FileText,
    title: '你拥有的控制项',
    body: [
      '项目资料默认不进入模型上下文，必须逐文件勾选；取消勾选后下一次请求即不再包含。',
      '可以随时停止生成；停止或断连会中止上游请求，并保留已生成的部分内容为“已取消”状态。',
      '可以删除单条对话、单篇文档或整个账户；删除不可撤销。',
    ],
  },
  {
    icon: ShieldCheck,
    title: '边界与限制',
    body: [
      'NOVA 不承诺永久免费、无限请求或所有模型永久可用；上游限流、额度耗尽或故障会以明确错误返回，不会伪造回答。',
      '搜索服务（SearXNG / Brave）只返回检索资料，摘要未经独立核验；保存的研究报告会区分“检索资料”“我的综合分析”“未证实推测”。',
      '这是独立开发中的项目，尚未完成独立安全审计；在公开部署前，部署者仍需补齐 HTTPS、备份恢复、告警与合规告知。',
    ],
  },
];

export default function Privacy() {
  return <main className="page-wrap container-wide privacy-page">
    <PageIntro
      eyebrow="NOVA / DATA & THIRD-PARTY DISCLOSURE"
      title={<>数据去哪，<br />由你决定。</>}
      description="这份说明回答三个问题：什么内容会被发送给第三方模型服务、NOVA 自己保存什么、你能如何控制。它不是法律文件，也不替代部署者所在地区的合规要求。"
      actions={<Button to="/chat">回到对话 <ArrowUpRight size={15} /></Button>}
    />
    <div className="privacy-sections">
      {SECTIONS.map(({ icon: Icon, title, body }) => <section className="privacy-section" key={title}>
        <div className="privacy-section-heading"><Icon size={18} /><h2>{title}</h2></div>
        {body.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      </section>)}
    </div>
    <div className="privacy-footnote"><Eyebrow>CONTACT / DEPLOYMENT</Eyebrow><p>数据控制者与联系邮箱由部署者填写。自托管部署时，请替换本页的联系方式，并按当地法规补充处理者信息、保留期限与投诉渠道。</p></div>
  </main>;
}
