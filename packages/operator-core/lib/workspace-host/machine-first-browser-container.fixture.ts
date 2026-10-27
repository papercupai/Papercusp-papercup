/** Owned SSH prerequisite for the maintained machine-first browser runtime.
 * Run beneath scripts/with-private-podman.mjs, with --evidence-dir <fresh-dir>.
 * The container has its own network/SSH accounts; no host SSH state is changed.
 * Use its recorded container identity for browser commands in the same network.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDockerAllocationOwner } from '../../../../scripts/with-documenso-sandbox.mjs';
import {
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_HOSTED_PTY_KNOWN_HOSTS,
  WORKSPACE_HOST_HOSTED_PTY_SSH_KEY,
} from '../../../../libs/generic/deployment-driver/src/workspace-host-bootstrap';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--evidence-dir' && args[1],
  'Use --evidence-dir <fresh-directory> beneath with-private-podman.mjs');
assert(process.env.DOCKER_HOST?.startsWith('unix://'), 'Requires the maintained private Podman API');
assert(process.getuid?.() === 1000, 'This fixture currently requires the dev account UID 1000');
const evidence = resolve(args[1]);
await mkdir(evidence, { mode: 0o700 });
// The service UID is mapped to a subordinate host UID by rootless Podman.
// Give it an output mount underneath the caller's private 0700 parent; the
// browser credential itself is still 0600 and removed after container cleanup.
const runtimeEvidence = join(evidence, 'runtime');
await mkdir(runtimeEvidence);
await chmod(runtimeEvidence, 0o777);
// Reuse the maintained owner's validated identity namespace.
const root = await mkdtemp(join(tmpdir(), 'pc-personal-ssh-'));
const name = `pc-personal-ssh-${randomUUID()}`;
const state: Record<string, unknown> = { container: name, evidence, sourceRoot: repo,
  runtimeEvidenceDirectory: runtimeEvidence,
  dockerHost: process.env.DOCKER_HOST, startedAt: new Date().toISOString(),
  scope: 'One owned container network with two enrolled source operator processes; not release proof' };
const save = () => writeFile(join(evidence, 'container.json'), JSON.stringify(state, null, 2));
let owner: Awaited<ReturnType<typeof startDockerAllocationOwner>> | undefined;
let waiter: ReturnType<typeof spawn> | undefined;
let stopping = false;
const stop = () => { stopping = true; waiter?.kill('SIGTERM'); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const deadline = setTimeout(stop, 20 * 60_000);
try {
  owner = await startDockerAllocationOwner({ name, root });
  const docker = (argv: string[]) => owner!.run(argv, {}, { pendingAfterMs: 20_000 });
  const image = (await docker(['image', 'inspect', '--format', '{{.Id}}', 'debian:stable-slim'])).trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  state.image = image;
  const nodeRoot = dirname(dirname(process.execPath));
  const bootstrap = [
    'set -eu',
    'apt-get update -qq',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server openssl git ca-certificates curl python3 fontconfig fonts-dejavu-core libstdc++6 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64',
    // The isolated-PG wrapper deliberately removes inherited GIT_CONFIG_*.
    // Trust only this read-only source mount in the disposable container.
    'git config --system --add safe.directory ' + repo,
    'groupadd -g 1000 mf-service; useradd -m -u 1000 -g 1000 -s /bin/bash mf-service',
    'service_home="$(getent passwd mf-service | cut -d: -f6)"',
    '[ -n "$service_home" ] && [ -d "$service_home" ]',
    `useradd -m -u 1001 -G mf-service -s /bin/bash ${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}`,
    // Password login remains disabled; a locked account is rejected by sshd
    // before public-key verification when UsePAM=no.
    `usermod -p '*' ${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}`,
    'install -d -m 0755 /run/sshd',
    `install -d -o mf-service -g mf-service -m 0700 ${dirname(WORKSPACE_HOST_HOSTED_PTY_SSH_KEY)}`,
    `runuser -u mf-service -- ssh-keygen -q -t ed25519 -N '' -f ${WORKSPACE_HOST_HOSTED_PTY_SSH_KEY}`,
    `install -d -o ${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER} -g ${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER} -m 0700 /home/${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}/.ssh`,
    `printf 'restrict,pty,from="127.0.0.1" %s\\n' "$(cat ${WORKSPACE_HOST_HOSTED_PTY_SSH_KEY}.pub)" > /home/${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}/.ssh/authorized_keys`,
    `chown ${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}:${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER} /home/${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}/.ssh/authorized_keys`,
    `chmod 0600 /home/${DEFAULT_WORKSPACE_HOST_WORKSPACE_USER}/.ssh/authorized_keys`,
    `printf '127.0.0.1 %s\\n' "$(cut -d ' ' -f 1,2 /etc/ssh/ssh_host_ed25519_key.pub)" > ${WORKSPACE_HOST_HOSTED_PTY_KNOWN_HOSTS}`,
    `chown mf-service:mf-service ${WORKSPACE_HOST_HOSTED_PTY_KNOWN_HOSTS}`,
    `chmod 0600 ${WORKSPACE_HOST_HOSTED_PTY_KNOWN_HOSTS}`,
    '/usr/sbin/sshd -e -o ListenAddress=127.0.0.1 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o UsePAM=no -o AllowUsers=' + DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
    'exec runuser -u mf-service -- env HOME="$service_home" PATH=' + nodeRoot + '/bin:/usr/local/bin:/usr/bin:/bin PLAYWRIGHT_BROWSERS_PATH=/ms-playwright MACHINE_FIRST_RUNTIME_CONTAINER_SSH=1 MACHINE_FIRST_RUNTIME_EVIDENCE=/evidence/runtime ' + process.execPath + ' scripts/with-test-pg.mjs --isolated-runtime=operator-api -- ' + process.execPath + ' --import tsx packages/operator-core/lib/workspace-host/machine-first-browser-runtime.fixture.ts --local-gui',
  ].join('\n') + '\n';
  await writeFile(join(root, 'bootstrap.sh'), bootstrap, { mode: 0o700 });
  const browserCache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.HOME!, '.cache/ms-playwright');
  await docker(['create', '--name', name, '--label', `papercusp.test.owner=${name}`,
    '--user=0', '--workdir', repo,
    '--mount', `type=bind,source=${repo},target=${repo},readonly`,
    '--mount', `type=bind,source=${nodeRoot},target=${nodeRoot},readonly`,
    '--mount', `type=bind,source=${browserCache},target=/ms-playwright,readonly`,
    '--mount', `type=bind,source=${root},target=/fixture,readonly`,
    '--mount', `type=bind,source=${runtimeEvidence},target=/evidence`,
    image, '/bin/sh', '/fixture/bootstrap.sh']);
  await docker(['start', name]);
  state.status = 'started';
  await save();
  console.log(JSON.stringify({ status: 'started', evidence, container: name }));
  if (!stopping) {
    waiter = spawn('docker', ['wait', name], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let result = '';
    waiter.stdout!.on('data', chunk => { result += chunk; });
    const waitCode = await new Promise<number | null>((done, fail) => {
      waiter!.once('error', fail); waiter!.once('close', done);
    });
    if (!stopping) {
      assert.equal(waitCode, 0, 'Docker wait must complete');
      assert.match(result.trim(), /^\d+$/);
      state.exitCode = Number(result.trim());
      process.exitCode = Number(result.trim());
    }
  }
  // Docker sends the container's stderr to its own stderr. The allocation
  // owner's stdout-only command result would otherwise discard startup errors.
  const log = await open(join(evidence, 'container.log'), 'w', 0o600);
  try {
    const reader = spawn('docker', ['logs', name], { env: process.env,
      stdio: ['ignore', log.fd, log.fd] });
    await new Promise<void>((done, fail) => {
      reader.once('error', fail);
      reader.once('close', code => code === 0 ? done() : fail(new Error(`Docker logs exited ${code}`)));
    });
  } finally { await log.close(); }
} catch (error) {
  state.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  try { if (owner) state.cleanup = await owner.close(); }
  catch (error) { state.cleanupError = String(error); process.exitCode = 1; }
  if (!owner) await rm(root, { recursive: true, force: true });
  // The allocation owner first removes the container, then this exact private
  // browser credential. The evidence directory itself remains for readback.
  await rm(join(runtimeEvidence, 'runtime.auth.json'), { force: true });
  state.stoppedAt = new Date().toISOString(); state.status = 'stopped';
  await save();
  process.off('SIGTERM', stop); process.off('SIGINT', stop);
  console.log(JSON.stringify({ status: state.status, cleanup: state.cleanup, failure: state.failure }));
}
