# Local Pathery — Implementation Plan

Written 2026-10-03. Builds on `docs/original-site-architecture.md` (cited below as "the report").
Read that first: it covers the pathing rules (§5), data formats (§4) and the server check (§8).

## 1. Goal and scope

A single-player browser app that runs locally with no backend:

- Generates random maps that resemble the site's **Simple, Normal, Complex and Centralized** maps.
- Lets the player place walls and press Go. Computes the path with a **local engine that matches
  the site's server**, then animates it and shows the score.
- Remembers each map's best score and solution locally. Every map comes from a seed, so it can be
  replayed or shared.

**Out of scope for v1:** accounts, online scoreboards, the site's other map types (dual-path, ice
specials, etc.), and a map editor. The engine will still support dual paths, `x` tiles and ice
because the rules are cheap to add and the server check covers them. A solver/AI that finds high
scores is a later option (Phase 7).

## 2. Tech stack

**TypeScript + Vite (no framework) + Vitest**, Node 24 / npm 11 (already installed).

- The game is one screen with a grid and a few controls. Plain DOM is enough, and the engine and
  generator are pure TypeScript modules with no UI dependencies.
- The user's other projects use Angular. If you'd rather use Angular here, only Phase 5 changes:
  the engine, generator and tests stay framework-free either way.
- Prettier for formatting. No other runtime dependencies are planned.

## 3. Project layout

```
pathery/
  docs/                       report + this plan
  reference/                  original site files, samples, analysis scripts (read-only)
    original/api/gen/*.json   80 sampled generator outputs (20 per type)
    original/api/history/     past daily maps + scoreboards (mapsbydate/, maps/, scores/)
    scripts/analyze.js        stats over sampled maps; render.js = ASCII renderer
    scripts/fetch-history.js  polite downloader for history/ (cached, rate-limited)
  src/
    engine/
      types.ts                Tile, MapData, Solution, PathResult, Token
      mapcode.ts              parse/serialize map code (report §4.4); solution string (§4.2)
      grid.ts                 passability per path, neighbors, coordinate helpers
      pathing.ts              computePaths(map, walls) -> {paths, totalMoves, blocked}
    generator/
      rng.ts                  seeded PRNG (mulberry32) + helpers (int, pick, shuffle, weighted)
      presets.ts              per-type parameters (§6 tables)
      generate.ts             generateMap(type, seed) -> MapData (place, validate, retry)
    game/
      state.ts                current map, walls, wall budget, undo stack
      storage.ts              localStorage: best per map key, prefs (wrapped in try/catch)
    ui/
      board.ts                renders grid, handles clicks
      animate.ts              plays a token stream (same format as server pathArray)
      controls.ts             Go, Reset, Undo, speed, map-type buttons, seed field
      styles.css
    main.ts
  tools/
    oracle/analyst.js         midnighttherapy's engine with the output-format fixes (§5.1)
    oracle/normalize.ts       converts analyst output to the current server token format
    oracle/record.ts          queries pathery.com getpath for the few cases in Phase 2 step 4
    genstats.ts               generates N local maps per type, prints stats vs. samples
  tests/
    fixtures/oracle/*.json    recorded server responses (committed; tests run offline)
    fixtures/scoreboard.json  (map code, solution, server moves) built from history/
    engine.test.ts, mapcode.test.ts, generator.test.ts, state.test.ts, analyst-diff.test.ts
```

## 4. Phases

Each phase ends with its tests passing. Phases 1–3 involve no UI.

**Progress log** (updated as work lands; resume from the first unchecked item):

- [x] Phase 0 — scaffold (2026-10-03, commit 1e25ebc)
- [x] Phase 1 — types + map code/solution round trips (2026-10-03, commit 1e25ebc)
- [x] Phase 2 steps 1–2 — `tests/fixtures/scoreboard.json` (602 distinct rows), 20 oracle
      fixtures, `tools/oracle/run-analyst.mjs` reproduces exact server tokens, `check-corpus.mjs`
      all match (2026-10-03, commit 1e25ebc). `analyst.js` is gitignored: `npm run oracle:fetch`.
