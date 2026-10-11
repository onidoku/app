import {
  paperbackConfigId,
  PaperbackListingSchema,
  paperbackSiteConfig,
  parseServer,
  parseSiteConfig,
  serverSiteConfig,
  SiteRegistry,
  type KeyValueStore,
  type PaperbackInstall,
  type ServerConfig,
  type SiteConfig,
} from '@onidoku/core';
import { CONFIGS_KEY, PAPERBACK_KEY, paperbackCodeKey, paperbackStateKey, SERVERS_KEY, SETTINGS_KEY } from './keys';
import { DEFAULT_SETTINGS, type Settings } from './messages';

export const chromeStore: KeyValueStore = {
  async get(key) {
    return (await chrome.storage.local.get(key))[key];
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
};

async function storedConfigs(): Promise<unknown[]> {
  return ((await chromeStore.get(CONFIGS_KEY)) as unknown[] | undefined) ?? [];
}

/** Installed site configs plus one generated config per media server and Paperback source. */
export async function loadRegistry(): Promise<SiteRegistry> {
  const registry = new SiteRegistry();
  for (const raw of await storedConfigs()) {
    try {
      registry.add(parseSiteConfig(raw));
    } catch (err) {
      console.warn('skipping invalid stored site config', raw, err);
    }
  }
  for (const server of await loadServers()) registry.add(serverSiteConfig(server));
  for (const install of await loadPaperbackInstalls()) registry.add(paperbackSiteConfig(install));
  return registry;
}

export async function loadPaperbackInstalls(): Promise<PaperbackInstall[]> {
  const stored = ((await chromeStore.get(PAPERBACK_KEY)) as Partial<PaperbackInstall>[] | undefined) ?? [];
  return stored.flatMap((raw) => {
    const listing = PaperbackListingSchema.safeParse(raw?.listing);
    if (!listing.success || typeof raw.repo !== 'string') {
      console.warn('skipping invalid stored Paperback source', raw);
      return [];
    }
    const sections = (Array.isArray(raw.sections) ? raw.sections : [])
      .filter((s) => typeof s?.id === 'string' && typeof s.title === 'string')
      .map((s) => ({ id: s.id, title: s.title, more: s.more === true }));
    return [{ repo: raw.repo, listing: listing.data, sections, installedAt: String(raw.installedAt ?? '') }];
  });
}

/** Stores a Paperback source, replacing one with the same id, and its code when given. */
export async function savePaperbackInstall(install: PaperbackInstall, code?: string): Promise<void> {
  const id = paperbackConfigId(install.listing.id);
  if (code !== undefined) await chromeStore.set(paperbackCodeKey(id), code);
  const others = (await loadPaperbackInstalls()).filter((i) => paperbackConfigId(i.listing.id) !== id);
  await chromeStore.set(PAPERBACK_KEY, [...others, install]);
}

/** Forgets a Paperback source, its code and its settings. */
export async function removePaperbackInstall(configId: string): Promise<void> {
  await chromeStore.set(PAPERBACK_KEY, (await loadPaperbackInstalls()).filter((i) => paperbackConfigId(i.listing.id) !== configId));
  await chrome.storage.local.remove([paperbackCodeKey(configId), paperbackStateKey(configId)]);
}

export async function loadServers(): Promise<ServerConfig[]> {
  const stored = ((await chromeStore.get(SERVERS_KEY)) as unknown[] | undefined) ?? [];
  return stored.flatMap((raw) => {
    try {
      return [parseServer(raw)];
    } catch (err) {
      console.warn('skipping invalid stored server', err);
      return [];
    }
  });
}

/** Stores a server, replacing one with the same id (the same address). */
export async function saveServer(server: ServerConfig): Promise<void> {
  const others = (await loadServers()).filter((s) => s.id !== server.id);
  await chromeStore.set(SERVERS_KEY, [...others, server]);
}

export async function removeServer(id: string): Promise<void> {
  await chromeStore.set(SERVERS_KEY, (await loadServers()).filter((s) => s.id !== id));
}

/** Validates and stores a config, replacing any installed config with the same id. */
export async function installConfig(raw: unknown): Promise<SiteConfig> {
  const config = parseSiteConfig(raw);
  const others = (await storedConfigs()).filter((c) => (c as { id?: unknown }).id !== config.id);
  await chromeStore.set(CONFIGS_KEY, [...others, config]);
  return config;
}

export async function removeConfig(id: string): Promise<void> {
  const remaining = (await storedConfigs()).filter((c) => (c as { id?: unknown }).id !== id);
  await chromeStore.set(CONFIGS_KEY, remaining);
}

export async function loadSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...((await chromeStore.get(SETTINGS_KEY)) as Partial<Settings> | undefined) };
}

export async function saveSettings(changes: Partial<Settings>): Promise<Settings> {
  const settings = { ...(await loadSettings()), ...changes };
  await chromeStore.set(SETTINGS_KEY, settings);
  return settings;
}
