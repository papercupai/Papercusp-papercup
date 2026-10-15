# Reproducible public PUI rubric review, revision 15

Subject: `acceptance-pui-first-party-public-release-2026-09-07@15`, criteria hash `c3776900beb7e64c59ae275494eeba18bf58c45f91fcfba8539dbec7e34c52d5`.
Source generation: `f2d92cbc8ad685b843e70c83718ac7a8d1a45371`. Plan version 146, content hash `0189b7fdad8a26315b93faa293d9e7b29264ff61703320a8cc4240843f1353bf`.

`pui-public-rubric15-repro-f2d9.json` freezes the complete 15 criteria, 44 decision headings, explicit exclusions, and SHA-256 for every bound source file. The original revision-14 input was compared field-by-field with the immutable platform revision: 15 criteria, zero differences. Revision 15 replaces only the obsolete R-01 test title with the current P-030 workbench title. The amendment preview classified it as method-only: unchanged BAR set, no outcome or falsifier changes, approvalRequired=false.

Revision-14 attestation EI-24716822128468414 remains failed by independent audit EI-25542782424765112. This record does not inherit that card's opaque thread-post evidence or its timestamp claim. It is a new review generation; independent vetting and audited attestation remain required.

Run the structural probe from the canonical repository. It reads source by immutable git object, so later source edits cannot silently change the evidence:

```bash
node - docs/evidence/pui-public-rubric15-repro-f2d9.json <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const snapshot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const source = file => execFileSync('git', ['show', snapshot.testedSha + ':' + file], {encoding:'utf8'});
for (const [file, digest] of Object.entries(snapshot.sourceSha256)) {
  assert.equal(createHash('sha256').update(source(file)).digest('hex'), digest, file);
}
let named = 0, missing = 0, structured = 0, manual = 0;
for (const c of snapshot.criteria) {
  assert.match(c.driftMarkers, /^BROKEN if any ONE holds: \(1\)/);
  assert.match(c.method, /GOAL CLAUSE:/);
  assert.match(c.method, /RATING BASIS:/);
  if (c.check.kind === 'instrument') {
    assert.equal(c.key, 'r-15');
    assert.equal(c.check.instrumentKey, 'none');
    assert.match(c.method, /EVIDENCE ARTIFACTS/);
    manual++; continue;
  }
  assert.equal(c.check.kind, 'tests');
  assert.ok(c.check.files.length); structured++;
  const contents = c.check.files.map(source).join('\n');
  const titles = [...(c.method.split('NAMED CASES')[1] ?? '').matchAll(/(?:[:;,(]\s*)'(.{12,}?)'(?=[;.,)\s]|$)/g)].map(m => m[1]);
  assert.ok(titles.length, c.key + ' must name its falsifying cases');
  for (const title of titles) {
    const literal = title.split(/\$\{[^}]*\}|%s/).sort((a,b) => b.length-a.length)[0];
    named++; if (!contents.includes(literal)) { missing++; console.log('MISSING', c.key, title); }
  }
}
let covered = 0, excluded = 0;
for (const d of snapshot.decisions) {
  const cited = snapshot.criteria.some(c => [c.model,c.method,c.driftMarkers,c.replication].some(text => String(text).includes(d.id)));
  const exception = snapshot.decisionExclusions[d.id];
  assert.ok(cited !== Boolean(exception), d.id + ' must be covered or explicitly excluded, exactly once');
  if (cited) covered++; else excluded++;
}
for (const id of Object.keys(snapshot.decisionExclusions)) assert.ok(snapshot.decisions.some(d => d.id === id));
assert.equal(snapshot.criteria.length,15); assert.equal(named,61); assert.equal(missing,0);
assert.equal(structured,14); assert.equal(manual,1); assert.equal(snapshot.decisions.length,44);
console.log(JSON.stringify({criteria:15,named,missing,structured,manual,decisions:44,covered,excluded,sourceFingerprint:'git:'+snapshot.testedSha}));
NODE
```

Run the existing spec validator from the retained immutable acceptance checkout. It loads the pinned compiler rather than the current shared tree. The first probe verifies the compiler bytes; the following command also asserts the checkout's HEAD and clean tracked source before import:

```bash
export PUI_RUBRIC_PIN=/dev/shm/pcv/pui-checkout8892-su-d2ae9
node --import "$PUI_RUBRIC_PIN/node_modules/tsx/dist/loader.mjs" - docs/evidence/pui-public-rubric15-repro-f2d9.json "$PUI_RUBRIC_PIN" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const s = JSON.parse(fs.readFileSync(process.argv[2],'utf8')), pin = process.argv[3];
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:pin,encoding:'utf8'}).trim(),s.testedSha);
assert.equal(execFileSync('git',['diff','HEAD','--name-only'],{cwd:pin,encoding:'utf8'}).trim(),'');
for (const [file,digest] of Object.entries(s.sourceSha256)) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(pin,file))).digest('hex'),digest,file);
const compiler = require(path.join(pin,'packages/operator-core/lib/agent-tools/plans/spec-clause-compiler.ts'));
const failures = s.criteria.flatMap(c => {
  const atomic = compiler.specBehaviorNonAtomicReason(c.model);
  const falsifiable = compiler.specBehaviorNonFalsifiableReason(c.model);
  return atomic || falsifiable ? [{key:c.key,atomic,falsifiable}] : [];
});
assert.deepEqual(failures,[]); console.log(JSON.stringify({criteria:s.criteria.length,flagged:failures.length,sourceFingerprint:'git:'+s.testedSha}));
NODE
```

If the retained checkout no longer exists, recreate this exact SHA with the maintained `setup-release-checkout.sh` immutable-input route; do not substitute the current working tree or weaken the hash assertions.

The meta-review assesses outcome quality separately from the product verdict:

- Outcomes: all 15 models describe installed-product behaviors or guarantees; the existing atomic/falsifiability validator checks their pass-floor sentences.
- Trace: each criterion names its requirement; the inverse probe partitions all 44 decision headings between a covering criterion and an explicit process/amendment exclusion.
- Falsifiers: each criterion has numbered broken conditions. The probe binds all 61 named cases to pinned test source. R-12 requires exact-candidate owner approval; R-15 requires actual public-path download evidence. Their pre-approval/pre-publication rating is unknown.
- Failure paths: R-02 covers delayed readiness, duplicate suppression, interruption and uncertain delivery; R-03 covers identity/authority narrowing; R-06 covers killed processes and exact resume; R-09 covers credential leakage and silent permission bypass; R-10/R-14 cover unjustified matrix exclusions; R-12/R-15 reject approval or publication evidence from a different candidate.
- Distinct outcomes: R-01 interaction, R-02 delivery, R-03 SU parity, R-04 setup/history, R-05 editor/controls, R-06 recovery, R-07 context/layout, R-08 installation, R-09 consent, R-10 support matrix, R-11 artifacts, R-12 evidence/approval, R-13 tasks, R-14 capability replacement, R-15 distribution. Shared journeys can exercise several assertions; ratings must name the failed family and drift marker.
- Structured checks: R-01..R-14 bind real framework test files. R-15 is explicitly manual and names its three evidence artifacts. Source presence is a meta-review check, not proof that those product tests passed.

The inherited full installed run `0mv1jzghwr4x7djgoll` finished refused. Its cold operator child lacked `@papercusp/sse`'s generated CommonJS export. The durable acceptance preparation now runs the package's maintained build and verifies that exact specifier before expensive legs. The conventional regression passed in the 36-test release-acceptance unit suite; current installed acceptance and independent product grading remain open. Neither PUI plan is shipped, and no public candidate approval is inferred from historical chat acceptance.

