// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { TerminalLinksAddon } from './terminal-links';

const navigation = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/operator-core/lib/client-navigation', () => ({
  navigateClient: navigation, shouldSoftNavigate: () => true,
}));
const REPORT = 'rpt_c6a650d3-4b68-4bef-9169-8bf4fe69f998';
const HREF = `/reports?sel=${REPORT}&view=all#details`;
const terminals: Terminal[] = [];
const write = (terminal: Terminal, value: string) => new Promise<void>(done => terminal.write(value, done));
function linksAt(provider: ILinkProvider, y: number): ILink[] {
  let links: ILink[] | undefined;
  provider.provideLinks(y, value => { links = value; });
  return links ?? [];
}
async function setup(text: string, cols = 100, rows = 10) {
  const terminal = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
  terminals.push(terminal);
  const register = vi.spyOn(terminal, 'registerLinkProvider');
  const addon = new TerminalLinksAddon();
  terminal.loadAddon(addon);
  await write(terminal, text);
  return { terminal, addon, provider: register.mock.calls[0][0], register };
}
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
  vi.clearAllMocks();
});

describe('terminal app references in real xterm buffers', () => {
  it('preserves query-fragment and punctuation with exact-cell-range and app activation', async () => {
    const { provider } = await setup(`\x1b[32mgo ${HREF}\x1b[0m).`);
    const [link] = linksAt(provider, 1);
    expect(link, 'the actual provider must discover the complete reference').toBeDefined();
    expect(link.text).toBe(HREF);
    expect(link.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 3 + HREF.length, y: 1 } });
    const event = new MouseEvent('click', { cancelable: true });
    link.activate(event, link.text);
    expect(event.defaultPrevented).toBe(true);
    expect(navigation).toHaveBeenCalledExactlyOnceWith(HREF);
  });

  it.each([
    [REPORT, `/reports?sel=${REPORT}`],
    [`/reports/${REPORT}?view=all#details`, `/reports?view=all&sel=${REPORT}#details`],
  ])('recognizes complete reference %s', async (text, expected) => {
    const { provider } = await setup(text);
    const [link] = linksAt(provider, 1);
    link.activate(new MouseEvent('click'), link.text);
    expect(navigation).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it('soft-wrap and split-at-wrap retain one exact inclusive range on every queried row', async () => {
    const { provider } = await setup(`>> ${HREF}`, 20);
    const end = { x: (3 + HREF.length - 1) % 20 + 1, y: Math.floor((3 + HREF.length - 1) / 20) + 1 };
    for (let y = 1; y <= end.y; y++) {
      const [link] = linksAt(provider, y);
      expect(link.range).toEqual({ start: { x: 4, y: 1 }, end });
      link.activate(new MouseEvent('click'), link.text);
    }
    expect(navigation).toHaveBeenCalledTimes(end.y);
    expect(navigation.mock.calls.every(([href]) => href === HREF)).toBe(true);
    expect(linksAt(provider, end.y + 1)).toEqual([]);
  });

  it.each([
    ['double-width', '界界 '], ['combining', 'e\u0301e\u0301 '], ['emoji', '😀👩‍💻 '],
  ])('%s prefix maps text offsets to actual cells', async (_scenario, prefix) => {
    const { terminal, provider } = await setup(prefix + HREF, 24);
    const [link] = linksAt(provider, 1);
    const { start, end } = link.range;
    expect(terminal.buffer.active.getLine(start.y - 1)?.getCell(start.x - 1)?.getChars()).toBe('/');
    expect(terminal.buffer.active.getLine(start.y - 1)?.getCell(start.x - 2)?.getChars()).toBe(' ');
    expect(terminal.buffer.active.getLine(end.y - 1)?.getCell(end.x - 1)?.getChars()).toBe('s');
    link.activate(new MouseEvent('click'), link.text);
    expect(navigation).toHaveBeenCalledExactlyOnceWith(HREF);
  });

  it('early-wrapped wide cells do not insert null padding into a token boundary', async () => {
    const { provider } = await setup(' '.repeat(19) + '界' + REPORT, 20);
    const [link] = linksAt(provider, 2);
    expect(link.text).toBe(REPORT);
    expect(link.range.start).toEqual({ x: 3, y: 2 });
    link.activate(new MouseEvent('click'), link.text);
    expect(navigation).toHaveBeenCalledExactlyOnceWith(`/reports?sel=${REPORT}`);
  });

  it('resize-reflow recomputes ranges without cached viewport coordinates', async () => {
    // Xterm deliberately leaves a wrapped group alone while the cursor is
    // inside it. Move past the group to exercise actual scrollback reflow.
    const { terminal, provider } = await setup(`go ${HREF}\r\n`, 20);
    const before = linksAt(provider, 1)[0];
    terminal.resize(40, 10);
    const after = linksAt(provider, 1)[0];
    expect(after.text).toBe(HREF);
    expect(after.range.end.y).toBeLessThan(before.range.end.y);
    expect(after.range.end).toEqual({ x: (3 + HREF.length - 1) % 40 + 1, y: Math.floor((3 + HREF.length - 1) / 40) + 1 });
  });

  it('resize of the active cursor group ignores newly added trailing null padding', async () => {
    const { terminal, provider } = await setup(`go ${HREF}`, 20);
    terminal.resize(40, 10);
    const [link] = linksAt(provider, 1);
    expect(link?.text).toBe(HREF);
    const { end } = link.range;
    expect(terminal.buffer.active.getLine(end.y - 1)?.getCell(end.x - 1)?.getChars()).toBe('s');
    link.activate(new MouseEvent('click'), link.text);
    expect(navigation).toHaveBeenCalledExactlyOnceWith(HREF);
  });

  it('buffer-viewport uses buffer row identities after scrollback', async () => {
    const { terminal, provider } = await setup('line\r\n'.repeat(40) + REPORT, 60, 3);
    expect(terminal.buffer.active.baseY).toBeGreaterThan(0);
    expect(linksAt(provider, 1)).toEqual([]);
    expect(linksAt(provider, 41)[0].range).toEqual({ start: { x: 1, y: 41 }, end: { x: REPORT.length, y: 41 } });
  });

  it('does not combine hard-newline fragments into an incomplete-token', async () => {
    const { provider } = await setup(REPORT.slice(0, 18) + '\r\n' + REPORT.slice(18));
    expect(linksAt(provider, 1)).toEqual([]);
    expect(linksAt(provider, 2)).toEqual([]);
  });

  it.each([
    ['incomplete-token', 'rpt_c6a650d3-4b68'],
    ['ambiguous-adjacency', `other-${REPORT}`],
    ['unsafe-scheme', `javascript:${REPORT}`],
    ['unsafe-scheme', `mailto:${REPORT}`],
    ['filesystem-api-path', `/tmp/reports/${REPORT}`],
    ['filesystem-api-path', '/api/reports?sel=' + REPORT],
    ['encoded-traversal', '/reports/%2e%2e/settings'],
    ['query-fragment', '/reports?sel=rpt_partial#details'],
  ])('%s remains inert: %s', async (_scenario, text) => {
    const { provider } = await setup(text);
    expect(linksAt(provider, 1)).toEqual([]);
    expect(navigation).not.toHaveBeenCalled();
  });

  it('external-web-control retains the actual WebLinksAddon handler', async () => {
    const url = `https://example.com/reports?sel=${REPORT}`;
    const { terminal, provider, register } = await setup(url);
    const external = vi.fn();
    terminal.loadAddon(new WebLinksAddon(external));
    expect(linksAt(provider, 1)).toEqual([]);
    const [link] = linksAt(register.mock.calls[1][0], 1);
    link.activate(new MouseEvent('click'), link.text);
    expect(external).toHaveBeenCalledWith(expect.any(MouseEvent), url);
    expect(navigation).not.toHaveBeenCalled();
  });

  it('disposal unregisters the provider and makes previously returned links inert', async () => {
    const { addon, provider, register } = await setup(REPORT);
    const [link] = linksAt(provider, 1);
    const released = vi.spyOn(register.mock.results[0].value, 'dispose');
    addon.dispose();
    link.activate(new MouseEvent('click'), link.text);
    expect(released).toHaveBeenCalledOnce();
    expect(linksAt(provider, 1)).toEqual([]);
    expect(navigation).not.toHaveBeenCalled();
  });
});

