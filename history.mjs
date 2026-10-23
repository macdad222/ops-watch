// history.mjs — per-sig rolling history (8 days) for v2 features. data/sig-stats.json.
// Jev must never compute counts/dates — this module gives triage-v2 code-computed facts.
// Structure: { sig: { byDay: {'YYYY-MM-DD': {count, cycles}}, held_log: [dates], pinged_log: [dates],
//                     last_verdict, last_verdict_ts, updated } }
// Zero deps. Tolerant: a corrupt/missing file behaves as empty history.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OPSWATCH_DATA_DIR || join(HERE, 'data');
const STATS = join(DATA_DIR, 'sig-stats.json');
const DAY_MS = 86400000;
const KEEP_DAYS = 8;      // plan §3.2: last 8 days of per-day counts
const WINDOW_DAYS = 7;    // features computed over last 7 days

function dayKey(ts = Date.now()) {
  // CT day key (container is UTC; Chris's day is Central)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ts)); // YYYY-MM-DD
}
function cutoffTs(days) { return Date.now() - days * DAY_MS; }

export function loadHistory(path) {
  const p = path || STATS;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

function saveHistory(hist, path) {
  try { writeFileSync(path || STATS, JSON.stringify(hist)); } catch { /* never break a cycle */ }
}

function prune(hist) {
  const cut = cutoffTs(KEEP_DAYS);
  for (const [sig, h] of Object.entries(hist)) {
    if (h.byDay) for (const d of Object.keys(h.byDay)) if (new Date(`${d}T12:00:00Z`).getTime() < cut - DAY_MS) delete h.byDay[d];
    if (Array.isArray(h.held_log)) h.held_log = h.held_log.filter(d => new Date(`${d}T12:00:00Z`).getTime() >= cutoffTs(WINDOW_DAYS));
    if (Array.isArray(h.pinged_log)) h.pinged_log = h.pinged_log.filter(d => new Date(`${d}T12:00:00Z`).getTime() >= cutoffTs(WINDOW_DAYS));
    if (!h.byDay || !Object.keys(h.byDay).length) {
      if (!h.held_log?.length && !h.pinged_log?.length && !h.last_verdict) delete hist[sig];
    }
  }
  return hist;
}

// Record one cycle's outcomes. clusters: [{sig, count}]; outcomes: {heldSigs:Set, pingedSigs:Set,
// verdicts: Map(sig → string)}. Call ONCE per cycle after decisions.
export function recordCycle(clusters, outcomes = {}, path) {
  const hist = prune(loadHistory(path));
  const today = dayKey();
  const seenThisCycle = new Set();
  for (const c of clusters || []) {
    if (!c?.sig) continue;
    const h = hist[c.sig] = hist[c.sig] || { byDay: {}, held_log: [], pinged_log: [], last_verdict: null, last_verdict_ts: null };
    h.byDay[today] = h.byDay[today] || { count: 0, cycles: 0 };
    if (!seenThisCycle.has(c.sig)) { h.byDay[today].cycles += 1; seenThisCycle.add(c.sig); }
    h.byDay[today].count += c.count || 0;
  }
  for (const sig of outcomes.heldSigs || []) {
    const h = hist[sig] = hist[sig] || { byDay: {}, held_log: [], pinged_log: [], last_verdict: null, last_verdict_ts: null };
    if (!h.held_log.includes(today)) h.held_log.push(today);
  }
  for (const sig of outcomes.pingedSigs || []) {
    const h = hist[sig] = hist[sig] || { byDay: {}, held_log: [], pinged_log: [], last_verdict: null, last_verdict_ts: null };
    if (!h.pinged_log.includes(today)) h.pinged_log.push(today);
  }
  for (const [sig, verdict] of outcomes.verdicts || []) {
    if (hist[sig]) { hist[sig].last_verdict = String(verdict).slice(0, 60); hist[sig].last_verdict_ts = new Date().toISOString(); }
  }
  saveHistory(prune(hist), path);
  return hist;
}

// 7-day feature block for one cluster (code-computed; never ask Jev to count).
export function features7d(hist, sig) {
  const h = hist?.[sig] || {};
  const cut = cutoffTs(WINDOW_DAYS);
  const days = Object.entries(h.byDay || {}).filter(([d]) => new Date(`${d}T12:00:00Z`).getTime() >= cut);
  const seen_7d_count = days.reduce((n, [, v]) => n + (v.cycles || 0), 0);
  const total_count = days.reduce((n, [, v]) => n + (v.count || 0), 0);
  return {
    seen_last_7d: seen_7d_count > 0,
    seen_7d_count,
    days_seen_7d: days.length,
    baseline_per_cycle_7d: seen_7d_count > 0 ? +(total_count / seen_7d_count).toFixed(1) : null,
    held_7d: (h.held_log || []).length,
    pinged_7d: (h.pinged_log || []).length,
    last_verdict: h.last_verdict ?? null,
  };
}

// One-time bootstrap from the existing audit trail so day-one features aren't all "new".
// held.jsonl: {ts, sig, count, heldBy...} rows → held_log + byDay approximations.
// Pings were not per-sig ledgered before v2 → pinged_7d starts empty and fills naturally.
export function bootstrapFromHeld({ heldPath, outPath } = {}) {
  const hp = heldPath || join(DATA_DIR, 'held.jsonl');
  const hist = loadHistory(outPath);
  let rows = 0;
  try {
    const lines = readFileSync(hp, 'utf8').split('\n').filter(Boolean);
    for (const l of lines) {
      let r; try { r = JSON.parse(l); } catch { continue; }
      if (!r.sig || !r.ts) continue;
      rows++;
      const d = dayKey(new Date(r.ts).getTime());
      const h = hist[r.sig] = hist[r.sig] || { byDay: {}, held_log: [], pinged_log: [], last_verdict: null, last_verdict_ts: null };
      h.byDay[d] = h.byDay[d] || { count: 0, cycles: 0 };
      h.byDay[d].cycles += 1;          // each hold row ≈ one cycle where the sig was seen
      h.byDay[d].count += r.count || 0;
      if (r.heldBy !== 'repeat-suppressed' && !h.held_log.includes(d)) h.held_log.push(d);
    }
  } catch { /* no held file */ }
  saveHistory(prune(hist), outPath);
  return { rows, sigs: Object.keys(hist).length };
}

// CLI: node history.mjs --bootstrap [--data-dir X]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const args = process.argv.slice(2);
  if (args.includes('--bootstrap')) {
    const out = bootstrapFromHeld({});
    console.log(`bootstrap: ${out.rows} held rows → ${out.sigs} sigs`);
  }
}
