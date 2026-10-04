//! Reference players (docs/rl-agent-plan.md Phase 2): random, greedy and an exact brute-force
//! search for tiny maps (to check search code against true optima later).

use crate::engine::Engine;
use crate::env::PatheryEnv;
use crate::mapcode::Map;

/// Small seeded PRNG (SplitMix64), so baselines are reproducible without dependencies.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in 0..n (n > 0).
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

/// Plays uniformly random legal walls (never STOP) until the episode ends. Returns the score.
pub fn random_episode(env: &mut PatheryEnv, rng: &mut Rng) -> i32 {
    env.reset();
    let mut mask = vec![false; env.n_actions()];
    let stop = env.stop_action();
    while !env.is_done() {
        env.legal_mask(&mut mask);
        let legal: Vec<usize> = (0..stop).filter(|&a| mask[a]).collect();
        if legal.is_empty() {
            env.step(stop);
            break;
        }
        env.step(legal[rng.below(legal.len())]);
    }
    env.score()
}

/// Greedy: repeatedly places the single wall that raises the score most (first cell on ties),
/// and stops when no wall raises it. Returns (score, walls as map cells).
pub fn greedy(map: &Map) -> (i32, Vec<u32>) {
    let mut engine = Engine::new(map);
    let wallable = engine.grid.wallable.iter().filter(|&&w| w != 0).count();
    let budget = map.walls.min(wallable);
    let has_teleports = map.tiles.iter().any(|t| t.kind == b't');
    let mut walls: Vec<u32> = Vec::new();
    let mut score = engine.score(&walls);
    while walls.len() < budget {
        // Without teleports only cells on a current path can change the score (see env.rs).
        let Some(paths) = engine.path_cells(&walls) else {
            break;
        };
        let pool: Vec<u32> = if has_teleports {
            (0..engine.grid.size as u32).collect()
        } else {
            paths.concat()
        };
        let mut cand: Vec<u32> = pool
            .into_iter()
            .filter(|&c| engine.grid.wallable[c as usize] != 0 && !walls.contains(&c))
            .collect();
        cand.sort_unstable();
        cand.dedup();
        let mut best = (score, u32::MAX);
        for c in cand {
            walls.push(c);
            let s = engine.score(&walls);
            walls.pop();
            if s > best.0 {
                best = (s, c);
            }
        }
        if best.1 == u32::MAX {
            break;
        }
        walls.push(best.1);
        score = best.0;
    }
    (score, walls)
}

/// Exact optimum by enumerating every wall set of size <= budget. Only for tiny maps: panics if
/// that is more than `limit` sets. Returns (score, walls).
pub fn brute_force(map: &Map, limit: u64) -> (i32, Vec<u32>) {
    let mut engine = Engine::new(map);
    let cells: Vec<u32> = (0..engine.grid.size as u32)
        .filter(|&c| engine.grid.wallable[c as usize] != 0)
        .collect();
    let k = map.walls.min(cells.len());
    let mut total: u64 = 0;
    let mut binom: u64 = 1;
    for i in 0..=k {
        if i > 0 {
            binom = binom * (cells.len() - i + 1) as u64 / i as u64;
        }
        total += binom;
    }
    assert!(total <= limit, "{total} wall sets is too many for brute force");
    let mut best = (engine.score(&[]), Vec::new());
    let mut chosen: Vec<u32> = Vec::with_capacity(k);
    fn rec(
        e: &mut Engine,
        cells: &[u32],
        from: usize,
        k: usize,
        chosen: &mut Vec<u32>,
        best: &mut (i32, Vec<u32>),
    ) {
        for i in from..cells.len() {
            chosen.push(cells[i]);
            let s = e.score(chosen);
            if s > best.0 {
                *best = (s, chosen.clone());
            }
            // A blocked set stays blocked when walls are added, so prune it.
            if s >= 0 && chosen.len() < k {
                rec(e, cells, i + 1, k, chosen, best);
            }
            chosen.pop();
        }
    }
    rec(&mut engine, &cells, 0, k, &mut chosen, &mut best);
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map_from_ascii;

    #[test]
    fn greedy_and_brute_force_on_a_tiny_map() {
        // 5x3, start left, finish right, 3 walls.
        let map = map_from_ascii(&["S...F", "S...F", "S...F"], 3);
        let (bf, walls) = brute_force(&map, 1_000_000);
        let mut e = Engine::new(&map);
        assert_eq!(e.score(&walls), bf);
        let (g, gw) = greedy(&map);
        assert_eq!(e.score(&gw), g);
        assert!(g <= bf);
        assert!(bf > e.score(&[]));
    }
}
