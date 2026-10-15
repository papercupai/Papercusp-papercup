// @vitest-environment node
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('packaged GNOME launcher preparation', () => {
  it('bundles the shared policy into a standalone launcher without runtime repository assets', async () => {
    const bundled = await build({ entryPoints: [fileURLToPath(new URL('./gnome-terminal-profile.mjs', import.meta.url))],
      bundle: true, platform: 'node', format: 'esm', write: false });
    const program = bundled.outputFiles[0]!.text + `
console.log(JSON.stringify({uuid:GNOME_SESSION_PROFILE_UUID,limit:GNOME_SESSION_SCROLLBACK_LINES,
  preparation:GNOME_PROFILE_PREPARATION.includes('from gi.repository import Gio'),
  terminal:await prepareGnomeTerminal({bin:'gnome-terminal',args:['--app-id=personal','--profile=personal','--']})}));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', program],
      { cwd: '/tmp', timeout: 5000 });
    expect(JSON.parse(stdout)).toEqual({ uuid: '42e5b17a-5f06-4cec-b4b2-b21dedc90c82', limit: 10000,
      preparation: true, terminal: { bin: 'gnome-terminal', args: ['--app-id=personal', '--profile=personal', '--'] } });
  });
});
