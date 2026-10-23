#!/usr/bin/env node
// compare-shadow.mjs — v1 vs v2 shadow comparison (plan §3.11). Reads data/jev-v2-shadow.jsonl.
//   node compare-shadow.mjs [--hours 24] [--json]
// No network, no sends. Run on .110 (docker exec ops-watch node compare-shadow.mjs --hours 24)
// or on the mini against a fetched copy.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OPSWATCH_DATA_DIR || join(HERE, 'data');
const PRICE_PER_MTOK = 0.042;   // Jev input, $/Mtok (matches jev-gate.mjs)
const args = process.argv.slice(2);
const hours = parseInt(args[(args.indexOf('--hours') ?? -2) + 1]) || 24;
const asJson = args.includes('--json');

function readShadow() {
  const p = join(DATA_DIR, 'jev-v2-shadow.jsonl');
  if (!existsSync(p)) return [];
  const cut = Date.now() - hours * 3600000;
  const rows = [];
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l) continue;
    try { const r = JSON.parse(l); if (new Date(r.ts).getTime() >= cut) rows.push(r); } catch { /* skip */ }
  }
  return rows;
}

const rows = readShadow();
const clusterRows = rows.filter(r => r.sig);
const callRows = rows.filter(r => r.type === 'call');
const terminalCalls = callRows.filter(r => r.retry === undefined);
const retryRows = callRows.filter(r => r.retry);

const cycles = new Set(clusterRows.map(r => r.cycle_id));
const scored = clusterRows.filter(r => r.v2_decision !== 'unscored');
const errors = clusterRows.filter(r => r.error && r.v2_decision === 'unscored');
const prestep = clusterRows.filter(r => r.v2_decision === 'prestep');

// agreement (hold↔hold, ping↔ping; digest/unscored counted separately)
let agree = 0, v1ping_v2hold = 0, v1ping_v2digest = 0, v1hold_v2ping = 0, v1hold_v2digest = 0, other = 0;
for (const r of scored) {
  const a = r.v1_decision, b = r.v2_decision;
  if (a === b && (a === 'hold' || a === 'ping')) agree++;
  else if (a === 'ping' && b === 'hold') v1ping_v2hold++;
  else if (a === 'ping' && b === 'digest') v1ping_v2digest++;
  else if (a === 'hold' && b === 'ping') v1hold_v2ping++;
  else if (a === 'hold' && b === 'digest') v1hold_v2digest++;
  else other++;
}
const total = scored.length;

