#!/usr/bin/env python3
"""Swap-tier test driver (WI-10005475, plan agent-capacity-and-cost-gcp-2026-09-30).

Question (owner directives #1858 / #1864): if parked agents' memory is pushed into swap, how fast
do they wake, how responsive does the machine stay, and which swap tier makes that acceptable?
The 2 Oct runs (D-041) showed swap stores nothing unless memory is forced out, so this test forces
it: every parked agent's cgroup is drained with `memory.reclaim`, then the agent is woken.

Agents are real interactive `claude` TUIs in tmux, each in its own systemd scope under
swaptier.slice, talking to swap-tier-stub-api.py, so replies are instant and the VM holds no
credentials. Each agent first builds a history of real tool results (WARM prompts).

  swap-tier.py bench-disk --device /dev/disk/by-id/google-swapbal --label pd-balanced --out DIR
  swap-tier.py run --out DIR --agents 24 --warm 8 --single 8 \\
      --arm none --arm zram --arm pd-balanced=/dev/disk/by-id/google-swapbal ...
  swap-tier.py report --out DIR            (also runs at the end of `run`)

P-544 minimum-resource runs add --active 1 --active 5 --active 10 --active-rounds 3
with --agents 50 --single 0 --cli codex and ONE --arm. Each active cohort performs
verified native file-hash tasks; the final storm still wakes all fifty agents.
The one swap arm is enabled before launch and kept until the agents stop, so
small-RAM runs never have to pull a live cohort out of swap just to start an arm.

Per arm: swap device on -> reclaim every agent (one at a time, like parking) -> drop page cache ->
idle IDLE_SEC (does an idle TUI page itself back?) -> wake --single agents one at a time ->
wake the rest at once (storm) -> settle -> record what is still in swap -> swapoff.
A wake is: type a prompt (t0), see it echoed (agent awake and rendering), press Enter, see the
reply rendered. A probe (`probe`) times fork+exec of /bin/true and timer oversleep every 100 ms
throughout, as the "is the desktop still responsive" signal.

Every measurement is one JSON line in DIR/results.jsonl; `report` reduces them to DIR/summary.json
and a markdown table. Lines to grep: SWAPTIER <kind>.
Codex runs also save native-evidence.tar.gz INSIDE DIR after stopping agents, including
raw histories, dummy data and a population/hash manifest. Copy that file locally and run
`swap-tier.py verify-archive --archive FILE --results DIR/results.jsonl` BEFORE deleting a guest. An incomplete
receipt is evidence loss, never capacity acceptance; the fixed deletion deadline still wins.
Before a cold wake/resize/growth operation, initialize a retained witness explicitly:
  swap-tier.py witness-create --manifest /data/witness.json --pg-config /data/embedded-pg.json \\
      --id unique-run-id --file /data/native-evidence.tar.gz --file /data/corpus/tasks.json
Save that receipt's manifestSha256 and the manifest locally BEFORE the operation. Afterwards use
witness-verify with the same --manifest/--pg-config and --manifest-sha256 from the saved receipt.
Verification never recreates a missing SQL row or file. These commands prove retained bytes only;
application-ready timing, capacity, billed cost and provider teardown are separate acceptance gates.
Keep this instrument under /data/tooling for lifecycle runs: guest /tmp may be cleared on boot.
Use `wait-health --port PORT --expected-sha SHA` for strict API readiness; measure the provider
start request separately so its time is included in cold-wake acceptance.
Run as root (cgroup writes, swapon); the agents run as --user (claude refuses bypass mode as root).
"""
import argparse
import datetime
import errno
import glob
import hashlib
import http.client
import io
import json
import math
import os
import re
import secrets
import shlex
import statistics
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request

SLICE = "swaptier"
CG_ROOT = "/sys/fs/cgroup/swaptier.slice"
TMUX = ["tmux", "-L", "swaptier"]
PORT = 8899
KEY = "swaptier-stub-not-a-real-credential-000000"
IDLE_SEC = int(os.environ.get("SWAPTIER_IDLE_SEC", "60"))
REAL_MODEL = False
CODEX_SESSIONS = {}
WARM_PREFIX = ""
WAKE_TIMEOUT = float(os.environ.get("SWAPTIER_WAKE_TIMEOUT", "300"))


def launch_delay_seconds(env=None):
    """Pause between native terminal launches so a large batch does not stampede the gateway."""
    value = float((env or os.environ).get("SWAPTIER_LAUNCH_DELAY_SEC", "0.15"))
    if not (0 <= value <= 30):
        raise ValueError("SWAPTIER_LAUNCH_DELAY_SEC must be between 0 and 30 seconds")
    return value


LAUNCH_DELAY_SEC = launch_delay_seconds()
HERE = os.path.dirname(os.path.abspath(__file__))


def wait_for_operator_health(ports, timeout=120, interval=0.2, expected_sha=None):
    """A listening socket or successful HTML response is not application readiness."""
    if (not ports or any(type(p) is not int or not 1 <= p <= 65535 for p in ports) or
            not 0 < timeout <= 600 or not 0 < interval <= 10):
        raise ValueError("valid ports and bounded positive health timing are required")
    started = time.monotonic()
    deadline = started + timeout
    attempts = 0
    while time.monotonic() < deadline:
        for port in dict.fromkeys(ports):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            attempts += 1
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health",
                                            timeout=min(1, remaining)) as response:
                    if response.status != 200:
                        continue
                    raw = response.read(65537)
                    if len(raw) > 65536:
                        continue
                    health = json.loads(raw)
                    if (isinstance(health, dict) and health.get("ok") is True and
                            health.get("service") == "papercusp-operator" and
                            (expected_sha is None or health.get("sha") == expected_sha)):
                        return {"ready": True, "port": port, "health": health,
                                "seconds": time.monotonic() - started, "attempts": attempts}
            except (OSError, ValueError, http.client.HTTPException):
                # SSH banners and disconnected non-HTTP sockets must not hide a later valid API.
                continue
        time.sleep(max(0, min(interval, deadline - time.monotonic())))
    return {"ready": False, "seconds": time.monotonic() - started, "attempts": attempts}


def durability_file(path):
    """Hash retained bytes without loading a whole native archive into memory."""
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        before = os.fstat(source.fileno())
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
        after = os.fstat(source.fileno())
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError("durability file changed while hashing")
    return {"path": os.path.abspath(path), "bytes": after.st_size, "sha256": digest.hexdigest()}


def durability_sql(config_path, psql, witness_id, value=None):
    """Only explicit initialization writes; verification is read-only in PostgreSQL too."""
    if not isinstance(witness_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", witness_id):
        raise ValueError("invalid durability witness id")
    with open(config_path) as source:
        config = json.load(source)
    url = urllib.parse.urlsplit(config["url"])
    if url.scheme not in ("postgres", "postgresql") or not url.hostname or not url.path.strip("/"):
        raise ValueError("invalid embedded PostgreSQL configuration")
    env = dict(os.environ, PGHOST=url.hostname, PGPORT=str(url.port or 5432),
               PGUSER=urllib.parse.unquote(url.username or ""),
               PGPASSWORD=urllib.parse.unquote(url.password or ""),
               PGDATABASE=urllib.parse.unquote(url.path[1:]), PGCONNECT_TIMEOUT="5",
               PGOPTIONS="-c statement_timeout=10000 -c default_transaction_read_only=" +
                         ("off" if value is not None else "on"))
    if value is not None:
        if not re.fullmatch(r"[a-f0-9]{64}", value):
            raise ValueError("invalid durability witness value")
        # No upsert: a repeated initialization must fail, never replace the old witness.
        sql = ("BEGIN; CREATE TABLE IF NOT EXISTS public.p544_durability_witness "
               "(id text PRIMARY KEY, value text NOT NULL); "
               f"INSERT INTO public.p544_durability_witness VALUES ('{witness_id}', '{value}'); COMMIT;")
    else:
        sql = ("SELECT current_setting('transaction_read_only'), value "
               f"FROM public.p544_durability_witness WHERE id = '{witness_id}';")
    try:
        result = subprocess.run([psql, "-X", "-A", "-t", "-q", "-F", "\t", "-v", "ON_ERROR_STOP=1", "-c", sql],
                                env=env, capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError("durability witness SQL unavailable") from None
    if result.returncode:
        # Config and provider errors may contain a credential. Never echo subprocess output.
        raise RuntimeError("durability witness SQL failed")
    return result.stdout.strip()


def create_durability_witness(manifest_path, files, config_path, psql, witness_id):
    if os.path.exists(manifest_path):
        raise ValueError("durability manifest already exists")
    if not files or len(set(map(os.path.abspath, files))) != len(files):
        raise ValueError("durability witness requires unique retained files")
    manifest = {"schemaVersion": "swap-tier-durability-witness-v1", "id": witness_id,
                "value": secrets.token_hex(32), "files": [durability_file(p) for p in files]}
    durability_sql(config_path, psql, witness_id, manifest["value"])
    with open(manifest_path, "x") as target:
        json.dump(manifest, target, sort_keys=True)
        target.flush()
        os.fsync(target.fileno())
    return {"created": True, "manifestSha256": durability_file(manifest_path)["sha256"],
            "files": len(files)}


def verify_durability_witness(manifest_path, expected_sha256, config_path, psql):
    with open(manifest_path, "rb") as source:
        raw = source.read()
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha256) or hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("durability manifest hash mismatch")
    manifest = json.loads(raw)
    files = manifest.get("files")
    if (manifest.get("schemaVersion") != "swap-tier-durability-witness-v1" or not isinstance(files, list) or
            not files or not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get("value", "")))):
        raise ValueError("invalid durability manifest")
    paths = [entry.get("path") for entry in files]
    if any(not isinstance(p, str) or not os.path.isabs(p) for p in paths) or len(set(paths)) != len(paths):
        raise ValueError("invalid durability manifest paths")
    for entry in files:
        if durability_file(entry["path"]) != entry:
            raise RuntimeError("retained durability file changed")
    if durability_sql(config_path, psql, manifest.get("id")) != "on\t" + manifest["value"]:
        raise RuntimeError("retained SQL witness missing, changed or not read-only")
    return {"verified": True, "manifestSha256": expected_sha256, "files": len(files), "sqlReadOnly": True}


