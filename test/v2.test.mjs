// test/v2.test.mjs — v2 module tests: bands, prestep, chunking/retry/split, history. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'opswatch-v2-test-'));
process.env.OPSWATCH_DATA_DIR = TMP;
const lib = await import('../lib.mjs');
const v2 = await import('../triage-v2.mjs');
const client = await import('../jev-client.mjs');
const history = await import('../history.mjs');

const CFG = lib.loadOpsConfig(join(TMP, 'missing.json'));
const P = (rn, ec, of, sr) => ({ routine_noise: rn, expected_change: ec, operational_fault: of, security_relevant: sr });

test('bands: table-driven', () => {
  const d = (probs, conf, src) => v2.decideBands(probs, conf, CFG, src);
  // security bias: 0.40 threshold, low conf gate 0.30
  assert.equal(d(P(0.3, 0.1, 0.2, 0.4), 0.35).decision, 'ping');
  assert.equal(d(P(0.3, 0.1, 0.2, 0.4), 0.25).decision, 'digest', 'conf < 0.30 → not a security ping');
  assert.equal(d(P(0.35, 0.05, 0.15, 0.45), 0.5).decision, 'ping');
  // fault: 0.60 + conf 0.50
  assert.equal(d(P(0.1, 0.05, 0.65, 0.2), 0.55).decision, 'ping');
  assert.equal(d(P(0.1, 0.05, 0.65, 0.2), 0.45).decision, 'digest', 'conf < 0.50 → uncertain');
  // routine hold: argmax rn, p ≥ 0.75, conf ≥ 0.60
  assert.equal(d(P(0.9, 0.02, 0.05, 0.03), 0.8).decision, 'hold');
  assert.equal(d(P(0.9, 0.02, 0.05, 0.03), 0.5).decision, 'digest', 'low conf routine → uncertain digest');
  // expected_change digest
  assert.equal(d(P(0.2, 0.7, 0.05, 0.05), 0.6).decision, 'digest');
  // uncertain fallback
  assert.equal(d(P(0.4, 0.3, 0.2, 0.1), 0.3).decision, 'digest');
  // per-source override
  const cfg2 = { v2: { bands: {}, thresholds_by_source: { fortigate: { security_ping_p: 0.7 } } } };
  assert.equal(v2.decideBands(P(0.3, 0.1, 0.2, 0.5), 0.5, cfg2, 'fortigate').decision, 'digest', 'override raises security bar');
  assert.equal(v2.decideBands(P(0.3, 0.1, 0.2, 0.5), 0.5, cfg2, 'sshd').decision, 'ping', 'other sources keep default');
});

function mkFeature(i, over = {}) {
  return { id: `clusters[${i}]`, sig: `sig${i}`, source: 'fortigate', program: 'traffic', host: 'h',
    count_this_cycle: 10, first_seen: 'x', last_seen: 'x', ct_last_seen: '12:00 CT',
    seen_last_7d: true, seen_7d_count: 20, days_seen_7d: 5, baseline_per_cycle_7d: 10,
    rate_vs_baseline: 1, held_7d: 5, pinged_7d: 0, last_verdict: null, distinct_users: 0, distinct_ips: 1,
    samples: ['sample'], window: {}, cycle_id: 'c1', ...over };
}

test('prestep: quiet known sigs held without Jev; spikes/new/adverse still judged', () => {
  const { holds, rest } = v2.prestepHold([
    mkFeature(0),                                                   // held 5×, rate 1 → prestep hold
    mkFeature(1, { rate_vs_baseline: 10 }),                         // spike → judged
    mkFeature(2, { held_7d: 2 }),                                   // < min_held_7d → judged
    mkFeature(3, { rate_vs_baseline: 'new' }),                      // new sig → judged
    mkFeature(4, { last_verdict: 'operational_fault p=0.8' }),      // adverse verdict → judged
    mkFeature(5, { held_7d: 3, rate_vs_baseline: 3 }),              // boundary → hold
  ], { cfg: CFG });
  assert.deepEqual(holds.map(h => h.sig), ['sig0', 'sig5']);
  assert.deepEqual(rest.map(h => h.sig), ['sig1', 'sig2', 'sig3', 'sig4']);
  assert.ok(holds[0].v2_reason.includes('v2-prestep'));
});

