/**
 * Visual smoke test: boots the wrapper headlessly, screenshots the app, quits.
 *
 * Proves the shell actually renders the Velxio editor, not just that the HTTP
 * layer works. Run: npx electron scripts/capture.cjs [outfile]
 *
 * NOTE: the log goes to BOTH stdout and a file, because app.exit() can drop
 * buffered pipe output on Windows.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { startAppServer } = require('../lib/server.cjs');
const { startBackend } = require('../lib/backend.cjs');

const OUT = process.argv[2] || path.join(__dirname, '..', 'test', 'artifacts', 'app.png');
const LOG = path.join(path.dirname(OUT), 'capture.log');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO_ROOT, 'frontend', 'dist');
const BACKEND_PORT = 18001;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(LOG, '');

const log = (m) => {
  const line = '[capture] ' + m;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* ignore */ }
};

// A wrapper rather than a top-level window keeps the app alive deterministically.
app.on('window-all-closed', () => {
  log('window-all-closed (ignored)');
});
process.on('uncaughtException', (e) => {
  log('UNCAUGHT ' + (e && e.stack ? e.stack : String(e)));
  process.exitCode = 1;
});
process.on('unhandledRejection', (e) => {
  log('UNHANDLED ' + (e && e.stack ? e.stack : String(e)));
});

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    log('electron=' + process.versions.electron + ' chrome=' + process.versions.chrome);
    const be = await startBackend({ repoRoot: REPO_ROOT, port: BACKEND_PORT, log: () => {} });
    log('backend ok=' + be.ok + (be.reason ? ' reason=' + be.reason : ''));

    const server = await startAppServer({
      distDir: DIST,
      backendBase: 'http://127.0.0.1:' + BACKEND_PORT,
      host: '127.0.0.1',
      port: 0,
    });
    log('serving ' + server.url);

    const win = new BrowserWindow({
      width: 1600,
      height: 1000,
      show: false,
      backgroundColor: '#111111',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) errors.push(message);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => log('DID FAIL LOAD ' + code + ' ' + desc));
    win.webContents.on('render-process-gone', (_e, d) => log('RENDER GONE ' + JSON.stringify(d)));
    win.webContents.on('preload-error', (_e, p, err) => log('PRELOAD ERROR ' + p + ' ' + err));

    await win.loadURL(server.url);
    log('loaded title=' + JSON.stringify(win.getTitle()));

    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      log('tick ' + (i + 1) + ' destroyed=' + win.isDestroyed());
      if (win.isDestroyed()) break;
    }

    if (win.isDestroyed()) {
      log('window destroyed before capture');
      app.exit(1);
      return;
    }

    const url = win.webContents.getURL();
    const rootLen = await win.webContents.executeJavaScript(
      'document.getElementById("root") ? document.getElementById("root").innerHTML.length : -1',
    );
    const canvasCount = await win.webContents.executeJavaScript(
      'document.querySelectorAll("canvas").length',
    );
    log('url=' + url);
    log('#root innerHTML length=' + rootLen + ' canvases=' + canvasCount);
    log('console errors/warnings=' + errors.length);
    errors.slice(0, 10).forEach((e) => log('  ! ' + String(e).slice(0, 200)));

    const image = await win.webContents.capturePage();
    fs.writeFileSync(OUT, image.toPNG());
    log('screenshot -> ' + OUT + ' (' + fs.statSync(OUT).size + ' bytes)');

    await server.close();
    log('DONE');
    app.quit();
  } catch (err) {
    log('FAILED ' + (err && err.stack ? err.stack : String(err)));
    app.exit(1);
  }
});
