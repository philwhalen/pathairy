# RL agent — results log

One entry per phase of docs/rl-agent-plan.md: what was tried, the numbers, and what they mean.

## Phase 2 prep (2026-10-03, overnight, branch `ml/phase-2`, not reviewed yet)

Built on Windows, natively, while Phase 0 (WSL2) is pending. Nothing here needs WSL, and nothing
used the GPU. No pathery.com requests were made.

**What exists**

| Piece                     | Where                                         | Status                                                                     |
| ------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| Rust engine port          | `ml/engine-rs/src/{mapcode,grid,engine}`      | 100% parity: 56 fixtures, 602 scoreboard rows, 3,000 TS-vs-Rust cases      |
| RL environment            | `ml/engine-rs/src/env.rs`                     | Mask exact (tested against the engine for every action); rewards telescope |
| Batched VecEnv for Python | `ml/engine-rs/src/python.rs` (PyO3, rayon)    | Built with maturin; pytest smoke tests pass                                |
| Baselines                 | `baselines.rs`, `solver.rs`, `ml/eval.py`     | Random, greedy, brute force (tiny maps), SA (Rust port)                    |
| Training map dump         | `tools/dump-maps.ts`, `tools/map-variants.ts` | Generator + site samples, 8 symmetries, jitter                             |
| Polite downloader         | `tools/fetch/polite.mjs`                      | Written and dry-run only (A 330, B 560, C 300 requests)                    |

Not done from Phase 2: the SB3 `VecEnv` subclass and the network benchmark (both need PyTorch,
which belongs in WSL), and baselines on the validation split (batch A isn't downloaded).

**Numbers** (i5-13600K, 20 threads)

- Engine: 6.1 µs per score on daily-size maps (TS 14 µs), 20 µs on larger maps; 1.86 M/s on 20
  threads (plan estimate 0.5–1.5 M/s).
- VecEnv, random policy, 256 envs: Simple 84k, Normal 52k, Complex 26k, Centralized 37k env
  steps/s (observation + mask included).
- Baselines on the solver tuning set (84 maps outside the history; ratio to the best score
  found by long SA runs):

  | Group              | Random | Greedy | SA 2 s | SA 10 s |
  | ------------------ | ------ | ------ | ------ | ------- |
  | Simple             | 0.398  | 0.539  | 1.000  | 1.000   |
  | Normal             | 0.332  | 0.672  | 0.998  | 1.000   |
  | Complex            | 0.230  | 0.498  | 0.958  | 0.978   |
  | Centralized        | 0.220  | 0.559  | 0.993  | 0.995   |
  | Site Complex       | 0.252  | 0.555  | 0.984  | 0.993   |
  | Mid (21×15)        | 0.168  | 0.557  | 0.891  | 0.960   |
  | Large (Ultra-like) | 0.141  | 0.213  | 0.840  | 0.928   |
  | **Overall**        | 0.244  | 0.517  | 0.958  | 0.981   |

  Greedy is weak (0.52): one-wall-at-a-time gains run out quickly, which is a useful reminder
  that the policy must learn walls whose payoff comes later. The Rust SA matches the TS SA
  (0.959 vs 0.951 at 2 s on the same maps).

**Finding that changes the plan:** the legal-mask shortcut in §2 ("only path cells can block") is
wrong on teleport maps. Details and the fix (`Engine::support_cells`) are in
`ml/engine-rs/README.md`. The plan's §2 row now carries a correction note.

**Design choices to review** (in `env.rs`):

- Observation: 23 planes. The plan's "distance to next target" plane became "path-1 progress"
  (when each cell is first visited, scaled 1–255), because "next target" is ambiguous for a
  static board.
- Teleport pair ids and checkpoint numbers are value planes (plus one-hot c1–c5+), not one-hot
  per pair.
- "Unlimited budget" = the budget covers every wallable cell; then walls-left is
  `min(left, 255)` instead of a fraction.
- Default reward scale = the no-walls score. The plan's choice (greedy score) is available:
  `VecEnv(..., scales=[...])` with `pathery_rs.greedy(code)[0]`.

## Phase 3 — PPO on Simple (2026-10-04, overnight, branch `ml/phase-3`, not reviewed yet)

**Run on native Windows**, not WSL: Phil OK'd GPU use for the night and WSL isn't installed yet.
PyTorch 2.14 + CUDA 13, SB3 2.9 / sb3-contrib 2.9 in a throwaway venv; no `torch.compile`. All
code is plain Python and should run unchanged in WSL.

**Setup**

- `ml/pathery_rl/vec_env.py`: SB3 `VecEnv` over the Rust batched env (one Rust call per step).
  Plane bounds are declared exactly, which also stops SB3 treating the planes as an image.
- `ml/pathery_rl/policy.py`: fully convolutional net (6 residual blocks × 64 channels, global
  pooling bias every 3rd block, 481k parameters). Per-cell logits from a 1×1 conv, STOP and
  value from pooled features. It is frame-size independent, so Simple trained in a 6×13 frame
  (instead of padding to 19×27), and the weights load into any frame later.
- Training maps: 154k Simple maps (20k generated seeds + 20 site samples, 4 flips each, 1
  jitter variant each), `tools/dump-maps.ts`.
- Evaluation: 200 held-out generated Simple maps (other seeds), reference = Rust SA at 3 s
  (which matched the best human on all 20 historical Simple maps). Deterministic policy, one
  pass. No history maps were used.
- MaskablePPO: 256 envs × 32 steps, batch 2048, 4 epochs, lr 3e-4, γ = 1, λ = 0.95, clip 0.2,
  entropy 0.01.

**Result:** stopped at 16.2M steps (31 min, ~8.7k steps/s, GPU-bound on many tiny kernels).

| Player (Simple eval set, ratio to SA reference) | Mean  | Min   | At reference |
| ----------------------------------------------- | ----- | ----- | ------------ |
| Random legal walls                              | 0.446 |       |              |
| Greedy (best single wall, repeated)             | 0.598 |       |              |
| Policy, 0.2M steps                              | 0.849 | 0.429 | 11%          |
| Policy, 3M steps                                | 0.933 | 0.511 | 39%          |
| Policy, 3M steps, best of 64 samples            | 0.977 | 0.826 | 69%          |
| **Policy, 16M steps (final)**                   | 0.977 | 0.758 | 69%          |

Phase 3's bar ("beats greedy, ≥ 0.95 mean ratio") is met by 6M steps, measured against the SA
reference on generated maps. The plan's bar is against humans on validation maps, which aren't
downloaded yet. Still improving when stopped.

**What the curves say** (`python -m ml.pathery_rl.tb_summary ml/runs/simple-v1`):

- _Entropy_ collapses within the first ~1M steps (−3.99 → −0.43) and then decays slowly to
  −0.29. The policy commits early; sampling still helps a lot (best-of-64 adds +0.04 at 3M).
  Worth trying a higher entropy coefficient or an entropy schedule.
- _Approx KL_ sits at 0.04–0.06 with _clip fraction_ 0.10–0.14. That's high for PPO (0.01–0.02
  is typical), so updates are large. Training stayed stable, but a lower lr or `target_kl`
  may help later phases.
- _Explained variance_ rises to 0.95: the value head predicts the return-to-go well, as you'd
  expect with deterministic dynamics and a per-map reward scale.
