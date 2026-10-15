---
rel_path: "audits/parked-agent-resumption-2026-10-09/continuation-report-2026-10-11.md"
updated_at: 1791747584094
_body: "content"
---

# Parked-agent plan continuation: verified evidence and remaining work

Avi requested continuation of session b0c174cf-b8e8-433d-abc8-50dc05fd04cc in AUTO, including its whole plan. This session has resumed parked-agent-census-resumption-and-root-cause-2026-10-09 under WI-10008017, directly, preserving the previous route. The plan remains open.

## Verified census

The frozen population is the 273 agents parked at 2026-10-10T01:09:46.552Z. A canonical PG-backed e2e test independently verified one disposition and one review row per agent, with no missing, duplicate or foreign owner. It recorded 253 explicitly unknown evidence fields. The live census and six negative controls passed 7/7; final-file typecheck is clean. Test ledger 21111403 and exact R-1 binding 37787 preserve the proof. Acceptance still needs a targeted counterexample and current fingerprints; neither the test pass nor this report claims P-001 is closed.

Disposition counts: {"resume-candidate":113,"justified-scoped-wait":88,"justified-recorded-dependency":24,"justified-idle-or-handoff":33,"justified-budget-or-time-bound":4,"justified-owner-stop-or-handoff":6,"justified-owner-pause":5}. These are decisions about the frozen audit population, not a measurement of current parked agents.

## Conditional wakes and current follow-through

All 113 resume candidates have archived required-wake requests (114 sends, including an additional capacity request). Exact owner/message joins to the retained wake ledger passed a known-positive control. Agent-origin tool activity was observed within ten minutes after a request for 43 owners; pickup is unconfirmed for 70. A queued message is not pickup. Post-wake activity does not prove that a particular message caused the turn. Outcome counts: {"turn-observed-after-wake":43,"delivery-recorded-pickup-unconfirmed":70}.

All 99 work-item refs associated with those 70 owners were read successfully after bounded retries. Current work/assignee comparison yields {"no-remaining-original-owned-work":64,"unfinished-original-owned-work":6}. A terminal or reassigned item does not imply failed delivery. The six cases with unfinished original owned work need exact native liveness and authority checks before further recovery. No second mass wake sweep was issued.

The initial draft wake-outcome artifact used a tenant predicate that matched no retained event-corpus rows; its known-positive control failed. It is disqualified as pickup evidence. The verified edition uses exact identities and a successful positive control.

## Measured detector gaps and prevention

The canonical plan ledger records P-004 through P-010 and P-012 as done. Existing completion records remain the evidence for those items; unchanged test matrices were not replayed. Plan D-012 records four measured detector gaps: disarming removed stalled-loop evidence; own inbox watchers exempted halted sessions; presence trusted a live host without checking whether its child could think; and no population alarm counted the correlated stall.

R-11 honest-liveness adequacy remains pass. The updated agent-strand alarm suite passes 10/10 on the current source. R-12 still lacks current standing-alarm live e2e proof. The maintained operator-api current-build route is :3170, but the measured serving blob does not contain the latest alarm change. No shipment, gate-green or standing-alarm recovery claim is made. The live gate lane was handed from su-521c53be to su-39585 via coordination; this session is advancing independent work.

## Remaining work

- P-001: targeted counterexample and current-fingerprint acceptance proof.
- P-002: reconcile the six remaining original-owned-work cases and record honest outcomes for the full candidate population.
- P-003: preserve this publication and complete readback, then bind report proof after the remaining audit reconciliation. The old cited rpt_8006cf99-003f-4399-9299-4f71fb0e13d8 returned not_found and is not a valid report reference.
- P-011: current-build containment and standing-alarm e2e evidence without duplicating a peer-owned gate lane.
- P-013: the required at-least-24-hour post-fix census at its real due time; a present-time census cannot substitute for that window.

Rubric revision 4 has an independent vetting consult: conv-request-e091cf2308eaa075a86d36fb94d4ee30d0c9fbf0b21149c0a7a3ebe6c2813a95. No waiver or acceptance weakening has been applied. AUTO and the 300-second warm work loop remain active.

## Canonical evidence and source

PG text-artifact keys under harness papercusp:

- audits/parked-agent-resumption-2026-10-09/dispositions.json
- audits/parked-agent-resumption-2026-10-09/wake-outcomes-2026-10-11-verified.json
- audits/parked-agent-resumption-2026-10-09/unconfirmed-owner-dispositions-2026-10-11.json
- audits/parked-agent-resumption-2026-10-09/census.json
- audits/parked-agent-resumption-2026-10-09/review-data.json
- audits/parked-agent-resumption-2026-10-09/unconfirmed-current-items-2026-10-11.json

