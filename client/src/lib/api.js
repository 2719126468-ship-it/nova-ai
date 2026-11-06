const fallbackApiUrl = window.location.protocol + '//' + window.location.hostname + ':4000';
const API_URL = (import.meta.env.VITE_API_URL || fallbackApiUrl).replace(/\/+$/, '');

function apiError(data, status) {
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
    ...options,
    method,
    headers,
    credentials: 'include',
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw apiError(data, response.status);
  return data;
}

export async function* apiStream(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'text/event-stream');
  headers.set('X-Requested-With', 'NOVA-Web');
  const response = await fetch(API_URL + path, {
    ...options,
    method: 'POST',
    headers,
    credentials: 'include',
  });
  const type = response.headers.get('content-type') || '';
  if (!response.ok) {
    const data = type.includes('application/json') ? await response.json() : { message: await response.text() };
    throw apiError(data, response.status);
  }
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
      const result = await reader.read();
      buffer += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
      if (result.done) break;
    }
    if (buffer.trim()) {
      const parsed = parseFrame(buffer);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock();
  }
}

export const json = (value) => JSON.stringify(value);
