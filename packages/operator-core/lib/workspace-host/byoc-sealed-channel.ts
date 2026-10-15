/**
 * End-to-end Noise channel for BYOC hosted-relay content.
 *
 * The control plane transports `ByocSealedPacket` values but never receives a
 * Noise key. `contentType` deliberately remains outside the sealed box: the
 * relay needs that one control-metadata field to enforce channel-kind and
 * controller/observer policy. The decrypted frame repeats the type and a
 * mismatch is terminal, so a relay cannot relabel ciphertext into another
 * allowlisted operation.
 */
import { timingSafeEqual } from 'node:crypto';
import SecretStream from '@hyperswarm/secret-stream';
import { Duplex } from 'node:stream';

export const BYOC_SEALED_PROTOCOL = 'papercusp-byoc-noise-xx.v1' as const;

export interface ByocSealedPacket {
  type: 'sealed.packet';
  protocol: typeof BYOC_SEALED_PROTOCOL;
  /** The application frame type; control metadata, never content. */
  contentType: string | null;
  /** One ordered fragment of the Noise XX + secretstream wire. */
  packet: string;
}

export interface ByocSealedChannelOptions {
  initiator: boolean;
  localKeyPair: { publicKey: Buffer; secretKey: Buffer };
  /** A single pinned peer key (a provisioned endpoint). Exactly one of this or `verifyRemotePublicKey`. */
  expectedRemotePublicKey?: Buffer;
  /**
   * Responder only: accept any peer whose static key this resolves (D-013 #6 — one key per
   * paired phone, read from `connected_apps.noise_public_key`). Resolves false to refuse.
   */
  verifyRemotePublicKey?: (remotePublicKey: Buffer) => Promise<boolean>;
  sendPacket: (packet: ByocSealedPacket) => void;
  onFrame: (frame: Record<string, unknown>) => void;
  onError?: (error: Error) => void;
}

function canonicalKey(value: Buffer, name: string): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new Error(`${name} must be a 32-byte Noise public key`);
  }
  return Buffer.from(value);
}

function frameType(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && type.length > 0 ? type : null;
}

function decodePacket(value: string): Buffer {
  if (typeof value !== 'string' || value.length === 0) throw new Error('sealed packet must be base64');
  const packet = Buffer.from(value, 'base64');
  if (packet.length === 0 || packet.toString('base64') !== value) {
    throw new Error('sealed packet must be canonical base64');
  }
  return packet;
}

/**
 * Raw byte transport underneath SecretStream, projected onto relay packets.
 *
 * Inbound attribution (WI-10007006): each received chunk is tagged with its relay
 * `contentType`, and `inboundType` names the tag of the chunk whose `'data'` emit is in
 * progress. SecretStream decrypts synchronously inside that emit, so the channel can stamp
 * each plaintext with the type of the exact packet that produced it. Nothing is shared
 * across packets, so a same-tick burst cannot cross-attribute types.
 */
class RelayPacketDuplex extends Duplex {
  /** Outbound label for the send window in progress (null for handshake writes). */
  contentType: string | null = null;
  /** Type of the inbound chunk currently being consumed; null outside a `'data'` emit. */
  inboundType: string | null = null;
  private readonly inboundTypes = new WeakMap<Buffer, string | null>();

  constructor(private readonly emitPacket: (packet: Buffer, contentType: string | null) => void) {
    super();
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event !== 'data' || !Buffer.isBuffer(args[0])) return super.emit(event, ...args);
    const previous = this.inboundType;
    this.inboundType = this.inboundTypes.get(args[0]) ?? null;
    try {
      return super.emit(event, ...args);
    } finally {
      this.inboundType = previous;
    }
  }

  override _read(_size: number): void {}

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.emitPacket(Buffer.from(chunk), this.contentType);
      callback(null);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  receive(packet: Buffer, contentType: string | null): void {
    if (this.destroyed) return;
    this.inboundTypes.set(packet, contentType);
    this.push(packet);
  }
}

/**
 * A pinned-static-key Noise XX session over ordered hosted-relay packets.
 *
 * Callers must serialize `send` calls (the method does this internally). Noise
 * handshake fragments use `contentType:null`; application fragments carry the
 * clear type solely for relay policy. `opened` rejects a key mismatch before
 * any application frame is delivered.
 */
export class ByocSealedChannel {
  readonly opened: Promise<void>;
  private readonly raw: RelayPacketDuplex;
  private readonly noise: InstanceType<typeof SecretStream>;
  private readonly expectedRemotePublicKey: Buffer | null;
  /** Relay type of the packet each decrypted plaintext came from (see RelayPacketDuplex). */
  private readonly plaintextTypes = new WeakMap<Buffer, string | null>();
  private sendChain: Promise<void> = Promise.resolve();
  private receiveBuffer = '';
  /** Relay type the buffered partial line arrived under; a line never spans two types. */
  private receiveBufferType: string | null = null;
  private closed = false;

