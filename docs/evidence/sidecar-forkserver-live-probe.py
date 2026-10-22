#!/usr/bin/env python3
"""Measure the live bg-host sidecar and its forkserver without exposing trace bytes."""
import datetime
import hashlib
import json
import re
import signal
import subprocess
import tempfile
import time
from pathlib import Path

TRACE_WINDOW_SECONDS = 3
MAX_TRACE_WINDOW_SECONDS = 3.1  # 100 ms scheduling tolerance, never a longer denominator.


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def summarize_trace(raw):
    lines = raw.decode(errors='replace').splitlines()
    calls = [line for line in lines if re.search(r'\b(?:clone|clone3|fork|vfork)\(', line)]
    reads = [line for line in lines if re.search(r'\bread\(', line)]
    durations = [float(match.group(1)) for line in calls
                 for match in [re.search(r'<([\d.]+)>$', line)] if match]
    read_durations = [float(match.group(1)) for line in reads
                      for match in [re.search(r'<([\d.]+)>$', line)] if match]
    return {
        'forkCallCount': len(calls), 'forkSeconds': sum(durations),
        'readSeconds': sum(read_durations),
        'unmeasuredCallCount': sum(not re.search(r'<([\d.]+)>$', line) for line in calls + reads),
        'traceLineCount': len(lines),
        'instrumentErrors': [line[:200] for line in lines
                             if line.startswith(('strace:', 'sudo:'))],
    }


GIT_SYNC_MARKER = 'PAPERCUSP_GIT_SYNC_PUSH=1'
GIT_PROGRESS_COUNTERS = ('cpuTicks', 'rchar', 'wchar', 'syscr', 'syscw')


def trace_instrument_available(traces, attached):
    # Only the sidecar's read/fork duration enters the blocking budget. A
    # forkserver waiting in an unfinished IPC read is normal, not missing
    # timing for the measured sidecar. Its trace still must be present/error-free.
    return attached and bool(traces) and all(
        not trace['instrumentErrors'] and trace['traceLineCount'] > 0
        and (trace['label'] != 'sidecar' or trace['unmeasuredCallCount'] == 0)
        and trace.get('coverage', {}).get('attachedThroughWindow') is True
        and trace['coverage'].get('aliveAtWindowEnd') is True
        and trace['coverage'].get('tracerIdentityAtStart')
        == trace['coverage'].get('tracerIdentityAtEnd')
        and bool(trace['coverage'].get('tracerIdentityAtStart'))
        and (trace['coverage'].get('exitCode') == 0
             or (trace['coverage'].get('stopRequested') is True
                 and trace['coverage'].get('exitCode') == -signal.SIGINT))
        for trace in traces)


def attached_tracer_identities(jobs, proc_root=Path('/proc')):
    """A live sudo wrapper alone does not prove its strace still owns the target."""
    identities = {}
    try:
        for label, pid, _, _, process in jobs:
            if process.poll() is not None:
                return None
            tracer = int(next(line.split(':', 1)[1]
                              for line in (proc_root / str(pid) / 'status').read_text().splitlines()
                              if line.startswith('TracerPid:')))
            if tracer <= 0:
                return None
            ticks = (proc_root / str(tracer) / 'stat').read_text().rsplit(')', 1)[1].split()[19]
            identities[label] = f'{tracer}:{ticks}'
    except (OSError, ValueError, StopIteration, IndexError):
        return None
    return identities or None


def read_git_sync_samples(forkservers, window_start, proc_root=Path('/proc')):
    """Read only marked Git children of the traced forkserver; never emit env/argv."""
    samples = []
    for parent in forkservers:
        try:
            children = (proc_root / str(parent) / 'task' / str(parent) / 'children').read_text().split()
        except OSError:
            continue
        for pid_text in children:
            entry = proc_root / pid_text
            try:
                fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
                if int(fields[1]) != parent or (entry / 'exe').resolve().name != 'git':
                    continue
                if GIT_SYNC_MARKER.encode() not in (entry / 'environ').read_bytes().split(b'\0'):
                    continue
                io = dict(line.split(':', 1) for line in (entry / 'io').read_text().splitlines())
                samples.append({
                    'pid': int(pid_text), 'parentPid': parent, 'startTicks': fields[19],
                    'atWindowSeconds': time.monotonic() - window_start,
                    'marker': GIT_SYNC_MARKER, 'cpuTicks': int(fields[11]) + int(fields[12]),
                    **{key: int(io[key]) for key in GIT_PROGRESS_COUNTERS[1:]},
                })
            except (OSError, ValueError, IndexError, KeyError):
                continue
    return samples


