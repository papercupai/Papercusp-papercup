"""Host-only Linux source custody primitive for the disposable runtime broker.

This is not a reviewer RPC. The host passes an already-open image as fd 3,
its expected digest/size bound, and a host-selected argv. No image pathname is
accepted. seal-exec copies that handle once, verifies and write-seals it, then
execs the host's census/launcher with the SAME inherited sealed descriptor.
mount-exec extracts that descriptor once in a private namespace and presents a
read-only /source to the host's command. It supplies no admission bypass: the
broker still owes the canonical manifest/census and durable receipt transaction.
"""
import argparse
import fcntl
import gzip
import hashlib
import io
import json
import os
import re
import resource
import socket
import stat
import subprocess
import sys

SOURCE_FD = 3
CONTROL_FD = 5
SEALS = fcntl.F_SEAL_WRITE | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_SEAL
MAX_IMAGE_BYTES = 2 * 1024 * 1024 * 1024
MANIFEST_NAME = '.broker-closure.json'
COMPRESSED_MANIFEST_NAME = '.broker-closure.json.gz'
MAX_MANIFEST_BYTES = 32 * 1024 * 1024
MAX_DECODED_MANIFEST_BYTES = 128 * 1024 * 1024


def refuse(code):
    raise ValueError(code)


def digest_fd(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while True:
        block = os.read(fd, 1024 * 1024)
        if not block:
            break
        digest.update(block)
    os.lseek(fd, 0, os.SEEK_SET)
    return digest.hexdigest()


def seal_source(expected, max_bytes):
    original = os.fstat(SOURCE_FD)
    if not stat.S_ISREG(original.st_mode) or not 0 < original.st_size <= max_bytes:
        refuse('invalid_image_size_or_type')
    image = os.memfd_create('blind-review-source', os.MFD_ALLOW_SEALING | os.MFD_CLOEXEC)
    try:
        os.lseek(SOURCE_FD, 0, os.SEEK_SET)
        total = 0
        while True:
            block = os.read(SOURCE_FD, 1024 * 1024)
            if not block:
                break
            total += len(block)
            if total > max_bytes:
                refuse('image_size_changed')
            view = memoryview(block)
            while view:
                written = os.write(image, view)
                if written <= 0:
                    refuse('image_copy_failed')
                view = view[written:]
        current = os.fstat(SOURCE_FD)
        if (total != original.st_size or current.st_size != original.st_size or
                current.st_mtime_ns != original.st_mtime_ns or current.st_ctime_ns != original.st_ctime_ns):
            refuse('image_changed_during_copy')
        # Seal BEFORE inspecting the final bytes. All later reads refer to this
        # kernel object, including a census child that changes the shared offset.
        fcntl.fcntl(image, fcntl.F_ADD_SEALS, SEALS)
        if fcntl.fcntl(image, fcntl.F_GET_SEALS) != SEALS or digest_fd(image) != expected:
            refuse('image_digest_or_seals_mismatch')
        os.dup2(image, SOURCE_FD, inheritable=True)
        return total
    finally:
        if image != SOURCE_FD:
            os.close(image)


def verify_source(expected, size):
    if (not stat.S_ISREG(os.fstat(SOURCE_FD).st_mode) or os.fstat(SOURCE_FD).st_size != size or
            fcntl.fcntl(SOURCE_FD, fcntl.F_GET_SEALS) != SEALS or digest_fd(SOURCE_FD) != expected):
        refuse('sealed_handle_invalid')


def export_source(expected, max_bytes):
    size = seal_source(expected, max_bytes)
    info = os.fstat(SOURCE_FD)
    # The host duplicates /proc/<this child>/fd/3 while this process holds it
    # open, compares the kernel device/inode, then acknowledges. This is a
    # duplicate of the sealed object, never another read of an image pathname.
    print(json.dumps({'version': 1, 'device': str(info.st_dev), 'inode': str(info.st_ino),
                      'sha256': expected, 'bytes': size}), flush=True)
    if sys.stdin.buffer.read(1) != b'\x01':
        refuse('sealed_export_not_acknowledged')


def verify_control(fd):
    # Private host/guest management socket, separate from reviewer invocation.
    if fd != CONTROL_FD:
        refuse('control_descriptor_invalid')
    with socket.socket(fileno=os.dup(fd)) as channel:
        if (channel.family != socket.AF_UNIX or channel.type != socket.SOCK_STREAM or
                channel.getsockname() not in ('', b'') or channel.getpeername() not in ('', b'')):
            refuse('inherited_control_socket_required')


def clean_exec(command, expected, size, extra_fds=0, control_fd=None):
    if not command or not os.path.isabs(command[0]):
        refuse('host_command_must_be_absolute')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    # An arbitrary same-UID host env, startup hook or inherited secret fd must
    # not become a dependency of the isolated source reader.
    keep = set(range(SOURCE_FD, SOURCE_FD + 1 + extra_fds))
    if control_fd is not None:
        verify_control(control_fd)
        keep.add(control_fd)
    # Preserve explicit descriptors only, including the gap at fd 4 in the
    # final namespace. A range through fd 5 would leak unrelated fd 4.
    first = SOURCE_FD
    for fd in sorted(keep):
        os.closerange(first, fd)
        os.set_inheritable(fd, True)
        first = fd + 1
    os.closerange(first, resource.getrlimit(resource.RLIMIT_NOFILE)[0])
    os.set_inheritable(SOURCE_FD, True)
    env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
           'PAPERCUSP_RUNTIME_SOURCE_FD': str(SOURCE_FD),
           'PAPERCUSP_RUNTIME_SOURCE_SHA256': expected, 'PAPERCUSP_RUNTIME_SOURCE_BYTES': str(size)}
    if control_fd is not None:
        env['PAPERCUSP_RUNTIME_CONTROL_FD'] = str(control_fd)
    os.execve(command[0], command, env)


