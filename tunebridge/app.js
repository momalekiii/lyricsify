// TuneBridge UI controller — wires the wizard steps to the provider adapters and transfer engine.
import { SERVICES, SERVICE_IDS, KINDS, canRead, canWrite, logoSvg } from './js/services.js';
import { createProvider } from './js/providers/index.js';
import { consumeRedirect, getRedirectUri, tokens } from './js/oauth.js';
import { getServiceConfig, getUserSettings, saveUserSettings, getAppConfig, isDemoMode, setDemoMode } from './js/settings.js';
import { runTransfer, summarize, missingAsCsv } from './js/transfer.js';
import { session } from './js/storage.js';
import { el, debounce, pluralize } from './js/util.js';

const UI_KEY = 'tunebridge.ui.v1';
const $ = (selector) => document.querySelector(selector);

const state = {
  source: null,
  destination: null,
  kind: 'playlists',
  items: { playlists: null, albums: null, artists: null },
  loading: null,
  loadError: null,
  selected: { playlists: new Map(), albums: new Map(), artists: new Map() },
  filter: '',
  profiles: {},
  busy: {},
  transfer: null,
  demo: isDemoMode(),
};

const providers = new Map();
const appConfig = getAppConfig();
let toastTimer;
let loadToken = 0;

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
  session.set(UI_KEY, { source: state.source, destination: state.destination, kind: state.kind });
}

function restoreUi() {
  const saved = session.get(UI_KEY, null);
  if (!saved) return;
  if (SERVICES[saved.source]) state.source = saved.source;
  if (SERVICES[saved.destination] && saved.destination !== state.source) state.destination = saved.destination;
  if (KINDS.some((k) => k.id === saved.kind)) state.kind = saved.kind;
}

function resetContent() {
  state.items = { playlists: null, albums: null, artists: null };
  state.selected = { playlists: new Map(), albums: new Map(), artists: new Map() };
  state.loadError = null;
  state.loading = null;
  state.filter = '';
  const filter = $('#picker-filter');
  if (filter) filter.value = '';
}

function resetTransfer() {
  if (state.transfer?.running) state.transfer.controller.abort();
  state.transfer = null;
  $('#transfer-log').replaceChildren();
  $('#progress-wrap').hidden = true;
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function svg(serviceId, size = 24) {
  const template = document.createElement('template');
  template.innerHTML = logoSvg(serviceId, { size });
  return template.content.firstElementChild;
}

function toast(message, type = '') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show ${type}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), type === 'error' ? 6500 : 3800);
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
  return `--brand:${service.color};--brand-2:${service.color2};--ink:${service.ink}`;
}

function applyAccent() {
  const root = document.documentElement;
  const from = state.source ? SERVICES[state.source].color : '#35e6ff';
  const to = state.destination ? SERVICES[state.destination].color : state.source ? SERVICES[state.source].color2 : '#a238ff';
  root.style.setProperty('--from', from);
  root.style.setProperty('--to', to);
}

