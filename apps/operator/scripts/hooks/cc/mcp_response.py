"""Shared runtime helpers for the Claude/Codex shell hooks.

Hook JSON can contain arbitrary tool input and the local MCP bearer is a live
credential.  Neither belongs in a child process's argv, where same-user process
inspection can read it.  Shell wrappers pass the hook payload on fd 3 and only
the permission-restricted token *path* in argv; the helpers below keep that
transport consistent across the hook family.

This module also parses the local MCP endpoint's JSON-RPC/SSE envelope.  The
endpoint can return HTTP 200 while ``result.isError`` is true; that is still a
rejected tool call, not a usable inner payload.
"""

import ast
import hashlib
import json
import os
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
import urllib.request
import urllib.parse
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

OUTPUT_ENVELOPE_SCHEMA_VERSION = 'papercusp.output-envelope/v1'
SCRATCH_URI_PREFIX = 'papercusp://scratch/'


def _skip_js_quoted(source, start):
    quote = source[start]
    index = start + 1
    while index < len(source):
        if source[index] == '\\':
            index += 2
        elif source[index] == quote:
            return index + 1
        else:
            index += 1
    return len(source)


def _exec_source(tool_input):
    if isinstance(tool_input, str):
        return tool_input
    if isinstance(tool_input, dict):
        for key in ('source', 'code', 'script'):
            value = tool_input.get(key)
            if isinstance(value, str):
                return value
    return None


def extract_nested_codex_apply_patches(tool_name, tool_input):
    """Find literal tools.apply_patch calls in a Codex JS exec input.

    Only static string arguments are admitted: the pre-hook must know every
    touched path before allowing the parent tool to run. A detected dynamic or
    malformed call is returned with complete=False so the caller can deny it.
    Strings and comments are skipped while looking for executable call sites.
    """
    if tool_name not in ('exec', 'functions.exec', 'functions__exec'):
        return None
    source = _exec_source(tool_input)
    if not isinstance(source, str):
        return {'found': False, 'complete': False, 'patches': []}
    if len(source) > 4 * 1024 * 1024:
        return {'found': 'tools' in source and 'apply_patch' in source,
                'complete': False, 'patches': []}

    found = False
    complete = True
    patches = []
    calls = 0
    index = 0
    while index < len(source):
        if source.startswith('//', index):
            newline = source.find('\n', index + 2)
            index = len(source) if newline < 0 else newline + 1
            continue
        if source.startswith('/*', index):
            end = source.find('*/', index + 2)
            index = len(source) if end < 0 else end + 2
            continue
        if source[index] in ('"', "'", '`'):
            index = _skip_js_quoted(source, index)
            continue

        if source.startswith('tools', index) and (index == 0 or not (source[index - 1].isalnum() or source[index - 1] in '_$')):
            cursor = index + len('tools')
            while cursor < len(source) and source[cursor].isspace():
                cursor += 1
            if cursor < len(source) and source[cursor] == '.':
                cursor += 1
                while cursor < len(source) and source[cursor].isspace():
                    cursor += 1
                if source.startswith('apply_patch', cursor):
                    after_name = cursor + len('apply_patch')
                    if after_name == len(source) or not (source[after_name].isalnum() or source[after_name] in '_$'):
                        cursor = after_name
                        while cursor < len(source) and source[cursor].isspace():
                            cursor += 1
                        if cursor < len(source) and source[cursor] == '(':
                            found = True
                            calls += 1
                            arg = cursor + 1
                            while arg < len(source) and source[arg].isspace():
                                arg += 1
                            patch = None
                            end_arg = arg
                            if arg < len(source) and source[arg] in ('"', "'"):
                                end_arg = _skip_js_quoted(source, arg)
                                try:
                                    patch = ast.literal_eval(source[arg:end_arg])
                                except (ValueError, SyntaxError):
                                    patch = None
                                tail = end_arg
                                while tail < len(source) and source[tail].isspace():
                                    tail += 1
                                if tail < len(source) and source[tail] not in (',', ')'):
                                    patch = None
                            if (isinstance(patch, str)
                                    and '*** Begin Patch' in patch
                                    and '*** End Patch' in patch):
                                patches.append(patch)
                            else:
                                complete = False
                            index = max(end_arg, cursor + 1)
                            continue
        index += 1

    return {'found': found, 'complete': complete and calls == len(patches), 'patches': patches}


