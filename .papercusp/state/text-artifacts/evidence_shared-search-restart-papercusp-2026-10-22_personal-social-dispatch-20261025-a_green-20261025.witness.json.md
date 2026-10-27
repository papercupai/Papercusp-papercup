---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/personal-social-dispatch-20261025-a/green-20261025.witness.json"
updated_at: 1792955728083
_body: "content"
---

{
  "schemaVersion": 1,
  "protocolSha256": "c27faa698e8dabdfe4dedc79791052973424ef6df300ac6a91a7cc2f2e7dc09f",
  "testSha256": "0cc018245a87aa8735e829042cff11794590971cd1f7e81f0ee41a0ae1526ccb",
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
    "social-disclosure"
  ],
  "unexecuted": [
    "social-unattributed-withholding"
  ],
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
            "id": "12941a50-991d-4914-90ba-4c135fff28cd",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6512"
          },
          {
            "id": "4080f497-b9be-4778-be3e-68698f8b3bc4",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6515"
          },
          {
            "id": "7b355cfb-02eb-42d4-9c91-c8ab372bfbbf",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6518"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "50af0598-7368-4671-b6d2-7dccc7a66856",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:49.062414-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:49.059594-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
        "readAtMs": 1792955509099
      },
      "after": {
        "docs": [
          {
            "id": "12941a50-991d-4914-90ba-4c135fff28cd",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6512"
          },
          {
            "id": "4080f497-b9be-4778-be3e-68698f8b3bc4",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6515"
          },
          {
            "id": "7b355cfb-02eb-42d4-9c91-c8ab372bfbbf",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6518"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "50af0598-7368-4671-b6d2-7dccc7a66856",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:49.062414-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:49.059594-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
        "readAtMs": 1792955509119
      },
      "requestStartedAtMs": 1792955509097,
      "responseAtMs": 1792955509117,
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
            "id": "12941a50-991d-4914-90ba-4c135fff28cd",
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
              "7ae1c4a7-6a87-42ad-ae06-40d9ca0be6cf"
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
              "entityRef": "12941a50-991d-4914-90ba-4c135fff28cd",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12941a50-991d-4914-90ba-4c135fff28cd",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e",
              "sourceRevision": "6512",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
              "readAtMs": 1792955509119
            },
            "requestStartedAtMs": 1792955509097,
            "responseAtMs": 1792955509117
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
              "entityRef": "12941a50-991d-4914-90ba-4c135fff28cd",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12941a50-991d-4914-90ba-4c135fff28cd",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3",
              "sourceRevision": "6512",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
              "readAtMs": 1792955509119
            },
            "requestStartedAtMs": 1792955509097,
            "responseAtMs": 1792955509117
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
              "entityRef": "12941a50-991d-4914-90ba-4c135fff28cd",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12941a50-991d-4914-90ba-4c135fff28cd",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6512",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
              "readAtMs": 1792955509119
            },
            "requestStartedAtMs": 1792955509097,
            "responseAtMs": 1792955509117
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
            "id": "12941a50-991d-4914-90ba-4c135fff28cd",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6512"
          },
          {
            "id": "4080f497-b9be-4778-be3e-68698f8b3bc4",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6515"
          },
          {
            "id": "7b355cfb-02eb-42d4-9c91-c8ab372bfbbf",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6518"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "50af0598-7368-4671-b6d2-7dccc7a66856",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:49.062414-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:49.059594-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
        "readAtMs": 1792955509123
      },
      "after": {
        "docs": [
          {
            "id": "12941a50-991d-4914-90ba-4c135fff28cd",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6512"
          },
          {
            "id": "4080f497-b9be-4778-be3e-68698f8b3bc4",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6515"
          },
          {
            "id": "7b355cfb-02eb-42d4-9c91-c8ab372bfbbf",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6518"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "50af0598-7368-4671-b6d2-7dccc7a66856",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:49.062414-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:49.059594-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
        "readAtMs": 1792955510556
      },
      "requestStartedAtMs": 1792955509121,
      "responseAtMs": 1792955510555,
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
              "entityRef": "4080f497-b9be-4778-be3e-68698f8b3bc4",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "4080f497-b9be-4778-be3e-68698f8b3bc4",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6515",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
              "readAtMs": 1792955510556
            },
            "requestStartedAtMs": 1792955509121,
            "responseAtMs": 1792955510555
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
              "entityRef": "4080f497-b9be-4778-be3e-68698f8b3bc4",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "4080f497-b9be-4778-be3e-68698f8b3bc4",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0",
              "sourceRevision": "6515",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
              "readAtMs": 1792955510556
            },
            "requestStartedAtMs": 1792955509121,
            "responseAtMs": 1792955510555
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
              "entityRef": "4080f497-b9be-4778-be3e-68698f8b3bc4",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "4080f497-b9be-4778-be3e-68698f8b3bc4",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc",
              "sourceRevision": "6515",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
              "readAtMs": 1792955510556
            },
            "requestStartedAtMs": 1792955509121,
            "responseAtMs": 1792955510555
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
              "entityRef": "4080f497-b9be-4778-be3e-68698f8b3bc4",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "4080f497-b9be-4778-be3e-68698f8b3bc4",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6515",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
              "readAtMs": 1792955510556
            },
            "requestStartedAtMs": 1792955509121,
            "responseAtMs": 1792955510555
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
              "entityRef": "4080f497-b9be-4778-be3e-68698f8b3bc4",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "4080f497-b9be-4778-be3e-68698f8b3bc4",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6515",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "f4e3bf7103f2cf43b44a09f14d299fbc3713a0d851a2186271227f8563cd5403",
              "readAtMs": 1792955510556
            },
            "requestStartedAtMs": 1792955509121,
            "responseAtMs": 1792955510555
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6532"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510583
      },
      "after": {
        "docs": [
          {
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6532"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510589
      },
      "requestStartedAtMs": 1792955510582,
      "responseAtMs": 1792955510587,
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
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
              "7ae1c4a7-6a87-42ad-ae06-40d9ca0be6cf"
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e",
              "sourceRevision": "6532",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510589
            },
            "requestStartedAtMs": 1792955510582,
            "responseAtMs": 1792955510587
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3",
              "sourceRevision": "6532",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510589
            },
            "requestStartedAtMs": 1792955510582,
            "responseAtMs": 1792955510587
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6532",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510589
            },
            "requestStartedAtMs": 1792955510582,
            "responseAtMs": 1792955510587
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510597
      },
      "after": {
        "docs": [
          {
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510602
      },
      "requestStartedAtMs": 1792955510595,
      "responseAtMs": 1792955510601,
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
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
              "7ae1c4a7-6a87-42ad-ae06-40d9ca0be6cf"
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6547",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510602
            },
            "requestStartedAtMs": 1792955510595,
            "responseAtMs": 1792955510601
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6547",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510602
            },
            "requestStartedAtMs": 1792955510595,
            "responseAtMs": 1792955510601
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6547",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510602
            },
            "requestStartedAtMs": 1792955510595,
            "responseAtMs": 1792955510601
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          },
          {
            "id": "7128893d-0d46-4c9b-b2c3-04ab6934ed39",
            "source": "mail",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6550"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510609
      },
      "after": {
        "docs": [
          {
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          },
          {
            "id": "7128893d-0d46-4c9b-b2c3-04ab6934ed39",
            "source": "mail",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6550"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510615
      },
      "requestStartedAtMs": 1792955510607,
      "responseAtMs": 1792955510613,
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
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
              "7ae1c4a7-6a87-42ad-ae06-40d9ca0be6cf"
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
            "id": "7128893d-0d46-4c9b-b2c3-04ab6934ed39",
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
              "7ae1c4a7-6a87-42ad-ae06-40d9ca0be6cf"
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6547",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510615
            },
            "requestStartedAtMs": 1792955510607,
            "responseAtMs": 1792955510613
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6547",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510615
            },
            "requestStartedAtMs": 1792955510607,
            "responseAtMs": 1792955510613
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6547",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510615
            },
            "requestStartedAtMs": 1792955510607,
            "responseAtMs": 1792955510613
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
              "entityRef": "7128893d-0d46-4c9b-b2c3-04ab6934ed39",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "7128893d-0d46-4c9b-b2c3-04ab6934ed39",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6550",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510615
            },
            "requestStartedAtMs": 1792955510607,
            "responseAtMs": 1792955510613
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
              "entityRef": "7128893d-0d46-4c9b-b2c3-04ab6934ed39",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "7128893d-0d46-4c9b-b2c3-04ab6934ed39",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6550",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510615
            },
            "requestStartedAtMs": 1792955510607,
            "responseAtMs": 1792955510613
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
              "entityRef": "7128893d-0d46-4c9b-b2c3-04ab6934ed39",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "7128893d-0d46-4c9b-b2c3-04ab6934ed39",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6550",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510615
            },
            "requestStartedAtMs": 1792955510607,
            "responseAtMs": 1792955510613
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510618
      },
      "after": {
        "docs": [
          {
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510624
      },
      "requestStartedAtMs": 1792955510616,
      "responseAtMs": 1792955510622,
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
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
              "7ae1c4a7-6a87-42ad-ae06-40d9ca0be6cf"
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6547",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510624
            },
            "requestStartedAtMs": 1792955510616,
            "responseAtMs": 1792955510622
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6547",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510624
            },
            "requestStartedAtMs": 1792955510616,
            "responseAtMs": 1792955510622
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
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6547",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510624
            },
            "requestStartedAtMs": 1792955510616,
            "responseAtMs": 1792955510622
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510626
      },
      "after": {
        "docs": [
          {
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510632
      },
      "requestStartedAtMs": 1792955510624,
      "responseAtMs": 1792955510630,
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6535",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510632
            },
            "requestStartedAtMs": 1792955510624,
            "responseAtMs": 1792955510630
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0",
              "sourceRevision": "6535",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510632
            },
            "requestStartedAtMs": 1792955510624,
            "responseAtMs": 1792955510630
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc",
              "sourceRevision": "6535",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510632
            },
            "requestStartedAtMs": 1792955510624,
            "responseAtMs": 1792955510630
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6535",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510632
            },
            "requestStartedAtMs": 1792955510624,
            "responseAtMs": 1792955510630
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6535",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510632
            },
            "requestStartedAtMs": 1792955510624,
            "responseAtMs": 1792955510630
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6554"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510637
      },
      "after": {
        "docs": [
          {
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6554"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510643
      },
      "requestStartedAtMs": 1792955510636,
      "responseAtMs": 1792955510641,
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510643
            },
            "requestStartedAtMs": 1792955510636,
            "responseAtMs": 1792955510641
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510643
            },
            "requestStartedAtMs": 1792955510636,
            "responseAtMs": 1792955510641
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510643
            },
            "requestStartedAtMs": 1792955510636,
            "responseAtMs": 1792955510641
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510643
            },
            "requestStartedAtMs": 1792955510636,
            "responseAtMs": 1792955510641
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510643
            },
            "requestStartedAtMs": 1792955510636,
            "responseAtMs": 1792955510641
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6554"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          },
          {
            "id": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
            "source": "bluesky",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6557"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510649
      },
      "after": {
        "docs": [
          {
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6554"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          },
          {
            "id": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
            "source": "bluesky",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6557"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510656
      },
      "requestStartedAtMs": 1792955510647,
      "responseAtMs": 1792955510655,
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
          },
          {
            "postId": "bluesky:cobalt-new-candidate",
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510656
            },
            "requestStartedAtMs": 1792955510647,
            "responseAtMs": 1792955510655
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510656
            },
            "requestStartedAtMs": 1792955510647,
            "responseAtMs": 1792955510655
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510656
            },
            "requestStartedAtMs": 1792955510647,
            "responseAtMs": 1792955510655
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510656
            },
            "requestStartedAtMs": 1792955510647,
            "responseAtMs": 1792955510655
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510656
            },
            "requestStartedAtMs": 1792955510647,
            "responseAtMs": 1792955510655
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
              "entityRef": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
              "fieldPath": "postId",
              "valueFingerprint": "15876bec7857fedc0ff8486cf6e9ef3b10f65b6477ce954d9456d48e85e6390a"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
              "fieldPath": "postId",
              "valueFingerprint": "15876bec7857fedc0ff8486cf6e9ef3b10f65b6477ce954d9456d48e85e6390a",
              "sourceRevision": "6557",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510656
            },
            "requestStartedAtMs": 1792955510647,
            "responseAtMs": 1792955510655
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
              "entityRef": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6557",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510656
            },
            "requestStartedAtMs": 1792955510647,
            "responseAtMs": 1792955510655
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
              "entityRef": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6557",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510656
            },
            "requestStartedAtMs": 1792955510647,
            "responseAtMs": 1792955510655
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
              "entityRef": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6557",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510656
            },
            "requestStartedAtMs": 1792955510647,
            "responseAtMs": 1792955510655
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
              "entityRef": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "eea36b9e-d5d7-4f90-aa94-a012f5d180b4",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6557",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510656
            },
            "requestStartedAtMs": 1792955510647,
            "responseAtMs": 1792955510655
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
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6554"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510660
      },
      "after": {
        "docs": [
          {
            "id": "088f683c-e8b9-40f4-be37-dbdf7a946fc9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6547"
          },
          {
            "id": "12abf177-4d2b-4e04-856a-d52424361f83",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6554"
          },
          {
            "id": "6b898c95-fe91-4bd9-ade9-763bdfc92ae5",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "9bc452b2-067e-48a9-89bb-84c84679adac",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.564312-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.563206-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
        "readAtMs": 1792955510667
      },
      "requestStartedAtMs": 1792955510658,
      "responseAtMs": 1792955510665,
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510667
            },
            "requestStartedAtMs": 1792955510658,
            "responseAtMs": 1792955510665
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510667
            },
            "requestStartedAtMs": 1792955510658,
            "responseAtMs": 1792955510665
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510667
            },
            "requestStartedAtMs": 1792955510658,
            "responseAtMs": 1792955510665
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510667
            },
            "requestStartedAtMs": 1792955510658,
            "responseAtMs": 1792955510665
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
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "12abf177-4d2b-4e04-856a-d52424361f83",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6554",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "a0b51363c2528d097f35a0f15764ca522e2ecbe2dd35b59e5320e61c798c9ce6",
              "readAtMs": 1792955510667
            },
            "requestStartedAtMs": 1792955510658,
            "responseAtMs": 1792955510665
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
            "id": "478d78eb-974a-4ef0-b5ea-04fd158132e9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6566"
          },
          {
            "id": "b4ad5398-b82a-4789-a1e0-703fa2cc33ff",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6569"
          },
          {
            "id": "cfec8880-0f98-46af-a194-1f74bd147113",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6572"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "aaa9ba7c-d78a-4a2a-b76a-bec5cfd3a6b6",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.671559-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:11:50.689579-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.67076-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f39aa09316767a1d585b7e2bafcd978c1fc1cc826824b582422f9dea6ea804e",
        "readAtMs": 1792955510691
      },
      "after": {
        "docs": [
          {
            "id": "478d78eb-974a-4ef0-b5ea-04fd158132e9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6566"
          },
          {
            "id": "b4ad5398-b82a-4789-a1e0-703fa2cc33ff",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6569"
          },
          {
            "id": "cfec8880-0f98-46af-a194-1f74bd147113",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6572"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "aaa9ba7c-d78a-4a2a-b76a-bec5cfd3a6b6",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.671559-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:11:50.689579-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.67076-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f39aa09316767a1d585b7e2bafcd978c1fc1cc826824b582422f9dea6ea804e",
        "readAtMs": 1792955510693
      },
      "requestStartedAtMs": 1792955510689,
      "responseAtMs": 1792955510692,
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
            "id": "478d78eb-974a-4ef0-b5ea-04fd158132e9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6566"
          },
          {
            "id": "b4ad5398-b82a-4789-a1e0-703fa2cc33ff",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6569"
          },
          {
            "id": "cfec8880-0f98-46af-a194-1f74bd147113",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6572"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "aaa9ba7c-d78a-4a2a-b76a-bec5cfd3a6b6",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.671559-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:11:50.689579-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.67076-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f39aa09316767a1d585b7e2bafcd978c1fc1cc826824b582422f9dea6ea804e",
        "readAtMs": 1792955510695
      },
      "after": {
        "docs": [
          {
            "id": "478d78eb-974a-4ef0-b5ea-04fd158132e9",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6566"
          },
          {
            "id": "b4ad5398-b82a-4789-a1e0-703fa2cc33ff",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6569"
          },
          {
            "id": "cfec8880-0f98-46af-a194-1f74bd147113",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6572"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "aaa9ba7c-d78a-4a2a-b76a-bec5cfd3a6b6",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.671559-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:11:50.689579-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.67076-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f39aa09316767a1d585b7e2bafcd978c1fc1cc826824b582422f9dea6ea804e",
        "readAtMs": 1792955510698
      },
      "requestStartedAtMs": 1792955510694,
      "responseAtMs": 1792955510696,
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
            "id": "3213fea5-b5dc-4ac9-b994-7b5a66fd5856",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6590"
          },
          {
            "id": "5c6d16b7-eeda-4200-a023-b03f9272e438",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6587"
          },
          {
            "id": "f92e6425-8853-4551-82de-e2665b8b1788",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6593"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "4b75aecc-0119-403e-b438-fa25bc09f70d",
              "level": "participants",
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "created_at": "2026-10-25T15:11:50.718883-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:11:50.718883-04:00",
              "updated_by": "fixture-owner",
              "match_value": "mail",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "c98b37a4-eb27-442c-b513-c86669a1cf94",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.701234-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.700374-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "fea581857b70008e7ced78954ba3241d7c6b74703c2db292f1d3f00c96db9ad3",
        "readAtMs": 1792955510721
      },
      "after": {
        "docs": [
          {
            "id": "3213fea5-b5dc-4ac9-b994-7b5a66fd5856",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6590"
          },
          {
            "id": "5c6d16b7-eeda-4200-a023-b03f9272e438",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6587"
          },
          {
            "id": "f92e6425-8853-4551-82de-e2665b8b1788",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6593"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "4b75aecc-0119-403e-b438-fa25bc09f70d",
              "level": "participants",
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "created_at": "2026-10-25T15:11:50.718883-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:11:50.718883-04:00",
              "updated_by": "fixture-owner",
              "match_value": "mail",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "c98b37a4-eb27-442c-b513-c86669a1cf94",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.701234-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.700374-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "fea581857b70008e7ced78954ba3241d7c6b74703c2db292f1d3f00c96db9ad3",
        "readAtMs": 1792955510728
      },
      "requestStartedAtMs": 1792955510719,
      "responseAtMs": 1792955510727,
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
            "id": "5c6d16b7-eeda-4200-a023-b03f9272e438",
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
              "7ae1c4a7-6a87-42ad-ae06-40d9ca0be6cf"
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
              "entityRef": "5c6d16b7-eeda-4200-a023-b03f9272e438",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5c6d16b7-eeda-4200-a023-b03f9272e438",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e",
              "sourceRevision": "6587",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "fea581857b70008e7ced78954ba3241d7c6b74703c2db292f1d3f00c96db9ad3",
              "readAtMs": 1792955510728
            },
            "requestStartedAtMs": 1792955510719,
            "responseAtMs": 1792955510727
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
              "entityRef": "5c6d16b7-eeda-4200-a023-b03f9272e438",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5c6d16b7-eeda-4200-a023-b03f9272e438",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3",
              "sourceRevision": "6587",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "fea581857b70008e7ced78954ba3241d7c6b74703c2db292f1d3f00c96db9ad3",
              "readAtMs": 1792955510728
            },
            "requestStartedAtMs": 1792955510719,
            "responseAtMs": 1792955510727
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
              "entityRef": "5c6d16b7-eeda-4200-a023-b03f9272e438",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5c6d16b7-eeda-4200-a023-b03f9272e438",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6587",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "fea581857b70008e7ced78954ba3241d7c6b74703c2db292f1d3f00c96db9ad3",
              "readAtMs": 1792955510728
            },
            "requestStartedAtMs": 1792955510719,
            "responseAtMs": 1792955510727
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
            "id": "01032d64-c185-4b09-9748-5084422de699",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6611"
          },
          {
            "id": "5180f315-83af-4b24-a310-f97da4c59a9e",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6617"
          },
          {
            "id": "f742438f-a24d-4264-9161-c3034e87fb0f",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6614"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "66261618-a3c1-4ea2-8ead-0ba3b16184b0",
              "level": "participants",
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "created_at": "2026-10-25T15:11:50.754184-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:11:50.754184-04:00",
              "updated_by": "fixture-owner",
              "match_value": "bluesky",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "8bc4f224-122b-46f9-a9d2-a2adab8e4169",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.736385-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.735663-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "bc8ac2671599699efbad5c4bfa560701103592b579f8d5adaec32373966c6ee0",
        "readAtMs": 1792955510756
      },
      "after": {
        "docs": [
          {
            "id": "01032d64-c185-4b09-9748-5084422de699",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6611"
          },
          {
            "id": "5180f315-83af-4b24-a310-f97da4c59a9e",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6617"
          },
          {
            "id": "f742438f-a24d-4264-9161-c3034e87fb0f",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6614"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "66261618-a3c1-4ea2-8ead-0ba3b16184b0",
              "level": "participants",
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "created_at": "2026-10-25T15:11:50.754184-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:11:50.754184-04:00",
              "updated_by": "fixture-owner",
              "match_value": "bluesky",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "8bc4f224-122b-46f9-a9d2-a2adab8e4169",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.736385-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.735663-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "bc8ac2671599699efbad5c4bfa560701103592b579f8d5adaec32373966c6ee0",
        "readAtMs": 1792955510764
      },
      "requestStartedAtMs": 1792955510754,
      "responseAtMs": 1792955510762,
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
              "entityRef": "f742438f-a24d-4264-9161-c3034e87fb0f",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "f742438f-a24d-4264-9161-c3034e87fb0f",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6614",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "bc8ac2671599699efbad5c4bfa560701103592b579f8d5adaec32373966c6ee0",
              "readAtMs": 1792955510764
            },
            "requestStartedAtMs": 1792955510754,
            "responseAtMs": 1792955510762
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
              "entityRef": "f742438f-a24d-4264-9161-c3034e87fb0f",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "f742438f-a24d-4264-9161-c3034e87fb0f",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0",
              "sourceRevision": "6614",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "bc8ac2671599699efbad5c4bfa560701103592b579f8d5adaec32373966c6ee0",
              "readAtMs": 1792955510764
            },
            "requestStartedAtMs": 1792955510754,
            "responseAtMs": 1792955510762
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
              "entityRef": "f742438f-a24d-4264-9161-c3034e87fb0f",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "f742438f-a24d-4264-9161-c3034e87fb0f",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc",
              "sourceRevision": "6614",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "bc8ac2671599699efbad5c4bfa560701103592b579f8d5adaec32373966c6ee0",
              "readAtMs": 1792955510764
            },
            "requestStartedAtMs": 1792955510754,
            "responseAtMs": 1792955510762
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
              "entityRef": "f742438f-a24d-4264-9161-c3034e87fb0f",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "f742438f-a24d-4264-9161-c3034e87fb0f",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6614",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "bc8ac2671599699efbad5c4bfa560701103592b579f8d5adaec32373966c6ee0",
              "readAtMs": 1792955510764
            },
            "requestStartedAtMs": 1792955510754,
            "responseAtMs": 1792955510762
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
              "entityRef": "f742438f-a24d-4264-9161-c3034e87fb0f",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "f742438f-a24d-4264-9161-c3034e87fb0f",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6614",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "bc8ac2671599699efbad5c4bfa560701103592b579f8d5adaec32373966c6ee0",
              "readAtMs": 1792955510764
            },
            "requestStartedAtMs": 1792955510754,
            "responseAtMs": 1792955510762
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
      "identity": null,
      "before": {
        "docs": [
          {
            "id": "34a1577e-9593-417a-b945-910f540243cd",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6638"
          },
          {
            "id": "557e78b3-472c-4969-ab4f-68563a669cfa",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6641"
          },
          {
            "id": "80bce871-a301-4ec7-a875-39957dd5ac07",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6635"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "8f85f2d4-1748-4947-9ab2-e447642805a9",
              "level": "participants",
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "created_at": "2026-10-25T15:11:50.785652-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:11:50.785652-04:00",
              "updated_by": "fixture-owner",
              "match_value": "bluesky",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "68eca279-4d22-43d5-bdf6-ab78e70db9c8",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.76984-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.768795-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "c7d2ac21f0c653c65127dc150baf8dfa2167c814dbfa4e7f37a445127827afb2",
        "readAtMs": 1792955510787
      },
      "after": {
        "docs": [
          {
            "id": "34a1577e-9593-417a-b945-910f540243cd",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6638"
          },
          {
            "id": "557e78b3-472c-4969-ab4f-68563a669cfa",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6641"
          },
          {
            "id": "80bce871-a301-4ec7-a875-39957dd5ac07",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6635"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "8f85f2d4-1748-4947-9ab2-e447642805a9",
              "level": "participants",
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "created_at": "2026-10-25T15:11:50.785652-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:11:50.785652-04:00",
              "updated_by": "fixture-owner",
              "match_value": "bluesky",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "68eca279-4d22-43d5-bdf6-ab78e70db9c8",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:11:50.76984-04:00",
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
              "user_id": "762671e6-db41-439e-850d-907b86946ae1",
              "updated_at": "2026-10-25T15:11:50.768795-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "c7d2ac21f0c653c65127dc150baf8dfa2167c814dbfa4e7f37a445127827afb2",
        "readAtMs": 1792955510792
      },
      "requestStartedAtMs": 1792955510786,
      "responseAtMs": 1792955510791,
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
              "entityRef": "34a1577e-9593-417a-b945-910f540243cd",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "34a1577e-9593-417a-b945-910f540243cd",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6638",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "c7d2ac21f0c653c65127dc150baf8dfa2167c814dbfa4e7f37a445127827afb2",
              "readAtMs": 1792955510792
            },
            "requestStartedAtMs": 1792955510786,
            "responseAtMs": 1792955510791
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
              "entityRef": "34a1577e-9593-417a-b945-910f540243cd",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "34a1577e-9593-417a-b945-910f540243cd",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0",
              "sourceRevision": "6638",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "c7d2ac21f0c653c65127dc150baf8dfa2167c814dbfa4e7f37a445127827afb2",
              "readAtMs": 1792955510792
            },
            "requestStartedAtMs": 1792955510786,
            "responseAtMs": 1792955510791
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
              "entityRef": "34a1577e-9593-417a-b945-910f540243cd",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "34a1577e-9593-417a-b945-910f540243cd",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc",
              "sourceRevision": "6638",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "c7d2ac21f0c653c65127dc150baf8dfa2167c814dbfa4e7f37a445127827afb2",
              "readAtMs": 1792955510792
            },
            "requestStartedAtMs": 1792955510786,
            "responseAtMs": 1792955510791
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
              "entityRef": "34a1577e-9593-417a-b945-910f540243cd",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "34a1577e-9593-417a-b945-910f540243cd",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6638",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "c7d2ac21f0c653c65127dc150baf8dfa2167c814dbfa4e7f37a445127827afb2",
              "readAtMs": 1792955510792
            },
            "requestStartedAtMs": 1792955510786,
            "responseAtMs": 1792955510791
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
              "entityRef": "34a1577e-9593-417a-b945-910f540243cd",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "34a1577e-9593-417a-b945-910f540243cd",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6638",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "c7d2ac21f0c653c65127dc150baf8dfa2167c814dbfa4e7f37a445127827afb2",
              "readAtMs": 1792955510792
            },
            "requestStartedAtMs": 1792955510786,
            "responseAtMs": 1792955510791
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