# ---------------------------------------------------------------- measurement helpers

def read_int(path):
    try:
        with open(path) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def read_kv(path):
    out = {}
    try:
        with open(path) as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    try:
                        out[parts[0].rstrip(":")] = int(parts[1])
                    except ValueError:
                        pass
    except OSError:
        pass
    return out


def cg_path(name):
    return f"{CG_ROOT}/{SLICE}-{name}.scope"


def agent_stats(name):
    cg = cg_path(name)
    st = read_kv(cg + "/memory.stat")
    return {"current": read_int(cg + "/memory.current"), "swap": read_int(cg + "/memory.swap.current"),
            "anon": st.get("anon"), "file": st.get("file"), "majflt": st.get("pgmajfault")}


def host_stats():
    vm = read_kv("/proc/vmstat")
    mi = read_kv("/proc/meminfo")
    out = {"pswpin": vm.get("pswpin"), "pswpout": vm.get("pswpout"), "pgmajfault": vm.get("pgmajfault"),
           "oom_kill": vm.get("oom_kill"),
           "memAvailableKb": mi.get("MemAvailable"), "swapUsedKb": (mi.get("SwapTotal", 0) - mi.get("SwapFree", 0))}
    try:
        with open("/sys/block/zram0/mm_stat") as f:
            mm = f.read().split()
        out["zram"] = {"orig": int(mm[0]), "compr": int(mm[1]), "used": int(mm[2])}
    except (OSError, IndexError, ValueError):
        pass
    return out


def sh(cmd, check=True):
    r = subprocess.run(cmd, text=True, capture_output=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed ({r.returncode}): {r.stderr.strip()}")
    return r


def server_population(expected, root="/sys/fs/cgroup"):
    """Reject a sizing run with missing or additional live Server services.

    Package-wide user-unit activation can start an SSH user's Server outside the
    measured tenant. Count live cgroups, including descendants, rather than
    assuming that the measured cgroup is the whole machine's workload.
    """
    active = []
    for service in glob.glob(os.path.join(root, "user.slice", "user-*.slice", "user@*.service",
                                         "app.slice", "papercusp-server.service")):
        for directory, _dirs, _files in os.walk(service):
            try:
                with open(os.path.join(directory, "cgroup.procs")) as f:
                    live = any(line.strip() for line in f)
            except FileNotFoundError:  # a child cgroup may disappear during enumeration
                continue
            if live:
                active.append(os.path.normpath(service))
                break
    active.sort()
    expected = os.path.normpath(expected)
    if active != [expected]:
        raise RuntimeError(f"server population mismatch: expected {[expected]}, active {active}")
    return {"expected": expected, "active": active, "count": len(active)}


def native_hash_prompt(marker):
    # Hashing still reads the whole file. Printing it first floods native output;
    # a short write_stdin poll can then truncate the only digest we can verify.
    return (f"Dummy benchmark {marker}. Run exactly this shell command: `sha256sum dummy-data.txt`. "
            "Use max_output_tokens=512 for execution and any polling so the full digest remains visible. "
            f"Preserve the file bytes. After the tool succeeds, reply exactly DONE-{marker} with no other text.")


def write(path, value):
    with open(path, "w") as f:
        f.write(value)


class Recorder:
    def __init__(self, out_dir):
        os.makedirs(out_dir, exist_ok=True)
        self.f = open(os.path.join(out_dir, "results.jsonl"), "a")

    def rec(self, kind, **kw):
        row = {"t": time.time(), "kind": kind, **kw}
        self.f.write(json.dumps(row) + "\n")
        self.f.flush()
        print(f"SWAPTIER {kind} {json.dumps(kw)[:400]}", flush=True)


# ---------------------------------------------------------------- tmux / agents

def pane(name, lines=80):
    r = subprocess.run(TMUX + ["capture-pane", "-p", "-t", name, "-S", f"-{lines}"], text=True, capture_output=True)
    return r.stdout if r.returncode == 0 else ""


def type_text(name, text):
    subprocess.run(TMUX + ["send-keys", "-t", name, "-l", text], check=True)


def press_enter(name):
    subprocess.run(TMUX + ["send-keys", "-t", name, "Enter"], check=True)


def codex_config(model, effort, gateway_url, owner, work):
    """Real model traffic uses the existing gateway over a loopback SSH tunnel.

    No upstream credential is copied to the test VM. Keep API authority at the
    original gateway and record model completion separately from input echo.
    """
    if not re.fullmatch(r"http://127\.0\.0\.1:\d+/v1", gateway_url):
        raise ValueError("benchmark gateway must be a loopback SSH tunnel URL")
    if effort not in ("low", "medium", "high"):
        raise ValueError("unsupported reasoning effort")
    q = json.dumps
    return "\n".join([
        f"model = {q(model)}", f"model_reasoning_effort = {q(effort)}",
        'model_provider = "benchmark-gateway"', 'check_for_update_on_startup = false',
        f"[projects.{q(work)}]", 'trust_level = "trusted"',
        '[features]', 'plugins = false', 'auth_elicitation = false',
        '[model_providers.benchmark-gateway]', 'name = "Benchmark gateway tunnel"',
        f"base_url = {q(gateway_url)}", f"model_catalog_url = {q(gateway_url + '/models')}",
        'wire_api = "responses"', 'requires_openai_auth = false',
        'experimental_bearer_token = "papercusp-gateway"',
        'http_headers = { originator = "codex_cli_rs", "x-papercusp-owner" = ' + q(owner) + ' }', "",
    ])


def codex_ready(text, model):
    # The native statusline is configurable and may omit context-left entirely.
    # Require both the selected model and the interactive input, not that setting.
    return model.lower() in text.lower() and "Ask Codex to do anything" in text


def gateway_preflight(gateway_url, owner, rec, catalog=True):
    """Check the same private Codex route used by the agents, including its auth headers.

    A surviving remote listener alone does not prove that an SSH reverse forward
    still reaches the gateway. Record transport failures before launching or
    retrying another expensive batch; never print credentials or response bodies.
    """
    if not re.fullmatch(r"http://127\.0\.0\.1:\d+/v1", gateway_url):
        raise ValueError("benchmark gateway must be a loopback SSH tunnel URL")
    # Catalog refresh can be slow while model requests are active. /healthz
    # checks the transport without refreshing the model catalog; even its 503
    # (for an unrelated provider pool) proves the private route is responding.
    url = gateway_url + "/models" if catalog else gateway_url.removesuffix("/v1") + "/healthz"
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer papercusp-gateway",
        "originator": "codex_cli_rs", "x-papercusp-owner": owner,
    })
    status = None
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status = response.status
            if catalog and status != 200:
                raise RuntimeError(f"gateway returned HTTP {status}")
    except urllib.error.HTTPError as error:
        status = error.code
        if catalog:
            rec.rec("gateway-preflight", success=False, status=status, error=type(error).__name__, catalog=catalog)
            raise RuntimeError("private Codex gateway route is unavailable; refusing a batch") from error
    except (OSError, RuntimeError) as error:
        status = getattr(error, "code", status)
        rec.rec("gateway-preflight", success=False, status=status, error=type(error).__name__, catalog=catalog)
        raise RuntimeError("private Codex gateway route is unavailable; refusing a batch") from error
    rec.rec("gateway-preflight", success=True, status=status, catalog=catalog)


def codex_sandbox_preflight(user, rec):
    """Exercise the native read-only sandbox before launching any model sessions."""
    home = f"/home/{user}"
    cmd = ["setpriv", f"--reuid={user}", f"--regid={user}", "--init-groups", "--",
           "env", "-i", f"HOME={home}", f"USER={user}", f"LOGNAME={user}",
           "PATH=/usr/local/bin:/usr/bin:/bin", "codex", "-c", 'sandbox_mode="read-only"',
           "sandbox", "--", "/bin/echo", "SWAPTIER_SANDBOX_OK"]
    result = subprocess.run(cmd, cwd=home, text=True, capture_output=True, timeout=60)
    if result.returncode or result.stdout.strip() != "SWAPTIER_SANDBOX_OK":
        raise RuntimeError(f"native read-only sandbox preflight failed: {result.stderr.strip()} {result.stdout.strip()}")
    rec.rec("sandbox-preflight", cli="codex", sandbox="read-only", success=True)


