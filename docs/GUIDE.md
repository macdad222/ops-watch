# ops-watch — The Plain-English Guide

*Read this first. No jargon required. If you already know what a firewall is, you'll be fine in ten minutes.*

---

## The one-sentence version

ops-watch reads thousands of log messages a day from every computer in the house, and texts Chris only when something actually needs a human — while keeping everything it saw, forever, in case we need to look back.

---

## Why this exists (the problem it solves)

Imagine every computer in the house — the firewall, three Macs, three Linux servers, about 25 apps running in Docker — each keeps a diary. Every error, every login, every weird event gets written down. That's a **log**.

Left alone, those diaries add up to **thousands of lines a day**. Nobody reads them. And that's exactly the problem: real problems hide in there like one important email in a flooded inbox. The day a hacker tried to break into the firewall (this really happened — see the use-cases doc), the evidence was sitting in logs. If nobody looks at logs until after something bad happens, you always find out too late.

ops-watch is the answer to: *"Who is actually reading all these logs, all the time?"*

The answer: this system. Every 5 minutes. It doesn't get tired, doesn't get bored, and doesn't text you about nothing.

---

## The house analogy

Think of ops-watch as a **home security system with a very smart receptionist**:

1. **Sensors** — every computer runs a small program (a "shipper") that watches its own diary and mails important pages to one central place. The firewall mails its pages too.
2. **The mailroom** (`receiver.mjs`) — one program on the `.110` server collects every page that arrives, in one long file. It never throws anything away.
3. **The librarian** (`loki-tail.mjs`) — some computers send their diaries to a big searchable archive instead (that archive is called **Loki**). The librarian copies the newest pages from the archive into the mailroom file too, so *everything* ends up in one stream.
4. **The reviewer** (`triage.mjs`) — every 5 minutes, this program picks up the new pages, groups identical events together (200 identical errors = 1 note, not 200), and decides: **does a human need to know?**
5. **The text messages** — when the answer is yes, Chris gets a Telegram message. Everything else gets filed in a **held** folder (the digest) that anyone can review later.

The key promise: **nothing is ever silently dropped.** Messages either get texted or filed — and you can always see what was filed and why.

---

## The four levels (P0 through P3)

Every group of events gets a priority letter-number grade. Here's what they mean in real life:

| Grade | Meaning | What happens | Real example |
|---|---|---|---|
| **P0** | Emergency. Someone is poking where they should never poke. | Texts Chris immediately. Can never be silenced, not even by the AI. | A "tripwire" credential (a honeytoken — see below) gets used |
| **P1** | Something is broken or being attacked. | Texts Chris, but the same alert won't re-text for 4 hours (so you don't get spammed by the same problem). | Database crashes, SSH brute-force, firewall admin attack |
| **P2** | Weird, might matter. | The AI gate (Jev) judges each one: routine noise → filed; anything new or unexplainable → texted. | A service logs something the rules never anticipated |
| **P3** | Routine noise. | Filed. Never texted. Visible if you go looking. | Health-check pings, debug messages, normal chatter |

The important design rule: **the simple, predictable checks always outrank the AI.** The AI (called Jev) can only file things away if a rule-based check didn't already flag them — and if the AI is offline, everything gets surfaced instead of silenced (that's called "fail-open"). When in doubt, ping the human.

---

## The AI judge — and why it can't go rogue

The four grades above are decided by plain code — except for one band. When an event is *neither clearly an attack nor clearly routine*, the system asks **Jev**, a tiny specialized AI judge, one narrow question: *"is this routine background noise, or something new?"* Routine → filed to the digest. New → texted to Chris.

