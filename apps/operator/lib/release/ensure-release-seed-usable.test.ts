/**
 * ensure-release-seed.sh — the repair-net's "is the committed seed usable?" predicate.
 *
 * WHY THIS FILE EXISTS. This shell predicate is what decides whether a build SHIPS the
 * committed `src-tauri/seed` or repairs it, and until WI-39447 it asked only "do manifest.json
 * and epoch-keys.json exist?". The seed shipped on 2026-08-15 answered yes to both while its
 * corestore was 50,165,685 bytes short of the size its own manifest declared, so the repair-net
 * logged "usable — no-op" and the build shipped a seed that restores an EMPTY hive.
 *
 * The predicate now consults verify-seed-payload-cli, whose three-way exit code it must map
 * correctly — and THAT MAPPING IS THE PROPERTY UNDER TEST. It is easy to get subtly wrong in a
 * way no other suite would catch: `test:affected` is import-based, so a shell script is selected
 * by nothing, and this file was the only untested seam in the fix.
 *
 * The mapping that matters, and why each arm is the way it is:
 *   exit 0 → usable          (intact)
 *   exit 1 → NOT usable      (broken — the WI-39447 case; must not ship)
 *   exit 2 → usable + WARN   (could not check: a VM leg or partial checkout, where failing the
 *                             build would be a bogus corruption claim — but it must SAY it is
 *                             unverified rather than imply it verified good)
 *
 * ZERO TREE MUTATION (CLAUDE.md tier 2). The real script is COPIED into a temp tree that mimics
 * the repo layout — every path it uses is derived from its own location — and a stub `npx` is
 * placed first on PATH, so the test drives the real script text while needing neither tsx nor
 * the 475MB seed, and never writes inside the shared checkout.
 */

import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * Overridable so falsifiability can be proven against a MUTATED COPY outside the tree
 * (CLAUDE.md tier 2) — mutating the shared checkout to test a guard risks the git-sync sweep
 * committing the mutant. Defaults to the real script.
 */
const REAL_SCRIPT =
  process.env.PROBE_ENSURE_SEED_SCRIPT ??
  join(HERE, '../../../../papercusp-desktop/bin/ensure-release-seed.sh');

let root: string;

/**
 * Build a temp tree the script will resolve against, with `npx` stubbed to exit `verdictExit`.
 * `seedFiles` controls the presence-only half of the predicate.
 */
async function makeTree(
  verdictExit: number,
  seedFiles = { manifest: true, epochKeys: true },
  npxBody?: string,
) {
  const bin = join(root, 'papercusp-desktop/bin');
  const seed = join(root, 'papercusp-desktop/src-tauri/seed');
  const operator = join(root, 'apps/operator/lib/release');
  const fakebin = join(root, 'fakebin');
  await mkdir(bin, { recursive: true });
  await mkdir(seed, { recursive: true });
  await mkdir(operator, { recursive: true });
  await mkdir(fakebin, { recursive: true });

  await cp(REAL_SCRIPT, join(bin, 'ensure-release-seed.sh'));
  // The predicate sources shared guards before checking the payload. Carry its
  // real helper tree so the fixture exercises that startup path as well.
  await cp(join(HERE, '../../../../papercusp-desktop/bin/lib'), join(bin, 'lib'), { recursive: true });
  await chmod(join(bin, 'ensure-release-seed.sh'), 0o755);

  if (seedFiles.manifest) await writeFile(join(seed, 'manifest.json'), '{"stores":[]}', 'utf8');
  if (seedFiles.epochKeys) await writeFile(join(seed, 'epoch-keys.json'), '{}', 'utf8');

  // Stub the verifier at the PATH level: the script shells out via `npx tsx ...`, so this
  // exercises the real invocation + exit-code plumbing without tsx or a real payload.
  await writeFile(
    join(fakebin, 'npx'),
    npxBody ?? `#!/usr/bin/env bash\necho "[stub-verify] invoked: $*"\nexit ${verdictExit}\n`,
    'utf8',
  );
  await chmod(join(fakebin, 'npx'), 0o755);

  return { script: join(bin, 'ensure-release-seed.sh'), fakebin };
}