def final_reply_text(row):
    payload = row.get("payload", {})
    if (row.get("type") != "response_item" or payload.get("role") != "assistant"
            or payload.get("phase") != "final_answer"):
        return ""
    return "".join(c.get("text", "") for c in payload.get("content", []) if c.get("type") == "output_text")


class NativeTaskError(RuntimeError):
    pass


def codex_record(state, row):
    """Validate native tool evidence, including function and code-mode outputs.

    A model can emit DONE after a failed shell call. The unpredictable file hash
    must actually appear in a tool result during THIS warm turn before admission.
    """
    payload = row.get("payload", {})
    if row.get("type") == "event_msg" and payload.get("type") == "task_complete":
        # A final answer precedes native turn settlement. Sending the next prompt
        # in that window can queue it into the old turn without starting a new one.
        # Only this native event admits the next prompt, never a fixed sleep.
        pending = state.pop("pending_outcome", None)
        marker = state.get("marker")
        if marker and payload.get("error"):
            state.setdefault("outcomes", {})[marker] = "native task failed: " + json.dumps(payload["error"])
        elif pending:
            state.setdefault("outcomes", {})[pending["marker"]] = pending["error"]
        elif marker:
            state.setdefault("outcomes", {})[marker] = "native task completed without an assistant final answer"
        return
    if row.get("type") != "response_item":
        return
    if payload.get("role") == "user":
        text = "".join(c.get("text", "") for c in payload.get("content", []))
        match = re.search(r"(?:WARM-[A-Za-z0-9]+-\d+|WAKE-[A-Za-z0-9]+)", text)
        if match:
            state["marker"], state["tool_ok"] = match.group(), False
    if payload.get("type") in ("function_call_output", "custom_tool_call_output"):
        output = payload.get("output", "")
        text = output if isinstance(output, str) else json.dumps(output)
        expected = state.get("expected_sha256")
        if expected and re.search(r"(?<![0-9a-f])" + re.escape(expected) + r"(?![0-9a-f])", text):
            state["tool_ok"] = True
    text = final_reply_text(row)
    marker = state.get("marker")
    if text and marker:
        error = None
        if "DONE-" + marker not in text:
            error = f"native final answer omitted DONE-{marker}: {text[:240]}"
        elif marker.startswith("WARM-") and not state.get("tool_ok"):
            error = f"{marker} has no successful native file-hash tool result"
        state["pending_outcome"] = {"marker": marker, "error": error}


def codex_completed(name, marker):
    """Read only newly appended native records, not the echoed input prompt.

    The observed Codex 0.162.1 final-answer record distinguishes an assistant
    result from a user prompt or tool command containing the same marker.
    """
    state = CODEX_SESSIONS[name]
    if not state.get("file"):
        paths = [p for p in glob.glob(state["root"] + "/**/*.jsonl", recursive=True)
                 if os.path.getmtime(p) >= state["started"]]
        if not paths:
            return False
        state["file"] = max(paths, key=os.path.getmtime)
        state["offset"] = 0
    with open(state["file"]) as f:
        f.seek(state["offset"])
        while True:
            offset = f.tell()
            line = f.readline()
            if not line or not line.endswith("\n"):
                f.seek(offset)
                break
            try:
                codex_record(state, json.loads(line))
            except ValueError:
                continue
        state["offset"] = f.tell()
    outcomes = state.get("outcomes", {})
    if marker in outcomes and outcomes[marker]:
        raise NativeTaskError(f"{name}: {outcomes[marker]}")
    return marker in outcomes


def stop_agents():
    """Terminal shutdown alone doesn't reap sibling systemd scope processes."""
    sh(TMUX + ["kill-server"], check=False)
    sh(["systemctl", "stop", SLICE + ".slice"], check=False)
    status = sh(["systemctl", "is-active", SLICE + ".slice"], check=False)
    if status.stdout.strip() == "active":
        raise RuntimeError("benchmark agent slice is still active; refusing a duplicate launch")


def saved_codex_session(config, expected_sha256):
    """Resolve an existing native history; never silently resume an empty/wrong home."""
    paths = glob.glob(config + "/sessions/**/*.jsonl", recursive=True)
    if not paths:
        raise ValueError(f"no native session to resume in {config}")
    path = max(paths, key=os.path.getmtime)
    state = {"expected_sha256": expected_sha256}
    session_id = None
    with open(path) as f:
        for line in f:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("type") == "session_meta":
                session_id = row.get("payload", {}).get("id")
            codex_record(state, row)
    verified = sorted(k for k, v in state.get("outcomes", {}).items() if k.startswith("WARM-") and v is None)
    if not session_id or not re.fullmatch(r"[0-9a-f-]{36}", session_id) or not verified:
        raise ValueError(f"native session has no verified warm history in {path}")
    return {"id": session_id, "path": path, "verifiedWarmMarkers": verified}


def native_archive_problems(manifest, files):
    """Recheck archived bytes and CURRENT-run native completions, without the guest."""
    problems = []
    if manifest.get("schemaVersion") != "swap-tier-native-archive-v1":
        return ["unsupported native archive manifest"]
    results = files.get("results.jsonl", b"")
    if hashlib.sha256(results).hexdigest() != manifest.get("resultsSha256"):
        return ["results hash mismatch"]
    rows = [json.loads(line) for line in results.splitlines() if line.strip()]
    starts = [r for r in rows if r.get("kind") == "run-start"]
    if len(starts) != 1 or starts[0].get("cli") != "codex":
        return ["archive requires exactly one Codex run-start"]
    start = starts[0]
    ends = [r["t"] for r in rows if r.get("kind") == "run-end" and r["t"] >= start["t"]]
    if not ends:
        problems.append("run did not complete")
    end = max(ends) if ends else max(r["t"] for r in rows)
    names = [f"a{k}" for k in range(1, start["agents"] + 1)]
    entries = manifest.get("agents", [])
    if sorted(e.get("agent", "") for e in entries) != sorted(names):
        problems.append("assigned native population mismatch")
    for entry in entries:
        name = entry["agent"]
        history = files.get(entry["historyPath"], b"")
        data = files.get(entry["dataPath"], b"")
        if not history or hashlib.sha256(history).hexdigest() != entry["historySha256"]:
            problems.append(f"{name}: missing or changed raw history")
            continue
        if not data or hashlib.sha256(data).hexdigest() != entry["dataSha256"]:
            problems.append(f"{name}: missing or changed task data")
            continue
        state = {"expected_sha256": entry["dataSha256"]}
        for line in history.splitlines():
            row = json.loads(line)
            stamp = row.get("timestamp")
            if stamp and start["t"] <= datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() <= end:
                codex_record(state, row)
        outcomes = state.get("outcomes", {})
        warm = sum(k.startswith("WARM-") and v is None for k, v in outcomes.items())
        wake = sum(k.startswith("WAKE-") and v is None for k, v in outcomes.items())
        tasks = [r for r in rows if r.get("kind") == "wake" and r.get("agent") == name]
        expected_warm = start["warm"] + sum(bool(r.get("nativeToolVerified")) for r in tasks)
        expected_wake = sum(not r.get("nativeToolVerified") for r in tasks)
        if (warm < expected_warm or wake < expected_wake or not tasks or
                any(not r.get("tDone") or r.get("error") for r in tasks)):
            problems.append(f"{name}: current-run native task coverage incomplete")
    return problems


def verify_native_archive(path, results_path):
    # Read members only: never extract paths supplied by an archive.
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        if any(not m.isfile() for m in members) or len({m.name for m in members}) != len(members):
            raise RuntimeError("native archive has non-file or duplicate members")
        files = {m.name: archive.extractfile(m).read() for m in members}
    if "native-manifest.json" not in files:
        raise RuntimeError("native archive missing required population manifest")
    with open(results_path, "rb") as f:
        if files.get("results.jsonl") != f.read():
            raise RuntimeError("native archive belongs to different run results")
    manifest = json.loads(files["native-manifest.json"])
    problems = native_archive_problems(manifest, files)
    if problems:
        raise RuntimeError("native archive incomplete: " + "; ".join(problems))
    with open(path, "rb") as f:
        digest = hashlib.file_digest(f, "sha256").hexdigest()
    return {"verified": True, "archiveSha256": digest, "assignedAgents": len(manifest["agents"]),
            "resultsSha256": manifest["resultsSha256"]}


