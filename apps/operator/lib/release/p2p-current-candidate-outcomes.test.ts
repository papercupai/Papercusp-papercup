/**
 * D297 real-current-candidate acceptance, WI-6554700010020476.
 * Candidate selection is private runtime DATA: a JSON file containing existing
 * ComputeOptions plus workspaceId/harnessSlug. No frozen source/digest edits,
 * synthetic originals, reader injection, mocks, status proxies or skipped tests.
 * This test reads evidence; it never cuts, builds, enrolls or runs a physical rig.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  computeCandidateManifestFromRecords, databaseDeps,
  type ComputeOptions, type ComputeResult,
} from './run-p2p-candidate-manifest';

interface Selection extends ComputeOptions { workspaceId: string; harnessSlug: string }
interface Outcomes {
  ok: boolean;
  candidateAcceptance: unknown | null;
  checks: Array<{ id: string; status: string; detail: string }>;
}
const JOURNEYS = ['discovery-join', 'git-consistency-signed-scope', 'serving-identity-restart',
  'replicated-write-outage-replay', 'delegated-seat-lifecycle', 'protected-effect-fencing',
  'github-bridge', 'full-installer-compat'];
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('authenticates the externally selected current candidate through the real computed original reader', async () => {
  let result: ComputeResult | undefined;
  let acquisition = 'current candidate input has not been acquired';
  let close: (() => Promise<void>) | undefined;
  try {
    const path = process.env.PAPERCUSP_P521_CANDIDATE_OPTIONS;
    if (!path) acquisition = 'PAPERCUSP_P521_CANDIDATE_OPTIONS is unset: no canonical current candidate selected';
    else {
      const selectionPath = resolve(root, path);
      const selectionBytes = readFileSync(selectionPath);
      const selection: Selection = JSON.parse(selectionBytes.toString('utf8'));
      const keys = ['workspaceId', 'harnessSlug', 'version', 'channel', 'legs', 'evidenceDir'];
      const named = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
      if (!selection || Object.keys(selection).some(key => !keys.includes(key))
          || !keys.filter(key => key !== 'legs').every(key => named(Reflect.get(selection, key)))
          || !Array.isArray(selection.legs) || !selection.legs.length
          || selection.legs.some(leg => !leg || !named(leg.leg) || !named(leg.path)
            || Object.keys(leg).some(key => key !== 'leg' && key !== 'path'))
          || new Set(selection.legs.map(leg => leg.leg)).size !== selection.legs.length
          || new Set(selection.legs.map(leg => resolve(root, leg.path))).size !== selection.legs.length) {
        acquisition = 'current candidate selection has malformed, duplicate, incomplete or non-locator fields';
      } else if (selection.workspaceId !== process.env.PAPERCUSP_WORKSPACE_ID
          || selection.harnessSlug !== process.env.PAPERCUSP_TEST_RUN_HARNESS) {
        acquisition = 'current candidate selection does not match the authenticated native runner scope';
      } else {
        const artifactDir = process.env.PAPERCUSP_TEST_ARTIFACT_DIR;
        const inputsDir = process.env.PC_EXECUTED_INPUTS_DIR;
        if (!artifactDir || !inputsDir) throw new Error('native runtime-input recorder is unavailable');
        const manifest = JSON.parse(readFileSync(join(artifactDir, 'manifest.json'), 'utf8'));
        if (manifest.runId !== process.env.PAPERCUSP_TEST_RUN_GROUP || manifest.root !== root.replace(/\/$/, '')
            || manifest.paths?.runtimeInputs !== inputsDir) throw new Error('native selection recorder is unbound');
        // Extend the runner's existing private executed-inputs packet. The
        // manifest/source already point to this directory. No public paths or
        // original bytes are printed, and this record confers no candidate trust.
        writeFileSync(join(inputsDir, 'p521-current-candidate-selection.json'), JSON.stringify({
          schemaVersion: 'p521-current-candidate-selection/v1', runId: manifest.runId,
          workspaceId: selection.workspaceId, harnessSlug: selection.harnessSlug,
          path: selectionPath, sha256: sha(selectionBytes), bytesBase64: selectionBytes.toString('base64'),
        }) + '\n', { mode: 0o600, flag: 'wx' });
        const [{ default: postgres }, { getHarnessAdminUrl }] = await Promise.all([
          import('postgres'), import('../../../../packages/operator-core/lib/embedded-pg-discovery'),
        ]);
        // Exactly the maintained computed CLI database adapter. Never replace its
        // original reader/hash implementation with values from the input file.
        const sql = postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 10 });
        close = () => sql.end({ timeout: 5 });
        result = await computeCandidateManifestFromRecords({
          version: selection.version, channel: selection.channel,
          legs: selection.legs.map(leg => ({ leg: leg.leg, path: resolve(root, leg.path) })),
          evidenceDir: resolve(root, selection.evidenceDir!), repoRoot: root, rehash: 'all', now: Date.now(),
        }, databaseDeps(sql as unknown as Parameters<typeof databaseDeps>[0], selection.workspaceId));
        if (!readFileSync(selectionPath).equals(selectionBytes)) {
          result = undefined;
          throw new Error('current candidate selection changed during execution');
        }
        acquisition = 'canonical candidate was computed with the real database adapter';
      }
    }
  } catch (error) {
    // Missing/unreadable originals remain an assertion failure in this test,
    // never a collection/hook failure or an optional skipped acceptance case.
    acquisition = `canonical current candidate acquisition failed (${error instanceof Error ? error.name : 'unknown error'})`;
  } finally {
    if (close) try { await close(); } catch {
      result = undefined; acquisition = 'canonical current candidate reader did not close cleanly';
    }
  }

  const outcomes = result && Reflect.get(result, 'outcomes') as Outcomes | undefined;
  expect(outcomes, `P-521 real current candidate acceptance is unavailable: ${acquisition}`)
    .toEqual(expect.objectContaining({ checks: expect.any(Array) }));
  const checks = outcomes!.checks.filter(check => check.id === 'P-521');
  expect(checks, 'one aggregate P-521 check must be derived from canonical originals').toHaveLength(1);
  expect(checks[0], 'real signed originals must satisfy the complete current-candidate outcome').toMatchObject({ status: 'pass' });
  expect(outcomes!.candidateAcceptance, 'the authenticated current-candidate outcome must be retained').toBeTruthy();
  expect(outcomes!.candidateAcceptance, 'the authenticated outcome must be an object').toBeTypeOf('object');
  expect(Array.isArray(outcomes!.candidateAcceptance), 'an array is not a candidate acceptance record').toBe(false);
  expect(Object.keys(outcomes!.candidateAcceptance as object), 'an empty acceptance record is insufficient').not.toHaveLength(0);
  expect(result!.provenance.sourceSha).toMatch(/^[0-9a-f]{40}$/);
  expect(result!.provenance.provenance.candidateDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(result!.provenance.provenance.checks.filter(check => check.status === 'fail')).toEqual([]);
  expect(result!.manifest.current.rows.map(row => row.capability)).toEqual(JOURNEYS);
  expect(result!.manifest.current.go, 'complete current-candidate journey readiness is required').toBe(true);
}, 120_000);
