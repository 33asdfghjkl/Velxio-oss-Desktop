'use strict';
/**
 * Velxio OSS Desktop - local application server.
 *
 * Serves the built web frontend and reverse-proxies the Velxio backend so the
 * SPA sees ONE origin (exactly the nginx setup the OSS Docker image uses).
 * Same-origin means no CORS changes are needed in the upstream backend and the
 * QEMU-board WebSockets upgrade through this same port.
 *
 * Original file - part of the unofficial community desktop wrapper.
 */

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.hex': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Paths proxied to the Python backend (not served from dist). */
function isBackendPath(pathname) {
  return pathname.startsWith('/api/') || pathname === '/api' || pathname === '/health';
}

function readIndexHtml(distDir) {
  return fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
}

/**
 * Inject the desktop bootstrap BEFORE any module script runs.
 *
 * Module scripts are deferred, so an inline classic script placed before
 * </head> always executes first - no race with the bundle's first
 * getApiBase() call. This is why the wrapper needs no upstream frontend
 * change to point the app at its local backend.
 */
function injectBootstrap(html, apiBase) {
  const boot =
    '<script>window.__VELXIO_API_BASE__=' + JSON.stringify(apiBase) + ';' +
    'window.__VELXIO_OSS_DESKTOP__=true;</' + 'script>';
  // Right after <head> is the earliest slot in the document, so the globals are
  // set before the bundle runs no matter how it is loaded (module, defer, async).
  const headOpen = html.match(/<head[^>]*>/i);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + boot + html.slice(at);
  }
  return boot + html;
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Body returned when the proxy cannot reach the backend.
 *
 * "Not reachable" was misleading: on a first launch the backend IS coming up,
 * it just needs ~50s to sync its board package indexes before it binds.
 * Reporting that as a hard failure sent users hunting for a broken install.
 */
function backendUnavailableBody(err, backendStatus) {
  const s = (typeof backendStatus === 'function' ? backendStatus() : null) || {};
  const detail = String((err && err.message) || err);
  if (s.phase === 'starting') {
    const secs = Math.round((s.elapsedMs || 0) / 1000);
    return {
      detail:
        'The local Velxio backend is still starting (' + secs + 's so far). ' +
        'On a first run it syncs its board package indexes before it can serve ' +
        'requests, which takes about a minute. Wait for it to finish, then compile again.',
      backend: 'starting',
      error: detail,
    };
  }
  if (s.phase === 'failed') {
    return {
      detail:
        'The local Velxio backend is not running: ' + (s.reason || 'unknown reason') + '. ' +
        'Editing and the in-browser AVR / RP2040 simulation still work; compiling needs it.',
      backend: 'failed',
      error: detail,
    };
  }
  return {
    detail:
      'Velxio backend is not reachable. The desktop app runs it locally; ' +
      'see the README "Backend" section.',
    backend: s.phase || 'unknown',
    error: detail,
  };
}

function proxyHttp(req, res, backendBase, backendStatus) {
  let target;
  try {
    target = new URL(backendBase + req.url);
  } catch (err) {
    return sendJson(res, 502, { detail: 'bad backend url', error: String(err) });
  }

  const headers = Object.assign({}, req.headers, { host: target.host });
  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: target.pathname + target.search,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    if (res.headersSent) return res.destroy();
    sendJson(res, 502, backendUnavailableBody(err, backendStatus));
  });

  req.pipe(upstream);
}

function proxyUpgrade(req, socket, head, backendBase, track) {
  if (track) track(socket);
  let target;
  try {
    target = new URL(backendBase);
  } catch {
    return socket.destroy();
  }
  const upstream = net.connect(
    Number(target.port || 80),
    target.hostname,
    () => {
      if (track) track(upstream);
      const headerLines = [
        req.method + ' ' + req.url + ' HTTP/1.1',
      ];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headerLines.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1]);
      }
      upstream.write(headerLines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    },
  );
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

/**
 * @param {{distDir: string, backendBase: string, host: string, port: number}} opts
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
function startAppServer(opts) {
  const { distDir, backendBase, host, port, backendStatus } = opts;
  const indexTemplate = readIndexHtml(distDir);
  // opts.port may be 0 ("pick any free port"), so the bootstrap cannot be
  // built until the socket is actually bound - otherwise the injected API
  // base would advertise port 0.
  let indexHtml = '';

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      // Collapse a leading '//': new URL('//assets/x.js') parses 'assets' as a
      // HOST, which would silently turn every asset request into a 404.
      const raw = (req.url || '/').replace(/^\/{2,}/, '/');
      pathname = decodeURIComponent(new URL(raw, 'http://localhost').pathname);
    } catch {
      return sendJson(res, 400, { detail: 'bad request url' });
    }

    if (isBackendPath(pathname)) return proxyHttp(req, res, backendBase, backendStatus);

    // Resolve inside distDir only - reject traversal.
    const rel = pathname.replace(/^\/+/, '');
    const filePath = path.resolve(distDir, rel);
    const inside = filePath === distDir || filePath.startsWith(distDir + path.sep);
    if (!inside) return sendJson(res, 403, { detail: 'forbidden' });

    fs.stat(filePath, (err, stat) => {
      if (!err && stat.isFile()) {
        res.writeHead(200, {
          'content-type': mimeFor(filePath),
          'content-length': String(stat.size),
          'cache-control': pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        });
        return fs.createReadStream(filePath).pipe(res);
      }
      // SPA fallback: every unknown path renders the app shell.
      const payload = Buffer.from(indexHtml, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(payload.length),
        'cache-control': 'no-cache',
      });
      res.end(payload);
    });
  });

  // Upgraded (WebSocket) sockets live outside the HTTP request lifecycle, so
  // server.close() would wait on them forever. Track them to close cleanly.
  const upgradeSockets = new Set();
  const track = (s) => {
    upgradeSockets.add(s);
    s.once('close', () => upgradeSockets.delete(s));
  };

  server.on('upgrade', (req, socket, head) => {
    if (isBackendPath(req.url ? req.url.split('?')[0] : '')) {
      return proxyUpgrade(req, socket, head, backendBase, track);
    }
    socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      indexHtml = injectBootstrap(indexTemplate, 'http://' + host + ':' + actualPort + '/api');
      resolve({
        url: 'http://' + host + ':' + actualPort + '/',
        port: actualPort,
        close: () =>
          new Promise((done) => {
            for (const s of upgradeSockets) {
              // Guard: destroying an already-closing handle trips a libuv
              // assertion on Windows and turns a clean exit into a crash.
              try { if (!s.destroyed) s.destroy(); } catch { /* best effort */ }
            }
            upgradeSockets.clear();
            server.close(() => done());
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
          }),
      });
    });
  });
}

module.exports = { startAppServer, injectBootstrap, isBackendPath, backendUnavailableBody };