Why trust it? And why is it here at all? Because ops-watch is nearly impossible without it — ~28,000 ambiguous clusters a day land in the band no code rule can classify: ping them all and the phone gets muted, file them all and the next real attack runs unnoticed. Jev is the only price point ($0.00002, 300 ms) at which every one of them gets judged. The full argument, with live measured numbers: [JEV.md §2](JEV.md#2-why-ops-watch-only-works-because-of-jev). And why trust it day-to-day? Because of how it's wired, not because it's smart:

- **It only sees the leftovers.** Four layers of plain code check everything first; Jev never touches anything those layers already classified.
- **It can't delete anything.** "Filed" means moved to a file you can open, with the reason attached — the system has no delete path.
- **It writes down every decision.** A running ledger records each verdict, so its behavior can be measured (and it is — every Sunday, automatically).
- **If it's down, the system gets louder, not quieter.** A dead judge means nothing gets filtered — every ambiguous event pings.
- **It's cheap and tiny on purpose.** One question, one answer, ~300 ms, a hundredth of a cent. Not a general AI with opinions — a single-purpose judgment unit.

The full story — principles, the exact flow of a cluster through the judgment layer, thresholds, the ledger, how the safety contract works — is in [JEV.md](JEV.md).

---

## What a real alert looks like

This is an actual alert format from the system (shortened):

```
🚨 P1: 2 clusters need attention (2026-10-21 21:47 CDT)

1. [P1] fortigate-admin-auth-fail (×65)
   why: FortiGate admin/VPN auth failures — brute-force signature
   host: fortigate | first 21:41:02 | last 21:47:10
   8 distinct source IPs
   sample: logdesc="Admin login failed" action=login status=failed ...

Reply HOLD to acknowledge, or ignore — repeat suppressed 4h.
```

Reading it: *the firewall saw 65 failed admin log-ins from 8 different internet addresses in 6 minutes.* That's not a typo — that's someone trying passwords. This exact alert (for real) is in the use-cases doc.

---

## Three words you'll see everywhere

- **Log line / event** — one entry in a computer's diary. `"Oct 22 19:17: firewall: admin login failed"` is one.
- **Cluster** — many identical events grouped into one. The system groups by a "signature" (what happened, not the exact details — so 65 failed logins from 8 IPs is *one* cluster with a count of 65 and "8 distinct IPs").
- **Held** — filed away instead of texted. Lives in a file called `held.jsonl` on the `.110` server. Also summarized in the Jev ledger. Nothing deleted, ever.

---

## What's watching what (coverage as of Oct 22, 2026)

- **The firewall (FortiGate, "CMACFG90G")** — every log it emits: internet attacks, blocked scans, admin logins, SD-WAN link health.
- **The mini (.56) and the M5Max laptop** — their service logs (the AI gateway, voice bridge, watchdogs, home automation).
- **The Mac mini M6 (.135)** — the AI vision server's logs (pulled over SSH).
- **The three Linux servers (.110 "agent-server", .120 "tr-server", .115 "vllm-tr")** — their system journals, **login/auth logs** (the SSH brute-force detector reads these), and on .110, the console output of ~25 Docker apps (the AI API gateway, databases, chat front-ends...).

If a device isn't on this list, ops-watch is blind to it — see the RUNBOOK ("Add a new host") to fix that.

---

## How fast is it?

- A bad event lands in the logs → shipper sends it within **seconds**.
- The reviewer runs **every 5 minutes** → worst case, your phone buzzes about **5 minutes** after the event. Typical: 1–3 minutes.
- The same alert won't re-text within **4 hours** unless it's a P0 emergency (those always re-alert).

---

## Where to look at things yourself

All of this lives on the `.110` server (user `chris`) and in the project folder on the mini:

| I want to... | Where |
|---|---|
| See what was held and why | `ssh chris@192.168.5.110 'tail -20 ~/ops-watch/data/held.jsonl'` |
| Search any log from any day | Grafana: `http://192.168.5.56:3500` (datasource → Loki on .110) |
| See the raw event stream | `~/ops-watch/data/events.jsonl` on .110 |
| See the alert rules | `rules.json` in the project folder |
| Read how the pieces connect | `docs/ARCHITECTURE.md` |
| Fix something / restart things | `docs/RUNBOOK.md` |
| Understand the alert grades & safety rules | `docs/RULES.md` |
| See real incidents this system caught | `docs/USE-CASES.md` |

---

## Glossary (the jargon, translated)

- **Syslog** — the standard way computers send diary entries over the network.
- **UDP** — the delivery method ("fire and forget" mail). Fast, no confirmation. Good for logs; if one page gets lost, thousands more follow.
- **Loki** — a searchable archive for logs (made by Grafana). Like a library where every diary page is indexed by computer name, app, and date.
- **Grafana** — the website where you search and graph what's in Loki.
- **Docker container** — an app packaged with everything it needs to run. The whole ops-watch brain runs inside one container called `ops-watch` on the `.110` server.
- **launchd** — macOS's "start this program automatically and keep it running" service. The Mac shippers run under launchd.
- **Shipper** — the small program on each computer that mails log pages to the mailroom.
- **Honeytoken** — a fake but juicy-looking credential (password file, API key, account name) planted where a real attacker would look. Nobody legitimate ever uses it — so the *instant* one gets used, you know someone's inside. ops-watch treats any honeytoken hit as a P0 emergency.
- **Jev** — the AI judge (TypeSafe System One) that reviews P2 "might be noise" clusters with one narrow question ("routine or novel?"). Deterministic rules always outrank it; it can file things away but never delete them; every verdict is logged to a ledger; it fails open when down. Full doc: `docs/JEV.md`.
- **Signature (sig)** — the fingerprint of an event: what happened, with the unique details (usernames, IPs, numbers) masked. Same fingerprint = same cluster.
- **Fail-open** — the safety stance: if the AI judge can't be reached, show everything. A missing filter must never become a missing alert.
- **P0/P1/P2/P3** — the priority grades explained above.

---

*Questions the guide doesn't answer? ARCHITECTURE.md has the deep version, RUNBOOK.md has the fix-it version, USE-CASES.md has the war stories, JEV.md explains the judgment layer.*
