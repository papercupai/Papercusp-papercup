/** Duplicate a kernel write-sealed image into the host before any census. */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../../scripts/lib/blind-review-sealed-source.py', import.meta.url));

export async function sealRuntimeSourceHandle(original: FileHandle, sha256: string, bytes: number,
  signal?: AbortSignal): Promise<FileHandle> {
  signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error('broker_invalid_image_identity');
  const child = spawn('/usr/bin/python3', ['-I', '-S', helper, 'seal-export', '--sha256', sha256,
    '--max-bytes', String(bytes)], { stdio: ['pipe', 'pipe', 'pipe', original.fd],
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, signal, timeout: 15_000 });
  // These are guaranteed by the explicit pipe entries above. The extra image
  // descriptor prevents Node's three-entry stdio overload from expressing it.
  const input = child.stdin!, output = child.stdout!, errors = child.stderr!;
  return await new Promise<FileHandle>((resolve, reject) => {
    let encoded = '', failure: unknown, handle: FileHandle | undefined;
    let opening: Promise<void> | undefined;
    input.on('error', error => { failure ??= error; child.kill(); });
    errors.resume();
    output.on('data', (chunk: Buffer) => {
      encoded += chunk.toString();
      if (encoded.length > 4096) { failure = new Error('broker_seal_export_invalid'); child.kill(); return; }
      if (!encoded.includes('\n') || opening) return;
      opening = (async () => {
        const proof = JSON.parse(encoded);
        if (proof.version !== 1 || proof.sha256 !== sha256 || proof.bytes !== bytes || !child.pid ||
            !/^\d+$/.test(proof.device) || !/^\d+$/.test(proof.inode)) throw new Error('broker_seal_export_invalid');
        // Child is blocked until the ACK below. Its exact kernel object must
        // match; a PID pathname alone never establishes source custody.
        handle = await open('/proc/' + child.pid + '/fd/3', constants.O_RDONLY);
        const info = await handle.stat({ bigint: true });
        if (!info.isFile() || String(info.dev) !== proof.device || String(info.ino) !== proof.inode ||
            info.size !== BigInt(bytes)) throw new Error('broker_seal_export_identity_changed');
        input.end(Buffer.from([1]));
      })().catch(error => { failure = error; child.kill(); });
    });
    child.once('error', error => { failure ??= error; });
    child.once('close', async code => {
      await opening;
      if (!failure && code === 0 && handle) resolve(handle);
      else {
        await handle?.close();
        reject(failure ?? new Error('broker_source_seal_failed'));
      }
    });
  });
}
