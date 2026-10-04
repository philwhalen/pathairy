"""Fully convolutional policy/value network for MaskablePPO (docs/rl-agent-plan.md §6.2).

- Trunk: residual blocks (pre-activation, no normalization) with KataGo-style global pooling: in
  some blocks, the mean and max over on-board cells feed a channel bias.
- Policy head: 1x1 conv -> one logit per cell; the STOP logit comes from pooled features.
- Value head: pooled features -> MLP. SB3 adds the final Linear(64, 1).

Being fully convolutional (pooling for STOP and value), the same weights work for any frame size,
so a net trained on the 6x13 Simple frame can be loaded for 19x27.
"""

from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from sb3_contrib.common.maskable.policies import MaskableActorCriticPolicy

from .vec_env import PLANE_HIGH

OFF_BOARD = 0
VALUE_DIM = 64


def plane_scale() -> torch.Tensor:
    """Per-plane input scale: binary planes as is, value planes to roughly 0..1."""
    s = torch.ones(len(PLANE_HIGH))
    s[13] = 1 / 8  # checkpoint number
    s[14] = s[15] = 1 / 4  # teleport pair number
    s[20] = s[21] = 1 / 255  # path order, walls left
    return s


def masked_pool(x: torch.Tensor, on: torch.Tensor) -> torch.Tensor:
    """[B, C, H, W] -> [B, 2C]: mean and max over on-board cells (`on` is [B, 1, H, W])."""
    n = on.sum(dim=(2, 3)).clamp(min=1)
    mean = (x * on).sum(dim=(2, 3)) / n
    mx = (x - (1 - on) * 1e4).amax(dim=(2, 3))
    return torch.cat([mean, mx], dim=1)


class ResBlock(nn.Module):
    def __init__(self, c: int, global_pool: bool):
        super().__init__()
        self.conv1 = nn.Conv2d(c, c, 3, padding=1)
        self.conv2 = nn.Conv2d(c, c, 3, padding=1)
        self.pool_fc = nn.Linear(2 * c, c) if global_pool else None
        nn.init.zeros_(self.conv2.weight)
        nn.init.zeros_(self.conv2.bias)

    def forward(self, x: torch.Tensor, on: torch.Tensor) -> torch.Tensor:
        y = self.conv1(F.relu(x))
        if self.pool_fc is not None:
            y = y + self.pool_fc(masked_pool(F.relu(y), on))[:, :, None, None]
        y = self.conv2(F.relu(y))
        return (x + y) * on


class PatheryNet(nn.Module):
    def __init__(self, n_planes: int, channels: int = 64, blocks: int = 6, pool_every: int = 3):
        super().__init__()
        self.register_buffer("scale", plane_scale()[None, :, None, None])
        self.stem = nn.Conv2d(n_planes, channels, 3, padding=1)
        self.blocks = nn.ModuleList(
            ResBlock(channels, global_pool=(i % pool_every == pool_every - 1)) for i in range(blocks)
        )
        self.policy_conv = nn.Conv2d(channels, 1, 1)
        self.stop_fc = nn.Linear(2 * channels, 1)
        self.value_fc = nn.Linear(2 * channels, VALUE_DIM)

    def forward(self, obs: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        x = obs * self.scale
        on = 1 - x[:, OFF_BOARD : OFF_BOARD + 1]
        h = self.stem(x) * on
        for b in self.blocks:
            h = b(h, on)
        h = F.relu(h)
        pooled = masked_pool(h, on)
        logits = torch.cat([self.policy_conv(h).flatten(1), self.stop_fc(pooled)], dim=1)
        value = F.relu(self.value_fc(pooled))
        return logits, value


class PatheryExtractor(nn.Module):
    """Stands in for SB3's mlp_extractor: features (flat obs) -> (policy logits, value latent)."""

    def __init__(self, obs_shape: tuple[int, int, int], channels: int, blocks: int):
        super().__init__()
        self.obs_shape = obs_shape
        c, h, w = obs_shape
        self.net = PatheryNet(c, channels, blocks)
        self.latent_dim_pi = h * w + 1
        self.latent_dim_vf = VALUE_DIM

    def forward(self, features: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        return self.net(features.view(-1, *self.obs_shape))

    def forward_actor(self, features: torch.Tensor) -> torch.Tensor:
        return self.forward(features)[0]

    def forward_critic(self, features: torch.Tensor) -> torch.Tensor:
        return self.forward(features)[1]


class PatheryPolicy(MaskableActorCriticPolicy):
    """MaskablePPO policy whose logits come straight from the conv net (action_net = Identity)."""

    def __init__(self, *args, channels: int = 64, blocks: int = 6, **kwargs):
        self.channels = channels
        self.blocks = blocks
        kwargs.setdefault("ortho_init", False)
        kwargs.setdefault("normalize_images", False)
        super().__init__(*args, **kwargs)

    def _build_mlp_extractor(self) -> None:
        self.mlp_extractor = PatheryExtractor(self.observation_space.shape, self.channels, self.blocks)

    def _build(self, lr_schedule) -> None:
        super()._build(lr_schedule)
        self.action_net = nn.Identity()
        self.optimizer = self.optimizer_class(self.parameters(), lr=lr_schedule(1), **self.optimizer_kwargs)

    def _get_constructor_parameters(self) -> dict:
        data = super()._get_constructor_parameters()
        data.update(channels=self.channels, blocks=self.blocks)
        return data
