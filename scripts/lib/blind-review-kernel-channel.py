"""Host-owned inherited invocation channel; no listener, reconnect or bearer API.

The trusted placement adapter supplies PID/start ticks/UID/cgroup from its spawn
record, never from a frame. Protocol decoding and canonical reviewer/lease checks
remain mandatory at dispatch and success authorization in the broker.
"""
import array
import os
import select
import socket
import struct

REQUEST_BYTES = 16 * 1024
RESPONSE_BYTES = 32 * 1024


class ChannelRefusal(ValueError):
    pass


def process_start_ticks(pid):
    with open('/proc/' + str(pid) + '/stat', encoding='ascii') as source:
        line = source.read()
    fields = line[line.rfind(')') + 1:].split()
    value = fields[19]
    if not value.isdecimal():
        raise ChannelRefusal('sender_identity_unknown')
    return value


def process_cgroup(pid):
    with open('/proc/' + str(pid) + '/cgroup', encoding='utf-8') as source:
        value = source.read()
    if not value or '\x00' in value:
        raise ChannelRefusal('sender_cgroup_unknown')
    return value


class AuthenticatedInvocationChannel:
    def __init__(self, fd, *, pid, start_ticks, uid, cgroup, receive_bytes=REQUEST_BYTES):
        self.socket = None
        self.pidfd = None
        if (type(pid) is not int or pid <= 0 or type(uid) is not int or uid < 0 or
                not isinstance(start_ticks, str) or not start_ticks.isdecimal() or
                not isinstance(cgroup, str) or not cgroup or
                receive_bytes not in (REQUEST_BYTES, RESPONSE_BYTES)):
            raise ChannelRefusal('invocation_identity_invalid')
        self.pid, self.start_ticks, self.uid, self.cgroup = pid, start_ticks, uid, cgroup
        self.receive_bytes = receive_bytes
        try:
            self.socket = socket.socket(fileno=os.dup(fd))
            # Only a connected unnamed socketpair is admissible. A socket path
            # with the same UID/peer or an accepted reconnect is not this channel.
            if (self.socket.family != socket.AF_UNIX or self.socket.type != socket.SOCK_SEQPACKET or
                    self.socket.getsockname() not in ('', b'') or self.socket.getpeername() not in ('', b'')):
                raise ChannelRefusal('inherited_socketpair_required')
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            self.socket.settimeout(5)
            # Opening a pidfd plus checking the recorded ticks prevents a PID
            # number reused before or after construction from gaining authority.
            self.pidfd = os.pidfd_open(pid)
            self._validate_sender()
        except Exception:
            self.close()
            raise

    def _validate_sender(self):
        try:
            if (select.select([self.pidfd], [], [], 0)[0] or
                    process_start_ticks(self.pid) != self.start_ticks or
                    process_cgroup(self.pid) != self.cgroup or
                    select.select([self.pidfd], [], [], 0)[0]):
                raise ChannelRefusal('sender_identity_changed')
        except (OSError, IndexError) as error:
            raise ChannelRefusal('sender_identity_unknown') from error

    def receive(self):
        if self.socket is None:
            raise ChannelRefusal('channel_closed')
        # PASSCRED must also be enabled by the placement writer BEFORE passing
        # the peer FD. A frame queued earlier without verifiable creds refuses.
        data, ancillary, flags, _ = self.socket.recvmsg(self.receive_bytes + 1,
            socket.CMSG_SPACE(struct.calcsize('3i')) + socket.CMSG_SPACE(16 * array.array('i').itemsize))
        credentials = []
        forbidden_ancillary = False
        for level, kind, encoded in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                # Rejected descriptors are already installed by recvmsg. Close
                # every received fd even for a truncated/malformed/bad frame.
                rights = array.array('i')
                rights.frombytes(encoded[:len(encoded) - len(encoded) % rights.itemsize])
                for descriptor in rights:
                    os.close(descriptor)
                forbidden_ancillary = True
            elif level == socket.SOL_SOCKET and kind == socket.SCM_CREDENTIALS and len(encoded) == struct.calcsize('3i'):
                credentials.append(struct.unpack('3i', encoded))
            else:
                forbidden_ancillary = True
        if (not data or len(data) > self.receive_bytes or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or
                forbidden_ancillary or len(credentials) != 1):
            raise ChannelRefusal('frame_or_ancillary_invalid')
        pid, uid, _gid = credentials[0]
        if pid != self.pid or uid != self.uid:
            raise ChannelRefusal('frame_sender_mismatch')
        self._validate_sender()
        return data

    def send(self, data):
        if self.socket is None or not isinstance(data, bytes) or not 0 < len(data) <= RESPONSE_BYTES:
            raise ChannelRefusal('response_invalid')
        self._validate_sender()
        if self.socket.send(data) != len(data):
            raise ChannelRefusal('response_incomplete')

    def close(self):
        if self.socket is not None:
            self.socket.close()
            self.socket = None
        if self.pidfd is not None:
            os.close(self.pidfd)
            self.pidfd = None
