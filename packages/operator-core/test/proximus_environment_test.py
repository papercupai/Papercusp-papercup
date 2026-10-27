"""Offline contract tests against the actual pinned Harbor/Proximus packages."""
import asyncio
import base64
import importlib.util
import json
import io
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"


def blocked(*args, **kwargs):
    raise AssertionError("Network access is forbidden in this offline test")


socket.socket.connect = blocked
socket.create_connection = blocked

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor_proximus.tools import BashArgs, ToolExecutor

path = Path(__file__).resolve().parents[1] / "lib/external-bench/proximus-environment.py"
spec = importlib.util.spec_from_file_location("proximus_environment", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

CID, IMAGE = "a" * 64, "task@sha256:" + "b" * 64


class AttachmentTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.calls = []
        self.row = {"Id": CID, "State": {"Running": True}, "Config": {"Image": IMAGE},
                    "HostConfig": {"NetworkMode": "task-private"},
                    "NetworkSettings": {"Networks": {"task-private": {}}}}
        self.internal = True

    async def command(self, args, timeout):
        self.calls.append((args, timeout))
        if args[0] == "inspect":
            text = json.dumps([self.row])
        elif args[:2] == ["network", "inspect"]:
            text = json.dumps([{"Internal": self.internal}])
        elif args[-1].startswith("base64 -- "):
            text = base64.b64encode(b"\x89PNG\r\n\x00\xff").decode()
        else:
            text = "sandbox output"
        return ExecResult(return_code=0, stdout=text, stderr="")

    def environment(self, **opts):
        return module.FrontierSweEnvironment(container_id=CID, image=IMAGE, instance_id="task1",
            network="task-private", network_mode="no-network", trial_dir=Path(self.scratch.name),
            command=self.command, max_wall_clock_ms=10_000, **opts)

    async def test_official_tool_executor_uses_only_the_bound_existing_container(self):
        env = self.environment()
        self.assertIsInstance(env, BaseEnvironment)
        await env.start()
        executor = ToolExecutor(env, default_workdir="/app", remaining_sec=lambda: 30)
        with env.scoped_exec_env({"OPENAI_API_KEY": ""}):
            result = await executor.bash(BashArgs(command="printf '$literal; `x`'", timeout_sec=5))
        self.assertIn("sandbox output", str(result))
        args, timeout = self.calls[-1]
        self.assertEqual(args[-8:-4], [CID, "timeout", "--signal=TERM", "--kill-after=1s"])
        self.assertEqual(float(args[-4][:-1]), 5)
        self.assertEqual(args[-3:], ["bash", "-lc", "printf '$literal; `x`'"])
        self.assertIn("OPENAI_API_KEY=", args)
        self.assertIn("/app", args)
        self.assertLessEqual(timeout, 7)
        self.assertGreater(timeout, 6)
        self.assertFalse(any(args[0] in ("run", "create", "rm", "stop") for args, _ in self.calls))

    async def test_rejects_changed_image_state_and_network_before_agent_execution(self):
        for key, value in (("Id", "c" * 64), ("State", {"Running": False}),
                           ("Config", {"Image": "other@sha256:" + "d" * 64}),
                           ("NetworkSettings", {"Networks": {"bridge": {}}})):
            prior = self.row[key]
            self.row[key] = value
            with self.assertRaises(ValueError):
                await self.environment().start()
            self.row[key] = prior
        self.internal = False
        with self.assertRaises(ValueError):
            await self.environment().start()

    async def test_refuses_lifecycle_and_host_file_upload_authority(self):
        env = self.environment()
        with self.assertRaises(ValueError):
            await env.start(force_build=True)
        with self.assertRaises(RuntimeError):
            await env.exec("pwd")
        await env.start()
        with self.assertRaises(NotImplementedError):
            await env.upload_file("/host/secret", "/app/secret")
        with self.assertRaises(ValueError):
            await env.stop(delete=True)

    async def test_download_and_deadline_are_bound_to_the_task(self):
        env = self.environment()
        await env.start()
        target = Path(self.scratch.name) / "image.png"
        await env.download_file("/app/image.png", target)
        self.assertEqual(target.read_bytes(), b"\x89PNG\r\n\x00\xff")
        self.assertEqual(self.calls[-1][0][-1], "base64 -- /app/image.png")
        self.assertIn(CID, self.calls[-1][0])
        self.assertFalse(any(args[0] == "cp" for args, _ in self.calls))
        for bad in (0, -1, float("inf"), float("nan"), True):
            with self.assertRaises(ValueError):
                await env.exec("pwd", timeout_sec=bad)
        with self.assertRaises(ValueError):
            await env.download_file("relative-path", "/tmp/image.png")

    def test_refuses_unpinned_container_or_image(self):
        with self.assertRaises(ValueError):
            module.FrontierSweEnvironment(container_id="--host", image=IMAGE, instance_id="task1",
                network="none", network_mode="no-network", trial_dir=Path(self.scratch.name), max_wall_clock_ms=10_000)

    async def test_image_download_never_follows_a_host_symlink_or_overwrites_a_file(self):
        env = self.environment()
        await env.start()
        secret = Path(self.scratch.name) / "host-secret"
        secret.write_bytes(b"leave intact")
        target = Path(self.scratch.name) / "image.png"
        target.symlink_to(secret)
        with self.assertRaises(FileExistsError):
            await env.download_file("/app/a;echo nope.png", target)
        self.assertEqual(secret.read_bytes(), b"leave intact")
        self.assertEqual(self.calls[-1][0][-1], "base64 -- '/app/a;echo nope.png'")

    async def test_task_deadline_limits_commands_and_refuses_expired_work(self):
        env = self.environment()
        await env.start()
        env._deadline = module.time.monotonic() + 0.1
        await env.exec("sleep 10", timeout_sec=100)
        self.assertLessEqual(float(self.calls[-1][0][-4][:-1]), 0.1)
        env._deadline = module.time.monotonic() - 1
        with self.assertRaises(TimeoutError):
            await env.exec("pwd")

    async def test_host_commands_are_serialized_and_correlated_without_a_docker_subprocess(self):
        output = io.StringIO()
        replies = b"".join((json.dumps({"kind": "task-result", "id": i, "return_code": 0,
            "stdout": "sandbox 猫", "stderr": ""}) + "\n").encode() for i in (1, 2))
        commands = module.HostTaskCommands()
        with patch.object(module.sys, "__stdout__", output), \
                patch.object(module.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(replies))), \
                patch.object(module.asyncio, "create_subprocess_exec", side_effect=AssertionError("no Docker authority")):
            results = await asyncio.gather(commands(["inspect", CID], 5), commands(["exec", CID], 3))
        self.assertEqual([r.stdout for r in results], ["sandbox 猫", "sandbox 猫"])
        self.assertEqual([json.loads(line)["id"] for line in output.getvalue().splitlines()], [1, 2])
        self.assertEqual(json.loads(output.getvalue().splitlines()[0])["args"], ["inspect", CID])

    async def test_host_command_rejects_mismatched_response_or_unterminated_stream(self):
        for reply in (b'{"kind":"task-result","id":2}\n', b'{"kind":"other","id":1}\n', b''):
            with patch.object(module.sys, "__stdout__", io.StringIO()), \
                    patch.object(module.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(reply))):
                with self.assertRaises(ValueError):
                    await module.HostTaskCommands()(["inspect", CID], 5)

    def test_default_environment_has_only_the_host_command_transport(self):
        env = module.FrontierSweEnvironment(container_id=CID, image=IMAGE, instance_id="task1",
            network="none", network_mode="no-network", trial_dir=Path(self.scratch.name), max_wall_clock_ms=10_000)
        self.assertIsInstance(env._command, module.HostTaskCommands)
        self.assertFalse(hasattr(module, "docker_command"))


if __name__ == "__main__":
    unittest.main()
