# Shared-host CPU performance policy — installation (WI-37533)

papercusp-host-performance.service sets both cpufreq's governor and the
independent `amd-pstate-epp` preference to `performance` on every CPU policy. It
resolves the physical disk or disks backing `/` and selects mq-deadline when
the kernel offers it. It verifies the scheduler read-back and fails if the root
disk or scheduler control cannot be resolved, so an active unit cannot imply
that the requested disk policy was skipped. It also reserves 18,000 × 2 MiB
huge pages before PostgreSQL starts. The unit is a
`RequiredBy` dependency of `postgresql@18-main.service`: if Linux cannot reserve
all pages, it fails loud and PostgreSQL does not start with a silent
`huge_pages=try` fallback.

⚠ Because PostgreSQL `Requires=` this unit, stopping or restarting it stops or
restarts the shared PostgreSQL too (WI-10004865: one `systemctl restart` caused a
3.5-minute fleet-wide DB outage). The unit therefore sets `RefuseManualStop=yes`,
so `systemctl stop|restart` is refused. To re-apply the policy after editing the
script, re-install it and RELOAD — never restart:

```bash
sudo install -o root -g root -m 0755 papercusp-host-performance.sh \
  /etc/systemd/system/papercusp-host-performance.sh
sudo systemctl reload papercusp-host-performance.service
```
The unit is ordered `After=power-profiles-daemon.service`. That daemon re-applies
its persisted profile when it starts, and under `amd-pstate-epp` the `balanced`
profile writes `powersave` to every policy. Without the ordering it raced the
sweep at boot, the read-back failed partway through, and PostgreSQL stayed down
with `result 'dependency'`. To recover a host that booted into that state:
`sudo systemctl start papercusp-host-performance.service` (it is failed, so
`start` is allowed), then `sudo systemctl start postgresql@18-main.service`, then
`systemctl --user reset-failed` any operator host that hit its start limit.

The shared development host has no battery and runs latency-sensitive PostgreSQL,
Node, TypeScript and git work continuously; the stock `powersave` governor kept
all 128 logical CPUs near base clock even though hardware boost was enabled.

Install root-owned copies so a privileged boot unit never executes a script from
the user-writable shared checkout:

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
sudo install -o root -g root -m 0755 papercusp-host-performance.sh \
  /etc/systemd/system/papercusp-host-performance.sh
sudo install -o root -g root -m 0644 papercusp-host-performance.service \
  /etc/systemd/system/papercusp-host-performance.service
sudo systemctl daemon-reload
sudo systemctl enable --now papercusp-host-performance.service
```

Verify the effective policy, not merely the unit state:

```bash
systemctl is-enabled papercusp-host-performance.service
systemctl is-active papercusp-host-performance.service
for f in /sys/devices/system/cpu/cpufreq/policy*/scaling_governor; do cat "$f"; done | sort -u
for f in /sys/devices/system/cpu/cpufreq/policy*/energy_performance_preference; do cat "$f"; done | sort -u
ROOT_SOURCE="$(findmnt -nro SOURCE / | cut -d '[' -f 1)"
lsblk --inverse --noheadings --raw --output KNAME,TYPE "$ROOT_SOURCE" |
  awk '$2 == "disk" { print $1 }' |
  while IFS= read -r disk; do printf '%s: ' "$disk"; cat "/sys/block/$disk/queue/scheduler"; done
cat /proc/sys/vm/nr_hugepages
sudo -u postgres psql -tAc "show shared_memory_size_in_huge_pages; show huge_pages; show huge_pages_status"
```

Both CPU populations must contain only `performance`, every root backing disk
must show mq-deadline as the selected scheduler, `nr_hugepages` must be at least 18,000, and PostgreSQL
must report `huge_pages=on` plus
`huge_pages_status=on`. A live fragmented host may accept only part of the
reservation; the service deliberately fails in that case. Reboot so allocation
happens before PostgreSQL consumes ~32 GiB, then run
`npx tsx scripts/pg-autotune.ts --apply` through the normal DB-resource drain.

Record each root disk's previous scheduler before a manual update. Roll back with
`sudo systemctl disable papercusp-host-performance.service` (no `--now`: the stop is
refused, and would stop PostgreSQL), remove the two installed files, daemon-reload,
and write the prior CPU/EPP, huge-page and root scheduler settings back through
sysfs. The oneshot stays nominally active until the next reboot, which is harmless.

---

# Root user-manager watchdog — installation (EI-14906)

`papercusp-user-manager-watchdog.{service,timer}` is the recovery actor for a
failure that user-scoped monitoring cannot repair: `user@1000.service` itself
dying. The timer runs under the system manager, verifies that uid 1000 still has
linger enabled, and waits for two observations spanning at least 60 seconds before
starting the manager. `activating`, `deactivating`, and `reloading` states reset
the observation window, so a deliberate restart cannot race the watchdog.

**Linger is read from the DURABLE marker `/var/lib/systemd/linger/<username>`,
never from `loginctl` alone (WI-1430770).** `loginctl show-user` queries logind's
LIVE user object, which is destroyed once the user manager exits and the last
session is removed — so it exits 1 with *"User ID N is not logged in or
lingering"* EXACTLY when the manager is down. This script used to gate on that
call and treat the failure as fatal, which made its enabling check succeed only
while it had nothing to do. On 2026-08-30 the user manager was SIGTERMed at
21:32:45; the watchdog then failed on that single line once a minute for 13
consecutive runs while the desktop session and the entire agent fleet stayed
down, until the owner logged back in by hand at 21:46:37 — 13m52s. `loginctl` is
now only corroboration, and its failure is an ordinary observation of a down
manager. The healthy-path log line names which source answered, so a regression
is visible in the journal before it costs anything:

```
healthy: user@1000.service is active (linger source: /var/lib/systemd/linger/<username>)
```

If that ever reads `linger source: loginctl` on a host where the marker should
exist, the watchdog is one manager-exit away from being inert again.

## Install or update

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
sudo install -o root -g root -m 0755 papercusp-user-manager-watchdog.sh \
  /etc/systemd/system/papercusp-user-manager-watchdog.sh
sudo install -o root -g root -m 0644 papercusp-user-manager-watchdog.service \
  /etc/systemd/system/papercusp-user-manager-watchdog.service
sudo install -o root -g root -m 0644 papercusp-user-manager-watchdog.timer \
  /etc/systemd/system/papercusp-user-manager-watchdog.timer
sudo systemctl daemon-reload
sudo systemctl enable --now papercusp-user-manager-watchdog.timer
```

Install root-owned copies rather than symlinks. A system service must never load
its unit or root-executed script from the user-writable shared checkout.

The checked-in service targets uid 1000. On a host where the Papercusp operator
account has another uid, install a system drop-in that overrides
`PAPERCUSP_USER_MANAGER_WATCHDOG_UID`; do not edit the checked-in unit.

## Verify

```bash
systemd-analyze verify /etc/systemd/system/papercusp-user-manager-watchdog.service \
  /etc/systemd/system/papercusp-user-manager-watchdog.timer
systemctl is-enabled papercusp-user-manager-watchdog.timer
systemctl is-active papercusp-user-manager-watchdog.timer
sudo systemctl start papercusp-user-manager-watchdog.service
journalctl -u papercusp-user-manager-watchdog.service --since "5 min ago" --no-pager
```

A healthy manual run logs `user@1000.service is active` and clears any stale
`/run/papercusp-user-manager-watchdog/user-1000.down-since` marker. Test the
actual repair path only in an attended maintenance window: stopping the user
manager intentionally stops every Papercusp user service and the desktop
session's service plane.

## Roll back

```bash
sudo systemctl disable --now papercusp-user-manager-watchdog.timer
sudo rm -f /etc/systemd/system/papercusp-user-manager-watchdog.{service,timer,sh}
sudo systemctl daemon-reload
```

---

# Operator boot-availability check — user-unit installation (WI-10006021)

`papercusp-operator-boot-availability.{service,timer}` samples
`http://127.0.0.1:3070/api/health` once a minute, starting 60 seconds after the
user manager starts. It reads `user@1000.service`'s monotonic active-enter time,
records the first healthy sample for that manager lifetime, and logs an
`ALERT` if the endpoint is still unavailable after 10 minutes. The check runs
from `timers.target` and has no ordering edge to `default.target`, so it can
report an API job waiting on that target. It only observes availability; it
does not restart the manager or operator unit. The separate root
`papercusp-user-manager-watchdog` remains the recovery actor when the user
manager itself is down.

## Install or update

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
install -Dm0644 papercusp-operator-boot-availability.service \
  "$HOME/.config/systemd/user/papercusp-operator-boot-availability.service"
install -Dm0644 papercusp-operator-boot-availability.timer \
  "$HOME/.config/systemd/user/papercusp-operator-boot-availability.timer"
systemctl --user daemon-reload
systemctl --user enable --now papercusp-operator-boot-availability.timer
```

## Verify

```bash
systemd-analyze --user verify \
  "$HOME/.config/systemd/user/papercusp-operator-boot-availability.service" \
  "$HOME/.config/systemd/user/papercusp-operator-boot-availability.timer"
