/**
 * TuneBridge token proxy — a tiny Cloudflare Worker that performs the OAuth token exchange
 * for services whose token endpoint requires a client secret (SoundCloud; optionally Deezer).
 *
 * The browser sends { provider, grant_type, code, code_verifier, redirect_uri } or
 * { provider, grant_type: 'refresh_token', refresh_token }; the worker adds the secret and
 * forwards the request. Secrets never reach the browser.
 *
 * Deploy (free tier is plenty):
 *   1. npm create cloudflare@latest tunebridge-proxy  →  choose "Hello World" worker, paste this file as src/index.js
 *   2. npx wrangler secret put SOUNDCLOUD_CLIENT_ID
 *      npx wrangler secret put SOUNDCLOUD_CLIENT_SECRET
 *   3. Set ALLOWED_ORIGINS in wrangler.toml [vars], e.g. "https://momalekiii.github.io,http://127.0.0.1:8000"
 *   4. npx wrangler deploy  →  put the worker URL into config.js → soundcloud.tokenEndpoint
 */

const PROVIDERS = {
  soundcloud: {
    tokenUrl: 'https://secure.soundcloud.com/oauth/token',
    clientId: (env) => env.SOUNDCLOUD_CLIENT_ID,
    clientSecret: (env) => env.SOUNDCLOUD_CLIENT_SECRET,
  },
  // Optional: only used when Deezer's browser (implicit) flow is not available for your app.
  // Secrets: DEEZER_APP_ID, DEEZER_APP_SECRET.
  deezer: {
    clientId: (env) => env.DEEZER_APP_ID,
    clientSecret: (env) => env.DEEZER_APP_SECRET,
    async exchange({ clientId, clientSecret, form }) {
      const url = new URL('https://connect.deezer.com/oauth/access_token.php');
      url.searchParams.set('app_id', clientId);
      url.searchParams.set('secret', clientSecret);
      url.searchParams.set('code', form.get('code') || '');
      url.searchParams.set('output', 'json');
      return fetch(url.toString());
    },
  },
};

const ALLOWED_FIELDS = new Set(['grant_type', 'code', 'code_verifier', 'redirect_uri', 'refresh_token']);

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.length === 0 || allowed.includes(origin) ? origin || '*' : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = { ...corsHeaders(origin, env), 'Content-Type': 'application/json' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers });
    if (headers['Access-Control-Allow-Origin'] === 'null') return new Response(JSON.stringify({ error: 'origin_not_allowed' }), { status: 403, headers });

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400, headers });
    }
    const provider = PROVIDERS[body.provider];
    if (!provider) return new Response(JSON.stringify({ error: 'unknown_provider' }), { status: 400, headers });
    const clientId = provider.clientId(env);
    const clientSecret = provider.clientSecret(env);
    if (!clientId || !clientSecret) return new Response(JSON.stringify({ error: 'proxy_not_configured' }), { status: 500, headers });

    const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
    for (const [key, value] of Object.entries(body)) {
      if (ALLOWED_FIELDS.has(key) && typeof value === 'string') form.set(key, value);
    }
    if (!['authorization_code', 'refresh_token'].includes(form.get('grant_type'))) {
      return new Response(JSON.stringify({ error: 'unsupported_grant_type' }), { status: 400, headers });
    }

    const upstream = provider.exchange
      ? await provider.exchange({ clientId, clientSecret, form })
      : await fetch(provider.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json; charset=utf-8' },
        body: form.toString(),
      });
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers });
  },
};
