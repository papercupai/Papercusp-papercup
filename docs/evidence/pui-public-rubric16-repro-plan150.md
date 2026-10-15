# Reproducible public PUI rubric review for plan revision 150

Subject: `acceptance-pui-first-party-public-release-2026-09-07@16`, criteria hash `9dd8a68c940e70de35f5fa8e9ca3bb318ffbd299cc8fb0b609d76d6a35527b09`. Frozen plan revision 150, content hash `c40527e25f63a8e30e4875c0391fd4a9127bef5c8808943795379dacc4ce5999`. Pinned source generation: `e180cae84778e1c33d1622cc8f160e9c66519deb`. Input: [pui-public-rubric16-repro-plan150.json](pui-public-rubric16-repro-plan150.json), SHA-256 `8bfc2368736b8ff4aea82204a2023512a00260a9449f3b2a5fa3cb9c26d7d993`.

This edition supersedes the plan-147 input for current review. It retains all 15 current criteria and all 45 complete current decision bodies, with owner names removed from six provenance tags by the canonical identity-safe serializer. Tier, date, normative text and every requirement remain intact. Decision bodies changed since plan147: none. Source files and both compiler runtime sources are pinned and hashed before use. Existing independent reviews are historical until a fresh review explicitly accepts this edition.

The raw canonical snapshot SHA-256 is `65c61e42befb7a712782f8034c547faf32641d9504ba715b1d316cf56f2e3f7c`. `decisionCapture.identitySerialization` records every raw decision-body hash, the six normalized decision IDs, and the maintained regeneration command. Canonical originals are retrieved with `plans:get { slug:"pui-first-party-public-release-2026-09-07", heading:"Decisions", includeEnrichments:false }`; require plan revision 150 and content hash `c40527e25f63a8e30e4875c0391fd4a9127bef5c8808943795379dacc4ce5999` before comparing hashes. This transformation changes attribution display only and does not grant approval or weaken a BAR.

Run both commands from the canonical repository with Node v22.21.1 or v25.9.0 and the retained git objects. They need no installed package loader.

Structural source/binding and negative-control replay:

```bash
env -u NODE_OPTIONS node --input-type=commonjs - docs/evidence/pui-public-rubric16-repro-plan150.json <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const bytes = fs.readFileSync(process.argv[2]);
assert.equal(createHash('sha256').update(bytes).digest('hex'), '8bfc2368736b8ff4aea82204a2023512a00260a9449f3b2a5fa3cb9c26d7d993');
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

Atomic/falsifiable model replay:

```bash
env -u NODE_OPTIONS node --input-type=commonjs - docs/evidence/pui-public-rubric16-repro-plan150.json <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { stripTypeScriptTypes } = require('node:module');
void (async () => {
  const bytes=fs.readFileSync(process.argv[2]);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'8bfc2368736b8ff4aea82204a2023512a00260a9449f3b2a5fa3cb9c26d7d993');
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

These checks verify source integrity, named cases, complete replication bindings, four missing-binding negative controls, and the model compiler rules. They do not establish that every assertion detects its claimed outcome or that a cited decision authorizes a requirement; fresh independent semantic review remains required. Neither is an installed-product or shipment verdict.

Authority distinctions remain explicit: D-012 is qualified by D-013 for OMP; agent-authored D-027 was superseded by D-041; D-034 approves only its historical artifact; D-040 holds later public releases on chat-first acceptance; D-041 preserves Avi’s exact final candidate approval. R-12 and R-15 remain unknown until that approval and public download/install evidence exist. Both plans remain unshipped.

