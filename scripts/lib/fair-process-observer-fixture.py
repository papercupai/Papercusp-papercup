#!/usr/bin/python3
"""Controlled payload used by the maintained fair-comparison integration test."""
import json
import os
import sys
import threading
import ctypes


children = []
release = threading.Event()
threads = []


def command(request):
    global threads
    op = request["op"]
    if op == "threads":
        threads = [threading.Thread(target=release.wait) for _ in range(5)]
        for thread in threads:
            thread.start()
    elif op == "unthread":
        release.set()
        for thread in threads:
            thread.join()
        threads = []
        release.clear()
    elif op == "fleeting":
        for _ in range(7):
            pid = os.fork()
            if pid == 0:
                os._exit(0)
            os.waitpid(pid, 0)
    elif op == "child":
        read, write = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(write)
            os.read(read, 1)
            os._exit(0)
        os.close(read)
        children.append((pid, write))
        return {"pid": pid}
    elif op == "group-child":
        read, write = os.pipe()
        pid = os.fork()
        if pid == 0:
            os.close(write)
            def survivor():
                os.read(read, 1)
            thread = threading.Thread(target=survivor)
            thread.start()
            # Exit only the group leader, keeping the other thread alive.
            ctypes.CDLL(None).pthread_exit(None)
            raise RuntimeError("pthread_exit returned")
        os.close(read)
        children.append((pid, write))
        return {"pid": pid}
    elif op == "retire":
        pid, write = children.pop()
        os.write(write, b"x")
        os.close(write)
        os.waitpid(pid, 0)
    elif op == "close":
        release.set()
        for thread in threads:
            thread.join()
    else:
        raise ValueError("unknown fixture operation")
    return {"pid": os.getpid()}


print(json.dumps({"ready": True, "pid": os.getpid()}), flush=True)
try:
    for line in sys.stdin:
        request = json.loads(line)
        result = command(request)
        print(json.dumps(result), flush=True)
        if request["op"] == "close":
            break
finally:
    release.set()
    for pid, write in children:
        os.close(write)
        os.waitpid(pid, 0)
