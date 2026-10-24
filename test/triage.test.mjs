// test/triage.test.mjs — ops-watch v2 unit tests (plan §7). No Telegram, no Jev API.
// Run: node --test test/
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect data dir BEFORE importing the module under test
const TMP = mkdtempSync(join(tmpdir(), 'opswatch-test-'));
process.env.OPSWATCH_DATA_DIR = TMP;
process.env.OPSWATCH_DISABLE_QWEN = '1';   // card tests never touch the network
const triage = await import('../triage.mjs');
const lib = await import('../lib.mjs');

const CFG = lib.loadOpsConfig(join(TMP, 'no-such-config.json')); // defaults
// v3: card rater injected — rate everything worth_a_look so the volume flag never diverts
const worthFn = async groups => groups.map(g => ({ ...g, rating: 'worth_a_look', headline: 'h', next_step: '', confidence: 0.7, qwen: true, fallback: false }));
function mkCluster(i, { count = 3, source = 'fortigate', program = 'traffic', level = 'P2' } = {}) {
  return { cluster: { sig: `sig${i}`, count, source, program, host: 'h', distinct_users: 1, distinct_ips: 2,
    first_seen: '2026-10-23T12:00:00Z', last_seen: '2026-10-23T12:04:00Z', samples: [`sample ${i} line`] },
    verdict: { level, why: `why ${i}` } };
}
const fakeJev = (state, questions) => ({
  answers: Object.fromEntries(Object.keys(questions).map(k => [k, { noul: 0.9 }])),
});

test('slicing: 200 synthetic P2 → 150 scored, 50 unscored, 0 double-counted', async () => {
  const p2 = Array.from({ length: 200 }, (_, i) => mkCluster(i));
  const r = await triage.jevScoreV1(p2, { cfg: CFG, windowMin: 5, jevFn: fakeJev, gateCfg: { enabled: true, threshold: 0.75 } });
  assert.equal(r.held.length, 200);            // 150 jev-benign + 50 batch-overflow (all held, none pinged)
  assert.equal(r.held.filter(h => h.heldBy === 'batch-overflow').length, 50);
  assert.equal(r.held.filter(h => h.heldBy !== 'batch-overflow').length, 150);
  assert.equal(r.unscored.length, 50);
  assert.ok(r.unscored.every(u => u.reason === 'batch-overflow'));
  // 0 double-counted: each sig appears exactly once across held+ping+jevDown
  const seen = new Map();
  for (const h of [...r.held, ...r.pingFromJev, ...r.jevDown]) seen.set(h.cluster.sig, (seen.get(h.cluster.sig) || 0) + 1);
  assert.ok([...seen.values()].every(n => n === 1), 'no cluster handled twice');
});

test('clusterEvents batch mode: events spanning 40 min all clustered', () => {
  const t0 = Date.parse('2026-10-23T12:00:00Z');
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const events = [];
  for (let m = 0; m <= 40; m += 10) {
    events.push({ source: 'syslog', host: 'h', program: 'app', ts: new Date(t0 + m * 60000).toISOString(),
      message: `event ${words[m / 10]} marker`, fields: {}, received_at: new Date(t0 + m * 60000).toISOString(), raw: 'x' });
  }
  for (const e of events) e.sig = lib.signature(e);   // raw fixtures bypass normalizeLine → set sig explicitly
  const { window, clusters } = lib.clusterEvents(events, 5, { mode: 'batch' });
  assert.equal(clusters.length, events.length, 'no event dropped by window filter');
  assert.equal(window.start, events[0].ts);
  assert.equal(window.end, events.at(-1).ts);
  assert.equal(window.label_min, 5);
  // window mode still filters (old behavior preserved for direct callers)
  const w = lib.clusterEvents(events, 5, { mode: 'window' });
  assert.ok(w.clusters.length < events.length);
});

