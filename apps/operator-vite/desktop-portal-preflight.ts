import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepareDesktopPortalBundle } from './desktop-portal-bundle.ts';

// Intentionally has no output-file option. Packaging and installed acceptance
// are separate from this source/graph preflight and the ordinary public build.
const { values } = parseArgs({ options: {
  'portal-root': { type: 'string' },
  'papercusp-root': { type: 'string' },
} });
if (!values['portal-root']) throw new Error('--portal-root must name the maintained portal checkout');
const papercuspRoot = values['papercusp-root'] ?? fileURLToPath(new URL('../../', import.meta.url));
const outputDirectory = resolve(tmpdir(), 'desktop-portal-memory-only');
const result = await prepareDesktopPortalBundle({
  portalRoot: values['portal-root'], papercuspRoot, outputDirectory,
});
const inputs = Object.keys(result.metafile.inputs);
const outputs = result.outputFiles.map(file => ({
  path: relative(outputDirectory, file.path).replaceAll('\\', '/'),
  bytes: file.contents.length,
  sha256: createHash('sha256').update(file.contents).digest('hex'),
})).sort((a, b) => a.path.localeCompare(b.path));
console.log(JSON.stringify({
  schemaVersion: 'desktop-portal-source-preflight-v1',
  preparedAt: new Date().toISOString(),
  ok: true,
  sourceFingerprint: result.source.sourceFingerprint,
  sourceInputs: result.source.inputs,
  graphInputCount: inputs.length,
  outputCount: outputs.length,
  outputBytes: outputs.reduce((n, file) => n + file.bytes, 0),
  outputSetFingerprint: createHash('sha256').update(JSON.stringify(outputs)).digest('hex'),
  nativeInputs: inputs.filter(path => path.includes('@tauri-apps/api/')),
  browserNativeShims: inputs.filter(path => path.includes('tauri-api-browser')),
  warnings: result.warnings.map(warning => ({ text: warning.text, file: warning.location?.file, line: warning.location?.line })),
  scope: 'In-memory shared UI and CSS compilation. Desktop bootstrap, API host composition, installed behavior and publication remain unverified.',
  outputsWritten: false,
}, null, 2));
