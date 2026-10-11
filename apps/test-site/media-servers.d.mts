export interface FakeRequest {
  method: string;
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
export interface FakeResponse {
  status: number;
  type: string;
  body: string;
  headers?: Record<string, string>;
}
export interface FakeServer {
  handle(request: FakeRequest): FakeResponse;
  progress: Record<string, unknown>[];
}
export const KOMGA_API_KEY: string;
export const KOMGA_USER: { username: string; password: string };
export const KAVITA_API_KEY: string;
export function createKomga(base: string): FakeServer & { addBook(seriesId?: string): void };
export function createKavita(base: string): FakeServer & { addChapter(seriesId?: number): void; TOKEN: string };
