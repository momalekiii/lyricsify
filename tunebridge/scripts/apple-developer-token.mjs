#!/usr/bin/env node
/**
 * Mint an Apple Music (MusicKit) developer token — an ES256-signed JWT — without any
 * dependencies. Requires an Apple Developer Program membership and a MusicKit private key.
 *
 *   node scripts/apple-developer-token.mjs \
 *     --key AuthKey_ABC123DEFG.p8 \
 *     --key-id ABC123DEFG \
 *     --team-id 1A2B3C4D5E \
 *     [--origin https://momalekiii.github.io] [--days 180]
 *
 * Paste the printed token into config.js → apple.developerToken (or the Settings dialog).
 * Tokens are valid for at most 6 months; re-run the script before they expire.
 * The optional --origin claim restricts the token to your site, which is recommended because
 * the token is visible to visitors (that is how MusicKit JS is designed to work).
 */
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, list) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), list[index + 1] && !list[index + 1].startsWith('--') ? list[index + 1] : 'true']);
  return pairs;
}, []));

const keyPath = args.key;
const keyId = args['key-id'];
const teamId = args['team-id'];
const days = Math.min(Number(args.days || 180), 182);
const origins = args.origin ? String(args.origin).split(',').map((s) => s.trim()).filter(Boolean) : null;

if (!keyPath || !keyId || !teamId) {
  console.error('Usage: node scripts/apple-developer-token.mjs --key AuthKey_XXXX.p8 --key-id XXXX --team-id YYYY [--origin https://your.site] [--days 180]');
  process.exit(1);
}

const base64url = (input) => Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
const payload = base64url(JSON.stringify({ iss: teamId, iat: now, exp: now + days * 86400, ...(origins ? { origin: origins } : {}) }));
const signingInput = `${header}.${payload}`;
const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'));
const signature = sign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' });
const token = `${signingInput}.${base64url(signature)}`;

console.log(token);
console.error(`\nDeveloper token created (expires ${new Date((now + days * 86400) * 1000).toISOString().slice(0, 10)}).`);
