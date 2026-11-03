import { describe, expect, it } from 'vitest';
import {
  buildRecipeAuthorityRecommendation,
  deriveRecipeAuthority,
  findVolatileCoordinationOwnerId,
  findVolatileRunArtifactLiteral,
  findVolatileSessionIdLiteral,
  findVolatileTaskIdLiteral,
  recipeRevision,
  recipeAuthorityMatches,
  recipeAuthorityMatchesLiveRefs,
  toRecipeAuthorityMetadata,
  validateRecipeAuthorityProof,
} from './recipe-authority';

describe('recipe revision contract (P-015)', () => {
  it('preserves legacy hashes and binds proofs to canonical schema + manifest material', async () => {
    const script = 'return await tools.plans.list({});';
    const updatedAt = '2026-08-22T22:00:00.000Z';
    const bindingSchema = {
      version: 1,
      properties: { plan: { type: 'string', lifetime: { kind: 'stable' }, required: true } },
      additionalProperties: false,
    };
    const capabilityManifest = {
      version: 1,
      representation: 'recipe-script',
      topology: { premises: ['host:same'] },
      requirements: [{ capability: 'tools:plans:list' }],
      lifecycle: { allowed: ['foreground'], default: 'foreground' },
      replay: { class: 'read-only' },
      content: { emits: ['text'] },
    };

    expect(recipeRevision(script, updatedAt, { bindingSchema: null, capabilityManifest: null }))
      .toBe(recipeRevision(script, updatedAt));
    expect(recipeRevision(script, updatedAt, {
      bindingSchema: {
        additionalProperties: false,
        properties: { plan: { required: true, lifetime: { kind: 'stable' }, type: 'string' } },
        version: 1,
      },
      capabilityManifest,
    })).toBe(recipeRevision(script, updatedAt, { bindingSchema, capabilityManifest }));

    const recommendation = await buildRecipeAuthorityRecommendation({
      script,
      updatedAt,
      bindingSchema,
      capabilityManifest,
    });
    expect(recommendation).not.toBeNull();
    await expect(validateRecipeAuthorityProof({
      script,
      updatedAt,
      bindingSchema,
      capabilityManifest,
      proof: recommendation!.proof,
    })).resolves.toMatchObject({ ok: true });
    await expect(validateRecipeAuthorityProof({
      script,
      updatedAt,
      bindingSchema: { ...bindingSchema, properties: {} },
      capabilityManifest,
      proof: recommendation!.proof,
    })).resolves.toMatchObject({ ok: false, error: 'authority_stale_revision' });
  });
});

