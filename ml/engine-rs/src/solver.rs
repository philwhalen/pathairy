//! Simulated-annealing wall placer: a port of `src/solver/solve.ts` (same moves, schedule and
//! parameters; read that file's header for the algorithm). Used as the SA baseline of
//! docs/rl-agent-plan.md. The random streams differ from the TS version, so results match in
//! quality, not bit for bit.

use crate::baselines::Rng;
use crate::engine::Engine;
use crate::mapcode::Map;
use std::time::{Duration, Instant};

/// Search constants, same names and defaults as `DEFAULT_PARAMS` in solve.ts.
#[derive(Clone, Copy, Debug)]
pub struct Params {
    pub greedy_samples: usize,
    pub restart_samples: usize,
    pub run_base: usize,
    pub run_per_wall: usize,
    pub run_wall_cap: usize,
    pub temp_base: f64,
    pub temp_frac: f64,
    pub temp_end: f64,
    pub p_add: f64,
    pub p_shift: f64,
    pub p_move: f64,
    pub p_near: f64,
    pub drop_min: f64,
    pub drop_range: f64,
    pub p_fresh: f64,
    pub p_relocate: f64,
    pub relocate_samples: usize,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            greedy_samples: 12,
            restart_samples: 6,
            run_base: 1500,
            run_per_wall: 40,
            run_wall_cap: 200,
            temp_base: 2.0,
            temp_frac: 0.01,
            temp_end: 0.15,
            p_add: 0.5,
            p_shift: 0.55,
            p_move: 0.9,
            p_near: 0.15,
            drop_min: 0.1,
            drop_range: 0.25,
            p_fresh: 0.25,
            p_relocate: 0.9,
            relocate_samples: 4,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SolveResult {
    /// Best wall set (map cells) and its score.
    pub walls: Vec<u32>,
    pub score: i32,
    pub evaluations: u64,
}

/// Runs until `time` has passed or `max_evals` score evaluations were made (whichever first;
/// with `time = None` only the evaluation count stops it, which makes the result deterministic).
pub fn solve(
    map: &Map,
    seed: u64,
    time: Option<Duration>,
    max_evals: Option<u64>,
    params: Params,
) -> SolveResult {
    let mut s = Annealer::new(map, seed, time, max_evals, params);
    s.run();
    SolveResult {
        walls: s.best_cells,
        score: s.best_score.max(0),
        evaluations: s.evals,
    }
}

struct Annealer {
    engine: Engine,
    rng: Rng,
    p: Params,
    budget: usize,
    wallable: Vec<u32>,
    /// Wallable cells in the 8-neighbourhood of each cell.
    near: Vec<Vec<u32>>,
    is_wall: Vec<u8>,
    cells: Vec<u32>,
    cur: i32,
    /// Wallable, wall-free cells on the current path (with repeats).
    path: Vec<u32>,
    path_dirty: bool,
    best_cells: Vec<u32>,
    best_score: i32,
    evals: u64,
    max_evals: u64,
    deadline: Option<Instant>,
    stopped: bool,
}

impl Annealer {
    fn new(map: &Map, seed: u64, time: Option<Duration>, max_evals: Option<u64>, p: Params) -> Annealer {
        let mut engine = Engine::new(map);
        let g = &engine.grid;
        let wallable: Vec<u32> = (0..g.size as u32)
            .filter(|&c| g.wallable[c as usize] != 0)
            .collect();
        let (w, h) = (g.width as i64, g.height as i64);
        let near = (0..g.size)
            .map(|c| {
                let (r, col) = ((c / g.width) as i64, (c % g.width) as i64);
                let mut out = Vec::new();
                for dr in -1..=1 {
                    for dc in -1..=1 {
                        let (rr, cc) = (r + dr, col + dc);
                        if (dr != 0 || dc != 0) && rr >= 0 && cc >= 0 && rr < h && cc < w {
                            let n = (rr * w + cc) as usize;
                            if g.wallable[n] != 0 {
                                out.push(n as u32);
                            }
                        }
                    }
                }
                out
            })
            .collect();
        let size = g.size;
        let budget = map.walls.min(wallable.len());
        let cur = engine.score(&[]);
        Annealer {
            engine,
            rng: Rng::new(seed),
            p,
            budget,
            wallable,
            near,
            is_wall: vec![0; size],
            cells: Vec::new(),
            cur,
            path: Vec::new(),
            path_dirty: true,
            best_cells: Vec::new(),
            best_score: cur,
            evals: 0,
            max_evals: max_evals.unwrap_or(u64::MAX),
            deadline: time.map(|t| Instant::now() + t),
            stopped: budget == 0,
        }
    }

