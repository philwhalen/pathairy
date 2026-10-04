"""MaskablePPO training on generated maps (docs/rl-agent-plan.md Phase 3).

    python -m ml.pathery_rl.train_ppo --run ml/runs/simple-v1 --types simple --frame 6x13 \\
        --eval-set ml/data/eval-simple.json --total-steps 20000000

- Logs to TensorBoard in <run>/tb (`tensorboard --logdir ml/runs`).
- Evaluates the deterministic policy on the eval set every --eval-every steps; keeps <run>/best.zip.
- Saves <run>/latest.zip every --ckpt-minutes (and at the end); --resume continues from it.
- Stops cleanly at the next rollout if <run>/STOP exists (or on Ctrl+C, after saving).
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
from sb3_contrib import MaskablePPO
from stable_baselines3.common.callbacks import BaseCallback

from .evaluate import evaluate, load_maps, parse_frame
from .policy import PatheryPolicy
from .vec_env import PatheryVecEnv


class RunCallback(BaseCallback):
    def __init__(self, run: Path, eval_sets: dict[str, list[dict]], frame, eval_every: int, ckpt_minutes: float):
        super().__init__()
        self.run, self.eval_sets, self.frame = run, eval_sets, frame
        self.eval_every, self.ckpt_s = eval_every, ckpt_minutes * 60
        self.next_eval = 0
        self.last_ckpt = time.time()
        self.best = -1.0
        self.scores: list[int] = []
        best_file = run / "best.json"
        if best_file.exists():
            self.best = json.loads(best_file.read_text())["mean_ratio"]

    def _on_training_start(self) -> None:
        self.next_eval = self.num_timesteps

    def _on_step(self) -> bool:
        for info in self.locals["infos"]:
            if "score" in info:
                self.scores.append(info["score"])
        if self.n_calls % 200 == 0 and (self.run / "STOP").exists():
            print("STOP file found: stopping.", flush=True)
            return False
        return True

    def _on_rollout_end(self) -> None:
        if self.scores:
            self.logger.record("rollout/final_score_mean", float(np.mean(self.scores)))
            self.scores.clear()
        if self.num_timesteps >= self.next_eval:
            self.next_eval = self.num_timesteps + self.eval_every
            parts, means = [], {}
            for name, eval_set in self.eval_sets.items():
                res = evaluate(self.model, eval_set, self.frame)
                prefix = "eval" if len(self.eval_sets) == 1 else f"eval_{name}"
                for k in ("mean_ratio", "min_ratio", "at_ref"):
                    self.logger.record(f"{prefix}/{k}", res[k])
                means[name] = res["mean_ratio"]
                parts.append(f"{name} {res['mean_ratio']:.4f} (min {res['min_ratio']:.3f}, at ref {res['at_ref']:.2f})")
            mean = float(np.mean(list(means.values())))
            if len(self.eval_sets) > 1:
                self.logger.record("eval/mean_ratio", mean)
            print(f"[{self.num_timesteps:>11,}] eval {'  '.join(parts)}", flush=True)
            if mean > self.best:
                self.best = mean
                self.model.save(self.run / "best.zip")
                (self.run / "best.json").write_text(
                    json.dumps({"mean_ratio": self.best, "per_set": means, "steps": self.num_timesteps})
                )
        if time.time() - self.last_ckpt > self.ckpt_s:
            self.model.save(self.run / "latest.zip")
            self.last_ckpt = time.time()

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", type=Path, required=True)
    ap.add_argument("--types", default="simple")
    ap.add_argument("--frame", default="6x13")
    ap.add_argument("--train-maps", type=Path, default=Path("ml/data/train-maps.jsonl"))
    ap.add_argument("--eval-set", required=True, help="comma-separated eval set files")
    ap.add_argument("--init-from", type=Path, help="start from this model's weights (any frame size)")
    ap.add_argument("--n-envs", type=int, default=256)
    ap.add_argument("--n-steps", type=int, default=32)
    ap.add_argument("--batch-size", type=int, default=2048)
    ap.add_argument("--n-epochs", type=int, default=4)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--ent-coef", type=float, default=0.01)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--gae-lambda", type=float, default=0.95)
    ap.add_argument("--vf-coef", type=float, default=0.5)
    ap.add_argument("--channels", type=int, default=64)
    ap.add_argument("--blocks", type=int, default=6)
    ap.add_argument("--total-steps", type=int, default=20_000_000)
    ap.add_argument("--eval-every", type=int, default=500_000)
    ap.add_argument("--ckpt-minutes", type=float, default=30)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--gpu-mem-fraction", type=float, default=0.0)
    args = ap.parse_args()

    frame = parse_frame(args.frame)
    args.run.mkdir(parents=True, exist_ok=True)
    (args.run / "STOP").unlink(missing_ok=True)
    (args.run / "args.json").write_text(json.dumps({k: str(v) for k, v in vars(args).items()}, indent=1))
    maps = load_maps(args.train_maps, args.types.split(","), fits=frame)
    print(f"{len(maps)} training maps ({args.types}) in frame {frame}", flush=True)
    env = PatheryVecEnv([m["code"] for m in maps], args.n_envs, frame[0], frame[1], seed=args.seed)
    eval_sets = {
        Path(p).stem.removeprefix("eval-"): json.loads(Path(p).read_text(encoding="utf-8"))
        for p in args.eval_set.split(",")
    }
    torch.set_float32_matmul_precision("high")
    if args.gpu_mem_fraction:
        # Keeps two runs from filling VRAM (on Windows, overflow spills to system RAM and crawls).
        torch.cuda.set_per_process_memory_fraction(args.gpu_mem_fraction)

    latest = args.run / "latest.zip"
    if args.resume and latest.exists():
        model = MaskablePPO.load(latest, env=env, device="cuda", tensorboard_log=str(args.run / "tb"))
        print(f"resumed at {model.num_timesteps:,} steps", flush=True)
    else:
        model = MaskablePPO(
            PatheryPolicy,
            env,
            learning_rate=args.lr,
            n_steps=args.n_steps,
            batch_size=args.batch_size,
            n_epochs=args.n_epochs,
            gamma=1.0,
            gae_lambda=args.gae_lambda,
            clip_range=args.clip,
            ent_coef=args.ent_coef,
            vf_coef=args.vf_coef,
            policy_kwargs={"channels": args.channels, "blocks": args.blocks},
            tensorboard_log=str(args.run / "tb"),
            device="cuda",
            seed=args.seed,
            verbose=0,
        )
        if args.init_from:
            src = MaskablePPO.load(args.init_from, device="cuda")
            model.policy.load_state_dict(src.policy.state_dict())
            print(f"initialized from {args.init_from}", flush=True)
    n_params = sum(p.numel() for p in model.policy.parameters())
    print(f"policy parameters: {n_params:,}", flush=True)
    cb = RunCallback(args.run, eval_sets, frame, args.eval_every, args.ckpt_minutes)
    t0 = time.time()
    try:
        model.learn(
            total_timesteps=args.total_steps,
            callback=cb,
            reset_num_timesteps=not (args.resume and latest.exists()),
            tb_log_name="ppo",
            progress_bar=False,
        )
    except KeyboardInterrupt:
        print("interrupted", flush=True)
    finally:
        model.save(latest)
        dt = time.time() - t0
        print(f"saved {latest} at {model.num_timesteps:,} steps ({dt / 60:.1f} min, best eval {cb.best:.4f})", flush=True)


if __name__ == "__main__":
    main()
