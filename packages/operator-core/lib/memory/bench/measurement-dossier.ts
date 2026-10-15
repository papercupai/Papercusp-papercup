/**
 * Final measurement verdict dossier (plan mdenseon-adoption-measurements-2026-10-01,
 * P-009, spec MDENSE-complete-measurement-verdict).
 *
 * A shipped adoption verdict is valid only when EVERY promised measurement bar
 * cites proof that is present, tracked in the repository that owns it, and
 * byte-identical to what the verdict was written against. A missing bar, an
 * `unknown` status, an absent or untracked manifest, or a manifest edited after
 * the verdict was recorded each refuse the whole dossier — and the refusal names
 * every offender, not just the first, so one pass shows the full repair list.
 *
 * Evidence paths are repository-relative to the dossier's own repository, so the
 * dossier is portable; an absolute or escaping path is refused. A path inside a
 * submodule is checked inside that submodule (see tracked-evidence.ts).
 *
 * CLI:
 *   npx tsx packages/operator-core/lib/memory/bench/measurement-dossier.ts verify <dossier.json>
 *     exits 0 only when the dossier verifies; prints one line per bar.
 *   npx tsx packages/operator-core/lib/memory/bench/measurement-dossier.ts fingerprint [--root <dir>] <repo-relative path>...
 *     prints the evidence references (path, sha256, bytes) to paste into a dossier;
 *     paths are relative to --root, else to the repository containing the cwd.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isCliEntry } from '../../util/cli-entry';
import { MEASUREMENT_BARS, fingerprintFile } from './measurement-manifest';
import { trackedEvidence, type TrackedEvidence } from './tracked-evidence';

export const DOSSIER_PLAN = 'mdenseon-adoption-measurements-2026-10-01';

const evidenceRefSchema = z.strictObject({
  path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(),
});
/** A residual defect is only "owned" when it names an owner, a filed item, its root cause and its guard. */
const ownedDefectSchema = z.strictObject({
  owner: z.string().min(1), item: z.string().regex(/^(WI|EI)-\d+$/), rootCause: z.string().min(1), guard: z.string().min(1),
});
const barSchema = z.strictObject({
  bar: z.enum(MEASUREMENT_BARS),
  items: z.array(z.string().regex(/^P-\d{3}$/)).min(1),
  // There is deliberately no `unknown`/`skipped`: an unfinished bar is not a status.
  status: z.enum(['measured', 'incompatible']),
  finding: z.string().min(1),
  evidence: z.array(evidenceRefSchema).min(1),
  defects: z.array(ownedDefectSchema).optional(),
});
export const measurementDossierSchema = z.strictObject({
  formatVersion: z.literal(1),
  plan: z.literal(DOSSIER_PLAN),
  recordedAt: z.iso.datetime(),
  recommendation: z.strictObject({
    decision: z.enum(['adopt', 'adopt-scoped', 'do-not-adopt']),
    rationale: z.string().min(1),
    scopes: z.array(z.string().min(1)).optional(),
  }),
  bars: z.array(barSchema).min(1),
});
export type MeasurementDossier = z.infer<typeof measurementDossierSchema>;
export type DossierEvidenceRef = z.infer<typeof evidenceRefSchema>;

export interface DossierVerification {
  dossier: TrackedEvidence;
  bars: Array<{ bar: MeasurementDossier['bars'][number]['bar']; status: 'measured' | 'incompatible'; evidence: TrackedEvidence[] }>;
}

