# Reproducible public PUI rubric review, revision 16

Historical custody note (2026-10-10): the input checksum used by this review is
`1737bde672cbdcc87fe01be3d45596cf95f829c9cdfc0903fff1a961d4e1838e`. The
currently retained JSON has a different checksum,
`5041674afe02a088ef7eb562d8219d39d6409aa9c129e2252194d61277952b7f`, and is
available unchanged from git commit `55230955c6e0083703b8bf3de664f2f5342a69c3`
at `docs/evidence/pui-public-rubric16-repro-f2d9.json`. A byte-identical copy was
saved and read back through `artifacts:load` with `slug:"papercusp"` and
`rel_path:"evidence/pui-public-rubric16-plan147/raw-5041674afe02a088ef7eb562d8219d39d6409aa9c129e2252194d61277952b7f.json"`.
The original reviewed bytes were recovered on 2026-10-10 from the retained
creation inputs and the exact textual bootstrap patch. Native session
`codex:01a122f0-2996-71c0-8940-31ffda5328d5`, tool parts 77/78 and 110/111,
records both the initial `b9a9a23f67d8d07036e4edb60c9c318e2be698b5807dfc69cf2ab58cf4d88657`
and final reviewed `1737bde672cbdcc87fe01be3d45596cf95f829c9cdfc0903fff1a961d4e1838e`
checksums. Replaying the creation and the patch's exact formatting matched both.
The 133,792 original UTF-8 bytes were saved privately through `artifacts:save`
and verified after `artifacts:load`, with an independent hash of the canonical
stored content. Retrieve them with `artifacts:load { slug:"papercusp",
rel_path:"evidence/pui-public-rubric16-plan147/raw-1737bde672cbdcc87fe01be3d45596cf95f829c9cdfc0903fff1a961d4e1838e.json" }`.
The historical commands below retain their original checksum guard; use those
archived original bytes as their input. This document does not attest the
different tracked edition.
Use [the independently reviewed plan-150 snapshot](pui-public-rubric16-repro-plan150.md)
for current rubric evidence; neither edition supplies installed-product proof
or final-candidate approval.

Subject: `acceptance-pui-first-party-public-release-2026-09-07@16`, criteria hash `9dd8a68c940e70de35f5fa8e9ca3bb318ffbd299cc8fb0b609d76d6a35527b09`. Source generation: `f2d92cbc8ad685b843e70c83718ac7a8d1a45371`. The frozen plan is revision 147, content hash `c7ea8a7d4c71104b7e86bf2ee8c56c8c1278a278f17838d58cead5323964b53d`.

Input: [pui-public-rubric16-repro-f2d9.json](pui-public-rubric16-repro-f2d9.json), SHA-256 `1737bde672cbdcc87fe01be3d45596cf95f829c9cdfc0903fff1a961d4e1838e`. It contains the complete current 15 criteria, all 45 decision bodies, explicit decision exclusions, and the compiler, its runtime helper, and test-source digests. Revision 15 and reviewer post `thread-post:1169462` remain historical evidence; neither is a revision-16 attestation.

Revision 16 adds the existing attached-live suite to R-03, agent-chat PTY to R-08, public-package to R-10, and release-acceptance to R-12. Every structured replication now names its complete source set. The platform preview classified the additions as approvalRequired=false; its apply recorded D-045 and moved plan 146 to 147. Models, numbered falsifiers, evidence planes, required layers, and candidate approval/publication gates were preserved.

Run both commands from the canonical repository. They need the retained git objects and either verified runtime, Node v22.21.1 or v25.9.0. They do not need an acceptance checkout, installed project dependencies, tsx, or a package loader. The shell removes NODE_OPTIONS before Node starts, and the compiler and its runtime helper are hashed before either is evaluated. Both runtimes produced identical stripped JavaScript for both verified TypeScript inputs; the command checks those output hashes before evaluation as a recurrence guard for stripper changes.

Reviewer post `thread-post:1169495` cleared the prior semantic and replication-source blockers but refused the original compiler command because the reviewer's canonical PATH supplied Node v22.21.1 rather than v25.9.0. This edition replaces that single-runtime assumption with the two directly verified runtimes and exact stripped-byte hashes. The earlier input digest was `b9a9a23f67d8d07036e4edb60c9c318e2be698b5807dfc69cf2ab58cf4d88657`; criterion and plan hashes did not change.

