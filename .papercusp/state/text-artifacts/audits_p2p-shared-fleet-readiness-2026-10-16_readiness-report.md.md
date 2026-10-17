---
rel_path: "audits/p2p-shared-fleet-readiness-2026-10-16/readiness-report.md"
updated_at: 1792164738015
_body: "content"
---

# P2P endgame and shared-fleet readiness — 16 October 2026

**Practical verdict:** cross-machine coordination is implemented and has passed real two-machine federation tests. The dedicated coordination plan is shipped. The complete P2P endgame is still on HOLD, and the available evidence does not justify promising that a newly created shared fleet on arbitrary installed machines will behave as reliably as a local fleet.

## Endgame status

The authoritative plan `p2p-public-release-endgame-2026-09-01` is revision 438, status ready, with no final release GO. Its six remaining items are P-401 (independent release GO), P-403 (driven-plan ship ceremonies), P-404 (portfolio closeout), P-502 (owner-freeze/recovery chaos), P-503 (post-GO disposition), and P-521 (integrated exact-artifact acceptance).

The most recent acceptance decision is D-250, preserved and narrowed by D-251/D-252. On 15 October, the D-249 candidate passed installation, installed-byte equality, offline egress enforcement, first launch and restart. It failed offline restore: the expected papercusp pot remained absent during the bounded observation. The authenticated installed-CLI phase was not reached. The root cause remains unproven. D-252, dated 16 October, explicitly retains the HOLD and requires a bounded distinguishing diagnosis on the preserved failed fixture; another unchanged full acceptance run is not authorized by that decision.

These facts establish an installer/bootstrap acceptance problem. They do not establish that the previously proven coordination transport is currently broken.

## What coordination evidence actually proves

The dedicated plan `p2p-coordination-public-release-2026-08-26` is shipped, updated 30 September, revision 102.

WI-42225 and the endgame mirror WI-2039871 store committed completion evidence for the tower ↔ Avis-iMac.local two-machine rig on pinned build #8, superproject e5516b47f81e. The recorded result is 17 passing probes across:
- CC-1..CC-5: handoff/escalation/message row federation and local-scope isolation.
- CR-1..CR-4: conversations, thread posts, directed reply linkage back to origin, and a trust negative.
- CD-0..CD-7: a real offline window, catch-up, retained prior data, duplicate suppression, resumed federation, member restart durability and a join-storm guard.

I read the maintained scenario writers. These probes primarily create and inspect coordination records across machines. They are stronger than same-process mocks, but are not a fresh demonstration of two actual agent CLIs discovering one another, being woken, replying and completing a handoff in a newly created shared fleet.

The coordination signoff also retained an amber observability residual (D-031/D-035; WI-2141796 remains open). Its historical outage was reported recovered; the old checkpoint is stale. This review does not claim a present outage or a verified current detector fix.

## Shared fleets inside shared pots

The intended mechanism exists:
- Remote session presence carries real agent owner IDs, so remote agents can be addressed through the existing coordination surface.
- Session-presence gossip stores fleet membership and role. The fleet audience resolver unions local and federated members; this is more than a local fleet label.
- Shared-pot scope is required for federation. Local/unscoped messages intentionally remain local; ambiguous multi-pot scope must be explicitly resolved.
- Remote capacity is governed through delegated seat offers and `fleet:request_remote_spawn`; creating a fleet alone does not launch remote agents or grant use of another machine.

The endgame's P-202 records a successful physical two-host offer → pull → spawn → complete → meter drill on build 587f459be598. That cited run passed its Claude-seat cases and refused the Codex-seat case as agent_runtime_missing. This is historical, build-specific evidence, not a current claim that every agent runtime is installed or works remotely.

## What Avi can reasonably expect today

The coordination capability is real and the shared-fleet architecture is present. However, I would treat a newly created cross-machine fleet as a controlled trial until its exact installed machines/builds demonstrate:
1. Both members joined to the same shared pot with the intended permissions and shared-fleet membership.
2. Remote agent discovery, a directed message and actual recipient turn pickup.
3. A reply returning to origin and one real work handoff with visible completion.
4. Healthy reconnect/catch-up behavior for that pair.

This assessment did not start a fleet, send test messages, operate a rig, restart a service or re-run acceptance. It answers readiness from current canonical records and maintained source. No claim of present machine-specific end-to-end parity is made.

## Evidence references

- Endgame plan revision 438: P-201, P-202, P-401/P-403/P-404/P-502/P-503/P-521; D-250 and D-252.
- Coordination plan revision 102: Requirements, D-031, D-035; shipped status.
- WI-42225 and WI-2039871: committed two-machine coordination witness.
- WI-6554700010013276: current endgame driver checkpoint, with explicitly stale dependencies treated as historical context.
- WI-2141796: open observability residual, not a declaration of an ongoing outage.
- `papercusp-desktop/bin/lib/scenario-coord-control-plane.sh`, `scenario-coord-p008-remainder.sh`, `scenario-coord-p008-custody.sh`.
- `packages/operator-core/lib/agent-tools/coordination/federation-scope.ts`, `federated-presence.ts`, `audience-host.ts`; `packages/operator-core/lib/sync/hyperbee/session-presence-store.ts`.
- Durable source snapshots: `papercusp:audits/p2p-shared-fleet-readiness-2026-10-16/endgame-plan.json` and `coordination-plan.json`.

Assessment work-item: WI-6554700010016245.

