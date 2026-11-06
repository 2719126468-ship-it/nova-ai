import { Children, isValidElement, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import jsonLanguage from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import cssLanguage from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import diff from 'highlight.js/lib/languages/diff';

const codeHighlightLanguages = {
  javascript,
  typescript,
  python,
  json: jsonLanguage,
  bash,
  css: cssLanguage,
  xml,
  sql,
  yaml,
  markdown,
  java,
  go,
  diff,
};

const codeHighlightAliases = {
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  typescript: ['ts', 'tsx'],
  python: ['py', 'py3'],
  bash: ['sh', 'shell', 'zsh'],
  xml: ['html', 'xhtml', 'svg'],
  yaml: ['yml'],
  markdown: ['md'],
};

function extractCodeText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(extractCodeText).join('');
  if (isValidElement(value)) return extractCodeText(value.props.children);
  return '';
}

function MarkdownCodeBlock({ children }) {
  const codeNode = Children.toArray(children).find(isValidElement);
  const codeChildren = codeNode?.props?.children ?? children;
  const className = codeNode?.props?.className || '';
  const language = className.match(/(?:^|\s)language-([a-z0-9_-]+)/i)?.[1] || '';
  const codeText = extractCodeText(codeChildren);
  const [copyState, setCopyState] = useState('idle');
  const copyTimer = useRef(null);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  async function copyCode() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(codeText);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopyState('idle'), 1600);
  }

  const languageLabel = language ? language.toUpperCase() : 'CODE';
  return <div className="markdown-code-block">
    <div className="markdown-code-toolbar">
      <span className="markdown-code-language">{languageLabel}</span>
      <button type="button" className="markdown-code-copy" onClick={copyCode}
        aria-label={copyState === 'copied' ? '代码已复制' : '复制代码块'}
        title={copyState === 'failed' ? '复制失败，请检查浏览器剪贴板权限' : '复制代码'}>
        {copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
        <span>{copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败' : '复制代码'}</span>
      </button>
    </div>
    <pre><code className={className}>{codeChildren}</code></pre>
  </div>;
}

export default function HighlightedMarkdown({ content }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[[rehypeHighlight, { languages: codeHighlightLanguages, aliases: codeHighlightAliases }]]}
    components={{ pre: MarkdownCodeBlock }}
  >{content}</ReactMarkdown>;
}