describe('recipe recommendation authority (P-008)', () => {
  const script = `
    await tools.plans.get({ slug: 'release-plan' });
    await tools.workItems.get({ id: 'WI-4655', harness: 'papercusp' });
    await tools.locks.acquireResource({ resource: 'windows-vm' });
  `;

  it('derives fleet/plan/harness/item/resource bindings and rejects mismatched recommendations', async () => {
    const descriptor = await deriveRecipeAuthority(script);
    expect(descriptor).toMatchObject({
      bound: true,
      unresolved: false,
      refs: {
        plans: ['release-plan'],
        harnesses: ['papercusp'],
        items: ['WI-4655'],
        resources: ['windows-vm'],
      },
    });

    await expect(buildRecipeAuthorityRecommendation({
      script,
      updatedAt: '2026-07-13T12:00:00.000Z',
      context: { plan: 'another-plan', harness: 'papercusp', items: ['WI-4655'], resources: ['windows-vm'] },
    })).resolves.toBeNull();

    await expect(buildRecipeAuthorityRecommendation({
      script,
      updatedAt: '2026-07-13T12:00:00.000Z',
      context: { plan: 'release-plan', harness: 'papercusp', items: ['WI-4655'], resources: ['windows-vm'] },
    })).resolves.toMatchObject({ proof: { version: 1 }, refs: { items: ['WI-4655'] } });
  });

  it('keeps filtered lock discovery unbound while exact resource reads stay holder-bound', async () => {
    const filteredScript = `
      const resource = 'git-sync:papercusp';
      const locks = await tools.locks.list({ q: resource, limit: 500 });
      const registry = locks.registryCount;
      if (registry?.qApplied !== true || registry?.truncatedByLimit !== false ||
          registry?.matched !== registry?.returned || registry?.returned !== locks.resources.length) {
        throw new Error('Filtered lock registry is incomplete.');
      }
      const rows = locks.resources.filter(row => row.resource === resource);
      if (rows.length !== 1) throw new Error('Exact resource row is missing or ambiguous.');
      return rows[0].held;
    `;
    await expect(deriveRecipeAuthority(filteredScript)).resolves.toMatchObject({
      bound: false,
      unresolved: false,
      refs: { resources: [] },
    });

    await expect(deriveRecipeAuthority(`
      return await tools.locks.list({ resource: 'git-sync:papercusp' });
    `)).resolves.toMatchObject({
      bound: true,
      unresolved: false,
      refs: { resources: ['git-sync:papercusp'] },
    });
  });

  it('fails closed for opaque SQL and dynamic entity arguments', async () => {
    await expect(deriveRecipeAuthority(`await tools.dev.pg_query({ sql: 'SELECT 1' });`)).resolves.toMatchObject({
      unresolved: true,
    });
    await expect(deriveRecipeAuthority(`await tools.workItems.get({ id: runtimeId });`)).resolves.toMatchObject({
      unresolved: true,
    });
  });

  it('fails closed for a caller-owned goal reference held in a variable', async () => {
    const script = `
      const gid = 'work-on-everything-fresh-grading-and-improvement-60d3a8';
      await tools.goals.get({ id: gid });
      await tools.search.fulltext({ query: 'goal_budget_unmeasurable respawner launch refused safety cap' });
    `;
    await expect(deriveRecipeAuthority(script)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: { kind: 'volatile-goal-reference', tool: 'goals.get' },
    });
  });

  it('fails closed for volatile coordination sender and cursor arguments', async () => {
    const coordinationScript = `return await tools.coord.inbox({
      from: 'su-stale-leader',
      since_ts: '2026-07-10T16:05:00.000Z',
    });`;
    await expect(deriveRecipeAuthority(coordinationScript)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: {
        kind: 'volatile-coordination-args',
        tool: 'coord.inbox',
        keys: ['from', 'since_ts'],
      },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script: coordinationScript,
      updatedAt: '2026-08-12T00:00:00.000Z',
      context: { harness: 'papercusp' },
    })).resolves.toBeNull();
    await expect(validateRecipeAuthorityProof({
      script: coordinationScript,
      updatedAt: '2026-08-12T00:00:00.000Z',
    })).resolves.toMatchObject({
      ok: false,
      error: 'authority_unresolved',
      reason: expect.stringContaining('volatile coordination sender/cursor'),
    });
  });

  it('fails closed for literal coordination owner ids', async () => {
    const staleOwnerScript = `
      const rr = await tools.coord.presence({ scope: 'workspace', include_detail: true });
      const owners = new Set([
        'su-b0dec57d-3d81-44ee-8c8b-5a5ffaa4cae3',
        'su-a79eb6a4-c513-4c40-8641-c2255811d326',
      ]);
      return (rr?.active || []).filter((row) => owners.has(row.ownerId));
    `;
    expect(findVolatileCoordinationOwnerId(staleOwnerScript)).toBe('su-b0dec57d-3d81-44ee-8c8b-5a5ffaa4cae3');
    await expect(deriveRecipeAuthority(staleOwnerScript)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: {
        kind: 'volatile-coordination-owner-id',
        ownerId: 'su-b0dec57d-3d81-44ee-8c8b-5a5ffaa4cae3',
      },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script: staleOwnerScript,
      updatedAt: '2026-08-21T11:26:33.000Z',
      context: { harness: 'papercusp' },
    })).resolves.toBeNull();
    await expect(validateRecipeAuthorityProof({
      script: staleOwnerScript,
      updatedAt: '2026-08-21T11:26:33.000Z',
    })).resolves.toMatchObject({
      ok: false,
      error: 'authority_unresolved',
      reason: expect.stringContaining('concrete agent owner id'),
    });

    // Dynamic owner resolution is the reusable shape: the recipe contains no
    // stale identity for the authority analyzer to freeze.
    const liveOwnerScript = `
      const rr = await tools.coord.presence({ scope: 'workspace', include_detail: true });
      const owners = new Set((await tools.coord.presence({ scope: 'workspace' })).active.map((row) => row.ownerId));
      return (rr?.active || []).filter((row) => owners.has(row.ownerId));
    `;
    expect(findVolatileCoordinationOwnerId(liveOwnerScript)).toBeNull();
    await expect(deriveRecipeAuthority(liveOwnerScript)).resolves.toMatchObject({ unresolved: false });
  });

  it('fails closed for short coordination owner selectors used by coord:send', async () => {
    // The live recipe that exposed this defect froze the short owner label rather
    // than a UUID: coord:send accepts this selector, but it still names one
    // session and can target the wrong/dead lane after a respawn or rotation.
    const shortOwnerScript = `
      await tools.coord.send({ to: ['su-f765ba8b'], wake: 'required' });
      await tools.improvements.capture({ kind: 'bug', title: 'leader-brief bug' });
    `;
    expect(findVolatileCoordinationOwnerId(shortOwnerScript)).toBe('su-f765ba8b');
    await expect(deriveRecipeAuthority(shortOwnerScript)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: {
        kind: 'volatile-coordination-owner-id',
        ownerId: 'su-f765ba8b',
      },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script: shortOwnerScript,
      updatedAt: '2026-08-22T00:00:00.000Z',
      context: { harness: 'papercusp' },
    })).resolves.toBeNull();
    await expect(validateRecipeAuthorityProof({
      script: shortOwnerScript,
      updatedAt: '2026-08-22T00:00:00.000Z',
    })).resolves.toMatchObject({
      ok: false,
      error: 'authority_unresolved',
      reason: expect.stringContaining('concrete agent owner id'),
    });
  });

  it('fails closed for rotating system git-sync process owners', async () => {
    const fullOwnerId = 'system:git-sync:3534749:60afb6c3-6aab-4d66-a071-850064d2a0f3';
    const shortRunOwnerId = 'system:git-sync:36733:fa04ed74';
    const staleOwnerScript = 'await tools.locks.queue({ owner: ' + JSON.stringify(fullOwnerId) + ' });';

    expect(findVolatileCoordinationOwnerId(staleOwnerScript)).toBe(fullOwnerId);
    expect(findVolatileCoordinationOwnerId(
      "const encoded = '%22system%3Agit-sync%3A36733%3Afa04ed74%22';",
    )).toBe(shortRunOwnerId);
    expect(findVolatileCoordinationOwnerId("const resource = 'git-sync:papercusp';")).toBeNull();
    await expect(deriveRecipeAuthority(staleOwnerScript)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: {
        kind: 'volatile-coordination-owner-id',
        ownerId: fullOwnerId,
      },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script: staleOwnerScript,
      updatedAt: '2026-08-22T00:00:00.000Z',
      context: { harness: 'papercusp' },
    })).resolves.toBeNull();
  });

  it('fails closed when a coordination owner id is inside a URI-encoded condition key', async () => {
    const encodedConditionKeyScript = `
      const key = 'alarm:codex-rollout-provider:%5B%22papercusp-workspace%22%2C%2240336%22%2C%22su-e5f812b6-2f01-4cb8-8d23-3299e65fc494%22%5D';
      return await tools.coord.conditions({ include_resolved: false });
    `;

    expect(findVolatileCoordinationOwnerId(encodedConditionKeyScript)).toBe(
      'su-e5f812b6-2f01-4cb8-8d23-3299e65fc494',
    );
    await expect(deriveRecipeAuthority(encodedConditionKeyScript)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: {
        kind: 'volatile-coordination-owner-id',
        ownerId: 'su-e5f812b6-2f01-4cb8-8d23-3299e65fc494',
      },
    });

    const verdict = await validateRecipeAuthorityProof({
      script: encodedConditionKeyScript,
      updatedAt: '2026-10-14T00:00:00.000Z',
    });
    expect(verdict).toMatchObject({ ok: false, error: 'authority_unresolved' });
    expect((verdict as { reason: string }).reason).toContain('concrete agent owner id');
  });

  // EI-20480226881133232 — the recurrence guard. The real `distill-exact-active-checkpoint-log`
  // recipe froze ONE gate run's /tmp log into a `const`, then reported that dead run's terminal
  // red as the LIVE gate's verdict (11 runs, misclassifying an in-flight candidate). The literal
  // never reaches `capability:read` as a static ARG, so call inspection cannot see it.
  it('fails closed for a pinned run-scoped ephemeral artifact path', async () => {
    const frozenLogScript = `const path = '/tmp/papercup-green-checkpoint-manual-1fxzuva-2026-08-13T13-14-14-693Z.log';
      const r = await tools.capability.read({ file_path: path, tail: 500 });
      return { path, finalLine: r };`;
    await expect(deriveRecipeAuthority(frozenLogScript)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: {
        kind: 'volatile-run-artifact-path',
        path: '/tmp/papercup-green-checkpoint-manual-1fxzuva-2026-08-13T13-14-14-693Z.log',
      },
    });
    // …so it is neither recommended for reuse…
    await expect(buildRecipeAuthorityRecommendation({
      script: frozenLogScript,
      updatedAt: '2026-08-15T00:00:00.000Z',
      context: { harness: 'papercusp' },
    })).resolves.toBeNull();
    // …nor runnable through recipes:run, and the refusal says how to re-author it.
    const verdict = await validateRecipeAuthorityProof({
      script: frozenLogScript,
      updatedAt: '2026-08-15T00:00:00.000Z',
    });
    expect(verdict).toMatchObject({ ok: false, error: 'authority_unresolved' });
    expect((verdict as { reason: string }).reason).toContain('live authority');
  });

  it('flags the pinned-artifact literal in either quoting style, and only when run-scoped', () => {
    // epoch-ms / pid stamp, and the inline-argument form
    expect(
      findVolatileRunArtifactLiteral(`await tools.capability.read({ file_path: "/tmp/run-1786896331.log" });`),
    ).toBe('/tmp/run-1786896331.log');
    for (const path of [
      '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      '/tmp/papercusp-capability/scratch/bash-8d7857db-c59.log',
      '/home/jdoe/.papercusp/checkpoint-logs/2026-08-12T19-34-01-974Z-base-8779b1c7f288-cand-53f4676ffa37.log',
      '/home/jdoe/.papercusp/checkpoint-logs/2026-08-21T00-03-33-331Z-base-a2d69cef50d5-cand-1bbf7e4fe81c.log',
    ]) {
      expect(findVolatileRunArtifactLiteral(`const p = '${path}';`)).toBe(path);
    }
    // A runtime-resolved active log is safe: the path is not frozen into the recipe.
    expect(findVolatileRunArtifactLiteral(`
      const currentLog = await resolveCurrentCheckpointLog();
      return await tools.capability.read({ file_path: currentLog });
    `)).toBeNull();
    // A manual unit name without a unit suffix is not enough to identify one run.
    expect(findVolatileRunArtifactLiteral(`const p = '/tmp/papercup-green-checkpoint-manual.log';`)).toBeNull();
    // a stable temp path is NOT run-scoped — reusable, must stay recommendable
    expect(findVolatileRunArtifactLiteral(`const p = '/tmp/papercup-green-checkpoint.log';`)).toBeNull();
    // a path DERIVED at runtime is the correct shape and must not be flagged
    expect(findVolatileRunArtifactLiteral('const p = `/tmp/gate-${runId}-${stamp}.log`;')).toBeNull();
    expect(findVolatileRunArtifactLiteral('const p = `/tmp/papercusp-capability/scratch/bash-${bashId}.log`;')).toBeNull();
    // non-ephemeral roots are addresses, not artifacts
    expect(findVolatileRunArtifactLiteral(`const p = 'docs/plans/my-plan-2026-08-13.md';`)).toBeNull();
  });

  it('fails closed for hardcoded generated task-manager ids, including hoisted loop values', async () => {
    const taskId = '0mt94bcnx1pyngto1k9';
    const script = `const ids = ['${taskId}', '0mt94elo6mf01p51y0c', '0mt94tjz61wif8wb1kn'];
      const out = [];
      for (const id of ids) {
        const p = await tools.processes.list({ rootTaskId: id, includeEnded: true, live: true, limit: 20 });
        out.push(p.tasks?.[0] ?? null);
      }
      return out;`;

    expect(findVolatileTaskIdLiteral(script)).toBe(taskId);
    await expect(deriveRecipeAuthority(script)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: { kind: 'volatile-task-id', taskId },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script,
      updatedAt: '2026-09-08T00:00:00.000Z',
      context: { harness: 'papercusp' },
    })).resolves.toBeNull();

    const verdict = await validateRecipeAuthorityProof({
      script,
      updatedAt: '2026-09-08T00:00:00.000Z',
    });
    expect(verdict).toMatchObject({ ok: false, error: 'authority_unresolved' });
    expect((verdict as { reason: string }).reason).toContain('task-manager id');
    expect((verdict as { reason: string }).reason).toContain('runtime binding');
  });

  it('keeps runtime-resolved and binding-supplied task handles reusable', async () => {
    const runtimeResolvedScript = `const live = await tools.processes.list({ live: true });
      const ids = (live.tasks || []).map((task) => task.taskId);
      return await Promise.all(ids.map((taskId) => tools.processes.list({ rootTaskId: taskId })));`;
    expect(findVolatileTaskIdLiteral(runtimeResolvedScript)).toBeNull();
    await expect(deriveRecipeAuthority(runtimeResolvedScript)).resolves.toMatchObject({ unresolved: false });

    const bindingScript = `const taskId = inputs.taskId;
      return await tools.processes.list({ rootTaskId: taskId });`;
    expect(findVolatileTaskIdLiteral(bindingScript)).toBeNull();
    await expect(deriveRecipeAuthority(bindingScript)).resolves.toMatchObject({ unresolved: false });
  });

  it('does not classify arbitrary literals as generated task ids', () => {
    expect(findVolatileTaskIdLiteral(`const word = 'abcdefghijklmnopqrs';`)).toBeNull();
    expect(findVolatileTaskIdLiteral(`const digits = '0123456789012345678';`)).toBeNull();
    expect(findVolatileTaskIdLiteral('const id = `${currentTaskId}`;')).toBeNull();
  });

  it('fails closed for a hardcoded native session UUID in a session id slot', async () => {
    const sessionId = '01a046b1-3b6c-7013-baeb-b1e0a260b785';
    const script = `const sessionId = '${sessionId}';
      return await tools.activity.toolLog({ session_id: sessionId });`;

    expect(findVolatileSessionIdLiteral(script)).toBe(sessionId);
    expect(findVolatileSessionIdLiteral("return await tools.activity.toolLog({ session_id: 'claude:ca072a58-85aa-47ae-9b99-1c91675822cf' });"))
      .toBe('claude:ca072a58-85aa-47ae-9b99-1c91675822cf');
    await expect(deriveRecipeAuthority(script)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: { kind: 'volatile-session-id-literal', sessionId },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script,
      updatedAt: '2026-09-08T00:00:00.000Z',
      context: { harness: 'papercusp' },
    })).resolves.toBeNull();

    const verdict = await validateRecipeAuthorityProof({ script, updatedAt: '2026-09-08T00:00:00.000Z' });
    expect(verdict).toMatchObject({ ok: false, error: 'authority_unresolved' });
    expect((verdict as { reason: string }).reason).toContain('native session id');
  });

  it('keeps runtime or binding supplied session ids reusable and ignores unrelated UUIDs', async () => {
    const sessionId = '01a046b1-3b6c-7013-baeb-b1e0a260b785';
    const runtimeScript = `const sessionId = inputs.sessionId;
      return await tools.activity.toolLog({ session_id: sessionId });`;
    expect(findVolatileSessionIdLiteral(runtimeScript)).toBeNull();
    await expect(deriveRecipeAuthority(runtimeScript)).resolves.toMatchObject({ unresolved: false });

    expect(findVolatileSessionIdLiteral(`const planId = '${sessionId}';`)).toBeNull();
    expect(findVolatileSessionIdLiteral(`const id = '${sessionId}';`)).toBeNull();
  });

  it('fails closed for a pinned capability:bash scratch log without rejecting runtime-derived paths', async () => {
    const path = '/tmp/papercusp-capability/scratch/bash-8d7857db-c59.log';
    const frozenLogScript = `const path = '${path}';
      const r = await tools.capability.read({ file_path: path, tail: 500 });
      return { path, finalLine: r };`;
    await expect(deriveRecipeAuthority(frozenLogScript)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: { kind: 'volatile-run-artifact-path', path },
    });

    const runtimeResolvedScript = 'const path = `/tmp/papercusp-capability/scratch/bash-${bashId}.log`;';
    await expect(deriveRecipeAuthority(runtimeResolvedScript)).resolves.toMatchObject({
      unresolved: false,
    });
  });

  it('keeps a live-resolved checkpoint-log recipe recommendable (the calibration case)', async () => {
    // The corrected shape the refusal asks for: resolve the path from live authority,
    // never pin it. This MUST stay recommendable or the guard is over-broad.
    const liveScript = `const pos = await tools.dev.pipelinePosition({ path: 'packages/operator-core/lib/x.ts' });
      const logPath = pos.gate?.logPath;
      return await tools.capability.read({ file_path: logPath, tail: 200 });`;
    await expect(deriveRecipeAuthority(liveScript)).resolves.toMatchObject({ unresolved: false });
    await expect(buildRecipeAuthorityRecommendation({
      script: liveScript,
      updatedAt: '2026-08-15T00:00:00.000Z',
      context: { harness: 'papercusp' },
    })).resolves.not.toBeNull();
  });

  it('fails closed for caller-scoped loop checkpoint state', async () => {
    const checkpointScript = `return await tools.loop.checkpoint({
      did: 'historical fleet work',
      left: 'historical next step',
      insight: 'historical conclusion',
      next: 'historical wake action',
    });`;
    await expect(deriveRecipeAuthority(checkpointScript)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: {
        kind: 'volatile-session-state',
        tool: 'loop.checkpoint',
      },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script: checkpointScript,
      updatedAt: '2026-08-12T00:00:00.000Z',
      context: { fleet: 'current-fleet', harness: 'papercusp' },
    })).resolves.toBeNull();
    await expect(validateRecipeAuthorityProof({
      script: checkpointScript,
      updatedAt: '2026-08-12T00:00:00.000Z',
    })).resolves.toMatchObject({
      ok: false,
      error: 'authority_unresolved',
      reason: expect.stringContaining('caller-scoped session carry state'),
    });
  });

  it.each([
    [
      'loop.arm',
      `await tools.events.await({ event: 'release:green:papercusp' });
       return await tools.loop.arm({ intervalSec: 300, goal: 'db-performance-remediation' });`,
    ],
    ['loop.end', `return await tools.loop.end({});`],
  ])('fails closed for caller-scoped %s state', async (tool, script) => {
    await expect(deriveRecipeAuthority(script)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: { kind: 'volatile-session-state', tool },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script,
      updatedAt: '2026-08-26T00:00:00.000Z',
      context: { fleet: 'current-fleet', harness: 'papercusp' },
    })).resolves.toBeNull();
    await expect(validateRecipeAuthorityProof({
      script,
      updatedAt: '2026-08-26T00:00:00.000Z',
    })).resolves.toMatchObject({
      ok: false,
      error: 'authority_unresolved',
      reason: expect.stringContaining('caller-scoped'),
    });
  });

  it('revalidates the stored revision and live entity identity at run time', async () => {
    const updatedAt = '2026-07-13T12:00:00.000Z';
    const proof = {
      version: 1 as const,
      revision: recipeRevision(script, updatedAt),
      context: { plan: 'release-plan', harness: 'papercusp', items: ['WI-4655'], resources: ['windows-vm'] },
    };
    await expect(validateRecipeAuthorityProof({ script, updatedAt, proof, liveContext: { harness: 'papercusp' } }))
      .resolves.toMatchObject({ ok: true });
    await expect(validateRecipeAuthorityProof({ script: `${script}\n// changed`, updatedAt, proof }))
      .resolves.toMatchObject({ ok: false, error: 'authority_stale_revision' });
    await expect(validateRecipeAuthorityProof({ script, updatedAt, proof, liveContext: { harness: 'other' } }))
      .resolves.toMatchObject({ ok: false, error: 'authority_entity_mismatch' });

    const descriptor = await deriveRecipeAuthority(script);
    expect(recipeAuthorityMatchesLiveRefs(descriptor, {
      plans: ['release-plan'],
      items: ['WI-4655'],
      resources: ['windows-vm'],
    })).toBe(true);
    expect(recipeAuthorityMatchesLiveRefs(descriptor, {
      plans: ['release-plan'],
      items: ['WI-4655'],
      resources: ['another-vm'],
    })).toBe(false);
  });

  it('does not accept a caller-carried fleet when no matching live fleet exists', async () => {
    const fleetScript = `return await tools.fleet.status({ fleet: 'release-fleet' });`;
    const updatedAt = '2026-07-13T12:00:00.000Z';
    const proof = {
      version: 1 as const,
      revision: recipeRevision(fleetScript, updatedAt),
      context: { fleet: 'release-fleet' },
    };
    await expect(validateRecipeAuthorityProof({ script: fleetScript, updatedAt, proof }))
      .resolves.toMatchObject({ ok: true });
    await expect(validateRecipeAuthorityProof({
      script: fleetScript,
      updatedAt,
      proof,
      liveContext: {},
    })).resolves.toMatchObject({ ok: false, error: 'authority_entity_mismatch' });
  });

  it('collects authority from heterogeneous items rows', async () => {
    const descriptor = await deriveRecipeAuthority(`
      return await tools.plans.setStatus({
        items: [{ slug: 'release-plan', itemId: 'P-008', harness: 'papercusp' }]
      });
    `);
    expect(descriptor.refs).toMatchObject({
      plans: ['release-plan'],
      items: ['P-008'],
      harnesses: ['papercusp'],
    });
  });

  it('captures a coord:orient planItems plan-lane claim as an item authority ref (EI-12213)', async () => {
    // A "monitor" recipe whose script claims a plan lane via coord:orient({ planSlug, planItems })
    // must record BOTH the plan AND the item so the recommendation filter requires the caller to
    // already hold that exact lane. Before this fix `planItems` was not in collectArgs' item-key
    // set, so only the plan ref was captured — and the recipe was recommended to any caller on the
    // plan (regardless of item), so running it re-declared their lane and claimed another agent's
    // item (the "surfaced a monitor recipe that would claim another plan lane" bug).
    const claimScript = `
      return await tools.coord.orient({
        intent: 'Monitor release readiness',
        mode: 'monitor',
        planSlug: 'blender-public-release-readiness-drive-2026-07-14',
        planItems: ['P-006'],
      });
    `;
    const descriptor = await deriveRecipeAuthority(claimScript);
    expect(descriptor.refs).toMatchObject({
      plans: ['blender-public-release-readiness-drive-2026-07-14'],
      items: ['P-006'],
    });

    // A caller ON the plan but NOT already holding P-006 must NOT get the recipe recommended —
    // the item-lane ref is now part of the authority contract, closing the lane-theft gap.
    await expect(buildRecipeAuthorityRecommendation({
      script: claimScript,
      updatedAt: '2026-07-14T12:00:00.000Z',
      context: { plan: 'blender-public-release-readiness-drive-2026-07-14', items: ['P-010'] },
    })).resolves.toBeNull();

    // A caller already declaring P-006 as their own lane may reuse it (re-declaring is a no-op).
    await expect(buildRecipeAuthorityRecommendation({
      script: claimScript,
      updatedAt: '2026-07-14T12:00:00.000Z',
      context: { plan: 'blender-public-release-readiness-drive-2026-07-14', items: ['P-006'] },
    })).resolves.toMatchObject({ proof: { version: 1 }, refs: { items: ['P-006'] } });
  });

  it('captures positional work-item claim rows and rejects fixed assignees (EI-20238127178875631)', async () => {
    const rowScript = `return await tools.workItems.claim({ row: 'WI-38077,,papercusp' });`;
    const descriptor = await deriveRecipeAuthority(rowScript);
    expect(descriptor).toMatchObject({
      bound: true,
      unresolved: false,
      refs: { items: ['WI-38077'], harnesses: ['papercusp'] },
    });

    await expect(buildRecipeAuthorityRecommendation({
      script: rowScript,
      updatedAt: '2026-08-12T09:00:00.000Z',
      context: { harness: 'papercusp', items: ['WI-38078'] },
    })).resolves.toBeNull();

    const fixedAssigneeScript = `return await tools.workItems.claim({ row: 'WI-38077,su-497dd000-243c-41f3-8cd4-c44756c81694,papercusp' });`;
    await expect(deriveRecipeAuthority(fixedAssigneeScript)).resolves.toMatchObject({
      refs: { items: ['WI-38077'], harnesses: ['papercusp'] },
      unresolved: true,
      unresolvedCause: { kind: 'fixed-claim-assignee', tool: 'workItems.claim' },
    });
    await expect(buildRecipeAuthorityRecommendation({
      script: fixedAssigneeScript,
      updatedAt: '2026-08-12T09:00:00.000Z',
      context: { harness: 'papercusp', items: ['WI-38077'] },
    })).resolves.toBeNull();
  });

  it('allows truly generic recipes without an authority proof', async () => {
    await expect(validateRecipeAuthorityProof({
      script: `return await tools.gateway.status({});`,
      updatedAt: '2026-07-13T12:00:00.000Z',
    })).resolves.toMatchObject({ ok: true, descriptor: { bound: false } });
  });

  // EI-20186804943808838 / EI-12692: `http-projection` sets `ctx.harnessSlug = '*'` for EVERY
  // superuser/operator-scope call (the documented HARNESS_ALL sentinel — see
  // agent-tools/_harness-scope.ts). Both recipes:search and recipes:run thread that ctx value
  // straight into the authority context, where the scalar comparison was a strict `===`. So for
  // every su session — the population recipe reuse exists to serve — a recipe binding a concrete
  // harness was UNREACHABLE, in a way no caller could repair: search refused to issue a proof
  // (buildRecipeAuthorityRecommendation returned null) and run rejected on the LIVE context, which
  // is server-derived and therefore immune to any proof the caller supplies. Filed twice, a month
  // apart, against the same recipe.
  describe('operator-scope wildcard harness (EI-20186804943808838)', () => {
    const harnessScript = `return await tools.scheduler.getNext({ harness: 'papercusp' });`;
    const updatedAt = '2026-07-10T16:14:16.826Z';

    it('lets an operator-scope session run a harness-bound recipe end to end', async () => {
      // The exact broken flow: search issues the proof, run validates it against the live ctx.
      const recommendation = await buildRecipeAuthorityRecommendation({
        script: harnessScript,
        updatedAt,
        context: { workspace: 'papercusp-workspace', harness: '*' },
      });
      expect(recommendation).not.toBeNull();

      await expect(validateRecipeAuthorityProof({
        script: harnessScript,
        updatedAt,
        proof: recommendation!.proof,
        liveContext: { workspace: 'papercusp-workspace', harness: '*' },
      })).resolves.toMatchObject({ ok: true });
    });

    it('accepts the friendly `all` spelling of the same sentinel', async () => {
      const recommendation = await buildRecipeAuthorityRecommendation({
        script: harnessScript,
        updatedAt,
        context: { harness: 'all' },
      });
      expect(recommendation).not.toBeNull();
    });

    // CONTROLS — the wildcard must not become a skeleton key. Each of these asserts the
    // widening stopped exactly where it was supposed to.
    it('still rejects a CALLER-CARRIED proof that claims wildcard scope', async () => {
      // The live context is server-derived and trustworthy; the proof is not. A caller who
      // hand-builds `harness:'*'` must not thereby authorize a concrete-harness recipe.
      await expect(validateRecipeAuthorityProof({
        script: harnessScript,
        updatedAt,
        proof: { version: 1, revision: recipeRevision(harnessScript, updatedAt), context: { harness: '*' } },
        liveContext: { harness: 'papercusp' },
      })).resolves.toMatchObject({ ok: false, error: 'authority_entity_mismatch' });
    });

    it('still rejects a live session scoped to a DIFFERENT concrete harness', async () => {
      await expect(validateRecipeAuthorityProof({
        script: harnessScript,
        updatedAt,
        proof: { version: 1, revision: recipeRevision(harnessScript, updatedAt), context: { harness: 'papercusp' } },
        liveContext: { harness: 'some-other-harness' },
      })).resolves.toMatchObject({ ok: false, error: 'authority_entity_mismatch' });
    });

    // CALIBRATION. The two controls above assert a REJECTION, and a rejection also happens
    // when nothing is wired up at all — so on their own they could pass vacuously. This pins
    // that the strict/loose distinction is real and load-bearing: the very same descriptor and
    // wildcard context that the strict comparison REJECTS is ACCEPTED once operator scope is
    // opted into. If a future edit passes `operatorScope: true` at the caller-carried proof
    // check, that is exactly the mutation this makes the controls above catch.
    it('separates strict from operator-scope matching (proves the controls are not vacuous)', async () => {
      const descriptor = await deriveRecipeAuthority(harnessScript);
      expect(recipeAuthorityMatches(descriptor, { harness: '*' })).toBe(false);
      expect(recipeAuthorityMatches(descriptor, { harness: '*' }, { operatorScope: true })).toBe(true);
      // ...and operator scope is not a blanket pass: a wrong concrete harness still fails.
      expect(recipeAuthorityMatches(descriptor, { harness: 'nope' }, { operatorScope: true })).toBe(false);
    });

    it('does NOT extend the wildcard to workspace — that is a tenant boundary', async () => {
      const wsScript = `return await tools.workItems.get({ id: 'WI-1', workspace: 'other-workspace' });`;
      const descriptor = await deriveRecipeAuthority(wsScript);
      expect(descriptor.refs.workspaces).toEqual(['other-workspace']);
      await expect(buildRecipeAuthorityRecommendation({
        script: wsScript,
        updatedAt,
        context: { workspace: '*' },
      })).resolves.toBeNull();
    });
  });

  // EI-12057: a recipe composing another recipe via `tools.recipes.run(...)` fails
  // with the SAME authority codes as a direct (non-nested) run of the inner recipe
  // — the failure is a property of the INNER script, not of nesting. Distinguishing
  // `reason` text lets a caller tell "permanent, run via code:run instead"
  // (authority_unresolved — opaque SQL/shell) apart from "get a proof first"
  // (authority_required — merely bound, not opaque).
  it('surfaces an actionable reason distinguishing permanent (opaque) from fixable (missing-proof) failures', async () => {
    const opaqueScript = `await tools.dev.pg_query({ sql: 'SELECT 1' });`;
    const opaqueResult = await validateRecipeAuthorityProof({
      script: opaqueScript,
      updatedAt: '2026-07-13T12:00:00.000Z',
    });
    expect(opaqueResult).toMatchObject({ ok: false, error: 'authority_unresolved' });
    if (!opaqueResult.ok) {
      expect(opaqueResult.reason).toMatch(/opaque\/unprovable/);
      expect(opaqueResult.reason).toMatch(/code:run/);
    }

    const boundScript = `await tools.workItems.get({ id: 'WI-4655', harness: 'papercusp' });`;
    const boundResult = await validateRecipeAuthorityProof({
      script: boundScript,
      updatedAt: '2026-07-13T12:00:00.000Z',
    });
    expect(boundResult).toMatchObject({ ok: false, error: 'authority_required' });
    if (!boundResult.ok) {
      expect(boundResult.reason).toMatch(/recipes:search/);
    }
  });

  // A recipe referencing a work-item is never dropped from bound refs by the
  // nesting-composition path — this pins the exact EI-12057 repro shape (a
  // work-item-bound script that ALSO calls the opaque dev:pg_query) to confirm
  // `unresolved` wins over `bound` (opaque always fails closed, regardless of
  // whether the script is otherwise entity-bound) and stays stable.
  it('EI-12057 repro shape: work-item-bound + opaque dev.pg_query stays permanently unresolved', async () => {
    const script = `
      await tools.work_items.get({ id: 'WI-4457', harness: 'papercusp', detail: true });
      await tools.dev.pg_query({ sql: 'SELECT 1', maxRows: 100 });
    `;
    const descriptor = await deriveRecipeAuthority(script);
    expect(descriptor.unresolved).toBe(true);
    expect(descriptor.bound).toBe(true);
    const result = await validateRecipeAuthorityProof({ script, updatedAt: '2026-07-13T12:00:00.000Z' });
    expect(result).toMatchObject({ ok: false, error: 'authority_unresolved' });
  });

  // EI-21163571260786543 — the recurrence guard. The real
  // `goal-mode-e2e-post-boundary-activity-rubric-authorship-histogram-for-subject`
  // recipe hardcoded ONE grading run's agent id (SUBJ) and time window into a
  // `sessions:timeline({ owner, since })` call. recipes:search recommended it
  // anyway, and the recommendation's authority proof carried the CURRENT
  // caller's own live subject/harness — so the search result looked "bound to
  // your own goal subject" when the script's real, hardcoded identity/window had
  // nothing to do with either. Two independent things were wrong here, and both
  // are pinned below: (1) THIS exact literal happens to be caught by
  // `findVolatileCoordinationOwnerId`'s su-id text scan, so it is already
  // `unresolved` and unrecommendable on its own; (2) the deeper, general defect —
  // `buildRecipeAuthorityRecommendation` echoed the CALLER's context into the
  // returned proof verbatim instead of deriving it from what the recipe's own
  // script actually references — meant a script whose frozen identity/window
  // ISN'T caught by any recognizer (e.g. a non-`su-`-shaped agent id) was
  // recommended with a proof that falsely claimed binding to the caller's own
  // resources/harness. Case (2) is the actual fix (recipe-authority.ts,
  // `buildRecipeAuthorityRecommendation`); case (1) is pinned so it can't regress.
  it('fails closed for a hardcoded su-id agent identity passed to a non-coord tool argument (EI-21163571260786543)', async () => {
    const histogramScript = `const SUBJ = 'su-6e9985dd-9a17-49b9-aaef-804852cd94d5';
const tl = await tools.sessions.timeline({ owner: SUBJ, since: '2026-08-09T09:40:00Z', limit: 300 });
const entries = tl.entries || [];
const toolRows = entries.filter(e => e.kind === 'tool' && !e.auto);
return { windowFrom: '2026-08-09T09:40:00Z', totalAgentToolCalls: toolRows.length };`;

    expect(findVolatileCoordinationOwnerId(histogramScript)).toBe('su-6e9985dd-9a17-49b9-aaef-804852cd94d5');
    await expect(deriveRecipeAuthority(histogramScript)).resolves.toMatchObject({
      unresolved: true,
      unresolvedCause: {
        kind: 'volatile-coordination-owner-id',
        ownerId: 'su-6e9985dd-9a17-49b9-aaef-804852cd94d5',
      },
    });

    // The exact reported shape: search is asked under a DIFFERENT caller whose own
    // live subject is su-9bf03ac3-... — the recipe must NOT be recommended just
    // because the caller's own context happens to be supplied alongside it.
    await expect(buildRecipeAuthorityRecommendation({
      script: histogramScript,
      updatedAt: '2026-08-09T14:12:07.701Z',
      context: { harness: 'papercusp', resources: ['su-9bf03ac3-0000-0000-0000-000000000000'] },
    })).resolves.toBeNull();

    // ...and recipes:run refuses it outright, so the stale runArgs from an older
    // (pre-fix) search response can never silently execute against the wrong agent.
    await expect(validateRecipeAuthorityProof({
      script: histogramScript,
      updatedAt: '2026-08-09T14:12:07.701Z',
    })).resolves.toMatchObject({
      ok: false,
      error: 'authority_unresolved',
      reason: expect.stringContaining('concrete agent owner id'),
    });
  });

  // The GENERAL case behind EI-21163571260786543: the exact same recipe shape,
  // except the frozen agent id does NOT happen to match the `su-` regex (e.g. a
  // different agent-kind prefix, or an opaque session id). No existing detector
  // — not the owner-id scan above, not the coord-only cursor/sender check (this
  // call's namespace is `sessions`, not `coord`) — can see this literal is
  // volatile, so the descriptor is (correctly, given today's detectors)
  // `unresolved: false, bound: false`. That is exactly the case
  // `buildRecipeAuthorityRecommendation` must treat as advertising NOTHING: its
  // returned proof must never manufacture a binding to the caller's own live
  // fleet/harness/items/resources just because the caller happened to supply
  // them. Before the fix this asserted a non-empty, caller-echoed `context`
  // (`{ harness: 'goal-mode-e2e', items: ['P-777'], resources: [...] }`) even
  // though the script references NONE of those.
  it('does not manufacture a caller-context proof for an unbound recipe with a non-catchable frozen identity (EI-21163571260786543)', async () => {
    const histogramScript = `const SUBJ = 'codex-6e9985dd';
const tl = await tools.sessions.timeline({ owner: SUBJ, since: '2026-08-09T09:40:00Z', limit: 300 });
return { windowFrom: '2026-08-09T09:40:00Z', totalAgentToolCalls: (tl.entries || []).length };`;

    const descriptor = await deriveRecipeAuthority(histogramScript);
    expect(descriptor).toMatchObject({ unresolved: false, bound: false });
    expect(descriptor.refs).toEqual({
      workspaces: [], fleets: [], plans: [], harnesses: [], items: [], resources: [],
    });

    const recommendation = await buildRecipeAuthorityRecommendation({
      script: histogramScript,
      updatedAt: '2026-08-09T14:12:07.701Z',
      // A caller's real search request always carries its own live fleet/harness,
      // and may pass its own items/resources too (e.g. "my current goal subject").
      // None of these are referenced by the script above.
      context: {
        fleet: 'goal-mode-e2e-fleet',
        harness: 'goal-mode-e2e',
        items: ['P-777'],
        resources: ['su-9bf03ac3-0000-0000-0000-000000000000'],
      },
    });
    // The recipe is genuinely context-free, so it is still recommended (a
    // truly generic script never needs a proof) — but the proof it carries
    // must say so, not fabricate a binding to the caller's own lane.
    expect(recommendation).not.toBeNull();
    expect(recommendation?.proof.context).toEqual({});
    expect(recommendation?.refs).toEqual(descriptor.refs);

    // The stored proof is also self-consistent: revalidating it (with NO live
    // context at all) still succeeds, exactly because it claims no binding.
    await expect(validateRecipeAuthorityProof({
      script: histogramScript,
      updatedAt: '2026-08-09T14:12:07.701Z',
      proof: recommendation!.proof,
    })).resolves.toMatchObject({ ok: true });
  });
});

