//! The pathing engine (port of `src/engine/pathing.ts`; read its header for the algorithm and
//! `src/engine/rules.ts` for where each rule comes from). Kept structurally identical to the
//! TypeScript so the two can be diffed by eye.

use crate::grid::{opposite, Grid};
use crate::mapcode::Map;

/// One element of the server's pathArray: a direction (1-4) or a string ("c1", "u", "3,2", ...).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Token {
    Dir(u8),
    Str(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathResult {
    pub tokens: Vec<Token>,
    pub moves: u32,
    pub blocked: bool,
    /// Server "x,y" strings.
    pub start: String,
    pub end: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathsResult {
    pub paths: Vec<PathResult>,
    pub total_moves: u32,
    pub blocked: bool,
}

/// rules.ts constants.
const FINISH_LABEL: &str = "f1";
const FAILED_WARP_TOKEN: &str = "r";

struct Leg {
    label: String,
    targets: Vec<u32>,
}

struct PathSpec {
    path_no: u32,
    /// Start tiles in row-major order.
    starts: Vec<u32>,
    legs: Vec<Leg>,
}

/// A reusable engine for one map. Not thread-safe (it reuses its work arrays); make one per
/// thread.
pub struct Engine {
    pub grid: Grid,
    specs: Vec<PathSpec>,
    /// cell -> number of a `tN` tile that warps (0 = none).
    tele_num: Vec<u32>,
    /// teleport number -> `uN` cells in row-major order.
    tele_exits: Vec<Vec<u32>>,
    tele_used: Vec<u8>,
    // Work arrays.
    pass: Vec<u8>,
    dist: Vec<i32>,
    queue: Vec<u32>,
    walls: Vec<u32>,
    // Outputs of the last walk().
    start_cell: i64,
    end_cell: i64,
}

/// rules.ts `pickNearest`: index of the source with the smallest distance (first on ties), or
/// None if no source can reach the target.
#[inline]
fn pick_nearest(cells: &[u32], dist: &[i32]) -> Option<usize> {
    let mut best = None;
    let mut best_dist = i32::MAX;
    for (i, &c) in cells.iter().enumerate() {
        let d = dist[c as usize];
        if d >= 0 && d < best_dist {
            best = Some(i);
            best_dist = d;
        }
    }
    best
}

impl Engine {
    pub fn new(map: &Map) -> Engine {
        let g = Grid::new(map);
        let cells_where = |pred: &dyn Fn(usize) -> bool| -> Vec<u32> {
            (0..g.size).filter(|&c| pred(c)).map(|c| c as u32).collect()
        };

        // Teleports.
        let mut max_tele = 0u32;
        for t in &g.tiles {
            if t.kind == b't' {
                max_tele = max_tele.max(t.value);
            }
        }
        let mut tele_num = vec![0u32; g.size];
        let mut tele_exits = vec![Vec::new(); max_tele as usize + 1];
        for (c, t) in g.tiles.iter().enumerate() {
            if t.kind == b't' {
                tele_num[c] = t.value;
            }
        }
        for n in 1..=max_tele {
            tele_exits[n as usize] = cells_where(&|c| g.tiles[c].kind == b'u' && g.tiles[c].value == n);
        }
        // A `t0` tile would have number 0 = "no teleport"; the TS engine treats it the same way.

        // Paths and their targets (rules.ts checkpointSequence: c1..cMax, reversed for path 2).
        let max_cp = g
            .tiles
            .iter()
            .filter(|t| t.kind == b'c')
            .map(|t| t.value)
            .max()
            .unwrap_or(0);
        let finishes = cells_where(&|c| g.tiles[c].kind == b'f');
        let mut specs = Vec::new();
        for path_no in [1u32, 2] {
            let starts = cells_where(&|c| g.tiles[c].kind == b's' && g.tiles[c].value == path_no);
            if starts.is_empty() {
                continue;
            }
            let mut seq: Vec<u32> = (1..=max_cp).collect();
            if path_no == 2 {
                seq.reverse();
            }
            let mut legs: Vec<Leg> = seq
                .into_iter()
                .map(|n| Leg {
                    label: format!("c{n}"),
                    targets: cells_where(&|c| g.tiles[c].kind == b'c' && g.tiles[c].value == n),
                })
                .collect();
            legs.push(Leg {
                label: FINISH_LABEL.into(),
                targets: finishes.clone(),
            });
            specs.push(PathSpec {
                path_no,
                starts,
                legs,
            });
        }

        let (size, state_count) = (g.size, g.state_count);
        Engine {
            grid: g,
            specs,
            tele_num,
            tele_exits,
            tele_used: vec![0; max_tele as usize + 1],
            pass: vec![0; size],
            dist: vec![-1; state_count],
            queue: vec![0; state_count],
            walls: Vec::with_capacity(size),
            start_cell: -1,
            end_cell: -1,
        }
    }

    /// Records the wall cells, ignoring any that are off-grid or not wallable.
    fn set_walls(&mut self, walls: &[u32]) {
        self.walls.clear();
        for &c in walls {
            if (c as usize) < self.grid.size && self.grid.wallable[c as usize] != 0 {
                self.walls.push(c);
            }
        }
    }

    /// Full result in the server's format.
    pub fn compute(&mut self, walls: &[u32]) -> PathsResult {
        self.set_walls(walls);
        let mut paths = Vec::new();
        for i in 0..self.specs.len() {
            let mut tokens = Vec::new();
            let moves = self.walk(i, Some(&mut tokens), None);
            if moves < 0 {
                let sc = if self.start_cell >= 0 {
                    self.start_cell as usize
                } else {
                    self.specs[i].starts[0] as usize
                };
                let start = self.grid.xy(sc);
                paths.push(PathResult {
                    tokens,
                    moves: 0,
                    blocked: true,
                    end: start.clone(),
                    start,
                });
                break; // rules.ts STOP_AT_FIRST_BLOCKED_PATH
            }
            paths.push(PathResult {
                tokens,
                moves: moves as u32,
                blocked: false,
                start: self.grid.xy(self.start_cell as usize),
                end: self.grid.xy(self.end_cell as usize),
            });
        }
        let blocked = paths.iter().any(|p| p.blocked);
        let total_moves = if blocked {
            0
        } else {
            paths.iter().map(|p| p.moves).sum()
        };
        PathsResult {
            paths,
            total_moves,
            blocked,
        }
    }

    /// Total moves, or -1 if any path is blocked. No allocation.
    pub fn score(&mut self, walls: &[u32]) -> i32 {
        self.set_walls(walls);
        let mut total = 0;
        for i in 0..self.specs.len() {
            let m = self.walk(i, None, None);
            if m < 0 {
                return -1;
            }
            total += m;
        }
        total
    }

    /// Cells visited by each path for the given walls, in order (start included, one entry per
    /// visit, a warp exit counts as visited), or None if blocked.
    pub fn path_cells(&mut self, walls: &[u32]) -> Option<Vec<Vec<u32>>> {
        let res = self.compute(walls);
        if res.blocked {
            return None;
        }
        let w = self.grid.width;
        let xy = |s: &str| -> u32 {
            let mut it = s.split(',').map(|v| v.parse::<usize>().unwrap());
            let (x, y) = (it.next().unwrap(), it.next().unwrap());
            (y * w + x) as u32
        };
        let mut out = Vec::new();
        for p in &res.paths {
            let mut cells = Vec::new();
            let mut cell = xy(&p.start);
            cells.push(cell);
            let mut i = 0;
            while i < p.tokens.len() {
                match &p.tokens[i] {
                    Token::Dir(d) => {
                        cell = self.grid.nbr[cell as usize * 4 + *d as usize - 1] as u32;
                        cells.push(cell);
                    }
                    Token::Str(s) if s == "u" && i + 2 < p.tokens.len() => {
                        if let Token::Str(c) = &p.tokens[i + 1] {
                            cell = xy(c);
                            cells.push(cell);
                            i += 2;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            out.push(cells);
        }
        Some(out)
    }

    /// The cells where a wall can change the result for these walls: every cell the paths visit,
    /// plus, at each warp, the walking route the path would have continued on from the teleport
    /// entrance (following the distance field, ignoring teleports). None if blocked.
    ///
    /// Why that is enough: a wall changes a distance only if it hits every shortest walking route.
    /// Each visited cell has one shortest walking route made of visited cells up to the next warp
    /// entrance, then that entrance's walking route. So walls elsewhere keep every visited cell's
    /// distance, other start tiles and exits can only get farther (never chosen instead), and the
    /// walk takes the same steps. Without teleports this is just the visited cells.
    pub fn support_cells(&mut self, walls: &[u32]) -> Option<Vec<u32>> {
        self.set_walls(walls);
        let mut out = Vec::new();
        for i in 0..self.specs.len() {
            if self.walk(i, None, Some(&mut out)) < 0 {
                return None;
            }
        }
        Some(out)
    }

    /// Walks one path; returns its moves or -1 if blocked (see pathing.ts `walk`). Appends the
    /// tokens and/or the support cells (see `support_cells`) if asked.
    fn walk(
        &mut self,
        spec_i: usize,
        mut tokens: Option<&mut Vec<Token>>,
        mut support: Option<&mut Vec<u32>>,
    ) -> i32 {
        let spec = &self.specs[spec_i];
        let g = &self.grid;
        self.pass.copy_from_slice(&g.passable[spec.path_no as usize - 1]);
        for &w in &self.walls {
            self.pass[w as usize] = 0;
        }
        self.tele_used.fill(0); // rules.ts TELEPORTS_SHARED_BETWEEN_PATHS = false

        let mut single = [0u32; 1];
        let mut use_starts = true;
        let mut moves = 0i32;
        let mut cell: usize = 0;
        self.start_cell = -1;
        for leg in &spec.legs {
            if let Some(t) = tokens.as_deref_mut() {
                t.push(Token::Str(leg.label.clone()));
            }
            distance_field(g, &self.pass, &mut self.dist, &mut self.queue, &leg.targets);
            let dist = &self.dist;
            let sources: &[u32] = if use_starts { &spec.starts } else { &single };
            let Some(i) = pick_nearest(sources, dist) else {
                return -1;
            };
            cell = sources[i] as usize;
            if self.start_cell < 0 {
                self.start_cell = cell as i64;
            }
            let mut state = cell;
            let mut d = dist[state];
            if let Some(s) = support.as_deref_mut() {
                s.push(cell as u32);
            }
            while d > 0 {
                let (next, dir) = descend(g, dist, state, d);
                state = next;
                cell = g.state_cell[next] as usize;
                d -= 1;
                moves += 1;
                if let Some(s) = support.as_deref_mut() {
                    s.push(cell as u32);
                }
                if let Some(t) = tokens.as_deref_mut() {
                    t.push(Token::Dir(dir));
                }

                let tn = self.tele_num[cell] as usize;
                if tn != 0 {
                    if self.tele_used[tn] != 0 {
                        if let Some(t) = tokens.as_deref_mut() {
                            t.push(Token::Str(format!("t{tn}")));
                        }
                    } else {
                        if let Some(s) = support.as_deref_mut() {
                            // The walking route from the entrance that set this cell's distance.
                            let (mut vs, mut vd) = (state, d);
                            while vd > 0 {
                                vs = descend(g, dist, vs, vd).0;
                                vd -= 1;
                                s.push(g.state_cell[vs]);
                            }
                        }
                        self.tele_used[tn] = 1;
                        let exits = &self.tele_exits[tn];
                        let Some(j) = pick_nearest(exits, dist) else {
                            if let Some(t) = tokens.as_deref_mut() {
                                t.push(Token::Str(FAILED_WARP_TOKEN.into()));
                            }
                            return -1;
                        };
                        cell = exits[j] as usize;
                        state = cell;
                        d = dist[cell];
                        if let Some(s) = support.as_deref_mut() {
                            s.push(cell as u32);
                        }
                        if let Some(t) = tokens.as_deref_mut() {
                            t.push(Token::Str("u".into()));
                            t.push(Token::Str(g.xy(cell)));
                            t.push(Token::Str("u".into()));
                        }
                    }
                }
            }
            if let Some(t) = tokens.as_deref_mut() {
                t.push(Token::Str("r".into()));
            }
            single[0] = cell as u32;
            use_starts = false;
        }
        self.end_cell = cell as i64;
        moves
    }
}

/// One step of the walk: the first successor of `state` (U, R, D, L; on ice only straight on)
/// whose distance is `d - 1`, and the direction taken.
#[inline]
fn descend(g: &Grid, dist: &[i32], state: usize, d: i32) -> (usize, u8) {
    let cell = g.state_cell[state] as usize;
    let sd = g.state_dir[state];
    let d_end = if sd != 0 { sd } else { 4 };
    let mut dir = if sd != 0 { sd } else { 1 };
    while dir <= d_end {
        let v = g.nbr[cell * 4 + dir as usize - 1];
        if v >= 0 {
            let iv = g.ice_state[v as usize];
            let sv = if iv < 0 {
                v as usize
            } else {
                iv as usize + dir as usize - 1
            };
            if dist[sv] == d - 1 {
                return (sv, dir);
            }
        }
        dir += 1;
    }
    panic!("pathing: inconsistent distance field");
}

/// Fills `dist[state]` = moves from that state to the nearest target (-1 = unreachable),
/// searching backwards from the targets (see pathing.ts `distanceField` for the movement rule).
fn distance_field(g: &Grid, pass: &[u8], dist: &mut [i32], queue: &mut [u32], targets: &[u32]) {
    dist.fill(-1);
    let (mut head, mut tail) = (0usize, 0usize);
    for &t in targets {
        let t = t as usize;
        if pass[t] != 0 && dist[t] < 0 {
            dist[t] = 0;
            queue[tail] = t as u32;
            tail += 1;
        }
    }
    while head < tail {
        let v = queue[head] as usize;
        head += 1;
        let nd = dist[v] + 1;
        let vc = g.state_cell[v] as usize;
        let vd = g.state_dir[v];
        let d_end = if vd != 0 { vd } else { 4 };
        let mut d = if vd != 0 { vd } else { 1 };
        while d <= d_end {
            let u = g.nbr[vc * 4 + opposite(d) as usize - 1];
            if u >= 0 && pass[u as usize] != 0 {
                let iu = g.ice_state[u as usize];
                let su = if iu < 0 {
                    u as usize
                } else {
                    iu as usize + d as usize - 1
                };
                if dist[su] < 0 {
                    dist[su] = nd;
                    queue[tail] = su as u32;
                    tail += 1;
                }
            }
            d += 1;
        }
    }
}
