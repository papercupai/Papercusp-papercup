import { describe, expect, it, vi } from 'vitest';
import type { Browser } from 'playwright-core';
import { register } from '../../../../scripts/fixtures/dao-hr-documenso-ui';

describe('Documenso UI failure diagnostics', () => {
  it.each([
    ['net::ERR_CONNECTION_REFUSED', 'Error', 'ERR_CONNECTION_REFUSED'],
    ['net::ERR_CONNECTION_RESET', 'Error', 'ERR_CONNECTION_RESET'],
    ['net::ERR_CONNECTION_CLOSED', 'Error', 'ERR_CONNECTION_CLOSED'],
    ['net::ERR_EMPTY_RESPONSE', 'Error', 'ERR_EMPTY_RESPONSE'],
    ['net::ERR_ADDRESS_UNREACHABLE', 'Error', 'ERR_ADDRESS_UNREACHABLE'],
    ['net::ERR_NAME_NOT_RESOLVED', 'Error', 'ERR_NAME_NOT_RESOLVED'],
    ['net::ERR_INVALID_URL', 'Error', 'ERR_INVALID_URL'],
    ['net::ERR_ABORTED', 'Error', 'ERR_ABORTED'],
    ['Cannot navigate to invalid URL', 'Error', 'invalid-url'],
    ['Target page, context or browser has been closed', 'Error', 'target-closed'],
    ['Page crashed', 'Error', 'page-crashed'],
    ['page.goto exceeded its deadline', 'TimeoutError', 'timeout'],
    ['expected navigation to succeed', 'AssertionError', 'assertion'],
    ['net::ERR_PRIVATE_SECRET_CODE', 'Error', 'unclassified'],
    ['an unexpected provider response', 'Error', 'unclassified'],
  ])('classifies %s without copying navigation secrets', async (message, name, code) => {
    const secret = 'https://provider.invalid/verify-email/private-token?password=never-print-this';
    const failure = new Error('page.goto: ' + message + '\nCall log: ' + secret);
    failure.name = name;
    const page = {
      goto: vi.fn().mockRejectedValue(failure),
      locator: vi.fn(() => ({
        evaluateAll: vi.fn().mockResolvedValue([]),
        evaluate: vi.fn().mockResolvedValue([]),
      })),
    };
    const browser = { newContext: async () => ({ newPage: async () => page }) } as unknown as Browser;
    const error = await register(browser, { personId: 'PER-diagnostic', name: 'Fixture', email: 'fixture@daohr.test' })
      .then(() => { throw new Error('Expected signup navigation to fail'); }, value => value as Error);
    expect(error.message).toBe('Documenso UI phase failed: open provider signup form; errorType=' + name +
      '; errorCode=' + code + '; issues=[]; controls=[]');
    expect(error.stack).not.toContain(secret);
    expect(error.stack).not.toContain('Call log:');
    expect(error.cause).toBeUndefined();
  });
});
