# Pathery RL Agent — Plan

Written 2026-10-03, revised twice the same day:

1. Use libraries where they fit, have Claude generate the rest, Phil reviews.
2. **All ML work runs in WSL2 (Ubuntu)**, and pathery.com downloads are slowed to one request per
   ~15 s, in chunks with breaks.

Builds on `docs/neural-net-research.md` (hardware, libraries, baselines; written before the WSL2
decision) and `docs/original-site-architecture.md` (rules).

## 1. Objective and way of working

**Objective:** experience training a real reinforcement-learning agent on a fun problem. The
deliverable is one trained Pathery agent that plays **every map type in the site's daily
rotation**. It is then evaluated against the **best human scores on real historical daily maps**
it never trained on.

**Way of working:**

- **Libraries first:** PPO from `sb3-contrib` (MaskablePPO), Gymnasium, Optuna, TensorBoard,
  `torch.compile`. For AlphaZero, LightZero gets a time-boxed trial before anything is
  hand-built (Phase 5).
- **Claude generates everything else**: the Rust engine port, environment, network, search,
  scripts and tests. It runs tests and short smoke runs, and writes up results. **It asks before
  every long run** (rules below).
- **Phil reviews every phase branch before merge.** Each phase is built on `ml/phase-N`, and Claude
  never merges it itself. Each phase names the few files worth reading closely. The tests cover
  the rest. Phil decides go/no-go between phases.
- Every phase ends with a `ml/RESULTS.md` entry: what was tried, the curves, and what they mean.

**Branch and merge rules**

1. Claude creates `ml/phase-N` from `main` and commits there. It pushes the branch only when
   asked.
2. At the end of the phase, Claude posts a review summary:
   - what was built;
   - test results;
   - the files to read closely (with line ranges);
   - results and curves;
   - known gaps.
3. Phil reviews the diff. Fixes go on the same branch. Phil merges, or tells Claude to.
4. The next phase starts from the updated `main`. Prep work for phase N+1 can start on its own
   branch while N is in review, but it is rebased after N merges.

**Long runs: Claude asks first.** Phil may be using the GPU (or the PC) for something else.

- **No need to ask:** builds, unit tests, and smoke runs that use the GPU for **≤ 5 minutes**.
- **Ask first:** any run that uses the GPU for more than 5 minutes, or most CPU cores for more than
  ~15 minutes (for example, SA baselines or self-play on CPU). Each request states:
  - what the run is for and its config;
  - expected duration;
  - GPU, VRAM, CPU and RAM use;
  - where to watch it (TensorBoard);
  - how to stop it.
- **Before asking**, Claude checks `nvidia-smi` for other GPU processes and mentions them.
- **Every long run:**
  - runs in a named `tmux` session;
  - checkpoints at least every 30 minutes and can resume;
  - stops cleanly on `Ctrl+C` or a `STOP` file in its run folder, so Phil can stop it at any time
    without losing more than one checkpoint interval.
- Downloads from pathery.com already need a `yes` per batch after the dry run (§4.3).

**Ground rules:** the agent learns from its own play, and the SA solver is a baseline, not a
teacher (except as a labelled side experiment). The test date range is used once, at the end. The
SA solver must not be tuned on it either: the 83 maps from the earlier SA run fall inside it.
Every score comes from the real engine.

## 2. The game as an RL problem

