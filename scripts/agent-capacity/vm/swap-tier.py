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

Per arm: swap device on -> reclaim every agent (one at a time, like parking) -> drop page cache ->
idle IDLE_SEC (does an idle TUI page itself back?) -> wake --single agents one at a time ->
wake the rest at once (storm) -> settle -> record what is still in swap -> swapoff.
A wake is: type a prompt (t0), see it echoed (agent awake and rendering), press Enter, see the
reply rendered. A probe (`probe`) times fork+exec of /bin/true and timer oversleep every 100 ms
throughout, as the "is the desktop still responsive" signal.

Every measurement is one JSON line in DIR/results.jsonl; `report` reduces them to DIR/summary.json
and a markdown table. Lines to grep: SWAPTIER <kind>.
Run as root (cgroup writes, swapon); the agents run as --user (claude refuses bypass mode as root).
"""
import argparse
import errno
import glob
import hashlib
import json
import os
import re
import shlex
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request

SLICE = "swaptier"
CG_ROOT = "/sys/fs/cgroup/swaptier.slice"
TMUX = ["tmux", "-L", "swaptier"]
PORT = 8899
KEY = "swaptier-stub-not-a-real-credential-000000"
IDLE_SEC = int(os.environ.get("SWAPTIER_IDLE_SEC", "60"))
REAL_MODEL = False
CODEX_SESSIONS = {}
GATEWAY_CHECK = None
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
    while pending and time.time() < deadline:
        for name in list(pending):
            check_codex_terminal(name, rec)
            text = pane(name)
            if codex_ready(text, model):
                pending.discard(name)
        time.sleep(0.5)
    if pending:
        for name in sorted(pending):
            rec.rec("startup-timeout", agent=name, pane=pane(name))
        raise RuntimeError(f"Codex agents never ready: {sorted(pending)}; first pane: {pane(sorted(pending)[0])}")
    rec.rec("agents-started", agents=len(names), cli="codex", model=model, effort=effort, inference="real")
    return names


def check_codex_terminal(name, rec):
    state = sh(TMUX + ["display-message", "-p", "-t", name, "#{pane_dead} #{pane_dead_status}"], check=False)
    if state.returncode or state.stdout.split()[:1] == ["1"]:
        evidence = {"agent": name, "state": state.stdout.strip(), "stderr": state.stderr.strip(), "pane": pane(name)}
        rec.rec("startup-failed", **evidence)
        raise RuntimeError(f"Codex terminal exited before readiness: {json.dumps(evidence)}")


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
    if GATEWAY_CHECK:
        GATEWAY_CHECK()
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
            text = pane(name)
            if s["tEnter"] is None:
                if marker_for(name) in text:
                    s["tEcho"] = time.time()
                    press_enter(name)
                    s["tEnter"] = time.time()
            else:
                try:
                    completed = codex_completed(name, marker_for(name)) if REAL_MODEL else "DONE-" + marker_for(name) in text
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
                    f"Dummy benchmark {marker(n)}. Run exactly this shell command: `cat dummy-data.txt; sha256sum dummy-data.txt`. "
                    f"Preserve the file bytes. After the tool succeeds, reply exactly DONE-{marker(n)} with no other text."
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


def run_arm(arm, names, single, ram_gb, rec, stub_log):
    swap_off()
    device = swap_on(arm, ram_gb)
    rec.rec("arm-start", arm=arm["name"], device=device, host=host_stats(), agents={n: agent_stats(n) for n in names})
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

    def wake(group, phase, emit_phase=True):
        pre = {n: agent_stats(n) for n in group}
        host_pre = host_stats()
        if emit_phase:
            rec.rec("phase", arm=arm["name"], phase=phase, edge="start")
        state = prompt_all(group, lambda n: f"WAKE-{nonce}{n}", lambda n: (
            f"Dummy wake task WAKE-{nonce}{n}. Compute 17+25 mentally. Reply exactly DONE-WAKE-{nonce}{n} with no other text."
            if REAL_MODEL else f"Wake up WAKE-{nonce}{n} please"), WAKE_TIMEOUT)
        if emit_phase:
            rec.rec("phase", arm=arm["name"], phase=phase, edge="end")
        time.sleep(2)
        for n in group:
            s = state[n]
            rec.rec("wake", arm=arm["name"], phase=phase, agent=n, **s,
                    tRequest=stub_request_times(stub_log, f"WAKE-{nonce}{n}"), pre=pre[n], post=agent_stats(n))
        rec.rec("wake-host", arm=arm["name"], phase=phase, pre=host_pre, post=host_stats())

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
        wake(storm, "storm")
    time.sleep(20)
    rec.rec("arm-end", arm=arm["name"], host=host_stats(), agents={n: agent_stats(n) for n in names})
    t0 = time.time()
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
        elif k == "reclaimed":
            s["reclaimed"].append(r)
        elif k == "idle":
            s["idleRegainedMiB"] = mib(sum(regained(r["before"][n], r["after"][n]) for n in r["before"]))
        elif k == "wake":
            s["wakes"][r["phase"]].append(r)
        elif k == "arm-end":
            s["swapAfterMiB"] = mib(sum(v["swap"] or 0 for v in r["agents"].values()))
            s["residentAfterMiB"] = mib(sum(v["anon"] or 0 for v in r["agents"].values()))
            zr = r["host"].get("zram")
            if zr:
                s["zramEnd"] = zr
        elif k == "phase" and r.get("edge") in ("start", "end"):
            phases.setdefault((a, r["phase"]), {})[r["edge"]] = r["t"]
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
        res = {"arm": a, "device": s.get("device")}
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
        for ph in ("single", "storm"):
            ws = s["wakes"][ph]
            if not ws:
                continue
            total = [(w["tDone"] - w["t0"]) if w.get("tDone") else None for w in ws]
            echo = [(w["tEcho"] - w["t0"]) if w.get("tEcho") else None for w in ws]
            submit = [(w["tDone"] - w["tEnter"]) if w.get("tDone") and w.get("tEnter") else None for w in ws]
            back = [regained(w["pre"], w["post"]) for w in ws]
            majflt = [max(0, (w["post"]["majflt"] or 0) - (w["pre"]["majflt"] or 0)) for w in ws]
            block = {"agents": len(ws), "failed": sum(1 for t in total if t is None),
                     "totalSec": {"p50": _r(pctl(total, 50)), "p90": _r(pctl(total, 90)), "max": _r(pctl(total, 100))},
                     "echoSec": {"p50": _r(pctl(echo, 50)), "max": _r(pctl(echo, 100))},
                     "submitToReplySec": {"p50": _r(pctl(submit, 50)), "max": _r(pctl(submit, 100))},
                     "regainedMiBPerAgent": mib(statistics.mean(back)),
                     "majfltPerAgent": round(statistics.mean(majflt))}
            if ph == "storm":
                done = [w["tDone"] for w in ws if w.get("tDone")]
                block["allDoneSec"] = _r(max(done) - min(w["t0"] for w in ws)) if len(done) == len(ws) else None
            win = phases.get((a, ph), {})
            samples = [p for p in probe if win.get("start") is not None and win.get("end") is not None and win["start"] <= p[0] <= win["end"]]
            if samples:
                block["probeExecMs"] = {"p50": _r(pctl([p[1] for p in samples], 50)), "p99": _r(pctl([p[1] for p in samples], 99)),
                                        "max": _r(pctl([p[1] for p in samples], 100)), "samples": len(samples)}
            res[ph] = block
        res["swapAfterStormMiB"] = s.get("swapAfterMiB")
        res["residentAfterStormMiB"] = s.get("residentAfterMiB")
        out.append(res)
    return out


def _r(x):
    return None if x is None else round(x, 3)


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
    global REAL_MODEL, GATEWAY_CHECK, WARM_PREFIX
    REAL_MODEL = a.cli == "codex"
    # Resumed JSONL may replay old rounds; only fresh unpredictable markers can
    # admit this run's new verification turn.
    WARM_PREFIX = os.urandom(6).hex() if a.resume_native else ""
    rec = Recorder(a.out)
    GATEWAY_CHECK = (lambda: gateway_preflight(a.gateway_url, a.owner, rec, catalog=False)) if REAL_MODEL else None
    arms = [parse_arm(s) for s in a.arm]
    stub_log = os.path.join(a.out, "stub.jsonl")
    warm_files = sorted(glob.glob("/usr/lib/python3*/*.py"), key=os.path.getsize, reverse=True)[:16]
    procs = [subprocess.Popen([sys.executable, os.path.abspath(__file__), "probe", "--out", os.path.join(a.out, "probe.csv")])]
    if not REAL_MODEL:
        procs.append(subprocess.Popen([sys.executable, os.path.join(HERE, "swap-tier-stub-api.py"), "--port", str(PORT), "--log", stub_log,
                                     "--warm-files", *warm_files], stdout=open(os.path.join(a.out, "stub.out"), "a"), stderr=subprocess.STDOUT))
    try:
        time.sleep(1)
        swap_off()
        rec.rec("run-start", agents=a.agents, warm=a.warm, warmConcurrency=a.warm_concurrency or a.agents,
                resumeNative=a.resume_native,
                single=a.single, arms=arms, idleSec=IDLE_SEC,
                kernel=os.uname().release, host=host_stats(), cli=a.cli, model=a.model if REAL_MODEL else None,
                effort=a.effort if REAL_MODEL else None, inference="real" if REAL_MODEL else "stub")
        stop_agents()
        if REAL_MODEL:
            gateway_preflight(a.gateway_url, a.owner, rec)
            codex_sandbox_preflight(a.user, rec)
        names = start_agents(a.agents, a.user, rec, a.cli, a.model, a.effort, a.gateway_url, a.owner, a.resume_native)
        warm(names, a.warm, rec, a.warm_concurrency)
        for arm in arms:
            run_arm(arm, names, a.single, a.ram_gb, rec, stub_log)
        rec.rec("run-end")
    finally:
        stop_agents()
        for p in procs:
            p.terminate()
        swap_off()
    report(a.out)


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--out", required=True)
    r.add_argument("--agents", type=int, default=24)
    r.add_argument("--warm", type=int, default=8)
    r.add_argument("--warm-concurrency", type=int, help="limit warm-up requests; wake storm still uses all agents")
    r.add_argument("--resume-native", action="store_true", help="resume recorded native sessions, then verify fresh warm turns")
    r.add_argument("--single", type=int, default=8)
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
    q = sub.add_parser("probe")
    q.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if a.cmd == "run":
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
    elif a.cmd == "probe":
        probe(a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