test('cluster-mode knob: v1/shadow decision path = window (default), batch opt-in, v2 always batch', () => {
  assert.equal(triage.decisionClusterMode({ triage_mode: 'v1' }), 'window');
  assert.equal(triage.decisionClusterMode({ triage_mode: 'shadow' }), 'window');
  assert.equal(triage.decisionClusterMode({ triage_mode: 'shadow', v1_cluster_mode: 'batch' }), 'batch');
  assert.equal(triage.decisionClusterMode({ triage_mode: 'v1', v1_cluster_mode: 'batch' }), 'batch');
  assert.equal(triage.decisionClusterMode({ triage_mode: 'v2' }), 'batch');
  assert.equal(triage.decisionClusterMode({ triage_mode: 'v2', v1_cluster_mode: 'window' }), 'batch');
  assert.equal(triage.decisionClusterMode({}), 'window');   // no cfg → v1 default, window
});

test('shadow dual sets: v1 decides on window, v2 shadow gets full batch; knob batch reuses one set', () => {
  const t0 = Date.parse('2026-10-23T12:00:00Z');
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const events = [];
  for (let m = 0; m <= 40; m += 10) {
    events.push({ source: 'syslog', host: 'h', program: 'app', ts: new Date(t0 + m * 60000).toISOString(),
      message: `event ${words[m / 10]} marker`, fields: {}, received_at: new Date(t0 + m * 60000).toISOString(), raw: 'x' });
  }
  for (const e of events) e.sig = lib.signature(e);   // raw fixtures bypass normalizeLine → set sig explicitly
  // shadow + default knob → window decision set, full-batch shadow set
  const s = triage.cycleClusterSets(events, { cfg: { triage_mode: 'shadow' }, windowMin: 5 });
  assert.equal(s.decMode, 'window');
  assert.ok(s.dec.clusters.length < s.shadow.clusters.length, 'decision set smaller than batch shadow set');
  assert.equal(s.shadow.clusters.length, events.length, 'shadow set covers whole batch');
  // v1 mode → no shadow set
  const v1s = triage.cycleClusterSets(events, { cfg: { triage_mode: 'v1' }, windowMin: 5 });
  assert.equal(v1s.decMode, 'window');
  assert.equal(v1s.shadow, null);
  // knob batch → decision set IS the batch, no separate shadow set
  const bs = triage.cycleClusterSets(events, { cfg: { triage_mode: 'shadow', v1_cluster_mode: 'batch' }, windowMin: 5 });
  assert.equal(bs.decMode, 'batch');
  assert.equal(bs.shadow, null);
  assert.equal(bs.dec.clusters.length, events.length);
  // v2 → batch decision set, no shadow set
  const v2s = triage.cycleClusterSets(events, { cfg: { triage_mode: 'v2' }, windowMin: 5 });
  assert.equal(v2s.decMode, 'batch');
  assert.equal(v2s.shadow, null);
});

test('send-path failure: lastP1 unchanged, no pings.jsonl row, items queued to digest', async () => {
  const pingState = { lastP1: {} };
  const pings = [mkCluster(1), mkCluster(2)];
  const failingSend = async () => { throw new Error('telegram 500'); };
  const d = await triage.deliver(pings, { cfg: CFG, pingState, live: true, send: failingSend, rateFn: worthFn });
  assert.equal(d.sent.length, 0);
  assert.deepEqual(pingState.lastP1, {}, 'failed send must NOT mark suppression');
  assert.equal(existsSync(join(TMP, 'pings.jsonl')), false, 'no pings.jsonl row on failure');
  assert.equal(d.sendFailed.length, 2);
  const q = readFileSync(join(TMP, 'digest-queue.jsonl'), 'utf8').trim().split('\n');
  assert.equal(q.length, 2);
  assert.ok(q.every(r => JSON.parse(r).reason === 'telegram-send-failed'));
});

