import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
// Register during collection: the live catalog has a large import graph and
// cannot be measured by an unregistered selector or a mocked working set.
import '../../index';
import {
  compactInputSchema,
  compactWireBytes,
  listAllProjectedTools,
  summaryGuidanceDescription,
} from '@papercusp/tooldef';
import { CLAUDE_TOOL_DELIVERY } from '../../../../../../apps/operator/scripts/tool-delivery.generated.mjs';
import { capabilityToolNames, OWNED_LOOP_TOOL_SELECTION } from '../../../agent-loop/capability-toolset';
import { applyCompactTier } from '../../../endpoint-route/routes/transport/tool-allowlist';
import { MIN_PLAUSIBLE_CATALOG_SIZE } from '../../tool-guidance-budget';
import { AGENT_MCP_TOOL_PREFIX, buildConverseMcpMount, selectConverseTools } from '../converse-toolset';

interface Definition {
  name: string;
  description: string;
  inputSchema: unknown;
  voice: boolean;
}

describe('Papercup tool surface — registered catalog (P-001)', () => {
  let definitions: Map<string, Definition>;
  let doors: string[];

  beforeAll(() => {
    const catalog = listAllProjectedTools();
    expect(catalog.length).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_CATALOG_SIZE);
    definitions = new Map(catalog.flatMap((tool) => {
      const name = tool.expose?.mcp?.name;
      if (!name) return [];
      return [[name, {
        name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? {},
        voice: (tool.modality ?? ['text', 'voice']).includes('voice'),
      }] as const];
    }));
    doors = capabilityToolNames(OWNED_LOOP_TOOL_SELECTION);
    expect(doors).toEqual(expect.arrayContaining(['tasks:ops', 'tasks:todo_write', 'tasks:update_plan']));
    expect(doors.some((name) => name.startsWith('capability:'))).toBe(true);
  });

  it('measures the real owner/customer/public selections and the same compact definitions the transport emits', () => {
    const surfaces = [
      { label: 'local-owner-text', hostTrust: 'owner' as const, modality: 'text' as const },
      { label: 'hosted-owner-text', hostTrust: 'owner' as const, modality: 'text' as const, agentRunsAsCustomer: true },
      { label: 'public-text', hostTrust: 'public' as const, modality: 'text' as const },
      { label: 'local-owner-voice', hostTrust: 'owner' as const, modality: 'voice' as const },
      { label: 'hosted-owner-voice', hostTrust: 'owner' as const, modality: 'voice' as const, agentRunsAsCustomer: true },
      { label: 'public-voice', hostTrust: 'public' as const, modality: 'voice' as const },
    ];
    const measurements = surfaces.map((surface) => {
      const names = selectConverseTools({
        ...surface, role: 'papercup', publicDoorNames: () => doors,
        supportsVoice: (name) => definitions.get(name)?.voice ?? false,
      }).map((name) => name.replace(AGENT_MCP_TOOL_PREFIX, ''));
      expect(new Set(names).size).toBe(names.length);
      const unknown = names.filter((name) => !definitions.has(name));
      expect(unknown, `${surface.label} advertises tools absent from the registered catalog`).toEqual([]);
      const listings = names.map((name) => definitions.get(name)!);
      const compact = applyCompactTier(listings, new Set(names), compactInputSchema, summaryGuidanceDescription);
      const projectedBytes = compact.reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify({
        name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      })), 0);
      const measuredCompactBytes = listings.reduce((sum, tool) => sum + compactWireBytes(tool.name, tool).compact, 0);
      expect(projectedBytes).toBe(measuredCompactBytes);

      const mount = buildConverseMcpMount({
        ...surface, baseUrl: 'http://fixture.invalid', workspaceId: 'fixture-workspace',
        tools: names, uiClientId: null, superuserToken: 'fixture-owner', principalToken: 'fixture-customer',
      });
      expect(mount).not.toBeNull();
      expect(new URL(mount!.url).searchParams.get('tools')?.split(',')).toEqual(names);
      if (surface.hostTrust === 'public' || surface.agentRunsAsCustomer) {
        expect(new URL(mount!.url).searchParams.has('superuser')).toBe(false);
        expect(mount!.bearer).toBe('fixture-customer');
      }
      return {
        surface: surface.label, tools: names.length,
        fullBytes: listings.reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify({
          name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
        })), 0),
        compactBytes: projectedBytes,
      };
    });
    const suNames = [...CLAUDE_TOOL_DELIVERY.advertised];
    const missingSu = suNames.filter((name) => !definitions.has(name));
    expect(missingSu, 'The same-build su comparison must resolve the actual shipping seed').toEqual([]);
    const suCompactBytes = suNames.reduce((sum, name) => sum + compactWireBytes(name, definitions.get(name)!).compact, 0);
    const candidateSeed = [
      'fleet:assignments', 'curation:feed', 'plans:attention', 'work_items:get', 'plans:get',
      'docs:search', 'docs:get', 'chat:ask_choice', 'voice:delegate_deep',
      'work_items:create', 'work_items:set_priority', 'coord:send', 'coord:escalate',
      'tools:find', 'tools:invoke',
    ];
    expect(candidateSeed.filter((name) => !definitions.has(name))).toEqual([]);
    const candidateCompactBytes = candidateSeed.reduce((sum, name) => sum + compactWireBytes(name, definitions.get(name)!).compact, 0);
    const registrySha256 = createHash('sha256').update(JSON.stringify(
      [...definitions.values()].sort((a, b) => a.name.localeCompare(b.name)),
    )).digest('hex');
    console.log(`PAPERCUP_TOOL_SURFACES ${JSON.stringify({
      registrySha256, registryTools: definitions.size,
      client: 'normalized MCP definitions in Vitest', model: 'none; provider input-token measurement remains separate',
      ownedLoopTools: doors.length, ownedLoopNames: doors,
      su: { tools: suNames.length, compactBytes: suCompactBytes }, measurements,
      proposedSeed: { names: candidateSeed, compactBytes: candidateCompactBytes, enabled: false },
      scope: 'registered source definitions before request principal filtering; not hosted deployment acceptance',
    })}`);
  });
});
