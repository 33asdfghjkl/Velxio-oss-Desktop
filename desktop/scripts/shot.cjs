/**
 * Screenshots the wrapper's UI through headless Chrome over CDP.
 *
 * Used as a visual smoke test: boots nothing itself, expects Chrome already
 * listening on --remote-debugging-port. Node's built-in WebSocket keeps this
 * dependency-free.
 *
 * Usage: node scripts/shot.cjs <url> <outfile> [dismissText]
 */
const fs = require('node:fs');
const path = require('node:path');

const URL_ARG = process.argv[2] || 'http://127.0.0.1:18100/editor/';
const OUT = process.argv[3] || path.join(__dirname, '..', 'test', 'artifacts', 'shot.png');
const DISMISS = process.argv[4] || 'Got it';
const PORT = Number(process.env.CDP_PORT || 9222);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg.method);
    }
  };
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_ARG });

  // Wait for load, then a settle period for React + Monaco.
  for (let i = 0; i < 60 && !events.includes('Page.loadEventFired'); i++) await sleep(250);
  await sleep(7000);

  // Dismiss any announcement modal so the editor is unobstructed.
  const dismissed = await send('Runtime.evaluate', {
    expression:
      '(function(){var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return (x.textContent||"").trim()===' +
      JSON.stringify(DISMISS) +
      ';});if(b){b.click();return true}return false})()',
    returnByValue: true,
  });
  console.log('dismissed modal: ' + JSON.stringify(dismissed.result && dismissed.result.value));
  await sleep(1500);

  const title = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  const rootLen = await send('Runtime.evaluate', {
    expression: 'document.getElementById("root")?document.getElementById("root").innerHTML.length:-1',
    returnByValue: true,
  });
  console.log('title=' + JSON.stringify(title.result.value));
  console.log('#root length=' + rootLen.result.value);

  const shotRes = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shotRes.data, 'base64'));
  console.log('wrote ' + OUT + ' (' + fs.statSync(OUT).size + ' bytes)');
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('shot failed:', e);
  process.exit(1);
});
