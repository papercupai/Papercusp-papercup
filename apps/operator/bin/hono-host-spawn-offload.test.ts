/**
 * WI-10002709 — the request host must declare itself a SPAWN-OFFLOAD host.
 *
 * `gitSidecarEnabled` defaults every sidecar-capable spawn seam to the spawner
 * sidecar only on a process that called `markSpawnOffloadHost()`. The marker is
 * deliberately in-memory (never an env var children would inherit), so the ONLY
 * thing that turns it on for :3070/:3170 is this call in `hono-host.ts`. Losing
 * it would silently put git-pipeline-position / systemd-probe spawns back on the
 * ~2 GB cluster worker's main thread (~240 ms of dead event loop per fork), with
 * no test or type error anywhere else to notice.
 *
 * Comments are stripped first so the explanatory comment beside the call cannot
 * satisfy the pin on its own.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const raw = readFileSync(join(__dirname, 'hono-host.ts'), 'utf8');
const code = stripCommentsOnly(raw, 'hono-host.ts') as string;
const bootstrapRaw = readFileSync(join(__dirname, 'host-bootstrap.ts'), 'utf8');
const bootstrapCode = stripCommentsOnly(bootstrapRaw, 'host-bootstrap.ts') as string;

describe('hono-host marks itself a spawn-offload host (WI-10002709)', () => {
  it('imports markSpawnOffloadHost from the git-via-sidecar module', () => {
    expect(code).toMatch(
      /import\s*\{[^}]*\bmarkSpawnOffloadHost\b[^}]*\}\s*from\s*'@papercusp\/operator-core\/lib\/fleet\/git-via-sidecar'/,
    );
  });

  it('calls it only when the process is NOT a sidecar (the spawner sidecar must never route through itself)', () => {
    expect(code).toMatch(/if\s*\(\s*sidecarMode\s*===\s*null\s*\)\s*markSpawnOffloadHost\(\s*\)/);
  });

  it('marks the host BEFORE the cluster starts, so the primary and every worker are marked', () => {
    const markAt = code.search(/markSpawnOffloadHost\(\s*\)/);
    const clusterAt = code.search(/startCluster\(\s*\{/);
    expect(markAt).toBeGreaterThan(-1);
    expect(clusterAt).toBeGreaterThan(-1);
    expect(markAt).toBeLessThan(clusterAt);
  });

  it('control: the comment beside the call alone would not satisfy the pin', () => {
    const commentOnly = '// if (sidecarMode === null) markSpawnOffloadHost();\n';
    expect(stripCommentsOnly(commentOnly, 'x.ts')).not.toMatch(/markSpawnOffloadHost\(\s*\)/);
  });
});

describe('background host marks itself only for its own sidecar opt-in', () => {
  it('requires the bg-host profile and guarded shared opt-in, then marks before background work starts', () => {
    expect(bootstrapCode).toMatch(
      /const backgroundSpawnerSidecarEnabled\s*=\s*backgroundWorkers\s*&&\s*!utilityHost\s*&&\s*isSidecarEnabledFromEnv\(/,
    );
    expect(bootstrapCode).toMatch(/if\s*\(\s*backgroundSpawnerSidecarEnabled\s*\)\s*markSpawnOffloadHost\(\s*\)/);
    const markAt = bootstrapCode.search(/if\s*\(\s*backgroundSpawnerSidecarEnabled\s*\)\s*markSpawnOffloadHost\(\s*\)/);
    const firstBackgroundWorkAt = bootstrapCode.search(/import\(['"]@papercusp\/operator-core\/lib\/sync\/hyperbee\/boot-all['"]\)/);
    expect(markAt).toBeGreaterThan(-1);
    expect(firstBackgroundWorkAt).toBeGreaterThan(-1);
    expect(markAt).toBeLessThan(firstBackgroundWorkAt);
  });
});