async function runScript(
  verdictExit: number,
  seedFiles?: { manifest: boolean; epochKeys: boolean },
  npxBody?: string,
  extraEnv: Record<string, string> = {},
) {
  const { script, fakebin } = await makeTree(verdictExit, seedFiles, npxBody);
  try {
    const { stdout, stderr } = await run('bash', [script], {
      env: {
        ...process.env,
        PATH: `${fakebin}:${process.env.PATH ?? ''}`,
        PAPERCUSP_SEED_REQUIRED: '0',
        PAPERCUSP_SEED_UUID_PLAN_PATH: '',
        PAPERCUSP_SEED_UUID_PLAN_SHA256: '',
        PAPERCUSP_SEED_UUID_CENSUS_PATH: '',
        PAPERCUSP_SEED_UUID_CENSUS_SHA256: '',
        ...extraEnv,
      },
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch (err) {
    // A non-zero exit is expected on the arms that fall through to the cut path; we assert on
    // the predicate's LOG LINES, which are emitted before any of that.
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
}

describe('ensure-release-seed.sh seed_usable — three-way payload verdict', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ensure-seed-test-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('actually consults the payload verifier (not just file presence)', async () => {
    const out = await runScript(0);
    expect(out).toMatch(/\[stub-verify] invoked/);
    // It must ask about the seed dir, not something else.
    expect(out).toMatch(/--seed/);
  });

  it('verdict 0 (intact) → usable, repair-net no-ops', async () => {
    const out = await runScript(0);
    expect(out).toMatch(/repair-net no-op/);
  });

  // THE WI-39447 CASE. Before the fix this arm printed "repair-net no-op" and shipped the seed.
  it('verdict 1 (mismatch) → NOT usable, and it does NOT no-op', async () => {
    const out = await runScript(1);
    expect(out).toMatch(/treating it as BROKEN, not usable/);
    expect(out).not.toMatch(/repair-net no-op/);
  });

  it('verdict 2 (undetermined) → usable, but WARNS it is unverified rather than verified-good', async () => {
    const out = await runScript(2);
    expect(out).toMatch(/could not verify/i);
    expect(out).toMatch(/UNVERIFIED, not verified-good/);
    // Must NOT fail the build: a VM leg / partial checkout cannot run the verifier.
    expect(out).toMatch(/repair-net no-op/);
  });

  it('a missing epoch-keys.json still short-circuits before the payload check (WI-3346)', async () => {
    const out = await runScript(0, { manifest: true, epochKeys: false });
    expect(out).not.toMatch(/repair-net no-op/);
  });

  it('sparse refusal retries a full cut with --no-force-backfill only after refresh completion was logged', async () => {
    const argsLog = join(root, 'cut-args.log');
    const firstAttempt = join(root, 'first-attempt.done');
    const liveStore = join(root, 'live-store');
    await mkdir(liveStore, { recursive: true });
    const npxBody = `#!/usr/bin/env bash
if [[ "$*" == *verify-seed-payload-cli.ts* ]]; then
  echo "[stub-verify] invoked: $*"
  exit 1
fi
if [[ "$*" == *cut-seed-cli.ts* ]]; then
  printf '%s\\n' "$*" >> "$TEST_CUT_ARGS_LOG"
  if [[ ! -e "$TEST_FIRST_ATTEMPT" ]]; then
    : > "$TEST_FIRST_ATTEMPT"
    echo '[cut-seed] refreshed via the live operator for test-workspace::papercusp'
    echo '[cut-seed] --sparse requires a fresh head snapshot at the own-log tail'
    exit 1
  fi
  mkdir -p "$TEST_SEED_OUT"
  printf '%s\\n' '{"stores":[]}' > "$TEST_SEED_OUT/manifest.json"
  printf '%s\\n' '{}' > "$TEST_SEED_OUT/epoch-keys.json"
  exit 0
fi
exit 1
`;
    const out = await runScript(
      1,
      { manifest: false, epochKeys: false },
      npxBody,
      {
        PAPERCUSP_SEED_FORCE: '1',
        PAPERCUSP_SEED_REUSE_CORESTORE: '0',
        PAPERCUSP_SEED_STORE_DIR: liveStore,
        PAPERCUSP_SEED_SPARSE: '1',
        TEST_CUT_ARGS_LOG: argsLog,
        TEST_FIRST_ATTEMPT: firstAttempt,
        TEST_SEED_OUT: join(root, 'papercusp-desktop/src-tauri/seed'),
      },
    );
    const attempts = (await readFile(argsLog, 'utf8')).trim().split('\n');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatch(/--sparse/);
    expect(attempts[0]).not.toMatch(/--no-force-backfill/);
    expect(attempts[1]).not.toMatch(/--sparse/);
    expect(attempts[1]).toMatch(/--no-force-backfill/);
    expect(out).toMatch(/first sparse attempt completed refresh/);
  });
});
