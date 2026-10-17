import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../gnome-terminal-safe.py');

function launch(arguments_: string[]) {
  const program = [
    'import importlib.util,json,resource,sys',
    'spec=importlib.util.spec_from_file_location("terminal_safe",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)',
    'soft,hard=resource.getrlimit(resource.RLIMIT_NOFILE)',
    'resource.setrlimit(resource.RLIMIT_NOFILE,(min(1024,hard),hard))',
    'module.os.execv=lambda executable,argv: print(json.dumps({"executable":executable,"argv":argv,"limits":resource.getrlimit(resource.RLIMIT_NOFILE),"originalHard":hard}))',
    'module.main(json.loads(sys.stdin.read()))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', program, SCRIPT], {
    encoding: 'utf8', input: JSON.stringify(arguments_), timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('Ubuntu terminal startup descriptor safety (WI-6554700010016095)', () => {
  it('raises the inherited soft limit before exec, without changing the hard ceiling', () => {
    const result = launch(['--wait', '--', '/bin/sh', '-c', 'exit 0']);
    expect(result.limits).toEqual([result.originalHard, result.originalHard]);
    expect(result.argv).toEqual([
      '/usr/bin/gnome-terminal', '--disable-factory', '--wait', '--', '/bin/sh', '-c', 'exit 0',
    ]);
  });

  it('does not mistake child command arguments for terminal grouping options', () => {
    expect(launch(['--', 'example', '--app-id=child', 'a b', '$literal']).argv).toEqual([
      '/usr/bin/gnome-terminal', '--disable-factory', '--', 'example', '--app-id=child', 'a b', '$literal',
    ]);
  });

  it.each([['--app-id=chosen'], ['--app-id', 'chosen'], ['--disable-factory'], ['--help'], ['--version']])(
    'preserves explicit grouping or informational flags: %j', (...arguments_) => {
      expect(launch(arguments_).argv).toEqual(['/usr/bin/gnome-terminal', ...arguments_]);
    },
  );

  it('routes desktop and new-window actions through Exec instead of the exhausted D-Bus factory', () => {
    const desktop = readFileSync(resolve(__dirname, '../systemd/gnome-terminal-safe.desktop'), 'utf8');
    expect(desktop).toMatch(/^DBusActivatable=false$/m);
    expect(desktop).toMatch(/^Exec=gnome-terminal$/m);
    expect(desktop).toMatch(/^Exec=gnome-terminal --window$/m);
  });
});
