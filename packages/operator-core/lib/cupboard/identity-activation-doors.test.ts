/**
 * agent-economy-flywheel P-016 (WI-10004280, D-011/D-012): every door that ACTIVATES an identity
 * stack routes through the funding gate. A priced layer activated by a door that skips the gate is
 * unpaid use, and nothing at runtime notices the missing call — the stack just renders. This guard
 * pins the call at each door so removing one fails here.
 *
 * Doors (D-012): launch (role-launch spec compile, SU bootstrap), switch/rebind
 * (identity-management), restart (SU persona refresh, codex home repair). Launch and switch
 * assert the stack is funded; restart doors rebuild through the funded variant, which drops a
 * refused priced layer instead of keeping it fail-soft.
 *
 * Matching runs on comment- and string-masked source, so a call left only in a comment or a
 * string does not satisfy the guard. The controls below prove that masking is live.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripCommentsAndStrings } from '../../../../scripts/lib/strip-comments-and-strings.mjs';

const LIB = resolve(__dirname, '..');

interface Door {
  door: string;
  file: string;
  call: 'assertIdentityActivationFunded' | 'rebuildSuLaunchArtifactFunded';
}

const DOORS: readonly Door[] = [
  { door: 'launch: role launch spec', file: 'role-launch-spec.ts', call: 'assertIdentityActivationFunded' },
  { door: 'launch: SU bootstrap', file: 'endpoint-route/routes/agent-mcp/bootstrap-su.ts', call: 'assertIdentityActivationFunded' },
  { door: 'switch/rebind: identity management', file: 'identity-management.ts', call: 'assertIdentityActivationFunded' },
  { door: 'restart: codex home repair', file: 'endpoint-route/routes/adv/sessions.ts', call: 'rebuildSuLaunchArtifactFunded' },
  { door: 'restart: SU persona refresh', file: 'endpoint-route/routes/agent-mcp/bootstrap-su-persona-refresh.ts', call: 'rebuildSuLaunchArtifactFunded' },
];

function masked(file: string): string {
  return stripCommentsAndStrings(readFileSync(resolve(LIB, file), 'utf8'), file) as string;
}

function callsIn(source: string, call: string): number {
  return source.match(new RegExp(`\\b${call}\\s*\\(`, 'g'))?.length ?? 0;
}

describe('identity activation doors route through the funding gate (P-016)', () => {
  it.each(DOORS)('$door calls $call', ({ file, call }) => {
    expect(callsIn(masked(file), call), `${file} must call ${call}(…)`).toBeGreaterThanOrEqual(1);
  });

  it('the gate symbols the doors call are real exports (positive control)', () => {
    expect(readFileSync(resolve(LIB, 'cupboard/identity-activation-gate-io.ts'), 'utf8'))
      .toMatch(/export async function assertIdentityActivationFunded\s*\(/);
    expect(readFileSync(resolve(LIB, 'cupboard/identity-activation-restart.ts'), 'utf8'))
      .toMatch(/export async function rebuildSuLaunchArtifactFunded\s*\(/);
  });

  it('a call present only in a comment or a string does not count (masking control)', () => {
    const decoy = [
      '// await assertIdentityActivationFunded({ stack });',
      "const note = 'rebuildSuLaunchArtifactFunded(input)';",
      'export const x = 1;',
    ].join('\n');
    const m = stripCommentsAndStrings(decoy, 'decoy.ts') as string;
    expect(callsIn(decoy, 'assertIdentityActivationFunded')).toBe(1);
    expect(callsIn(m, 'assertIdentityActivationFunded')).toBe(0);
    expect(callsIn(m, 'rebuildSuLaunchArtifactFunded')).toBe(0);
  });
});