- [x] Phase 2 step 4 — 36 probes sent (`tools/oracle/probes.json`, `record.ts`), fixtures in
      `tests/fixtures/oracle/`, findings in report §9. analyst.js is wrong on checkpoint gaps,
      `tN` without `uN`, and `z1` (2026-10-03, commit 316c83f)
- [x] Phase 3 — engine: 56/56 server fixtures exact, 602/602 scoreboard rows, 11k-case
      differential test vs analyst.js (Phase 2 step 3). Open rules isolated in
      `src/engine/rules.ts` (2026-10-03, commit 12c938f)
- [~] Phase 4 — generator + genstats done (commits 12c938f, b3f6ab1). 100 more site samples
  showed the Complex gap was noise (median 42 local vs 45 site); no extra site filter found.
  Waiting on map review with Phil.
- [~] Phase 5 — UI done: play loop on all 4 types, desktop + 375 px, checked in headless
  Chrome. Not browser-tested yet: dual paths, ice, x tiles. Waiting on playtest with Phil.
- [x] Phase 6 — mute/speed/last-map prefs, Web Audio blips (mutable), G/R/N/Ctrl+Z shortcuts,
      Daily mode (`{type}-{seed}` key, seed hashed from local date + type), 2026-10-03
- [ ] Phase 7 — solver (optional). Deferred to a later step by Phil. A partial solver core
      (`src/solver/solve.ts`, `tools/solve.ts`, tests) is parked on branch `wip/solver`. It
      typechecks and its tests pass, but tuning and the scoreboard benchmark weren't finished.

### Phase 0: Scaffold

- `npm create vite` (vanilla-ts), add Vitest and Prettier, `git init`, `.gitignore`.
- Scripts: `dev`, `build`, `test`, `oracle:record`, `genstats`.
- **Done when:** `npm test` runs an empty suite and `npm run dev` serves a blank page.

### Phase 1: Data model and map codes

- `types.ts`: tiles as `{type, value}`. Coordinates are always `{row, col}` internally, and
  conversion to the server's `x,y` = `col,row` happens only at the edges (report §4.2).
- `mapcode.ts`: parse/serialize map code (run-length format) and solution strings (`.r,c.r,c.:`).
- **Tests:** round-trip every map in `reference/original/api/**` (map JSON → code equals the
  `code` field, and code → tiles equals `tiles`).

### Phase 2: Offline test corpus (as few server requests as possible)

Goal: be polite to pathery.com. Almost all checking happens offline, using data that is already
scored by the server or by a reference engine. Calls to `getpath` (it runs the server's engine,
and it records scores) are kept for the few questions nothing else answers.

1. **Scoreboard corpus (no `getpath` calls).** Scoreboards of finished maps list every player's
   solution next to its server-scored move count (`a/score/{mapid}_{page}.js`, 10 rows per page,
   `users[n].solution` / `.moves`). `reference/scripts/fetch-history.js` downloads the past ~20
   days: `a/mapsbydate/{date}.js` (usually Cloudflare-cached), `a/map/{id}.js` (old ones often
   miss the cache) and score pages (always reach the PHP origin). Requests are sequential, 1–3 s
   apart, never re-downloaded, stop at the first error, and fetch score page 1 only by default. Build `tests/fixtures/scoreboard.json` as `{mapId, code, solution, moves}` rows.
   These are real maps (all five daily types, including Ultra Complex with teleports and ice)
   with real high-scoring wall sets, which is the case that matters most. Limitation: moves only,
   no tokens. Two different routes with the same length would both pass.
   **Done 2026-10-03:** 2026-09-13 to 10-02 gave 84 maps, 83 of them finished, with 824 rows
   (602 distinct solutions). 89 distinct solutions are on ice maps, 292 on teleport maps and 21
   on dual-path maps. This took 184 requests (82 score pages) and about 1 MB.
   The 5th daily slot rotates through special types (Teleport Madness, Loop craziness, ABC's,
   Thirty, Dualing Paths, Side to Side, Seeing Double, Rocky Maze, Thirty Too, Centralized), and
   Ultra Complex runs for several days.