def codex_apply_patch_paths(patch):
    """Return the file headers the lock and attribution hooks both recognize."""
    if not isinstance(patch, str):
        return []
    text = patch.replace('\r\n', '\n').replace('\r', '\n')
    paths = []
    for match in re.finditer(r'^\*\*\* (?:Add|Update|Delete) File: (.+)$', text, re.MULTILINE):
        path = match.group(1).strip()
        if path:
            paths.append(path)
    for match in re.finditer(r'^\*\*\* Move to: (.+)$', text, re.MULTILINE):
        path = match.group(1).strip()
        if path:
            paths.append(path)
    return paths


def nested_codex_apply_patch_results(response):
    """Extract only serialized/structured nested tool results from an exec reply.

    A parent status such as ``completed`` is deliberately not proof that its
    nested apply_patch succeeded. The function result must be surfaced as a
    structured apply_patch result or as JSON emitted in output/content text.
    """
    results = []
    visited = set()

    def add_result(result):
        try:
            marker = ('json', json.dumps(result, sort_keys=True, separators=(',', ':')))
        except Exception:
            marker = ('id', id(result))
        if marker not in visited:
            visited.add(marker)
            results.append(result)

    def is_result(value):
        return isinstance(value, dict) and (
            isinstance(value.get('content'), list)
            or isinstance(value.get('structuredContent'), dict)
            or any(key in value for key in ('ok', 'success', 'isError', 'is_error'))
        )

    def visit(value, serialized=False, depth=0):
        if depth > 10:
            return
        if isinstance(value, str):
            try:
                decoded = json.loads(value.strip())
            except (ValueError, TypeError):
                return
            visit(decoded, True, depth + 1)
            return
        if isinstance(value, list):
            for item in value:
                visit(item, serialized, depth + 1)
            return
        if not isinstance(value, dict):
            return

        name = value.get('tool_name') or value.get('toolName') or value.get('name')
        if isinstance(name, str) and name.lower() in ('apply_patch', 'functions.apply_patch'):
            result = value.get('result', value.get('tool_response', value.get('toolResponse', value)))
            if is_result(result):
                add_result(result)
            return
        if serialized and is_result(value):
            add_result(value)
            return

        for key in ('result', 'tool_result', 'toolResult', 'tool_results', 'toolResults',
                    'tool_calls', 'toolCalls', 'content', 'output', 'stdout', 'text', 'data'):
            if key not in value:
                continue
            child = value[key]
            visit(child, key in ('result', 'tool_result', 'toolResult', 'tool_results', 'toolResults'), depth + 1)

    visit(response)
    return results


