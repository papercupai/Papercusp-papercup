"""Canonical offline runner tests using real pinned Harbor and Proximus types."""
import asyncio
import importlib.util
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.dont_write_bytecode = True
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"


def blocked(*args, **kwargs):
    raise AssertionError("Network access is forbidden in this offline test")


socket.socket.connect = blocked
socket.create_connection = blocked

from harbor_proximus.proximus import Proximus

path = Path(__file__).resolve().parents[1] / "lib/external-bench/proximus-host.py"
spec = importlib.util.spec_from_file_location("proximus_host", path)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class HostTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.measured = {"runtimeRevision": "a" * 64, "sourceRevision": host.SOURCE_REVISION,
            "clientVersion": "harbor-proximus@0.1.0a1", "harborVersion": "0.23.0"}
        self.payload = {"instruction": "solve the exact task", "trialDir": self.scratch.name,
            "network": "none", "networkMode": "no-network",
            "gateway": {"baseURL": "http://127.0.0.1:32105", "token": "opaque_gateway_token_" + "x" * 32},
            "spec": {**self.measured, "agent": "harbor_proximus:Proximus", "provider": "openai",
                "model": "offline-model", "modelName": "openai/offline-model", "taskId": "t1",
                "containerId": "b" * 64, "image": "task@sha256:" + "c" * 64, "maxWallClockMs": 10_000,
                "options": {"time_budget_sec": 10, "reasoning_effort": "high",
                    "model_info": {"max_input_tokens": 20_000, "supports_vision": False, "mode": "responses"},
                    "llm_call_kwargs": {"max_tokens": 10}}}}
        self.environment = AsyncMock()
        from unittest.mock import Mock
        self.environment.scoped_exec_env = Mock(return_value=__import__('contextlib').nullcontext())

    def test_measures_actual_installed_bytes_and_official_source_without_provider_access(self):
        first = host.measure_runtime()
        self.assertRegex(first["runtimeRevision"], r"^[a-f0-9]{64}$")
        self.assertGreater(first["fileCount"], 100)
        self.assertEqual(first["sourceRevision"], host.SOURCE_REVISION)
        original = host.sha
        with patch.object(host, "sha", side_effect=lambda path: "0" * 64 if path.name == "proximus-host.py" else original(path)):
            self.assertNotEqual(host.measure_runtime()["runtimeRevision"], first["runtimeRevision"])

    async def test_official_run_masks_gateway_token_and_returns_only_diagnostic_usage(self):
        observed = []

        async def run_task(agent, instruction, environment, context):
            observed.append((agent, instruction, environment))
            context.cost_usd = 0.012

        with patch.object(host, "measure_runtime", return_value=self.measured), \
                patch.object(host, "load_environment", return_value=lambda **kw: self.environment), \
                patch.object(Proximus, "_run_task", run_task):
            result = await host.run_assignment(self.payload)
        agent, instruction, environment = observed[0]
        self.assertIsInstance(agent, Proximus)
        self.assertIs(environment, self.environment)
        self.assertEqual(instruction, self.payload["instruction"])
        self.assertEqual(agent._llm._config.api_base, "http://127.0.0.1:32105/v1")
        self.assertEqual(agent._llm._api_key, self.payload["gateway"]["token"])
        self.environment.scoped_exec_env.assert_called_once_with({"OPENAI_API_KEY": ""})
        self.assertEqual(result["billingStatus"], "unreconciled")
        self.assertEqual(result["diagnosticContext"]["cost_usd"], 0.012)
        self.environment.start.assert_awaited_once()
        self.environment.stop.assert_awaited_once_with()

    async def test_runtime_drift_refuses_before_container_or_agent_access(self):
        self.payload["spec"]["runtimeRevision"] = "d" * 64
        with patch.object(host, "measure_runtime", return_value=self.measured), \
                patch.object(host, "load_environment") as factory:
            with self.assertRaisesRegex(ValueError, "frozen assignment"):
                await host.run_assignment(self.payload)
            factory.assert_not_called()

    async def test_hard_deadline_cancels_run_and_releases_attachment_without_deleting_container(self):
        self.payload["spec"]["maxWallClockMs"] = 40
        self.payload["spec"]["options"]["time_budget_sec"] = 0.04
        cancelled = []

        async def run_task(*args):
            try:
                await asyncio.sleep(60)
            finally:
                cancelled.append(True)

        with patch.object(host, "measure_runtime", return_value=self.measured), \
                patch.object(host, "load_environment", return_value=lambda **kw: self.environment), \
                patch.object(Proximus, "_run_task", run_task):
            with self.assertRaises(TimeoutError):
                await host.run_assignment(self.payload)
        self.assertEqual(cancelled, [True])
        self.environment.stop.assert_awaited_once_with()

    async def test_agent_failure_also_releases_attachment(self):
        with patch.object(host, "measure_runtime", return_value=self.measured), \
                patch.object(host, "load_environment", return_value=lambda **kw: self.environment), \
                patch.object(Proximus, "_run_task", AsyncMock(side_effect=RuntimeError("provider failed"))):
            with self.assertRaises(RuntimeError):
                await host.run_assignment(self.payload)
        self.environment.stop.assert_awaited_once_with()

    def test_gateway_never_falls_back_to_a_provider_or_accepts_a_copied_external_url(self):
        for base in ("https://api.openai.com", "http://localhost:32105", "http://127.0.0.1:32105/v1",
                     "http://secret@127.0.0.1:32105", "http://127.0.0.1:32105?redirect=evil"):
            with self.assertRaises(ValueError):
                host.scoped_connection("openai", {**self.payload["gateway"], "baseURL": base})
        self.assertEqual(host.scoped_connection("anthropic", self.payload["gateway"])["api_base"],
            "http://127.0.0.1:32105")

    async def test_rejects_unfrozen_options_and_model_before_attachment(self):
        for key, value in (("api_base", "https://api.openai.com"), ("load_trajectory", "/other/run")):
            self.payload["spec"]["options"][key] = value
            with patch.object(host, "measure_runtime", return_value=self.measured), \
                    patch.object(host, "load_environment") as factory:
                with self.assertRaises(ValueError):
                    await host.run_assignment(self.payload)
                factory.assert_not_called()
            del self.payload["spec"]["options"][key]


if __name__ == "__main__":
    unittest.main()
