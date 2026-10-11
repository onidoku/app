import type { SiteConfig } from './siteConfig';
import { globToRegExp, normalizeUrl } from './url';

export type PageKind = 'series' | 'chapter';

export interface PageMatch {
  config: SiteConfig;
  kind: PageKind;
}

interface Compiled {
  config: SiteConfig;
  series: RegExp;
  chapter: RegExp;
}

/** Installed site configs, and which one (if any) understands a given URL. */
export class SiteRegistry {
  private readonly configs = new Map<string, Compiled>();

  constructor(configs: SiteConfig[] = []) {
    for (const config of configs) this.add(config);
  }

  add(config: SiteConfig): void {
    this.configs.set(config.id, {
      config,
      series: globToRegExp(config.series.url),
      chapter: globToRegExp(config.chapter.url),
    });
  }

  remove(id: string): boolean {
    return this.configs.delete(id);
  }

  get(id: string): SiteConfig | undefined {
    return this.configs.get(id)?.config;
  }

  list(): SiteConfig[] {
    return [...this.configs.values()].map((c) => c.config);
  }

  match(url: string): PageMatch | undefined {
    let target: string;
    try {
      target = normalizeUrl(url);
    } catch {
      return undefined;
    }
    const all = [...this.configs.values()];
    // Chapter URLs usually sit under the series URL, so test the more specific pattern first.
    const chapter = all.find((c) => c.chapter.test(target));
    if (chapter) return { config: chapter.config, kind: 'chapter' };
    const series = all.find((c) => c.series.test(target));
    if (series) return { config: series.config, kind: 'series' };
    return undefined;
  }
}
