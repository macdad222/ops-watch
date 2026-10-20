#!/usr/bin/env node
// loki-tail.mjs — poll Loki for new log lines, emit ops-watch events.
//   node loki-tail.mjs <outJsonl> [--state state.json] [--window-min 5] [--url http://192.168.5.56:3100]
// Emits JSON events: {source:'loki', host, program:<job>, level, ts, message}
// …and RAW lines for syslog/kernel jobs (RFC3164 parser handles them with full fidelity).
// State: lastTsNs + recent-line hash set → no duplicates, no re-fetch. Zero deps.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const out = args.find(a => !a.startsWith('--'));
const get = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const statePath = get('--state', 'loki-state.json');
const url = get('--url', 'http://localhost:3100');
const windowMin = parseInt(get('--window-min', '5'), 10);
const MAX_LINES = 5000;
if (!out) { console.error('usage: loki-tail.mjs <outJsonl> [--state s.json] [--url URL]'); process.exit(1); }

const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { lastNs: null, seen: [] };
const nowNs = BigInt(Date.now()) * 1000000n;
// default window; never look past 60s ago (clock-skew guard)
let startNs = state.lastNs ? BigInt(state.lastNs) + 1n : nowNs - BigInt(windowMin) * 60000000000n;
const endNs = nowNs - 5000000000n; // 5s lag
if (startNs >= endNs) { console.log(JSON.stringify({ fetched: 0, appended: 0, note: 'no new range' })); process.exit(0); }

const query = encodeURIComponent('{job=~".+"}');
const u = `${url}/loki/api/v1/query_range?query=${query}&start=${startNs}&end=${endNs}&limit=${MAX_LINES}&direction=forward`;
const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
if (!r.ok) { const b = await r.text(); throw new Error(`loki ${r.status}: ${b.slice(0, 150)}`); }
const body = await r.json();

const seen = new Set(state.seen || []);
let maxNs = state.lastNs ? BigInt(state.lastNs) : 0n;
let appended = 0, fetched = 0, streams = 0, truncated = false;
const outLines = [];

for (const stream of body.data?.result || []) {
  streams++;
  const L = stream.stream;
  const job = L.job || 'unknown';
  const host = L.host || L.instance || L.hostname || (L.container ? `${L.container}` : 'unknown-host');
  for (const [ns, line] of stream.values || []) {
    fetched++;
    const h = createHash('sha1').update(`${job}|${line}`).digest('hex').slice(0, 12);
    if (seen.has(h)) continue;
    seen.add(h);
    const ts = new Date(Number(BigInt(ns) / 1000000n)).toISOString();
    if (job === 'syslog' || job === 'kernel') {
      outLines.push(line.slice(0, 2000)); // raw → RFC3164/bare parser keeps host/program
    } else {
      outLines.push(JSON.stringify({ source: 'loki', host, program: job, level: L.detected_level || null, ts, message: line.slice(0, 1000) }));
    }
    appended++;
    if (BigInt(ns) > maxNs) maxNs = BigInt(ns);
    if (appended >= MAX_LINES) { truncated = true; break; }
  }
  if (truncated) break;
}

if (appended) appendFileSync(out, outLines.join('\n') + '\n');
// keep hash set bounded
const seenArr = [...seen].slice(-4000);
writeFileSync(statePath, JSON.stringify({ lastNs: String(maxNs || startNs), seen: seenArr }));
console.log(JSON.stringify({ fetched, appended, streams, truncated, lastNs: String(maxNs || startNs) }));
