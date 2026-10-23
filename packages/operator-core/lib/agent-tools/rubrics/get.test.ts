import { describe, expect, it } from 'vitest';
import getRubricTool from './get';

describe('rubrics:get workspace transaction boundary', () => {
  it('does not retain an ambient workspace transaction during its independent reads', () => {
    expect((getRubricTool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});
