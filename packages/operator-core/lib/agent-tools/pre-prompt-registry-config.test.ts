/**
 * pre-prompt-registry-config.test.ts — the host config of which tools get Tier-3
 * prompt-declared column schemas. Two load-bearing invariants: (1) entry names are
 * UNIQUE (the registry is keyed by name; a dup makes lookup ambiguous), and (2)
 * only fixed-shape writes opt into `write:'positional'`. `work_items:set_state`
 * stays keyed because its terminal branch requires completion evidence and
 * assumptions that do not fit a single CSV row.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/pre-prompt-registry-config.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  advertisedArgsSchema,
  isPositionalReadEncoding,
  projectWriteColumns,
  reconstructArgs,
} from '@papercusp/result-encoding';
import { lookupByMcpName } from '@papercusp/agent-mcp';
import { WORK_ITEM_ID_PATTERN } from '../work-items';
import { PRE_PROMPT_REGISTRY } from './pre-prompt-registry-config';
import './work_items/set_state';
import './work_items/claim';

describe('PRE_PROMPT_REGISTRY', () => {
  it('has unique, non-empty entry names', () => {
    const names = PRE_PROMPT_REGISTRY.map((e) => e.name);
    for (const n of names) expect(typeof n === 'string' && n.length > 0).toBe(true);
    expect(new Set(names).size).toBe(names.length); // no duplicates
  });

  it('keeps claim positional but leaves set_state keyed-only for terminal evidence', () => {
    const setState = PRE_PROMPT_REGISTRY.find((x) => x.name === 'work_items:set_state');
    expect(setState, 'set_state must not advertise a row that cannot carry terminal evidence').toBeUndefined();
    const claim = PRE_PROMPT_REGISTRY.find((x) => x.name === 'work_items:claim');
    expect(claim?.write).toBe('positional');
  });

  it('serves the audit:list read as self-describing TOON, never a headerless positional body (EI-136)', () => {
    const e = PRE_PROMPT_REGISTRY.find((x) => x.name === 'audit:list');
    expect(e, 'audit:list must stay in the governed registry').toBeDefined();
    // EI-136 measured a ~1/3 COLUMN-SHIFT MISREAD of this exact result under the
    // headerless form (2 pass / 1 fail over 3 runs) — the reader had to map 5
    // bare positions to a column order held thousands of tokens away in the
    // prompt legend. TOON carries `fields[5]: …` adjacent to the rows instead.
    expect(e?.read).toBe('toon');
    // The load-bearing property is POSITIONAL-ness, not the literal string: any
    // future flip to another headerless encoding (tsv) re-arms the same misread.
    expect(
      isPositionalReadEncoding(e?.read),
      'audit:list must not be served in a headerless positional encoding — see EI-136',
    ).toBe(false);
  });

  it('hardens the positional work-item claim id with columnOverrides (D-007 residual, EI-7927)', () => {
    const claim = PRE_PROMPT_REGISTRY.find((e) => e.name === 'work_items:claim');
    expect(claim?.columnOverrides?.id?.pattern).toBe('^(?:(?:WI|F|EI)-\\d+|F-FIX-\\d+|PR-\\d+-P-\\d+)$');
    expect(claim?.columnOverrides?.id?.pattern).toBe(WORK_ITEM_ID_PATTERN);
  });

  it('reconstructs a promoted F-FIX work-item id through the real claim registry projection', () => {
    const claim = PRE_PROMPT_REGISTRY.find((e) => e.name === 'work_items:claim');
    const claimTool = lookupByMcpName('work_items:claim');
    expect(claim).toBeDefined();
    expect(claimTool).toBeDefined();

    const columns = projectWriteColumns(claimTool!.inputSchema as Record<string, unknown>, {
      columnNames: claim!.writeColumnNames,
      requiredColumnNames: claim!.writeRequiredColumnNames,
      columnOverrides: claim!.columnOverrides,
    });
    expect(columns).toBeDefined();
    expect(reconstructArgs('F-FIX-051,worker,papercusp', columns!)).toEqual({
      ok: true,
      args: { id: 'F-FIX-051', assignee: 'worker', harness: 'papercusp' },
    });
  });

  it('reconstructs a scheduler-created PR work-item id through the real claim registry projection', () => {
    const claim = PRE_PROMPT_REGISTRY.find((e) => e.name === 'work_items:claim');
    const claimTool = lookupByMcpName('work_items:claim');
    expect(claim).toBeDefined();
    expect(claimTool).toBeDefined();

    const columns = projectWriteColumns(claimTool!.inputSchema as Record<string, unknown>, {
      columnNames: claim!.writeColumnNames,
      requiredColumnNames: claim!.writeRequiredColumnNames,
      columnOverrides: claim!.columnOverrides,
    });
    expect(columns).toBeDefined();
    expect(reconstructArgs('PR-971-P-001,worker,papercusp', columns!)).toEqual({
      ok: true,
      args: { id: 'PR-971-P-001', assignee: 'worker', harness: 'papercusp' },
    });
  });

  it('reconstructs force and reason for a system:plan-item-lane-sync hold', () => {
    const claim = PRE_PROMPT_REGISTRY.find((e) => e.name === 'work_items:claim');
    const claimTool = lookupByMcpName('work_items:claim');
    expect(claim).toBeDefined();
    expect(claimTool).toBeDefined();

    const columns = projectWriteColumns(claimTool!.inputSchema as Record<string, unknown>, {
      columnNames: claim!.writeColumnNames,
      requiredColumnNames: claim!.writeRequiredColumnNames,
      columnOverrides: claim!.columnOverrides,
    });
    expect(columns?.map((column) => column.name)).toEqual(['id', 'assignee', 'harness', 'force', 'reason']);
    expect(reconstructArgs('EI-21572738517279628,,papercusp,true,system:plan-item-lane-sync hold', columns!)).toEqual({
      ok: true,
      args: {
        id: 'EI-21572738517279628',
        harness: 'papercusp',
        force: true,
        reason: 'system:plan-item-lane-sync hold',
      },
    });
  });

  it('advertises claim as row+keyed while set_state stays on its full keyed schema (WI-3260)', () => {
    const claim = lookupByMcpName('work_items:claim');
    expect(claim).toBeDefined();
    const claimAdvertised = advertisedArgsSchema('work_items:claim', claim!.inputSchema as Record<string, unknown>);
    const claimOneOf = (claimAdvertised as { oneOf?: unknown[] }).oneOf;
    expect(claimOneOf).toHaveLength(2);
    expect(JSON.stringify(claimAdvertised)).not.toContain('ownerOverride');
    const row = claimOneOf![0] as { properties?: Record<string, { description?: string }> };
    expect(row.properties?.row?.description).toContain('id, assignee?, harness?, force?, reason?');

    const setState = lookupByMcpName('work_items:set_state');
    expect(setState).toBeDefined();
    const setStateAdvertised = advertisedArgsSchema('work_items:set_state', setState!.inputSchema as Record<string, unknown>);
    const setStateProperties = (setStateAdvertised as { properties?: Record<string, unknown> }).properties;
    expect(setStateProperties).not.toHaveProperty('row');
    expect(JSON.stringify(setStateAdvertised)).not.toContain('positional');
    expect(setStateProperties).toHaveProperty('completionRef');
    expect(setStateProperties).toHaveProperty('assumptions');
  });
});
