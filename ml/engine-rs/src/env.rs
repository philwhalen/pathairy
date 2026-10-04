//! The RL environment for one map (docs/rl-agent-plan.md §2, §6.1). Read closely: the legal
//! mask and the reward decide what the agent learns.
//!
//! - **Episode:** start with no walls; each step places one wall or picks STOP. It ends on STOP,
//!   when the budget is spent, or when no wall can be placed (every free cell would block).
//! - **Actions:** the map sits in the top-left corner of a fixed `frame_h x frame_w` frame (so
//!   one network serves all map sizes). Action `r * frame_w + c` walls cell (r, c); the last
//!   action, `frame_h * frame_w`, is STOP.
//! - **Legal mask:** STOP is always legal. A cell is legal if it is on the map, wallable (`o`),
//!   free, a wall is left, and walling it does not block a path. On maps without teleports only
//!   cells on a current path can block: a wall off every path leaves every path (and the score)
//!   unchanged, because distances only grow and the cells of the chosen route keep theirs. So only
//!   path cells cost an engine call. **With teleports that shortcut is wrong:** the warp exit is
//!   chosen by walking distance from each exit, and that walking route may run through cells the
//!   path never visits (it warps again first). Walling one can change the exit or leave no exit
//!   able to reach the target (found by `tests/env.rs`). So the cells checked are
//!   `Engine::support_cells`: the visited cells plus, at each warp, the walking route from the
//!   teleport entrance (its doc comment has the argument). `tests/env.rs` checks the mask against
//!   the engine for every action on ~400 maps.
//! - **Reward:** `(score_t - score_{t-1}) / scale`. The rewards sum to
//!   `(final - no-walls score) / scale`, so with gamma = 1 maximizing the return maximizes the
//!   game score. `scale` is per map (default: the no-walls score; the plan uses the greedy
//!   baseline's score, see `baselines::greedy`).

use crate::engine::Engine;
use crate::grid::{blocks_path, is_ice};
use crate::mapcode::Map;

/// Observation planes (each `frame_h x frame_w`, uint8). 0/1 unless noted.
pub mod plane {
    pub const OFF_BOARD: usize = 0;
    pub const WALLABLE: usize = 1;
    pub const WALL: usize = 2;
    /// Rock, x1, z1 (path 1) / rock, x2, z1 (path 2).
    pub const BLOCKED_1: usize = 3;
    pub const BLOCKED_2: usize = 4;
    pub const START_1: usize = 5;
    pub const START_2: usize = 6;
    pub const FINISH: usize = 7;
    /// One-hot checkpoint number: c1, c2, c3, c4, c5 and up.
    pub const CHECKPOINT: usize = 8;
    /// Checkpoint number as a value (0 = none).
    pub const CHECKPOINT_N: usize = 13;
    /// Teleport pair number as a value (0 = none), for `tN` and `uN` tiles.
    pub const TELE_IN: usize = 14;
    pub const TELE_OUT: usize = 15;
    pub const ICE: usize = 16;
    pub const UNBUILDABLE: usize = 17;
    /// Cells on the current path 1 / path 2 (with no walls left to place, still shown).
    pub const PATH_1: usize = 18;
    pub const PATH_2: usize = 19;
    /// Path 1 progress: when a cell is first visited, scaled to 1..255 along the path.
    pub const PATH_1_ORDER: usize = 20;
    /// Broadcast: walls left / budget * 255 (with an unlimited budget: min(walls left, 255)).
    pub const WALLS_LEFT: usize = 21;
    /// Broadcast: 1 if the budget is at least the number of wallable cells.
    pub const UNLIMITED: usize = 22;
    pub const COUNT: usize = 23;
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Step {
    pub reward: f32,
    pub done: bool,
    /// Score after the step (total moves).
    pub score: i32,
}

pub struct PatheryEnv {
    engine: Engine,
    map: Map,
    frame_h: usize,
    frame_w: usize,
    budget: usize,
    unlimited: bool,
    scale: f32,
    no_wall_score: i32,
    // State.
    walls: Vec<u32>,
    is_wall: Vec<u8>,
    score: i32,
    done: bool,
    // Derived from the state, refreshed after every change.
    path: [Vec<u32>; 2],
    /// Legal flags for map cells (index = map cell).
    legal: Vec<u8>,
    legal_count: usize,
}

impl PatheryEnv {
    /// Errors if the map doesn't fit the frame or is blocked with no walls.
    pub fn new(map: Map, frame_h: usize, frame_w: usize, scale: Option<f32>) -> Result<Self, String> {
        if map.height > frame_h || map.width > frame_w {
            return Err(format!(
                "map {}x{} exceeds frame {frame_w}x{frame_h}",
                map.width, map.height
            ));
        }
        let mut engine = Engine::new(&map);
        let no_wall_score = engine.score(&[]);
        if no_wall_score < 0 {
            return Err("map is blocked with no walls".into());
        }
        let wallable = engine.grid.wallable.iter().filter(|&&w| w != 0).count();
        let budget = map.walls.min(wallable);
        let scale = scale.unwrap_or(no_wall_score.max(1) as f32);
        let size = map.width * map.height;
        let mut env = PatheryEnv {
            engine,
            frame_h,
            frame_w,
            budget,
            unlimited: map.walls >= wallable,
            scale,
            no_wall_score,
            walls: Vec::new(),
            is_wall: vec![0; size],
            score: no_wall_score,
            done: false,
            path: [Vec::new(), Vec::new()],
            legal: vec![0; size],
            legal_count: 0,
            map,
        };
        env.reset();
        Ok(env)
    }

