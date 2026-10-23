# ops-watch — High-Value Use Cases (with real examples)

*What this system is actually *for*. Each use case follows the same shape: the story, what you'd see on your phone, what to do about it, and where to dig deeper. Several of these are real incidents, marked **[REAL]**. The judgment layer that separates "text him" from "file it" on the ambiguous middle band is **Jev (TypeSafe System One)** — its principles and flow are documented in [JEV.md](JEV.md).*

---

## 1. Catching a firewall attack in the first minutes **[REAL]**

**The story.** On October 21, 2026, someone on the internet started guessing the admin password of the house firewall (a FortiGate). They hit it 65 times from 8 different IP addresses in about 6 minutes. Zero successes — but they were never going to stop on their own.

**What happened.** ops-watch had been receiving the firewall's logs for about a minute when the failed-login cluster tripped the security rule. Chris got the alert, confirmed the attack in Grafana, and disabled remote admin access on the external interface the same night. Total exposure: minutes, not months.

**The alert you'd see:**
```
🚨 P1: fortigate-admin-auth-fail (×65)
why: FortiGate admin/VPN auth failures — brute-force signature
8 distinct source IPs | first 21:41:02 | last 21:47:10
sample: logdesc="Admin login failed" action=login status=failed
```

**Why it works.** The firewall's `fortigate-syslog` feed reaches the receiver in seconds (via the collector on the mini), and the rule fires at ≥3 failed logins per 5-minute window — sensitive enough for a patient attacker, quiet enough that one of your own typos doesn't page you.

**What to do if this fires:**
1. Open Grafana → query `{job="fortigate-syslog"} |= "Admin login failed"` for the last hour. Look at the source IPs and whether any attempt *succeeded*.
2. If attacks are coming from the internet: Network → Interfaces on the firewall → confirm admin access is off on WAN-facing interfaces.
3. Persistent single-IP attacker? Block it at the firewall.

**Dig deeper:** Loki query above, or `docker exec ops-watch sh -c "grep -i 'admin login' logs/..."`. Full post-mortem lives in the daily memory files (2026-10-21/22).

---

## 2. Seeing the constant background scanning (and knowing it's normal) **[REAL]**

**The story.** The internet is a rough neighborhood. The firewall logs show constant drive-by scanning: on one recent day, **1,064 blocked scan attempts hit the fiber connection** (ports like Telnet, random TCP, from Germany, Canada, Iran...) and 73 hit the Spectrum connection. This is normal background noise — every public IP gets this.

**Why it's valuable anyway.** ops-watch files this as low-priority hum (a burst of denied connection attempts is *deterministic-checked* and otherwise held). That means:
- It doesn't text you 1,064 times (you'd mute the system — useless).
- It doesn't silently vanish either — it's in the digest, and any *spike* in that baseline would trip the volume-burst rule.

**The high-value part:** when you ask "have we been scanned more than usual?", the answer is queryable in seconds via Grafana, not vibes:

```
Loki: sum by (srcintf) (count_over_time({job="fortigate-syslog"} |= "action=\"deny\"" [24h]))
```

**What to do:** nothing, normally. Worry only when the *denied* volume suddenly changes shape — e.g., scans start coming from inside your LAN, or a scan hits something that answers.

---

## 3. SSH brute-force on any server **[rule: `ssh-bruteforce`]**

**The story.** Every Linux server that accepts SSH logins eventually gets password-guessing attempts. The three lab servers (.110/.120/.115) now ship their **auth logs** into the pipeline, so a brute-force run — often thousands of tries per hour from botnets — lights up within one 5-minute cycle.

**The alert you'd see:**
```
🚨 P1: ssh-bruteforce (×412)
why: SSH brute-force burst on a fleet host
host: tr-server | 1 distinct user patterns | 3 distinct IPs
sample: sshd[22314]: Failed password for root from 45.155.205.211 port 51022 ssh2
```

**Why it works.** The rule matches `Failed password` / `Invalid user` / `authentication failure` in any `syslog`-job event and fires at ≥10 per 5 minutes. Normal human typos never reach 10; bots reach 10 in seconds.

