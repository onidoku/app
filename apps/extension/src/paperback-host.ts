// The offscreen document that holds Paperback sources' sandboxed frames, one per source. A
// service worker can't have frames, so the background keeps this page open while sources run.
// It only relays: port messages from the background go to the source's frame, and what a frame
// sends goes back tagged with that frame's source.
import { HOST_PORT, type FromHost, type FromSandbox, type ToHost } from './paperback-protocol';

const frames = new Map<string, { frame: HTMLIFrameElement; ready: Promise<void> }>();
let port: chrome.runtime.Port | undefined;

function frameFor(configId: string) {
  let entry = frames.get(configId);
  if (!entry) {
    const frame = document.createElement('iframe');
    frame.src = 'paperback-sandbox.html';
    const ready = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
    document.body.append(frame);
    frames.set(configId, (entry = { frame, ready }));
  }
  return entry;
}

async function deliver(message: ToHost): Promise<void> {
  const { configId, ...rest } = message;
  if (rest.kind === 'drop') {
    frames.get(configId)?.frame.remove();
    frames.delete(configId);
    return;
  }
  const { frame, ready } = frameFor(configId);
  await ready;
  frame.contentWindow?.postMessage(rest, '*');
}

window.addEventListener('message', (event: MessageEvent<FromSandbox>) => {
  for (const [configId, { frame }] of frames) {
    if (event.source === frame.contentWindow) {
      port?.postMessage({ ...event.data, configId } satisfies FromHost);
      return;
    }
  }
});

// No reconnecting: that would wake an idle service worker forever. When the background needs
// sources again after a restart, it replaces this page with a fresh one.
port = chrome.runtime.connect({ name: HOST_PORT });
port.onMessage.addListener((message: ToHost) => void deliver(message));
port.onDisconnect.addListener(() => (port = undefined));
