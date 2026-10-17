#!/usr/bin/env python3
"""Read-only kernel iterators and regular-file leases for retention.

One JSON request per line; a new pair of iterator FDs scans ALL file descriptors
and working directories for each request. Programs/maps survive only in this
worker's FDs. No bpffs pins, tracing subscriptions or event cache. Regular-file
effects may additionally hold an explicit POSIX file lease until the caller
releases it; unsupported or incomplete evidence fails closed.
Unsupported hosts and any incomplete measurement return complete=false.
"""
import ctypes as C
import errno
import fcntl
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import time


_active_lease = None
_lease_break_requested = False
_lease_signal_installed = False


def _lease_signal(_signum, _frame):
    # F_SETLEASE notifies this process when another process attempts a
    # conflicting open. Keep the worker alive so the caller can finish its
    # bounded effect and release the lease explicitly.
    global _lease_break_requested
    _lease_break_requested = True


try:
    signal.signal(signal.SIGIO, _lease_signal)
    _lease_signal_installed = True
except (AttributeError, OSError):
    # request_file_lease reports the unsupported signal path as an incomplete
    # lease instead of silently treating the lease as proof.
    pass


class Config(C.Structure):
    _fields_ = [(name, C.c_uint64) for name in
                ("device", "inode", "directory", "caller", "cwd_device", "cwd_inode", "caller_start_ticks", "tick_ns")]


class Stats(C.Structure):
    _fields_ = [(name, C.c_uint64) for name in
                ("files", "tasks", "failures", "fd_end", "cwd_end", "caller_seen")]


def kernel_device(device):
    major, minor = os.major(device), os.minor(device)
    if major >= 1 << 12 or minor >= 1 << 20:
        raise ValueError("device identity outside kernel dev_t range")
    return (major << 20) | minor


def reject_nested_mounts(path, mountinfo):
    # Dentry parents stop at mount roots. A full proc walk is required when
    # another mount occurs inside a candidate directory (including bind mounts).
    prefix = os.path.realpath(path).rstrip("/") + "/"
    for line in mountinfo.splitlines():
        fields = line.split()
        if len(fields) < 7 or " - " not in line:
            raise ValueError("malformed mount coverage evidence")
        mounted = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), fields[4])
        if mounted.startswith(prefix):
            raise ValueError("nested mount requires full proc holder scan")


