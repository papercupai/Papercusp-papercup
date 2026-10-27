---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/personal-social-dispatch-20261025-a/red-20261025.witness.json"
updated_at: 1792955727931
_body: "content"
---

{
  "schemaVersion": 1,
  "protocolSha256": "87637cb1110ee512922c3ab8d697333c239ca5316c9a08a33ffa6ce507fe9ded",
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
    "personal-disclosure"
  ],
  "unexecuted": [
    "social-disclosure",
    "social-unattributed-withholding"
  ],
  "sourcePins": [
    {
      "path": "packages/operator-core/lib/agent-tools/personal/search.ts",
      "sha256": "2c1fc8082d17bc67aa7217d061b44c2b2693cacd644fcb46e954f324f4f91e52"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/social/search.ts",
      "sha256": "7538faa69150aebb090ed19c8838c97bae999f36f0cff83fdcff9d916fa7b470"
    },
    {
      "path": "packages/operator-core/lib/capability-verbs/social-read.ts",
      "sha256": "1c1d869d2b9537d021c5ef47d979bcafc4879fd56293d876c3c39a6baf8e65ed"
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
            "id": "3bfa4d81-5ed7-428d-a152-04645768087b",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6436"
          },
          {
            "id": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6439"
          },
          {
            "id": "6f99a75d-3000-4ad2-800f-5bb90b17035f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6442"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "024e2a54-3771-47ac-956a-4c8e5e630dfb",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:22.093323-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:22.091223-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
        "readAtMs": 1792955242125
      },
      "after": {
        "docs": [
          {
            "id": "3bfa4d81-5ed7-428d-a152-04645768087b",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6436"
          },
          {
            "id": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6439"
          },
          {
            "id": "6f99a75d-3000-4ad2-800f-5bb90b17035f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6442"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "024e2a54-3771-47ac-956a-4c8e5e630dfb",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:22.093323-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:22.091223-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
        "readAtMs": 1792955242151
      },
      "requestStartedAtMs": 1792955242123,
      "responseAtMs": 1792955242149,
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
            "id": "3bfa4d81-5ed7-428d-a152-04645768087b",
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
              "ece76607-1529-4a27-b398-9b9ffcffa7f5"
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
              "entityRef": "3bfa4d81-5ed7-428d-a152-04645768087b",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "3bfa4d81-5ed7-428d-a152-04645768087b",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e",
              "sourceRevision": "6436",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
              "readAtMs": 1792955242151
            },
            "requestStartedAtMs": 1792955242123,
            "responseAtMs": 1792955242149
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
              "entityRef": "3bfa4d81-5ed7-428d-a152-04645768087b",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "3bfa4d81-5ed7-428d-a152-04645768087b",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3",
              "sourceRevision": "6436",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
              "readAtMs": 1792955242151
            },
            "requestStartedAtMs": 1792955242123,
            "responseAtMs": 1792955242149
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
              "entityRef": "3bfa4d81-5ed7-428d-a152-04645768087b",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "3bfa4d81-5ed7-428d-a152-04645768087b",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6436",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
              "readAtMs": 1792955242151
            },
            "requestStartedAtMs": 1792955242123,
            "responseAtMs": 1792955242149
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
            "id": "3bfa4d81-5ed7-428d-a152-04645768087b",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6436"
          },
          {
            "id": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6439"
          },
          {
            "id": "6f99a75d-3000-4ad2-800f-5bb90b17035f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6442"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "024e2a54-3771-47ac-956a-4c8e5e630dfb",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:22.093323-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:22.091223-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
        "readAtMs": 1792955242155
      },
      "after": {
        "docs": [
          {
            "id": "3bfa4d81-5ed7-428d-a152-04645768087b",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6436"
          },
          {
            "id": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6439"
          },
          {
            "id": "6f99a75d-3000-4ad2-800f-5bb90b17035f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6442"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "024e2a54-3771-47ac-956a-4c8e5e630dfb",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:22.093323-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:22.091223-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
        "readAtMs": 1792955243516
      },
      "requestStartedAtMs": 1792955242153,
      "responseAtMs": 1792955243514,
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
              "entityRef": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6439",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
              "readAtMs": 1792955243516
            },
            "requestStartedAtMs": 1792955242153,
            "responseAtMs": 1792955243514
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
              "entityRef": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0",
              "sourceRevision": "6439",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
              "readAtMs": 1792955243516
            },
            "requestStartedAtMs": 1792955242153,
            "responseAtMs": 1792955243514
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
              "entityRef": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc",
              "sourceRevision": "6439",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
              "readAtMs": 1792955243516
            },
            "requestStartedAtMs": 1792955242153,
            "responseAtMs": 1792955243514
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
              "entityRef": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6439",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
              "readAtMs": 1792955243516
            },
            "requestStartedAtMs": 1792955242153,
            "responseAtMs": 1792955243514
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
              "entityRef": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "6ad7ba4d-3198-454b-812a-22aa3f730bce",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6439",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "973bc8d5d55b9abb046696e08d22ddf162b6c081139401779cf70de25fec19d3",
              "readAtMs": 1792955243516
            },
            "requestStartedAtMs": 1792955242153,
            "responseAtMs": 1792955243514
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6456"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6459"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243545
      },
      "after": {
        "docs": [
          {
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6456"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6459"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243551
      },
      "requestStartedAtMs": 1792955243543,
      "responseAtMs": 1792955243549,
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
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
              "ece76607-1529-4a27-b398-9b9ffcffa7f5"
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e",
              "sourceRevision": "6456",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243551
            },
            "requestStartedAtMs": 1792955243543,
            "responseAtMs": 1792955243549
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3",
              "sourceRevision": "6456",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243551
            },
            "requestStartedAtMs": 1792955243543,
            "responseAtMs": 1792955243549
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6456",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243551
            },
            "requestStartedAtMs": 1792955243543,
            "responseAtMs": 1792955243549
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6459"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243558
      },
      "after": {
        "docs": [
          {
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6459"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243563
      },
      "requestStartedAtMs": 1792955243556,
      "responseAtMs": 1792955243561,
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
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
              "ece76607-1529-4a27-b398-9b9ffcffa7f5"
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6471",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243563
            },
            "requestStartedAtMs": 1792955243556,
            "responseAtMs": 1792955243561
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6471",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243563
            },
            "requestStartedAtMs": 1792955243556,
            "responseAtMs": 1792955243561
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6471",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243563
            },
            "requestStartedAtMs": 1792955243556,
            "responseAtMs": 1792955243561
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6459"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          },
          {
            "id": "eec5039a-83a3-41d2-9c86-af75b8f8758b",
            "source": "mail",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6474"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243568
      },
      "after": {
        "docs": [
          {
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6459"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          },
          {
            "id": "eec5039a-83a3-41d2-9c86-af75b8f8758b",
            "source": "mail",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6474"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243573
      },
      "requestStartedAtMs": 1792955243567,
      "responseAtMs": 1792955243572,
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
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
              "ece76607-1529-4a27-b398-9b9ffcffa7f5"
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
            "id": "eec5039a-83a3-41d2-9c86-af75b8f8758b",
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
              "ece76607-1529-4a27-b398-9b9ffcffa7f5"
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6471",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243573
            },
            "requestStartedAtMs": 1792955243567,
            "responseAtMs": 1792955243572
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6471",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243573
            },
            "requestStartedAtMs": 1792955243567,
            "responseAtMs": 1792955243572
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6471",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243573
            },
            "requestStartedAtMs": 1792955243567,
            "responseAtMs": 1792955243572
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
              "entityRef": "eec5039a-83a3-41d2-9c86-af75b8f8758b",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "eec5039a-83a3-41d2-9c86-af75b8f8758b",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6474",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243573
            },
            "requestStartedAtMs": 1792955243567,
            "responseAtMs": 1792955243572
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
              "entityRef": "eec5039a-83a3-41d2-9c86-af75b8f8758b",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "eec5039a-83a3-41d2-9c86-af75b8f8758b",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6474",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243573
            },
            "requestStartedAtMs": 1792955243567,
            "responseAtMs": 1792955243572
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
              "entityRef": "eec5039a-83a3-41d2-9c86-af75b8f8758b",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "eec5039a-83a3-41d2-9c86-af75b8f8758b",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6474",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243573
            },
            "requestStartedAtMs": 1792955243567,
            "responseAtMs": 1792955243572
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6459"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243576
      },
      "after": {
        "docs": [
          {
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6459"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243581
      },
      "requestStartedAtMs": 1792955243575,
      "responseAtMs": 1792955243579,
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
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
              "ece76607-1529-4a27-b398-9b9ffcffa7f5"
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "title",
              "valueFingerprint": "52afdcba58d6912ee36a5db675a9aa15356c1add88ad22a398883b299f01f397",
              "sourceRevision": "6471",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243581
            },
            "requestStartedAtMs": 1792955243575,
            "responseAtMs": 1792955243579
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "snippet",
              "valueFingerprint": "e8ea8b3fba2ac1211dee2a0305429b9c8bbefac6e5372dd28fbe4935d9e0a8f2",
              "sourceRevision": "6471",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243581
            },
            "requestStartedAtMs": 1792955243575,
            "responseAtMs": 1792955243579
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
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6471",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243581
            },
            "requestStartedAtMs": 1792955243575,
            "responseAtMs": 1792955243579
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6459"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243582
      },
      "after": {
        "docs": [
          {
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6459"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243588
      },
      "requestStartedAtMs": 1792955243581,
      "responseAtMs": 1792955243586,
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6459",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243588
            },
            "requestStartedAtMs": 1792955243581,
            "responseAtMs": 1792955243586
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0",
              "sourceRevision": "6459",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243588
            },
            "requestStartedAtMs": 1792955243581,
            "responseAtMs": 1792955243586
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc",
              "sourceRevision": "6459",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243588
            },
            "requestStartedAtMs": 1792955243581,
            "responseAtMs": 1792955243586
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6459",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243588
            },
            "requestStartedAtMs": 1792955243581,
            "responseAtMs": 1792955243586
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6459",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243588
            },
            "requestStartedAtMs": 1792955243581,
            "responseAtMs": 1792955243586
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6478"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243594
      },
      "after": {
        "docs": [
          {
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6478"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243599
      },
      "requestStartedAtMs": 1792955243592,
      "responseAtMs": 1792955243597,
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243599
            },
            "requestStartedAtMs": 1792955243592,
            "responseAtMs": 1792955243597
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243599
            },
            "requestStartedAtMs": 1792955243592,
            "responseAtMs": 1792955243597
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243599
            },
            "requestStartedAtMs": 1792955243592,
            "responseAtMs": 1792955243597
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243599
            },
            "requestStartedAtMs": 1792955243592,
            "responseAtMs": 1792955243597
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243599
            },
            "requestStartedAtMs": 1792955243592,
            "responseAtMs": 1792955243597
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6478"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          },
          {
            "id": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
            "source": "bluesky",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6481"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243604
      },
      "after": {
        "docs": [
          {
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6478"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          },
          {
            "id": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
            "source": "bluesky",
            "externalId": "cobalt-new-candidate",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6481"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243609
      },
      "requestStartedAtMs": 1792955243603,
      "responseAtMs": 1792955243607,
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243609
            },
            "requestStartedAtMs": 1792955243603,
            "responseAtMs": 1792955243607
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243609
            },
            "requestStartedAtMs": 1792955243603,
            "responseAtMs": 1792955243607
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243609
            },
            "requestStartedAtMs": 1792955243603,
            "responseAtMs": 1792955243607
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243609
            },
            "requestStartedAtMs": 1792955243603,
            "responseAtMs": 1792955243607
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243609
            },
            "requestStartedAtMs": 1792955243603,
            "responseAtMs": 1792955243607
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
              "entityRef": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
              "fieldPath": "postId",
              "valueFingerprint": "15876bec7857fedc0ff8486cf6e9ef3b10f65b6477ce954d9456d48e85e6390a"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
              "fieldPath": "postId",
              "valueFingerprint": "15876bec7857fedc0ff8486cf6e9ef3b10f65b6477ce954d9456d48e85e6390a",
              "sourceRevision": "6481",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243609
            },
            "requestStartedAtMs": 1792955243603,
            "responseAtMs": 1792955243607
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
              "entityRef": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6481",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243609
            },
            "requestStartedAtMs": 1792955243603,
            "responseAtMs": 1792955243607
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
              "entityRef": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6481",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243609
            },
            "requestStartedAtMs": 1792955243603,
            "responseAtMs": 1792955243607
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
              "entityRef": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6481",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243609
            },
            "requestStartedAtMs": 1792955243603,
            "responseAtMs": 1792955243607
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
              "entityRef": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "bb7faffd-1517-4a42-9279-7408f3ba4c1a",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6481",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243609
            },
            "requestStartedAtMs": 1792955243603,
            "responseAtMs": 1792955243607
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
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6478"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243613
      },
      "after": {
        "docs": [
          {
            "id": "1cf1f59a-af92-459f-8e0c-ca3df811ae79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 2",
            "snippet": "Cobalt mail body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6471"
          },
          {
            "id": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 2",
            "snippet": "Cobalt bluesky body 2. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-02 08:00:00-04",
            "sourceRevision": "6478"
          },
          {
            "id": "ba3b455b-5a3a-4c22-9b65-20a973d01d4f",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6462"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "5d3ff873-f356-4d23-bed0-c03a9e6b9321",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.523935-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.522786-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
        "readAtMs": 1792955243618
      },
      "requestStartedAtMs": 1792955243612,
      "responseAtMs": 1792955243617,
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243618
            },
            "requestStartedAtMs": 1792955243612,
            "responseAtMs": 1792955243617
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "title",
              "valueFingerprint": "cac78e1d11760afe75b747a6fb485aa842cdda18303a500eb8622d35ff7b6454",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243618
            },
            "requestStartedAtMs": 1792955243612,
            "responseAtMs": 1792955243617
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "snippet",
              "valueFingerprint": "9915b0f0467e435921bc0f3b6fabaf8c919ed4c69bc8a689bd89307619663811",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243618
            },
            "requestStartedAtMs": 1792955243612,
            "responseAtMs": 1792955243617
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "occurredAt",
              "valueFingerprint": "9aa9a3d210785f361446963ac87b85f0956cb3bc949be17a43f7cdbc3fdb97e4",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243618
            },
            "requestStartedAtMs": 1792955243612,
            "responseAtMs": 1792955243617
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
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "24ad7007-646a-49a4-9e1b-35444a4b9f19",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6478",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "4f89e4ae6fd80f0765685cbbbbbf099323848e6e56d0876fbeda3dc209932043",
              "readAtMs": 1792955243618
            },
            "requestStartedAtMs": 1792955243612,
            "responseAtMs": 1792955243617
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
            "id": "c82e3d5a-3d80-470d-b54b-138ea30a217c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6490"
          },
          {
            "id": "dcd42b8f-26a5-4512-a42d-1c351eb4de26",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6493"
          },
          {
            "id": "e94599be-1dce-497c-bf8d-c85347a12917",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6496"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "54221648-ef22-4c06-abb2-a83a29bc7093",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.624559-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:07:23.64289-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.623512-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "3a057cb83e611fcd2449a89d62fa1b626d58c0a1d003ba89b2125a20891bb1f3",
        "readAtMs": 1792955243644
      },
      "after": {
        "docs": [
          {
            "id": "c82e3d5a-3d80-470d-b54b-138ea30a217c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6490"
          },
          {
            "id": "dcd42b8f-26a5-4512-a42d-1c351eb4de26",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6493"
          },
          {
            "id": "e94599be-1dce-497c-bf8d-c85347a12917",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6496"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "54221648-ef22-4c06-abb2-a83a29bc7093",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.624559-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:07:23.64289-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.623512-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "3a057cb83e611fcd2449a89d62fa1b626d58c0a1d003ba89b2125a20891bb1f3",
        "readAtMs": 1792955243647
      },
      "requestStartedAtMs": 1792955243643,
      "responseAtMs": 1792955243645,
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
            "id": "c82e3d5a-3d80-470d-b54b-138ea30a217c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6490"
          },
          {
            "id": "dcd42b8f-26a5-4512-a42d-1c351eb4de26",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6493"
          },
          {
            "id": "e94599be-1dce-497c-bf8d-c85347a12917",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6496"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "54221648-ef22-4c06-abb2-a83a29bc7093",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.624559-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:07:23.64289-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.623512-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "3a057cb83e611fcd2449a89d62fa1b626d58c0a1d003ba89b2125a20891bb1f3",
        "readAtMs": 1792955243649
      },
      "after": {
        "docs": [
          {
            "id": "c82e3d5a-3d80-470d-b54b-138ea30a217c",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6490"
          },
          {
            "id": "dcd42b8f-26a5-4512-a42d-1c351eb4de26",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6493"
          },
          {
            "id": "e94599be-1dce-497c-bf8d-c85347a12917",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6496"
          }
        ],
        "authority": {
          "rules": [],
          "grants": [
            {
              "id": "54221648-ef22-4c06-abb2-a83a29bc7093",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.624559-04:00",
              "granted_by": "fixture-owner",
              "revoked_at": "2026-10-25T15:07:23.64289-04:00",
              "principal_id": "operator",
              "workspace_id": "p001-personal-social-fixture",
              "principal_type": "agent-role"
            }
          ],
          "settings": [
            {
              "enabled": true,
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.623512-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "3a057cb83e611fcd2449a89d62fa1b626d58c0a1d003ba89b2125a20891bb1f3",
        "readAtMs": 1792955243652
      },
      "requestStartedAtMs": 1792955243648,
      "responseAtMs": 1792955243650,
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
            "id": "1bc9fca6-9c3a-4abb-a22c-ba85a3f6ab2e",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6514"
          },
          {
            "id": "2eeb2da6-395e-46d9-9c43-2bbe2db6a41c",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6517"
          },
          {
            "id": "db538bd2-2dfa-4f61-b547-5609ab549f7a",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6511"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "bda2d1c3-7711-4b94-b954-9bbffe0371df",
              "level": "participants",
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "created_at": "2026-10-25T15:07:23.671646-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:07:23.671646-04:00",
              "updated_by": "fixture-owner",
              "match_value": "mail",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "91b6c5a0-1bc0-47f0-8269-bf243fa91379",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.655403-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.654514-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "b491d7319801acaabd3468aff8f77664fd05d3de15994bde9c7b037c26e801a3",
        "readAtMs": 1792955243673
      },
      "after": {
        "docs": [
          {
            "id": "1bc9fca6-9c3a-4abb-a22c-ba85a3f6ab2e",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6514"
          },
          {
            "id": "2eeb2da6-395e-46d9-9c43-2bbe2db6a41c",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6517"
          },
          {
            "id": "db538bd2-2dfa-4f61-b547-5609ab549f7a",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6511"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "bda2d1c3-7711-4b94-b954-9bbffe0371df",
              "level": "participants",
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "created_at": "2026-10-25T15:07:23.671646-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:07:23.671646-04:00",
              "updated_by": "fixture-owner",
              "match_value": "mail",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "91b6c5a0-1bc0-47f0-8269-bf243fa91379",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.655403-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.654514-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "b491d7319801acaabd3468aff8f77664fd05d3de15994bde9c7b037c26e801a3",
        "readAtMs": 1792955243680
      },
      "requestStartedAtMs": 1792955243672,
      "responseAtMs": 1792955243678,
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
            "id": "db538bd2-2dfa-4f61-b547-5609ab549f7a",
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
              "ece76607-1529-4a27-b398-9b9ffcffa7f5"
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
              "entityRef": "db538bd2-2dfa-4f61-b547-5609ab549f7a",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "db538bd2-2dfa-4f61-b547-5609ab549f7a",
              "fieldPath": "title",
              "valueFingerprint": "ce56d97d7f7c8403180f493e679e43bf3c1f1960111e0524d731830758d1eb1e",
              "sourceRevision": "6511",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "b491d7319801acaabd3468aff8f77664fd05d3de15994bde9c7b037c26e801a3",
              "readAtMs": 1792955243680
            },
            "requestStartedAtMs": 1792955243672,
            "responseAtMs": 1792955243678
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
              "entityRef": "db538bd2-2dfa-4f61-b547-5609ab549f7a",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "db538bd2-2dfa-4f61-b547-5609ab549f7a",
              "fieldPath": "snippet",
              "valueFingerprint": "aa3b8cb5aedd0c99436e7c29d6746bacfd0450786596cfcc695b8eb94ac52aa3",
              "sourceRevision": "6511",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "b491d7319801acaabd3468aff8f77664fd05d3de15994bde9c7b037c26e801a3",
              "readAtMs": 1792955243680
            },
            "requestStartedAtMs": 1792955243672,
            "responseAtMs": 1792955243678
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
              "entityRef": "db538bd2-2dfa-4f61-b547-5609ab549f7a",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "db538bd2-2dfa-4f61-b547-5609ab549f7a",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6511",
              "authority": "Personal Vault imported provider value in harness_shared.documents; provider revision required for provider-current claim",
              "authorityEpoch": "b491d7319801acaabd3468aff8f77664fd05d3de15994bde9c7b037c26e801a3",
              "readAtMs": 1792955243680
            },
            "requestStartedAtMs": 1792955243672,
            "responseAtMs": 1792955243678
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
            "id": "488d5c70-bd35-4a5c-b515-0d40b513b19f",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          },
          {
            "id": "830926bd-2790-4623-960f-4904a4b1c428",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6541"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "17341326-41a6-41d5-84c4-f932b0ce8c4a",
              "level": "participants",
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "created_at": "2026-10-25T15:07:23.706133-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:07:23.706133-04:00",
              "updated_by": "fixture-owner",
              "match_value": "bluesky",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "5a80ea77-6842-4826-b55c-4c4cdfa0907d",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.687993-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.687259-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "7d5b8dc1c40d8339d2a1ededa1ed1504da374602a943e246e7b2d5f02e294fab",
        "readAtMs": 1792955243708
      },
      "after": {
        "docs": [
          {
            "id": "488d5c70-bd35-4a5c-b515-0d40b513b19f",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6535"
          },
          {
            "id": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6538"
          },
          {
            "id": "830926bd-2790-4623-960f-4904a4b1c428",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6541"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "17341326-41a6-41d5-84c4-f932b0ce8c4a",
              "level": "participants",
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "created_at": "2026-10-25T15:07:23.706133-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:07:23.706133-04:00",
              "updated_by": "fixture-owner",
              "match_value": "bluesky",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "5a80ea77-6842-4826-b55c-4c4cdfa0907d",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.687993-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.687259-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "7d5b8dc1c40d8339d2a1ededa1ed1504da374602a943e246e7b2d5f02e294fab",
        "readAtMs": 1792955243714
      },
      "requestStartedAtMs": 1792955243706,
      "responseAtMs": 1792955243712,
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
              "entityRef": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6538",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "7d5b8dc1c40d8339d2a1ededa1ed1504da374602a943e246e7b2d5f02e294fab",
              "readAtMs": 1792955243714
            },
            "requestStartedAtMs": 1792955243706,
            "responseAtMs": 1792955243712
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
              "entityRef": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0",
              "sourceRevision": "6538",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "7d5b8dc1c40d8339d2a1ededa1ed1504da374602a943e246e7b2d5f02e294fab",
              "readAtMs": 1792955243714
            },
            "requestStartedAtMs": 1792955243706,
            "responseAtMs": 1792955243712
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
              "entityRef": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc",
              "sourceRevision": "6538",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "7d5b8dc1c40d8339d2a1ededa1ed1504da374602a943e246e7b2d5f02e294fab",
              "readAtMs": 1792955243714
            },
            "requestStartedAtMs": 1792955243706,
            "responseAtMs": 1792955243712
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
              "entityRef": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6538",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "7d5b8dc1c40d8339d2a1ededa1ed1504da374602a943e246e7b2d5f02e294fab",
              "readAtMs": 1792955243714
            },
            "requestStartedAtMs": 1792955243706,
            "responseAtMs": 1792955243712
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
              "entityRef": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "5f41c5e9-9590-479b-a001-b1a2b33d5852",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6538",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "7d5b8dc1c40d8339d2a1ededa1ed1504da374602a943e246e7b2d5f02e294fab",
              "readAtMs": 1792955243714
            },
            "requestStartedAtMs": 1792955243706,
            "responseAtMs": 1792955243712
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
            "id": "72c95589-80e3-4875-b3d1-efaa521f50e5",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6560"
          },
          {
            "id": "bcd535e0-5e8a-4f0f-ae11-e0b1164d2d79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6557"
          },
          {
            "id": "ff5751aa-9aba-4991-9ed9-303e4f6e15ab",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6563"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "d97e0a00-3b8c-4ac3-b523-a54f60864338",
              "level": "participants",
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "created_at": "2026-10-25T15:07:23.754378-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:07:23.754378-04:00",
              "updated_by": "fixture-owner",
              "match_value": "bluesky",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "33f14862-0f85-4be0-87e4-2abcbac71ec8",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.72831-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.727246-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "02a4fe7e9e10d9e1f10597f91ffd1f0558c8345cb4c8a3608cd1333364916fb8",
        "readAtMs": 1792955243756
      },
      "after": {
        "docs": [
          {
            "id": "72c95589-80e3-4875-b3d1-efaa521f50e5",
            "source": "bluesky",
            "externalId": "at://did:plc:p001/app.bsky.feed.post/cobalt",
            "title": "Cobalt bluesky version 1",
            "snippet": "Cobalt bluesky body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence.",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6560"
          },
          {
            "id": "bcd535e0-5e8a-4f0f-ae11-e0b1164d2d79",
            "source": "mail",
            "externalId": "cobalt-mail",
            "title": "Cobalt mail version 1",
            "snippet": "Cobalt mail body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6557"
          },
          {
            "id": "ff5751aa-9aba-4991-9ed9-303e4f6e15ab",
            "source": "gcal",
            "externalId": "cobalt-mail",
            "title": "Cobalt gcal version 1",
            "snippet": "Cobalt gcal body 1. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Cobalt sentence. Co",
            "occurredAt": "2026-10-01 08:00:00-04",
            "sourceRevision": "6563"
          }
        ],
        "authority": {
          "rules": [
            {
              "id": "d97e0a00-3b8c-4ac3-b523-a54f60864338",
              "level": "participants",
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "created_at": "2026-10-25T15:07:23.754378-04:00",
              "created_by": "fixture-owner",
              "match_kind": "source",
              "updated_at": "2026-10-25T15:07:23.754378-04:00",
              "updated_by": "fixture-owner",
              "match_value": "bluesky",
              "workspace_id": "p001-personal-social-fixture",
              "authority_ref": null
            }
          ],
          "grants": [
            {
              "id": "33f14862-0f85-4be0-87e4-2abcbac71ec8",
              "scopes": [
                "personal:bluesky",
                "personal:mail"
              ],
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "metadata": {},
              "expires_at": null,
              "granted_at": "2026-10-25T15:07:23.72831-04:00",
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
              "user_id": "b8a0dd84-aec2-448c-90b0-c8f3d3979b32",
              "updated_at": "2026-10-25T15:07:23.727246-04:00",
              "updated_by": "fixture-owner",
              "workspace_id": "p001-personal-social-fixture"
            }
          ]
        },
        "authorityEpoch": "02a4fe7e9e10d9e1f10597f91ffd1f0558c8345cb4c8a3608cd1333364916fb8",
        "readAtMs": 1792955243762
      },
      "requestStartedAtMs": 1792955243754,
      "responseAtMs": 1792955243761,
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
              "entityRef": "72c95589-80e3-4875-b3d1-efaa521f50e5",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "72c95589-80e3-4875-b3d1-efaa521f50e5",
              "fieldPath": "postId",
              "valueFingerprint": "bd79db035db915836aa352beae51c81567515f556648fae7cfa1d115e0e9fb50",
              "sourceRevision": "6560",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "02a4fe7e9e10d9e1f10597f91ffd1f0558c8345cb4c8a3608cd1333364916fb8",
              "readAtMs": 1792955243762
            },
            "requestStartedAtMs": 1792955243754,
            "responseAtMs": 1792955243761
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
              "entityRef": "72c95589-80e3-4875-b3d1-efaa521f50e5",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "72c95589-80e3-4875-b3d1-efaa521f50e5",
              "fieldPath": "title",
              "valueFingerprint": "ee0a71068d59ab8c4edee335b8389ce02af3d236357d8bef3c617d69d271e7d0",
              "sourceRevision": "6560",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "02a4fe7e9e10d9e1f10597f91ffd1f0558c8345cb4c8a3608cd1333364916fb8",
              "readAtMs": 1792955243762
            },
            "requestStartedAtMs": 1792955243754,
            "responseAtMs": 1792955243761
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
              "entityRef": "72c95589-80e3-4875-b3d1-efaa521f50e5",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "72c95589-80e3-4875-b3d1-efaa521f50e5",
              "fieldPath": "snippet",
              "valueFingerprint": "9cf592995c67086e2bc61b6c0be6aed2063574aca9ec0dbd342f1ae0696747fc",
              "sourceRevision": "6560",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "02a4fe7e9e10d9e1f10597f91ffd1f0558c8345cb4c8a3608cd1333364916fb8",
              "readAtMs": 1792955243762
            },
            "requestStartedAtMs": 1792955243754,
            "responseAtMs": 1792955243761
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
              "entityRef": "72c95589-80e3-4875-b3d1-efaa521f50e5",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "72c95589-80e3-4875-b3d1-efaa521f50e5",
              "fieldPath": "occurredAt",
              "valueFingerprint": "fc7945fd368e21ff4573b3b692f459913cf7a8c20bb893b67e29697f6e858097",
              "sourceRevision": "6560",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "02a4fe7e9e10d9e1f10597f91ffd1f0558c8345cb4c8a3608cd1333364916fb8",
              "readAtMs": 1792955243762
            },
            "requestStartedAtMs": 1792955243754,
            "responseAtMs": 1792955243761
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
              "entityRef": "72c95589-80e3-4875-b3d1-efaa521f50e5",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "72c95589-80e3-4875-b3d1-efaa521f50e5",
              "fieldPath": "replyable",
              "valueFingerprint": "f657305889b4bb04496fced72adc665d45d7920335814a75abc7ff3809c7bb9f",
              "sourceRevision": "6560",
              "authority": "Personal Vault provider document + current provider registry/platform usability",
              "authorityEpoch": "02a4fe7e9e10d9e1f10597f91ffd1f0558c8345cb4c8a3608cd1333364916fb8",
              "readAtMs": 1792955243762
            },
            "requestStartedAtMs": 1792955243754,
            "responseAtMs": 1792955243761
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
