// test/contract-jev.test.mjs — REAL Jev API contract test (plan §7). Costs ~$0.001.
// Skipped unless OPSWATCH_CONTRACT=1 (kept out of default `node --test` runs).
// Asserts: per-cluster probabilities actually differ (range of p_routine_noise > 0.3)
// and answers parse as Choice with probabilities + confidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('jev contract: per-cluster Choice probabilities differ across 5 distinct clusters', { skip: !process.env.OPSWATCH_CONTRACT }, async () => {
  const { jevClassifyClusters } = await import('../jev-client.mjs');
  const lib = await import('../lib.mjs');
  const cfg = lib.loadOpsConfig();
  const mk = (i, over) => ({ id: `clusters[${i}]`, sig: `ct${i}`, source: over.source, program: over.program, host: over.host || 'h',
    count_this_cycle: over.count, first_seen: '2026-10-23T12:00:00Z', last_seen: '2026-10-23T12:04:00Z', ct_last_seen: '12:04 CT',
    seen_last_7d: over.seen, seen_7d_count: over.seen ? 40 : 0, days_seen_7d: over.seen ? 6 : 0,
    baseline_per_cycle_7d: over.seen ? over.baseline : null, rate_vs_baseline: over.seen ? +(over.count / over.baseline).toFixed(1) : 'new',
    held_7d: over.held ?? 0, pinged_7d: 0, last_verdict: null, distinct_users: over.users ?? 0, distinct_ips: over.ips ?? 1,
    samples: over.samples, window: { start: '2026-10-23T12:00:00Z', end: '2026-10-23T12:04:00Z' }, cycle_id: 'contract' });
  const clusters = [
    mk(0, { source: 'sshd', program: 'sshd', count: 47, seen: false, users: 9, ips: 1,
      samples: ['Failed password for invalid user admin from 198.51.100.7 port 40022 ssh2', 'Failed password for invalid user oracle from 198.51.100.7 port 40026 ssh2', 'pam_unix(sshd:auth): authentication failure; user=oracle'] }),
    mk(1, { source: 'docker', program: 'dockerd', count: 6, seen: true, baseline: 5, held: 12,
      samples: ['Container ops-watch started', 'Container loki started'] }),
    mk(2, { source: 'fortigate', program: 'traffic', count: 4210, seen: true, baseline: 3900, held: 40,
      samples: ['type=traffic action=deny level=information dstip=203.0.113.5 port=443', 'type=traffic action=accept level=information'] }),
    mk(3, { source: 'syslog', program: 'kernel', count: 14, seen: true, baseline: 0.2,
      samples: ['blk_update_request: I/O error, dev sda, sector 1180240 op 0x1:(WRITE)', 'blk_update_request: I/O error, dev sda, sector 1180248'] }),
    mk(4, { source: 'app', program: 'cron', count: 3, seen: true, baseline: 3, held: 30,
      samples: ['CRON[12345]: (root) CMD (run-parts /etc/cron.hourly)'] }),
  ];
  const state = { cycle: { window_start: '2026-10-23T12:00:00Z', window_end: '2026-10-23T12:04:00Z', ct_time: '12:04 CT', cycle_id: 'contract' }, clusters };
  const t0 = Date.now();
  const { results, calls } = await jevClassifyClusters(state, clusters, { cfg, examples: JSON.parse((await import('node:fs')).readFileSync(new URL('../examples.json', import.meta.url), 'utf8')) });
  const ms = Date.now() - t0;
  const probs = clusters.map(c => results.get(c.id));
  assert.ok(probs.every(p => p && p.probs && typeof p.confidence === 'number'), 'all 5 parsed as Choice with probabilities+confidence');
  const rn = probs.map(p => p.probs.routine_noise);
  const range = Math.max(...rn) - Math.min(...rn);
  console.log(`contract: ${ms}ms, tokens_in=${calls.reduce((n, c) => n + (c.tokens_in || 0), 0)}, p_rn=[${rn.map(x => x.toFixed(2)).join(', ')}], range=${range.toFixed(2)}`);
  assert.ok(range > 0.3, `per-cluster variation required: range ${range.toFixed(2)} > 0.3 (got [${rn.join(', ')}])`);
});
