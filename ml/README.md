# ml/ — gated local label model (plan §4.5)

Built now, **gated**: `train.py` exits early with "need ≥300 labels, have N" until
`data/labels.jsonl` has ≥ `ml.min_labels` (config opswatch.json) rows. No venv is created
until the gate opens (nothing to train on yet).

- `train.py` — catboost/scikit-learn binary classifier: target useful/missed = 1, noise/mute = 0.
  Features: 4 Jev probabilities + confidence + code features (count, rate_vs_baseline,
  seen_7d_count, held_7d, source one-hot, hour CT). Time-based split. Reports AUC/precision/recall
  vs the Jev bands. Emits `ml/model.cbm` + `ml/eval-<date>.md`.
- `score.py` — shadow scorer: runs on Jarvon, writes `ml_p` into a separate
  `data/ml-shadow.jsonl` (NO decisions, NO sends).
- `requirements.txt` — pinned deps for the venv (`~/clawd/projects/ops-watch/ml/.venv`, never system Python on .110).

Setup when the gate opens:
```
cd ~/clawd/projects/ops-watch/ml
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python train.py --labels <fetched labels.jsonl> --shadow <fetched jev-v2-shadow.jsonl>
```
