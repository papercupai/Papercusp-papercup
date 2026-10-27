import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { buildCloneIndex, cloneBlobSha, type CloneSource } from './clone-index';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL(
  './__fixtures__/clone-corpus-20261021/governor-sources.json', import.meta.url,
), 'utf8')) as {
  candidateCommit: string;
  members: (CloneSource & { sha256: string; gitBlobSha1: string })[];
};
const sharedPath = 'packages/operator-core/lib/learning-governor/registrants.ts';
const paths = fixture.members.map(row => row.path);
const current = [...paths, sharedPath].map(path => ({ path, source: readFileSync(resolve(root, path), 'utf8') }));
const redundantMass = (sources: CloneSource[]) => buildCloneIndex(sources).families().reduce((total, family) =>
  total + family.members.reduce((sum, member) => sum + member.mass, 0)
    - Math.max(...family.members.map(member => member.mass)), 0);

const seedFixture = JSON.parse(readFileSync(new URL(
  './__fixtures__/clone-remediation-seeders-20261024.json', import.meta.url,
), 'utf8')) as { members: (CloneSource & { sha256: string })[] };
const seedSharedPath = 'packages/operator-core/lib/harness/routines/seed-routine-main.ts';
const seedPaths = seedFixture.members.map(member => member.path);
const seedCurrent = [...seedPaths, seedSharedPath].map(path => ({ path, source: readFileSync(resolve(root, path), 'utf8') }));

function assertSeederRemediation(sources: CloneSource[]): void {
  const index = buildCloneIndex(sources);
  for (const path of [...seedPaths, seedSharedPath]) {
    const file = index.getFile(path);
    if (!file || file.status !== 'indexed') throw new Error(`Unmeasured routine seeder: ${path}`);
    if (path !== seedSharedPath && file.functions.some(fn => fn.name === 'main')) {
      throw new Error(`Separately maintained routine-seeder main: ${path}`);
    }
  }
  if (redundantMass(sources) !== 0) {
    throw new Error('Routine-seeder duplicate mass has returned');
  }
}

function assertGovernorRemediation(sources: CloneSource[]): void {
  const index = buildCloneIndex(sources);
  for (const path of [...paths, sharedPath]) {
    const file = index.getFile(path);
    if (!file || file.status !== 'indexed') throw new Error(`Unmeasured governor source: ${path}`);
    if (path !== sharedPath && file.functions.some(fn => fn.name.endsWith('GovernorGate'))) {
      throw new Error(`Separately maintained governor gate: ${path}`);
    }
  }
  if (redundantMass(sources) !== 0) throw new Error('Governor duplicate mass has returned');
}

describe('P020 measured clone-family remediation', () => {
  it('retains the frozen ten-governor prechange population and exact source identities', () => {
    expect(fixture.candidateCommit).toBe('7395c59c0032f6810f995a1ecf7966c92ac83448');
    expect(paths).toHaveLength(10);
    expect(new Set(paths).size).toBe(10);
    for (const member of fixture.members) {
      expect(cloneBlobSha(member.source)).toBe(member.gitBlobSha1);
      expect(createHash('sha256').update(member.source).digest('hex')).toBe(member.sha256);
    }
    const families = buildCloneIndex(fixture.members).families();
    expect(families).toHaveLength(1);
    expect(families[0].members.map(member => member.path).sort()).toEqual([...paths].sort());
    expect(families[0].members.every(member => member.name.endsWith('GovernorGate'))).toBe(true);
  });

  it('strictly reduces duplicate mass across migrated callers plus the shared implementation', () => {
    expect(redundantMass(fixture.members)).toBeGreaterThan(0);
    expect(redundantMass(current)).toBeLessThan(redundantMass(fixture.members));
    expect(() => assertGovernorRemediation(current)).not.toThrow();
  });

  it.each(fixture.members)('rejects restoring the removed duplicate in $path', member => {
    const restored = current.map(source => source.path === member.path ? member : source);
    expect(() => assertGovernorRemediation(restored)).toThrow('Separately maintained governor gate');
  });
});

