import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapterRuntimeArguments, readAdapterRequestPin, readAdapterRuntimeEvidence } from './runtime-adapter-evidence';

describe('observed direct adapter custody', () => {
  it('accepts only exact isolated capture arguments', () => {
    expect(adapterRuntimeArguments(['--adapter', '--', '--requests', 'r.json', '--out', 'o.json']))
      .toEqual(['--requests', 'r.json', '--out', 'o.json']);
    for (const args of [[], ['--', '--out', 'o.json'], ['--', '--requests', 'x.json', '--out', 'x.json'],
      ['--', '--requests', 'r.json', '--out', 'o.json', '--extra']])
      expect(() => adapterRuntimeArguments(args)).toThrow();
  });
  it.each(['valid', 'missing', 'duplicate', 'request-drift', 'input-drift', 'invalid-json', 'negative-time', 'transport', 'acceptance'])(
    'binds request bytes and final terminal captures: %s', variant => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-adapter-'));
      try {
        const input = path.join(root, 'requests.json'), output = path.join(root, 'output.json');
        const args = ['--requests', input, '--out', output];
        const requests = ['a', 'b'].map(id => ({ id, adapter: 'search:semantic',
          args: { query: 'frozen '+id, scope: ['work_item'], harness_slug: 'papercusp', limit: 3 } }));
        fs.writeFileSync(input, JSON.stringify(requests));
        const pin = readAdapterRequestPin(args);
        const rows = requests.map(r => ({ schemaVersion: 1, attemptId: r.id, adapter: r.adapter, request: {...r.args},
          exitCode: 0, stdout: '{"content":[]}', deliveryWallMs: 2,
          observation: { plane: 'direct-tool-handler', transportExercised: false, baselineAccepted: false } }));
        if (variant === 'missing') rows.pop();
        if (variant === 'duplicate') rows[1]!.attemptId = 'a';
        if (variant === 'request-drift') rows[0]!.request.query = 'changed';
        if (variant === 'input-drift') fs.appendFileSync(input, '\n');
        if (variant === 'invalid-json') rows[0]!.stdout = 'partial';
        if (variant === 'negative-time') rows[0]!.deliveryWallMs = -1;
        if (variant === 'transport') rows[0]!.observation.transportExercised = true;
        if (variant === 'acceptance') rows[0]!.observation.baselineAccepted = true;
        fs.writeFileSync(output, JSON.stringify(rows));
        const read = () => readAdapterRuntimeEvidence(args, pin);
        if (variant === 'valid') expect(read()).toMatchObject({ executed: 2, searchAdapterExercised: true,
          baselineAccepted: false, latencyAcceptance: false });
        else expect(read).toThrow();
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
});
