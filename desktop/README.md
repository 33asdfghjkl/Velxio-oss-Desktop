# Velxio OSS Desktop (Unofficial)

An **unofficial community desktop wrapper** that packages the open-source
[Velxio](https://github.com/davidmonterocrespo24/velxio) web frontend as an
offline desktop application, using **Electron**.

> **Not affiliated with the Velxio project.** No Pro keys, no proprietary
> validation logic, no Velxio logo or trademark. AGPLv3. See `../NOTICE` and
> `../DISCLAIMER.md`.

## What this directory contains

```
desktop/
├── main.cjs                     Electron main process: boot, window, menu
├── preload.cjs                  Minimal, contextIsolation-safe preload
├── lib/
│   ├── server.cjs               Static server + /api & WebSocket reverse proxy
│   └── backend.cjs              Local Python backend supervisor
├── scripts/generate-icon.mjs    Original icon generator (dependency-free PNG)
├── build/icon.png               Generated icon (not a Velxio trademark)
└── package.json                 Electron app manifest + electron-builder config
```

## Why Electron and not Tauri

The upstream project ships a Tauri desktop shell, but that shell lives in the
**private pro overlay** and is built around a licence gate. This wrapper is
deliberately independent of it:

- Tauri on Windows needs the Rust toolchain **and** the MSVC C++ build tools
  (multi-GB). Electron needs only Node, so the wrapper builds and runs anywhere
  the web app does.
- Electron keeps this project free of the pro overlay's licence machinery, which
  is a hard requirement for an unofficial OSS wrapper.

## How it works

1. **Backend (best effort).** `lib/backend.cjs` finds `backend/venv` or a
   system `python`, runs
   `uvicorn app.main:app --host 127.0.0.1 --port 8001`, and waits for
   `/health`. If that fails, the app still opens.
2. **One origin.** `lib/server.cjs` serves `frontend/dist` on a random loopback
   port and reverse-proxies `/api`, `/health` and WebSocket upgrades to the
   backend — the same shape as the OSS nginx image. Because everything is
   same-origin, the upstream backend's CORS list needs **no** changes, and QEMU
   board WebSockets work.
3. **Bootstrap injection.** The server rewrites `index.html` to set
   `window.__VELXIO_API_BASE__` *before* any module script runs. That is the
   hook `frontend/src/lib/apiBase.ts` already documents for desktop hosts, so
   **no upstream frontend file is modified**.
4. **Window.** A sandboxed `BrowserWindow` (`contextIsolation: true`,
   `nodeIntegration: false`, `sandbox: true`) loads the local URL. External
   links open in the system browser.

## Requirements

| Piece | Needed for | Notes |
| --- | --- | --- |
| Node.js 20+ | building the frontend, running the wrapper | required |
| A built `frontend/dist` | the UI itself | `cd frontend && npm install && npx vite build` |
| Python 3.10+ and `backend/requirements.txt` | compiling code | optional; simulator still runs without it |
| `arduino-cli` + `arduino:avr` core on PATH | compiling Arduino sketches | optional |

## Commands

```bash
npm install            # install Electron
npm run gen:icon       # regenerate build/icon.png and build/icon.ico
npm start              # run the desktop app
npm start -- --no-backend   # skip auto-starting the Python backend
npm run dist           # package installers into desktop/release/ (see below)
```

Useful environment variables:

- `VELXIO_BACKEND_PORT` — backend port (default `8001`).
- `VELXIO_BACKEND_TIMEOUT_MS` — how long to wait for `/health` before
  giving up (default `240000`). The first start with `arduino-cli` on PATH
  can take minutes: the backend syncs several package indexes
  (`core update-index`) before it binds.

### Troubleshooting

**The window never appears when run from an Electron-based host.** Some
environments export `ELECTRON_RUN_AS_NODE=1`, which makes Electron behave as
plain Node, so `require('electron').app` is undefined and the app exits
immediately. Clear it first:

```powershell
$env:ELECTRON_RUN_AS_NODE=''; npx electron .
```

**The backend is slow on first run.** See `VELXIO_BACKEND_TIMEOUT_MS`
above. Pre-warm once with `arduino-cli core update-index`.

### Installing on Windows

`npm run dist` produces a normal electron-builder output, but on a machine
with **Smart App Control** (or any WDAC application-control policy) enabled,
that `.exe` is refused outright:

```
An Application Control policy has blocked this file.
```

electron-builder renames and rewrites Electron's executable, which changes
its hash and removes the reputation the policy relies on. The Electron binary
that `npm install` downloads is untouched, so policy allows *that* one.

`scripts/install-windows.ps1` installs the untouched binary and loads the app
from a normal directory instead (Electron's "run an app directory" mode):

```powershell
powershell -ExecutionPolicy Bypass -File desktop\scripts\install-windows.ps1
# custom destination:
powershell -ExecutionPolicy Bypass -File desktop\scripts\install-windows.ps1 -Destination 'D:\Apps\Velxio'
```

It lays out `electron.exe`, `desktop/`, `frontend/dist/`, `backend/` (including
its venv) and `.tools/arduino-cli/`, then creates a desktop shortcut whose
target is `electron.exe "<install>\desktop"`. In that mode
`app.isPackaged === false`, which is the layout this wrapper already supports,
so no extra build step is needed.

The window appears in about a second: the HTTP server and window are created
*before* the backend is spawned, and the backend catches up in the background
(the proxy answers 502 until it does).

## Known limitations

- **The Python backend is not bundled.** Only its source is. The wrapper starts
  it when a suitable interpreter is present; otherwise the UI runs in
  frontend-only mode (editor, `.vlx` projects, in-browser AVR / RP2040
  emulation).
- **QEMU-backed boards** (ESP32 family, STM32, Raspberry Pi Linux) need the QEMU
  libraries that the OSS project intentionally does not ship.
- **Nothing is code-signed.** macOS Gatekeeper will warn, and on Windows a
  machine with Smart App Control enabled refuses the electron-builder output
  outright — use `scripts/install-windows.ps1` (see above). Doing this
  properly needs a CA-issued code-signing certificate.

## License

AGPLv3 — see `../LICENSE`. Velxio core © David Montero Crespo and
contributors. This wrapper is a derivative work and is licensed the same way.
