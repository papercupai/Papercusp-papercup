/** P016 reporter journey, registered in the scheduled Tauri surface suite. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import postgres from 'postgres';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';
import { defaultEvidenceRoot, parseSelectionArgs, runHarness } from '@papercusp/verification-harness';
import { sealImplementationAcceptance, createImplementationReadiness } from '../packages/operator-core/lib/harness/improvements/agent-review-policy.ts';
import { bakedCanonicalHiveInvite } from '../packages/operator-core/lib/harness/papercusp-hive-join.ts';
import { insertHiveIfAbsent, getHiveByPubkey } from '../packages/operator-core/lib/hive-store.ts';
// apps/operator is a CommonJS package under tsx, unlike this .mts entry.
const { defaultReporterReleaseDeps, publishReporterRelease } = createRequire(import.meta.url)(
  '../apps/operator/lib/release/reporter-release.ts',
) as typeof import('../apps/operator/lib/release/reporter-release.ts');

// Cheap runtime preflight before the expensive desktop boot; catches package
// export/loader mismatches that a TypeScript-only check cannot exercise.
if (process.argv.includes('--check-imports')) {
  assert.equal(typeof publishReporterRelease, 'function');
  assert.equal(typeof defaultReporterReleaseDeps, 'function');
  assert.equal(typeof sealImplementationAcceptance, 'function');
  assert.equal(typeof insertHiveIfAbsent, 'function');
  assert.ok(bakedCanonicalHiveInvite(), 'canonical membership fixture needs the baked public invite');
  console.log('REPORTER_STATUS_IMPORTS_OK');
  process.exit(0);
}

const selection = parseSelectionArgs(process.argv.slice(2));
const result = await runHarness({
  contract: { name: 'reporter-status-tauri', phases: [{ id: 'native', description: 'Preview, receipt subscription, fixer question, consented reply and published fix notification' }] },
  evidenceRoot: defaultEvidenceRoot('reporter-status-tauri'), selection, reuseFrom: selection.reuse,
  async runPhase(ctx) {
    assert.equal(process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED, '1', 'Requires isolated verifier DB');
    const isolatedPg = resolveScriptPgUrl();
    assert.ok(
      isolatedPg.source === 'env' && 'via' in isolatedPg && isolatedPg.via === 'HARNESS_ADMIN_DATABASE_URL' &&
      !isolatedPg.envLocal.applied.includes('HARNESS_ADMIN_DATABASE_URL'),
      'Requires an explicitly supplied isolated admin database URL',
    );
    assert.ok(process.env.VERIFY_TAURI_PID);
    const sql = postgres(isolatedPg.url, { max: 1, onnotice: () => {} });
    const ws = process.env.PAPERCUSP_WORKSPACE_ID ?? process.env.PAPERCUSP_WORKSPACE!;
    const pid = process.env.VERIFY_TAURI_PID!;
    const tool = process.env.VERIFY_TAURI_AGENT_TOOLS_BIN ?? 'tauri-agent-tools';
    const native = (...args: string[]) => execFileSync(tool, [...args, '--pid', pid], { encoding: 'utf8', timeout: 60_000 });
    const ev = (script: string) => native('eval', script);
    const wait = (script: string) => native('wait', '--eval', script, '--timeout', '60000', '--interval', '500');
    const clickText = (text: string) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('missing button');b.click();return true})()`);
    const type = (selector: string, text: string) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing report field');const prototype=e instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    const capture = (name: string) => {
      writeFileSync(join(ctx.evidenceDir, `${name}.json`), ev('JSON.stringify({url:location.href,body:document.body.innerText})'));
      native('screenshot', '--selector', 'html', '--title', '^Papercusp$', '--output', join(ctx.evidenceDir, `${name}.png`));
    };
    try {
      // The maintained ready seed provisions onboarding/principals, not joined
      // Pots. Background bootstrap is deliberately disabled in the isolated
      // host. Seed the existing membership store and read it back, rather than
      // weakening the production contribution membership gate.
      ctx.markStep('canonical-membership-fixture');
      const invite = bakedCanonicalHiveInvite();
      assert.ok(invite, 'missing baked canonical invite');
      await insertHiveIfAbsent({ workspaceId: ws, homeSlug: 'papercusp',
        pubkeyBase64: invite.pubkeyBase64, keychainId: 'remote:reporter-status-fixture', title: 'Canonical report fixture' }, sql);
      assert.equal((await getHiveByPubkey(ws, invite.pubkeyBase64, sql))?.pubkeyBase64, invite.pubkeyBase64);
      ctx.markStep('submit-previewed-report');
      native('navigate', '/inbox?report=true', '--json');
      wait("!!document.querySelector('[data-testid=report-problem-text]')");
      const marker = `P016 export crashes ${Date.now()}`;
      type('[data-testid=report-problem-text]', marker);
      clickText('Review');
      wait("!!document.querySelector('[data-testid=report-problem-dialog] pre')");
      capture('preview');
      ctx.markStep('preview-and-consent-screenshot');
      clickText('Capture screenshot');
      wait("(()=>{const img=document.querySelector('[data-testid=report-problem-screenshot-preview] img');return img?.complete&&img.naturalWidth>100&&img.naturalHeight>100})()");
      assert.equal(ev("document.querySelector('[data-testid=report-problem-attach-screenshot]').getAttribute('aria-checked')").trim().replace(/^"|"$/g, ''), 'false');
      const [beforeConsent] = await sql`SELECT count(*)::int AS count FROM harness_shared.work_items
        WHERE workspace_id = ${ws} AND title LIKE ${`%${marker}%`}`;
      assert.equal(beforeConsent?.count, 0, 'capture sent the report before consent');
      capture('screenshot-preview');
      ev("document.querySelector('[data-testid=report-problem-attach-screenshot]').click()");
      clickText('Send');
      wait("document.querySelector('[data-testid=report-problem-dialog]')?.innerText.includes('your report was filed')");
      const [source] = await sql<{ feature_id: string; title: string; summary: string; payload: Record<string, unknown> }[]>`
        SELECT feature_id, title, summary, payload FROM harness_shared.work_items WHERE workspace_id = ${ws} AND title LIKE ${`%${marker}%`}`;
      assert.ok(source, 'real report missing');
      const [image] = await sql<{ content: Buffer; redaction: string }[]>`SELECT content, redaction
        FROM harness_shared.report_attachments WHERE workspace_id = ${ws}
        AND work_item_id = ${source.feature_id} AND kind = 'screenshot'`;
      assert.equal(image?.redaction, 'not-redactable');
      assert.ok(image.content.byteLength > 8);
      assert.deepEqual([...image.content.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      clickText('Close');
      const acceptance = sealImplementationAcceptance({ source: { kind: 'bug', title: source.title, summary: source.summary },
        proposal: { problem: source.summary, evidence: ['isolated export failure'], outcome: 'Export works', scope: 'Export only', completionCheck: 'Export reproduction passes' },
        authority: { kind: 'agent-review', reviewer: 'su-native-reviewer', submittedBy: 'su-native-filer', round: 1 }, reason: 'fixture reproduced', acceptedAt: new Date().toISOString(),
        reproduction: { kind: 'failing-test', ref: 'reporter-status-tauri fixture', buildSha: 'abcdef1' } });
      assert.equal(acceptance.ok, true);
      if (!acceptance.ok) throw Error('acceptance fixture refused');
      const question = { id: 'native-question', text: 'Which export file causes the crash?', askedBy: 'su-native-fixer', askedAt: new Date().toISOString() };
      await sql`UPDATE harness_shared.work_items SET taken_by = 'su-native-fixer', payload = payload || ${sql.json(JSON.parse(JSON.stringify({
        implementationReadiness: createImplementationReadiness({ status: 'ready', source: 'agent-review', reason: 'fixture accepted', updatedAt: new Date().toISOString(), evidence: { acceptance: acceptance.contract } }),
        reporterQuestion: question,
      })))}::jsonb WHERE workspace_id = ${ws} AND feature_id = ${source.feature_id}`;
      const [questionFixture] = await sql`SELECT jsonb_typeof(payload) AS payload_type,
        payload->'reporterQuestion'->>'id' AS question_id FROM harness_shared.work_items
        WHERE workspace_id = ${ws} AND feature_id = ${source.feature_id}`;
      assert.equal(questionFixture?.payload_type, 'object', 'fixture payload must remain a JSON object');
      assert.equal(questionFixture?.question_id, question.id, 'question fixture did not persist');
      ctx.markStep('push-question-and-previewed-reply');
      wait("[...document.querySelectorAll('[data-sonner-toast]')].some(e=>e.innerText.includes('Which export file causes the crash?'))");
      clickText('View report');
      wait("!!document.querySelector('[aria-label=\"Your report\"] textarea')");
      type('[aria-label="Your report"] textarea', 'sample.csv; OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456');
      clickText('Review reply');
      wait("document.querySelector('[aria-label=\"Your report\"] pre')?.textContent.includes('sample.csv')");
      assert.equal(ev("String(document.querySelector('[aria-label=\"Your report\"] pre').textContent.includes('sk-abcdefghijklmnopqrstuvwxyz123456'))").trim().replace(/^"|"$/g, ''), 'false');
      const [before] = await sql`SELECT payload->'reporterAnswer' AS answer FROM harness_shared.work_items WHERE feature_id = ${source.feature_id}`;
      assert.equal(before!.answer, null, 'reply sent before consent');
      capture('reply-preview');
      clickText('Send reply');
      wait("document.querySelector('[aria-label=\"Your report\"]')?.innerText.includes('Your reply')");
      const [after] = await sql`SELECT payload->'reporterAnswer' AS answer FROM harness_shared.work_items WHERE feature_id = ${source.feature_id}`;
      assert.equal(after!.answer.questionId, question.id);
      assert.ok(!after!.answer.text.includes('sk-abcdefghijklmnopqrstuvwxyz123456'));
      ctx.markStep('published-exact-fix-notification');
      const blob = 'b'.repeat(40);
      await sql`UPDATE harness_shared.work_items SET status = 'done', authority = 'committed', terminal_completion_ref = 'native-completion',
        payload = payload || ${sql.json({ _completionEvidence: { settlementManifest: { repositoryRoot: '/native-fixture',
          contentIdentity: [{ path: 'src/export.ts', headBlobSha: blob, workingTreeBlobSha: blob }] } } })}::jsonb
        WHERE workspace_id = ${ws} AND feature_id = ${source.feature_id}`;
      const [completionFixture] = await sql`SELECT jsonb_typeof(payload) AS payload_type,
        payload->'_completionEvidence'->'settlementManifest'->>'repositoryRoot' AS repository_root
        FROM harness_shared.work_items WHERE workspace_id = ${ws} AND feature_id = ${source.feature_id}`;
      assert.equal(completionFixture?.payload_type, 'object', 'completion fixture payload must remain a JSON object');
      assert.equal(completionFixture?.repository_root, '/native-fixture', 'completion fixture did not persist');
      wait("document.querySelector('[aria-label=\"Your report\"]')?.innerText.includes('Fix verified; awaiting release')");
      assert.equal(ev("String(document.body.innerText.includes('Fixed in v0.9.5'))").trim().replace(/^"|"$/g, ''), 'false');
      const release = { version: '0.9.5', channel: 'alpha', cutAt: new Date(), publishedAt: new Date(), changelogMd: null,
        workItemIds: [source.feature_id], planSlugs: [], artifacts: [], gitSha: 'a'.repeat(40), cutBy: null, notes: null };
      assert.deepEqual(await publishReporterRelease(release, { ...defaultReporterReleaseDeps(sql, ws, release), repositoryRoot: '/native-fixture',
        readBlobs: async () => new Map([['src/export.ts', { status: 'resolved', sha: blob }]]) }), { notified: [source.feature_id], unconfirmed: [] });
      wait("document.querySelector('[aria-label=\"Your report\"]')?.innerText.includes('Fixed in v0.9.5') && [...document.querySelectorAll('[data-sonner-toast]')].some(e=>e.innerText.includes('Fixed in v0.9.5'))");
      capture('published-notification');
      return { ok: true };
    } catch (error) { capture('failure'); throw error; }
    finally { await sql.end(); }
  },
});
console.log(`P016_TAURI_SURFACE_VERIFY_${result.verdict === 'pass' ? 'OK' : 'FAIL'} leg=reporter-status output=${result.evidenceDir}`);
process.exitCode = result.verdict === 'pass' ? 0 : 1;