    pub fn n_actions(&self) -> usize {
        self.frame_h * self.frame_w + 1
    }

    pub fn stop_action(&self) -> usize {
        self.frame_h * self.frame_w
    }

    pub fn score(&self) -> i32 {
        self.score
    }

    pub fn no_wall_score(&self) -> i32 {
        self.no_wall_score
    }

    pub fn budget(&self) -> usize {
        self.budget
    }

    pub fn is_done(&self) -> bool {
        self.done
    }

    pub fn map(&self) -> &Map {
        &self.map
    }

    /// Placed walls as map cells, in order.
    pub fn walls(&self) -> &[u32] {
        &self.walls
    }

    pub fn reset(&mut self) {
        for &w in &self.walls {
            self.is_wall[w as usize] = 0;
        }
        self.walls.clear();
        self.score = self.no_wall_score;
        self.done = false;
        self.refresh();
    }

    /// Map cell of an action, or None for STOP / off-board.
    pub fn action_cell(&self, action: usize) -> Option<u32> {
        let (r, c) = (action / self.frame_w, action % self.frame_w);
        (action < self.stop_action() && r < self.map.height && c < self.map.width)
            .then(|| (r * self.map.width + c) as u32)
    }

    pub fn cell_action(&self, cell: u32) -> usize {
        let (r, c) = (cell as usize / self.map.width, cell as usize % self.map.width);
        r * self.frame_w + c
    }

    /// Writes the legal-action mask (`n_actions` entries). All false once done.
    pub fn legal_mask(&self, out: &mut [bool]) {
        out.fill(false);
        if self.done {
            return;
        }
        for (cell, &l) in self.legal.iter().enumerate() {
            if l != 0 {
                out[self.cell_action(cell as u32)] = true;
            }
        }
        out[self.stop_action()] = true;
    }

    /// Applies an action. Panics on an illegal action or after the episode ended (the caller
    /// must respect the mask).
    pub fn step(&mut self, action: usize) -> Step {
        assert!(!self.done, "step after done");
        if action == self.stop_action() {
            self.done = true;
            return Step {
                reward: 0.0,
                done: true,
                score: self.score,
            };
        }
        let cell = self.action_cell(action).expect("off-board action");
        assert!(self.legal[cell as usize] != 0, "illegal action {action}");
        self.walls.push(cell);
        self.is_wall[cell as usize] = 1;
        let new_score = self.engine.score(&self.walls);
        debug_assert!(new_score >= 0, "legal wall blocked the path");
        let reward = (new_score - self.score) as f32 / self.scale;
        self.score = new_score;
        self.refresh();
        self.done = self.walls.len() >= self.budget || self.legal_count == 0;
        Step {
            reward,
            done: self.done,
            score: self.score,
        }
    }

