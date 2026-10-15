#!/usr/bin/env python3
"""Scripted stand-in for the Anthropic Messages API, for the swap-tier test (WI-10005475).

Real interactive `claude` TUIs run against it on a throwaway VM, so the VM holds no credentials
and every reply is instant: the time a woken agent takes is the agent's own (paging its memory
back), never the model's.

Each prompt the driver types carries a marker, and the reply follows it:

  WARM-<agent>-<k>   first reply: a Read tool call on warm file k (mod the list), so the agent
                     builds a real history of tool results. After the tool result: a ~2 KB text
                     reply ending in DONE-WARM-<agent>-<k>.
  WAKE-<nonce>       a short text reply ending in DONE-WAKE-<nonce>.
  (no marker)        a short text reply (side requests such as title generation).

Every request is logged as one JSON line (arrival time, marker, kind, body bytes) to --log, so the
driver can time keypress -> request separately from keypress -> rendered reply.

  swap-tier-stub-api.py --port 8899 --log stub.jsonl --warm-files <file> [<file> ...]
"""
import argparse
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARKER = re.compile(r"\b(WARM-[A-Za-z0-9]+-\d+|WAKE-[A-Za-z0-9]+)\b")
FILLER = (
    "Summary of the file just read: it defines several helpers, a small class hierarchy and a "
    "handful of module-level constants. Nothing in it needs changing for this task. "
) * 12


def text_blocks(content):
    if isinstance(content, str):
        return [content]
    return [b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text"]


def has_tool_result(content):
    return isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)


def plan_reply(body, warm_files):
    """Return (kind, marker, reply) for one request. reply = ('text', str) or ('tool', path)."""
    msgs = [m for m in body.get("messages", []) if isinstance(m, dict)]
    marker, marker_idx = None, -1
    for i in range(len(msgs) - 1, -1, -1):
        m = msgs[i]
        if m.get("role") != "user":
            continue
        for t in reversed(text_blocks(m.get("content"))):
            hits = MARKER.findall(t)
            if hits:
                marker, marker_idx = hits[-1], i
                break
        if marker:
            break
    # The CLI can append a reminder-only user message after the tool result, so "the tool already
    # ran" is any tool result after the prompt that carried the marker, not just in the last message.
    after_tool = marker is not None and any(
        m.get("role") == "user" and has_tool_result(m.get("content")) for m in msgs[marker_idx + 1:]
    )
    if marker and marker.startswith("WARM-"):
        if after_tool:
            return "warm-done", marker, ("text", FILLER + "\nDONE-" + marker)
        k = int(marker.rsplit("-", 1)[1])
        return "warm-tool", marker, ("tool", warm_files[k % len(warm_files)])
    if marker and marker.startswith("WAKE-"):
        return "wake", marker, ("text", "Back. DONE-" + marker)
    return "side", None, ("text", "ok")


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


def stream_events(model, reply):
    msg_id = f"msg_stub_{int(time.time() * 1e6)}"
    yield sse("message_start", {"type": "message_start", "message": {
        "id": msg_id, "type": "message", "role": "assistant", "model": model, "content": [],
        "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1000, "output_tokens": 1}}})
    if reply[0] == "tool":
        tool_id = f"toolu_stub_{int(time.time() * 1e6)}"
        yield sse("content_block_start", {"type": "content_block_start", "index": 0,
                                          "content_block": {"type": "tool_use", "id": tool_id, "name": "Read", "input": {}}})
        yield sse("content_block_delta", {"type": "content_block_delta", "index": 0,
                                          "delta": {"type": "input_json_delta", "partial_json": json.dumps({"file_path": reply[1]})}})
        stop = "tool_use"
    else:
        yield sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
        yield sse("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": reply[1]}})
        stop = "end_turn"
    yield sse("content_block_stop", {"type": "content_block_stop", "index": 0})
    yield sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 50}})
    yield sse("message_stop", {"type": "message_stop"})


def json_message(model, reply):
    if reply[0] == "tool":
        content = [{"type": "tool_use", "id": f"toolu_stub_{int(time.time() * 1e6)}", "name": "Read", "input": {"file_path": reply[1]}}]
        stop = "tool_use"
    else:
        content = [{"type": "text", "text": reply[1]}]
        stop = "end_turn"
    return {"id": f"msg_stub_{int(time.time() * 1e6)}", "type": "message", "role": "assistant", "model": model,
            "content": content, "stop_reason": stop, "stop_sequence": None, "usage": {"input_tokens": 1000, "output_tokens": 50}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    warm_files = []
    log = None
    lock = threading.Lock()

    def log_message(self, *_):  # quiet: the JSONL log is the record
        pass

    def record(self, row):
        with self.lock:
            self.log.write(json.dumps(row) + "\n")
            self.log.flush()

    def send_json(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.record({"t": time.time(), "method": "GET", "path": self.path})
        self.send_json(200, {})

    def do_HEAD(self):
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_POST(self):
        t = time.time()
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        path = self.path.split("?", 1)[0]
        if not path.endswith("/v1/messages"):
            self.record({"t": t, "method": "POST", "path": self.path, "bytes": len(raw)})
            if path.endswith("/count_tokens"):
                return self.send_json(200, {"input_tokens": 1000})
            return self.send_json(200, {})
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            return self.send_json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "bad json"}})
        kind, marker, reply = plan_reply(body, self.warm_files)
        model = body.get("model", "claude-stub")
        self.record({"t": t, "method": "POST", "path": path, "kind": kind, "marker": marker, "bytes": len(raw),
                     "stream": bool(body.get("stream")), "messages": len(body.get("messages", []))})
        if not body.get("stream"):
            return self.send_json(200, json_message(model, reply))
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("transfer-encoding", "chunked")
        self.end_headers()
        for chunk in stream_events(model, reply):
            self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--log", required=True)
    ap.add_argument("--warm-files", nargs="+", required=True)
    a = ap.parse_args(argv)
    Handler.warm_files = a.warm_files
    Handler.log = open(a.log, "a")
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    srv.daemon_threads = True
    print(f"STUB_READY port={a.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
