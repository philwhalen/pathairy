"""Prints a run's TensorBoard scalars at a few points: python -m ml.pathery_rl.tb_summary ml/runs/NAME [points]"""

import sys
from pathlib import Path

from tensorboard.backend.event_processing.event_accumulator import EventAccumulator

TAGS = [
    "eval/mean_ratio",
    "rollout/final_score_mean",
    "rollout/ep_rew_mean",
    "train/entropy_loss",
    "train/approx_kl",
    "train/clip_fraction",
    "train/explained_variance",
    "train/value_loss",
]


def main() -> None:
    run = Path(sys.argv[1])
    points = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    files = sorted((run / "tb").rglob("events.out.tfevents.*"))
    acc = {}
    for f in files:
        ea = EventAccumulator(str(f), size_guidance={"scalars": 0})
        ea.Reload()
        for tag in ea.Tags()["scalars"]:
            acc.setdefault(tag, []).extend((e.step, e.value) for e in ea.Scalars(tag))
    tags = [t for t in TAGS if t in acc] + sorted(t for t in acc if t.startswith("eval_") and t.endswith("mean_ratio"))
    steps = sorted({s for s, _ in acc.get("train/approx_kl", [])})
    if not steps:
        print("no data")
        return
    picks = [steps[round(i * (len(steps) - 1) / (points - 1))] for i in range(points)]
    print(f"{'tag':32}" + "".join(f"{p:>12,}" for p in picks))
    for t in tags:
        series = sorted(acc[t])
        row = []
        for p in picks:
            before = [v for s, v in series if s <= p]
            row.append(f"{before[-1]:>12.4f}" if before else f"{'-':>12}")
        print(f"{t:32}" + "".join(row))


if __name__ == "__main__":
    main()
