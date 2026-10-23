#!/usr/bin/env node
// loki-tail.mjs — poll Loki for new log lines, emit ops-watch events.
//   node loki-tail.mjs <outJsonl|-> [--state state.json] [--url URL] [--udp host:port] [--window-min 5]
// Emits JSON events: {source:'loki', host, program:<job>, level, ts, message}
// …and RAW lines for syslog/kernel/fortigate-syslog jobs (parsers keep host/program fidelity).
// State: lastTsNs + recent-line hash set → no duplicates, no re-fetch. Zero deps.
//
// GOTCHAS (learned 2026-10-22):
// - The {job=~".+"} regex matcher HANGS on this Loki build even with ~29 streams, while every
//   exact {job="x"} query is instant → query per job and merge client-side.
// - A stale state (tap down for hours) means a huge catch-up window that blows per-query timeouts
//   → catch up in 30-min chunks, saving state after each chunk (max 6 chunks/cycle).
// - When shipping via --udp, cap datagrams at ~1300 bytes — Docker NAT drops fragmented UDP.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';

const args = process.argv.slice(2);
const out = args.find(a => !a.startsWith('--'));
const get = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const statePath = get('--state', 'loki-state.json');
const url = get('--url', 'http://localhost:3100');
const windowMin = parseInt(get('--window-min', '5'), 10);
const udpArg = (() => { const i = args.indexOf('--udp'); return i >= 0 ? args[i + 1] : null; })();
const MAX_LINES = 5000;
const CHUNK_NS = BigInt(10) * 60000000000n; // 10 min catch-up chunks — 30-min fortigate windows take >15s server-side; 10-min are fast
const MAX_CHUNKS = 6; // per run — catches up 3h/cycle; a multi-day gap drains over a few cycles
if (!out) { console.error('usage: loki-tail.mjs <outJsonl|-> [--state s.json] [--url URL] [--udp h:p]'); process.exit(1); }

const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { lastNs: null, seen: [] };
const nowNs = BigInt(Date.now()) * 1000000n;
// default window; never look past 60s ago (clock-skew guard)
let startNs = state.lastNs ? BigInt(state.lastNs) + 1n : nowNs - BigInt(windowMin) * 60000000000n;
const endNs = nowNs - 5000000000n; // 5s lag
let skippedGap = false;
const GAP_SKIP_NS = BigInt(2) * 3600n * 1000000000n; // gaps >2h: skip, don't replay (stale alerts + slow scans)
if (endNs - startNs > GAP_SKIP_NS) {
  skippedGap = true;
  startNs = endNs - BigInt(windowMin) * 60000000000n;
}
if (startNs >= endNs) { console.log(JSON.stringify({ fetched: 0, appended: 0, note: 'no new range' })); process.exit(0); }

const seen = new Set(state.seen || []);
let maxNs = state.lastNs ? BigInt(state.lastNs) : 0n;
let appended = 0, fetched = 0, streams = 0, truncated = false;
const outLines = [];

let sock = null;
if (udpArg) {
  sock = createSocket('udp4');
  sock.unref();
}

async function ship() {
  if (!outLines.length) return;
  if (sock) {
    const [uhost, uport] = udpArg.split(':');
    let buf = [], len = 0;
    const flush = async () => {
      if (!buf.length) return;
      sock.send(buf.join('\n'), Number(uport), uhost);
      buf = []; len = 0;
      await new Promise(res => setTimeout(res, 5));
    };
    for (const line of outLines) {
      const l = line.length > 1300 ? line.slice(0, 1300) : line;
      if (len + l.length + 1 > 1300 && buf.length) await flush();
      buf.push(l); len += l.length + 1;
    }
    await flush();
  } else if (out && out !== '-') {
    appendFileSync(out, outLines.join('\n') + '\n');
  }
  outLines.length = 0;
}

function saveState() {
  const seenArr = [...seen].slice(-4000);
  writeFileSync(statePath, JSON.stringify({ lastNs: String(maxNs || startNs), seen: seenArr }));
}

