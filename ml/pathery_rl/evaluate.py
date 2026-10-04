"""Evaluation sets and policy evaluation.

An evaluation set is a list of {id, type, code, ref}: held-out generated maps (seeds disjoint from
training) with a reference score from the SA solver. No history maps: those are the validation
and test splits, and the test split is used once, at the end (docs/rl-agent-plan.md §4.1).

    python -m ml.pathery_rl.evaluate build --maps ml/data/eval-maps.jsonl --type simple --n 200 --seconds 5
    python -m ml.pathery_rl.evaluate run --model ml/runs/NAME/best.zip --set ml/data/eval-simple.json --frame 6x13
"""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

import pathery_rs

from .vec_env import PatheryVecEnv


def load_maps(path: Path, types: list[str], fits: tuple[int, int] | None = None) -> list[dict]:
    """Rows of a tools/dump-maps.ts JSONL file, filtered by type (and frame size)."""
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l]
    out = [r for r in rows if r["type"] in types]
    if fits:
        h, w = fits
        out = [r for r in out if int(r["code"].split(".")[1]) <= h and int(r["code"].split(".")[0]) <= w]
    return out


def build_set(maps: Path, map_type: str, n: int, seconds: float, out: Path, jobs: int = 18) -> list[dict]:
    rows = [r for r in load_maps(maps, [map_type]) if r["source"] == "generator"][:n]
    with ThreadPoolExecutor(jobs) as pool:
        refs = list(pool.map(lambda r: pathery_rs.solve_sa(r["code"], seconds=seconds, seed=7)[0], rows))
    data = [{"id": r["id"], "type": r["type"], "code": r["code"], "ref": ref} for r, ref in zip(rows, refs)]
    out.write_text(json.dumps(data, indent=1), encoding="utf-8")
    return data


def play(
    model, codes: list[str], frame: tuple[int, int], deterministic: bool = True, repeats: int = 1, seed: int = 0
) -> np.ndarray:
    """Plays each map `repeats` times with the policy; returns the final scores, shape
    [repeats * len(codes)] (play r of map i at index r * len(codes) + i)."""
    if seed:
        import torch

        torch.manual_seed(seed)
    env = PatheryVecEnv(codes, len(codes) * repeats, frame[0], frame[1], fixed=True)
    obs = env.reset()
    scores = np.full(len(codes) * repeats, -1, dtype=np.int64)
    while (scores < 0).any():
        masks = env.action_masks()
        actions, _ = model.predict(obs, action_masks=masks, deterministic=deterministic)
        obs, _, done, infos = env.step(actions)
        for i in np.flatnonzero(done):
            if scores[i] < 0:
                scores[i] = infos[i]["score"]
    return scores


def evaluate(model, eval_set: list[dict], frame: tuple[int, int], best_of: int = 0) -> dict:
    """Deterministic policy (best_of = 0), or the best of `best_of` sampled episodes per map."""
    codes = [m["code"] for m in eval_set]
    if best_of:
        scores = play(model, codes, frame, deterministic=False, repeats=best_of, seed=1)
        scores = scores.reshape(best_of, len(codes)).max(axis=0)
    else:
        scores = play(model, codes, frame)
    refs = np.array([m["ref"] for m in eval_set], dtype=np.float64)
    ratios = scores / refs
    return {
        "mean_ratio": float(ratios.mean()),
        "min_ratio": float(ratios.min()),
        "at_ref": float((scores >= refs).mean()),
        "scores": scores.tolist(),
    }


def parse_frame(s: str) -> tuple[int, int]:
    h, w = s.lower().split("x")
    return int(h), int(w)


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--maps", type=Path, default=Path("ml/data/eval-maps.jsonl"))
    b.add_argument("--type", default="simple")
    b.add_argument("--n", type=int, default=200)
    b.add_argument("--seconds", type=float, default=5.0)
    b.add_argument("--out", type=Path)
    r = sub.add_parser("run")
    r.add_argument("--model", type=Path, required=True)
    r.add_argument("--set", type=Path, required=True)
    r.add_argument("--frame", default="19x27")
    r.add_argument("--best-of", type=int, default=0, help="best of K sampled episodes per map")
    args = ap.parse_args()
    if args.cmd == "build":
        out = args.out or Path(f"ml/data/eval-{args.type}.json")
        data = build_set(args.maps, args.type, args.n, args.seconds, out)
        print(f"{len(data)} maps -> {out}, mean ref {np.mean([d['ref'] for d in data]):.1f}")
    else:
        from sb3_contrib import MaskablePPO

        model = MaskablePPO.load(args.model, device="cuda")
        res = evaluate(model, json.loads(args.set.read_text(encoding="utf-8")), parse_frame(args.frame), args.best_of)
        print({k: v for k, v in res.items() if k != "scores"})


if __name__ == "__main__":
    main()
