"""Attach unmodified Harbor Proximus to the container owned by FrontierSweSeam.

This adapter never creates, replaces, stops or grades a task container. Provider
credentials stay in the host Proximus process; Docker receives explicit exec
overlays only. The TypeScript host owns the overall deadline and teardown.
"""
from __future__ import annotations

import asyncio
import base64
import json
import math
import re
import shlex
import sys
import time
from pathlib import Path, PurePosixPath
from typing import Awaitable, Callable

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.environments.capabilities import EnvironmentCapabilities
from harbor.models.task.config import EnvironmentConfig, NetworkMode, NetworkPolicy
from harbor.models.trial.paths import TrialPaths

Command = Callable[[list[str], float], Awaitable[ExecResult]]


class HostTaskCommands:
    """One private request at a time on the existing host process pipes.

    The trusted parent validates the exact container, operation and deadline.
    This worker never receives Docker credentials or a daemon socket.
    """
    def __init__(self):
        self._lock = asyncio.Lock()
        self._ordinal = 0

    async def __call__(self, args: list[str], timeout: float) -> ExecResult:
        async with self._lock:
            self._ordinal += 1
            print(json.dumps({"kind": "task-command", "id": self._ordinal,
                              "args": args, "timeout": timeout}), file=sys.__stdout__, flush=True)
            line = await asyncio.to_thread(sys.stdin.buffer.readline, 24 * 1024 * 1024 + 1)
            if len(line) > 24 * 1024 * 1024 or not line.endswith(b"\n"):
                raise ValueError("Invalid host task response")
            result = json.loads(line)
            if result.get("kind") != "task-result" or result.get("id") != self._ordinal:
                raise ValueError("Host task response correlation changed")
            return ExecResult(return_code=result["return_code"], stdout=result["stdout"], stderr=result["stderr"])


