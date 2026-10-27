// fetch() wrapper with rate-limit handling, retries, typed errors and a JSONP fallback.
import { sleep, throwIfAborted, abortError } from './util.js';

export class ApiError extends Error {
  constructor(message, { status = 0, body = null, url = '', retryAfter = 0, code = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.url = url;
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

export function toQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((item) => search.append(key, String(item)));
    else search.append(key, String(value));
  }
  return search.toString();
}

export function withQuery(url, params) {
  const query = toQuery(params);
  if (!query) return url;
  return url + (url.includes('?') ? '&' : '?') + query;
}

function extractMessage(body, fallback) {
  if (!body) return fallback;
  if (typeof body === 'string') return body.slice(0, 200) || fallback;
  const candidates = [
    body.error?.message,
    body.error_description,
    body.errors?.[0]?.detail,
    body.errors?.[0]?.title,
    body.error?.errors?.[0]?.message,
    body.message,
    typeof body.error === 'string' ? body.error : null,
    body.error?.type ? `${body.error.type}: ${body.error.message || ''}` : null,
  ];
  return candidates.find((c) => typeof c === 'string' && c.trim()) || fallback;
}

function extractCode(body) {
  return (
    body?.error?.errors?.[0]?.reason ||
    body?.errors?.[0]?.code ||
    body?.error?.code ||
    body?.error ||
    ''
  );
}

/**
 * http(url, options)
 *  - query: object appended to the URL
 *  - json: object sent as JSON body
 *  - form: object sent as application/x-www-form-urlencoded
 *  - retries: how many times to retry on 429/5xx/network errors
 *  - parse: 'json' (default) | 'text' | 'none'
 */
export async function http(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    query,
    json,
    form,
    body,
    signal,
    retries = 3,
    parse = 'json',
    timeoutMs = 45000,
  } = options;

  const finalUrl = withQuery(url, query);
  const requestHeaders = { Accept: 'application/json', ...headers };
  let requestBody = body;
  if (json !== undefined) {
    requestHeaders['Content-Type'] = requestHeaders['Content-Type'] || 'application/json';
    requestBody = JSON.stringify(json);
  } else if (form !== undefined) {
    requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    requestBody = toQuery(form);
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    throwIfAborted(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(finalUrl, { method, headers: requestHeaders, body: requestBody, signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw abortError();
      if (attempt < retries) {
        attempt += 1;
        await sleep(400 * 2 ** attempt, { signal });
        continue;
      }
      throw new ApiError(`Network error while calling ${new URL(finalUrl).host}. ${error.message || ''}`.trim(), { url: finalUrl });
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        parsed = text;
      }
    }

    if (response.ok) {
      if (parse === 'none') return null;
      if (parse === 'text') return text;
      return parsed;
    }

    const retryAfterHeader = Number(response.headers.get('Retry-After'));
    const retryAfter = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : 0;
    const retriable = response.status === 429 || (response.status >= 500 && response.status !== 501);
    if (retriable && attempt < retries) {
      attempt += 1;
      const wait = retryAfter ? Math.min(retryAfter, 90) * 1000 : 600 * 2 ** attempt;
      await sleep(wait, { signal });
      continue;
    }

    const message = extractMessage(parsed, `${response.status} ${response.statusText || 'request failed'}`);
    throw new ApiError(message, { status: response.status, body: parsed, url: finalUrl, retryAfter, code: extractCode(parsed) });
  }
}

/** JSONP helper used as a fallback for APIs that reject cross-origin fetches (Deezer). */
export function jsonp(url, { timeoutMs = 20000, callbackParam = 'callback' } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new ApiError('JSONP is only available in a browser', { url }));
      return;
    }
    const callbackName = `__tunebridge_jsonp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const script = document.createElement('script');
    const timer = setTimeout(() => {
      cleanup();
      reject(new ApiError('Request timed out', { url }));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
    }
    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new ApiError('Request failed (script could not load)', { url }));
    };
    script.src = withQuery(url, { [callbackParam]: callbackName });
    document.head.append(script);
  });
}

/** Limits concurrency and enforces a minimum gap between calls. */
export function createLimiter({ concurrency = 4, minIntervalMs = 0 } = {}) {
  let active = 0;
  let lastStart = 0;
  const queue = [];
  const pump = () => {
    if (active >= concurrency || queue.length === 0) return;
    const now = Date.now();
    const wait = Math.max(0, lastStart + minIntervalMs - now);
    if (wait > 0) {
      setTimeout(pump, wait);
      return;
    }
    const { fn, resolve, reject } = queue.shift();
    active += 1;
    lastStart = Date.now();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        pump();
      });
    pump();
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
