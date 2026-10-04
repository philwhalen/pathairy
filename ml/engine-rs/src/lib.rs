//! Rust port of the TypeScript pathing engine in `src/engine` (see its comments for the rules
//! and their sources). The TypeScript engine is the reference: `tests/parity.rs` checks this
//! port against the recorded server fixtures, the scoreboard corpus and a differential corpus
//! dumped from the TypeScript engine (`tools/dump-engine-cases.ts`).

pub mod baselines;
pub mod engine;
pub mod env;
pub mod grid;
pub mod mapcode;
#[cfg(feature = "python")]
mod python;
pub mod solver;

pub use engine::{Engine, PathResult, PathsResult, Token};
pub use env::{PatheryEnv, Step};
pub use mapcode::{map_from_ascii, parse_map_code, parse_solution, Map, Tile};
