import { describe, expect, it, vi } from 'vitest';

import {
  learningDistillerLlm,
  learningStudentRunner,
  TRANSFER_DISTILL_MODEL,
  TRANSFER_STUDENT_MODEL,
} from './live-deps';
import { LEARNING_MODEL_SPEC } from '../learning/model-policy';

const result = {
  text: '[]',
  json: undefined,
  costUsd: 0.25,
  inputTokens: 3,
  outputTokens: 2,
  raw: null,
};

describe('provider-neutral transfer learning LLMs', () => {
  it('distills through the canonical Sol xhigh Responses seam without changing prompt or cap', async () => {
    const call = vi.fn(async () => result);
    const llm = learningDistillerLlm({ llmCall: call as never });

    await expect(llm({ system: 'system prompt', user: 'candidate', maxTokens: 128 })).resolves.toEqual({
      text: '[]',
      costUsd: 0.25,
    });
    expect(TRANSFER_DISTILL_MODEL).toBe(LEARNING_MODEL_SPEC);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({
      model: LEARNING_MODEL_SPEC,
      maxTokens: 128,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'candidate' }],
      priority: 'transfer',
    }));
  });

  it('runs the replay student through the same canonical model with preserved output metadata', async () => {
    const call = vi.fn(async () => ({ ...result, text: 'continued' }));
    const runner = learningStudentRunner({ llmCall: call as never });
    await expect(runner({ systemPrompt: 'system', contextText: 'context' } as never)).resolves.toMatchObject({
      outputText: 'continued',
      costUsd: 0.25,
      inputTokens: 3,
      outputTokens: 2,
      replayed: true,
      execution: { model: LEARNING_MODEL_SPEC, codeHash: null,
        loadedCode: { student: expect.stringMatching(/^[a-f0-9]{16}$/) },
        unresolved: ['student-transport-completeness'] },
    });
    expect(TRANSFER_STUDENT_MODEL).toBe(LEARNING_MODEL_SPEC);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ model: LEARNING_MODEL_SPEC, maxTokens: 2_048 }));
  });

  it('forwards the actual transport receipt while retaining incomplete execution coverage', async () => {
    const runner = learningStudentRunner({ llmCall: async () => ({ ...result,
      execution: { model: 'wire-student', codeHash: null,
        loadedCode: { client: 'loaded-client' }, unresolved: ['remote-gateway'] } }) });
    const output = await runner({ systemPrompt: 'system', contextText: 'context' } as never);
    expect(output.execution).toMatchObject({ model: 'wire-student', codeHash: null,
      loadedCode: { client: 'loaded-client', student: expect.stringMatching(/^[a-f0-9]{16}$/) },
      unresolved: ['remote-gateway'] });
  });
});
