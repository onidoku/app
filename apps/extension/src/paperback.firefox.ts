// Firefox builds have no Paperback sources (no offscreen documents, and AMO doesn't accept
// add-ons that run downloaded code), so they get this instead of paperback.ts (see "imports" in
// package.json). Same exports; nothing here touches APIs Firefox lacks.
import type { PaperbackRepo, PaperbackRuntime, SiteConfig } from '@onidoku/core';
import type { SiteSource } from './messages';
import { removePaperbackInstall } from './storage';

export const PAPERBACK_SUPPORTED = false;

const unsupported = () => new Error('Paperback sources work in Chrome and Edge only');

export function paperbackRuntime(_config: SiteConfig): PaperbackRuntime | undefined {
  return undefined;
}

export async function allowSourceImages(_config: SiteConfig, _urls: (string | undefined)[]): Promise<void> {}

export async function forgetSourceImages(_configId: string): Promise<void> {}

export async function fetchPaperbackRepo(_input: string): Promise<PaperbackRepo> {
  throw unsupported();
}

export async function installPaperback(_repoUrl: string, _sourceId: string): Promise<SiteConfig> {
  throw unsupported();
}

export async function removePaperback(configId: string): Promise<void> {
  await removePaperbackInstall(configId);
}

export async function fetchPaperbackImage(_url: string): Promise<{ type: string; base64?: string; text?: string }> {
  throw unsupported();
}

export async function retryPaperbackSections(_config: SiteConfig): Promise<void> {}

export async function paperbackSiteSource(_url: string): Promise<SiteSource | null> {
  return null;
}

export async function findPaperbackPage(_url: string, _titles: string[], _saved?: string[]): Promise<string> {
  throw unsupported();
}

export async function paperbackShareUrl(_config: SiteConfig, _url: string): Promise<string | undefined> {
  return undefined;
}
