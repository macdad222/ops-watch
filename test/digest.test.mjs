// test/digest.test.mjs — digest collection/cap/state (§7; v3 card rework 2026-10-23).
// Send injected; no network. Buttons only on question cards (cap 5); no message-level keyboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'opswatch-digest-test-'));
process.env.OPSWATCH_DATA_DIR = TMP;
process.env.OPSWATCH_DISABLE_QWEN = '1';
const digest = await import('../digest.mjs');
const lib = await import('../lib.mjs');

const CFG = { ...lib.loadOpsConfig(join(TMP, 'missing.json')), digest: { enabled: true, send_at_ct: '08:00', max_items: 3, max_questions: 5 } };
const worthFn = async groups => groups.map(g => ({ ...g, rating: 'worth_a_look', headline: 'Something happened.', next_step: '', confidence: 0.7, qwen: true, fallback: false }));
const seed = (queue, shadow) => {
  writeFileSync(join(TMP, 'digest-queue.jsonl'), queue.map(q => JSON.stringify(q)).join('\n') + (queue.length ? '\n' : ''));
  writeFileSync(join(TMP, 'jev-v2-shadow.jsonl'), shadow.map(s => JSON.stringify(s)).join('\n') + (shadow.length ? '\n' : ''));
};

test('digest: shadow would-ping + queue items → body message (no buttons) + question messages with buttons, queue rotated', async () => {
  seed(
    Array.from({ length: 5 }, (_, i) => ({ ts: '2026-10-23T12:00:00Z', cycle_id: 'c', reason: 'jev-down', sig: `q${i}`, source: 'app', program: 'p', count: 2, sample: 's' })),
    [
      { ts: new Date(Date.now() - 3600000).toISOString(), cycle_id: 'c1', mode: 'shadow', sig: 'sp1', source: 'sshd', program: 'sshd', count: 9, v2_decision: 'ping', v2_reason: 'security_relevant p=0.55', v1_decision: 'hold', features: { samples: ['Failed password from 198.51.100.9'] }, probs: { security_relevant: 0.55 }, confidence: 0.6 },
      { ts: new Date(Date.now() - 3500000).toISOString(), cycle_id: 'c1', mode: 'shadow', sig: 'su1', source: 'app', program: 'x', count: 3, v2_decision: 'digest', v2_reason: 'uncertain (argmax=routine_noise)', v1_decision: 'hold', features: { samples: ['x'] }, probs: { routine_noise: 0.5 }, confidence: 0.4 },
    ],
  );
  const sends = [];
  const r = await digest.runDigest({ cfg: CFG, force: true, rateFn: worthFn, send: async (body, opts) => { sends.push({ body, markup: opts?.replyMarkup ?? null }); return { result: { message_id: 777 + sends.length } }; } });
  assert.equal(r.sent, true);
  assert.equal(sends.length, 4, '1 body + 3 question messages');
  assert.equal(sends[0].markup, null, 'digest BODY message carries NO buttons');
  assert.ok(sends[0].body.includes('📬'), 'digest header on body');
  assert.ok(sends[0].body.includes('+4 more minor items'), 'cap 3 → +4 more');
  for (const s of sends.slice(1)) {
    assert.ok(s.markup && s.markup.inline_keyboard.length === 1, 'each question message carries exactly one card\'s buttons');
    assert.ok(s.body.includes('worth a look') || s.body.includes('needs attention'), 'question message is a full card');
    for (const b of s.markup.inline_keyboard[0]) assert.ok(b.callback_data.length <= 64);
  }
  assert.ok(!sends[0].body.includes('ow missed'), 'old digest footer gone');
  const rows = readFileSync(join(TMP, 'pings.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const drow = rows.find(x => x.kind === 'digest');
  assert.ok(drow, 'digest recorded in pings.jsonl');
  assert.equal(drow.items.length, 3);
  assert.ok(Array.isArray(drow.cards) && drow.cards.length >= 1, 'cards mapping recorded');
  const qcards = drow.cards.filter(c => c.question);
  assert.equal(qcards.length, 3);
  assert.ok(qcards.every(c => c.message_id != null && c.message_id !== drow.message_id), 'question cards have their OWN message_ids');
  assert.equal(existsSync(join(TMP, 'digest-queue.jsonl')), false, 'queue rotated after send');
});

test('digest: question cap honored (7 borderline items, max_questions 5 → 5 buttoned cards)', async () => {
  const CFG5 = { ...CFG, digest: { ...CFG.digest, max_items: 15, max_questions: 5 } };
  seed(
    [],
    Array.from({ length: 7 }, (_, i) => ({
      ts: new Date(Date.now() - 3600000).toISOString(), cycle_id: 'c', mode: 'shadow', sig: `s${i}`,
      source: 'svc' + i, program: '', count: 3, v2_decision: 'ping', v2_reason: 'operational_fault p=0.7 (conf 0.6)',
      v1_decision: 'hold', features: { samples: [`sample ${i}`] }, probs: { operational_fault: 0.7 }, confidence: 0.6,
    })),
  );
  let sends = [];
  const r = await digest.runDigest({ cfg: CFG5, force: true, rateFn: worthFn, send: async (body, opts) => { sends.push({ body, markup: opts?.replyMarkup ?? null }); return { result: { message_id: 778 + sends.length } }; } });
  assert.equal(r.sent, true);
  assert.equal(r.questions, 5, 'hard cap 5 questions/day');
  assert.equal(sends.length, 6, '1 body + 5 question messages');
  assert.equal(sends.filter(s => s.markup && s.markup.inline_keyboard.length === 1).length, 5, 'buttons only on the 5 question messages');
  assert.equal(sends[0].markup, null, 'body has no buttons');
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
