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
  /** Independent clone trigger; null/absent means this writer could not measure it. */
  addedExportedFunctions?: string[] | null;
  peerEvidence: EditTimePeerEvidence;
}

function signatures(text: string, file: string): { rows: Map<string, string[]>; functions: Set<string>; functionsComplete: boolean } | null {
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
  const functions = new Set<string>();
  const localFunctions = new Set<string>();
  const localNonFunctions = new Set<string>();
  let functionsComplete = true;
  for (const n of source.statements) {
    if (ts.isFunctionDeclaration(n) && n.name) localFunctions.add(n.name.text);
    else if ((ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)
      || ts.isEnumDeclaration(n)) && n.name) localNonFunctions.add(n.name.text);
    else if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue;
      if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) localFunctions.add(d.name.text);
      else if (d.initializer && (ts.isNumericLiteral(d.initializer) || ts.isStringLiteral(d.initializer)
          || d.initializer.kind === ts.SyntaxKind.TrueKeyword || d.initializer.kind === ts.SyntaxKind.FalseKeyword))
        localNonFunctions.add(d.name.text);
    }
  }
  const exportLocal = (local: string, exported: string) => {
    if (localFunctions.has(local)) functions.add(exported);
    else if (!localNonFunctions.has(local)) functionsComplete = false;
  };
  const add = (name: string, value: unknown) => rows.set(name, [...(rows.get(name) ?? []), JSON.stringify(value)]);
  for (const n of source.statements) {
    if (ts.isExportDeclaration(n)) {
      add('export', print(n));
      if (!n.isTypeOnly) {
        if (n.moduleSpecifier || !n.exportClause || !ts.isNamedExports(n.exportClause)) functionsComplete = false;
        else for (const item of n.exportClause.elements) if (!item.isTypeOnly)
          exportLocal(item.propertyName?.text ?? item.name.text, item.name.text);
      }
      continue;
    }
    if (ts.isExportAssignment(n)) {
      add('export', print(n));
      if (ts.isIdentifier(n.expression)) exportLocal(n.expression.text, 'default');
      else if (ts.isArrowFunction(n.expression) || ts.isFunctionExpression(n.expression)) functions.add('default');
      else functionsComplete = false;
      continue;
    }
    if (!has(n, ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = has(n, ts.SyntaxKind.DefaultKeyword);
    if (ts.isFunctionDeclaration(n)) {
      const name = isDefault ? 'default' : n.name?.text ?? 'default';
      add(name, callable(n)); functions.add(name);
    }
    else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const v = d.initializer;
        if (v && (ts.isArrowFunction(v) || ts.isFunctionExpression(v))) {
          add(d.name.text, { type: print(d.type), callable: callable(v) });
          functions.add(d.name.text);
        }
        else {
          if (d.type) add(d.name.text, print(d.type));
          exportLocal(d.name.text, d.name.text);
        }
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
  return { rows, functions, functionsComplete };
}

export function captureInterfaceEligibility(input: {
  file: string; beforeText: string | null; afterText: string | null; capturedAt: string;
  peerEvidence: EditTimePeerEvidence;
}): InterfaceEligibility {
  const hash = (text: string | null) => text === null ? null : createHash('sha256').update(text).digest('hex');
  const base = { version: 1 as const, capturedAt: input.capturedAt,
    beforeSha256: hash(input.beforeText), afterSha256: hash(input.afterText), changedExports: [] as string[],
    addedExportedFunctions: null as string[] | null,
    peerEvidence: { status: input.peerEvidence.status, peers: input.peerEvidence.peers.map(p => ({ ...p })) },
  };
  if (!Number.isFinite(Date.parse(input.capturedAt)) || input.beforeText === null || input.afterText === null)
    return { ...base, verdict: 'unknown', reason: 'full-file before/after unavailable' };
  const before = signatures(input.beforeText, input.file), after = signatures(input.afterText, input.file);
  if (!before || !after) return { ...base, verdict: 'unknown', reason: 'full-file TypeScript parse failed' };
  base.changedExports = [...new Set([...before.rows.keys(), ...after.rows.keys()])]
    .filter(name => JSON.stringify(before.rows.get(name)) !== JSON.stringify(after.rows.get(name))).sort();
  // This observation depends on full source, not on the interface leg finding a
  // peer or on the clone delivery path producing an advisory.
  if (before.functionsComplete && after.functionsComplete)
    base.addedExportedFunctions = [...after.functions].filter(name => !before.functions.has(name)).sort();
  if (!base.changedExports.length) return { ...base, verdict: 'ineligible', reason: 'no exported signature change' };
  if (base.peerEvidence.status !== 'measured') return { ...base, verdict: 'unknown', reason: 'edit-time peer evidence unavailable' };
  return base.peerEvidence.peers.length
    ? { ...base, verdict: 'eligible', reason: 'exported signature changed with an observed peer' }
    : { ...base, verdict: 'ineligible', reason: 'no observed peer at edit time' };
}
