#!/usr/bin/env python3
"""Per-tenant footprint of a tenant-density.sh run (plan agent-capacity-and-cost-gcp-2026-09-30, P-011 /
D-045). Moved from .papercusp/scratch/p011/analyze-final.py by WI-10006497. That copy hard-coded one
run's tenant names, its idle-unload split and its step timestamps; this one reads them from the run.

Usage: tenant-density-analyze.py <evidence dir> [--run-log <tenant-density run.log>] [--group NAME=t1,t2 ...]
  <evidence dir>  the unpacked ev.tgz: fp-<tenant>.jsonl (sample-footprint.py) and host.log (host-sampler.sh)
  --run-log       adds one STEP line per STEP_END the driver printed (host MemAvailable after each step)
  --group         adds a GROUP_MEAN line over the named tenants, e.g. --group unload-off=pct2 to compare a
                  tenant started with a different TENANT_ENV_<name> against the rest

Output, one fact per line (key=value, GiB and cores):
  TENANT name=.. life_min=.. mem_gib=.. anon_gib=.. file_gib=.. shmem_gib=.. kernel_gib=.. peak_gib=..
         serve_anon_gib=.. life_cores=.. tail_cores=.. settle_min=<n|none> settled=<0|1>
  SETTLED_MEAN n=.. mem_gib=.. anon_gib=.. serve_anon_gib=..   (settled = last-10-min CPU < SETTLED_CORES)
  GROUP_MEAN name=.. n=.. mem_gib=.. anon_gib=.. serve_anon_gib=..
  CLASS name=.. mean_anon_gib=.. n=..                         (top 10 process classes over settled tenants)
  HOST samples=.. first_avail_gib=.. min_avail_gib=.. last_avail_gib=.. max_load1=..
  STEP K=.. memAvailableGiB=..
  TOTAL tenants=.. mem_gib=..                                 (sum of each tenant's last cgroup memory)
Exit: 0 analysed · 2 usage, or no fp-*.jsonl sample in the evidence dir.
"""
import json
import os
import re
import sys

GIB = 1024 ** 3
SETTLED_CORES = 0.15  # a tenant whose last 10 min average under this is past its boot/backfill burst
SETTLE_CORES = 0.1    # settle point: first sample after which a 5-min window averages under this
TAIL_SEC = 600
SETTLE_WINDOW_SEC = 300


USAGE = "tenant-density-analyze.py <evidence dir> [--run-log <run.log>] [--group NAME=t1,t2 ...]"


def usage(msg):
    print(f"USAGE: {msg}\n  {USAGE}", file=sys.stderr)
    sys.exit(2)


def parse_args(argv):
    if not argv:
        usage("missing evidence dir")
    ev, run_log, groups = None, None, []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--run-log" and i + 1 < len(argv):
            run_log = argv[i + 1]
            i += 2
        elif a == "--group" and i + 1 < len(argv) and "=" in argv[i + 1]:
            name, members = argv[i + 1].split("=", 1)
            groups.append((name, [m for m in members.split(",") if m]))
            i += 2
        elif a.startswith("--"):
            usage(f"unknown or incomplete option {a}")
        elif ev is None:
            ev = a
            i += 1
        else:
            usage(f"unexpected argument {a}")
    if ev is None or not os.path.isdir(ev):
        usage(f"evidence dir {ev} is not a directory")
    return ev, run_log, groups


def read_samples(path):
    samples = []
    with open(path) as f:
        for line in f:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if isinstance(o, dict) and "t" in o and isinstance(o.get("cg"), dict) and "cpu_usec" in o["cg"]:
                samples.append(o)
    return samples


def cores(a, b):
    dt = b["t"] - a["t"]
    return (b["cg"]["cpu_usec"] - a["cg"]["cpu_usec"]) / 1e6 / dt if dt > 0 else 0.0


