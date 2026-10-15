import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import tool from './list';

describe('orders:list limit contract', () => {
  it('keeps both numeric bounds visible when a client flattens the parameter to a number', () => {
    const schema = z.toJSONSchema(tool.args, { io: 'input' });
    const limit = schema.properties?.limit as {
      minimum: number;
      maximum: number;
      description: string;
    };
    expect(limit.minimum).toBe(1);
    expect(limit.maximum).toBe(200);
    for (const boundary of [limit.minimum, limit.maximum]) {
      expect(limit.description).toMatch(new RegExp(`\\b${boundary}\\b`));
    }
  });

  it('agrees with the published boundaries without relaxing validation', () => {
    expect(tool.args.safeParse({ limit: 1 }).success).toBe(true);
    expect(tool.args.safeParse({ limit: 200 }).success).toBe(true);
    for (const limit of [0, 201, 500, 1.5]) {
      expect(tool.args.safeParse({ limit }).success).toBe(false);
    }
    expect(tool.args.safeParse({}).success).toBe(true);
  });
});
