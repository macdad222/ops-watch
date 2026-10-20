// notify.mjs — Telegram delivery for ops-watch. Bot token read at runtime from
// MEMORY.md (never typed/inlined — exec redactor lesson). Zero deps.
import { readFileSync } from 'node:fs';

const MEM_PATH = '/Users/chrismacfarland/clawd/MEMORY.md';
const CHAT_ID = '309983163';

export function getToken() {
  const m = readFileSync(MEM_PATH, 'utf8').match(/(\d{9,11}:[A-Za-z0-9_-]{30,45})/);
  if (!m) throw new Error('bot token not found in MEMORY.md');
  return m[1];
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendTelegram(html, { silent = false } = {}) {
  const url = `https://api.telegram.org/bot${getToken()}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: html, parse_mode: 'HTML', disable_notification: silent }),
    signal: AbortSignal.timeout(30000),
  });
  const r = await res.json();
  if (!r.ok) throw new Error(`telegram ${r.error_code}: ${r.description}`);
  return r;
}

export function pingMessage(cluster, verdict, { test = false } = {}) {
  const icon = verdict.level === 'P0' ? '🚨' : '⚠️';
  const head = test ? 'SYNTHETIC-TEST' : '';
  const lines = [
    `${icon} <b>${head} [${verdict.level}] ${esc(cluster.source)}: ${esc(cluster.program || cluster.fg?.subtype || 'event')}</b>`,
    `<b>Why:</b> ${esc(verdict.why)}`,
    `Count: ${cluster.count} in window · hosts: ${esc(cluster.host || 'n/a')} · users: ${cluster.distinct_users} · IPs: ${cluster.distinct_ips}`,
    `Sample: <code>${esc((cluster.samples[0] || '').slice(0, 220))}</code>`,
    `Window: ${esc(cluster.first_seen)} → ${esc(cluster.last_seen)}`,
  ];
  return lines.join('\n');
}
