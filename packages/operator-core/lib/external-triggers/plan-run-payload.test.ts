import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  readTriggerOperationPayload,
  readTriggerPlanRunPayload,
  redactTriggerArgsForPlanInputs,
  type TriggerRunArgs,
} from './plan-run-payload';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluatePlanStartReadiness } from '../agent-tools/plans/plan-input-validation';

type JsonSchema = {
  const?: unknown;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  default?: unknown;
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
};

interface PackPlanTarget {
  label: string;
  inputSchema: JsonSchema & { properties: { trigger: JsonSchema } };
  /** The full envelope the engine stores (payload included), built from the schema. */
  args: TriggerRunArgs;
  /** Top-level inputs a binding supplies beside the projected envelope. */
  bindingInput: Record<string, unknown>;
  /** The plan text the pack installs for this target (its manifest `path`). */
  planText: string;
}

/**
 * True when plan text tells the agent to read the event from the plan inputs
 * (`payload.plan_run.inputs.trigger.payload`, or the short `trigger.payload`).
 * The binding engine strips that field before launch, so such a step reads
 * nothing; the event is fetched with `triggers:read-payload { planRunId }`.
 */
function readsStrippedTriggerPayload(text: string): boolean {
  return /\btrigger\.payload\b/.test(text);
}

/**
 * A string matching a simple anchored alternation pattern such as
 * `^ext:bluesky:(post|reply)$|^ext:threads:reply$`: take the first top-level
 * branch, then the first alternative of every group. Verified against the
 * pattern, so an unsupported shape fails loudly instead of sampling wrongly.
 */
function sampleForPattern(pattern: string): string {
  let depth = 0;
  let cut = pattern.length;
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '(') depth += 1;
    else if (pattern[i] === ')') depth -= 1;
    else if (pattern[i] === '|' && depth === 0) {
      cut = i;
      break;
    }
  }
  let sample = pattern.slice(0, cut).replace(/^\^/, '').replace(/\$$/, '');
  while (/\(([^()]*)\)/.test(sample)) sample = sample.replace(/\(([^()]*)\)/, (_m, inner: string) => inner.split('|')[0]!);
  // Character classes: `[a-z0-9]` → its first character, dropped entirely under `*` or `?`
  // (zero repetitions satisfy them); escapes → the escaped character, `\d` → a digit.
  // A bounded repeat `{n}` / `{n,m}` / `{n,}` takes its minimum count (e.g. a Slack/Discord
  // snowflake id `^[0-9]{17,20}$`).
  const expanded = sample
    .replace(/\[(\^?)([^\]]+)\](\*|\+|\?|\{(\d+)(?:,\d*)?\})?/g, (_m, negated: string, cls: string, quantifier?: string, min?: string) =>
      quantifier === '*' || quantifier === '?' ? '' : (negated ? 'a' : cls[0]!).repeat(min ? Number(min) : 1),
    )
    .replace(/\\d\{(\d+)(?:,\d*)?\}/g, (_m, min: string) => '1'.repeat(Number(min)))
    .replace(/\\d/g, '1')
    .replace(/\\(.)/g, '$1');
  const matcher = new RegExp(pattern);
  const found = [sample, expanded, '1', '1.5', 'sample-value', 'a'].find((candidate) => matcher.test(candidate));
  if (found === undefined) throw new Error(`sampleForPattern cannot satisfy ${pattern}`);
  return found;
}

/** A minimal value that satisfies `schema` — consts and defaults win, then the type. */
function sampleFor(schema: JsonSchema): unknown {
  if ('const' in schema) return schema.const;
  if (typeof schema.pattern === 'string') return sampleForPattern(schema.pattern);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.format === 'uuid') return '2b7f9e2a-0000-4000-8000-000000000009';
  if (schema.format === 'date-time') return '2026-10-06T00:00:00.000Z';
  switch (schema.type) {
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const key of schema.required ?? []) out[key] = sampleFor(schema.properties?.[key] ?? {});
      return out;
    }
    default:
      return 'sample-value';
  }
}

