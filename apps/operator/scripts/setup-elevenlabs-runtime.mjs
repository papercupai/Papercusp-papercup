import { readFile, mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import ts from 'typescript';

// Read the maintained SDK's cooked template without evaluating package code.
export function extractWorklet(source, name) {
  const file = ts.createSourceFile('worklet.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const matches = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'createWorkletModuleLoader'
      && node.arguments.length === 2 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === name) {
      const code = node.arguments[1];
      if (!ts.isNoSubstitutionTemplateLiteral(code)) throw new Error(`Unsupported SDK worklet source: ${name}`);
      matches.push(code.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (file.parseDiagnostics.length || matches.length !== 1 || !matches[0].includes(`registerProcessor("${name}"`)) {
    throw new Error(`Cannot extract maintained SDK worklet: ${name}`);
  }
  return matches[0];
}

export async function setupElevenLabsRuntime(appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const require = createRequire(join(appRoot, 'package.json'));
  const sdk = dirname(require.resolve('@elevenlabs/client'));
  const samplerate = join(dirname(require.resolve('@alexanderolsen/libsamplerate-js')), 'libsamplerate.worklet.js');
  // Prepare every source before publishing any asset; missing dependencies fail the build.
  const assets = new Map();
  for (const name of ['rawAudioProcessor', 'audioConcatProcessor']) {
    assets.set(`${name}.js`, extractWorklet(await readFile(join(sdk, 'utils', `${name}.generated.js`), 'utf8'), name));
  }
  assets.set('libsamplerate.worklet.js', await readFile(samplerate));
  const destination = join(appRoot, 'public', 'elevenlabs-runtime');
  await mkdir(destination, { recursive: true });
  const staged = await mkdtemp(join(destination, '.stage-'));
  try {
    for (const [name, content] of assets) await writeFile(join(staged, name), content);
    // Rename replaces the inode, preserving any sibling checkout's hard links.
    for (const name of assets.keys()) await rename(join(staged, name), join(destination, name));
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
  return [...assets.keys()];
}

if (isCliEntry(import.meta.url)) {
  console.log(`elevenlabs-runtime: mirrored ${(await setupElevenLabsRuntime()).join(', ')}`);
}
