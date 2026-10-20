#!/usr/bin/env node
// triage.mjs — ops-watch decision pipeline.
//   node triage.mjs <events.jsonl> [--window-min 5] [--live] [--digest-only]
//
// Decision order (fixed):
//   P0/P1 deterministic (honeytokens, IOCs, config change, auth burst, critical level)
//     → ALWAYS ping, Jev never consulted, never suppressed. (Chris 2026-10-20: blocking OK,
//       but deterministic layer is above Jev by design.)
//   P2 → Jev security-triage gate scores "routine background noise" (noul).
//     blocking mode: benign >= threshold → HELD (digest only; ledgered, never deleted).
//     Jev down/unsure → fail-open: goes to digest AND flagged unparsed — never silently lost.
// All decisions append to the Jev ledger (gate: security-triage).
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeLine, clusterEvents, deterministicVerdict, appRulesVerdict, buildLokiEvent, scrub } from './lib.mjs';
import { sendTelegram, pingMessage } from './notify.mjs';
let _jev;
try { _jev = await import('../jev/jev-gate.mjs'); }        // repo layout (mini)
catch { _jev = await import('./jev/jev-gate.mjs'); }        // container layout (/app)
const { jev, gateConfig, logDecision } = _jev;

const HERE = dirname(fileURLToPath(import.meta.url));
const HONEY = JSON.parse(readFileSync(join(HERE, 'honeytokens.json'), 'utf8'));
let RULES = [];
try { RULES = JSON.parse(readFileSync(join(HERE, 'rules.json'), 'utf8')).rules || []; } catch { /* no rules file → generic layer only */ }
const GATE = 'security-triage';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const windowMin = parseInt(args[(args.indexOf('--window-min') ?? -2) + 1]) || 5;
const live = args.includes('--live');
const digestOnly = args.includes('--digest-only');
const stateFile = args.includes('--state-file') ? args[args.indexOf('--state-file') + 1] : null;
const REPEAT_HOURS = 4;
let pingState = { lastP1: {} };
if (stateFile) { try { pingState = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { pingState = { lastP1: {} }; } }
pingState.lastP1 = pingState.lastP1 || {};
function suppressRepeat(sig) {
  const last = pingState.lastP1[sig];
  if (last && Date.now() - last < REPEAT_HOURS * 3600000) return true;
  return false;
}
if (!file) { console.error('usage: triage.mjs <events.jsonl> [--window-min N] [--live] [--digest-only]'); process.exit(1); }

let offset = 0;
if (stateFile) {
  try { offset = JSON.parse(readFileSync(stateFile, 'utf8')).offset || 0; } catch { offset = 0; }
}
const stat = existsSync(file) ? statSync(file) : { size: 0 };
if (stat.size < offset) offset = 0; // rotated/truncated
const rawLines = stat.size > offset
  ? readFileSync(file, 'utf8').slice(offset).split('\n').filter(Boolean)
  : [];
// note: last line may be partial — only safe if file ends with \n
if (rawLines.length && !readFileSync(file, 'utf8').endsWith('\n')) { rawLines.pop(); }
const newOffset = offset + Buffer.byteLength(rawLines.join('\n') + (rawLines.length ? '\n' : ''));
const events = [];
for (const l of rawLines) {
  let ev = null;
  if (l.startsWith('{')) {
    try {
      const j = JSON.parse(l);
      if (j.line !== undefined) ev = normalizeLine(j.line, j.received_at ? new Date(j.received_at) : undefined);
      else if (j.message !== undefined) ev = buildLokiEvent(j);
    } catch { /* fall through to raw */ }
  }
  if (!ev) ev = normalizeLine(l);
  if (ev) events.push(ev);
}
const { window, clusters } = clusterEvents(events, windowMin);
const cfg = gateConfig(GATE) || { enabled: true, threshold: 0.75, mode: 'blocking' };
const th = cfg.threshold ?? 0.75;

// ── Layer 1: deterministic ────────────────────────────────────────────────────
const p0 = [], p1 = [], p2 = [], p3 = [];
for (const c of clusters) {
  const appV = appRulesVerdict(c, RULES);
  const v = appV || deterministicVerdict(c, HONEY);
  if (v.level === 'P0') p0.push({ cluster: c, verdict: v });
  else if (v.level === 'P1') p1.push({ cluster: c, verdict: v });
  else if (v.level === 'P3') p3.push({ cluster: c, verdict: v });
  else p2.push({ cluster: c, verdict: v });
}
logDecision({ gate: GATE, action: 'deterministic-layer', pass: true,
  p0: p0.length, p1: p1.length, p2: p2.length, p3: p3.length, window });

// ── Layer 2: Jev semantic scoring on P2 clusters ─────────────────────────────
const held = [], pingFromJev = [], jevDown = [];
for (const x of p3) held.push({ ...x, benignProb: null, heldBy: 'deterministic-hum' });
logDecision({ gate: GATE, action: 'hold-hum', pass: true, count: p3.length });
if (p2.length && cfg.enabled !== false) {
  const capped = p2.slice(0, 150); // batch cap (Jev ≈ $0.00002/verdict; 150 ≈ $0.003/cycle)
  const overflow = p2.slice(20);
  const state = capped.map((x, i) => {
    const c = x.cluster;
    return `[c${i}] SOURCE: ${c.source} HOST: ${c.host || 'n/a'} PROGRAM: ${c.program || 'n/a'}\n` +
      `COUNT: ${c.count} in ${windowMin}min window · distinct_users: ${c.distinct_users} · distinct_ips: ${c.distinct_ips}\n` +
      `SAMPLES:\n` + c.samples.map(s => `  - ${scrub(s).slice(0, 160)}`).join('\n');
  }).join('\n\n');
  const questions = {};
  capped.forEach((_, i) => {
    questions[`c${i}`] = { type: 'noul', instructions:
      'Cluster is ROUTINE recurring background noise — a repeated known-good pattern (routine firewall block/allow traffic, periodic cron/keepalive/backup jobs, health checks, expected repeats of a familiar low-severity app message seen many times before). It is NOT novel, NOT a config or policy change, NOT a spike in failure rate, NOT security-relevant, and does NOT need human attention now.' };
  });
  try {
    const r = await jev(state, questions, { gate: GATE, action: 'triage' });
    capped.forEach((x, i) => {
      const p = r.answers?.[`c${i}`]?.noul ?? null;
      if (p === null) pingFromJev.push({ ...x, verdict: { ...x.verdict, why: 'jev-unparsed → escalated' } });
      else if (p >= th) held.push({ ...x, benignProb: p });
      else pingFromJev.push({ ...x, benignProb: p, verdict: { ...x.verdict, why: `jev scored novel (benign ${p.toFixed(2)} < ${th})` } });
    });
    overflow.forEach(x => held.push({ ...x, benignProb: null, heldBy: 'batch-overflow' }));
  } catch (e) {
    // fail-open: Jev down → NOTHING is suppressed; everything surfaces (digest), ping only P0/P1
    console.error(`jev unavailable (${e.message}) — fail-open: no suppression this cycle`);
    p2.forEach(x => jevDown.push({ ...x, verdict: { ...x.verdict, why: `jev down (${e.message.slice(0, 60)}) → held-visible, flagged` } }));
    logDecision({ gate: GATE, action: 'fail-open', pass: true, note: 'jev down; no suppression' });
  }
} else if (p2.length) {
  p2.forEach(x => jevDown.push({ ...x, verdict: { ...x.verdict, why: 'gate disabled → digest, flagged' } }));
}

// ── Ledger for held items ─────────────────────────────────────────────────────
for (const h of held) logDecision({ gate: GATE, action: 'hold-noise', pass: true, sig: h.cluster.sig,
  count: h.cluster.count, benignProb: h.benignProb, source: h.cluster.source });

// ── Output ────────────────────────────────────────────────────────────────────
const pingsRaw = [...p0, ...p1, ...pingFromJev];
const pings = [], repeatHeld = [];
for (const x of pingsRaw) {
  if (x.verdict.level !== 'P0' && suppressRepeat(x.cluster.sig)) {
    repeatHeld.push({ ...x, heldBy: 'repeat-suppressed', repeatOf: pingState.lastP1[x.cluster.sig] });
  } else {
    pingState.lastP1[x.cluster.sig] = Date.now();
    pings.push(x);
  }
}
const result = {
  window,
  counts: { clusters: clusters.length, p0: p0.length, p1: p1.length, jevPing: pingFromJev.length, held: held.length + repeatHeld.length, jevDown: jevDown.length, repeatsHeld: repeatHeld.length },
  pings: pings.map(x => ({ level: x.verdict.level, why: x.verdict.why, source: x.cluster.source, program: x.cluster.program,
    count: x.cluster.count, host: x.cluster.host, sample: (x.cluster.samples[0] || '').slice(0, 160) })),
  held: [...repeatHeld.map(x => ({ sig: x.cluster.sig, benignProb: null, heldBy: 'repeat-suppressed', source: x.cluster.source, program: x.cluster.program, count: x.cluster.count, sample: (x.cluster.samples[0] || '').slice(0, 100) })), ...held.map(x => ({ sig: x.cluster.sig, benignProb: x.benignProb, source: x.cluster.source, program: x.cluster.program,
    count: x.cluster.count, sample: (x.cluster.samples[0] || '').slice(0, 100) }))],
  jevDown: jevDown.map(x => ({ sig: x.cluster.sig, source: x.cluster.source, count: x.cluster.count })),
};
appendFileSync(join(HERE, 'held.jsonl'), held.map(h => JSON.stringify({ ts: new Date().toISOString(), sig: h.cluster.sig,
  source: h.cluster.source, program: h.cluster.program, count: h.cluster.count,
  benignProb: h.benignProb, heldBy: h.heldBy || 'jev-benign', why: h.verdict?.why })).join('\n') + (held.length ? '\n' : ''));

if (stateFile) writeFileSync(stateFile, JSON.stringify({ offset: newOffset, lastP1: pingState.lastP1 }));
console.log(JSON.stringify(result, null, 2));

if (live && pings.length && !digestOnly) {
  const body = pings.slice(0, 10).map(x => pingMessage(x.cluster, x.verdict, { test: process.env.OPSWATCH_TEST === '1' })).join('\n\n———\n\n');
  await sendTelegram(body);
  console.error(`pinged ${Math.min(pings.length, 10)} cluster(s) to Telegram`);
}
