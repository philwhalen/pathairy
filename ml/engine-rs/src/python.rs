//! Python bindings (feature `python`, built with maturin; see ml/engine-rs/README.md).
//!
//! `VecEnv` steps a batch of environments in one call (in parallel with rayon) and hands back
//! numpy arrays, so the Python side (an SB3 `VecEnv` subclass) does no per-board work.
//! Episodes auto-reset like SB3 expects: when an env finishes, the returned observation is the
//! first observation of its next episode, and the finished episode's final score is reported.

use crate::baselines::{brute_force, greedy, random_episode, Rng};
use crate::env::{plane, PatheryEnv};
use crate::solver::{solve, Params};
use crate::{parse_map_code, parse_solution, Engine, Map};
use numpy::ndarray::{Array2, Array4};
use numpy::{IntoPyArray, PyArray1, PyArray2, PyArray4, PyReadonlyArray1};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use rayon::prelude::*;

fn parse(code: &str) -> PyResult<Map> {
    parse_map_code(code).map_err(PyValueError::new_err)
}

fn walls_of(map: &Map, solution: &str) -> PyResult<Vec<u32>> {
    Ok(parse_solution(solution)
        .map_err(PyValueError::new_err)?
        .into_iter()
        .filter(|&(r, c)| r >= 0 && c >= 0 && (r as usize) < map.height && (c as usize) < map.width)
        .map(|(r, c)| (r as usize * map.width + c as usize) as u32)
        .collect())
}

fn solution_of(map: &Map, walls: &[u32]) -> String {
    let parts: Vec<String> = walls
        .iter()
        .map(|&c| format!("{},{}", c as usize / map.width, c as usize % map.width))
        .collect();
    format!(".{}.:", parts.join("."))
}

/// Total moves for a map code and solution string (-1 if blocked).
#[pyfunction]
fn score(code: &str, solution: &str) -> PyResult<i32> {
    let map = parse(code)?;
    let walls = walls_of(&map, solution)?;
    Ok(Engine::new(&map).score(&walls))
}

/// Greedy baseline: (score, solution string).
#[pyfunction]
#[pyo3(name = "greedy")]
fn greedy_py(py: Python<'_>, code: &str) -> PyResult<(i32, String)> {
    let map = parse(code)?;
    let (s, w) = py.detach(|| greedy(&map));
    Ok((s, solution_of(&map, &w)))
}

/// Exact optimum for tiny maps: (score, solution string). Errors past `limit` wall sets.
#[pyfunction]
#[pyo3(name = "brute_force", signature = (code, limit = 5_000_000))]
fn brute_force_py(code: &str, limit: u64) -> PyResult<(i32, String)> {
    let map = parse(code)?;
    let r = std::panic::catch_unwind(|| brute_force(&map, limit))
        .map_err(|_| PyValueError::new_err("too many wall sets for brute force"))?;
    Ok((r.0, solution_of(&map, &r.1)))
}

/// Simulated annealing (port of src/solver/solve.ts): (score, solution string, evaluations).
/// Stops after `seconds`, or after `max_evals` evaluations if given (deterministic then).
#[pyfunction]
#[pyo3(name = "solve_sa", signature = (code, seconds = 2.0, seed = 1, max_evals = None))]
fn solve_sa_py(
    py: Python<'_>,
    code: &str,
    seconds: f64,
    seed: u64,
    max_evals: Option<u64>,
) -> PyResult<(i32, String, u64)> {
    let map = parse(code)?;
    let time = if max_evals.is_some() {
        None
    } else {
        Some(std::time::Duration::from_secs_f64(seconds))
    };
    let r = py.detach(|| solve(&map, seed, time, max_evals, Params::default()));
    Ok((r.score, solution_of(&map, &r.walls), r.evaluations))
}

