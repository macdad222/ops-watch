#!/usr/bin/env node
// triage.mjs — ops-watch decision pipeline (v2).
//   node triage.mjs <events.jsonl> [--window-min 5] [--live] [--digest-only]
//
// Decision order (fixed, code above Jev):
//   P0/P1 deterministic (honeytokens, IOCs, config change, auth burst, critical level)
//     → ALWAYS ping, Jev never consulted, never suppressed. (Chris 2026-10-20: blocking OK,
//       but deterministic layer is above Jev by design.)
//   P2 → Jev security-triage gate scores "routine background noise" (noul).
//     blocking mode: benign >= threshold → HELD (digest only; ledgered, never deleted).
//     Jev down/unsure → fail-open: goes to digest AND flagged unparsed — never silently lost.
// All decisions append to the Jev ledger (gate: security-triage).
//
// v2 (2026-10-23) drop-bug fixes (plan §3.8):
//   - overflow = p2.slice(v1_cap) — clusters 20..149 are no longer scored AND held; 150+ are
//     unscored WITH a reason (data/unscored.jsonl) instead of silently double-handled.
//   - clusterEvents batch mode: the WHOLE unread batch is clustered (backlog no longer dropped).
//   - send path: mutes + 4h repeat filter → P0-first cap → send → lastP1/pings.jsonl marked
//     ONLY after Telegram ok → over-cap / send-failed items go to the digest queue, never lost.
// Exported pieces (parseEvents/classify/jevScoreV1/deliver) are unit-testable; main() runs
// only when executed directly.
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeLine, clusterEvents, deterministicVerdict, appRulesVerdict, buildLokiEvent, scrub, loadOpsConfig, isQuietHoursCT } from './lib.mjs';
import { sendTelegram, pingMessage, feedbackKeyboard } from './notify.mjs';
import { assess, esc } from './assess.mjs';   // analyst enrichment (PLAN-qwen-assess 2026-10-23)
import { recordCycle } from './history.mjs';
import { triageV2 } from './triage-v2.mjs';
import { readFileSync as _rf } from 'node:fs';
let EXAMPLES = null;
try { EXAMPLES = JSON.parse(_rf(join(HERE, 'examples.json'), 'utf8')); } catch { EXAMPLES = null; }
let _jev;
try { _jev = await import('../jev/jev-gate.mjs'); }        // repo layout (mini)
catch { _jev = await import('./jev/jev-gate.mjs'); }        // container layout (/app)
const { jev, gateConfig, logDecision } = _jev;

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OPSWATCH_DATA_DIR || join(HERE, 'data');   // tests redirect via env
const HONEY = JSON.parse(readFileSync(join(HERE, 'honeytokens.json'), 'utf8'));
let RULES = [];
try { RULES = JSON.parse(readFileSync(join(HERE, 'rules.json'), 'utf8')).rules || []; } catch { /* no rules file → generic layer only */ }
const GATE = 'security-triage';

// ── jsonl writers (all under data/ — the mounted volume; recreate-safe) ──────
function appendJsonl(file, rows) {
  if (!rows || !rows.length) return;
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }
  appendFileSync(join(DATA_DIR, file), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}
export function readMutes(path) {
  try {
    const m = JSON.parse(readFileSync(path || join(DATA_DIR, 'mutes.json'), 'utf8'));
    return m && typeof m === 'object' ? m : {};
  } catch { return {}; }
}
function muteUntil(v) { return typeof v === 'number' ? v : (v ? Date.parse(v) : 0); }
export function appendPingsRow(row) { appendJsonl('pings.jsonl', [row]); }
export function appendDigestQueue(items, reason, cycleId) {
  appendJsonl('digest-queue.jsonl', items.map(x => ({
    ts: new Date().toISOString(), cycle_id: cycleId, reason, sig: x.cluster.sig,
    source: x.cluster.source, program: x.cluster.program || '', count: x.cluster.count,
    sample: (x.cluster.samples[0] || '').slice(0, 160),
  })));
}
export function appendUnscored(rows) { appendJsonl('unscored.jsonl', rows); }

