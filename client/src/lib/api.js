const fallbackApiUrl = `${window.location.protocol}//${window.location.hostname}:4000`;
const API_URL = (import.meta.env.VITE_API_URL || fallbackApiUrl).replace(/\/+$/, '');

export async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-Requested-With', 'NOVA-Web');
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    method,
    headers,
    credentials: 'include',
  });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(data?.message || data?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.code = data?.error;
    error.details = data?.details;
    throw error;
  }
  return data;
}

export const json = (value) => JSON.stringify(value);
