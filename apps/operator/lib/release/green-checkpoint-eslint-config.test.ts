import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const greenCheckpointSource = fileURLToPath(new URL('./green-checkpoint.ts', import.meta.url));

describe('green-checkpoint ESLint configuration', () => {
  it('has no unresolved rules in the source file directives', async () => {
    const eslint = new ESLint({ cwd: repositoryRoot });

    expect(await eslint.isPathIgnored(greenCheckpointSource)).toBe(false);

    const [result] = await eslint.lintFiles([greenCheckpointSource]);
    expect(result?.filePath).toBe(greenCheckpointSource);
    expect(
      result?.messages.filter(
        ({ message, messageId }) =>
          messageId === 'ruleNotFound' || /Definition for rule .+ was not found/.test(message),
      ),
    ).toEqual([]);
  });
});
