const fallbackApiUrl = window.location.protocol + '//' + window.location.hostname + ':4000';
const API_URL = (import.meta.env.VITE_API_URL || fallbackApiUrl).replace(/\/+$/, '');

function createApiError(data, status) {
  const error = new Error(data?.message || data?.error || '请求失败（' + status + '）');
  error.status = status;
  error.code = data?.error;
  error.details = data?.details;
  return error;
}

export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-Requested-With', 'NOVA-Web');
  const response = await fetch(API_URL + path, {
    ...options, method, headers, credentials: 'include',
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw createApiError(data, response.status);
  return data;
}

/** Fetch-based SSE preserves POST bodies, session cookies and AbortSignal support. */
export async function* apiStream(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'text/event-stream');
  headers.set('X-Requested-With', 'NOVA-Web');

  const response = await fetch(API_URL + path, {
    ...options, method: 'POST', headers, credentials: 'include',
  });
  const type = response.headers.get('content-type') || '';
  if (!response.ok) {
    const data = type.includes('application/json')
      ? await response.json()
      : { message: await response.text() };
    throw createApiError(data, response.status);
  }
  if (!type.includes('text/event-stream')) throw new Error('服务端没有返回流式响应。');
  if (!response.body) throw new Error('浏览器无法读取流式响应。');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseFrame = (frame) => {
    let event = 'message';
    const data = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return null;
    const raw = data.join('\n');
    try { return { event, data: JSON.parse(raw) }; }
    catch { return { event, data: raw }; }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const packet = parseFrame(frame);
        if (packet) yield packet;
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const packet = parseFrame(buffer);
      if (packet) yield packet;
    }
  } finally {
    reader.releaseLock();
  }
}

export const json = (value) => JSON.stringify(value);
