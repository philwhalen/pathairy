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

## Phase 4 — PPO generalist, four generated types (2026-10-04, overnight, branch `ml/phase-4`, not reviewed yet)

Also run on native Windows, with the same venv as Phase 3. No new code: the `train_ppo.py` flags it
uses (`--init-from`, `--gpu-mem-fraction`, `--resume`) already went in with the Phase 3 commit.

**Setup** (`ml/runs/std-init`)

- One checkpoint for Simple, Normal, Complex and Centralized, all in a 9×19 frame (the largest
  of the four types). Training maps: 632k (generated seeds plus site samples, flips and jitter).
- Eval: 200 held-out generated maps per type, ratio to SA at 3 s. Mean references: 40.5 / 81.8
  / 210.0 / 191.3.
- Initialized from the Phase 3 Simple checkpoint, using the same 6 × 64 net. The net is
  frame-size independent, so the weights load into the bigger frame unchanged.
- 512 envs × 32 steps, batch 4096, lr 2e-4, other settings as in Phase 3.
- Types are mixed uniformly from the start. The plan's curriculum and "oversample the weakest
  type" sampler, and its bigger net, were **not** done (see below).

**Result:** stopped by the overnight deadline at 59.8M steps (227 min, ~4.4k steps/s).

| Policy (ratio to SA reference: mean / min / at-ref) | Simple             | Normal             | Complex            | Centralized        |
| --------------------------------------------------- | ------------------ | ------------------ | ------------------ | ------------------ |
| Greedy baseline                                     | 0.598              | 0.605              | 0.559              | 0.531              |
| Phase 3 Simple specialist, deterministic            | 0.977 / 0.76 / 69% |                    |                    |                    |
| Phase 3 Simple specialist, best of 64               | 0.989 / 0.76 / 83% |                    |                    |                    |
| Generalist at start (= Phase 3 weights)             | 0.966              | 0.789              | 0.565              | 0.647              |
| **Generalist, deterministic** (54M, best.zip)       | 0.963 / 0.64 / 58% | 0.931 / 0.58 / 25% | 0.785 / 0.47 / 3%  | 0.887 / 0.55 / 7%  |
| Generalist, best of 16 samples                      | 0.981 / 0.76 / 73% | 0.964 / 0.64 / 40% | 0.873 / 0.58 / 4%  | 0.938 / 0.57 / 20% |
| Generalist, best of 64 samples                      | 0.988 / 0.82 / 81% | 0.973 / 0.64 / 50% | 0.900 / 0.58 / 9%  | 0.949 / 0.58 / 29% |
| Generalist, last checkpoint (59.8M), deterministic  | 0.960              | 0.932              | 0.789              | 0.882              |

Best-of-K is K sampled episodes per map, keeping the best one. That's 22 s for 200 Complex
maps at K = 64 on the GPU, a cheap stand-in for search.

`best.zip` was chosen by these same eval sets, so its numbers are slightly optimistic. The last
checkpoint, which wasn't selected, is within ±0.005, so the bias is small. The validation split
(history maps, batch A) still needs downloading to do this properly.

**Reading it**

- Phase 4's "done when" is met: one checkpoint plays all four types, with policy-only results
  per type. As the plan expected, it trails SA most on Complex (0.785 policy-only).
- Simple barely moved: 0.966 → 0.963, while Normal +0.14, Complex +0.22, Centralized +0.24.
  There was no catastrophic forgetting.
- Gains were flattening when the run stopped. Over the last 20M steps: Normal +0.005,
  Complex +0.01, Centralized +0.02 (eval noise is about ±0.005).
- Sampling helps most on Complex: +0.115 from best-of-64, against +0.025 on Simple. The
  policy's first choice is often wrong there, but a good line is usually in its top
  candidates. That's the case for search (Phase 5).
- Curves (`tb_summary ml/runs/std-init`) look healthier than Phase 3. Entropy settles at
  about −0.40, approx KL at 0.03–0.04, clip fraction about 0.10, explained variance 0.93.
  lr 2e-4 versus 3e-4 roughly halved the KL early on.

**Bigger net (not done).** A 10 × 96 net from scratch (`ml/runs/std-big`, 1.75M parameters)
had to drop to batch 1024 to fit next to the main run. It shared the GPU and cut both runs'
throughput, so I stopped it at 512k steps (best 0.28; nothing learned about size yet). The plan
item "net grows to 10–12 blocks × 96–128" is still open. Do it when the GPU isn't shared.
Initializing from the 6 × 64 weights would need a net-surgery step.

**Lesson: Windows VRAM spill.** When two runs together exceed VRAM, the Windows driver
silently pages GPU memory to system RAM instead of failing. Throughput fell from ~5k to ~330
steps/s with no error. Fix: `--gpu-mem-fraction` (`torch.cuda.set_per_process_memory_fraction`),
which turns the spill into a clean OOM. I also dropped `cudnn.benchmark`, whose autotuning
workspaces made the spill worse. WSL behaves the same way (it shares the Windows driver), so
keep the flag.

**Next (open Phase 4 items, before or alongside Phase 5)**

1. Download batch A and validate against humans (Phase 1 is still not done; it needs Phil's
   "yes").
2. Weakest-type sampler: oversample Complex.
3. Bigger net on an otherwise idle GPU.
4. Entropy: Phase 3's early collapse didn't recur from the warm start, but an entropy schedule
   is still untested.
