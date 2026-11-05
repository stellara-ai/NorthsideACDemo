// Preview debugging plugin - DEV SERVER ONLY (apply: 'serve'; never part of a
// production build). Captures browser console output, page errors, and
// failed/slow network calls from EVERY device that opens the preview URL -
// including the user's phone - and appends them as JSONL to
// /workspace/.logs/preview-debug.jsonl, where the assistant reads them with
// read_preview_console / read_preview_network. The user never has to open
// devtools or copy anything.
//
// Every string field is scrubbed of `__preview_session=<token>` BEFORE it is
// buffered: that parameter is a live app-session credential the screenshot tool
// appends to the preview URL, and the capture runs before the app can strip it
// from the address bar. It must never reach the log file, the model, or the user.
import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = '/workspace/.logs';
const LOG_FILE = path.join(LOG_DIR, 'preview-debug.jsonl');
const MAX_LOG_BYTES = 2 * 1024 * 1024; // rotate to .1 beyond this

const CLIENT_SNIPPET = `(() => {
  if (window.__previewDebugInstalled) return;
  window.__previewDebugInstalled = true;
  const ENDPOINT = '/__preview_debug__';
  const buffer = [];
  const cap = (v, n) => { const s = String(v); return s.length > n ? s.slice(0, n) + '…' : s; };
  const safe = (v) => {
    try {
      if (v instanceof Error) return v.stack || v.message;
      if (typeof v === 'object') return cap(JSON.stringify(v), 600);
      return cap(v, 600);
    } catch { return '[unserializable]'; }
  };
  const scrub = (v) => String(v).replace(/(__preview_session=)[^&#\\s]+/g, '$1[redacted]');
  const push = (e) => {
    const clean = {};
    for (const k of Object.keys(e)) clean[k] = typeof e[k] === 'string' ? scrub(e[k]) : e[k];
    buffer.push({ ts: new Date().toISOString(), page: location.pathname, ...clean });
    if (buffer.length > 200) buffer.shift();
  };
  const flush = (useBeacon) => {
    if (!buffer.length) return;
    const body = JSON.stringify(buffer.splice(0));
    try {
      if (useBeacon && navigator.sendBeacon) { navigator.sendBeacon(ENDPOINT, body); return; }
      window.__previewDebugFetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    } catch {}
  };
  push({ type: 'session', ua: navigator.userAgent, url: location.href });
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { push({ type: 'console', level, message: args.map(safe).join(' ') }); original(...args); };
  }
  window.addEventListener('error', (e) => push({ type: 'pageerror', message: cap(e.message, 600), source: cap((e.filename || '') + ':' + e.lineno, 200) }));
  window.addEventListener('unhandledrejection', (e) => push({ type: 'pageerror', message: 'Unhandled rejection: ' + safe(e.reason) }));
  const realFetch = window.fetch.bind(window);
  window.__previewDebugFetch = realFetch; // flush path must never recurse
  window.fetch = async (input, init) => {
    const url = cap(typeof input === 'string' ? input : (input && input.url) || '', 400);
    if (url.includes(ENDPOINT)) return realFetch(input, init);
    const method = (init && init.method) || (input && input.method) || 'GET';
    const started = performance.now();
    try {
      const res = await realFetch(input, init);
      const ms = Math.round(performance.now() - started);
      if (!res.ok || ms > 3000) push({ type: 'network', method, url, status: res.status, duration_ms: ms });
      return res;
    } catch (err) {
      push({ type: 'network', method, url, status: 0, error: safe(err), duration_ms: Math.round(performance.now() - started) });
      throw err;
    }
  };
  setInterval(() => flush(false), 2000);
  window.addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
})();`;

export default function previewDebugPlugin() {
  return {
    name: 'preview-debug',
    apply: 'serve',
    transformIndexHtml() {
      return [{ tag: 'script', children: CLIENT_SNIPPET, injectTo: 'head-prepend' }];
    },
    configureServer(server) {
      server.middlewares.use('/__preview_debug__', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 262144) req.destroy(); });
        req.on('end', () => {
          try {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            try {
              if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
                fs.renameSync(LOG_FILE, LOG_FILE + '.1');
              }
            } catch {}
            const events = JSON.parse(body);
            const lines = (Array.isArray(events) ? events : [events])
              .map((e) => JSON.stringify(e))
              .join('\n');
            if (lines) fs.appendFileSync(LOG_FILE, lines + '\n');
          } catch {}
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}
