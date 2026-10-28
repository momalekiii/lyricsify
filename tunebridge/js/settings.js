// Merges the deploy-time config (config.js → window.TUNEBRIDGE_CONFIG) with the
// visitor's own API keys saved in this browser (Settings dialog).
import { local, session } from './storage.js';
import { SERVICE_IDS } from './services.js';

const USER_KEY = 'tunebridge.settings.v1';
const DEMO_KEY = 'tunebridge.demo';

function baseConfig() {
  const config = (typeof window !== 'undefined' && window.TUNEBRIDGE_CONFIG) || {};
  return config;
}

export function getUserSettings() {
  return local.get(USER_KEY, {}) || {};
}

export function saveUserSettings(settings) {
  local.set(USER_KEY, settings);
}

/** Effective per-service credentials: user-entered values win over config.js values. */
export function getServiceConfig(serviceId) {
  const base = baseConfig()[serviceId] || {};
  const user = getUserSettings()[serviceId] || {};
  const merged = { ...base };
  for (const [key, value] of Object.entries(user)) {
    if (typeof value === 'string' ? value.trim() : value) merged[key] = typeof value === 'string' ? value.trim() : value;
  }
  return merged;
}

export function getAllServiceConfigs() {
  return Object.fromEntries(SERVICE_IDS.map((id) => [id, getServiceConfig(id)]));
}

export function getAppConfig() {
  const base = baseConfig();
  return {
    appName: base.appName || 'TuneBridge',
    allowDemo: base.allowDemo !== false,
    allowUserKeys: base.allowUserKeys !== false,
    ownerName: base.ownerName || 'momalekiii',
    ownerUrl: base.ownerUrl || 'https://momalekiii.github.io',
    repoUrl: base.repoUrl || 'https://github.com/momalekiii/tunebridge',
    resolverUrl: String(base.resolverUrl || '').trim().replace(/\/+$/, ''),
    setupUrl: base.setupUrl || `${(base.repoUrl || 'https://github.com/momalekiii/tunebridge').replace(/\/$/, '')}/blob/main/SETUP.md`,
  };
}

export function isDemoMode() {
  return Boolean(session.get(DEMO_KEY, false));
}

export function setDemoMode(enabled) {
  if (enabled) session.set(DEMO_KEY, true);
  else session.remove(DEMO_KEY);
}
