//! Engine throughput: `cargo run --release --example bench [-- seconds]`.
//! Scores every scoreboard solution (real maps, real wall sets) in a loop on one thread, then on
//! all threads (std::thread, one engine per thread), and prints evaluations per second.

use pathery_rs::{parse_map_code, parse_solution, Engine};
use std::time::{Duration, Instant};

fn main() {
    let secs: f64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(3.0);
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/scoreboard.json"
    );
    let text = std::fs::read_to_string(path).unwrap();
    // Minimal field extraction so the example needs no JSON dependency.
    let field = |row: &str, key: &str| -> String {
        let k = format!("\"{key}\":\"");
        let i = row.find(&k).unwrap() + k.len();
        row[i..].split('"').next().unwrap().to_string()
    };
    let mut cases = Vec::new();
    for row in text.split("\n").filter(|l| l.contains("\"code\"")) {
        let map = parse_map_code(&field(row, "code")).unwrap();
        let walls: Vec<u32> = parse_solution(&field(row, "solution"))
            .unwrap()
            .into_iter()
            .map(|(r, c)| (r as usize * map.width + c as usize) as u32)
            .collect();
        cases.push((map, walls));
    }
    let by_size = |pred: &dyn Fn(usize) -> bool| -> Vec<(pathery_rs::Map, Vec<u32>)> {
        cases
            .iter()
            .filter(|(m, _)| pred(m.width * m.height))
            .cloned()
            .collect()
    };
    let run = |set: &[(pathery_rs::Map, Vec<u32>)], threads: usize| -> f64 {
        let t0 = Instant::now();
        let total: u64 = std::thread::scope(|s| {
            let hs: Vec<_> = (0..threads)
                .map(|_| {
                    s.spawn(|| {
                        let mut engines: Vec<Engine> = set.iter().map(|(m, _)| Engine::new(m)).collect();
                        let mut n = 0u64;
                        let end = Instant::now() + Duration::from_secs_f64(secs);
                        while Instant::now() < end {
                            for (e, (_, w)) in engines.iter_mut().zip(set) {
                                std::hint::black_box(e.score(w));
                                n += 1;
                            }
                        }
                        n
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).sum()
        });
        total as f64 / t0.elapsed().as_secs_f64()
    };
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    for (label, set) in [
        ("<= 19x9 (daily)", by_size(&|n| n <= 171)),
        ("> 171 cells (specials, Ultra)", by_size(&|n| n > 171)),
    ] {
        let one = run(&set, 1);
        let all = run(&set, threads);
        println!(
            "{label:32} {:>5} cases  1 thread {:>9.0}/s ({:.2} us)  {threads} threads {:>10.0}/s",
            set.len(),
            one,
            1e6 / one,
            all
        );
    }
}
