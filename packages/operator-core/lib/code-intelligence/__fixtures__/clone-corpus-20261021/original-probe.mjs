// Scratch probe (WI-6554700010018580): measure Type-1 / Type-2 function-body clones
// across first-party TS using the TypeScript compiler's own parser. Read-only.
// Type-1 = identical token stream (whitespace/comments ignored, names kept).
// Type-2 = identical AST shape with every identifier and literal normalized away.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const ts = require(process.cwd() + '/node_modules/typescript');
const MIN_MASS = Number(process.env.MIN_MASS ?? 80);

const files = execFileSync('git', ['ls-files', '--recurse-submodules', '*.ts', '*.tsx'], { maxBuffer: 1 << 28 })
  .toString().split('\n').filter(f => f
    && !/\.d\.ts$/.test(f)
    && !/(\.test|\.spec|\.integration\.test)\.tsx?$/.test(f)
    && !/(^|\/)(node_modules|dist|dist-host|build|coverage|__fixtures__|__mocks__|generated|\.materialized|sidecar)(\/|$)/.test(f)
    && !/\.gen\.tsx?$/.test(f));

const LIT = new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail, ts.SyntaxKind.RegularExpressionLiteral]);
const isFn = n => (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n)
  || ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n)) && n.body && ts.isBlock(n.body);

function fingerprint(body, sf) {
  const t1 = [], t2 = []; let mass = 0;
  const walk = n => {
    mass++;
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) { t1.push('I:' + n.text); t2.push('I'); return; }
    if (LIT.has(n.kind)) { t1.push('L:' + n.getText(sf)); t2.push('L'); return; }
    t1.push(n.kind); t2.push(n.kind);
    t1.push('('); t2.push('(');
    ts.forEachChild(n, walk);
    t1.push(')'); t2.push(')');
  };
  walk(body);
  const h = a => createHash('sha1').update(a.join(',')).digest('hex').slice(0, 16);
  return { mass, h1: h(t1), h2: h(t2) };
}

const pkgOf = f => {
  const p = f.split('/');
  if (p[0] === 'libs' && p[1] === 'generic') return p.slice(0, 3).join('/');
  if (p[0] === 'libs' && p[1] === 'papercusp') return p.slice(0, 4).join('/');
  return p.slice(0, 2).join('/');
};

const fns = []; let parsed = 0, failed = 0;
for (const f of files) {
  let src; try { src = readFileSync(f, 'utf8'); } catch { failed++; continue; }
  if (src.length > 1_500_000) continue;
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  parsed++;
  const visit = n => {
    if (isFn(n)) {
      const fp = fingerprint(n.body, sf);
      if (fp.mass >= MIN_MASS) {
        let name = n.name && ts.isIdentifier(n.name) ? n.name.text : '';
        if (!name && n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) name = n.parent.name.text;
        if (!name && n.parent && ts.isPropertyAssignment(n.parent) && ts.isIdentifier(n.parent.name)) name = n.parent.name.text;
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        fns.push({ f, line, name: name || '<anon>', pkg: pkgOf(f), ...fp });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function groups(key) {
  const m = new Map();
  for (const fn of fns) { const g = m.get(fn[key]); g ? g.push(fn) : m.set(fn[key], [fn]); }
  // A clone group = same fingerprint in >=2 distinct functions; drop nested-duplicate
  // artefacts by requiring distinct (file,line).
  return [...m.values()].filter(g => new Set(g.map(x => x.f + ':' + x.line)).size >= 2);
}
const g1 = groups('h1'), g2 = groups('h2');
const g1keys = new Set(g1.flatMap(g => g.map(x => x.f + ':' + x.line)));
const renamedOnly = g2.filter(g => !g.every(x => g1keys.has(x.f + ':' + x.line)));
const summarize = gs => {
  const crossFile = gs.filter(g => new Set(g.map(x => x.f)).size >= 2);
  const crossPkg = gs.filter(g => new Set(g.map(x => x.pkg)).size >= 2);
  const redundant = gs.reduce((s, g) => s + (g.length - 1) * g[0].mass, 0);
  return { groups: gs.length, crossFile: crossFile.length, crossPackage: crossPkg.length,
    fnsInGroups: gs.reduce((s, g) => s + g.length, 0), redundantMass: redundant };
};
const top = (gs, n) => gs
  .filter(g => new Set(g.map(x => x.f)).size >= 2)
  .sort((a, b) => (b.length - 1) * b[0].mass - (a.length - 1) * a[0].mass)
  .slice(0, n)
  .map(g => ({ mass: g[0].mass, n: g.length, pkgs: [...new Set(g.map(x => x.pkg))].length,
    members: g.slice(0, 4).map(x => `${x.f}:${x.line} ${x.name}`) }));

const totalMass = fns.reduce((s, x) => s + x.mass, 0);
const out = {
  minMass: MIN_MASS, filesListed: files.length, filesParsed: parsed, readFailures: failed,
  functionsAtOrAboveMinMass: fns.length, totalMass,
  type1: summarize(g1), type2: summarize(g2), type2RenamedOnlyGroups: renamedOnly.length,
  topType1: top(g1, 12), topRenamedOnly: top(renamedOnly, 8),
};
writeFileSync('.papercusp/scratch/dup-probe-out.json', JSON.stringify({ ...out, allType2: g2.map(g => g.map(x => `${x.f}:${x.line} ${x.name} m=${x.mass}`)) }, null, 1));
console.log(JSON.stringify({ ...out, topType1: undefined, topRenamedOnly: undefined }));
