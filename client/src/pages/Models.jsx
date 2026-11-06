import { useEffect, useState } from 'react';
import { ArrowUpRight, BrainCircuit, CircleDashed, LockKeyhole, Server, SlidersHorizontal } from 'lucide-react';
import { api } from '../lib/api';
import { Button, ErrorNotice, Loading, PageIntro } from '../components/UI';

export default function Models() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/v1/models').then(setData).catch((e) => setError(e.message)); }, []);
  const model = data?.models?.find((item) => item.id === data.defaultModelId) || data?.models?.find((item) => item.selectable) || null;
  const configured = Boolean(data?.configured);

  return <main className="page-wrap container-wide">
    <PageIntro eyebrow="NOVA MODEL LAYER" title={<>模型是引擎，<br />体验才是方向。</>} description="NOVA 不绑定单一模型服务。通过服务器端 Provider Adapter，你可以接入兼容 OpenAI Chat Completions 格式的 API。" />
    <ErrorNotice>{error}</ErrorNotice>
    {!data && !error && <Loading label="正在读取模型配置…" />}
    <div className="model-status-card">
      <div className="model-status-main">
        <div className="model-status-icon"><BrainCircuit size={25} /></div>
        <div>
          <span className="eyebrow">ACTIVE MODEL CONFIGURATION</span>
          <h2>{model?.name || '尚未配置模型接口'}</h2>
          <p>{configured
            ? '服务端凭据和模型标识已配置；尚未执行上游连通性或健康检查。'
            : '目前没有可用的模型配置。添加服务端 API 配置后，才能发起真实模型请求。'}</p>
        </div>
      </div>
      <div className={'connection-state ' + (configured ? 'configured' : 'disconnected')}>
        <CircleDashed size={15} />
        {configured ? 'CONFIGURED · UNVERIFIED' : 'NOT CONFIGURED'}
      </div>
    </div>
    {data?.models?.length > 0 && <div className="config-reference">
      <div><span className="eyebrow">MODEL REGISTRY</span><h3>模型目录 <span className="model-registry-count">{data.models.length}</span></h3><p>所有密钥仅存在服务端；只有已配置且启用的模型能在 Chat 中选择。</p></div>
      <div className="model-registry-list">
        {data.models.map((item) => <div className="model-registry-row" key={item.id}>
          <div><strong>{item.name}</strong><span>{item.providerName || item.provider} · {item.capabilities?.join(' / ') || 'text'}</span></div>
          <span className={'model-registry-status ' + (item.selectable ? 'is-selectable' : 'is-disabled')}>{item.selectable ? '已配置 · 状态未知' : item.enabled ? '未配置' : '已禁用'}</span>
        </div>)}
      </div>
      <div className="config-warning"><CircleDashed size={15} />上游健康状态：未知。只有真实探测成功后，NOVA 才会显示已验证。</div>
    </div>}
    <div className="model-steps">
      <div><span>01</span><Server size={19} /><h3>配置 API 地址</h3><p>在服务端设置 AI_BASE_URL，填写兼容接口的基础地址。</p></div>
      <div><span>02</span><LockKeyhole size={19} /><h3>添加 API 密钥</h3><p>将 AI_API_KEY 写入服务器环境变量，不要放进前端代码。</p></div>
      <div><span>03</span><SlidersHorizontal size={19} /><h3>指定模型标识</h3><p>通过 AI_MODEL 填写上游服务所要求的模型 ID。</p></div>
    </div>
    <div className="config-reference">
      <div><span className="eyebrow">SERVER ENVIRONMENT</span><h3>需要的配置项</h3><p>修改服务器 .env 后重启 API 服务。</p></div>
      <pre><code>{'AI_BASE_URL=https://your-provider.example/v1\nAI_API_KEY=your-secret-key\nAI_MODEL=your-model-name\nAI_TIMEOUT_MS=60000\n\n# Optional: register multiple OpenAI-compatible providers\nAI_PROVIDERS_JSON=[{"id":"deepseek","name":"DeepSeek","baseUrl":"https://api.deepseek.com/v1","apiKey":"server-only-key","models":[{"id":"deepseek-chat","name":"DeepSeek Chat"}]}]\nAI_DEFAULT_MODEL=deepseek:deepseek-chat'}</code></pre>
      <div className="config-warning"><LockKeyhole size={15} />这些值只在服务器端读取，状态接口不会返回 API 密钥。多 Provider 配置使用 JSON 数组，模型 ID 使用 providerId:modelId 形式。</div>
    </div>
    <div className="model-bottom-cta"><div><h3>开始连接你的模型</h3><p>查看接口约定与 Provider Adapter 的工作方式。</p></div><Button to="/developers" variant="outline">开发者文档 <ArrowUpRight size={15} /></Button></div>
  </main>;
}
