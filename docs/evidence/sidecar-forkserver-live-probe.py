#!/usr/bin/env python3
"""Measure the live bg-host sidecar and its forkserver without exposing trace bytes."""
import datetime
import hashlib
import json
import os
import re
import signal
import subprocess
import tempfile
import time
from pathlib import Path


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def measure():
    started = now()
    root = int(subprocess.check_output([
        "systemctl", "--user", "show", "papercusp-bg-host.service",
        "-p", "MainPID", "--value",
    ], text=True).strip())
    rows = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / 'stat').read_text()
            fields = stat[stat.rfind(')') + 2:].split()
            rows[int(entry.name)] = {
                'ppid': int(fields[1]),
                'startTicks': fields[19],
                'args': (entry / 'cmdline').read_bytes().split(b'\0'),
            }
        except (OSError, ValueError, IndexError):
            continue

    def descendant(pid):
        for _ in range(16):
            if pid == root:
                return True
            pid = rows.get(pid, {}).get('ppid', 0)
            if not pid:
                return False
        return False

    sidecars = [pid for pid, row in rows.items()
                if descendant(pid) and len(row['args']) > 1
                and row['args'][1].endswith(b'/spawner-sidecar.mjs')]
    if len(sidecars) != 1:
        raise RuntimeError(f'Expected one live bg-host sidecar, found {sidecars}')
    sidecar = sidecars[0]
    forkservers = [pid for pid, row in rows.items()
                   if row['ppid'] == sidecar and b'-e' in row['args']]
    jobs = []
    traces = []
    directory = Path(tempfile.mkdtemp(prefix='sidecar-forkserver-live-'))
    try:
        for label, pid in [('sidecar', sidecar)] + [('forkserver', p) for p in forkservers]:
            path = directory / (label + '.strace')
            output = path.open('w')
            process = subprocess.Popen([
                'sudo', '-n', 'strace', '-qq', '-tt', '-T', '-e',
                'trace=clone,clone3,fork,vfork,read', '-p', str(pid),
            ], stdout=subprocess.DEVNULL, stderr=output)
            jobs.append((label, pid, path, output, process))
        window_start = time.monotonic()
        time.sleep(3)
        window_seconds = time.monotonic() - window_start
    finally:
        for label, pid, path, output, process in jobs:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
            process.wait(timeout=5)
            output.close()
            raw = path.read_bytes()
            lines = raw.decode(errors='replace').splitlines()
            calls = [line for line in lines if re.search(r'\b(?:clone|clone3|fork|vfork)\(', line)]
            durations = [float(match.group(1)) for line in calls
                         for match in [re.search(r'<([\d.]+)>$', line)] if match]
            traces.append({
                'label': label, 'pid': pid, 'startTicks': rows[pid]['startTicks'],
                'forkCallCount': len(calls), 'forkSeconds': sum(durations),
                'traceLineCount': len(lines),
                'instrumentErrors': [line[:200] for line in lines
                                     if line.startswith(('strace:', 'sudo:'))],
                'rawEvidence': str(path), 'rawSha256': hashlib.sha256(raw).hexdigest(),
            })
    after = int(subprocess.check_output([
        'systemctl', '--user', 'show', 'papercusp-bg-host.service',
        '-p', 'MainPID', '--value',
    ], text=True).strip())
    main = next(trace for trace in traces if trace['label'] == 'sidecar')
    assertions = [
        {'id': 'stable-live-runtime', 'passed': after == root,
         'evidence': f'bg-host MainPID before={root}, after={after}; sidecar={sidecar}.'},
        {'id': 'trace-instrument-available',
         'passed': bool(traces) and all(not t['instrumentErrors'] and t['traceLineCount'] > 0 for t in traces),
         'evidence': json.dumps([{k: t[k] for k in ('label', 'traceLineCount', 'instrumentErrors')} for t in traces])},
        {'id': 'forkserver-positive-control',
         'passed': any(t['label'] == 'forkserver' and t['forkCallCount'] > 0 for t in traces),
         'evidence': json.dumps([{k: t[k] for k in ('label', 'pid', 'forkCallCount')} for t in traces])},
        {'id': 'sidecar-no-child-forks',
         'passed': main['forkCallCount'] == 0,
         'evidence': f"sidecar={sidecar}, windowSeconds={window_seconds:.6f}, forkCalls={main['forkCallCount']}, forkSeconds={main['forkSeconds']}."},
    ]
    return {
        'schemaVersion': 1, 'kind': 'operational-test-evidence',
        'name': 'Live sidecar forks are delegated to its forkserver',
        'framework': 'operational',
        'command': ['python3', 'docs/evidence/sidecar-forkserver-live-probe.py'],
        'startedAt': started, 'finishedAt': now(),
        'exitCode': 0 if all(a['passed'] for a in assertions) else 1,
        'summary': 'Three-second live bg-host trace; forkserver syscall activity is the positive control for zero sidecar fork calls.',
        'assertions': assertions, 'traces': traces, 'windowSeconds': window_seconds,
        'runtime': {'bgHostPid': root, 'sidecarPid': sidecar, 'forkserverPids': forkservers},
        'limitations': [
            'Fork-related syscall counts include failed clone3 attempts, not only created children.',
            'This checks fork blocking, not total event-loop or admission latency.',
            'Compare admission distributions only at similar sidecar ages.',
        ],
    }


if __name__ == '__main__':
    result = measure()
    print(json.dumps(result, indent=2))
    raise SystemExit(result['exitCode'])
