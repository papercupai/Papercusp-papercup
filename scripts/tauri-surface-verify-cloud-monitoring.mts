/** Ledger-recorded local usage and disclosure acceptance in the maintained native rig. */
// VERIFY_TAURI_ASSERTION_REQUIRED_ENV=PAPERCUSP_TEST_RUNS_DB_URL,PAPERCUSP_TEST_RUN_WORKSPACE,PAPERCUSP_TEST_RUN_GROUP
import { defaultEvidenceRoot, parseSelectionArgs, runHarness } from '@papercusp/verification-harness';
import { checkNativeLedger, runNativeE2e } from './tauri-surface-verify-reports.mts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

if (process.argv.includes('--check-ledger')) {
  checkNativeLedger();
  // Admit the real built docs before allocating the expensive native rig. The
  // frozen operator source omits generated assets; its host needs this explicit
  // existing docs mount, just like the packaged desktop sidecar.
  const root = process.env.PAPERCUSP_DOCS_ROOT;
  assert.ok(root && isAbsolute(root), 'Set PAPERCUSP_DOCS_ROOT to the built Starlight docs');
  const markdown = readFileSync(join(process.cwd(), 'apps/operator-docs/src/content/docs/posthog/index.mdx'), 'utf8');
  const events = [...new Set(markdown.match(/cloud_[a-z_]+/g) ?? [])];
  assert.ok(events.length > 0, 'Disclosure must declare the production events');
  const html = readFileSync(join(root, 'posthog.html'), 'utf8');
  for (const event of events) assert.ok(html.includes(event), 'Built disclosure is missing ' + event);
  for (const term of ['retention', 'revocation', 'flags.papercuspai.com']) {
    assert.ok(html.toLowerCase().includes(term), 'Built disclosure is missing ' + term);
  }
  console.info('CLOUD_MONITORING_NATIVE_DOCS_PREFLIGHT ' + JSON.stringify({ root,
    sha256: createHash('sha256').update(html).digest('hex'), events }));
  console.info('CLOUD_MONITORING_NATIVE_LEDGER_PREFLIGHT_OK');
} else {
  const selection = parseSelectionArgs(process.argv.slice(2));
  const result = await runHarness({
    contract: { name: 'cloud-monitoring-native',
      phases: [{ id: 'native', description: 'Customer-local per-call usage and disclosure reader' }] },
    evidenceRoot: defaultEvidenceRoot('cloud-monitoring-native'), selection, reuseFrom: selection.reuse,
    async runPhase(ctx) {
      ctx.markStep('isolated-native-cloud-monitoring');
      await runNativeE2e(['packages/operator-core/lib/cloud-monitoring-native.e2e.test.ts'],
        { runtimeUnit: 'cloud-monitoring-native-desktop' });
      return { ok: true };
    },
  });
  console.info(`CLOUD_MONITORING_NATIVE_${result.verdict.toUpperCase()} evidence=${result.evidenceDir}`);
  process.exitCode = result.verdict === 'pass' ? 0 : 1;
}
