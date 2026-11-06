import { useEffect, useState } from 'react';
import { ArrowUpRight, BrainCircuit, CheckCircle2, CircleDashed, LockKeyhole, Server, SlidersHorizontal } from 'lucide-react';
import { api } from '../lib/api';
import { Button, ErrorNotice, Loading, PageIntro } from '../components/UI';

export default function Models() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/models').then(setData).catch((e) => setError(e.message)); }, []);
  return <main className="page-wrap container-wide"><PageIntro eyebrow="NOVA MODEL LAYER" title={<>模型是引擎，<br />体验才是方向。</>} description="NOVA 不绑定单一模型服务。通过服务器端 Provider Adapter，你可以接入兼容 OpenAI Chat Completions 格式的 API。" />
    <ErrorNotice>{error}</ErrorNotice>
    <div className="model-status-card"><div className="model-status-main"><div className="model-status-icon"><BrainCircuit size={25} /></div><div><span className="eyebrow">ACTIVE PROVIDER</span><h2>{data?.configured ? data.models?.[0]?.name : '尚未连接模型'}</h2><p>{data?.configured ? '服务端已检测到可用的 Provider 配置。' : '核心平台已经就绪。添加 API 配置后即可启用真实模型调用。'}</p></div></div><div className={`connection-state ${data?.configured ? 'connected' : 'disconnected'}`}>{data?.configured ? <CheckCircle2 size={15} /> : <CircleDashed size={15} />}{data?.configured ? 'CONNECTED' : 'NOT CONFIGURED'}</div></div>
    <div className="model-steps"><div><span>01</span><Server size={19} /><h3>配置 API 地址</h3><p>在服务端设置 AI_BASE_URL，填写兼容接口的基础地址。</p></div><div><span>02</span><LockKeyhole size={19} /><h3>添加 API 密钥</h3><p>将 AI_API_KEY 写入服务器环境变量，不要放进前端代码。</p></div><div><span>03</span><SlidersHorizontal size={19} /><h3>选择模型</h3><p>通过 AI_MODEL 指定模型名称，服务端会自动调用适配层。</p></div></div>
    <div className="config-reference"><div><span className="eyebrow">SERVER ENVIRONMENT</span><h3>需要的配置项</h3><p>修改服务器 `.env` 后重启 API 服务。</p></div><pre><code>{`AI_BASE_URL=https://your-provider.example/v1
AI_API_KEY=your-secret-key
AI_MODEL=your-model-name
AI_TIMEOUT_MS=60000`}</code></pre><div className="config-warning"><LockKeyhole size={15} />这些值只在服务器端读取，状态接口不会返回 API 密钥。</div></div>
    <div className="model-bottom-cta"><div><h3>开始连接你的模型</h3><p>查看接口约定与 Provider Adapter 的工作方式。</p></div><Button to="/developers" variant="outline">开发者文档 <ArrowUpRight size={15} /></Button></div>
  </main>;
}
