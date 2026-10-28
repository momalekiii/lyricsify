// TuneBridge UI controller — paste a public playlist link (or drop an exported file), preview the
// songs, pick a destination, log in there, and the transfer engine rebuilds the playlist.
import { SERVICES, SERVICE_IDS, LOGIN_SERVICE_IDS, KINDS, canWrite, logoSvg } from './js/services.js';
import { createProvider } from './js/providers/index.js';
import { consumeRedirect, getRedirectUri, tokens } from './js/oauth.js';
import { getServiceConfig, getUserSettings, saveUserSettings, getAppConfig, isDemoMode, setDemoMode } from './js/settings.js';
import { runTransfer, summarize, missingAsCsv } from './js/transfer.js';
import { session } from './js/storage.js';
import { el, debounce, formatDuration, isAbortError } from './js/util.js';
import { importFiles, classifyLink, linkHint, importLink, peekLink, PLATFORM_NAMES, summarize as summarizeImport } from './js/importers/index.js';
import { loadLibrary, getLibrary, hasLibrary, addToLibrary, clearLibrary } from './js/importers/library.js';

const UI_KEY = 'tunebridge.ui.v2';
const PENDING_KEY = 'tunebridge.pendingTransfer.v1';
const SOURCE = 'import';
const TRACK_PREVIEW_LIMIT = 100;
const $ = (selector) => document.querySelector(selector);

const state = {
  destination: null,
  selected: { playlists: new Map(), albums: new Map(), artists: new Map() },
  known: new Set(),
  expanded: new Set(),
  profiles: {},
  busy: {},
  transfer: null,
  demo: isDemoMode(),
  link: { raw: '', info: null, status: 'idle', error: '', peek: null, progress: null, attempted: false },
  notes: [],
};

const providers = new Map();
const appConfig = getAppConfig();
let toastTimer;
let linkController = null;

// ---------------------------------------------------------------------------
// Providers & persistence
// ---------------------------------------------------------------------------

function provider(id) {
  if (!id) return null;
  if (!providers.has(id)) providers.set(id, createProvider(id, { demo: state.demo, config: getServiceConfig(id) }));
  return providers.get(id);
}

function resetProviders() {
  providers.clear();
  state.profiles = {};
}

function persistUi() {
  session.set(UI_KEY, { destination: state.destination, deselected: deselectedIds(), expanded: [...state.expanded] });
}

function restoreUi() {
  const saved = session.get(UI_KEY, null);
  if (!saved) return;
  if (LOGIN_SERVICE_IDS.includes(saved.destination)) state.destination = saved.destination;
  syncSelection(true);
  for (const id of saved.deselected || []) for (const kind of KINDS) state.selected[kind.id].delete(id);
  for (const id of saved.expanded || []) state.expanded.add(id);
}

function linkCapabilities() {
  return { resolverEnabled: Boolean(appConfig.resolverUrl), youtubeDirect: Boolean(getServiceConfig('youtube').apiKey) };
}

// ---------------------------------------------------------------------------
// Library & selection
// ---------------------------------------------------------------------------

const stripTracks = ({ tracks, ...item }) => ({ ...item, trackCount: tracks?.length ?? item.trackCount ?? 0 });

function libraryItems(kind) {
  const library = getLibrary();
  if (!library) return [];
  return (library[kind] || []).map(stripTracks);
}

/** Newly imported items start selected; anything removed from the library is dropped. */
function syncSelection(selectNew = true) {
  for (const kind of KINDS) {
    const items = libraryItems(kind.id);
    const ids = new Set(items.map((item) => item.id));
    for (const id of [...state.selected[kind.id].keys()]) if (!ids.has(id)) state.selected[kind.id].delete(id);
    for (const item of items) {
      if (state.selected[kind.id].has(item.id)) state.selected[kind.id].set(item.id, item);
      else if (selectNew && !state.known.has(item.id)) state.selected[kind.id].set(item.id, item);
      state.known.add(item.id);
    }
  }
}

function deselectedIds() {
  const out = [];
  for (const kind of KINDS) for (const item of libraryItems(kind.id)) if (!state.selected[kind.id].has(item.id)) out.push(item.id);
  return out;
}

const totalItems = () => KINDS.reduce((sum, kind) => sum + libraryItems(kind.id).length, 0);
const totalSelected = () => KINDS.reduce((sum, kind) => sum + state.selected[kind.id].size, 0);

function sourcePlatform() {
  const library = getLibrary();
  const first = library?.playlists?.[0] || library?.albums?.[0] || library?.artists?.[0];
  if (first?.platform && SERVICES[first.platform]) return first.platform;
  const label = library?.sources?.[0] || '';
  return LOGIN_SERVICE_IDS.find((id) => SERVICES[id].name === label || label.toLowerCase().startsWith(SERVICES[id].name.toLowerCase())) || null;
}

function sourceName() {
  const platform = sourcePlatform();
  if (platform) return SERVICES[platform].name;
  const sources = getLibrary()?.sources || [];
  return sources.length === 1 ? sources[0] : 'your file';
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function svg(serviceId, size = 24) {
  const template = document.createElement('template');
  template.innerHTML = logoSvg(serviceId, { size });
  return template.content.firstElementChild;
}

function toast(message, type = '', durationMs) {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show ${type}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), durationMs || (type === 'error' ? 6500 : 3800));
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') {
    if (!dialog.open) dialog.showModal();
  } else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  else dialog.removeAttribute('open');
}

function brandVars(serviceId) {
  const service = SERVICES[serviceId];
  if (!service) return '--brand:#8f9bff;--brand-2:#35e6ff;--ink:#0a0a0d';
  return `--brand:${service.color};--brand-2:${service.color2};--ink:${service.ink}`;
}

function applyAccent() {
  const root = document.documentElement;
  const platform = sourcePlatform() || state.link.info?.platform;
  const from = platform && SERVICES[platform] ? SERVICES[platform].color : '#8f9bff';
  const to = state.destination ? SERVICES[state.destination].color : platform && SERVICES[platform] ? SERVICES[platform].color2 : '#35e6ff';
  root.style.setProperty('--from', from);
  root.style.setProperty('--to', to);
}

