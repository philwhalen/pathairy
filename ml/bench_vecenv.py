"""VecEnv throughput with a random legal policy: python ml/bench_vecenv.py [n_envs=256] [seconds=5]

Uses generated maps from ml/data/train-maps.jsonl (tools/dump-maps.ts) per type, in the padded
19x27 frame the PPO phases use. Reports env steps/s including observations and masks.
"""

import json
import sys
import time
from pathlib import Path

import numpy as np

import pathery_rs

n_envs = int(sys.argv[1]) if len(sys.argv) > 1 else 256
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
rows = [json.loads(l) for l in Path("ml/data/train-maps.jsonl").read_text(encoding="utf-8").splitlines() if l]
rng = np.random.default_rng(0)
for t in ["simple", "normal", "complex", "centralized"]:
    codes = [r["code"] for r in rows if r["type"] == t and r["source"] == "generator"][:500]
    env = pathery_rs.VecEnv(codes, n_envs=n_envs, frame_h=19, frame_w=27, seed=1)
    env.reset()
    steps, episodes, t0 = 0, 0, time.perf_counter()
    while time.perf_counter() - t0 < seconds:
        masks = env.action_masks()
        # Random legal action per env (vectorized: random scores, masked argmax).
        acts = np.argmax(np.where(masks, rng.random(masks.shape), -1.0), axis=1)
        _, _, done, _, _ = env.step(acts.astype(np.int64))
        steps += n_envs
        episodes += int(done.sum())
    dt = time.perf_counter() - t0
    print(f"{t:12} {steps / dt:>9.0f} env steps/s  {episodes / dt:>7.0f} episodes/s  ({n_envs} envs)")