2. **Validate the reference engine.** Run midnighttherapy's `analyst.js` (with the format fixes in
   §5.1) on the scoreboard corpus and on the existing `probe_*`/`getpath_*` responses. Record
   which rows, if any, disagree, grouped by feature (ice, teleports, dual paths).
   **Done 2026-10-03:** it matches all 20 saved responses (tokens included) and **all 824
   scoreboard rows** (moves), including ice, teleport, dual-path, `x` and `p` maps.
3. **Differential testing against the reference engine (unlimited, offline).** For map features
   where step 2 shows `analyst.js` agrees with the server, compare our engine with it on thousands
   of generated maps and random wall sets, checking **tokens** (after normalizing), moves and the
   blocked flag. This replaces the earlier plan to send random wall sets to `getpath`.
4. **Targeted `getpath` probes (about 30–60 requests, confirm with Phil first).** Only for
   questions steps 1–3 can't settle. Each case that disagrees becomes a fixture, and the server's
   answer wins over `analyst.js`.
   - Ice: entry, exit, turning at edges, ice next to rocks/walls, several ice tiles in a row,
     `z1`–`z4`. `analyst.js` ice support is from 2018 and its author called it "might be buggy".
     It matched all 89 ice-map solutions on moves, so these probes mainly check the token
     sequences and rare layouts. All observed ice is single `z5` tiles.
   - Several `uN` exits (`analyst.js` searches from all of them at once, nearest to the target wins).
   - Teleports with dual paths (`analyst.js` keeps one set of used teleports per path).
   - Missing checkpoint numbers (`analyst.js` stops at the first gap. The report guessed skip).
   - Any scoreboard row where `analyst.js` disagrees with the server.
     Use `tools/oracle/record.ts`: POST `do.php?r=getpath&isChallenge=false&mapid=-1&mapcode=…&solution=…`
     with body `rndval=1` (report §8), at least 3 s apart, cached by (code, solution).
     Store each as `{code, solution, response}` in `tests/fixtures/oracle/`.

- **Done when:** the scoreboard corpus and fixtures are committed, `analyst.js` is classified per
  feature (agrees with the server or not), and the open questions are answered in a short addendum
  to the report.

### Phase 3: Pathing engine

`computePaths(map, walls)` returns `{paths: [{tokens, moves, blocked, start, end}], totalMoves, blocked}`.
`tokens` uses the server's `pathArray` format so fixtures can be compared directly.

Algorithm (from report §5; adjust it to whatever the Phase 2 fixtures show):

1. Paths: path 0 if any `s1` (targets c1..cN, f). Path 1 if any `s2` (targets cN..c1, f). Skip
   checkpoint numbers with no tiles.
2. For each target: **BFS distance field from all tiles of the target type** over cells passable
   for this path (rocks/walls block; `xN` blocks path N). Ice: the search state is (cell, direction)
   while on ice, and the path keeps moving in the same direction on ice. For the first target,
   start from the start tile with the smallest distance (tie → first in row-major order, verify).
   If no target is reachable: blocked, score 0.
3. Walk: at each cell, choose the first neighbor in **U, R, D, L** order whose distance is one less.
   Emit a direction token and count a move.
4. Stepping onto an unused `tN` disables all `tN` tiles, emits `"u","x,y","u"`, warps to `uN` (0
   moves) and goes back to step 2 for the same target. A used `tN` emits `"tN"`. On arrival
   emit `"r"`, then the next target's token (`"c2"` / `"f1"`).
5. `totalMoves` = sum of path moves. Blocked if any path is blocked.

Performance: at most 50×50 cells and ~20 targets, so each BFS is trivial. Allocate typed
arrays once per call. Aim for well under 1 ms per `computePaths` on 19×9 maps; the solver in
Phase 7 will call it thousands of times.

- **Tests:** every oracle fixture must match **exactly** (tokens, moves, blocked). Every scoreboard
  row must match on moves. The differential test against `analyst.js` must agree on its
  validated features. Also add hand-written unit tests for each rule.
- **Done when:** 100% of fixtures and scoreboard rows match, and the differential test passes.

