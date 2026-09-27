'use strict';
/**
 * Velxio OSS Desktop - local Python backend supervisor.
 *
 * The desktop app is a wrapper around the open-source Velxio stack. Compiling
 * Arduino / MicroPython / ESP-IDF code needs the Velxio FastAPI backend, so we
 * look for a usable Python interpreter, start uvicorn on a loopback port, and
 * wait for /health before pointing the UI at it.
 *
 * If no interpreter is found the app still opens (editor + in-browser AVR and
 * RP2040 emulation work offline) and the UI says the backend is unavailable.
 *
 * Original file - part of the unofficial community desktop wrapper.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

function candidates(repoRoot) {
  const venv = path.join(repoRoot, 'backend', 'venv');
  const list = [];
  if (process.platform === 'win32') {
    list.push(path.join(venv, 'Scripts', 'python.exe'));
  } else {
    list.push(path.join(venv, 'bin', 'python3'), path.join(venv, 'bin', 'python'));
  }
  list.push(process.platform === 'win32' ? 'python.exe' : 'python3');
  list.push('python');
  return list;
}

function firstExisting(list) {
  for (const c of list) {
    if (c.includes(path.sep) || c.includes('/')) {
      if (fs.existsSync(c)) return c;
    } else {
      return c; // bare command name: let the OS resolve it
    }
  }
  return null;
}

/**
 * Repo-local tool directories to prepend to PATH for the backend.
 *
 * A portable arduino-cli dropped in .tools/arduino-cli lets the wrapper
 * compile sketches with no system-wide install and no elevation prompt.
 * (winget's MSI needs UAC; the portable zip does not.)
 */
function toolDirs(repoRoot) {
  return [path.join(repoRoot, '.tools', 'arduino-cli'), path.join(repoRoot, '.tools')].filter(
    (d) => fs.existsSync(d),
  );
}

function probeHealth(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{repoRoot: string, port: number, log: (m: string) => void}} opts
 * @returns {Promise<{ok: boolean, child: any, reason?: string}>}
 */
async function startBackend(opts) {
  const { repoRoot, port, log } = opts;
  const backendDir = path.join(repoRoot, 'backend');
  if (!fs.existsSync(path.join(backendDir, 'app', 'main.py'))) {
    return { ok: false, child: null, reason: 'backend/app/main.py not found' };
  }

  const python = firstExisting(candidates(repoRoot));
  if (!python) return { ok: false, child: null, reason: 'no python interpreter found' };

  log('starting backend: ' + python + ' -m uvicorn app.main:app --port ' + port);

  const extra = toolDirs(repoRoot);
  const env = Object.assign({}, process.env);

  // Defer the backend's startup board-index refresh. It is a network
  // round-trip that otherwise blocks the backend for 44s-150s before it can
  // answer anything (measured), which looks like a broken install. The
  // backend re-runs the same pass on demand, the first time a board needs a
  // core that is not installed, so only the wait moves - nothing is lost.
  // See backend/app/services/arduino_cli.py.
  if (!env.VELXIO_SKIP_STARTUP_INDEX) env.VELXIO_SKIP_STARTUP_INDEX = '1';
  if (extra.length) {
    const joined = extra.join(path.delimiter);
    env.PATH = joined + path.delimiter + (env.PATH || '');
    env.Path = env.PATH; // Windows stores this one under a different casing
    log('prepended to PATH: ' + joined);
  }

  let child;
  try {
    child = spawn(
      python,
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port)],
      { cwd: backendDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env },
    );
  } catch (err) {
    return { ok: false, child: null, reason: 'spawn failed: ' + err.message };
  }

  let stderr = '';
  child.stdout.on('data', (d) => log('[backend] ' + String(d).trim()));
  child.stderr.on('data', (d) => {
    const s = String(d).trim();
    stderr += s + '\n';
    log('[backend] ' + s);
  });
  child.on('error', (err) => log('[backend] process error: ' + err.message));

  // Cold start can be slow: with arduino-cli on PATH the backend syncs
  // several package indexes (core update-index) before it binds, which has
  // been measured in minutes on a fresh machine. Allow for that, and let an
  // operator shorten it with VELXIO_BACKEND_TIMEOUT_MS.
  const timeoutMs = Number(process.env.VELXIO_BACKEND_TIMEOUT_MS || 240000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return {
        ok: false,
        child: null,
        reason: 'backend exited with code ' + child.exitCode + (stderr ? ': ' + stderr.slice(-400) : ''),
      };
    }
    if (await probeHealth(port, 1500)) return { ok: true, child };
    await sleep(500);
  }
  return {
    ok: false,
    child,
    reason: 'backend did not answer /health within ' + Math.round(timeoutMs / 1000) + 's',
  };
}

function stopBackend(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* best effort */ }
}

module.exports = { startBackend, stopBackend };
