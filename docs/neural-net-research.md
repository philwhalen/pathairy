# Training a Local Neural Net to Play Pathery — Research Report

Written 2026-10-03. **Update (same day): the project now runs in WSL2. See `docs/rl-agent-plan.md` §5, which supersedes this report's §7 environment advice.** Builds on `docs/original-site-architecture.md` (rules) and
`docs/implementation-plan.md` (Phase 7, solver). Numbers marked **measured** were run on this
machine today. Numbers marked **estimate** are back-of-envelope figures.

## 1. Short answer

**Yes. Your machine can easily train the networks this game needs.** A Pathery board is tiny: at
most 19×9 = 171 cells for the daily maps, or 27×19 = 513 for Ultra. A game is at most ~22 actions
(one per wall). The right-sized network is 1–10 M parameters, about 10–100× smaller than
AlphaZero/KataGo Go nets, and it uses well under 2 GB of your 16 GB of VRAM.

The limit will be the **CPU-side game engine**, not the GPU. Every training example needs many
path evaluations. The big engineering item is to get the engine into the training loop quickly
(§5), not to scale the model.

The harder question is whether a neural net can **beat the search we already have**. Today's
simulated-annealing (SA) solver already matches the best human score on every Simple and Normal
map (§3). The net is worth building for Complex maps (teleports, many checkpoints) and the large
special maps, where SA falls 5–50% short of the best players.

### Hardware check (measured)

| Component | What you have                                                                                                                                               | Verdict                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| GPU       | `nvidia-smi` reports an **RTX 4070 Ti SUPER**, 16 GB, Ada (compute capability 8.9), driver 610.74 (CUDA 13.3). Not a "4080 Ti Super" (no such card exists). | Plenty. Supports bf16/fp16 tensor cores, and PyTorch has native Windows CUDA wheels for it. |
| CPU       | i5-13600K, 6 P-cores + 8 E-cores, 20 threads                                                                                                                | Good, and the part that matters most (engine evaluations, search, data generation).         |
| RAM       | 32 GB                                                                                                                                                       | Enough. A replay buffer of millions of positions fits as uint8 planes (§6).                 |
| Toolchain | Python 3.14.3, Node 24, Rust 1.95 / cargo; no WSL, no CUDA toolkit                                                                                          | Fine. No CUDA toolkit or WSL needed (§7).                                                   |

## 2. What "playing Pathery" is, as an ML problem

- **Single-player, deterministic, one-shot optimization.** Given a map and a wall budget _k_,
  choose ≤ _k_ wallable cells to maximize total path moves without blocking the path. No opponent,
  no hidden information, no randomness after the map is generated.
- **It is NP-hard in general.** Without teleports/ice/checkpoints it is the _k most vital nodes_
  problem for shortest paths (pick _k_ nodes whose removal most lengthens the shortest s–t path),
  which is NP-hard even with unit lengths (Bar-Noy, Khuller & Schieber 1995). Pathery adds
  checkpoints, teleports and ice on top. So any approach is a heuristic, and **search will always
  matter**. A network alone will rarely land on the exact optimum. A network that guides a search
  can find it much faster and more often.
- **Sequential framing for learning:** state = (map, walls placed so far), action = next wall cell
  (≤ 171 choices, masked to wallable, non-blocking cells), episode length = wall budget, reward
  = final move count. This is the same structure as AlphaZero and as S2V-DQN (Khalil et al. 2017),
  which learns to pick graph nodes one at a time for NP-hard graph problems. "Network Interdiction
  Goes Neural" (2024) applies GNNs to almost this exact problem family.
- **The engine is the simulator and the rules oracle.** Exact tie-breaking (U, R, D, L priority,
  row-major source choice, teleport spending) decides the score. So the net only _proposes_ walls,
  and the real engine always _scores_ them.

## 3. The baseline a neural net must beat (measured)

The SA solver parked on `wip/solver` (`tools/solve.ts --scoreboard`) was run today on all 83
historical daily maps in `tests/fixtures/scoreboard.json`: 2 s per map, 16 jobs in parallel. The
**ratio** is the AI score divided by the best human score on that map's scoreboard.

