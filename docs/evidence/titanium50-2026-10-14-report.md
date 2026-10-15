Avi, the 50-agent test is complete: all 50 real **gpt-6-luna, low-effort** Codex sessions passed six warm-up tasks and six wake tasks each, with **zero failed wakes**. The test VM was deleted through the existing capacity rails, its disk census is empty, and the private gateway tunnel is inactive.

**Recommendation:** keep zstd zram as the first memory cushion. Titanium SSD is substantially faster than the earlier N2 Local SSD setup, but this test does not justify moving to a storage-optimized VM just to obtain swap. Lz4 trades compression density for faster reclaim. Smaller wake batches improve observed responsiveness while substantially delaying completion of the whole group.

The earlier N2 disk was not Google's fastest Local SSD generation. Google's current documentation identifies **Titanium SSD** as a newer generation with higher IOPS, throughput and lower latency. This test used one 3,000 GiB Titanium device on `z3-highmem-8-highlssd`, with 8 vCPUs and 64 GiB RAM in `us-central1-a`. It is a measured, budget-bounded Titanium configuration; larger multi-device shapes advertise higher aggregate performance, so this is not a claim to have tested Google's absolute maximum storage configuration.

The accepted run lasted 20 minutes 38 seconds, from 23:17:51 to 23:38:29 UTC on 2026-10-14. Native session records independently confirm the model, low effort, 300 successful file-hash warm tasks and 300 successful wake tasks. Each session ran real shell tools against dummy data through the read-only sandbox and used real model responses through a private SSH forward. Upstream credentials were not copied to the VM.

The 50 warm sessions occupied about 4.5 GiB of anonymous resident memory. We then explicitly reclaimed each agent's cgroup, moving about 91 MiB per agent into swap, waited 60 seconds, and woke them. The host had ample physical RAM: **this tests forced paging and wake behavior for 50 real sessions, not maximum host capacity or 50 large production contexts under sustained pressure**. There was one fixed-order pass per setting, not a randomized repeated trial.

| Setting | Reclaim all 50 | Compression, original / RAM used | Prompt echo p50 / max | Probe fork+exec p99 |
|---|---:|---:|---:|---:|
| RAM baseline | — | — | 326 / 449 ms | 2.35 ms |
| zram, zstd | 24.0 s | 4.53× | 327 / 525 ms | 2.17 ms |
| zram, lz4 | 9.5 s | 3.12× | 294 / 485 ms | 2.04 ms |
| Titanium, default page-cluster=3 | 3.0 s | — | 302 / 462 ms | 6.17 ms |
| Titanium, page-cluster=0 | 3.0 s | — | 294 / 551 ms | 2.22 ms |
| Titanium, batches of five | 2.7 s | — | 68 / 81 ms | 1.70 ms |

Titanium reclaimed these pages about eight times as quickly as zstd and about three times as quickly as lz4. Lz4 reclaimed about 2.5 times as quickly as zstd, but needed about 1,355 MiB of RAM to hold the compressed pages versus 923 MiB with zstd. That is roughly 47% more compressed RAM for this data. Prefer zstd when density matters; lz4 is a plausible choice when faster reclaim matters more.

`page-cluster=0` produced no clear improvement in median prompt echo in this single run. Its probe tail was lower, but that is insufficient to call it a general speedup. Batched wakes reduced observed prompt echo and probe delay, but the harness also sends fewer inputs at once; this improvement cannot be assigned entirely to page-in speed. All 50 completed in about **190 seconds with batches of five**, compared with **24 seconds for simultaneous Titanium wakes**.

| Setting | Full task reply p50 | Time from first submission until all 50 replies |
|---|---:|---:|
| RAM | 20.60 s | 26.35 s |
| zstd zram | 15.05 s | 21.00 s |
| lz4 zram | 34.72 s | 42.75 s |
| Titanium default | 13.61 s | 24.07 s |
| Titanium page-cluster=0 | 27.90 s | 34.87 s |
| Titanium batches of five | 13.18 s per submitted batch member | 189.82 s |

These full reply timings include real inference and gateway latency. Their variation is much larger than the prompt-echo differences: **they do not establish that swap makes inference faster or that lz4 makes it slower**. Prompt echo itself includes the controller's input dispatch and rendering, rather than measuring only page faults. The host probe is a lightweight responsiveness signal, not an interactive desktop acceptance test. Disk swap-used also retains swap-cache slots after page-in, so resident growth and fault counters are the relevant evidence; a flat swap-used value is not proof that nothing paged back in.

