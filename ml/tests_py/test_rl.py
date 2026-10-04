"""Tests for ml/pathery_rl (CPU only): python -m pytest ml/tests_py -q"""

import json
from pathlib import Path

import numpy as np
import torch
from sb3_contrib import MaskablePPO

from ml.pathery_rl.evaluate import play
from ml.pathery_rl.policy import PatheryNet
from ml.pathery_rl.vec_env import PLANE_HIGH, PatheryVecEnv

REPO = Path(__file__).resolve().parents[2]
ROWS = json.loads((REPO / "tests/fixtures/scoreboard.json").read_text(encoding="utf-8"))
SIMPLE = sorted({r["code"] for r in ROWS if ".Simple." in r["code"]})


def test_vec_env_spaces_and_bounds():
    env = PatheryVecEnv(SIMPLE, 8, 6, 13, seed=1)
    obs = env.reset()
    assert obs.shape == (8, len(PLANE_HIGH), 6, 13)
    assert env.observation_space.contains(obs[0])
    assert env.action_space.n == 6 * 13 + 1
    masks = np.stack(env.env_method("action_masks"))
    assert masks.shape == (8, 79) and masks[:, -1].all()


def test_episode_info_and_returns():
    env = PatheryVecEnv(SIMPLE, 4, 6, 13, seed=2)
    env.reset()
    rng = np.random.default_rng(0)
    episodes = 0
    for _ in range(100):
        m = env.action_masks()
        a = np.argmax(np.where(m, rng.random(m.shape), -1), axis=1)
        env.step_async(a)
        _, _, done, infos = env.step_wait()
        for i in np.flatnonzero(done):
            assert infos[i]["episode"]["l"] >= 1 and infos[i]["score"] > 0
            episodes += 1
    assert episodes > 20


def test_net_is_frame_independent_and_masks_off_board():
    net = PatheryNet(len(PLANE_HIGH), channels=16, blocks=3)
    for h, w in [(6, 13), (19, 27)]:
        env = PatheryVecEnv(SIMPLE[:2], 2, h, w)
        obs = torch.as_tensor(env.reset()).float()
        logits, value = net(obs)
        assert logits.shape == (2, h * w + 1) and value.shape == (2, 64)
    # Off-board cells carry no features: their logit is the policy conv bias alone.
    off = obs[0, 0] > 0
    cell_logits = logits[0, :-1].view(19, 27)
    bias = net.policy_conv.bias.item()
    assert torch.allclose(cell_logits[off], torch.full_like(cell_logits[off], bias))


def test_ppo_learns_a_little_and_plays_legal_moves(tmp_path):
    env = PatheryVecEnv(SIMPLE, 32, 6, 13, seed=3)
    from ml.pathery_rl.policy import PatheryPolicy

    model = MaskablePPO(
        PatheryPolicy, env, n_steps=16, batch_size=256, n_epochs=2, gamma=1.0,
        policy_kwargs={"channels": 16, "blocks": 2}, device="cpu", seed=1,
    )
    model.learn(2048)
    model.save(tmp_path / "m.zip")
    loaded = MaskablePPO.load(tmp_path / "m.zip", device="cpu")
    scores = play(loaded, SIMPLE[:10], (6, 13))
    assert (scores > 0).all()