// per-call spread of p(routine_noise) — group cluster rows by (cycle_id, chunk)
const byCall = new Map();
for (const r of scored) {
  if (r.probs?.routine_noise === undefined) continue;
  const k = `${r.cycle_id}|${r.chunk ?? '?'}`;
  if (!byCall.has(k)) byCall.set(k, []);
  byCall.get(k).push(r.probs.routine_noise);
}
const callRanges = [...byCall.values()].filter(a => a.length >= 2).map(a => Math.max(...a) - Math.min(...a));
callRanges.sort((a, b) => a - b);
const median = a => (a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null);
const stdev = a => { if (a.length < 2) return 0; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

// argmax distribution + confidence
const argmaxDist = {};
for (const r of scored) {
  const p = r.probs || {};
  const am = Object.entries(p).sort((a, b) => b[1] - a[1])[0]?.[0] || 'none';
  argmaxDist[am] = (argmaxDist[am] || 0) + 1;
}
const confs = scored.map(r => r.confidence).filter(x => typeof x === 'number').sort((a, b) => a - b);

// top disagreement lists
const v2wouldPing_v1held = scored.filter(r => r.v1_decision === 'hold' && r.v2_decision === 'ping')
  .sort((a, b) => b.count - a.count).slice(0, 15);
const v2wouldHold_v1pinged = scored.filter(r => r.v1_decision === 'ping' && r.v2_decision === 'hold')
  .sort((a, b) => b.count - a.count).slice(0, 15);

// pings/day + cost
const spanH = Math.max(hours, 0.1);
const v1pingsPerDay = scored.filter(r => r.v1_decision === 'ping').length / spanH * 24;
const v2pingsPerDay = scored.filter(r => r.v2_decision === 'ping').length / spanH * 24;
const tokensIn = callRows.reduce((n, r) => n + (r.tokens_in || 0), 0);
const tokensOut = callRows.reduce((n, r) => n + (r.tokens_out || 0), 0);
const costDay = ((tokensIn + tokensOut) / 1e6) * PRICE_PER_MTOK / spanH * 24;

const errRate = terminalCalls.length ? (terminalCalls.filter(c => !c.ok).length / terminalCalls.length) : 0;
const out = {
  window_hours: hours,
  cycles: cycles.size,
  clusters_scored: scored.length,
  unscored_rows: errors.length,
  prestep_holds: prestep.length,
  v2_error_rate: +errRate.toFixed(4),
  retries: retryRows.length,
  agreement: total ? +((agree / total)).toFixed(3) : null,
  confusion: { agree_hold_or_ping: agree, v1ping_v2hold, v1ping_v2digest, v1hold_v2ping, v1hold_v2digest, other },
  per_call_spread: {
    calls_with_2plus: callRanges.length,
    median_range: median(callRanges) === null ? null : +median(callRanges).toFixed(3),
    min: callRanges.length ? +callRanges[0].toFixed(3) : null,
    max: callRanges.length ? +callRanges.at(-1).toFixed(3) : null,
    stdev_of_ranges: +stdev(callRanges).toFixed(3),
    target: 'median range ≫ 0.03 (v1 batch-noul baseline)',
  },
  argmax_dist: argmaxDist,
  confidence: { median: confs.length ? +median(confs).toFixed(3) : null, min: confs[0] ?? null, max: confs.at(-1) ?? null },
  top_v2_ping_v1_hold: v2wouldPing_v1held.map(r => ({ sig: r.sig, source: r.source, program: r.program, count: r.count,
    p_sr: r.probs?.security_relevant, p_of: r.probs?.operational_fault, conf: r.confidence, sample: r.features?.samples?.[0]?.slice(0, 90) })),
  top_v2_hold_v1_ping: v2wouldHold_v1pinged.map(r => ({ sig: r.sig, source: r.source, program: r.program, count: r.count,
    p_rn: r.probs?.routine_noise, conf: r.confidence, v1_benignProb: r.v1_benignProb, sample: r.features?.samples?.[0]?.slice(0, 90) })),
  est_pings_per_day: { v1: +v1pingsPerDay.toFixed(1), v2: +v2pingsPerDay.toFixed(1) },
  tokens: { in: tokensIn, out: tokensOut, est_usd_per_day: +costDay.toFixed(3) },
};

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  const f = x => (x === null ? 'n/a' : x);
  console.log(`ops-watch shadow comparison — last ${hours}h (${new Date().toISOString()})`);
  console.log(`cycles: ${out.cycles} · clusters scored: ${scored.length} · prestep holds: ${prestep.length} · unscored: ${errors.length}`);
  console.log(`v2 error rate (terminal calls): ${(errRate * 100).toFixed(1)}% · retries: ${retryRows.length}`);
  console.log(`agreement v1↔v2: ${f(out.agreement)}`);
  console.log(`confusion: hold/ping agree=${out.confusion.agree_hold_or_ping} v1ping→v2hold=${v1ping_v2hold} v1ping→v2digest=${v1ping_v2digest} v1hold→v2ping=${v1hold_v2ping} v1hold→v2digest=${v1hold_v2digest} other=${other}`);
  console.log(`per-call p(rn) spread: median=${f(out.per_call_spread.median_range)} min=${f(out.per_call_spread.min)} max=${f(out.per_call_spread.max)} stdev=${f(out.per_call_spread.stdev_of_ranges)} (target ≫ 0.03)`);
  console.log(`argmax dist: ${JSON.stringify(out.argmax_dist)}`);
  console.log(`confidence: median=${f(out.confidence.median)} min=${f(out.confidence.min)} max=${f(out.confidence.max)}`);
  console.log(`est pings/day: v1=${out.est_pings_per_day.v1} v2=${out.est_pings_per_day.v2}`);
  console.log(`tokens: in=${tokensIn} out=${tokensOut} ≈$${out.tokens.est_usd_per_day}/day`);
  if (v2wouldPing_v1hold.length) {
    console.log(`\nTop v2-would-PING that v1 held (${v2wouldPing_v1hold.length} shown of ${scored.filter(r => r.v1_decision === 'hold' && r.v2_decision === 'ping').length}):`);
    for (const r of v2wouldPing_v1hold) console.log(`  ${r.source}/${r.program} ×${r.count} p_sr=${(r.probs?.security_relevant ?? 0).toFixed(2)} conf=${(r.confidence ?? 0).toFixed(2)} — ${(r.features?.samples?.[0] || '').slice(0, 90)}`);
  }
  if (v2wouldHold_v1pinged.length) {
    console.log(`\nTop v2-would-HOLD that v1 pinged (${v2wouldHold_v1pinged.length} shown of ${scored.filter(r => r.v1_decision === 'ping' && r.v2_decision === 'hold').length}):`);
    for (const r of v2wouldHold_v1pinged) console.log(`  ${r.source}/${r.program} ×${r.count} p_rn=${(r.probs?.routine_noise ?? 0).toFixed(2)} v1_benign=${r.v1_benignProb ?? 'n/a'} — ${(r.features?.samples?.[0] || '').slice(0, 90)}`);
  }
}