def archive_native_evidence(out, sessions=None):
    """Make the run output self-contained before a caller can discard the VM."""
    sessions = CODEX_SESSIONS if sessions is None else sessions
    with open(os.path.join(out, "results.jsonl"), "rb") as f:
        files = {"results.jsonl": f.read()}
    manifest = {"schemaVersion": "swap-tier-native-archive-v1", "agents": [],
                "resultsSha256": hashlib.sha256(files["results.jsonl"]).hexdigest()}
    for name, session in sorted(sessions.items()):
        if not re.fullmatch(r"a[1-9][0-9]*", name):
            raise ValueError("invalid native archive agent name")
        history = session.get("file")
        if not history:
            candidates = [p for p in glob.glob(session["root"] + "/**/*.jsonl", recursive=True)
                          if os.path.getmtime(p) >= session["started"]]
            history = max(candidates, key=os.path.getmtime) if candidates else None
        if not history or not os.path.isfile(history):
            continue
        data_path = session["data"]
        if not os.path.isfile(data_path):
            continue
        entry = {"agent": name, "historyPath": f"native/{name}/session.jsonl",
                 "dataPath": f"native/{name}/dummy-data.txt"}
        for key, path in [("history", history), ("data", data_path)]:
            with open(path, "rb") as f:
                content = f.read()
            files[entry[key + "Path"]] = content
            entry[key + "Sha256"] = hashlib.sha256(content).hexdigest()
        manifest["agents"].append(entry)
    manifest["problems"] = native_archive_problems(manifest, files)
    files["native-manifest.json"] = json.dumps(manifest, indent=2).encode()
    path = os.path.join(out, "native-evidence.tar.gz")
    with tarfile.open(path + ".partial", "w:gz") as archive:
        for name, content in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(content)
            member.mode = 0o600
            archive.addfile(member, io.BytesIO(content))
    os.replace(path + ".partial", path)
    return verify_native_archive(path, os.path.join(out, "results.jsonl"))


def start_codex_agents(n, user, rec, model, effort, gateway_url, owner, resume=False):
    home = f"/home/{user}"
    names = [f"a{k}" for k in range(1, n + 1)]
    for name in names:
        work, config = f"{home}/work/{name}", f"{home}/codex-homes/{name}"
        os.makedirs(work, exist_ok=True)
        os.makedirs(config, exist_ok=True)
        # Actual tool output builds CLI context; no synthetic resident-memory padding.
        with open(work + "/dummy-data.txt", "w") as f:
            for k in range(512):
                f.write(hashlib.sha256(f"{name}-{k}".encode()).hexdigest() + "\n")
        with open(config + "/config.toml", "w") as f:
            f.write(codex_config(model, effort, gateway_url, owner, work))
        with open(work + "/dummy-data.txt", "rb") as f:
            expected_sha256 = hashlib.sha256(f.read()).hexdigest()
        saved = saved_codex_session(config, expected_sha256) if resume else None
        if saved:
            rec.rec("native-resume", agent=name, **saved)
        CODEX_SESSIONS[name] = {"root": config + "/sessions", "started": time.time(),
                                "data": work + "/dummy-data.txt",
                                "expected_sha256": expected_sha256}
        sh(["chown", "-R", f"{user}:{user}", work, config])
        env = f"env -i HOME={home} USER={user} LOGNAME={user} CODEX_HOME={config} PATH=/usr/local/bin:/usr/bin:/bin TERM=tmux-256color LANG=C.UTF-8"
        cmd = (f"systemd-run --scope --quiet --unit={SLICE}-{name} --slice={SLICE} -p MemoryAccounting=yes -- "
               f"setpriv --reuid={user} --regid={user} --init-groups -- {env} codex "
               # Independent benchmark sessions must keep their runtime in the
               # measured cgroup. The shared daemon can fail its control-socket
               # bootstrap during a large launch and outlive the measured TUI.
               f"--no-daemon --no-alt-screen --sandbox read-only --ask-for-approval never --model {shlex.quote(model)}")
        if saved:
            cmd += " resume " + saved["id"]
        # Keep exited terminals until their status/output has been recorded. Without
        # this, a launch crash becomes an empty pane followed by a three-minute wait.
        sh(TMUX + ["new-session", "-d", "-s", name, "-x", "160", "-y", "50", "-c", work, cmd,
                   ";", "set-window-option", "-t", name, "remain-on-exit", "on"])
        time.sleep(LAUNCH_DELAY_SEC)
    deadline, pending = time.time() + 180, set(names)
    startup_failures = []
    failure_settle_deadline = None
    while (
        pending
        and time.time() < deadline
        and (failure_settle_deadline is None or time.time() < failure_settle_deadline)
    ):
        # Inspect the whole cohort before deciding. Raising from check_codex_terminal
        # here used to stop at the first dead pane; run()'s finally then destroyed
        # every other terminal before its exit status and screen could be recorded.
        for name in sorted(pending):
            evidence = check_codex_terminal(name, rec)
            if evidence is not None:
                pending.discard(name)
                startup_failures.append(evidence)
                if failure_settle_deadline is None:
                    # A short settling window captures siblings that fail together
                    # during a large native launch without waiting out the full
                    # readiness timeout after the cohort is already invalid.
                    failure_settle_deadline = min(deadline, time.time() + 2)
                continue
            if codex_ready(pane(name), model):
                pending.discard(name)
        time.sleep(0.5)

    if startup_failures:
        pending_evidence = []
        for name in sorted(pending):
            evidence = codex_terminal_evidence(name)
            evidence["reason"] = "sibling-terminal-failed-before-cohort-readiness"
            rec.rec("startup-aborted", **evidence)
            pending_evidence.append(evidence)
        raise RuntimeError(
            "Codex startup cohort failed before warmup: "
            f"{len(startup_failures)} terminal(s) exited or could not be inspected; "
            f"{len(pending_evidence)} other terminal(s) did not reach readiness. "
            "Per-terminal status and pane evidence recorded in results.jsonl."
        )

    if pending:
        for name in sorted(pending):
            rec.rec("startup-timeout", **codex_terminal_evidence(name))
        raise RuntimeError(
            f"Codex agents never ready: {sorted(pending)}; "
            "per-terminal status and pane evidence recorded in results.jsonl"
        )
    rec.rec("agents-started", agents=len(names), cli="codex", model=model, effort=effort, inference="real")
    return names


def codex_terminal_evidence(name):
    state = sh(TMUX + ["display-message", "-p", "-t", name, "#{pane_dead} #{pane_dead_status}"], check=False)
    parts = state.stdout.split()
    return {
        "agent": name,
        "state": state.stdout.strip(),
        "stderr": state.stderr.strip(),
        "pane": pane(name),
        "dead": parts[:1] == ["1"],
        "inspectionFailed": state.returncode != 0,
    }


def check_codex_terminal(name, rec):
    evidence = codex_terminal_evidence(name)
    if evidence["dead"]:
        rec.rec("startup-failed", **evidence)
        return evidence
    if evidence["inspectionFailed"]:
        # A vanished pane or failed tmux query is not proof of a process exit, but
        # it is still unsafe to admit this terminal into the benchmark cohort.
        rec.rec("startup-inspection-failed", **evidence)
        return evidence
    return None


def start_agents(n, user, rec, cli="claude", model="gpt-6-luna", effort="low", gateway_url=None, owner=None, resume=False):
    if cli == "codex":
        if not gateway_url or not owner:
            raise ValueError("real Codex benchmark requires --gateway-url and --owner")
        return start_codex_agents(n, user, rec, model, effort, gateway_url, owner, resume)
    home = f"/home/{user}"
    claude = f"{home}/.local/bin/claude"
    cfg_path = f"{home}/.claude.json"
    cfg = {}
    if os.path.exists(cfg_path):
        with open(cfg_path) as f:
            cfg = json.load(f)
    cfg.update({"hasCompletedOnboarding": True, "theme": "dark", "numStartups": 5, "autoUpdates": False,
                "bypassPermissionsModeAccepted": True,
                "customApiKeyResponses": {"approved": [KEY[-20:]], "rejected": []}})
    projects = cfg.setdefault("projects", {})
    names = [f"a{k}" for k in range(1, n + 1)]
    for name in names:
        work = f"{home}/work/{name}"
        os.makedirs(work, exist_ok=True)
        sh(["chown", f"{user}:{user}", work])
        projects[work] = {"hasTrustDialogAccepted": True, "hasCompletedProjectOnboarding": True, "allowedTools": []}
    with open(cfg_path, "w") as f:
        json.dump(cfg, f)
    os.makedirs(f"{home}/.claude", exist_ok=True)
    with open(f"{home}/.claude/settings.json", "w") as f:
        json.dump({"skipDangerousModePermissionPrompt": True}, f)
    sh(["chown", "-R", f"{user}:{user}", cfg_path, f"{home}/.claude"])
    env = (f"env -i HOME={home} USER={user} LOGNAME={user} PATH={home}/.local/bin:/usr/bin:/bin TERM=tmux-256color "
           f"LANG=C.UTF-8 ANTHROPIC_BASE_URL=http://127.0.0.1:{PORT} ANTHROPIC_API_KEY={KEY} DISABLE_AUTOUPDATER=1 "
           "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1")
    for name in names:
        cmd = (f"systemd-run --scope --quiet --unit={SLICE}-{name} --slice={SLICE} -p MemoryAccounting=yes -- "
               f"setpriv --reuid={user} --regid={user} --init-groups -- {env} {claude} --dangerously-skip-permissions")
        sh(TMUX + ["new-session", "-d", "-s", name, "-x", "160", "-y", "50", "-c", f"{home}/work/{name}", cmd])
        time.sleep(1.0)
    deadline = time.time() + 180
    pending = set(names)
    while pending and time.time() < deadline:
        for name in list(pending):
            if "bypass permissions on" in pane(name):
                pending.discard(name)
        time.sleep(0.5)
    if pending:
        raise RuntimeError(f"agents never became ready: {sorted(pending)}; first pane:\n{pane(sorted(pending)[0])}")
    rec.rec("agents-started", agents=len(names))
    return names