```bash
env -u NODE_OPTIONS node --input-type=commonjs - docs/evidence/pui-public-rubric16-repro-f2d9.json <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const bytes = fs.readFileSync(process.argv[2]);
assert.equal(createHash('sha256').update(bytes).digest('hex'), '1737bde672cbdcc87fe01be3d45596cf95f829c9cdfc0903fff1a961d4e1838e');
const s = JSON.parse(bytes);
const source = file => execFileSync('git', ['show', s.testedSha + ':' + file], {encoding:'utf8'});
const sources = new Map();
for (const [file, digest] of Object.entries(s.sourceSha256)) {
  const text = source(file);
  assert.equal(createHash('sha256').update(text).digest('hex'), digest, file);
  sources.set(file, text);
}
const aliases = {
  'su-session-capability-parity': 'packages/operator-core/lib/su-session-capability-parity.test.ts',
  'attached-live': 'packages/operator-core/lib/su-session-attached-live.integration.test.ts',
  'agent-chat': 'packages/operator-core/lib/pui-e2e/agent-chat-pty.integration.test.ts',
  'context-pane': 'packages/operator-core/lib/pui-e2e/context-pane-cockpit-pty.integration.test.ts',
  'public-package': 'packages/operator-core/lib/pui-e2e/public-package.integration.test.ts',
  'release-acceptance': 'packages/operator-core/lib/pui-e2e/release-acceptance.integration.test.ts',
};
function replicationReferences(c) {
  const split = c.replication.split('\nREPLICATION SOURCES: ');
  assert.equal(split.length, 2, c.key + ': explicit replication source set');
  const refs = split[1].replace(/\.$/, '').split('; ');
  assert.deepEqual([...refs].sort(), [...c.check.files].sort(), c.key + ': replication/check source equality');
  for (const file of refs) assert.ok(sources.has(file), c.key + ': unhashed replication source ' + file);
  for (const [alias,file] of Object.entries(aliases)) if (split[0].includes(alias)) assert.ok(refs.includes(file), c.key + ': unbound ' + alias);
  const content = refs.map(file => sources.get(file)).join('\n');
  const quoted = [...split[0].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  for (const title of quoted) assert.ok(content.includes(title), c.key + ': replication case fragment absent: ' + title);
  for (const marker of split[0].matchAll(/AUTO-BAR-R-\d+-P-\d+/g)) assert.ok(content.includes(marker[0]), c.key + ': replication marker absent: ' + marker[0]);
  return {refs:refs.length, cases:quoted.length};
}
let named=0, structured=0, manual=0, replicationFiles=0, replicationCases=0;
for (const c of s.criteria) {
  assert.match(c.driftMarkers, /^BROKEN if any ONE holds: \(1\)/);
  assert.match(c.method, /GOAL CLAUSE:/); assert.match(c.method, /RATING BASIS:/);
  if (c.check.kind === 'instrument') {
    assert.equal(c.key,'r-15'); assert.equal(c.check.instrumentKey,'none');
    assert.match(c.method,/EVIDENCE ARTIFACTS/); manual++; continue;
  }
  assert.equal(c.check.kind,'tests'); structured++;
  const content=c.check.files.map(file => { assert.ok(sources.has(file),file); return sources.get(file); }).join('\n');
  const titles=[...(c.method.split('NAMED CASES')[1] ?? '').matchAll(/(?:[:;,(]\s*)'(.{12,}?)'(?=[;.,)\s]|$)/g)].map(m=>m[1]);
  assert.ok(titles.length,c.key);
  for (const title of titles) {
    const literal=title.split(/\$\{[^}]*\}|%s/).sort((a,b)=>b.length-a.length)[0];
    assert.ok(content.includes(literal),c.key+': named case absent '+title); named++;
  }
  const checked=replicationReferences(c); replicationFiles+=checked.refs; replicationCases+=checked.cases;
}
let cited=0, excluded=0;
for (const d of s.decisions) {
  assert.ok(d.body.length,d.id+': full decision body missing');
  const mention=s.criteria.some(c=>['model','method','driftMarkers','replication'].some(k=>String(c[k]).includes(d.id)));
  assert.ok(mention !== Boolean(s.decisionExclusions[d.id]),d.id+': exactly one lexical citation/exclusion');
  if (mention) cited++; else excluded++;
}
for (const id of Object.keys(s.decisionExclusions)) assert.ok(s.decisions.some(d=>d.id===id));
// These negative probes exercise the new refusal boundary; they do not grade the product.
for (const [key,file] of [['r-03',aliases['attached-live']],['r-08',aliases['agent-chat']],['r-10',aliases['public-package']],['r-12',aliases['release-acceptance']]]) {
  const mutant=structuredClone(s.criteria.find(c=>c.key===key));
  mutant.check.files=mutant.check.files.filter(f=>f!==file);
  assert.throws(()=>replicationReferences(mutant),{name:'AssertionError'},key+': missing-binding mutant escaped');
}
assert.equal(s.criteria.length,15); assert.equal(named,61); assert.equal(structured,14); assert.equal(manual,1); assert.equal(s.decisions.length,45);
console.log(JSON.stringify({criteria:15,named,structured,manual,decisions:45,lexicallyCited:cited,explicitlyExcluded:excluded,replicationFiles,replicationCases,missingBindingMutantsCaught:4,sourceFingerprint:'git:'+s.testedSha}));
NODE
```