let jobs;
try {
  const lr = await fetch(`${url}/loki/api/v1/label/job/values`, { signal: AbortSignal.timeout(10000) });
  if (!lr.ok) throw new Error(`loki labels ${lr.status}`);
  // fortigate-syslog bypasses Loki: the collector ships those lines to the receiver over UDP
  // directly (full-window scans of that stream are pathologically slow — RUNBOOK 2026-10-22)
  jobs = ((await lr.json()).data || []).filter(j => j !== 'fortigate-syslog');
} catch (e) {
  console.log(JSON.stringify({ fetched: 0, appended: 0, error: `labels: ${String(e && e.message || e).slice(0, 120)}` }));
  process.exit(0);
}

let chunks = 0, err = null;
try {
  while (startNs < endNs && chunks < MAX_CHUNKS) {
    const chunkEnd = (startNs + CHUNK_NS > endNs) ? endNs : startNs + CHUNK_NS;
    const merged = [];
    for (const job of jobs) {
      const q = encodeURIComponent(`{job="${job}"}`);
      let r;
      try {
        r = await fetch(`${url}/loki/api/v1/query_range?query=${q}&start=${startNs}&end=${chunkEnd}&limit=${MAX_LINES}&direction=forward`, { signal: AbortSignal.timeout(15000) });
      } catch (e) {
        throw new Error(`loki fetch job=${job}: ${String(e && e.message || e).slice(0, 100)}`);
      }
      if (!r.ok) throw new Error(`loki ${r.status} job=${job}`);
      const jb = await r.json();
      for (const s of jb.data?.result || []) merged.push(s);
    }
    // collect values, prefer newest when over cap (tail semantics)
    const all = [];
    for (const stream of merged) {
      streams++;
      const L = stream.stream;
      const job = L.job || 'unknown';
      const host = L.host || L.instance || L.hostname || (L.container ? `${L.container}` : 'unknown-host');
      const level = L.detected_level || null;
      for (const [ns, line] of stream.values || []) {
        fetched++;
        all.push([ns, job, host, level, line]);
      }
    }
    all.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? 1 : -1)); // newest first
    let chunkTruncated = false;
    if (all.length > MAX_LINES) { all.length = MAX_LINES; chunkTruncated = truncated = true; }
    all.sort((a, b) => (BigInt(a[0]) > BigInt(b[0]) ? 1 : -1)); // emit oldest first

    for (const [ns, job, host, level, line] of all) {
      const h = createHash('sha1').update(`${job}|${line}`).digest('hex').slice(0, 12);
      if (seen.has(h)) continue;
      seen.add(h);
      const ts = new Date(Number(BigInt(ns) / 1000000n)).toISOString();
      if (job === 'syslog' || job === 'kernel' || job === 'fortigate-syslog') {
        outLines.push(line.slice(0, 2000)); // raw → RFC3164/FortiGate KV parser keeps host/program
      } else {
        outLines.push(JSON.stringify({ source: 'loki', host, program: job, level, ts, message: line.slice(0, 1000) }));
      }
      appended++;
      if (BigInt(ns) > maxNs) maxNs = BigInt(ns);
    }
    // advance: normally to chunkEnd; only when the chunk itself hit the line cap do we
    // re-query from the newest emitted line so capped-out data isn't skipped
    startNs = chunkTruncated && maxNs > 0n ? maxNs + 1n : chunkEnd;
    await ship();
    saveState();
    chunks++;
  }
} catch (e) {
  err = String(e && e.message || e).slice(0, 150);
}

if (sock) { await new Promise(res => setTimeout(res, 100)); sock.close(); }
if (skippedGap && maxNs < endNs) maxNs = endNs; // don't let a quiet skipped window re-trigger the skip
if (appended) saveState();
console.log(JSON.stringify({ fetched, appended, streams, truncated, chunks, skippedGap, lastNs: String(maxNs || startNs), ...(err ? { error: err } : {}) }));
if (err && !appended) process.exit(1);
