// Messages between the three places a Paperback source involves (Chrome only):
//
//   background (paperback.ts)  ⇄ port ⇄  offscreen host (paperback-host.ts)  ⇄ postMessage ⇄  sandbox (paperback-sandbox.ts)
//
// The sandbox runs the source's code with no extension APIs, one sandboxed frame per source. The
// host only relays, and tags what a frame sends with that frame's source, so a source can't speak
// for another. The background does the fetching and storage, deciding what each source may reach.
import type { PaperbackMethod, PbHttpRequest } from '@onidoku/core';

export const HOST_PORT = 'paperback-host';

/** A message before it's given an id (applied to each member of a union). */
export type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

/** Requests the background makes of a source's frame. */
export type SandboxCall =
  | { kind: 'load'; id: number; code: string; sourceId: string }
  | { kind: 'call'; id: number; method: PaperbackMethod; args: unknown[] };

/** Answers to the frame's own requests. */
export type SandboxReply = { kind: 'reply'; id: number; ok: true; value: unknown } | { kind: 'reply'; id: number; ok: false; error: string };

export type ToSandbox = SandboxCall | SandboxReply;

export type FromSandbox =
  | { kind: 'result'; id: number; ok: true; value: unknown }
  | { kind: 'result'; id: number; ok: false; error: string }
  | { kind: 'fetch'; id: number; request: PbHttpRequest }
  | { kind: 'state'; id: number; op: 'get' | 'set'; key: string; value?: unknown };

/** On the port, every message says which source's frame it's for or from. */
export type ToHost = (ToSandbox & { configId: string }) | { kind: 'drop'; configId: string };
export type FromHost = FromSandbox & { configId: string };