```bash
env -u NODE_OPTIONS node --input-type=commonjs - docs/evidence/pui-public-rubric16-repro-f2d9.json <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
void (async () => {
  const bytes=fs.readFileSync(process.argv[2]);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'1737bde672cbdcc87fe01be3d45596cf95f829c9cdfc0903fff1a961d4e1838e');
  const s=JSON.parse(bytes); assert.ok(s.nodeBootstrap.supportedNodeVersions.includes(process.version),'unverified Node runtime '+process.version);
  assert.equal(typeof stripTypeScriptTypes,'function','builtin type stripper required');
  const readVerified=file=>{
    const text=execFileSync('git',['show',s.testedSha+':'+file],{encoding:'utf8'});
    assert.equal(createHash('sha256').update(text).digest('hex'),s.sourceSha256[file],file);
    return text;
  };
  const compilerFile='packages/operator-core/lib/agent-tools/plans/spec-clause-compiler.ts';
  const helperFile='packages/operator-core/lib/agent-tools/plans/val-assertions.ts';
  const compilerSource=readVerified(compilerFile), helperSource=readVerified(helperFile);
  const helperJs=stripTypeScriptTypes(helperSource,{mode:'strip'});
  assert.equal(createHash('sha256').update(helperJs).digest('hex'),s.nodeBootstrap.strippedSourceSha256[helperFile],'verified helper transform');
  assert.doesNotMatch(helperJs,/^\s*import\s/m,'helper unexpectedly imports runtime code');
  const url=js=>'data:text/javascript;base64,'+Buffer.from(js).toString('base64');
  let compilerJs=stripTypeScriptTypes(compilerSource,{mode:'strip'});
  assert.equal(createHash('sha256').update(compilerJs).digest('hex'),s.nodeBootstrap.strippedSourceSha256[compilerFile],'verified compiler transform');
  const seam=/(from\s+)(['"])\.\/val-assertions\2/g;
  assert.equal([...compilerJs.matchAll(seam)].length,1,'one verified runtime-helper seam');
  compilerJs=compilerJs.replace(seam,(_,prefix,quote)=>prefix+quote+url(helperJs)+quote);
  for (const m of compilerJs.matchAll(/\bfrom\s+(['"])(.*?)\1/g)) assert.ok(m[2]==='node:crypto'||m[2].startsWith('data:text/javascript;base64,'),'unverified runtime import '+m[2]);
  assert.doesNotMatch(compilerJs,/\b(?:require|import)\s*\(/,'unexpected dynamic runtime import');
  const compiler=await import(url(compilerJs));
  const failures=s.criteria.flatMap(c=>{
    const atomic=compiler.specBehaviorNonAtomicReason(c.model), falsifiable=compiler.specBehaviorNonFalsifiableReason(c.model);
    return atomic||falsifiable?[{key:c.key,atomic,falsifiable}]:[];
  });
  assert.deepEqual(failures,[]);
  console.log(JSON.stringify({criteria:s.criteria.length,flagged:0,node:process.version,bootstrap:'builtin-type-strip',verifiedRuntimeSources:[compilerFile,helperFile],sourceFingerprint:'git:'+s.testedSha}));
})().catch(error=>{console.error(error);process.exitCode=1;});
NODE
```

The structural command establishes source integrity, lexical citations, case/marker presence, complete replication-source bindings, and refusal of four missing-binding mutants. It cannot establish that an assertion proves its claimed outcome or that a decision substantively authorizes a requirement. The compiler command checks the existing atomic/falsifiable model rules. Neither command is a product verdict.

For semantic review, read the full decision bodies in the JSON and the actual assertions in each pinned suite. Preserve these authority distinctions: D-012 is qualified by D-013 for OMP; D-027's study deferral was agent-authored and superseded by D-041; D-034 approves only the historical r14 artifact; D-040 holds later public releases on chat-first acceptance; D-041 removes the study while preserving Avi's exact-candidate approval. D-045 records source bindings, not evidence that their opt-in live tests ran. R-12 and R-15 remain unknown until the candidate approval and public-path evidence respectively exist.

The installed f2d9 full scripted/Codex replay `0mv1ktic6c771mnzagv` ended with exit 1 at 2026-10-09T23:23:02Z. The native Codex leg passed nine tests; the scripted leg passed 86, failed the P-030 initial tab-bar snapshot, and skipped eight native cases. Its parent release verdict correctly refused the failed scripted leg. The failure is owned on WI-10007999, with cause still under investigation. This replay used the prepared SSE export and unchanged archive; its product outcome is separate from the meta-review. Both PUI plans remain unshipped pending current product proof, independent audited grading, and the remaining owner/publication gates.
