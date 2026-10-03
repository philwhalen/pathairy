# Pathery (pathery.com) — Architecture Report

Analysis of the original browser game at https://www.pathery.com, written 2026-10-03 as the
reference for building a local version. Everything below is based on the downloaded client code
and on live requests to the server. Statements marked **(probed)** were confirmed by sending
test maps to the server's pathing endpoint. Statements marked **(inferred)** are not confirmed.

## 1. Key conclusion

**The pathing engine runs on the server (PHP, not public). The browser only draws the board,
records wall placements and animates a path the server sends back.** No client file contains
pathfinding. A local version needs a new engine. Section 5 gives the rules it must follow, and
the server can be used to check it (section 8).

## 2. Local reference copies

All under `reference/original/`:

| Path                   | What it is                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `js/mapspecs.js`       | Main game client: rendering, wall placement, Go request, path animation (1108 lines)             |
| `js/scores.js`         | Scoreboard and member-list paging/rendering                                                      |
| `js/ajax.js`           | "SACK" AJAX library (2005); global `ajax` object used for `do.php` calls                         |
| `js/globe.js`          | Cookie helpers (`savePref`, `getCookie`), sign-in box toggle                                     |
| `js/dateformat.js`     | Third-party `Date.prototype.format`                                                              |
| `pages/tutorial.html`  | 5 tutorial maps embedded as JSON plus inline tutorial controller (`TutorialView`, `challengeGo`) |
| `pages/faq.html`       | Official rules text, with 4 demo maps embedded as JSON                                           |
| `pages/mapeditor.html` | Map editor (inline JS); lists tile palette and named "special" map generators                    |
| `pages/home.html`      | Daily-maps page (5 map IDs that change daily)                                                    |
| `pages/scores.html`    | Historical maps browser                                                                          |
| `pages/root.html`      | Same as tutorial page (root serves the tutorial)                                                 |
| `api/map_*.json`       | Sample map files from `a/map/{id}.js`                                                            |
| `api/getpath_*.json`   | Sample server path responses for real maps                                                       |
| `api/probe_*.json`     | Server responses for the test maps used in section 5                                             |

Not downloaded: CSS (`css/maps.css`, `css/page.css`), images (`images/paths/Path{1,2}-{1..4}.png`,
overlays, emblems), sounds (`sounds/*.mp3`). Tile appearance comes from `maps.css` classes
named `{type}{value}` (e.g. `.c1`, `.t3`).

## 3. System architecture

```
Browser (jQuery 1.8.3 + mapspecs.js)                 Server (PHP, closed source)
------------------------------------                 ---------------------------
displayMap() ── GET a/map/{id}.js ─────────────────► static map JSON (cached)
mapAsHTML()  renders grid of <div>s
grid_click() toggles walls, builds solution string
doSend()     ── POST do.php?r=getpath&mapcode=..&solution=.. ─► pathing engine
request_path_done() ◄── JSON {path:[{pathArray..}], best, mybest} ──┘
doanimate()  steps through pathArray with setTimeout
scoresShowPage() ── GET a/score/{mapid}_{page}.js ─► scoreboard JSON
```

### Endpoints

| Endpoint                                                             | Method                                                            | Purpose                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `a/map/{id}.js`                                                      | GET                                                               | Map JSON (section 4.1)                                               |
| `a/challenge/{id}.js`                                                | GET                                                               | Challenge-map JSON                                                   |
| `a/score/{mapid}_{page}.js`                                          | GET                                                               | Scoreboard page                                                      |
| `a/mapsbydate/{yyyy-mm-dd}.js`                                       | GET                                                               | Array of map IDs for a date                                          |
| `do.php?r=getpath&isChallenge=&mapcode=&mapid=&solution=`            | **POST** with a non-empty body (GET or empty POST gives HTTP 411) | Compute path and record score (section 4.4)                          |
| `do.php?r=getsol&mapID=`                                             | POST                                                              | Player's saved best solution `{solution, moves, mapid}`              |
| `do.php?r=getChallengeSolution&mapID=&challengeID=`                  | POST                                                              | Same, for challenges                                                 |
| `do.php?r=reqMemberPage&...`                                         | POST                                                              | Member list                                                          |
| `mapeditor` (POST `mapByMap=<json>`)                                 | POST                                                              | Validates an editor map and returns playable map JSON plus mapcode   |
| `mapeditor?mapByCode=` / `?mapBySpecial=<name>` / `?genMap=true&...` | GET                                                               | Load a map by code, generate a named special map, or random-generate |