**What to do:**
1. Check the source IPs in Grafana. Internet-originated? The firewall should already be blocking inbound SSH — confirm, and if the box must take SSH from outside, it needs key-only auth (verify `PasswordAuthentication no`).
2. Internal-originated? More interesting — a compromised LAN device trying to move. That's lateral movement, the thing you really don't want.

---

## 4. The honeytoken tripwire **[rule: `honeytoken-trigger` — P0, Phase 3 pending]**

**The story.** A **honeytoken** is a fake credential that looks real and valuable — say, a file named `aws-root-keys.txt` sitting in a shared folder, or a user account `svc-backup-adm` in the directory. No legitimate person or process will ever use it. So the *only* way it ever appears in a log is if someone (or some malware) with unauthorized access picked it up and tried it.

That makes it the cleanest alarm in security: **zero false positives by design.** Password wrong 3 times? Could be you. Canary key used? Someone is inside.

**The alert you'd see:**
```
🚨 P0: honeytoken-trigger (×1)
why: honeytoken touched — someone is poking where they should not
sample: sshd: Failed password for svc-backup-adm from 192.168.5.77
```
P0s are never suppressed and always re-alert.

**Status:** the rule is live and armed (`honeytokens.json` defines the canaries), but the physical plants (decoy files/accounts) are Phase 3 — awaiting Chris's go-ahead. Until planted, nothing can trip it.

---

## 5. Knowing an app is dying before it's fully dead **[rules: `litellm-error-burst`, `vllm-engine-down`, `postgres-fatal`]**

**The story.** The AI stack Chris runs daily (the LiteLLM API gateway, the vLLM model servers, the postgres database behind them) fails in ways that start as error *bursts* — hundreds of timeouts, then hard failure. Watching for "the app is down" misses the slide; watching the error rate catches it at the slide.

**The alert you'd see:**
```
🚨 P1: litellm-error-burst (×87)
why: LiteLLM error burst — API lane degrading
host: agent-server | sample: ERROR: httpx.RemoteProtocolError ... upstream
```

**Why it works.** These are app-specific rules in `rules.json` (job = the Docker container name, error patterns, burst threshold). Because .110's ~25 containers stream their console output into the pipeline, every app on that box is covered by the generic error-burst layer even without its own rule.

**What to do:** the AI stack has its own runbooks (model lanes, LiteLLM on .110/.120). Usually: check the upstream provider, restart the container, or fail traffic over to the mirror lane on .120.

---

## 6. Home automation down at 2 AM **[rule: `homebridge-failure`]**

**The story.** The house runs Homebridge (the bridge that lets non-HomeKit gadgets show up in Apple Home). When it dies, lights and sensors stop responding — annoying at noon, invisible-but-infuriating at 2 AM when you just want the porch light off.

**The alert:**
```
🚨 P1: homebridge-failure (×3)
why: homebridge failure — smart home impacted
sample: [Homebridge] ERROR EADDRINUSE :::51826
```

**What to do:** restart the service (`launchctl kickstart`), check the log for the bind conflict, move on. The watchdog scripts on the mini usually auto-heal this one — the alert is for when the watchdog *also* fails.

---

## 7. The voice bridge failing **[rules: `voice-lane-*` family]**

**The story.** The voice-call bridge (voice-bridge / voice-v3 on the mini) is the piece that lets the assistant place and take calls. If it silently dies, the failure mode is bad: everything *looks* fine, but calls just don't happen. Error-level logs from those services feed the same deterministic layers — a burst gets held, a fatal gets pinged.

**What to do:** check which process exited (`launchctl print` / log tail), restart, and if it keeps dying, the log cluster will tell you why (port conflict, API key, crashed dependency).

---

## 8. A server running out of memory **[rule: `kernel-oom`]**

**The story.** When a Linux server runs out of RAM, the kernel starts killing processes (OOM = Out Of Memory). The victim is often the *wrong* process — your database gets murdered so a runaway Python script can live. The kernel logs each kill loudly.

**The alert:**
```
🚨 P1: kernel-oom (×2)
why: kernel OOM killer active on a fleet host
sample: kernel: Out of memory: Killed process 22314 (node) total-vm:8123456kB
```

