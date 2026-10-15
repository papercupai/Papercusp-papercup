import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pushSignatureMatches } from './connector-push';

describe('declared push signature framing', () => {
  it('requires the declared prefix and signs the exact raw bytes', () => {
    const rawBody = Buffer.from('{ "entry": [] }');
    const digest = createHmac('sha256', 'app-secret').update(rawBody).digest('hex');
    const input = { rawBody, secrets: ['app-secret'], prefix: 'sha256=' };
    expect(pushSignatureMatches({ ...input, header: `sha256=${digest}` })).toBe(true);
    expect(pushSignatureMatches({ ...input, header: digest })).toBe(false);
    expect(pushSignatureMatches({ ...input, header: `sha1=${digest}` })).toBe(false);
    expect(pushSignatureMatches({ ...input, header: `sha256=${digest}`, rawBody: Buffer.from('{"entry":[]}') })).toBe(false);
    expect(pushSignatureMatches({ rawBody, secrets: ['app-secret'], header: digest })).toBe(true);
  });
});