class FrontierSweEnvironment(BaseEnvironment):
    """The existing immutable image/container is the sole execution target."""

    def __init__(self, *, container_id: str, image: str, instance_id: str,
                 network: str, network_mode: str, trial_dir: Path, max_wall_clock_ms: int,
                 command: Command | None = None):
        if not re.fullmatch(r"[a-f0-9]{64}", container_id):
            raise ValueError("A full Docker container ID is required")
        if not re.fullmatch(r"[^\s@]+@sha256:[a-f0-9]{64}", image):
            raise ValueError("An immutable task image digest is required")
        if not instance_id.strip() or not re.fullmatch(r"[a-zA-Z0-9_.-]+", network):
            raise ValueError("An exact task/network binding is required")
        mode = NetworkMode(network_mode)
        if isinstance(max_wall_clock_ms, bool) or not isinstance(max_wall_clock_ms, int) or max_wall_clock_ms <= 0:
            raise ValueError("A finite positive task deadline is required")
        self.container_id, self.image, self.instance_id = container_id, image, instance_id
        self.network, self._command = network, command or HostTaskCommands()
        self._deadline = time.monotonic() + max_wall_clock_ms / 1000
        self._attached = False
        super().__init__(
            environment_dir=trial_dir, environment_name=instance_id,
            session_id=container_id, trial_paths=TrialPaths(trial_dir=trial_dir),
            task_env_config=EnvironmentConfig(docker_image=image, workdir="/app"),
            network_policy=NetworkPolicy(network_mode=mode),
        )

    @staticmethod
    def type() -> str:
        return "frontier-swe-existing-container"

    @property
    def capabilities(self) -> EnvironmentCapabilities:
        return EnvironmentCapabilities(disable_internet=True, network_allowlist=True)

    def _validate_definition(self):
        if not self.environment_dir.is_dir():
            raise ValueError("The host trial directory must already exist")

    async def _checked(self, args: list[str], timeout: float = 10) -> ExecResult:
        result = await self._command(args, self._remaining(timeout))
        if result.return_code != 0:
            # Keep command output out of exceptions: Docker diagnostics can
            # contain configuration; the host retains the original result.
            raise RuntimeError("The bound Docker operation failed")
        return result

    def _remaining(self, timeout: float) -> float:
        remaining = self._deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("The task deadline expired")
        return min(timeout, remaining)

    async def start(self, force_build: bool = False) -> None:
        if force_build:
            raise ValueError("The FrontierSWE seam owns image/container creation")
        result = await self._checked(["inspect", self.container_id])
        rows = json.loads(result.stdout or "null")
        if not isinstance(rows, list) or len(rows) != 1:
            raise ValueError("The exact task container is unavailable")
        row = rows[0]
        networks = row.get("NetworkSettings", {}).get("Networks", {})
        if (row.get("Id") != self.container_id or not row.get("State", {}).get("Running")
                or row.get("Config", {}).get("Image") != self.image
                or row.get("HostConfig", {}).get("NetworkMode") not in (
                    {self.network, "default"} if self.network == "bridge" else {self.network})
                or set(networks) != {self.network}):
            raise ValueError("The task container/image/network binding changed")
        if self.network_policy.network_mode != NetworkMode.PUBLIC and self.network != "none":
            network = json.loads((await self._checked(["network", "inspect", self.network])).stdout or "null")
            if not isinstance(network, list) or len(network) != 1 or network[0].get("Internal") is not True:
                raise ValueError("The task network no longer enforces no-network")
        # The inner timeout kills sandbox commands when the Docker client is
        # interrupted. Refuse images lacking it before any model request.
        await self._checked(["exec", self.container_id, "bash", "-lc", "command -v timeout >/dev/null"])
        self._attached = True

    async def stop(self, delete: bool = False):
        self._attached = False
        if delete:
            raise ValueError("Only the FrontierSWE seam may delete this container")

    async def exec(self, command: str, cwd: str | None = None,
                   env: dict[str, str] | None = None, timeout_sec: int | None = None,
                   user: str | int | None = None) -> ExecResult:
        if not self._attached:
            raise RuntimeError("The task environment is not attached")
        timeout = 60 if timeout_sec is None else timeout_sec
        if isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("A finite positive command deadline is required")
        timeout = self._remaining(timeout)
        args = ["exec"]
        if user is not None:
            args += ["--user", str(user)]
        if cwd is not None:
            args += ["--workdir", cwd]
        for key, value in sorted((self._merge_env(env) or {}).items()):
            if not re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]*", key) or "\0" in value:
                raise ValueError("Invalid sandbox environment overlay")
            args += ["--env", f"{key}={value}"]
        args += [self.container_id, "timeout", "--signal=TERM", "--kill-after=1s",
                 f"{timeout}s", "bash", "-lc", command]
        return await self._command(args, self._remaining(timeout + 2))

    async def download_file(self, source_path: str, target_path: Path | str):
        if not self._attached or not PurePosixPath(source_path).is_absolute() or "\0" in source_path:
            raise ValueError("A bound container and absolute sandbox path are required")
        # Docker cp can recreate a sandbox symlink on the HOST, which upstream
        # view_image would then follow. Read bytes inside the container instead;
        # the normal command capture limit also bounds image transport size.
        result = await self.exec("base64 -- " + shlex.quote(source_path), timeout_sec=10)
        if result.return_code != 0:
            raise RuntimeError("The sandbox image could not be read")
        data = base64.b64decode("".join((result.stdout or "").split()), validate=True)
        # Upstream supplies a fresh temporary path. Refuse an existing path,
        # including a symlink, rather than opening any host-selected target.
        with Path(target_path).open("xb") as target:
            target.write(data)

    async def upload_file(self, source_path: Path | str, target_path: str):
        raise NotImplementedError("Proximus does not upload host files into tasks")

    async def upload_dir(self, source_dir: Path | str, target_dir: str):
        raise NotImplementedError("The FrontierSWE seam owns task provisioning")

    async def download_dir(self, source_dir: str, target_dir: Path | str):
        raise NotImplementedError("The FrontierSWE grader owns artifact collection")