**What to do:** identify the memory hog from the same kernel logs, restart or cap it (`docker update --memory`, systemd limits). Two OOMs in a day means something changed — find what.

---

## 9. Your AI model lane failing mid-work **[rule: `omlx-lane-failure`]**

**The story.** Chris's daily-driver AI runs on local model servers (the lab lane). When a lane 500s or drops its model, every dependent task starts failing at once — and the failure looks like "the AI is being dumb" rather than "the server is down." The dedicated rule turns that into a named, actionable ping.

**Why it's high-value:** minutes matter here — half of a work session can be lost to a silent lane failure. The alert names the lane, so the fix (restart the serve process, swap to the mirror) takes one command.

---

## 10. "What ACTUALLY happened at 3 AM?" — the audit trail **[REAL]**

**The story.** This is the quiet superpower. In late October 2026, the office internet kept "feeling" flaky. Nobody could say why. The full firewall history was sitting in Loki, so a 30-minute forensic session answered it completely:

- ~800 SD-WAN route changes per day — all three internet links (fiber, Spectrum cable, Starlink) flapping in and out of the health-check's SLA all day,
- the exact flapping pattern per link (fiber every 15–35s, Starlink once per ~5 min, Spectrum with 42 hard link-downs),
- which member was which ISP (matched by whois-ing the public IPs each link uses),
- and the config root cause (a health-check SLA threshold set tighter than real-world latency).

**What to do when you need this:**
1. Grafana (`http://192.168.5.56:3500`) → Loki datasource.
2. Search by what you remember: `*= |~ "keyword"` — e.g. `{job="fortigate-syslog"} |= "out-of-sla"`, time range last 7 days.
3. Everything is retained — firewall, auth logs, app logs. Nothing was sampled away, nothing was deleted.

This works because of the design rule *held, never deleted* — the digest isn't just noise reduction, it's a searchable memory of the house.

---

## 11. Firewall configuration changes **[generic deterministic layer]**

**The story.** A silent config change on the firewall is how attackers persist (a new port forward, a new admin user, a weakened rule). ops-watch treats any firewall *config* event as P1-worthy — no AI judgment involved, no suppression path.

**The alert:**
```
🚨 P1: fortigate-config-change (×1)
sample: logdesc="Configuration changed" user=admin from 192.168.5.40
```

**What to do:** was that you? If yes, ignore. If you *didn't* change it — find out who did, immediately. (This rule is why the honeytoken design pairs well: config changes + canary use = the two loudest "someone's inside" signals.)

---

## 12. Suspicious logins across many accounts **[generic: auth-burst]**

**The story.** One failed login is noise. Failed logins for *many different usernames* in a short window is reconnaissance — someone cycling through a list of plausible accounts. The generic deterministic layer fires at ≥3 distinct users hitting auth failures, no tuning required — and no AI judgment involved. (This is deliberate: the things worth pinging about are decided by code; Jev only judges the leftover middle band — see [JEV.md](JEV.md).)

---

## What ops-watch deliberately does NOT do

Being honest about the edges keeps the system trustworthy:

- **It does not fight back.** No auto-blocking IPs, no killing processes, no firewall changes. It alerts; a human pulls the trigger. (This is a design choice — automated responses that misfire are worse than fast pings.)
- **It is not a compliance SIEM.** It's a home/fleet watchdog: superb at "does a human need to know *right now*" and "what happened here," not an audit-evidence system for regulations.
- **UDP can drop a packet under extreme flood.** The mailroom accepts fire-and-forget deliveries. Under a genuine packet-storm, a few lines may vanish — which is why the volume-burst rule exists, and why nothing *critical* relies on a single packet.
- **It watches the hosts on its coverage list.** A new device that doesn't ship logs is invisible — see RUNBOOK → "Add a new host" (5 minutes per Linux host, one plist edit per Mac).

---

*Every rule behind these use cases is documented in `docs/RULES.md` and live in `rules.json`. To test any of them safely, see RUNBOOK → "Live-fire test" — test events are labeled and held, never paged.*
