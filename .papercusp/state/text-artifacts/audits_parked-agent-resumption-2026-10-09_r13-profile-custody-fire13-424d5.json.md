---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-profile-custody-fire13-424d5.json"
updated_at: 1791805511919
_body: "content"
---

{
  "schemaVersion": "parked-profile-custody-v1",
  "workItem": "WI-6554700010008887",
  "sourceAsOf": "2026-10-10T01:09:46.552Z",
  "scope": "Original 273 parked-audit members; these dispositions certify R2 candidates/waits, not an independently frozen R13 wedged eligibility list.",
  "sourceRefs": [
    "census.json",
    "review-data.json",
    "dispositions.json"
  ],
  "sql": "WITH a AS (SELECT rel_path,updated_at,content::jsonb c FROM harness_shared.harness_text_artifacts WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND rel_path IN ('audits/parked-agent-resumption-2026-10-09/census.json','audits/parked-agent-resumption-2026-10-09/review-data.json','audits/parked-agent-resumption-2026-10-09/dispositions.json')), c AS (SELECT r->'presence'->>'ownerId' owner_id,r->'presence'->'model' model FROM a CROSS JOIN LATERAL jsonb_array_elements(c->'records') r WHERE rel_path LIKE '%/census.json'), l AS (SELECT r->>'ownerId' owner_id,r->'loop'->'loop'->>'carry' carry FROM a CROSS JOIN LATERAL jsonb_array_elements(c->'rows') r WHERE rel_path LIKE '%/review-data.json'), d AS (SELECT r->>'ownerId' owner_id,r->>'decision' decision FROM a CROSS JOIN LATERAL jsonb_array_elements(c->'decisions') r WHERE rel_path LIKE '%/dispositions.json') SELECT c.owner_id,c.model,l.carry,d.decision FROM c LEFT JOIN l USING(owner_id) LEFT JOIN d USING(owner_id) ORDER BY c.owner_id",
  "account": "not recorded by these original artifacts",
  "rows": [
    {
      "owner_id": "su-002e59dc-96c3-4212-9569-636eafec156a",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-01248af5-137e-4f7c-82d7-1715d6ecf725",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-01864986-d27d-497b-b501-7082b6e0caab",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-0409ed28-a00c-41b2-a14c-f98ca6181791",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-059e1b4e-e4fb-49d1-a4ab-085e052d4690",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-079b1c14-07ec-495e-b640-6a60f89180e2",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-07c1fc99-9a9a-49f3-8556-297727400441",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-07eba67b-e1f4-48ec-9f2f-8e518ecb6eec",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-08664d7f-dbcc-4e78-b2db-f9978e6076e8",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-08885e73-2abb-4866-bb49-4d876822fa05",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-0c1f1afa-db9d-4bbc-8852-5726660a5862",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-0d2affd0-2198-4734-b54f-186234343375",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-0e4db6a0-49d5-400e-acf2-121effa56c27",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-0e53c244-5ba3-4d96-b499-4e233e3a8936",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-0ed5b5f3-815c-42b6-93d2-43ce620305b5",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-0f45ebc8-24a7-4e9b-9fee-35a3c72290d0",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-0f674e05-72fb-4dfa-9078-47f7f93ccf8c",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-0fbe2904-7a7b-48d5-b3b7-da81d592f41d",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-12c1bd39-1548-483c-b529-2888ce105cee",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-14554ce7-b9db-4aa8-a47f-ade4e4a31b89",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-14a0f69e-c9b4-4e9e-ace4-f19e201ef55a",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-14d6b6ef-6549-4c3f-bf9f-0e86a0e96f00",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-14f4c057-33ba-432c-9207-cc57855abdf8",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-166e1335-67a7-4e39-b973-5c74df3cadcb",
      "model": null,
      "carry": "warm",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-16a32d35-86cc-4e57-8137-78722f12a433",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-16da39cf-6e87-45f1-9c6f-7fa8915f021d",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-17442b70-89a3-4ea5-82bb-9d0ca2cab71e",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-174cad2e-5b58-42a5-858e-3925c0a45b81",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-18cc8df4-7a58-493c-a584-5975027af3ad",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-1b166a52-b343-40a5-8ba5-b60a7e0aede0",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-1b535dd7-f7da-4b71-ac8c-a8a8b7677eb3",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-1ece32b6-7d83-4bcc-a4de-52bd136d570f",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-1f0cf4e6-8eaf-431d-b706-01546feae136",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-1f339db0-6173-4ee6-931d-3a54a6c8d148",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-20441be6-e975-42ba-81d8-54fb4ab286c8",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-210ffd48-6f47-4a3d-85bc-1b3617b9b139",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-23c7fc91-515d-4107-b31b-74a3d0faac72",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-23d26824-25a2-4979-9b57-a86ba389c2ca",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-25e533d0-1702-4875-8218-d1fb4d077be2",
      "model": null,
      "carry": null,
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-26943f5d-c097-42e4-913a-f2ea7b2fca4a",
      "model": null,
      "carry": "warm",
      "decision": "justified-budget-or-time-bound"
    },
    {
      "owner_id": "su-27479421-4171-429e-be37-2e86059290b1",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
      "model": null,
      "carry": "cold",
      "decision": "justified-owner-stop-or-handoff"
    },
    {
      "owner_id": "su-2a56400c-0263-46b7-9667-fe2ac22cec80",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-2a7e6d3d-2b60-4531-b48f-7f036b0b9394",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-2ad46958-628a-4c17-bbd6-ebe812805f73",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-2b0b24d0-e9f4-4467-87a1-ff83cdd39d99",
      "model": null,
      "carry": "warm",
      "decision": "justified-owner-pause"
    },
    {
      "owner_id": "su-2ba0bda6-32b7-4f2f-982e-4125f317fa95",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-2c2b6ea4-8d79-462b-932f-8c5a6b06a6b1",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-2cced081-20f6-4e64-9433-87d7c393bde4",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-2f9783e0-684c-42b7-a5ed-dff9bc582620",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-303a40a3-ba68-43e6-9498-c3dd7872f395",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-3077f62c-1a5d-4be6-896c-e75866032dcb",
      "model": null,
      "carry": "warm",
      "decision": "justified-owner-stop-or-handoff"
    },
    {
      "owner_id": "su-32b95ef6-169a-43ae-a8a5-e367fbc40b2b",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-32c78573-727f-415f-a3f9-4bf96246b9d1",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-340db785-4864-494c-9d24-d9c3d4ce2f6c",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-353a50d8-bcff-423e-9334-9498ed6ff4e9",
      "model": null,
      "carry": "warm",
      "decision": "justified-owner-pause"
    },
    {
      "owner_id": "su-35487441-ba34-4a1d-ba7f-839d3585becf",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-357e43d6-080a-4a92-a347-c14d82a4232d",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-35abc0ff-4711-4e19-bcaf-07e6ff0da983",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-370a4d53-f815-47ea-b921-3e4fd79ad9eb",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-3790bff3-9f96-445b-a6f5-bddc36f217bf",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-37c2c6ca-c16b-4b74-a551-02e09d4f6e3f",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-37ffa216-14c7-4113-9981-b9b358da4155",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-38c4b8ff-c242-4dbb-9b0e-b053bcb99401",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-39465574-6834-47a3-ac4d-849b0e1824a6",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-3c59e42e-6bb1-4f5a-a5d6-dca4b748f43b",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-3deab7ce-f92f-48b1-98f5-314de3e584f2",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-3e76622f-f481-4032-b89c-8015f2dfa6b5",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-3e892ec3-60a5-40c1-8b7e-3c0b24d1039e",
      "model": null,
      "carry": "warm",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-3ec6d547-5bb5-4da7-a50e-0d19f35e42f2",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-3ecaf532-8655-4072-b2c0-6bc3319221b1",
      "model": null,
      "carry": null,
      "decision": "justified-owner-stop-or-handoff"
    },
    {
      "owner_id": "su-41ae0aae-a1b6-4a8c-8da0-71b968bbdb12",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-4375e570-0ffb-4d0f-8652-9d23635c5fe9",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-449d831c-b3e3-4fad-8816-cc35d56c30cc",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-44dea2d5-1d65-4d48-a221-91975912e717",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-44e04b45-8305-4182-813b-b5b0a931b2e0",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-4505aee9-2ce2-4c58-9b12-ddc2d4a28422",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-45be5953-95f1-4b27-89e2-c3a1b1885f05",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-46a58ca5-f152-40ee-9ca7-199b327b0690",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-49768592-5c0a-440c-a629-25588de3b0d3",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-4a152da3-3ef7-420f-a82b-bfab10cf563a",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-4d390264-fc3c-4875-a655-a71b0afcd6ef",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-4e1fbeb0-d056-4e46-b5a6-27d2a6e9df58",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-4f6ea469-1018-4149-ad55-3fb2883e404a",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-50591fd4-cda2-459c-af03-691c4107f736",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-50f71624-3c60-4db3-b43d-06160dbc957c",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-512e62bc-7b1a-4b07-bd01-d677d8aa5c1f",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-517bc2b4-a5c0-447b-96a2-bc3f1940ceca",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-533a9a79-33ef-487f-876c-41ac39337175",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-54c73bd5-e418-4a16-ba65-0a825b32ed50",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-551357e4-5ebf-48f6-8041-11e3498ca370",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-5541a53f-2723-4a0c-88a6-dd9191ffbd2a",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-55769027-ea65-49d0-a287-7d16b4b38627",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-56a093dd-88b7-42e8-9d44-ee4ae9558c6f",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-56b83dff-25c8-4a9b-bacf-5c549c832931",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-586d69f1-1289-4cd0-824c-09a6f98ee5e7",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-592ef0c5-b0ed-47d6-ad26-a089169482a7",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-59826d83-3b3c-4029-b504-536ae91f45dc",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-59c100a0-6221-483e-8450-055226ca7e7e",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-5c8861e6-d074-49bc-b5d8-3a12bf29b8d4",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-5cb3f995-7e62-41a0-ba2b-741473b01bdd",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-5d6e108e-cac3-4a1c-97ea-f48b6245638f",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-5e86e622-0a42-4e11-9cb5-b44e36856641",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-5e90d003-e223-444a-9b03-0ee0fe2585b5",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-5ebc55ab-9378-4418-ac14-34ccae0b872d",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-60fe2f2f-e9cb-4aff-8daf-5c96c4ad2f37",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-610a2d46-e567-49a5-baac-9163d664f79f",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-61f9729d-fef8-416a-88a8-72293cce5695",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-625df130-d2ce-4aef-badb-9e68b6ee51d4",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-628c6726-ef68-46b9-9503-41d9dfb337aa",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-63bb4991-a409-47dc-afd4-b4616d64c73d",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-64244b21-7448-404d-aa24-633e4d279424",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-65561c09-269f-42c6-9b69-fac3c4b7f47f",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-6788d0ac-d425-4756-a9b3-3a451df401be",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-67c067a4-a97b-41ee-82ca-06b9be615327",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-683ce784-8984-43ed-acd6-e5f2387405d3",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-684c584a-3351-49ee-a145-f657d7e42237",
      "model": null,
      "carry": "warm",
      "decision": "justified-owner-pause"
    },
    {
      "owner_id": "su-69e1022f-5619-4c52-aead-87d926c1b432",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-6a88e6e9-67c3-4894-a788-754d8b618ea8",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-6b620d7a-a070-4ecc-a63c-1c81ffc321af",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-6c382a1c-8a44-4f18-9434-d5a7dd2f65be",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-6e3cb6d4-4014-41ae-81ce-6305bc7d6a41",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-6e8d0b9f-cdc3-4c53-806f-d187a0016e5e",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-6f749f41-4859-4b62-914f-84a6958b5218",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-704f5a66-5e60-4adf-8044-c45a75cfd9d8",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-706a7b9d-be81-45ae-9ff3-cc402e005fa4",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-70bd7b0b-bd59-4ea3-8288-fbe76edb24cb",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-70fcd6a0-d71e-469e-af2c-3f9faa51679b",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-72f78fbb-7e47-41ae-a842-35c83b8fcdd2",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-7449fcf0-768a-43a5-8d3f-5ab55604ac4c",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-7461b1c3-e158-4ff4-8d4c-2438f5b8bb16",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-74a1bee4-37ce-4f09-a910-9ccb11453b71",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-75676c8f-ed12-4217-b88d-57bd6f4043aa",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-77c82667-190c-4293-a0ea-07d4628f56c4",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-7813359c-e643-4587-9b3f-4becb2397ea4",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-7ac2753d-7d1d-4fd5-9a4a-e115e91d6aaf",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-7cae20c1-3295-4e19-acfe-1a6dd757c919",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-7ec704fa-dc6a-4965-bb37-13576272127a",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-7f7a83bc-f278-4004-abbf-72d44d5fe3f0",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-80a51f05-4c07-4259-a883-8b9ef4b2a7ca",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-812af642-19bb-41ea-ba19-e20458d5759f",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-83e97357-e571-4b82-89a0-6cf75adb65a2",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-865d00c9-ac7b-412f-8a99-ea6a76747d98",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-86846503-3215-4026-b9e0-e16d2d566ba7",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-86cd7f0e-8929-469b-af96-e7ff9ead8e01",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-86f4bd71-5d4f-428e-b008-24aae14be09d",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-88019212-f9e1-4476-84af-91cad67de6e4",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-8a3c6c59-d24f-4e34-97b3-9ad3905f5d30",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-8a9800a4-640b-4cb2-a51c-d5169128023c",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-8aec963c-1284-4a99-85f6-64e3dd62c82f",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-8c25125d-002d-4b93-9f83-6b463da9ca9b",
      "model": null,
      "carry": "warm",
      "decision": "justified-owner-pause"
    },
    {
      "owner_id": "su-8ec23f4a-5d17-4f1c-bf4c-790edb53f5e3",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-928e075d-6320-4ecf-9149-8c86187a9ed8",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-97b230d9-72a8-44eb-96b0-5d8a65e217f1",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-97b68245-28a2-431e-a1c4-a0d018969d9a",
      "model": null,
      "carry": null,
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-9844199a-9ccd-4c7b-a47c-03bea510ee31",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-98e0d4ff-6025-49e3-aba1-c1d3e5606cd9",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-98e61f58-9674-4d6a-88fd-b9cd6194fc9b",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-99042929-9493-4ec9-b63b-71ba18544ec9",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-990b747e-c51f-482f-bf3d-8ffaa2b9ec34",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-99548e16-a948-4a0f-b8d9-3f30e2c081b5",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-9b0d7528-da21-48ce-92a6-c98ca8c4777e",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-9b9af65b-ec38-4e45-a98b-eacd7ff3dea5",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-9c390ec4-e133-49e5-84e3-626df801f124",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-9d21d3d8-e614-42de-aca6-d0e1b76dc574",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-9d2295e7-3ce3-4776-a70e-21d3adb8b0a5",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
      "model": null,
      "carry": "warm",
      "decision": "justified-budget-or-time-bound"
    },
    {
      "owner_id": "su-9dfd3ffc-fb7b-40bf-b625-d93dbab9f002",
      "model": null,
      "carry": "cold",
      "decision": "justified-owner-stop-or-handoff"
    },
    {
      "owner_id": "su-9e66a68d-2451-4a45-88db-633a23171b79",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-9e82325a-829a-4424-b916-b06bd154ebe7",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-a0207b03-ccc8-43e2-8830-e47a09f36573",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-a0a2e2b0-4f63-4cef-8ea9-578a3fdd222f",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-a14b1fa2-6c97-4925-b315-2ff2e766522a",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-a1cfa7fb-6d21-4bf0-b4aa-7482a73212a7",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-a3dc1235-44f0-46d9-b149-40240a0a1c57",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-a8d3f4c4-6268-47bb-9b42-c2a653e75e9f",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-a969f93a-6e0b-4c86-a1c0-a5cf3283af8f",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-a973d2b0-0677-4a5b-b483-93676730c9e9",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-aa1f2cd7-e0ea-49ea-9d02-75db53df9a2d",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-abcc8192-01b5-40d9-8b5b-6f7a16f2e327",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-ac4f14a4-6c8b-45da-821b-73196391b494",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-acd7804d-5729-4946-b02a-ca953853bffe",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-ad69d345-2a2e-44dc-91e1-82214609ff1a",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-aeed2f5d-9af7-4557-88e8-93ec7a01fd3b",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-af19b8e7-8887-4ddf-9de9-705fd2a19071",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-b0dc22a9-95e3-42f5-8047-1ba27be48c9c",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-b11f76ed-5823-4fe4-a597-1ebc5c3a441e",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-b24bba70-8532-4c3f-8894-8a098a016b31",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-b36b4692-520c-4a71-ae87-d0399bd81c9e",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-b4028e2d-590a-4d1c-9256-b44536574813",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-b53bc730-cf97-42c1-804a-906e355053c2",
      "model": null,
      "carry": null,
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-b77e72a0-b7bc-43db-b575-94b173a2e747",
      "model": null,
      "carry": "warm",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-b7c19363-b01a-46ad-a273-0ff5ba5e9d85",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-b83c1f62-d5f3-49a7-b59d-e38fa0ecf97d",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-b90c2f86-5497-4fa0-ad9a-387132dc9730",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-b91607b7-df27-4a74-9397-560f19919e6a",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-b9ccbf0d-131b-4a64-aca3-90987d99d842",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-bce4e498-fbb7-4457-acc3-1ae2215875e0",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-bf22e2b4-9980-4a5b-9ec8-1ee8a4438e97",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-c00a1144-9b15-4d4e-bbaf-2a54f757753c",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-c337f447-0612-44d3-99a2-e5b38d27ce1d",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-c358e0aa-3674-4c87-a65b-60d4d3a563de",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-c832d9a7-6920-4550-9674-9cf05dcc513a",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-c9ae39e2-b027-4be1-b7ce-b145b8e53269",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-c9cbdca9-7cd0-4b58-a69c-7645de562968",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-cc7811cb-e5a2-4fba-aa88-82b8b0af286b",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-cca022c6-abd0-481c-bac8-5b2515247196",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-ccfd0e9f-ea87-46bf-8ad6-e9f4241b3317",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-cdc9a540-470a-4660-bffc-f0d3cfd0b4c4",
      "model": null,
      "carry": null,
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-ceb257ba-7560-4474-b6de-d607f2afb5cb",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-cf144a16-16f8-4e0b-9385-34a3c60a4c36",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-d04734a3-55b6-4397-aa78-f94023423da4",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-d0fb6abc-1ba4-474b-b6e9-daa36b6a9b6c",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-d2b7c180-b846-4373-952d-f49edf8be253",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-d2bef231-4ef2-4c42-9add-dad274e2f895",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-d3049251-af5c-495b-a1c5-d4e4340ec073",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-d34a76e0-ade1-430e-84fe-89b693e92c31",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-d3f260f3-10dd-410f-a483-64a8aa6d94f2",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-d589b5a0-2b4e-4413-a74a-430577e14cd5",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-d66bf8ac-bf4f-4301-aa8a-cd76a2d290f6",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-d759f7bc-0b18-43bd-8945-b839fa0e54c9",
      "model": null,
      "carry": "warm",
      "decision": "justified-owner-pause"
    },
    {
      "owner_id": "su-d97ef8cb-cd98-4096-a72f-2f0688f09628",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-dab96471-48c6-40bf-a2b6-2ec7c5b052ca",
      "model": null,
      "carry": "warm",
      "decision": "justified-owner-stop-or-handoff"
    },
    {
      "owner_id": "su-dae9d804-7887-4fc2-b09f-d62f9430b5ba",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-dc48eb8d-8c60-4b48-92a1-b1ee56a65e79",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-dcaa01f6-a834-4620-b9b3-7ee1adaa1f38",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-dcd843d2-bf3a-4f37-a5cd-05ebddcd1d60",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-dd6af82f-1cd4-4cdb-bcf8-ebe921942a3d",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-ddac0f5b-1a6b-43fc-b881-754ab28175ee",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-e0a45d80-1eb9-40e6-af6e-0887fef50a37",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-e0efb68c-1eb5-4534-98b2-fe366eb857e1",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-e16e0da4-f858-4e10-9665-55116edbc36b",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-e29e77de-45ec-4677-b1b4-3b662ab57a95",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-e2f4c8b8-3d4a-4f05-9607-d7de17e558f4",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-e3191a37-985b-4177-9f59-181a69c62184",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-e6d2a824-e413-4321-9aea-6600c71cec71",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-e7208581-4177-450e-a2a9-65d871758d61",
      "model": null,
      "carry": "warm",
      "decision": "justified-budget-or-time-bound"
    },
    {
      "owner_id": "su-e72eb90d-23bb-4363-aaf7-72e4c693c881",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-e73f3cf2-60fb-4dac-a033-59d3910c9ea7",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-e78cc6d7-340f-49eb-baf6-4fc6ca294d16",
      "model": null,
      "carry": null,
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-e8964bb1-c0e6-4428-84bd-bddf54976b53",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-e8f92eda-9acd-460a-8c73-6fbd9130712a",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-e936dd5c-ed94-4761-906f-bed388f43e14",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-ea145858-8dc8-4602-ae3d-675eb6c2b804",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-eba6d9a4-c73d-4ef0-b785-1c57e7fd356a",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
      "model": null,
      "carry": "warm",
      "decision": "justified-budget-or-time-bound"
    },
    {
      "owner_id": "su-ec67d65a-222d-4bc0-8d52-c81e99a00bbf",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-eda09d85-f3fc-4068-bbfb-f87524bbbf4a",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-edcdd485-a437-46e6-b59c-b5f09ce2be92",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-f31eb02a-1307-4b7a-98ca-001a0574178e",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-f396b11e-37a2-43bb-a889-dc1564575118",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-f57d18ae-a195-4e83-a82b-458ef3338a12",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-f5fc3980-cd07-43d9-8931-d48d75988a29",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-f685e5bb-5716-4aa5-ab3f-93a419738d63",
      "model": null,
      "carry": "cold",
      "decision": "justified-recorded-dependency"
    },
    {
      "owner_id": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-f74b7aee-6039-400b-b877-20f58ce42c84",
      "model": null,
      "carry": null,
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-f943ed28-5fdf-4bb5-a258-7d7f814319d3",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-f9c6b250-0e9a-4fa8-85d3-0d6edf183297",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-fa27e6b4-1980-41c8-b300-fef994f43ab8",
      "model": null,
      "carry": "warm",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-fa29568b-c401-4f26-9b9c-8c337c7b11d1",
      "model": null,
      "carry": null,
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-fa4c1948-0cb1-4552-a7a3-dc274c5e1b0a",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-faf26552-0633-4081-a250-172c02f07c19",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-fbce18bf-ab91-435d-b28b-fe11815ad7da",
      "model": null,
      "carry": "warm",
      "decision": "justified-idle-or-handoff"
    },
    {
      "owner_id": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
      "model": null,
      "carry": "cold",
      "decision": "justified-owner-stop-or-handoff"
    },
    {
      "owner_id": "su-fd4ae72d-2102-4f99-8356-c14f46ead16f",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-ff119829-de01-43d3-9eda-2211cb4ccc36",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    },
    {
      "owner_id": "su-respawn-03e7b214f48eef2846ff673f14bfc298",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-respawn-302388a21ed7ab77379045848faa0690",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-respawn-78a1739f77e4338214bd25b427cca743",
      "model": null,
      "carry": "cold",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-respawn-d4be19ee8a5d30542446e0190ae6afe4",
      "model": null,
      "carry": "warm",
      "decision": "resume-candidate"
    },
    {
      "owner_id": "su-respawn-f5b5aaaedcd83439ae8e1d33621374ae",
      "model": null,
      "carry": "cold",
      "decision": "justified-scoped-wait"
    }
  ]
}
