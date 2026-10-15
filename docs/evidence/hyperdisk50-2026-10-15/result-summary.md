# Hyperdisk Balanced and AWS io2 trial

The fresh trial layout was OS 32 GiB, swap 256 GiB, and database 256 GiB. Both cloud resources were created with automatic cleanup and were verified absent after teardown.

## Google Hyperdisk Balanced

The verified C4 x86 fallback (`c4-standard-8`, 8 vCPU, 30 GiB RAM) used a 32 GiB boot Hyperdisk, a 256 GiB 16,000-IOPS swap disk, a 256 GiB 16,000-IOPS DB disk, and a 512 GiB 32,000-IOPS shared comparison disk. N4 was unavailable in three checked zones.

Raw disk results are in the sibling fio files. At queue depth 1, the 16,000-IOPS disk measured 1,886 IOPS and 469 µs p50 read latency; the 32,000-IOPS disk measured 2,091 IOPS and 428 µs. Queue-depth-32 reads measured 16,319 and 32,511 IOPS respectively.

PostgreSQL with `fsync=on`, `synchronous_commit=on`, and `full_page_writes=on` completed with zero failed transactions. Separate DB and swap volumes averaged 6,234 and 6,514 TPS across two 30-second runs. The shared volume averaged 3,602 and 3,749 TPS. This is a within-host placement result; it does not isolate every VM bandwidth effect.

The 50-agent run did not produce a valid scale verdict. The first attempt lost terminal exit evidence; the second exposed a native turn-settlement race and was stopped. An 8-agent guard run succeeded (8/8 warm, 8/8 wakes, zero failures). The harness now waits for native `task_complete` after the assistant final answer; 23 canonical tests and the scoped scripts typecheck pass. The 1-second launch delay remains a mitigation, not a proven root cause of the original startup failure.

## AWS io2 Block Express

The clean-room account launched `m7i.2xlarge` (8 vCPU, 32 GiB) with encrypted 256 GiB io2 volumes at 6,000 IOPS and a 512 GiB io2 volume at 12,000 IOPS, plus a 32 GiB gp3 root. The 1-agent native preflight passed. Raw results are in `docs/evidence/io2-2026-10-15/`; the same maintained fio driver measured 1,505 IOPS at 667.6 µs p50 for 6,000 IOPS and 2,303 IOPS at 419.8 µs p50 for 12,000 IOPS at queue depth 1. These are measured configurations, not provider-wide latency guarantees.

Both instances used encrypted, auto-delete-on-termination volumes and a bounded shutdown timer. GCP census after teardown showed no instances or orphan disks. AWS termination was requested and the tag-filtered volume census was empty.

No production kernel, filesystem, database, or storage settings were changed.
