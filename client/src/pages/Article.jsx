import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Eyebrow, Loading, ErrorNotice } from '../components/UI';

export default function Article() {
  const { slug } = useParams();
  const [article, setArticle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { setLoading(true); api(`/api/research/${encodeURIComponent(slug)}`).then((data) => setArticle(data.article)).catch((e) => setError(e.message)).finally(() => setLoading(false)); }, [slug]);
  if (loading) return <main className="page-wrap container-wide"><Loading label="正在打开文章…" /></main>;
  if (error || !article) return <main className="page-wrap container-wide"><ErrorNotice>{error || '文章不存在。'}</ErrorNotice><Link className="back-link" to="/research"><ArrowLeft size={16} /> 返回研究列表</Link></main>;
  return <main className="article-page container-wide">
    <Link className="back-link" to="/research"><ArrowLeft size={16} /> 所有研究</Link>
    <div className="article-header"><Eyebrow>NOVA RESEARCH / {article.category}</Eyebrow><h1>{article.title}</h1><p>{article.summary}</p><div className="article-byline"><span>BY NOVA EDITORIAL</span><span>{article.published_at ? new Date(`${article.published_at.replace(' ', 'T')}Z`).toLocaleDateString() : 'NOVA'}</span></div></div>
    <div className="article-divider" />
    <article className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{article.body}</ReactMarkdown></article>
    <div className="article-end"><span>END OF ARTICLE</span><Link to="/research">继续阅读 <ArrowUpRight size={15} /></Link></div>
  </main>;
}