### Phase 4: Map generator

See §6 for the parameters. `generateMap(type, seed)`:

1. Seed the RNG. Build the empty grid and the fixed layout for the type (borders, start/finish).
2. Place, in this order, each on a random empty `o` cell inside the type's allowed region:
   checkpoints → teleport pairs → ice → rocks. Counts are drawn from the preset distributions.
3. Choose the wall budget from the preset distribution.
4. **Validate** with the engine using no walls: not blocked (every target reachable). The site
   marks all generated maps `validated: true`, so it does at least this. On failure, re-roll
   with the next RNG state, so the same seed always gives the same map.
5. Map key = `"{type}-{seed}"`, used for storage and sharing.

- **Tests:** deterministic for a given seed; invariants hold for 1000 seeds per type (sizes,
  fixed layout, counts within range, never blocked).
- `tools/genstats.ts`: generate 1000 maps per type and print the same histograms as
  `reference/scripts/analyze.js`, side by side with the sampled maps.
  Also compare the **no-walls path length** distribution (local engine on the local maps vs.
  local engine on the 80 samples), as a simple proxy for difficulty.
- **Done when:** histograms are close (§6.5) and Phil agrees that the maps feel right.

### Phase 5: Playable UI

- Board: CSS grid of square cells, ~35 px (scale down to fit the viewport). Distinct look per
  tile type: start, finish, checkpoint letters A–O in the site's colors (report §6 `targetColor`),
  teleport pairs numbered, ice, rocks, unbuildable.
  Use our own drawings, not the site's images.
- Clicking an open cell toggles a wall. Show walls left, and flash a message when there are none
  left. Add Reset and Undo.
- Go: run the engine, then animate the tokens. Speed options are Slow/Med/Fast/Ultra
  (180/94/44/22 ms per step), with pauses at targets and teleports like the original (report §6).
  The path trail fades. The move counter shows `green + red = total` for dual paths.
  Show a "blocked" message instead of an alert.
- Header: map type buttons (New Simple / Normal / Complex / Centralized), seed shown and editable,
  copy-link (`?map=complex-123456`).
- After each run: compare with the stored best for this map ("New best!", "Tied best", "Best is N")
  and offer "Load best solution".
- **Done when:** a full play loop works for all four types, on desktop and on phone width.

### Phase 6: Persistence and polish

- localStorage: `best[mapKey] = {moves, solution}`, plus prefs (speed, mute, last map). Every
  access in try/catch, and the game still works if storage is unavailable.
- Optional sounds (own or freely licensed): step milestone every 100 moves, checkpoint, teleport,
  new best.
- Keyboard: `G` = Go, `R` = reset, `Ctrl+Z` = undo, `N` = new map of the current type.
- "Daily" mode: seed derived from the date, so each day has one map per type, like the site.

### Phase 7 (optional): Solver / target scores

- Hill-climbing or simulated-annealing wall placer using the fast engine. Show an "AI best"
  as a target to beat for each map, and use it in genstats to compare difficulty with the site's samples
  (we can also score the 80 sampled maps with the same solver).

## 5. Engine: matching the site

The engine must reproduce the server exactly, because tie-breaking decides which route the path takes,
and that decides the score. The approach:

- Treat the server data (oracle fixtures and scoreboard rows) as the spec. Any mismatch is an
  engine bug until shown otherwise. `analyst.js` is the next best source, and only for features
  where it agrees with the server.
- Areas most likely to need correction (report §8.3): tie-breaking in open areas with ice, start
  ties, multiple teleport exits, teleport state shared between dual paths.
- If a mismatch can't be explained, record more targeted fixtures around it rather than guessing.

### 5.1 Reference engine: midnighttherapy `analyst.js`

