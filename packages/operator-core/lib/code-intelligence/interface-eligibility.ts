/** P002/P003 D018: independent full-file eligibility captured before peers disappear.
 * Do not import the push path, peer-impact derivation or hook signature detector.
 */
import { createHash } from 'node:crypto';
import ts from 'typescript';

export interface EditTimePeerEvidence {
  status: 'measured' | 'unknown';
  /** Capture producer correlates these live peers to the edited surface. */
  peers: Array<{ owner: string; path: string; via: 'lock' | 'working-set' }>;
}
export interface InterfaceEligibility {
  version: 1;
  capturedAt: string;
  verdict: 'eligible' | 'ineligible' | 'unknown';
  reason: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  changedExports: string[];
  peerEvidence: EditTimePeerEvidence;
}

function signatures(text: string, file: string): Map<string, string[]> | null {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  if ((source as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length) return null;
  const printer = ts.createPrinter({ removeComments: true });
  const print = (n: ts.Node | undefined) => n ? printer.printNode(ts.EmitHint.Unspecified, n, source) : null;
  const modifiers = (n: ts.Node) => ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : [];
  const has = (n: ts.Node, kind: ts.SyntaxKind) => modifiers(n).some(m => m.kind === kind);
  const callable = (n: ts.SignatureDeclarationBase) => ({
    typeParameters: n.typeParameters?.map(print) ?? [], parameters: n.parameters.map(print), type: print(n.type),
  });
  const rows = new Map<string, string[]>();
  const add = (name: string, value: unknown) => rows.set(name, [...(rows.get(name) ?? []), JSON.stringify(value)]);
  for (const n of source.statements) {
    if (ts.isExportDeclaration(n) || ts.isExportAssignment(n)) { add('export', print(n)); continue; }
    if (!has(n, ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = has(n, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(n)) add(isDefault ? 'default' : n.name?.text ?? 'default', callable(n));
    else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const v = d.initializer;
        if (v && (ts.isArrowFunction(v) || ts.isFunctionExpression(v)))
          add(d.name.text, { type: print(d.type), callable: callable(v) });
        else if (d.type) add(d.name.text, print(d.type));
      }
    } else if (ts.isClassDeclaration(n)) {
      const members = n.members.filter(m => !has(m, ts.SyntaxKind.PrivateKeyword)
        && !has(m, ts.SyntaxKind.ProtectedKeyword) && !(m.name && ts.isPrivateIdentifier(m.name)));
      add(isDefault ? 'default' : n.name?.text ?? 'default', {
        typeParameters: n.typeParameters?.map(print) ?? [], heritage: n.heritageClauses?.map(print) ?? [],
        members: members.map(m => ({ name: print(m.name), kind: m.kind, modifiers: modifiers(m).map(mod => mod.kind),
          shape: ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)
            || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m) ? callable(m)
            : ts.isPropertyDeclaration(m) ? { type: print(m.type), optional: !!m.questionToken } : print(m),
        })),
      });
    } else if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n))
      add(n.name.text, print(n));
  }
  for (const [name, shapes] of rows) rows.set(name, [...new Set(shapes)].sort());
  return rows;
}

export function captureInterfaceEligibility(input: {
  file: string; beforeText: string | null; afterText: string | null; capturedAt: string;
  peerEvidence: EditTimePeerEvidence;
}): InterfaceEligibility {
  const hash = (text: string | null) => text === null ? null : createHash('sha256').update(text).digest('hex');
  const base = { version: 1 as const, capturedAt: input.capturedAt,
    beforeSha256: hash(input.beforeText), afterSha256: hash(input.afterText), changedExports: [] as string[],
    peerEvidence: { status: input.peerEvidence.status, peers: input.peerEvidence.peers.map(p => ({ ...p })) },
  };
  if (!Number.isFinite(Date.parse(input.capturedAt)) || input.beforeText === null || input.afterText === null)
    return { ...base, verdict: 'unknown', reason: 'full-file before/after unavailable' };
  const before = signatures(input.beforeText, input.file), after = signatures(input.afterText, input.file);
  if (!before || !after) return { ...base, verdict: 'unknown', reason: 'full-file TypeScript parse failed' };
  base.changedExports = [...new Set([...before.keys(), ...after.keys()])]
    .filter(name => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name))).sort();
  if (!base.changedExports.length) return { ...base, verdict: 'ineligible', reason: 'no exported signature change' };
  if (base.peerEvidence.status !== 'measured') return { ...base, verdict: 'unknown', reason: 'edit-time peer evidence unavailable' };
  return base.peerEvidence.peers.length
    ? { ...base, verdict: 'eligible', reason: 'exported signature changed with an observed peer' }
    : { ...base, verdict: 'ineligible', reason: 'no observed peer at edit time' };
}
