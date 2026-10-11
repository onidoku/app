export const PAPERBACK_SOURCE_ID: string;
export function paperbackSourceCode(): string;
export function paperbackVersioning(origin: string): unknown;
export function handlePaperbackRepo(url: URL): { status: number; type: string; body: string; headers?: Record<string, string> } | undefined;