def read_lock_operation(path, owner, session_id):
    """A native operation belongs to one owner AND one client continuation."""
    try:
        with open(path, encoding='utf-8') as stream:
            record = json.load(stream)
        if (record.get('version') != 1 or record.get('owner') != owner
                or record.get('session_id') != session_id):
            return None
        uuid.UUID(record['operation']['id'])
        if not record.get('paths') or not record.get('intent', '').startswith('PreToolUse:'):
            return None
        return record
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def write_lock_operation(path, record):
    """Persist before HTTP; a failed write must never admit an acquire."""
    temp = path + '.tmp-' + str(os.getpid())
    try:
        with open(temp, 'w', encoding='utf-8') as stream:
            os.chmod(temp, 0o600)
            json.dump(record, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        try:
            os.unlink(temp)
        except FileNotFoundError:
            pass


# D-002: the authority admits only a pinned acquire (the pin is persisted before
# that acquire is sent) and refuses every acquire after the admission deadline.
# A record with no pin, no terminal state and a passed deadline was therefore
# never admitted and never can be. It is inert history, not a live operation
# (D-005). Reusing one replays a doomed acquire for as long as the native tool
# id recurs; against an origin that predates the protocol, that replay is the
# operation-scope deny. The grace absorbs skew against a remote authority clock.
INERT_OPERATION_GRACE_SEC = 300


def lock_operation_inert(record, now=None):
    try:
        operation = record['operation']
        if operation.get('authority') or record.get('terminal'):
            return False
        deadline = datetime.fromisoformat(operation['deadline'].replace('Z', '+00:00'))
    except (KeyError, TypeError, ValueError, AttributeError):
        return False
    if deadline.tzinfo is None:
        return False
    now = now or datetime.now(timezone.utc)
    return now >= deadline + timedelta(seconds=INERT_OPERATION_GRACE_SEC)


def retire_inert_lock_operation(path, now=None):
    """Move an inert record to ``<path>.expired`` so this call decides afresh.

    Any owner's inert record qualifies: it can admit nothing, so it can block
    nothing. A pinned, terminal, unreadable or still-admissible record stays.
    """
    try:
        with open(path, encoding='utf-8') as stream:
            record = json.load(stream)
    except (OSError, ValueError):
        return False
    if not isinstance(record, dict) or not lock_operation_inert(record, now):
        return False
    try:
        os.replace(path, path + '.expired')
    except OSError:
        return False
    return True


def prepare_lock_operation(path, owner, session_id, tool_id, arguments):
    if not session_id or not tool_id:
        raise ValueError('native session and tool identity required')
    record = read_lock_operation(path, owner, session_id)
    scope = {key: arguments.get(key) for key in ('paths', 'intent', 'ttl_sec', 'coordination_domain')}
    if os.path.exists(path):
        if record is None or any(record.get(key) != value for key, value in scope.items()):
            raise ValueError('native operation scope changed')
        return record
    record = dict(scope, version=1, owner=owner, session_id=session_id, tool_id=tool_id,
                  operation={'id': str(uuid.uuid4()),
                             'deadline': (datetime.now(timezone.utc) + timedelta(seconds=1200)).isoformat()})
    # The existing batch leader election serializes batch creation. O_EXCL
    # serializes per-tool creation, including a repeated native PreToolUse.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        record = read_lock_operation(path, owner, session_id)
        if record is None or any(record.get(key) != value for key, value in scope.items()):
            raise ValueError('native operation creation conflict')
        return record
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(record, stream)
        stream.flush()
        os.fsync(stream.fileno())
    return record


def lock_operation_arguments(record, finish=False):
    operation = dict(record['operation'])
    args = {'hook_operation': operation}
    if record.get('coordination_domain'):
        args['coordination_domain'] = record['coordination_domain']
    if finish:
        operation.update({key: record[key] for key in ('paths', 'intent', 'ttl_sec')})
    else:
        args.update({key: record[key] for key in ('paths', 'intent', 'ttl_sec')})
        args['wait'] = {'max_sec': 0}
    return args


def settle_lock_operation(path, record, call_tool, proof=None):
    """Never downgrade operation identity, pin, or exact scope on a retry."""
    if record.get('terminal') == 'completed' or (record.get('terminal') == 'cancelled' and proof is None):
        return True
    if lock_operation_inert(record):
        # Nothing was admitted and nothing can be: there is no grant to fence,
        # so send no doomed preparation acquire, and retire the record.
        retire_inert_lock_operation(path)
        return True
    if not record['operation'].get('authority'):
        prepared, error = call_tool('locks:acquire', lock_operation_arguments(record))
        if (error is not None or not isinstance(prepared, dict)
                or prepared.get('reason') != 'operation_authority_required'
                or not isinstance(prepared.get('operation_authority'), str)):
            return False
        record['operation']['authority'] = prepared['operation_authority']
        write_lock_operation(path, record)
    args = lock_operation_arguments(record, finish=True)
    if proof is not None:
        args['native_edit_proof'] = proof
    result, error = call_tool('locks:release' if proof is not None else 'locks:cancel_wait', args)
    confirmed = (error is None and isinstance(result, dict) and result.get('ok') is True
            and result.get('operation_id') == record['operation']['id']
            and result.get('state') in ('completed', 'cancelled'))
    if confirmed:
        record['terminal'] = result['state']
        write_lock_operation(path, record)
    return confirmed


OPERATION_PROTOCOL_TOOLS = ('locks:acquire', 'locks:release', 'locks:cancel_wait')
OPERATION_PROTOCOL_TTL_SEC = {True: 600, False: 60}


def _origin_protocol_cache_path(cache_dir, origin, owner, native_session_id):
    scope = (
        origin.rstrip('/'),
        owner if isinstance(owner, str) else '',
        native_session_id if isinstance(native_session_id, str) else '',
    )
    digest = hashlib.sha256(json.dumps(scope, separators=(',', ':')).encode('utf-8')).hexdigest()[:16]
    return os.path.join(cache_dir, 'operation-protocol-' + digest + '.json')


def schema_declares_hook_operation(raw_resp):
    """True only when every operation tool's input schema declares hook_operation."""
    data = [line[5:].strip() for line in raw_resp.splitlines() if line.startswith('data:')]
    try:
        tools = json.loads(data[-1] if data else raw_resp)['result']['tools']
    except Exception:
        return False
    declared = {}
    for tool in tools if isinstance(tools, list) else []:
        if isinstance(tool, dict) and tool.get('name') in OPERATION_PROTOCOL_TOOLS:
            properties = (tool.get('inputSchema') or {}).get('properties') or {}
            declared[tool['name']] = 'hook_operation' in properties
    return all(declared.get(name) is True for name in OPERATION_PROTOCOL_TOOLS)


def origin_operation_protocol_qualified(cache_dir, origin, token, owner, native_session_id, now=None):
    """D-003/D-004(4): may this origin receive the native operation protocol?

    Qualification is a read-only tools/list schema read, never an acquire: an
    older, non-strict origin would ignore hook_operation and grant a real legacy
    lock. The verdict is cached per origin, owner and native session (600s
    qualified, 60s unqualified); a failed read is unqualified for this call
    only and is not cached. Qualification uses the same authenticated session
    route as the subsequent locks call.
    """
    now = time.time() if now is None else now
    normalized_origin = origin.rstrip('/')
    normalized_owner = owner if isinstance(owner, str) else ''
    normalized_session = native_session_id if isinstance(native_session_id, str) else ''
    path = _origin_protocol_cache_path(cache_dir, normalized_origin, normalized_owner, normalized_session)
    try:
        with open(path, encoding='utf-8') as stream:
            cached = json.load(stream)
        qualified = cached.get('qualified')
        same_scope = (
            cached.get('origin') == normalized_origin
            and cached.get('owner') == normalized_owner
            and cached.get('native_session_id') == normalized_session
        )
        if same_scope and isinstance(qualified, bool) and 0 <= now - float(cached['checked_at']) < OPERATION_PROTOCOL_TTL_SEC[qualified]:
            return qualified
    except Exception:
        pass
    base_url = (normalized_origin + '/api/mcp?superuser=1&origin=hook&format=json&tools='
           + ','.join(OPERATION_PROTOCOL_TOOLS) + '&client=' + urllib.parse.quote(owner, safe=''))
    url = with_native_session(base_url, normalized_session)
    request = urllib.request.Request(url, data=json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {},
    }).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                         'Accept': 'application/json, text/event-stream'}, method='POST')
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=3) as response:
            qualified = schema_declares_hook_operation(response.read().decode('utf-8', errors='replace'))
    except Exception:
        return False
    try:
        tmp = path + '.tmp-' + str(os.getpid())
        with open(tmp, 'w', encoding='utf-8') as stream:
            json.dump({
                'origin': normalized_origin,
                'owner': normalized_owner,
                'native_session_id': normalized_session,
                'qualified': qualified,
                'checked_at': now,
            }, stream)
        os.replace(tmp, path)
    except Exception:
        pass
    return qualified


