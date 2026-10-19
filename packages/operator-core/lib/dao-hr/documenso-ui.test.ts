import { describe, expect, it, vi } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { assertCompletionResponse, register, sign } from '../../../../scripts/fixtures/dao-hr-documenso-ui';

describe('Documenso UI failure diagnostics', () => {
  it.each([false, true])('waits for the PDF viewer before navigating to a virtualized signature field (signature dialog=%s)', async needsSignature => {
    let viewerReady = false, fieldRevealed = false, dialogVisible = false, fieldSigned = false, completed = false;
    const viewer = { first: () => viewer, waitFor: vi.fn(async () => {
      // Model the separately loaded PDF viewer. An earlier Next Field click
      // cannot set data-scroll-to-page on a viewer that does not exist yet.
      await Promise.resolve();
      viewerReady = true;
    }) };
    const field = {
      waitFor: vi.fn(async () => { if (!fieldRevealed) throw Object.assign(new Error('Field page never mounted'), { name: 'TimeoutError' }); }),
      scrollIntoViewIfNeeded: vi.fn(), boundingBox: vi.fn().mockResolvedValue({ x: 20, y: 30, width: 120, height: 40 }),
      evaluateAll: async () => [],
    };
    const next = { first: () => next, click: vi.fn(async () => { fieldRevealed = viewerReady; }) };
    const complete = { first: () => complete, count: async () => Number(fieldSigned), click: vi.fn(async () => { dialogVisible = true; }) };
    const typedInput = { fill: vi.fn() };
    const dialog = { isVisible: async () => dialogVisible,
      getByRole: (role: string, options: { name: string }) => ({ click: vi.fn(async () => {
        if (role === 'button' && options.name === 'Sign') {
          if (fieldSigned) completed = true;
          else fieldSigned = true;
          dialogVisible = false;
        }
      }) }), getByTestId: () => typedInput };
    const page = { goto: vi.fn(), locator: vi.fn(selector => selector === '#field-tooltip' ? field :
      selector === '[data-pdf-content] .konva-container canvas' ? viewer :
      { evaluateAll: async () => [], evaluate: async () => [] }),
      getByRole: vi.fn((role, options) => role === 'dialog' ? dialog : options.name === 'Next Field' ? next : complete),
      mouse: { click: vi.fn(async () => { dialogVisible = needsSignature; fieldSigned = !needsSignature; }) },
    } as unknown as Page;
    await sign(page, 'https://provider.invalid/private-signing-link');
    expect(viewer.waitFor).toHaveBeenCalledOnce();
    expect(next.click).toHaveBeenCalledOnce();
    expect(page.mouse.click).toHaveBeenCalledWith(80, 50);
    expect(typedInput.fill).toHaveBeenCalledTimes(Number(needsSignature));
    expect(completed).toBe(true);
  });

  it('reports PDF readiness failure before clicking Next Field without retaining provider data', async () => {
    const nextClick = vi.fn();
    const page = { goto: vi.fn(), getByRole: () => ({ first: () => ({ click: nextClick }) }),
      locator: (selector: string) => selector === '[data-pdf-content] .konva-container canvas' ?
        { first: () => ({ waitFor: vi.fn().mockRejectedValue(Object.assign(new Error('private signing URL'), { name: 'TimeoutError' })) }) } :
        { evaluateAll: async () => [], evaluate: async () => [] },
    } as unknown as Page;
    await expect(sign(page, 'https://provider.invalid/private-signing-link')).rejects.toThrow(
      'Documenso UI phase failed: wait for provider PDF viewer readiness; errorType=TimeoutError; errorCode=timeout; issues=[]; controls=[]');
    expect(nextClick).not.toHaveBeenCalled();
  });

  it.each(['locate', 'position', 'activate'] as const)('distinguishes a canvas %s failure while retaining only safe geometry', async stage => {
    const NEVER_EMIT_MARKER = 'never-emit-me';
    const failure = Object.assign(new Error('Timeout at https://provider.invalid/' + NEVER_EMIT_MARKER), { name: 'TimeoutError' });
    const box = { x: 10, y: 80, width: 200, height: 40 };
    const element = { textContent: NEVER_EMIT_MARKER, getAttribute: () => NEVER_EMIT_MARKER, getBoundingClientRect: () => box,
      ownerDocument: { defaultView: { innerWidth: 800, innerHeight: 600 },
        elementFromPoint: () => ({ tagName: 'CANVAS', textContent: NEVER_EMIT_MARKER }), querySelectorAll: () => [1, 2] } };
    const field = {
      waitFor: stage === 'locate' ? vi.fn().mockRejectedValue(failure) : vi.fn(),
      scrollIntoViewIfNeeded: stage === 'position' ? vi.fn().mockRejectedValue(failure) : vi.fn(),
      boundingBox: vi.fn().mockResolvedValue(box),
      evaluateAll: vi.fn(async callback => callback([element])),
    };
    const page = {
      goto: vi.fn(), getByRole: vi.fn(() => ({ first: () => ({ click: vi.fn() }) })),
      mouse: { click: vi.fn().mockRejectedValue(failure) },
      locator: vi.fn(selector => selector === '#field-tooltip' ? field : selector === '[data-pdf-content] .konva-container canvas' ?
        { first: () => ({ waitFor: vi.fn() }) } : {
        evaluateAll: vi.fn().mockResolvedValue([]), evaluate: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as Page;
    const error = await sign(page, 'https://provider.invalid/' + NEVER_EMIT_MARKER).then(() => null, value => value as Error);
    expect(error!.message).toBe('Documenso UI phase failed: ' + stage + ' provider canvas signature field; ' +
      'errorType=TimeoutError; errorCode=timeout; issues=[]; controls=[]; fieldLayout=' +
      JSON.stringify([{ ...box, viewportWidth: 800, viewportHeight: 600, canvasCount: 2, centerTarget: 'CANVAS' }]));
    expect(error!.stack).not.toContain(NEVER_EMIT_MARKER);
    expect(error!.cause).toBeUndefined();
    if (stage !== 'activate') expect(page.mouse.click).not.toHaveBeenCalled();
  });
  it('reads and retains the allowlisted completion refusal before a failed status assertion', async () => {
    const retain = vi.fn();
    const response = Response.json({ ok: false, error: 'invalid_completion', message: 'private response text',
      completion: { check: 'envelope_schema', providerStatus: 'PENDING', invalidFields: ['status', 'completedAt'], signer: 'private@example.test' },
      signingUrl: 'https://provider.invalid/private-token', apiKey: 'private-api-key' }, { status: 409 });
    const error = await assertCompletionResponse(response, retain).then(() => null, value => value as Error);
    expect(error).toBeInstanceOf(Error);
    expect(response.bodyUsed).toBe(true);
    expect(retain).toHaveBeenCalledExactlyOnceWith({ status: 409, ok: false, error: 'invalid_completion',
      completion: { check: 'envelope_schema', providerStatus: 'PENDING', invalidFields: ['status', 'completedAt'] } });
    for (const privateValue of ['private response text', 'private@example.test', 'private-token', 'private-api-key']) {
      expect(error!.message).not.toContain(privateValue);
      expect(JSON.stringify(retain.mock.calls)).not.toContain(privateValue);
    }
  });
  it.each(['non-json', 'unclassified'] as const)('retains a safe %s failure without copying body values', async scenario => {
    const retain = vi.fn();
    const response = scenario === 'non-json' ? new Response('private-provider-body', { status: 502 }) :
      Response.json({ error: 'private-provider-error', completion: { check: 'private-provider-check', providerStatus: 'private-status' } }, { status: 409 });
    await expect(assertCompletionResponse(response, retain)).rejects.toThrow('Authenticated provider completion response');
    expect(retain).toHaveBeenCalledExactlyOnceWith(scenario === 'non-json' ? { status: 502, ok: false } :
      { status: 409, ok: false, error: 'unclassified' });
  });
  it('retains a successful completion response without the private contract reference', async () => {
    const retain = vi.fn();
    await assertCompletionResponse(Response.json({ ok: true, contractId: 'private-contract' }), retain);
    expect(retain).toHaveBeenCalledExactlyOnceWith({ status: 200, ok: true });
  });
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
