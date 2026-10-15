import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** Shared raw JSONL corpus traversal for the WI-6882 context and P-001 output instruments. */
export async function* walkRawTranscripts(dir, { onError = () => {} } = {}) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { onError(error, dir); return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkRawTranscripts(p, { onError });
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

/** An optional finite snapshot prevents an actively appended transcript from extending the scan. */
export async function* readRawTranscript(file, { snapshotBytes } = {}) {
  if (snapshotBytes === 0) return;
  const input = createReadStream(file, { encoding: 'utf8', ...(snapshotBytes == null ? {} : { end: snapshotBytes - 1 }) });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { yield { record: JSON.parse(line) }; }
      catch { yield { record: null, error: 'invalid-json' }; }
    }
  } finally {
    rl.close();
    input.destroy();
  }
}
