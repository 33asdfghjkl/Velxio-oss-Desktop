'use strict';
/**
 * Velxio OSS Desktop (Unofficial) - Electron main process.
 *
 * An unofficial community wrapper that packages the open-source Velxio web
 * frontend as an offline desktop application. It is NOT affiliated with the
 * Velxio project and ships no Pro keys or proprietary validation logic.
 *
 * How it fits together:
 *   1. Start the local Velxio FastAPI backend (best effort - the app still
 *      opens without it, because AVR and RP2040 emulation run in the page).
 *   2. Start a loopback HTTP server that serves frontend/dist and
 *      reverse-proxies /api + /health + WebSockets to that backend.
 *   3. Load that server in a BrowserWindow. One origin, no CORS changes.
 *
 * Original file - part of the unofficial community desktop wrapper.
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const { startAppServer } = require('./lib/server.cjs');
const { startBackend, stopBackend } = require('./lib/backend.cjs');

const APP_TITLE = 'Velxio OSS Desktop (Unofficial)';
const HOST = '127.0.0.1';
const DEFAULT_BACKEND_PORT = 8001;

/** Filled in during boot; torn down on quit. */
let state = {
  window: null,
  appServer: null,
  backendChild: null,
  backendOk: false,
  backendReason: '',
};

const log = (msg) => console.log('[' + new Date().toISOString() + '] ' + msg);

/**
 * Packaged builds put resources under process.resourcesPath; a dev run uses
 * the repository layout.
 */
function resolvePaths() {
  if (app.isPackaged) {
    const resources = process.resourcesPath;
    return {
      repoRoot: resources,
      distDir: path.join(resources, 'frontend-dist'),
      iconPath: path.join(resources, 'icon.png'),
    };
  }
  const repoRoot = path.resolve(__dirname, '..');
  return {
    repoRoot,
    distDir: path.join(repoRoot, 'frontend', 'dist'),
    iconPath: path.join(__dirname, 'build', 'icon.png'),
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, HOST, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function fatal(title, detail) {
  dialog.showErrorBox(title, detail);
  app.quit();
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => state.window && state.window.reload(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Backend status',
          click: () => {
            dialog.showMessageBox(state.window, {
              type: state.backendOk ? 'info' : 'warning',
              title: 'Local backend',
              message: state.backendOk
                ? 'The local Velxio backend is running.'
                : 'The local Velxio backend is not running.',
              detail: state.backendOk
                ? 'Compiling Arduino / MicroPython / ESP-IDF sketches is available.'
                : (state.backendReason || 'Unknown reason.') +
                  '\n\nEditing, .vlx projects and in-browser AVR / RP2040 ' +
                  'emulation still work. See the README "Backend" section.',
              buttons: ['OK'],
            });
          },
        },
        {
          label: 'About (unofficial)',
          click: () => {
            dialog.showMessageBox(state.window, {
              type: 'info',
              title: 'About',
              message: APP_TITLE,
              detail:
                'Unofficial community desktop wrapper for Velxio.\n' +
                'Built with Electron. Licensed AGPLv3.\n' +
                'Not affiliated with the Velxio project. Ships no Pro keys ' +
                'and no proprietary validation logic.\n\n' +
                'Velxio core copyright belongs to its original authors ' +
                '(AGPLv3).',
              buttons: ['OK'],
            });
          },
        },
        { type: 'separator' },
        {
          label: 'Velxio on GitHub',
          click: () => shell.openExternal('https://github.com/davidmonterocrespo24/velxio'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(url, iconPath) {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    title: APP_TITLE,
    backgroundColor: '#111111',
    autoHideMenuBar: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Keep the app a single window: navigation and popups go to the OS browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  win.loadURL(url);
  return win;
}

async function boot() {
  const { repoRoot, distDir, iconPath } = resolvePaths();

  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    fatal(
      'Frontend build not found',
      'Expected the built web app at:\n' + distDir + '\n\n' +
        'Build it first:\n' +
        '  cd frontend && npm install && npx vite build\n\n' +
        'See the README for the full setup.',
    );
    return;
  }

  buildMenu();

  // A free port keeps two instances from colliding.
  const backendPort = process.env.VELXIO_BACKEND_PORT
    ? Number(process.env.VELXIO_BACKEND_PORT)
    : DEFAULT_BACKEND_PORT;

  // 1. Loopback server and window FIRST.
  //
  // The backend must NOT be awaited before this point. A cold start with
  // arduino-cli on PATH syncs several package indexes before uvicorn binds,
  // which has been measured at ~48s and can be far longer; awaiting it here
  // left the user staring at nothing after a double-click. The proxy already
  // answers 502 while the backend is down, so the UI can open immediately and
  // the backend can catch up in the background.
  const appPort = await getFreePort();
  state.appServer = await startAppServer({
    distDir,
    backendBase: 'http://' + HOST + ':' + backendPort,
    host: HOST,
    port: appPort,
  });
  log('serving frontend at ' + state.appServer.url + ' (backend ' + HOST + ':' + backendPort + ')');

  state.window = createWindow(state.appServer.url, iconPath);

  // 2. Backend, in the background (best effort).
  if (process.argv.includes('--no-backend')) {
    state.backendReason = 'disabled with --no-backend';
    log('backend disabled with --no-backend');
  } else {
    startBackend({ repoRoot, port: backendPort, log })
      .then((result) => {
        state.backendOk = result.ok;
        state.backendChild = result.child;
        state.backendReason = result.reason || '';
        log(result.ok ? 'backend ready' : 'backend unavailable: ' + state.backendReason);
      })
      .catch((err) => {
        state.backendReason = String((err && err.message) || err);
        log('backend failed: ' + state.backendReason);
      });
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (state.window) {
      if (state.window.isMinimized()) state.window.restore();
      state.window.focus();
    }
  });

  app.whenReady().then(boot).catch((err) => {
    fatal('Failed to start', String((err && err.stack) || err));
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });

  app.on('before-quit', () => {
    stopBackend(state.backendChild);
    if (state.appServer) state.appServer.close().catch(() => {});
  });
}
