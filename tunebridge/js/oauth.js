// Browser-side OAuth helpers: PKCE, redirect bookkeeping and the local token store.
// Tokens never leave the browser; they are kept in localStorage per service.
import { local, session } from './storage.js';
import { toQuery } from './http.js';
import { randomId } from './util.js';

const PENDING_KEY = 'tunebridge.pendingAuth';
const TOKEN_PREFIX = 'tunebridge.token.';

/** The page URL without query/hash — this is what must be registered as redirect URI. */
export function getRedirectUri() {
  if (typeof location === 'undefined') return 'http://127.0.0.1:8000/';
  const path = location.pathname.replace(/index\.html$/i, '');
  return `${location.origin}${path}`;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function createPkcePair() {
  const verifier = randomId(64);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export const randomState = () => randomId(24);

/**
 * Remember what we were doing, then send the browser to the provider's login page.
 * The page reloads on the way back, so everything needed later lives in sessionStorage.
 */
export function beginRedirectAuth({ provider, authorizeUrl, params, verifier = null, extra = null }) {
  const pending = { provider, verifier, state: params.state || null, extra, startedAt: Date.now() };
  session.set(PENDING_KEY, pending);
  local.set(PENDING_KEY, pending); // read by the new tab when the login has to leave an embedded frame
  const url = `${authorizeUrl}${authorizeUrl.includes('?') ? '&' : '?'}${toQuery(params)}`;
  if (isFramed()) {
    // Login pages refuse to render inside iframes (X-Frame-Options), so leave the frame: a new tab
    // completes the login, lands back on TuneBridge and picks the pending transfer up from storage.
    const popup = window.open(url, '_blank');
    if (popup) return new Promise(() => {});
  }
  location.assign(url);
  return new Promise(() => {}); // never resolves: the page is navigating away
}

/** True when the app is embedded in another page (preview panes, iframes). */
export function isFramed() {
  try { return window.top !== window.self; } catch (_) { return true; }
}

/**
 * Called once on page load. Detects ?code= / #access_token= redirects, validates state and
 * returns { provider, code, token, expiresIn, verifier, extra, error } — or null when the
 * page was loaded normally.
 */
export function consumeRedirect() {
  if (typeof location === 'undefined') return null;
  const url = new URL(location.href);
  const search = url.searchParams;
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const code = search.get('code');
  const token = hash.get('access_token');
  const error = search.get('error') || hash.get('error') || hash.get('error_reason');
  if (!code && !token && !error) return null;

  const fromLocal = local.get(PENDING_KEY);
  const pending = session.get(PENDING_KEY) || (fromLocal && Date.now() - (fromLocal.startedAt || 0) < 30 * 60 * 1000 ? fromLocal : null);
  session.remove(PENDING_KEY);
  local.remove(PENDING_KEY);
  history.replaceState(null, '', `${url.origin}${url.pathname}`);

  const errorDescription = search.get('error_description') || hash.get('error_description') || '';
  if (!pending) {
    return { provider: null, error: error ? `${error}${errorDescription ? ': ' + errorDescription : ''}` : 'Sign-in session expired. Please try again.' };
  }
  const returnedState = search.get('state') || hash.get('state');
  if (pending.state && returnedState && returnedState !== pending.state) {
    return { provider: pending.provider, error: 'Sign-in could not be verified (state mismatch). Please try again.' };
  }
  return {
    provider: pending.provider,
    code,
    token,
    tokenType: hash.get('token_type'),
    expiresIn: Number(hash.get('expires_in') || hash.get('expires') || 0) || 0,
    scope: hash.get('scope') || search.get('scope') || '',
    verifier: pending.verifier,
    extra: pending.extra,
    error: error ? `${error}${errorDescription ? ': ' + errorDescription : ''}` : null,
  };
}

export const tokens = {
  get(provider) {
    return local.get(TOKEN_PREFIX + provider);
  },
  set(provider, token) {
    local.set(TOKEN_PREFIX + provider, { ...token, savedAt: Date.now() });
  },
  clear(provider) {
    local.remove(TOKEN_PREFIX + provider);
  },
  clearAll() {
    for (const key of local.keys(TOKEN_PREFIX)) local.remove(key);
  },
};
