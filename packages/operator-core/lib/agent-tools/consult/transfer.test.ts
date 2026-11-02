import { describe, expect, it } from 'vitest';
import consultTransferTool from './transfer';

describe('consult:transfer', () => {
  it('requires a reason for the audited follow-up handoff', () => {
    const schema = consultTransferTool.args as unknown as { safeParse: (value: unknown) => { success: boolean } };
    expect(schema.safeParse({ conversation_id: 'conv-transfer', reason: 'requester ended' }).success).toBe(true);
    expect(schema.safeParse({ conversation_id: 'conv-transfer', reason: '  ' }).success).toBe(false);
  });

  it('refuses non-superusers before loading identity or storage dependencies', async () => {
    const handler = consultTransferTool.handler as unknown as (
      args: { conversation_id: string; reason: string },
      ctx: unknown,
    ) => Promise<{ data: Record<string, unknown> }>;
    const result = await handler(
      { conversation_id: 'conv-transfer', reason: 'requester ended' },
      { isSuperuser: false },
    );
    expect(result.data).toMatchObject({ ok: false, error: 'superuser_required' });
  });
});
