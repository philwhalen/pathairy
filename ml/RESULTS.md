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