systemctl --user is-enabled papercusp-operator-boot-availability.timer
systemctl --user is-active papercusp-operator-boot-availability.timer
systemctl --user start papercusp-operator-boot-availability.service
journalctl --user -u papercusp-operator-boot-availability.service --since "5 min ago" --no-pager
```

The first healthy line reports the elapsed time from `user@1000.service` start
to the first successful health sample. If the timer's first healthy sample
arrives after the 10-minute window, it says the startup window was not observed
instead of presenting a late probe as the boot latency. If the endpoint remains
unavailable at the deadline, the failed oneshot records an `ALERT` in the user
journal. A successful sample clears the per-manager alert marker; restarting
the user manager begins a new measurement.

## Roll back

```bash
systemctl --user disable --now papercusp-operator-boot-availability.timer
rm -f "$HOME/.config/systemd/user/papercusp-operator-boot-availability.service"
rm -f "$HOME/.config/systemd/user/papercusp-operator-boot-availability.timer"
systemctl --user daemon-reload
```

---

# User-manager signal audit — installation (WI-1430770)

`papercusp-usermgr-signal-audit.{service,timer}` is the FORENSIC half of the
watchdog above: it arms an audit rule recording every `kill()`/`tgkill()` aimed
at the current main process of `user@1000.service`, so a signal that tears the
manager down names its sender.

**Why it exists.** When the manager was SIGTERMed on 2026-08-30, the sender could
not be identified at all. This host's audit rules capture only signal 9
(`-S kill -F a1=0x9 -k sigkill`) and only `execve` of the session binaries
(`systemctl`/`loginctl`/`pkill`/`killall`/`kill`/`gnome-session-quit`/`systemd-run`,
`-k session_ctl`). A direct in-process `kill(pid, SIGTERM)` matches neither and
leaves no trace. The rule is pinned to one pid, so it closes that gap for the
process whose death costs the whole box while adding no measurable audit volume.

The rule is pid-pinned, so it is re-armed every minute: the manager's MainPID
changes on every restart, and an auditd restart flushes the ruleset outright.

This is a SEPARATE unit rather than a few lines inside the watchdog on purpose.
`auditctl` speaks `NETLINK_AUDIT`, and the watchdog runs with
`RestrictAddressFamilies=AF_UNIX`. Widening the recovery actor's sandbox to carry
a forensic nicety would be a bad trade — nothing should enlarge the failure
surface of the thing whose job is to come back up.

## Install or update

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
sudo install -o root -g root -m 0755 papercusp-usermgr-signal-audit.sh \
  /etc/systemd/system/papercusp-usermgr-signal-audit.sh
sudo install -o root -g root -m 0644 papercusp-usermgr-signal-audit.service \
  /etc/systemd/system/papercusp-usermgr-signal-audit.service
sudo install -o root -g root -m 0644 papercusp-usermgr-signal-audit.timer \
  /etc/systemd/system/papercusp-usermgr-signal-audit.timer
sudo systemctl daemon-reload
sudo systemctl enable --now papercusp-usermgr-signal-audit.timer
```

## Verify

```bash
sudo systemctl start papercusp-usermgr-signal-audit.service
journalctl -u papercusp-usermgr-signal-audit.service --since "5 min ago" --no-pager
sudo auditctl -l | grep usermgr_signal
```

A positive control, safe to run at any time — signal 0 is a permission check that
delivers nothing, and the rule matches on the target pid regardless of signal:

```bash
kill -0 "$(systemctl show user@1000.service -p MainPID --value)"
sudo ausearch -k usermgr_signal -ts recent
```

The resulting `SYSCALL` record carries `syscall=62` (kill), `a0` = the target pid
in hex, `a1` = the signal, and — the point of the whole exercise — the sender's
`pid`, `ppid`, `auid`, `comm`, `exe`, and full `PROCTITLE`.

**Known limit, stated rather than assumed away:** `pidfd_send_signal` carries a
pidfd in `a0`, not a pid, so it cannot be filtered this way. A sender using it
stays invisible to this rule.

## Read it after an incident

```bash
sudo ausearch -k usermgr_signal -ts today
```

## Roll back

```bash
sudo systemctl disable --now papercusp-usermgr-signal-audit.timer
sudo auditctl -l | grep usermgr_signal   # then -d the listed rule if still loaded
sudo rm -f /etc/systemd/system/papercusp-usermgr-signal-audit.{service,timer,sh}
sudo systemctl daemon-reload
```

---

# Marketplace API — installation

`marketplace-api.service` keeps the registry API on `:3057`. It deliberately
runs the package's non-watching `start` script: the `dev` watcher can survive a
crashed server child, leaving systemd active while `/healthz` is unreachable.

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
ln -sfn "$(pwd)/marketplace-api.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now marketplace-api.service
curl --fail --silent http://127.0.0.1:3057/healthz
```

Verify the live unit resolves to this repo source and that its effective
`ExecStart` contains `npm start`, never `npm run dev`.

---

# Cloud Portal backend — installation (EI-21983147886595945)

The canonical hosted launcher owns HTTP readiness and watchdog supervision.
It extends the shared `systemd-readiness.ts` transport with one persistent
`python3`/`libsystemd` sender in the service cgroup, instead of spawning a
short-lived `systemd-notify --no-block` for every ping. The Linux host therefore
needs Python 3 and `libsystemd` (both present on the supported systemd host).
The Portal child receives no `NOTIFY_SOCKET` or `WATCHDOG_*` ownership variables;
this avoids competing heartbeat senders without modifying its separate checkout.
Readiness still requires HTTP success, watchdog pings still require a successful
health probe, and unhealthy HTTP still withdraws the service. Neither the
watchdog limit nor those health gates are disabled. The real-systemd integration
suite checks manager-credited timestamps, blackhole withdrawal, and a negative
control whose successful-looking attempts deliver no heartbeats.

`papercusp-cloud-portal.service` supervises the Portal's built Next.js
standalone production artifact on `127.0.0.1:3801`. Run `npm run build` in the
Portal checkout first; the build uses a unique private `distDir`, moves the
completed output into the checkout sibling
`../.portal-runtime/portal/releases/<generation>`, and atomically retargets its
`current` link. Keeping generated releases outside the checkout prevents a
standalone trace from recursively copying its own release history into every
new artifact. The service launches through
`scripts/start-web.mjs`, which resolves that pointer once and keeps serving the
immutable selected generation. A later or concurrent build therefore cannot
delete the running process's JS/CSS/static files while preparing the next
generation. The service uses `Type=notify`: the launcher keeps systemd in
`activating` until a bounded `127.0.0.1:3801` HTTP probe first returns 200, then
sends `READY=1`. After startup it sends the systemd watchdog heartbeat only
after a fresh successful HTTP probe; a bounded probe failure terminates the
launcher and makes the unit fail/restart instead of remaining `active` while
the backend blackholes. The checked-in
`papercusp-cloud-portal.service.in` is a machine-neutral template; the deploy
helper resolves the external Portal checkout and Node binary at install time.
The Portal's own `.env.local` remains in that external checkout and is loaded by
the unit as an external `EnvironmentFile`; it is never copied into the portable
artifact or the checked-in template.

Validate/render and install the unit without touching the currently running
backend:

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
export PAPERCUSP_CLOUD_PORTAL_ROOT="$HOME/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/portal"
# Optional: override the default sibling runtime store.
# export PAPERCUSP_CLOUD_PORTAL_RUNTIME_ROOT="$HOME/.papercusp/runtime/cloud-portal"
export PAPERCUSP_CLOUD_PORTAL_NODE="$HOME/.local/node25/bin/node"
bash ./deploy-cloud-portal.sh --install-only
systemd-analyze verify "$HOME/.config/systemd/user/papercusp-cloud-portal.service"
systemctl --user show papercusp-cloud-portal.service \
  -p ActiveState -p SubState -p MainPID -p ControlGroup -p ExecStart \
  -p Type -p NotifyAccess -p WatchdogUSec
```

Use the explicit handoff mode for an existing terminal-scoped `next dev`; the
replacement service runs the already-built standalone artifact:

```bash
bash ./deploy-cloud-portal.sh --handoff
curl --fail --silent --show-error http://127.0.0.1:3801/
curl --fail --silent --show-error http://127.0.0.1:3081/
```

The helper validates the listener's PID, user, Portal cwd, and `next dev`
lineage before sending SIGTERM to its process group. Because both generations
must bind the same TCP port, the cutover has a bounded outage window; the
helper health-checks the new unit and restores the prior command if startup or
health fails. It atomically refreshes the versioned
`papercusp-cloud-portal-proxy.mjs` program in `$HOME/.local/bin`, but never stops
or restarts `papercusp-cloud-portal-3081.service`, the persistent front-door
proxy. The proxy holds safe GET/HEAD requests through the bounded backend gap;
state-changing requests are never replayed. After the proxy program itself
changes, restart that proxy unit once to activate it. Re-running handoff against
a healthy managed backend is idempotent.

The helper stages the unit in a same-filesystem temporary directory before the
atomic rename. It uses `$TMPDIR` (or `/tmp`) by default and automatically falls
back to `/var/tmp` when `/tmp` is a separate `tmpfs`;
set `PAPERCUSP_CLOUD_PORTAL_TMPDIR` explicitly only to a directory on the same
filesystem as the user-unit directory.

Rollback after a successful handoff:

```bash
systemctl --user disable --now papercusp-cloud-portal.service
systemctl --user daemon-reload
```

If the helper reports that its automatic rollback could not restore the legacy
listener, inspect `$HOME/.papercusp/logs/cloud-portal-legacy.log` and start the
same command from the Portal checkout manually; do not stop the `:3081` proxy.

---

# Dedicated bg-host drop-ins — installation (EI-21434335931587523, EI-22359055031706978)

`papercup-bg-host.service` owns the DBOS routines, git-sync, and substrate
background machinery. Its versioned `95-bundled-entry.conf` rebuilds the host
bundle from the shared checkout in `ExecStartPre`, then starts
`dist-host/hono-host.mjs` with the base unit's complete port/DBOS environment.
Its `97-gateway-systemd-authority.conf` sets
`PAPERCUSP_GATEWAY_SUPERVISE=0` on this Linux/systemd host so the dedicated
`papercup-inference-gateway.service` is the single `:8788` authority. Without
that pin, a bg-host boot while the dedicated unit is absent can spawn the
cross-platform fallback first; the later systemd start then crash-loops on
`EADDRINUSE` even though the fallback gateway is serving. Packaged
macOS/Windows hosts do not load this drop-in and retain the fallback supervisor.
The 98-dependency-generation-root.conf drop-in directs the immutable dependency
generation store to /mnt/data/papercusp-dependency-generations, on the
dedicated data mount rather than Docker's root filesystem. This reduces the
measured bg-host generation writer's overlap with Docker's root device; a
post-change Docker remeasurement is still needed to establish whether that
overlap caused the container-start stall.

The 99-mcp-proxy.conf drop-in routes MCP clients minted by the background host
through the separate `papercup-mcp-proxy-bg-host.service` (`:9271` → `:3271`).
Since WI-6554700010008332 (2026-10-11) that pin covers only orchestrator/blueprint
spawns such as release fixers, which must stay on bg-host's current build
(WI-212675). Its `PAPERCUSP_BG_HOST_AGENTS_MCP_BASE=http://127.0.0.1:9071` line moves
the SU sessions, resumes and console-launched agents bg-host starts to the live
proxy; delete that line to return them to `:9271`.
That proxy retries only upstream connection refusals, where the request has not
reached the host; post-connect failures are surfaced so a write is never replayed
after it may have run.

Every drop-in named in this section must be installed as a symlink so the
checked-in contracts remain the source of truth.