def request_config(request):
    if not isinstance(request, dict) or set(request) != {"path", "caller", "control"}:
        raise ValueError("require exactly path, caller and control")
    path, caller, control = request["path"], request["caller"], request["control"]
    if (not isinstance(path, str) or not isinstance(control, str) or
            not path.startswith("/") or not control.startswith("/") or
            os.path.normpath(path) != path or os.path.normpath(control) != control or
            len(path) > 4096 or len(control) > 4096 or "\x00" in path + control or
            type(caller) is not int or caller <= 0 or caller > 2 ** 31 - 1):
        raise ValueError("invalid literal path or original caller")
    ids = re.search(r"^NSpid:\s*(.+)$", Path("/proc/self/status").read_text(), re.M)
    if not ids or len(ids.group(1).split()) != 1:
        raise ValueError("host PID namespace unavailable")
    if (os.readlink("/proc/self/ns/pid") != os.readlink("/proc/1/ns/pid") or
            os.readlink(f"/proc/{caller}/ns/pid") != os.readlink("/proc/self/ns/pid") or
            os.readlink(f"/proc/{caller}/ns/mnt") != os.readlink("/proc/self/ns/mnt")):
        raise ValueError("original caller namespace control mismatch")
    target, cwd = os.lstat(path), os.stat(control)
    if not (stat.S_ISREG(target.st_mode) or stat.S_ISDIR(target.st_mode)):
        raise ValueError("candidate is not a plain file or directory")
    if stat.S_ISDIR(target.st_mode):
        reject_nested_mounts(path, Path("/proc/self/mountinfo").read_text())
    if not stat.S_ISDIR(cwd.st_mode):
        raise ValueError("original caller control is not a directory")
    current_cwd = os.stat(f"/proc/{caller}/cwd")
    if (current_cwd.st_dev, current_cwd.st_ino) != (cwd.st_dev, cwd.st_ino):
        raise ValueError("original caller cwd identity mismatch")
    ticks = os.sysconf("SC_CLK_TCK")
    if ticks <= 0 or 1_000_000_000 % ticks:
        raise ValueError("unsupported process start-time scale")
    # /proc stat fields start after the final ')' of the arbitrary comm string.
    caller_start = int(Path(f"/proc/{caller}/stat").read_text().rsplit(")", 1)[1].split()[19])
    return Config(kernel_device(target.st_dev), target.st_ino,
                  int(stat.S_ISDIR(target.st_mode)), caller,
                  kernel_device(cwd.st_dev), cwd.st_ino, caller_start, 1_000_000_000 // ticks)


def _lease_request_config(request):
    required = {"operation", "path", "caller", "control", "dev", "ino", "newestWriteMs", "uid", "gid"}
    if not isinstance(request, dict) or set(request) != required or request["operation"] != "lease-acquire":
        raise ValueError("require exact regular-file lease acquire request")
    # Reuse the scan request's namespace, caller-cwd and literal-path checks.
    config = request_config({key: request[key] for key in ("path", "caller", "control")})
    if config.directory != 0:
        raise ValueError("regular-file lease requires a plain file")
    if (type(request["dev"]) is not int or request["dev"] <= 0 or
            type(request["ino"]) is not int or request["ino"] <= 0 or
            type(request["uid"]) is not int or request["uid"] < 0 or
            type(request["gid"]) is not int or request["gid"] < 0 or
            type(request["newestWriteMs"]) not in (int, float) or
            not math.isfinite(float(request["newestWriteMs"]))):
        raise ValueError("invalid regular-file lease identity")
    return config


def _same_lease_identity(st, request):
    newest = max(st.st_mtime_ns, st.st_ctime_ns) / 1_000_000
    return (stat.S_ISREG(st.st_mode) and st.st_dev == request["dev"] and
            st.st_ino == request["ino"] and st.st_uid == request["uid"] and
            st.st_gid == request["gid"] and
            abs(newest - float(request["newestWriteMs"])) <= 0.001)


def request_file_lease(request):
    """Acquire a write lease and retain its FD until lease_release is called.

    The descriptor is opened with O_NOFOLLOW and the path is revalidated after
    F_SETLEASE. A write lease makes a conflicting open fail with EAGAIN while
    this managed worker remains alive, so the caller can unlink or dry-run the
    exact inode without another host-wide holder census.
    """
    global _active_lease, _lease_break_requested
    if _active_lease is not None:
        raise ValueError("regular-file lease already held")
    _lease_request_config(request)
    if (not _lease_signal_installed or not hasattr(fcntl, "F_SETLEASE") or
            not hasattr(fcntl, "F_GETLEASE")):
        raise OSError(errno.ENOTSUP, "file leases unavailable")
    flags = os.O_RDWR | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(request["path"], flags)
    locked = False
    try:
        before = os.fstat(fd)
        if not _same_lease_identity(before, request):
            raise ValueError("regular-file lease identity changed before acquire")
        if hasattr(fcntl, "F_SETOWN"):
            fcntl.fcntl(fd, fcntl.F_SETOWN, os.getpid())
        fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_WRLCK)
        locked = True
        if fcntl.fcntl(fd, fcntl.F_GETLEASE) != fcntl.F_WRLCK:
            raise OSError(errno.EIO, "write lease was not installed")
        after = os.fstat(fd)
        path_after = os.lstat(request["path"])
        if not _same_lease_identity(after, request) or not _same_lease_identity(path_after, request):
            raise ValueError("regular-file lease identity changed after acquire")
        _lease_break_requested = False
        token = secrets.token_hex(16)
        _active_lease = {"fd": fd, "token": token}
        return {"complete": True, "lease": {"token": token, "type": "write"},
                "diagnostics": {"backend": "fcntl-file-lease", "identityStable": True}}
    except BaseException:
        if locked:
            try:
                fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
            except OSError:
                pass
        os.close(fd)
        raise