Login is OAuth (Google/Facebook/etc.). `userObj` is set inline on each page
(`ID:-1` when logged out). Anonymous `getpath` calls still work and return `mybest:"0"`.

## 4. Data formats

### 4.1 Map JSON

```json
{"ID":23462, "width":13, "height":6, "walls":"8", "name":"Simple",
 "tiles":[ [["s",1],["o",1],...], ... ],          // tiles[row][col] = [type, value]
 "teleports":0, "checkpoints":1, "flags":"", "isBlind":false,
 "dateExpires":1791086400, "containsNormalStart":true, "containsReverseStart":false,
 "normalStartLocations":["0,0"], "reverseStartLocations":null,
 "code":"13.6.8.Simple...:,s1.11,r3.,...", "oldCode":null}
```

`walls` is a **string**. Some numeric fields arrive as strings, and the client coerces them with `x - 0`.

### 4.2 Coordinate conventions (easy to get wrong)

- `tiles[row][col]`. DOM tile id = `"{mapid},{row},{col}"`.
- **Solution string** uses `row,col`: `".3,5.4,6.:"` = walls at (row3,col5), (row4,col6). It
  starts with `.`, uses `.` between entries and ends with `:` **(probed)**. Old solutions without `:`
  are converted by `fixOldYSolution`.
- **Server path coordinates** (`start`, `end`, teleport targets in `pathArray`) use `x,y` = `col,row`.
- `mapspecs.js` swaps the names `x` and `y` internally (in `doanimate`, `x` is the row). Don't copy its
  variable naming.

### 4.3 Tile types

| Code | Name                      | Values                                                         | Behavior                                                                                                              |
| ---- | ------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `o`  | Open                      | 1                                                              | Passable. Only tile type the player can wall                                                                          |
| `s`  | Start                     | 1 = green/path 1 start, 2 = red/path 2 start ("reverse start") | Passable mid-path                                                                                                     |
| `f`  | Finish                    | 1                                                              | Final target. Passable mid-path                                                                                       |
| `c`  | Checkpoint                | 1..15 (A, B, C, ...)                                           | Targets visited in order. Passable when not the current target                                                        |
| `r`  | Rock                      | 1, 2, 3                                                        | Impassable. Values are cosmetic only **(probed r2, r3)**                                                              |
| `t`  | Teleport In               | 1..7 (paired with `u` of same value)                           | Trap, see 5.5                                                                                                         |
| `u`  | Teleport Out              | 1..7                                                           | Exit point. Passable                                                                                                  |
| `p`  | Unbuildable               | 1                                                              | Passable, but walls can't be placed there **(probed)**                                                                |
| `x`  | Single-Path Rock          | 1, 2                                                           | `x1` blocks path 1 (from `s1`), passable for path 2. `x2` blocks path 2, passable for path 1 **(probed)**             |
| `z`  | "Directional Force" / Ice | 5 = ice                                                        | Path can't turn on it **(probed)**. Values 1–4 are probably directional (conveyor) tiles (inferred, not seen in data) |

Player walls are drawn as `.child.w` with the player's color/emblem. On the server they behave
like rocks.

### 4.4 Map code (compact map string)

`width.height.walls.name.?.?.?:` + body. All samples have 3 empty trailing header fields
(meaning unknown). The body is a run-length list of non-open tiles, `gap,TypeValue.` per entry,
in row-major order: `index = previousIndex + 1 + gap` (start `previousIndex = -1`; empty
gap = 0). Trailing open tiles are omitted.
Example: `13.6.8.Simple...:,s1.11,r3.,r3.1,r1.` → s1@0, r3@12, r3@13, r1@15.
The server accepts **any** map code in `getpath`, so the client can send a made-up map.

### 4.5 `getpath` response

