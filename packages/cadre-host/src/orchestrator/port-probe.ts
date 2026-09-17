import { createServer } from 'node:net';

/** One TCP port a child binds, on the address it binds it to. */
export interface PortBinding {
  port: number;
  host: string;
}

/**
 * Resolve when `binding` can be bound right now; reject, naming the port and the
 * OS error code, when it cannot. Binds briefly and closes again at once.
 *
 * Any bind error counts as "unavailable", not just `EADDRINUSE`: on Windows a
 * port held with `SO_EXCLUSIVEADDRUSE` (which libuv sets on every TCP bind) can
 * answer `EACCES` instead, and a child launched onto a port that fails either way
 * would die on it.
 */
export function assertPortFree(binding: PortBinding): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(
        `port ${binding.port} on ${binding.host} is unavailable (${err.code ?? err.message})`,
        { cause: err },
      ));
    });
    server.listen({ port: binding.port, host: binding.host }, () => {
      server.close(() => resolve());
    });
  });
}