On this Linux development host, the packaged `papercusp-server.service` can
also start the cross-platform gateway fallback. When the dedicated
`papercup-inference-gateway.service` is installed, its host-only override keeps
that unit as the single `:8788` authority. The packaged base unit stays
default-on, so Linux installations without the dedicated gateway retain their
managed fallback.

## Install (one-time, on the shared development host)

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
mkdir -p ~/.config/systemd/user/papercup-bg-host.service.d
mkdir -p ~/.config/systemd/user/papercusp-server.service.d
sudo install -d -m 0750 -o "$(id -un)" -g "$(id -gn)" /mnt/data/papercusp-dependency-generations
ln -sfn "$(pwd)/papercup-bg-host.service.d/95-bundled-entry.conf" \
  ~/.config/systemd/user/papercup-bg-host.service.d/95-bundled-entry.conf
ln -sfn "$(pwd)/papercup-bg-host.service.d/97-gateway-systemd-authority.conf" \
  ~/.config/systemd/user/papercup-bg-host.service.d/97-gateway-systemd-authority.conf
ln -sfn "$(pwd)/papercusp-server.service.d/97-gateway-systemd-authority.conf" \
  ~/.config/systemd/user/papercusp-server.service.d/97-gateway-systemd-authority.conf
ln -sfn "$(pwd)/papercup-bg-host.service.d/98-dependency-generation-root.conf" ~/.config/systemd/user/papercup-bg-host.service.d/98-dependency-generation-root.conf
ln -sfn "$(pwd)/papercup-bg-host.service.d/99-mcp-proxy.conf" ~/.config/systemd/user/papercup-bg-host.service.d/99-mcp-proxy.conf
ln -sfn "$(pwd)/papercup-mcp-proxy-bg-host.service" ~/.config/systemd/user/papercup-mcp-proxy-bg-host.service
systemctl --user daemon-reload
systemctl --user enable --now papercup-mcp-proxy-bg-host.service
```

Do not copy the drop-in or edit the generated service. Do not restart bg-host or
papercusp-server as part of this installation; activate each override at its
next coordinated/managed restart.

The drop-in also carries `TimeoutStartSec=300`. That is not decoration and must not be
dropped: `ExecStartPre` time counts against `TimeoutStartSec` for `Type=simple`, and the
base unit inherits systemd's 90s default with nothing else raising it. The bundle was
measured at 36.61s warm on 2026-08-26 — a fit, but only ~2.5x margin on a host observed
that same day at load 421 with a measured degradation knee near load 230. If the start
job does blow the deadline, `Restart=always` (drop-in 40) + `RestartSec=5` +
`RestartSteps=0` retry the same losing boot, so the failure does not self-clear while the
load persists. Any unit that gains an `ExecStartPre` owns its start timeout too.

## Verify

```bash
node scripts/check-systemd-dropins-installed.mjs   # from the repo root
systemctl --user is-enabled papercup-mcp-proxy-bg-host.service
systemctl --user is-active papercup-mcp-proxy-bg-host.service
systemctl --user show papercup-bg-host.service --property=DropInPaths --value \
  | tr ' ' '\n' | grep 99-mcp-proxy.conf
