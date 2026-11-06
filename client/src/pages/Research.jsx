import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Eyebrow, Loading, PageIntro, ErrorNotice, EmptyState } from '../components/UI';

export default function Research() {
  const [articles, setArticles] = useState([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/research').then((data) => setArticles(data.articles)).catch((e) => setError(e.message)).finally(() => setLoading(false)); }, []);
  const categories = useMemo(() => ['全部', ...new Set(articles.map((item) => item.category))], [articles]);
  const filtered = articles.filter((article) => (category === '全部' || article.category === category) && `${article.title} ${article.summary} ${article.category}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="page-wrap container-wide">
    <PageIntro eyebrow="NOVA RESEARCH / IDEAS & PERSPECTIVES" title={<>思想的边界，<br />值得不断探索。</>} description="围绕人工智能、技术趋势与产品实践展开的阅读空间。内容可通过管理后台持续更新。" />
    <div className="research-toolbar"><label className="search-box"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索主题、标题或关键词…" /></label><div className="filter-pills">{categories.map((item) => <button key={item} className={category === item ? 'filter-pill active' : 'filter-pill'} onClick={() => setCategory(item)}>{item}</button>)}</div></div>
    <ErrorNotice>{error}</ErrorNotice>
    {loading ? <Loading label="正在读取研究文章…" /> : filtered.length ? <div className="research-list">{filtered.map((article, index) => <Link className="research-row" key={article.id} to={`/research/${article.slug}`}><span className="research-number">{String(index + 1).padStart(2, '0')}</span><div className="research-row-main"><div className="research-meta"><span>{article.category}</span><span>{article.published_at ? new Date(`${article.published_at.replace(' ', 'T')}Z`).toLocaleDateString() : 'NOVA Research'}</span></div><h2>{article.title}</h2><p>{article.summary}</p></div><span className="research-arrow"><ArrowUpRight size={19} /></span></Link>)}</div> : <EmptyState title="没有找到匹配内容" description="试试其他关键词，或切换文章分类。" />}
    <div className="research-note"><Eyebrow>EDITORIAL NOTE</Eyebrow><p>部分初始文章属于项目演示内容，发布到正式站点前请由编辑审核、补充来源并确认事实。</p></div>
  </main>;
}
