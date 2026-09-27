/**
 * End-to-end proof that the wrapper can really compile firmware.
 *
 * Chain under test:  wrapper HTTP proxy -> FastAPI backend -> arduino-cli
 *
 * Skips (exit 0) when arduino-cli or the arduino:avr core is unavailable, so
 * it stays green on a machine that only runs the simulator.
 *
 * Run: node test/compile-e2e.mjs
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startAppServer } = require('../lib/server.cjs');
const { startBackend, stopBackend } = require('../lib/backend.cjs');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKEND_PORT = 18023;

const BLINK = [
  'void setup() {',
  '  pinMode(LED_BUILTIN, OUTPUT);',
  '  Serial.begin(9600);',
  '}',
  'void loop() {',
  '  digitalWrite(LED_BUILTIN, HIGH);',
  '  Serial.println("on");',
  '  delay(200);',
  '  digitalWrite(LED_BUILTIN, LOW);',
  '  delay(200);',
  '}',
  '',
].join('\n');

function post(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('compile request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

const logs = [];
const log = (m) => {
  logs.push(m);
  console.log(m);
};

async function main() {
  const backend = await startBackend({ repoRoot: REPO_ROOT, port: BACKEND_PORT, log: (m) => logs.push(m) });
  if (!backend.ok) {
    console.log('SKIP: backend did not start - ' + backend.reason);
    process.exit(0);
  }

  const server = await startAppServer({
    distDir: path.join(REPO_ROOT, 'frontend', 'dist'),
    backendBase: 'http://127.0.0.1:' + BACKEND_PORT,
    host: '127.0.0.1',
    port: 0,
  });
  log('wrapper ' + server.url + ' -> backend 127.0.0.1:' + BACKEND_PORT);

  let result;
  try {
    const res = await post(
      server.url + 'api/compile/',
      { files: [{ name: 'sketch.ino', content: BLINK }], board_fqbn: 'arduino:avr:uno' },
      240000,
    );
    result = JSON.parse(res.text);
    log('HTTP ' + res.status);
  } catch (err) {
    log('FAILED to call compile: ' + err.message);
    await server.close();
    stopBackend(backend.child);
    process.exit(1);
  }

  const hex = result.hex_content || '';
  const looksLikeHex = hex.startsWith(':') && /^:[0-9A-Fa-f]{10}/m.test(hex);

  log('success      = ' + result.success);
  log('error        = ' + JSON.stringify(result.error));
  log('hex bytes    = ' + hex.length);
  log('valid intel hex = ' + looksLikeHex);
  if (result.stderr) log('stderr tail  = ' + String(result.stderr).trim().split('\n').slice(-3).join(' | '));

  await server.close();
  stopBackend(backend.child);

  const backendLog = logs.join('\n');
  if (backendLog.includes('arduino-cli is installed and in PATH') || backendLog.includes('Could not verify cores')) {
    console.log('\nSKIP: arduino-cli / arduino:avr not available in this environment');
    process.exit(0);
  }

  if (result.success === true && looksLikeHex) {
    console.log('\nCOMPILE E2E PASSED - real .hex produced through the wrapper');
    process.exit(0);
  }
  console.log('\nCOMPILE E2E FAILED');
  process.exit(1);
}

main().catch((err) => {
  console.error('compile e2e crashed:', err);
  process.exit(2);
});