```

That is the authoritative check and it is the one to trust: it reads the unit's live
`DropInPaths` and fails when a tracked drop-in is not actually loaded. It covers every
tracked `*.service.d/*.conf`, not just this one.

For a manual look:

```bash
systemd-analyze --user verify papercup-bg-host.service
systemctl --user show papercup-bg-host.service --property=DropInPaths --value \
  | tr ' ' '\n' | grep 95-bundled-entry.conf
systemctl --user show papercup-bg-host.service \
  -p WorkingDirectory -p ExecStartPre -p ExecStart -p TimeoutStartUSec
```

Check `DropInPaths` **first**. `ExecStartPre` alone cannot distinguish "the drop-in is
loaded" from "the drop-in is configured but the unit never picked it up" — and the second
is not hypothetical: this drop-in sat un-installed for a day after being committed, while
`bghost-bundled-entry.test.ts`, `bghost-watchdog.mjs` and `check-host-bundle-builds.mjs`
were all written as though it were active. None of them could see the host. See plan
`substrate-observability-bug-wave-2026-08-26` D-002/D-004.

Once loaded, the effective unit should show `bundle-host.sh` as `ExecStartPre` and
`node dist-host/hono-host.mjs` as the final command, `TimeoutStartUSec=5min`, and retain
the `PAPERCUSP_HONO_PORT=3271`, `PAPERCUSP_BACKGROUND_WORKERS=1`, and DBOS/routine
assignments from the base unit. It should also show
`PAPERCUSP_MCP_PROXY_BASE=http://127.0.0.1:9271`,
`PAPERCUSP_MCP_PROXY_TARGET_PORT=3271` and
`PAPERCUSP_BG_HOST_AGENTS_MCP_BASE=http://127.0.0.1:9071`. A configured drop-in is not proof that the
running service has loaded it; verify after the next managed restart.

---

# Clustered operator memory envelope — installation (EI-20340243384897336)

`papercup-dev-api.service.d/55-memory-envelope.conf` is the versioned,
service-wide cgroup policy for the 11-process `:3070` operator. It complements
the in-process memory watchdog: the watchdog recycles one leaking worker, while
`MemoryHigh` / `MemoryMax` / `MemorySwapMax` bound the aggregate cluster.

The drop-in also unsets the old `PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=12288`
service override. That variable is process-scoped; after clustering, it allowed
17 independent 12 GiB budgets rather than one 12 GiB service budget. Request
workers fall back to the code's role-aware process limit instead.

## Install (one-time, on the shared development host)

Do not activate this while a green-checkpoint run is in flight: restarting
`papercup-dev-api` also terminates descendants owned by the live checkpoint.
Once the checkpoint singleton has cleared:

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
mkdir -p ~/.config/systemd/user/papercup-dev-api.service.d
ln -sfn "$(pwd)/papercup-dev-api.service.d/55-memory-envelope.conf" \
  ~/.config/systemd/user/papercup-dev-api.service.d/55-memory-envelope.conf
systemctl --user daemon-reload
```

Use the managed operator restart door after acquiring the registered
`dev-server` resource lock; never raw-restart a shared service around peers.

## Verify

```bash
systemctl --user show papercup-dev-api.service \
  -p MemoryAccounting -p MemoryHigh -p MemoryMax -p MemorySwapMax -p Environment
systemd-analyze --user verify papercup-dev-api.service
```

Expected effective limits are `MemoryHigh=48G`, `MemoryMax=64G`, and
`MemorySwapMax=16G`, with no `PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB` in the unit's
effective environment. The later memory-envelope drop-in also overrides the
legacy `PAPERCUSP_CLUSTER=16` setting with `PAPERCUSP_CLUSTER_WORKERS=6` and
sets `PAPERCUSP_EXPECTED_OPERATOR_PROCS=7`. Verify the boot log names
`PAPERCUSP_CLUSTER_WORKERS=6`, `:3070` is healthy, and the running service has
six request workers plus one primary after the managed restart; a configured
drop-in is not proof the running cgroup loaded it.

---

# LLM testing nightly cron — installation

Plan §12 Phase 5.

## Install (one-time, ~3 minutes)

```bash
# 1. Symlink the unit + timer into the user systemd dir.
ln -sf "$(pwd)/llm-test-nightly.service" ~/.config/systemd/user/
ln -sf "$(pwd)/llm-test-nightly.timer"   ~/.config/systemd/user/

# 2. Expose ANTHROPIC_API_KEY to systemd-user. Either:
#    a. Edit the .service file's `# Environment=...` line, or
#    b. Drop a file at ~/.config/environment.d/anthropic.conf:
#       ANTHROPIC_API_KEY=sk-ant-...

# 3. Reload systemd-user and enable.
systemctl --user daemon-reload
systemctl --user enable --now llm-test-nightly.timer
```

## Verify

```bash
systemctl --user list-timers llm-test-nightly.timer
systemctl --user status   llm-test-nightly.service
```

## Manual run

```bash
systemctl --user start llm-test-nightly.service
journalctl --user -u llm-test-nightly.service -f
```

Or run the script directly:

```bash
./llm-test-nightly.sh
```

Logs land in `~/.papercusp/llm-test-logs/llm-test-<TS>.log`.

## What it does

Hits `papercusp-desktop`'s operator at `$PAPERCUSP_OPERATOR_URL`
(default `http://127.0.0.1:3055`). If the operator isn't reachable
the script exits 0 and you'll see "operator not reachable — skipping"
in the journal — better than firing a noisy failure when the laptop
is closed.

Otherwise it runs `pnpm llm-test --target operator --target oracle`
which exercises every registered scenario (15 today). Findings land
in `harness_shared.llm_test_findings` with `acknowledged=false`. New
errors surface in `/admin/testing?tab=llm&subtab=findings` — that's
the alert surface; no separate notification system needed.

The script also runs a small SQL summary at the end (passed / failed
/ errored counts per target, total cost) into the log.

## Cost envelope

Per the plan §9 cost math:

- 12 operator scenarios + 3 oracle scenarios = 15 scenarios
- Average matrix N=3 for judge-heavy scenarios (most are)
- Sonnet SUT + Sonnet judge: ~$1.50–2.50 per matrix
- Nightly total: ~$25–40 / run = ~$750–$1200 / month

Tighten by:

- Editing `LLM_TEST_TARGETS` in the .service to drop oracle
- Setting `LLM_TEST_SUT_MODEL=claude-haiku-4-5` to use Haiku for SUT
  (judges still Sonnet for cross-model bias mitigation)
- Switching the timer to `OnCalendar=Mon` (weekly instead of nightly)

## Tighten the cron cadence

Edit the `.timer` file's `OnCalendar=` line:

- `OnCalendar=*-*-* 03:30:00` — nightly at 03:30 (default)
- `OnCalendar=Mon *-*-* 03:30:00` — weekly Mondays
- `OnCalendar=*-*-* 09,21:00:00` — twice a day at 09:00 + 21:00

After editing: `systemctl --user daemon-reload && systemctl --user restart llm-test-nightly.timer`.

---

# perf-signals capture — installation

The host-side producer for the perf-signals-v1 SLO/CLOSE_WAIT guard
(`packages/operator-core/lib/system-health/perf-budgets.ts`, consumed by the infra
health panel AND the green-checkpoint perf-gate). Runs the read-only host probe
`../perf/capture-signals.py` on a 2-min cadence so the latest capture never goes
stale (`staleMs` = 10 min) and the budgets keep evaluating live. Without it the
guard silently degrades to `unknown` — the WI-324 finding (the capture had gone 62h
stale because nothing scheduled it). Deliberately a systemd timer, NOT a DBOS
scheduled workflow / in-process tick (dev-box host signals = infra monitoring, and a
per-tick DBOS workflow_status row is the high-freq bloat that froze the engine —
EI-1622 / dbos-scheduler-consolidation D-004).

## Install (one-time)

```bash
ln -sf "$(pwd)/papercup-perf-signals-capture.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-perf-signals-capture.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-perf-signals-capture.timer
```

## Verify

```bash
systemctl --user list-timers papercup-perf-signals-capture.timer
# newest capture should be < 2 min old:
ls -t ~/.papercusp/perf-baselines/*-scheduled.json | head -1
```

The wrapper (`../perf/capture-perf-signals.sh`) prunes to the newest 15
`*-scheduled.json` files (~30 min of history); ad-hoc/manual captures (other labels)
are never touched. If the timer dies, a capture older than `blindMs` (30 min) surfaces
on the infra panel as `warn` ("host SLO monitor blind") instead of silent `unknown`.

---

# Resilient MCP proxy — installation (OPT-IN)

`papercup-mcp-proxy.service` runs an always-up local proxy on `:9071` that forwards to
`:3070/api/mcp` and RETRIES across a `:3070` deploy restart (mcp-host-availability-resilience-2026-06-22
P-005). Point an MCP client (Claude Code) at the proxy and a `:3070` restart becomes
invisible — the client→proxy connection stays up, and a `tools/call` issued mid-restart
just waits a beat instead of erroring + stranding the session toolless. Code: `../../bin/mcp-proxy.ts`

- `../../lib/mcp-proxy/proxy.ts` (tested: `proxy.test.ts`).

SAFETY: the proxy RETRIES only a _refused_ upstream (the request provably never reached
`:3070`), never a post-connect error — so a non-idempotent `tools/call` is never double-applied.

## Install + run the proxy (harmless on its own — nothing connects until you repoint a client)

```bash
ln -sf "$(pwd)/papercup-mcp-proxy.service" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-mcp-proxy.service
# verify passthrough:
curl -s http://127.0.0.1:9071/api/health   # → the real :3070 health JSON
```

## Repoint a client at the proxy (the actual opt-in — ATTENDED cutover)

In `~/.claude.json`, change the `papercusp-su` server URL host:port from `localhost:3070`
to `localhost:9071` (keep the `?superuser=1&...` query + the bearer). Or set the psu
launcher's MCP URL env. Then VERIFY restart-survival before trusting it: force a `:3070`
deploy/restart (`PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute`)
and confirm an in-flight agent's native MCP tools keep working (no toolless session, no
relaunch). Leave the default config on `:3070` until that e2e passes — this is a fleet-wide
cutover, so the owner should green-light + attend it.

---

# Leaked-webview reaper — installation (WI-345 F12)

`papercup-webkit-reaper.{service,timer}` reaps runaway `WebKitWebProcess`
instances and stale `papercusp-desktop` processes left behind by agents
that spawned Tauri desktop sessions for UI verification and didn't clean up.

**Root cause:** When a Tauri desktop is killed (SIGKILL from an agent
finishing a task, a crash, or `tauri dev` watcher rebuilding), its
WebKitWebProcess children (managed by WebKitGTK) become orphans reparented
to PID 1. They continue spinning at 99% CPU on dead connections. Five of
these plus zombies caused visible CPU saturation on the shared dev box.

**Safety:** The reaper protects the NEWEST papercusp-desktop process (the
active user session). All older instances running > 30 min are stale test
instances. Orphaned WebKitWebProcess (ppid=1) older than 5 min are always
safe — their parent is definitively dead.

## Install (one-time)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
ln -sf "$(pwd)/papercup-webkit-reaper.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-webkit-reaper.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-webkit-reaper.timer
```

## Verify

```bash
systemctl --user list-timers papercup-webkit-reaper.timer
systemctl --user status papercup-webkit-reaper.service
```

## Manual run / dry-run

```bash
# Dry run (logs what it would kill without touching anything):
WEBKIT_REAPER_DRY_RUN=1 /home/dev/papercupai-workspace/papercusp/bin/reap-leaked-webviews.sh

# Live run:
systemctl --user start papercup-webkit-reaper.service
journalctl --user -u papercup-webkit-reaper.service --since "1 min ago"
```

## Tune thresholds

```bash
# Reap orphans older than 2 min (default 5 min):
WEBKIT_REAPER_ORPHAN_THRESHOLD=120 ./bin/reap-leaked-webviews.sh

# Protect stale desktops longer (default 30 min):
WEBKIT_REAPER_DESKTOP_STALE=3600 systemctl --user start papercup-webkit-reaper.service
```

---

# Orphaned-vitest-worker reaper — installation (EI-18686031108193522)

`papercup-vitest-orphan-reaper.{service,timer}` reaps orphaned vitest fork-pool
worker processes (`node_modules/vitest/dist/workers/{forks,vmForks}.js`) left
behind when the vitest CLI process that owns them is SIGKILLed — a
harness/heavy-command timeout, an admission-guard abort, a `run_in_background`
task reaped, or an agent session ending mid-suite. SIGKILL can't be trapped, so
the parent gets no chance to tear its worker pool down; the workers are
reparented to this host's subreaper (`systemd --user`, confirmed via /proc —
not always PID 1) and simply sit there, forever. Measured 2026-07-26: 8 such
workers alive 24h+, up to 6.7 days, ~600MB combined RSS, each reading 0.0% CPU
— a pure memory/process-table leak, NOT a load contributor (see the filed
issue for why that distinction matters).

**Safety:** a worker is a reap candidate only if its cmdline names a
`forks.js`/`vmForks.js` entrypoint. Its real PPID is read from `/proc`, and if
that parent is alive AND its own cmdline mentions `vitest` (a legitimately
still-running suite), the worker is left alone regardless of age — this is
mirrored from `reap-leaked-webviews.sh`'s live-parent check, not a bare
`ppid==1` test. Only orphans older than the age threshold (default 5 min) are
reaped, TERM first then KILL after a grace period.

**Detection + reaping only** — this does not (and cannot) patch vitest's own
worker entrypoints to self-exit on parent death (`PR_SET_PDEATHSIG`): those
files live in `node_modules` and are overwritten by every `npm install`, so
any patch would be silently lost. A sweeper is the durable side of this fix,
mirroring the webkit reaper's own precedent of reaping rather than patching a
vendored dependency's internals.

## Install (one-time)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
ln -sf "$(pwd)/papercup-vitest-orphan-reaper.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-vitest-orphan-reaper.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-vitest-orphan-reaper.timer
```

## Verify

```bash
systemctl --user list-timers papercup-vitest-orphan-reaper.timer
systemctl --user status papercup-vitest-orphan-reaper.service
```

## Manual run / dry-run

```bash
# Dry run (logs what it would kill without touching anything):
VITEST_REAPER_DRY_RUN=1 /home/dev/papercupai-workspace/papercusp/bin/reap-orphaned-vitest-workers.sh

# Live run:
systemctl --user start papercup-vitest-orphan-reaper.service
journalctl --user -u papercup-vitest-orphan-reaper.service --since "1 min ago"
```

## Tune thresholds

```bash
# Reap orphans older than 60s (default 300s = 5 min):
VITEST_REAPER_ORPHAN_THRESHOLD=60 ./bin/reap-orphaned-vitest-workers.sh
```

---

# Stale-testvm reaper — installation (EI-18792610532592319)

`papercup-testvm-reaper.{service,timer}` reaps orphaned `papercusp-testvm-*`
QEMU VMs (the `linux-test-vm` rig's `clean`/`fed-a`/`fed-b`/`updater`/ad-hoc
instances — `scripts/linux-test-vm/boot-vm.sh`) left running past an age
threshold. Each VM is launched `-daemonize`'d, detaching from its own launcher
immediately on boot; `vm-federation.sh`/`fed.sh` already `trap cleanup EXIT`,
but a trap can't fire if the launching process is SIGKILLed (a harness
timeout, an admission-guard abort, an agent session ending mid-run), leaving
the VM orphaned and burning real CPU/RAM indefinitely. Measured 2026-07-27:
two `fed-{a,b}` frames alive 13.6h/16.6h, ~1300% combined CPU, contributing to
a sustained load1 ~85-90 that made `test:affected` auto-degrade into
flake-absorbing retry fleet-wide (EI-9103) — a correctness cost to the whole
fleet's verification, not just a speed cost.

**Safety:** a VM is a reap candidate only if its cmdline carries
`-name papercusp-testvm-<X>` — the exact marker `boot-vm.sh` stamps on every
VM it boots. This can **never** match the persistent mac (:2222) / Windows
(:2223) build-and-test VMs (`papercup-vm-mac.service` / the Windows VM
service): they're launched by a different script with no `-name` flag at all,
and are explicitly owner-sanctioned to stay running indefinitely (memory
648ac99a — do not delete their images, do not uninstall their services). The
reaper's selftest reproduces both VMs' real cmdline shapes to guard this.
Before reaping anything it also scans for a LIVE orchestrator process
(`vm-federation.sh`, `fed.sh`, `live-federation-gate.sh`,
`two-instance-federation-smoke.sh`) — if one is running, the whole sweep is
skipped that tick, erring toward never touching another agent's in-flight
infrastructure. Only a candidate older than the age threshold (default 6h —
well past the live-federation-gate's own 4h `TimeoutStartSec` bound) is
reaped, via `vmctl down <name>` (graceful in-guest poweroff, then SIGTERM,
then SIGKILL — the same escalation `vmctl down` already uses), with a hard
per-attempt timeout and a direct-kill fallback if `vmctl` itself can't run.
After `vmctl down` succeeds the reaper waits up to 15s
(`TESTVM_REAPER_VMCTL_EXIT_GRACE`) for QEMU to exit before escalating.

**Opting an over-age VM out (WI-10006429, WI-10006611).** Two leases stop the
reaper from touching an instance:

- **Named-resource lease (the normal one).** A rig that holds
  `linux-test-vm:<instance>` through `locks:acquire_resource` is skipped for as
  long as that lease is live. The reaper reads it with
  `scripts/mcp-call.mjs locks:list` once per over-age candidate. If the lease
  plane cannot be read, the VM is deferred to the next sweep, not reaped, unless
  it has run longer than 48h (`TESTVM_REAPER_LEASE_UNREADABLE_MAX_AGE_SECS`).
- **File keep lease.** For a run with no Papercusp session to hold a lease, write
  the epoch-seconds keep-until time into
  `~/.local/state/papercusp/testvm-keep/<instance>` (capped at 48h).

**Detection + reaping only** — this does not (and cannot) make a SIGKILLed
launcher's `trap cleanup EXIT` fire; a sweeper is the durable second line of
defense for exactly that case, mirroring `papercup-vitest-orphan-reaper`'s own
precedent for the same underlying class of problem (a process-spawning
workflow with no teardown guarantee against an abrupt parent death).

The first line of defense is now in `scripts/linux-test-vm/boot-vm.sh` itself:
every disposable `papercusp-testvm-*` QEMU starts inside a regular, escaped,
named transient systemd scope. The scope derives a reclaim threshold and hard ceiling from the
existing `PAPERCUSP_TESTVM_RAM_MB` guest-RAM setting (default 16 GiB → 20 GiB
`MemoryHigh`, 24 GiB `MemoryMax`, 8 GiB `MemorySwapMax`). This preserves QEMU's
pidfile/daemonized lifecycle and `vmctl down`, while preventing a young or
abandoned test VM from consuming unbounded host memory during the reaper's
deliberate six-hour safety window. Startup fails closed when the user systemd
manager cannot apply the envelope; it never silently falls back to unbounded
QEMU. The focused regression check validates both the hermetic launch argv and,
when a user manager is reachable, real transient-unit name/property acceptance:

```bash
bash papercusp-desktop/scripts/linux-test-vm/resource-control.selftest.sh
```

## Install (one-time)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
ln -sf "$(pwd)/papercup-testvm-reaper.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-testvm-reaper.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-testvm-reaper.timer
```

## Verify

```bash
systemctl --user list-timers papercup-testvm-reaper.timer
systemctl --user status papercup-testvm-reaper.service
```

## Manual run / dry-run

```bash
# Dry run (logs what it would reap without touching anything):
TESTVM_REAPER_DRY_RUN=1 /home/dev/papercupai-workspace/papercusp/bin/reap-stale-testvms.sh

# Live run:
systemctl --user start papercup-testvm-reaper.service
journalctl --user -u papercup-testvm-reaper.service --since "5 min ago"
```

## Tune thresholds

```bash
# Reap VMs older than 1h (default 21600s = 6h):
TESTVM_REAPER_MAX_AGE_SECS=3600 ./bin/reap-stale-testvms.sh
```

## Self-test

```bash
bash bin/reap-stale-testvms.selftest.sh
```

---

# Isolated-DHT liveness probe — installation (EI-8892)

`papercup-isolated-dht-liveness.{service,timer}` runs a REAL 2-swarm hyperswarm
announce/connect probe (`../p2p-dht-liveness-probe.mjs`, wrapped by
`../papercup-dht-liveness-check.sh`) against `papercup-isolated-dht.service`'s
bootstrap node every 5 minutes and files an EI on failure.

**Root cause this catches:** the isolated DHT testnet can WEDGE (unit stays
`ActiveState=active`, the bootstrap node stops actually routing DHT traffic)
with ZERO passive signal — `systemctl is-active` sees nothing wrong, and
hyperswarm rides UDX/UDP so `ss`/`netstat` show nothing useful either. This
class wedged silently for 3 days (2026-07-06→07-09, cross-machine federation
dead the whole time) before being caught by a hand-rolled probe. The ONLY
reliable health signal is "did a second swarm actually receive a `connection`
event within a timeout" — join()/flush() resolving is not enough (both can
succeed against a wedged bootstrap).

**Detection + escalation ONLY — this unit never restarts
`papercup-isolated-dht.service`.** A health check that reads a signal spanning
process restarts must not also hold restart authority over that process, or a
boot-grace bug turns into a restart-storm (EI-8901's lesson: a
freshly-restarted unit that hasn't had time to become live yet gets repeatedly
killed by its own check). The wrapper script has its own `DHT_BOOT_GRACE_SEC`
(default 120s) skip for exactly this reason. Recovery (`systemctl --user
restart papercup-isolated-dht.service`) is a human/agent call made off the
filed EI, not something this script does automatically.

## Install (one-time)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
ln -sf "$(pwd)/papercup-isolated-dht-liveness.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-isolated-dht-liveness.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-isolated-dht-liveness.timer
```

## Verify

```bash
systemctl --user list-timers papercup-isolated-dht-liveness.timer
systemctl --user status papercup-isolated-dht-liveness.service
# last successful probe (epoch seconds):
cat ~/.papercusp/dht-liveness/last-ok
```

## Manual run / dry-run

```bash
# Run the probe directly against a given bootstrap (bypasses unit resolution):
node apps/operator/scripts/p2p-dht-liveness-probe.mjs --host 172.31.44.1 --port 49838

# Run the full wrapper (resolves host/port from the live unit) without filing an EI:
DHT_NO_FILE=1 bash apps/operator/scripts/papercup-dht-liveness-check.sh

# Force it through systemd (files a real EI on failure):
systemctl --user start papercup-isolated-dht-liveness.service
journalctl --user -u papercup-isolated-dht-liveness.service --since "5 min ago"
```

## Tune thresholds

```bash
# Probe connect-timeout (default 15000ms):
DHT_PROBE_TIMEOUT_MS=20000 bash apps/operator/scripts/papercup-dht-liveness-check.sh

# Boot-grace before judging a freshly-(re)started unit (default 120s, EI-8901):
DHT_BOOT_GRACE_SEC=180 bash apps/operator/scripts/papercup-dht-liveness-check.sh

# RED-EI dedup window — file once per still-wedged condition, not every 5-min
# tick (default 12h; mirrors papercup-live-federation-gate.sh's RED_REFILE_H):
DHT_RED_REFILE_H=6 bash apps/operator/scripts/papercup-dht-liveness-check.sh

# Staleness — no successful probe at all for this long files a louder, separate
# EI (the signal itself may be dark, default 6h):
DHT_STALE_H=3 bash apps/operator/scripts/papercup-dht-liveness-check.sh
```

---

# Fed-plane disk-health probe — installation (EI-8982)

`papercup-fedplane-disk-health.{service,timer}` (Linux) /
`com.papercusp.fedplane-disk-health.plist` (macOS, under `../launchd/`) runs
`../papercup-fedplane-disk-health-check.sh` every 5 minutes on any fed-plane
host and files an EI when either (a) disk usage on the papercusp data volume
crosses a threshold (default 90%) or (b) `serve.log` carries an ENOSPC /
crash-loop signature.

**Root cause this catches:** a fed-plane machine's disk can fill silently
until total wedge — no disk monitor, no ENOSPC alert, no health surface
existed before this probe. 2026-07-10 (P-059 live-rig cause #9): a Mac VM's
Data volume hit 100% (43Mi free); `~/.papercusp/operator.lock` writes failed
ENOSPC, serve spawns crash-looped (~25s connect-cycles), and the ONLY visible
symptom was on the PEER machine — a mysterious connect/drop cycle with zero
local signal. Diagnosis took cross-machine correlation; the fix itself was
trivial (freed 30G of a stale cargo target dir). This probe (and the
companion note added to `replication-liveness.ts`'s `connected_never_replicated`
alert body) exists so the next occurrence is caught locally within minutes,
and a zombie-connection alert on the OTHER machine now points investigators
at peer host-health as a likely cause.

**Detection + escalation ONLY** — same posture as the DHT liveness probe
above: this script never deletes files or restarts anything. Recovery
(freeing space, restarting a wedged serve process) is a human/agent call made
off the filed EI.

## Install — Linux (systemd --user)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
ln -sf "$(pwd)/papercup-fedplane-disk-health.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-fedplane-disk-health.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-fedplane-disk-health.timer
```

Verify: `systemctl --user list-timers papercup-fedplane-disk-health.timer`,
`journalctl --user -u papercup-fedplane-disk-health.service --since "5 min ago"`.

## Install — macOS (launchd, e.g. the Mac VM)

```bash
mkdir -p ~/Library/LaunchAgents
cd /path/to/papercusp/apps/operator/scripts/launchd
# Edit the plist's ProgramArguments REPO_ROOT placeholder + the HOME env var
# to this machine's actual checkout/home before installing:
sed -e "s#/REPO_ROOT#$(cd ../../../.. && pwd)#" \
    -e "s#__REPLACE_WITH_HOME__#$HOME#" \
    com.papercusp.fedplane-disk-health.plist > ~/Library/LaunchAgents/com.papercusp.fedplane-disk-health.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.papercusp.fedplane-disk-health.plist
launchctl enable gui/$(id -u)/com.papercusp.fedplane-disk-health
```

Verify: `launchctl print gui/$(id -u)/com.papercusp.fedplane-disk-health`,
`tail -f /tmp/papercup-fedplane-disk-health.log`.

## Manual run / dry-run (either platform)

```bash
# Log-only, no EI filed:
DISK_NO_FILE=1 bash apps/operator/scripts/papercup-fedplane-disk-health-check.sh

# Point at a specific volume / serve.log (e.g. testing without installing):
DISK_PATH=/Volumes/Data SERVE_LOG=/path/to/serve.log DISK_NO_FILE=1 \
  bash apps/operator/scripts/papercup-fedplane-disk-health-check.sh
```

## Tune thresholds

```bash
# Disk-usage warn threshold (default 90%):
DISK_WARN_PCT=85 bash apps/operator/scripts/papercup-fedplane-disk-health-check.sh

# ENOSPC/crash-loop signature count in the log tail before alarming (default 5):
CRASH_LOOP_MIN_COUNT=3 bash apps/operator/scripts/papercup-fedplane-disk-health-check.sh

# RED-EI dedup window (default 12h, mirrors the DHT probe's DHT_RED_REFILE_H):
DISK_RED_REFILE_H=6 bash apps/operator/scripts/papercup-fedplane-disk-health-check.sh
```

---

# Private-key exposure probe — installation (WI-2143622)

`papercup-fedplane-key-permission.{service,timer}` runs
`../papercup-fedplane-key-permission-check.sh` **daily** and files an EI when a
private key — or a `.ssh` directory containing one — is readable by group or
other.

**Root cause this catches:** on 2026-09-03 an UNENCRYPTED SSH private key was
found at `/mnt/data/back/Debug/.ssh/id_ed25519`, mode 0664 inside a 0775
directory (EI-22240449643643994). Group- *and* world-readable, with no
passphrase — so readable meant directly usable by any local account. It
surfaced only because an agent happened to `stat` that path during an unrelated
disk-reclaim check. Nothing on this box was looking for it: the fed-plane
detector family covered disk (EI-8982), DHT liveness (EI-8892) and backup
health, and key permissions were an uncovered class. The interval between
exposure and discovery was bounded only by luck.

**Detection + escalation ONLY** — same posture as the probes above. It never
chmods, moves or deletes anything, and it never reads or logs key MATERIAL:
findings carry paths and mode bits, nothing else.

## The three things that make this probe trustworthy

Read these before changing it — each one is a measured result, and reverting any
of them breaks the probe in a way that still looks like it is working.

1. **Content-match, never filename.** `id_*` matches `/usr/share/i18n`'s `id_ID`
   LOCALE files, while a real key named `deploy.pem` is missed entirely. Every
   candidate is confirmed by a `PRIVATE KEY` header in the file.

2. **Vendored trees are excluded, or nobody reads the output.** A census of
   `/mnt/data` on 2026-09-03 content-matched **755** group/world-readable
   private keys, and every single one was published third-party test material:
   496 openssl-src/postgresql-src test suites, 188 gomodcache (grpc, kopia,
   sigstore, in-toto), 17 node_modules fixtures, 4 Go stdlib testdata. Mode 444
   on a read-only module cache is normal. The measured post-exclusion floor on
   this box is **zero**, which is what makes a hit worth waking someone for.

3. **An empty result is not automatically a clean result.** This is the one a
   security probe most often omits, because the broken direction is the
   reassuring one. During that same census, three separate instruments produced
   a clean-looking nothing — `find / -xdev` (never crosses into `/home` or
   `/mnt/data` here: separate mounts) returned ZERO rows while two `id_ed25519`
   files demonstrably existed; a whole-box foreground find was SIGTERM-killed at
   its deadline and printed nothing; and a log read taken while the writer was
   still running looked identical to a finished empty one. So the probe carries
   a **positive control** (a key it must rediscover every run), treats a
   timed-out sweep as INDETERMINATE, and names unreadable roots as BLIND SPOTS.
   A run that cannot prove it still finds the key we already know about has
   established nothing about the keys we do not.

⛔ **Do not "simplify" the encryption check back to `ssh-keygen -y -P ''`.**
ssh-keygen REFUSES to load a key whose permissions are too open (exit 255) —
which is true of every key this probe flags, by definition — so it reported
unencrypted world-readable keys as passphrase-protected, understating severity
in exactly the reassuring direction. The header-inspection implementation needs
no permission from ssh, copies nothing, and also covers TLS keys ssh-keygen
cannot read at all. A named regression test pins it.

## Two tiers

- **Tier 1 — `.ssh` directories** (`KEYPERM_SSH_ROOTS`, default
  `/home /root /mnt/data/back`, depth `KEYPERM_SSH_MAXDEPTH`=6). Checks the
  directory mode *and* each contained key's mode; neither subsumes the other.
  It prunes the same configured vendored/cache/Gradle-intermediate directory-name globs as tier 2.
  This is the tier that catches the 2026-09-03 shape.
- **Tier 2 — content sweep outside `.ssh`** (`KEYPERM_DEEP_ROOTS`, default
  `$HOME/papercupai-workspace $HOME/.config /mnt/data/back`). Catches an
  exported deploy key or a loose `.pem`. The defaults also prune Android
  Gradle's generated `intermediates` directories by name; workspace source and
  configuration trees remain scanned.
  Bounded by `KEYPERM_DEEP_TIMEOUT_S`; each deep sweep runs at `nice 10` /
  `ionice -c 2 -n 7`, the lowest best-effort I/O priority that can still make
  progress while the device is active. The service also uses `Nice=10`,
  `CPUWeight=50`, and matching best-effort I/O settings to keep its CPU share
  moderate without risking idle-class starvation.

The unit runs **unprivileged**, so `/root` is unreadable and is reported as a
named blind spot rather than counted as clean. A host that needs `/root` covered
should install this as a SYSTEM unit — do not add `sudo` to a detector.

## Install — Linux (systemd --user)

```bash
cd ~/papercupai-workspace/papercusp/apps/operator/scripts/systemd
ln -sf "$(pwd)/papercup-fedplane-key-permission.service" ~/.config/systemd/user/
ln -sf "$(pwd)/papercup-fedplane-key-permission.timer"   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercup-fedplane-key-permission.timer
```

After either symlinked unit file changes, rerun `systemctl --user daemon-reload`;
systemd keeps the loaded definition until that command runs again. Before a
qualifying full scan, check the active service properties with:

```bash
systemctl --user show papercup-fedplane-key-permission.service -p Nice -p CPUWeight -p IOSchedulingClass -p IOSchedulingPriority
```

Verify: `systemctl --user list-timers papercup-fedplane-key-permission.timer`,
`journalctl --user -u papercup-fedplane-key-permission.service --since today`.

## Manual run / dry-run

```bash
# Log-only, no EI filed — tier 1 only (fast):
KEYPERM_NO_FILE=1 KEYPERM_DEEP=0 \
  bash apps/operator/scripts/papercup-fedplane-key-permission-check.sh

# Both tiers, log-only:
KEYPERM_NO_FILE=1 bash apps/operator/scripts/papercup-fedplane-key-permission-check.sh
```

## Tune

```bash
# Widen/narrow the .ssh sweep:
KEYPERM_SSH_ROOTS="/home /srv" KEYPERM_SSH_MAXDEPTH=8 bash …

# Raise the deep-sweep budget on a slow or busy host (a TIMEOUT files a RED
# saying the tier-2 result is INDETERMINATE — it is never reported as clean):
KEYPERM_DEEP_TIMEOUT_S=1800 bash …

# Add a vendored tree that is producing noise (directory NAME globs, so a tree
# is pruned wherever it is unpacked):
KEYPERM_EXCLUDE_DIRS="node_modules gomodcache* .git target vendor my-vendored-thing" bash …

# RED-EI dedup window (default 24h; state-aware via lib/red-marker.sh, so a
# dropped tracking item causes a refile rather than silent suppression):
KEYPERM_RED_REFILE_H=6 bash …
```

A host that genuinely holds no private key can opt out of self-validation with
`KEYPERM_POSITIVE_CONTROL=""`. Note that a configured-but-MISSING control path
is a **failure**, not a skip — otherwise a stale path lets the probe print "no
exposed private keys found" forever while validating nothing.

---

# Postgres backup + offsite kopia — the EXECUTION units (EI-12028)

`papercusp-db-backup.{timer,service}` (hourly `pg_dump -Fd -j` per database, EI-10733),
`papercusp-db-backup-alert.service` (its `OnFailure=` handler), `kopia-snapshots.{timer,service}`
(30-min offsite ship of the dumps via kopia), and `kopia-healthcheck.{timer,service}` (15-min
dump-freshness/snapshot-recency probe, a BACKSTOP to `papercup-backup-health.{timer,service}`
above — see its own header comment for why two checks exist and how they're kept from
disagreeing).

**Why these are here:** until EI-12028, these 7 unit files existed ONLY as regular files in
`~/.config/systemd/user/` — no repo copy, unlike `papercup-backup-health.{timer,service}` (the
detection layer, already symlinked). A machine re-provision restored the health PROBE (repo,
symlinked) but silently lost backup EXECUTION entirely — broken-but-detected is still broken.
Relocated here and re-symlinked, mirroring every other unit in this directory, so the whole
backup stack re-materializes on a fresh machine.

**Snapshot scripts are canonical here now.** Plan
`serialize-and-slow-kopia-backups-2026-08-20` completed the deferred relocation for
`snapshot-all.sh`, `home-snapshot.sh`, and `healthcheck.sh`. Their installed paths remain under
`~/.config/kopia/`, but those paths are symlinks to the versioned files here. One versioned
`kopia-backup-guard.sh` owns the global flock: the hourly database dump and hot scheduled work
use its non-blocking low-impact admission and defer when memory full PSI is at least 5 or I/O
full PSI is at least 10; daily home/VM and protected/manual work wait for it. The default lock is
the host-global
`/run/lock/papercusp/kopia-global.lock`, intentionally outside `XDG_RUNTIME_DIR` so a
root-launched maintenance task and the user-level systemd services cannot enter separate
effective-UID namespaces. The dedicated non-sticky subdirectory avoids the host's
`fs.protected_regular` denial when root opens a user-created file in sticky `/run/lock`; the guard
creates the directory and lock with shared-write permissions for either identity.
`KOPIA_BACKUP_LOCK_PATH` remains available for isolated tests or an explicitly managed deployment.
`kopia-protected-snapshot.sh SOURCE...` is the supported manual entrypoint. The remaining
`papercusp-db-backup.sh` dump producer and `kopia-backup-alert.sh` alarm are tracked in this
directory. The database backup service invokes the producer from the checkout; the alert unit
keeps its `~/.config/kopia/backup-alert.sh` path through the symlink in the install recipe. Both
are outside this snapshot-serialization contract.

New database dumps live at /mnt/cold-a/Backup/db-dumps. The previous
/mnt/backup/db-dumps tree is retained as legacy data; this relocation does not
delete or prune it. Mount the cold-a filesystem persistently by UUID at /mnt/cold-a:
UUID=<filesystem-uuid> /mnt/cold-a ext4 defaults,nofail 0 2
The database backup, hot snapshot, and Kopia healthcheck units require the cold-a
mount so they cannot write to or inspect an underlying mountpoint directory.

## Install (one-time, on a fresh machine)

```bash
cd /home/dev/papercupai-workspace/papercusp/apps/operator/scripts/systemd
for f in papercusp-db-backup.timer papercusp-db-backup.service papercusp-db-backup-alert.service \
         papercusp-nonblocking-trigger@.service \
         kopia-snapshots.timer kopia-snapshots.service \
         kopia-healthcheck.timer kopia-healthcheck.service \
         kopia-home-snapshot.timer kopia-home-snapshot.service; do
  ln -sf "$(pwd)/$f" ~/.config/systemd/user/
done
mkdir -p ~/.config/kopia
ln -sf "$(pwd)/kopia-backup-guard.sh" ~/.config/kopia/kopia-backup-guard.sh
ln -sf "$(pwd)/kopia-cache-bootstrap.sh" ~/.config/kopia/kopia-cache-bootstrap.sh
ln -sf "$(pwd)/kopia-snapshot-all.sh" ~/.config/kopia/snapshot-all.sh
ln -sf "$(pwd)/kopia-home-snapshot.sh" ~/.config/kopia/home-snapshot.sh
ln -sf "$(pwd)/kopia-healthcheck.sh" ~/.config/kopia/healthcheck.sh
ln -sf "$(pwd)/kopia-protected-snapshot.sh" ~/.config/kopia/kopia-protected-snapshot.sh
ln -sf "$(pwd)/kopia-backup-alert.sh" ~/.config/kopia/backup-alert.sh
systemctl --user daemon-reload
# Re-arm active timers after changing their targets; this restarts only the timer
# units and leaves any in-flight backup worker alone.
systemctl --user try-restart papercusp-db-backup.timer kopia-snapshots.timer
systemctl --user enable --now papercusp-db-backup.timer kopia-snapshots.timer \
  kopia-healthcheck.timer kopia-home-snapshot.timer
```

The database backup service invokes tracked `papercusp-db-backup.sh` directly; do not recreate an
untracked `~/.config/kopia/db-backup.sh` copy. The install recipe links tracked
`kopia-backup-alert.sh` to the stable `~/.config/kopia/backup-alert.sh` path used by the alert
unit. The Kopia snapshot, home/VM, healthcheck, shared cache bootstrap, global guard, and
supported protected/manual entrypoints are restored by the symlinks above. The cache bootstrap
creates a missing target behind an existing `~/.cache/kopia` symlink without unlinking or
replacing that symlink, and fails closed when the target is not a writable directory.

## Manual/protected snapshot

Never invoke `sudo kopia snapshot create` directly. The supported command waits for the same
global lock used by both timers:

```bash
~/.config/kopia/kopia-protected-snapshot.sh /path/to/source [/another/source]
```

The hot timer intentionally runs every 30 minutes. `healthcheck.sh` uses a 60-minute snapshot
staleness bar, which allows one missed/deferred cycle plus runtime and timer jitter.

## Mandatory post-restore recovery sweep

Restoring `/home` or `/etc` restores unit files on disk, but it does not repair the systemd
manager's in-memory state. A timer can therefore remain failed/inactive with `Result=resources`
(`Unit to trigger vanished`) even after its file is back, and `Persistent=true` cannot catch up
until the timer is started again. After every restore that touched `/home`, run the versioned
sweep below before declaring the host recovered:

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
bash ./papercusp-systemd-restore-recovery.sh --scope user
```

The sweep runs `systemctl --user daemon-reload`, `systemctl --user reset-failed`, then starts
every `enabled` or `enabled-runtime` timer that is not active. Disabled timers and already-active
timers are left alone. It exits non-zero if the manager cannot be reloaded or any enabled timer
cannot be started, so a failed recovery cannot be mistaken for a successful restore.

If `/etc` was restored, recover the system manager too (root may be required):

```bash
sudo bash ./papercusp-systemd-restore-recovery.sh --scope system
```

If both trees were restored, one invocation covers both managers:

```bash
bash ./papercusp-systemd-restore-recovery.sh --scope both
```

## Verify

```bash
systemctl --user list-timers papercusp-db-backup.timer kopia-snapshots.timer kopia-healthcheck.timer
systemctl --user cat kopia-snapshots.service kopia-home-snapshot.service
bash ~/.config/kopia/healthcheck.sh --self-test
journalctl --user -u papercusp-db-backup.service --since "2 hours ago"
cat /mnt/data/Backup/db-dumps/STATUS.json
```

---

# Shared `/tmp` scratch residue reclaimer — EI-22401828026029625

`papercup-tmp-scratch-reclaim.{timer,service}` is the host-level actor for the
shared `/tmp` leak that the operator's per-workspace `scratch-gc` cannot see.
It runs the deliberately narrow `scripts/reclaim-tmp-scratch-residue.sh` every
30 minutes, deletes only the four audited top-level residue shapes after the
conservative 240-minute age floor, and preserves `/tmp/pc-heavy/*`,
`exthost-*.cpuprofile`, fresh entries, and every unmatched path. The service
explicitly sets `PrivateTmp=no`; enabling private `/tmp` would turn a healthy
run into a silent no-op. Manual invocations remain dry-run unless `--execute`
is passed.

## Install (one-time, on a fresh machine)

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
for f in papercup-tmp-scratch-reclaim.timer papercup-tmp-scratch-reclaim.service; do
  ln -sf "$(pwd)/$f" ~/.config/systemd/user/
done
systemctl --user daemon-reload
systemctl --user enable --now papercup-tmp-scratch-reclaim.timer
```

## Verify

```bash
systemctl --user list-timers papercup-tmp-scratch-reclaim.timer
systemctl --user cat papercup-tmp-scratch-reclaim.service
journalctl --user -u papercup-tmp-scratch-reclaim.service --since "2 hours ago"
bash "$(git rev-parse --show-toplevel)/scripts/reclaim-tmp-scratch-residue.sh" --help
```

---

# Shared embedding sidecar — WI-4021 (relocated here EI-19380773834961669)

`papercup-embed-sidecar.service` is the ONE supervised owner of the shared
embedding + rerank sidecar on `127.0.0.1:3384`, plus its companion
`papercup-embed-sidecar-watchdog.{service,timer}` (60s cache-bypassing `/embed`
probe that exercises the worker and restarts the unit when the response or
per-request inference accounting is invalid) and the drop-in
`papercup-embed-sidecar.service.d/98-embed-concurrency.conf` (bounded embed
concurrency: 2 slots x intraOp 4 threads = exactly the unit's 800% CPUQuota).

The service cgroup accounts memory, begins reclaim at 8 GiB, hard-stops at 12
GiB, and disallows swap (`MemoryAccounting=yes`, `MemoryHigh=8G`,
`MemoryMax=12G`, `MemorySwapMax=0`, `OOMPolicy=kill`). The hard-limit kill is a
failed sidecar instance, so `Restart=always` replaces it instead of leaving a
partially alive worker behind.

**Why these are here:** identical reasoning to the backup units above — these 4
files existed ONLY as regular files in `~/.config/systemd/user/`, with no repo
copy, so a machine re-provision would silently lose them. That is worse here
than for most units: since WI-4021 clients **REQUIRE** the sidecar (the
in-process embedder fallback was retired), losing it does not degrade memory and
search, it **stops** them. Relocated + symlinked mirroring every other unit in
this directory; the three files other than the `.service` were verified
byte-identical (`diff -q`) before symlinking, and `daemon-reload` was confirmed
not to restart the running sidecar (MainPID unchanged).

**The one behavioral change made during the relocation** was adding `rerank` to
the boot-warm set (see the unit's own header comment for the full rationale):

```
Environment=PAPERCUSP_EMBED_SIDECAR_WARM=gemma,harrier,rerank
```

The boot-warm RERANKER set is parsed from that same env and defaults to none, so
this search-serving host had been bringing the ~150M cross-encoder up cold on
every restart and paying the load inside the first `/rerank` caller's budget.

## Install (one-time, on a fresh machine)

The CUDA ONNX Runtime provider needs `libcurand` and `libcufft` alongside the
CUDA bundle under `/usr/local/lib/ollama/cuda_v12`. Install the distro runtime
packages before enabling the sidecar; the unit adds the Ollama bundle to its
loader path for `cublas` and `cudart`.

```bash
sudo apt-get install libcurand10 libcufft11
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
for f in papercup-embed-sidecar.service \
         papercup-embed-sidecar-watchdog.service papercup-embed-sidecar-watchdog.timer; do
  ln -sfn "$(pwd)/$f" ~/.config/systemd/user/
done
mkdir -p ~/.config/systemd/user/papercup-embed-sidecar.service.d
ln -sfn "$(pwd)/papercup-embed-sidecar.service.d/98-embed-concurrency.conf" \
        ~/.config/systemd/user/papercup-embed-sidecar.service.d/
systemctl --user daemon-reload
systemctl --user enable --now papercup-embed-sidecar.service papercup-embed-sidecar-watchdog.timer
```

The unit resolves the home directory via systemd's `%h` specifier (matching
`papercup-mcp-proxy.service`), so it is portable across users. It does still
assume the checkout lives at `~/papercupai-workspace/papercusp` and that node
comes from linuxbrew — re-point `WorkingDirectory=` / `PATH=` on a host where
either differs.

## Verify

```bash
systemctl --user show papercup-embed-sidecar.service -p MainPID -p ActiveState
systemctl --user show papercup-embed-sidecar.service -p Environment   # expect WARM=gemma,harrier,rerank
curl -s http://127.0.0.1:3384/healthz | jq '{models, capabilities, rerankExecution}'
```

`capabilities` lists every route THIS BUILD serves — it is the honest test for
"does this sidecar do reranking", NOT the presence of a warm reranker in
`models`. Note the entry is esbuild-bundled by `ExecStartPre` on **every**
start, so a restart always picks up current staging source; a long-lived sidecar
can therefore be running a build many days older than the tree (measured
2026-08-02: a 16.9-day-old process serving no `/rerank` route at all).

# App sidecars — email (:8791) + calendar (:8792) — EI-23439593071892927

`papercusp-email-sidecar.service` and `papercusp-calendar-sidecar.service` run
the receiving end of the platform→app data producer (plan
`platform-to-app-data-producer-2026-08-30`, P-008) for the two template-
materialized app checkouts at `~/papercupai-workspace/{email,calendar}`. Those
checkouts are SEPARATE repos (an app template materialization, `sidecar` npm
script = `tsx apps/sidecar/src/index.ts`) and carry no unit source of their own,
so — until 2026-09-17 — both units existed only as hand-written files in
`~/.config/systemd/user/`, and the restart-on-change fix (WI-10001633, `tsx
watch` after the email sidecar served 16 days of stale code) had to land as an
unreviewable `<unit>.d/watch.conf` drop-in. Both are now tracked here, installed
by symlink like every other unit in this directory, with the watcher folded into
`ExecStart` and the drop-ins retired. The phone sidecar is rendered from its
tracked source (`infra/phone-app/systemd/*.tmpl`) by `deploy.sh`; its template
now uses Node's `--watch` mode too, so edits in that out-of-repo checkout restart
the service without a manual unit restart.

Invariants pinned by `apps/operator/lib/app-sidecar-units.test.ts`: `tsx watch`
ExecStart · every path `%h`-relative · config from the injected
`~/.papercusp/app-producer.env` (secrets never in a repo) · the app's
`*_LOCAL_MODE` jwtVerify bypass NOT set · `Restart=always` · no tracked drop-in
directory shadowing the unit.

## Install (one-time, on a fresh machine)

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
for app in email calendar; do
  rm -rf ~/.config/systemd/user/papercusp-$app-sidecar.service.d   # retired drop-ins
  ln -sfn "$(pwd)/papercusp-$app-sidecar.service" ~/.config/systemd/user/
done
systemctl --user daemon-reload
systemctl --user enable --now papercusp-email-sidecar.service papercusp-calendar-sidecar.service
```

Prerequisites the units assume: the app checkouts at
`~/papercupai-workspace/{email,calendar}` (a symlink into
`~/.papercusp-workspaces/...` is fine — `/api/health` reports the resolved
`tree`), the injected `~/.papercusp/app-producer.env`, and `npx` on the
user-manager PATH.

## Platform connection (WI-10006978)

Connecting these apps is a separate deployment step. Their tracked units select
dedicated token files, `~/.papercusp/email-platform-token` and
`~/.papercusp/calendar-platform-token`, instead of the app runtime's implicit
superuser credential. Issue an approved scoped app/service key through
`access:create`, then install its private output into the corresponding token
file with owner-only permissions. Never copy a token into either repository.
An unattended service key needs an approved spending cap; a zero cap permits
non-LLM reads and refuses new LLM work.

After the grant is approved and the token file exists, set the existing injected
`app-producer.env` variables for each app (`EMAIL_` or `CALENDAR_` prefix):
`PLATFORM_INVOKE_URL=http://127.0.0.1:3070/api/mcp`,
`PLATFORM_WORKSPACE=papercusp-workspace`, and `PLATFORM_HARNESS=email` or
`calendar`. The final app connection targets the green operator on `:3070`;
current-build acceptance uses a separately configured isolated instance pointed
at `:3170`. A connected-app key URL must omit `superuser`, `role`, and `harness`
query parameters: the verified key determines authority, while the app sends
its workspace/harness metadata through the existing invoker.

Keep `PLATFORM_TOKEN` unset and do not override `PLATFORM_TOKEN_FILE` in the
injected environment. systemd's EnvironmentFile overrides Environment defaults,
so inspect the effective configuration without printing credential values before
activation. With no invoke URL the apps stay disconnected; with a configured URL
and a missing explicit token file they fail startup rather than fall back to a
superuser token. Reload and restart only after provisioning, then verify through
the real authenticated app people search. Final shipment evidence must come from
the deployed green operator, separately from current-build checks.

Phone voice producer admission uses the existing `work_items:create` surface:
`{ phone_producer: { roomName: "<admitted room>" }, harness: "phone-app" }`.
This mode accepts no caller-authored owner, runtime binding, payload or assignment.
The caller must use a verified bearer service principal matching the sidecar's
configured execution owner; connected-app grants are rechecked before writes.
The operator requires injected `PHONE_PRODUCER_ADMISSION_ENDPOINT` (the trusted
HTTPS `/platform/producer-admission` URL) and `PHONE_PRODUCER_TOKEN_FILE` (the
private bridge token file). The latter reuses the sidecar's bridge credential
setting; neither setting has a superuser or worker-secret fallback. Configure
these outside the repository only after the scoped principal and bridge grant
are approved. Missing configuration refuses admission. This entry creates the
canonical producer binding; retained outcome settlement and live acceptance
remain separate checks.

## Verify

```bash
systemctl --user show papercusp-email-sidecar.service papercusp-calendar-sidecar.service -p MainPID -p ActiveState -p NRestarts
curl -s http://127.0.0.1:8791/api/health | jq '{ok, sha, tree}'   # email
curl -s http://127.0.0.1:8792/api/health | jq '{ok, sha, tree}'   # calendar
```

`sha` must equal `git -C <tree> rev-parse HEAD`; a mismatch means the watcher
is not restarting on change (the exact WI-10001633 symptom) — check the unit's
`ExecStart` still says `tsx watch` and the log at
`~/.papercusp/logs/papercusp-<app>-sidecar.log`.

# Rig macOS VM watchdog — installation (WI-10002582, EI-24019740313758959)

`papercusp-mac-vm-watchdog.timer` runs
`papercusp-desktop/bin/mac-vm-watchdog.mjs` every minute against
`papercusp-vm-mac.service`. It exists because a guest panic → firmware reset
loop (QMP `RESET` about once a second) went unnoticed for 10+ minutes:
`mac-vm-health.sh` calls that state `booting`.

Signals: QMP `query-status` plus the RESET count over a 5s window; ping + ARP
state of `172.31.44.2` on `macbr0` (never ssh `:2222`, a slirp hostfwd that
accepts TCP while the guest is dead); the P-203 fold cursor (alert-only).
Remedy: a coord alert, then — after 2 consecutive reset-loop checks, or 3
unreachable-guest checks past the 600s boot grace — a COLD restart (QMP
`quit`, wait for qemu to exit, `systemctl --user start`). It never sends
`system_reset`, which re-enters the loop. At most one cold restart per hour.

The registered exclusive `mac-test-vm:aviweiss@127.0.0.1:2222` lease
automatically withholds cold restarts while it is active; alerts still fire.
The watchdog checks live exclusive rows across coordination domains and fails
closed if it cannot read the lease state. For operations outside that lease, a
manual hold still suppresses restarts:

```bash
node ~/papercupai-workspace/papercusp/papercusp-desktop/bin/mac-vm-watchdog.mjs \
  hold --for 1800 --by <your-su-id> --reason '<op>'
node ~/papercupai-workspace/papercusp/papercusp-desktop/bin/mac-vm-watchdog.mjs release
```

A pending systemd job on the VM unit or a contended QMP slot also skips the run.

## Install or update

Only the holder of the `hive-git-physical-rig` resource lock installs this: it
can restart the rig VM.

```bash
cp apps/operator/scripts/systemd/papercusp-mac-vm-watchdog.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
node papercusp-desktop/bin/mac-vm-watchdog.mjs --dry-run   # read-only; prints the verdict
systemctl --user enable --now papercusp-mac-vm-watchdog.timer
```

## Verify

```bash
systemctl --user list-timers papercusp-mac-vm-watchdog.timer
journalctl --user -u papercusp-mac-vm-watchdog.service -n 5
node papercusp-desktop/bin/mac-vm-watchdog.mjs status     # streak, last restart, hold
tail -n 5 ~/.papercusp/mac-vm-watchdog/actions.jsonl
```

## Roll back

```bash
systemctl --user disable --now papercusp-mac-vm-watchdog.timer
```

# Rig macOS VM inference route — installation (WI-10004503)

`papercusp-mac-vm-gateway-tunnel.service` holds an ssh reverse tunnel that puts
the tower's account-pool gateway (`127.0.0.1:8788`) on the VM's
`127.0.0.1:18788`. The VM operator's own gateway keeps `:8788` and forwards
upstream to the tunnel: `boot-headless-current.sh` exports
`ANTHROPIC_BASE_URL_UPSTREAM`, and the VM pool's one account is `tower-pool`
(`token:~/.papercusp/tower-gateway.token`, holding the non-secret placeholder
`papercusp-gateway`; the tower gateway strips caller auth). VM fleet seats
therefore run on the tower's OAuth'd accounts and no credential lives on the
VM. Never copy a tower OAuth bundle to the VM instead: a refresh on either side
revokes the other.

## Install or update

```bash
cp apps/operator/scripts/systemd/papercusp-mac-vm-gateway-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now papercusp-mac-vm-gateway-tunnel.service
```

VM side, once per VM DB (the pool lives in the VM's PG and survives restarts):

```bash
ssh aviweiss@172.31.44.2 'umask 077; printf "%s\n" papercusp-gateway > ~/.papercusp/tower-gateway.token;
  printf "%s" "{\"id\":\"tower-pool\",\"credentialRef\":\"token:~/.papercusp/tower-gateway.token\"}" |
  /tmp/vmcall.sh accounts:register --json -'
```

## Verify

```bash
ssh aviweiss@172.31.44.2 'curl -s 127.0.0.1:18788/healthz | head -c 80; echo;
  curl -s 127.0.0.1:8788/healthz | head -c 120'   # tower accountId; VM tower-pool → :18788
```

## Roll back

```bash
systemctl --user disable --now papercusp-mac-vm-gateway-tunnel.service
# and boot the VM operator with PAPERCUSP_RIG_GATEWAY_UPSTREAM= (empty) to use its own sign-in
```

# VirtualBox kernel-update rebuild hook — reboot-residue D-004 (WI-10005993, WI-10006387)

Oracle's `virtualbox-7.2` package ships **no kernel-update hook**. Without one, every
kernel update leaves `vboxdrv` unbuilt for the new kernel, and VirtualBox is down after
the next reboot until someone runs `vboxdrv.sh setup` by hand. That is exactly how the
`7.0.0-34-generic` reboot took it down (reboot-residue-service-repairs-2026-10-03).
`vboxdrv-rebuild.kernel-hook` runs `vboxdrv.sh setup <kver>` for each newly installed
kernel. It **never exits non-zero**, because a failing kernel hook wedges dpkg (WI-38019);
a failed build is reported on stderr and to syslog (`journalctl -t vboxdrv-rebuild`), with
the build log in `/var/log/vboxdrv-rebuild-<kver>.log`. The image hook can fire before the
headers are installed; the `header_postinst.d` copy runs it again once they are.

Behaviour is pinned by `apps/operator/scripts/__tests__/vboxdrv-rebuild-kernel-hook.test.ts`,
which executes the hook against stubs.

## Install or update

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
sudo install -o root -g root -m 0755 vboxdrv-rebuild.kernel-hook \
  /etc/kernel/postinst.d/vboxdrv-rebuild
sudo install -o root -g root -m 0755 vboxdrv-rebuild.kernel-hook \
  /etc/kernel/header_postinst.d/vboxdrv-rebuild
```

Install root-owned copies, not symlinks: dpkg runs these as root, so they must never
execute from the user-writable shared checkout.

## Verify

```bash
cd "$(git rev-parse --show-toplevel)/apps/operator/scripts/systemd"
cmp vboxdrv-rebuild.kernel-hook /etc/kernel/postinst.d/vboxdrv-rebuild
cmp vboxdrv-rebuild.kernel-hook /etc/kernel/header_postinst.d/vboxdrv-rebuild
run-parts --test --arg="$(uname -r)" /etc/kernel/postinst.d | grep vboxdrv-rebuild
modinfo -F vermagic vboxdrv   # first field must equal `uname -r`
```

Both `cmp` calls must be silent (exit 0). A difference means the installed hook has
drifted from the reviewed copy, so re-run the install step.
