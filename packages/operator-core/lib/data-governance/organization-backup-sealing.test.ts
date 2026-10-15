/**
 * Framing rules of sealed organization backup artifacts (WI-6554700010012443 U3). The key service is a
 * stand-in that binds organization and scope; organization-backup-sealing.integration.test.ts runs the
 * real key service.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKUP_ARTIFACT_ID_BYTES,
  collectBytes,
  openBackupArtifact,
  organizationBackupRetentionDecision,
  sealBackupArtifact,
  type BackupKeyService,
} from './organization-backup-sealing';
import { OrganizationKeyUnavailableError } from './organization-keys';

const ORG = 'org-a';

describe('organization backup retention under legal hold', () => {
  it('keeps every artifact in held scope, even when live held rows are absent', () => {
    expect(organizationBackupRetentionDecision({ workspaceIds: ['held'] }, [
      { holdId: 'hold-b', workspaceId: 'held' }, { holdId: 'hold-a', workspaceId: 'held' },
      { holdId: 'hold-a', workspaceId: 'held' }, { holdId: 'other', workspaceId: 'unrelated' },
    ])).toEqual({ prunable: false, holdIds: ['hold-a', 'hold-b'], reason: 'legal-hold-active' });
  });

  it('permits normal pruning after release and ignores holds in other scopes', () => {
    const scope = { workspaceIds: ['released'] };
    expect(organizationBackupRetentionDecision(scope, [])).toEqual({
      prunable: true, holdIds: [], reason: 'no-active-legal-hold',
    });
    expect(organizationBackupRetentionDecision(scope, [{ holdId: 'other', workspaceId: 'unrelated' }]).prunable).toBe(true);
  });
});
const calls = { encrypt: 0 };

const fakeService: BackupKeyService = {
  async encrypt(organizationId, scope, plaintext) {
    calls.encrypt += 1;
    return Buffer.concat([Buffer.from(`${organizationId}|${scope}|`), plaintext]);
  },
  async decrypt(organizationId, scope, blob) {
    const prefix = Buffer.from(`${organizationId}|${scope}|`);
    if (!blob.subarray(0, prefix.length).equals(prefix)) {
      throw new OrganizationKeyUnavailableError(organizationId, 'envelope-auth-failed', 'stand-in auth failure');
    }
    return blob.subarray(prefix.length);
  },
};

const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i % 251));

async function seal(plain: Buffer, chunkBytes: number, artifactId?: Buffer): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const frame of sealBackupArtifact(fakeService, ORG, [plain], { chunkBytes, artifactId })) out.push(frame);
  return out;
}

async function open(frames: readonly Buffer[], org = ORG): Promise<Buffer> {
  return collectBytes(openBackupArtifact(fakeService, org, frames));
}

async function malformedDetail(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(OrganizationKeyUnavailableError);
  expect((err as OrganizationKeyUnavailableError).code).toBe('envelope-malformed');
  return (err as Error).message;
}

describe('sealBackupArtifact / openBackupArtifact', () => {
  it('round-trips across chunk boundaries, including an exact multiple and an empty input', async () => {
    for (const [size, chunk] of [[0, 4], [3, 4], [8, 4], [1000, 7]] as const) {
      const plain = bytes(size);
      const frames = await seal(plain, chunk);
      expect(frames.length).toBe(Math.floor(size / chunk) + 1);
      expect((await open(frames)).equals(plain)).toBe(true);
    }
  });

  it('streams: re-chunks input pieces of any size and accepts the artifact split at any byte', async () => {
    const plain = bytes(50);
    const pieces = [plain.subarray(0, 3), plain.subarray(3, 41), plain.subarray(41)];
    const frames: Buffer[] = [];
    for await (const f of sealBackupArtifact(fakeService, ORG, pieces, { chunkBytes: 16 })) frames.push(f);
    const whole = Buffer.concat(frames);
    const dribble = Array.from({ length: whole.length }, (_, i) => whole.subarray(i, i + 1));
    expect((await collectBytes(openBackupArtifact(fakeService, ORG, dribble))).equals(plain)).toBe(true);
  });

  it('refuses a reordered artifact', async () => {
    const frames = await seal(bytes(12), 4);
    expect(await malformedDetail(open([frames[1]!, frames[0]!, frames[2]!, frames[3]!]))).toMatch(/frame 1 where frame 0/);
  });

  it('refuses an artifact missing its final frame, and one truncated inside a frame', async () => {
    const frames = await seal(bytes(12), 4);
    expect(await malformedDetail(open(frames.slice(0, -1)))).toMatch(/missing the final frame/);
    const whole = Buffer.concat(frames);
    expect(await malformedDetail(open([whole.subarray(0, whole.length - 1)]))).toMatch(/truncated inside a frame/);
    expect(await malformedDetail(open([]))).toMatch(/no frames/);
  });

  it('refuses a frame after the final frame and a frame spliced from another artifact', async () => {
    const a = await seal(bytes(8), 4, Buffer.alloc(BACKUP_ARTIFACT_ID_BYTES, 1));
    const b = await seal(bytes(8), 4, Buffer.alloc(BACKUP_ARTIFACT_ID_BYTES, 2));
    expect(await malformedDetail(open([...a, b[0]!]))).toMatch(/follows the final frame/);
    expect(await malformedDetail(open([a[0]!, b[1]!, a[2]!]))).toMatch(/another artifact/);
  });

  it('refuses an oversized length prefix before buffering it', async () => {
    const huge = Buffer.alloc(4);
    huge.writeUInt32BE(0xffffffff, 0);
    expect(await malformedDetail(open([huge]))).toMatch(/exceeds the limit/);
  });

  it('seals under scope backup and refuses another organization', async () => {
    const frames = await seal(bytes(5), 4);
    expect(frames[0]!.subarray(4).toString('latin1').startsWith(`${ORG}|backup|`)).toBe(true);
    const err = await open(frames, 'org-b').then(() => null, (e: unknown) => e);
    expect((err as OrganizationKeyUnavailableError).code).toBe('envelope-auth-failed');
  });

  it('seals lazily, one frame per pull', async () => {
    calls.encrypt = 0;
    const gen = sealBackupArtifact(fakeService, ORG, [bytes(40)], { chunkBytes: 4 });
    await gen.next();
    expect(calls.encrypt).toBe(1);
    await gen.return(undefined);
  });
});