test('jev-client: chunking + per-cluster answers + call rows', async () => {
  const clusters = Array.from({ length: 75 }, (_, i) => mkFeature(i, { sig: `c${i}`, id: `clusters[${i}]` }));
  const seen = [];
  const fakeJev = async (state, questions) => {
    seen.push(Object.keys(questions).length);
    return { model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 50 },
      answers: Object.fromEntries(Object.keys(questions).map((k, i) => [k, {
        type: 'choice', choice: 'routine_noise', confidence: 0.8,
        probabilities: { routine_noise: 0.7 + i * 0.001, expected_change: 0.1, operational_fault: 0.1, security_relevant: 0.1 } }])) };
  };
  const r = await client.jevClassifyClusters({ cycle: {} }, clusters, { cfg: { ...CFG, v2: { ...CFG.v2, chunk_size: 30 } }, jevFn: fakeJev });
  assert.deepEqual(seen, [30, 30, 15], 'chunks of 30');
  assert.equal(r.results.size, 75);
  assert.ok(r.results.get('clusters[0]').probs.routine_noise >= 0.7, 'probabilities preserved per cluster');
  assert.equal(r.calls.filter(c => c.ok).length, 3);
  assert.ok(r.calls.every(c => c.tokens_in === 100));
});

test('jev-client: retry on 429 then success', async () => {
  const clusters = [mkFeature(0, { sig: 'r0', id: 'clusters[0]' })];
  let n = 0;
  const flaky = async () => {
    if (n++ === 0) { const e = new Error('jev HTTP 429: slow down'); e.status = 429; throw e; }
    return { model: 'm', usage: {}, answers: { q0: { type: 'choice', choice: 'routine_noise', confidence: 0.9,
      probabilities: { routine_noise: 0.95, expected_change: 0.02, operational_fault: 0.02, security_relevant: 0.01 } } } };
  };
  const r = await client.jevClassifyClusters({ cycle: {} }, clusters, { cfg: { ...CFG, v2: { ...CFG.v2, backoff_ms: 1 } }, jevFn: flaky });
  assert.equal(r.results.get('clusters[0]').probs.routine_noise, 0.95);
  assert.equal(r.calls.filter(c => c.retry).length, 1);
  assert.equal(r.calls.filter(c => c.ok).length, 1);
});

test('jev-client: token-limit error splits chunk in half', async () => {
  const clusters = Array.from({ length: 4 }, (_, i) => mkFeature(i, { sig: `s${i}`, id: `clusters[${i}]` }));
  const sizes = [];
  const splitFail = async (state, questions) => {
    sizes.push(Object.keys(questions).length);
    if (Object.keys(questions).length >= 4) { const e = new Error('jev HTTP 400: max_tokens_exceeded'); e.status = 400; e.body = 'max_tokens_exceeded'; throw e; }
    return { model: 'm', usage: {}, answers: Object.fromEntries(Object.keys(questions).map(k => [k, {
      type: 'choice', choice: 'routine_noise', confidence: 0.7,
      probabilities: { routine_noise: 0.8, expected_change: 0.1, operational_fault: 0.05, security_relevant: 0.05 } }])) };
  };
  const r = await client.jevClassifyClusters({ cycle: {} }, clusters, { cfg: { ...CFG, v2: { ...CFG.v2, chunk_size: 4, retries: 0 } }, jevFn: splitFail });
  assert.deepEqual(sizes.sort((a, b) => b - a), [4, 2, 2]);
  assert.equal(r.results.size, 4);
});

test('history: recordCycle → features7d math', () => {
  const f = join(TMP, 'hist-test.json');
  rmSync(f, { force: true });
  const clusters = [{ sig: 'sigA', count: 40 }, { sig: 'sigB', count: 5 }];
  history.recordCycle(clusters, { heldSigs: new Set(['sigA']), pingedSigs: new Set(['sigB']), verdicts: new Map([['sigA', 'hold']]) }, f);
  history.recordCycle(clusters, {}, f);
  const hist = history.loadHistory(f);
  const fa = history.features7d(hist, 'sigA');
  assert.equal(fa.seen_7d_count, 2, 'two cycles seen');
  assert.equal(fa.baseline_per_cycle_7d, 40, 'mean count per cycle');
  assert.equal(fa.held_7d, 1);
  assert.equal(fa.last_verdict, 'hold');
  const fb = history.features7d(hist, 'sigB');
  assert.equal(fb.pinged_7d, 1);
  assert.equal(fb.days_seen_7d, 1);
});

