/** chrome.storage.local key holding the installed site configs. */
export const CONFIGS_KEY = 'siteConfigs';

/** chrome.storage.local key bumped on every library write, so pages can watch the library (kept in IndexedDB). */
export const LIBRARY_CHANGED_KEY = 'libraryChanged';

/** chrome.storage.local key that held the whole library before it moved to IndexedDB; moved over on first use. */
export const LEGACY_LIBRARY_KEY = 'library';

/** chrome.storage.local key holding user settings (see Settings in messages.ts). */
export const SETTINGS_KEY = 'settings';

/** chrome.storage.local key holding the user's media servers, with their credentials. */
export const SERVERS_KEY = 'servers';

/** chrome.storage.local key holding installed Paperback sources (see PaperbackInstall); their code is under paperbackCodeKey. */
export const PAPERBACK_KEY = 'paperbackSources';

/** Where a Paperback source's code is stored (it can be ~1 MB, so not with the list). */
export const paperbackCodeKey = (configId: string) => `paperbackCode:${configId}`;

/** Settings a Paperback source keeps for itself (its state manager). */
export const paperbackStateKey = (configId: string) => `paperbackState:${configId}`;

/**
 * chrome.storage.session key: hosts whose Cloudflare check challenges the extension's own requests,
 * so Paperback requests and images for them go through an open tab of the site.
 */
export const CF_HOSTS_KEY = 'cloudflareHosts';
