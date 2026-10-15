/**
 * The PUBLIC user manual, not the authenticated engineering corpus.
 * Built by apps/papercusp-docs and mirrored into public/docs.
 */
import { Hono } from 'hono';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { servePublicDocs } from '@papercusp/operator-core/lib/public-docs';

const HOST_MODULE_DIR = typeof __dirname === 'string'
  ? __dirname
  : fileURLToPath(new URL('.', import.meta.url));

const root = process.env.PAPERCUSP_PUBLIC_DOCS_ROOT
  ? resolve(process.env.PAPERCUSP_PUBLIC_DOCS_ROOT)
  : resolve(HOST_MODULE_DIR, '..', 'public', 'docs');

export const publicDocsRoutes = new Hono();
publicDocsRoutes.all('/docs', (c) => servePublicDocs(c.req.raw, root));
publicDocsRoutes.all('/docs/*', (c) => servePublicDocs(c.req.raw, root));