[github.com/WuTheFWasThat/midnighttherapy](https://github.com/WuTheFWasThat/midnighttherapy)
`src/analyst.js` is a pathing engine that players wrote by reverse engineering (2013–2018) for a
browser extension that showed a live score while you placed walls. It isn't the server's code, but
it matched **all 20** saved server responses (every probe plus the Simple 23462 and Ultra Complex
23445 maps, 171 moves with teleports and 9 checkpoints; neither map had walls placed). It also
matched the move counts of **all 824** scoreboard solutions on 83 past daily maps (Phase 2 step 1).

- **Algorithm:** for each target, a search outward from the current cell(s) that checks neighbors
  in the order U, R, D, L and stops at the first target found. That gives the same result as the
  report's model (report §5.6). Several start tiles or teleport exits are searched from at once,
  in row-major order.
- **Output-format fixes needed** (the server's format changed since 2018): `snapify` reports rows
  starting at 1 (drop the `+ 1`); checkpoint labels come from a 5-entry array (use `'c' + n`);
  `path` is joined into a string (keep the array). Teleport tokens differ: it emits `"t1"`, then
  `"u1"`, the coordinates and `"u1"`, where the server emits `"u","x,y","u"`. It emits nothing for
  a used teleport, where the server emits `"t1"`. Normalize by dropping `tN` and mapping `uN` to `u`.
- **Known limits:** ice may be buggy (see Phase 2 step 4); the search queue holds 1000 entries
  and overflows silently on larger maps (fine for 19×9, not for 50×50); it accepts any wall
  list without checking it; tile types it doesn't know are treated as open.
- **License:** the repo has no license, so use it only as a local test tool and don't copy its code
  into `src/`.

## 6. Generator specifications (from 20 samples per type; 80 Complex, 60 Centralized)

Samples: `reference/original/api/gen/{type}_NN.json`, fetched from `mapeditor?mapBySpecial={type}`.
Coordinates below are (col, row). "r3" is the decorative rock variant the site uses for borders.
It blocks exactly like r1, but the UI may draw it differently.

### 6.1 Simple — 13 × 6

| Feature               | Observed                                             |
| --------------------- | ---------------------------------------------------- |
| Left column (col 0)   | r3 in every row except one random row = `s1`         |
| Right column (col 12) | r3 in every row except one random row = `f1`         |
| Checkpoints           | exactly 1 (A), cols 2–9, any row                     |
| Rocks (r1)            | 3–8 (avg 5), **cols 2–10**, any row incl. top/bottom |
| Teleports / ice       | none                                                 |
| Walls                 | 6, 7, 8 (20% / 40% / 40%)                            |

### 6.2 Normal — 17 × 9

| Feature               | Observed                                      |
| --------------------- | --------------------------------------------- |
| Left column           | r3 except one random row = `s1`               |
| Right column (col 16) | `f1` in all 9 rows                            |
| Checkpoints           | A always; B 50% of the time; cols 1–14        |
| Rocks                 | 10, 12 or 14 (about equal); cols 1–15         |
| Ice (z5)              | 10% of maps have 2 separate ice tiles         |
| Teleports             | none                                          |
| Walls                 | 10–14 (10:15%, 11:15%, 12:30%, 13:5%, 14:35%) |

### 6.3 Complex — 19 × 9

| Feature               | Observed                                                         |
| --------------------- | ---------------------------------------------------------------- |
| Left column           | `s1` in all 9 rows                                               |
| Right column (col 18) | `f1` in all 9 rows                                               |
| Checkpoints           | 3 (50%), 4 (20%), 5 (30%); cols 1–17                             |
| Teleports             | 1 pair (75%) or 2 pairs (25%); `t` and `u` anywhere in cols 1–17 |
| Ice (z5)              | 0 (68%), 3 (29%), 6 (4%); separate single tiles                  |
| Rocks                 | mostly 11 or 14 (some 8); cols 1–17                              |
| Walls                 | 15–22, roughly uniform                                           |

### 6.4 Centralized — 19 × 9

| Feature         | Observed                                            |
| --------------- | --------------------------------------------------- |
| Borders         | none; the whole grid is open                        |
| Start / finish  | single `s1` at (8,4), single `f1` at (10,4), always |
| Checkpoints     | exactly 3 (A, B, C), anywhere (col 18 too)          |
| Rocks           | 16–20, anywhere, edges included                     |
| Teleports / ice | none                                                |
| Walls           | 16�20, roughly uniform (15/18/10/9/8 of 60)         |

### 6.5 Notes and how close is close enough

- Rock counts land on a few fixed values (Normal 10/12/14, Complex 8/11/14; never 11/13 or
  9/10/12/13). The "N attempts, drop collisions" idea was tested and **rejected**: with 14
  attempts on ~150 cells a collision happens in ~45% of maps and would give 11/13 often. The
  count is drawn from a small set (Simple uniform 3–8, Centralized uniform 16–20) and rocks go
  on free cells. Walls, rocks, checkpoint and ice counts are independent of each other.
- Checkpoints/teleports/ice can sit next to each other and next to start/finish; the observed
  adjacency rate matches uniform random placement (ice tiles were 4-adjacent in 1 of 8 ice
  maps, so "separate" is only a tendency). Header: `W.H.walls.Name...:` (name = type name,
  three extra fields empty).
- **`numberOfAttempts` and the "path too short" worry (investigated with 100 extra requests):**
  the first-20 gap (Complex median 44 local vs 54 sampled) was small-sample noise. With 80 Complex
  samples the no-walls length is median 45 / mean 45.0 vs local 44 / 45.0 (3000 maps); Centralized
  (60) median 32 / mean 34.9 vs local 32 / 33.7. Per checkpoint count, teleport-pair count,
  checkpoint col/row, start/finish distance, consecutive-checkpoint distance and teleport
  entrance-exit/nearest-feature distance, samples and local maps agree. The teleport entrance is on
  the no-walls path in only 13% of samples (9% local), so "teleport must be used" is not a rule.
  So there is no length or placement filter. `numberOfAttempts` > 1 is 17.5% of Complex (14/80),
  11.7% of Centralized (7/60), 10% of Normal (2/20), 0% of Simple (0/20), whereas blocked maps are
  essentially never produced locally (<0.1%). Attempt-count lengths (2 or 3) do not correlate with
  path length. A simulation of "re-roll when a checkpoint/teleport/ice item lands on an occupied
  cell" gives 16.4% Complex, 5.5% Centralized, 0.7% Normal, 0% Simple, which fits Complex and Simple
  but is a weak fit for Centralized and Normal; the accepted maps would be indistinguishable from
  ours either way. We therefore keep the blocked-only re-roll; `attempts` is cosmetic.
- Centralized checkpoints never landed in col 18 (60 sampled), so the preset uses cols 0–17.
- 20 samples per type is small. Percentages above are rough. Fetch more samples if a
  histogram looks off (the endpoint is cheap, but keep it polite).
- **Close enough:** local histograms fall inside the sampled ranges with similar shape, and the
  median no-walls path length is within ~10% of the samples'. Final check is playing them.
- Resolved: the site does not appear to reject maps for being too easy or hard (see above).

## 7. Risks

| Risk                                                                     | Mitigation                                                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Engine tie-breaking differs from the server in rare cases                | Scoreboard corpus (real high-scoring solutions) plus differential tests against `analyst.js`; exact-match tests               |
| `analyst.js` disagrees with the server in ways the corpus doesn't reveal | Used only for features where it agrees with the server data; targeted probes for the rest                                     |
| Our requests burden pathery.com                                          | One-time download of ~20 days of map/score files, 1–3 s apart, never re-fetched; `getpath` limited to ~30–60 confirmed probes |
| Pathery.com changes or goes offline                                      | Fixtures are recorded once and committed; samples and report are already local                                                |
| Generated maps feel different despite matching stats                     | No-walls path length comparison; optional solver-based difficulty comparison (Phase 7); playtesting                           |
| Ice rules are subtle                                                     | Dedicated probes in Phase 2 before writing the ice code                                                                       |

## 8. Order of work and checkpoints with Phil

1. Phases 0–1 (small). 2. Phase 2 offline corpus, then targeted probes: **confirm before sending
   the ~30–60 `getpath` requests**.
2. Phase 3 engine until all fixtures match. 4. Phase 4 generator plus genstats: **review maps together**.
3. Phase 5 UI: **playtest**. 6. Phases 6–7 as wanted.
