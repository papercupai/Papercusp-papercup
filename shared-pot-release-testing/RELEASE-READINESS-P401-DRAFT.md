# P-401 GO/NO-GO — PRE-DRAFT (UNSIGNED)

> **Current audit pin — 2026-10-13, WI-10004684 (su-3ecaf532).**
> D-223/D-224 nominate the PRIVATE candidate at superproject
> `faa5abc1730ded04d2dfe5fcf829edec6b7b93bb`, build identity `2018b667`.
> Manifest SHA256: `b613a6186c18fa89c16a72b15fc7a51436ebed3df85b68d455be883bbc2e10af`.
> Evidence bank: `/mnt/data/offload/papercusp-private-release-evidence/su-07164/wi10007067-d223-20261013T0241Z`.
> This pin supersedes the 0.0.28-alpha pin below for the current independent
> P-401 audit. The older rows remain historical evidence, requiring individual
> reconciliation before signing; their GO-eligible label is not a current verdict.
> D-179 separates this audit from publication; D-224 excludes ARM and requires
> P-521 on these exact bytes. Publication, tagging, seed-census and managed-release
> checks remain in the publication lane. P-521 completion and independent review
> are pending. **UNSIGNED: no GO or publication approval is asserted here.**

> **STATUS: DRAFT. NOT A SIGNATURE. NOT A VERDICT.** Pre-synthesized under endgame
> `p2p-public-release-endgame-2026-09-01#D-117` lane L4 (WI-2039882) by su-84e43fbb, 2026-10-01.
> The governing signed verdict is still the head block of `RELEASE-READINESS.md`
> (2026-08-27, NO-GO). Do not quote this file as a GO.
>
> **Revision 2026-10-02 23:4xZ (su-84e43fbb, leader order g:8c90c376).** Retargeted from 0.0.27 to
> **0.0.28-alpha** (`#D-126`: the 0.0.27 tag is burned, so 0.0.28-alpha is cut with full history).
> Folds in `#D-132` (no soak holds publication), `#D-136`/`#D-138` (no doc-vector seed in 0.0.28),
> `#D-139` (P-521 accepts on the Linux two-host rig only) and `#D-140`…`#D-148` (seed credential
> rulings). Only §3 (the P-521 row) and the §0 verdict/GO-signature line stay open.
>
> **How this becomes a signature.** Per `#D-009`, P-401 signs the CURRENT
> `RELEASE-READINESS.md` and names the evidence pin separately. When (1) P-521 is done on the
> final 0.0.28-alpha candidate, (2) the independent GO (L3, WI-10004684) is signed, and (3) the
> endgame leader confirms, this block is filled in at the `⟦P-521⟧` and `⟦PIN⟧` markers,
> re-verified row by row against live state, and prepended to `RELEASE-READINESS.md` as its new
> head verdict. This file is then deleted.
>
> **Signer lineage (checked, per check `p401-signer-must-be-unconflicted`).** su-84e43fbb has not
> authored any part of `RELEASE-READINESS.md`, any coordination-slice block, D-008, or any
> Phase 2/3/6 implementation item. It is also not L3 (the independent GO signer) and not L1 (the
> cut). Re-check at signing time.

## 0. Verdict line (to be completed)

**VERDICT — ⟦pending⟧ (P-401, WI-2039882, per `p2p-public-release-endgame-2026-09-01#D-017`/`#D-117`).**

- Evidence pin: ⟦PIN: 0.0.28-alpha artifact identity — version, source sha (the contained
  promoted source satisfying `#D-122`), artifact digests, manifest id from P-519; taken from the
  `release:candidate-artifact:desktop-v0.0.28-alpha` payload⟧. Before P-521 the frozen witness
  candidate was build #6 / superproject `5be66dc6905c` (remaining-lanes `#D-159`, P-102); later
  pins (531fcc2863, e5516b47f81e, 0.0.22–0.0.26) are superseded (`#D-009` §0, `#D-065`…`#D-074`,
  `#D-080`, `#D-114`). 0.0.26 is retired (`#D-114`). The 0.0.27 tag is burned and can never be
  signed (`#D-126`).
- Document version signed: the `RELEASE-READINESS.md` blob at signing time (record
  `git rev-parse staging:shared-pot-release-testing/RELEASE-READINESS.md`), per `#D-008` §3 / `#D-009`.
