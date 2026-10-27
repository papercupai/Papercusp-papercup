---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/personal-social-dispatch-20261025-a/fixed-20261025.witness.json"
updated_at: 1792955728227
_body: "content"
---

{
  "schemaVersion": 1,
  "protocolSha256": "59774d28ce2c9f16f4dcda66b739a0b33c6556eb22400d315f86322ee166ce77",
  "testSha256": "e55854ef6f74c818bbf451c63364034fcb9d4e18751f17e49e436b7edfd94136",
  "declared": [
    "projected-fields",
    "content-and-candidates",
    "grant-transitions",
    "personal-disclosure",
    "social-disclosure",
    "social-unattributed-withholding"
  ],
  "executed": [
    "projected-fields",
    "content-and-candidates",
    "grant-transitions",
    "personal-disclosure",
    "social-disclosure",
    "social-unattributed-withholding"
  ],
  "unexecuted": [],
  "sourcePins": [
    {
      "path": "packages/operator-core/lib/agent-tools/personal/search.ts",
      "sha256": "2c1fc8082d17bc67aa7217d061b44c2b2693cacd644fcb46e954f324f4f91e52"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/social/search.ts",
      "sha256": "2cbd735c14234fd59be88e47f509bf7ec1beddb71906e691d2369575af7284dc"
    },
    {
      "path": "packages/operator-core/lib/capability-verbs/social-read.ts",
      "sha256": "ed0a0e69ed71468d28d048368b83fc2cfc12934ad8e6045aff8b5b3869587559"
    },
    {
      "path": "packages/operator-core/lib/capability-verbs/social.ts",
      "sha256": "3acf02ca8c420e5f9af12cf20005a1eeb8b8a1d7e3441111287a5ed2c7b810c7"
    },
    {
      "path": "packages/operator-core/lib/personal-vault/store.ts",
      "sha256": "a808eeeedb6083e886a0d543a66fa731a38ac1598776b7c3101139032cdb4bd8"
    },
    {
      "path": "packages/operator-core/lib/personal-vault/authorization.ts",
      "sha256": "af62e324b78e6b47188c506a407001adaf7050ac27787a347f205fbc41378368"
    },
    {
      "path": "packages/operator-core/lib/personal-vault/disclosure-ledger.ts",
      "sha256": "f4705cf44e5c051427a63211dd66ed67b7ed8bc2121124b41c75f6c734f63243"
    },
    {
      "path": "packages/operator-core/lib/personal-vault/disclosure-labels.ts",
      "sha256": "4ae83755f27e08389b76f2451dabb794aacffbde49956316a962a611a1f84561"
    },
    {
      "path": "packages/operator-core/lib/integrations/provider-registry.ts",
      "sha256": "8f3f5ac8493ebd57332dd0dfa59a30c47ef18567b96eb6ac898ae6adf7d3bb29"
    },
    {
      "path": "packages/operator-core/lib/capability-verbs/social-provider.fixture.ts",
      "sha256": "d6eebee0990d40c4b920bf5723a7a7a379eda762f5cf7c6a189764f69802727f"
    },
    {
      "path": "libs/generic/tooldef/src/dispatch-projected.ts",
      "sha256": "888b3b2a32a2f45713cdc4f0737960ee1fa7834db73b9084702ce1c736aeb9aa"
    },
    {
      "path": "libs/generic/tooldef/src/dispatch-stack.ts",
      "sha256": "a51a5f5d3b820d2026a00fcbadc164f1d6975a2a1ab4f98bc421000000c7844f"
    },
    {
      "path": "libs/papercusp/libs/db/sql/1414-vault-mail-partition.sql",
      "sha256": "3c94440911c7bd496a745fcbaa05c62d56482ac6f03f2a4b708495fb25d302be"
    }
  ],
  "cleanup": "dropped",
  "receipts": [
    {
      "surface": "personal:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6423"
          },
          {
            "id": "7fd672ec-d055-427d-b9ed-39f02a3e5507",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6426"
          },
          {
            "id": "dee4bc1d-2aea-448f-b023-1a167552ec0a",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6420"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "7f45adc4-439b-4f3c-b988-fe814aa11ae7",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:11.722452-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:11.710937-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
        "readAtMs": 1792955651828
      },
      "after": {
        "docs": [
          {
            "id": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6423"
          },
          {
            "id": "7fd672ec-d055-427d-b9ed-39f02a3e5507",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6426"
          },
          {
            "id": "dee4bc1d-2aea-448f-b023-1a167552ec0a",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6420"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "7f45adc4-439b-4f3c-b988-fe814aa11ae7",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:11.722452-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:11.710937-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
        "readAtMs": 1792955651865
      },
      "requestStartedAtMs": 1792955651825,
      "responseAtMs": 1792955651863,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "grantedScopes": [
          "personal:mail"
        ],
        "vectorLeg": "unavailable",
        "results": [
          {
            "id": "dee4bc1d-2aea-448f-b023-1a167552ec0a",
            "source": "mail",
            "scopeKey": "personal:mail",
            "sourceId": null,
            "providerAccountId": null,
            "kind": "email",
            "externalId": "cobalt-mail",
            "occurredAt": "2026-10-01 08:00:00-04",
            "participants": [
              "alice@example.test"
            ],
            "participantIds": [
              "ab2a32bf-e15f-4e63-8fb0-e241070c0e17"
            ],
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "metadata": {},
            "score": 0.01639344262295082,
            "lexicalRank": 1,
            "vectorRank": null,
            "privacy": null
          }
        ]
      },
      "fields": [
        {
          "id": "papercusp/personal:search/title",
          "input": {
            "returned": {
              "entityRef": "dee4bc1d-2aea-448f-b023-1a167552ec0a",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "dee4bc1d-2aea-448f-b023-1a167552ec0a",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e",
              "sourceRevision": "6420",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
              "readAtMs": 1792955651865
            },
            "requestStartedAtMs": 1792955651825,
            "responseAtMs": 1792955651863
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/snippet",
          "input": {
            "returned": {
              "entityRef": "dee4bc1d-2aea-448f-b023-1a167552ec0a",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "dee4bc1d-2aea-448f-b023-1a167552ec0a",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3",
              "sourceRevision": "6420",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
              "readAtMs": 1792955651865
            },
            "requestStartedAtMs": 1792955651825,
            "responseAtMs": 1792955651863
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "dee4bc1d-2aea-448f-b023-1a167552ec0a",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "dee4bc1d-2aea-448f-b023-1a167552ec0a",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6420",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
              "readAtMs": 1792955651865
            },
            "requestStartedAtMs": 1792955651825,
            "responseAtMs": 1792955651863
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "social:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6423"
          },
          {
            "id": "7fd672ec-d055-427d-b9ed-39f02a3e5507",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6426"
          },
          {
            "id": "dee4bc1d-2aea-448f-b023-1a167552ec0a",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6420"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "7f45adc4-439b-4f3c-b988-fe814aa11ae7",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:11.722452-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:11.710937-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
        "readAtMs": 1792955651869
      },
      "after": {
        "docs": [
          {
            "id": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6423"
          },
          {
            "id": "7fd672ec-d055-427d-b9ed-39f02a3e5507",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6426"
          },
          {
            "id": "dee4bc1d-2aea-448f-b023-1a167552ec0a",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6420"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "7f45adc4-439b-4f3c-b988-fe814aa11ae7",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:11.722452-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:11.710937-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
        "readAtMs": 1792955653514
      },
      "requestStartedAtMs": 1792955651867,
      "responseAtMs": 1792955653512,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "vectorLeg": "unavailable",
        "scopesSearched": [
          "personal:bluesky"
        ],
        "hits": [
          {
            "postId": "bluesky:at://did:plc:p001/app.bsky.feed.post/cobalt",
            "platform": "bluesky",
            "platformLabel": "bluesky",
            "author": "alice@example.test",
            "occurredAt": "2026-10-01 08:00:00-04",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "privacy": null,
            "score": 0.01639344262295082,
            "replyable": {
              "allowed": true
            }
          }
        ],
        "skipped": []
      },
      "fields": [
        {
          "id": "papercusp/social:search/postId",
          "input": {
            "returned": {
              "entityRef": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6423",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
              "readAtMs": 1792955653514
            },
            "requestStartedAtMs": 1792955651867,
            "responseAtMs": 1792955653512
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/title",
          "input": {
            "returned": {
              "entityRef": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0",
              "sourceRevision": "6423",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
              "readAtMs": 1792955653514
            },
            "requestStartedAtMs": 1792955651867,
            "responseAtMs": 1792955653512
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/snippet",
          "input": {
            "returned": {
              "entityRef": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc",
              "sourceRevision": "6423",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
              "readAtMs": 1792955653514
            },
            "requestStartedAtMs": 1792955651867,
            "responseAtMs": 1792955653512
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6423",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
              "readAtMs": 1792955653514
            },
            "requestStartedAtMs": 1792955651867,
            "responseAtMs": 1792955653512
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/replyable",
          "input": {
            "returned": {
              "entityRef": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "3db9f89e-4d1e-4d4a-94f5-2d14a0588653",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6423",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a13234d229965a966bdab1790827fbd7181647c88f4815b825e2e7c035b9e689",
              "readAtMs": 1792955653514
            },
            "requestStartedAtMs": 1792955651867,
            "responseAtMs": 1792955653512
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "personal:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6440"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6443"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653542
      },
      "after": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6440"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6443"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653551
      },
      "requestStartedAtMs": 1792955653541,
      "responseAtMs": 1792955653549,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "grantedScopes": [
          "personal:mail"
        ],
        "vectorLeg": "unavailable",
        "results": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "scopeKey": "personal:mail",
            "sourceId": null,
            "providerAccountId": null,
            "kind": "email",
            "externalId": "cobalt-mail",
            "occurredAt": "2026-10-01 08:00:00-04",
            "participants": [
              "alice@example.test"
            ],
            "participantIds": [
              "ab2a32bf-e15f-4e63-8fb0-e241070c0e17"
            ],
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "metadata": {},
            "score": 0.01639344262295082,
            "lexicalRank": 1,
            "vectorRank": null,
            "privacy": null
          }
        ]
      },
      "fields": [
        {
          "id": "papercusp/personal:search/title",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e",
              "sourceRevision": "6440",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653551
            },
            "requestStartedAtMs": 1792955653541,
            "responseAtMs": 1792955653549
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/snippet",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3",
              "sourceRevision": "6440",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653551
            },
            "requestStartedAtMs": 1792955653541,
            "responseAtMs": 1792955653549
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6440",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653551
            },
            "requestStartedAtMs": 1792955653541,
            "responseAtMs": 1792955653549
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "personal:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6443"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653558
      },
      "after": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6443"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653564
      },
      "requestStartedAtMs": 1792955653556,
      "responseAtMs": 1792955653563,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "grantedScopes": [
          "personal:mail"
        ],
        "vectorLeg": "unavailable",
        "results": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "scopeKey": "personal:mail",
            "sourceId": null,
            "providerAccountId": null,
            "kind": "email",
            "externalId": "cobalt-mail",
            "occurredAt": "2026-10-02 08:00:00-04",
            "participants": [
              "alice@example.test"
            ],
            "participantIds": [
              "ab2a32bf-e15f-4e63-8fb0-e241070c0e17"
            ],
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "metadata": {},
            "score": 0.01639344262295082,
            "lexicalRank": 1,
            "vectorRank": null,
            "privacy": null
          }
        ]
      },
      "fields": [
        {
          "id": "papercusp/personal:search/title",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6455",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653564
            },
            "requestStartedAtMs": 1792955653556,
            "responseAtMs": 1792955653563
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/snippet",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6455",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653564
            },
            "requestStartedAtMs": 1792955653556,
            "responseAtMs": 1792955653563
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6455",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653564
            },
            "requestStartedAtMs": 1792955653556,
            "responseAtMs": 1792955653563
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "personal:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "e9d049ee-93f7-4928-9990-f81aa404baf6",
            "source": "mail",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6458"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6443"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653569
      },
      "after": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "e9d049ee-93f7-4928-9990-f81aa404baf6",
            "source": "mail",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6458"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6443"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653576
      },
      "requestStartedAtMs": 1792955653568,
      "responseAtMs": 1792955653574,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "grantedScopes": [
          "personal:mail"
        ],
        "vectorLeg": "unavailable",
        "results": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "scopeKey": "personal:mail",
            "sourceId": null,
            "providerAccountId": null,
            "kind": "email",
            "externalId": "cobalt-mail",
            "occurredAt": "2026-10-02 08:00:00-04",
            "participants": [
              "alice@example.test"
            ],
            "participantIds": [
              "ab2a32bf-e15f-4e63-8fb0-e241070c0e17"
            ],
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "metadata": {},
            "score": 0.01639344262295082,
            "lexicalRank": 1,
            "vectorRank": null,
            "privacy": null
          },
          {
            "id": "e9d049ee-93f7-4928-9990-f81aa404baf6",
            "source": "mail",
            "scopeKey": "personal:mail",
            "sourceId": null,
            "providerAccountId": null,
            "kind": "email",
            "externalId": "cobalt-new-candidate",
            "occurredAt": "2026-10-02 08:00:00-04",
            "participants": [
              "alice@example.test"
            ],
            "participantIds": [
              "ab2a32bf-e15f-4e63-8fb0-e241070c0e17"
            ],
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "metadata": {},
            "score": 0.016129032258064516,
            "lexicalRank": 2,
            "vectorRank": null,
            "privacy": null
          }
        ]
      },
      "fields": [
        {
          "id": "papercusp/personal:search/title",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6455",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653576
            },
            "requestStartedAtMs": 1792955653568,
            "responseAtMs": 1792955653574
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/snippet",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6455",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653576
            },
            "requestStartedAtMs": 1792955653568,
            "responseAtMs": 1792955653574
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6455",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653576
            },
            "requestStartedAtMs": 1792955653568,
            "responseAtMs": 1792955653574
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/title",
          "input": {
            "returned": {
              "entityRef": "e9d049ee-93f7-4928-9990-f81aa404baf6",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "e9d049ee-93f7-4928-9990-f81aa404baf6",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6458",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653576
            },
            "requestStartedAtMs": 1792955653568,
            "responseAtMs": 1792955653574
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/snippet",
          "input": {
            "returned": {
              "entityRef": "e9d049ee-93f7-4928-9990-f81aa404baf6",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "e9d049ee-93f7-4928-9990-f81aa404baf6",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6458",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653576
            },
            "requestStartedAtMs": 1792955653568,
            "responseAtMs": 1792955653574
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "e9d049ee-93f7-4928-9990-f81aa404baf6",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "e9d049ee-93f7-4928-9990-f81aa404baf6",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6458",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653576
            },
            "requestStartedAtMs": 1792955653568,
            "responseAtMs": 1792955653574
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "personal:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6443"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653579
      },
      "after": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6443"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653583
      },
      "requestStartedAtMs": 1792955653577,
      "responseAtMs": 1792955653582,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "grantedScopes": [
          "personal:mail"
        ],
        "vectorLeg": "unavailable",
        "results": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "scopeKey": "personal:mail",
            "sourceId": null,
            "providerAccountId": null,
            "kind": "email",
            "externalId": "cobalt-mail",
            "occurredAt": "2026-10-02 08:00:00-04",
            "participants": [
              "alice@example.test"
            ],
            "participantIds": [
              "ab2a32bf-e15f-4e63-8fb0-e241070c0e17"
            ],
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "metadata": {},
            "score": 0.01639344262295082,
            "lexicalRank": 1,
            "vectorRank": null,
            "privacy": null
          }
        ]
      },
      "fields": [
        {
          "id": "papercusp/personal:search/title",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6455",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653583
            },
            "requestStartedAtMs": 1792955653577,
            "responseAtMs": 1792955653582
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/snippet",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6455",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653583
            },
            "requestStartedAtMs": 1792955653577,
            "responseAtMs": 1792955653582
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6455",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653583
            },
            "requestStartedAtMs": 1792955653577,
            "responseAtMs": 1792955653582
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "social:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6443"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653585
      },
      "after": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6443"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653591
      },
      "requestStartedAtMs": 1792955653584,
      "responseAtMs": 1792955653589,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "vectorLeg": "unavailable",
        "scopesSearched": [
          "personal:bluesky"
        ],
        "hits": [
          {
            "postId": "bluesky:at://did:plc:p001/app.bsky.feed.post/cobalt",
            "platform": "bluesky",
            "platformLabel": "bluesky",
            "author": "alice@example.test",
            "occurredAt": "2026-10-01 08:00:00-04",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "privacy": null,
            "score": 0.01639344262295082,
            "replyable": {
              "allowed": true
            }
          }
        ],
        "skipped": []
      },
      "fields": [
        {
          "id": "papercusp/social:search/postId",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6443",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653591
            },
            "requestStartedAtMs": 1792955653584,
            "responseAtMs": 1792955653589
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/title",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0",
              "sourceRevision": "6443",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653591
            },
            "requestStartedAtMs": 1792955653584,
            "responseAtMs": 1792955653589
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/snippet",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc",
              "sourceRevision": "6443",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653591
            },
            "requestStartedAtMs": 1792955653584,
            "responseAtMs": 1792955653589
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6443",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653591
            },
            "requestStartedAtMs": 1792955653584,
            "responseAtMs": 1792955653589
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/replyable",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6443",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653591
            },
            "requestStartedAtMs": 1792955653584,
            "responseAtMs": 1792955653589
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "social:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653597
      },
      "after": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653603
      },
      "requestStartedAtMs": 1792955653595,
      "responseAtMs": 1792955653602,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "vectorLeg": "unavailable",
        "scopesSearched": [
          "personal:bluesky"
        ],
        "hits": [
          {
            "postId": "bluesky:at://did:plc:p001/app.bsky.feed.post/cobalt",
            "platform": "bluesky",
            "platformLabel": "bluesky",
            "author": "alice@example.test",
            "occurredAt": "2026-10-02 08:00:00-04",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "privacy": null,
            "score": 0.01639344262295082,
            "replyable": {
              "allowed": true
            }
          }
        ],
        "skipped": []
      },
      "fields": [
        {
          "id": "papercusp/social:search/postId",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653603
            },
            "requestStartedAtMs": 1792955653595,
            "responseAtMs": 1792955653602
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/title",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653603
            },
            "requestStartedAtMs": 1792955653595,
            "responseAtMs": 1792955653602
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/snippet",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653603
            },
            "requestStartedAtMs": 1792955653595,
            "responseAtMs": 1792955653602
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653603
            },
            "requestStartedAtMs": 1792955653595,
            "responseAtMs": 1792955653602
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/replyable",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653603
            },
            "requestStartedAtMs": 1792955653595,
            "responseAtMs": 1792955653602
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "social:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
            "source": "bluesky",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6465"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653608
      },
      "after": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
            "source": "bluesky",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6465"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653615
      },
      "requestStartedAtMs": 1792955653607,
      "responseAtMs": 1792955653614,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "vectorLeg": "unavailable",
        "scopesSearched": [
          "personal:bluesky"
        ],
        "hits": [
          {
            "postId": "bluesky:cobalt-new-candidate",
            "platform": "bluesky",
            "platformLabel": "bluesky",
            "author": "alice@example.test",
            "occurredAt": "2026-10-02 08:00:00-04",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "privacy": null,
            "score": 0.01639344262295082,
            "replyable": {
              "allowed": true
            }
          },
          {
            "postId": "bluesky:at://did:plc:p001/app.bsky.feed.post/cobalt",
            "platform": "bluesky",
            "platformLabel": "bluesky",
            "author": "alice@example.test",
            "occurredAt": "2026-10-02 08:00:00-04",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "privacy": null,
            "score": 0.016129032258064516,
            "replyable": {
              "allowed": true
            }
          }
        ],
        "skipped": []
      },
      "fields": [
        {
          "id": "papercusp/social:search/postId",
          "input": {
            "returned": {
              "entityRef": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
              "fieldPath": "postId",
              "valueFingerprint": "15876bec7857fedc0ff8486cf6e9ef3b10f65b6477ce954d9456d48e85e6390a"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
              "fieldPath": "postId",
              "valueFingerprint": "15876bec7857fedc0ff8486cf6e9ef3b10f65b6477ce954d9456d48e85e6390a",
              "sourceRevision": "6465",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653615
            },
            "requestStartedAtMs": 1792955653607,
            "responseAtMs": 1792955653614
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/title",
          "input": {
            "returned": {
              "entityRef": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6465",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653615
            },
            "requestStartedAtMs": 1792955653607,
            "responseAtMs": 1792955653614
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/snippet",
          "input": {
            "returned": {
              "entityRef": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6465",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653615
            },
            "requestStartedAtMs": 1792955653607,
            "responseAtMs": 1792955653614
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6465",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653615
            },
            "requestStartedAtMs": 1792955653607,
            "responseAtMs": 1792955653614
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/replyable",
          "input": {
            "returned": {
              "entityRef": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "32d88d8f-06d4-4f85-9a63-db6c08fb82d5",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6465",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653615
            },
            "requestStartedAtMs": 1792955653607,
            "responseAtMs": 1792955653614
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/postId",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653615
            },
            "requestStartedAtMs": 1792955653607,
            "responseAtMs": 1792955653614
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/title",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653615
            },
            "requestStartedAtMs": 1792955653607,
            "responseAtMs": 1792955653614
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/snippet",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653615
            },
            "requestStartedAtMs": 1792955653607,
            "responseAtMs": 1792955653614
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653615
            },
            "requestStartedAtMs": 1792955653607,
            "responseAtMs": 1792955653614
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/replyable",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653615
            },
            "requestStartedAtMs": 1792955653607,
            "responseAtMs": 1792955653614
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "social:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653619
      },
      "after": {
        "docs": [
          {
            "id": "2620de88-5bd8-4e8d-b906-3c9693b1330c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6455"
          },
          {
            "id": "b7e2c7db-c548-4187-a26e-1ffa3ce8d4ca",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6446"
          },
          {
            "id": "ea5c525e-dbd8-4bad-8971-674b4357682c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "d9636669-e610-491e-bd03-b05bfc091a3f",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.524032-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.523004-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
        "readAtMs": 1792955653626
      },
      "requestStartedAtMs": 1792955653617,
      "responseAtMs": 1792955653624,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "vectorLeg": "unavailable",
        "scopesSearched": [
          "personal:bluesky"
        ],
        "hits": [
          {
            "postId": "bluesky:at://did:plc:p001/app.bsky.feed.post/cobalt",
            "platform": "bluesky",
            "platformLabel": "bluesky",
            "author": "alice@example.test",
            "occurredAt": "2026-10-02 08:00:00-04",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "privacy": null,
            "score": 0.01639344262295082,
            "replyable": {
              "allowed": true
            }
          }
        ],
        "skipped": []
      },
      "fields": [
        {
          "id": "papercusp/social:search/postId",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653626
            },
            "requestStartedAtMs": 1792955653617,
            "responseAtMs": 1792955653624
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/title",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653626
            },
            "requestStartedAtMs": 1792955653617,
            "responseAtMs": 1792955653624
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/snippet",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653626
            },
            "requestStartedAtMs": 1792955653617,
            "responseAtMs": 1792955653624
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653626
            },
            "requestStartedAtMs": 1792955653617,
            "responseAtMs": 1792955653624
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/replyable",
          "input": {
            "returned": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "ea5c525e-dbd8-4bad-8971-674b4357682c",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6462",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "2ba359579bf7a874ce3f7bd5bc2d3f2e03da1fd0ab4eabce4fa351ef8dc7a5c4",
              "readAtMs": 1792955653626
            },
            "requestStartedAtMs": 1792955653617,
            "responseAtMs": 1792955653624
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "personal:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "13455cf6-5055-477d-8505-af65cb1fbc2f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6480"
          },
          {
            "id": "2b97c807-af02-4622-b8ac-5e5e2cf01da1",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6474"
          },
          {
            "id": "dd5bdf34-76c9-4d56-b983-a7b3c05ba35c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6477"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "38c76c9f-f330-4717-aadb-c103a24e2532",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.630949-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:14:13.645798-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.62976-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "14df575661a6e2cb4fc099c5a815504d5a2b071c6c0091b67d08cbb7816c54b3",
        "readAtMs": 1792955653647
      },
      "after": {
        "docs": [
          {
            "id": "13455cf6-5055-477d-8505-af65cb1fbc2f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6480"
          },
          {
            "id": "2b97c807-af02-4622-b8ac-5e5e2cf01da1",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6474"
          },
          {
            "id": "dd5bdf34-76c9-4d56-b983-a7b3c05ba35c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6477"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "38c76c9f-f330-4717-aadb-c103a24e2532",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.630949-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:14:13.645798-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.62976-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "14df575661a6e2cb4fc099c5a815504d5a2b071c6c0091b67d08cbb7816c54b3",
        "readAtMs": 1792955653650
      },
      "requestStartedAtMs": 1792955653646,
      "responseAtMs": 1792955653649,
      "response": {
        "allowed": false,
        "refusal": "no_live_grant",
        "results": [],
        "grantedScopes": []
      },
      "fields": []
    },
    {
      "surface": "social:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "13455cf6-5055-477d-8505-af65cb1fbc2f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6480"
          },
          {
            "id": "2b97c807-af02-4622-b8ac-5e5e2cf01da1",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6474"
          },
          {
            "id": "dd5bdf34-76c9-4d56-b983-a7b3c05ba35c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6477"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "38c76c9f-f330-4717-aadb-c103a24e2532",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.630949-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:14:13.645798-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.62976-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "14df575661a6e2cb4fc099c5a815504d5a2b071c6c0091b67d08cbb7816c54b3",
        "readAtMs": 1792955653652
      },
      "after": {
        "docs": [
          {
            "id": "13455cf6-5055-477d-8505-af65cb1fbc2f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6480"
          },
          {
            "id": "2b97c807-af02-4622-b8ac-5e5e2cf01da1",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6474"
          },
          {
            "id": "dd5bdf34-76c9-4d56-b983-a7b3c05ba35c",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6477"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "38c76c9f-f330-4717-aadb-c103a24e2532",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.630949-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:14:13.645798-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.62976-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "14df575661a6e2cb4fc099c5a815504d5a2b071c6c0091b67d08cbb7816c54b3",
        "readAtMs": 1792955653655
      },
      "requestStartedAtMs": 1792955653650,
      "responseAtMs": 1792955653653,
      "response": {
        "allowed": false,
        "refusal": "no_live_grant"
      },
      "fields": []
    },
    {
      "surface": "personal:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "125d02ba-137c-4584-ac28-3e06618fb416",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6498"
          },
          {
            "id": "9ae7aec9-495e-46d1-81d0-078f65fcd6e9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6495"
          },
          {
            "id": "edc2f09d-48f5-4450-b016-a1934dc9bcf7",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6501"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "a7759f4d-7a94-4ddb-b86b-f9c93f1ee7c1",
              "level": "participants",
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "created_at": "2026-10-25T15:14:13.676165-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:14:13.676165-04:00",
              "updated_by": "fixture-owner",
              "match_value": "mail",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "81401b80-9798-417c-83e8-004caddf1369",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.658138-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.657323-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "7bf3cb59004b1487780c9ca10372e6815a60b6235a2cd6ab111be5d4c457592d",
        "readAtMs": 1792955653678
      },
      "after": {
        "docs": [
          {
            "id": "125d02ba-137c-4584-ac28-3e06618fb416",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6498"
          },
          {
            "id": "9ae7aec9-495e-46d1-81d0-078f65fcd6e9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6495"
          },
          {
            "id": "edc2f09d-48f5-4450-b016-a1934dc9bcf7",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6501"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "a7759f4d-7a94-4ddb-b86b-f9c93f1ee7c1",
              "level": "participants",
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "created_at": "2026-10-25T15:14:13.676165-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:14:13.676165-04:00",
              "updated_by": "fixture-owner",
              "match_value": "mail",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "81401b80-9798-417c-83e8-004caddf1369",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.658138-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.657323-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "7bf3cb59004b1487780c9ca10372e6815a60b6235a2cd6ab111be5d4c457592d",
        "readAtMs": 1792955653685
      },
      "requestStartedAtMs": 1792955653677,
      "responseAtMs": 1792955653683,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "grantedScopes": [
          "personal:mail"
        ],
        "vectorLeg": "unavailable",
        "results": [
          {
            "id": "9ae7aec9-495e-46d1-81d0-078f65fcd6e9",
            "source": "mail",
            "scopeKey": "personal:mail",
            "sourceId": null,
            "providerAccountId": null,
            "kind": "email",
            "externalId": "cobalt-mail",
            "occurredAt": "2026-10-01 08:00:00-04",
            "participants": [
              "alice@example.test"
            ],
            "participantIds": [
              "ab2a32bf-e15f-4e63-8fb0-e241070c0e17"
            ],
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "metadata": {},
            "score": 0.01639344262295082,
            "lexicalRank": 1,
            "vectorRank": null,
            "privacy": {
              "level": "participants",
              "readerSet": [
                "alice@example.test"
              ]
            }
          }
        ],
        "restrictedResults": 1,
        "restrictionNote": "Results carrying `privacy` are restricted: until the owner releases them, you may send only to their privacy.readerSet (intersected across everything restricted you have read) or to the owner."
      },
      "fields": [
        {
          "id": "papercusp/personal:search/title",
          "input": {
            "returned": {
              "entityRef": "9ae7aec9-495e-46d1-81d0-078f65fcd6e9",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "9ae7aec9-495e-46d1-81d0-078f65fcd6e9",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e",
              "sourceRevision": "6495",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "7bf3cb59004b1487780c9ca10372e6815a60b6235a2cd6ab111be5d4c457592d",
              "readAtMs": 1792955653685
            },
            "requestStartedAtMs": 1792955653677,
            "responseAtMs": 1792955653683
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/snippet",
          "input": {
            "returned": {
              "entityRef": "9ae7aec9-495e-46d1-81d0-078f65fcd6e9",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "9ae7aec9-495e-46d1-81d0-078f65fcd6e9",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3",
              "sourceRevision": "6495",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "7bf3cb59004b1487780c9ca10372e6815a60b6235a2cd6ab111be5d4c457592d",
              "readAtMs": 1792955653685
            },
            "requestStartedAtMs": 1792955653677,
            "responseAtMs": 1792955653683
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/personal:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "9ae7aec9-495e-46d1-81d0-078f65fcd6e9",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "9ae7aec9-495e-46d1-81d0-078f65fcd6e9",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6495",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "7bf3cb59004b1487780c9ca10372e6815a60b6235a2cd6ab111be5d4c457592d",
              "readAtMs": 1792955653685
            },
            "requestStartedAtMs": 1792955653677,
            "responseAtMs": 1792955653683
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "social:search",
      "identity": "su-p001-personal-social-fixture",
      "before": {
        "docs": [
          {
            "id": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6522"
          },
          {
            "id": "60f8b1b4-87a9-411f-b348-057de833c856",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6525"
          },
          {
            "id": "f7f2c3be-bac2-4ba9-819f-2c8f1d313083",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6519"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "4298d960-2566-4f26-bc32-a36a9f695031",
              "level": "participants",
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "created_at": "2026-10-25T15:14:13.716945-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:14:13.716945-04:00",
              "updated_by": "fixture-owner",
              "match_value": "bluesky",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "a4499646-54ab-401a-bed3-a0dc5b5962b3",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.701021-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.700133-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "acefc63e62a12a0321546fa07cdaa7773676141dddc5b1f4855d0761d5b6c238",
        "readAtMs": 1792955653718
      },
      "after": {
        "docs": [
          {
            "id": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6522"
          },
          {
            "id": "60f8b1b4-87a9-411f-b348-057de833c856",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6525"
          },
          {
            "id": "f7f2c3be-bac2-4ba9-819f-2c8f1d313083",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6519"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "4298d960-2566-4f26-bc32-a36a9f695031",
              "level": "participants",
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "created_at": "2026-10-25T15:14:13.716945-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:14:13.716945-04:00",
              "updated_by": "fixture-owner",
              "match_value": "bluesky",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "a4499646-54ab-401a-bed3-a0dc5b5962b3",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:14:13.701021-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": null,
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "62f55160-198f-47d6-a3b9-a19306045ba0",
              "updated_at": "2026-10-25T15:14:13.700133-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "acefc63e62a12a0321546fa07cdaa7773676141dddc5b1f4855d0761d5b6c238",
        "readAtMs": 1792955653725
      },
      "requestStartedAtMs": 1792955653717,
      "responseAtMs": 1792955653724,
      "response": {
        "allowed": true,
        "principal": {
          "type": "agent-role",
          "id": "operator"
        },
        "vectorLeg": "unavailable",
        "scopesSearched": [
          "personal:bluesky"
        ],
        "hits": [
          {
            "postId": "bluesky:at://did:plc:p001/app.bsky.feed.post/cobalt",
            "platform": "bluesky",
            "platformLabel": "bluesky",
            "author": "alice@example.test",
            "occurredAt": "2026-10-01 08:00:00-04",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "privacy": {
              "level": "participants",
              "readerSet": [
                "alice@example.test"
              ]
            },
            "score": 0.01639344262295082,
            "replyable": {
              "allowed": true
            }
          }
        ],
        "skipped": [],
        "restrictedResults": 1,
        "restrictionNote": "Results carrying privacy are restricted to their privacy.readerSet (intersected across restricted content you have read) or the owner."
      },
      "fields": [
        {
          "id": "papercusp/social:search/postId",
          "input": {
            "returned": {
              "entityRef": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6522",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "acefc63e62a12a0321546fa07cdaa7773676141dddc5b1f4855d0761d5b6c238",
              "readAtMs": 1792955653725
            },
            "requestStartedAtMs": 1792955653717,
            "responseAtMs": 1792955653724
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/title",
          "input": {
            "returned": {
              "entityRef": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0",
              "sourceRevision": "6522",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "acefc63e62a12a0321546fa07cdaa7773676141dddc5b1f4855d0761d5b6c238",
              "readAtMs": 1792955653725
            },
            "requestStartedAtMs": 1792955653717,
            "responseAtMs": 1792955653724
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/snippet",
          "input": {
            "returned": {
              "entityRef": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc",
              "sourceRevision": "6522",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "acefc63e62a12a0321546fa07cdaa7773676141dddc5b1f4855d0761d5b6c238",
              "readAtMs": 1792955653725
            },
            "requestStartedAtMs": 1792955653717,
            "responseAtMs": 1792955653724
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/occurredAt",
          "input": {
            "returned": {
              "entityRef": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6522",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "acefc63e62a12a0321546fa07cdaa7773676141dddc5b1f4855d0761d5b6c238",
              "readAtMs": 1792955653725
            },
            "requestStartedAtMs": 1792955653717,
            "responseAtMs": 1792955653724
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "id": "papercusp/social:search/replyable",
          "input": {
            "returned": {
              "entityRef": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5e7cfaa6-3ccf-4db4-8a17-24f2496153ab",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6522",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "acefc63e62a12a0321546fa07cdaa7773676141dddc5b1f4855d0761d5b6c238",
              "readAtMs": 1792955653725
            },
            "requestStartedAtMs": 1792955653717,
            "responseAtMs": 1792955653724
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "surface": "social:search/reader",
      "identity": null,
      "control": "explicit-null-identity",
      "response": {
        "scopesSearched": [
          "personal:bluesky"
        ],
        "hits": [],
        "skipped": [],
        "withheldRestricted": 1,
        "withheldReason": "disclosure_identity_unresolved"
      }
    }
  ],
  "qualifiedFieldClaims": 0,
  "limits": [
    "controlled imported provider content",
    "session-user and unavailable embedding fixture seams",
    "admin SQL injected; host authentication/RLS/full runtime unmeasured",
    "candidate/provider revisions absent; field currentness unknown"
  ]
}
