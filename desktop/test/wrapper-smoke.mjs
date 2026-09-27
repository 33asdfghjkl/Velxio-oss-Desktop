/**
 * Wrapper smoke test - verifies the local server WITHOUT Electron.
 *
 * Checks, against the real built frontend in frontend/dist:
 *   1. the app shell is served and the desktop bootstrap is injected BEFORE
 *      the module bundle (the whole reason no upstream file needs changing);
 *   2. hashed assets are served with the right content type;
 *   3. unknown SPA routes fall back to index.html;
 *   4. /api is reverse-proxied to the backend, including when it is down;
 *   5. a WebSocket upgrade is proxied end to end.
 *
 * Deliberately avoids global fetch(): undici's keep-alive pool keeps handles
 * alive past teardown and trips a libuv assertion on Windows. Plain
 * http.request with agent:false exits cleanly.
 *
 * Run: node test/wrapper-smoke.mjs
 */
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startAppServer } = require('../lib/server.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', '..', 'frontend', 'dist');

let failures = 0;
function check(name, condition, extra = '') {
  if (condition) {
    console.log('  PASS  ' + name);
  } else {
    failures++;
    console.log('  FAIL  ' + name + (extra ? ' - ' + extra : ''));
  }
}

/** Minimal GET with no connection pooling. */
function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Close a server, but never let a lingering socket hang the suite. */
function closeWithTimeout(srv, ms = 2000) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    srv.close(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function main() {
  // A fake backend that answers /health and echoes /api/echo.
  const backend = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"status":"ok"}');
    }
    if (req.url.startsWith('/api/echo')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ proxied: true, url: req.url }));
    }
    res.writeHead(404);
    res.end('nope');
  });

  // Minimal WebSocket-ish upgrade echo. Upgraded sockets leave the server's
  // connection tracking, so they must be tracked here or backend.close()
  // waits on them forever.
  const backendUpgrades = new Set();
  backend.on('upgrade', (req, socket) => {
    backendUpgrades.add(socket);
    socket.once('close', () => backendUpgrades.delete(socket));
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: dummy\r\n\r\n',
    );
    socket.write('hello-from-backend');
  });

  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const backendPort = backend.address().port;

  const server = await startAppServer({
    distDir: DIST,
    backendBase: 'http://127.0.0.1:' + backendPort,
    host: '127.0.0.1',
    port: 0,
  });
  const base = server.url;
  console.log('server: ' + base + '  backend: 127.0.0.1:' + backendPort + '\n');

  // 1. shell + bootstrap injection
  const indexRes = await get(base);
  const html = indexRes.text;
  check('GET / returns 200', indexRes.status === 200);
  check('bootstrap global injected', html.includes('window.__VELXIO_API_BASE__'));
  check(
    'injected API base points at wrapper port',
    html.includes('http://127.0.0.1:' + server.port + '/api'),
  );
  const injectedAt = html.indexOf('window.__VELXIO_API_BASE__');
  const moduleAt = html.search(/<script[^>]+type="module"/);
  check(
    'bootstrap runs before the module bundle',
    moduleAt === -1 || injectedAt < moduleAt,
    'injected=' + injectedAt + ' module=' + moduleAt,
  );

  // 2. static asset
  const assetMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
  if (assetMatch) {
    const assetRes = await get(new URL(assetMatch[1], base).toString());
    check(
      'hashed asset served as javascript',
      assetRes.status === 200 &&
        String(assetRes.headers['content-type']).includes('javascript'),
      'status=' + assetRes.status + ' ct=' + assetRes.headers['content-type'],
    );
  } else {
    check('hashed asset discoverable', false, 'no /assets/*.js in index.html');
  }

  // 3. SPA fallback
  const spaRes = await get(base + 'editor/');
  check(
    'SPA route falls back to the shell',
    spaRes.status === 200 && spaRes.text.includes('<div id="root"'),
  );

  // 4. API reverse proxy (backend up)
  const echoRes = await get(base + 'api/echo?x=1');
  const echoBody = JSON.parse(echoRes.text);
  check(
    'GET path proxied to backend',
    echoRes.status === 200 && echoBody.proxied === true && echoBody.url === '/api/echo?x=1',
  );

  // 5. path traversal blocked
  const travRes = await get(base + 'assets/..%2f..%2fpackage.json');
  check('path traversal does not escape dist', travRes.status === 403 || travRes.status === 404);

  // 6. WebSocket upgrade, probed with a raw socket so no HTTP-client
  //    normalisation can mask a broken proxy.
  const wsResult = await new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      if (!sock.destroyed) sock.destroy();
      done({ ok: false, data: 'timeout, got: ' + JSON.stringify(buf.slice(0, 80)) });
    }, 5000);
    const sock = net.connect(server.port, '127.0.0.1', () => {
      sock.write(
        'GET /api/simulation/ws/test HTTP/1.1\r\n' +
          'Host: 127.0.0.1:' + server.port + '\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('hello-from-backend')) {
        if (!sock.destroyed) sock.destroy();
        done({ ok: true, data: 'upgraded, backend payload received' });
      }
    });
    sock.on('error', (e) => done({ ok: false, data: String(e.message) }));
  });
  check('WebSocket upgrade proxied', wsResult.ok === true, JSON.stringify(wsResult));

  // 7. backend down -> clean 502 JSON, not a hang
  for (const s of backendUpgrades) {
    try { if (!s.destroyed) s.destroy(); } catch { /* ignore */ }
  }
  backendUpgrades.clear();
  backend.closeAllConnections?.();
  await closeWithTimeout(backend);
  const downRes = await get(base + 'api/echo');
  let downBody = null;
  try { downBody = JSON.parse(downRes.text); } catch { /* not json */ }
  check(
    'backend down yields 502 JSON',
    downRes.status === 502 && downBody && typeof downBody.detail === 'string',
    'status=' + downRes.status,
  );

  // 8. The 502 used to say "not reachable" even while the backend was still
  //    warming up (~50s on a first launch), which sent users hunting for a
  //    broken install. It must report the real phase instead.
  const warming = await startAppServer({
    distDir: DIST,
    backendBase: 'http://127.0.0.1:1', // nothing is listening there
    host: '127.0.0.1',
    port: 0,
    backendStatus: () => ({ phase: 'starting', elapsedMs: 12000 }),
  });
  const warmRes = await get(warming.url + 'api/echo');
  let warmBody = null;
  try { warmBody = JSON.parse(warmRes.text); } catch { /* not json */ }
  check(
    '502 during warm-up reports "still starting" rather than "not reachable"',
    warmRes.status === 502 &&
      warmBody &&
      warmBody.backend === 'starting' &&
      /still starting \(12s/.test(String(warmBody.detail)),
    JSON.stringify(warmBody).slice(0, 200),
  );
  await warming.close();

  await server.close();
  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exitCode = 2;
});
