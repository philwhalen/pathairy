//! Rust SA on the solver tuning set (tests/data/bench-maps.json, from tools/solver-bench/dump.ts):
//! `cargo run --release --example sa_bench -- [seconds=2] [threads=18] [seed=1]`.
//! Prints the mean ratio to the best-known score per group, like tools/tune-solver.ts.

use pathery_rs::parse_map_code;
use pathery_rs::solver::{solve, Params};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let secs: f64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(2.0);
    let threads: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(18);
    let seed: u64 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
    let text =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/bench-maps.json")).unwrap();
    // {"id": ..., "group": ..., "code": ..., "best": N} objects, one field per line.
    let mut rows = Vec::new();
    let (mut id, mut group, mut code) = (String::new(), String::new(), String::new());
    for line in text.lines().map(str::trim) {
        let val = |l: &str| {
            l.splitn(2, ": ")
                .nth(1)
                .unwrap()
                .trim_end_matches(',')
                .trim_matches('"')
                .to_string()
        };
        if line.starts_with("\"id\"") {
            id = val(line);
        } else if line.starts_with("\"group\"") {
            group = val(line);
        } else if line.starts_with("\"code\"") {
            code = val(line);
        } else if line.starts_with("\"best\"") {
            rows.push((
                id.clone(),
                group.clone(),
                code.clone(),
                val(line).parse::<i32>().unwrap(),
            ));
        }
    }
    let next = AtomicUsize::new(0);
    let results: Vec<(String, f64, u64)> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..threads)
            .map(|_| {
                s.spawn(|| {
                    let mut out = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some((_, group, code, best)) = rows.get(i) else {
                            break;
                        };
                        let map = parse_map_code(code).unwrap();
                        let r = solve(
                            &map,
                            seed,
                            Some(Duration::from_secs_f64(secs)),
                            None,
                            Params::default(),
                        );
                        out.push((group.clone(), r.score as f64 / *best as f64, r.evaluations));
                    }
                    out
                })
            })
            .collect();
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    let mut groups: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut evals = 0;
    for (g, r, e) in &results {
        groups.entry(g.clone()).or_default().push(*r);
        evals += e;
    }
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let all: Vec<f64> = results.iter().map(|r| r.1).collect();
    print!(
        "rust SA {secs} s seed {seed}: overall {:.4} (at best {}/{})",
        mean(&all),
        all.iter().filter(|&&x| x >= 1.0).count(),
        all.len()
    );
    for (g, v) in &groups {
        print!("  {g} {:.4}", mean(v));
    }
    println!(
        "  [{:.0}k evals/map]",
        evals as f64 / results.len() as f64 / 1000.0
    );
}
