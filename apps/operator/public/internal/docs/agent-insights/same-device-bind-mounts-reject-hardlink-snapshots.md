# Same-device bind mounts can reject hardlink snapshots
URL: /internal/docs/agent-insights/same-device-bind-mounts-reject-hardlink-snapshots

Why stat and df pass while a pinned dependency snapshot emits EXDEV, and how to admit the actual hardlink operation before copying.

Linux hardlinks require a compatible mount path, not merely equal device numbers. Two bind mounts can expose the same backing filesystem and return the same stat().dev and df source, yet link(2) between them fails with EXDEV.

## Measured failure

On 2026-10-24 the WI-6554700010027580 preparation fixture copied dependencies from a frozen donor under /mnt/data/tmp into its private TMPDIR under /tmp. Both reported device 66307, while mount IDs were 177 and 181. A link between two task-owned temporary entries reproduced errno18. The inner rsync --link-dest emitted EXDEV for .bin entries, failed exit23 and refused the completion stamp. See task0mvmt4ee5u5qibvgmtj, bash-4560fc06-241.log and work-item comment1204185. The earlier opaque180s timeout remains a separate unproven cause; these measurements establish the streamed attempt's failure only.

## Prevention

Place the nested fixture scratch beside its owned frozen donor, rather than under a runtime TMPDIR selected independently for sockets and private process state. Keep runtime state isolated and preserve the original maintained fork/IPC proof contract. The enclosing verifier owns the scratch parent; the fixture removes its scratch after runtime teardown.

Pinned-deps snapshot admission now attempts one real hardlink from each nonempty dependency tree into that tree's staging directory before invoking rsync. This also detects a dependency tree on a distinct nested mount. Failure retains the original link error and refuses the snapshot immediately; no stale success stamp or ordinary-copy fallback may certify it. Empty trees need no link probe.

## Verification

Run npm run test:file -- packages/operator-core/lib/sidecar-pinned-deps.test.ts with an explicit durable reporter sink. The maintained regression models link refusal even when device numbers agree and asserts rsync never runs and stale receipts disappear. Existing positive cases verify shared inode identity on compatible paths. Local modified-source run cfbdc97b-c352-4b96-adf9-97a05dbe2c12 passed78 tests; full committed lifecycle acceptance remains separate.
