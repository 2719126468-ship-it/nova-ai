import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, BookOpen, ExternalLink, FilePlus2, LoaderCircle, Search, Sparkles } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api, json } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { Button, Eyebrow, Loading, PageIntro, ErrorNotice, EmptyState } from '../components/UI';

function safeMarkdownText(value) {
  return String(value || '').replace(/[\\\\`*_{}[\]()#+.!|>~-]/g, '\\\\$&');
}

export default function Research() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [articles, setArticles] = useState([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeView, setActiveView] = useState('articles');
  const [webQuery, setWebQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchMeta, setSearchMeta] = useState(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState([]);
  const [notesBySource, setNotesBySource] = useState({});
  const [savingReport, setSavingReport] = useState(false);
  const [synthesis, setSynthesis] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [draftModel, setDraftModel] = useState(null);

  useEffect(() => {
    let active = true;
    api('/api/research')
      .then((data) => { if (active) setArticles(Array.isArray(data.articles) ? data.articles : []); })
      .catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const categories = useMemo(() => ['全部', ...new Set(articles.map((item) => item.category))], [articles]);
  const filtered = articles.filter((article) =>
    (category === '全部' || article.category === category)
    && `${article.title} ${article.summary} ${article.category}`.toLowerCase().includes(query.toLowerCase()));
  const selectedSources = searchResults.filter((source) => selectedSourceIds.includes(source.id));

  async function runWebSearch(event) {
    event.preventDefault();
    const term = webQuery.trim();
    if (term.length < 2) {
      setSearchError('请输入至少 2 个字符的研究关键词。');
      return;
    }
    if (!user) {
      setSearchError('网络研究需要登录后使用。');
      return;
    }
    setSearchLoading(true);
    setSearchError('');
    setSearchResults([]);
    setSelectedSourceIds([]);
    setNotesBySource({});
    setSynthesis('');
    setDraftError('');
    setDraftModel(null);
    setSearchMeta(null);
    try {
      const result = await api('/api/v1/research/search', {
        method: 'POST',
        body: json({ query: term, count: 8 }),
      });
      setSearchResults(Array.isArray(result.sources) ? result.sources : []);
      setSearchMeta({
        provider: result.provider,
        retrievedAt: result.retrievedAt,
        moreResultsAvailable: Boolean(result.moreResultsAvailable),
      });
    } catch (cause) {
      setSearchError(cause.message || '真实搜索请求失败，请稍后重试。');
    } finally {
      setSearchLoading(false);
    }
  }

  async function draftSynthesis() {
    if (!selectedSources.length || drafting) return;
    setDrafting(true);
    setDraftError('');
    try {
      const result = await api('/api/v1/research/synthesize', {
        method: 'POST',
        body: json({
          query: webQuery.trim(),
          notes: selectedSources.map((source) => (notesBySource[source.id] || '').trim()).filter(Boolean).join('\n'),
          sources: selectedSources.map((source) => ({
            title: source.title,
            url: source.url,
            snippet: source.snippet || '',
            publishedAt: source.publishedAt || null,
          })),
        }),
      });
      setSynthesis(result.synthesis || '');
      setDraftModel({ modelId: result.modelId, generatedAt: result.generatedAt, disclosure: result.disclosure });
    } catch (cause) {
      setDraftError(cause.code === 'AI_PROVIDER_NOT_CONFIGURED'
        ? '尚未配置可用模型，无法生成研究草稿。你仍可以手动填写综合分析。'
        : (cause.message || '生成研究草稿失败，请稍后重试。'));
    } finally {
      setDrafting(false);
    }
  }

  function toggleSource(sourceId) {
    setSelectedSourceIds((current) => current.includes(sourceId)
      ? current.filter((id) => id !== sourceId)
      : [...current, sourceId]);
  }

  function buildResearchMarkdown() {
    const reportTitle = '网络研究：' + webQuery.trim();
    const sections = [
      '# ' + safeMarkdownText(reportTitle),
      '',
      '> 检索时间：' + (searchMeta?.retrievedAt || new Date().toISOString()),
      '> 搜索关键词：' + webQuery.trim(),
      '> 搜索服务：' + (searchMeta?.provider || '未知'),
      '> 内容分级：本报告区分「检索资料」（外部返回，未核验）、「我的笔记」（人工判断）和「未证实推测」（模型或作者推断）。',
      '',
      '## 一、检索资料（来自搜索服务，未经独立核验）',
      '',
      '以下标题、摘要和日期均由外部搜索服务返回，NOVA 未逐一打开原文验证，不得直接当作已确认事实引用。',
      '',
    ];
    selectedSources.forEach((source, index) => {
      const note = (notesBySource[source.id] || '').trim();
      sections.push('### [' + (index + 1) + '] ' + safeMarkdownText(source.title));
      sections.push('');
      if (source.snippet) {
        sections.push('> ' + safeMarkdownText(source.snippet).replace(/\n/g, '\n> '));
        sections.push('');
      }
      sections.push('- 来源：[' + safeMarkdownText(source.domain) + '](<' + source.url + '>)');
      if (source.publishedAt) sections.push('- 页面日期：' + safeMarkdownText(source.publishedAt));
      if (source.engines?.length) sections.push('- 检索引擎：' + source.engines.map(safeMarkdownText).join('、'));
      if (note) {
        sections.push('');
        sections.push('**我的笔记（人工判断，非检索事实）**');
        sections.push('');
        sections.push(note.split(/\r?\n/).map((line) => safeMarkdownText(line)).join('  \n'));
      }
      sections.push('');
    });
    sections.push('## 二、我的综合分析（未证实，需逐条核对来源）');
    sections.push('');
    const synthesisText = synthesis.trim();
    if (synthesisText) {
      if (draftModel) {
        sections.push('> 生成方式：模型 ' + (draftModel.modelId || '服务端默认模型') + ' 根据上方检索摘要生成（' + draftModel.generatedAt + '）。这是模型综合，不是已核验事实。');
        sections.push('');
      }
      sections.push(synthesisText.split(/\r?\n/).map((line) => safeMarkdownText(line)).join('  \n'));
    } else {
      sections.push('（尚未填写。此节用于区分作者或模型推断与上方的检索资料。）');
    }
    sections.push('');
    sections.push('## 三、未证实推测');
    sections.push('');
    sections.push('- 本报告未包含模型自动生成的结论；后续补写的推断需在此节逐条标注“推测”并说明依据缺口。');
    sections.push('- 检索摘要可能过时、断章取义或与原文冲突，任何结论都需要打开原文复核。');
    sections.push('');
    sections.push('## 引用索引');
    sections.push('');
    selectedSources.forEach((source, index) => sections.push('[' + (index + 1) + ']: ' + source.url));
    sections.push('');
    sections.push('> 说明：检索资料来自搜索服务，摘录不是独立事实核验；「我的综合分析」与「未证实推测」两节不代表已核实结论。正式引用前请打开原始页面核对上下文、作者与发布日期。');
    return { title: reportTitle.slice(0, 120), content: sections.join('\n') };
  }

  async function saveSelectedSources() {
    if (!user || !selectedSources.length || savingReport) return;
    setSavingReport(true);
    setSearchError('');
    try {
      const report = buildResearchMarkdown();
      const result = await api('/api/v1/documents', {
        method: 'POST',
        body: json({ title: report.title, content: report.content }),
      });
      navigate('/documents/' + result.document.id);
    } catch (cause) {
      setSearchError('保存到 Documents 失败：' + (cause.message || '请重试。'));
    } finally {
      setSavingReport(false);
    }
  }

  return <main className="page-wrap container-wide research-page">
    <PageIntro eyebrow="NOVA RESEARCH / IDEAS & EVIDENCE" title={<>从检索开始，<br />让观点有据可循。</>} description="浏览 NOVA 编辑文章，或使用已配置的真实搜索服务查找外部来源。网络检索结果会保留原始链接，便于核验和整理。" />
    <div className="research-view-tabs" role="group" aria-label="Research 内容类型">
      <button type="button" aria-pressed={activeView === 'articles'} className={activeView === 'articles' ? 'active' : ''} onClick={() => setActiveView('articles')}><BookOpen size={15} /> 精选文章</button>
      <button type="button" aria-pressed={activeView === 'web'} className={activeView === 'web' ? 'active' : ''} onClick={() => setActiveView('web')}><Search size={15} /> 网络研究</button>
    </div>

    {activeView === 'articles' ? <>
      <div className="research-toolbar">
        <label className="search-box"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索主题、标题或关键词…" /></label>
        <div className="filter-pills">{categories.map((item) => <button key={item} className={category === item ? 'filter-pill active' : 'filter-pill'} onClick={() => setCategory(item)}>{item}</button>)}</div>
      </div>
      <ErrorNotice>{error}</ErrorNotice>
      {loading ? <Loading label="正在读取研究文章…" /> : filtered.length ? <div className="research-list">{filtered.map((article, index) => <Link className="research-row" key={article.id} to={`/research/${article.slug}`}><span className="research-number">{String(index + 1).padStart(2, '0')}</span><div className="research-row-main"><div className="research-meta"><span>{article.category}</span><span>{article.published_at ? new Date(`${article.published_at.replace(' ', 'T')}Z`).toLocaleDateString() : 'NOVA Research'}</span></div><h2>{article.title}</h2><p>{article.summary}</p></div><span className="research-arrow"><ArrowUpRight size={19} /></span></Link>)}</div> : <EmptyState title="没有找到匹配内容" description="试试其他关键词，或切换文章分类。" />}
      <div className="research-note"><Eyebrow>EDITORIAL NOTE</Eyebrow><p>精选文章由 NOVA 编辑后台发布；它们与实时互联网搜索结果分开呈现。正式发布前请审核事实并补充来源。</p></div>
    </> : <>
      <section className="research-search-panel">
        <div className="research-search-intro">
          <span className="eyebrow">LIVE WEB SEARCH</span>
          <h2>搜索外部资料</h2>
          <p>结果来自服务器配置的 SearXNG 或 Brave Search。搜索密钥不会发送到浏览器；如果服务尚未配置，页面会明确提示，不会用示例内容代替真实结果。</p>
        </div>
        <form className="research-web-search-form" onSubmit={runWebSearch}>
          <label className="search-box"><Search size={17} /><input value={webQuery} onChange={(event) => setWebQuery(event.target.value)} maxLength={300} placeholder="输入研究问题或关键词…" aria-label="网络研究搜索关键词" /></label>
          <button className="research-search-submit" type="submit" disabled={searchLoading || !webQuery.trim()}>{searchLoading ? <><LoaderCircle size={15} className="spin" /> 搜索中…</> : <><Search size={15} /> 搜索网络</>}</button>
        </form>
        {!user && <p className="research-login-hint">登录后可使用网络搜索并将选中的来源保存到私人 Documents。<Link to="/login">登录 NOVA <ArrowUpRight size={13} /></Link></p>}
        <ErrorNotice>{searchError}</ErrorNotice>
        {searchLoading && <Loading label="正在向真实搜索服务请求结果…" />}
        {!searchLoading && searchMeta && <div className="research-search-meta" role="status">
          <span>返回 {searchResults.length} 条来源</span>
          <span>Provider：{searchMeta.provider}</span>
          <time>{new Date(searchMeta.retrievedAt).toLocaleString()}</time>
          {searchMeta.moreResultsAvailable && <span>还有更多结果，可调整关键词缩小范围</span>}
        </div>}
      </section>
      {!searchLoading && searchMeta && searchResults.length === 0 && <EmptyState title="没有找到相关来源" description="尝试换用更具体的关键词，或减少限定条件。" />}
      {searchResults.length > 0 && <section className="research-results-section">
        <div className="research-results-heading">
          <div><span className="eyebrow">SEARCH RESULTS</span><h2>检索来源 <span>{searchResults.length}</span></h2></div>
          <span>勾选需要整理的资料</span>
        </div>
        <div className="research-source-list">
          {searchResults.map((source, index) => <article className="research-source-card" key={source.id}>
            <label className="research-source-select">
              <input type="checkbox" checked={selectedSourceIds.includes(source.id)} onChange={() => toggleSource(source.id)} />
              <span>引用 {index + 1}</span>
            </label>
            <div className="research-source-body">
              <a className="research-source-title" href={source.url} target="_blank" rel="noopener noreferrer">{source.title} <ExternalLink size={14} /></a>
              <div className="research-source-meta"><span>{source.domain}</span>{source.publishedAt && <time>{source.publishedAt}</time>}{source.engines?.length > 0 && <span>引擎：{source.engines.join('、')}</span>}</div>
              {source.snippet && <p>{source.snippet}</p>}
              {selectedSourceIds.includes(source.id) && <label className="research-source-note">研究笔记<textarea rows={2} maxLength={1200} value={notesBySource[source.id] || ''} onChange={(event) => setNotesBySource((current) => ({ ...current, [source.id]: event.target.value }))} placeholder="记录你对这条来源的判断、摘录或待核实问题…" /></label>}
            </div>
          </article>)}
        </div>
        <section className="research-synthesis">
          <label htmlFor="research-synthesis-input">我的综合分析（可选，保存时标记为未证实推断）</label>
          <textarea
            id="research-synthesis-input"
            rows={4}
            maxLength={4000}
            value={synthesis}
            onChange={(event) => setSynthesis(event.target.value)}
            placeholder="写下你基于这些来源的判断。保存后会与检索资料分开标注，不表示已核验事实。"
          />
          <div className="research-synthesis-actions">
            <Button type="button" variant="outline" onClick={draftSynthesis} disabled={drafting || !selectedSources.length}>
              {drafting ? <><LoaderCircle size={14} className="spin" /> 正在生成…</> : <><Sparkles size={14} /> 用所选来源生成草稿</>}
            </Button>
            <small>{synthesis.length.toLocaleString()} / 4,000 · 生成内容会标注为模型综合，不会写成已核验事实。</small>
          </div>
          {draftModel && <small className="research-synthesis-disclosure">草稿来自 {draftModel.modelId || '服务端默认模型'}，生成于 {new Date(draftModel.generatedAt).toLocaleString()}。{draftModel.disclosure}</small>}
          {draftError && <p className="research-synthesis-error" role="alert">{draftError}</p>}
        </section>
        <div className="research-organize-bar">
          <span>已选择 {selectedSources.length} / {searchResults.length} 条来源</span>
          <button type="button" onClick={saveSelectedSources} disabled={!user || !selectedSources.length || savingReport}>{savingReport ? <><LoaderCircle size={15} className="spin" /> 保存中…</> : <><FilePlus2 size={15} /> 整理并保存到 Documents</>}</button>
        </div>
      </section>}
      <div className="research-source-disclaimer">来源说明：搜索标题、摘要和日期来自外部检索服务，可能不完整或过时。NOVA 不会将摘要标记为已核实事实；引用前请打开原文确认。</div>
    </>}
  </main>;
}