// ── parse raw lines → events ─────────────────────────────────────────────────
export function parseEvents(rawLines) {
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
  return events;
}

// ── deterministic layers (P0/P1/P3 out, P2 back) ─────────────────────────────
export function classify(events, { windowMin = 5, mode = 'batch' } = {}) {
  const { window, clusters } = clusterEvents(events, windowMin, { mode });
  const p0 = [], p1 = [], p2 = [], p3 = [];
  for (const c of clusters) {
    const appV = appRulesVerdict(c, RULES);
    const v = appV || deterministicVerdict(c, HONEY);
    if (v.level === 'P0') p0.push({ cluster: c, verdict: v });
    else if (v.level === 'P1') p1.push({ cluster: c, verdict: v });
    else if (v.level === 'P3') p3.push({ cluster: c, verdict: v });
    else p2.push({ cluster: c, verdict: v });
  }
  return { window, clusters, p0, p1, p2, p3 };
}

// ── v1 Jev scoring on P2 (batch noul, bug-fixed) ─────────────────────────────
export async function jevScoreV1(p2, { cfg, windowMin = 5, jevFn = jev, gateCfg = null } = {}) {
  const held = [], pingFromJev = [], jevDown = [], unscored = [];
  if (!p2.length) return { held, pingFromJev, jevDown, unscored };
  const gcfg = gateCfg || gateConfig(GATE) || { enabled: true, threshold: 0.75, mode: 'blocking' };
  const th = gcfg.threshold ?? 0.75;
  if (gcfg.enabled === false) {
    p2.forEach(x => jevDown.push({ ...x, verdict: { ...x.verdict, why: 'gate disabled → digest, flagged' } }));
    return { held, pingFromJev, jevDown, unscored };
  }
  const cap = cfg.v1_cap ?? 150;
  const capped = p2.slice(0, cap);
  const overflow = p2.slice(cap);   // FIX: was slice(20) → clusters 20..149 scored AND held
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
    const r = await jevFn(state, questions, { gate: GATE, action: 'triage' });
    capped.forEach((x, i) => {
      const p = r.answers?.[`c${i}`]?.noul ?? null;
      if (p === null) pingFromJev.push({ ...x, verdict: { ...x.verdict, why: 'jev-unparsed → escalated' } });
      else if (p >= th) held.push({ ...x, benignProb: p });
      else pingFromJev.push({ ...x, benignProb: p, verdict: { ...x.verdict, why: `jev scored novel (benign ${p.toFixed(2)} < ${th})` } });
    });
    overflow.forEach(x => {
      held.push({ ...x, benignProb: null, heldBy: 'batch-overflow' });
      unscored.push({ ts: new Date().toISOString(), reason: 'batch-overflow', sig: x.cluster.sig,
        source: x.cluster.source, program: x.cluster.program || '', count: x.cluster.count });
    });
  } catch (e) {
    // fail-open: Jev down → NOTHING is suppressed; everything surfaces (digest), ping only P0/P1
    console.error(`jev unavailable (${e.message}) — fail-open: no suppression this cycle`);
    p2.forEach(x => {
      jevDown.push({ ...x, verdict: { ...x.verdict, why: `jev down (${e.message.slice(0, 60)}) → held-visible, flagged` } });
      unscored.push({ ts: new Date().toISOString(), reason: 'jev-error', sig: x.cluster.sig,
        source: x.cluster.source, program: x.cluster.program || '', count: x.cluster.count });
    });
    logDecision({ gate: GATE, action: 'fail-open', pass: true, note: 'jev down; no suppression' });
  }
  return { held, pingFromJev, jevDown, unscored };
}