describe('WI-40896 / D-048: refsMeasured separates an UNMEASURED authority set from an empty one', () => {
  const REV = 'a'.repeat(64);

  // The script whose identities can never be collected: `inspectCall` returns the
  // cause BEFORE collecting the dynamic call's args, so `refs` is a FLOOR, not a total.
  const dynamicScript = `await tools.tools.invoke({ name: chosenVerb, args: {} });`;
  // A script that genuinely touches no bound entity — refs are empty because there
  // is nothing to measure, which is the OPPOSITE situation with the SAME rendering.
  const contextFreeScript = `return 1 + 1;`;

  it('renders a dynamically-dispatched script as NOT measured, and names which construct fired', async () => {
    const descriptor = await deriveRecipeAuthority(dynamicScript);
    const metadata = toRecipeAuthorityMetadata(descriptor, REV);

    expect(metadata.refsMeasured).toBe(false);
    expect(metadata.unresolvedCause).toMatchObject({ kind: 'dynamic-dispatch-target' });
  });

  it('renders a genuinely context-free script as MEASURED, with no cause', async () => {
    const descriptor = await deriveRecipeAuthority(contextFreeScript);
    const metadata = toRecipeAuthorityMetadata(descriptor, REV);

    expect(metadata.refsMeasured).toBe(true);
    expect(metadata.unresolvedCause).toBeNull();
  });

  // THIS is the regression test that actually pins the bug. The two scripts above
  // are INDISTINGUISHABLE on every field recipes:get used to emit — identical empty
  // refs, identical requiresContext:false. A test asserting only "refs are empty"
  // would therefore pass both BEFORE and AFTER the fix and prove nothing. The
  // discrimination has to be asserted against a field that differs, which is the
  // whole reason `refsMeasured` exists.
  it('pins the defect: the two are identical on refs/requiresContext, so only refsMeasured tells them apart', async () => {
    const unmeasured = toRecipeAuthorityMetadata(await deriveRecipeAuthority(dynamicScript), REV);
    const genuinelyEmpty = toRecipeAuthorityMetadata(await deriveRecipeAuthority(contextFreeScript), REV);

    // Calibration: confirm the collision this field exists to break is real. If a
    // future analyzer change makes these differ on their own, this assertion fails
    // and tells you the premise moved — rather than the test quietly passing for a
    // new reason.
    expect(unmeasured.refs).toEqual(genuinelyEmpty.refs);
    expect(unmeasured.requiresContext).toBe(genuinelyEmpty.requiresContext);

    // The discrimination itself.
    expect(unmeasured.refsMeasured).not.toBe(genuinelyEmpty.refsMeasured);
  });

  // FALSIFIABILITY CONTROL (kept permanently, per the repo's tier-1 rule: prove the
  // guard CAN fail with a deliberately-wrong implementation in the test file, never
  // by mutating the shared tree). This models the PRE-FIX projection — the exact
  // shape recipes:get emitted before WI-40896 — and asserts it is blind to the
  // difference. If someone deletes `refsMeasured` from toRecipeAuthorityMetadata,
  // the real assertions above start failing; this control is what proves those
  // assertions were ever capable of failing at all.
  it('control: the pre-fix projection could not tell the two apart (so the tests above are falsifiable)', async () => {
    const preFixProjection = (descriptor: Awaited<ReturnType<typeof deriveRecipeAuthority>>) => ({
      version: 1 as const,
      revision: REV,
      refs: descriptor.refs,
      requiresContext: descriptor.bound,
      runnable: !descriptor.unresolved,
      // no refsMeasured, no unresolvedCause — this was the whole defect
    });

    const unmeasured = preFixProjection(await deriveRecipeAuthority(dynamicScript));
    const genuinelyEmpty = preFixProjection(await deriveRecipeAuthority(contextFreeScript));

    // Blind on the REFS-SCOPED fields — the ones a consumer of `refs` actually reads.
    // These are identical across two OPPOSITE situations, which is the defect.
    expect(unmeasured.refs).toEqual(genuinelyEmpty.refs);
    expect(unmeasured.requiresContext).toBe(genuinelyEmpty.requiresContext);

    // ...but NOT blind overall, and this suite refuses to overstate the bug: `runnable`
    // DID already differ. That is why the fix is a marker beside `refs` rather than a
    // new verdict field — pre-fix, the only signal lived on a field scoped to a
    // DIFFERENT question ("may I execute this?"), so reading it as a statement about
    // the completeness of `refs` meant borrowing an answer from an unrelated verdict.
    // `runnable` is co-extensive with `refsMeasured` TODAY; this asserts the
    // co-extension explicitly so that if the two ever diverge, a test says so.
    expect(unmeasured.runnable).not.toBe(genuinelyEmpty.runnable);
  });
});
