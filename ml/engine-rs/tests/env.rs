//! Environment invariants on real maps (scoreboard) and random synthetic maps (diff corpus).

use pathery_rs::baselines::{random_episode, Rng};
use pathery_rs::env::plane;
use pathery_rs::{map_from_ascii, parse_map_code, Engine, Map, PatheryEnv};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Distinct map codes: scoreboard maps plus synthetic/generated maps from the diff corpus.
fn maps(limit: usize) -> Vec<Map> {
    let rows: Value =
        serde_json::from_str(&fs::read_to_string(repo().join("tests/fixtures/scoreboard.json")).unwrap())
            .unwrap();
    let mut codes: Vec<String> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["code"].as_str().unwrap().to_string())
        .collect();
    let diff = fs::read_to_string(repo().join("ml/engine-rs/tests/data/diff-cases.jsonl")).unwrap();
    for l in diff.lines().filter(|l| !l.is_empty()) {
        let c: Value = serde_json::from_str(l).unwrap();
        codes.push(c["code"].as_str().unwrap().to_string());
    }
    codes.sort();
    codes.dedup();
    codes
        .iter()
        .map(|c| parse_map_code(c).unwrap())
        .filter(|m| Engine::new(m).score(&[]) >= 0 && m.width <= 27 && m.height <= 19)
        .take(limit)
        .collect()
}

#[test]
fn mask_is_exact_and_rewards_telescope() {
    let mut rng = Rng::new(7);
    let mut episodes = 0;
    for map in maps(400) {
        let mut env = PatheryEnv::new(map.clone(), 19, 27, None).unwrap();
        let mut engine = Engine::new(&map);
        let mut mask = vec![false; env.n_actions()];
        let scale = env.no_wall_score().max(1) as f32;
        let mut total_reward = 0.0f64;
        let mut steps = 0;
        while !env.is_done() && steps < 40 {
            env.legal_mask(&mut mask);
            assert!(mask[env.stop_action()], "STOP must be legal");
            let walls = env.walls().to_vec();
            // Every on-board action: legal <=> wallable, free, under budget, and not blocking.
            let mut legal = Vec::new();
            for a in 0..env.stop_action() {
                let Some(cell) = env.action_cell(a) else {
                    assert!(!mask[a], "off-board action {a} is legal");
                    continue;
                };
                let t = map.tiles[cell as usize];
                let free = t.kind == b'o' && !walls.contains(&cell);
                let mut w = walls.clone();
                w.push(cell);
                let expect = free && walls.len() < env.budget() && engine.score(&w) >= 0;
                if mask[a] != expect {
                    let mut rows = String::new();
                    for r in 0..map.height {
                        for c in 0..map.width {
                            let t = map.tile(r, c);
                            let i = (r * map.width + c) as u32;
                            rows.push(if i == cell {
                                '*'
                            } else if walls.contains(&i) {
                                '@'
                            } else {
                                t.kind as char
                            });
                            if t.kind != b'o' && t.kind != b'r' {
                                rows.push_str(&t.value.to_string())
                            } else {
                                rows.push(' ')
                            }
                        }
                        rows.push(10 as char);
                    }
                    let paths = (engine.compute(&walls), engine.compute(&w));
                    panic!(
                        "action {a} (cell {cell}) mask {} expected {expect}{}{rows}paths {paths:?}",
                        mask[a], 10 as char
                    );
                }
                if expect {
                    legal.push(a);
                }
            }
            if legal.is_empty() {
                break;
            }
            let before = env.score();
            let a = legal[rng.below(legal.len())];
            let st = env.step(a);
            let mut w = walls.clone();
            w.push(env.action_cell(a).unwrap());
            assert_eq!(st.score, engine.score(&w));
            assert!((st.reward - (st.score - before) as f32 / scale).abs() < 1e-6);
            total_reward += st.reward as f64;
            steps += 1;
        }
        let expected = (env.score() - env.no_wall_score()) as f64 / scale as f64;
        assert!(
            (total_reward - expected).abs() < 1e-3,
            "rewards must sum to the score gain"
        );
        episodes += 1;
    }
    assert!(episodes >= 300);
}

#[test]
fn episodes_end_at_budget_or_stop() {
    let map = map_from_ascii(
        &[
            "#...........#",
            "S.....#.....#",
            "#...A.......#",
            "#...........F",
            "#..#........#",
            "#...........#",
        ],
        3,
    );
    let mut env = PatheryEnv::new(map, 6, 13, None).unwrap();
    let mut rng = Rng::new(1);
    random_episode(&mut env, &mut rng);
    assert!(env.is_done());
    assert!(env.walls().len() <= 3);
    env.reset();
    assert_eq!(env.walls().len(), 0);
    let st = env.step(env.stop_action());
    assert!(st.done && st.reward == 0.0);
}

#[test]
fn observation_planes() {
    let map = map_from_ascii(&["S1.A.", "S#~.F", "T.x_a"], 2);
    let env = PatheryEnv::new(map.clone(), 4, 6, None).unwrap();
    let (fh, fw) = (4, 6);
    let mut obs = vec![0u8; plane::COUNT * fh * fw];
    env.observe(&mut obs);
    let at = |p: usize, r: usize, c: usize| obs[p * fh * fw + r * fw + c];
    assert_eq!(at(plane::OFF_BOARD, 3, 0), 1);
    assert_eq!(at(plane::OFF_BOARD, 0, 5), 1);
    assert_eq!(at(plane::OFF_BOARD, 0, 0), 0);
    assert_eq!(at(plane::START_1, 0, 0), 1);
    for r in 0..map.height {
        for c in 0..map.width {
            let t = map.tile(r, c);
            assert_eq!(at(plane::WALLABLE, r, c), (t.kind == b'o') as u8);
            assert_eq!(at(plane::FINISH, r, c), (t.kind == b'f') as u8);
            assert_eq!(
                at(plane::TELE_IN, r, c),
                if t.kind == b't' { t.value as u8 } else { 0 }
            );
            assert_eq!(at(plane::ICE, r, c), (t.kind == b'z' && t.value == 5) as u8);
        }
    }
    assert_eq!(
        at(plane::PATH_1, 0, 0) + at(plane::PATH_1, 1, 0),
        1,
        "path starts at one s1"
    );
    assert_eq!(at(plane::WALLS_LEFT, 3, 5), 255);
    assert_eq!(at(plane::UNLIMITED, 2, 2), 0);
}

/// The argument in `Engine::support_cells`: a wall outside the support set changes nothing at
/// all (same tokens), on maps with teleports and random wall sets.
#[test]
fn walls_outside_support_change_nothing() {
    let mut rng = Rng::new(11);
    let mut checked = 0u64;
    for map in maps(2000)
        .into_iter()
        .filter(|m| m.tiles.iter().any(|t| t.kind == b't'))
    {
        let mut e = Engine::new(&map);
        let free: Vec<u32> = (0..map.tiles.len() as u32)
            .filter(|&c| map.tiles[c as usize].kind == b'o')
            .collect();
        for _ in 0..5 {
            let walls: Vec<u32> = free.iter().copied().filter(|_| rng.below(100) < 15).collect();
            let Some(support) = e.support_cells(&walls) else {
                continue;
            };
            let base = e.compute(&walls);
            for &c in &free {
                if walls.contains(&c) || support.contains(&c) {
                    continue;
                }
                let mut w = walls.clone();
                w.push(c);
                assert_eq!(
                    e.compute(&w),
                    base,
                    "wall at {c} outside support changed the result"
                );
                checked += 1;
            }
        }
    }
    assert!(checked > 50_000, "only {checked} checks");
}