test('send-path cap: 14 cards → 10 card-messages sent + overflow line, 4 queued, only 10 marked', async () => {
  const pingState = { lastP1: {} };
  const pings = Array.from({ length: 14 }, (_, i) => mkCluster(i, { source: `src${i}`, program: `prog${i}` }));   // 14 distinct services → 14 cards
  const sends = [];
  const okSend = async (body) => { sends.push(body); return { result: { message_id: 12345 + sends.length } }; };
  const d = await triage.deliver(pings, { cfg: CFG, pingState, live: true, send: okSend, rateFn: worthFn });
  assert.equal(d.sent.length, 10);
  assert.equal(d.overCap.length, 4);
  assert.equal(sends.length, 10, 'one message per card, capped');
  assert.ok(sends.at(-1).includes('+4 more to check'), 'plain overflow line on last message');
  assert.ok(sends.at(-1).includes('8am digest'));
  assert.ok(!sends.some(b => b.includes('ow noise')), 'old feedback footer gone');
  assert.ok(!sends.some(b => b.includes('useful ·')), 'old feedback footer gone');
  assert.ok(sends.every(b => !b.includes('ops-watch —')), 'no message-level header');
  assert.equal(Object.keys(pingState.lastP1).length, 10, 'only delivered pings marked');
  const row = JSON.parse(readFileSync(join(TMP, 'pings.jsonl'), 'utf8').trim());
  assert.equal(row.kind, 'ping');
  assert.equal(row.items.length, 10);
  assert.ok(row.message_id != null);
  assert.ok(Array.isArray(row.cards) && row.cards.length === 10, 'cards mapping recorded');
  const q = readFileSync(join(TMP, 'digest-queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(q.filter(r => r.reason === 'over-cap').length, 4);
});

test('mutes: muted sig not pinged, P0 still pings, expired mute ignored', async () => {
  const now = Date.now();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(TMP, 'mutes.json'), JSON.stringify({ sig1: now + 3600000, sig2: now - 1000 }));
  const pingState = { lastP1: {} };
  const pings = [
    mkCluster(1, { level: 'P1' }),                       // sig1 → muted
    mkCluster(2, { level: 'P1' }),                       // sig2 → expired mute → pinged
    { ...mkCluster(1), verdict: { level: 'P0', why: 'honeytoken' } }, // sig1 P0 → NEVER muted
  ];
  const d = await triage.deliver(pings, { cfg: CFG, pingState, live: false });
  assert.deepEqual(d.muted.map(x => x.cluster.sig), ['sig1']);
  assert.equal(d.candidates.length, 2, 'expired-mute P1 + P0 remain candidates');
  assert.ok(d.candidates.some(x => x.verdict.level === 'P0' && x.cluster.sig === 'sig1'), 'P0 bypasses mute');
  rmSync(join(TMP, 'mutes.json'));
});

test('repeat suppression: recent lastP1 held, P0 always re-pings', async () => {
  const now = Date.now();
  const pingState = { lastP1: { sig1: now - 3600000 } }; // 1h ago < 4h
  const pings = [mkCluster(1), { ...mkCluster(1), verdict: { level: 'P0', why: 'honeytoken' } }];
  const d = await triage.deliver(pings, { cfg: CFG, pingState, live: false });
  assert.equal(d.repeatHeld.length, 1);
  assert.equal(d.candidates.length, 1);
  assert.equal(d.candidates[0].verdict.level, 'P0');
});

test('config loader: defaults on missing file, deep-merge on real file', () => {
  const def = lib.loadOpsConfig(join(TMP, 'definitely-missing.json'));
  assert.equal(def.triage_mode, 'v1');
  assert.equal(def.v1_cap, 150);
  assert.equal(def.pings.max_per_cycle, 10);
  const custom = join(TMP, 'cfg.json');
  writeFileSync(custom, JSON.stringify({ triage_mode: 'shadow', v1_cap: 99 }));
  const c = lib.loadOpsConfig(custom);
  assert.equal(c.triage_mode, 'shadow');
  assert.equal(c.v1_cap, 99);
  assert.equal(c.pings.max_per_cycle, 10, 'unspecified keys keep defaults');
});

test('quiet hours CT: 01:30 CT quiet, 12:35 CT not, boundaries', () => {
  const cfg = { quiet_hours_ct: { start: '00:00', end: '06:00' } };
  // 2026-10-23 06:30 UTC = 01:30 CDT (UTC-5 in October)
  assert.equal(lib.isQuietHoursCT(cfg, new Date('2026-10-23T06:30:00Z')), true);
  assert.equal(lib.isQuietHoursCT(cfg, new Date('2026-10-23T17:35:00Z')), false); // 12:35 CDT
  assert.equal(lib.isQuietHoursCT(cfg, new Date('2026-10-23T05:59:00Z')), true);  // 00:59 CDT
  assert.equal(lib.isQuietHoursCT(cfg, new Date('2026-10-23T11:00:00Z')), false); // 06:00 CDT boundary (end exclusive)
});

// ── Buzz relay known-hum (2026-10-24) ────────────────────────────────────────
function mkBuzzCluster(rawLines, program = 'buzz-prod-relay-1') {
  return {
    sig: 'buzzsig', count: rawLines.length, source: 'loki', program, host: 'agent-server',
    distinct_users: 0, distinct_ips: 1, first_seen: 'x', last_seen: 'x',
    samples: rawLines.slice(0, 3),
    events: rawLines.map(raw => ({ raw, fields: {} })),
  };
}
const buzzRaw = (message, fields = {}) =>
  JSON.stringify({ timestamp: '2026-10-24T21:03:07Z', level: 'INFO', message, target: 'buzz_relay::connection', ...fields });

test('buzz relay lifecycle churn → deterministic hum (held, not pinged)', () => {
  const honey = {};
  // each observed lifecycle message type → P3
  for (const raw of [
    buzzRaw('WebSocket connection closed', { conn_id: 'c-1', addr: '192.168.5.50:49232' }),
    buzzRaw('WebSocket connection established', { conn_id: 'c-2', addr: '192.168.5.50:49240' }),
    buzzRaw('3 missed pongs — closing connection', { level: 'WARN' }),
    buzzRaw('NIP-42 auth successful', { conn_id: 'c-3', pubkey: 'd52d69fc' }),
    buzzRaw('Event ingested via pipeline', { event_id: 'e-1', kind: 30003, target: 'buzz_relay::handlers::ingest' }),
    buzzRaw('HTTP bridge request', { pubkey: 'd52d69fc', route: '/events', status: 200, accepted: true, target: 'buzz_relay::api::bridge' }),
  ]) {
    const v = lib.deterministicVerdict(mkBuzzCluster([raw]), honey);
    assert.equal(v.level, 'P3', `expected hum for: ${raw.slice(0, 80)}`);
    assert.match(v.why, /buzz relay/);
  }
  // mixed all-lifecycle cluster → hum
  const v = lib.deterministicVerdict(mkBuzzCluster([
    buzzRaw('WebSocket connection established', { conn_id: 'c-4' }),
    buzzRaw('WebSocket connection closed', { conn_id: 'c-4' }),
  ]), honey);
  assert.equal(v.level, 'P3');
});

test('buzz relay errors still surface (no hum)', () => {
  const honey = {};
  // ERROR-level line → not hum
  let v = lib.deterministicVerdict(mkBuzzCluster([buzzRaw('WebSocket connection closed', { level: 'ERROR' })]), honey);
  assert.notEqual(v.level, 'P3');
  // failed bridge request (accepted:false) → not hum
  v = lib.deterministicVerdict(mkBuzzCluster([buzzRaw('HTTP bridge request', { route: '/events', status: 500, accepted: false })]), honey);
  assert.notEqual(v.level, 'P3');
  // non-2xx bridge status → not hum
  v = lib.deterministicVerdict(mkBuzzCluster([buzzRaw('HTTP bridge request', { route: '/events', status: 429, accepted: false })]), honey);
  assert.notEqual(v.level, 'P3');
  // mixed cluster with one error line → whole cluster surfaces
  v = lib.deterministicVerdict(mkBuzzCluster([
    buzzRaw('WebSocket connection established', { conn_id: 'c-5' }),
    buzzRaw('handler panicked', { level: 'ERROR', target: 'buzz_relay::handlers' }),
  ]), honey);
  assert.notEqual(v.level, 'P3');
  // other programs with the same text are unaffected
  v = lib.deterministicVerdict(mkBuzzCluster([buzzRaw('WebSocket connection closed')], 'some-other-app'), honey);
  assert.notEqual(v.level, 'P3');
  // honeytoken still beats buzz hum (P0 checked first)
  v = lib.deterministicVerdict(mkBuzzCluster([buzzRaw('WebSocket connection closed', { note: 'HONEYTOKEN-canary-x' })]), { strings: ['HONEYTOKEN-canary-x'] });
  assert.equal(v.level, 'P0');
});
