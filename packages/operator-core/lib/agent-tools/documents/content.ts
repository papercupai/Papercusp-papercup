import { z } from 'zod';
import { CONTENT_LIMITS, ContentIntakeError, readContent, type ContentInput } from '../../content-intake';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

const source = {
  ref: z.string().min(1).max(2000).optional(),
  title: z.string().max(500).optional(),
  partial: z.boolean().optional(),
};
/** Provided bytes only. Source fetch/read stays in existing authorized reader tools. */
const providedSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['text', 'selection']), text: z.string().min(1).max(CONTENT_LIMITS.maxInputBytes), ...source }),
  z.object({ kind: z.literal('html'), html: z.string().min(1).max(CONTENT_LIMITS.maxInputBytes), ...source }),
  z.object({ kind: z.literal('pdf'), base64: z.string().min(4).max(Math.ceil(CONTENT_LIMITS.maxInputBytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), ...source }),
]);
export const providedContentSchema = z.union([
  providedSourceSchema,
  z.object({ kind: z.literal('collection'), sources: z.array(providedSourceSchema).min(1).max(20), ...source }),
]);

/**
 * Decode a validated provided-content payload into the intake's ContentInput:
 * base64 PDFs become bytes, at the top level AND inside a collection. The one
 * decoder every provided-content surface uses (tool + operator-tts route), so a
 * new schema variant cannot be decoded in one place and forgotten in another.
 */
export function decodeProvidedContent(supplied: z.infer<typeof providedContentSchema>): ContentInput {
  const decode = (member: z.infer<typeof providedSourceSchema>) => member.kind === 'pdf'
    ? { kind: 'pdf' as const, bytes: new Uint8Array(Buffer.from(member.base64, 'base64')), ref: member.ref, title: member.title, partial: member.partial }
    : member;
  return supplied.kind === 'collection'
    ? { ...supplied, sources: supplied.sources.map(decode) }
    : decode(supplied);
}

export async function readProvidedContent(
  supplied: z.infer<typeof providedContentSchema>,
  ctx: PapercuspUnifiedToolContext,
  maxChars = CONTENT_LIMITS.maxChars,
) {
  const readerId = disclosureSubject(ctx);
  const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
  if (!readerId || !workspaceId || workspaceId === '*') throw new ContentIntakeError('unauthorized', 'A concrete workspace and reader identity are required.');
  const input = decodeProvidedContent(supplied);
  return readContent(input, { workspaceId, readerId, signal: ctx.signal }, {
    // The caller supplied these bytes; this never dereferences the provenance ref
    // or obtains new access. Existing reader tools retain their own ACL checks.
    authorize: async candidate => candidate.kind !== 'reference',
  }, { maxChars });
}
