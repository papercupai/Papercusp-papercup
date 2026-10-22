import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditInstrumentBindings, getRegisteredInstrument, runInstrument } from '../rubric-instrument-registry';
import { requirementSectionsSchema } from '../agent-tools/plans/rubric-template';
import {
  parseTicketFilingIntegration, ticketFilingIntegrationInstrument,
  TICKET_FILING_CASE_COUNT, TICKET_FILING_CASE_TITLES, TICKET_FILING_INSTRUMENT_KEY, TICKET_FILING_SUITE,
} from './ticket-filing-instrument';

const report = () => ({
  success: true, numTotalTests: TICKET_FILING_CASE_COUNT, numPassedTests: TICKET_FILING_CASE_COUNT,
  numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: [{ name: '/repo/' + TICKET_FILING_SUITE, status: 'passed',
    assertionResults: TICKET_FILING_CASE_TITLES.map(fullName => ({ fullName, status: 'passed' })) }],
});
const marker = 'TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed provenance=stamped childSubstituted=0 skippedTests=0';
const output = (value: unknown = report(), summary = marker) => `npm preamble\n${JSON.stringify(value)}\n${summary}\n`;

describe('portable ticket filing instrument preserves the full original integration check', () => {
  it('registers fixed argv for the whole original file without a shell or name filter', () => {
    const instrument = ticketFilingIntegrationInstrument('/repo with spaces');
    expect(instrument.argv).toEqual(['npm', '--prefix', '/repo with spaces', 'run', 'test:file', '--', TICKET_FILING_SUITE, '--', '--reporter=json']);
    expect(getRegisteredInstrument(TICKET_FILING_INSTRUMENT_KEY)).toMatchObject({ evaluator: 'command', parse: parseTicketFilingIntegration });
    expect(parseTicketFilingIntegration(output())).toBe(1);
  });

  it.each(['', 'not json', output({}, marker), output(report(), ''), output(report(), marker + '\n' + marker)])('does not pass missing, malformed or ambiguous evidence %#', value => {
    expect(parseTicketFilingIntegration(value)).toBeNull();
  });

  it.each(['requested=0', 'executed=0', 'matched=0', 'status=failed', 'provenance=drifted', 'skippedTests=1', 'childSubstituted=1', 'childSubstituted=unknown', 'finalizationError=true'])('refuses incomplete runner evidence: %s', field => {
    const key = field.split('=')[0]!;
    const summary = marker.split(' ').filter(token => !token.startsWith(key + '=')).concat(field).join(' ');
    expect(parseTicketFilingIntegration(output(report(), summary))).toBeNull();
  });

  it('refuses a passing subset, skipped/todo/failed tests, another file, duplicate names and missing assertions', () => {
    for (const mutate of [
      (r: ReturnType<typeof report>) => { r.numTotalTests--; r.numPassedTests--; r.testResults[0]!.assertionResults.pop(); },
      (r: ReturnType<typeof report>) => { r.numPendingTests = 1; },
      (r: ReturnType<typeof report>) => { r.numTodoTests = 1; },
      (r: ReturnType<typeof report>) => { r.numFailedTests = 1; r.success = false; },
      (r: ReturnType<typeof report>) => { r.testResults[0]!.name = '/repo/other.integration.test.ts'; },
      (r: ReturnType<typeof report>) => { r.testResults[0]!.assertionResults[0]!.status = 'pending'; },
      (r: ReturnType<typeof report>) => { r.testResults[0]!.assertionResults[0]!.fullName = TICKET_FILING_CASE_TITLES[1]!; },
      (r: ReturnType<typeof report>) => { r.testResults[0]!.assertionResults[0]!.fullName = 'replacement passing test'; },
      (r: ReturnType<typeof report>) => { r.testResults[0]!.assertionResults = []; },
    ]) {
      const value = report(); mutate(value);
      expect(parseTicketFilingIntegration(output(value))).toBeNull();
    }
  });

  it('uses the complete JSON assertion population when the runner has no separate skip counter', () => {
    expect(parseTicketFilingIntegration(output(report(), marker.replace('skippedTests=0', 'skippedTests=unknown')))).toBe(1);
    const skipped = report(); skipped.testResults[0]!.assertionResults[0]!.status = 'pending';
    expect(parseTicketFilingIntegration(output(skipped, marker.replace('skippedTests=0', 'skippedTests=unknown')))).toBeNull();
  });

  it('keeps command failure, timeout and malformed results unknown through the real executor', async () => {
    for (const message of ['exit code 1', 'timed out']) {
      expect(await runInstrument(TICKET_FILING_INSTRUMENT_KEY, { exec: async () => { throw new Error(message); } }))
        .toMatchObject({ value: null, error: message });
    }
    expect(await runInstrument(TICKET_FILING_INSTRUMENT_KEY, { exec: async () => '' })).toMatchObject({ value: null });
    expect(await runInstrument(TICKET_FILING_INSTRUMENT_KEY, { exec: async () => output() })).toMatchObject({ value: 1 });
  });

  it('preserves the templates integration layer and exposes only a stable instrument binding', () => {
    for (const name of ['plan', 'report']) {
      const text = readFileSync(join(__dirname, '../../../../libs/papercusp/plugins/bug-triage', name + '.md'), 'utf8');
      const block = JSON.parse(text.match(/```requirement\s*([\s\S]*?)```/)![1]!);
      expect(requirementSectionsSchema.safeParse(block).success).toBe(true);
      expect(auditInstrumentBindings({ prior: [], next: [{ key: 'r-1', check: block.verification.check }] }).refused).toEqual([]);
      expect(block.acceptance.requiredTestLayers).toEqual(['integration']);
      expect(block.verification.check).toEqual({ kind: 'instrument', instrumentKey: TICKET_FILING_INSTRUMENT_KEY, expect: { op: 'eq', value: 1 } });
      expect(text).not.toContain(TICKET_FILING_SUITE);
      expect(text).not.toContain('packages/operator-core/');
    }
  });
});