def prompt_all(names, marker_for, prompt_for, timeout, on_done=None):
    """Type a prompt into every agent, press Enter once its echo shows, wait for DONE-<marker>.

    Returns {name: {t0, tEcho, tEnter, tDone}} (None where a step never happened)."""
    # run() authenticates the model route once before launching agents. After
    # that, each native task's completion/error and deadline are authoritative.
    # A separate monitoring request can time out while that route still works;
    # using it as a batch veto discards work without measuring the agents.
    state = {}
    for name in names:
        if REAL_MODEL:
            CODEX_SESSIONS[name].get("outcomes", {}).pop(marker_for(name), None)
        state[name] = {"t0": time.time(), "tEcho": None, "tEnter": None, "tDone": None, "error": None}
        type_text(name, prompt_for(name))
    deadline = time.time() + timeout
    while time.time() < deadline and any(s["tDone"] is None and not s["error"] for s in state.values()):
        # Once submitted, native completion/errors and this batch's deadline are
        # authoritative. A synchronous health probe here both contaminates the
        # timing and can destroy an otherwise live cohort on one slow response.
        for name, s in state.items():
            if s["tDone"] is not None or s["error"]:
                continue
            if s["tEnter"] is None:
                text = pane(name)
                if marker_for(name) in text:
                    s["tEcho"] = time.time()
                    press_enter(name)
                    s["tEnter"] = time.time()
            else:
                try:
                    # Native history owns completion. Repeated tmux captures
                    # here add observer work without providing any evidence.
                    completed = codex_completed(name, marker_for(name)) if REAL_MODEL else "DONE-" + marker_for(name) in pane(name)
                except NativeTaskError as e:
                    s["error"] = str(e)
                    continue
                if completed:
                    s["tDone"] = time.time()
                    if on_done:
                        on_done(name, s)
        time.sleep(0.02)
    return state


def warm(names, rounds, rec, concurrency=None):
    if concurrency is not None and (concurrency < 1 or concurrency > len(names)):
        raise ValueError("warm concurrency must be between 1 and the agent count")
    width = concurrency or len(names)
    for k in range(rounds):
        t0 = time.time()
        missing = names
        # Real models occasionally alter a command/token. Correct only those
        # tasks, record the attempts, and keep already verified agents intact.
        for attempt in range(3):
            # A previous echoed prompt must never admit a retry's Enter key.
            # Keep retry identity inside the alphanumeric agent component so
            # native transcript parsing recognizes the whole unique marker.
            marker = lambda n: f"WARM-{WARM_PREFIX}{n}{'r' + str(attempt) if attempt else ''}-{k}"
            state = {}
            for start in range(0, len(missing), width):
                state.update(prompt_all(missing[start:start + width], marker, lambda n: (
                    native_hash_prompt(marker(n))
                    if REAL_MODEL else f"Please do step {marker(n)} now"), 300))
            missing = [n for n, s in state.items() if s["tDone"] is None]
            if not missing:
                break
            rec.rec("warm-retry", round=k, attempt=attempt + 1, agents=missing,
                    errors={n: state[n].get("error") for n in missing})
        if missing:
            raise RuntimeError(f"warm round {k} never finished for {missing}")
        rec.rec("warm-round", round=k, agents=len(names), seconds=time.time() - t0,
                nativeToolVerified=REAL_MODEL)
    rec.rec("warmed", rounds=rounds, agents={n: agent_stats(n) for n in names})


def stub_request_times(stub_log, marker):
    """Arrival time of the main request for a marker: the one carrying the most messages."""
    best = None
    try:
        with open(stub_log) as f:
            for line in f:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("marker") == marker and (best is None or row.get("messages", 0) >= best.get("messages", 0)):
                    best = row
    except OSError:
        return None
    return best["t"] if best else None


# ---------------------------------------------------------------- swap arms

def parse_arm(spec):
    """`none` | `zram` | `<label>=<block device>`."""
    if spec in ("none", "zram"):
        return {"name": spec, "kind": spec}
    if spec in ("zram:lz4", "zram:lzo-rle", "zram:zstd"):
        return {"name": spec.replace(":", "-"), "kind": "zram", "algorithm": spec.split(":")[1]}
    label, sep, device = spec.partition("=")
    if not sep or not label or not device:
        raise ValueError(f"--arm expects none, zram or <label>=<device>, got '{spec}'")
    arm = {"name": label, "kind": "device", "device": device}
    if "@pc" in label:
        label, pc = label.rsplit("@pc", 1)
        if pc not in ("0", "1", "2", "3"):
            raise ValueError("disk swap page-cluster must be 0..3")
        arm.update(name=label + "-pc" + pc, pageCluster=int(pc))
    match = re.search(r"-batch([1-9]\d*)$", label)
    if match:
        arm["batch"] = int(match.group(1))
    return arm


def swap_off():
    sh(["swapoff", "-a"], check=False)
    if os.path.exists("/sys/block/zram0"):
        sh(["zramctl", "--reset", "/dev/zram0"], check=False)


def configured_swap_devices(path="/proc/swaps"):
    """Read the kernel inventory; Ubuntu's swapon does not support --json."""
    devices = []
    with open(path) as f:
        header = next(f, "").split()
        if header != ["Filename", "Type", "Size", "Used", "Priority"]:
            raise RuntimeError("invalid kernel swap inventory header")
        for line in f:
            fields = line.split()
            if len(fields) != 5:
                raise RuntimeError("invalid kernel swap inventory row")
            name = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m[1], 8)), fields[0])
            devices.append({"name": name, "size": int(fields[2]) * 1024,
                            "prio": int(fields[4])})
    return devices


def active_swap(arm, ram_gb):
    """Validate externally provisioned swap without draining a live Server."""
    devices = configured_swap_devices()
    if arm["kind"] == "none":
        if devices:
            raise RuntimeError("active none arm requires no configured swap")
        return {"device": None, "devices": devices}
    for device in devices:
        name = device["name"]
        if arm["kind"] == "device":
            if os.path.realpath(name) == os.path.realpath(arm["device"]):
                return {"device": name, "devices": devices}
        elif re.fullmatch(r"zram\d+", os.path.basename(name)):
            # swapon's usable size excludes the first page of the device.
            if int(device["size"]) + 4096 < ram_gb * (1 << 30):
                continue
            with open(f"/sys/block/{os.path.basename(name)}/comp_algorithm") as f:
                algorithm = f"[{arm.get('algorithm', 'zstd')}]"
                if algorithm not in f.read().split():
                    continue
            return {"device": name, "devices": devices}
    raise RuntimeError("active swap arm must be configured before starting the Server and benchmark")


def swap_on(arm, ram_gb):
    if arm["kind"] == "none":
        return None
    if arm["kind"] == "zram":
        sh(["modprobe", "zram"])
        dev = sh(["zramctl", "--find", "--size", f"{ram_gb}G", "--algorithm", arm.get("algorithm", "zstd")]).stdout.strip()
        sh(["mkswap", dev])
        sh(["swapon", "-p", "100", dev])
        write("/proc/sys/vm/page-cluster", "0")  # zram: no swap-in readahead (the common zram setting)
        return dev
    sh(["mkswap", "-f", arm["device"]])
    sh(["swapon", "-p", "100", arm["device"]])
    write("/proc/sys/vm/page-cluster", str(arm.get("pageCluster", 3)))
    return arm["device"]


def reclaim(name):
    """Drain one agent's cgroup into swap; returns seconds spent."""
    cg = cg_path(name)
    t0 = time.time()
    for _ in range(8):
        cur = read_int(cg + "/memory.current")
        if cur is None or cur < (4 << 20):
            break
        try:
            write(cg + "/memory.reclaim", str(cur))
        except OSError as e:
            if e.errno != errno.EAGAIN:
                raise
            # EAGAIN: it reclaimed less than asked; one more pass rarely moves more.
            if read_int(cg + "/memory.current") >= cur * 0.95:
                break
    return time.time() - t0


