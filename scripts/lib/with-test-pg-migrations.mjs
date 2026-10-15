/** Freeze one migration source for a disposable runtime's entire lifetime. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function migrationFiles(source) {
  return readdirSync(source, { withFileTypes: true })
    .filter(entry => entry.name.endsWith('.sql') || entry.name.endsWith('.sql.forward-compat.json'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(entry => {
      if (!entry.isFile()) throw new Error('migration source must be a regular file: ' + entry.name);
      const bytes = readFileSync(join(source, entry.name));
      return { name: entry.name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
}

export function snapshotMigrationSource(source, destination) {
  const captured = migrationFiles(source);
  if (!captured.some(file => file.name.endsWith('.sql'))) throw new Error('migration source has no SQL files');
  mkdirSync(destination, { mode: 0o700 }); // Never reuse another runtime's snapshot.
  try {
    for (const file of captured) writeFileSync(join(destination, file.name), file.bytes, { mode: 0o600, flag: 'wx' });
    const identity = files => JSON.stringify(files.map(({ name, sha256 }) => [name, sha256]));
    if (identity(captured) !== identity(migrationFiles(source))) {
      throw new Error('migration source changed while capturing isolated runtime');
    }
    return destination;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
