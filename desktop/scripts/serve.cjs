/**
 * Runs the wrapper's local server WITHOUT Electron.
 *
 * Useful for debugging, for the smoke test, and for checking the UI in a
 * normal browser. In the packaged app this server is started by main.cjs.
 *
 * Run: node scripts/serve.cjs
 * Env: PORT (default 18100), VELXIO_BACKEND_PORT (default 18001)
 */
const path = require('node:path');
const { startAppServer } = require('../lib/server.cjs');
const { startBackend } = require('../lib/backend.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_PORT = Number(process.env.VELXIO_BACKEND_PORT || 18001);
const PORT = Number(process.env.PORT || 18100);

(async () => {
  const be = await startBackend({
    repoRoot: REPO_ROOT,
    port: BACKEND_PORT,
    log: (m) => console.log(m),
  });
  console.log('[serve] backend ok=' + be.ok + (be.reason ? ' reason=' + be.reason : ''));

  const server = await startAppServer({
    distDir: path.join(REPO_ROOT, 'frontend', 'dist'),
    backendBase: 'http://127.0.0.1:' + BACKEND_PORT,
    host: '127.0.0.1',
    port: PORT,
  });
  console.log('[serve] SERVING ' + server.url);

  const shutdown = () => {
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
