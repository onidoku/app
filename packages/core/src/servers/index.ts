import { KavitaServer } from './kavita';
import { KomgaServer } from './komga';
import type { MediaServer, ServerConfig, ServerIO } from './server';

export * from './server';
export * from './parts';
export { KavitaServer } from './kavita';
export { KomgaServer } from './komga';

export function connectServer(server: ServerConfig, io: ServerIO): MediaServer {
  return server.kind === 'komga' ? new KomgaServer(server, io) : new KavitaServer(server, io);
}
