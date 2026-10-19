import { describe, expect, it } from 'vitest';
import { assertSpawnAccountRoute, spawnObservedGatewayModel, spawnRouteGatewayModel, verifySpawnFirstGatewayRequest,
  type SpawnAccountRoute, type SpawnFirstGatewayRequest } from './spawn-tree';

const route: SpawnAccountRoute = {
  ownerId: 's-primary', accountRoute: 'auto', requestedBackend: 'codex',
  requestedModel: 'gpt-5.4', requestedEffort: 'high', launchedBackend: 'codex',
  launchedModel: 'gpt-5.4', launchedEffort: 'high', resolvedAccountIds: ['pool-a', 'pool-b'],
};
const request: SpawnFirstGatewayRequest = {
  ownerId: 's-primary', requestId: 'gateway-incarnation:1', requestOrdinal: 1, provider: 'codex',
  protocol: 'openai-responses', model: 'gpt-5.4', effort: 'high', servingAccountId: 'pool-b',
  outcome: 'ok', finalStatus: 200, startedAt: 100,
};

describe('exact spawn/first gateway request correlation', () => {
  it('requires a real request and membership in the resolved route set', () => {
    expect(verifySpawnFirstGatewayRequest('s-primary', route, request)).toBe(true);
    expect(verifySpawnFirstGatewayRequest('s-primary', route, null)).toBe(false);
    expect(verifySpawnFirstGatewayRequest('s-primary', route, { ...request, servingAccountId: 'unrelated-headroom' })).toBe(false);
  });
  it('matches Claude gateway evidence to the upstream id while preserving the [1m] launch spec', () => {
    const claudeRoute: SpawnAccountRoute = {
      ...route,
      launchedBackend: 'claude-code',
      launchedModel: 'claude-sonnet-5[1m]',
      resolvedAccountIds: ['claude-a'],
    };
    const claudeRequest: SpawnFirstGatewayRequest = {
      ...request,
      provider: 'claude',
      protocol: 'anthropic-messages',
      model: 'claude-sonnet-5',
      servingAccountId: 'claude-a',
    };
    expect(spawnRouteGatewayModel(claudeRoute)).toBe('claude-sonnet-5');
    expect(spawnObservedGatewayModel(claudeRequest)).toBe('claude-sonnet-5');
    expect(verifySpawnFirstGatewayRequest('s-primary', claudeRoute, claudeRequest)).toBe(true);
    expect(verifySpawnFirstGatewayRequest('s-primary', claudeRoute,
      { ...claudeRequest, model: 'claude-sonnet-5[1m]' })).toBe(true);
    expect(spawnObservedGatewayModel({ ...claudeRequest, model: 'claude-opus-5[1m]' })).toBe('claude-opus-5');
    expect(verifySpawnFirstGatewayRequest('s-primary', claudeRoute,
      { ...claudeRequest, model: 'claude-opus-5[1m]' })).toBe(false);
  });
  it.each([
    { ownerId: 's-foreign' }, { requestId: '' }, { provider: 'claude' },
    { model: 'wrong-model' }, { effort: 'low' }, { outcome: 'upstream-429', finalStatus: 429 },
    { servingAccountId: null },
  ])('rejects mismatched/omitted first-request evidence %j', patch => {
    expect(verifySpawnFirstGatewayRequest('s-primary', route, { ...request, ...patch })).toBe(false);
  });
  it('refuses omitted primary metadata and mismatched stable keys', () => {
    expect(() => assertSpawnAccountRoute('s-other', route)).toThrow(/owner/);
    expect(() => assertSpawnAccountRoute('s-primary', { ...route, requestedModel: '' })).toThrow(/backend\/model/);
    expect(() => assertSpawnAccountRoute('s-primary', { ...route, resolvedAccountIds: ['a', 'a'] })).toThrow(/unique/);
  });
});
