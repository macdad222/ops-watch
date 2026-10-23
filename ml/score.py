#!/usr/bin/env python3
"""ml/score.py — shadow scorer for ops-watch (plan §4.5). Runs on Jarvon; writes
ml_p into a SEPARATE data/ml-shadow.jsonl. NO decisions, NO sends, NO ledger writes.

Usage: python3 score.py --model model.cbm --shadow jev-v2-shadow.jsonl [--out ml-shadow.jsonl]
"""
import argparse
import json
import sys
from pathlib import Path


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--shadow", required=True)
    ap.add_argument("--out", default="ml-shadow.jsonl")
    args = ap.parse_args()

    model_path = Path(args.model)
    if not model_path.exists():
        print(f"no model at {model_path} — run train.py first (gated at 300 labels)")
        sys.exit(0)

    from catboost import CatBoostClassifier
    m = CatBoostClassifier()
    m.load_model(str(model_path))

    out = Path(args.out)
    n = 0
    with open(out, "a", encoding="utf-8") as w:
        for r in load_jsonl(Path(args.shadow)):
            if not r.get("probs"):
                continue
            p = r["probs"]
            feats = r.get("features") or {}
            row = {
                "p_routine_noise": p.get("routine_noise", 0.0),
                "p_expected_change": p.get("expected_change", 0.0),
                "p_operational_fault": p.get("operational_fault", 0.0),
                "p_security_relevant": p.get("security_relevant", 0.0),
                "confidence": r.get("confidence", 0.0),
                "count": feats.get("count_this_cycle", 0) or 0,
                "rate_vs_baseline": feats.get("rate_vs_baseline", 0) if isinstance(feats.get("rate_vs_baseline"), (int, float)) else 0.0,
                "seen_7d_count": feats.get("seen_7d_count", 0) or 0,
                "held_7d": feats.get("held_7d", 0) or 0,
            }
            try:
                ml_p = float(m.predict_proba([list(row.values())])[0][1])
            except Exception:
                continue
            w.write(json.dumps({"ts": r.get("ts"), "sig": r.get("sig"), "ml_p": round(ml_p, 4),
                                "v2_decision": r.get("v2_decision")}) + "\n")
            n += 1
    print(f"scored {n} shadow rows → {out} (shadow-only; no decisions)")


if __name__ == "__main__":
    main()