  constructor(private readonly options: ByocSealedChannelOptions) {
    const verify = options.verifyRemotePublicKey;
    if ((options.expectedRemotePublicKey === undefined) === (verify === undefined)) {
      throw new Error('BYOC sealed channel needs exactly one of expectedRemotePublicKey or verifyRemotePublicKey');
    }
    if (verify && options.initiator) throw new Error('verifyRemotePublicKey is responder-only');
    this.expectedRemotePublicKey = options.expectedRemotePublicKey === undefined
      ? null
      : canonicalKey(options.expectedRemotePublicKey, 'expected remote public key');
    canonicalKey(options.localKeyPair.publicKey, 'local public key');
    if (!Buffer.isBuffer(options.localKeyPair.secretKey) || options.localKeyPair.secretKey.length !== 64) {
      throw new Error('local Noise secret key must be 64 bytes');
    }
    this.raw = new RelayPacketDuplex((packet, contentType) => {
      options.sendPacket({
        type: 'sealed.packet',
        protocol: BYOC_SEALED_PROTOCOL,
        contentType,
        packet: packet.toString('base64'),
      });
    });
    this.noise = new SecretStream(options.initiator, this.raw, {
      keyPair: options.localKeyPair,
      ...(this.expectedRemotePublicKey ? { remotePublicKey: this.expectedRemotePublicKey } : {}),
    });
    // SecretStream pushes each decrypted message synchronously from inside the raw chunk's
    // 'data' emit; stamp it there, because its own 'data' event is delivered later.
    const push = this.noise.push.bind(this.noise);
    this.noise.push = (chunk: Buffer | null) => {
      if (Buffer.isBuffer(chunk)) this.plaintextTypes.set(chunk, this.raw.inboundType);
      return push(chunk);
    };
    this.noise.on('data', (data: Buffer) => this.acceptPlaintext(data));
    // Completing Noise proves possession of a key, not that this key belongs to
    // a paired device. Hold plaintext in the stream until the asynchronous
    // authorization check succeeds; keep the per-buffer relay labels above.
    this.noise.pause();
    this.noise.on('error', (error: Error) => this.fail(error));
    this.raw.on('error', (error: Error) => this.fail(error));
    this.opened = this.noise.opened.then(async (ok) => {
      const remote = ok && this.noise.remotePublicKey ? Buffer.from(this.noise.remotePublicKey) : null;
      if (!remote || remote.length !== 32) throw new Error('BYOC sealed channel remote key mismatch');
      const accepted = this.expectedRemotePublicKey
        ? timingSafeEqual(remote, this.expectedRemotePublicKey)
        : await verify!(remote).catch(() => false);
      if (!accepted) throw new Error('BYOC sealed channel remote key mismatch');
      if (this.closed) throw new Error('BYOC sealed channel is closed');
      this.noise.resume();
    }).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.fail(failure);
      throw failure;
    });
  }

  /** Encrypt one JSON frame. Newline framing is inside the ciphertext. */
  send(frame: Record<string, unknown>): Promise<void> {
    const type = frameType(frame);
    if (!type) return Promise.reject(new Error('sealed frame requires a non-empty type'));
    const task = this.sendChain.then(async () => {
      await this.opened;
      if (this.closed) throw new Error('BYOC sealed channel is closed');
      this.raw.contentType = type;
      try {
        this.noise.write(Buffer.from(JSON.stringify(frame) + '\n'));
        await this.noise.flush();
      } finally {
        this.raw.contentType = null;
      }
    });
    this.sendChain = task.catch(() => {});
    return task;
  }

  /** Feed one packet received from the untrusted control-plane relay. */
  receive(value: ByocSealedPacket): void {
    if (this.closed || value.type !== 'sealed.packet' || value.protocol !== BYOC_SEALED_PROTOCOL) return;
    if (value.contentType !== null && (typeof value.contentType !== 'string' || value.contentType.length === 0)) {
      this.fail(new Error('sealed packet content type is invalid'));
      return;
    }
    try {
      this.raw.receive(decodePacket(value.packet), value.contentType);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.noise.destroy();
    this.raw.destroy();
  }

  private acceptPlaintext(data: Buffer): void {
    const chunkType = this.plaintextTypes.get(data) ?? null;
    if (this.receiveBuffer.length > 0 && chunkType !== this.receiveBufferType) {
      this.fail(new Error('sealed channel content type mismatch'));
      return;
    }
    this.receiveBuffer += data.toString('utf8');
    this.receiveBufferType = chunkType;
    while (true) {
      const newline = this.receiveBuffer.indexOf('\n');
      if (newline < 0) return;
      const raw = this.receiveBuffer.slice(0, newline);
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.fail(new Error('sealed channel produced invalid JSON'));
        return;
      }
      // Every application frame must arrive under the type it decrypts to. A null label is
      // handshake-only: application content relabelled to null would skip relay policy.
      const decryptedType = frameType(parsed);
      if (!decryptedType || chunkType === null || decryptedType !== chunkType) {
        this.fail(new Error('sealed channel content type mismatch'));
        return;
      }
      this.options.onFrame(parsed as Record<string, unknown>);
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.options.onError?.(error);
    this.noise.destroy(error);
    this.raw.destroy(error);
  }
}

export function isByocSealedPacket(value: unknown): value is ByocSealedPacket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const packet = value as Partial<ByocSealedPacket>;
  return packet.type === 'sealed.packet' && packet.protocol === BYOC_SEALED_PROTOCOL &&
    (packet.contentType === null || typeof packet.contentType === 'string') && typeof packet.packet === 'string';
}

/** The policy-visible type without decrypting content. */
export function byocSealedContentType(value: unknown): string | null {
  return isByocSealedPacket(value) && typeof value.contentType === 'string' ? value.contentType : null;
}