The disk-only fio measurements used the maintained driver's direct-I/O jobs against a prefilled 4 GiB region:

| fio job | Earlier N2 Local SSD | Z3 Titanium SSD |
|---|---:|---:|
| 4 KiB random read, queue depth 1 | 7,706 IOPS; p50 119.3 µs | 12,304 IOPS; p50 75.3 µs |
| 4 KiB random read, queue depth 32 | 179,997 IOPS | 315,829 IOPS |
| 4 KiB random write, queue depth 32 | 100,008 IOPS | 339,681 IOPS |
| 1 MiB sequential read, queue depth 8 | 737.7 MB/s | 3,225.0 MB/s |

That is about 4.4× the sequential-read throughput and 37% lower median queue-depth-one read latency on these measured configurations. The N2 measurement was from the earlier four-vCPU VM, while Z3 has eight vCPUs; this is a whole-configuration comparison, not an isolated SSD-generation experiment. Multi-device striping was not measured here. It can raise aggregate bandwidth, but does not establish lower latency for one serial page fault.

Current Cloud Billing Catalog list prices were read at 23:08 UTC for `us-central1`, on-demand, USD, before discounts:

| Resource | Unit price | Normalized cost for 32 GiB |
|---|---:|---:|
| E2 RAM | $0.00292353/GiB-hour | $68.29/month |
| N2 RAM | $0.004237/GiB-hour | $98.98/month |
| Z3 RAM | $0.0066553/GiB-hour | $155.47/month |
| Z3 Titanium SSD | $0.08/GiB-month | $2.56/month at unit price, **not purchasable as a 32 GiB attachment** |
| C4 Titanium SSD | $0.16/GiB-month | $5.12/month at unit price, with a compatible VM and disk-size minimum |

The important minimum is **3,000 GiB on the tested Z3 shape: $240/month for its Titanium storage alone**. CPU, RAM and the 50 GiB boot disk bring that configuration to approximately **$1.1602/hour, or $846.97 per 730-hour month**. By comparison, another 32 GiB of N2 RAM costs about **$0.1356/hour** before other shape constraints. Buying this Z3 just for swap is therefore unattractive at this workload size despite SSD's much lower per-GiB price. If a suitable Titanium-equipped VM is already needed for other work, using its spare local storage for a swap fallback is a different incremental-cost decision. Local SSD is ephemeral and is not durable data storage.

The VM carried the existing six-hour self-delete limit and a $6.97 worst-case admitted infrastructure label. That is a budget bound, not an invoice. Model inference and network charges are excluded from these infrastructure figures. The programme's existing admission and teardown protections were reused; no new provisioning service was introduced.

The maintained harness needed fixes before this result could be trusted: Z3 maintenance-policy admission, native input readiness without an optional status line, cleanup of surviving systemd scopes, distro Bubblewrap/AppArmor prerequisites, and native successful-tool validation rather than accepting a model's DONE text alone. Observed output variants and bounded corrections are covered by the canonical suite. **20 swap-tier tests and 30 capacity-rail tests passed.** The broader scripts typecheck reported two errors only in the separate `premises-gate.ts` source; that follow-up remains assigned to this session as **EI-25998869405647921**. This report does not claim the whole repository typechecks or that these source edits have been promoted to production.

Evidence is saved under `docs/evidence/titanium50-2026-10-14-*`: final summary, raw results, probe samples, run log, original native JSONL archive, per-agent native verification, failed-attempt evidence, fio measurements, current SKU prices, VM identity, verified teardown and tunnel receipts. The driver SHA-256 in the native receipt matches the local source used for the accepted run. Work item: **WI-6554700010013508**. Harness fixes: **EI-25997441249806391** and **EI-25998255851637754**. Their completion evidence was recorded; automatic commit-content settlement is separate from the measured benchmark result.

Sources: [Google Local SSD and Titanium performance](https://cloud.google.com/compute/docs/disks/local-ssd), [Z3 machine types](https://cloud.google.com/compute/docs/storage-optimized-machines#z3_machine_types), [Cloud Billing Catalog API](https://cloudbilling.googleapis.com/v1/services/6F81-5844-456A/skus), and [official OpenAI documentation for Linux sandbox prerequisites](https://developers.openai.com/codex/sandboxing).
