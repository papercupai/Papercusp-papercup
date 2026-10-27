#!/usr/bin/python3
"""Optional Linux measurement backend for the frozen fair-comparison runner.

Attach BEFORE a caller-minted managed scope exists. Its first attached process
is the launch root; count its process descendants across subsequent scope moves.
No perf/ring buffer is used: synchronous probe updates remain in kernel maps.
Every map failure or foreign attachment permanently invalidates the measurement.
The observer itself lives in a separate, enrolled task.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import sys


def program(path):
    if not path.startswith("/") or len(path.encode()) >= 240 or "\x00" in path:
        raise ValueError("unsafe or overlong cgroup path")
    return r'''
#include <linux/sched.h>
#include <linux/sched/signal.h>
// Name the tail word: C struct-return lowering may leave implicit padding
// different at the attach and fork probes, creating unequal map keys.
struct key_t { u64 start; u32 pid; u32 padding; };
struct path_t { char text[240]; };
struct attachment_t { struct key_t process; struct path_t path; char command[16]; };
struct stats_t {
    u64 writers, version, errors, root_pid, root_start;
    u64 live_processes, peak, births, exits, threads, migrations;
};
BPF_ARRAY(stats, struct stats_t, 1);
BPF_HASH(targets, struct path_t, u8, 1);
BPF_HASH(members, struct key_t, u8, 32768);
BPF_HASH(stamps, u32, u64, 32768);
BPF_HASH(paths, struct path_t, u8, 1024);
BPF_HASH(attachments, u64, struct attachment_t, 32768);
static __always_inline struct key_t key_for(struct task_struct *task) {
    struct task_struct *leader = task->group_leader;
    struct key_t key = {};
    key.pid = task->tgid;
    key.start = leader->start_boottime;
    return key;
}
static __always_inline void fault(struct stats_t *s, u64 flag) {
    __sync_fetch_and_or(&s->errors, flag);
}
static __always_inline void begin(struct stats_t *s) {
    __sync_fetch_and_add(&s->writers, 1);
}
static __always_inline void end(struct stats_t *s) {
    __sync_fetch_and_add(&s->version, 1);
    __sync_fetch_and_sub(&s->writers, 1);
}
static __always_inline void born(struct stats_t *s) {
    u64 count = __sync_add_and_fetch(&s->live_processes, 1);
    __sync_fetch_and_add(&s->births, 1);
    // A plain map ++ or max is racy across CPUs. Linearize the count with an
    // atomic RMW, then monotonically publish that observed count with CAS.
    #pragma unroll
    for (int i = 0; i < 16; i++) {
        u64 old = s->peak;
        if (old >= count) return;
        if (__sync_val_compare_and_swap(&s->peak, old, count) == old) return;
    }
    fault(s, 1);
}
RAW_TRACEPOINT_PROBE(cgroup_attach_task) {
    u32 zero = 0;
    struct stats_t *s = stats.lookup(&zero);
    if (!s) return 0;
    struct task_struct *task = (void *)ctx->args[2];
    struct key_t key = key_for(task);
    struct attachment_t attachment = {};
    int length = bpf_probe_read_kernel_str(attachment.path.text, sizeof(attachment.path.text), (void *)ctx->args[1]);
    // A constant byte-comparison chain causes verifier state explosion on
    // long scope paths. Exact map-key equality has the same custody boundary
    // without making the verifier explore combinations of input bytes.
    volatile int target = targets.lookup(&attachment.path) != 0;
    volatile int member = members.lookup(&key) != 0;
    if (!target && !member) return 0;
    begin(s);
    if (length <= 0 || length >= sizeof(attachment.path.text)) fault(s, 2);
    u8 yes = 1;
    if (paths.update(&attachment.path, &yes)) fault(s, 4);
    u64 attachment_id = 0;
    if (!member && target) {
        u64 previous = __sync_val_compare_and_swap(&s->root_pid, 0, key.pid);
        if (previous == 0) {
            s->root_start = key.start;
            if (members.insert(&key, &yes)) fault(s, 8);
            if (stamps.insert(&key.pid, &key.start)) fault(s, 256);
        } else {
            // Moving an unrelated process into the target is not a fork from
            // our launch root. Do not silently treat it as a descendant.
            fault(s, 16);
        }
    } else {
        attachment_id = __sync_add_and_fetch(&s->migrations, 1);
    }
    // Keep exited, fleeting probe identities as well as live server members.
    // Read the moved task's command, not the manager performing the attach.
    attachment.process = key;
    if (bpf_probe_read_kernel_str(attachment.command, sizeof(attachment.command), task->group_leader->comm) <= 0)
        fault(s, 2048);
    if (attachments.insert(&attachment_id, &attachment)) fault(s, 1024);
    end(s);
    return 0;
}
RAW_TRACEPOINT_PROBE(sched_process_fork) {
    struct task_struct *parent = (void *)ctx->args[0];
    struct key_t parent_key = key_for(parent);
    if (!members.lookup(&parent_key)) return 0;
    u32 zero = 0;
    struct stats_t *s = stats.lookup(&zero);
    if (!s) return 0;
    begin(s);
    struct task_struct *child = (void *)ctx->args[1];
    if (child->pid != child->tgid) {
        __sync_fetch_and_add(&s->threads, 1);
    } else {
        struct key_t key = key_for(child);
        u8 yes = 1;
        if (members.insert(&key, &yes)) fault(s, 32);
        else {
            if (stamps.insert(&key.pid, &key.start)) fault(s, 256);
            born(s);
        }
    }
    end(s);
    return 0;
}
RAW_TRACEPOINT_PROBE(sched_process_exit) {
    struct task_struct *task = (void *)ctx->args[0];
    struct key_t key = key_for(task);
    if (!members.lookup(&key)) return 0;
    u32 zero = 0;
    struct stats_t *s = stats.lookup(&zero);
    if (!s) return 0;
    begin(s);
    // A leader may exit before its other threads. Retire the PROCESS only
    // when the kernel's thread-group live count reaches zero.
    if (task->signal->live.counter != 0) { end(s); return 0; }
    if (stamps.delete(&key.pid)) fault(s, 256);
    if (members.delete(&key)) fault(s, 64);
    else if (key.pid != s->root_pid || key.start != s->root_start) {
        u64 previous = __sync_fetch_and_sub(&s->live_processes, 1);
        if (!previous) fault(s, 128);
        __sync_fetch_and_add(&s->exits, 1);
    }
    end(s);
    return 0;
}
RAW_TRACEPOINT_PROBE(sched_process_exec) {
    struct task_struct *task = (void *)ctx->args[0];
    struct key_t key = key_for(task);
    u64 *start = stamps.lookup(&key.pid);
    if (!start) return 0;
    u32 zero = 0;
    struct stats_t *s = stats.lookup(&zero);
    if (!s) return 0;
    begin(s);
    // Non-leader exec can replace the group leader identity. Refuse that
    // unsupported transition rather than leave a stale, apparently live key.
    if (*start != key.start) fault(s, 512);
    end(s);
    return 0;
}
'''


def snapshot(bpf):
    """A seqlock-style read: no concurrent map writer may overlap the copy.

    Probe writers mark entry before touching membership/counters, increment the
    version before leaving, and use atomic instructions for shared counters.
    A bounded inability to find a stable copy is UNKNOWN, never a zero peak.
    """
    table = bpf["stats"]
    for _ in range(200):
        first = table[ctypes.c_int(0)]
        if first.writers:
            continue
        population = [{"pid": key.pid, "startNs": str(key.start)} for key in bpf["members"].keys()]
        groups = sorted(key.text.decode() for key in bpf["paths"].keys())
        attachments = [{"index": int(index.value), "pid": value.process.pid,
                        "startNs": str(value.process.start),
                        "cgroupPath": value.path.text.decode(),
                        "commandAtAttach": value.command.decode(errors="replace")}
                       for index, value in bpf["attachments"].items()]
        attachments.sort(key=lambda value: value["index"])
        second = table[ctypes.c_int(0)]
        if not second.writers and first.version == second.version:
            fields = {name: int(getattr(second, name)) for name, _ in second._fields_}
            fields["current"] = fields.pop("live_processes")
            # Keep nanoseconds exact across the JSON/JavaScript boundary.
            fields["root_start"] = str(second.root_start)
            return {"schemaVersion": 1, "scope": "launch-root-process-descendants",
                    "clockTicksPerSecond": os.sysconf("SC_CLK_TCK"),
                    "observerUid": os.getuid(),
                    "counters": fields, "members": population, "cgroupPaths": groups,
                    "scopeAttachments": attachments}
    raise RuntimeError("process observer snapshot remained concurrent")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cgroup", required=True)
    args = parser.parse_args()
    # Existing scope means an unobserved prefix, even if currently empty.
    if Path("/sys/fs/cgroup" + args.cgroup).exists():
        raise RuntimeError("observer must attach before the target cgroup exists")
    from bcc import BPF
    bpf = BPF(text=program(args.cgroup), cflags=["-mcpu=v3"])
    try:
        # Arm the exact future scope after every probe is attached and before
        # READY lets the parent create it. Never adopt an already-running root.
        key = bpf["targets"].Key()
        key.text = args.cgroup.encode()
        bpf["targets"][key] = ctypes.c_ubyte(1)
        if Path("/sys/fs/cgroup" + args.cgroup).exists():
            raise RuntimeError("target cgroup appeared before observer READY")
        # Compilation/attachment needs privileges; the protocol and cleanup do
        # not. Keep the registered long-lived payload signalable by its owner.
        if os.geteuid() == 0:
            uid = int(os.environ["SUDO_UID"])
            gid = int(os.environ["SUDO_GID"])
            if uid <= 0 or gid <= 0:
                raise RuntimeError("observer requires an unprivileged invoking owner")
            os.setgroups([])
            os.setgid(gid)
            os.setuid(uid)
        print("FAIR_PROCESS_OBSERVER_READY=1", flush=True)
        for line in sys.stdin:
            request = json.loads(line)
            try:
                if request["method"] != "sample":
                    raise ValueError("unknown observer method")
                reply = {"id": request["id"], "result": snapshot(bpf)}
            except Exception as error:
                reply = {"id": request["id"], "error": str(error)}
            print("FAIR_WORKER_REPLY=" + json.dumps(reply), flush=True)
    finally:
        bpf.cleanup()


if __name__ == "__main__":
    main()