/// Mean score of `episodes` uniformly random legal-wall episodes (the random baseline).
#[pyfunction]
#[pyo3(name = "random_play", signature = (code, episodes = 20, seed = 1))]
fn random_play_py(py: Python<'_>, code: &str, episodes: usize, seed: u64) -> PyResult<f64> {
    let map = parse(code)?;
    let (h, w) = (map.height, map.width);
    let mut env = PatheryEnv::new(map, h, w, None).map_err(PyValueError::new_err)?;
    let total: i64 = py.detach(|| {
        let mut rng = Rng::new(seed);
        (0..episodes)
            .map(|_| random_episode(&mut env, &mut rng) as i64)
            .sum()
    });
    Ok(total as f64 / episodes.max(1) as f64)
}

#[pyclass(module = "pathery_rs")]
struct VecEnv {
    pool: Vec<Map>,
    scales: Vec<Option<f32>>,
    envs: Vec<PatheryEnv>,
    /// Pool index of each env's current map.
    map_idx: Vec<usize>,
    rng: Rng,
    frame_h: usize,
    frame_w: usize,
    /// Env i always plays map i % pool size (for evaluation) instead of a random map.
    fixed: bool,
}

impl VecEnv {
    fn new_episode(&mut self, i: usize) -> PyResult<()> {
        let k = if self.fixed { i % self.pool.len() } else { self.rng.below(self.pool.len()) };
        self.map_idx[i] = k;
        self.envs[i] = PatheryEnv::new(self.pool[k].clone(), self.frame_h, self.frame_w, self.scales[k])
            .map_err(PyValueError::new_err)?;
        Ok(())
    }

    fn obs_array<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray4<u8>> {
        let hw = self.frame_h * self.frame_w;
        let per = plane::COUNT * hw;
        let mut data = vec![0u8; self.envs.len() * per];
        data.par_chunks_mut(per)
            .zip(self.envs.par_iter())
            .for_each(|(out, e)| e.observe(out));
        Array4::from_shape_vec((self.envs.len(), plane::COUNT, self.frame_h, self.frame_w), data)
            .unwrap()
            .into_pyarray(py)
    }
}

#[pymethods]
impl VecEnv {
    /// `codes`: the map pool (each episode draws one uniformly, or with `fixed` env i always
    /// plays map i % len). `scales`: optional per-map reward scale (default: each map's no-walls
    /// score).
    #[new]
    #[pyo3(signature = (codes, n_envs, frame_h = 19, frame_w = 27, seed = 0, scales = None, fixed = false))]
    fn new(
        codes: Vec<String>,
        n_envs: usize,
        frame_h: usize,
        frame_w: usize,
        seed: u64,
        scales: Option<Vec<f32>>,
        fixed: bool,
    ) -> PyResult<Self> {
        if codes.is_empty() || n_envs == 0 {
            return Err(PyValueError::new_err("need at least one map and one env"));
        }
        let pool = codes.iter().map(|c| parse(c)).collect::<PyResult<Vec<_>>>()?;
        let scales = match scales {
            Some(s) if s.len() == pool.len() => s.into_iter().map(Some).collect(),
            Some(_) => return Err(PyValueError::new_err("scales must match codes")),
            None => vec![None; pool.len()],
        };
        let mut envs = Vec::with_capacity(n_envs);
        for _ in 0..n_envs {
            envs.push(
                PatheryEnv::new(pool[0].clone(), frame_h, frame_w, scales[0])
                    .map_err(PyValueError::new_err)?,
            );
        }
        let mut v = VecEnv {
            pool,
            scales,
            envs,
            map_idx: vec![0; n_envs],
            rng: Rng::new(seed),
            frame_h,
            frame_w,
            fixed,
        };
        for i in 0..n_envs {
            v.new_episode(i)?;
        }
        Ok(v)
    }

    #[getter]
    fn num_envs(&self) -> usize {
        self.envs.len()
    }

    #[getter]
    fn n_actions(&self) -> usize {
        self.frame_h * self.frame_w + 1
    }

    #[getter]
    fn obs_shape(&self) -> (usize, usize, usize) {
        (plane::COUNT, self.frame_h, self.frame_w)
    }

