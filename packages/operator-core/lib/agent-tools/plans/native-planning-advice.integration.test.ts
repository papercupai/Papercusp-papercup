import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { PlanItem } from '@papercusp/plan-parser';
import { firstPartyCallers } from '../../code-intelligence/first-party-callers';
import { nativePlanGraphAdvice } from './plan-dag-parallelism';

describe('native P013 compiler-to-plan decomposition integration', () => {
  it('derives producer-before-consumer advice from the actual compiler reference fixture', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-plan-order-'));
    try {
      writeFileSync(join(root, 'producer.ts'), 'export function api() { return "value"; }\n');
      writeFileSync(join(root, 'consumer.ts'), 'import { api } from "./producer";\nexport function client() { return api(); }\n');
      const answer = firstPartyCallers({ ts, root, name: 'api', filePath: 'producer.ts', paths: ['.'], op: 'impact', direction: 'downstream', limit: 20 });
      expect(answer.error).toBeNull();
      const items: Pick<PlanItem, 'id' | 'storedStatus' | 'blockedBy'>[] = [{ id: 'P-001', storedStatus: 'todo', blockedBy: [] }, { id: 'P-002', storedStatus: 'todo', blockedBy: [] }];
      const advice = nativePlanGraphAdvice(items, { symbol: 'api', file: 'producer.ts', taskPaths: [
        { itemId: 'P-001', paths: ['consumer.ts'] }, { itemId: 'P-002', paths: ['producer.ts'] },
      ] }, answer.evidence, new Map(), 'fixture');
      expect(advice.status).toBe('measured'); expect(advice.proposedOrder).toEqual(['P-002', 'P-001']);
      expect(advice.ordering).toContainEqual(expect.objectContaining({ producer: 'P-002', consumer: 'P-001', sourcePath: 'consumer.ts', targetPath: 'producer.ts' }));
      expect(items[0].blockedBy).toEqual([]); expect(items[1].blockedBy).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