def forget_origin_operation_protocol(cache_dir, origin, owner, native_session_id):
    try:
        os.remove(_origin_protocol_cache_path(cache_dir, origin, owner, native_session_id))
    except OSError:
        pass


def call_lock_operation(origin, token, owner, session_id, name, arguments):
    """The pinned operation protocol never retries at an unqualified origin."""
    url = with_native_session(origin.rstrip('/') + '/api/mcp?superuser=1&origin=hook&format=json&client='
                              + urllib.parse.quote(owner, safe=''), session_id)
    request = urllib.request.Request(url, data=json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
        'params': {'name': name, 'arguments': arguments},
    }).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                         'Accept': 'application/json, text/event-stream'}, method='POST')
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=10) as response:
            inner, error, phase = parse_mcp_response(response.read().decode('utf-8', errors='replace'))
        return inner, error or (None if phase == 'ok' else phase)
    except Exception as exc:
        return None, str(exc)


def parent_tool_terminal(response):
    """A yielded native exec envelope cannot finish its nested edit."""
    if isinstance(response, dict):
        if ('session_id' in response and 'exit_code' not in response
                or response.get('status') in ('running', 'yielded')):
            return False
        return all(parent_tool_terminal(value) for value in response.values())
    if isinstance(response, list):
        return all(parent_tool_terminal(value) for value in response)
    if isinstance(response, str):
        if 'Script running with cell ID' in response:
            return False
        try:
            parsed = json.loads(response)
        except (ValueError, TypeError):
            return True
        if isinstance(parsed, (dict, list)):
            return parent_tool_terminal(parsed)
    return response is not None


def with_native_session(url, native_session_id):
    """Bind a hook MCP request to its verified native session URL context.

    The MCP host derives request.ctx.advSessionId from this query parameter;
    a JSON-RPC argument named ``session_id`` is telemetry and cannot establish
    the verified request context. Keep other query parameters intact and
    replace any stale native_session value rather than sending duplicates.
    """
    if not isinstance(url, str) or not isinstance(native_session_id, str):
        return url
    native_session_id = native_session_id.strip()
    if not native_session_id:
        return url
    try:
        parts = urlsplit(url)
        query = [
            (key, value)
            for key, value in parse_qsl(parts.query, keep_blank_values=True)
            if key != 'native_session'
        ]
        query.append(('native_session', native_session_id))
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))
    except (TypeError, ValueError):
        return url


