import { createHash } from 'node:crypto';
import type { PublishReportInput } from './report-library';

/** Preserve historical source bytes and caveats; backfill never upgrades an audit's verdict. */
export function makeReportBackfill(input: {
  workspaceId: string; sourcePath: string; sourceRef: string; bodyMd: string; diagramMd?: string;
}): PublishReportInput {
  if (!input.bodyMd.trim()) throw new Error('Refusing an empty historical report');
  const title = /^#\s+(.+)$/m.exec(input.bodyMd)?.[1]?.trim();
  if (!title) throw new Error('Historical report must have a title');
  const sourceSha256 = createHash('sha256').update(input.bodyMd).digest('hex');
  const bodyMd = input.bodyMd + (input.diagramMd ? `\n\n## Archived architecture diagram\n\n\`\`\`mermaid\n${input.diagramMd}\n\`\`\`\n` : '')
    + `\n\n## Backfill provenance\n\nSource: ${input.sourcePath}\n\nOriginal record: ${input.sourceRef}\n\nOriginal Markdown SHA-256: ${sourceSha256}\n`
    + '\nThis is an import of the historical report. Its original scope and limitations remain in force; no audit was rerun by this import.\n';
  return { workspaceId: input.workspaceId, title, bodyMd, kind: 'audit', visibility: 'owner', source: 'backfill',
    subject: { kind: 'external', ref: input.sourceRef }, tags: ['backfill', 'historical-audit'],
    requestKey: `backfill:${createHash('sha256').update(input.sourceRef).digest('hex')}` };
}
