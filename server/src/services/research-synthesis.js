import { createAssistantReply } from './provider.js';

const MAX_SOURCES = 10;
const MAX_SNIPPET = 1200;
const MAX_NOTES = 4000;
const MAX_QUERY = 300;

export class ResearchSynthesisError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'ResearchSynthesisError';
    this.code = code;
    this.status = status;
  }
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export function normalizeSynthesisSources(rawSources) {
  if (!Array.isArray(rawSources)) {
    throw new ResearchSynthesisError('VALIDATION_ERROR', 400, '需要提供来源列表。');
  }
  const sources = [];
  const seen = new Set();
  for (const item of rawSources.slice(0, MAX_SOURCES * 2)) {
    if (!item || typeof item !== 'object') continue;
    let parsed;
    try {
      parsed = new URL(typeof item.url === 'string' ? item.url : '');
    } catch {
      continue;
    }
    if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) continue;
    const url = parsed.toString();
    if (seen.has(url)) continue;
    const title = cleanText(item.title, 300);
    if (!title) continue;
    seen.add(url);
    sources.push({
      title,
      url,
      domain: parsed.hostname,
      snippet: cleanText(item.snippet, MAX_SNIPPET),
      publishedAt: cleanText(item.publishedAt, 100) || null,
    });
    if (sources.length >= MAX_SOURCES) break;
  }
  if (!sources.length) {
    throw new ResearchSynthesisError('VALIDATION_ERROR', 400, '没有可用的有效来源（需要 HTTP/HTTPS 链接和标题）。');
  }
  return sources;
}

export function buildSynthesisMessages({ query, sources, notes }) {
  const sourceBlock = sources.map((source, index) => [
    '[' + (index + 1) + '] ' + source.title,
    'URL: ' + source.url,
    source.publishedAt ? 'Published: ' + source.publishedAt : null,
    source.snippet ? 'Excerpt: ' + source.snippet.replace(/\s+/g, ' ') : 'Excerpt: (none returned by the search provider)',
  ].filter(Boolean).join('\n')).join('\n\n');

  const system = [
    'You are assisting a research workspace. Write a short, structured research brief in Chinese.',
    'Hard rules:',
    '1. Every factual sentence must cite the source index it comes from, like [1] or [2][3].',
    '2. The excerpts are retrieval snippets, not verified facts. If a snippet is ambiguous, truncated, or does not support a claim, say so instead of filling the gap.',
    '3. Never invent a source, URL, author, date, quotation, or number that is not present in the provided material.',
    '4. Separate three sections explicitly: "已检索事实" (only what the excerpts state), "综合判断" (your inference, labelled as inference), and "待核实" (open questions and what to check on the original pages).',
    '5. Keep it under roughly 500 Chinese characters. Do not add a bibliography; the application appends the citation index.',
  ].join('\n');

  const user = [
    'Research question: ' + query,
    '',
    'Retrieved sources:',
    sourceBlock,
    notes ? '\nOwner notes (treat as the user\'s own judgement, not evidence):\n' + notes : '',
    '',
    'Write the brief now.',
  ].filter(Boolean).join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Draft a cited research brief from user-selected sources. The output is always
 * labelled as model synthesis; the caller must keep it separate from retrieved
 * facts in the saved document.
 */
export async function synthesizeResearch({ query, sources, notes, modelId, signal }) {
  const cleanQuery = cleanText(query, MAX_QUERY);
  if (cleanQuery.length < 2) {
    throw new ResearchSynthesisError('VALIDATION_ERROR', 400, '研究问题必须为 2–300 个字符。');
  }
  const normalizedSources = normalizeSynthesisSources(sources);
  const cleanNotes = cleanText(notes, MAX_NOTES);
  const messages = buildSynthesisMessages({ query: cleanQuery, sources: normalizedSources, notes: cleanNotes });

  const content = await createAssistantReply(messages, { modelId, signal });
  return {
    query: cleanQuery,
    modelId: modelId || null,
    sourceCount: normalizedSources.length,
    synthesis: content,
    generatedAt: new Date().toISOString(),
    disclosure: '本节由模型根据所选检索摘要生成，属于模型综合而非已核验事实；引用前必须打开原始页面核对。',
  };
}
