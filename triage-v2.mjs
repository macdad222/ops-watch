// triage-v2.mjs — per-cluster Jev triage (v2). Plan §3.
// One Choice question per cluster, naming it, with code-computed features (Jev never counts)
// and per-family example situations. Decision bands are code; Jev only supplies probabilities.
// SHADOW mode: v1 decides; v2 runs on the same P2 set and writes ONLY the shadow ledger —
// it sends nothing and never touches pingState. Nothing is ever silently dropped:
// every cluster ends pinged / held / digest / unscored-with-reason.
import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub, ctWallTime, isQuietHoursCT } from './lib.mjs';
import { jevClassifyClusters as _defaultClassify, familyOf } from './jev-client.mjs';
import { loadHistory, features7d } from './history.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OPSWATCH_DATA_DIR || join(HERE, 'data');

function appendShadow(rows) {
  if (!rows.length) return;
  try { appendFileSync(join(DATA_DIR, 'jev-v2-shadow.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n'); }
  catch { /* ledger failure must never break the cycle */ }
}

// ── features (code-computed; §3.2) ───────────────────────────────────────────
export function buildFeatures(clusters, { window, cycleId, hist, windowMin = 5 } = {}) {
  return clusters.map((x, i) => {
    const c = x.cluster;
    const f7 = features7d(hist, c.sig);
    const baseline = f7.baseline_per_cycle_7d;
    return {
      id: `clusters[${i}]`,
      sig: c.sig,
      source: c.source,
      program: c.program || '',
      host: c.host || 'n/a',
      count_this_cycle: c.count,
      first_seen: c.first_seen,
      last_seen: c.last_seen,
      ct_last_seen: ctLabel(c.last_seen),
      ...f7,
      rate_vs_baseline: baseline ? +(c.count / baseline).toFixed(1) : 'new',
      distinct_users: c.distinct_users,
      distinct_ips: c.distinct_ips,
      samples: (c.samples || []).map(s => scrub(s).slice(0, 160)),
      window: { start: window?.start, end: window?.end, label_min: windowMin },
      cycle_id: cycleId,
    };
  });
}
function ctLabel(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return `${ctWallTime(d)} CT`;
  } catch { return null; }
}

// ── pre-step hold (§3.5 — no Jev call for well-known quiet sigs) ─────────────
export function prestepHold(features, { cfg } = {}) {
  const ps = cfg?.v2?.prestep || { enabled: true, min_held_7d: 3, max_rate_vs_baseline: 3 };
  const holds = [], rest = [];
  for (const f of features) {
    const quiet =
      ps.enabled !== false &&
      f.held_7d >= (ps.min_held_7d ?? 3) &&
      !/operational_fault|security_relevant/.test(String(f.last_verdict || '')) &&
      (f.rate_vs_baseline === 'new' ? false : f.rate_vs_baseline <= (ps.max_rate_vs_baseline ?? 3));
    // rate guard: a known sig spiking 10x still gets judged; 'new' sigs always get judged
    if (quiet) holds.push({ ...f, v2_decision: 'prestep', v2_reason: `v2-prestep: held ${f.held_7d}×/7d, rate ${f.rate_vs_baseline}× baseline, no adverse verdict` });
    else rest.push(f);
  }
  return { holds, rest };
}

// ── decision bands (§3.6) ────────────────────────────────────────────────────
export function decideBands(probs, confidence, cfg, source = '') {
  const b = cfg?.v2?.bands || {};
  const bySrc = cfg?.v2?.thresholds_by_source?.[source] || {};
  const secP = bySrc.security_ping_p ?? b.security_ping_p ?? 0.40;
  const secC = bySrc.security_min_conf ?? b.security_min_conf ?? 0.30;
  const faultP = bySrc.fault_ping_p ?? b.fault_ping_p ?? 0.60;
  const faultC = bySrc.fault_min_conf ?? b.fault_min_conf ?? 0.50;
  const rnP = bySrc.routine_hold_p ?? b.routine_hold_p ?? 0.75;
  const rnC = bySrc.routine_min_conf ?? b.routine_min_conf ?? 0.60;
  const ecP = bySrc.expected_change_p ?? b.expected_change_p ?? 0.60;
  const p = k => probs?.[k] ?? 0;
  const argmax = Object.entries(probs || {}).sort((a, b2) => b2[1] - a[1])[0]?.[0] || null;
  if (p('security_relevant') >= secP && confidence >= secC)
    return { decision: 'ping', reason: `security_relevant p=${p('security_relevant').toFixed(2)} ≥ ${secP} (conf ${confidence.toFixed(2)})` };
  if (p('operational_fault') >= faultP && confidence >= faultC)
    return { decision: 'ping', reason: `operational_fault p=${p('operational_fault').toFixed(2)} ≥ ${faultP} (conf ${confidence.toFixed(2)})` };
  if (argmax === 'routine_noise' && p('routine_noise') >= rnP && confidence >= rnC)
    return { decision: 'hold', reason: `routine_noise p=${p('routine_noise').toFixed(2)} ≥ ${rnP} (conf ${confidence.toFixed(2)})` };
  if (argmax === 'expected_change' && p('expected_change') >= ecP)
    return { decision: 'digest', reason: `expected_change p=${p('expected_change').toFixed(2)} ≥ ${ecP}` };
  return { decision: 'digest', reason: `uncertain (argmax=${argmax}, p_rn=${p('routine_noise').toFixed(2)}, conf ${confidence.toFixed(2)})` };
}