```json
{
  "totalMoves": 16,
  "blocked": false,
  "path": [
    {
      "start": "0,0",
      "end": "12,4",
      "moves": 16,
      "blocked": false,
      "pathArray": ["c1", 2, 2, 2, 3, 3, 3, 3, "r", "f1", 2, 2, 2, 2, 2, 2, 2, 2, 2, "r"]
    }
  ],
  "mapid": 23462,
  "mapcodeExecuted": "...",
  "usedSolution": "..:",
  "best": "48",
  "bestby": "vzl[pi]",
  "mybest": "0"
}
```

- `path` has 1 entry, or 2 on dual-path maps (index 0 = green from `s1`, index 1 = red from `s2`).
  `totalMoves` = sum.
- Blocked: `{"blocked":true, "totalMoves":0, path:[{"blocked":true,"lastTarget":{"f":1},"pathArray":["f1"],"moves":0}]}`.
  The client shows "Uhm, the path is blocked...". Score is 0.
- Errors: `{"error":["Invalid solution"]}` (wall on non-`o` tile), or plain text `Out of walls???` (too many walls).

**`pathArray` tokens** (walked in order starting from `start`):

| Token               | Meaning                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `"c1"`, `"f1"`, ... | Now heading to this target. The client sets the path color to `targetColor(token)`                                             |
| `1` `2` `3` `4`     | Move Up / Right / Down / Left one cell (counts as 1 move)                                                                      |
| `"r"`               | Reached the target on the current cell. The client greys the tile (`#dddddd`)                                                  |
| `"u"`               | Teleport event on the current cell. Emitted as `"u", "x,y", "u"`: grey teleport-in, warp to `x,y` (0 moves), grey teleport-out |
| `"t1"` etc.         | Stepped onto an **already-used** teleport-in. No effect                                                                        |

## 5. Game rules (pathing engine spec)

Sources: FAQ text plus server probes (`api/probe_*.json`).

1. **Goal.** Place up to `walls` walls on open tiles to make the path as long as possible.
   Score = total moves. A blocked path scores 0.
2. **Shortest path, 4-directional.** The path always takes a shortest route (by moves) to its
   _current target only_. It is greedy and doesn't plan ahead **(probed: greedy demo)**.
3. **Target order.** Path 1 (green, from `s1`): c1, c2, ..., cN, f. Path 2 (red, from `s2`):
   **cN, ..., c2, c1, f** (reverse checkpoint order, same finish) **(probed: dual3cp)**. Checkpoint
   numbers with no tile on the map are skipped (inferred).
4. **Multiple tiles of one target type.** The path goes to the nearest one **(probed)**. An
   unreachable copy is ignored as long as another copy is reachable **(probed)**.
5. **Multiple start tiles.** The path starts from whichever start tile is closest to the first
   target **(probed: startnear)**. Tie: in one test, the first start in row-major order won
   **(probed: starttie, single case)**.
6. **Tie-breaking between equal-length routes: Up, Right, Down, Left.** "The path will go UP as
   far as it can first." Bottom-left→top-right gives `1111 2222`, top-right→bottom-left gives
   `3333 4444` **(probed)**. A model that matches all probes: BFS distances outward from the target(s), then
   walk from the current cell, at each step picking the first neighbor in order U,R,D,L whose
   distance is one less. Verify this against the server on harder maps before relying on it.
7. **Teleports are traps.** They do not affect route choice (the route is planned as if they were
   plain tiles). If the path steps onto an unused `tN`, it warps to `uN` (0 moves). Then it plans
   a new route from there to the same target. **All `tN` tiles of that number are spent after one use**.
   Later visits emit `"tN"` and do nothing **(probed: teleport, tptwo)**. With several `uN`
   tiles, which exit is used is unknown. Whether teleport state is shared between the two paths
   is unknown.
8. **Ice (`z5`).** The path can't change direction while on ice. The engine plans routes with this
   rule built in (ice is not a trap) **(probed: ice demo gives 12 moves instead of 6)**. To model
   this, include direction in the search state while on ice.
9. **Passability.** Rocks and walls block. Start, finish, checkpoints, teleports and `p` are passable.
   `x1` blocks only path 1 and `x2` only path 2, even on single-path maps **(probed)**.