    /// Recomputes the paths and the legal cells for the current walls.
    fn refresh(&mut self) {
        let mut paths = self
            .engine
            .path_cells(&self.walls)
            .expect("current walls block a path");
        paths.resize(2, Vec::new());
        self.path = [std::mem::take(&mut paths[0]), std::mem::take(&mut paths[1])];
        let size = self.engine.grid.size;
        self.legal.fill(0);
        self.legal_count = 0;
        if self.walls.len() >= self.budget {
            return;
        }
        let mut on_path = vec![0u8; size];
        for c in self
            .engine
            .support_cells(&self.walls)
            .expect("current walls block a path")
        {
            on_path[c as usize] = 1;
        }
        for cell in 0..size {
            if self.engine.grid.wallable[cell] == 0 || self.is_wall[cell] != 0 {
                continue;
            }
            let ok = on_path[cell] == 0 || {
                self.walls.push(cell as u32);
                let s = self.engine.score(&self.walls);
                self.walls.pop();
                s >= 0
            };
            if ok {
                self.legal[cell] = 1;
                self.legal_count += 1;
            }
        }
    }

    /// Writes the observation (`plane::COUNT * frame_h * frame_w` bytes, plane-major).
    pub fn observe(&self, out: &mut [u8]) {
        let (fh, fw) = (self.frame_h, self.frame_w);
        let hw = fh * fw;
        assert_eq!(out.len(), plane::COUNT * hw);
        out.fill(0);
        let at = |p: usize, r: usize, c: usize| p * hw + r * fw + c;
        let mut set = |p: usize, r: usize, c: usize, v: u8| out[at(p, r, c)] = v;
        let m = &self.map;
        for r in 0..fh {
            for c in 0..fw {
                if r >= m.height || c >= m.width {
                    set(plane::OFF_BOARD, r, c, 1);
                    continue;
                }
                let cell = r * m.width + c;
                let t = m.tiles[cell];
                if t.kind == b'o' {
                    set(plane::WALLABLE, r, c, 1);
                }
                if self.is_wall[cell] != 0 {
                    set(plane::WALL, r, c, 1);
                }
                if blocks_path(t, 1) {
                    set(plane::BLOCKED_1, r, c, 1);
                }
                if blocks_path(t, 2) {
                    set(plane::BLOCKED_2, r, c, 1);
                }
                let v = t.value.min(255) as u8;
                match t.kind {
                    b's' if t.value == 1 => set(plane::START_1, r, c, 1),
                    b's' if t.value == 2 => set(plane::START_2, r, c, 1),
                    b'f' => set(plane::FINISH, r, c, 1),
                    b'c' => {
                        set(plane::CHECKPOINT + (t.value.clamp(1, 5) as usize - 1), r, c, 1);
                        set(plane::CHECKPOINT_N, r, c, v);
                    }
                    b't' => set(plane::TELE_IN, r, c, v),
                    b'u' => set(plane::TELE_OUT, r, c, v),
                    b'p' => set(plane::UNBUILDABLE, r, c, 1),
                    _ => {}
                }
                if is_ice(t) {
                    set(plane::ICE, r, c, 1);
                }
            }
        }
        for (pi, p) in self.path.iter().enumerate() {
            let len = p.len().max(1);
            for (i, &cell) in p.iter().enumerate() {
                let (r, c) = (cell as usize / m.width, cell as usize % m.width);
                out[at(if pi == 0 { plane::PATH_1 } else { plane::PATH_2 }, r, c)] = 1;
                if pi == 0 && out[at(plane::PATH_1_ORDER, r, c)] == 0 {
                    out[at(plane::PATH_1_ORDER, r, c)] = (1 + i * 254 / len) as u8;
                }
            }
        }
        let left = self.budget - self.walls.len();
        let walls_left = if self.unlimited {
            left.min(255) as u8
        } else {
            (left * 255 / self.budget.max(1)) as u8
        };
        out[plane::WALLS_LEFT * hw..(plane::WALLS_LEFT + 1) * hw].fill(walls_left);
        out[plane::UNLIMITED * hw..(plane::UNLIMITED + 1) * hw].fill(self.unlimited as u8);
    }
}