// ── main v2 pass over a P2 set ───────────────────────────────────────────────
// mode 'shadow': ledger only. mode 'v2': returns decisions that triage.mjs acts on.
// v1Map: Map(sig → {decision, benignProb}) from the v1 pass (shadow comparison).
export async function triageV2(p2, { cfg, window, cycleId, mode = 'shadow', v1Map = null, windowMin = 5, examples = null, classifyFn = _defaultClassify } = {}) {
  const t0 = Date.now();
  const hist = loadHistory();
  const features = buildFeatures(p2, { window, cycleId, hist, windowMin });
  const { holds, rest } = prestepHold(features, { cfg });

  const maxClusters = cfg?.v2?.max_clusters_per_cycle ?? 300;
  const scored = rest.slice(0, maxClusters);
  const overCap = rest.slice(maxClusters);

  const shadowRows = [];
  const decisions = new Map();   // sig → {decision, reason, probs, confidence}
  for (const f of holds) decisions.set(f.sig, { decision: 'hold', reason: f.v2_reason, probs: null, confidence: null, prestep: true });

  let allFailed = false;
  if (scored.length) {
    const state = {
      cycle: {
        window_start: window?.start, window_end: window?.end,
        ct_time: `${ctWallTime()} CT`, cycle_id: cycleId,
        batch_events: p2.reduce((n, x) => n + (x.cluster?.count || 0), 0),
      },
      clusters: scored,
    };
    const callLog = [];
    const { results, calls } = await classifyFn(state, scored, {
      cfg, gate: 'security-triage', examples,
      log: row => callLog.push(row),
    });
    for (const row of calls) {
      appendShadow([{ ts: new Date().toISOString(), cycle_id: cycleId, mode, ...row }]);
    }
    const terminal = calls.filter(c => c.type === 'call' && c.retry === undefined);
    allFailed = scored.length > 0 && terminal.length > 0 && terminal.every(c => !c.ok);
    for (const f of scored) {
      const r = results.get(f.id) ?? null;
      let v2dec;
      if (!r) {
        v2dec = { decision: 'unscored', reason: 'jev error/unparsed after retry', probs: null, confidence: null, error: true };
      } else {
        const band = decideBands(r.probs, r.confidence, cfg, f.source);
        v2dec = { decision: band.decision, reason: band.reason, probs: r.probs, confidence: r.confidence };
      }
      decisions.set(f.sig, v2dec);
      const v1 = v1Map?.get(f.sig) || null;
      shadowRows.push({
        ts: new Date().toISOString(), cycle_id: cycleId, mode,
        sig: f.sig, source: f.source, program: f.program, count: f.count_this_cycle,
        chunk: r.chunk ?? null,
        features: f,
        probs: v2dec.probs, confidence: v2dec.confidence,
        v2_decision: v2dec.decision, v2_reason: v2dec.reason,
        v1_decision: v1?.decision ?? null, v1_benignProb: v1?.benignProb ?? null,
        error: v2dec.error ? v2dec.reason : null,
      });
    }
    // over-cap: unscored with reason, still visible via digest queue (triage.mjs queues them)
    for (const f of overCap) {
      decisions.set(f.sig, { decision: 'unscored', reason: `v2-cap (${overCap.length} beyond ${maxClusters})`, probs: null, confidence: null });
      shadowRows.push({ ts: new Date().toISOString(), cycle_id: cycleId, mode, sig: f.sig, source: f.source, program: f.program,
        count: f.count_this_cycle, features: f, probs: null, confidence: null,
        v2_decision: 'unscored', v2_reason: `v2-cap beyond ${maxClusters}`, v1_decision: v1Map?.get(f.sig)?.decision ?? null, v1_benignProb: null, error: 'v2-cap' });
    }
  } else {
    for (const f of overCap) {
      decisions.set(f.sig, { decision: 'unscored', reason: `v2-cap beyond ${maxClusters}`, probs: null, confidence: null });
    }
  }

  // prestep rows → shadow ledger too (they are v2 decisions)
  for (const f of holds) {
    const v1 = v1Map?.get(f.sig) || null;
    shadowRows.push({ ts: new Date().toISOString(), cycle_id: cycleId, mode, sig: f.sig, source: f.source, program: f.program,
      count: f.count_this_cycle, features: f, probs: null, confidence: null,
      v2_decision: 'prestep', v2_reason: f.v2_reason, v1_decision: v1?.decision ?? null, v1_benignProb: v1?.benignProb ?? null, error: null });
  }
  appendShadow(shadowRows);

  return {
    decisions,
    shadowRows: shadowRows.length,
    prestepHeld: holds.length,
    scored: scored.length,
    overCap: overCap.length,
    allFailed,
    latency_ms: Date.now() - t0,
    failedCount: [...decisions.values()].filter(d => d.error).length,
    top5: [...p2].sort((a, b) => b.cluster.count - a.cluster.count).slice(0, 5)
      .map(x => `${x.cluster.source}/${x.cluster.program || '?'} ×${x.cluster.count}`),
  };
}
