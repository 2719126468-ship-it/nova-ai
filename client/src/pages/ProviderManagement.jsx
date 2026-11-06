import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, Database, LockKeyhole, Pencil, Plus, RefreshCw, Server, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, json } from '../lib/api';
import { Button, ErrorNotice, Loading } from '../components/UI';

const emptyDraft = () => ({
  id: '',
  name: '',
  baseUrl: '',
  apiKey: '',
  enabled: true,
  modelsText: JSON.stringify([
    { id: 'your-model-id', name: 'Model display name', enabled: true, capabilities: ['chat', 'text'], contextLimit: null },
  ], null, 2),
});

const healthLabels = {
  healthy: '已验证可访问',
  degraded: '上游受限',
  unavailable: '连接失败',
  unknown: '状态未知',
};

export default function ProviderManagement() {
  const [state, setState] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [editingId, setEditingId] = useState(null);
  const [showEditor, setShowEditor] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [healthByModel, setHealthByModel] = useState({});
  const [checkingModelId, setCheckingModelId] = useState(null);

  const load = useCallback(async () => {
    const [providerState, modelCatalog] = await Promise.all([
      api('/api/v1/admin/providers'),
      api('/api/v1/models'),
    ]);
    setState(providerState);
    setCatalog(modelCatalog);
  }, []);

  useEffect(() => {
    load().catch((cause) => setError(cause.message)).finally(() => setLoading(false));
  }, [load]);

  function beginCreate() {
    setEditingId(null);
    setDraft(emptyDraft());
    setError('');
    setNotice('');
    setShowEditor(true);
  }

  function beginEdit(provider) {
    if (provider.readOnly) return;
    setEditingId(provider.id);
    setDraft({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl || '',
      apiKey: '',
      enabled: provider.enabled,
      modelsText: JSON.stringify(provider.models || [], null, 2),
    });
    setError('');
    setNotice('');
    setShowEditor(true);
  }

  async function saveProvider(event) {
    event.preventDefault();
    if (saving) return;
    setError('');
    setNotice('');

    let models;
    try {
      models = JSON.parse(draft.modelsText);
    } catch {
      setError('模型列表不是有效 JSON，请检查括号、逗号和引号。');
      return;
    }
    if (!Array.isArray(models) || !models.length) {
      setError('至少需要配置一个模型。');
      return;
    }

    setSaving(true);
    try {
      const body = {
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        enabled: draft.enabled,
        models,
      };
      let path = '/api/v1/admin/providers';
      let method = 'POST';
      if (editingId) {
        path += '/' + encodeURIComponent(editingId);
        method = 'PUT';
        if (draft.apiKey.trim()) body.apiKey = draft.apiKey.trim();
      } else {
        body.id = draft.id.trim();
        body.apiKey = draft.apiKey.trim();
      }
      await api(path, { method, body: json(body) });
      await load();
      setShowEditor(false);
      setDraft(emptyDraft());
      setEditingId(null);
      setNotice(editingId ? 'Provider 配置已更新。' : 'Provider 已添加。');
    } catch (cause) {
      setError(cause.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleProvider(provider) {
    setError('');
    setNotice('');
    try {
      await api('/api/v1/admin/providers/' + encodeURIComponent(provider.id), {
        method: 'PUT',
        body: json({ enabled: !provider.enabled }),
      });
      await load();
      setNotice(provider.enabled ? 'Provider 已停用。' : 'Provider 已启用。');
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function deleteProvider(provider) {
    if (!window.confirm('删除 Provider「' + provider.name + '」及其模型配置？此操作无法撤销。')) return;
    setError('');
    setNotice('');
    try {
      await api('/api/v1/admin/providers/' + encodeURIComponent(provider.id), { method: 'DELETE' });
      await load();
      setNotice('Provider 已删除。');
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function updateDefaultModel(defaultModelId) {
    setError('');
    setNotice('');
    try {
      const next = await api('/api/v1/admin/model-default', {
        method: 'PUT',
        body: json({ defaultModelId: defaultModelId || null }),
      });
      setState(next);
      setNotice(defaultModelId ? '默认模型已更新。' : '已恢复自动选择默认模型。');
    } catch (cause) {
      setError(cause.message);
    }
  }

  async function checkModel(modelId) {
    if (checkingModelId) return;
    setCheckingModelId(modelId);
    setError('');
    try {
      const result = await api('/api/v1/models/health', {
        method: 'POST',
        body: json({ modelId }),
      });
      setHealthByModel((current) => ({ ...current, [modelId]: result }));
    } catch (cause) {
      setError(cause.message);
    } finally {
      setCheckingModelId(null);
    }
  }

  if (loading) return <Loading label="正在读取 Provider 配置…" />;

  const selectableModels = catalog?.models?.filter((model) => model.selectable) || [];
  const modelOptions = selectableModels.map((model) => ({
    id: model.id,
    name: model.name,
    providerName: model.providerName,
  }));

  return <section className="provider-management">
    <div className="admin-panel-heading">
      <div><span className="eyebrow">MODEL LAYER / PROVIDER CONTROL</span><h2>模型与 Provider</h2></div>
      <Button onClick={load} variant="outline"><RefreshCw size={14} /> 刷新</Button>
    </div>
    <ErrorNotice>{error}</ErrorNotice>
    {notice && <div className="provider-notice"><CheckCircle2 size={14} />{notice}</div>}

    {!state?.canManageProviders && <div className="provider-security-warning">
      <LockKeyhole size={17} />
      <div><strong>尚未启用安全凭据存储</strong><p>在服务器 .env 中设置 PROVIDER_ENCRYPTION_KEY（至少 32 个随机字符），重启 API 后才能新增或修改数据库托管的 Provider。请备份并长期保留此密钥；更换密钥会使现有 Provider 凭据无法解密。</p></div>
    </div>}

    <div className="provider-default-card">
      <div><span className="eyebrow">DEFAULT MODEL</span><strong>默认对话模型</strong><p>{state?.defaultModelSource === 'environment' ? '当前由服务器环境变量控制。' : '选择一个已启用并完成配置的模型。'}</p></div>
      <select
        aria-label="默认模型"
        value={state?.defaultModelId || ''}
        disabled={state?.defaultModelSource === 'environment' || !selectableModels.length}
        onChange={(event) => updateDefaultModel(event.target.value)}
      >
        {!state?.defaultModelId && <option value="">自动选择</option>}
        {modelOptions.map((model) => <option value={model.id} key={model.id}>{model.name} · {model.providerName}</option>)}
      </select>
    </div>

    <div className="provider-list-heading">
      <div><strong>已注册的 Provider</strong><span>{state?.providers?.length || 0} 个服务</span></div>
      <Button onClick={beginCreate} disabled={!state?.canManageProviders}><Plus size={14} /> 添加 Provider</Button>
    </div>

    {showEditor && <form className="provider-editor" onSubmit={saveProvider}>
      <div className="provider-editor-heading">
        <div><span className="eyebrow">{editingId ? 'EDIT PROVIDER' : 'NEW PROVIDER'}</span><h3>{editingId ? '编辑 Provider' : '添加 OpenAI-compatible Provider'}</h3></div>
        <button type="button" aria-label="关闭编辑器" onClick={() => setShowEditor(false)}><X size={17} /></button>
      </div>
      <div className="provider-form-grid">
        {!editingId && <label>Provider ID<input required maxLength={64} pattern="[A-Za-z0-9_-]+" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="例如 deepseek" /></label>}
        <label>显示名称<input required maxLength={120} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如 DeepSeek" /></label>
        <label className="provider-field-wide">API 基础地址<input required type="url" maxLength={500} value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
        <label className="provider-field-wide">API Key
          <input required={!editingId} type="password" autoComplete="new-password" maxLength={4000} value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={editingId ? '留空则保留当前密钥' : '只发送到服务端并以 AES-256-GCM 加密保存'} />
        </label>
        <label className="provider-enabled-field"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> 启用此 Provider</label>
        <label className="provider-field-wide">模型列表（JSON）
          <textarea required rows={8} spellCheck={false} value={draft.modelsText} onChange={(event) => setDraft({ ...draft, modelsText: event.target.value })} />
          <small>每个模型填写 id；name、enabled、capabilities、contextLimit 可选。contextLimit 是模型上下文 Token 上限，未知时填写 null。</small>
        </label>
      </div>
      <div className="provider-editor-actions">
        <Button type="submit" disabled={saving}>{saving ? '保存中…' : editingId ? '保存修改' : '添加 Provider'}</Button>
        <Button type="button" variant="ghost" onClick={() => setShowEditor(false)}>取消</Button>
      </div>
    </form>}

    {!state?.providers?.length && <div className="provider-empty"><Server size={22} /><strong>还没有 Provider</strong><span>添加兼容 OpenAI Chat Completions 的服务后，模型就会出现在 Chat 选择器中。</span></div>}

    <div className="provider-cards">
      {(state?.providers || []).map((provider) => <article className={'provider-card ' + (!provider.enabled ? 'is-disabled' : '')} key={provider.id}>
        <div className="provider-card-main">
          <div className="provider-card-title">
            <span className="provider-card-icon"><Server size={16} /></span>
            <div><strong>{provider.name}</strong><small>{provider.id} · {provider.protocol}</small></div>
            <span className={'provider-source ' + (provider.readOnly ? 'is-readonly' : '')}>{provider.readOnly ? '环境变量 · 只读' : '数据库托管'}</span>
          </div>
          <div className="provider-card-meta"><span>{provider.baseUrl || 'API 地址由服务器环境变量管理'}</span><span>{provider.models?.length || 0} 个模型</span><span>{provider.hasApiKey ? '密钥已配置' : '未配置密钥'}</span></div>
          <div className="provider-model-list">
            {(provider.models || []).map((model) => {
              const modelId = provider.id + ':' + model.id;
              const health = healthByModel[modelId];
              const publicModel = catalog?.models?.find((item) => item.id === modelId);
              return <div className="provider-model-row" key={model.id}>
                <div><strong>{model.name || model.id}</strong><small>{model.id}{model.contextLimit ? ' · ' + model.contextLimit.toLocaleString() + ' context' : ' · context 未知'}</small></div>
                <span className={'provider-model-status ' + (!model.enabled || !provider.enabled ? 'is-off' : '')}>{model.enabled && provider.enabled ? '已启用' : '已停用'}</span>
                {publicModel?.selectable && <button type="button" onClick={() => checkModel(modelId)} disabled={Boolean(checkingModelId)}>{checkingModelId === modelId ? '检查中…' : healthLabels[health?.status || 'unknown']}</button>}
              </div>;
            })}
          </div>
        </div>
        {!provider.readOnly && <div className="provider-card-actions">
          <button type="button" onClick={() => beginEdit(provider)} disabled={!state?.canManageProviders}><Pencil size={13} /> 编辑</button>
          <button type="button" onClick={() => toggleProvider(provider)} disabled={!state?.canManageProviders}>{provider.enabled ? '停用' : '启用'}</button>
          <button type="button" className="is-danger" onClick={() => deleteProvider(provider)}><Trash2 size={13} /> 删除</button>
        </div>}
        {provider.readOnly && <div className="provider-readonly-note"><Database size={13} /> 此 Provider 来自服务器环境变量，需在 .env 中修改。</div>}
      </article>)}
    </div>

    <div className="provider-security-footnote"><ShieldCheck size={14} /><span>浏览器永远不会收到 API Key 或加密后的密文。环境变量 Provider 优先于数据库托管配置；同 ID 的数据库条目不会覆盖环境配置。</span></div>
  </section>;
}
