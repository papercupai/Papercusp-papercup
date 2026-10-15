/**
 * Identity scrub for the doc-vector seed a release ships (WI-10006868).
 *
 * The seed's manifest holds only `[source_key, slug, anchor, page_sha]` keys, which looked
 * identity-free — but `anchor` is a HEADING SLUG, and a heading can quote a person. On
 * 2026-10-06 the 0.0.21-pcd006a workspace-host cut was refused by the bundle's identity audit
 * after ~33 minutes because one agent-insights heading named the owner's GitHub handle; the
 * doc BODIES that name it were already redacted by the sidecar's `--scrub-text`, but the seed
 * is exported AFTER that step, so it was the one shipping text artifact that bypassed it.
 *
 * Fix: run the audit's OWN `--scrub-text` over the written seed, so the scrub cannot drift
 * from what the audit later refuses, then re-read the seed to prove the rewrite kept every row
 * aligned with its vector. A redacted anchor simply matches no host `doc_sections` row, so that
 * section is embedded on the host by the normal backfill — correctness is unaffected.
 *
 * Fails CLOSED: any scrub or validation error throws, and the exporter then refuses to ship
 * the seed rather than shipping it unscrubbed.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readDocVectorSeed } from '../search/doc-vector-seed';

/** Repo-relative path of the release identity audit that owns the identity map. */
export const RELEASE_IDENTITY_AUDIT_SCRIPT = 'papercusp-desktop/bin/audit-release-bundle.py';

export type ScrubCommandRunner = (command: string, args: readonly string[]) => Promise<void>;

// An injected runner must not require execFile from a narrow importer mock.
let execFileAsync: typeof execFile.__promisify__ | null = null;

const defaultRunner: ScrubCommandRunner = async (command, args) => {
  await (execFileAsync ??= promisify(execFile))(command, [...args], { maxBuffer: 16 * 1024 * 1024 });
};

/**
 * Redact build-box and known-sensitive identities from the seed at `seedDir` in place, then
 * verify the seed still parses with one vector per row. Throws on any failure.
 */
export async function scrubDocVectorSeedIdentity(
  seedDir: string,
  repoRoot: string,
  run: ScrubCommandRunner = defaultRunner,
): Promise<{ rows: number }> {
  await run('python3', [join(repoRoot, RELEASE_IDENTITY_AUDIT_SCRIPT), '--scrub-text', seedDir]);
  const seed = await readDocVectorSeed(seedDir);
  return { rows: seed.manifest.rows.length };
}