/** Inherited GIT_DIR / GIT_WORK_TREE would answer about a different repository. */
function repoRootOf(file: string): string | null {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  try {
    return fs.realpathSync(execFileSync('git', ['-C', path.dirname(path.resolve(file)), 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
  }
}

function portable(ref: string): boolean {
  return !path.isAbsolute(ref) && !ref.split(/[\\/]/).includes('..');
}

/** Current evidence references for repository-relative paths under `root`. */
export async function fingerprintDossierEvidence(root: string, refs: readonly string[]): Promise<DossierEvidenceRef[]> {
  const out: DossierEvidenceRef[] = [];
  for (const ref of refs) {
    if (!portable(ref)) throw new Error(`non-portable evidence path: ${ref}`);
    const { sha256, bytes } = await fingerprintFile(path.join(root, ref));
    out.push({ path: ref, sha256, bytes });
  }
  return out;
}

/** Refuse a dossier that does not carry current, tracked, fingerprinted proof for every promised bar. */
export async function verifyMeasurementDossier(file: string): Promise<DossierVerification> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`measurement dossier refused:\n- unreadable dossier ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = measurementDossierSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`measurement dossier refused:\n- invalid dossier ${file}:\n${z.prettifyError(parsed.error)}`);
  const dossier = parsed.data;

  const problems: string[] = [];
  const self = trackedEvidence(file);
  if (!self) problems.push(`dossier is not tracked: ${file}`);

  const counts = new Map<string, number>();
  for (const b of dossier.bars) counts.set(b.bar, (counts.get(b.bar) ?? 0) + 1);
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([bar]) => bar);
  const missing = MEASUREMENT_BARS.filter((bar) => !counts.has(bar));
  if (duplicated.length) problems.push(`duplicated bars: ${duplicated.join(', ')}`);
  if (missing.length) problems.push(`unmeasured promised bars: ${missing.join(', ')}`);

  const root = self?.repoRoot ?? repoRootOf(file) ?? path.dirname(path.resolve(file));
  const bars: DossierVerification['bars'] = [];
  for (const b of dossier.bars) {
    if (b.status === 'incompatible' && !b.defects?.length) problems.push(`incompatible bar without an owned defect: ${b.bar}`);
    const evidence: TrackedEvidence[] = [];
    for (const e of b.evidence) {
      if (!portable(e.path)) { problems.push(`non-portable evidence path in ${b.bar}: ${e.path}`); continue; }
      const abs = path.join(root, e.path);
      if (!fs.existsSync(abs)) { problems.push(`absent evidence in ${b.bar}: ${e.path}`); continue; }
      const tracked = trackedEvidence(abs);
      if (!tracked) { problems.push(`untracked evidence in ${b.bar}: ${e.path}`); continue; }
      const actual = await fingerprintFile(abs);
      if (actual.sha256 !== e.sha256 || actual.bytes !== e.bytes) {
        problems.push(`stale evidence in ${b.bar}: ${e.path} (recorded ${e.sha256.slice(0, 12)}/${e.bytes}B, now ${actual.sha256.slice(0, 12)}/${actual.bytes}B)`);
        continue;
      }
      evidence.push(tracked);
    }
    bars.push({ bar: b.bar, status: b.status, evidence });
  }
  if (problems.length) throw new Error(`measurement dossier refused:\n- ${problems.join('\n- ')}`);
  return { dossier: self!, bars };
}

if (isCliEntry(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'verify' && args.length === 1) {
      const result = await verifyMeasurementDossier(args[0]);
      for (const b of result.bars) console.log(`${b.bar}\t${b.status}\t${b.evidence.map((e) => e.repoRelative).join(',')}`);
      console.log(`verified\t${result.dossier.repoRelative}\t${result.bars.length} bars`);
    } else if (command === 'fingerprint' && args.length) {
      const rooted = args[0] === '--root';
      if (rooted && args.length < 3) throw new Error('fingerprint --root needs a directory and at least one path');
      const root = rooted ? path.resolve(args[1]) : repoRootOf(path.join(process.cwd(), 'x')) ?? process.cwd();
      console.log(JSON.stringify(await fingerprintDossierEvidence(root, rooted ? args.slice(2) : args), null, 2));
    } else {
      throw new Error('usage: measurement-dossier.ts verify <dossier.json> | fingerprint [--root <dir>] <repo-relative path>...');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