// Population discovery is structural; behavior above runs the actual provider.
// Runtime imports are discovered independently of the declared expected hosts.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HOSTS = [
  'apps/operator/app/_components/SetupWizard/InlinePtyTerminal.tsx',
  'apps/operator/app/_components/StructuredStreamView.tsx',
  'apps/operator/app/cloud-workspaces/HostedWorkspaceSession.tsx',
  'apps/operator/app/dev/_components/TerminalTab.tsx',
  'apps/operator/app/harness/PiPanel.tsx',
].sort();
function runtimeXtermImport(path: string, text: string): boolean {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.some(arg => ts.isStringLiteral(arg) && arg.text === '@xterm/xterm')) found = true;
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === '@xterm/xterm' && !node.importClause?.isTypeOnly) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
function population() {
  return ['apps/operator/app', 'apps/operator/lib', 'packages/operator-ui/src'].flatMap(root =>
    ts.sys.readDirectory(resolve(ROOT, root), ['.ts', '.tsx'], ['**/*.test.*', '**/__tests__/**', '**/test/**', '**/e2e/**'])
      .filter(path => runtimeXtermImport(path, readFileSync(path, 'utf8')))
      .map(path => relative(ROOT, path).split('\\').join('/')),
  ).sort();
}
describe('terminal production host census', () => {
  it('host-population-census discovers the complete current production population', () => {
    expect(population()).toEqual(HOSTS);
  });
  it('host-population-extra-control rejects an undisclosed runtime terminal host', () => {
    const extra = 'apps/operator/app/extra/Terminal.tsx';
    expect(runtimeXtermImport(extra, "const { Terminal } = await import('@xterm/xterm'); new Terminal();")).toBe(true);
    expect([...population(), extra].sort()).not.toEqual(HOSTS);
  });
  it('host-population-missing-control rejects an omitted production mount', () => {
    expect(population().slice(1)).not.toEqual(HOSTS);
  });
});
