/** P024/D029: blog publishing uses the existing owner-scoped outbound and disclosure seams. */
import type postgres from 'postgres';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { assertDisclosurePermits } from '../personal-vault/disclosure-ledger';
import { assertTrustedAddressee, type AddresseeProvenance } from './addressing';
import { invokeOutboundProvider, resolveCapabilitySource, OUTBOUND_CAPABILITIES, type OutboundDispatchDeps } from './provider-dispatch';

export interface BlogPostInput {
  providerId: string;
  sourceId: string;
  title: string;
  markdown: string;
  canonicalUrl: string;
  published?: boolean;
  tags?: string[];
}

export async function postToBlog(sql: postgres.Sql, params: BlogPostInput & {
  workspaceId: string; userId: string; provenance: AddresseeProvenance; agentOwnerId: string | null;
}, deps: OutboundDispatchDeps = {}) {
  if (!params.sourceId.trim() || !params.providerId.trim()) throw new Error('blog_source_required');
  if (params.published !== undefined && typeof params.published !== 'boolean') throw new Error('blog_published_invalid');
  if (!params.title.trim() || [...params.title].length > 128 || !params.markdown.trim() || Buffer.byteLength(params.markdown) > 80000) throw new Error('blog_content_invalid');
  const canonical = new URL(params.canonicalUrl);
  if (canonical.protocol !== 'https:' || canonical.hostname !== 'papercusp.com' || canonical.username || canonical.password || canonical.port || canonical.hash) throw new Error('blog_canonical_url_invalid');
  // An explicit source is still resolved through the owner's source list. A caller cannot
  // select another user's account or silently fall back to a different provider/publication.
  const target = await resolveCapabilitySource(sql, { workspaceId: params.workspaceId, userId: params.userId,
    datatype: 'blog-post', capabilities: [OUTBOUND_CAPABILITIES.blogPost], providerId: params.providerId, sourceId: params.sourceId }, deps);
  const publication = typeof target.source.config.publicationId === 'string' ? target.source.config.publicationId : target.source.id;
  const destination = `${target.provider.id}:${publication}`;
  await assertTrustedAddressee(sql, { workspaceId: params.workspaceId, userId: params.userId, address: destination, provenance: params.provenance });
  // Vendor drafts also leave the box: the same reader-set restriction applies to both modes.
  await assertDisclosurePermits(sql, { workspaceId: params.workspaceId, userId: params.userId,
    agentOwnerId: params.agentOwnerId, recipients: null, sink: `blog:${destination}` });
  const published = params.published === true;
  const echo = { providerId: target.provider.id, sourceId: target.source.id, destination, title: params.title.trim(),
    canonicalUrl: canonical.href, published };
  if (published && !await getFlag(FLAGS.SOCIAL_AUTO_PUBLISH, `social-post:${params.workspaceId}`)) {
    return { status: 'withheld' as const, echo, result: null, withheld: { reason: 'publish-flag-off',
      detail: 'Public publication requires the existing papercusp-social-auto-publish owner setting; drafting remains available.' } };
  }
  const result = await invokeOutboundProvider(sql, target, OUTBOUND_CAPABILITIES.blogPost, {
    title: params.title.trim(), markdown: params.markdown, canonicalUrl: canonical.href, published,
    ...(params.tags === undefined ? {} : { tags: params.tags }),
  }, deps);
  if (typeof result.externalId !== 'string' || !result.externalId.trim() || result.published !== published || result.canonicalUrl !== canonical.href) {
    throw Object.assign(new Error('blog_post_ambiguous_result_do_not_retry'), { retrySafe: false });
  }
  return { status: published ? 'published' as const : 'drafted' as const, echo, result, withheld: null };
}
