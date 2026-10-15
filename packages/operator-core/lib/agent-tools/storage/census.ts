/**
 * storage:census — what is filling each watched disk, and what grew in the last 24h
 * (disk-headroom-standing-reclaim-2026-10-12 P-001, R-1). Read-only view over the
 * census the scheduled `diskConsumerCensus` workflow writes every 6h
 * (storage/disk-consumer-census.ts). storage:usage stays the per-CATEGORY view of
 * Papercusp's own stores; this is the per-DEVICE view of everything on the disk.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'storage:census',
  profile: 'engineer',
  description:
    'What is filling each watched disk (/ and /mnt/data here): every directory ≥1 GiB to depth 6, large files, Postgres and Docker, plus unattributed bytes, each with its size and 24h growth. From the 6-hourly census; flags stale, missing and coverage-gap devices. Read-only.',
  capability: 'storage:read',
  guidance: {
    when: 'Finding what is using or growing on a disk before reclaiming space, or checking a disk alarm’s cause.',
    notWhen: 'Sizes of Papercusp’s own stores by category: storage:usage. Deleting: storage:prune.',
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z
    .object({
      device: z.string().optional().describe('Mount point, e.g. "/" or "/mnt/data"; omit for every watched device.'),
      orderBy: z.enum(['bytes', 'growth']).optional().describe('bytes (default) = largest first; growth = fastest-growing first.'),
      limit: z.number().int().min(1).max(500).optional().describe('Consumers per device (default 30).'),
      receiptId: z.string().uuid().optional().describe('Read this reclaim receipt; omitted returns the latest real pass.'),
    })
    .optional(),
  async handler(args) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { readReclaimReceipt, reclaimReceiptHref } = await import('../../storage/disk-reclaim');
    if (args?.receiptId) {
      const receipt = await readReclaimReceipt(getOrgPg().sql, activeWorkspaceId(), args.receiptId);
      return { data: { ok: true, receipt, receiptHref: receipt ? reclaimReceiptHref(receipt.id) : null } };
    }
    const { readDiskConsumerCensus, resolveCensusDevices } = await import('../../storage/disk-consumer-census');
    const expectedDevices = await resolveCensusDevices()
      .then((ds) => ds.map((d) => d.device))
      .catch(() => undefined);
    const census = await readDiskConsumerCensus(getOrgPg().sql as never, {
      device: args?.device,
      orderBy: args?.orderBy,
      limit: args?.limit,
      expectedDevices,
    });
    const receipt = await readReclaimReceipt(getOrgPg().sql, activeWorkspaceId(), args?.receiptId);
    return { data: { ok: true, ...census, receipt, receiptHref: receipt ? reclaimReceiptHref(receipt.id) : null } };
  },
});
