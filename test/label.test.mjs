// test/label.test.mjs — feedback ingestion CLI (§7): lookup by message_id/ping_id, mute → mutes.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = mkdtempSync(join(tmpdir(), 'opswatch-label-test-'));
const LABEL = new URL('../label.mjs', import.meta.url).pathname;

function seed(pings, shadow = [], mutes = {}) {
  writeFileSync(join(TMP, 'pings.jsonl'), pings.map(p => JSON.stringify(p)).join('\n') + '\n');
  writeFileSync(join(TMP, 'jev-v2-shadow.jsonl'), shadow.map(s => JSON.stringify(s)).join('\n') + '\n');
  writeFileSync(join(TMP, 'mutes.json'), JSON.stringify(mutes));
  rmSync(join(TMP, 'labels.jsonl'), { force: true });   // per-test isolation
}
function run(args) {
  return execFileSync(process.execPath, [LABEL, ...args], { env: { ...process.env, OPSWATCH_DATA_DIR: TMP }, encoding: 'utf8' });
}

const PING = { ts: '2026-10-23T18:00:00Z', ping_id: 'k3f9', message_id: 555001, kind: 'ping', mode: 'v1',
  items: [
    { item_id: 'k3f9.1', sig: 'sigA', source: 'fortigate', program: 'traffic', level: 'P2', decision: 'why-a', mode: 'v1' },
    { item_id: 'k3f9.2', sig: 'sigB', source: 'sshd', program: 'sshd', level: 'P2', decision: 'why-b', mode: 'v1' },
  ] };
const SHADOW = [{ ts: '2026-10-23T18:00:01Z', cycle_id: 'c1', mode: 'shadow', sig: 'sigA', source: 'fortigate', program: 'traffic',
  count: 20, probs: { routine_noise: 0.2, security_relevant: 0.6 }, confidence: 0.7, v2_decision: 'ping', v2_reason: 'test',
  features: { id: 'clusters[0]', sig: 'sigA', source: 'fortigate', count_this_cycle: 20, rate_vs_baseline: 1 } }];

test('label by message_id (reaction path): both items labeled, shadow enriched', () => {
  seed([PING], SHADOW, {});
  const out = run(['--msg', '555001', '--label', 'noise', '--via', 'reaction']);
  assert.ok(out.includes('labeled 2 item(s)'));
  const rows = readFileSync(join(TMP, 'labels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.label === 'noise' && r.via === 'reaction' && r.ping_id === 'k3f9'));
  assert.equal(rows[0].jev.probs.security_relevant, 0.6, 'shadow probs attached');
  assert.equal(rows[0].v2_shadow_decision, 'ping');
  assert.equal(rows[0].features !== null, true);
});

test('label by ping_id single item (reply path) + mute writes mutes.json', () => {
  seed([PING], [], {});
  const out = run(['--ping', 'k3f9', '--item', 'k3f9.2', '--label', 'mute', '--via', 'reply']);
  assert.ok(out.includes('mutes updated'));
  const rows = readFileSync(join(TMP, 'labels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_id, 'k3f9.2');
  const mutes = JSON.parse(readFileSync(join(TMP, 'mutes.json'), 'utf8'));
  const until = mutes.sigB;
  assert.ok(until > Date.now() + 6.9 * 86400000 && until < Date.now() + 7.1 * 86400000, 'mute ≈ 7 days out');
});

test('label button path: callback ping_id + useful; unknown id exits 1', () => {
  seed([PING], [], {});
  const out = run(['--ping', 'k3f9', '--label', 'useful', '--via', 'button']);
  assert.ok(out.includes('useful via button'));
  let failed = false;
  try { run(['--ping', 'zzzz', '--label', 'noise']); } catch (e) { failed = e.status === 1; }
  assert.equal(failed, true, 'unknown ping id exits 1');
  assert.equal(existsSync(join(TMP, 'labels.jsonl')), true);
});
