"""Measured host entry point for the unchanged, pinned official Proximus loop.

Only the trusted TypeScript host invokes this process. Its scoped gateway token
travels on stdin, never argv or a task file. Context usage is diagnostic, not a
provider bill. Container lifecycle and grading remain with FrontierSweSeam.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata as metadata
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from contextlib import redirect_stdout
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent.parent / "vendor/proximus"
SOURCE_REVISION = "a989f7b35c95c0fd30603290da3c923b7898cba8"


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def measure_runtime() -> dict:
    """Hash actual installed bytes, the interpreter and both host adapters.

    Distribution metadata alone cannot detect a changed imported module. The
    editable official package is measured separately against its Git manifest.
    No paths, credentials or host environment values enter the public receipt.
    """
    if sys.version_info < (3, 12):
        raise ValueError("Proximus requires Python 3.12 or newer")
    if metadata.version("harbor") != "0.23.0" or metadata.version("harbor-proximus") != "0.1.0a1":
        raise ValueError("The installed Harbor/Proximus versions differ from the pin")
    package = importlib.util.find_spec("harbor_proximus")
    if package is None or Path(package.origin).resolve() != SOURCE / "src/harbor_proximus/__init__.py":
        raise ValueError("The imported Proximus package is not the official vendored source")
    manifest = json.loads((SOURCE / "UPSTREAM.json").read_text())
    if manifest["revision"] != SOURCE_REVISION:
        raise ValueError("The official source revision changed")
    expected = {row["path"]: row["sha256"] for row in manifest["files"]}
    observed = {path.relative_to(SOURCE).as_posix() for path in SOURCE.rglob("*")
                if path.is_file() and path.name != "UPSTREAM.json" and "__pycache__" not in path.parts}
    if observed != set(expected):
        raise ValueError("The official source file population changed")
    files = {}
    for name, digest in sorted(expected.items()):
        path = SOURCE / name
        if path.is_symlink() or sha(path) != digest:
            raise ValueError("The official source bytes changed")
        files["source/" + name] = digest
    for distribution in sorted(metadata.distributions(), key=lambda dist: dist.metadata["Name"].lower()):
        prefix = "installed/" + distribution.metadata["Name"].lower() + "@" + distribution.version + "/"
        if distribution.files is None:
            raise ValueError("An installed distribution lacks its file census")
        for entry in sorted(distribution.files):
            if str(entry).endswith((".pyc", ".pyo")):
                continue
            path = Path(distribution.locate_file(entry))
            if not path.is_file():
                raise ValueError("An installed distribution file is missing")
            key = prefix + str(entry)
            if key in files:
                raise ValueError("The installed distribution census is ambiguous")
            files[key] = sha(path)
    files["python/executable"] = sha(Path(sys.executable))
    for name in ("proximus-host.py", "proximus-environment.py"):
        files["adapter/" + name] = sha(HERE / name)
    document = {"schemaVersion": 1, "python": sys.version, "files": files}
    revision = hashlib.sha256(json.dumps(document, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"schemaVersion": 1, "runtimeRevision": revision, "sourceRevision": SOURCE_REVISION,
            "clientVersion": "harbor-proximus@0.1.0a1", "harborVersion": "0.23.0", "fileCount": len(files)}


def load_environment():
    spec = importlib.util.spec_from_file_location("proximus_environment", HERE / "proximus-environment.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.FrontierSweEnvironment


def scoped_connection(provider: str, gateway: dict) -> dict[str, str]:
    base, token = gateway["baseURL"], gateway["token"]
    url = urlsplit(base)
    if (provider not in ("openai", "anthropic") or url.scheme != "http" or url.hostname != "127.0.0.1"
            or not url.port or base != f"http://127.0.0.1:{url.port}"
            or not re.fullmatch(r"[A-Za-z0-9_-]{32,512}", token)):
        raise ValueError("An exact loopback scoped gateway is required")
    return {"api_base": base + ("/v1" if provider == "openai" else ""), "token": token}


async def run_assignment(payload: dict) -> dict:
    from harbor.models.agent.context import AgentContext
    from harbor_proximus.proximus import Proximus

    spec = payload["spec"]
    measured = measure_runtime()
    if (spec["runtimeRevision"] != measured["runtimeRevision"]
            or spec["sourceRevision"] != measured["sourceRevision"]
            or spec["clientVersion"] != measured["clientVersion"]
            or spec["harborVersion"] != measured["harborVersion"]
            or spec["agent"] != "harbor_proximus:Proximus"):
        raise ValueError("The installed official runtime differs from its frozen assignment")
    connection = scoped_connection(spec["provider"], payload["gateway"])
    options = spec["options"]
    if set(options) != {"time_budget_sec", "reasoning_effort", "model_info", "llm_call_kwargs"}:
        raise ValueError("Only the frozen Proximus options are accepted")
    if (spec["modelName"] != spec["provider"] + "/" + spec["model"]
            or type(spec["maxWallClockMs"]) is not int or spec["maxWallClockMs"] <= 0
            or options["time_budget_sec"] != spec["maxWallClockMs"] / 1000):
        raise ValueError("The model or hard deadline differs from its assignment")
    if not isinstance(payload["instruction"], str) or not payload["instruction"].strip():
        raise ValueError("The task instruction is required")
    trial = Path(payload["trialDir"])
    if not trial.is_absolute() or not trial.is_dir():
        raise ValueError("An existing absolute host trial directory is required")
    environment = load_environment()(container_id=spec["containerId"], image=spec["image"],
        instance_id=spec["taskId"], network=payload["network"], network_mode=payload["networkMode"],
        trial_dir=trial, max_wall_clock_ms=spec["maxWallClockMs"])
    context = AgentContext()
    # No provider key is supplied: this token authenticates only the live
    # assignment gateway. The official agent masks its consumed env overlay.
    key_name = "OPENAI_API_KEY" if spec["provider"] == "openai" else "ANTHROPIC_API_KEY"
    async with asyncio.timeout(spec["maxWallClockMs"] / 1000):
        try:
            await environment.start()
            agent = Proximus(logs_dir=trial, model_name=spec["modelName"],
                extra_env={key_name: connection["token"]},
                **options, api_base=connection["api_base"])
            await agent.setup(environment)
            await agent.run(payload["instruction"], environment, context)
        finally:
            await environment.stop()
    return {"schemaVersion": 1, "status": "completed", "runtime": measured,
            "diagnosticContext": context.model_dump(mode="json"), "billingStatus": "unreconciled"}


def main() -> int:
    try:
        if sys.argv[1:] == ["measure"]:
            result = measure_runtime()
        elif sys.argv[1:] == ["run"]:
            data = sys.stdin.buffer.readline(1024 * 1024 + 1)
            if len(data) > 1024 * 1024:
                raise ValueError("The host assignment payload is too large")
            # Official dependency diagnostics must not share the private task
            # protocol stream. HostTaskCommands writes explicitly to __stdout__.
            with redirect_stdout(sys.stderr):
                result = asyncio.run(run_assignment(json.loads(data)))
        else:
            raise ValueError("Expected measure or run")
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except Exception as error:
        # Do not print arbitrary exceptions from provider libraries: those may
        # contain request headers or full model input. Artifacts stay private.
        print(json.dumps({"schemaVersion": 1, "status": "failed", "errorType": type(error).__name__,
                          "billingStatus": "unreconciled"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