def run_arm(arm, names, single, ram_gb, rec, stub_log, active=None, active_rounds=3,
            swap_ready=False, keep_swap=False):
    if not swap_ready:
        swap_off()
        device = swap_on(arm, ram_gb)
    else:
        device = arm.get("device")
    rec.rec("arm-start", arm=arm["name"], device=device, assignedAgents=len(names),
            host=host_stats(), agents={n: agent_stats(n) for n in names})
    if arm["kind"] != "none":
        rec.rec("phase", arm=arm["name"], phase="reclaim", edge="start")
        for name in names:
            before = agent_stats(name)
            secs = reclaim(name)
            rec.rec("reclaimed", arm=arm["name"], agent=name, seconds=secs, before=before, after=agent_stats(name))
        write("/proc/sys/vm/drop_caches", "1")
        rec.rec("phase", arm=arm["name"], phase="reclaim", edge="end", host=host_stats())
        before_idle = {n: agent_stats(n) for n in names}
        rec.rec("phase", arm=arm["name"], phase="idle", edge="start")
        time.sleep(IDLE_SEC)
        rec.rec("idle", arm=arm["name"], seconds=IDLE_SEC, before=before_idle, after={n: agent_stats(n) for n in names},
                host=host_stats())
        rec.rec("phase", arm=arm["name"], phase="idle", edge="end")
    nonce = f"{re.sub('[^A-Za-z0-9]', '', arm['name'])[:6]}{int(time.time()) % 100000}"

    def wake(group, phase, emit_phase=True, task_round=None):
        pre = {n: agent_stats(n) for n in group}
        host_pre = host_stats()
        # Reuse WARM native evidence validation for real shell work; WAKE remains
        # the separate light model-response burst. Include width/round identity
        # so a previous completion can never satisfy another active round.
        marker = (lambda n: f"WARM-{nonce}c{len(group)}{n}-{task_round}") if task_round is not None else (
            lambda n: f"WAKE-{nonce}{n}")
        if emit_phase:
            rec.rec("phase", arm=arm["name"], phase=phase, edge="start")
        state = prompt_all(group, marker, lambda n: (
            native_hash_prompt(marker(n))
            if task_round is not None else (
                f"Dummy wake task {marker(n)}. Compute 17+25 mentally. Reply exactly DONE-{marker(n)} with no other text."
                if REAL_MODEL else f"Wake up {marker(n)} please")), WAKE_TIMEOUT)
        if emit_phase:
            rec.rec("phase", arm=arm["name"], phase=phase, edge="end")
        time.sleep(2)
        for n in group:
            s = state[n]
            rec.rec("wake", arm=arm["name"], phase=phase, agent=n, **s,
                    concurrentAgents=len(group), assignedAgents=len(names),
                    nativeToolVerified=task_round is not None and s["tDone"] is not None and not s.get("error"),
                    tRequest=stub_request_times(stub_log, marker(n)), pre=pre[n], post=agent_stats(n))
        rec.rec("wake-host", arm=arm["name"], phase=phase, pre=host_pre, post=host_stats())

    for width in active or []:
        for round_index in range(active_rounds):
            wake(names[:width], f"active-{width}", task_round=round_index)
    for n in names[:single]:
        wake([n], "single")
        time.sleep(1)
    storm = names[single:]
    if arm.get("batch"):
        rec.rec("phase", arm=arm["name"], phase="storm", edge="start")
        for offset in range(0, len(storm), arm["batch"]):
            wake(storm[offset:offset + arm["batch"]], "storm", emit_phase=False)
        rec.rec("phase", arm=arm["name"], phase="storm", edge="end")
    else:
        wake(storm, "storm", task_round=active_rounds if active else None)
    time.sleep(20)
    rec.rec("arm-end", arm=arm["name"], host=host_stats(), agents={n: agent_stats(n) for n in names})
    t0 = time.time()
    if not keep_swap:
        swap_off()
        rec.rec("swapoff", arm=arm["name"], seconds=time.time() - t0)


# ---------------------------------------------------------------- disk benchmark

FIO_JOBS = [
    ("randread-4k-qd1", ["--rw=randread", "--bs=4k", "--iodepth=1"]),
    ("randread-4k-qd32", ["--rw=randread", "--bs=4k", "--iodepth=32"]),
    ("randread-32k-qd16", ["--rw=randread", "--bs=32k", "--iodepth=16"]),
    ("randwrite-4k-qd32", ["--rw=randwrite", "--bs=4k", "--iodepth=32"]),
    ("seqread-1m-qd8", ["--rw=read", "--bs=1m", "--iodepth=8"]),
]


def fio_summary(job, fio_json):
    j = fio_json["jobs"][0]
    side = j["read"] if j["read"]["io_bytes"] else j["write"]
    pct = side.get("clat_ns", {}).get("percentile", {})
    return {"job": job, "iops": round(side["iops"]), "mbps": round(side["bw_bytes"] / 1e6, 1),
            "clatP50us": round(pct.get("50.000000", 0) / 1000, 1), "clatP99us": round(pct.get("99.000000", 0) / 1000, 1)}


def bench_disk(device, label, out_dir, runtime):
    rec = Recorder(out_dir)
    base = ["fio", "--name=b", f"--filename={device}", "--ioengine=libaio", "--direct=1", "--size=4G", "--output-format=json"]
    # Prefill the tested region: reads of never-written PD blocks are not a real measurement.
    sh(base + ["--rw=write", "--bs=1m", "--iodepth=16"])
    for job, args in FIO_JOBS:
        r = sh(base + args + ["--time_based", f"--runtime={runtime}"])
        rec.rec("fio", device=label, **fio_summary(job, json.loads(r.stdout)))


# ---------------------------------------------------------------- report