| Map type                | n   | median ratio | min ratio                             |
| ----------------------- | --- | ------------ | ------------------------------------- |
| Simple                  | 20  | 1.000        | 1.000                                 |
| Normal                  | 20  | 1.000        | 0.990                                 |
| Complex                 | 20  | 0.993        | 0.842                                 |
| Dualing Paths           | 2   | 1.000        | 1.000                                 |
| Side to Side            | 3   | 1.000        | 0.942                                 |
| Centralized             | 2   | 0.957        | 0.956                                 |
| ABC's                   | 3   | 0.955        | 0.907                                 |
| Loop craziness          | 3   | 0.968        | 0.905                                 |
| Teleport Madness        | 2   | 0.947        | 0.894                                 |
| Thirty / Thirty Too     | 3   | 0.86–0.91    | 0.784                                 |
| Rocky Maze              | 1   | 0.889        | 0.889                                 |
| Seeing Double           | 1   | 0.841        | 0.841                                 |
| Ultra Complex Unlimited | 3   | **0.538**    | **0.490**                             |
| **Overall**             | 83  | 1.000        | mean **0.959**, 53/83 matched or beat |

Takeaways:

1. **Simple/Normal are solved** by plain search in 2 s. A net adds nothing there except speed.
2. **Complex maps** have a long tail of failures (0.84–0.89). Those are teleport/multi-checkpoint
   maps where good solutions need coordinated walls that local moves can't reach one at a time.
   A learned prior helps most with exactly this.
3. **Large / unlimited-wall maps** (Ultra 27×19) are where SA collapses. The search space grows
   far beyond what 2 s of local moves can explore. This is the biggest headroom. It is also the
   least represented in training data, since our generator produces only the four standard types.
4. Some gap is just time and tuning: SA was stopped mid-tuning and ran 2 s per map. **Run SA at 30 s
   and 120 s before investing in a net.** If the gap closes, the net's value is speed, not quality.

## 4. Approaches, ranked

### A. Supervised "wall heatmap" + NN-seeded search (recommended first step)

1. Generate many maps (the existing generator, by seed) and solve each with SA for a few seconds.
   Keep the best wall set and score.
2. Train a network to predict, for each cell, the probability that it holds a wall in the best
   solution (policy head), and the best score (value head).
3. At play time: seed SA with the net's top-_k_ cells, and bias SA's "relocate" move toward
   high-probability cells.

- **Cost:** low. Data generation is embarrassingly parallel on the CPU. Training takes minutes to
  an hour on the GPU.
- **Expected gain:** SA converges much faster. Quality improves where SA was budget-limited. It
  will not exceed the quality of its teacher by much on its own.
- **Also good for:** a "hint" heatmap in the UI, and estimating a map's difficulty instantly
  (value head) for the generator (plan Phase 7).

### B. Expert iteration / Gumbel AlphaZero self-play (the real "learns to play" option)

- Policy-value net + tree search (MCTS) over wall placements, with the Rust engine (§5) as the
  simulator. Search results become the training targets for the policy. The value head learns to
  predict the final score. The improved net then guides the next round of search. This is the
  AlphaZero loop, in its single-player form ("expert iteration").
- Use the **Gumbel AlphaZero** variant (Danihelka et al. 2022). It still improves the policy with
  very few simulations per move (16–32 instead of 800), so it suits a single-GPU budget.
