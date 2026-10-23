// test/digest.test.mjs — digest collection/cap/state (§7). Send injected; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'opswatch-digest-test-'));
process.env.OPSWATCH_DATA_DIR = TMP;
const digest = await import('../digest.mjs');
const lib = await import('../lib.mjs');

const CFG = { ...lib.loadOpsConfig(join(TMP, 'missing.json')), digest: { enabled: true, send_at_ct: '08:00', max_items: 3 } };
const seed = (queue, shadow) => {
  writeFileSync(join(TMP, 'digest-queue.jsonl'), queue.map(q => JSON.stringify(q)).join('\n') + '\n');
  writeFileSync(join(TMP, 'jev-v2-shadow.jsonl'), shadow.map(s => JSON.stringify(s)).join('\n') + '\n');
};

test('digest: shadow would-ping + queue items, cap + "+N more", pings.jsonl row, queue rotated', async () => {
  seed(
    Array.from({ length: 5 }, (_, i) => ({ ts: '2026-10-23T12:00:00Z', cycle_id: 'c', reason: 'jev-down', sig: `q${i}`, source: 'app', program: 'p', count: 2, sample: 's' })),
    [
      { ts: new Date(Date.now() - 3600000).toISOString(), cycle_id: 'c1', mode: 'shadow', sig: 'sp1', source: 'sshd', program: 'sshd', count: 9, v2_decision: 'ping', v2_reason: 'security_relevant p=0.55', features: { samples: ['Failed password from 198.51.100.9'] }, probs: { security_relevant: 0.55 }, confidence: 0.6 },
      { ts: new Date(Date.now() - 3500000).toISOString(), cycle_id: 'c1', mode: 'shadow', sig: 'su1', source: 'app', program: 'x', count: 3, v2_decision: 'digest', v2_reason: 'uncertain (argmax=routine_noise)', features: { samples: ['x'] }, probs: { routine_noise: 0.5 }, confidence: 0.4 },
    ],
  );
  let sentBody = '';
  const r = await digest.runDigest({ cfg: CFG, force: true, send: async (body, opts) => { sentBody = body; return { result: { message_id: 777 } }; } });
  assert.equal(r.sent, true);
  assert.ok(sentBody.includes('v2 shadow — WOULD have pinged'));
  assert.ok(sentBody.includes('+4 more'), 'cap 3 → +4 more');
  const rows = readFileSync(join(TMP, 'pings.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const drow = rows.find(x => x.kind === 'digest');
  assert.ok(drow, 'digest recorded in pings.jsonl');
  assert.equal(drow.items.length, 3);
  assert.equal(drow.message_id, 777);
  assert.equal(existsSync(join(TMP, 'digest-queue.jsonl')), false, 'queue rotated after send');
});

test('digest: quiet hours → never sends', async () => {
  seed([], []);
  // 2026-10-23 06:30 UTC = 01:30 CDT → quiet
  const r = await digest.runDigest({ cfg: CFG, force: false, now: Date.parse('2026-10-23T06:30:00Z'), send: async () => { throw new Error('must not send'); } });
  assert.equal(r.sent, false);
  assert.equal(r.why, 'quiet-hours');
});

test('digest: already-sent-today guard', async () => {
  writeFileSync(join(TMP, 'digest-state.json'), JSON.stringify({ last_sent_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()) }));
  seed([{ ts: 'x', sig: 'q', source: 's', program: 'p', count: 1, sample: '', reason: 'r' }], []);
  const r = await digest.runDigest({ cfg: CFG, force: false, send: async () => { throw new Error('must not send'); } });
  assert.equal(r.sent, false);
  assert.equal(r.why, 'already sent today');
});
