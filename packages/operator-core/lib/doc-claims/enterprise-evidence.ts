/** R1/R10 guards over the maintained census, assumption register and pilot pack.
 * These inspect evidence semantics, not enterprise readiness. Missing operational
 * records remain gaps; a clean document cannot manufacture approval or recovery.
 * No second registry, processor inventory, or acceptance store is introduced.
 */
export interface EvidenceFinding { code: string; subject: string }
export interface EvidenceInspection {
  violations: EvidenceFinding[];
  /** Required observations this document inspection cannot supply. */
  unverified: string[];
}

export const ENTERPRISE_AREAS = [
  'Directory and group administration',
  'Organization-wide policy and sensitive actions',
  'Data governance',
  'Security evidence and SIEM',
  'Finance and accepted-outcome cost',
  'Supported enterprise connectors',
  'Approved departmental workflows',
  'Managed deployment, recovery and support',
] as const;

/** Read one contiguous table by its first header, preserving escaped pipes. */
export function evidenceTable(markdown: string, header: string): string[][] {
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/).map((cell) => cell.trim());
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith('|') && cells(line)[0] === header);
  if (start < 0 || !/^\s*\|\s*:?-{2,}/.test(lines[start + 1] ?? '')) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith('|')) break;
    rows.push(cells(line));
  }
  return rows;
}

function population(rows: string[][], expected: readonly string[], code: string): EvidenceFinding[] {
  const names = rows.map((row) => row[0]);
  return [
    ...expected.filter((name) => names.filter((n) => n === name).length !== 1)
      .map((subject) => ({ code, subject })),
    ...names.filter((name) => !expected.includes(name)).map((subject) => ({ code, subject })),
  ];
}

export function inspectEnterpriseScope(input: {
  census: string; assumptions: string; pilot: string;
}): EvidenceInspection {
  const violations: EvidenceFinding[] = [];
  const rows = evidenceTable(input.census, 'Enterprise area');
  violations.push(...population(rows, ENTERPRISE_AREAS, 'scope-population'));
  for (const [area, state = '', reuse = '', owner = ''] of rows) {
    // This dated source census has no functional/runtime observations. Its
    // source-only label cannot silently become a support qualification.
    if (!state.startsWith('SOURCE-ONLY: ') || !/\]\([^)]+\)/.test(state)) {
      violations.push({ code: 'source-classification', subject: area });
    }
    if (!/\b(?:extend|reuse|build.+maintained)\b/i.test(reuse)
      || /\b(?:new|duplicate|parallel) (?:store|service|registry|system)\b/i.test(reuse)
        && !/\b(?:because|does not fit|cannot satisfy)\b/i.test(reuse)) {
      violations.push({ code: 'reuse-justification', subject: area });
    }
    if (!/P-\d{3}/.test(owner) || !/WI-\d+/.test(owner)) {
      violations.push({ code: 'scope-owner', subject: area });
    }
  }
  const assumptions = evidenceTable(input.assumptions, 'Id');
  const ids = Array.from({ length: 10 }, (_, i) => `A-${i + 1}`);
  const normalized = assumptions.map((row) => [row[0]?.match(/^A-\d+\b/)?.[0] ?? '', ...row.slice(1)]);
  violations.push(...population(normalized, ids, 'assumption-population'));
  for (const [id = '', assumption = '', source = '', override = ''] of assumptions) {
    if (!/\bASSUMED\b/.test(id)
      || affirmativeClaims(assumption, /\b(?:buyer|partner|customer)[ -](?:evidence|verified|validated)\b/i).length) {
      violations.push({ code: 'assumption-classification', subject: id });
    }
    if (!source.trim() || !override.trim()) violations.push({ code: 'assumption-provenance', subject: id });
  }
  if (!input.assumptions.includes('D-009') || !input.assumptions.includes('D-010')) {
    violations.push({ code: 'assumption-authority', subject: 'D-009/D-010' });
  }
  if (!/A-1 to A-10/.test(input.pilot) || !/assumed pilot contract/i.test(input.pilot)) {
    violations.push({ code: 'pilot-assumption-binding', subject: 'P-003' });
  }
  return { violations, unverified: [
    'current runtime qualification for each census area',
    'immutable approved P-003 scope, threshold and approval record',
    'real buyer evidence (D-010 excluded residue)',
  ] };
}