function scrollToStep(id) {
  requestAnimationFrame(() => {
    const node = document.getElementById(id);
    if (node && !node.hidden) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function capabilityNote(serviceId, role) {
  const index = role === 'source' ? 0 : 1;
  const supported = KINDS.filter((kind) => SERVICES[serviceId].caps[kind.id][index]).map((kind) => kind.label);
  const unsupported = KINDS.filter((kind) => !SERVICES[serviceId].caps[kind.id][index]).map((kind) => kind.label.toLowerCase());
  return { supported: supported.join(' · '), unsupported: unsupported.length ? `No ${unsupported.join(', ')}` : '' };
}

function kindAvailable(kind) {
  return Boolean(state.source && state.destination && canRead(state.source, kind) && canWrite(state.destination, kind));
}

function kindUnavailableReason(kind) {
  const label = KINDS.find((k) => k.id === kind).label.toLowerCase();
  if (state.source && !canRead(state.source, kind)) return `${SERVICES[state.source].name} does not expose ${label} through its API.`;
  if (state.destination && !canWrite(state.destination, kind)) return `${SERVICES[state.destination].name} cannot save ${label} through its API.`;
  return '';
}

const totalSelected = () => KINDS.reduce((sum, kind) => sum + state.selected[kind.id].size, 0);

// ---------------------------------------------------------------------------
// Static rendering (runs once)
// ---------------------------------------------------------------------------

function renderStatic() {
  $('#footer-year').textContent = String(new Date().getFullYear());
  const strip = $('#services-strip');
  strip.replaceChildren(...SERVICE_IDS.map((id) => el('li', { style: brandVars(id) }, svg(id, 18), SERVICES[id].name)));
  $('#redirect-uri').textContent = getRedirectUri();

  const table = $('#caps-table');
  const head = el('tr', {}, el('th', { text: 'Service' }), ...KINDS.map((kind) => el('th', { text: kind.label })));
  const rows = SERVICE_IDS.map((id) => el('tr', {}, el('td', {}, el('span', { style: `display:inline-flex;align-items:center;gap:8px;${brandVars(id)}` }, svg(id, 16), SERVICES[id].name)), ...KINDS.map((kind) => {
    const [read, write] = SERVICES[id].caps[kind.id];
    if (read && write) return el('td', { class: 'yes', text: '✓ read & write' });
    if (read) return el('td', { class: 'partial', text: 'read only' });
    if (write) return el('td', { class: 'partial', text: 'write only' });
    return el('td', { class: 'no', text: '—' });
  })));
  table.replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));

  const ownerLink = document.querySelector('.footer-copyright a');
  if (ownerLink) {
    ownerLink.href = appConfig.ownerUrl;
    ownerLink.lastChild.textContent = ` ${appConfig.ownerName}`;
  }
  $('#demo-toggle').hidden = !appConfig.allowDemo;
  $('#hero-demo-button').hidden = !appConfig.allowDemo;
}

// ---------------------------------------------------------------------------
// Dynamic rendering
// ---------------------------------------------------------------------------

function render() {
  applyAccent();
  renderRouteBar();
  renderGrids();
  renderSteps();
  if (state.source && state.destination) renderConnect();
  if (bothConnected()) {
    renderTabs();
    renderPicker();
    renderTransferPanel();
  }
  $('#demo-toggle').setAttribute('aria-pressed', String(state.demo));
  $('#route-demo-badge').hidden = !state.demo;
}

function renderRouteBar() {
  const bar = $('#route-bar');
  bar.hidden = !state.source;
  if (!state.source) return;
  const chip = (node, id, placeholder) => {
    node.replaceChildren();
    if (id) {
      node.setAttribute('style', brandVars(id));
      node.classList.remove('is-empty');
      node.append(svg(id, 18), SERVICES[id].name);
    } else {
      node.removeAttribute('style');
      node.classList.add('is-empty');
      node.append(el('span', { class: 'route-placeholder', text: placeholder }));
    }
  };
  chip($('#route-source'), state.source, 'Choose source');
  chip($('#route-destination'), state.destination, 'Choose destination');
}

function renderGrids() {
  const build = (role) => {
    const selected = role === 'source' ? state.source : state.destination;
    const other = role === 'source' ? state.destination : state.source;
    return SERVICE_IDS.map((id) => {
      const note = capabilityNote(id, role);
      const isOther = id === other;
      const button = el('button', {
        type: 'button',
        class: 'service-button',
        style: brandVars(id),
        'aria-pressed': String(selected === id),
        disabled: isOther,
        title: isOther ? `${SERVICES[id].name} is already the ${role === 'source' ? 'destination' : 'source'}` : `${role === 'source' ? 'Copy from' : 'Copy to'} ${SERVICES[id].name}`,
        dataset: { service: id, role },
      },
      isOther ? el('span', { class: 'service-flag', text: role === 'source' ? 'Destination' : 'Source' }) : null,
      el('span', { class: 'service-logo' }, svg(id, 30)),
      el('span', { class: 'service-name', text: SERVICES[id].name }),
      el('span', { class: 'service-note', text: note.supported }),
      note.unsupported ? el('span', { class: 'service-note unsupported', text: note.unsupported }) : null);
      return button;
    });
  };
  $('#source-grid').replaceChildren(...build('source'));
  $('#destination-grid').replaceChildren(...build('destination'));
}

function bothConnected() {
  return Boolean(state.source && state.destination && provider(state.source).isConnected() && provider(state.destination).isConnected());
}

function renderSteps() {
  const connected = bothConnected();
  $('#step-destination').hidden = !state.source;
  $('#step-connect').hidden = !(state.source && state.destination);
  $('#step-content').hidden = !connected;
  $('#step-transfer').hidden = !(connected && (totalSelected() > 0 || state.transfer));
  $('#step-results').hidden = !state.transfer?.report;
}

function renderConnect() {
  const grid = $('#connect-grid');
  const cards = [
    ['source', state.source],
    ['destination', state.destination],
  ].map(([role, id]) => {
    const service = SERVICES[id];
    const instance = provider(id);
    const connected = instance.isConnected();
    const profile = state.profiles[id];
    const busy = state.busy[id];
    const card = el('div', { class: 'connect-card', style: brandVars(id) });
    card.append(el('div', { class: 'connect-card-head' },
      el('span', { class: 'service-logo' }, svg(id, 24)),
      el('div', {}, el('div', { class: 'connect-role', text: role === 'source' ? 'From' : 'To' }), el('div', { class: 'connect-name', text: service.name }))));

    const status = el('div', { class: 'connect-status' });
    if (connected) {
      status.append(el('span', { class: 'dot on' }));
      if (profile?.image) status.append(el('img', { src: profile.image, alt: '' }));
      status.append(el('span', { text: profile ? `Connected as ${profile.name}` : 'Connected' }));
    } else {
      status.append(el('span', { class: 'dot' }), el('span', { text: busy ? `Opening ${service.name} sign-in…` : 'Not connected yet' }));
    }
    card.append(status);

    const actions = el('div', { class: 'connect-actions' });
    if (connected) {
      if (profile?.url) actions.append(el('a', { class: 'ghost-button', href: profile.url, target: '_blank', rel: 'noreferrer', text: `Open ${service.name}` }));
      actions.append(el('button', { type: 'button', class: 'text-button', text: 'Disconnect', on: { click: () => disconnect(id) } }));
    } else if (instance.isConfigured()) {
      actions.append(el('button', { type: 'button', class: `gradient-button${service.ink === '#ffffff' ? ' light-ink' : ''}`, disabled: Boolean(busy), on: { click: () => connect(id) } }, svg(id, 18), busy ? 'Redirecting…' : `Connect ${service.name}`));
    } else {
      const hint = el('div', { class: 'connect-hint' });
      hint.append(el('div', {}, el('strong', { text: `${service.name} isn’t set up on this TuneBridge yet.` }), ` ${instance.missingConfigMessage()}`));
      const hintActions = el('div', { class: 'hint-actions' });
      if (appConfig.allowUserKeys) hintActions.append(el('button', { type: 'button', class: 'ghost-button', text: 'Add my own API key', on: { click: () => openSettings(id) } }));
      if (appConfig.allowDemo && !state.demo) hintActions.append(el('button', { type: 'button', class: 'pill-button', text: 'Try with demo data', on: { click: () => toggleDemo(true) } }));
      hint.append(hintActions);
      actions.append(hint);
    }
    card.append(actions);
    return card;
  });
  grid.replaceChildren(...cards);
}

function renderTabs() {
  const tabs = $('#kind-tabs');
  tabs.replaceChildren(...KINDS.map((kind) => {
    const available = kindAvailable(kind.id);
    const count = state.selected[kind.id].size;
    const tab = el('button', {
      type: 'button',
      class: 'tab',
      role: 'tab',
      'aria-selected': String(state.kind === kind.id),
      disabled: !available,
      title: available ? '' : kindUnavailableReason(kind.id),
      on: { click: () => selectKind(kind.id) },
    }, kind.label, count ? el('span', { class: 'count', text: `(${count})` }) : null);
    return tab;
  }));
  const sourceName = SERVICES[state.source].name;
  const destName = SERVICES[state.destination].name;
  const unavailable = KINDS.filter((k) => !kindAvailable(k.id)).map((k) => k.label.toLowerCase());
  $('#step-content-copy').textContent = `Everything you tick here will be rebuilt on ${destName}.${unavailable.length ? ` ${unavailable.join(' and ').replace(/^\w/, (c) => c.toUpperCase())} can’t move from ${sourceName} to ${destName} (API limitation).` : ''}`;
}

function renderPicker() {
  const status = $('#picker-status');
  const list = $('#item-list');
  const items = state.items[state.kind];
  if (!kindAvailable(state.kind)) {
    status.hidden = false;
    status.className = 'picker-status';
    status.textContent = kindUnavailableReason(state.kind);
    list.replaceChildren();
    return;
  }
  if (state.loading === state.kind) {
    status.hidden = false;
    status.className = 'picker-status';
    status.textContent = `Loading your ${state.kind} from ${SERVICES[state.source].name}…`;
    list.replaceChildren();
    return;
  }
  if (state.loadError && items == null) {
    status.hidden = false;
    status.className = 'picker-status error';
    status.textContent = state.loadError;
    list.replaceChildren();
    return;
  }
  if (items == null) {
    loadItems(state.kind);
    return;
  }
  const query = state.filter.trim().toLowerCase();
  const visible = items.filter((item) => !query || itemSearchText(item).includes(query));
  status.hidden = visible.length > 0;
  status.className = 'picker-status';
  status.textContent = items.length ? 'Nothing matches your filter.' : `No ${state.kind} found on ${SERVICES[state.source].name}.`;
  const selected = state.selected[state.kind];
  list.replaceChildren(...visible.map((item) => renderItem(item, selected.has(item.id))));
}

function itemSearchText(item) {
  return `${item.name || item.title || ''} ${(item.artists || []).join(' ')} ${item.owner || ''}`.toLowerCase();
}

function renderItem(item, isSelected) {
  const kind = state.kind;
  const title = item.name || item.title || 'Untitled';
  let meta = '';
  if (kind === 'playlists') meta = [item.trackCount != null ? pluralize(item.trackCount, 'track') : item.special ? 'Your library' : '', item.owner && item.owner !== 'You' ? `by ${item.owner}` : ''].filter(Boolean).join(' · ');
  if (kind === 'albums') meta = [(item.artists || []).join(', '), item.year, item.trackCount ? pluralize(item.trackCount, 'track') : ''].filter(Boolean).join(' · ');
  if (kind === 'artists') meta = 'Artist';
  const cover = el('span', { class: `item-cover${kind === 'artists' ? ' round' : ''}` });
  if (item.image) cover.append(el('img', { src: item.image, alt: '', loading: 'lazy' }));
  else cover.textContent = title.trim().charAt(0).toUpperCase() || '♪';
  const label = el('label', { class: `item${isSelected ? ' is-selected' : ''}` },
    el('input', { type: 'checkbox', checked: isSelected, on: { change: (event) => toggleItem(item, event.target.checked, label) } }),
    el('span', { class: 'checkbox', 'aria-hidden': 'true' }),
    cover,
    el('span', { class: 'item-text' }, el('span', { class: 'item-title', text: title }), el('span', { class: 'item-meta', text: meta })),
    item.special ? el('span', { class: 'item-tag', text: 'Library' }) : item.isPublic === false && kind === 'playlists' ? el('span', { class: 'item-tag', text: 'Private' }) : null);
  return label;
}

function renderTransferPanel() {
  const summary = $('#transfer-summary');
  const chips = KINDS.filter((kind) => state.selected[kind.id].size).map((kind) => el('span', { class: 'summary-chip' }, el('strong', { text: String(state.selected[kind.id].size) }), kind.label.toLowerCase()));
  const trackEstimate = Array.from(state.selected.playlists.values()).reduce((sum, p) => sum + (p.trackCount || 0), 0);
  if (trackEstimate) chips.push(el('span', { class: 'summary-chip' }, el('strong', { text: `≈${trackEstimate}` }), 'tracks to match'));
  if (!chips.length) chips.push(el('span', { class: 'summary-chip', text: 'Nothing selected yet' }));
  summary.replaceChildren(el('span', { class: 'summary-chip', style: brandVars(state.source) }, svg(state.source, 16), SERVICES[state.source].name, '→', svg(state.destination, 16), SERVICES[state.destination].name), ...chips);
  $('#option-suffix-source').textContent = SERVICES[state.source].name;

  const button = $('#transfer-button');
  const running = Boolean(state.transfer?.running);
  const destination = SERVICES[state.destination];
  const ink = SERVICES[state.source].ink === '#ffffff' && destination.ink === '#ffffff';
  button.classList.toggle('light-ink', ink);
  button.disabled = running || totalSelected() === 0;
  button.replaceChildren(el('span', { class: 'service-inline' }, running ? 'Transferring…' : `Transfer to ${destination.name}`, running ? null : svg(state.destination, 20)));
  $('#cancel-button').hidden = !running;
  if (state.destination === 'youtube' && trackEstimate > 60 && !running) {
    const warn = el('span', { class: 'summary-chip', style: 'border-color:rgba(255,196,0,.5);color:#ffd866', text: `YouTube’s default API quota fits about 60 new tracks per day — ${trackEstimate} may take several days.` });
    summary.append(warn);
  }
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
        : `${stats.missing} ${stats.missing === 1 ? 'item' : 'items'} couldn’t be found on ${destination.name} — details below.`;
  $('#results-copy').textContent = copy;
  $('#step-results-title').textContent = report.cancelled ? 'Cancelled' : report.error ? 'Stopped' : 'All done';

  const statBoxes = el('div', { class: 'results-stats' },
    el('div', { class: 'stat' }, el('strong', { text: String(stats.items) }), el('span', { text: 'items processed' })),
    el('div', { class: 'stat' }, el('strong', { text: `${stats.tracksMatched}/${stats.tracksTotal}` }), el('span', { text: 'tracks matched' })),
    el('div', { class: 'stat' }, el('strong', { text: String(stats.missing) }), el('span', { text: 'not found' })),
    el('div', { class: 'stat' }, el('strong', { text: `${Math.max(1, Math.round((report.finishedAt - report.startedAt) / 1000))}s` }), el('span', { text: 'elapsed' })));

  const items = report.items.map((item) => {
    const cls = item.status === 'done' ? (item.missing.length + item.failed.length ? 'partial' : 'done') : item.status;
    const icon = cls === 'done' ? '✓' : cls === 'partial' ? '!' : '×';
    const sub = item.kind === 'playlist' ? `${item.matched} of ${item.total} tracks` : item.message;
    const details = el('details', { class: `result-item ${cls}` });
    const summaryNode = el('summary', {}, el('span', { class: 'log-icon', text: icon }), el('span', { class: 'result-title' }, item.name, ' ', el('span', { class: 'result-sub', text: `· ${sub}` })));
    if (item.url) summaryNode.append(el('a', { class: 'result-link', href: item.url, target: '_blank', rel: 'noreferrer', text: `Open on ${destination.name} ↗`, on: { click: (event) => event.stopPropagation() } }));
    details.append(summaryNode);
    const missing = el('ul', { class: 'missing-list' });
    for (const track of item.missing) missing.append(el('li', {}, el('strong', { text: track.title || track.name || '' }), el('span', { text: (track.artists || []).join(', ') }), el('em', { text: 'not found' })));
    for (const { track, error } of item.failed) missing.append(el('li', {}, el('strong', { text: track.title || track.name || '' }), el('span', { text: (track.artists || []).join(', ') }), el('em', { text: error })));
    if (item.error && !item.failed.length) missing.append(el('li', {}, el('em', { text: item.error })));
    if (!missing.childElementCount) missing.append(el('li', {}, el('span', { text: item.kind === 'playlist' ? 'Every track was found.' : item.message })));
    details.append(missing);
    return details;
  });
  panel.replaceChildren(statBoxes, ...items);
  $('#download-missing').hidden = stats.missing === 0;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function selectService(role, id) {
  if (role === 'source') {
    if (state.source === id) return;
    state.source = id;
    if (state.destination === id) state.destination = null;
    resetContent();
    resetTransfer();
    persistUi();
    render();
    scrollToStep(state.destination ? 'step-connect' : 'step-destination');
  } else {
    if (state.destination === id) return;
    state.destination = id;
    for (const kind of KINDS) if (!kindAvailable(kind.id)) state.selected[kind.id].clear();
    if (!kindAvailable(state.kind)) state.kind = KINDS.find((kind) => kindAvailable(kind.id))?.id || 'playlists';
    resetTransfer();
    persistUi();
    render();
    scrollToStep(bothConnected() ? 'step-content' : 'step-connect');
  }
}

async function connect(id) {
  const instance = provider(id);
  if (!instance.isConfigured()) {
    openSettings(id);
    return;
  }
  state.busy[id] = true;
  render();
  try {
    await instance.connect(); // redirect-based providers never resolve here (page navigates away)
    await loadProfile(id);
    toast(`Connected to ${SERVICES[id].name}.`, 'success');
  } catch (error) {
    toast(error.message || `Could not connect to ${SERVICES[id].name}.`, 'error');
  } finally {
    state.busy[id] = false;
    render();
    if (bothConnected()) scrollToStep('step-content');
  }
}

function disconnect(id) {
  provider(id).disconnect();
  delete state.profiles[id];
  resetContent();
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
  if (!result) return;
  if (result.error && !result.provider) {
    toast(result.error, 'error');
    return;
  }
  const id = result.provider;
  if (result.error) {
    toast(`${SERVICES[id]?.name || 'Sign-in'}: ${result.error}`, 'error');
    return;
  }
  try {
    await provider(id).finishConnect(result);
    await loadProfile(id);
    toast(`Connected to ${SERVICES[id].name}.`, 'success');
  } catch (error) {
    toast(`${SERVICES[id]?.name || 'Sign-in'}: ${error.message}`, 'error');
  }
}

function selectKind(kind) {
  if (!kindAvailable(kind)) return;
  state.kind = kind;
  persistUi();
  render();
}

async function loadItems(kind) {
  const token = ++loadToken;
  const source = provider(state.source);
  state.loading = kind;
  state.loadError = null;
  renderPicker();
  try {
    const items = kind === 'playlists' ? await source.listPlaylists() : kind === 'albums' ? await source.listAlbums() : await source.listArtists();
    state.items[kind] = items;
    if (token !== loadToken) return;
  } catch (error) {
    if (token !== loadToken) return;
    state.loadError = error.name === 'AuthError' ? error.message : `Could not load ${kind} from ${SERVICES[state.source].name}: ${error.message}`;
    if (error.name === 'AuthError') {
      delete state.profiles[state.source];
      render();
      return;
    }
  } finally {
    if (token === loadToken) state.loading = null;
  }
  render();
}

function toggleItem(item, checked, node) {
  const selected = state.selected[state.kind];
  if (checked) selected.set(item.id, item);
  else selected.delete(item.id);
  node.classList.toggle('is-selected', checked);
  renderTabs();
  renderSteps();
  renderTransferPanel();
}

function selectAll(value) {
  const items = state.items[state.kind] || [];
  const query = state.filter.trim().toLowerCase();
  const selected = state.selected[state.kind];
  for (const item of items) {
    if (query && !itemSearchText(item).includes(query)) continue;
    if (value) selected.set(item.id, item);
    else selected.delete(item.id);
  }
  render();
}

async function startTransfer() {
  if (state.transfer?.running) return;
  const source = provider(state.source);
  const destination = provider(state.destination);
  const selection = { playlists: [...state.selected.playlists.values()], albums: [...state.selected.albums.values()], artists: [...state.selected.artists.values()] };
  const controller = new AbortController();
  const entries = new Map();
  state.transfer = { controller, running: true, report: null, entries };
  const log = $('#transfer-log');
  log.replaceChildren();
  $('#progress-wrap').hidden = false;
  $('#progress-fill').style.width = '0%';
  $('#progress-label').textContent = 'Starting…';
  $('#progress-count').textContent = '';
  $('#step-results').hidden = true;
  render();
  scrollToStep('step-transfer');

  const sourceName = SERVICES[state.source].name;
  const options = {
    publicPlaylists: $('#option-public').checked,
    renamePlaylist: $('#option-suffix').checked ? (playlist) => `${playlist.name} (from ${sourceName})` : null,
  };

  const report = await runTransfer({
    source,
    destination,
    selection,
    options,
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
  else toast(`Done — ${stats.tracksMatched} of ${stats.tracksTotal} tracks matched.`, stats.missing ? '' : 'success');
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
  setTimeout(() => {
    $('#cancel-button').disabled = false;
  }, 1500);
}

function downloadMissing() {
  const report = state.transfer?.report;
  if (!report) return;
  const csv = missingAsCsv(report);
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: `tunebridge-missing-${state.source}-to-${state.destination}.csv` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function toggleDemo(force) {
  const next = typeof force === 'boolean' ? force : !state.demo;
  if (next === state.demo) return;
  if (state.transfer?.running) {
    toast('Wait for the current transfer to finish (or cancel it) before switching modes.', 'error');
    return;
  }
  state.demo = next;
  setDemoMode(next);
  resetProviders();
  resetContent();
  resetTransfer();
  render();
  toast(next ? 'Demo mode on — sample libraries, nothing touches your real accounts.' : 'Demo mode off — back to real services.');
  if (next && !state.source) scrollToStep('step-source');
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

function openSettings(focusService) {
  const container = $('#settings-services');
  const user = getUserSettings();
  const baseConfig = (window.TUNEBRIDGE_CONFIG || {});
  container.replaceChildren(...SERVICE_IDS.map((id) => {
    const service = SERVICES[id];
    const base = baseConfig[id] || {};
    const effective = getServiceConfig(id);
    const configured = createProvider(id, { config: effective }).isConfigured();
    const section = el('section', { class: 'settings-service', style: brandVars(id), id: `settings-${id}` });
    section.append(el('div', { class: 'settings-service-head' }, svg(id, 20), service.name, el('span', { class: `status${configured ? ' ok' : ''}`, text: configured ? 'Ready' : 'Not configured' })));
    section.append(el('p', { html: `${service.setup} <a href="${service.developer}" target="_blank" rel="noreferrer">Open developer portal ↗</a>` }));
    for (const credential of service.credentials) {
      const value = user[id]?.[credential.key] || '';
      const fromConfig = base[credential.key] ? 'Pre-filled by the site owner — leave empty to keep it.' : '';
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
  for (const instance of providers.values()) instance.disconnect?.();
  state.profiles = {};
  resetContent();
  resetTransfer();
  closeDialog($('#settings-dialog'));
  render();
  toast('Signed out of all services on this browser.');
}

// ---------------------------------------------------------------------------
// Events & boot
// ---------------------------------------------------------------------------

function bindEvents() {
  document.addEventListener('click', (event) => {
    const serviceButton = event.target.closest('.service-button');
    if (serviceButton && !serviceButton.disabled) selectService(serviceButton.dataset.role, serviceButton.dataset.service);
    const close = event.target.closest('[data-close]');
    if (close) closeDialog(close.closest('dialog'));
  });
  $('#route-source').addEventListener('click', () => scrollToStep('step-source'));
  $('#route-destination').addEventListener('click', () => scrollToStep('step-destination'));
  $('#demo-toggle').addEventListener('click', () => toggleDemo());
  $('#hero-demo-button').addEventListener('click', () => {
    toggleDemo(true);
    if (!state.source) selectService('source', 'spotify');
    if (!state.destination) selectService('destination', 'apple');
    scrollToStep('step-connect');
  });
  $('#settings-button').addEventListener('click', () => openSettings());
  $('#about-button').addEventListener('click', () => openDialog($('#about-dialog')));
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
  $('#picker-filter').addEventListener('input', debounce((event) => {
    state.filter = event.target.value;
    renderPicker();
  }, 120));
  $('#select-all').addEventListener('click', () => selectAll(true));
  $('#select-none').addEventListener('click', () => selectAll(false));
  $('#reload-items').addEventListener('click', () => {
    state.items[state.kind] = null;
    state.loadError = null;
    render();
  });
  $('#transfer-button').addEventListener('click', startTransfer);
  $('#cancel-button').addEventListener('click', cancelTransfer);
  $('#download-missing').addEventListener('click', downloadMissing);
  $('#transfer-more').addEventListener('click', () => {
    for (const kind of KINDS) state.selected[kind.id].clear();
    resetTransfer();
    render();
    scrollToStep('step-content');
  });
  $('#start-over').addEventListener('click', () => {
    resetTransfer();
    resetContent();
    state.source = null;
    state.destination = null;
    persistUi();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeDialog(dialog);
    });
  }
  window.addEventListener('beforeunload', (event) => {
    if (state.transfer?.running) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

async function boot() {
  renderStatic();
  restoreUi();
  bindEvents();
  const redirect = consumeRedirect();
  render();
  if (redirect) {
    await handleRedirect(redirect);
    render();
    scrollToStep(bothConnected() ? 'step-content' : 'step-connect');
  }
  await Promise.all([loadProfile(state.source), loadProfile(state.destination)]);
  render();
}

boot().catch((error) => {
  console.error(error);
  toast(`Something went wrong while starting TuneBridge: ${error.message}`, 'error');
});

export { state, provider };
