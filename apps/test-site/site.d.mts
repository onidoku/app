import type { FakeResponse } from './media-servers.mjs';

export interface SiteRequest {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: string;
}
export function createSite(): { handle(url: URL, request?: SiteRequest): FakeResponse; reset(): void };