def release_file_lease(request):
    """Release the currently held lease; repeated release is rejected."""
    global _active_lease, _lease_break_requested
    if (not isinstance(request, dict) or set(request) != {"operation", "token"} or
            request["operation"] != "lease-release" or not isinstance(request["token"], str)):
        raise ValueError("require exact regular-file lease release request")
    lease = _active_lease
    if lease is None or request["token"] != lease["token"]:
        raise ValueError("regular-file lease token mismatch")
    _active_lease = None
    try:
        fcntl.fcntl(lease["fd"], fcntl.F_SETLEASE, fcntl.F_UNLCK)
    finally:
        os.close(lease["fd"])
    broken = _lease_break_requested
    _lease_break_requested = False
    return {"complete": not broken, "released": True,
            "diagnostics": {"backend": "fcntl-file-lease", "breakRequested": broken}}


def complete_stats(stats):
    return (stats.files > 0 and stats.tasks > 0 and stats.failures == 0 and
            stats.fd_end == 1 and stats.cwd_end == 1 and stats.caller_seen > 0)


class KernelScan:
    def __init__(self):
        self.object, self.links = None, []
        self.library = C.CDLL("libbpf.so.1", use_errno=True)
        signatures = {
            "bpf_object__open_file": ([C.c_char_p, C.c_void_p], C.c_void_p),
            "bpf_object__load": ([C.c_void_p], C.c_int),
            "bpf_object__close": ([C.c_void_p], None),
            "bpf_object__find_program_by_name": ([C.c_void_p, C.c_char_p], C.c_void_p),
            "bpf_program__attach_iter": ([C.c_void_p, C.c_void_p], C.c_void_p),
            "bpf_link__fd": ([C.c_void_p], C.c_int),
            "bpf_link__destroy": ([C.c_void_p], C.c_int),
            "bpf_iter_create": ([C.c_int], C.c_int),
            "libbpf_get_error": ([C.c_void_p], C.c_long),
            "bpf_object__find_map_fd_by_name": ([C.c_void_p, C.c_char_p], C.c_int),
            "bpf_map_update_elem": ([C.c_int, C.c_void_p, C.c_void_p, C.c_uint64], C.c_int),
            "bpf_map_lookup_elem": ([C.c_int, C.c_void_p, C.c_void_p], C.c_int),
            "bpf_map_delete_elem": ([C.c_int, C.c_void_p], C.c_int),
            "bpf_map_get_next_key": ([C.c_int, C.c_void_p, C.c_void_p], C.c_int),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.library, name)
            function.argtypes, function.restype = arguments, result
        compiler = next((shutil.which(x) for x in
                         ("clang-19", "clang-18", "clang") if shutil.which(x)), None)
        if not compiler:
            raise RuntimeError("BPF compiler unavailable")
        try:
            with tempfile.TemporaryDirectory(prefix="papercusp-holder-bpf-") as temp:
                object_path = str(Path(temp) / "holders.o")
                source = str(Path(__file__).with_name("disk-reclaim-holder.bpf.c"))
                built = subprocess.run([compiler, "-g", "-O2", "-target", "bpf", "-c", source,
                                        "-o", object_path], capture_output=True, timeout=30)
                if built.returncode:
                    raise RuntimeError("BPF compile failed: " + built.stderr.decode(errors="replace")[-1000:])
                self.object = self.pointer(self.library.bpf_object__open_file(os.fsencode(object_path), None))
                self.result(self.library.bpf_object__load(self.object), "BPF load")
            for name in ("scan_files", "scan_cwds"):
                program = self.pointer(self.library.bpf_object__find_program_by_name(self.object, name.encode()))
                self.links.append(self.pointer(self.library.bpf_program__attach_iter(program, None)))
            self.maps = {}
            for name in ("config", "stats", "holders"):
                fd = self.library.bpf_object__find_map_fd_by_name(self.object, name.encode())
                self.result(fd, "BPF map lookup")
                self.maps[name] = fd
        except BaseException:
            self.close()
            raise

    def pointer(self, pointer):
        error = self.library.libbpf_get_error(pointer)
        if not pointer or error:
            raise RuntimeError(f"BPF pointer error {error or C.get_errno()}")
        return pointer

    @staticmethod
    def result(result, operation):
        if result < 0:
            raise RuntimeError(f"{operation} failed: {result}/{C.get_errno()}")
        return result

    def close(self):
        for link in reversed(self.links):
            self.library.bpf_link__destroy(link)
        self.links = []
        if self.object:
            self.library.bpf_object__close(self.object)
            self.object = None

    def keys(self):
        keys, previous = [], None
        for _ in range(16385):
            key = C.c_uint32()
            status = self.library.bpf_map_get_next_key(self.maps["holders"],
                                                     C.byref(previous) if previous else None, C.byref(key))
            if status < 0:
                if C.get_errno() != 2:
                    raise RuntimeError("holder map enumeration failed")
                return keys
            keys.append(key.value)
            previous = key
        raise RuntimeError("holder map enumeration did not reach EOF")

    def scan(self, request):
        started = time.monotonic()
        mounts = Path("/proc/self/mountinfo").read_bytes()
        config = request_config(request)
        for value in self.keys():
            key = C.c_uint32(value)
            self.result(self.library.bpf_map_delete_elem(self.maps["holders"], C.byref(key)), "clear holders")
        zero, stats = C.c_uint32(0), Stats()
        for name, value in (("config", config), ("stats", stats)):
            self.result(self.library.bpf_map_update_elem(self.maps[name], C.byref(zero), C.byref(value), 0), "reset " + name)
        for link in self.links:
            fd = self.result(self.library.bpf_iter_create(self.library.bpf_link__fd(link)), "fresh iterator")
            try:
                # Even empty output is read to EOF; a failed/truncated read raises.
                while os.read(fd, 65536):
                    pass
            finally:
                os.close(fd)
        self.result(self.library.bpf_map_lookup_elem(self.maps["stats"], C.byref(zero), C.byref(stats)), "read stats")
        pids = sorted(self.keys())
        # Re-check both namespace/caller and candidate identities after the walk.
        after = request_config(request)
        identity_stable = (bytes(after) == bytes(config) and
                           Path("/proc/self/mountinfo").read_bytes() == mounts)
        complete = complete_stats(stats) and identity_stable
        return {"complete": complete,
                "byPath": [[request["path"], [str(pid) for pid in pids]]] if pids else [],
                "diagnostics": {"backend": "kernel-iterators", "elapsedMs": round((time.monotonic() - started) * 1000),
                                "descriptorsScanned": stats.files, "processesScanned": stats.tasks,
                                "readFailures": stats.failures, "fdEnd": stats.fd_end, "cwdEnd": stats.cwd_end,
                                "callerSeen": stats.caller_seen, "identityStable": identity_stable}}


