"""Smoke tests for the pathery_rs Python module (run after `maturin develop --release`):

    python -m pytest ml/engine-rs/tests_py -q
"""

import json
from pathlib import Path

import numpy as np
import pytest

import pathery_rs

REPO = Path(__file__).resolve().parents[3]
ROWS = json.loads((REPO / "tests/fixtures/scoreboard.json").read_text(encoding="utf-8"))


def test_score_matches_scoreboard():
    for r in ROWS[:200]:
        assert pathery_rs.score(r["code"], r["solution"]) == r["moves"]


def test_greedy_and_brute_force():
    code = ROWS[0]["code"]
    s, sol = pathery_rs.greedy(code)
    assert s == pathery_rs.score(code, sol)
    tiny = "5.3.3.T...:,s1.3,f1.,s1.3,f1.,s1.3,f1."
    bf, bsol = pathery_rs.brute_force(tiny)
    assert bf == pathery_rs.score(tiny, bsol)
    assert bf >= pathery_rs.greedy(tiny)[0]
    with pytest.raises(ValueError):
        pathery_rs.brute_force(code, limit=1000)


def simple_codes():
    return sorted({r["code"] for r in ROWS if ".Simple." in r["code"]})


def test_vec_env_random_play():
    codes = simple_codes()
    env = pathery_rs.VecEnv(codes, n_envs=64, frame_h=6, frame_w=13, seed=1)
    c, h, w = env.obs_shape
    assert c == pathery_rs.N_PLANES
    obs = env.reset()
    assert obs.shape == (64, c, h, w) and obs.dtype == np.uint8
    rng = np.random.default_rng(0)
    finished = 0
    returns = np.zeros(64)
    for _ in range(200):
        masks = env.action_masks()
        assert masks.shape == (64, env.n_actions) and masks[:, -1].all()
        # Random legal wall, never STOP while a wall is possible.
        acts = []
        for m in masks:
            cells = np.flatnonzero(m[:-1])
            acts.append(rng.choice(cells) if len(cells) else env.n_actions - 1)
        obs, rew, done, final, idx = env.step(np.array(acts, dtype=np.int64))
        returns += rew
        for i in np.flatnonzero(done):
            # Rewards telescope: return = (final - no-walls score) / no-walls score.
            nw = pathery_rs.score(codes[idx[i]], "..:")
            assert abs(returns[i] - (final[i] - nw) / nw) < 1e-4
            returns[i] = 0
            finished += 1
    assert finished > 100


def test_illegal_action_raises():
    env = pathery_rs.VecEnv(simple_codes()[:1], n_envs=1, frame_h=6, frame_w=13)
    env.reset()
    masks = env.action_masks()
    bad = int(np.flatnonzero(~masks[0])[0])
    with pytest.raises(ValueError):
        env.step(np.array([bad], dtype=np.int64))
