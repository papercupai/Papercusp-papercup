/**
 * remark-work-refs.ts — remark plugin that splices a custom `workRefPill`
 * mdast node in place of every WI-/EI-/F-/P- ref found in chat message prose,
 * and resolves report IDs and app paths to ordinary links before display.
 * (chat-ref-pills-2026-07-26 P-004). Reuses parseWorkRefs (P-001) for the
 * actual extraction rather than re-deriving ref matching here.
 *
 * Why a tree transform instead of visiting raw text with unist-util-visit:
 * mdast already segregates fenced code blocks / inline code spans into their
 * own `code`/`inlineCode` node types (string `value`, no phrasing `children`
 * to descend into) — so simply never recursing into a childless node is
 * "must NOT linkify inside code spans or fenced blocks" for free, with no
 * extra masking logic needed at this layer (parseWorkRefs's own raw-text
 * masking already covers non-mdast callers). The one thing mdast does NOT
 * separate out for us is an existing markdown link's label — `[WI-123](url)`
 * still has a `text` child node whose value is the bare ref — so a plain
 * per-node visit would double-linkify it into a nested, invalid `<a>` inside
 * `<a>`. `transformChildren` tracks whether it is currently inside a
 * `link`/`linkReference` subtree and skips ref-splitting there.
 */
import type { Link, Root, RootContent, Text } from 'mdast';
import { parseWorkRefs, type WorkRefMatch } from './parse-work-refs';

/** App pages only: filesystem paths and API/action endpoints are not links.
 * Keep resolution pure so streaming turns and old history use the same rules. */
export function chatAppHref(value: string): string | null {
  if (!/^\/(?:reports|adv|admin|settings|plans|inbox|notes|wiki|dev|docs|internal\/docs|cloud-workspaces|tasks-roster)(?:[/?#]|$)/.test(value)) return null;
  if (/[\s\\<>\u0000-\u001f\u007f]/.test(value)) return null;
  const path = value.split(/[?#]/, 1)[0];
  const segments = path.slice(1).replace(/\/$/, '').split('/');
  if (segments.some(segment => !/^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/.test(segment))) return null;
  const url = new URL(value, 'https://chat.invalid');
  // Older report citations used a path segment; the Reports reader uses sel.
  const legacyReport = /^\/reports\/(rpt_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/.exec(path);
  if (legacyReport) {
    url.pathname = '/reports';
    url.searchParams.set('sel', legacyReport[1]);
    return url.pathname + url.search + url.hash;
  }
  if (path.startsWith('/reports/') && path !== '/reports/') return null;
  const selectedReport = url.searchParams.get('sel');
  if ((path === '/reports' || path === '/reports/') && selectedReport !== null
    && !/^rpt_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(selectedReport)) return null;
  return value;
}

interface AppRefMatch { start: number; end: number; href: string }

function appRefs(text: string): AppRefMatch[] {
  const matches: AppRefMatch[] = [];
  const paths: Array<{ start: number; end: number }> = [];
  // A whole candidate is consumed even when it is not an app route. This avoids
  // finding /reports inside a filesystem path or an unrecognised URL.
  for (const match of text.matchAll(/\/[A-Za-z0-9_~][A-Za-z0-9_~/?#&=.%:+@!$*,;-]*/g)) {
    const start = match.index!;
    paths.push({ start, end: start + match[0].length });
    if (start > 0 && /[\w/.:\\%~-]/.test(text[start - 1])) continue;
    if (text[start + match[0].length] === '\\') continue;
    const value = match[0].replace(/[.,;:!?]+$/, '');
    const href = chatAppHref(value);
    if (href) matches.push({ start, end: start + value.length, href });
  }
  for (const match of text.matchAll(/\brpt_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g)) {
    const start = match.index!;
    if (/[\w/-]/.test(text[start - 1] ?? '') || /[\w-]/.test(text[start + match[0].length] ?? '')) continue;
    if (paths.some(other => start >= other.start && start < other.end)) continue;
    matches.push({ start, end: start + match[0].length, href: `/reports?sel=${match[0]}` });
  }
  return matches;
}

/** The custom mdast node type spliced in for one matched ref. `data.hName` +
 *  `data.hProperties` are the mdast-to-hast contract (react-markdown's
 *  internal remark-rehype step reads these) that turns this node into a
 *  `workrefpill` hast element carrying `refId`/`refKind` — which
 *  markdown component map in PapercupChat.tsx intercepts via its own
 *  `workrefpill` component override and renders as a real
 *  HydratedWorkRefPill/WorkRefPill. Deliberately plain camelCase keys (not
 *  `data-ref-id`-style attribute names): this node is NEVER rendered as a
 *  literal DOM element — the override always wins — so there's no need to
 *  round-trip through hast's HTML-attribute-name normalization, and reading
 *  `node.properties.refId` on the other end stays unambiguous. */
export interface WorkRefPillNode {
  type: 'workRefPill';
  data: {
    hName: 'workrefpill';
    hProperties: { refId: string; refKind: WorkRefMatch['kind'] };
  };
  children: [];
}

function splitTextNode(node: Text): Array<Text | WorkRefPillNode | Link> {
  const appMatches = appRefs(node.value);
  const matches: Array<WorkRefMatch | AppRefMatch> = [
    ...appMatches,
    ...parseWorkRefs(node.value).filter(match => !appMatches.some(app => match.start < app.end && match.end > app.start)),
  ].sort((a, b) => a.start - b.start);
  if (matches.length === 0) return [node];

  const out: Array<Text | WorkRefPillNode | Link> = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) out.push({ type: 'text', value: node.value.slice(cursor, m.start) });
    if ('href' in m) {
      out.push({ type: 'link', url: m.href, children: [{ type: 'text', value: node.value.slice(m.start, m.end) }] });
    } else {
      out.push({
        type: 'workRefPill',
        data: { hName: 'workrefpill', hProperties: { refId: m.id, refKind: m.kind } },
        children: [],
      });
    }
    cursor = m.end;
  }
  if (cursor < node.value.length) out.push({ type: 'text', value: node.value.slice(cursor) });
  return out;
}

/**
 * Recursively rebuild a phrasing-content children array: split every `text`
 * node into text + workRefPill segments, except while `insideLink` (a ref
 * that IS (or is nested inside, e.g. bold text inside) an existing link's
 * label is left as plain text — it's already linked, and a nested pill-link
 * would be an invalid nested `<a>`). A node with no `children` array
 * (`inlineCode`, `code`, `image`, …) is returned as-is and never descended
 * into, which is what keeps refs inside code spans/fences un-linkified.
 */
function transformChildren(nodes: RootContent[], insideLink: boolean): RootContent[] {
  const out: RootContent[] = [];
  for (const node of nodes) {
    if (node.type === 'text' && !insideLink) {
      out.push(...(splitTextNode(node as Text) as unknown as RootContent[]));
      continue;
    }
    const children = (node as { children?: RootContent[] }).children;
    if (Array.isArray(children)) {
      const nextInsideLink = insideLink || node.type === 'link' || node.type === 'linkReference';
      out.push({ ...node, children: transformChildren(children, nextInsideLink) } as RootContent);
      continue;
    }
    out.push(node);
  }
  return out;
}

/** remark plugin factory — pass to `ReactMarkdown`'s `remarkPlugins` array
 *  (after remark-gfm, so GFM's own syntax expansions like autolinks have
 *  already run before we scan the resulting text nodes). */
export function remarkWorkRefs() {
  return (tree: Root) => {
    tree.children = transformChildren(tree.children as RootContent[], false) as Root['children'];
  };
}