- What a GO means here (P-401 text, `remaining-lanes#D-158`): witness green, blockers settled,
  soak/chaos SCHEDULED post-GO. The canary soak (P-501) and Leg-G chaos (P-502) do NOT gate GO.
  For 0.0.28-alpha, `#D-132` (owner directive) goes further: no 24h or 72h soak, and no P-501
  completion, may hold PUBLICATION either. That supersedes `#D-128`'s 24h soak. The route is:
  contained promoted source (`#D-122`) → cut/build/bundle audits → exact-artifact
  install/drill/journeys (P-521) → independent GO → publish under standing approval.

**Provisional reading on every row except P-521: GO-eligible.** No row below is a standing
blocker. The verdict therefore turns on P-521 and the independent GO.

## 1. The two named blockers of the 2026-08-27 / 08-22 signatures

| Blocker | Disposition | Evidence |
|---|---|---|
| **W1** — owner-frame post-restart self-classification | 🟢 RETIRED on evidence | P-301 / WI-2039875: remaining-lanes `#D-067` bar (3 consecutive clean `0 rows origin=remote` order-82 readings, each with a passing in-run frame-b positive control) met at n=3: runs `m1788342442`, `m1788365793`, `m1788385269`. |
| **WI-40537** — revocation k-cut | 🟢 SETTLED, not a breach | P-302 / WI-2039877: local-matrix `--frames=3` on the repacked pinned `.deb` (`p302-gate.deb`, pin `5be66dc6` build #6): `revocation_kcut` (order 90) PASS. Leg (a): banned frame B received no post-ban content; pre-ban stayed readable. Leg (b): no red reproduced on the pinned candidate. Never describe this as a confirmed read-access breach. |
| **P-506 / D-069** (headline of 08-27) | ⏹ superseded by P-101 | P-304 / WI-2039880 ruled D-074/D-069 current. Its condition, a new clean current-HEAD seeded Server artifact, was met by P-101 / WI-2039869 (build #6, 0.0.18 x64, `gitDirty=false`, pristine-clone build). The final artifact is P-521's. |

## 2. Rows by endgame item (everything except P-521)

Legend: 🟢 evidenced · 🟡 shipped with a named limitation · ⏩ post-GO by ruling · ⟦P-521⟧ pending re-proof on the final artifact.

### Phase 0 — rig custody
| Item | Row | Status | Evidence |
|---|---|---|---|
| P-002 | Tower outbox drain stall (EI-21848848412437329) | 🟢 | WI-2039864: drain 2 rows / oldest 2s (vs 85 / 70.7h); root fix `#D-126` 7e6507106d; drain watchdog + quarantine guards, 17 tests green. |
| P-003 | bg-host OOM at 4.5GB heap (EI-21855287664853515) | 🟢 | WI-2039865: root fix c34f5e1 (bounded memory scopes), 48min steady state, 0 heap/OOM warnings, RSS plateau 4.0G. |
| P-004 | D-158 one clean sample + custody gate | 🟢 | WI-2039866: clean tower/VM/probe sample 2026-09-02 07:03–07:15Z on build #6; `p008:vm-rig-custody-safe` fired. |
| P-005 | Durable rig custody | 🟢 | WI-2039868: runbook, event parking, claim release on session death, Mac identity-mirror recurrence guard. |

### Phase 1 — pinned witness candidate
| P-101 | Clean current-HEAD seeded Server artifact | 🟢 | WI-2039869: build #6, provenance `gitHead f3bb0288…`, `gitDirty=false`, pristine boot. |
| P-102 | Pin recorded | 🟢 | WI-2039870: remaining-lanes `#D-159` (superproject `5be66dc6905c`). Superseded for the final verdict by ⟦PIN⟧. |

### Phase 2 — witnesses + live acceptance (current build; exact-artifact re-proof is P-521)
| P-201 | Coordination-only live witness | 🟢 (slice 🟡) | WI-2039871: coordination P-008 17/17 on the real two-machine rig (CC-1..5, CR-1..4, CD-0..7). The slice still carries its observability residual (silent multi-hour federation stalls); see the 09-02 coordination-slice signature and P-512's exact consistency predicate. |
| P-202 | LIVE-2 work distribution, two hosts | 🟢 current build · ⟦P-521⟧ | `#D-072`: VM build 587f459be598, claude seat PASS=7 FAIL=0 (WD-2..WD-7 incl. real seat consumption, receipt at tower); codex seat run PASS=7. `#D-011`: v1 delegated seats ship unmetered and the two non-v1 LIVE-2 legs are explicit skips. |
| P-203 | hive-git Leg A storage + join | 🟢 current build · ⟦P-521⟧ | `#D-073`: fresh join (P-007 run #16) + pot-git/substrate convergence, VM LIVE-ALL 39/39 logs `notConverged=0` (VM build fc5dbddfb2c8). Full-history join is release scope (`#D-058`). |
| P-204 | hive-git Leg E GitHub-bridge flip | 🟢 current build · ⟦P-521⟧ | `#D-078`: P-505 run 32 zero-skip PASS, runId `p505-physical-20260929T030713Z-2208938`. |
| P-504 | VM-rejoin federation storm (WI-2141185) | 🟢 | WI-2141418: root-caused and fixed on three fronts, committed, live-proven on the rig. |

### Phase 3 — evidence settlement
| P-301 | W1 | 🟢 | §1. |
| P-302 | WI-40537 | 🟢 | §1. |
| P-303 | Signed gate verdicts (gate_verdicts had zero rows) | 🟢 | WI-2039879: signing wired at verdict write, deterministic ids, backfill converged. |
| P-304 | P-506 contradiction | 🟢 | §1. |
| P-305 | P-511 independent audit | 🟢 audit half | WI-2039881 / `#D-008` §2: Phase-6 code evidence passes on re-measured greens, 142/142 (runIds `21ac9bab…`, `61b3697f…`). The auditor was barred from signing. Remaining-lanes P-511 itself closes on endgame evidence (`#D-090`, lane L5a). |

### Phase 4 — packaging
| P-402 | Packaging prerequisites | 🟢 / 👤 | WI-2039883: packaging freshness and arm64 parity green. Code-signing certificates: owner-supplied input. ⟦re-check at signing: supplied, or explicitly owner-waived for alpha (P-523 / WI-2147009 traced the requirements)⟧. |

### Phase 6 — pre-public contract hardening (`#D-016`: required release scope)
| P-512 | F1 exact release consistency ≠ stall health | 🟢 source | WI-2144473. |
| P-513 | F2 signed Git announcement protocol | 🟢 source | WI-2144474 (`#D-021`). |
| P-514 | F3 one serving/signing identity | 🟢 source · ⟦P-521⟧ | WI-2144475; packaged two-machine proof moved into P-521 (`#D-036`). |
| P-515 | F4 durable unapplied-write recovery | 🟢 source · ⟦P-521⟧ | WI-2144476; outage/replay journey is a P-521 line. |
| P-516 | F5 delegated-seat privilege boundary | 🟢 source · ⟦P-521⟧ | WI-2144477; seat-stop fix is required on the final cut (`#D-080`). |
| P-517 | F6 sink-fenced exclusive effects | 🟢 source · ⟦P-521⟧ | WI-2144478; packaged proof is a P-521 line (`#D-037`). |
| P-518 | F7 headless witness runtime, reproducible | 🟢 source · ⟦P-521⟧ | WI-2144479. |
| P-519 | F8 computed readiness manifest | 🟢 source · ⟦P-521⟧ | WI-2144480; the manifest for ⟦PIN⟧ is generated in P-521. |
| P-520 | Public v1 scope and claims contract | 🟢 | WI-2144481: explicit exclusions incl. 256-peer validation, so RELEASE-READINESS §2.1 row 14 (mesh scale 🟡, measured to 64 peers) is outside the v1 claim. |

### Phase 7 — parallel preparation
| P-522 | Independent pre-GO audit of the hardened contract | 🟢 | WI-2147007. ⟦re-check: every finding closed or carried into P-521⟧. |
| P-523 | Installer + signing preflight | 🟢 preflight | WI-2147009: adequacy card EI-24010665109374029 9/9. |
| P-524 | Canary/chaos execution readiness | 🟢 preflight | WI-2147010. |

### 0.0.28-alpha content rulings (settled; the L3 GO audits them on the artifact)
| Ruling | Row | Status | Evidence |
|---|---|---|---|
| `#D-136` / `#D-138` | Doc-vector seed | 🟡 named limitation | Not admitted to the frozen lineage. 0.0.28-alpha ships the 0.0.27 first-boot embed behaviour; the seed rides the next gate cycle. |
| `#D-140`…`#D-144` | Seed credential findings | 🟢 ruled · L3 verifies | Exceptions bind exact match content plus decrypted-plaintext evidence (`#D-140`). Plaintext clearance is approved (`#D-141`). The Kasm fixture credential is sanitized and the seed regenerated; the 62 sealed epoch-key envelopes are accepted under a structural, fail-closed exemption (`#D-142`/`#D-143`). Case-insensitive matching is allowed with a post-hoc exact-case equality check (`#D-144`). |
| `#D-145`…`#D-148` | Seed cut safety + legacy aliases | 🟢 ruled · L3 verifies | The seed-cut retry runs under a shared bg-host fence with a read-only probe (`#D-145`). Legacy bare-key aliases that still carry the Kasm literal get one audited, guarded outbox PUT each (`#D-146`, widened to the whole class by `#D-148`). The validator's admissible provisional classes and their fail-closed proofs are set out in `#D-147` (a preparatory L3 ruling, not a GO). |
| `#D-139` | Platform scope of P-521 | 🟢 ruled | P-521 accepts on the Linux two-host rig (Server .deb on the VM + tower). Mac and Windows rows are out of scope; the Mac baseline and Windows SSH findings are warn-only on WI-10004688. |

### Post-GO (do not gate GO or 0.0.28 publication; `remaining-lanes#D-158` (3), `#D-117`, `#D-132`)
| P-501 | Canary soak, hive-canary (`#D-041`) | ⏩ non-blocking | `#D-132`: no soak duration and no P-501 completion holds 0.0.28-alpha publication (supersedes `#D-128`). Observation may still run once 0.0.28 is on the canary. |
| P-502 | Leg-G owner-freeze chaos drill | ⏩ | `#D-155`: typed deps moved from [P-501, P-517] to [P-401, P-517]. Never a 0.0.28 publication dependency (`#D-132`/`#D-153`). A current-build rehearsal is staged on WI-10004688 (rehearsal only, never evidence, per `#D-152`). |
| P-503 | Default hiveGit.mode decision | ⏩ | `#D-155`: blockedBy moved from [P-501] to [P-401]. Its "72h canary evidence" wording now reads "P-501 observation evidence exists, no minimum duration". |

## 3. The P-521 row — ⟦to be filled at signing⟧

| P-521 | Integrated hardened-artifact acceptance on ⟦PIN⟧ (0.0.28-alpha, Linux two-host rig per `#D-139`) | ⟦pending⟧ | ⟦WI-2144482 completion: journeys F1–F8 + discovery/join + Git + serving identity + outage/replay + seat boot/work/receipts/stop + P-202/P-203/P-204 re-proof on the exact artifact; drill 3 (WI-10004688) + journeys (WI-10004750); manifest id; independent component acceptance⟧ |

Independent GO (L3, WI-10004684; current holder ⟦re-check at signing⟧, last seen su-respawn-d08b654c): ⟦GO/NO-GO, timestamp, what it verified: artifact, manifest, D-112 identity gate, seed contents per `#D-140`…`#D-148`⟧.

## 4. Discrepancies to resolve before signing (found during this pre-draft)

1. **Work-item ↔ plan drift.** Plan items P-202, P-203 and P-204 are `done` (`#D-072`/`#D-073`/`#D-078`).
   As of 2026-10-02 23:4xZ WI-2039872 reads `done`, but WI-2039873 and WI-2039874 still read `blocked`. Hand to L7
   (code-truth audit) / P-404; the signature should not cite a `blocked` WI as its evidence.
2. **WI-2039881 (P-305) completion summary is only its title.** The real evidence is `#D-008` and post 81357.
   Cite those, not the WI summary.
3. **The pre-P-521 head verdict text names P-506/D-069 as the blocker.** At signing, the new head block
   must say plainly that P-101 + P-521 supersede it, so a reader does not hit two contradictory heads.
4. **Code-signing input (P-402).** Confirm the current status (supplied, or owner-waived for alpha) from
   live state at signing time; do not carry the 2026-09 "pending" reading forward.