def pctl(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    return xs[min(len(xs) - 1, int(p / 100 * len(xs)))]


def mib(b):
    return None if b is None else round(b / 2**20, 1)


def regained(before, after):
    """Bytes of anonymous memory an agent got back in RAM between two samples.

    Measured as growth of resident anon, never as a drop in swap-used. On a disk swap device
    the kernel keeps a page's swap slot after reading it back (swap cache), so swap-used barely
    moves while the agent pages itself back in: measured 14 Oct 2026, idle agents on pd-ssd
    regained ~1.1 GiB of resident memory while swap-used fell 74 MiB. zram frees the slot on
    read, so there the two agree. Resident growth also counts memory the agent newly allocates;
    the `none` arm (nothing in swap) measures that baseline, about 3 MiB per wake.
    """
    return max(0, (after["anon"] or 0) - (before["anon"] or 0))


def summarize(rows, probe):
    """Reduce results.jsonl rows (+ probe samples [(t, exec_ms, oversleep_ms)]) to per-arm numbers."""
    arms = {}
    phases = {}
    for r in rows:
        a = r.get("arm")
        if a is None:
            continue
        s = arms.setdefault(a, {"arm": a, "reclaimed": [], "wakes": {"single": [], "storm": []}})
        k = r["kind"]
        if k == "arm-start":
            s["device"] = r.get("device")
            s["assignedAgents"] = r.get("assignedAgents")
        elif k == "reclaimed":
            s["reclaimed"].append(r)
        elif k == "idle":
            s["idleRegainedMiB"] = mib(sum(regained(r["before"][n], r["after"][n]) for n in r["before"]))
        elif k == "wake":
            s["wakes"].setdefault(r["phase"], []).append(r)
        elif k == "arm-end":
            s["swapAfterMiB"] = mib(sum(v["swap"] or 0 for v in r["agents"].values()))
            s["residentAfterMiB"] = mib(sum(v["anon"] or 0 for v in r["agents"].values()))
            zr = r["host"].get("zram")
            if zr:
                s["zramEnd"] = zr
        elif k == "phase" and r.get("edge") in ("start", "end"):
            windows = phases.setdefault((a, r["phase"]), [])
            if r["edge"] == "start":
                windows.append({"start": r["t"]})
            elif windows and "end" not in windows[-1]:
                windows[-1]["end"] = r["t"]
        elif k == "phase" and r.get("phase") == "reclaim":
            pass
        if k == "phase" and r.get("phase") == "reclaim" and r.get("edge") == "end":
            zr = r.get("host", {}).get("zram")
            if zr:
                s["zramAfterReclaim"] = {"origMiB": mib(zr["orig"]), "comprMiB": mib(zr["compr"]), "usedMiB": mib(zr["used"]),
                                         "ratio": round(zr["orig"] / zr["used"], 2) if zr["used"] else None}
    out = []
    for a, s in arms.items():
        rc = s["reclaimed"]
        res = {"arm": a, "device": s.get("device"), "assignedAgents": s.get("assignedAgents")}
        if rc:
            swapped = [r["after"]["swap"] or 0 for r in rc]
            res["reclaim"] = {
                "agents": len(rc),
                "beforeMiBPerAgent": mib(statistics.mean(r["before"]["current"] or 0 for r in rc)),
                "swappedMiBPerAgent": mib(statistics.mean(swapped)),
                "residentAfterMiBPerAgent": mib(statistics.mean(r["after"]["current"] or 0 for r in rc)),
                "seconds": round(sum(r["seconds"] for r in rc), 1),
                "swapOutMiBps": round(mib(sum(swapped)) / max(0.001, sum(r["seconds"] for r in rc)), 1),
            }
            res["idleRegainedMiB"] = s.get("idleRegainedMiB")
            res["zram"] = s.get("zramAfterReclaim")
        for ph, ws in s["wakes"].items():
            if not ws:
                continue
            total = [(w["tDone"] - w["t0"]) if w.get("tDone") else None for w in ws]
            echo = [(w["tEcho"] - w["t0"]) if w.get("tEcho") else None for w in ws]
            submit = [(w["tDone"] - w["tEnter"]) if w.get("tDone") and w.get("tEnter") else None for w in ws]
            back = [regained(w["pre"], w["post"]) for w in ws]
            majflt = [max(0, (w["post"]["majflt"] or 0) - (w["pre"]["majflt"] or 0)) for w in ws]
            block = {"agents": len({w["agent"] for w in ws}), "tasks": len(ws),
                     "failed": sum(1 for t in total if t is None),
                     "totalSec": {"p50": _r(pctl(total, 50)), "p90": _r(pctl(total, 90)), "p95": _r(pctl(total, 95)), "max": _r(pctl(total, 100))},
                     "echoSec": {"p50": _r(pctl(echo, 50)), "p95": _r(pctl(echo, 95)), "max": _r(pctl(echo, 100))},
                     "submitToReplySec": {"p50": _r(pctl(submit, 50)), "p95": _r(pctl(submit, 95)), "max": _r(pctl(submit, 100))},
                     "regainedMiBPerAgent": mib(statistics.mean(back)),
                     "majfltPerAgent": round(statistics.mean(majflt))}
            if ph == "storm":
                done = [w["tDone"] for w in ws if w.get("tDone")]
                block["allDoneSec"] = _r(max(done) - min(w["t0"] for w in ws)) if len(done) == len(ws) else None
            windows = phases.get((a, ph), [])
            samples = [p for p in probe if any(w.get("start") is not None and w.get("end") is not None
                                              and w["start"] <= p[0] <= w["end"] for w in windows)]
            if samples:
                block["probeExecMs"] = {"p50": _r(pctl([p[1] for p in samples], 50)), "p95": _r(pctl([p[1] for p in samples], 95)), "p99": _r(pctl([p[1] for p in samples], 99)),
                                        "max": _r(pctl([p[1] for p in samples], 100)), "samples": len(samples)}
            res[ph] = block
        res["swapAfterStormMiB"] = s.get("swapAfterMiB")
        res["residentAfterStormMiB"] = s.get("residentAfterMiB")
        out.append(res)
    return out


def evaluate_native_workload(rows, probe):
    """D-075 native-workload detector over RAW observations, not rounded reports.

    This deliberately does not qualify a VM: cold readiness, retained SQL/files,
    archive custody, exact candidate, provider cleanup and billed costs are separate
    observations. Missing counters/windows stay unknown; failed tasks stay counted.
    """
    gaps, failures, metrics = [], [], {}

    def number(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0

    starts = [r for r in rows if r.get("kind") == "run-start"]
    ends = [r for r in rows if r.get("kind") == "run-end"]
    if len(starts) != 1 or len(ends) != 1:
        gaps.append("one-complete-run-required")
    config = starts[0] if len(starts) == 1 else {}
    if config and (config.get("agents") != 50 or config.get("cli") != "codex" or
                   config.get("inference") != "real" or config.get("single") != 0 or
                   config.get("active") != [1, 5, 10] or config.get("activeRounds") != 3 or
                   not config.get("model") or not config.get("effort") or
                   len(config.get("arms", [])) != 1 or config["arms"][0].get("batch")):
        failures.append("frozen-run-population-or-model-binding")
    arms = [r for r in rows if r.get("kind") == "arm-start"]
    terminal = [r for r in rows if r.get("kind") == "arm-end"]
    if len(arms) != 1 or len(terminal) != 1:
        gaps.append("one-complete-arm-required")
    arm = arms[0].get("arm") if len(arms) == 1 else None
    if arm is None or (config and config.get("arms", [{}])[0].get("name") != arm):
        gaps.append("arm-identity")
    if any(r.get("arm") != arm for r in rows if r.get("kind") in ("wake", "phase", "arm-end")):
        gaps.append("mixed-arm-evidence")
    assigned = arms[0].get("agents", {}) if len(arms) == 1 else {}
    if len(assigned) != 50 or (arms and arms[0].get("assignedAgents") != 50):
        gaps.append("assigned-agent-census")
    if len(terminal) == 1 and (terminal[0].get("arm") != arm or set(terminal[0].get("agents", {})) != set(assigned)):
        gaps.append("terminal-agent-census")
    if any(r.get("error") or r.get("kind") in ("startup-failed", "startup-inspection-failed") for r in rows):
        failures.append("native-failure")
    if starts and ends and number(starts[0].get("t")) and number(ends[0].get("t")):
        if ends[0]["t"] <= starts[0]["t"] or any(
                not number(r.get("t")) or not starts[0]["t"] <= r["t"] <= ends[0]["t"] for r in rows):
            gaps.append("run-clock-or-appended-evidence")
    else:
        gaps.append("run-clock")
    # Host-wide counters cover agent/server OOMs too. Older records lack this
    # detector and cannot be retroactively certified by treating absence as zero.
    hosts = [r.get("host", {}) for r in [config, *terminal]]
    for counter in ("oom_kill", "pgmajfault", "pswpin", "pswpout"):
        values = [h.get(counter) for h in hosts]
        if len(values) != 2 or not all(number(v) and int(v) == v for v in values) or values[1] < values[0]:
            gaps.append("host-counter:" + counter)
        else:
            metrics[counter] = values[1] - values[0]
    if metrics.get("oom_kill", 0) > 0:
        failures.append("oom")
    for phase, width, rounds in [("active-1", 1, 3), ("active-5", 5, 3), ("active-10", 10, 3), ("storm", 50, 1)]:
        ws = [r for r in rows if r.get("kind") == "wake" and r.get("arm") == arm and r.get("phase") == phase]
        windows, pending = [], None
        for r in rows:
            if r.get("kind") != "phase" or r.get("arm") != arm or r.get("phase") != phase:
                continue
            if r.get("edge") == "start" and pending is None and number(r.get("t")):
                pending = r["t"]
            elif r.get("edge") == "end" and pending is not None and number(r.get("t")) and r["t"] > pending:
                windows.append((pending, r["t"]))
                pending = None
            else:
                gaps.append(phase + ":phase-window")
        if pending is not None or len(windows) != rounds or any(a[1] >= b[0] for a, b in zip(windows, windows[1:])):
            gaps.append(phase + ":phase-window")
        if (len(ws) != width * rounds or len({w.get("agent") for w in ws}) != width or
                any(w.get("agent") not in assigned or w.get("assignedAgents") != 50 or
                    w.get("concurrentAgents") != width for w in ws)):
            gaps.append(phase + ":population")
        echo, total = [], []
        for w in ws:
            if w.get("nativeToolVerified") is not True or w.get("error") or w.get("tDone") is None:
                failures.append(phase + ":native-task")
            times = [w.get(k) for k in ("t0", "tEcho", "tEnter", "tDone")]
            if not all(number(t) for t in times) or times != sorted(times):
                gaps.append(phase + ":task-clock")
                continue
            if sum(start <= times[0] <= times[-1] <= end for start, end in windows) != 1:
                gaps.append(phase + ":task-outside-window")
            echo.append(times[1] - times[0])
            total.append(times[3] - times[0])
        # Each round needs exactly the declared unique cohort, not the same
        # agent's completion duplicated to pad the aggregate task count.
        samples = []
        for start, end in windows:
            cohort = [w.get("agent") for w in ws if number(w.get("t0")) and start <= w["t0"] <= end]
            if len(cohort) != width or len(set(cohort)) != width:
                gaps.append(phase + ":round-population")
            observed = [p for p in probe if len(p) == 3 and all(number(v) for v in p) and start <= p[0] <= end]
            if not observed:
                gaps.append(phase + ":probe-window")
            samples.extend(p[1] for p in observed)
        block = {"agents": len({w.get("agent") for w in ws}), "tasks": len(ws),
                 "echoSec": pctl(echo, 95), "taskWallSec": pctl(total, 95), "probeExecMs": pctl(samples, 95)}
        if block["echoSec"] is not None and block["echoSec"] > (3 if phase == "storm" else 1):
            failures.append(phase + ":echo")
        if phase != "storm":
            if block["taskWallSec"] is not None and block["taskWallSec"] > 30:
                failures.append(phase + ":task-wall")
            if block["probeExecMs"] is not None and block["probeExecMs"] > 100:
                failures.append(phase + ":host-exec")
        elif ws and len(total) == len(ws):
            block["allDoneSec"] = max(w["tDone"] for w in ws) - min(w["t0"] for w in ws)
            if block["allDoneSec"] > 120:
                failures.append("storm:all-settled")
        metrics[phase] = block
    return {"scope": "D075-native-workload-only", "qualification": "not-evaluated",
            "status": "fail" if failures else "unknown" if gaps else "pass",
            "gaps": sorted(set(gaps)), "failures": sorted(set(failures)), "metrics": metrics}


def _r(x):
    return None if x is None else round(x, 3)


def read_workload_acceptance(out_dir):
    """Do not silently discard malformed/truncated raw rows as a report may do."""
    try:
        with open(os.path.join(out_dir, "results.jsonl")) as source:
            rows = [json.loads(line) for line in source if line.strip()]
        if any(not isinstance(row, dict) for row in rows):
            raise ValueError("raw rows must be objects")
        return evaluate_native_workload(rows, load_probe(os.path.join(out_dir, "probe.csv")))
    except (OSError, ValueError, TypeError, KeyError, IndexError) as error:
        return {"scope": "D075-native-workload-only", "qualification": "not-evaluated",
                "status": "unknown", "gaps": ["unreadable-raw-evidence:" + type(error).__name__],
                "failures": [], "metrics": {}}


def load_probe(path):
    out = []
    try:
        with open(path) as f:
            for line in f:
                parts = line.strip().split(",")
                if len(parts) == 3:
                    try:
                        out.append((float(parts[0]), float(parts[1]), float(parts[2])))
                    except ValueError:
                        pass
    except OSError:
        pass
    return out


def report(out_dir):
    rows = []
    with open(os.path.join(out_dir, "results.jsonl")) as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    arms = summarize(rows, load_probe(os.path.join(out_dir, "probe.csv")))
    fio = [{k: v for k, v in r.items() if k not in ("t", "kind")} for r in rows if r.get("kind") == "fio"]
    summary = {"arms": arms, "fio": fio}
    with open(os.path.join(out_dir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print("SWAPTIER_SUMMARY " + json.dumps(summary))
    return summary


# ---------------------------------------------------------------- probe

def probe(out_path):
    with open(out_path, "a") as f:
        while True:
            t = time.time()
            subprocess.run(["/bin/true"])
            e = time.time() - t
            s = time.time()
            time.sleep(0.1)
            o = time.time() - s - 0.1
            f.write(f"{t:.3f},{e * 1000:.2f},{o * 1000:.2f}\n")
            f.flush()


# ---------------------------------------------------------------- main

def run(a):
    population = server_population(a.server_cgroup) if getattr(a, "server_cgroup", None) else None
    arms = [parse_arm(s) for s in a.arm]
    # Fail before recorder/probe/agent mutation. Active runs share a live Server;
    # swapoff -a can OOM it even after all benchmark agents have stopped.
    configured_swap = active_swap(arms[0], a.ram_gb) if a.active else None
    if configured_swap:
        arms[0]["device"] = configured_swap["device"]
    global REAL_MODEL, WARM_PREFIX
    REAL_MODEL = a.cli == "codex"
    CODEX_SESSIONS.clear()
    # Resumed JSONL may replay old rounds; only fresh unpredictable markers can
    # admit this run's new verification turn.
    WARM_PREFIX = os.urandom(6).hex() if a.resume_native else ""
    rec = Recorder(a.out)
    if population:
        rec.rec("server-population-preflight", **population)
    if configured_swap:
        rec.rec("active-swap-preflight", **configured_swap)
    stub_log = os.path.join(a.out, "stub.jsonl")
    warm_files = sorted(glob.glob("/usr/lib/python3*/*.py"), key=os.path.getsize, reverse=True)[:16]
    procs = [subprocess.Popen([sys.executable, os.path.abspath(__file__), "probe", "--out", os.path.join(a.out, "probe.csv")])]
    if not REAL_MODEL:
        procs.append(subprocess.Popen([sys.executable, os.path.join(HERE, "swap-tier-stub-api.py"), "--port", str(PORT), "--log", stub_log,
                                     "--warm-files", *warm_files], stdout=open(os.path.join(a.out, "stub.out"), "a"), stderr=subprocess.STDOUT))
    try:
        time.sleep(1)
        warm_width = a.warm_concurrency or (min(a.active) if a.active else a.agents)
        rec.rec("run-start", agents=a.agents, warm=a.warm, warmConcurrency=warm_width,
                resumeNative=a.resume_native,
                single=a.single, active=a.active, activeRounds=a.active_rounds, arms=arms, idleSec=IDLE_SEC,
                kernel=os.uname().release, host=host_stats(), cli=a.cli, model=a.model if REAL_MODEL else None,
                effort=a.effort if REAL_MODEL else None, inference="real" if REAL_MODEL else "stub")
        stop_agents()
        if not a.active:
            swap_off()
        if REAL_MODEL:
            gateway_preflight(a.gateway_url, a.owner, rec)
            codex_sandbox_preflight(a.user, rec)
        names = start_agents(a.agents, a.user, rec, a.cli, a.model, a.effort, a.gateway_url, a.owner, a.resume_native)
        warm(names, a.warm, rec, warm_width)
        for arm in arms:
            run_arm(arm, names, a.single, a.ram_gb, rec, stub_log, active=a.active, active_rounds=a.active_rounds,
                    swap_ready=bool(a.active), keep_swap=bool(a.active))
        rec.rec("run-end")
    finally:
        stop_agents()
        for p in procs:
            p.terminate()
        if not a.active:
            swap_off()
        if REAL_MODEL:
            # Preserve partial evidence on failure too. Never mask the original
            # native error, and never delay mandatory provider deadline deletion.
            failing = sys.exc_info()[0] is not None
            try:
                receipt = archive_native_evidence(a.out)
                print("SWAPTIER native-archive " + json.dumps(receipt), flush=True)
            except Exception as error:
                print("SWAPTIER native-archive-incomplete " + str(error), file=sys.stderr, flush=True)
                if not failing:
                    raise
    report(a.out)


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--out", required=True)
    r.add_argument("--server-cgroup", help="require exactly this one live Server service before launching agents")
    r.add_argument("--agents", type=int, default=24)
    r.add_argument("--warm", type=int, default=8)
    r.add_argument("--warm-concurrency", type=int, help="limit warm-up requests; wake storm still uses all agents")
    r.add_argument("--resume-native", action="store_true", help="resume recorded native sessions, then verify fresh warm turns")
    r.add_argument("--single", type=int, default=8)
    r.add_argument("--active", type=int, action="append", help="active native tool cohort width; repeat for moderate-load scenarios")
    r.add_argument("--active-rounds", type=int, default=3, help="verified tool rounds per active cohort")
    r.add_argument("--ram-gb", type=int, default=16)
    r.add_argument("--user", default="agent")
    r.add_argument("--arm", action="append", required=True)
    r.add_argument("--cli", choices=["claude", "codex"], default="claude")
    r.add_argument("--model", default="gpt-6-luna")
    r.add_argument("--effort", choices=["low", "medium", "high"], default="low")
    r.add_argument("--gateway-url")
    r.add_argument("--owner")
    b = sub.add_parser("bench-disk")
    b.add_argument("--device", required=True)
    b.add_argument("--label", required=True)
    b.add_argument("--out", required=True)
    b.add_argument("--runtime", type=int, default=20)
    p = sub.add_parser("report")
    p.add_argument("--out", required=True)
    p = sub.add_parser("evaluate-workload", help="check raw D075 workload; does not qualify the VM")
    p.add_argument("--out", required=True)
    q = sub.add_parser("probe")
    q.add_argument("--out", required=True)
    v = sub.add_parser("verify-archive")
    v.add_argument("--archive", required=True, help="locally copied native-evidence.tar.gz; required before teardown")
    v.add_argument("--results", required=True, help="locally copied results.jsonl from the exact run being torn down")
    h = sub.add_parser("wait-health", help="wait for strict operator API health, tolerating non-HTTP candidates")
    h.add_argument("--port", type=int, action="append", required=True)
    h.add_argument("--timeout", type=float, default=120)
    h.add_argument("--expected-sha")
    for command in ("witness-create", "witness-verify"):
        w = sub.add_parser(command, help="retained file/SQL witness before or after cold wake/disk growth")
        w.add_argument("--manifest", required=True)
        w.add_argument("--pg-config", required=True, help="guest embedded-pg.json; credentials are never printed")
        w.add_argument("--psql", default="/usr/lib/Papercusp Server/sidecar/bin/psql")
        if command == "witness-create":
            w.add_argument("--file", required=True, action="append")
            w.add_argument("--id", required=True)
        else:
            w.add_argument("--manifest-sha256", required=True, help="receipt saved locally BEFORE the lifecycle operation")
    a = ap.parse_args(argv)
    if a.cmd == "run":
        if a.active and (a.cli != "codex" or a.warm < 1 or a.single != 0 or len(a.arm) != 1 or
                         a.active_rounds < 1 or len(set(a.active)) != len(a.active) or
                         any(not 1 <= width <= a.agents for width in a.active) or
                         any(parse_arm(spec).get("batch") for spec in a.arm)):
            ap.error("active cohort requires Codex, fresh warm>=1, --single 0, one unbatched arm, unique widths between 1 and --agents, and positive rounds")
        if a.resume_native and (a.cli != "codex" or a.warm < 1):
            ap.error("--resume-native requires Codex and at least one fresh verified warm round")
        if a.warm_concurrency is not None and not 1 <= a.warm_concurrency <= a.agents:
            ap.error("--warm-concurrency must be between 1 and --agents")
        if a.single >= a.agents:
            ap.error("--single must leave agents for the storm")
        for s in a.arm:
            parse_arm(s)
        run(a)
    elif a.cmd == "bench-disk":
        bench_disk(a.device, a.label, a.out, a.runtime)
    elif a.cmd == "report":
        report(a.out)
    elif a.cmd == "evaluate-workload":
        receipt = read_workload_acceptance(a.out)
        print(json.dumps(receipt))
        return {"pass": 0, "fail": 1, "unknown": 2}[receipt["status"]]
    elif a.cmd == "probe":
        probe(a.out)
    elif a.cmd == "verify-archive":
        print(json.dumps(verify_native_archive(a.archive, a.results)))
    elif a.cmd == "wait-health":
        receipt = wait_for_operator_health(a.port, a.timeout, expected_sha=a.expected_sha)
        print(json.dumps(receipt))
        return 0 if receipt["ready"] else 1
    elif a.cmd == "witness-create":
        print(json.dumps(create_durability_witness(a.manifest, a.file, a.pg_config, a.psql, a.id)))
    elif a.cmd == "witness-verify":
        print(json.dumps(verify_durability_witness(a.manifest, a.manifest_sha256, a.pg_config, a.psql)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