// ── delivery: mutes → repeat filter → P0-first cap → send → mark only on ok ──
export async function deliver(pingsRaw, { cfg, pingState, live = true, send = sendTelegram, now = Date.now(), cycleId = 'local' } = {}) {
  const repeatHours = ((cfg.pings?.repeat_hours ?? 4)) * 3600000;
  const maxPer = cfg.pings?.max_per_cycle ?? 10;
  const mutes = readMutes();
  const repeatHeld = [], muted = [], candidates = [];
  for (const x of pingsRaw) {
    const last = pingState.lastP1[x.cluster.sig];
    if (x.verdict.level !== 'P0' && last && now - last < repeatHours) {
      repeatHeld.push({ ...x, heldBy: 'repeat-suppressed', repeatOf: last });
      continue;
    }
    const until = muteUntil(mutes[x.cluster.sig]);
    if (x.verdict.level !== 'P0' && until && until > now) {   // P0 is NEVER muted
      muted.push({ ...x, heldBy: 'muted' });
      continue;
    }
    candidates.push(x);
  }
  const rank = { P0: 0, P1: 1, P2: 2 };
  candidates.sort((a, b) => (rank[a.verdict.level] ?? 3) - (rank[b.verdict.level] ?? 3));
  const capped = candidates.slice(0, maxPer);
  const overCap = candidates.slice(maxPer);
  const out = { candidates, sent: [], muted, repeatHeld, overCap, sendFailed: [], messageId: null, pingId: null };
  if (!live) return out;   // digest-only / dry run: classify only, no send, no marking
  if (!capped.length && !overCap.length) return out;
  out.pingId = Math.random().toString(36).slice(2, 6);
  const decidingMode = cfg.triage_mode === 'v2' ? 'v2' : 'v1';
  const items = capped.map((x, i) => ({ ...x, item_id: `${out.pingId}.${i + 1}` }));
  let body = items.map(x => pingMessage(x.cluster, x.verdict, { test: process.env.OPSWATCH_TEST === '1', tag: x.item_id })).join('\n\n———\n\n');
  if (overCap.length) {
    const top = overCap.slice(0, 5).map(x => `${x.cluster.source}/${x.cluster.program || '?'} ×${x.cluster.count}`).join(', ');
    body += `\n\n➕ +${overCap.length} more P2 clusters (top: ${top}) — in digest`;
  }
  body += `\n\n<i>Feedback: 👍 useful · 👎 noise · 🔕 mute 7d — or reply "ow noise ${out.pingId}"</i>`;
  try {
    const r = await send(body, { replyMarkup: feedbackKeyboard(out.pingId) });
    out.messageId = r?.result?.message_id ?? null;
    // mark-sent + ledger ONLY after Telegram ok — a failed send must never mute a sig for 4h
    for (const x of capped) pingState.lastP1[x.cluster.sig] = now;
    appendPingsRow({
      ts: new Date().toISOString(), ping_id: out.pingId, message_id: out.messageId, kind: 'ping', mode: decidingMode,
      items: items.map((x, i) => ({ item_id: `${out.pingId}.${i + 1}`, sig: x.cluster.sig,
        source: x.cluster.source, program: x.cluster.program || '', level: x.verdict.level,
        decision: x.verdict.why, mode: decidingMode, probs: null, confidence: null })),
    });
    out.sent = items;
    if (overCap.length) appendDigestQueue(overCap, 'over-cap', cycleId);   // visible in digest, NOT marked pinged
  } catch (e) {
    out.sendFailed = [...capped, ...overCap];
    appendDigestQueue(out.sendFailed, 'telegram-send-failed', cycleId);
    console.error(`telegram ping FAILED: ${String(e && e.message || e).slice(0, 150)}`);
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const windowMin = parseInt(args[(args.indexOf('--window-min') ?? -2) + 1]) || 5;
  const live = args.includes('--live');
  const digestOnly = args.includes('--digest-only');
  const stateFile = args.includes('--state-file') ? args[args.indexOf('--state-file') + 1] : null;
  if (!file) { console.error('usage: triage.mjs <events.jsonl> [--window-min N] [--live] [--digest-only]'); process.exit(1); }

  const cfg = loadOpsConfig();
  const cycleId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let pingState = { lastP1: {} };
  let offset = 0;
  if (stateFile) {
    try { const s = JSON.parse(readFileSync(stateFile, 'utf8')); pingState = { lastP1: s.lastP1 || {} }; offset = s.offset || 0; }
    catch { pingState = { lastP1: {} }; offset = 0; }
  }
  pingState.lastP1 = pingState.lastP1 || {};

  const stat = existsSync(file) ? statSync(file) : { size: 0 };
  if (stat.size < offset) offset = 0; // rotated/truncated
  // Bounded incremental read (2026-10-23): read only bytes [offset, end) instead of
  // slurping the whole file — readFileSync hit Node's ~512MB string limit once
  // events.jsonl grew past it and crashed every cycle (ERR_STRING_TOO_LONG).
  // 64MB cap/cycle ≈ 768MB/h at the 5-min cadence; a bigger burst just finishes next cycle.
  const READ_CAP = 64 * 1024 * 1024;
  const end = Math.min(stat.size, offset + READ_CAP);
  let rawLines = [];
  let consumed = 0;
  if (end > offset) {
    const buf = Buffer.alloc(end - offset);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
    // Keep only complete lines: cut at the last newline IN BYTE SPACE so the saved
    // offset always lands on a line boundary (receiver writes line + '\n' per event).
    // A torn last line (or cap-hit mid-line) is simply re-read next cycle.
    const nlByte = buf.lastIndexOf(0x0a);
    if (nlByte >= 0) {
      const lineBytes = buf.subarray(0, nlByte + 1);
      consumed = lineBytes.length;
      rawLines = lineBytes.toString('utf8').split('\n').filter(Boolean);
    }
  }
  const newOffset = offset + consumed;
  const events = parseEvents(rawLines);
  const { window, clusters, p0, p1, p2, p3 } = classify(events, { windowMin, mode: 'batch' });

  logDecision({ gate: GATE, action: 'deterministic-layer', pass: true,
    p0: p0.length, p1: p1.length, p2: p2.length, p3: p3.length, window });

  // ── Layer 2: Jev semantic scoring on P2 clusters ───────────────────────────
  const held = [];
  for (const x of p3) held.push({ ...x, benignProb: null, heldBy: 'deterministic-hum' });
  logDecision({ gate: GATE, action: 'hold-hum', pass: true, count: p3.length });
  const mode = cfg.triage_mode || 'v1';
  let v1 = { held: [], pingFromJev: [], jevDown: [], unscored: [] };
  let v2res = null;
  if (mode === 'v2') {
    // v2 decides; v1 not called (plan §3.10)
    try { v2res = await triageV2(p2, { cfg, window, cycleId, mode, windowMin, examples: EXAMPLES }); }
    catch (e) { console.error(`v2 triage FAILED (${e.message}) — fail-open: no suppression this cycle`); logDecision({ gate: GATE, action: 'v2-error', pass: false, error: String(e.message).slice(0, 120) }); p2.forEach(x => v1.jevDown.push({ ...x, verdict: { ...x.verdict, why: `v2 error (${String(e.message).slice(0, 40)}) → digest, flagged` } })); }
  } else {
    v1 = await jevScoreV1(p2, { cfg, windowMin });
    if (mode === 'shadow' && p2.length) {
      // SHADOW: v1 decided above; v2 runs on the SAME P2 set, ledger-only (plan §3.10).
      // Shadow failure must NEVER break the cycle — v1 already decided and deliver still runs.
      const v1Map = new Map();
      for (const h of v1.held) v1Map.set(h.cluster.sig, { decision: h.heldBy === 'batch-overflow' ? 'unscored' : 'hold', benignProb: h.benignProb });
      for (const p of v1.pingFromJev) v1Map.set(p.cluster.sig, { decision: 'ping', benignProb: p.benignProb });
      for (const j of v1.jevDown) v1Map.set(j.cluster.sig, { decision: 'digest', benignProb: null });
      try { v2res = await triageV2(p2, { cfg, window, cycleId, mode, v1Map, windowMin, examples: EXAMPLES }); }
      catch (e) { console.error(`v2 shadow FAILED (${e.message}) — v1 unaffected`); logDecision({ gate: GATE, action: 'v2-shadow-error', pass: false, error: String(e.message).slice(0, 120) }); }
    }
  }
  const pingItems = mode === 'v2'
    ? (v2res ? [...p2].filter(x => v2res.decisions.get(x.cluster.sig)?.decision === 'ping')
        .map(x => ({ ...x, verdict: { level: 'P2', why: `v2: ${v2res.decisions.get(x.cluster.sig).reason}` } })) : [])
    : v1.pingFromJev;
  const digestItems = mode === 'v2'
    ? (v2res ? [...p2].filter(x => ['digest', 'unscored'].includes(v2res.decisions.get(x.cluster.sig)?.decision)) : v1.jevDown)
    : v1.jevDown;
  const v2HoldItems = mode === 'v2'
    ? (v2res ? [...p2].filter(x => v2res.decisions.get(x.cluster.sig)?.decision === 'hold') : [])
    : [];
  held.push(...v1.held, ...v2HoldItems.map(x => ({ ...x, benignProb: null, heldBy: 'v2-jev-routine' })));

  // ── Ledger for held items ─────────────────────────────────────────────────
  for (const h of held) logDecision({ gate: GATE, action: 'hold-noise', pass: true, sig: h.cluster.sig,
    count: h.cluster.count, benignProb: h.benignProb, source: h.cluster.source, heldBy: h.heldBy || 'jev-benign' });

  // ── Deliver (mutes → repeat → cap → send → mark on ok) ────────────────────
  const pingsRaw = [...p0, ...p1, ...pingItems];
  const d = await deliver(pingsRaw, { cfg, pingState, live: live && !digestOnly, cycleId });

  // digest queue: v1 jevDown / v2 digest+unscored items (visible at 08:00, never silent)
  if (digestItems.length) appendDigestQueue(digestItems, mode === 'v2' ? 'v2-digest' : 'jev-down', cycleId);
  if (v1.unscored.length) { appendUnscored(v1.unscored); logDecision({ gate: GATE, action: 'unscored', pass: true, count: v1.unscored.length }); }
  if (mode === 'v2' && v2res?.overCap) {
    appendUnscored([...p2].filter(x => v2res.decisions.get(x.cluster.sig)?.decision === 'unscored')
      .map(x => ({ ts: new Date().toISOString(), reason: 'v2-cap', sig: x.cluster.sig,
        source: x.cluster.source, program: x.cluster.program || '', count: x.cluster.count })));
  }
  // v2 all-chunks-failed summary: ping OUTSIDE quiet hours, else digest-queue (quiet-hours rule)
  if (mode === 'v2' && v2res?.allFailed && p2.length) {
    const msg = `⚠️ ops-watch v2: Jev down — ${p2.length} P2 clusters unreviewed this cycle. Top: ${v2res.top5.join(', ')}`;
    if (!isQuietHoursCT(cfg)) {
      try { await sendTelegram(msg); logDecision({ gate: GATE, action: 'v2-down-summary', pass: true, delivered: true }); }
      catch (e) { appendDigestQueue([{ cluster: { sig: 'v2-jev-down', source: 'ops-watch', program: 'summary', count: p2.length, samples: [msg] } }], 'v2-down-summary-failed', cycleId); }
    } else {
      appendDigestQueue([{ cluster: { sig: 'v2-jev-down', source: 'ops-watch', program: 'summary', count: p2.length, samples: [msg] } }], 'v2-down-quiet-hours', cycleId);
      logDecision({ gate: GATE, action: 'v2-down-summary', pass: true, delivered: false, note: 'quiet hours → digest' });
    }
  }

  // history: record per-sig outcomes for v2 features (actual decisions of the acting mode)
  try {
    const heldSigs = new Set([...v1.held.map(h => h.cluster.sig), ...v2HoldItems.map(x => x.cluster.sig)]);
    const pingedSigs = new Set(d.sent.map(x => x.cluster.sig));
    const verdicts = new Map();
    if (v2res) for (const [sig, dec] of v2res.decisions) verdicts.set(sig, dec.decision);
    recordCycle(clusters, { heldSigs, pingedSigs, verdicts });
  } catch { /* history must never break a cycle */ }

  // ── held.jsonl audit (incl. muted) ────────────────────────────────────────
  const heldAll = [...held, ...d.muted];
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }
  appendFileSync(join(DATA_DIR, 'held.jsonl'), heldAll.map(h => JSON.stringify({ ts: new Date().toISOString(), cycle_id: cycleId, sig: h.cluster.sig,
    source: h.cluster.source, program: h.cluster.program, count: h.cluster.count,
    benignProb: h.benignProb, heldBy: h.heldBy || 'jev-benign', why: h.verdict?.why })).join('\n') + (heldAll.length ? '\n' : ''));

  // offset always advances (events are ledgered above); lastP1 reflects ONLY delivered pings
  if (stateFile) writeFileSync(stateFile, JSON.stringify({ offset: newOffset, lastP1: pingState.lastP1 }));

  const result = {
    cycle_id: cycleId, mode: cfg.triage_mode, window,
    counts: { clusters: clusters.length, p0: p0.length, p1: p1.length, jevPing: pingItems.length,
      held: heldAll.length + d.repeatHeld.length, jevDown: digestItems.length, repeatsHeld: d.repeatHeld.length,
      muted: d.muted.length, overCap: d.overCap.length, unscored: v1.unscored.length, sent: d.sent.length,
      v2_shadow_rows: v2res?.shadowRows ?? 0, v2_prestep: v2res?.prestepHeld ?? 0 },
    pings: d.sent.map(x => ({ level: x.verdict.level, why: x.verdict.why, source: x.cluster.source, program: x.cluster.program,
      count: x.cluster.count, host: x.cluster.host, sample: (x.cluster.samples[0] || '').slice(0, 160) })),
    held: [...d.repeatHeld.map(x => ({ sig: x.cluster.sig, benignProb: null, heldBy: 'repeat-suppressed', source: x.cluster.source, program: x.cluster.program, count: x.cluster.count, sample: (x.cluster.samples[0] || '').slice(0, 100) })), ...heldAll.map(x => ({ sig: x.cluster.sig, benignProb: x.benignProb, heldBy: x.heldBy || 'jev-benign', source: x.cluster.source, program: x.cluster.program,
      count: x.cluster.count, sample: (x.cluster.samples[0] || '').slice(0, 100) }))],
    jevDown: digestItems.map(x => ({ sig: x.cluster.sig, source: x.cluster.source, count: x.cluster.count })),
  };
  console.log(JSON.stringify(result, null, 2));

  if (d.sent.length) {
    console.error(`pinged ${d.sent.length} cluster(s) to Telegram`);
    // Analyst enrichment (Qwen3.8-27B-t8k via LiteLLM): pings already sent — this can only
    // ADD a follow-up assessment, never delay or suppress. Fail-open: null → skip silently.
    const tAssess = Date.now();
    const a = await assess(d.sent.slice(0, 10), { windowMin }).catch(() => null);
    if (a) {
      const lines = d.sent.slice(0, 10).map((x, i) => {
        const t = (a.assessments[`c${i}`] || '').trim();
        return t ? `▪ c${i} · ${esc(x.cluster.program || x.cluster.source || '?')}: ${esc(t)}` : null;
      }).filter(Boolean).join('\n\n');
      if (lines) {
        try {
          await sendTelegram(`🧠 <b>ops-watch assessment</b> (${esc(a.model)})\n\n${lines}`.slice(0, 3850));
          console.error(`assessment sent (${a.latencyMs}ms)`);
        } catch (e) {
          console.error(`assessment telegram FAILED: ${String(e && e.message || e).slice(0, 120)}`);
        }
      }
      logDecision({ gate: GATE, action: 'assess', pass: true, latency_ms: a.latencyMs, model: a.model });
    } else {
      logDecision({ gate: GATE, action: 'assess', pass: false, latency_ms: Date.now() - tAssess, note: 'disabled or fail-open (no assessment)' });
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
