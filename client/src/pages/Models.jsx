import { useEffect, useState } from 'react';
import { ArrowUpRight, BrainCircuit, CircleDashed, LockKeyhole, Server, SlidersHorizontal } from 'lucide-react';
import { api } from '../lib/api';
import { Button, ErrorNotice, Loading, PageIntro } from '../components/UI';

export default function Models() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/v1/models').then(setData).catch((e) => setError(e.message)); }, []);
  const model = data?.models?.[0];
  const configured = Boolean(data?.configured);

  return <main className="page-wrap container-wide">
    <PageIntro eyebrow="NOVA MODEL LAYER" title={<>模型是引擎，<br />体验才是方向。</>} description="NOVA 不绑定单一模型服务。通过服务器端 Provider Adapter，你可以接入兼容 OpenAI Chat Completions 格式的 API。" />
    <ErrorNotice>{error}</ErrorNotice>
    {!data && !error && <Loading label="正在读取模型配置…" />}
    {data && <div className="model-status-card">
      <div className="model-status-main">
        <div className="model-status-icon"><BrainCircuit size={25} /></div>
        <div>
          <span className="eyebrow">ACTIVE MODEL CONFIGURATION</span>
          <h2>{model?.name || '尚未配置模型服务'}</h2>
          <p>{configured
            ? '服务端模型配置完整，但尚未主动检查上游连通性；当前不能确认模型服务可用。'
            : '目前没有可用的模型配置。添加服务端 API 配置后，才能发起真实模型请求。'}</p>
        </div>
      </div>
      <div className={'connection-state ' + (configured ? 'configured' : 'disconnected')}>
        <CircleDashed size={15} />
        {configured ? 'CONFIGURED · NOT CHECKED' : 'NOT CONFIGURED'}
      </div>
    </div>}
    {configured && <div className="config-reference">
      <div><span className="eyebrow">MODEL STATUS</span><h3>已登记的模型</h3><p>模型目录只反映服务端配置，不代表上游实时健康。</p></div>
      <pre><code>{JSON.stringify({
        id: model?.id,
        provider: model?.provider,
        enabled: model?.enabled,
        selectable: model?.selectable,
        status: model?.status,
        statusLabel: model?.statusLabel,
        capabilities: model?.capabilities,
        contextLimit: model?.contextLimit,
      }, null, 2)}</code></pre>
      <div className="config-warning"><CircleDashed size={15} />上游健康状态：未检查。NOVA 不会把配置完整误报为已连接或健康。</div>
    </div>}
    <div className="model-steps">
      <div><span>01</span><Server size={19} /><h3>配置 API 地址</h3><p>在服务端设置 AI_BASE_URL，填写兼容接口的基础地址。</p></div>
      <div><span>02</span><LockKeyhole size={19} /><h3>添加 API 密钥</h3><p>将 AI_API_KEY 写入服务器环境变量，不要放进前端代码。</p></div>
      <div><span>03</span><SlidersHorizontal size={19} /><h3>指定模型标识</h3><p>通过 AI_MODEL 填写上游服务所要求的模型 ID。</p></div>
    </div>
    <div className="config-reference">
      <div><span className="eyebrow">SERVER ENVIRONMENT</span><h3>需要的配置项</h3><p>修改服务器 .env 后重启 API 服务。</p></div>
      <pre><code>{'AI_BASE_URL=https://your-provider.example/v1\nAI_API_KEY=your-secret-key\nAI_MODEL=your-model-name\nAI_TIMEOUT_MS=60000'}</code></pre>
      <div className="config-warning"><LockKeyhole size={15} />这些值只在服务器端读取，状态接口不会返回 API 密钥。</div>
    </div>
    <div className="model-bottom-cta"><div><h3>开始连接你的模型</h3><p>查看接口约定与 Provider Adapter 的工作方式。</p></div><Button to="/developers" variant="outline">开发者文档 <ArrowUpRight size={15} /></Button></div>
  </main>;
}
