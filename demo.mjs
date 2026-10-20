#!/usr/bin/env node
// demo.mjs — end-to-end proof on SYNTHETIC events (clearly labeled).
// Feeds realistic FortiGate KV lines, server syslog, app logs + one honeytoken hit
// through the full pipeline. Runs triage in-process (no network receiver needed).
import { writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = join(HERE, 'demo-events.jsonl');

const now = new Date();
const lt = (secAgo) => new Date(now.getTime() - secAgo * 1000).toTimeString().slice(0, 8); // LOCAL wall clock — RFC3164/FortiGate paths parse as local
const fgDate = now.toISOString().slice(0, 10).replace(/-/g, '');
const fgTime = lt; // same local clock

const lines = [];
// 1) Routine firewall traffic-block noise (40x, same signature family)
for (let i = 0; i < 40; i++) lines.push(
  `date=${fgDate} time=${fgTime(i * 6)} devid="FGT61F-XYZ" logid="0000000013" type="traffic" subtype="forward" level="notice" action="block" srcip="10.0.5.${20 + (i % 8)}" dstip="203.0.113.${40 + (i % 3)}" dstport="443" service="HTTPS" msg="Traffic blocked by firewall policy 42"`);
// 2) sshd auth failures across 3 distinct users (deterministic P1 — one cluster via <user> masking)
let k = 0;
for (const u of ['root', 'admin', 'deploy']) for (let i = 0; i < 4; i++) lines.push(
  `<84>Oct 20 17:0${i}:12 srv-db01 sshd[2${i}41]: Failed password for ${u} from 198.51.100.7 port 5${i}2${i}2 ssh2`.replace(/17:0\d:\d\d/, lt(k++ * 7)));
// 3) HONEYTOKEN: canary account login attempt (deterministic P0 — bypasses Jev)
lines.push(`<38>Oct 20 17:05:33 srv-db01 sshd[2911]: Invalid user svc-backup-adm from 198.51.100.7 port 60022`.replace(/17:05:33/, lt(20)));
// 4) Firewall CONFIG change (deterministic P1 — always surfaces)
lines.push(`date=${fgDate} time=${fgTime(90)} devid="FGT61F-XYZ" logid="0100035001" type="event" subtype="system" level="information" action="config" ui="GUI(admin)" msg="Configuration is changed by admin from GUI"`);
// 5) App error pattern (5x same message — Jev decides: routine vs novel)
for (let i = 0; i < 5; i++) lines.push(
  `{"source":"app-api01","host":"api01","program":"payments","level":"ERROR","message":"PaymentGateway timeout after 5000ms orderId=<n> retries=3"}`.replace('<n>', String(80000 + i)));
// 6) Routine keepalive noise (12x)
for (let i = 0; i < 12; i++) lines.push(
  `<30>Oct 20 17:0${i % 6}:44 srv-web01 systemd[1]: Finished Daily apt upgrade and clean activities.`.replace(/17:0\d:\d\d/, lt(i * 9)));

writeFileSync(tmp, lines.join('\n') + '\n');
console.error(`[demo] fed ${lines.length} SYNTHETIC events (expected: 1×P0 honeytoken ping, 2×P1 ping, 1×P2 jev ping, 2×P3 held)`);

const out = execFileSync('node', [join(HERE, 'triage.mjs'), tmp, '--window-min', '5', '--live'], {
  env: { ...process.env, OPSWATCH_TEST: '1' }, encoding: 'utf8', timeout: 120000 });
console.log(out);
try { rmSync(tmp); } catch {}