10. **Walls.** Allowed only on `o` tiles. More walls than `walls` is rejected **(probed)**.
    Fully blocking is allowed and gives a blocked result **(probed)**.
11. **Dual paths** are computed independently on the same board. The score is the sum. The client shows
    `green + red = total`.

## 6. Client code walk-through (`mapspecs.js`)

Global state (all keyed by map id, so several maps can share a page): `mapdata[id]` (map JSON
plus `usedWallCount`, animation state), `solution[id]` (wall string), `mapjson[id]` (last server
response), `count[id]` (move counter during animation).

- **Load:** `displayMap(id, divID, width, solution, moves)` → AJAX `a/map/{id}.js` →
  `mapAsHTML(map)` builds HTML strings: a `.map.playable` container of `.mapcell {type}{value}`
  divs, each with an inner `.child` div used for path/wall overlays. Only `o` cells get
  `onClick='grid_click(this)'`. Tiles are 35px (scaled down to fit `targetWidth`). Also adds the
  header (map id, walls left, Reset), the Go button, speed `<select>` and mute toggle.
  `getmapdata` resets `usedWallCount = walls` and `solution = '.'`.
- **Walls:** `grid_click` toggles `obj.cv`, edits `solution[id]` (`+= "r,c."` / replace
  `".r,c."`), updates the "N walls" counter and refuses at 0 ("OUT!").
  `clearwalls`/`resetwalls` undo everything. `loadSolution`/`showTempSolution` replay a solution
  string by calling `grid_click` on each listed cell (used for scoreboard hover previews,
  `restoreSolution` puts back the player's own).
- **Go:** `doSend` POSTs to `do.php`. `request_path_done` parses the response, shows the record line,
  sets `pathsPending` and calls `animatePath` for each path. The paths animate at the same time.
- **Animation:** `doanimate(x, y, pathArray, currentToken, id, pathNo)` handles one token per
  `setTimeout`. Step delays by speed setting: Slow 180 ms, Med 94, Fast 44, Ultra 22, Insane 1.
  Reaching a target (`c`/`f` next) adds +250 ms (+200 more at speed ≤ 2). A teleport adds
  `1350 - speed*100` ms. Each step sets the cell's `.child` class to `transition path{pathNo}-{dir}`
  (arrow sprite `images/paths/Path{1|2}-{dir}.png`) and the cell background to the path color,
  then clears both after ~860 ms (trail effect). Every 100 moves a chime plays and the counter
  flashes. When all paths finish, the final score is compared with `best`/`mybest` and shown as
  "Beat X's record", "Tied", "Improved", etc. Visited target tiles are restored after 2.5 s.
- **Colors:** `targetColor`: c1 `#F777FF`, c2 `#FFFF11`, c3 `#FF4466`, c4 `#ff9911`, c5 `#00FFFF`,
  c6 `#a12ec4`, c7 `#46c0a0`, c8 `#33ff33`, c9 `#f032e6`, c10 `#d2f53c`, c11 `#fabebe`,
  c12 `#9090f4`, c13 `#e6beff`, c14 `#aa6e28`, c15 `#fffac8`, f `#ccc`. Default wall color `#666`.
- **Sounds** (SoundManager2, ids → files in `/sounds/`): `charm` (every 100 moves / new best),
  `bling`/`blingb` (path 1/2 reaches checkpoint), `ufoblip` (teleport), `sc`=transmission.mp3
  (improved score), `achieve` (achievement notification), `pit` (unmute).
- **Prefs:** cookies `pref_speed`, `pref_mute` via `savePref`.
- Code quality: built from HTML strings with inline `onclick`, `setTimeout` with string code, implicit
  globals everywhere. Use it as a behavior reference only, not code to reuse.

## 7. Other pages

- **Tutorial** (`pages/tutorial.html`): 5 maps with `isChallenge = true`. `challengeGo(mapid)` checks
  `mapjson[mapid].path[0].moves` against goals (18, 64, 33, 75) and unlocks the next step.
  Hint tiles are listed as DOM ids `"map,row,col"`. Good small test maps with known answers.
- **FAQ** (`pages/faq.html`): rules text plus 4 demo maps (teleport priority, dual path with `x`
  tiles, greedy checkpoints, ice).
- **Home**: 5 daily maps (Simple, Normal, Complex, Centralized, Ultra Complex Unlimited), each with
  "Load your best solution" and a scoreboard. Countdown to the next map.
- **Map editor**: palette `s1 s2 f1 p1 x1 x2 z5 r1-3 o1 c1-14 t1-7 u1-7`. Max 50×50. The server
  returns a validated playable map with `code`. Named special-map generators: simple, normal,
  complex, abcs, centralized, dualing paths, loop craziness, mirror image, rocky maze,
  reverse order, seeing double, side to side, teleport madness, thirty, thirty too,
  ultimate random, ultra complex (unlimited), plus "Underground" and "Experimental" (ice) sets.
  Fetching `mapeditor?mapBySpecial=<name>` returns a freshly generated map. That's a source
  of realistic test maps.
- **Scores**: browse past maps by date (`a/mapsbydate/`). Old maps show every player's solution,
  so they are a source of high-scoring reference solutions.

## 8. Recommendations for the local version

1. **Engine first, as a pure module** (no DOM): `computePaths(map, walls) → {paths:[{tokens, moves,
blocked}], total}`. Produce the same `pathArray` token format as the server so responses can be
   diffed directly.
2. **Use the server to check the engine.** POST `do.php?r=getpath&isChallenge=false&mapid=-1&mapcode=<code>&solution=<sol>`
   with any non-empty body (e.g. `rndval=1`). Compare tokens for many maps and solutions. Sources of
   cases: tutorial/FAQ maps, daily maps (`a/map/{id}.js`), special-map generator, top solutions from
   old scoreboards. Keep request volume modest. Store results locally as fixtures.
3. **Open questions to settle with that check:** exact tie-breaking (rule 6) on complex maps; start tie
   (rule 5); multiple `uN` exits; teleport state across dual paths; ice turning/entry details and
   `z1–z4`; whether `isBlind` maps hide the path; meaning of the 3 empty map-code header fields.
4. **Rendering:** replicate with a canvas or CSS grid. The look needs `maps.css` and the
   `images/` sprites (not downloaded yet; copyright pathery.com 2011–2018, fine for personal use).

## 9. Addendum: probe results (2026-10-03)

36 `getpath` probes (Phil approved) were sent sequentially, 3-4 s apart, with `tools/oracle/record.ts`.
Fixtures are `tests/fixtures/oracle/<name>.json`; `node tools/oracle/check-corpus.mjs -v` compares each
with `analyst.js`. All 36 got a normal path response (no error replies). Open questions from §5/§8:

- **Several `uN` exits: the exit nearest to the current target by real path distance wins** (not
  Manhattan, not first/last). Ties go to the first exit in row-major order. A walled-in exit is
  never chosen. `u_far_exit_nearest_target` (col 7 of 3/7), `u_first_exit_nearest_target`,
  `u_three_exits` (last of three), `u_manhattan_vs_path` (3,2 beats Manhattan-closer 4,0),
  `u_exit_tie_equal_dist` ("1,0" over "1,2"), `u_sealed_exit`. analyst.js agrees on all.
- **Two teleport numbers** are independent: each tN is spent separately, tokens
  `u,"4,0",u ... u,"9,0",u` (`u_two_numbers_two_exits`). Agrees.
- **Teleports with dual paths: state is per path.** Both paths warp on their first visit; the
  second path is not affected by the first path's spent teleports; each path emits its own
  `"tN"` on a later visit (`dual_tp_shared_state` 9, `dual_tp_reuse_twice` 13). Agrees.
- **tN without uN: the path is blocked.** Walking onto `t1` with no `u1` gives `blocked:true`,
  `moves:0`, partial `pathArray ["f1",2,2,"r"]` (moves up to the teleport tile, then `"r"`), no
  `lastTarget` (`t_no_exit`). analyst.js is **wrong**: it treats `t1` as a plain tile (5 moves).
- **uN without tN** is a plain passable tile (`u_no_entry`, 5 moves). Agrees.
- **Missing checkpoint numbers: blocked, score 0.** Targets are c1..cN in order with N = highest
  number present; the first missing number cannot be reached, so that path is blocked with
  `lastTarget {"c":k}` and `pathArray` = tokens up to and including `"ck"` (e.g. `["c1",2,2,"r","c2"]`).
  Only the first blocked path is reported, so on a dual map `path` has one entry and
  `totalMoves` is 0 (`cp_gap_c1_c3`, `_c2_only`, `_c1_c2_c4` (stops at `c3`), `_c1_c4`, `_c2_c3_no_c1`,
  `_dual`). analyst.js is **wrong**: it stops at the first gap and goes to `f` (8, 8, 14, 8, 8, 18).
  Which path order is blocked first on a dual map where only the red path is affected: not tested.
- **Ice (`z5`), observed rules**, all identical to analyst.js:
  - Dead ends are blocked: ice then rock (`ice_deadend_rock`), then map edge (`ice_deadend_edge`),
    then a player wall (`ice_wall_ahead`), and ice-to-ice turning chains (`ice_chain_turn`). The
    path never turns on ice, not even when forced to by an obstacle ahead.
  - Leaving ice onto a plain tile: free again at once, turn allowed on that first plain tile
    (`ice_slide_continues`: 2,2,3). Vertical ice works (`ice_vertical`).
  - Tie-breaking is still U,R,D,L over the ice-aware search: an equal-length route via ice wins
    when it starts with R (`ice_tie_prefers_ice`: 2,2,3 rather than 3,2,2). Red path on
    `ice_dual` goes 1,2,2,2 through the `s1` tile and the ice.
- **`z1`-`z4`:** `z1` is **impassable** (like a rock): `z1_center` detours (4 moves, route 1,2,2,3),
  `z1_down` is blocked. `z2`, `z3`, `z4` are plain passable tiles in every tested direction
  (right in `z*_center`, down in `z*_down`, left in `z*_left`); up not tested. No error is
  returned for any of them. They never occur on real maps; engine may treat z1 as a rock.
  analyst.js treats z1 as plain (wrong); z2-z4 agree.

Blocked paths: the reported `end` is junk (`"0,0"`, `"-1,1"`, `"7,3"`); never compare it.
analyst.js direction tokens are wrong on width-1 boards (down is emitted as 2, since its index
step +1 is read as "right"); moves agree. Real maps are never 1 wide.

### Per-feature classification of analyst.js

| Feature                                   | Agrees with server? | Evidence                                                  |
| ----------------------------------------- | ------------------- | --------------------------------------------------------- |
| Plain shortest path, U,R,D,L tie-break    | Yes                 | 280/280 plain scoreboard rows, probe__/getpath__ fixtures |
| Checkpoints in order, dual reverse order  | Yes                 | scoreboard, probe_dual3cp                                 |
| Checkpoint numbers with gaps              | **No**              | 6 `cp_gap_*` fixtures (server: blocked)                   |
| Multiple targets of one type, multi-start | Yes                 | probe_startnear/starttie/multistart, scoreboard           |
| `x1`/`x2`, `p1`                           | Yes                 | scoreboard 21/21 and 8/8, probe_x*/ppass                  |
| Teleport warp, spent after one use        | Yes                 | 292/292 scoreboard, probe_teleport/tptwo, tokens exact    |
| Several `uN` exits (nearest, tie, sealed) | Yes                 | 6 `u_*` fixtures                                          |
| Per-path teleport state on dual maps      | Yes                 | `dual_tp_*`                                               |
| `tN` with no `uN`                         | **No**              | `t_no_exit` (server: blocked)                             |
| `uN` with no `tN`                         | Yes                 | `u_no_entry`                                              |
| Ice (`z5`): moves, dead ends, turns, ties | Yes                 | 89/89 scoreboard rows, 9 `ice_*`/probe_ice fixtures       |
| `z1` tile                                 | **No**              | `z1_center`, `z1_down` (server: impassable)               |
| `z2`-`z4` tiles                           | Yes (as plain)      | 7 `z*_center/down/left` fixtures; up not tested           |
| Width-1 boards, direction tokens          | **No** (tokens)     | `z2_down` etc.; moves agree, irrelevant for real maps     |
| Blind maps, wall + ice + teleport combos  | Not tested          |                                                           |