def mount_source(command, expected, size, manifest_hash, control_fd=None, runtime_boot=False):
    verify_source(expected, size)
    if control_fd is not None:
        verify_control(control_fd)
    if runtime_boot:
        # Pin trusted management code before executing any product input. It
        # remains outside the source image and is never selected by a caller.
        with open(os.path.join(os.path.dirname(__file__), 'blind-review-runtime-guest.py'), 'rb') as guest:
            bootstrap = os.memfd_create('blind-review-runtime-init', os.MFD_ALLOW_SEALING)
            with os.fdopen(os.dup(bootstrap), 'wb') as output:
                output.write(guest.read())
        fcntl.fcntl(bootstrap, fcntl.F_ADD_SEALS, SEALS)
        os.lseek(bootstrap, 0, os.SEEK_SET)
        if bootstrap != 6:
            os.dup2(bootstrap, 6, inheritable=True)
            os.close(bootstrap)
        command = ['/usr/bin/python3', '-I', '-S', '/runtime.py']
    # The namespace init program itself is pinned by a sealed descriptor, so
    # bwrap does not reopen this mutable checkout after the host starts it.
    with open(__file__, 'rb') as helper:
        program = os.memfd_create('blind-review-source-init', os.MFD_ALLOW_SEALING)
        with os.fdopen(os.dup(program), 'wb') as output:
            output.write(helper.read())
    fcntl.fcntl(program, fcntl.F_ADD_SEALS, SEALS)
    os.lseek(program, 0, os.SEEK_SET)
    if program != 4:
        os.dup2(program, 4, inheritable=True)
        os.close(program)
    os.set_inheritable(4, True)
    argv = ['/usr/bin/bwrap', '--unshare-all', '--hostname', 'review-runtime', '--die-with-parent', '--new-session',
            '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
            '--symlink', 'usr/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
            '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/source', '--dir', '/etc',
            '--ro-bind-data', '4', '/init.py',
            *(['--ro-bind-data', '6', '/runtime.py'] if runtime_boot else []),
            '/usr/bin/python3', '-I', '-S', '/init.py', '_extract-exec',
            '--sha256', expected, '--max-bytes', str(size),
            '--manifest-sha256', manifest_hash,
            *([] if control_fd is None else ['--control-fd', str(control_fd)]), '--', *command]
    clean_exec(argv, expected, size, extra_fds=3 if runtime_boot else 1, control_fd=control_fd)