- Single-player rewards need normalizing. Use either the score divided by the SA/human reference
  for that map, or "ranked reward" (did this game beat the agent's recent percentile?). Without
  this, the value target varies wildly between maps.
- Cheap structure helps search a lot: only cells **on or next to the current path** can change the
  score immediately (the SA solver already uses this). Mask or prioritise those actions.
- **Cost:** medium–high (a few weeks of part-time work). **Upside:** the only approach that can
  exceed the SA teacher, especially on Complex/Ultra.

### C. Plain model-free RL (PPO / DQN) — not recommended as the main route

MaskablePPO (sb3-contrib) or DQN on a Gymnasium wrapper would run, and it's a fun first
experiment. But the reward is sparse and delayed, and these methods have no lookahead. For
NP-hard placement puzzles they usually stop short of search-based methods. Use it only to check
that the environment works end to end.

### Hybrid that's easy to forget: tune SA first

Fixed time budgets, better restarts and multi-core SA may close part of the Complex gap with
zero ML. That gives a stronger teacher for A and a fairer bar for B. Do it as step 0.

## 5. Getting the engine into the training loop (the main engineering task)

Training is in Python (PyTorch). The engine is TypeScript. Options:

| Option                                                                         | Speed                                                                        | Effort    | Notes                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1. Port `score()` + path trace to Rust, expose to Python with PyO3/maturin** | fastest (estimate 2–5× Node per core, plus a parallel batch API with no GIL) | ~2–4 days | **Recommended.** The engine is ~450 lines of typed-array code with no allocation in the hot loop, so it ports almost line for line. Verify it with the existing 602 scoreboard rows + oracle fixtures, plus a differential test against the TS engine on random generated maps and wall sets. Rust is already installed. |
| 2. Port to Python + Numba                                                      | fast                                                                         | ~2 days   | Simpler toolchain. Parallel batches are clumsier than Rust + rayon.                                                                                                                                                                                                                                                      |
| 3. Keep TS, call Node workers over stdin/IPC in batches                        | ok if batched                                                                | ~1 day    | Per-call overhead swamps a 14 µs evaluation. Only works for whole batches (e.g. score 1,000 wall sets per message). Good for a prototype.                                                                                                                                                                                |
| 4. Train in TypeScript (TensorFlow.js)                                         | —                                                                            | —         | Not recommended. tfjs-node-gpu is effectively unmaintained, and CUDA support on Windows is poor.                                                                                                                                                                                                                         |
| 5. Engine on GPU (batched BFS in PyTorch)                                      | very fast in batch                                                           | high      | Distance fields vectorize well. The exact tie-breaking walk and teleports don't. Skip unless the CPU becomes the wall.                                                                                                                                                                                                   |

**Engine speed today (measured, `tools/bench-engine.ts`):** `engine.score` takes 2.2 µs (13×6),
7.4 µs (17×9), 14.2 µs (19×9) and 82 µs (27×19) per call on one Node thread. That's ~70k
evaluations/s per core on Complex-sized maps. **Estimate** for all 20 threads with a Rust port:
0.5–1.5 M evaluations/s.

The **map generator** isn't in the hot loop. Add a small `tools/dump-maps.ts` that writes
`{type, seed, code}` JSONL for millions of seeds, and parse the map codes in Python/Rust. Map
codes are already the shared format.

## 6. Model and compute sizing

**Network (recommended starting point):** a fully convolutional ResNet over the grid.

- **Input planes** (per cell): blocked-for-path-1, blocked-for-path-2, wallable, start1, start2,
  finish, checkpoint order (one-hot c1–c5 or normalized), teleport in/out by pair, ice, walls
  placed, walls remaining (broadcast), plus **engine-derived features**: current path cells,
  distance-to-next-target fields. Hand features like these made KataGo much more sample-efficient,
  and the engine computes them for free.
- **Trunk:** 8–12 residual blocks × 96–128 channels, with KataGo-style global pooling in a few
  blocks, because path length is a global property. ≈ 1.5–3 M parameters. A small transformer over
  the cells (171 tokens) is a reasonable alternative.
- **Heads:** policy = one logit per cell, masked. Value = normalized final score.
- Being fully convolutional lets one net handle every map size (pad to the largest, mask the rest).

**Compute (estimates):**

- One forward pass of a 10-block × 128-channel ResNet on 19×9 ≈ 1 GFLOP. At realistic small-conv
  utilization on the 4070 Ti SUPER (bf16), that's ~10–30k positions/s. Smaller nets (6×64) are
  several times faster.
- Gumbel AlphaZero with 32 simulations × 20 walls ≈ 640 net evaluations per game, so roughly
  20–40 games/s on the GPU side. **Over a million self-play games per day**, before any CPU limit.
- Supervised data: SA at ~2 s/map on 20 threads ≈ 30k solved maps/hour, ~700k/day.
- **VRAM:** model + optimizer + batch 1,024 is well under 2 GB. Even a 50 M-parameter net would
  fit for training.
- **RAM:** 1 M positions × ~24 planes × 171 cells as uint8 ≈ 4 GB. Or store just (map seed, walls)
  and recompute planes on the fly (a few bytes each).

## 7. What to install

Everything below runs **natively on Windows**. WSL2 is optional (see the end of the section).

| Tool                                | Why                                                                                                                                                                              | Install                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| NVIDIA driver                       | Already 610.74 (CUDA 13.3). **No separate CUDA toolkit needed**, since PyTorch wheels bundle the CUDA runtime.                                                                   | —                                                                         |
| **uv**                              | Fast Python project/venv manager. Pins the Python version and the PyTorch CUDA index per project.                                                                                | `winget install astral-sh.uv`                                             |
| **Python 3.14**                     | Already installed. Verified today: PyTorch 2.14.1 publishes Windows `cu130` and `cu132` wheels for cp314. If an optional package lags, `uv` can pin 3.13 for the ML folder only. | —                                                                         |
| **PyTorch 2.14 (CUDA 13.2)**        | Training and inference                                                                                                                                                           | `uv pip install torch --index-url https://download.pytorch.org/whl/cu132` |
| numpy, tensorboard, tqdm, pytest    | Arrays, training curves, progress, tests                                                                                                                                         | `uv pip install numpy tensorboard tqdm pytest`                            |
| **Rust + maturin + PyO3 (+ rayon)** | Native engine extension for Python (§5, option 1). Rust 1.95 already installed.                                                                                                  | `uv pip install maturin`, crates in `Cargo.toml`                          |
| onnx, onnxruntime(-gpu)             | Optional: export the net and run it without PyTorch. **onnxruntime-web** (npm) can run it in the browser game for an "AI hint".                                                  | `uv pip install onnx onnxruntime-gpu`                                     |
| triton-windows                      | Optional: makes `torch.compile` work on Windows (community build, has cp314 wheels). Skip until the GPU is the bottleneck.                                                       | `uv pip install triton-windows`                                           |
| gymnasium, sb3-contrib              | Optional: approach C sanity-check experiment                                                                                                                                     | `uv pip install gymnasium sb3-contrib`                                    |
| numba                               | Optional: engine option 2 instead of Rust                                                                                                                                        | `uv pip install numba`                                                    |

**WSL2 + Ubuntu**: install it only if you want JAX-based tools. DeepMind's `mctx` (reference
Gumbel MuZero/AlphaZero search) needs JAX, and JAX has no native Windows GPU support. LightZero
(a PyTorch MCTS zoo) has no Windows wheels and mainly targets Linux. Neither is needed: a
single-player Gumbel AlphaZero search for this game is a few hundred lines of Python + Rust.