test('history: bootstrap from held.jsonl', () => {
  const held = join(TMP, 'held-boot.jsonl');
  writeFileSync(held, [
    JSON.stringify({ ts: '2026-10-20T12:00:00Z', sig: 'boot1', source: 'fortigate', count: 500, heldBy: 'jev-benign' }),
    JSON.stringify({ ts: '2026-10-21T12:00:00Z', sig: 'boot1', source: 'fortigate', count: 600, heldBy: 'jev-benign' }),
    JSON.stringify({ ts: '2026-10-22T12:00:00Z', sig: 'boot2', source: 'sshd', count: 12, heldBy: 'deterministic-hum' }),
  ].join('\n') + '\n');
  const out = join(TMP, 'boot-stats.json');
  const r = history.bootstrapFromHeld({ heldPath: held, outPath: out });
  assert.equal(r.rows, 3);
  const hist = history.loadHistory(out);
  const fb = history.features7d(hist, 'boot1');
  assert.equal(fb.held_7d, 2);
  assert.equal(fb.seen_7d_count, 2);
  assert.equal(fb.baseline_per_cycle_7d, 550);
});

test('triageV2 shadow: rows written, decisions ledger-only, no send impact', async () => {
  const shadowFile = join(TMP, 'jev-v2-shadow.jsonl');
  rmSync(shadowFile, { force: true });
  const p2 = [
    { cluster: { sig: 'sh1', count: 20, source: 'fortigate', program: 'traffic', host: 'h', distinct_users: 0, distinct_ips: 2,
      first_seen: '2026-10-23T12:00:00Z', last_seen: '2026-10-23T12:04:00Z', samples: ['deny hum 203.0.113.5'] }, verdict: { level: 'P2', why: 'none' } },
    { cluster: { sig: 'sh2', count: 4, source: 'sshd', program: 'sshd', host: 'h', distinct_users: 3, distinct_ips: 1,
      first_seen: '2026-10-23T12:00:00Z', last_seen: '2026-10-23T12:04:00Z', samples: ['Failed password for admin from 198.51.100.9'] }, verdict: { level: 'P2', why: 'none' } },
  ];
  const v1Map = new Map([['sh1', { decision: 'hold', benignProb: 0.9 }], ['sh2', { decision: 'ping', benignProb: 0.2 }]]);
  const cfg = { ...CFG, v2: { ...CFG.v2, prestep: { enabled: false } } };
  const fakeJev = async (state, questions) => ({
    model: 'jev-1.13.0', usage: { input_tokens: 200, output_tokens: 80 },
    answers: {
      q0: { type: 'choice', choice: 'routine_noise', confidence: 0.85,
        probabilities: { routine_noise: 0.9, expected_change: 0.04, operational_fault: 0.03, security_relevant: 0.03 } },
      q1: { type: 'choice', choice: 'security_relevant', confidence: 0.7,
        probabilities: { routine_noise: 0.05, expected_change: 0.05, operational_fault: 0.1, security_relevant: 0.8 } },
    },
  });
  // inject the fake classifier directly (ESM namespace is frozen — no monkey-patching)
  const orig = client.jevClassifyClusters;
  const r = await v2.triageV2(p2, { cfg, window: { start: 'a', end: 'b' }, cycleId: 'cyc1', mode: 'shadow', v1Map, windowMin: 5, examples: { families: {} }, classifyFn: async (state, clusters, opts) => orig(state, clusters, { ...opts, jevFn: fakeJev }) });
  assert.equal(r.shadowRows, 2);
  assert.equal(r.decisions.get('sh1').decision, 'hold');
  assert.equal(r.decisions.get('sh2').decision, 'ping');
  const rows = readFileSync(shadowFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(x => x.type === 'call').length, 1);
  const clusterRows = rows.filter(x => x.sig);
  assert.ok(clusterRows.every(x => x.v1_decision !== null), 'v1 comparison recorded');
  assert.equal(clusterRows.find(x => x.sig === 'sh1').v1_benignProb, 0.9);
});