def read_manifest(root, expected):
    names = [name for name in [MANIFEST_NAME, COMPRESSED_MANIFEST_NAME]
             if os.path.lexists(os.path.join(root, name))]
    if len(names) != 1:
        refuse('closure_manifest_invalid')
    path = os.path.join(root, names[0])
    if not stat.S_ISREG(os.lstat(path).st_mode) or os.lstat(path).st_size > MAX_MANIFEST_BYTES:
        refuse('closure_manifest_invalid')
    with open(path, 'rb') as source:
        encoded = source.read()
    if hashlib.sha256(encoded).hexdigest() != expected:
        refuse('closure_manifest_digest_mismatch')
    if names[0] == COMPRESSED_MANIFEST_NAME:
        # Bounded expansion, including concatenated gzip members. A small
        # compressed stream must never grant an unbounded allocation.
        with gzip.GzipFile(fileobj=io.BytesIO(encoded), mode='rb') as compressed:
            encoded = compressed.read(MAX_DECODED_MANIFEST_BYTES + 1)
        if len(encoded) > MAX_DECODED_MANIFEST_BYTES:
            refuse('closure_manifest_expansion_invalid')

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                refuse('closure_manifest_duplicate_key')
            result[key] = value
        return result

    manifest = json.loads(encoded, object_pairs_hook=unique_object)
    if (not isinstance(manifest, dict) or
            set(manifest) != {'version', 'sourceCommit', 'sourceReceiptSha256', 'dependenciesReceiptSha256', 'files'} or
            type(manifest['version']) is not int or manifest['version'] != 1 or
            not isinstance(manifest['sourceCommit'], str) or not re.fullmatch('[a-f0-9]{40,64}', manifest['sourceCommit']) or
            not all(isinstance(manifest[key], str) and re.fullmatch('[a-f0-9]{64}', manifest[key])
                    for key in ['sourceReceiptSha256', 'dependenciesReceiptSha256']) or
            not isinstance(manifest['files'], list) or not 0 < len(manifest['files']) <= 500000):
        refuse('closure_manifest_invalid')
    records = {}
    for record in manifest['files']:
        if not isinstance(record, dict) or set(record) != {'path', 'kind', 'executable', 'sha256'}:
            refuse('closure_manifest_invalid_record')
        path = record['path']
        if (not isinstance(path, str) or not path or '\\' in path or '\x00' in path or
                any(part in ['', '.', '..'] for part in path.split('/')) or
                path in [MANIFEST_NAME, COMPRESSED_MANIFEST_NAME] or
                path in records or record['kind'] not in ['file', 'symlink'] or
                type(record['executable']) is not bool or not isinstance(record['sha256'], str) or
                not re.fullmatch('[a-f0-9]{64}', record['sha256'])):
            refuse('closure_manifest_invalid_record')
        records[path] = record
    return manifest


def verify_manifest(root, expected):
    manifest = read_manifest(root, expected)
    records = {record['path']: record for record in manifest['files']}
    actual = set()
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = os.path.join(directory, name)
            info = os.lstat(path)
            if stat.S_ISDIR(info.st_mode):
                continue
            relative = os.path.relpath(path, root)
            if relative in [MANIFEST_NAME, COMPRESSED_MANIFEST_NAME]:
                continue
            record = records.get(relative)
            if not record:
                refuse('closure_unrecorded_input')
            actual.add(relative)
            link = stat.S_ISLNK(info.st_mode)
            if ((not link and not stat.S_ISREG(info.st_mode)) or
                    record['kind'] != ('symlink' if link else 'file') or
                    record['executable'] != bool(info.st_mode & 0o111)):
                refuse('closure_input_type_or_mode_changed')
            if link:
                digest = hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest()
            else:
                with open(path, 'rb') as source:
                    digest = hashlib.file_digest(source, 'sha256').hexdigest()
            if digest != record['sha256']:
                refuse('closure_input_bytes_changed')
    if actual != set(records):
        refuse('closure_input_missing')
    return manifest


def inspect_source(expected, size, manifest_hash):
    verify_source(expected, size)
    manifest = verify_manifest('/source', manifest_hash)
    with open('/source/.verifier-source.json', 'rb') as source:
        receipt = json.load(source)
    recorded = {row['path']: row for row in manifest['files']}
    if (receipt.get('sourceCommit') != manifest['sourceCommit'] or
            not isinstance(receipt.get('files'), list) or
            any(recorded.get(row.get('path')) != row for row in receipt['files'])):
        refuse('source_receipt_population_mismatch')
    with open('/source/.broker-build.json', 'rb') as source:
        generated_hash = hashlib.file_digest(source, 'sha256').hexdigest()
    # Only trusted helper code runs. No source entry point, shell, startup hook
    # or generated output is executed in order to produce this measurement.
    print(json.dumps({'version': 1, 'source': receipt, 'generatedSha256': generated_hash},
                     separators=(',', ':')), flush=True)


