"""SB3 VecEnv over the Rust batched environment (pathery_rs.VecEnv).

All per-board work (stepping, observations, legal masks) happens in Rust in one call per step.
MaskablePPO reads the masks through `env_method("action_masks")`.
"""

from __future__ import annotations

import time
from typing import Any, Sequence

import gymnasium as gym
import numpy as np
from stable_baselines3.common.vec_env.base_vec_env import VecEnv, VecEnvStepReturn

import pathery_rs

# Upper bound of each observation plane (env.rs `plane`). Binary planes are 0/1; the others are
# values. Declaring the real bounds also stops SB3 from treating the planes as an image (which
# would divide by 255 and transpose channels).
PLANE_HIGH = np.array(
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 255, 255, 255, 1, 1, 1, 1, 255, 255, 1], dtype=np.uint8
)
assert len(PLANE_HIGH) == pathery_rs.N_PLANES


class PatheryVecEnv(VecEnv):
    def __init__(
        self,
        codes: Sequence[str],
        n_envs: int,
        frame_h: int,
        frame_w: int,
        seed: int = 0,
        scales: Sequence[float] | None = None,
        fixed: bool = False,
    ):
        self.codes = list(codes)
        self.rs = pathery_rs.VecEnv(
            self.codes, n_envs, frame_h, frame_w, seed, list(scales) if scales is not None else None, fixed
        )
        c, h, w = self.rs.obs_shape
        high = np.broadcast_to(PLANE_HIGH[:, None, None], (c, h, w)).copy()
        obs_space = gym.spaces.Box(low=0, high=high, shape=(c, h, w), dtype=np.uint8)
        self.render_mode = None
        super().__init__(n_envs, obs_space, gym.spaces.Discrete(self.rs.n_actions))
        self._actions: np.ndarray | None = None
        self._returns = np.zeros(n_envs, dtype=np.float64)
        self._lengths = np.zeros(n_envs, dtype=np.int64)
        self._t0 = time.time()

    # -- VecEnv API --------------------------------------------------------------------------

    def reset(self) -> np.ndarray:
        self._returns[:] = 0
        self._lengths[:] = 0
        return self.rs.reset()

    def step_async(self, actions: np.ndarray) -> None:
        self._actions = np.asarray(actions, dtype=np.int64).reshape(-1)

    def step_wait(self) -> VecEnvStepReturn:
        assert self._actions is not None
        obs, rew, done, final, idx = self.rs.step(self._actions)
        self._returns += rew
        self._lengths += 1
        infos: list[dict[str, Any]] = [{} for _ in range(self.num_envs)]
        for i in np.flatnonzero(done):
            infos[i] = {
                "episode": {"r": float(self._returns[i]), "l": int(self._lengths[i]), "t": time.time() - self._t0},
                "score": int(final[i]),
                "map_index": int(idx[i]),
            }
            self._returns[i] = 0
            self._lengths[i] = 0
        return obs, rew.astype(np.float32), done, infos

    def action_masks(self) -> np.ndarray:
        return self.rs.action_masks()

    def close(self) -> None:
        pass

    def get_attr(self, attr_name: str, indices=None) -> list[Any]:
        return [getattr(self, attr_name)] * len(self._indices(indices))

    def set_attr(self, attr_name: str, value: Any, indices=None) -> None:
        setattr(self, attr_name, value)

    def env_method(self, method_name: str, *args, indices=None, **kwargs) -> list[Any]:
        if method_name == "action_masks":
            masks = self.rs.action_masks()
            return [masks[i] for i in self._indices(indices)]
        raise NotImplementedError(method_name)

    def env_is_wrapped(self, wrapper_class, indices=None) -> list[bool]:
        return [False] * len(self._indices(indices))

    def seed(self, seed: int | None = None):  # maps are drawn by the Rust RNG (seeded at init)
        return [None] * self.num_envs

    def _indices(self, indices) -> list[int]:
        if indices is None:
            return list(range(self.num_envs))
        if isinstance(indices, int):
            return [indices]
        return list(indices)
