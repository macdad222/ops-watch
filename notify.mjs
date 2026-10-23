// notify.mjs — Telegram delivery for ops-watch. Bot token read at runtime from
// MEMORY.md (never typed/inlined — exec redactor lesson). Zero deps.
// v3 (2026-10-23): message-level feedback keyboard REMOVED — per-card buttons only
// (cards.mjs cardButtons). Old messages with the old keyboard still label fine via label.mjs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MEM_PATH = '/Users/chrismacfarland/clawd/MEMORY.md';
const CHAT_ID = '309983163';

export function getToken() {
  if (process.env.TG_BOT_TOKEN) return process.env.TG_BOT_TOKEN;
  try { const v = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'secrets/tg.cred'), 'utf8').trim(); if (v) return v; } catch { /* no cred file */ }
  const m = readFileSync(MEM_PATH, 'utf8').match(/(\d{9,11}:[A-Za-z0-9_-]{30,45})/);
  if (!m) throw new Error('bot token not found (env TG_BOT_TOKEN, secrets/tg.cred, MEMORY.md)');
  return m[1];
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendTelegram(html, { silent = false, replyMarkup = null } = {}) {
  const url = `https://api.telegram.org/bot${getToken()}/sendMessage`;
  // Telegram hard limit 4096 chars — truncate with a marker instead of 400-failing
  if (html.length > 3900) html = html.slice(0, 3850) + '\n\n⚠️ …truncated (full detail in ops-watch held.jsonl)';
  const body = { chat_id: CHAT_ID, text: html, parse_mode: 'HTML', disable_notification: silent };
  if (replyMarkup) body.reply_markup = replyMarkup;   // inline keyboard (Bot API; no deps)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const r = await res.json();
  if (!r.ok) throw new Error(`telegram ${r.error_code}: ${r.description}`);
  return r;
}

// Plain-English layer (Chris 2026-10-20: 'I have no idea what all the ops messages mean') —
// every ping now leads with what happened + whether he needs to act; tech details stay below.
const PLAIN_MEANINGS = [
  [/honeytoken|canary/i, 'A planted tripwire (decoy account/file) was touched — that is designed to only happen if someone is snooping where they should not be.'],
  [/ioc/i, 'A known-bad indicator (IP, domain, or attack signature) showed up in your logs.'],
  [/config[- ]change/i, 'A device or service had its configuration changed.'],
  [/auth[- ]burst|failed log/i, 'A burst of failed logins — someone may be guessing passwords.'],
  [/critical|fatal/i, 'A service is throwing fatal errors repeatedly (crash-looping).'],
  [/novel/i, 'Something unusual that I could not classify as routine background noise.'],
];
function plainMeaning(text) {
  for (const [re, t] of PLAIN_MEANINGS) if (re.test(text)) return t;
  return 'Unusual activity that did not match any known-good pattern.';
}
function plainAction(verdict) {
  if (verdict.level === 'P0') return 'Act now — treat as a possible breach until checked out.';
  if (/config[- ]change/i.test(verdict.why) || /auth[- ]burst/i.test(verdict.why))
    return 'If you or a scheduled change caused this, ignore it — if not, tell me and I will dig in.';
  return 'No emergency — I am tracking it and will only re-ping if it persists or gets worse.';
}

export function pingMessage(cluster, verdict, { test = false, tag = null, pingId = null } = {}) {
  const icon = verdict.level === 'P0' ? '🚨' : '⚠️';
  const head = test ? 'SYNTHETIC-TEST' : '';
  const lines = [
    `${icon} <b>${head} [${verdict.level}] ${esc(cluster.source)}: ${esc(cluster.program || cluster.fg?.subtype || 'event')}</b>`,
    `<b>What happened:</b> ${esc(plainMeaning(`${verdict.why} ${cluster.program || ''} ${(cluster.samples[0] || '').slice(0, 120)}`))}`,
    `<b>Do you need to act:</b> ${esc(plainAction(verdict))}`,
    `<i>Why flagged:</i> ${esc(verdict.why)}`,
    `Count: ${cluster.count} in window · hosts: ${esc(cluster.host || 'n/a')} · users: ${cluster.distinct_users} · IPs: ${cluster.distinct_ips}`,
    `Sample: <code>${esc((cluster.samples[0] || '').slice(0, 220))}</code>`,
    `Window: ${esc(cluster.first_seen)} → ${esc(cluster.last_seen)}`,
  ];
  if (tag) lines.push(`Item: <code>#${esc(tag)}</code>`);
  return lines.join('\n');
}
