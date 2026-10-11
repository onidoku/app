// Runs one Paperback source's code. This page is listed under "sandbox" in the manifest: it has
// a unique origin, no extension APIs and no network access of its own (see its CSP), so all the
// source can do is ask the page that embeds it to fetch or store something for it.
import { PaperbackInstance, type PaperbackBridge } from '@onidoku/core';
import type { FromSandbox, ToSandbox, WithoutId } from './paperback-protocol';

let instance: PaperbackInstance | undefined;
let nextId = 1;
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

function post(message: FromSandbox): void {
  window.parent.postMessage(message, '*');
}

function ask(message: WithoutId<Extract<FromSandbox, { kind: 'fetch' | 'state' }>>): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    post({ ...message, id } as FromSandbox);
  });
}

const bridge: PaperbackBridge = {
  userAgent: navigator.userAgent,
  fetch: (request) => ask({ kind: 'fetch', request }) as ReturnType<PaperbackBridge['fetch']>,
  getState: (key) => ask({ kind: 'state', op: 'get', key }),
  setState: async (key, value) => void (await ask({ kind: 'state', op: 'set', key, value })),
};

/** Results cross to the extension as JSON: functions, class instances and proxies don't survive cloning. */
function plain(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function run(message: Extract<ToSandbox, { kind: 'load' | 'call' }>): Promise<unknown> {
  if (message.kind === 'load') {
    instance = PaperbackInstance.load(message.code, message.sourceId, bridge);
    return true;
  }
  if (!instance) throw new Error('the source isn’t loaded');
  return plain(await instance.call(message.method, message.args));
}

window.addEventListener('message', (event: MessageEvent<ToSandbox>) => {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (message?.kind === 'reply') {
    const entry = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.ok) entry?.resolve(message.value);
    else entry?.reject(new Error(message.error));
    return;
  }
  if (message?.kind !== 'load' && message?.kind !== 'call') return;
  run(message).then(
    (value) => post({ kind: 'result', id: message.id, ok: true, value }),
    (err) => post({ kind: 'result', id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
});
