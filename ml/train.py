#!/usr/bin/env python3
"""ml/train.py — gated local label model for ops-watch (plan §4.5).

GATE: exits early until labels >= ml.min_labels (default 300). Built 2026-10-23, no venv
created until the gate opens (nothing to train on). Runs on Jarvon only — never on .110.

Usage:
  python3 train.py --labels labels.jsonl --shadow jev-v2-shadow.jsonl [--min-labels 300]

Target: useful/missed = 1, noise/mute = 0. Features: 4 Jev probs + confidence + code
features (count, rate_vs_baseline, seen_7d_count, held_7d, source one-hot, hour CT).
Time-based split; reports AUC/precision/recall vs the Jev bands; emits model.cbm + eval-<date>.md.
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

MIN_LABELS_DEFAULT = 300
FEATURE_PROBS = ["p_routine_noise", "p_expected_change", "p_operational_fault", "p_security_relevant"]
SOURCES = ["fortigate", "sshd", "docker", "unifi", "mac", "kernel", "cron", "other"]


def load_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def featurize(label, shadow_by_sig):
    sh = shadow_by_sig.get(label.get("sig"))
    if not sh or not sh.get("probs"):
        return None
    p = sh["probs"]
    f = {
        "p_routine_noise": p.get("routine_noise", 0.0),
        "p_expected_change": p.get("expected_change", 0.0),
        "p_operational_fault": p.get("operational_fault", 0.0),
        "p_security_relevant": p.get("security_relevant", 0.0),
        "confidence": sh.get("confidence", 0.0),
        "count": (sh.get("features") or {}).get("count_this_cycle", 0) or 0,
        "rate_vs_baseline": (sh.get("features") or {}).get("rate_vs_baseline", 0) if isinstance((sh.get("features") or {}).get("rate_vs_baseline"), (int, float)) else 0.0,
        "seen_7d_count": (sh.get("features") or {}).get("seen_7d_count", 0) or 0,
        "held_7d": (sh.get("features") or {}).get("held_7d", 0) or 0,
        "hour_ct": (sh.get("features") or {}).get("ct_last_seen", "00:00")[:2] if (sh.get("features") or {}).get("ct_last_seen") else "00",
    }
    src = (label.get("source") or "other").lower()
    for s in SOURCES:
        f[f"src_{s}"] = 1 if s in src else 0
    y = 1 if label.get("label") in ("useful", "missed") else 0 if label.get("label") in ("noise", "mute") else None
    if y is None:
        return None
    return f, y


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", required=True)
    ap.add_argument("--shadow", required=True)
    ap.add_argument("--min-labels", type=int, default=MIN_LABELS_DEFAULT)
    args = ap.parse_args()

    labels = load_jsonl(Path(args.labels))
    shadow_by_sig = {}
    for r in load_jsonl(Path(args.shadow)):
        if r.get("sig") and r.get("probs"):
            shadow_by_sig[r["sig"]] = r  # last wins (append order)

    pairs = [p for p in (featurize(l, shadow_by_sig) for l in labels) if p]
    n = len(pairs)
    if n < args.min_labels:
        print(f"need >= {args.min_labels} labels, have {n} — gate not open yet (ml.shadow stays on)")
        sys.exit(0)

    import pandas as pd
    from sklearn.metrics import roc_auc_score, precision_score, recall_score
    try:
        from catboost import CatBoostClassifier
        USE_CB = True
    except ImportError:
        from sklearn.ensemble import HistGradientBoostingClassifier
        USE_CB = False

    df = pd.DataFrame([f for f, _ in pairs])
    df["hour_ct"] = pd.to_numeric(df["hour_ct"], errors="coerce").fillna(0)
    y = pd.Series([yy for _, yy in pairs])
    # time-based split: labels sorted by ts, first 80% train
    order = sorted(range(len(pairs)), key=lambda i: labels[i].get("ts", ""))
    cut = int(len(order) * 0.8)
    tr, te = order[:cut], order[cut:]
    Xtr, Xte, ytr, yte = df.iloc[tr], df.iloc[te], y.iloc[tr], y.iloc[te]

    model = CatBoostClassifier(iterations=400, depth=5, learning_rate=0.06, verbose=False) if USE_CB \
        else HistGradientBoostingClassifier(max_iter=300)
    model.fit(Xtr, ytr)
    proba = model.predict_proba(Xte)[:, 1]
    auc = roc_auc_score(yte, proba) if yte.nunique() > 1 else float("nan")
    pred = (proba >= 0.5).astype(int)
    prec = precision_score(yte, pred, zero_division=0)
    rec = recall_score(yte, pred, zero_division=0)

    out_md = Path(__file__).parent / f"eval-{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.md"
    out_md.write_text(
        f"# ops-watch ml eval — {datetime.now(timezone.utc).date()}\n\n"
        f"- labels used: {n} (train {len(tr)} / test {len(te)})\n"
        f"- model: {'catboost' if USE_CB else 'hist-gb'}\n"
        f"- AUC: {auc:.3f} · precision: {prec:.3f} · recall: {rec:.3f}\n"
        f"- comparison vs Jev bands: see compare-shadow.mjs output for the same window\n"
        f"- shadow-only: score.py writes ml_p to data/ml-shadow.jsonl; NO decisions, NO sends\n",
        encoding="utf-8")
    if USE_CB:
        model.save_model(str(Path(__file__).parent / "model.cbm"))
    print(f"trained on {n} labels — AUC {auc:.3f} prec {prec:.3f} rec {rec:.3f} → {out_md.name}")


if __name__ == "__main__":
    main()
