# pathery_rs — Rust engine and RL environment

Prep for docs/rl-agent-plan.md Phase 2. Contains a Rust port of the TypeScript engine
(`src/engine`), the RL environment (`src/env.rs`), baselines (random, greedy, brute force),
and Python bindings for the training loop.

| File                   | What                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `src/mapcode.rs`       | Map code / solution parsing, plus `map_from_ascii` for tests                            |
| `src/grid.rs`          | Flat grid, tile rules (port of `grid.ts` + the tile parts of `rules.ts`)                |
| `src/engine.rs`        | The engine (port of `pathing.ts`, same structure). `score()` doesn't allocate           |
| `src/env.rs`           | **Read closely.** Episode, legal mask, reward, observation planes                       |
| `src/baselines.rs`     | Random episode, greedy, exact brute force for tiny maps                                 |
| `src/solver.rs`        | SA baseline: port of `src/solver/solve.ts` (same moves and parameters)                  |
| `src/python.rs`        | `pathery_rs` Python module (feature `python`): batched `VecEnv`, `score`, `greedy`, ... |
| `tests/parity.rs`      | Server fixtures (exact), all scoreboard rows, 3,000 TS-vs-Rust cases (exact tokens)     |
| `tests/env.rs`         | Mask is exact (checked against the engine for every action), rewards telescope          |
| `tests_py/`            | Python smoke tests of the bindings (pytest, numpy only)                                 |
| `examples/bench.rs`    | Engine throughput                                                                       |
| `examples/sa_bench.rs` | Rust SA on the solver tuning set (`tests/data/bench-maps.json`)                         |

## Commands

```sh
cargo test --release                              # all tests (needs the repo's tests/fixtures)
cargo run --release --example bench -- 3          # engine evaluations/s, 1 and all threads
npx tsx tools/dump-engine-cases.ts                # (repo root) regenerate tests/data/diff-cases.jsonl
maturin develop --release                         # build + install the Python module in the active venv
```

On this Windows machine the default `x86_64-w64-mingw32-gcc` on PATH is llvm-mingw's clang,
which can't link Rust's GNU target (no libgcc). Point cargo at the WinLibs GCC for the command:
`CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=<WinLibs>/mingw64/bin/gcc.exe cargo test --release`.
WSL (where the plan runs ML) needs nothing special.

## Results (2026-10-03, i5-13600K, Windows)

- Parity: 56/56 server fixtures exact (tokens, moves, start/end, blocked), 602/602 scoreboard
  rows, 3,000/3,000 differential cases vs the TS engine (tokens included).
- Engine speed, scoring real scoreboard solutions: 6.1 µs per score on daily-size maps
  (≤ 19×9; TS: ~14 µs), 20 µs on larger specials/Ultra. 20 threads: 1.86 M/s and 0.67 M/s.

## Finding: the plan's mask shortcut is wrong on teleport maps

docs/rl-agent-plan.md §2 says only cells on the current path can block, so the legal mask needs
one engine call per path cell. That holds without teleports (ice included), but not with them:
the warp exit is chosen by walking distance from each exit, and that walking route can pass
through cells the path never visits (because it warps again first). Walling such a cell can
change the exit, or leave no exit able to reach the target, which blocks the path. `tests/env.rs`
found a case on a synthetic map.

Fix: `Engine::support_cells` returns the visited cells plus, at each warp, the walking route
from the teleport entrance (the doc comment has the argument for why that is exactly enough).
Only those cells get an engine call. `tests/env.rs` checks the mask against the engine for every
action on ~400 maps, and that walls outside the support set leave the result identical (tokens
included) in 50k+ cases on teleport maps. The same correction applies to "a wall off the path
never changes the score".

## VecEnv throughput (Python, random legal policy, 256 envs, 19×27 frame, 20 threads)

| Type        | env steps/s | episodes/s |
| ----------- | ----------- | ---------- |
| Simple      | 84k         | 12.2k      |
| Normal      | 52k         | 4.5k       |
| Complex     | 26k         | 1.4k       |
| Centralized | 37k         | 2.2k       |

Each step includes the observation (23 planes) and the legal mask (one engine call per support
cell). `ml/bench_vecenv.py` reproduces this after `npx tsx tools/dump-maps.ts --per-type 2000`.
