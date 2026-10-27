/** P-011/R8: syntax candidates, never type/runtime truth or an edit veto. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { astGrepIdentity } from './ast-grep-process.mjs';

type Rule = Record<string, unknown>;
const patterns = (...values: string[]): Rule => ({ any: values.map(pattern => ({ pattern })) });
const catches = (...values: string[]): Rule => ({ any: values.map(context => ({ pattern: { context: `try {} ${context}`, selector: 'catch_clause' } })) });
const loop = { any: ['for_statement', 'for_in_statement', 'while_statement', 'do_statement'].map(kind => ({ kind })), stopBy: 'end' };
export const AGENT_ANTIPATTERN_RULES = [
  { id: 'error-empty-catch', rule: catches('catch ($E) {}', 'catch {}'), hint: 'propagate or explicitly handle the error' },
  { id: 'error-log-only-catch', rule: catches('catch ($E) { console.$M($$$A) }', 'catch ($E) { logger.$M($$$A) }', 'catch { console.$M($$$A) }'), hint: 'logging alone does not handle failure' },
  { id: 'db-read-fallback', rule: patterns('$READ ?? 0', '$READ ?? null'), constraints: { READ: { regex: '(?i)(read|get|query|select|find)[\\w.]*\\s*\\(' } }, hint: 'preserve missing/failed read state' },
  { id: 'unsafe-as-any', rule: { pattern: '$X as any' }, hint: 'retain a checked type boundary' },
  { id: 'newly-skipped-test', rule: { kind: 'call_expression', regex: '^(it|test|describe)\\.skip(?:\\.each)?\\(' }, hint: 'repair the test rather than skipping it' },
  { id: 'widened-test-timeout', rule: patterns('test.setTimeout($N)', 'jest.setTimeout($N)', 'test($NAME, $FN, $N)', 'it($NAME, $FN, $N)'), constraints: { N: { kind: 'number' } }, hint: 'diagnose the slow path before widening its timeout' },
  { id: 'sync-io-in-async', rule: { kind: 'call_expression', regex: '(readFileSync|writeFileSync|readdirSync|statSync|execSync|execFileSync)\\(', inside: { any: ['function_declaration', 'function_expression', 'arrow_function', 'method_definition'].map(kind => ({ kind, regex: '^async\\b' })), stopBy: 'end' } }, hint: 'move blocking I/O off the async request path' },
  { id: 'await-in-serial-loop', rule: { kind: 'await_expression', inside: loop }, hint: 'consider bounded parallel work for independent iterations' },
  { id: 'unbounded-promise-all', rule: { pattern: 'Promise.all($ITEMS.map($$$A))' }, hint: 'bound fan-out before Promise.all' },
  { id: 'full-table-read-filter', rule: { pattern: '(await $DB.selectFrom($TABLE).selectAll().execute()).filter($$$A)' }, hint: 'push filtering into the database query' },
] as const;
export type AgentAntipatternId = typeof AGENT_ANTIPATTERN_RULES[number]['id'];
export interface AgentAntipatternHit { ruleId: AgentAntipatternId; line1: number; text: string; numeric?: number }
export interface AgentAntipatternResult {
  status: 'measured' | 'unknown'; hits: AgentAntipatternHit[]; beforeSha256: string | null; sha256: string;
  error?: string; truncated: boolean;
}
export const antipatternHash = (text: string): string => createHash('sha256').update(text).digest('hex');
export function buildAgentAntipatternArgs(language: 'ts' | 'tsx'): string[] {
  return ['scan', '--stdin', '--json=compact', '--inline-rules', AGENT_ANTIPATTERN_RULES.map(rule => JSON.stringify({
    id: rule.id, language, severity: 'hint', message: rule.hint, rule: rule.rule,
    ...('constraints' in rule ? { constraints: rule.constraints } : {}),
  })).join('\n---\n')];
}
interface RawHit { ruleId: AgentAntipatternId; text: string; range: { start: { line: number } }; metaVariables?: { single?: Record<string, { text: string }> } }
async function scan(text: string, language: 'ts' | 'tsx', bin: string): Promise<AgentAntipatternHit[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(bin, buildAgentAntipatternArgs(language), { timeout: 2000, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
      if (error || stderr.trim()) reject(new Error(stderr || error?.message)); else resolve(stdout);
    });
    child.stdin?.on('error', reject);
    child.stdin?.end(text);
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('invalid ast-grep result');
  return (parsed as RawHit[]).map(hit => ({ ruleId: hit.ruleId, line1: hit.range.start.line + 1, text: hit.text,
    ...(hit.ruleId === 'widened-test-timeout' ? { numeric: Number(hit.metaVariables?.single?.N?.text.replaceAll('_', '')) } : {}) }));
}
const identity = (hit: AgentAntipatternHit) => `${hit.ruleId}:${hit.text.replace(/\s+/g, '')}`;
const timeoutIdentity = (hit: AgentAntipatternHit) => hit.text.replace(/[\d_]+(?=\s*\)\s*$)/, '$N').replace(/\s+/g, '');
/** Unknown before content cannot establish *new* skips or increased timeouts. */
export function introducedAntipatterns(before: AgentAntipatternHit[] | null, after: AgentAntipatternHit[]): AgentAntipatternHit[] {
  const old = new Map<string, number>();
  for (const hit of before ?? []) old.set(identity(hit), (old.get(identity(hit)) ?? 0) + 1);
  const timeouts = new Map((before ?? []).filter(hit => hit.ruleId === 'widened-test-timeout').map(hit => [timeoutIdentity(hit), hit.numeric]));
  return after.filter(hit => {
    const count = old.get(identity(hit)) ?? 0;
    if (count) { old.set(identity(hit), count - 1); return false; }
    if (hit.ruleId === 'newly-skipped-test') return before !== null;
    if (hit.ruleId === 'widened-test-timeout') {
      const previous = timeouts.get(timeoutIdentity(hit));
      return previous !== undefined && Number.isFinite(hit.numeric) && hit.numeric! > previous;
    }
    return true;
  });
}
/** Runs in asynchronous preparation/the explicit structural query, never in a PushLeg. */
export async function agentAntipatterns(before: string | null, after: string, language: 'ts' | 'tsx' = 'ts'): Promise<AgentAntipatternResult> {
  const base = { beforeSha256: before === null ? null : antipatternHash(before), sha256: antipatternHash(after), truncated: false };
  try {
    if (Buffer.byteLength(after) > 100_000 || (before !== null && Buffer.byteLength(before) > 100_000)) throw new Error('source exceeds 100000-byte analysis bound');
    const parser = await astGrepIdentity();
    if (!parser.ok) throw new Error(parser.reason);
    const [old, current] = await Promise.all([before === null ? null : scan(before, language, parser.identity.bin), scan(after, language, parser.identity.bin)]);
    const hits = introducedAntipatterns(old, current);
    return { ...base, status: 'measured', hits: hits.slice(0, 100), truncated: hits.length > 100 };
  } catch (error) { return { ...base, status: 'unknown', hits: [], error: String(error).slice(0, 300) }; }
}