def _parse_json_object(text):
    if not isinstance(text, str) or not text.strip().startswith('{'):
        return None
    try:
        value = json.loads(text)
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def _scratch_uri_to_path(uri):
    """Resolve only a local scratch URI contained beneath the configured root."""
    if not isinstance(uri, str) or not uri.startswith(SCRATCH_URI_PREFIX):
        return None
    relative = uri[len(SCRATCH_URI_PREFIX):]
    if not relative or '\x00' in relative or any(part == '..' for part in relative.split('/')):
        return None

    root = os.environ.get('PAPERCUSP_SCRATCH_ROOT', '').strip()
    if not root:
        root = os.path.join(os.path.expanduser('~'), '.papercusp', 'scratch')
    root = os.path.realpath(os.path.abspath(root))
    candidate = os.path.realpath(os.path.join(root, *relative.split('/')))
    try:
        if os.path.commonpath((root, candidate)) != root or candidate == root:
            return None
    except (OSError, ValueError):
        return None
    return candidate


def _read_spilled_payload(path):
    """Read the final JSON line from a result-door spill, matching ptool."""
    try:
        last_nonempty = None
        with open(path, 'r', encoding='utf-8', errors='replace') as stream:
            for line in stream:
                if line.strip():
                    last_nonempty = line
        return json.loads(last_nonempty) if last_nonempty else None
    except (OSError, ValueError):
        return None


def _unwrap_output_envelope(value):
    """Return the tool result from a result-door envelope, or None if unreadable.

    References are followed only for the operator's result-door schema and only
    when their scratch URI resolves under this process's scratch root. Preview
    text is deliberately not authoritative: a spilled result is read from disk.
    """
    if not isinstance(value, dict) or value.get('schemaVersion') != OUTPUT_ENVELOPE_SCHEMA_VERSION:
        return value
    if 'ok' in value:
        return value

    for part in value.get('content') or []:
        if not isinstance(part, dict):
            continue
        inline = _parse_json_object(part.get('text'))
        if inline is not None:
            return inline

        if part.get('kind') not in ('reference', 'evidence-reference') and part.get('type') != 'reference':
            continue
        path = _scratch_uri_to_path(part.get('uri'))
        if not path:
            continue
        spilled = _read_spilled_payload(path)
        if not isinstance(spilled, dict):
            continue
        for spilled_part in spilled.get('content') or []:
            if not isinstance(spilled_part, dict):
                continue
            candidate = _parse_json_object(spilled_part.get('text'))
            if candidate is not None:
                return candidate
    return None


def read_hook_payload(fd=3):
    """Read a hook event from a non-argv file descriptor."""
    try:
        with os.fdopen(fd, 'r', encoding='utf-8', errors='replace') as stream:
            return stream.read()
    except OSError:
        return ''


def read_token_file(path):
    """Read the local bearer without ever copying its value into process argv."""
    try:
        with open(path, 'r', encoding='utf-8') as stream:
            return stream.read().strip()
    except OSError:
        return ''


def parse_mcp_response(raw_resp):
    """Return ``(inner, rpc_error, phase)`` for a JSON or SSE MCP response.

    ``inner`` is the JSON object encoded in the first text content block only
    when the outer response is a successful tool result.  ``rpc_error`` holds
    either a JSON-RPC ``error`` object or the rejected outer ``result`` carrying
    ``isError: true``.  ``phase`` is one of ``ok``, ``rpc-error``, ``is-error``,
    ``no-result``, or ``no-text``.
    """
    result = None
    rpc_error = None
    for line in (raw_resp or '').splitlines():
        line = line.strip()
        if not line or line.startswith('event:'):
            continue
        if line.startswith('data:'):
            line = line[5:].strip()
        try:
            candidate = json.loads(line)
        except Exception:
            continue
        if not isinstance(candidate, dict):
            continue
        if 'result' in candidate:
            result = candidate['result']
            break
        if 'error' in candidate:
            rpc_error = candidate['error']
            break

    if rpc_error is not None:
        return None, rpc_error, 'rpc-error'
    if not isinstance(result, dict):
        return None, None, 'no-result'
    if result.get('isError') is True:
        return None, result, 'is-error'

    for item in result.get('content') or []:
        if not isinstance(item, dict) or item.get('type') != 'text':
            continue
        parsed = _parse_json_object(item.get('text'))
        if parsed is None:
            continue
        inner = _unwrap_output_envelope(parsed)
        if inner is not None:
            return inner, None, 'ok'
    return None, None, 'no-text'