def tenant_row(name, samples):
    first, last = samples[0], samples[-1]
    tail = [s for s in samples if s["t"] >= last["t"] - TAIL_SEC]
    settle = None
    for i, s in enumerate(samples):
        win = [x for x in samples[i:] if x["t"] <= s["t"] + SETTLE_WINDOW_SEC]
        if len(win) > 1 and cores(win[0], win[-1]) < SETTLE_CORES:
            settle = (s["t"] - first["t"]) / 60
            break
    serve = max([p.get("anon_kb", 0) for p in last.get("procs", []) if p.get("cls") == "node:serve.mjs"] or [0])
    classes = {}
    for p in last.get("procs", []):
        c = p.get("cls") or p.get("comm") or "?"
        classes[c] = classes.get(c, 0) + p.get("anon_kb", 0) * 1024
    cg = last["cg"]
    tail_cores = cores(tail[0], tail[-1]) if len(tail) > 1 else 0.0
    return dict(
        name=name, life_min=(last["t"] - first["t"]) / 60,
        mem=cg.get("mem", 0) / GIB, anon=cg.get("anon", 0) / GIB, file=cg.get("file", 0) / GIB,
        shmem=cg.get("shmem", 0) / GIB, kernel=cg.get("kernel", 0) / GIB,
        peak=max(s["cg"].get("mem", 0) for s in samples) / GIB, serve=serve * 1024 / GIB,
        life_cores=cores(first, last), tail_cores=tail_cores, settle=settle,
        settled=tail_cores < SETTLED_CORES, classes=classes)


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")


def tenant_order(name):
    m = re.match(r"^(\D*)(\d+)$", name)
    return (m.group(1), int(m.group(2)), "") if m else (name, 0, name)


def group_line(label, key, rows):
    return (f"{label}{key} n={len(rows)} mem_gib={mean([r['mem'] for r in rows]):.2f} "
            f"anon_gib={mean([r['anon'] for r in rows]):.2f} serve_anon_gib={mean([r['serve'] for r in rows]):.2f}")


def main(argv):
    ev, run_log, groups = parse_args(argv)
    rows = []
    for fn in sorted(os.listdir(ev)):
        m = re.match(r"^fp-(.+)\.jsonl$", fn)
        if not m:
            continue
        samples = read_samples(os.path.join(ev, fn))
        if samples:
            rows.append(tenant_row(m.group(1), samples))
    if not rows:
        usage(f"no fp-*.jsonl samples in {ev}")
    rows.sort(key=lambda r: tenant_order(r["name"]))

    for r in rows:
        settle = "none" if r["settle"] is None else f"{r['settle']:.0f}"
        print(f"TENANT name={r['name']} life_min={r['life_min']:.0f} mem_gib={r['mem']:.2f} anon_gib={r['anon']:.2f} "
              f"file_gib={r['file']:.2f} shmem_gib={r['shmem']:.2f} kernel_gib={r['kernel']:.2f} "
              f"peak_gib={r['peak']:.2f} serve_anon_gib={r['serve']:.2f} life_cores={r['life_cores']:.2f} "
              f"tail_cores={r['tail_cores']:.2f} settle_min={settle} settled={int(r['settled'])}")

    settled = [r for r in rows if r["settled"]]
    print(group_line("SETTLED_MEAN", "", settled))
    by_name = {r["name"]: r for r in rows}
    for name, members in groups:
        print(group_line("GROUP_MEAN", f" name={name}", [by_name[m] for m in members if m in by_name]))

    agg = {}
    for r in settled:
        for c, v in r["classes"].items():
            agg.setdefault(c, []).append(v / GIB)
    for c, vs in sorted(agg.items(), key=lambda kv: (-mean(kv[1]), kv[0]))[:10]:
        print(f"CLASS name={c} mean_anon_gib={mean(vs):.3f} n={len(vs)}")

    host_log = os.path.join(ev, "host.log")
    host = []
    if os.path.exists(host_log):
        with open(host_log) as f:
            for line in f:
                m = re.match(r"^\S+ .*MemAvailable:=(\d+).*load=([\d.]+)", line)
                if m:
                    host.append((int(m.group(1)) * 1024 / GIB, float(m.group(2))))
    if host:
        print(f"HOST samples={len(host)} first_avail_gib={host[0][0]:.2f} min_avail_gib={min(h[0] for h in host):.2f} "
              f"last_avail_gib={host[-1][0]:.2f} max_load1={max(h[1] for h in host):.2f}")
    else:
        print("HOST samples=0")

    if run_log:
        with open(run_log) as f:
            for line in f:
                m = re.match(r"^STEP_END K=(\d+) memAvailableGiB=(\S+)", line)
                if m:
                    print(f"STEP K={m.group(1)} memAvailableGiB={m.group(2)}")

    print(f"TOTAL tenants={len(rows)} mem_gib={sum(r['mem'] for r in rows):.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
