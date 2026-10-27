import { describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/clone-remediation-starters-20261024.json', import.meta.url), 'utf8')) as {
  members: { path: string; name: string; source: string; timer: string; run: string; defaultInterval: string }[];
};
const parse = (source: string) => ts.createSourceFile('starter.ts', source, ts.ScriptTarget.Latest, true);
const helperFile = readFileSync(resolve(root, 'libs/generic/scheduled-registry/src/index.ts'), 'utf8');
const helperAst = parse(helperFile);
const helper = helperAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createManagedSweepStarter')!.getText(helperAst);

for (const member of fixture.members) describe(`P020 actual starter ${member.name}`, () => {
  const ast = parse(readFileSync(resolve(root, member.path), 'utf8'));
  const armName = `arm${member.name.slice(5)}`;
  const current = ast.statements.filter(node => (ts.isFunctionDeclaration(node) && node.name?.text === member.name)
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => decl.name.getText(ast) === armName)))
    .map(node => node.getText(ast)).join('\n');

  async function observe(source: string, intervalMs?: number, failure?: unknown) {
    const events: unknown[][] = [];
    let tick!: () => void | Promise<void>;
    const sql = { fixture: 'sql' };
    const context = { exports: {} as Record<string, (...args: unknown[]) => void>, Error,
      console: { warn: (...args: unknown[]) => { events.push(['warn', ...args]); } },
      managedSetInterval: (name: string, interval: number, callback: typeof tick, options: unknown) => {
        events.push(['arm', name, interval, options]); tick = callback;
        return { stop: () => { events.push(['stop']); } };
      },
      [member.defaultInterval]: 4321,
      [member.run]: (...args: unknown[]) => {
        events.push(['run', args.length, args.length ? args[0] === sql : null]);
        return failure === undefined ? Promise.resolve({ done: true }) : Promise.reject(failure);
      },
    };
    const code = ts.transpileModule(`${helper}\nlet ${member.timer} = null;\n${source}`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(code, context, { timeout: 1000 });
    const original = parse(member.source).statements.find(ts.isFunctionDeclaration)!;
    const args = original.parameters[0].name.getText() === 'sql' ? [sql, { intervalMs }] : [{ intervalMs }];
    context.exports[member.name](...args);
    await tick();
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    return JSON.parse(JSON.stringify(events));
  }

  it.each([undefined, 57, 0])('preserves real callback, metadata and interval %s', async intervalMs => {
    expect(await observe(current, intervalMs)).toEqual(await observe(member.source, intervalMs));
  });
  it.each([new Error('controlled sweep failure'), 'non-error rejection'])('preserves caller failure logging %s', async failure => {
    expect(await observe(current, undefined, failure)).toEqual(await observe(member.source, undefined, failure));
  });
});