Windows gotchas: PyTorch `DataLoader` workers use `spawn`, so put the entry point under
`if __name__ == "__main__":` and keep worker state picklable. Prefer the Rust extension's own
thread pool over many Python worker processes.

**Suggested layout** (separate from the web app, so the TS build is untouched):

```
ml/
  pyproject.toml          uv project: torch (cu132 index), numpy, tensorboard, maturin
  engine-rs/              Rust crate: pathery engine + PyO3 bindings (score, trace, batch_score)
  pathery_ml/             features.py, model.py, sa_teacher.py, selfplay.py, train.py, eval.py
  data/                   generated maps + solved datasets (git-ignored)
tools/dump-maps.ts        writes generator maps as JSONL for ml/
```

## 8. Roadmap with checkpoints

| Step | Work                                                                                                                       | Done when                                                                                          | Rough effort              |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------- |
| 0    | Finish SA tuning on `wip/solver`. Benchmark at 2 s / 30 s / 120 s.                                                         | Know how much of the gap is just time                                                              | 1–2 days                  |
| 1    | Rust engine + PyO3 bindings + parity tests (scoreboard, oracle fixtures, differential vs TS)                               | 100% parity, and an evaluations/s figure                                                           | 2–4 days                  |
| 2    | `dump-maps.ts`. Rust SA teacher (or TS SA in Node workers). Build a dataset of ~200k–1M solved maps across the four types. | Dataset on disk                                                                                    | 1–2 days + overnight runs |
| 3    | Approach A: train the heatmap/value net. NN-seeded SA.                                                                     | On the 83 held-out scoreboard maps, beats plain SA at equal wall-clock (mean ratio > 0.959 at 2 s) | 2–4 days                  |
| 4    | Approach B: Gumbel AlphaZero self-play, starting from the step-3 weights                                                   | Beats step 3 on Complex and the large maps                                                         | 1–3 weeks part-time       |
| 5    | Optional: ONNX export → onnxruntime-web "AI hint"/"AI best" in the game UI                                                 | Hint shows in the browser                                                                          | 1–2 days                  |

