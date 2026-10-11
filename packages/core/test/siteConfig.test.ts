import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { configOrigins, globToRegExp, parseSiteConfig, SiteConfigError, SiteRegistry } from '../src';
import { BASE, mangaConfig, novelConfig } from './helpers';

describe('parseSiteConfig', () => {
  it('applies defaults', () => {
    expect(novelConfig.series.chapters.order).toBe('newest-first');
  });

  it('rejects configs with both or neither of pages/text', () => {
    const both = { ...mangaConfig, chapter: { ...mangaConfig.chapter, text: 'article' } };
    expect(() => parseSiteConfig(both)).toThrow(/exactly one of "pages" or "text"/);
    const { pages: _pages, ...neither } = mangaConfig.chapter;
    expect(() => parseSiteConfig({ ...mangaConfig, chapter: neither })).toThrow(SiteConfigError);
  });

  it('rejects unknown keys, so typos in community configs surface early', () => {
    expect(() => parseSiteConfig({ ...mangaConfig, scirpt: 'alert(1)' })).toThrow(/unrecognized key/);
  });

  it('rejects globs with a wildcard host', () => {
    const config = { ...mangaConfig, series: { ...mangaConfig.series, url: 'https://*/series/*' } };
    expect(() => parseSiteConfig(config)).toThrow(/literal host/);
  });

  it('requires an icon, developer and 18+ flag', () => {
    const { icon: _icon, developer: _developer, nsfw: _nsfw, ...bare } = mangaConfig;
    try {
      parseSiteConfig(bare);
      expect.unreachable();
    } catch (err) {
      expect((err as SiteConfigError).issues.map((i) => i.split(':')[0])).toEqual(['icon', 'developer', 'nsfw']);
    }
    expect(() => parseSiteConfig({ ...mangaConfig, icon: 'javascript:alert(1)' })).toThrow(/icon/);
    expect(parseSiteConfig({ ...mangaConfig, icon: 'data:image/png;base64,AAAA' }).icon).toMatch(/^data:image/);
  });

  it('only explores lists on the host the series pages live on', () => {
    const list = { name: 'Popular', url: 'https://elsewhere.example/popular?page={page}', item: 'li' };
    expect(() => parseSiteConfig({ ...mangaConfig, explore: [list] })).toThrow(/explore\.0\.url/);
    const ok = parseSiteConfig({ ...mangaConfig, explore: [{ ...list, url: `${BASE}/popular?page={page}` }] });
    expect(ok.explore?.[0]?.name).toBe('Popular');
  });

  it('only searches the host the series pages live on', () => {
    const search = { url: 'https://elsewhere.example/search?q={query}', item: 'li' };
    expect(() => parseSiteConfig({ ...mangaConfig, search })).toThrow(/search\.url: must be on the same host/);
    expect(() => parseSiteConfig({ ...mangaConfig, search: { ...search, url: `${BASE}/search` } })).toThrow(/\{query\}/);
  });

  it('lists every issue', () => {
    try {
      parseSiteConfig({ schema: 1 });
      expect.unreachable();
    } catch (err) {
      expect((err as SiteConfigError).issues.length).toBeGreaterThan(3);
    }
  });
});

describe('configOrigins', () => {
  it('lists each host once, keeping ports', () => {
    expect(configOrigins(mangaConfig)).toEqual(['http://localhost:4173/*']);
    const split = { ...mangaConfig, chapter: { ...mangaConfig.chapter, url: 'https://m.site.example/read/*' } };
    expect(configOrigins(split)).toEqual(['http://localhost:4173/*', 'https://m.site.example/*']);
  });
});

describe('globToRegExp', () => {
  const series = globToRegExp('https://site.example/series/*');

  it('matches one path segment per *', () => {
    expect(series.test('https://site.example/series/moon')).toBe(true);
    expect(series.test('https://site.example/series/moon/')).toBe(true);
    expect(series.test('https://site.example/series/moon?tab=chapters')).toBe(true);
    expect(series.test('https://site.example/series/moon/chapter/1')).toBe(false);
    expect(series.test('https://evil.example/series/moon')).toBe(false);
  });

  it('matches across segments with **', () => {
    expect(globToRegExp('https://site.example/read/**').test('https://site.example/read/a/b/c')).toBe(true);
  });

  it('treats regex characters literally', () => {
    expect(globToRegExp('https://site.example/a.b').test('https://site.example/aXb')).toBe(false);
  });
});

describe('SiteRegistry', () => {
  const registry = new SiteRegistry([mangaConfig, novelConfig]);

  it('routes URLs to the right config and page kind', () => {
    expect(registry.match(`${BASE}/series/moon-garden`)).toMatchObject({ kind: 'series', config: { id: 'testsite.manga' } });
    expect(registry.match(`${BASE}/series/moon-garden/chapter/2#p3`)).toMatchObject({
      kind: 'chapter',
      config: { id: 'testsite.manga' },
    });
    expect(registry.match(`${BASE}/novel/quiet-orbit/chapter/1`)).toMatchObject({
      kind: 'chapter',
      config: { id: 'testsite.novel' },
    });
    expect(registry.match(`${BASE}/`)).toBeUndefined();
    expect(registry.match('not a url')).toBeUndefined();
  });
});

describe('configs in the repo', () => {
  const dir = new URL('../../../configs/', import.meta.url);
  const testSite = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const featured = readdirSync(new URL('featured/', dir)).map((f) => `featured/${f}`);
  const load = (file: string) => parseSiteConfig(JSON.parse(readFileSync(new URL(file, dir), 'utf8')));

  it.each([...testSite, ...featured])('%s is valid', (file) => {
    expect(() => load(file)).not.toThrow();
  });

  it.each(testSite)('%s is searchable', (file) => {
    expect(load(file).search).toBeDefined();
  });
});