function scrollToStep(id) {
  requestAnimationFrame(() => {
    const node = document.getElementById(id);
    if (node && !node.hidden) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function capabilityNote(serviceId) {
  const unsupported = KINDS.filter((kind) => !SERVICES[serviceId].caps[kind.id][1]).map((kind) => kind.label.toLowerCase());
  return unsupported.length ? `No ${unsupported.join(', ')}` : '';
}

const countLabel = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function totalDuration(tracks = []) {
  const ms = tracks.reduce((sum, t) => sum + (t.durationMs || 0), 0);
  if (!ms) return '';
  const minutes = Math.round(ms / 60000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

// ---------------------------------------------------------------------------
// Static rendering (runs once)
// ---------------------------------------------------------------------------

function renderStatic() {
  const strip = $('#services-strip');
  strip.replaceChildren(...LOGIN_SERVICE_IDS.map((id) => el('li', { style: brandVars(id) }, svg(id, 18), SERVICES[id].name)));

  const table = $('#caps-table');
  const head = el('tr', {}, el('th', { text: 'Service' }), ...KINDS.map((kind) => el('th', { text: kind.label })));
  const rows = SERVICE_IDS.map((id) => el('tr', {}, el('td', {}, el('span', { style: `display:inline-flex;align-items:center;gap:8px;${brandVars(id)}` }, svg(id, 16), SERVICES[id].noLogin ? 'Pasted link / file (source)' : SERVICES[id].name)), ...KINDS.map((kind) => {
    const [read, write] = SERVICES[id].caps[kind.id];
    if (SERVICES[id].noLogin) return el('td', { class: read ? 'yes' : 'no', text: read ? '✓ source' : '—' });
    if (write) return el('td', { class: 'yes', text: '✓ can receive' });
    return el('td', { class: 'no', text: '—' });
  })));
  table.replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));

  for (const link of document.querySelectorAll('.footer-copyright .footer-link')) link.href = appConfig.ownerUrl;
  $('#redirect-uri').textContent = getRedirectUri();
  const setupLink = $('#setup-link');
  if (setupLink) setupLink.href = appConfig.setupUrl;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  renderLinkBar();
  renderSteps();
  renderPreview();
  renderDestination();
  applyAccent();
  $('#demo-badge').hidden = !state.demo;
}

function renderSteps() {
  const { status } = state.link;
  $('#step-preview').hidden = !(hasLibrary() || status === 'loading' || status === 'error' || state.busy.import);
  $('#step-destination').hidden = !hasLibrary();
  $('#step-transfer').hidden = !state.transfer;
  $('#step-results').hidden = !state.transfer?.report;
}

function renderLinkBar() {
  const form = $('#link-form');
  const { raw, info, status } = state.link;
  const platform = info?.kind === 'link' ? info.platform : '';
  form.dataset.platform = platform;
  form.setAttribute('style', platform ? brandVars(platform) : '');
  const icon = $('#link-icon');
  if (platform) {
    if (icon.dataset.platform !== platform) {
      icon.replaceChildren(svg(platform, 22));
      icon.dataset.platform = platform;
    }
  } else if (icon.dataset.platform !== '') {
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
    icon.dataset.platform = '';
  }
  $('#link-clear').hidden = !raw;
  const go = $('#link-go');
  go.disabled = !raw || status === 'loading';
  $('#link-go-label').textContent = status === 'loading' ? 'Reading…' : 'Preview';

  const hint = $('#link-hint');
  hint.className = 'link-hint';
  if (!raw) {
    hint.textContent = '';
    return;
  }
  const problem = linkHint(info, linkCapabilities());
  if (info?.kind === 'link' && !problem) {
    hint.classList.add('is-ok');
    const typeLabel = info.type === 'short' ? 'link' : info.type;
    hint.replaceChildren(
      el('span', { class: 'platform-pill', style: brandVars(platform) }, svg(platform, 14), `${PLATFORM_NAMES[platform]} ${typeLabel}`),
      ' ',
      status === 'loading' ? 'Reading it now…' : status === 'ready' ? 'Imported below.' : 'recognised — press Enter or Preview.');
  } else if (problem) {
    hint.classList.add(state.link.attempted || info?.kind === 'link' ? 'is-error' : '');
    hint.textContent = problem;
  } else hint.textContent = '';
}

function renderPreview() {
  const container = $('#preview');
  const { status, info, error, peek, progress } = state.link;
  const library = getLibrary();
  const platform = info?.platform;
  const platformName = platform ? PLATFORM_NAMES[platform] : '';

  if (status === 'loading' || state.busy.import) {
    const box = el('div', { class: 'preview-state', style: brandVars(platform) }, el('span', { class: 'spinner' }));
    box.append(el('strong', { text: status === 'loading' ? `Reading your ${platformName} ${info?.type === 'album' ? 'album' : 'playlist'}…` : 'Reading your files…' }));
    if (progress?.count) box.append(el('span', { text: `${progress.count}${progress.total ? ` of ${progress.total}` : ''} songs so far` }));
    if (peek?.title) box.append(peekCard(peek));
    container.replaceChildren(box);
    return;
  }

  if (status === 'error' && !hasLibrary()) {
    const box = el('div', { class: 'preview-state is-error', style: brandVars(platform) });
    if (peek?.title) box.append(el('span', { text: 'We found it, but can’t read its songs from here:' }), peekCard(peek));
    box.append(el('strong', { text: error }));
    box.append(el('div', { class: 'hint-actions' },
      el('button', { type: 'button', class: 'ghost-button', text: 'What files work?', on: { click: () => openDialog($('#import-help-dialog')) } }),
      el('button', { type: 'button', class: 'ghost-button', text: 'Choose a file', on: { click: () => $('#file-input').click() } })));
    container.replaceChildren(box);
    return;
  }

  if (!hasLibrary()) {
    container.replaceChildren();
    return;
  }

  const nodes = [];
  if (status === 'error' && error) nodes.push(el('p', { class: 'preview-notes', text: error }));
  const playlists = library.playlists || [];
  const albums = library.albums || [];
  const artists = library.artists || [];
  const single = totalItems() === 1;

  const toolbar = el('div', { class: 'preview-toolbar' },
    el('span', { class: 'muted', text: `${summarizeImport(library)} · from ${(library.sources || []).join(', ') || 'your import'}` }),
    el('span', {},
      single ? null : el('button', { type: 'button', class: 'text-button', text: 'Select all', on: { click: () => selectAll(true) } }),
      single ? null : el('button', { type: 'button', class: 'text-button', text: 'Select none', on: { click: () => selectAll(false) } }),
      el('button', { type: 'button', class: 'text-button', text: 'Add a file', on: { click: () => $('#file-input').click() } }),
      el('button', { type: 'button', class: 'text-button danger', text: 'Clear', on: { click: () => startOver() } })));
  nodes.push(toolbar);
  if (state.notes.length) nodes.push(el('ul', { class: 'preview-notes' }, ...state.notes.slice(0, 5).map((note) => el('li', { text: note }))));

  if (single && playlists.length === 1) nodes.push(playlistCard(playlists[0], { hero: true }));
  else if (single && albums.length === 1) nodes.push(albumCard(albums[0]));
  else {
    if (playlists.length) nodes.push(group('Playlists', playlists.length, playlists.map((playlist) => playlistRow(playlist))));
    if (albums.length) nodes.push(group('Albums', albums.length, albums.map((album) => simpleRow('albums', album, album.title, `${album.artists?.join(', ') || ''}${album.year ? ' · ' + album.year : ''}`, album.image))));
    if (artists.length) nodes.push(group('Artists', artists.length, artists.map((artist) => simpleRow('artists', artist, artist.name, 'Artist', artist.image))));
  }
  container.replaceChildren(...nodes);
}

function peekCard(peek) {
  return el('div', { class: 'preview-peek' }, peek.image ? el('img', { src: peek.image, alt: '' }) : null, el('span', {}, el('strong', { text: peek.title }), peek.author ? el('div', { class: 'muted', text: `by ${peek.author}` }) : null));
}

function group(title, count, rows) {
  return el('section', { class: 'preview-group' }, el('h3', { class: 'preview-group-title' }, title, el('span', { class: 'count', text: String(count) })), el('div', { class: 'item-list' }, ...rows));
}

function platformPill(item) {
  const platform = item.platform && SERVICES[item.platform] ? item.platform : sourcePlatform();
  if (platform) return el('span', { class: 'platform-pill', style: brandVars(platform) }, svg(platform, 14), `${SERVICES[platform].name} ${item.kindLabel || 'playlist'}`);
  return el('span', { class: 'platform-pill' }, svg('import', 14), item.origin || 'Imported');
}

function coverNode(image, platform, size = 56) {
  const cover = el('div', { class: 'cover' });
  if (image) cover.append(el('img', { src: image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', on: { error: (event) => event.target.remove() } }));
  else cover.append(svg(platform || 'import', size));
  return cover;
}

/** Hidden input + drawn box, in the markup the .item styles expect (the row itself is the <label>). */
function checkbox(kind, item) {
  const input = el('input', { type: 'checkbox', checked: state.selected[kind].has(item.id), 'aria-label': `Include ${item.name || item.title}` });
  input.addEventListener('change', () => toggleItem(kind, item, input.checked));
  return [input, el('span', { class: 'checkbox', 'aria-hidden': 'true' })];
}

function playlistCard(playlist, { hero = false } = {}) {
  const platform = playlist.platform && SERVICES[playlist.platform] ? playlist.platform : sourcePlatform();
  const card = el('article', { class: 'playlist-card', style: brandVars(platform) });
  card.append(coverNode(playlist.image, platform));
  const tracks = playlist.tracks || [];
  const meta = [`${countLabel(tracks.length, 'song')}`, totalDuration(tracks), playlist.owner ? `by ${playlist.owner}` : ''].filter(Boolean);
  const main = el('div', { class: 'card-main' },
    platformPill(playlist),
    el('h3', { text: playlist.name }),
    el('p', { class: 'card-meta', html: meta.map((part, index) => (index === 0 ? `<b>${escape(part)}</b>` : escape(part))).join(' · ') }),
    playlist.description ? el('p', { class: 'card-meta', text: playlist.description.slice(0, 200) }) : null,
    el('div', { class: 'card-actions' }, playlist.url ? el('a', { class: 'text-button', href: playlist.url, target: '_blank', rel: 'noreferrer', text: `Open on ${platform ? SERVICES[platform].name : 'source'} ↗` }) : null));
  card.append(main);
  if (!hero) card.append(el('label', { class: `item card-check${state.selected.playlists.has(playlist.id) ? ' is-selected' : ''}` }, ...checkbox('playlists', stripTracks(playlist))));
  card.append(trackList(tracks, playlist.id));
  return card;
}

function albumCard(album) {
  const platform = album.platform && SERVICES[album.platform] ? album.platform : sourcePlatform();
  const card = el('article', { class: 'playlist-card', style: brandVars(platform) });
  card.append(coverNode(album.image, platform));
  card.append(el('div', { class: 'card-main' },
    platformPill({ ...album, kindLabel: 'album' }),
    el('h3', { text: album.title }),
    el('p', { class: 'card-meta', html: `<b>${escape(album.artists?.join(', ') || 'Unknown artist')}</b>${album.year ? ' · ' + escape(album.year) : ''}${album.trackCount ? ' · ' + countLabel(album.trackCount, 'song') : ''}` }),
    el('p', { class: 'card-meta', text: 'The album will be saved to your library on the destination.' })));
  if (album.tracks?.length) card.append(trackList(album.tracks, album.id));
  return card;
}

function trackList(tracks, key) {
  const list = el('ol', { class: 'track-list' });
  const showAll = state.expanded.has(`all:${key}`);
  const visible = showAll ? tracks : tracks.slice(0, TRACK_PREVIEW_LIMIT);
  for (const [index, track] of visible.entries()) {
    list.append(el('li', {},
      el('span', { class: 'track-index', text: String(index + 1) }),
      el('span', { class: 'track-text' }, el('span', { class: 'track-title', text: track.title }), el('span', { class: 'track-artist', text: [track.artists?.join(', '), track.album].filter(Boolean).join(' · ') || '—' })),
      el('span', { class: 'track-time', text: track.durationMs ? formatDuration(track.durationMs) : '' })));
  }
  if (!tracks.length) list.append(el('li', {}, el('span'), el('span', { class: 'track-artist', text: 'No songs could be read for this item.' })));
  if (tracks.length > visible.length) list.append(el('li', {}, el('span'), el('button', { type: 'button', class: 'text-button track-more', text: `Show all ${tracks.length} songs`, on: { click: () => { state.expanded.add(`all:${key}`); renderPreview(); } } })));
  return list;
}

function playlistRow(playlist) {
  const item = stripTracks(playlist);
  const platform = playlist.platform && SERVICES[playlist.platform] ? playlist.platform : sourcePlatform();
  const open = state.expanded.has(playlist.id);
  const row = el('label', { class: `item${state.selected.playlists.has(item.id) ? ' is-selected' : ''}`, style: brandVars(platform) },
    ...checkbox('playlists', item),
    el('span', { class: 'item-cover' }, playlist.image ? el('img', { src: playlist.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : svg(platform || 'import', 22)),
    el('span', { class: 'item-text' }, el('span', { class: 'item-title', text: playlist.name }), el('span', { class: 'item-meta', text: [countLabel(playlist.tracks?.length || 0, 'song'), playlist.owner].filter(Boolean).join(' · ') })),
    el('button', { type: 'button', class: 'item-expand', text: open ? 'Hide songs' : 'Songs', 'aria-expanded': String(open), on: { click: () => { if (open) state.expanded.delete(playlist.id); else state.expanded.add(playlist.id); persistUi(); renderPreview(); } } }));
  if (open) row.append(el('div', { class: 'item-tracks' }, trackList(playlist.tracks || [], playlist.id)));
  return row;
}

function simpleRow(kind, item, title, meta, image) {
  const platform = item.platform && SERVICES[item.platform] ? item.platform : sourcePlatform();
  return el('label', { class: `item${state.selected[kind].has(item.id) ? ' is-selected' : ''}`, style: brandVars(platform) },
    ...checkbox(kind, item),
    el('span', { class: 'item-cover' }, image ? el('img', { src: image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : svg(platform || 'import', 22)),
    el('span', { class: 'item-text' }, el('span', { class: 'item-title', text: title }), el('span', { class: 'item-meta', text: meta })));
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDestination() {
  const grid = $('#destination-grid');
  const sourceId = sourcePlatform();
  grid.replaceChildren(...LOGIN_SERVICE_IDS.map((id) => {
    const instance = provider(id);
    const connected = instance.isConnected();
    const note = capabilityNote(id);
    const button = el('button', {
      type: 'button',
      class: 'service-button',
      style: brandVars(id),
      'aria-pressed': String(state.destination === id),
      dataset: { service: id },
    },
    connected ? el('span', { class: 'service-flag ready', text: 'Logged in' }) : id === sourceId ? el('span', { class: 'service-flag', text: 'Same service' }) : null,
    el('span', { class: 'service-logo' }, svg(id, 30)),
    el('span', { class: 'service-name', text: SERVICES[id].name }),
    el('span', { class: `service-note${note ? ' unsupported' : ''}`, text: note || 'Playlists · Albums · Artists' }));
    return button;
  }));

  const panel = $('#destination-panel');
  panel.hidden = !state.destination;
  if (!state.destination) return;
  const id = state.destination;
  const destination = SERVICES[id];
  const instance = provider(id);
  const connected = instance.isConnected();
  const configured = instance.isConfigured();
  const running = Boolean(state.transfer?.running);
  const profile = state.profiles[id];

  const summary = $('#transfer-summary');
  const chips = [];
  const route = el('span', { class: 'summary-chip', style: brandVars(sourceId || 'import') }, svg(sourceId || 'import', 16), sourceName(), '→', svg(id, 16), destination.name);
  chips.push(route);
  for (const kind of KINDS) {
    const count = state.selected[kind.id].size;
    if (!count) continue;
    if (!canWrite(id, kind.id)) chips.push(el('span', { class: 'summary-chip', style: 'border-color:rgba(255,196,0,.5);color:#ffd866', text: `${count} ${kind.label.toLowerCase()} skipped — ${destination.name} can’t receive ${kind.label.toLowerCase()}` }));
    else chips.push(el('span', { class: 'summary-chip' }, el('strong', { text: String(count) }), count === 1 ? kind.label.toLowerCase().replace(/s$/, '') : kind.label.toLowerCase()));
  }
  const trackEstimate = [...state.selected.playlists.values()].reduce((sum, p) => sum + (p.trackCount || 0), 0);
  if (trackEstimate && canWrite(id, 'playlists')) chips.push(el('span', { class: 'summary-chip' }, el('strong', { text: String(trackEstimate) }), 'songs to match'));
  if (!totalSelected()) chips.push(el('span', { class: 'summary-chip', text: 'Nothing selected — tick something above' }));
  if (id === 'youtube' && trackEstimate > 60 && !running) chips.push(el('span', { class: 'summary-chip', style: 'border-color:rgba(255,196,0,.5);color:#ffd866', text: `YouTube’s default API quota fits about 60 new songs per day — ${trackEstimate} may take several days.` }));
  const status = el('div', { class: 'destination-status' });
  if (connected) {
    status.append(el('span', { class: 'dot on' }));
    if (profile?.image) status.append(el('img', { src: profile.image, alt: '', referrerpolicy: 'no-referrer' }));
    status.append(el('span', {}, `Logged in to ${destination.name}`, profile?.name ? ` as ${profile.name}` : ''), el('button', { type: 'button', class: 'text-button', text: 'Not you? Sign out', on: { click: () => disconnect(id) } }));
  } else {
    status.append(el('span', { class: 'dot' }), el('span', { text: `Not logged in to ${destination.name} yet` }));
  }
  summary.replaceChildren(status, ...chips);
  $('#option-suffix-source').textContent = sourceName();

  const button = $('#transfer-button');
  const nothing = totalSelected() === 0 || !KINDS.some((kind) => state.selected[kind.id].size && canWrite(id, kind.id));
  button.classList.toggle('light-ink', destination.ink === '#ffffff');
  button.classList.toggle('login', !connected);
  button.disabled = running || nothing || (!configured && !state.demo);
  button.replaceChildren(el('span', { class: 'service-inline' }, running ? 'Transferring…' : connected ? `Transfer to ${destination.name}` : `Log in with ${destination.name} & transfer`, running ? null : svg(id, 20)));
  $('#cancel-button').hidden = !running;
  const note = $('#cta-note');
  if (!configured && !state.demo) note.innerHTML = `Transfers to <b>${destination.name}</b> aren’t switched on for this site yet — pick another destination for now.`;
  else if (running) note.textContent = '';
  else if (connected) note.innerHTML = `New playlists are created in <b>your ${destination.name} account</b>; nothing is deleted or changed there.`;
  else note.innerHTML = `<b>${destination.name}</b> opens its own sign-in page (the one you always use) and sends you straight back — the transfer then starts by itself. TuneBridge never sees your password.`;
}

function renderResults() {
  const report = state.transfer?.report;
  if (!report) return;
  const stats = summarize(report);
  const panel = $('#results-panel');
  const destination = SERVICES[state.destination];
  const copy = report.cancelled
    ? 'The transfer was cancelled. Anything already created stays on the destination.'
    : report.error
      ? `The transfer stopped early: ${report.error}`
      : stats.missing === 0
        ? `Everything made it to ${destination.name}.`
        : `${stats.missing} ${stats.missing === 1 ? 'song' : 'songs'} couldn’t be found on ${destination.name} — details below.`;
  $('#results-copy').textContent = copy;
  $('#step-results-title').textContent = report.cancelled ? 'Cancelled' : report.error ? 'Stopped' : 'All done';

  const statBoxes = el('div', { class: 'results-stats' },
    el('div', { class: 'stat' }, el('strong', { text: String(stats.items) }), el('span', { text: stats.items === 1 ? 'item processed' : 'items processed' })),
    el('div', { class: 'stat' }, el('strong', { text: `${stats.tracksMatched}/${stats.tracksTotal}` }), el('span', { text: 'songs matched' })),
    el('div', { class: 'stat' }, el('strong', { text: String(stats.missing) }), el('span', { text: 'not found' })),
    el('div', { class: 'stat' }, el('strong', { text: `${Math.max(1, Math.round((report.finishedAt - report.startedAt) / 1000))}s` }), el('span', { text: 'elapsed' })));

  const items = report.items.map((item) => {
    const cls = item.status === 'done' ? (item.missing.length + item.failed.length ? 'partial' : 'done') : item.status;
    const icon = cls === 'done' ? '✓' : cls === 'partial' ? '!' : '×';
    const sub = item.kind === 'playlist' ? `${item.matched} of ${item.total} songs` : item.message;
    const details = el('details', { class: `result-item ${cls}`, open: cls !== 'done' });
    const summaryNode = el('summary', {}, el('span', { class: 'log-icon', text: icon }), el('span', { class: 'result-title' }, item.name, ' ', el('span', { class: 'result-sub', text: `· ${sub}` })));
    if (item.url) summaryNode.append(el('a', { class: 'result-link', href: item.url, target: '_blank', rel: 'noreferrer', text: `Open on ${destination.name} ↗`, on: { click: (event) => event.stopPropagation() } }));
    details.append(summaryNode);
    const missing = el('ul', { class: 'missing-list' });
    for (const track of item.missing) missing.append(el('li', {}, el('strong', { text: track.title || track.name || '' }), el('span', { text: (track.artists || []).join(', ') }), el('em', { text: 'not found' })));
    for (const { track, error } of item.failed) missing.append(el('li', {}, el('strong', { text: track.title || track.name || '' }), el('span', { text: (track.artists || []).join(', ') }), el('em', { text: error })));
    if (item.error && !item.failed.length) missing.append(el('li', {}, el('em', { text: item.error })));
    if (!missing.childElementCount) missing.append(el('li', {}, el('span', { text: item.kind === 'playlist' ? 'Every song was found.' : item.message })));
    details.append(missing);
    return details;
  });
  panel.replaceChildren(statBoxes, ...items);
  $('#download-missing').hidden = stats.missing === 0;
}

// ---------------------------------------------------------------------------
// Link & file import
// ---------------------------------------------------------------------------

function onLinkInput() {
  const raw = $('#link-input').value;
  if (raw === state.link.raw) return;
  state.link.raw = raw;
  state.link.info = classifyLink(raw);
  state.link.attempted = false;
  if (state.link.status === 'error' || state.link.status === 'ready') { state.link.status = 'idle'; state.link.error = ''; state.link.peek = null; }
  renderLinkBar();
  applyAccent();
  renderSteps();
}

async function previewLink() {
  const input = $('#link-input');
  onLinkInput();
  const info = state.link.info;
  state.link.attempted = true;
  if (!info || info.kind === 'empty') { input.focus(); renderLinkBar(); return; }
  const problem = linkHint(info, linkCapabilities());
  linkController?.abort();
  const controller = new AbortController();
  linkController = controller;
  state.link.error = '';
  state.link.peek = null;
  state.link.progress = null;
  if (problem) {
    state.link.status = 'error';
    state.link.error = problem;
    render();
    scrollToStep('step-preview');
    if (info.kind === 'link') peekLink(info, { signal: controller.signal }).then((peek) => { if (!controller.signal.aborted && peek) { state.link.peek = peek; renderPreview(); } });
    return;
  }
  state.link.status = 'loading';
  state.notes = [];
  render();
  scrollToStep('step-preview');
  peekLink(info, { signal: controller.signal }).then((peek) => { if (!controller.signal.aborted && peek && state.link.status === 'loading') { state.link.peek = peek; renderPreview(); } });
  try {
    const result = await importLink(info, {
      signal: controller.signal,
      config: { resolverUrl: appConfig.resolverUrl, youtubeApiKey: getServiceConfig('youtube').apiKey || '' },
      onProgress: (count, total) => { state.link.progress = { count, total }; renderPreview(); },
    });
    if (controller.signal.aborted) return;
    await clearLibrary(); // a pasted link replaces whatever was there: one playlist at a time
    await addToLibrary(result, PLATFORM_NAMES[info.platform]);
    state.known.clear();
    for (const kind of KINDS) state.selected[kind.id].clear();
    state.expanded.clear();
    syncSelection(true);
    state.notes = result.notes || [];
    state.link.status = 'ready';
    delete state.profiles[SOURCE];
    providers.delete(SOURCE);
    resetTransfer();
    persistUi();
    render();
    toast(`Found ${summarizeImport(result)}.`, 'success');
    scrollToStep('step-preview');
  } catch (error) {
    if (isAbortError(error) || controller.signal.aborted) return;
    state.link.status = 'error';
    state.link.error = error.message || 'Could not read that link.';
    render();
  }
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  state.busy.import = true;
  state.link.status = 'idle';
  render();
  scrollToStep('step-preview');
  const label = files.length === 1 ? files[0].name : `${files.length} files`;
  try {
    const result = await importFiles(files);
    const count = result.playlists.length + result.albums.length + result.artists.length;
    const origins = [...new Set(result.playlists.map((p) => p.origin).filter(Boolean))];
    if (count) {
      await addToLibrary(result, origins.length === 1 ? origins[0] : label.replace(/\.[^.]+$/, ''));
      syncSelection(true);
      resetTransfer();
      persistUi();
    }
    state.notes = result.notes || [];
    providers.delete(SOURCE);
    if (count) toast(`Imported ${summarizeImport(result)} from ${label}.`, 'success');
    else toast(result.notes[0] || `Nothing usable found in ${label}.`, 'error', 9000);
  } catch (error) {
    toast(error.message || `Could not import ${label}.`, 'error', 9000);
  } finally {
    state.busy.import = false;
    render();
    scrollToStep('step-preview');
  }
}

function toggleItem(kind, item, checked) {
  if (checked) state.selected[kind].set(item.id, item);
  else state.selected[kind].delete(item.id);
  persistUi();
  renderPreview();
  renderDestination();
}

function selectAll(value) {
  for (const kind of KINDS) {
    for (const item of libraryItems(kind.id)) {
      if (value) state.selected[kind.id].set(item.id, item);
      else state.selected[kind.id].delete(item.id);
    }
  }
  persistUi();
  renderPreview();
  renderDestination();
}

async function startOver() {
  linkController?.abort();
  resetTransfer();
  await clearLibrary();
  for (const kind of KINDS) state.selected[kind.id].clear();
  state.known.clear();
  state.expanded.clear();
  state.notes = [];
  state.link = { raw: '', info: null, status: 'idle', error: '', peek: null, progress: null, attempted: false };
  $('#link-input').value = '';
  providers.delete(SOURCE);
  delete state.profiles[SOURCE];
  persistUi();
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('#link-input').focus();
}

// ---------------------------------------------------------------------------
// Destination: pick, log in, transfer
// ---------------------------------------------------------------------------

function selectDestination(id) {
  if (!LOGIN_SERVICE_IDS.includes(id)) return;
  if (state.transfer?.running) { toast('Wait for the current transfer to finish (or cancel it) first.', 'error'); return; }
  state.destination = id;
  resetTransfer();
  persistUi();
  render();
  loadProfile(id).then(() => renderDestination());
  scrollToStep('destination-panel');
}

function readOptions() {
  return { publicPlaylists: $('#option-public').checked, suffix: $('#option-suffix').checked };
}

function savePendingTransfer(id) {
  session.set(PENDING_KEY, { destination: id, options: readOptions(), deselected: deselectedIds(), at: Date.now() });
}

async function primaryAction() {
  const id = state.destination;
  if (!id || state.transfer?.running) return;
  const instance = provider(id);
  if (instance.isConnected()) {
    await startTransfer();
    return;
  }
  if (!instance.isConfigured()) {
    toast(`Transfers to ${SERVICES[id].name} aren’t switched on for this site yet.`, 'error');
    return;
  }
  savePendingTransfer(id);
  state.busy[id] = true;
  renderDestination();
  try {
    await instance.connect(); // redirect-based logins navigate away here and come back through boot()
    session.remove(PENDING_KEY);
    await loadProfile(id);
    state.busy[id] = false;
    render();
    toast(`Logged in to ${SERVICES[id].name}.`, 'success');
    await startTransfer();
  } catch (error) {
    session.remove(PENDING_KEY);
    state.busy[id] = false;
    toast(error.message || `Could not log in to ${SERVICES[id].name}.`, 'error');
    render();
  }
}

function disconnect(id) {
  provider(id).disconnect();
  delete state.profiles[id];
  resetTransfer();
  render();
}

async function loadProfile(id) {
  const instance = provider(id);
  if (!instance?.isConnected() || state.profiles[id]) return;
  try {
    state.profiles[id] = await instance.getProfile();
  } catch (error) {
    if (error.name === 'AuthError') {
      instance.disconnect();
      toast(error.message, 'error');
    } else {
      state.profiles[id] = { name: 'your account' };
      console.warn('Profile lookup failed', error);
    }
  }
}

async function handleRedirect(result) {
  if (!result) return false;
  if (result.error && !result.provider) {
    toast(result.error, 'error');
    return false;
  }
  const id = result.provider;
  if (result.error) {
    toast(`${SERVICES[id]?.name || 'Sign-in'}: ${result.error}`, 'error');
    return false;
  }
  try {
    await provider(id).finishConnect(result);
    await loadProfile(id);
    toast(`Logged in to ${SERVICES[id].name}.`, 'success');
    return true;
  } catch (error) {
    toast(`${SERVICES[id]?.name || 'Sign-in'}: ${error.message}`, 'error');
    return false;
  }
}

function resetTransfer() {
  if (state.transfer?.running) state.transfer.controller.abort();
  state.transfer = null;
  $('#transfer-log').replaceChildren();
  $('#progress-wrap').hidden = true;
}

async function startTransfer() {
  if (state.transfer?.running || !state.destination) return;
  const source = provider(SOURCE);
  const destination = provider(state.destination);
  const selection = Object.fromEntries(KINDS.map((kind) => [kind.id, canWrite(state.destination, kind.id) ? [...state.selected[kind.id].values()] : []]));
  if (!Object.values(selection).some((list) => list.length)) { toast('Nothing to transfer — tick at least one item.', 'error'); return; }
  const controller = new AbortController();
  const entries = new Map();
  state.transfer = { controller, running: true, report: null, entries };
  $('#transfer-log').replaceChildren();
  $('#progress-wrap').hidden = false;
  $('#progress-fill').style.width = '0%';
  $('#progress-label').textContent = 'Starting…';
  $('#progress-count').textContent = '';
  render();
  scrollToStep('step-transfer');

  const { publicPlaylists, suffix } = readOptions();
  const from = sourceName();
  const report = await runTransfer({
    source,
    destination,
    selection,
    options: { publicPlaylists, renamePlaylist: suffix ? (playlist) => `${playlist.name} (from ${from})` : null },
    signal: controller.signal,
    onEvent: (event) => handleTransferEvent(event, entries),
  });

  state.transfer.running = false;
  state.transfer.report = report;
  $('#progress-label').textContent = report.cancelled ? 'Cancelled' : report.error ? 'Stopped' : 'Finished';
  if (!report.cancelled && !report.error) $('#progress-fill').style.width = '100%';
  render();
  renderResults();
  renderSteps();
  scrollToStep('step-results');
  const stats = summarize(report);
  if (report.cancelled) toast('Transfer cancelled.');
  else if (report.error) toast(report.error, 'error');
  else toast(`Done — ${stats.tracksMatched} of ${stats.tracksTotal} songs matched.`, stats.missing ? '' : 'success');
}

function handleTransferEvent(event, entries) {
  if (event.type === 'overall') {
    const percent = event.total ? Math.round((event.done / event.total) * 100) : 0;
    $('#progress-fill').style.width = `${percent}%`;
    $('#progress-count').textContent = `${event.done}/${event.total}`;
    return;
  }
  if (event.type === 'done') return;
  const item = event.item;
  let node = entries.get(item);
  if (!node) {
    node = el('li', { class: 'log-item running' },
      el('span', { class: 'log-icon' }),
      el('span', {}, el('div', { class: 'log-title', text: item.name }), el('div', { class: 'log-message' })),
      el('span', { class: 'log-side' }),
      el('span', { class: 'log-mini' }, el('span')));
    entries.set(item, node);
    $('#transfer-log').prepend(node);
  }
  node.querySelector('.log-message').textContent = item.message || '';
  node.querySelector('.log-side').textContent = item.kind === 'playlist' && item.total ? `${item.matched} matched · ${item.missing.length + item.failed.length} missing` : '';
  node.querySelector('.log-mini span').style.width = item.total ? `${Math.round((item.done / item.total) * 100)}%` : '0%';
  $('#progress-label').textContent = `${item.name}: ${item.message || ''}`;
  if (event.type === 'item:done') {
    const cls = item.status === 'done' ? (item.missing.length + item.failed.length ? 'partial' : 'done') : item.status;
    node.className = `log-item ${cls}`;
    node.querySelector('.log-icon').textContent = cls === 'done' ? '✓' : cls === 'partial' ? '!' : '×';
    node.querySelector('.log-mini span').style.width = '100%';
  }
}

function cancelTransfer() {
  state.transfer?.controller.abort();
  $('#cancel-button').disabled = true;
  setTimeout(() => { $('#cancel-button').disabled = false; }, 1500);
}

function downloadMissing() {
  const report = state.transfer?.report;
  if (!report) return;
  const csv = missingAsCsv(report);
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `tunebridge-missing-${state.destination}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function toggleDemo(force) {
  const next = typeof force === 'boolean' ? force : !state.demo;
  if (next === state.demo) return;
  if (state.transfer?.running) return;
  state.demo = next;
  setDemoMode(next);
  resetProviders();
  resetTransfer();
  render();
  toast(next ? 'Demo mode: the destination is a sample account — nothing touches real services.' : 'Demo mode off.');
}

// ---------------------------------------------------------------------------
// Site-owner settings (hidden: #setup or About → "Site owner settings")
// ---------------------------------------------------------------------------

function openSettings(focusService) {
  const container = $('#settings-services');
  const user = getUserSettings();
  const baseConfig = (window.TUNEBRIDGE_CONFIG || {});
  container.replaceChildren(...LOGIN_SERVICE_IDS.filter((id) => SERVICES[id].credentials.length).map((id) => {
    const service = SERVICES[id];
    const base = baseConfig[id] || {};
    const effective = getServiceConfig(id);
    const configured = createProvider(id, { config: effective }).isConfigured();
    const section = el('section', { class: 'settings-service', style: brandVars(id), id: `settings-${id}` });
    section.append(el('div', { class: 'settings-service-head' }, svg(id, 20), service.name, el('span', { class: `status${configured ? ' ok' : ''}`, text: configured ? 'Ready' : 'Not configured' })));
    section.append(el('p', { html: `${service.setup} <a href="${service.developer}" target="_blank" rel="noreferrer">Open developer portal ↗</a>` }));
    for (const credential of service.credentials) {
      const value = user[id]?.[credential.key] || '';
      const fromConfig = base[credential.key] ? 'Pre-filled by config.js — leave empty to keep it.' : '';
      const input = credential.multiline
        ? el('textarea', { name: `${id}.${credential.key}`, placeholder: credential.placeholder || '', spellcheck: 'false' })
        : el('input', { name: `${id}.${credential.key}`, type: credential.secret ? 'password' : 'text', placeholder: credential.placeholder || '', autocomplete: 'off', spellcheck: 'false' });
      input.value = value;
      section.append(el('div', { class: 'field' }, el('label', { text: `${credential.label}${fromConfig ? ' · ' + fromConfig : ''}` }), input));
    }
    for (const note of service.notes || []) section.append(el('p', { text: note }));
    return section;
  }));
  openDialog($('#settings-dialog'));
  if (focusService) requestAnimationFrame(() => document.getElementById(`settings-${focusService}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
}

function saveSettings(event) {
  event.preventDefault();
  const form = $('#settings-form');
  const next = {};
  for (const element of form.elements) {
    if (!element.name || !element.name.includes('.')) continue;
    const [id, key] = element.name.split('.');
    const value = element.value.trim();
    if (!value) continue;
    next[id] = next[id] || {};
    next[id][key] = value;
  }
  saveUserSettings(next);
  resetProviders();
  closeDialog($('#settings-dialog'));
  render();
  toast('Settings saved in this browser.', 'success');
}

function forgetTokens() {
  tokens.clearAll();
  for (const [id, instance] of providers) if (id !== SOURCE) instance.disconnect?.();
  state.profiles = {};
  resetTransfer();
  closeDialog($('#settings-dialog'));
  render();
  toast('Signed out of all services on this browser.');
}

// ---------------------------------------------------------------------------
// Events & boot
// ---------------------------------------------------------------------------

function bindEvents() {
  const input = $('#link-input');
  input.addEventListener('input', onLinkInput);
  input.addEventListener('paste', () => setTimeout(() => {
    onLinkInput();
    if (state.link.info?.kind === 'link' && !linkHint(state.link.info, linkCapabilities())) previewLink();
    else if (state.link.info?.kind === 'link') { state.link.attempted = true; renderLinkBar(); }
  }, 0));
  $('#link-form').addEventListener('submit', (event) => { event.preventDefault(); previewLink(); });
  $('#link-clear').addEventListener('click', () => { input.value = ''; onLinkInput(); linkController?.abort(); if (state.link.status === 'loading') { state.link.status = 'idle'; render(); } input.focus(); });
  $('#file-button').addEventListener('click', () => $('#file-input').click());
  $('#file-help-button').addEventListener('click', () => openDialog($('#import-help-dialog')));
  $('#file-input').addEventListener('change', (event) => { handleFiles(event.target.files); event.target.value = ''; });

  let dragDepth = 0;
  const overlay = $('#drop-overlay');
  document.addEventListener('dragenter', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth += 1;
    overlay.hidden = false;
  });
  document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.hidden = true; });
  document.addEventListener('dragover', (event) => { if ([...(event.dataTransfer?.types || [])].includes('Files')) event.preventDefault(); });
  document.addEventListener('drop', (event) => {
    dragDepth = 0;
    overlay.hidden = true;
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    handleFiles(event.dataTransfer.files);
  });

  document.addEventListener('click', (event) => {
    const serviceButton = event.target.closest('#destination-grid .service-button');
    if (serviceButton && !serviceButton.disabled) selectDestination(serviceButton.dataset.service);
    const close = event.target.closest('[data-close]');
    if (close) closeDialog(close.closest('dialog'));
  });
  $('#about-button').addEventListener('click', () => openDialog($('#about-dialog')));
  $('#owner-settings-button').addEventListener('click', () => { closeDialog($('#about-dialog')); openSettings(); });
  $('#settings-form').addEventListener('submit', saveSettings);
  $('#forget-tokens').addEventListener('click', forgetTokens);
  $('#copy-redirect').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getRedirectUri());
      toast('Redirect URI copied.', 'success');
    } catch (_) {
      toast('Copy failed — select the text manually.', 'error');
    }
  });
  $('#transfer-button').addEventListener('click', primaryAction);
  $('#cancel-button').addEventListener('click', cancelTransfer);
  $('#download-missing').addEventListener('click', downloadMissing);
  $('#transfer-more').addEventListener('click', () => {
    resetTransfer();
    state.destination = null;
    persistUi();
    render();
    scrollToStep('step-destination');
  });
  $('#start-over').addEventListener('click', startOver);
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
  }
  window.addEventListener('hashchange', handleHashFlags);
  window.addEventListener('beforeunload', (event) => {
    if (state.transfer?.running) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

/** Hidden switches: #demo toggles the sample destination, #setup opens owner settings. */
function handleHashFlags() {
  const hash = (location.hash || '').toLowerCase();
  if (hash === '#demo' && appConfig.allowDemo) toggleDemo(true);
  else if (hash === '#demo-off' || hash === '#nodemo') toggleDemo(false);
  else if (hash === '#setup' && appConfig.allowUserKeys) openSettings();
  else return;
  history.replaceState(null, '', `${location.origin}${location.pathname}${location.search}`);
}

async function boot() {
  await loadLibrary(); // the imported playlist survives the destination's login redirect
  renderStatic();
  bindEvents();
  const hash = (location.hash || '').toLowerCase();
  if (hash === '#demo' || hash === '#demo-off' || hash === '#nodemo' || hash === '#setup') handleHashFlags();
  state.demo = isDemoMode();
  const redirect = consumeRedirect();
  restoreUi();
  const pending = session.get(PENDING_KEY, null);
  session.remove(PENDING_KEY);
  render();
  if (redirect) {
    const ok = await handleRedirect(redirect);
    render();
    if (ok && pending && pending.destination === redirect.provider && hasLibrary() && Date.now() - (pending.at || 0) < 30 * 60 * 1000) {
      state.destination = pending.destination;
      $('#option-public').checked = Boolean(pending.options?.publicPlaylists);
      $('#option-suffix').checked = Boolean(pending.options?.suffix);
      syncSelection(true);
      for (const id of pending.deselected || []) for (const kind of KINDS) state.selected[kind.id].delete(id);
      render();
      await startTransfer();
      return;
    }
    scrollToStep(hasLibrary() ? 'step-destination' : 'step-paste');
  }
  await loadProfile(state.destination);
  render();
  if (hasLibrary()) scrollToStep('step-preview');
}

boot().catch((error) => {
  console.error(error);
  toast(`Something went wrong while starting TuneBridge: ${error.message}`, 'error');
});

export { state, provider };