/** A bounded prose lint, not an authority or natural-language proof. Preserve
 * decimal targets, separate assertions, and do not borrow another claim's denial.
 * Negative inventory lists may put their limitation after the listed terms. */
function affirmativeClaims(markdown: string, pattern: RegExp): string[] {
  return markdown.split(/[\n|;!?]+|(?<!\d)\.|\.(?!\d)|\b(?:but|however|yet|although)\b|,\s*(?=(?:we|they|it|this|our|the)\b)|\band\s+(?=(?:we|they|it|this|our|the)\b)/i)
    .flatMap((clause) => {
      const matches = [...clause.matchAll(new RegExp(pattern.source, 'gi'))];
      return matches.flatMap((match, index) => {
        const previous = matches[index - 1];
        const prefix = clause.slice(previous ? previous.index! + previous[0].length : 0, match.index);
        const suffix = clause.slice(match.index! + match[0].length, matches[index + 1]?.index);
        const deniedBefore = /\b(?:no|not|never|without|unsigned|unapproved|excluded|unknown)\b/i.test(prefix)
          && !/\bnot\s+only\b/i.test(prefix);
        const deniedAfter = /\b(?:is|are|remains?)\s+(?:missing|excluded|unknown|unapproved)\b/i.test(suffix);
        return deniedBefore || deniedAfter ? [] : [clause.trim()];
      });
    });
}

/** Each assertion is judged in its own clause: a disclaimer in another
 * sentence/cell cannot launder a positive commercial or assurance claim. */
export function unsupportedEnterpriseClaims(markdown: string): EvidenceFinding[] {
  const prohibited = /\b(?:SOC\s*2|ISO\s*27001)\s+(?:certified|compliant)|\b(?:signed|executed|approved)\s+DPA\b|\b(?:guaranteed|guarantees?)\s+(?:\d+(?:\.\d+)?%\s+)?(?:uptime|SLA|response)|\$\s*\d+(?:\.\d+)?\s*(?:\/|per\b)/i;
  return affirmativeClaims(markdown, prohibited).map((subject) => ({ code: 'unsupported-external-claim', subject }));
}

export function inspectEnterpriseProcurement(pilot: string, processingPathIds: readonly string[]): EvidenceInspection {
  const start = pilot.indexOf('## Internal security and procurement working pack');
  const end = pilot.indexOf('\n## ', start + 3);
  const pack = start < 0 ? '' : pilot.slice(start, end < 0 ? undefined : end);
  const violations = unsupportedEnterpriseClaims(pilot);
  for (const heading of ['Threat model and qualification boundaries', 'Internal security questionnaire',
    'Declared-profile processor inventory for review', 'Unsigned DPA working terms and required annexes',
    'Evidence custody and remaining acceptance']) {
    if (!pack.includes(`### ${heading}`)) violations.push({ code: 'pack-component', subject: heading });
  }
  if (!/Engineering custodian:\s*[^.;\n]+/.test(pack) || !/Prepared \d{4}-\d{2}-\d{2}/.test(pack)) {
    violations.push({ code: 'pack-provenance', subject: 'P-020' });
  }
  const questions = evidenceTable(pack, 'Question');
  if (!questions.length) violations.push({ code: 'questionnaire-empty', subject: 'P-020' });
  for (const [question, answer = '', unknown = ''] of questions) {
    if (!answer.trim() || !unknown.trim() || /^(?:none|n\/a|all verified)\.?$/i.test(unknown)) {
      violations.push({ code: 'questionnaire-evidence', subject: question });
    }
  }
  const inventory = evidenceTable(pack, 'Declared path or adjacent identity dependency');
  const normalizedInventory = inventory.map((row) => [row[0].replace(/ \(A-\d+\)$/, ''), ...row.slice(1)]);
  violations.push(...population(normalizedInventory, ['Directory identity', ...processingPathIds], 'processor-population'));
  for (const [id, processor = '', data = '', qualification = ''] of inventory) {
    if (!processor.trim() || !data.trim() || !qualification.trim()) {
      violations.push({ code: 'processor-disclosure', subject: id });
    }
  }
  const terms = evidenceTable(pack, 'Working clause');
  if (!terms.length || terms.some((row) => !row[1]?.trim() || !row[2]?.trim())) {
    violations.push({ code: 'unsigned-terms-annex', subject: 'P-020' });
  }
  for (const residue of ['External assurance', 'DPA/subprocessor approval', 'priced support/SLA']) {
    if (!pack.includes(residue)) violations.push({ code: 'residue-disclosure', subject: residue });
  }
  if (!/fleet leader owns engineering escalation/.test(pilot) || !/incident gets its own accountable work-item holder/.test(pilot)) {
    violations.push({ code: 'support-owner', subject: 'P-021' });
  }
  return { violations, unverified: [
    'non-implementer review of each current claim against its source/runtime record',
    'numeric internal response/recovery targets and measured incident exercise',
    'external assurance, signed legal terms and priced support/SLA (D-010 excluded residue)',
  ] };
}

