import { readFileSync } from 'node:fs';
import { DOMParser } from 'linkedom';
import mangaRaw from '../../../configs/testsite.manga.json';
import novelRaw from '../../../configs/testsite.novel.json';
import { parseSiteConfig } from '../src';

export const BASE = 'http://localhost:4173';
export const mangaConfig = parseSiteConfig(mangaRaw);
export const novelConfig = parseSiteConfig(novelRaw);

export function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html') as unknown as Document;
}

export function fixture(name: string): Document {
  return parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}
