import { createServer } from 'vite';
import { once } from 'node:events';
import { createApp, createRuntimeService } from '../server.mjs';
import { pathToFileURL } from 'node:url';
import { localAccessError } from '../server/local-access.mjs';

export async function startDevelopment({ service, port = 3000 } = {}) {
  const ownsService = !service;
  service ||= await createRuntimeService();
  const backend = createApp({ service });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const target = `http://127.0.0.1:${backend.address().port}`;
  const proxy = {
    target,
    // Preserve the validated browser Host/Origin for CSRF checks and QR links.
    changeOrigin: false,
  };
  let frontend;
  try {
    frontend = await createServer({
      plugins: [
        {
          name: 'localhost-only',
          configureServer(server) {
            server.middlewares.use((req, res, next) => {
              const accessError = localAccessError(req);
              if (accessError) {
                res.writeHead(403);
                res.end(accessError);
                return;
              }
              next();
            });
          },
        },
      ],
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true,
        cors: false,
        proxy: { '/api': proxy },
      },
    });
    await frontend.listen();
  } catch (error) {
    await frontend?.close();
    backend.close();
    throw error;
  }
  return {
    frontend,
    async close() {
      await frontend.close();
      backend.closeAllConnections();
      await new Promise((resolve) => backend.close(resolve));
      if (ownsService) await service.application?.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startDevelopment();
  console.log('DigitalArch development · http://localhost:3000 · React HMR + backend watch');
  async function shutdown() {
    await app.close();
    process.exit(0);
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