    /// Starts a new episode in every env; returns observations [N, C, H, W] uint8.
    fn reset<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyArray4<u8>>> {
        for i in 0..self.envs.len() {
            self.new_episode(i)?;
        }
        Ok(self.obs_array(py))
    }

    /// Legal actions [N, A] bool.
    fn action_masks<'py>(&self, py: Python<'py>) -> Bound<'py, PyArray2<bool>> {
        let a = self.n_actions();
        let mut data = vec![false; self.envs.len() * a];
        data.par_chunks_mut(a)
            .zip(self.envs.par_iter())
            .for_each(|(out, e)| e.legal_mask(out));
        Array2::from_shape_vec((self.envs.len(), a), data)
            .unwrap()
            .into_pyarray(py)
    }

    /// One action per env. Returns (obs, rewards f32, dones bool, final_scores i32, map_idx):
    /// `final_scores[i]` is the finished episode's score where `dones[i]`, else -1, and
    /// `map_idx[i]` the pool index of that finished episode's map (else of the current one).
    #[allow(clippy::type_complexity)]
    fn step<'py>(
        &mut self,
        py: Python<'py>,
        actions: PyReadonlyArray1<'py, i64>,
    ) -> PyResult<(
        Bound<'py, PyArray4<u8>>,
        Bound<'py, PyArray1<f32>>,
        Bound<'py, PyArray1<bool>>,
        Bound<'py, PyArray1<i32>>,
        Bound<'py, PyArray1<i64>>,
    )> {
        let actions = actions.as_slice()?;
        if actions.len() != self.envs.len() {
            return Err(PyValueError::new_err("one action per env"));
        }
        let n_actions = self.n_actions();
        if actions.iter().any(|&a| a < 0 || a as usize >= n_actions) {
            return Err(PyValueError::new_err("action out of range"));
        }
        // Validate against the masks first, so a bad action raises instead of panicking.
        let mut mask = vec![false; n_actions];
        for (i, e) in self.envs.iter().enumerate() {
            e.legal_mask(&mut mask);
            if !mask[actions[i] as usize] {
                return Err(PyValueError::new_err(format!(
                    "illegal action {} in env {i}",
                    actions[i]
                )));
            }
        }
        let steps: Vec<_> = self
            .envs
            .par_iter_mut()
            .zip(actions.par_iter())
            .map(|(e, &a)| e.step(a as usize))
            .collect();
        let rewards: Vec<f32> = steps.iter().map(|s| s.reward).collect();
        let dones: Vec<bool> = steps.iter().map(|s| s.done).collect();
        let finals: Vec<i32> = steps.iter().map(|s| if s.done { s.score } else { -1 }).collect();
        let idx: Vec<i64> = self.map_idx.iter().map(|&k| k as i64).collect();
        for i in 0..self.envs.len() {
            if dones[i] {
                self.new_episode(i)?;
            }
        }
        Ok((
            self.obs_array(py),
            rewards.into_pyarray(py),
            dones.into_pyarray(py),
            finals.into_pyarray(py),
            idx.into_pyarray(py),
        ))
    }

    /// Current walls of env `i` as a solution string, and its score.
    fn current(&self, i: usize) -> PyResult<(String, i32)> {
        let e = self
            .envs
            .get(i)
            .ok_or_else(|| PyValueError::new_err("no such env"))?;
        Ok((solution_of(e.map(), e.walls()), e.score()))
    }
}

#[pymodule]
fn pathery_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<VecEnv>()?;
    m.add_function(wrap_pyfunction!(score, m)?)?;
    m.add_function(wrap_pyfunction!(greedy_py, m)?)?;
    m.add_function(wrap_pyfunction!(brute_force_py, m)?)?;
    m.add_function(wrap_pyfunction!(solve_sa_py, m)?)?;
    m.add_function(wrap_pyfunction!(random_play_py, m)?)?;
    m.add("N_PLANES", plane::COUNT)?;
    Ok(())
}