def extract_source(command, expected, size, manifest_hash, control_fd=None):
    verify_source(expected, size)
    # The only extraction is inside the new mount/PID/network/IPC/user scope.
    # Never extract source into a host directory or reopen an image pathname.
    subprocess.run(['/usr/bin/unsquashfs', '-no-progress', '-processors', '1',
                    '-dest', '/tmp/source-stage', '/proc/self/fd/3'],
                   pass_fds=(SOURCE_FD,), check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for root, dirs, files in os.walk('/tmp/source-stage', followlinks=False):
        for name in dirs + files:
            path = os.path.join(root, name)
            mode = os.lstat(path).st_mode
            if stat.S_ISLNK(mode):
                target = os.readlink(path)
                resolved = os.path.realpath(path)
                if os.path.isabs(target) or not resolved.startswith('/tmp/source-stage/'):
                    refuse('source_symlink_escape')
            elif not stat.S_ISDIR(mode) and not stat.S_ISREG(mode):
                refuse('source_special_file')
    # Attest the complete extracted population, including dependencies and
    # explicitly generated inputs, against the host-pinned verifier manifest.
    # Merely hashing an image would bless a source race during image creation.
    verify_manifest('/tmp/source-stage', manifest_hash)
    # Supply a generated guest identity, never the host's /etc or passwd rows.
    # Native PostgreSQL/GTK require NSS and font configuration even when every
    # product path, credential and environment variable is otherwise private.
    guest_etc = '/tmp/guest-etc'
    os.mkdir(guest_etc, 0o700)
    os.mkdir(guest_etc + '/fonts', 0o700)
    guest_files = {
        'passwd': 'review:x:' + str(os.getuid()) + ':' + str(os.getgid()) +
                  ':Disposable review:/tmp/home:/usr/sbin/nologin\n',
        'group': 'review:x:' + str(os.getgid()) + ':\n',
        'nsswitch.conf': 'passwd: files\ngroup: files\nhosts: files\n',
        'hosts': '127.0.0.1 localhost\n::1 localhost\n',
        'resolv.conf': '',
        'machine-id': os.urandom(16).hex() + '\n',
        'fonts/fonts.conf': '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">'
                            '<fontconfig><dir>/usr/share/fonts</dir>'
                            '<cachedir>/tmp/fontcache</cachedir></fontconfig>\n',
    }
    for name, value in guest_files.items():
        with open(guest_etc + '/' + name, 'x', encoding='utf-8') as output:
            output.write(value)
    # Hide the writable extraction after the read-only bind. Census and all
    # product children share this exact mount; no mutable donor is visible.
    # A fresh PID namespace also hides the staging supervisor's /proc/PID/root;
    # hiding /tmp alone would still expose its writable extraction that way.
    argv = ['/usr/bin/bwrap', '--die-with-parent', '--unshare-pid', '--unshare-user', '--disable-userns',
            '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
            '--ro-bind', '/tmp/source-stage', '/source', '--ro-bind', guest_etc, '/etc',
            '--tmpfs', '/tmp', '--perms', '0700', '--dir', '/tmp/home', '--perms', '0700', '--dir', '/tmp/run',
            '--setenv', 'HOME', '/tmp/home', '--setenv', 'XDG_RUNTIME_DIR', '/tmp/run',
            '--chdir', '/source', *command]
    clean_exec(argv, expected, size, control_fd=control_fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['seal-exec', 'seal-export', 'mount-exec', 'runtime-exec', '_extract-exec', 'inspect', '_inspect'])
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--max-bytes', required=True, type=int)
    parser.add_argument('--manifest-sha256')
    parser.add_argument('--control-fd', type=int)
    options, command = parser.parse_known_args()
    if command[:1] == ['--']:
        command = command[1:]
    if (not re.fullmatch('[a-f0-9]{64}', options.sha256) or
            not 0 < options.max_bytes <= MAX_IMAGE_BYTES):
        refuse('invalid_image_identity')
    if options.control_fd is not None and options.mode not in ['mount-exec', 'runtime-exec', '_extract-exec']:
        refuse('control_mode_invalid')
    if options.mode == 'seal-export':
        export_source(options.sha256, options.max_bytes)
    elif options.mode == 'seal-exec':
        size = seal_source(options.sha256, options.max_bytes)
        clean_exec(command, options.sha256, size)
    else:
        if not options.manifest_sha256 or not re.fullmatch('[a-f0-9]{64}', options.manifest_sha256):
            refuse('closure_manifest_identity_missing')
        if options.mode == 'inspect':
            mount_source(['/usr/bin/python3', '-I', '-S', '/init.py', '_inspect',
                          '--sha256', options.sha256, '--max-bytes', str(options.max_bytes),
                          '--manifest-sha256', options.manifest_sha256],
                         options.sha256, options.max_bytes, options.manifest_sha256)
        elif options.mode == '_inspect':
            inspect_source(options.sha256, options.max_bytes, options.manifest_sha256)
        elif options.mode == 'runtime-exec':
            if command or options.control_fd != CONTROL_FD:
                refuse('runtime_boot_arguments_invalid')
            mount_source([], options.sha256, options.max_bytes, options.manifest_sha256, CONTROL_FD, runtime_boot=True)
        elif options.mode == 'mount-exec':
            mount_source(command, options.sha256, options.max_bytes, options.manifest_sha256, options.control_fd)
        else:
            extract_source(command, options.sha256, options.max_bytes, options.manifest_sha256, options.control_fd)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError):
        # Stable failure without paths, source contents, command args or env.
        print('SEALED_SOURCE_REFUSED', file=sys.stderr)
        sys.exit(3)