/** Adapter for a record read from an existing evidence store, not a new ledger.
 * The trusted reader must return the actual immutable record; caller-supplied
 * metadata alone cannot establish that a record exists or was approved. */
export interface EnterpriseEvidenceRecord {
  ref: string; hash: string; workspace: string; subject: string; profile: string;
  owner: string; observedAt: string; expiresAt: string;
}
export function inspectEnterpriseEvidenceRecord(
  binding: EnterpriseEvidenceRecord,
  context: { workspace: string; subject: string; profile: string; now: number },
  resolve: (ref: string) => EnterpriseEvidenceRecord | undefined,
): EvidenceFinding[] {
  const record = resolve(binding.ref);
  const findings: EvidenceFinding[] = [];
  if (!record) return [{ code: 'record-missing', subject: binding.ref }];
  for (const key of ['ref', 'hash', 'workspace', 'subject', 'profile', 'owner', 'observedAt', 'expiresAt'] as const) {
    if (!record[key]?.trim() || record[key] !== binding[key]) findings.push({ code: 'record-binding', subject: key });
  }
  for (const key of ['workspace', 'subject', 'profile'] as const) {
    if (record[key] !== context[key]) findings.push({ code: 'record-scope', subject: key });
  }
  const start = Date.parse(record.observedAt), end = Date.parse(record.expiresAt);
  if (!Number.isFinite(context.now) || !Number.isFinite(start) || !Number.isFinite(end)
    || start > context.now || end <= context.now || end <= start) {
    findings.push({ code: 'record-stale', subject: binding.ref });
  }
  if (!/^[a-f\d]{64}$/.test(record.hash)) findings.push({ code: 'record-hash', subject: binding.ref });
  return findings;
}

export function inspectInternalRecovery(input: {
  owner: string; reviewer: string; responseMs: number; recoveryMs: number;
  responseTargetMs: number; recoveryTargetMs: number; recovered: boolean;
}): EvidenceFinding[] {
  const positive = (v: number) => Number.isFinite(v) && v > 0;
  const measured = (v: number) => Number.isFinite(v) && v >= 0;
  return !input.owner.trim() || !input.reviewer.trim() || input.owner === input.reviewer
    || !positive(input.responseTargetMs) || !positive(input.recoveryTargetMs)
    || !measured(input.responseMs) || !measured(input.recoveryMs) || !input.recovered
    || input.responseMs > input.responseTargetMs || input.recoveryMs > input.recoveryTargetMs
    ? [{ code: 'internal-recovery-failed', subject: 'P-021' }] : [];
}