**Evaluation rule:** the 83 scoreboard maps (human best known) are a **held-out test set only**.
Never train on them. Report mean/min ratio per type at fixed time budgets.

## 9. Risks and open questions

- **The net may not beat well-tuned SA given enough time** on standard maps. That's a real
  possibility, which is why step 0 comes first and step 3 has a go/no-go metric.
- **Distribution shift:** our generator makes only Simple/Normal/Complex/Centralized. The biggest
  SA gaps are on special maps (Ultra 27×19 unlimited, Thirty, Seeing Double). Training for those
  means extending the generator, or training on those map shapes by sampling random variants.
- **Ultra-size maps** (513 cells, unlimited walls) make episodes 3–10× longer and raise engine
  cost ~6× per evaluation (82 µs measured). That's still feasible, but plan compute separately.
- **Engine rules not yet probed** (noted in `rules.ts` and the reference-engine memo: ice token
  order, several `uN` exits, and so on) carry over unchanged into training. Score differences
  from the server on those edge cases would teach the net slightly wrong play.
- **Hybrid CPU:** E-cores are ~half as fast as P-cores. Measure thread counts instead of assuming
  20× scaling.

## Sources

- PyTorch wheel index, checked 2026-10-03: <https://download.pytorch.org/whl/cu132/torch/>
  (2.14.1, cp314 win_amd64). Note: some web pages still say "no CUDA wheels for Python 3.14 on
  Windows" ([example](https://github.com/rohitg00/ai-engineering-from-scratch/issues/192)). That
  is outdated.
- PyPI metadata checked 2026-10-03 for numba 0.68, triton-windows 3.8, onnxruntime-gpu 1.30,
  numpy 2.5, gymnasium 1.3, maturin 1.15, lightzero 0.2 (source-only).
- JAX installation docs, Windows GPU via WSL2 only:
  <https://github.com/google/jax/blob/jaxlib-v0.4.25/docs/installation.md>
- Bar-Noy, Khuller, Schieber, _The Complexity of Finding Most Vital Arcs and Nodes_ (1995):
  <https://drum.lib.umd.edu/handle/1903/763>
- _Network Interdiction Goes Neural_ (2024): <https://arxiv.org/abs/2405.16409>
- _Most vital segment barriers_ (2019): <https://arxiv.org/pdf/1905.01185>
- Khalil et al., _Learning Combinatorial Optimization Algorithms over Graphs_ (NeurIPS 2017).
- Silver et al., _AlphaZero_ (Science 2018). Wu, _Accelerating Self-Play Learning in Go_
  (KataGo, 2019). Danihelka et al., _Policy Improvement by Planning with Gumbel_ (ICLR 2022).
- Agostinelli et al., _DeepCubeA_ (Nature MI 2019), learned heuristic + search for puzzles:
  <https://deepcube.igb.uci.edu/static/files/SolvingTheRubiksCubeWithDeepReinforcementLearningAndSearch_Final.pdf>