function findTriggerPack(node: unknown): { targets?: Array<Record<string, unknown>> } | null {
  if (!node || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;
  if (record.triggerPack && typeof record.triggerPack === 'object') return record.triggerPack as never;
  for (const value of Object.values(record)) {
    const found = findTriggerPack(value);
    if (found) return found;
  }
  return null;
}

/** Every first-party pack plan target whose input schema receives a trigger envelope. */
function firstPartyTriggerPackPlanTargets(): PackPlanTarget[] {
  const pluginsDir = fileURLToPath(new URL('../../../../libs/papercusp/plugins/', import.meta.url));
  const targets: PackPlanTarget[] = [];
  for (const dir of readdirSync(pluginsDir).sort()) {
    const manifestPath = `${pluginsDir}${dir}/papercusp.json`;
    if (!existsSync(manifestPath)) continue;
    const pack = findTriggerPack(JSON.parse(readFileSync(manifestPath, 'utf8')));
    for (const target of pack?.targets ?? []) {
      const inputSchema = target.inputSchema as PackPlanTarget['inputSchema'] | undefined;
      const triggerSchema = inputSchema?.properties?.trigger;
      if (target.kind !== 'plan' || !triggerSchema) continue;
      const trigger = sampleFor(triggerSchema) as Record<string, unknown>;
      const payloadSchema = triggerSchema.properties?.payload;
      const args = {
        trigger: { ...trigger, payload: payloadSchema ? sampleFor(payloadSchema) : { text: 'PRIVATE' } },
      } as unknown as TriggerRunArgs;
      const bindingInput: Record<string, unknown> = {};
      for (const key of inputSchema.required ?? []) {
        if (key !== 'trigger') bindingInput[key] = sampleFor(inputSchema.properties[key as 'trigger'] ?? {});
      }
      const planPath = `${pluginsDir}${dir}/${String(target.path)}`;
      const planText = existsSync(planPath) ? readFileSync(planPath, 'utf8') : '';
      targets.push({ label: `${dir}/${String(target.id)}`, inputSchema, args, bindingInput, planText });
    }
  }
  return targets;
}

function gmailArgs(): TriggerRunArgs {
  return {
    trigger: {
      key: 'ext:gmail:message.received',
      source: 'gmail',
      event: 'message.received',
      sourceId: '2b7f9e2a-0000-4000-8000-000000000001',
      externalId: '19abc0011',
      occurredAt: '2026-09-04T09:00:00.000Z',
      datatypeId: 'email-message',
      dedupeKey: 'gmail:19abc0011',
      payload: {
        id: '19abc0011',
        threadId: 't-19abc0011',
        from: 'someone@example.com',
        subject: 'Quarterly numbers',
        messageId: '<abc@mail.example.com>',
        direction: 'inbound',
        text: 'PRIVATE BODY — must never reach a federated record.',
      },
    },
  };
}

function slackArgs(): TriggerRunArgs {
  return {
    trigger: {
      key: 'ext:slack:mention',
      source: 'slack',
      event: 'mention',
      sourceId: '2b7f9e2a-0000-4000-8000-000000000002',
      externalId: 'C123:1725440000.001',
      occurredAt: '2026-09-04T09:00:00.000Z',
      datatypeId: 'slack-message',
      dedupeKey: 'slack:C123:1725440000.001',
      payload: { channelId: 'C123', threadId: '1725440000.001', text: 'PRIVATE MENTION TEXT' },
    },
  };
}

describe('redactTriggerArgsForPlanInputs', () => {
  it('drops the private payload and keeps every routing field', () => {
    const projected = redactTriggerArgsForPlanInputs(gmailArgs());
    expect(projected.trigger).not.toHaveProperty('payload');
    expect(projected.trigger).toEqual({
      key: 'ext:gmail:message.received',
      source: 'gmail',
      event: 'message.received',
      sourceId: '2b7f9e2a-0000-4000-8000-000000000001',
      externalId: '19abc0011',
      occurredAt: '2026-09-04T09:00:00.000Z',
      datatypeId: 'email-message',
      dedupeKey: 'gmail:19abc0011',
    });
  });

  it('does not carry the private body anywhere in the serialized projection', () => {
    const serialized = JSON.stringify(redactTriggerArgsForPlanInputs(gmailArgs()));
    expect(serialized).not.toContain('PRIVATE BODY');
    expect(serialized).not.toContain('someone@example.com');
  });

  it('leaves the source args untouched — trigger_runs.args must keep the payload', () => {
    const args = gmailArgs();
    redactTriggerArgsForPlanInputs(args);
    expect(args.trigger.payload).toMatchObject({ direction: 'inbound' });
    expect(args.trigger.payload.text).toContain('PRIVATE BODY');
  });
});

/**
 * THE LOCKSTEP GUARD (WI-2143575).
 *
 * The engine stopping sending `trigger.payload` and the installed input schema
 * still REQUIRING it is a silent-breakage pair: every launch fails validation and
 * a refused launch produces no run and no error surface. These assertions run the
 * engine's real projection through the real start-gate oracle — the same
 * `evaluatePlanStartReadiness` that `plan-run-action.ts` consults — so the two
 * halves cannot drift apart without a red test.
 */
describe('projected plan inputs satisfy every shipped trigger input schema', () => {
  /**
   * Every first-party trigger pack's plan target is installed as that plan's
   * input_schema (trigger-pack-materialize.ts), so each one is checked against
   * the engine's real projection. Discovered from the manifests, so a new pack
   * is covered without editing this file (WI-10006318: 15 pack targets once
   * required the payload the engine strips, and only the flagship was pinned).
   */
  const packTargets = firstPartyTriggerPackPlanTargets();

  it('discovers the first-party trigger-pack plan targets (non-vacuous)', () => {
    expect(packTargets.length).toBeGreaterThanOrEqual(10);
    expect(packTargets.map((target) => target.label)).toContain('email-draft-responder/draft-reply');
  });

  it.each(packTargets.map((target) => [target.label, target] as const))(
    '%s: the redacted envelope is start-ready',
    (_label, target) => {
      const verdict = evaluatePlanStartReadiness(
        { template: null, inputSchema: target.inputSchema },
        { ...redactTriggerArgsForPlanInputs(target.args), ...target.bindingInput },
      );
      expect(verdict).toEqual({ ready: true, source: 'input-schema' });
    },
  );

  it('no shipped trigger schema still requires the private payload', () => {
    // A pack may still DESCRIBE payload (it documents the stored envelope that
    // triggers:read-payload returns); it may never REQUIRE it.
    const requiring = packTargets
      .filter((target) => (target.inputSchema.properties.trigger.required ?? []).includes('payload'))
      .map((target) => target.label);
    expect(requiring).toEqual([]);
  });

  it('no shipped pack plan text reads the stripped trigger.payload from its inputs', () => {
    const missingText = packTargets.filter((target) => target.planText === '').map((target) => target.label);
    expect(missingText).toEqual([]);
    const reading = packTargets
      .filter((target) => readsStrippedTriggerPayload(target.planText))
      .map((target) => target.label);
    expect(reading).toEqual([]);
  });

  it('CONTROL: the plan-text detector flags both spellings and spares triggers:read-payload', () => {
    expect(readsStrippedTriggerPayload('Parse `payload.plan_run.inputs.trigger.payload`;')).toBe(true);
    expect(readsStrippedTriggerPayload('1. Read `trigger.payload`. Use ONLY fields')).toBe(true);
    expect(
      readsStrippedTriggerPayload('Call `triggers:read-payload { planRunId: payload.plan_run.runId }` and read its `payload`.'),
    ).toBe(false);
  });

  /**
   * CALIBRATION — proves the assertions above can actually fail. A schema
   * identical to the shipped one except that it still requires `payload` must
   * REJECT the projection. Without this, a validator that passed everything
   * would make the whole block green and meaningless.
   */
  it('CONTROL: a pack target that still requires payload rejects the projection', () => {
    const target = packTargets.find((candidate) => candidate.label === 'email-draft-responder/draft-reply')!;
    const trigger = target.inputSchema.properties.trigger;
    const stale = {
      ...target.inputSchema,
      properties: {
        ...target.inputSchema.properties,
        trigger: { ...trigger, required: [...(trigger.required ?? []), 'payload'] },
      },
    };
    const verdict = evaluatePlanStartReadiness(
      { template: null, inputSchema: stale },
      { ...redactTriggerArgsForPlanInputs(target.args), ...target.bindingInput },
    );
    expect(verdict.ready).toBe(false);
  });

  /**
   * CONTROL: the same oracle accepts the UNREDACTED args too, so a green result
   * above is evidence about the projection and not about a schema so loose it
   * accepts anything.
   */
  it('CONTROL: the unredacted envelope is also start-ready under the shipped schema', () => {
    const target = packTargets.find((candidate) => candidate.label === 'email-draft-responder/draft-reply')!;
    const verdict = evaluatePlanStartReadiness(
      { template: null, inputSchema: target.inputSchema },
      { ...target.args, ...target.bindingInput },
    );
    expect(verdict.ready).toBe(true);
  });
});

function stubSql(rows: unknown[]): postgres.Sql {
  return ((..._ignored: unknown[]) => Promise.resolve(rows)) as unknown as postgres.Sql;
}

function capturingStubSql(rows: unknown[], capture: { query: string }): postgres.Sql {
  return ((parts: TemplateStringsArray, ..._values: unknown[]) => {
    capture.query = Array.from(parts).join(' /* interpolation */ ');
    return Promise.resolve(rows);
  }) as unknown as postgres.Sql;
}

describe('readTriggerPlanRunPayload', () => {
  it('returns the private payload resolved server-side from the local trigger run', async () => {
    const sql = stubSql([{ triggerRunId: 'run-1', args: gmailArgs() }]);
    const result = await readTriggerPlanRunPayload(sql, 'papercusp-workspace', 974);
    expect(result.triggerRunId).toBe('run-1');
    expect(result.key).toBe('ext:gmail:message.received');
    expect(result.source).toBe('gmail');
    expect(result.dedupeKey).toBe('gmail:19abc0011');
    expect(result.payload.text).toContain('PRIVATE BODY');
  });

  it('is source-agnostic — one reader serves slack as well as gmail', async () => {
    const sql = stubSql([{ triggerRunId: 'run-2', args: slackArgs() }]);
    const result = await readTriggerPlanRunPayload(sql, 'papercusp-workspace', 42);
    expect(result.source).toBe('slack');
    expect(result.payload.channelId).toBe('C123');
  });

  it('resolves a plan run ref regardless of the trigger receipt status', async () => {
    const capture = { query: '' };
    const sql = capturingStubSql([{ triggerRunId: 'run-failed', args: slackArgs() }], capture);
    const result = await readTriggerPlanRunPayload(sql, 'papercusp-workspace', 1347);

    expect(result.triggerRunId).toBe('run-failed');
    expect(result.payload.channelId).toBe('C123');
    expect(capture.query).toContain('tr.plan_run_ref = ');
    expect(capture.query).not.toContain("tr.status = 'succeeded'");
  });

  it('refuses a non-positive or non-integral planRunId before touching the database', async () => {
    const sql = stubSql([]);
    await expect(readTriggerPlanRunPayload(sql, 'w', 0)).rejects.toThrow('trigger_payload_plan_run_id_invalid');
    await expect(readTriggerPlanRunPayload(sql, 'w', -3)).rejects.toThrow('trigger_payload_plan_run_id_invalid');
    await expect(readTriggerPlanRunPayload(sql, 'w', 1.5)).rejects.toThrow('trigger_payload_plan_run_id_invalid');
  });

  it('throws a typed not-found rather than returning an empty payload', async () => {
    const sql = stubSql([]);
    await expect(readTriggerPlanRunPayload(sql, 'papercusp-workspace', 999)).rejects.toThrow(
      'trigger_payload_run_not_found:999',
    );
  });

  it('degrades to an empty payload object when a legacy row carries no trigger envelope', async () => {
    const sql = stubSql([{ triggerRunId: 'run-3', args: {} }]);
    const result = await readTriggerPlanRunPayload(sql, 'papercusp-workspace', 7);
    expect(result.payload).toEqual({});
    expect(result.key).toBe('');
  });
});

describe('readTriggerOperationPayload (D-006: trigger-fired operation work item)', () => {
  it('returns the same private payload shape, keyed by the operation work item', async () => {
    const sql = stubSql([{ triggerRunId: 'run-op-1', args: gmailArgs() }]);
    const result = await readTriggerOperationPayload(sql, 'papercusp-workspace', 'WI-123');
    expect(result.triggerRunId).toBe('run-op-1');
    expect(result.source).toBe('gmail');
    expect(result.payload.text).toContain('PRIVATE BODY');
  });

  it('refuses a blank work item id before touching the database', async () => {
    let touched = false;
    const sql = ((..._ignored: unknown[]) => {
      touched = true;
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;
    await expect(readTriggerOperationPayload(sql, 'w', '   ')).rejects.toThrow('trigger_payload_work_item_id_invalid');
    expect(touched).toBe(false);
  });

  it('throws a typed not-found rather than returning an empty payload', async () => {
    await expect(readTriggerOperationPayload(stubSql([]), 'papercusp-workspace', 'WI-404')).rejects.toThrow(
      'trigger_payload_operation_not_found:WI-404',
    );
  });
});
