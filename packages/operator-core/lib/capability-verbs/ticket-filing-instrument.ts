import type { CommandInstrument } from '../rubric-instrument-registry';

/** Public templates bind this key; the original integration suite stays on the host. */
export const TICKET_FILING_INSTRUMENT_KEY = 'ticket:filing-integration';
export const TICKET_FILING_SUITE = 'packages/operator-core/lib/capability-verbs/ticket.integration.test.ts';
// Pinned from the original full-suite JSON report. Table cases are expanded, so
// removing a negative control cannot silently shrink the instrument's population.
export const TICKET_FILING_CASE_TITLES = Object.freeze(Object.entries({
  'ticket:file files at the destination the installation chose': [
    'creates one ticket in the picked project and quotes the message as untrusted evidence; a replay files nothing',
    'a lost create response is pending, and the next call recovers the same ticket without a second POST',
    'a retry while the lost create is not yet visible to the lookup stays pending and never POSTs again',
    'deduplicates matching messages across trigger runs and serializes concurrent filers',
    'keeps message idempotency scoped to the pack installation',
  ],
  'ticket:file assigns the ticket when the installation asks for it': [
    'files the ticket assigned to the connected account, records the confirmation, and a replay reports it',
    'an installation without the input files unassigned and the result says nothing about assignment',
    'a lost create response recovers the same assigned ticket: the attempt froze the request',
    'records an unconfirmed assignment as assigned:false rather than assuming it',
    'refuses an assignee other than self before recording an attempt or calling the provider',
  ],
  'ticket:file durable classification': [
    'records non-bug and needs-information without provider HTTP, preserving the first reason on replay',
    'serializes matching and contradictory verdicts without overwriting the winner',
    'keeps origin and channel authorization for negative classifications',
    'cannot relabel a ticket created by the earlier implementation without a classification record',
  ],
  'trigger-pack arming validates the configured destination': [
    'checks project-eng before recording a review or arming bindings',
    'checks project-other before recording a review or arming bindings',
    'refuses disabled-source without borrowing another owner',
    'refuses missing-owner without borrowing another owner',
    "arms with assignee 'self' and refuses any other assignee before recording a review",
    'refuses an ambiguous ticket destination before arming',
    'fences inputs changes during the provider read before arm writes',
    'fences source-owner changes during the provider read before arm writes',
    'refuses a target removed during the provider read before recording a review',
  ],
  'ticket:file refuses before any ticket HTTP': [
    'a destination no connected source offers for create is unavailable, and no attempt is recorded',
    'a message from a channel the installation does not watch cannot file',
    'an installation with no destination input is refused as unset',
    'a plan run no trigger-pack installation launched is not a filing origin',
    'two sources offering the same destination are ambiguous rather than guessed',
    'refuses empty or oversized text without reading anything',
  ],
}).flatMap(([group, cases]) => cases.map(title => `${group} ${title}`)));
export const TICKET_FILING_CASE_COUNT = TICKET_FILING_CASE_TITLES.length;

/** Only the real runner's complete, successful, unskipped integration result is measurable. */
export function parseTicketFilingIntegration(stdout: string): number | null {
  const lines = stdout.split(/\r?\n/);
  const summaries = lines.filter(line => line.startsWith('TEST_FILE_RESULT '));
  if (summaries.length !== 1) return null;
  const fields = new Map(summaries[0]!.split(/\s+/).slice(1).map(field => {
    const at = field.indexOf('=');
    return [field.slice(0, at), field.slice(at + 1)];
  }));
  if (fields.get('requested') !== '1' || fields.get('executed') !== '1' ||
      fields.get('matched') !== '1' || fields.get('status') !== 'passed' ||
      !['0', 'unknown'].includes(fields.get('skippedTests') ?? '') || fields.get('provenance') !== 'stamped' ||
      fields.get('childSubstituted') !== '0' ||
      fields.get('finalizationError') === 'true') return null;
  const reports: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && Array.isArray(value.testResults)) reports.push(value);
    } catch { /* Runner progress and npm preambles are not report JSON. */ }
  }
  if (reports.length !== 1) return null;
  const report = reports[0]!;
  if (report.success !== true || report.numTotalTests !== TICKET_FILING_CASE_COUNT ||
      report.numPassedTests !== TICKET_FILING_CASE_COUNT || report.numFailedTests !== 0 ||
      report.numPendingTests !== 0 || report.numTodoTests !== 0) return null;
  const suites = report.testResults as Array<Record<string, unknown>>;
  if (suites.length !== 1) return null;
  const suite = suites[0]!;
  if (typeof suite.name !== 'string' ||
      !suite.name.replaceAll('\\', '/').endsWith('/lib/capability-verbs/ticket.integration.test.ts') ||
      suite.status !== 'passed' || !Array.isArray(suite.assertionResults)) return null;
  const assertions = suite.assertionResults as Array<Record<string, unknown>>;
  if (assertions.length !== TICKET_FILING_CASE_COUNT ||
      assertions.some(test => test.status !== 'passed' || typeof test.fullName !== 'string' || !test.fullName.trim()) ||
      new Set(assertions.map(test => test.fullName)).size !== TICKET_FILING_CASE_COUNT ||
      TICKET_FILING_CASE_TITLES.some(title => !assertions.some(test => test.fullName === title))) return null;
  return 1;
}

export function ticketFilingIntegrationInstrument(root: string): CommandInstrument {
  return {
    key: TICKET_FILING_INSTRUMENT_KEY,
    evaluator: 'command',
    description: 'Runs the complete original ticket-filing Postgres/Asana integration suite, including its negative controls; 1 only for a full unskipped passing result, otherwise unknown.',
    unit: 'count',
    // Fixed argv, no shell, test-name filter, or caller-selected test population.
    argv: ['npm', '--prefix', root, 'run', 'test:file', '--', TICKET_FILING_SUITE, '--', '--reporter=json'],
    timeoutMs: 900_000,
    parse: parseTicketFilingIntegration,
  };
}