describe('P020 routine-seeder clone-family remediation', () => {
  it('retains the complete frozen forty-seeder prechange population', () => {
    expect(seedPaths).toHaveLength(40);
    expect(new Set(seedPaths).size).toBe(40);
    for (const member of seedFixture.members) {
      expect(createHash('sha256').update(member.source).digest('hex')).toBe(member.sha256);
    }
    const families = buildCloneIndex(seedFixture.members).families();
    expect(families).toHaveLength(12);
    expect(new Set(families.flatMap(family => family.members.map(member => member.path))))
      .toEqual(new Set(seedPaths));
  });

  it('strictly reduces duplicate mass including the shared SQL and CLI implementation', () => {
    expect(redundantMass(seedFixture.members)).toBeGreaterThan(0);
    expect(redundantMass(seedCurrent)).toBeLessThan(redundantMass(seedFixture.members));
    expect(() => assertSeederRemediation(seedCurrent)).not.toThrow();
  });

  it.each(seedFixture.members)('rejects restoring the removed main in $path', member => {
    const restored = seedCurrent.map(source => source.path === member.path ? member : source);
    expect(() => assertSeederRemediation(restored)).toThrow('Separately maintained routine-seeder main');
  });
});

const starterFixture = JSON.parse(readFileSync(new URL(
  './__fixtures__/clone-remediation-starters-20261024.json', import.meta.url,
), 'utf8')) as { members: (CloneSource & { name: string; sha256: string })[];
  sharedBefore: CloneSource & { sha256: string } };
const starterGroups = new Map<string, typeof starterFixture.members>();
for (const member of starterFixture.members) starterGroups.set(member.path, [...(starterGroups.get(member.path) ?? []), member]);
const starterBefore = [...starterGroups].map(([path, members]) => ({ path, source: members.map(member => member.source).join('\n') }));
starterBefore.push(starterFixture.sharedBefore);
const starterCurrent = [...starterGroups].map(([path, members]) => {
  const ast = ts.createSourceFile(path, readFileSync(resolve(root, path), 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set(members.map(member => member.name));
  const arms = new Set(members.map(member => `arm${member.name.slice(5)}`));
  const selected = ast.statements.filter(node => (ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''))
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => arms.has(decl.name.getText(ast)))));
  return { path, source: selected.map(node => node.getText(ast)).join('\n') };
});
starterCurrent.push({ path: starterFixture.sharedBefore.path,
  source: readFileSync(resolve(root, starterFixture.sharedBefore.path), 'utf8') });

function assertStarterRemediation(sources: CloneSource[]): void {
  const index = buildCloneIndex(sources);
  for (const [path, members] of starterGroups) {
    const file = index.getFile(path);
    if (!file || file.status !== 'indexed') throw new Error(`Unmeasured recurring starter: ${path}`);
    if (file.functions.some(fn => members.some(member => member.name === fn.name))) {
      throw new Error(`Separately maintained recurring starter: ${path}`);
    }
  }
  if (redundantMass(sources) !== 0) throw new Error('Recurring-starter duplicate mass has returned');
}

describe('P020 recurring-starter clone-family remediation', () => {
  it('retains the eight original starters and the prechange shared-registry source', () => {
    expect(starterFixture.members).toHaveLength(8);
    expect(starterGroups.size).toBe(7);
    for (const source of [...starterFixture.members, starterFixture.sharedBefore]) {
      expect(createHash('sha256').update(source.source).digest('hex')).toBe(source.sha256);
    }
    expect(buildCloneIndex(starterBefore).families()).toHaveLength(2);
  });
  it('strictly reduces duplicate mass including the complete shared registry', () => {
    expect(redundantMass(starterBefore)).toBeGreaterThan(0);
    expect(redundantMass(starterCurrent)).toBeLessThan(redundantMass(starterBefore));
    expect(() => assertStarterRemediation(starterCurrent)).not.toThrow();
  });
  for (const member of starterFixture.members) it(`rejects restoring ${member.name}`, () => {
    const restored = starterCurrent.map(source => source.path === member.path
      ? { ...source, source: starterGroups.get(member.path)!.map(row => row.source).join('\n') } : source);
    expect(() => assertStarterRemediation(restored)).toThrow('Separately maintained recurring starter');
  });
});