def main():
    scanner, initialization_error = None, None
    try:
        for line in sys.stdin:
            operation = None
            try:
                request = json.loads(line)
                operation = request.get("operation") if isinstance(request, dict) else None
                if operation == "lease-acquire":
                    result = request_file_lease(request)
                elif operation == "lease-release":
                    result = release_file_lease(request)
                else:
                    # Reject malformed callers before allocating kernel resources.
                    request_config(request)
                    if _active_lease is not None:
                        raise RuntimeError("holder scan unavailable while regular-file lease is held")
                    if initialization_error:
                        raise RuntimeError(initialization_error)
                    if scanner is None:
                        try:
                            scanner = KernelScan()
                        except Exception as error:
                            initialization_error = str(error)
                            raise
                    result = scanner.scan(request)
            except Exception as error:
                result = {"complete": False, "byPath": [],
                          "diagnostics": {"backend": "fcntl-file-lease" if operation in ("lease-acquire", "lease-release") else "kernel-iterators",
                                           "reason": str(error)[:1000]}}
            print(json.dumps(result), flush=True)
    finally:
        if _active_lease is not None:
            try:
                release_file_lease({"operation": "lease-release", "token": _active_lease["token"]})
            except Exception:
                pass
        if scanner:
            scanner.close()


if __name__ == "__main__":
    main()
