"""Baseline evaluation (docs/rl-agent-plan.md Phase 2 step 3): random, greedy and SA players on a
set of maps, reported in raw moves and as a ratio to a reference score per map.

    python ml/eval.py MAPS.json [--players random,greedy,sa2,sa30] [--jobs 16] [--out results.json]

MAPS.json is a list of {"id", "group", "code", "best"} objects ("best" = the reference score, e.g.
the best human score; 0 if unknown), like ml/engine-rs/tests/data/bench-maps.json. The plan runs
this on the validation split only; the test split is used once, in Phase 7.

Needs the pathery_rs module (`maturin develop --release` in ml/engine-rs) and numpy.
"""

import argparse
import json
import statistics
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pathery_rs

PLAYERS = {
    "random": lambda code: pathery_rs.random_play(code, episodes=20, seed=1),
    "greedy": lambda code: pathery_rs.greedy(code)[0],
    "sa2": lambda code: pathery_rs.solve_sa(code, seconds=2.0, seed=1)[0],
    "sa10": lambda code: pathery_rs.solve_sa(code, seconds=10.0, seed=1)[0],
    "sa30": lambda code: pathery_rs.solve_sa(code, seconds=30.0, seed=1)[0],
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("maps", type=Path)
    ap.add_argument("--players", default="random,greedy,sa2")
    ap.add_argument("--jobs", type=int, default=16, help="maps solved in parallel (SA releases the GIL)")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args()
    maps = json.loads(args.maps.read_text(encoding="utf-8"))
    players = args.players.split(",")
    rows = []
    with ThreadPoolExecutor(args.jobs) as pool:
        for p in players:
            scores = list(pool.map(PLAYERS[p], [m["code"] for m in maps]))
            for m, s in zip(maps, scores):
                rows.append({"id": m["id"], "group": m["group"], "player": p, "score": s, "best": m["best"]})

    groups = sorted({m["group"] for m in maps})
    print(f"{'group':14}" + "".join(f"{p:>16}" for p in players))
    for g in groups + ["overall"]:
        cells = []
        for p in players:
            rs = [
                r["score"] / r["best"]
                for r in rows
                if r["player"] == p and r["best"] > 0 and (g == "overall" or r["group"] == g)
            ]
            cells.append(f"{statistics.mean(rs):>16.3f}" if rs else f"{'-':>16}")
        print(f"{g:14}" + "".join(cells))
    print("(mean ratio to the reference score)")
    if args.out:
        args.out.write_text(json.dumps(rows, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
