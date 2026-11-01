import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  formatMinePeerDriftBanner,
  formatUncoveredFilesBanner,
  runCrossLegChecks,
  suggestTypecheckGate,
} from './tsc-baseline-gate.mjs';

test('--mine output describes the current shared dirty set without attributing it to the caller', () => {
  const lines = formatMinePeerDriftBanner({ outsideCount: 2 });
  assert.equal(
    lines[0],
    '✓ The current --mine dirty set is tsc-clean. 2 baseline-regressed file(s) are outside that set:',
  );
  assert.ok(lines.some((line) => line.includes("other sessions' dirty edits")));
  assert.ok(lines.some((line) => line.includes('--files= for explicit attribution')));
  assert.ok(!lines.some((line) => line.includes('Your changed files')));
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('mixed operator and backup follow-up accounts for every unchecked file', () => {
  const operator = [
    'apps/operator/scripts/__tests__/kopia-home-snapshot.test.ts',
    'apps/operator/scripts/__tests__/kopia-snapshot-source-order.test.ts',
  ];
  const backup = ['hook', 'destinations', 'policy', 'scheduler']
    .map((name) => `packages/backup/src/${name}.test.ts`);
  const uncovered = [...operator, ...backup];
  const banner = formatUncoveredFilesBanner({
    label: 'operator-core', uncovered, fatal: false,
    suggestions: new Map(uncovered.map((file) => [file, suggestTypecheckGate(ROOT, file)])),
    siblingGates: [{ npmScript: 'lint:tsc:operator', prefixes: ['apps/operator/'] }],
  });
  const text = banner.join('\n');
  assert.match(text, /6 of the file\(s\)/);
  assert.equal(banner.filter((line) => line.includes('RUN THIS')).length, 2);
  assert.ok(text.includes(`npm run lint:tsc:operator -- --files=${operator.join(',')}`));
  assert.ok(text.includes('npm run --workspace packages/backup typecheck'));
  for (const file of uncovered) {
    assert.equal(banner.filter((line) => line.trim() === `- ${file}`).length, 1, file);
  }
  assert.ok(!text.includes('No typecheck gate FOUND'));
});

test('mixed follow-up explicitly discloses a file with no owning gate', () => {
  const owned = 'packages/backup/src/hook.test.ts';
  const unknown = 'unregistered-fixture/no-owner.ts';
  const banner = formatUncoveredFilesBanner({
    label: 'operator-core', uncovered: [owned, unknown], fatal: false,
    suggestions: new Map([[owned, suggestTypecheckGate(ROOT, owned)], [unknown, null]]),
  });
  const text = banner.join('\n');
  assert.ok(text.includes('npm run --workspace packages/backup typecheck'));
  const gap = banner.findIndex((line) => line.includes('No typecheck gate FOUND'));
  assert.ok(gap >= 0);
  assert.ok(banner.slice(gap + 1).some((line) => line.trim() === `- ${unknown}`));
});

test('mixed-file typecheck routing offers an owning command for packages/backup files', () => {
    const suggestion = suggestTypecheckGate(ROOT, 'packages/backup/src/hook.test.ts');
    assert.equal(suggestion?.workspaceDir, 'packages/backup');
    assert.equal(suggestion?.command, 'npm run --workspace packages/backup typecheck');

    const banner = formatUncoveredFilesBanner({
      label: 'operator-core',
      uncovered: ['packages/backup/src/hook.test.ts'],
      suggestions: new Map([['packages/backup/src/hook.test.ts', suggestion]]),
      fatal: false,
    });
    assert.match(banner.join('\n'), /npm run --workspace packages\/backup typecheck/);
    assert.match(banner.join('\n'), /packages\/backup\/src\/hook\.test\.ts/);
});

test('cross-leg child timeout resets across queued service and fallback compiler progress', async (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'papercusp-cross-leg-progress-'));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
  const scriptPath = join(fixtureDir, 'consumer.mjs');
  writeFileSync(scriptPath, [
    "console.log('TSC_SERVICE state=queued requestId=fixture resultOrigin=pending');",
    "setTimeout(() => console.log('LINT_TSC_CROSS_LEG_PROGRESS leg=operator phase=program-start elapsedMs=400'), 400);",
    "setTimeout(() => console.log('LINT_TSC_CROSS_LEG_PROGRESS leg=operator phase=diagnostics-start elapsedMs=900'), 900);",
    "setTimeout(() => console.log('LINT_TSC_CROSS_LEG leg=operator status=clean members=1'), 1400);",
  ].join('\n'));

  const result = await runCrossLegChecks({
    root: ROOT,
    plans: [{ npmScript: 'lint:tsc:operator', scriptPath, files: ['packages/operator-core/lib/example.ts'] }],
    childTimeoutMs: 1000,
  });

  assert.deepEqual(result, {
    clean: ['lint:tsc:operator'],
    notMember: [],
    red: [],
    undetermined: [],
  });
});

test('cross-leg child with no compiler progress remains undetermined', async (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'papercusp-cross-leg-stall-'));
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
  const scriptPath = join(fixtureDir, 'stalled-consumer.mjs');
  writeFileSync(scriptPath, 'setTimeout(() => {}, 5000);\n');

  const result = await runCrossLegChecks({
    root: ROOT,
    plans: [{ npmScript: 'lint:tsc:operator', scriptPath, files: ['packages/operator-core/lib/example.ts'] }],
    childTimeoutMs: 200,
  });

  assert.deepEqual(result.clean, []);
  assert.equal(result.undetermined.length, 1);
  assert.match(result.undetermined[0].reason, /made no compiler progress for 200ms/);
});