| Element    | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Episode    | One map. Start with no walls. Each step places one wall. Ends when the budget is spent, the agent picks **STOP**, or no legal action remains.                                                                                                                                                                                                                                                                                                                                                                                               |
| State      | Map tiles + walls placed so far + walls remaining, plus engine-derived planes (current path, distance fields). See §6.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Action     | One wallable cell, or STOP. Up to 171 cells on daily maps, 513 on Ultra.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Legal mask | Cell is an `o` tile, is free, and **does not block** any path. Only cells on a current path can block, because a wall off every path never changes them. So the block check costs one engine call per path cell, not per board cell. **Correction (2026-10-03, Phase 2 prep):** not true with teleports. The warp exit is chosen by walking distance, whose route can run through cells the path never visits. The check set is `Engine::support_cells` (visited cells + each warp entrance's walking route); see `ml/engine-rs/README.md`. |
| Reward     | Dense and telescoping: `r_t = score(walls_t) − score(walls_{t−1})`, divided by a per-map scale (§6.3). The rewards sum to final score − no-wall score, so maximizing the return maximizes the game score.                                                                                                                                                                                                                                                                                                                                   |
| Discount   | γ = 1. Episodes are finite and the true objective is the undiscounted final score.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Dynamics   | Deterministic. Same walls → same path. That's ideal for tree search (AlphaZero) and makes evaluation exact.                                                                                                                                                                                                                                                                                                                                                                                                                                 |

STOP matters because extra walls can _shorten_ a path when teleports are involved, and because
Ultra Complex Unlimited (budget 999) has no natural end. The best human Ultra solution uses
hundreds of walls for 2,781 moves.

## 3. Map types the agent must cover

**Seen in 20 days of history** (88 maps, `reference/original/api/history/`):

| Type                    | Days seen | Size  | Walls | Features beyond rocks/checkpoints |
| ----------------------- | --------- | ----- | ----- | --------------------------------- |
| Simple                  | 21        | 13×6  | 6–8   | —                                 |
| Normal                  | 21        | 17×9  | 10–14 | ice                               |
| Complex                 | 21        | 19×9  | 15–22 | teleports, ice                    |
| Ultra Complex Unlimited | 4         | 27×19 | 999   | teleports, ice                    |
| Centralized             | 3         | 19×9  | 16–19 | start/finish in the middle        |
| Loop craziness          | 3         | 17×9  | 27–29 | teleports, ice                    |
| ABC's                   | 3         | 19×11 | 20–23 | many checkpoints                  |
| Side to Side            | 3         | 26×6  | 18    | teleports                         |
| Teleport Madness        | 2         | 17×12 | 18    | teleports                         |
| Thirty                  | 2         | 18×14 | 30    | teleports                         |
| Dualing Paths           | 2         | 18×9  | 13    | **two paths** (`s2`), `x` tiles   |
| Rocky Maze              | 1         | 19×15 | 32    | —                                 |
| Thirty Too              | 1         | 21×15 | 32    | two paths, `x`, `p`, teleports    |
| Seeing Double           | 1         | 21×13 | 22    | teleports                         |

The map editor's generator list (`reference/original/pages/mapeditor.html`) also has **Mirror
Image, Reverse Order, Ultimate Random, Ultra Complex**, plus 16 "Underground"/"Experimental"
types (Bombs Away, Rooms, Ice Dial, …). **Scope = whatever appears in the extended history
(Phase 1).** Types that never appear in the daily rotation are out of scope.

The daily rotation is Simple, Normal, Complex, Ultra, plus one special that rotates. So 20 days
give only 1–3 maps of each special type, which is why Phase 1 extends the history.

## 4. Data sources, splits and download schedule

### 4.1 Splits (by date, so no map is in two splits)

| Split      | Date range (daily maps)                  | Contents                                                                       |
| ---------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| Test       | most recent 90 days (2026-07-05 → 10-02) | All 5 maps for the latest 30 days, special + Ultra only for the 60 before that |
| Validation | the 60 days before (2026-05-06 → 07-04)  | All 5 maps for the latest 30 days, special + Ultra only for the 30 before that |
| Training   | no history at all                        | Local generator, site generator samples, transforms, jitter variants           |

That gives about 30 Simple/Normal/Complex maps per evaluation split, and roughly 60–90 specials
in test (≥ 5–10 per type, depending on the rotation).

### 4.2 Training map sources

| Source                                           | Types                                     | How                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Local generator (`src/generator`)                | Simple, Normal, Complex, Centralized      | `tools/dump-maps.ts` → `{type, seed, code}` JSONL. Unlimited.                                                                      |
| Site generator (`mapeditor?mapBySpecial=<name>`) | Each special type that appears in history | **30 samples per type** (download schedule below)                                                                                  |
| Map transforms                                   | All                                       | Flips, rotations and transposes: ×8 _new, valid_ maps per sample. The engine re-scores each one, so tie-break order is handled.    |
| Jitter variants                                  | All                                       | Move rocks/checkpoints/teleports to random cells of the same kind of region, keep counts, reject blocked maps. Unlimited variants. |

30 samples × 8 transforms × jitter is plenty of variety per type. That's why the sample count
dropped from 100 to 30.

### 4.3 Download schedule (pathery.com)

Requests needed:

| Batch | What                                                                         | Requests   | Run time\* | Needed by   |
| ----- | ---------------------------------------------------------------------------- | ---------- | ---------- | ----------- |
| A     | Validation, full days: 30 days × (date list + 5 maps + 5 score pages)        | ~330       | ~4 h       | Phase 3     |
| B     | Validation special-only days + all test days (30 + 60 special-only, 10 full) | ~560       | ~7 h       | Phase 6 / 7 |
| C     | `mapBySpecial` samples: 30 × each special type found in A + B (~13 types)    | ~390       | ~5 h       | Phase 6     |
|       | **Total**                                                                    | **~1,280** | **~16 h**  |             |

\*At the schedule below. "Special only" days fetch the date list, then only the 4th and 5th map
IDs (special, Ultra) and their score pages. Each map's name is checked after download, and any
day where the order differs is logged.

**Schedule and controls**, implemented once in a shared `tools/fetch/polite.mjs` and used by all
three batches:

- **One request at a time, 15 s apart** (± 3 s jitter).
- **Chunks of 40 requests (~10 min), then a 20-minute break.** About 80 requests/hour.
- **Dry run first:** it prints the exact request list, count and ETA, and waits for a `yes`.
- **Interruptible at any point:**
  - `Ctrl+C` stops immediately. Every file is saved as it arrives, so a rerun resumes where it
    stopped and never re-downloads.
  - Creating `ml/data/fetch.STOP` stops at the end of the current request.
  - Creating `ml/data/fetch.PAUSE` waits until the file is deleted.
- During breaks it prints progress, the next chunk start time and the ETA.
- **Stops for good** on any non-200 response, an HTTP 429 or 5xx, or a Cloudflare challenge page.
- Identifying User-Agent, as in the existing scripts.

Batch A runs while Phase 2 is being built. B and C can run overnight, or across a few evenings.
**The downloads don't delay training:** Phases 2–5 use only generated maps, plus batch A for
validation.

Before a map type is used at all, the engine must reproduce **every scoreboard score** for that
type (`tools/oracle/check-corpus.mjs` on the new history). Types the engine gets wrong are fixed
first, or left out.

## 5. Environment and stack (WSL2)

### 5.1 Why WSL2

| WSL2 makes this possible                                              | Effect on the plan                                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `torch.compile` with the official Triton (no community Windows build) | Used from Phase 3. Typically 1.3–2× faster for small conv nets (estimate, measured in Phase 2).       |
| LightZero builds (Linux/macOS only)                                   | Phase 5 begins with a time-boxed LightZero trial before hand-building search.                         |
| JAX + DeepMind `mctx` run on the GPU                                  | Available as a fallback for Gumbel search. Not planned, because mixing JAX and PyTorch adds friction. |
| PufferLib (fast Linux-first PPO)                                      | Fallback if SB3 throughput becomes the bottleneck.                                                    |
| `fork`-based multiprocessing, `tmux`, `nvtop`, `py-spy`               | Faster workers. Long runs survive closing the editor. Easier profiling.                               |

### 5.2 Stack

| Piece                       | Choice                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS                          | WSL2, Ubuntu LTS, on the C: NVMe drive. The GPU is shared through the **Windows** NVIDIA driver (no Linux driver inside WSL).                         |
| Python                      | **3.12** via `uv` (widest RL wheel coverage on Linux). A separate **3.11** env only for the LightZero trial (it needs ≤ 3.11 and numpy < 2).          |
| Deep learning               | PyTorch 2.14 (Linux CUDA 13 wheels, which bundle the CUDA runtime), bf16, `torch.compile`                                                             |
| Env API                     | Gymnasium + a custom SB3 `VecEnv` that steps all boards in one Rust call                                                                              |
| PPO                         | **sb3-contrib `MaskablePPO`** + a custom fully-convolutional policy class (Claude-generated)                                                          |
| AlphaZero search            | **LightZero trial first.** If it doesn't fit: Claude-generated Gumbel MCTS in Rust, ported from `mctx`'s reference algorithm                          |
| Engine in the training loop | Claude-generated Rust port of `src/engine` (PyO3 + maturin + rayon), checked against the existing fixtures                                            |
| Tuning, logging             | Optuna. TensorBoard, served from WSL and opened in the Windows browser at `localhost:6006`                                                            |
| Code location               | A **clone inside the Linux filesystem** (`~/src/pathery`), not `/mnt/c`, which is many times slower for many small files. Synced with GitHub via git. |
| Claude Code                 | Installed and run **inside WSL** for all ML work. Review in VS Code with the WSL extension.                                                           |

```
 Windows: browser (TensorBoard, game) · VS Code (WSL remote) · NVIDIA driver
 ───────────────────────────────────────────────────────────────────────────
 WSL2 Ubuntu  ~/src/pathery
            ┌────────────── Python 3.12 (PyTorch, GPU) ──────────────┐
 maps.jsonl │ MaskablePPO (sb3-contrib) │ AlphaZero (LightZero or    │
 ──────────▶│ policy.py (fully conv)    │ Claude-generated), eval.py │
            └──────────────┬─────────────────────────┬────────────────┘
                           ▼  numpy obs / masks       ▼ leaf batches
            ┌──────────── pathery_rs (Rust, PyO3, rayon) ─────────────┐
            │ engine · VecEnv (SB3 interface) · Gumbel MCTS (if built) │
            └──────────────────────────────────────────────────────────┘
```

**One SB3 constraint:** its observation space is fixed-size, so the PPO phases pad every map to
27×19 with an "off-board" plane (Discrete(514) actions incl. STOP). That wastes compute on small
maps, but it's fine for PPO. The AlphaZero phase batches maps by size instead.

## 6. Network, observations, reward scaling

### 6.1 Observation planes (uint8, H×W)

Off-board · wallable · placed wall · rock/blocked for path 1 · for path 2 · start 1 · start 2 ·
finish · checkpoint index (one-hot c1–c5+, or one ordinal plane for ABC's) · teleport in / out
(one-hot pair id) · ice · unbuildable `p` · **current path 1 cells** · **current path 2 cells** ·
**distance to next target** (scaled) · walls-remaining fraction (broadcast) · unlimited-budget
flag (broadcast).

### 6.2 Network

- Trunk: ResNet, **6 blocks × 64 channels** (~0.5 M params) to start, growing to **12 × 128**
  (~3.5 M) for all types, with **KataGo-style global pooling** every few blocks.
- Policy head: 1×1 conv → one logit per cell. STOP logit from pooled features. Mask, then softmax.
- Value head: pooled → MLP → predicted **normalized return-to-go**.
- The same module serves as the SB3 policy and the AlphaZero network, so PPO weights can
  initialize AlphaZero.

### 6.3 Reward scale across map types

Raw scores range from ~40 moves (Simple) to ~2,800 (Ultra). Rewards are divided by a **per-map
reference**: the greedy baseline's score (place the best single wall repeatedly), computed once
per map. Other options (no-wall path length, PopArt) are compared only if training comes out
unbalanced. Results are always reported in raw moves and as ratios to the human best.

## 7. Phases and estimates

Three kinds of time:

- **Claude build:** Claude sessions to write code, tests and smoke runs.
- **Your review:** your time reading the diff, results and curves.
- **Compute:** wall-clock time of approved runs and downloads, which need no one watching.

| #   | Phase                                      | Claude build       | Your review   | Compute                                  | Calendar       |
| --- | ------------------------------------------ | ------------------ | ------------- | ---------------------------------------- | -------------- |
| 0   | WSL2 setup and smoke test                  | < 1 h              | **30–60 min** | —                                        | same day       |
| 1   | Fetch script, map corpus, splits           | 1 session          | 30 min        | ~16 h of polite downloads, in background | 2–4 days       |
| 2   | Rust engine, VecEnv, baselines             | 1–2 sessions       | 1–2 h         | ~3 h (SA baselines on validation)        | 2–3 days       |
| 3   | PPO on Simple (MaskablePPO)                | 1 session          | 1 h           | 2–6 h per run, 3–5 runs + 1 sweep        | 3–5 days       |
| 4   | PPO generalist: four generated types       | 1 session          | 1 h           | overnight runs, 3–5 iterations           | 4–7 days       |
| 5   | AlphaZero: LightZero trial, then main runs | 2–3 sessions       | 3–4 h         | 1–3 days per run, 2–4 iterations         | 1.5–3 weeks    |
| 6   | All map types incl. Ultra                  | 1–2 sessions       | 1–2 h         | 2–4 multi-day runs                       | 1–2 weeks      |
| 7   | Human comparison on the test set           | 1 session          | 1–2 h         | ~½ day                                   | 1–2 days       |
| 8   | Optional: AI hint in the browser (ONNX)    | 1 session          | 30 min        | —                                        | 1 day          |
|     | **Total (0–7)**                            | **~9–13 sessions** | **~10–15 h**  | mostly Phases 5–6                        | **~4–7 weeks** |

Phase 1's downloads overlap Phases 2–5, so the slower schedule doesn't lengthen the calendar.
Training time and the number of tuning rounds are still the uncertain part.

The calendar also assumes the GPU is free for training most nights, and that branch reviews
happen within a day or two. Each long run waits for your OK, and each phase waits for its merge.
Weeks when the GPU is busy with other things push the dates out one for one.

### Phase 0 — WSL2 setup and smoke test

**You, after the reboot (about 30–60 min):**

1. Run `wsl --status`. If it still says virtualization is off, enable **Intel VT-x** (often
   called "Intel Virtualization Technology") in the BIOS. On this machine, Windows reports a
   hypervisor already running, so the reboot alone probably fixes it.
2. `wsl --install -d Ubuntu-24.04` (or whatever Ubuntu LTS `wsl --list --online` offers). Create
   your Linux user.
3. Create `%UserProfile%\.wslconfig`, so Linux can't starve Windows and can use every core:
   ```ini
   [wsl2]
   memory=24GB
   processors=20
   swap=8GB
   ```
   Then run `wsl --shutdown` so the settings apply. Also run
   `wsl --manage Ubuntu-24.04 --set-sparse true`, so the virtual disk gives freed space back to C:.
4. **Disk:** C: has **65 GB free** (94% full). The plan needs about 25–35 GB inside WSL (OS,
   PyTorch + CUDA libraries ~8 GB, Rust, node_modules, datasets, checkpoints). Free up some space
   on C: first if you can. D: is the USB T5 drive, which is not recommended for the distro (slower,
   and an unplug can corrupt it), though it's fine for archived checkpoints.
5. In Ubuntu, install Claude Code (`curl -fsSL https://claude.ai/install.sh | bash`), then
   `git clone https://github.com/philwhalen/pathairy ~/src/pathery`. Start Claude Code there.
   **Push the docs first** so the clone has them.
6. Optional: copy this project's Claude memory folder from Windows
   (`C:\Users\Phil\.claude\projects\C--Users-Phil-Documents-Source-pathery\memory`) into the
   matching folder under `~/.claude/projects/` in WSL. Claude Code keys memory by project path,
   so the WSL clone otherwise starts without it. The docs carry everything essential anyway.

**Claude, inside WSL:**

- `apt` build tools (`build-essential`, `pkg-config`, `git`, `tmux`, `nvtop`), `rustup`, `uv`,
  Node 24 (via `nvm`), `npm ci`, `npm run oracle:fetch`, then `npm test` (the TS suite must pass on
  Linux too).
- `ml/pyproject.toml` (Python 3.12, torch from the CUDA 13 index, gymnasium, stable-baselines3,
  sb3-contrib, optuna, tensorboard, numpy, maturin, pytest).
- Smoke tests:
  - `nvidia-smi` and `torch.cuda.is_available()` inside WSL;
  - a bf16 matmul benchmark, with and without `torch.compile`;
  - a 1-minute MaskablePPO run on a dummy env;
  - TensorBoard reachable from the Windows browser.
- **Check that a `tmux` training run survives closing every WSL terminal.** If WSL shuts the VM
  down when no terminal is open, keep one Windows Terminal tab open during long runs.
- **Review:** `ml/pyproject.toml` only.

### Phase 1 — Fetch script, map corpus and splits

1. Claude writes `tools/fetch/polite.mjs` (§4.3) and the three batch definitions. **You review the
   dry-run output** (request list, count, ETA) before each batch starts.
2. Batch A → re-run the engine scoreboard check on it → Batch B → check again → decide the
   in-scope special types from the history → Batch C.
3. `tools/dump-maps.ts`, transforms and jitter. Freeze `ml/data/splits.json`.

- **Done when:** every in-scope type has training, validation and test maps, and the engine
  matches 100% of scoreboard scores on validation and test.
- **Review:** `polite.mjs` (rate limits, stop conditions), `splits.json`, the per-type counts in
  RESULTS.md.

### Phase 2 — Rust engine, VecEnv, baselines

1. Rust port of the engine + PyO3 bindings. **Parity tests:** the 602 scoreboard rows, all oracle
   fixtures, and a random differential test (TS vs Rust on random maps × random wall sets).
2. VecEnv implementing SB3's interface: observations, legal masks, rewards, STOP.
3. Baselines through one `eval.py`: random, greedy, and SA (Rust port of the `wip/solver` core)
   at 2 s and 30 s per map, on validation only.
4. A tiny-map brute-force solver (enumerates every wall set on ~6×4 maps) for Phase 5's
   correctness tests.
5. Benchmarks: engine evaluations/s (1 and 20 threads), network positions/s (with and without
   `torch.compile`).

- **Done when:** 100% parity, benchmarks recorded, baseline table on validation.
- **Review closely:** the env's reward and mask code (`ml/engine-rs/src/env.rs`, ~150 lines).
  Skim the engine port, since the parity tests cover it.

### Phase 3 — PPO on Simple (MaskablePPO)

- Custom fully convolutional policy class (`torch.compile`d). 256–1,024 boards per VecEnv.
- Train on generated Simple maps, validate on batch-A Simple maps.
- A short Optuna sweep over learning rate, entropy coefficient, n_steps and batch size.
- Ablations: dense vs final-only reward, with vs without engine-derived planes.
- **Done when:** the policy alone (no search) beats the greedy baseline and reaches ≥ 0.95 mean
  ratio vs human on validation Simple maps.
- **Review:** the policy class, and the TensorBoard curves. Claude's RESULTS.md entry explains
  what entropy, approximate KL, clip fraction and explained variance did.

### Phase 4 — PPO generalist: the four generated types

- Curriculum: Simple → + Normal → + Complex/Centralized, with a sampler that oversamples the
  types where validation is weakest. Net grows to 10–12 blocks × 96–128.
- **Done when:** one checkpoint plays all four types, with policy-only results per type on
  validation. It is expected to trail SA on Complex. That's what Phase 5 fixes.

### Phase 5 — AlphaZero

1. **LightZero trial (time-boxed to one Claude session, ~½ day of compute).** In its own Python
   3.11 env, wrap the Rust env as a LightZero AlphaZero env (it needs "reset to a given state",
   which is easy here: state = map + wall list). Train briefly on Simple. Measure games/s and GPU
   utilization, and check that it learns.
   - **Adopt it** if throughput is within ~3× of the Phase 2 estimate and it learns. Then
     Claude's work is the env adapter + configs.
   - **Otherwise build it:** Claude-generated Gumbel MCTS in Rust (sequential halving, following
     `mctx`), with leaf evaluations batched across many games into one GPU call. The PyTorch
     training loop has a replay buffer that stores map id + walls and rebuilds planes on the fly.
2. **Either way:** initialize from the Phase 4 weights (plus one from-scratch run to compare).
   Value target = normalized final score. Try "ranked reward" if values stay flat.
3. **Correctness tests:** on tiny maps, search with an exact value function must find the
   brute-force optimum, and the trained agent should find it too.

- **Done when:** with search at a fixed budget (10 s per map), it beats SA at the same budget on
  validation Complex maps.
- **Review closely:** the trial write-up (adopt or build). Then either the LightZero env adapter
  - config, or `mcts.rs` + the training targets. This is the heart of the project, worth an hour
    with the Gumbel paper open.

### Phase 6 — All map types

- Special-type pools enter the self-play mix: dual paths, `x`/`p` tiles, large boards.
- **Ultra Complex Unlimited** last (27×19, hundreds of moves per episode). Fewer simulations per
  move, and STOP is critical. A separate Ultra fine-tune is acceptable if recorded.
- **Done when:** one agent (plus at most an Ultra fine-tune) has validation results for every
  in-scope type.

### Phase 7 — Human comparison

Run once on the test range with all tuning frozen (protocol in §8). Claude writes
`docs/rl-agent-results.md`, and you review it together.

### Phase 8 (optional) — AI hint in the browser

ONNX export → `onnxruntime-web`: a policy heatmap ("AI hint") and a predicted score in the game.

## 8. Evaluation protocol

For each test map:

| Player             | Budget                                                                     |
| ------------------ | -------------------------------------------------------------------------- |
| Agent, policy only | one forward pass per wall (milliseconds)                                   |
| Agent + search     | 10 s and 60 s per map                                                      |
| SA baseline        | 10 s and 60 s per map                                                      |
| Humans             | best score on the scoreboard, and the 10th-best (page 1 of the scoreboard) |

Report per type and overall: mean and minimum **ratio vs best human**, **% of maps matched or
beaten**, % that would place **top 10**, and agent vs SA at equal time.

The humans had a whole day and thousands of players, so ratio = 1.0 on Complex and specials is a
high bar. "Top 10 on most types, matching the best on some" would be a strong outcome.

## 9. Compute plan

- Engine: 14 µs per score on 19×9 in TS (measured). Rust over 20 threads: 0.5–1.5 M/s (estimate).
- GPU: a 12×128 net does roughly 10–30k positions/s (more with `torch.compile`), so self-play
  with 32 simulations per move gives about 10⁶ Complex games/day (estimate). CUDA under WSL2 runs
  close to native speed for this kind of work. Phase 2 measures it.
- Runs checkpoint every 30 min and resume, so they can pause while you use the PC. Pause Windows
  Update and sleep during multi-day runs.
- Disk ~25–35 GB inside WSL (§ Phase 0). RAM ≤ 24 GB (the `.wslconfig` cap). VRAM < 4 GB.

## 10. Install list

**Windows:** the NVIDIA driver (already installed; it also serves WSL), WSL2 + Ubuntu LTS, VS Code

- WSL extension, `.wslconfig`.

**Inside WSL:** build-essential, pkg-config, git, tmux, nvtop; rustup; uv; Node 24 (nvm); Claude
Code. Python 3.12 env: PyTorch 2.14 (CUDA 13), gymnasium, stable-baselines3 + sb3-contrib,
optuna, tensorboard, numpy, pytest, maturin. Rust crates: `pyo3`, `numpy`, `rayon`. Phase 5 trial
only: a Python 3.11 env with LightZero. Optional: onnx + onnxruntime (Phase 8), py-spy.

**Not needed:** a CUDA toolkit (the PyTorch wheels bundle the runtime; add the WSL-Ubuntu toolkit
package only if a custom CUDA extension is ever built), and never a Linux NVIDIA driver inside WSL.

**Optional reading** for reviews: the Hugging Face Deep RL Course units on PPO, _The 37
Implementation Details of PPO_, the AlphaZero paper, and _Policy Improvement by Planning with
Gumbel_ (before Phase 5).

## 11. Decisions

All settled on 2026-10-03:

| Decision    | Answer                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------- |
| Environment | Everything runs in WSL2 (Ubuntu), with Claude Code inside WSL (§5).                       |
| Code        | Libraries where they fit. Claude generates the rest.                                      |
| Downloads   | Approved, at ~15 s spacing in chunks with breaks, dry run + `yes` per batch (§4.3).       |
| Review      | Phil reviews every `ml/phase-N` branch before merge. Claude never merges on its own (§1). |
| Long runs   | Claude asks before any run over 5 GPU-minutes or ~15 minutes on most CPU cores (§1).      |

## 12. Risks

| Risk                                            | Mitigation                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Virtualization off after reboot                 | Enable VT-x in the BIOS (Phase 0 step 1).                                                 |
| C: drive fills up                               | Free space first, sparse VHD, prune old checkpoints, archive to D:.                       |
| WSL stops background runs when terminals close  | Checked in Phase 0. Keep a terminal tab open if needed. Checkpoints make runs resumable.  |
| Site load from downloads                        | 15 s spacing, chunked breaks, stops on any error or 429, never re-downloads.              |
| LightZero doesn't fit (old Python/numpy, speed) | Time-boxed trial, then the Claude-generated Rust search.                                  |
| Generated code is subtly wrong                  | Parity tests vs TS engine, brute-force optima on tiny maps, focused review of env + MCTS. |
| PPO plateaus well below SA on Complex           | Expected. That's why Phase 5 exists.                                                      |
| Engine wrong on untested special tiles/types    | Scoreboard check per type before use (§4). Leave out types that fail.                     |
| Ultra is too long-horizon                       | Separate budget, STOP action, optional fine-tune. Report it honestly.                     |
| Overfitting to the generator's style            | Validation on real history maps, jitter + transforms, site samples.                       |
| Test-set leakage through tuning                 | Test range touched once, in Phase 7. SA isn't tuned on it either.                         |