    fn rand(&mut self) -> f64 {
        (self.rng.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn pick(&mut self, n: usize) -> usize {
        self.rng.below(n)
    }

    fn evaluate(&mut self) -> i32 {
        self.evals += 1;
        if self.evals >= self.max_evals
            || (self.evals % 64 == 0 && self.deadline.is_some_and(|d| Instant::now() >= d))
        {
            self.stopped = true;
        }
        self.engine.score(&self.cells)
    }

    fn add(&mut self, c: u32) {
        self.is_wall[c as usize] = 1;
        self.cells.push(c);
    }

    fn remove_at(&mut self, i: usize) -> u32 {
        let c = self.cells.swap_remove(i);
        self.is_wall[c as usize] = 0;
        c
    }

    fn replace_at(&mut self, i: usize, c: u32) -> u32 {
        let old = self.cells[i];
        self.is_wall[old as usize] = 0;
        self.is_wall[c as usize] = 1;
        self.cells[i] = c;
        old
    }

    fn load(&mut self, cells: &[u32]) {
        for &c in &self.cells {
            self.is_wall[c as usize] = 0;
        }
        self.cells.clear();
        for &c in cells {
            self.add(c);
        }
        self.path_dirty = true;
    }

    fn record(&mut self, score: i32) {
        self.cur = score;
        self.path_dirty = true;
        if score > self.best_score {
            self.best_score = score;
            self.best_cells = self.cells.clone();
        }
    }

    fn all_path_cells(&mut self) -> Vec<u32> {
        self.engine
            .path_cells(&self.cells)
            .map(|p| p.concat())
            .unwrap_or_default()
    }

    fn current_path(&mut self) {
        if self.path_dirty {
            let all = self.all_path_cells();
            let g = &self.engine.grid;
            self.path = all
                .into_iter()
                .filter(|&c| g.wallable[c as usize] != 0 && self.is_wall[c as usize] == 0)
                .collect();
            self.path_dirty = false;
        }
    }

    fn candidate(&mut self) -> u32 {
        self.current_path();
        if self.path.is_empty() {
            let i = self.pick(self.wallable.len());
            return self.wallable[i];
        }
        let k = self.pick(self.path.len());
        let p = self.path[k];
        if self.rand() >= self.p.p_near {
            return p;
        }
        let n = self.near[p as usize].len();
        if n == 0 {
            p
        } else {
            let k = self.pick(n);
            self.near[p as usize][k]
        }
    }

    fn run(&mut self) {
        if self.stopped {
            return;
        }
        self.greedy_fill(self.p.greedy_samples);
        let run_len = self.p.run_base + self.p.run_per_wall * self.budget.min(self.p.run_wall_cap);
        let mut run = 0;
        while !self.stopped {
            if run > 0 {
                let fresh = self.rand() < self.p.p_fresh;
                let best = self.best_cells.clone();
                self.load(&best);
                let share = if fresh {
                    1.0
                } else {
                    self.p.drop_min + self.p.drop_range * self.rand()
                };
                let drop = ((self.cells.len() as f64 * share).round() as usize).max(1);
                for _ in 0..drop {
                    if self.cells.is_empty() {
                        break;
                    }
                    let i = self.pick(self.cells.len());
                    self.remove_at(i);
                }
                self.cur = self.evaluate();
                self.path_dirty = true;
                if self.stopped {
                    return;
                }
                self.greedy_fill(if fresh {
                    self.p.greedy_samples
                } else {
                    self.p.restart_samples
                });
            }
            self.anneal(run_len);
            run += 1;
        }
    }

    fn greedy_fill(&mut self, samples: usize) {
        while self.cells.len() < self.budget && !self.stopped {
            self.current_path();
            if self.path.is_empty() {
                return;
            }
            let mut tried: Vec<u32> = Vec::with_capacity(samples);
            let (mut best_c, mut best_s, mut ties) = (u32::MAX, -1i32, 0u32);
            let mut k = 0;
            while k < samples * 3 && tried.len() < samples && !self.stopped {
                k += 1;
                let pk = self.pick(self.path.len());
                let c = self.path[pk];
                if tried.contains(&c) {
                    continue;
                }
                tried.push(c);
                self.add(c);
                let s = self.evaluate();
                self.remove_at(self.cells.len() - 1);
                if s > best_s {
                    best_s = s;
                    best_c = c;
                    ties = 1;
                } else if s == best_s {
                    ties += 1;
                    if self.rand() * (ties as f64) < 1.0 {
                        best_c = c;
                    }
                }
            }
            if best_c == u32::MAX || best_s < 0 {
                return;
            }
            self.add(best_c);
            self.record(best_s);
        }
    }

    fn accept(&mut self, s: i32, temp: f64) -> bool {
        let delta = (s - self.cur) as f64;
        s >= 0 && (delta >= 0.0 || self.rand() < (delta / temp).exp())
    }

    fn anneal(&mut self, length: usize) {
        let p = self.p;
        let t0 = p.temp_base + p.temp_frac * self.best_score.max(0) as f64;
        let t1 = p.temp_end;
        let mut it = 0;
        while it < length && !self.stopped {
            let temp = t0 * (t1 / t0).powf(it as f64 / length as f64);
            let n = self.cells.len();
            if n > 0 && self.rand() < p.p_relocate {
                self.relocate(temp);
                it += 1 + p.relocate_samples;
                continue;
            }
            it += 1;
            let r = self.rand();
            // Each move returns its undo record: (index, old cell) pairs, or "remove last".
            enum Undo {
                RemoveLast,
                Replace(usize, u32),
                Replace2(usize, u32, usize, u32),
            }
            let undo;
            if n < self.budget && (n == 0 || r < p.p_add) {
                let c = self.candidate();
                if self.is_wall[c as usize] != 0 || self.engine.grid.wallable[c as usize] == 0 {
                    continue;
                }
                self.add(c);
                undo = Undo::RemoveLast;
            } else if n == 0 {
                return;
            } else if r < p.p_shift {
                let i = self.pick(n);
                let nb = self.near[self.cells[i] as usize].len();
                if nb == 0 {
                    continue;
                }
                let k = self.pick(nb);
                let c = self.near[self.cells[i] as usize][k];
                if self.is_wall[c as usize] != 0 {
                    continue;
                }
                let old = self.replace_at(i, c);
                undo = Undo::Replace(i, old);
            } else if r < p.p_move || n < 2 {
                let c = self.candidate();
                if self.is_wall[c as usize] != 0 {
                    continue;
                }
                let i = self.pick(n);
                let old = self.replace_at(i, c);
                undo = Undo::Replace(i, old);
            } else {
                let c1 = self.candidate();
                let c2 = self.candidate();
                if self.is_wall[c1 as usize] != 0 || self.is_wall[c2 as usize] != 0 || c1 == c2 {
                    continue;
                }
                let i = self.pick(n);
                let mut j = self.pick(n - 1);
                if j >= i {
                    j += 1;
                }
                let o1 = self.replace_at(i, c1);
                let o2 = self.replace_at(j, c2);
                undo = Undo::Replace2(i, o1, j, o2);
            }
            let s = self.evaluate();
            if self.accept(s, temp) {
                self.record(s);
            } else {
                match undo {
                    Undo::RemoveLast => {
                        self.remove_at(self.cells.len() - 1);
                    }
                    Undo::Replace(i, old) => {
                        self.replace_at(i, old);
                    }
                    Undo::Replace2(i, o1, j, o2) => {
                        self.replace_at(j, o2);
                        self.replace_at(i, o1);
                    }
                }
            }
        }
    }

    /// Removes a random wall, re-traces the path, and puts the wall back on the best of a few
    /// cells of the new path. Accepted like any other move.
    fn relocate(&mut self, temp: f64) {
        let i = self.pick(self.cells.len());
        let old = self.remove_at(i);
        self.evals += 1;
        let path = self.all_path_cells();
        let (mut best_c, mut best_s) = (u32::MAX, -1i32);
        for _ in 0..self.p.relocate_samples {
            if path.is_empty() || self.stopped {
                break;
            }
            let c = path[self.pick(path.len())];
            if c == old || self.is_wall[c as usize] != 0 || self.engine.grid.wallable[c as usize] == 0 {
                continue;
            }
            self.add(c);
            let s = self.evaluate();
            self.remove_at(self.cells.len() - 1);
            if s > best_s {
                best_s = s;
                best_c = c;
            }
        }
        if best_c != u32::MAX && self.accept(best_s, temp) {
            self.add(best_c);
            self.record(best_s);
        } else {
            self.add(old);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::baselines::greedy;
    use crate::map_from_ascii;

    fn map() -> Map {
        map_from_ascii(
            &[
                "S.......#........F",
                "S..#.......A.....F",
                "S......#.....#...F",
                "S...B.........#..F",
                "S.#.......1......F",
                "S.....#......a...F",
            ],
            12,
        )
    }

    #[test]
    fn valid_deterministic_and_beats_greedy() {
        let m = map();
        let a = solve(&m, 3, None, Some(20_000), Params::default());
        let b = solve(&m, 3, None, Some(20_000), Params::default());
        assert_eq!(a.walls, b.walls);
        assert_eq!(a.score, b.score);
        assert!(a.walls.len() <= 12);
        let mut e = Engine::new(&m);
        assert_eq!(e.score(&a.walls), a.score);
        assert!(
            a.score >= greedy(&m).0,
            "SA {} < greedy {}",
            a.score,
            greedy(&m).0
        );
    }

    #[test]
    fn stops_on_time() {
        let t0 = Instant::now();
        let r = solve(
            &map(),
            1,
            Some(Duration::from_millis(200)),
            None,
            Params::default(),
        );
        assert!(t0.elapsed() < Duration::from_millis(400));
        assert!(r.evaluations > 1000);
    }
}
