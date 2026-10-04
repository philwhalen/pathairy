//! Parity of the Rust engine with the server (recorded fixtures), the scoreboard corpus and the
//! TypeScript engine (differential corpus from tools/dump-engine-cases.ts).

use pathery_rs::{parse_map_code, parse_solution, Engine, Map, PathsResult, Token};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Wall cells for a solution, the way the TS engine reads them (off-grid walls are dropped
/// here; non-wallable ones are dropped by the engine).
fn wall_cells(map: &Map, solution: &str) -> Vec<u32> {
    parse_solution(solution)
        .unwrap()
        .into_iter()
        .filter(|&(r, c)| r >= 0 && c >= 0 && (r as usize) < map.height && (c as usize) < map.width)
        .map(|(r, c)| (r as usize * map.width + c as usize) as u32)
        .collect()
}

fn token_json(t: &Token) -> Value {
    match t {
        Token::Dir(d) => Value::from(*d),
        Token::Str(s) => Value::from(s.as_str()),
    }
}

/// Same comparable shape as tests/engine.test.ts (a blocked path's `end` is junk on the server).
fn shape(r: &PathsResult) -> Value {
    Value::Array(
        r.paths
            .iter()
            .map(|p| {
                serde_json::json!({
                    "tokens": p.tokens.iter().map(token_json).collect::<Vec<_>>(),
                    "moves": p.moves,
                    "blocked": p.blocked,
                    "start": p.start,
                    "end": if p.blocked { Value::Null } else { Value::from(p.end.as_str()) },
                })
            })
            .collect(),
    )
}

#[test]
fn server_fixtures_match_exactly() {
    let dir = repo().join("tests/fixtures/oracle");
    let mut n = 0;
    let mut files: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
    files.sort();
    for f in files {
        if f.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let o: Value = serde_json::from_str(&fs::read_to_string(&f).unwrap()).unwrap();
        if o.get("error").and_then(Value::as_bool) == Some(true) || !o["response"]["path"].is_array() {
            continue;
        }
        let map = parse_map_code(o["code"].as_str().unwrap()).unwrap();
        let walls = wall_cells(&map, o["solution"].as_str().unwrap());
        let r = Engine::new(&map).compute(&walls);
        let s = &o["response"];
        let expected = Value::Array(
            s["path"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| {
                    let blocked = p.get("blocked").and_then(Value::as_bool).unwrap_or(false);
                    serde_json::json!({
                        "tokens": p["pathArray"],
                        "moves": p["moves"],
                        "blocked": blocked,
                        "start": p["start"],
                        "end": if blocked { Value::Null } else { p["end"].clone() },
                    })
                })
                .collect(),
        );
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(shape(&r), expected, "{name}");
        assert_eq!(r.total_moves as i64, s["totalMoves"].as_i64().unwrap(), "{name}");
        assert_eq!(
            r.blocked,
            s.get("blocked").and_then(Value::as_bool).unwrap_or(false),
            "{name}"
        );
        n += 1;
    }
    assert!(n >= 50, "only {n} fixtures");
}

#[test]
fn scoreboard_moves_match() {
    let rows: Value =
        serde_json::from_str(&fs::read_to_string(repo().join("tests/fixtures/scoreboard.json")).unwrap())
            .unwrap();
    let rows = rows.as_array().unwrap();
    assert!(rows.len() >= 600);
    for r in rows {
        let map = parse_map_code(r["code"].as_str().unwrap()).unwrap();
        let walls = wall_cells(&map, r["solution"].as_str().unwrap());
        let mut e = Engine::new(&map);
        let expected = r["moves"].as_i64().unwrap();
        assert_eq!(
            e.compute(&walls).total_moves as i64,
            expected,
            "map {}",
            r["mapId"]
        );
        assert_eq!(e.score(&walls) as i64, expected, "map {} (score)", r["mapId"]);
    }
}

#[test]
fn matches_typescript_engine_on_random_cases() {
    let path = repo().join("ml/engine-rs/tests/data/diff-cases.jsonl");
    let text =
        fs::read_to_string(&path).expect("missing diff corpus: run `npx tsx tools/dump-engine-cases.ts`");
    let mut n = 0;
    for line in text.lines().filter(|l| !l.is_empty()) {
        let c: Value = serde_json::from_str(line).unwrap();
        let map = parse_map_code(c["code"].as_str().unwrap()).unwrap();
        let walls = wall_cells(&map, c["solution"].as_str().unwrap());
        let mut e = Engine::new(&map);
        let r = e.compute(&walls);
        assert_eq!(shape(&r), c["paths"], "case {n}: {}", c["code"]);
        assert_eq!(
            r.total_moves as i64,
            c["totalMoves"].as_i64().unwrap(),
            "case {n}"
        );
        let expect_score = if r.blocked { -1 } else { r.total_moves as i32 };
        assert_eq!(e.score(&walls), expect_score, "case {n} (score)");
        n += 1;
    }
    assert!(n >= 1000, "only {n} cases");
}