def git_sync_progress(before, after, window_seconds):
    return (before['marker'] == after['marker'] == GIT_SYNC_MARKER
            and all(before[key] == after[key] for key in ('pid', 'parentPid', 'startTicks'))
            and 0 <= before['atWindowSeconds'] < after['atWindowSeconds'] <= window_seconds
            and all(after[key] >= before[key] >= 0 for key in GIT_PROGRESS_COUNTERS)
            and any(after[key] > before[key] for key in GIT_PROGRESS_COUNTERS))


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
    if len(forkservers) != 1:
        raise RuntimeError(f'Expected one stable live forkserver, found {forkservers}')
    jobs = []
    traces = []
    witness = None
    first_git_samples = {}
    traced_before = None
    traced_after = None
    attached = False
    trace_continuous = False
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
        # Popen returning is not proof that sudo/strace has attached yet.
        # Start the workload-witness clock only after every target is traced.
        attach_deadline = time.monotonic() + 2
        while time.monotonic() < attach_deadline:
            traced_before = attached_tracer_identities(jobs)
            attached = traced_before is not None
            if attached:
                break
            time.sleep(0.01)
        window_start = time.monotonic()
        trace_continuous = attached
        while time.monotonic() - window_start < TRACE_WINDOW_SECONDS:
            if attached_tracer_identities(jobs) != traced_before:
                trace_continuous = False
            for sample in read_git_sync_samples(forkservers, window_start):
                identity = (sample['pid'], sample['parentPid'], sample['startTicks'])
                before = first_git_samples.setdefault(identity, sample)
                if witness is None and git_sync_progress(before, sample, TRACE_WINDOW_SECONDS):
                    witness = {'before': before, 'after': sample}
            time.sleep(0.01)
        window_seconds = time.monotonic() - window_start
        traced_after = attached_tracer_identities(jobs)
        trace_continuous = (trace_continuous and traced_after == traced_before
                            and TRACE_WINDOW_SECONDS <= window_seconds <= MAX_TRACE_WINDOW_SECONDS)
    finally:
        for label, pid, path, output, process in jobs:
            stop_requested = process.poll() is None
            if stop_requested:
                process.send_signal(signal.SIGINT)
            exit_code = process.wait(timeout=5)
            output.close()
            raw = path.read_bytes()
            traces.append({
                'label': label, 'pid': pid, 'startTicks': rows[pid]['startTicks'],
                **summarize_trace(raw),
                'coverage': {
                    'attachedThroughWindow': trace_continuous,
                    'aliveAtWindowEnd': traced_after is not None,
                    'tracerIdentityAtStart': (traced_before or {}).get(label),
                    'tracerIdentityAtEnd': (traced_after or {}).get(label),
                    'exitCode': exit_code, 'stopRequested': stop_requested,
                },
                'rawEvidence': str(path), 'rawSha256': hashlib.sha256(raw).hexdigest(),
            })
    after = int(subprocess.check_output([
        'systemctl', '--user', 'show', 'papercusp-bg-host.service',
        '-p', 'MainPID', '--value',
    ], text=True).strip())
    main = next(trace for trace in traces if trace['label'] == 'sidecar')
    identities_stable = after == root
    for trace in traces:
        try:
            current_ticks = Path(f"/proc/{trace['pid']}/stat").read_text().rsplit(')', 1)[1].split()[19]
            identities_stable = identities_stable and current_ticks == trace['startTicks']
        except (OSError, IndexError):
            identities_stable = False
    assertions = [
        {'id': 'stable-live-runtime', 'passed': identities_stable,
         'evidence': f'bg-host MainPID before={root}, after={after}; sidecar={sidecar}.'},
        {'id': 'trace-instrument-available',
         'passed': trace_instrument_available(traces, attached),
         'evidence': json.dumps([{k: t[k] for k in ('label', 'traceLineCount', 'instrumentErrors', 'unmeasuredCallCount')} for t in traces])},
        {'id': 'forkserver-positive-control',
         'passed': any(t['label'] == 'forkserver' and t['forkCallCount'] > 0 for t in traces),
         'evidence': json.dumps([{k: t[k] for k in ('label', 'pid', 'forkCallCount')} for t in traces])},
        {'id': 'git-sync-overlap-progress', 'passed': witness is not None,
         'evidence': json.dumps(witness) if witness else 'No marked git-sync Git child made measurable progress within the trace window; workload unverified.'},
        {'id': 'sidecar-no-child-forks',
         'passed': main['forkCallCount'] == 0,
         'evidence': f"sidecar={sidecar}, windowSeconds={window_seconds:.6f}, forkCalls={main['forkCallCount']}, forkSeconds={main['forkSeconds']}."},
        {'id': 'sidecar-fork-and-read-budget',
         'passed': (main['forkSeconds'] + main['readSeconds']) / window_seconds < 0.05,
         'evidence': f"All read time conservatively bounds exec-wait reads: forkSeconds={main['forkSeconds']}, readSeconds={main['readSeconds']}, windowSeconds={window_seconds:.6f}; sum/window must be below0.05."},
    ]
    return {
        'schemaVersion': 1, 'kind': 'operational-test-evidence',
        'name': 'Live sidecar forks are delegated to its forkserver',
        'framework': 'operational',
        'command': ['python3', 'docs/evidence/sidecar-forkserver-live-probe.py'],
        'startedAt': started, 'finishedAt': now(),
        'exitCode': 0 if all(a['passed'] for a in assertions) else 1,
        'summary': 'Three-second live bg-host trace with forkserver activity and marked git-sync child CPU/I/O progress overlapping the trace.',
        'assertions': assertions, 'traces': traces, 'windowSeconds': window_seconds,
        'traceAttachedBeforeWindow': attached,
        'gitSyncWitness': witness,
        'sidecarBlockedPercent': 100 * (main['forkSeconds'] + main['readSeconds']) / window_seconds,
        'runtime': {'bgHostPid': root, 'sidecarPid': sidecar, 'forkserverPids': forkservers},
        'limitations': [
            'Fork-related syscall counts include failed clone3 attempts, not only created children.',
            'Every sidecar read duration is counted as an upper bound on exec-wait reads; unrelated reads can make this check fail conservatively.',
            'This checks fork plus read blocking, not total event-loop or admission latency.',
            'Compare admission distributions only at similar sidecar ages.',
        ],
    }


if __name__ == '__main__':
    result = measure()
    print(json.dumps(result, indent=2))
    raise SystemExit(result['exitCode'])