Test source: packages/operator-core/lib/agent-tools/coordination/parked-agent-audit.e2e.test.ts. Report source: audits/parked-agent-resumption-2026-10-09/continuation-report-2026-10-11.md. Source keys let a successor recover the full evidence.

## Complete frozen-population disposition table

| Agent | Recorded disposition | Wake outcome |
| --- | --- | --- |
| su-002e59dc-96c3-4212-9569-636eafec156a | resume-candidate | turn-observed-after-wake |
| su-01248af5-137e-4f7c-82d7-1715d6ecf725 | justified-scoped-wait | not a resume candidate |
| su-01864986-d27d-497b-b501-7082b6e0caab | resume-candidate | turn-observed-after-wake |
| su-0409ed28-a00c-41b2-a14c-f98ca6181791 | justified-recorded-dependency | not a resume candidate |
| su-059e1b4e-e4fb-49d1-a4ab-085e052d4690 | justified-scoped-wait | not a resume candidate |
| su-079b1c14-07ec-495e-b640-6a60f89180e2 | justified-scoped-wait | not a resume candidate |
| su-07c1fc99-9a9a-49f3-8556-297727400441 | justified-scoped-wait | not a resume candidate |
| su-07eba67b-e1f4-48ec-9f2f-8e518ecb6eec | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-08664d7f-dbcc-4e78-b2db-f9978e6076e8 | justified-idle-or-handoff | not a resume candidate |
| su-08885e73-2abb-4866-bb49-4d876822fa05 | justified-scoped-wait | not a resume candidate |
| su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4 | resume-candidate | turn-observed-after-wake |
| su-0c1f1afa-db9d-4bbc-8852-5726660a5862 | justified-scoped-wait | not a resume candidate |
| su-0d2affd0-2198-4734-b54f-186234343375 | justified-scoped-wait | not a resume candidate |
| su-0e4db6a0-49d5-400e-acf2-121effa56c27 | justified-idle-or-handoff | not a resume candidate |
| su-0e53c244-5ba3-4d96-b499-4e233e3a8936 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-0ed5b5f3-815c-42b6-93d2-43ce620305b5 | justified-recorded-dependency | not a resume candidate |
| su-0f45ebc8-24a7-4e9b-9fee-35a3c72290d0 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-0f674e05-72fb-4dfa-9078-47f7f93ccf8c | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-0fbe2904-7a7b-48d5-b3b7-da81d592f41d | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-12c1bd39-1548-483c-b529-2888ce105cee | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-14554ce7-b9db-4aa8-a47f-ade4e4a31b89 | justified-recorded-dependency | not a resume candidate |
| su-14a0f69e-c9b4-4e9e-ace4-f19e201ef55a | justified-idle-or-handoff | not a resume candidate |
| su-14d6b6ef-6549-4c3f-bf9f-0e86a0e96f00 | resume-candidate | turn-observed-after-wake |
| su-14f4c057-33ba-432c-9207-cc57855abdf8 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-166e1335-67a7-4e39-b973-5c74df3cadcb | justified-recorded-dependency | not a resume candidate |
| su-16a32d35-86cc-4e57-8137-78722f12a433 | justified-recorded-dependency | not a resume candidate |
| su-16da39cf-6e87-45f1-9c6f-7fa8915f021d | justified-scoped-wait | not a resume candidate |
| su-17442b70-89a3-4ea5-82bb-9d0ca2cab71e | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-174cad2e-5b58-42a5-858e-3925c0a45b81 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-18cc8df4-7a58-493c-a584-5975027af3ad | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-1b166a52-b343-40a5-8ba5-b60a7e0aede0 | justified-recorded-dependency | not a resume candidate |
| su-1b535dd7-f7da-4b71-ac8c-a8a8b7677eb3 | justified-scoped-wait | not a resume candidate |
| su-1ece32b6-7d83-4bcc-a4de-52bd136d570f | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-1f0cf4e6-8eaf-431d-b706-01546feae136 | justified-scoped-wait | not a resume candidate |
| su-1f339db0-6173-4ee6-931d-3a54a6c8d148 | justified-scoped-wait | not a resume candidate |
| su-20441be6-e975-42ba-81d8-54fb4ab286c8 | justified-recorded-dependency | not a resume candidate |
| su-210ffd48-6f47-4a3d-85bc-1b3617b9b139 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-23c7fc91-515d-4107-b31b-74a3d0faac72 | resume-candidate | turn-observed-after-wake |
| su-23d26824-25a2-4979-9b57-a86ba389c2ca | justified-idle-or-handoff | not a resume candidate |
| su-25e533d0-1702-4875-8218-d1fb4d077be2 | justified-scoped-wait | not a resume candidate |
| su-26943f5d-c097-42e4-913a-f2ea7b2fca4a | justified-budget-or-time-bound | not a resume candidate |
| su-27479421-4171-429e-be37-2e86059290b1 | justified-recorded-dependency | not a resume candidate |
| su-298f8b56-c687-404f-99e1-d1c1e53baf0c | justified-owner-stop-or-handoff | not a resume candidate |
| su-2a56400c-0263-46b7-9667-fe2ac22cec80 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-2a7e6d3d-2b60-4531-b48f-7f036b0b9394 | justified-idle-or-handoff | not a resume candidate |
| su-2ad46958-628a-4c17-bbd6-ebe812805f73 | justified-scoped-wait | not a resume candidate |
| su-2b0b24d0-e9f4-4467-87a1-ff83cdd39d99 | justified-owner-pause | not a resume candidate |
| su-2ba0bda6-32b7-4f2f-982e-4125f317fa95 | justified-idle-or-handoff | not a resume candidate |
| su-2c2b6ea4-8d79-462b-932f-8c5a6b06a6b1 | resume-candidate | turn-observed-after-wake |
| su-2cced081-20f6-4e64-9433-87d7c393bde4 | justified-scoped-wait | not a resume candidate |
| su-2f9783e0-684c-42b7-a5ed-dff9bc582620 | justified-scoped-wait | not a resume candidate |
| su-303a40a3-ba68-43e6-9498-c3dd7872f395 | justified-recorded-dependency | not a resume candidate |
| su-3077f62c-1a5d-4be6-896c-e75866032dcb | justified-owner-stop-or-handoff | not a resume candidate |
| su-32b95ef6-169a-43ae-a8a5-e367fbc40b2b | justified-scoped-wait | not a resume candidate |
| su-32c78573-727f-415f-a3f9-4bf96246b9d1 | justified-scoped-wait | not a resume candidate |
| su-340db785-4864-494c-9d24-d9c3d4ce2f6c | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-353a50d8-bcff-423e-9334-9498ed6ff4e9 | justified-owner-pause | not a resume candidate |
| su-35487441-ba34-4a1d-ba7f-839d3585becf | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-357e43d6-080a-4a92-a347-c14d82a4232d | justified-idle-or-handoff | not a resume candidate |
| su-35abc0ff-4711-4e19-bcaf-07e6ff0da983 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-370a4d53-f815-47ea-b921-3e4fd79ad9eb | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-3790bff3-9f96-445b-a6f5-bddc36f217bf | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-37c2c6ca-c16b-4b74-a551-02e09d4f6e3f | justified-idle-or-handoff | not a resume candidate |
| su-37ffa216-14c7-4113-9981-b9b358da4155 | justified-idle-or-handoff | not a resume candidate |
| su-38c4b8ff-c242-4dbb-9b0e-b053bcb99401 | resume-candidate | turn-observed-after-wake |
| su-39465574-6834-47a3-ac4d-849b0e1824a6 | justified-scoped-wait | not a resume candidate |
| su-3c59e42e-6bb1-4f5a-a5d6-dca4b748f43b | resume-candidate | turn-observed-after-wake |
| su-3deab7ce-f92f-48b1-98f5-314de3e584f2 | resume-candidate | turn-observed-after-wake |
| su-3e76622f-f481-4032-b89c-8015f2dfa6b5 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-3e892ec3-60a5-40c1-8b7e-3c0b24d1039e | justified-recorded-dependency | not a resume candidate |
| su-3ec6d547-5bb5-4da7-a50e-0d19f35e42f2 | justified-scoped-wait | not a resume candidate |
| su-3ecaf532-8655-4072-b2c0-6bc3319221b1 | justified-owner-stop-or-handoff | not a resume candidate |
| su-41ae0aae-a1b6-4a8c-8da0-71b968bbdb12 | justified-scoped-wait | not a resume candidate |
| su-4375e570-0ffb-4d0f-8652-9d23635c5fe9 | resume-candidate | turn-observed-after-wake |
| su-449d831c-b3e3-4fad-8816-cc35d56c30cc | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-44dea2d5-1d65-4d48-a221-91975912e717 | justified-scoped-wait | not a resume candidate |
| su-44e04b45-8305-4182-813b-b5b0a931b2e0 | resume-candidate | turn-observed-after-wake |
| su-4505aee9-2ce2-4c58-9b12-ddc2d4a28422 | resume-candidate | turn-observed-after-wake |
| su-45be5953-95f1-4b27-89e2-c3a1b1885f05 | justified-scoped-wait | not a resume candidate |
| su-46a58ca5-f152-40ee-9ca7-199b327b0690 | justified-scoped-wait | not a resume candidate |
| su-49768592-5c0a-440c-a629-25588de3b0d3 | justified-scoped-wait | not a resume candidate |
| su-4a152da3-3ef7-420f-a82b-bfab10cf563a | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-4d390264-fc3c-4875-a655-a71b0afcd6ef | justified-idle-or-handoff | not a resume candidate |
| su-4e1fbeb0-d056-4e46-b5a6-27d2a6e9df58 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-4f6ea469-1018-4149-ad55-3fb2883e404a | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-50591fd4-cda2-459c-af03-691c4107f736 | justified-scoped-wait | not a resume candidate |
| su-50f71624-3c60-4db3-b43d-06160dbc957c | justified-scoped-wait | not a resume candidate |
| su-512e62bc-7b1a-4b07-bd01-d677d8aa5c1f | resume-candidate | turn-observed-after-wake |
| su-517bc2b4-a5c0-447b-96a2-bc3f1940ceca | justified-recorded-dependency | not a resume candidate |
| su-533a9a79-33ef-487f-876c-41ac39337175 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-54c73bd5-e418-4a16-ba65-0a825b32ed50 | resume-candidate | turn-observed-after-wake |
| su-551357e4-5ebf-48f6-8041-11e3498ca370 | justified-idle-or-handoff | not a resume candidate |
| su-5541a53f-2723-4a0c-88a6-dd9191ffbd2a | resume-candidate | turn-observed-after-wake |
| su-55769027-ea65-49d0-a287-7d16b4b38627 | justified-idle-or-handoff | not a resume candidate |
| su-56a093dd-88b7-42e8-9d44-ee4ae9558c6f | justified-scoped-wait | not a resume candidate |
| su-56b83dff-25c8-4a9b-bacf-5c549c832931 | justified-scoped-wait | not a resume candidate |
| su-586d69f1-1289-4cd0-824c-09a6f98ee5e7 | justified-scoped-wait | not a resume candidate |
| su-592ef0c5-b0ed-47d6-ad26-a089169482a7 | justified-scoped-wait | not a resume candidate |
| su-59826d83-3b3c-4029-b504-536ae91f45dc | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-59c100a0-6221-483e-8450-055226ca7e7e | justified-recorded-dependency | not a resume candidate |
| su-5c8861e6-d074-49bc-b5d8-3a12bf29b8d4 | justified-idle-or-handoff | not a resume candidate |
| su-5cb3f995-7e62-41a0-ba2b-741473b01bdd | justified-scoped-wait | not a resume candidate |
| su-5d6e108e-cac3-4a1c-97ea-f48b6245638f | justified-idle-or-handoff | not a resume candidate |
| su-5e86e622-0a42-4e11-9cb5-b44e36856641 | resume-candidate | turn-observed-after-wake |
| su-5e90d003-e223-444a-9b03-0ee0fe2585b5 | justified-scoped-wait | not a resume candidate |
| su-5ebc55ab-9378-4418-ac14-34ccae0b872d | justified-scoped-wait | not a resume candidate |
| su-60fe2f2f-e9cb-4aff-8daf-5c96c4ad2f37 | resume-candidate | turn-observed-after-wake |
| su-610a2d46-e567-49a5-baac-9163d664f79f | resume-candidate | turn-observed-after-wake |
| su-61f9729d-fef8-416a-88a8-72293cce5695 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-625df130-d2ce-4aef-badb-9e68b6ee51d4 | justified-scoped-wait | not a resume candidate |
| su-628c6726-ef68-46b9-9503-41d9dfb337aa | justified-scoped-wait | not a resume candidate |
| su-63bb4991-a409-47dc-afd4-b4616d64c73d | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-64244b21-7448-404d-aa24-633e4d279424 | justified-idle-or-handoff | not a resume candidate |
| su-65561c09-269f-42c6-9b69-fac3c4b7f47f | justified-idle-or-handoff | not a resume candidate |
| su-6788d0ac-d425-4756-a9b3-3a451df401be | resume-candidate | turn-observed-after-wake |
| su-67c067a4-a97b-41ee-82ca-06b9be615327 | justified-scoped-wait | not a resume candidate |
| su-683ce784-8984-43ed-acd6-e5f2387405d3 | resume-candidate | turn-observed-after-wake |
| su-684c584a-3351-49ee-a145-f657d7e42237 | justified-owner-pause | not a resume candidate |
| su-69e1022f-5619-4c52-aead-87d926c1b432 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-6a88e6e9-67c3-4894-a788-754d8b618ea8 | justified-scoped-wait | not a resume candidate |
| su-6b620d7a-a070-4ecc-a63c-1c81ffc321af | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-6c382a1c-8a44-4f18-9434-d5a7dd2f65be | justified-scoped-wait | not a resume candidate |
| su-6e3cb6d4-4014-41ae-81ce-6305bc7d6a41 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-6e8d0b9f-cdc3-4c53-806f-d187a0016e5e | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-6f749f41-4859-4b62-914f-84a6958b5218 | justified-scoped-wait | not a resume candidate |
| su-704f5a66-5e60-4adf-8044-c45a75cfd9d8 | justified-scoped-wait | not a resume candidate |
| su-706a7b9d-be81-45ae-9ff3-cc402e005fa4 | justified-scoped-wait | not a resume candidate |
| su-70bd7b0b-bd59-4ea3-8288-fbe76edb24cb | justified-scoped-wait | not a resume candidate |
| su-70fcd6a0-d71e-469e-af2c-3f9faa51679b | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-72f78fbb-7e47-41ae-a842-35c83b8fcdd2 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-7449fcf0-768a-43a5-8d3f-5ab55604ac4c | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-7461b1c3-e158-4ff4-8d4c-2438f5b8bb16 | resume-candidate | turn-observed-after-wake |
| su-74a1bee4-37ce-4f09-a910-9ccb11453b71 | justified-scoped-wait | not a resume candidate |
| su-75676c8f-ed12-4217-b88d-57bd6f4043aa | resume-candidate | turn-observed-after-wake |
| su-77c82667-190c-4293-a0ea-07d4628f56c4 | justified-scoped-wait | not a resume candidate |
| su-7813359c-e643-4587-9b3f-4becb2397ea4 | justified-scoped-wait | not a resume candidate |
| su-7ac2753d-7d1d-4fd5-9a4a-e115e91d6aaf | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-7cae20c1-3295-4e19-acfe-1a6dd757c919 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-7ec704fa-dc6a-4965-bb37-13576272127a | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-7f7a83bc-f278-4004-abbf-72d44d5fe3f0 | justified-scoped-wait | not a resume candidate |
| su-80a51f05-4c07-4259-a883-8b9ef4b2a7ca | justified-idle-or-handoff | not a resume candidate |
| su-812af642-19bb-41ea-ba19-e20458d5759f | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-83e97357-e571-4b82-89a0-6cf75adb65a2 | justified-scoped-wait | not a resume candidate |
| su-865d00c9-ac7b-412f-8a99-ea6a76747d98 | justified-idle-or-handoff | not a resume candidate |
| su-86846503-3215-4026-b9e0-e16d2d566ba7 | justified-recorded-dependency | not a resume candidate |
| su-86cd7f0e-8929-469b-af96-e7ff9ead8e01 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-86f4bd71-5d4f-428e-b008-24aae14be09d | justified-scoped-wait | not a resume candidate |
| su-88019212-f9e1-4476-84af-91cad67de6e4 | justified-scoped-wait | not a resume candidate |
| su-8a3c6c59-d24f-4e34-97b3-9ad3905f5d30 | justified-scoped-wait | not a resume candidate |
| su-8a9800a4-640b-4cb2-a51c-d5169128023c | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-8aec963c-1284-4a99-85f6-64e3dd62c82f | justified-idle-or-handoff | not a resume candidate |
| su-8c25125d-002d-4b93-9f83-6b463da9ca9b | justified-owner-pause | not a resume candidate |
| su-8ec23f4a-5d17-4f1c-bf4c-790edb53f5e3 | justified-scoped-wait | not a resume candidate |
| su-928e075d-6320-4ecf-9149-8c86187a9ed8 | justified-scoped-wait | not a resume candidate |
| su-97b230d9-72a8-44eb-96b0-5d8a65e217f1 | resume-candidate | turn-observed-after-wake |
| su-97b68245-28a2-431e-a1c4-a0d018969d9a | justified-scoped-wait | not a resume candidate |
| su-9844199a-9ccd-4c7b-a47c-03bea510ee31 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-98e0d4ff-6025-49e3-aba1-c1d3e5606cd9 | justified-recorded-dependency | not a resume candidate |
| su-98e61f58-9674-4d6a-88fd-b9cd6194fc9b | justified-idle-or-handoff | not a resume candidate |
| su-99042929-9493-4ec9-b63b-71ba18544ec9 | justified-scoped-wait | not a resume candidate |
| su-990b747e-c51f-482f-bf3d-8ffaa2b9ec34 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-99548e16-a948-4a0f-b8d9-3f30e2c081b5 | resume-candidate | turn-observed-after-wake |
| su-9b0d7528-da21-48ce-92a6-c98ca8c4777e | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-9b9af65b-ec38-4e45-a98b-eacd7ff3dea5 | resume-candidate | turn-observed-after-wake |
| su-9c390ec4-e133-49e5-84e3-626df801f124 | resume-candidate | turn-observed-after-wake |
| su-9d21d3d8-e614-42de-aca6-d0e1b76dc574 | justified-scoped-wait | not a resume candidate |
| su-9d2295e7-3ce3-4776-a70e-21d3adb8b0a5 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c | justified-budget-or-time-bound | not a resume candidate |
| su-9dfd3ffc-fb7b-40bf-b625-d93dbab9f002 | justified-owner-stop-or-handoff | not a resume candidate |
| su-9e66a68d-2451-4a45-88db-633a23171b79 | justified-idle-or-handoff | not a resume candidate |
| su-9e82325a-829a-4424-b916-b06bd154ebe7 | resume-candidate | turn-observed-after-wake |
| su-a0207b03-ccc8-43e2-8830-e47a09f36573 | justified-scoped-wait | not a resume candidate |
| su-a0a2e2b0-4f63-4cef-8ea9-578a3fdd222f | justified-scoped-wait | not a resume candidate |
| su-a14b1fa2-6c97-4925-b315-2ff2e766522a | justified-scoped-wait | not a resume candidate |
| su-a1cfa7fb-6d21-4bf0-b4aa-7482a73212a7 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-a3dc1235-44f0-46d9-b149-40240a0a1c57 | justified-scoped-wait | not a resume candidate |
| su-a8d3f4c4-6268-47bb-9b42-c2a653e75e9f | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-a969f93a-6e0b-4c86-a1c0-a5cf3283af8f | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-a973d2b0-0677-4a5b-b483-93676730c9e9 | justified-idle-or-handoff | not a resume candidate |
| su-aa1f2cd7-e0ea-49ea-9d02-75db53df9a2d | justified-idle-or-handoff | not a resume candidate |
| su-abcc8192-01b5-40d9-8b5b-6f7a16f2e327 | justified-idle-or-handoff | not a resume candidate |
| su-ac4f14a4-6c8b-45da-821b-73196391b494 | justified-idle-or-handoff | not a resume candidate |
| su-acd7804d-5729-4946-b02a-ca953853bffe | justified-scoped-wait | not a resume candidate |
| su-ad69d345-2a2e-44dc-91e1-82214609ff1a | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-aeed2f5d-9af7-4557-88e8-93ec7a01fd3b | justified-scoped-wait | not a resume candidate |
| su-af19b8e7-8887-4ddf-9de9-705fd2a19071 | justified-recorded-dependency | not a resume candidate |
| su-b0dc22a9-95e3-42f5-8047-1ba27be48c9c | resume-candidate | turn-observed-after-wake |
| su-b11f76ed-5823-4fe4-a597-1ebc5c3a441e | resume-candidate | turn-observed-after-wake |
| su-b24bba70-8532-4c3f-8894-8a098a016b31 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-b36b4692-520c-4a71-ae87-d0399bd81c9e | justified-scoped-wait | not a resume candidate |
| su-b4028e2d-590a-4d1c-9256-b44536574813 | justified-scoped-wait | not a resume candidate |
| su-b53bc730-cf97-42c1-804a-906e355053c2 | justified-scoped-wait | not a resume candidate |
| su-b77e72a0-b7bc-43db-b575-94b173a2e747 | justified-recorded-dependency | not a resume candidate |
| su-b7c19363-b01a-46ad-a273-0ff5ba5e9d85 | justified-recorded-dependency | not a resume candidate |
| su-b83c1f62-d5f3-49a7-b59d-e38fa0ecf97d | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-b90c2f86-5497-4fa0-ad9a-387132dc9730 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-b91607b7-df27-4a74-9397-560f19919e6a | justified-scoped-wait | not a resume candidate |
| su-b9ccbf0d-131b-4a64-aca3-90987d99d842 | justified-recorded-dependency | not a resume candidate |
| su-bce4e498-fbb7-4457-acc3-1ae2215875e0 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-bf22e2b4-9980-4a5b-9ec8-1ee8a4438e97 | justified-scoped-wait | not a resume candidate |
| su-c00a1144-9b15-4d4e-bbaf-2a54f757753c | resume-candidate | turn-observed-after-wake |
| su-c337f447-0612-44d3-99a2-e5b38d27ce1d | justified-scoped-wait | not a resume candidate |
| su-c358e0aa-3674-4c87-a65b-60d4d3a563de | justified-recorded-dependency | not a resume candidate |
| su-c832d9a7-6920-4550-9674-9cf05dcc513a | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-c9ae39e2-b027-4be1-b7ce-b145b8e53269 | justified-idle-or-handoff | not a resume candidate |
| su-c9cbdca9-7cd0-4b58-a69c-7645de562968 | resume-candidate | turn-observed-after-wake |
| su-cc7811cb-e5a2-4fba-aa88-82b8b0af286b | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-cca022c6-abd0-481c-bac8-5b2515247196 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-ccfd0e9f-ea87-46bf-8ad6-e9f4241b3317 | justified-recorded-dependency | not a resume candidate |
| su-cdc9a540-470a-4660-bffc-f0d3cfd0b4c4 | justified-scoped-wait | not a resume candidate |
| su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-ceb257ba-7560-4474-b6de-d607f2afb5cb | justified-recorded-dependency | not a resume candidate |
| su-cf144a16-16f8-4e0b-9385-34a3c60a4c36 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-d04734a3-55b6-4397-aa78-f94023423da4 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-d0fb6abc-1ba4-474b-b6e9-daa36b6a9b6c | justified-scoped-wait | not a resume candidate |
| su-d2b7c180-b846-4373-952d-f49edf8be253 | resume-candidate | turn-observed-after-wake |
| su-d2bef231-4ef2-4c42-9add-dad274e2f895 | justified-idle-or-handoff | not a resume candidate |
| su-d3049251-af5c-495b-a1c5-d4e4340ec073 | resume-candidate | turn-observed-after-wake |
| su-d34a76e0-ade1-430e-84fe-89b693e92c31 | justified-idle-or-handoff | not a resume candidate |
| su-d3f260f3-10dd-410f-a483-64a8aa6d94f2 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-d589b5a0-2b4e-4413-a74a-430577e14cd5 | justified-scoped-wait | not a resume candidate |
| su-d66bf8ac-bf4f-4301-aa8a-cd76a2d290f6 | justified-idle-or-handoff | not a resume candidate |
| su-d759f7bc-0b18-43bd-8945-b839fa0e54c9 | justified-owner-pause | not a resume candidate |
| su-d97ef8cb-cd98-4096-a72f-2f0688f09628 | justified-scoped-wait | not a resume candidate |
| su-dab96471-48c6-40bf-a2b6-2ec7c5b052ca | justified-owner-stop-or-handoff | not a resume candidate |
| su-dae9d804-7887-4fc2-b09f-d62f9430b5ba | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-dc48eb8d-8c60-4b48-92a1-b1ee56a65e79 | justified-scoped-wait | not a resume candidate |
| su-dcaa01f6-a834-4620-b9b3-7ee1adaa1f38 | justified-scoped-wait | not a resume candidate |
| su-dcd843d2-bf3a-4f37-a5cd-05ebddcd1d60 | justified-scoped-wait | not a resume candidate |
| su-dd6af82f-1cd4-4cdb-bcf8-ebe921942a3d | justified-idle-or-handoff | not a resume candidate |
| su-ddac0f5b-1a6b-43fc-b881-754ab28175ee | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-e0a45d80-1eb9-40e6-af6e-0887fef50a37 | justified-recorded-dependency | not a resume candidate |
| su-e0efb68c-1eb5-4534-98b2-fe366eb857e1 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-e16e0da4-f858-4e10-9665-55116edbc36b | resume-candidate | turn-observed-after-wake |
| su-e29e77de-45ec-4677-b1b4-3b662ab57a95 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-e2f4c8b8-3d4a-4f05-9607-d7de17e558f4 | justified-scoped-wait | not a resume candidate |
| su-e3191a37-985b-4177-9f59-181a69c62184 | justified-scoped-wait | not a resume candidate |
| su-e6d2a824-e413-4321-9aea-6600c71cec71 | resume-candidate | turn-observed-after-wake |
| su-e7208581-4177-450e-a2a9-65d871758d61 | justified-budget-or-time-bound | not a resume candidate |
| su-e72eb90d-23bb-4363-aaf7-72e4c693c881 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-e73f3cf2-60fb-4dac-a033-59d3910c9ea7 | resume-candidate | turn-observed-after-wake |
| su-e78cc6d7-340f-49eb-baf6-4fc6ca294d16 | resume-candidate | turn-observed-after-wake |
| su-e8964bb1-c0e6-4428-84bd-bddf54976b53 | justified-scoped-wait | not a resume candidate |
| su-e8f92eda-9acd-460a-8c73-6fbd9130712a | justified-recorded-dependency | not a resume candidate |
| su-e936dd5c-ed94-4761-906f-bed388f43e14 | justified-scoped-wait | not a resume candidate |
| su-ea145858-8dc8-4602-ae3d-675eb6c2b804 | resume-candidate | turn-observed-after-wake |
| su-eba6d9a4-c73d-4ef0-b785-1c57e7fd356a | justified-scoped-wait | not a resume candidate |
| su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a | justified-budget-or-time-bound | not a resume candidate |
| su-ec67d65a-222d-4bc0-8d52-c81e99a00bbf | justified-idle-or-handoff | not a resume candidate |
| su-eda09d85-f3fc-4068-bbfb-f87524bbbf4a | justified-scoped-wait | not a resume candidate |
| su-edcdd485-a437-46e6-b59c-b5f09ce2be92 | resume-candidate | turn-observed-after-wake |
| su-f31eb02a-1307-4b7a-98ca-001a0574178e | resume-candidate | turn-observed-after-wake |
| su-f396b11e-37a2-43bb-a889-dc1564575118 | justified-scoped-wait | not a resume candidate |
| su-f57d18ae-a195-4e83-a82b-458ef3338a12 | justified-scoped-wait | not a resume candidate |
| su-f5fc3980-cd07-43d9-8931-d48d75988a29 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-f685e5bb-5716-4aa5-ab3f-93a419738d63 | justified-recorded-dependency | not a resume candidate |
| su-f6b6fcca-f4f9-484f-86ca-974378824a67 | justified-scoped-wait | not a resume candidate |
| su-f74b7aee-6039-400b-b877-20f58ce42c84 | justified-idle-or-handoff | not a resume candidate |
| su-f943ed28-5fdf-4bb5-a258-7d7f814319d3 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-f9c6b250-0e9a-4fa8-85d3-0d6edf183297 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-fa27e6b4-1980-41c8-b300-fef994f43ab8 | justified-scoped-wait | not a resume candidate |
| su-fa29568b-c401-4f26-9b9c-8c337c7b11d1 | justified-scoped-wait | not a resume candidate |
| su-fa4c1948-0cb1-4552-a7a3-dc274c5e1b0a | justified-scoped-wait | not a resume candidate |
| su-faf26552-0633-4081-a250-172c02f07c19 | resume-candidate | turn-observed-after-wake |
| su-fbce18bf-ab91-435d-b28b-fe11815ad7da | justified-idle-or-handoff | not a resume candidate |
| su-fc5749a7-6632-4f73-9c99-8b475641e7e2 | justified-owner-stop-or-handoff | not a resume candidate |
| su-fd4ae72d-2102-4f99-8356-c14f46ead16f | resume-candidate | turn-observed-after-wake |
| su-ff119829-de01-43d3-9eda-2211cb4ccc36 | justified-scoped-wait | not a resume candidate |
| su-respawn-03e7b214f48eef2846ff673f14bfc298 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-respawn-302388a21ed7ab77379045848faa0690 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-respawn-78a1739f77e4338214bd25b427cca743 | resume-candidate | turn-observed-after-wake |
| su-respawn-d4be19ee8a5d30542446e0190ae6afe4 | resume-candidate | delivery-recorded-pickup-unconfirmed |
| su-respawn-f5b5aaaedcd83439ae8e1d33621374ae | justified-scoped-wait | not a resume candidate |

