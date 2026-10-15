import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// PROBE_SCRIPT lets scripts/mutation-probe.sh point the test at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? path.join(__dirname, 'stage-driver.sh');

describe('vm/stage-driver.sh (fake repo via STAGE_ROOT, faked gcloud)', () => {
  let root: string;
  const put = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  const gcloudLog = () => path.join(root, 'gcloud.log');

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'stage-driver-'));
    put('scripts/agent-capacity/driver.ts', "import { a } from '@papercusp/operator-core/lib/child-output';\nimport {\n  b,\n} from '@papercusp/operator-core/lib/util/cli-entry';\nimport { c } from './sibling';\n");
    put('scripts/agent-capacity/sibling.ts', "import path from 'node:path';\n");
    // A test's imports are not part of what runs on the VM.
    put('scripts/agent-capacity/driver.test.ts', "import { z } from '@papercusp/operator-core/lib/test-only';\n");
    put('scripts/agent-capacity/corpus/tasks.json', '{"version":1,"tasks":[]}\n');
    put('scripts/agent-capacity/vm/ramp.sh', '#!/usr/bin/env bash\n');
    put('scripts/agent-capacity/vm/sample.py', '\n');
    put('packages/operator-core/lib/child-output.ts', "import { StringDecoder } from 'node:string_decoder';\nimport type { ChildProcess } from 'node:child_process';\n");
    put('packages/operator-core/lib/util/cli-entry.ts', "import { realpathSync } from 'node:fs';\n");
    // Logs every call; with FAKE_VM_HOME set it is also a fake VM: ssh runs --command under
    // HOME=FAKE_VM_HOME, scp copies the sources to FAKE_VM_HOME/<dest>.
    put(
      'bin/gcloud',
      `#!/usr/bin/env bash
echo "$*" >> "${gcloudLog()}"
[ -n "\${FAKE_VM_HOME:-}" ] || exit 0
verb="$1 $2"; shift 2
case "$verb" in
  "compute ssh") for a in "$@"; do case "$a" in --command=*) HOME="$FAKE_VM_HOME" bash -c "\${a#--command=}" || exit $?;; esac; done ;;
  "compute scp") srcs=(); for a in "$@"; do case "$a" in --*) ;; *) srcs+=("$a");; esac; done
    dest="\${srcs[-1]#*:}"; unset 'srcs[-1]'; cp "\${srcs[@]}" "$FAKE_VM_HOME/$dest" ;;
esac
`,
    );
    chmodSync(path.join(root, 'bin', 'gcloud'), 0o755);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run = (env: Record<string, string> = {}) =>
    spawnSync('bash', [SCRIPT, 'cap-x', 'proj', 'zone-a'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, STAGE_ROOT: root, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, ...env },
    });

  it('copies the driver, corpus, vm scripts and every imported operator-core leaf module into the VM scripts/node_modules', () => {
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^STAGE_OK vm=cap-x scripts=2 operatorCore=2 \(lib\/child-output lib\/util\/cli-entry\)$/m);
    const calls = readFileSync(gcloudLog(), 'utf8').trim().split('\n');
    const nm = 'cap-x:capacity/scripts/node_modules/@papercusp/operator-core';
    expect(calls[0]).toMatch(/^compute ssh cap-x --project=proj --zone=zone-a --command=mkdir -p .*~\/capacity\/scripts\/node_modules\/@papercusp\/operator-core\/lib\/util /);
    expect(calls[0]).toContain('"name":"@papercusp/operator-core"');
    expect(calls).toContain(`compute scp --project=proj --zone=zone-a --quiet scripts/agent-capacity/driver.ts scripts/agent-capacity/sibling.ts cap-x:capacity/scripts/agent-capacity/`);
    expect(calls).toContain(`compute scp --project=proj --zone=zone-a --quiet scripts/agent-capacity/corpus/tasks.json cap-x:capacity/scripts/agent-capacity/corpus/`);
    expect(calls).toContain(`compute scp --project=proj --zone=zone-a --quiet scripts/agent-capacity/vm/ramp.sh scripts/agent-capacity/vm/sample.py cap-x:capacity/scripts/agent-capacity/vm/`);
    expect(calls).toContain(`compute scp --project=proj --zone=zone-a --quiet packages/operator-core/lib/child-output.ts ${nm}/lib/child-output.ts`);
    expect(calls).toContain(`compute scp --project=proj --zone=zone-a --quiet packages/operator-core/lib/util/cli-entry.ts ${nm}/lib/util/cli-entry.ts`);
    expect(calls.join('\n')).not.toContain('test-only');
  });

  it('stages operator-core where a later npm install in ~/capacity cannot prune it, and the driver still resolves it', () => {
    // WI-10005355: the bring-up runs `npm init -y && npm install tsx@4` in ~/capacity AFTER staging, and
    // npm prunes an undeclared package from ~/capacity/node_modules (measured; two ramp preflights failed).
    const vm = path.join(root, 'vmhome');
    mkdirSync(vm);
    const r = run({ FAKE_VM_HOME: vm });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const home = realpathSync(vm);
    // npm's reach is ~/capacity/node_modules, so deleting all of it is the worst case of that prune.
    rmSync(path.join(home, 'capacity', 'node_modules'), { recursive: true, force: true });
    const driver = path.join(home, 'capacity/scripts/agent-capacity/driver.ts');
    expect(existsSync(driver)).toBe(true);
    const req = createRequire(driver);
    for (const m of ['lib/child-output', 'lib/util/cli-entry']) {
      expect(req.resolve(`@papercusp/operator-core/${m}.ts`)).toBe(
        path.join(home, `capacity/scripts/node_modules/@papercusp/operator-core/${m}.ts`),
      );
    }
  });

  it('refuses, before touching the VM, an imported module that is not a leaf', () => {
    put('packages/operator-core/lib/child-output.ts', "import { x } from './util/other';\nimport { StringDecoder } from 'node:string_decoder';\n");
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/STAGE_ERROR packages\/operator-core\/lib\/child-output\.ts imports \.\/util\/other - not a leaf module/);
    expect(existsSync(gcloudLog())).toBe(false);
  });

  it('refuses an import whose module does not exist, and a missing corpus tasks.json', () => {
    rmSync(path.join(root, 'packages/operator-core/lib/util/cli-entry.ts'));
    let r = run();
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/STAGE_ERROR packages\/operator-core\/lib\/util\/cli-entry\.ts \(imported as @papercusp\/operator-core\/lib\/util\/cli-entry\) does not exist/);
    put('packages/operator-core/lib/util/cli-entry.ts', '\n');
    rmSync(path.join(root, 'scripts/agent-capacity/corpus'), { recursive: true });
    r = run();
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/STAGE_ERROR no scripts\/agent-capacity\/corpus\/tasks\.json/);
    expect(existsSync(gcloudLog())).toBe(false);
  });
});
