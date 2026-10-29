---
rel_path: "evidence/idop-p001-roles-get-argument-scope-20261029-fire44.json"
updated_at: 1793236777026
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "bounded-current-caller-real-argument-observation",
  "plan": "identity-definitions-own-policy-2026-10-17",
  "item": "P-001",
  "workItem": "WI-6554700010017386",
  "canonicalAcceptance": false,
  "acceptance": "OPEN",
  "startedAt": "2026-10-29T01:18:01.410775+00:00",
  "caller": {
    "ownerId": "su-4a84c93a-e530-450c-b01e-8beb7bdc670f",
    "nativeSessionId": "01a18535-e060-70b1-a0ee-4f50741f39db",
    "roleEnvironment": null,
    "workspace": "papercusp-workspace",
    "harness": "papercusp",
    "route": "http://127.0.0.1:3170",
    "authority": "Existing parent superuser credential via maintained ptool, unchanged; role environment is not authenticated identity proof"
  },
  "schema": {
    "sourceArtifact": "evidence/idop-p001-supplemental-raw-schemas-20261028-fire42.json",
    "sourceArtifactSha256": "8c2dfb092eda7a0c3f6ea88799f7e2f2d77745efb1ef2e9aeb8b38557e3fbecd",
    "entry": {
      "name": "roles:get",
      "description": "Fetch one role manifest by id, scoped to a harness slug (or global when slug omitted).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "harnessSlug": {
            "type": "string"
          }
        },
        "required": [
          "id"
        ],
        "additionalProperties": false
      },
      "annotations": {
        "readOnlyHint": true
      },
      "_meta": {
        "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e7629d018070520",
        "papercusp/toolRegistrySource": "projected-tool-registry",
        "papercusp/provider": {
          "pluginName": "agent-mcp",
          "packageName": "@papercusp/agent-mcp",
          "version": "0.1.0",
          "kind": "builtin"
        },
        "papercusp/servingGeneration": "serving-generation-v1:8fcc83f43b134c8db2566ff8cec683242354457dc9f09c845b427f9abfa7b8de"
      }
    },
    "inputSchemaSha256": "4836e95773deb4d35042a04100c1e8fceb55b3779319e3cbb74d43ac117c1dde",
    "hashEncoding": "SHA256 of UTF8 JSON.stringify in returned property order; page archive is zlib + base64 over exact JSON.stringify(pages)"
  },
  "sourceBefore": [
    {
      "path": "packages/operator-core/lib/agent-tools/roles/get.ts",
      "sha256": "e135c0bb2f36c1636134328ca0c274cce6af411556ff7b789b66d4b836933362"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/_harness-scope.ts",
      "sha256": "9522f7a699a19eb814efdf29813fc82a9eae610381fb82297f51a92c9f62af8f"
    },
    {
      "path": "packages/operator-core/lib/role-registry.ts",
      "sha256": "336c54895438c72d80d9aa340e5fac6b94245ce0cdf8ca77d73c5bbac66d5a63"
    },
    {
      "path": "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts",
      "sha256": "6ebdeee75c25aa844020e115f28eae3faa1643c82095057bfb19d38de4c98e98"
    },
    {
      "path": "packages/operator-core/lib/endpoint-route/hive-harness-arg-coverage.ts",
      "sha256": "b4573c80d76c27968f305885359c66528bb8d6dee39c9a1f38891c291d5216b7"
    },
    {
      "path": "apps/operator/scripts/ptool.mjs",
      "sha256": "6f16bc5ebb60ba0a5cec7c05b6cad6546f905ac2720a1ce1d0927ac08cf4d355"
    }
  ],
  "loadedCommitSourcePins": [
    {
      "path": "packages/operator-core/lib/agent-tools/roles/get.ts",
      "buildSha": "b30d5f83fa",
      "committedBuildFileSha256": "e135c0bb2f36c1636134328ca0c274cce6af411556ff7b789b66d4b836933362",
      "observedSourceSha256": "e135c0bb2f36c1636134328ca0c274cce6af411556ff7b789b66d4b836933362",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/agent-tools/_harness-scope.ts",
      "buildSha": "b30d5f83fa",
      "committedBuildFileSha256": "9522f7a699a19eb814efdf29813fc82a9eae610381fb82297f51a92c9f62af8f",
      "observedSourceSha256": "9522f7a699a19eb814efdf29813fc82a9eae610381fb82297f51a92c9f62af8f",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/role-registry.ts",
      "buildSha": "b30d5f83fa",
      "committedBuildFileSha256": "336c54895438c72d80d9aa340e5fac6b94245ce0cdf8ca77d73c5bbac66d5a63",
      "observedSourceSha256": "336c54895438c72d80d9aa340e5fac6b94245ce0cdf8ca77d73c5bbac66d5a63",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts",
      "buildSha": "b30d5f83fa",
      "committedBuildFileSha256": "6ebdeee75c25aa844020e115f28eae3faa1643c82095057bfb19d38de4c98e98",
      "observedSourceSha256": "6ebdeee75c25aa844020e115f28eae3faa1643c82095057bfb19d38de4c98e98",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/endpoint-route/hive-harness-arg-coverage.ts",
      "buildSha": "b30d5f83fa",
      "committedBuildFileSha256": "b4573c80d76c27968f305885359c66528bb8d6dee39c9a1f38891c291d5216b7",
      "observedSourceSha256": "b4573c80d76c27968f305885359c66528bb8d6dee39c9a1f38891c291d5216b7",
      "matches": true
    },
    {
      "path": "apps/operator/scripts/ptool.mjs",
      "buildSha": "b30d5f83fa",
      "committedBuildFileSha256": "bb85e2641dc9a02703dd4faf0c6d7f8e7c8d416f02ee26de4f8377a159477695",
      "observedSourceSha256": "6f16bc5ebb60ba0a5cec7c05b6cad6546f905ac2720a1ce1d0927ac08cf4d355",
      "matches": false
    }
  ],
  "runtimeBefore": {
    "decodedResponse": {
      "currentBuildTestRoute": {
        "id": "operator-api",
        "source": "Committed local integration branch (staging by default), loaded by maintained staging sync",
        "runtime": "staging-operator",
        "route": "http://127.0.0.1:3170 after dev:pipeline_position containment check",
        "routeFile": "apps/operator/scripts/systemd/papercup-staging-api.service.d/50-staging-checkout.conf",
        "isolation": "Separate port, process and checkout; database and workspace are not isolated.",
        "prerequisites": [
          "Containing staging commit loaded",
          "private test identity/data for writes"
        ],
        "verification": "Measured :3170 build identity plus request/response on that build.",
        "readiness": "ready"
      },
      "_partial": true,
      "input": {
        "path": "packages/operator-core/lib/agent-tools/roles/get.ts",
        "sha": null
      },
      "targetSha": "17c4f3d940de688977e209d5589760a406424db9",
      "dirtyUncommitted": false,
      "servingRuntimes": [
        {
          "method": "blob",
          "runtime": "release-operator",
          "role": "owner",
          "buildSha": "d740fc3802",
          "buildShaSource": "health",
          "containsChange": true,
          "instances": null,
          "unknownReason": null
        },
        {
          "method": "blob",
          "runtime": "staging-operator",
          "role": "owner",
          "buildSha": "b30d5f83fa",
          "buildShaSource": "health",
          "containsChange": true,
          "instances": null,
          "unknownReason": null
        },
        {
          "method": "blob",
          "runtime": "bg-host",
          "role": "shared",
          "buildSha": "0b6a44a7d9",
          "buildShaSource": "health",
          "containsChange": true,
          "instances": null,
          "unknownReason": null
        },
        {
          "method": "blob",
          "runtime": "gateway",
          "role": "shared",
          "buildSha": "2d7239f55e",
          "buildShaSource": "runtime-vintage",
          "containsChange": true,
          "instances": null,
          "unknownReason": null
        }
      ],
      "_projection": {
        "kind": "bounded-payload",
        "truncated": true,
        "tier": "standard",
        "forced": true,
        "originalChars": 3504,
        "returnedChars": 2753,
        "omittedCount": 1,
        "omitted": [],
        "cursor": {
          "kind": "scratch-page",
          "tool": "capability:read",
          "args": {
            "file_path": "papercusp://scratch/papercusp-workspace/dev:pipeline_position/c7093bb8-efa9-4604-9072-e0811a760b22/result-door-1793236590509-47606f34.spill",
            "byte_offset": 0,
            "byte_limit": 3072
          },
          "bodyComplete": false
        },
        "next": "The emitted result was written to the reference in `content` — page it to inspect what the tool emitted. The `uri` in `content` is a framed scratch-reference container, not a raw JSON file. Read it with `capability:read` byte pages (`byte_offset` + `byte_limit`, without `raw`) and follow `next_cursor` to validate and unwrap its manifest before parsing the payload; the default numbered line view can truncate a long single-line payload. However, the emitted result already carries upstream partial marker(s) (textTruncated); paging this reference cannot recover the omitted fields, rows, or text. The dev:pipeline_position result already marked a field as truncated. Re-read using that field's documented recovery handle or narrower arguments; a wider per-field limit may not exist."
      }
    },
    "stdout": {
      "encoding": "base64+zlib",
      "bytes": 2759,
      "sha256": "159239d3250cff64e6f7979f9612427a80be4e5cde175ae78952e69527eeca76",
      "payload": "eNrFVttu4zYQfe9XEHppglqWfItj560LFEWBtkCyfSoWMUWObDa0qJKUvUawQD+iX9gv6RlKzqVN96UPiyBBRA1nzpw5M6PHTHXeUxO/7YzV7ynEW9dFytaPmdHZOnMteRmdz2VrslEWXOcV3mbv3H5vYiQtrFPSCtNE2sLSuEZUXjZqJy5ClFvTbEV1Eppq2dl4OYK51LiFs73EJfzi6WwZTo1CFN810ew5zPAiP8Pglz2+bBdjuy6KyXQ5LvEzWc8my1LIOpJHuMO6NS1ZeL9vXTAJl3Ip3h7ZCrUj9XD29p2x7FG2bSjOkYqgvGljKMIpRNrropV4o7o2P2MCI+NA/mAUjXWxKJ9eJN/wO0bAGjFMcDYxgxh31Er4J9E6H0ei9U5RCEI2Wpyv3Qgto6xkoHR8dP4htFLhyZNoXBS9P9Jj+G49efq9M0iRQrb+FYVJSSY2B1ZVqtXAfLpjDgwBN+BMgw4TTwUHFbXz4uiTrw+j7EDe1Eadsf9IMnQe5eqprlgxT/dFa7sgGAu8Fp5C6xpkANrjTsbemAF7khpVCQCb/j9ln0bZPUiJRtpsHX1HYKxpu8gabGXcwRDpP8gtPVcnV85TYU1V4LiJeXTOhsI7C5stxXEMLNadzNZNZy0iROlxfscn2WSp5vVMr+alpqvr69VySdNypRcL/HtVynl5NZ/OdbWCC218PP3SqLPas3UtbQDCVPhme9srlZl/zPYUd46bprKueiVjTxbc0WsZJ825Y0P8mPjp4enlvKzV7Lqcvji/OzfejqQFJ6NsUHN4t5PNlp6ZQ9UbxYg481HWNQ8NgtwiPhexp+NzWN9suf/CWs1KvaivZ7X8Ilirbb5zIT5DRMl90vgLjGV1JedzudSrL4Jxi1Y7ytPnMU71cjpb1YsFvYVxcJYfeGBu6f+B/cDt5t1vpPq2fsweTJOQu67BgMhbeeJRgSjw2iiZZN8HiAYCSBJptPRsgoGhnt87b6AdaQHLA8RsUc6542PnMeWHw+lyMYNl30/vEBONPnk6QCMBIHZSgPKesWEYy6h2wJbS53bHqZKtrIzF9FnzKMELdHngazUm+v3T8EiDO/C2GPwUT2f503gt3lwahVqWq1lVXefYYKt8flXO81W5nOZUXk8mEvOimk553GG75dphMk2Wq9l0drVYlYsSF2BxVc/m49Aaa7m4p0j3rq4DIe9yeLYG2YMvOMasqpw+Yb+2lnjRpYGD04Y+wiR7vyNBw+rtw4qjDGloR8KwdZi3hDc19gKkgMUsNqwWTMmN+OuPPwVTKLAOYAm9tJCBOPKE5mvM69n7WHCoTefN5rUTg3Ulai/3vLiHujzHG5RJfpR2lRReHsUPdz//JLgmYwEtag5/NHEHp68ruBFMR4IYxMXmBVcb8Y3YPHO1GSUH2JZigwCby7Qqa2etO4oNU3Xfa2jDeR6kNZo3Hht1zdHLFhACvkAaU/MSrAg65rg+8MJkKoYuuEkPw+eLaLp9RbwBWSPiYOgolATpQ58gW+t48cKJpTwZDX7G4nt3pAPTEv9dQWnTKoQz7w1S79oQcbIXw14EUv9A/iJciouI5N6fG/PyhsnqMZvwouyAxfR7Ug5BU8yhw1AHsjqMhHdH/MXCZ499td/+bvoHyIRFswbYkYD4nuYElzdnK9ENREJYyezrILRTHX97pbQTrJPA+NKWGESD1MGQx1fONpmFG4Q44vPCC/Rq3gdLxQeCUxIXfTQhjrNPn776GyViyuk="
    },
    "stderr": {
      "encoding": "base64+zlib",
      "bytes": 7443,
      "sha256": "23630b4b1fdbabd14f59cace6847af7bc825a06badff58199c256e0332bb0cfb",
      "payload": "eNrtV01v3DYQvftXLHRqgR0vKYkipVvqU4CmKGqjhxRFwY+RV41WYkWu2yDwf+9I67XTreH20DhWKuggcjgczjzyUU9eexzsPviVw7rp8Krv29XFt69XX/lIza+rVav3nd3icLbZ9jvc7PQQttDXdWNx4w+zvW7g9354F7x+MAa/0d6HTU89HfthE+zQ+Bg2U+Dz3a/hbGpVK9t3HdrY9N0qDhRh9SEJtOJO/4hDIGtSJZMnPDjC5Ag3PFknU/O1I69MmKJ2BQMlmYE81zkoVBkYhdKUqAqmGE04ZnRxCHeJv+2xs5hUfJ0cq73s98NoSmzbwH5ooW71dfLR+FTM9zpuyec/R4YWonWxi1NZYQ+5VrktMw0oMga5YBYM4wjKoJHG2UKyeoSC5n+nd2PeDm8q33hsaVN/8X1oRtjGuLpzjdMRf+j3EUNS/fQhGcbmRasDdZO2t7oF1wwEDflv+xDJylN5zugZAff9QKaMS7ZOdIy48/Gq2SEFeUMBuGCM3f68TgaMw/tv9u4aD/aU7DTDDw0h9f7imMcb/cerQ5DJifag1m1rtH33hMvdsujuq6AF8YYQo1yPuB7PC4Soh7EWel/jIw5jTVsd8HL0Q/dqDJKytADOIC2vGK94UaX8XErxNrl9icd2GDshXt3H5LVxdSFSqAWnmMIhGMNzKDJbl5yVpcsweYBsG6OHuyB/g+tuMPi+Cwhb1I4KpPHp2CTVJzk/XyTK0yGjRHe+xYifGeF/debTcybk27GEVvuAbpyeZespYZoZ99QnXs9jt0yacVeXClyhC8itUaAsF1Ba5QxDVTOpF048M8pz5ITg2QknuDjlRDqT3RLasMykILnRkBMIoErJwKbKScG4xYItnFhE5P9DRH6KKu4HRsPtUzL1kUvwEaX62e+/Ox38l/tPCjGP+64sdVnymkri1kLOtQTjSLs5FMJlWmUZW3Txc39VZqkB0vKEAycSIGdfJiVmuVlZeirY2Ex/YqTMuLGSlHU9/nJq4pfCugZhdFkX3AqrsuUCe2aU58gJJcTTF9hLpcSirhd1/c/q+kBJj5Rfd/0RI0f8A9DK7UuhIT+lIVuItxBv5sR75Fv48pknZZHenv0JJRt9cA=="
    }
  },
  "requests": [
    {
      "case": "default",
      "tool": "roles:get",
      "arguments": {
        "id": "infra-reviewer"
      },
      "startedAt": "2026-10-29T01:18:01.416793+00:00",
      "finishedAt": "2026-10-29T01:18:06.030079+00:00",
      "durationMs": 4613,
      "exitCode": 0,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 728,
        "sha256": "1368b1f8e97e0b2c3f3f93261b9b744fec06a957234503add8fa5aabcda92c91",
        "payload": "eNp1UsGO1DAMvfMVVk4gdQYuXIYbsyAhBLvSsCfEIdO6rbWpE9nJVMNqJD6CL+RLcNpZtBcubR3nPT+/10dHnds54l78RvBEOKO4xo1eGFUPoQzWTj6htEWTdfpY2CBZCjZOYkC3e/wPyTwi3yv2JVh3H1lLyFAP4XD3YQ++6yiTHcNEw5jB9z22GfKI0GEK8TwhZ0iUMBAj/Pn1G27eg7YjTh6iVJT4haABxhmQT3DyYtWxUOiAOJWsr2PJ9d1AsmWIoY3c01BWaHMdBdnLgPWWEXs+55F4MCk+A00pEOqiayXWVihlm4mdHUdoR88DbuEmwtfbb3XAsmlvVKkIbpLErthmPfpstcLL+09X0CJWqXoNIQ7UNgZP5wZ6iZyRu03kcAbNPuOrLXyJmkFMsTfXdIzF1DwfabL1HSyQxeequVpzLCHYdtAG9GLNupM9a2BqSbZVFsxRHrYW22pYjfWBatTuSXdNf/38vDYWAndpnA+zP+tHErxlt/vuIt9JPJGaw9i5H407ls7s3Vug6nZv3/wjOtBP+4GcTj4Eo9dYpMVno6vhmdhdbMiy5GQyrH2F2w22EYasljxVl8uLv41cBHY="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5645,
        "sha256": "8a039ecb4494e0eb1f424e67721b5642a0c69d7fb83a17d9954ea4222a524f2a",
        "payload": "eNrtV8GO2zYQvecrDJ1awLRJiqQo3dI9BWiKorvoIUUPFDlcq5EllqTSBsH+e0fa9W7jLIIcmk29MHwwOZx5w3mcIUfBBIh2SmHlwHcDXI1jv7r48dXqu5Bx+H2z6s002B3EF9vduIft3sS0I6P3nYVtuLUOpiN/jfFtCuZBmMLWhJC2I85MHuM22diFnLYL8Gb/R3qxjJqVHYcBbO7GYZUjIqw+FAk97s2vEBNKi6ZYNMmDIlkUyTtWrItl+MqhFlBwvhQt4TWviVBCkrr1jGinlaKtoMJXaHDY0cUt3CX8OcFgoWjYujhEezlOcRYVtu/IFHvie3Nd/Gt9CeZnk3eo858zg47QLwx5CStNRBgtbF0aArKkREhqSUsZEN1CW7XOqor6mQq0/8ns533HsYfUXEOesczgOmcy/DJOGVLR/PYB13F40ZuE06IfremJ6yLSgfq7MWWUMl5tKP5mksMYUVSyiq4LkzPsQ77q9oAgrxGASUrpze/rIkKO73+YHPpd5BzlaBFih+y8vzjs47X5++UtyKKEvHvT962xbz+jcucW3H0U6BDeIUu41wOXhxwhKZs4x4L/1/CIwhzTziS4nPXAvZxBOOWKMIrpc0VZw3RD2UZq+qa4+T+mapwnKV/dY2ppjKDakNopT0QrOGlFq4mnllrnSus5LR4o2+UcyB3IJ3TdLaYwDgnIDozDAHF9SZui+Sr58yxZXpIMN7oPPSBz35bhL8p5vqGavZlD6E1I4GZzrdbLhtEyTzjHuj6N05KWcsp4iyCAmL6mxAhviZKlUwraUtXiXBNPzPLp1YTYaK6PaoLz45rgp3FaTktlTKWIqsESIWxFDGN4eFAC1V7UtVXnmjg3js+3cfwaUdwvzIKbz7Wmj1x8j3Sn3/zOu+t9P7rzSq5P5OHn3MmWmZL4qnJEgLTEgOPEVUxWHGgNhp0vuSd+Sk7y4ZfyqAiY/vjhF1Q+y5o4ydNSx6fFlTzRbxfqpaoU+mJeYHFxjc+2q2rsqp2qhAddl+dvl6dm+fSKQm4UFcdXmGKPFMU/CO8o0g=="
      },
      "decodedResponse": {
        "id": "infra-reviewer",
        "harnessSlug": "papercusp",
        "found": true,
        "role": {
          "id": "infra-reviewer",
          "whenUseful": "Consult when SPEC additions might affect the deployment pipeline — DB schema or migrations, new env vars, build inputs/outputs, plugin configuration, deploy targets, or anything that implies the build script needs to change. Do NOT consult for pure-product features (UI changes, business logic, copy, frontend-only state). Most replans should NOT consult this; only when the new bullets clearly imply infrastructure work.",
          "output": {
            "kind": "features",
            "featureKind": "infra"
          },
          "alwaysFireOn": [
            "onProvisioned"
          ],
          "budgetCents": 50,
          "featureSize": "small",
          "source": {
            "kind": "builtin"
          }
        },
        "consumes": {
          "feature": "none",
          "plan": "none"
        }
      }
    },
    {
      "case": "explicit-home",
      "tool": "roles:get",
      "arguments": {
        "id": "infra-reviewer",
        "harnessSlug": "papercusp"
      },
      "startedAt": "2026-10-29T01:18:06.031541+00:00",
      "finishedAt": "2026-10-29T01:18:08.174018+00:00",
      "durationMs": 2142,
      "exitCode": 0,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 728,
        "sha256": "1368b1f8e97e0b2c3f3f93261b9b744fec06a957234503add8fa5aabcda92c91",
        "payload": "eNp1UsGO1DAMvfMVVk4gdQYuXIYbsyAhBLvSsCfEIdO6rbWpE9nJVMNqJD6CL+RLcNpZtBcubR3nPT+/10dHnds54l78RvBEOKO4xo1eGFUPoQzWTj6htEWTdfpY2CBZCjZOYkC3e/wPyTwi3yv2JVh3H1lLyFAP4XD3YQ++6yiTHcNEw5jB9z22GfKI0GEK8TwhZ0iUMBAj/Pn1G27eg7YjTh6iVJT4haABxhmQT3DyYtWxUOiAOJWsr2PJ9d1AsmWIoY3c01BWaHMdBdnLgPWWEXs+55F4MCk+A00pEOqiayXWVihlm4mdHUdoR88DbuEmwtfbb3XAsmlvVKkIbpLErthmPfpstcLL+09X0CJWqXoNIQ7UNgZP5wZ6iZyRu03kcAbNPuOrLXyJmkFMsTfXdIzF1DwfabL1HSyQxeequVpzLCHYdtAG9GLNupM9a2BqSbZVFsxRHrYW22pYjfWBatTuSXdNf/38vDYWAndpnA+zP+tHErxlt/vuIt9JPJGaw9i5H407ls7s3Vug6nZv3/wjOtBP+4GcTj4Eo9dYpMVno6vhmdhdbMiy5GQyrH2F2w22EYasljxVl8uLv41cBHY="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5640,
        "sha256": "35786a1a783210dd84378641e1e3805dcbeb7ac2adb1cdc7b3b6a00bb2619c27",
        "payload": "eNrtV0tv3DYQvudXLHRqgR0vX3reUp8CNEVRGzmk6GFEjrxqtBJLctMGgf97R7LXblwjyKFxs8ZiD0sO5/lxZjjy6CnYffQrR10/0uU0DavzH1+tvvOJl983qwH3o91SeLHZTjva7DDELUxd11va+Btpjz38OYV30eM9MfoNeh83E+8wTWETbeh9iptF8dnu9/hiWTUrO40j2dRP4yoF1rD6mEW2uMM3FCJTsyZbOOGeERZGeC+zdbYsXznmcjKntnUEXa0lGGUctBIVUF50JaIpBGoWOHh0fqPugv7Y02gpa+Q6O0R7Me3DTMrs0MM+DNANeJX943wJ5mdMW+b5z5FhQ2yXxrSEFfdgsDK21sihaAEmFxZaIQmqltqydbYoRTdDwfI/4W72O0wDxeaK0qwLR9c7TPTLtE8Us+bXj3zOy/MBI2+zYbI4gOsDw8H82ykmpkpVngn+zSD7KTBJy1KsM0yJdj5d9jtiJa9ZgcyFENe/rbNAKXz4Ye/Y7kJXTGcJH3pG58P5wY/X+NfLGyULE+Pe4TC0aN99huXWLLm7KNggvWeU2NcDloccgZgwzLHw/xU9wjDHtMVIFzMfuZezEiVUAVKAqi+FbGTViOJMlvJtdv0tpmqYNzFd3ukstC0FmQ4KQxpMq2qohVNQlmgw12VVdEV2D9k2JQ+3Sv4F1+1h9NMYCbaEjgPk8yVtsuar5M+zRHlJMnZ05wdi5P5fhL8w5wtTvp1DGNBHcrO4UevFYZZMe95zXR/HbZGSWnfUgWCXWafVgEJKyJE6hhxrSXSqiSdG+fhqojwrhXpQE1I8rAl1HLfVFkVOtitAFyWBqboWKpR8eS0pZ7GVrsxPNXEaHJ/v4Pg1org7mAnXnxtNH2l8j0yn38AcsMy+n/a83OTH0eRUVXFT0xpqXam5ySmoHSE453TdqRy7Spya3BM/JUf58Mv84TD86btvxPMsieO8rOrBZVVH+uGSF6hybWqQJbZgBFlA1gWmdKZqW2OqXJ/61xOjfIwlUef5F5TE38rRMVo="
      },
      "decodedResponse": {
        "id": "infra-reviewer",
        "harnessSlug": "papercusp",
        "found": true,
        "role": {
          "id": "infra-reviewer",
          "whenUseful": "Consult when SPEC additions might affect the deployment pipeline — DB schema or migrations, new env vars, build inputs/outputs, plugin configuration, deploy targets, or anything that implies the build script needs to change. Do NOT consult for pure-product features (UI changes, business logic, copy, frontend-only state). Most replans should NOT consult this; only when the new bullets clearly imply infrastructure work.",
          "output": {
            "kind": "features",
            "featureKind": "infra"
          },
          "alwaysFireOn": [
            "onProvisioned"
          ],
          "budgetCents": 50,
          "featureSize": "small",
          "source": {
            "kind": "builtin"
          }
        },
        "consumes": {
          "feature": "none",
          "plan": "none"
        }
      }
    },
    {
      "case": "second-known-role",
      "tool": "roles:get",
      "arguments": {
        "id": "security-reviewer",
        "harnessSlug": "papercusp"
      },
      "startedAt": "2026-10-29T01:18:08.175198+00:00",
      "finishedAt": "2026-10-29T01:18:12.423071+00:00",
      "durationMs": 4248,
      "exitCode": 0,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 693,
        "sha256": "4e86376c8c49ba49a442364de58776f36c5cb696a39dde6b4f559f5ae0ffcc96",
        "payload": "eNp1UbGO2zAM3fsVhKYWcJIuXbK6d0sPTXtuiwJFB55E20IUSSClGOkh/146vgS33CKIfOR7JN+z8c5sjZCt7MtpxXT0NBGbxozIkUS6UAetyJiJbZWsSJ9q1K7ClRrDKZDZPr/NM40Ufwr1NWhBm6LUUGBOQvftrgV0zhevaSip2hGwFsWKtzhnm0uc2MtLWIUYfMy1wIjRBR8HeP+76zbd9we/6brH+03GMkJhPBILBjiSLYnlQwM6HVPZ6ONmBcWuFA20u8cOEkNSdQbLSWSlsoOPIJV7tCQN9D4Q1BwSOo20OtIEjjJFJbQnnatwctUu+6QIGe0eB9LdRixgUw0OLDKfoP11J2v4nODr7ocCy1V6pcyVaZUXGugJi8YCk9cr6M76Ct0mWsOD35PK9oy3kzdwSFKAKQfUKWS8qL6WKaOXtTqjhHrH2by9nw01V7nZ4+X7ZQGuvppzYzBMeJJ7z7SLZvvnb2OeqhuotHpTMdtPH2/Nnf9Hc/MBQ1BKSZUtvZJ7qj4UH81ZWS+zHVRa4Zd2rYgpknbOm1yj8/ndfygm90Y="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5644,
        "sha256": "b04131be51a7d6fd4212eb672947b65a608a3eff060f63113c0656c30f5c223b",
        "payload": "eNrtV01v3DYQvedXLHRqgeUuv7SidEt9CtAURW3kkKKHETn0qtFKLMlNGwT+7x3JXjuxjSCHxs0aiz0sOZx5w3nkDEcBAka7T2Hh0HcDXoxjvzj7+dXih5Bp+GOz6GE/2C3GF+vtuMP1DmLastH7zuI6XFsH6NjfY3yXAtwJU1hDCGk90gzyGNfJxi7ktJ6BV7s/04t51CzsOAxoczcOixwJYfGxSORxB28wJpIWTTFrsjtFNiuy96JYFvPwlSMtrUwl69oz5LZm2pecQWWASVm3FVfWW8vJ4LCjs2u4c/xrj4PFohHL4hDt+biPk6iwfcf2sWe+h8vik/U5mF8hb0nnP2eGHJFfHPIcVtozDUbbWgHDUnGmS25ZywUy02Jbtc5uKu4nKsj+F9hN+45jj6m5xDxhweA6Bxl/G/cZU9H8/pHWaXjWQ6Jp0Y8Weua6SHSQ/nZMmaRCVitOv4nkMEYSKVHxZQE54y7ki26HBPKaAETJOb/6Y1lEzPHDT3tHfme5JDlZhNgROx/ODvt4Df+8vAaZlYh3D33fgn33BZUbt+huoyCH+J5Yor0euDzcEZYyxCkW+r/ERxSmmLaQ8HzSQ/dyApFcbpjgTNYXXDTCNNyslDBvi6vv8arGaZLyxS2mEqgrVJpVyAXTvJTMCEJHg5bXulWVbYs7yrY5B3YD8oCum8UUxiEh2yI4CpDW52tTNN/k/jxLludLRhvdhR6Juf+X4a+885tSvJ1C6CEkdJO5Ust5w2SZ9zSnvD6O09Lee+V5zUpTUeGUrWRgFJ0WR1BOYtkaOOXEE7N8dDkhxEpKfi8n5IOckMdxWlWrFJlZBg42hFkZOi00rG2d8KC8AnSnnDg1js+3cfwWUdwuTIKrL7WmjxS+R7rT76APmHvfz2teLevjKHLgjXRu45hwNdCTZBxrJUimxMY700ouLJ6K3BM/JUf58OvyXhKU+vOHn74BnmVOHOdp1fdOy+gj/XSpnPFtrWvGNXdMG9USJlJnbSusylprI82pgj0xy8eXE3JFkd3LiRn1QVL8C9/6LCM="
      },
      "decodedResponse": {
        "id": "security-reviewer",
        "harnessSlug": "papercusp",
        "found": true,
        "role": {
          "id": "security-reviewer",
          "whenUseful": "Consult when SPEC additions touch authentication, authorisation, user input handling (XSS/SQLi/SSRF/path traversal vectors), secret/credential handling, CORS or other cross-origin surfaces, file uploads, or new dependency introductions on packages that could carry CVEs. Do NOT consult for pure-product features without those surfaces. Like infra-reviewer, most replans should NOT consult this.",
          "output": {
            "kind": "features",
            "featureKind": "security"
          },
          "alwaysFireOn": [],
          "budgetCents": 50,
          "featureSize": "small",
          "source": {
            "kind": "builtin"
          }
        },
        "consumes": {
          "feature": "none",
          "plan": "none"
        }
      }
    },
    {
      "case": "unknown-role",
      "tool": "roles:get",
      "arguments": {
        "id": "idop-unregistered-role-fire44"
      },
      "startedAt": "2026-10-29T01:18:12.424928+00:00",
      "finishedAt": "2026-10-29T01:18:13.991648+00:00",
      "durationMs": 1567,
      "exitCode": 0,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 135,
        "sha256": "ed2210390a0ca5deafd49e281f417931732e0058f8cfadc9a16da5bfd3286d8a",
        "payload": "eNo1jDEOhDAMBPt7huuko8o37gURbLhIxolsXCH+jimuWWk1O3tR36hEjJldFHu3E4ot62Dk1hXLQol+VQVmX/Y91rNO6Oo2g7ThEg+tsiHRa1ERZ060DjE/YFQuaqinayCSIQhtcpV/u+/PA46RLoQ="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5641,
        "sha256": "e01ebd86a5b4e79bbe48e4ef36347e3feab971dfa92f08cb4ed6e9c71237cfaa",
        "payload": "eNrtV81u3DYQvucpFjq1wI6XFEWJ2lvqU4CmKGqjhxQ9jMiRV41WYkkqbRD43TuSvU7jGEYOjZs1FgtoyeH8fpwhhx49BTtFv3LUdgNdjmO/Ov/x1eo7n3j4/XbV4zTYHYUXm924p80eQ9zB2LadpY2/kfbYwV9jeBs9fiRGv0Hv42bkGaYxbKINnU9xsyg+2/8RXyyj7cqOw0A2deOwSoE1rD5kkS3u8VcKkanZNls44SMjLIzwTmbrbBm+csxV5FUhUCMIQwYKYyto2lqBUKgalzea9Cxw8Oj8Rt0F/TnRYCnbynV2iPZinMJMymzfwRR6aHu8yv61vgTzM6Yd8/znyLAhtktDWsKKExRoClsrBNJKQKGFhUZIAtNQUzXOlpVoZyhY/ifcz36Hsae4vaI068LBdQ4T/TJOiWK2/e0Dr/PwvMfI06wfLfbgusBwMP9ujImpMq/OBP9mzPwYmKRkJdYZpkR7ny67PbGS16xAaiHE9e/rLFAK73+YHNtd6DnTWcKHjtF5f37w4zX+/fJGycLEuLfY9w3at4+w3JoldxcFG6R3jBL7esDykCMQE4Y5Fv6/ogcY5ph2GOli5iP3claSi7wEKSCvL4XcSsN2z7TK32TX32KqhnkS0+WdzjKvG6JaAH9zThlBUBdYgTSm0Y0UZNWcJAfIdil5uFXyGVy3i9GPQyTYEToOkNeXtMm2XyV/niXKS5Kxo3vfEyP3/yL8hTlvjH4zh9Cjj+RmcaXXi8MsmSaec10fx25JQ04XrQOnm4J18r4ZrVowRaVr6bTNCzzVxBOjfHw1oc50Wd2rCSnv10R+HLvViFaXpqrBMjJ8gpHmjZIlVKo2lW0ttUafauLUOD7fxvFrRHG3MBOuH2tNHzj4HuhOv4E+YOl9Pz3zhJbHccg5ItNUqoASWwVFWeVgJClA2SC6shXWVKdD7omvkqO8+I24VwT1p/d+IfSzLInj3Kzy8c06moeLUrUwli/uouaiYvX84CxdDaqUtkJjmyo/PVyeGuVjLAkj75eEfqgm/gEJgygm"
      },
      "decodedResponse": {
        "id": "idop-unregistered-role-fire44",
        "harnessSlug": "papercusp",
        "found": false,
        "role": null,
        "consumes": {
          "feature": "none",
          "plan": "none"
        }
      }
    },
    {
      "case": "missing-id",
      "tool": "roles:get",
      "arguments": {},
      "startedAt": "2026-10-29T01:18:13.992660+00:00",
      "finishedAt": "2026-10-29T01:18:16.900285+00:00",
      "durationMs": 2908,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5836,
        "sha256": "9f5a9dbf0c9fab37d50069396af6d6f341018752ebcace5702498c5e2324045e",
        "payload": "eNrtWM2O2zYQvu9TCDolgLkmJeqHuqV7WiApiu6ihwRFMyJHthpZYklqm0WwQB6iQC99ujxJRvJ607iLoIdmGy8MH8wZDj9yPs4Mx7Zg0enR28hg0/Z4OQxddPb8PHpiAw2fVlEHY6/X6E6W62GDyw04v2ZD07Qal3a72kLLfh/cG2/hk9LbJVjrlwNJEAa39Nq1NvjlDHy6+dWfzKMq0kPfow7t0EfBEUL0Lva04wZ+QudJG1fxbMk+GbLZkF2JeBHPw3NDVo2SSsqkZEkjNJOikKzGomG1ROCN4QASaMHuRGdbuAv8bcReY1yJRbzz9mIY3aSKddey0XWs6WAV/21+duYHCGuy+c+ZoY1oX+zD7JYfmYRSapUCwyzlTGZcs5oLZGWNdVEbnRe8maig9d/DZjq3Gzr01QrDhAW9aQ0E/HEYA/q4evWO5ml41oEnMe4GDR0zrSM6yH49+EBakRSnnD4TyXZwpEpFwRcxhIAbGy7bDRLICwIQGef85udF7DC46+9GQ/vO+oT0tMK6lti5Ptud4wW8fbYFmY2I9wa6rgb95gsmt9uiufOCNsQrYonOuuNyFyPMB3CTL/S9wnsMJp/W4PFiskPzbAJJeJIzwVmiLrmoRFkJecqVfBnffIuh6ibBh8s7zLRMjSi5YYlJFJM1AKMpxZoUpdQocRskO8rWIVh2C/IPum4nvR16j2yNYMhBmp/DJq6+Svw8SpbnIKODbmyHxNz/y/C/jPlUJS8nFzqwHs20PCXQ6cC0MowkU14fxm2VKi0k54KBkAmTygCrjZJMlVQ4k1oJWRxz4qFZPrycyE+zUu3lRJLv50RyGLeljASqYhlr6F6YNHRbZapzlie5kaYGnoE65sSxcXy8jePX8OJuYlLcfKk1vafw3dOdfgN9wNz7fl7zsiQ9jCJnOCapVDnLSkKSiUGmUkoBVQM9TVmqOE+PRe6Bn5JDfPhzke8lgfz83Zc8e5QpcZiXVe5dVnGgP1zSoix1rjNmstQwKTPDlAbBSgOZQJ0maV0f69cDs3yIKVEosZcS+T0p8eGvP6PpFiJqxEbXo4mgj9C5wVUnbX8FXWt+aXs7hiraieBWniRTRedbTXRrgG8tOUYQPri2Xy0IU2N7RYqx3/7LbKIP7/+IwhqjpsXOPPFPSYAQNdB2aBYEFDVjR8HzujWvI9Aaqa2iwAnXdmJ7i0tObdr+OfarqZcWNycfAS35db0="
      },
      "decodedResponse": null
    },
    {
      "case": "empty-id",
      "tool": "roles:get",
      "arguments": {
        "id": ""
      },
      "startedAt": "2026-10-29T01:18:16.901082+00:00",
      "finishedAt": "2026-10-29T01:18:20.329982+00:00",
      "durationMs": 3429,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 6349,
        "sha256": "6e19013123855ff3318a373341c8b21b5913577fc01e282784ad4afe30a11f72",
        "payload": "eNrtWNtu3DYQffdXEHpxAiy9pO5SkQKpiwIGckO86EOKoiDF0a4SraiSlC8IDPQjCvSlX5cv6ZDrXSeOEfShSbOBYWDNy8yZmcMZaqRRjGCayY5EQdsNsNC6J8dPTsiD0eHwYU16MQ3NCszBfKXXMF8LY1dUt23XwHzcaI+io+favLGjuFm041yMo51rnAmnzdw2phudnQfgo/VrexBGNWn0MEDjOj0QZxCBvI0sWlyLn8FYXI3qKEjSG0EaBOkZj2ZRGJ4olCplwSQvJVUSCpqqPKdVVgGVXCQiK6XijKHC1qPjDdwp/D7B0EBU81m0jfZUT8YvRU3f0cn0tO3FMnpvPwTzQrgVyvznzKAhtAuDC2HZiaaiTJsqERSyhNE0Yw2VjAMtJchCqiYvWOupQP1nYu39NroHWy/BeSwxqE4JBy/15MBG9S9vcR+Hx72wOI163Yieqs4gHSi/0tbhKo+LI4Z/nuRRG1xKeMFmkXAO1qNbdGtAkKcIwDPG2NWvs8iAM5c/TArthvUY11FjNB2yc3m89eOpuHi8AQlCyHsr+l6K5s0nRK7NgtpFgQbhDFlCX7dcbnOEWieMjwX/L+EOAR/TSlg49XKgHnuQmMU55YzG1YLxmpc1RwJY8Sq6+hpT1fiJdYsdZpZCmcqypU3JY5rKhtGqwEzJG1EyJWWRyTK6oWzl3EivQT6i63rTjnqwQFcgFAaI+yFtovqz5M83yXJIMnR0PfaAzP2/DP/LnI/L7JUPoRejBeXV42IWHEZNN/k5gu3FacUyl22OmKmAjKZNkdIqT0u8R3mSFS1D3OK+Jr4wy/tXE9VRGSe3aiKNb9dEvB+nVYCSZV6lVMYFxyOTnAretjSRMTYWCUuTNL6vifvG8dttHD9HFLsNv3D1qdb0jovvju70K+gDQu/7YR9Q5ntyyZVJUgrBBE1Zij8FcFoqyGnaxhxiyaqKV/eX3Bd+lOzlgz8vbxUBTz988Kcs+yZrYi9Pq+C3Tyvb01cXngEHHpc0S9uUply1tOKypDnHF03e5G2m7m+wL83y3tVEjIDV7RvsrpJ49/dfxJ8CwVZsMgMoIgYCxmhTH3TDmeg79Vs3jJOryXYqzNLiTNUEPxsTu8ZWrCZwMWJQqG6d6YYlYpKVOAPy/SNOmpVA4h0yQxarzhIL5gwMwZGZhsFLy6nrFZEJU1lbJq2YEbuJjvBs3Q1ELPUROWmJ8+rHz5+dLl4+Pnm2IOcCMTDCC+93ixZQQrgN3AzHsLMwGt2Atd6odV3fExhabZrgKoo9f/Ij0QOQd3/8GeaekkMUDW09Rr5ZNAAEm2OiOiuWfnLeuRU59yZfT9ahK+2EXJNLPWEEmmCUXXuJ3otuwG2P4WN/L2JAJwKwcBtX0D+MSfjv8sjnEflJm6DXTMZgLm498q7MSGifN0qYWP0Hhl7sPvH7XPXg2wIh6G5IsRCtUGrjTE0OryUP/entUJEGPPFpjdYteYDqwZQnyNaYEvoNVjYZ8C1i5uXs7GO0q4eYVCp49fT4hT+Ki0sSCgPPI3hr4LsNl+FGmJER64VQ/yL1yGdsPZ/vimTjOaZb3zWd6y+PDv4BJSgldA=="
      },
      "decodedResponse": null
    },
    {
      "case": "numeric-id",
      "tool": "roles:get",
      "arguments": {
        "id": 7
      },
      "startedAt": "2026-10-29T01:18:20.330961+00:00",
      "finishedAt": "2026-10-29T01:18:22.336164+00:00",
      "durationMs": 2005,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 6124,
        "sha256": "2a774cca8233cd03475dfc98d6bb72348e4731ce43ac82b8eb4ad2e1acc3911d",
        "payload": "eNrtWM1u4zYQvucpCJ0SwLRJSrJ+sFgg9QboAt4fJEEPWxQ1RY5sdmVJJSnvGkGAPkSBXvp0+yQdKXHSZoNFD910HQQ+WBwOv5n5ZoYau5UtWNW5lmgoTQ3nTVOR2fwlOWw9Ph7lpJJdrVZgDyarZg2TtbRuRZuyNAom7dXpVhr6obHvXStvha6dyLZ1kwZX0jd24pQ1rXeTAXi8/sUdDE85UU1dg/KmqYm3iEAuAocW1/IHsA6lQR4MmvRWkQ6KdMODUTA8vtSoJbIiYSIGGhUJp9E0ETTLwikVQqZhWWZSlhke2Hk0u4I7g187qBUEOR8Fu2jPms72okBVhna2omUll8Hf9odg3kq/Qp3/nBk0hHah9kNYrqORTCOVhZJCHDIaxUzRgnGgaQFFUmg1TVjZU4HnX8t177dtKnD5EnyPJWtttPRw2nQeXJD/eIH7+DirpMNlUDVKVlQbi3Sg/qpxHqVcJGOGn57ktrEoCnnCRoH0HtatPzdrQJBXCMBjxtjlT6PAgrfb7zqNdge5QDmeaK1BdraznR+v5MfjK5BBCXkvZVUVUr3/gsq1WdA3UaBB2CBL6OuOy12NUOel7WPB7yXco9DHtJIOzno90Mc9iGBiSjmjIjtnPOdpLtg4Ctm74PJbLFXbL5w/v8FMmEpEWEQ04UVGI2AZTUFnCByJuORlXKQiuKVs5X1Lr0E+o+t607VN7YCuQGoMEPeHsgnyr1I/j5LlocjQ0XVbATL3/zL8L2t+mibv+hAq2TrQ/XERjwaH8aTv+jWC7UW2sijVAFlGiymLaRRiogoBmK0UTYmoBJnFTz3xwCzvX0/w8TSZ3umJJLvbE2I/shUmcQwJS6kSUtKIZ4ymMhaUiVSJkAOLtHrqiafB8fEOjl8jipuNXnD5pdH0novvnun0G5gDhtn3H3ceD0W6J2OajjM9jYCKOElpxEpOU8UFLcKYyUKnIePJ0yX3wK+SfXzxJ/HdYfjOLByx+FG2xF4ma/rZjcWTPf3pgm0VlVxqqgpAYA4plSLWFPsry0DGqYqLpxvsgVnev6YQYx5ld5tiek9PfPrzD9KngeAs1tkaNJE1AWsbmx+YeiMro382ddv5nOyW0i4drnROXl5JyLUCfGwxMoRw3pp6OUJMBWaDgrpbF2DJ7M3p6cns/OQFmR3P5+TTb78TB7UmfmUQ8WYGPbwggcE0keDZFdLzgFwekUN0cdsi2sLoBTlc7DYXRxgBYgD+m60qaVGj1zsak5MN2C1ZPOuXzxdEFs0GiHFEkrfz49nJ92/mL05OR6RuPIqWWCLohce0AEGUAbE0UGk3OIjRlJ2TFVZ2V2HMGmvDlFtSdJ7gyNyDlKaqSNlYsm26IToLbdXXPki1Ih+MX6EdC4iBvHVACkBlGDjAQMbDkRurhw7jWklElaYCPUKWSdlV2FpD/FIpwLET26qPrp/7BzYw5WtTz6Fe9r81+OXBX0oqzI8="
      },
      "decodedResponse": null
    },
    {
      "case": "unknown-key",
      "tool": "roles:get",
      "arguments": {
        "id": "infra-reviewer",
        "harness": "papercusp"
      },
      "startedAt": "2026-10-29T01:18:22.337341+00:00",
      "finishedAt": "2026-10-29T01:18:23.685859+00:00",
      "durationMs": 1349,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 7053,
        "sha256": "ff5c7acca904ab5521fc0026cd905f941145101461c4f8c9ca60d102ddb7ce52",
        "payload": "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"
      },
      "decodedResponse": null
    },
    {
      "case": "all-sentinel",
      "tool": "roles:get",
      "arguments": {
        "id": "infra-reviewer",
        "harnessSlug": "all"
      },
      "startedAt": "2026-10-29T01:18:23.686798+00:00",
      "finishedAt": "2026-10-29T01:18:27.165073+00:00",
      "durationMs": 3478,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5865,
        "sha256": "f74ec70c2a14447f17997bef64aac46cb8df998b50ea362f3405ef2014f8ec15",
        "payload": "eNrtWM1u3DYQvvspCF3aAstdifqhpJvrU4CmKGqjhxRBMCRHlhpJVEnKqRH4OXrp0/VJOpK9du0aQQ+N0zWMBXap+Z+PM+RoJ5jQ6dlPzGDTjXhmbc9OvnvFvp4CLb+pWQ/zqFt0R7vWDrgbwPmW26bpNO6ma+0JOv7Buvd+gjuin3YwTX5n6QmCdTuvXTcFv1sNb4df/NG6qpm244g6dHZkwZEF9jHy5HGAn9B5okZ1tEryO0G+CvKLJNpE6/KVIamsagyKJOdFAgXPlC55GaeSq6zJJGoDqkpJYR/RybW5U/x1xlFjVCebaJ/tqZ3dQop03/HZ9bzp4Tz6G39N5gcILcn858iQI/KLY1jT8jPPoMx0lQLHPI15lseaqzhBXipUUhldyLhZoCD972FY4na2R1+fY1hswWg6AwF/tHNAH9U/fyQ+LU968PQY9VZDz03nCA6Sb60PRE2E3Mb0WUCerCNSmsh4E0EIOEzhrBuQjLwmA0kex/HV203kMLjLb2dDfle6IDppTK4jdC5P9nG8ht+Or42sQoR7A32vQL//hMiNWzS3WZBDvCCUKNY9lvsa4T6AW3Kh33N8RGDJqQWPp4scmuPFiIhFwZOYi+osTuqkrEW6lWXxJrr6P5aqWx58OLu1mYMoTFMarhpR8qzCjCspFZdgRIpJo2ShozvI2hAmfmPkH3DdMP1kR4+8RTCUIPHXsonqz1I/zxLltcgo0GHqkZD7sgj/q5rPtokQb5YUepg8mkU9rTZrwKQZZnqmvj6M3SqTRjdCNTxGyjMrKFOQFXKMVS4S+tK5eemJJ0b58Hqi2BZ59aAnEvmwJ8SB7FaOUou04EWRpzzTCXCFBXBBNIyLxGiTvfTEy+D4fAfHz5HFLWMhXH1qNH3k4HtkOv3iZ97N7HvvzBNllR3GIdeASFVcGJ7JmMa0rCnIpgCeiEpmqjRNnqqXQ+6Jr5KDvPhl+aAJivv3fhbnz7IlDnKzyodvLjR+HuirizayiBVWPK6yhmcp0K1dlMBLKUohFQKW8uUEe2KUD68pyGSVPGgK+UhL/PnH72zZBUaj2OxGNAxGhs5ZVx+1QATv3zXWqc4YHGt2Qzrt53MW0QwWsZHmR89gz2EUqu8MstB2nnmi0L5+5VnbXSCLbifaaMuOmXbWe75yCJeeDbDX+wCXVD9zb9hoA/0XHdAxRVI9EBhmQ7xhoJ2haO24YdYRx1KSTF3e87s9+gvqOn9R"
      },
      "decodedResponse": null
    },
    {
      "case": "star-sentinel",
      "tool": "roles:get",
      "arguments": {
        "id": "infra-reviewer",
        "harnessSlug": "*"
      },
      "startedAt": "2026-10-29T01:18:27.165885+00:00",
      "finishedAt": "2026-10-29T01:18:28.599751+00:00",
      "durationMs": 1434,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5863,
        "sha256": "b0ede2b911041fdbfcc77d5b9cb6607546c2c7b60b0c7ceee1d12fbb349623b8",
        "payload": "eNrtWM1u5DYMvucpBF/6g9GM5H/7lua0QLcomqCHLYqCkujYXdtyJTnbYJHn6KVP1ycp7WSSJhsseuimO0EwwIxMUvz5SEr0TDCh07OfmMGmG/HM2p6dfPuKfTkFWn5Vsx7mUbfojnatHXA3gPMtt03TadxN17sn6Pg76976Ce6IftrBNPmdpScI1u28dt0U/G5VvB1+9UfrqmbajiPq0NmRBUca2PvIk8UBfkTniRrV0SrJ7wT5KsgvZLSJ1uUrQ1KqApOWacwhLiRPRZJxUCXyREkJWZVXeZPRhr1HJ9fqTvG3GUeNUS030T7aUzu7hRTpvuOz63nTw3n0D/4azPcQWpL5z5EhQ2QXx7CG5WeeQpnqKgGOWSJ4mgnNlZDIS4WqUEbnhWgWKGj/dzAsfjvbo6/PMSy6YDSdgYA/2Dmgj+qf3hOflic9eHqMequh56ZzBAfJt9YHosq42Ar6LCBP1hEpkYXYRBACDlM46wYkJa9JgcyEEFc/byKHwV1+Mxuyu9JjotOOyXWEzuXJ3o/X8PvxtZJViHBvoO8V6LcfEbkxi+Y2CjKIF4QS+brHcl8j3AdwSyz0e46PCCwxteDxdJFDc7woiUWccyl4XJ0JWcuyJgDiPHkTXX2OpeqWBx/ObnVClcRFHEueN0lBRVLmXFFdcKoOyIzURgBGd5C1IUz8RskHcN0w/WRHj7xFMBQg8deyiepPUj/PEuW1yMjRYeox4P+M8L+s+SKu3iwh9DB5NNeNXG5Wj2lrmIlAjX0Y6ZKyQo1Q8rSo6Cs3pN0UyGWKukDMhQD50hRPjPLhNUW5TYR82BTyYU/Eh5GtAjOTx5XhMskVT1We8bIgE6hKkaekUTf5S0+8TI7Pd3L8FFHcMhbC1cdm00cOvkfG089gEFiH3/tnnsgO5JBLVKMqBchjrHK6l5qGVxlUvMkbFcs0Lkz+Mg0/9VVykBe/fNgExf17PxXZs2yJw0xW+SBZh/rionVBH1lRnkzK01QnvISipPfMBlQh8wyT5uX8emKUD7El0uqDFxfxSE/89ecfbEkDo0lsdiMaBiND56yrj1oggve/NNapzhgca3ZDOu3ncxZ9HbGRhkfPYE9n5KnvDLLQdp55olBav/Cs7S6QRbfjbLRlx0w76z1fOQRLzwbY73sHl1Q+c2/YaAP9Ex3QMUVSPRAWZkO8YaDEkK923DDriGMpRqYu79ndHv0NYMd3uw=="
      },
      "decodedResponse": null
    },
    {
      "case": "unregistered-harness",
      "tool": "roles:get",
      "arguments": {
        "id": "infra-reviewer",
        "harnessSlug": "idop-argument-scope-unregistered-fire44"
      },
      "startedAt": "2026-10-29T01:18:28.600688+00:00",
      "finishedAt": "2026-10-29T01:18:31.864784+00:00",
      "durationMs": 3264,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5899,
        "sha256": "39e8799293d0fc9f31c6803eef762de70c7e1c194915b39d29b0b8ba71c79060",
        "payload": "eNrtWM1uJDUQvucpLF8AaTzjdv+5+xZyWolFiEQcQAi57fJ0s93txnbvEq3yHFx4Op6E6k4mISFaOLBZJormMHb91+cqu2YmNYHXc5iIAduNcOFcT86+ekU+nyIuv6hJr+ZRt+BPdq0bYDcoH1rmrO007KZr7Ul17J3zb8Kk7ohh2qlpCjuHOxWd3wXtuymG3Wp4O/wcTtZVTbQbR9CxcyOJHi2Q9zSgx0F9Bz4gldZ0lWR3gmwVZG8TuqHr8pVBKW2b0lZVxlSqDMs0aCaLpmF5IoRRmldWLwqHiM6uzZ3DLzOMGmidbOgh23M3+4VEdd+x2ffM9mpP/8Jfk/lGxRZl/nNk0BH6hTGuaYWZZUpmukoVgzzlLMu5Zg1PgMkGmrIxuii5XaBA/a/VsMTtXQ+h3kNcbKnRdEZF+NbNEQKtf3iPfFye9SrglvZOq56ZziMcKN+6EJGaiHLL8bNgNjmPpDQp+YaqGGGY4kU3ABp5jQaSnHN+9eOGeoj+8svZoN+VLpCOGpPvEJ3Ls0Mcr9Wvp9dGViHE3aq+b5R+8wGRG7dgbrNAh/AWUcJYD1geaoSFqPySC37v4RGBJadWBThf5MCcLkYEFwVLOBPVBU/qRNZCbktefk+v/o+l6pdNiBd3NjWkpc4FS1IrWWbLgknJc1aIrCyNlbmFlN5B1sY4sRsjf4PrhhkmNwZgLSiDCSJ/LRtaf5T6eZYor0WGgQ5TD4jcp0X4X9V8teUF1jym0KspgFnVebFZI0bVOCMBG/s4jquoVJkAL1guygZtVhqt4+kVuRZaygoaU700xROjfHRNkSbbvEofNIV82BLiOA5LNSbTWVExkcmKZdLmTGWFZZJraWWJaAl4aYmXwfH5Do4fI4tbxkK4+tBo+si998h0+snngJvZ996VJ2RVHMmLVKYZAFZ6U+FNl1WNQusCWKKrLBeJylRevlxyT/yUHOO7X3DxoAmy++9+xvNn2RLHeVj5Pw1pR/K7RdrE6iJPWSU52jToFedowcpUal1oq0sjXu6vJ0b5GFtC8uRBS5SPtMQfv/9GllMgOIjNfgRD1EjAe+frk1YhIYSfrPNNZwyMNbkhnffzntDOuIkpv58HRIkFjSfA5tHDvgsRPBhmMdMso2TECTMQddAmmE7oDJDYdoEEpODZfxZI270FQm9nXrolp0R7FwJbOYhdTwZ10HunLrHG5t6Q0UX8txpdkgaleoWAmQ3yhiUuzMiNG+I8chwCQZrLe363J38CUdKTjA=="
      },
      "decodedResponse": null
    },
    {
      "case": "numeric-harness",
      "tool": "roles:get",
      "arguments": {
        "id": "infra-reviewer",
        "harnessSlug": 7
      },
      "startedAt": "2026-10-29T01:18:31.865534+00:00",
      "finishedAt": "2026-10-29T01:18:35.736456+00:00",
      "durationMs": 3871,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 6169,
        "sha256": "3e82dd4f7f9356fac7ea5ec873d1d351226240026f2166b808f39a94de89e261",
        "payload": "eNrtWNtu4zYQfc9XEHpKANPW/YbFAqk3QANku4sk6MMWRT0iRxa7sqSSlLNBEKAfUaAv/br9ko6UOLcGiz50s3UQGLDF4fAMzyGHHLmDDrXoTccklqrB07at2fzokO12lh73clZD34gK9c6salc4W4E2FW/LUgmcdVejO1D8rNUfTQe3RtPNoOvMrKUW2FbPjNCqs2Y2Ak9Xv5qd8Slnom0aFFa1DbOaENiFYyjiCn5Ebcjq5M7oyW8d+ejI154zccbHQ0leQVjGWeZGPIxS+sJEcIgFcA9SEbtQJIVIacBmRvMruBP8rcdGoJN7E2fD9qTt9WByRK14r2te1rB07vSPZN6DrcjnP1eGAlFcbOxIy/Q8hDQUWQAco8Aleq7gheshTwskVlLEiVsOUtD4H2A1zFu3NZp8iXbAgkYqCRaP296icfKfLqifHuc1GGo6dSug5lJpkoP8q9ZYsnp+MnXpM4jctZpMgZe4EwesxVVnT9UKCeQtAXiR67qXP08cjVaff9dLijvafbLTiE4rUud8vpnHW/i0fwUyOpHuJdR1AeLjF1yuw6K8YUEBcU0q0Vw3Wm72CDcW9MCFfpf4iMPAqQKDJ4Mfyv0BxHf9mHsu97NT18u9lPhOszD+4Fz+H7eqHhrGnt5guomfShGUXASZz8M49DlkmHGBoZcmGPkQxM6tZJW1Hb8G+Ydc152maxuDvEKQRJD6x23j5F9l/zxLlcdNRhNddTWSct9W4X+15/2pHwYfBgo1dAblMDxMJ+OEaaTtqU15vR2rFWeelOhHvIzcgIeFV3IosoKnQQIos0TEZfSSE0+s8vblRDhNo+hBTnhe/DAp/O1YLj8pilIWJS/KsqQjrIjoCBOC+6Eg9eKEIsqXpHipHJ9v5fg1WNx0DIbLL9Wmj5x8j5Sn3/zQuy5+7x16getn23HIRQVmiZumHCIq0cIg8uhO8hIuCy9MCjfwUoCXQ+6Jr5JtvPmz5GE1HN2/90M3epYpsZ2LlTxYrG19c/FlKkMvBJ54Muahn0ieYRDzKCoxw1Ckgcxezq8nVnn7UiKaRm748G0+fCQnPv/1JxuWgVEl1usGJYOGodatzndUs4ZayV9U0/U2Z5sm6KXJWQXkbcxJ3S9zdnjVxa498VNHFAnLWK2a5YTABao1GZp+VaBm83fHxwfz04M3bL5/dMQ+//4HM9hIZitF0Del6O4FcxStF303pQZSeq3wDLUzYc6d+IPDq6tQrx12ucd2icx5R+EWd7wWbHex8VrsEWmKhvT/t6hBk+swYG/KDtaoz9ni1dB8vWBQtGtkyjBg74/25wffvzt6c3A8YU1rybSkXUXztbSSyAhlRCwV1tKMVIh32RuoKRn6mtSRtJ1Uec6K3jKqsQeQUtU1K1vNztt+1EFjVw/pgiAqdqZsRXE0EgYp3CMrkJxxVIuITMchN1F3DfGqgFBB1SgntB6s7GvKxvtCgBBIBSul5EBzeGMYZXEud/4GJ9vovw=="
      },
      "decodedResponse": null
    }
  ],
  "limits": [
    "Current parent caller only; not an original launched non-SU-role baseline or exhaustive argument population.",
    "Current-build reads do not authenticate historical source, four vault settings, or full P001 acceptance.",
    "Supplemental schema exposure, transport validation, handler lookup and dispatch authority remain distinct.",
    "No product source, role, grant, identity, mode or acceptance gate changes."
  ],
  "sourceAfter": [
    {
      "path": "packages/operator-core/lib/agent-tools/roles/get.ts",
      "sha256": "e135c0bb2f36c1636134328ca0c274cce6af411556ff7b789b66d4b836933362"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/_harness-scope.ts",
      "sha256": "9522f7a699a19eb814efdf29813fc82a9eae610381fb82297f51a92c9f62af8f"
    },
    {
      "path": "packages/operator-core/lib/role-registry.ts",
      "sha256": "336c54895438c72d80d9aa340e5fac6b94245ce0cdf8ca77d73c5bbac66d5a63"
    },
    {
      "path": "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts",
      "sha256": "6ebdeee75c25aa844020e115f28eae3faa1643c82095057bfb19d38de4c98e98"
    },
    {
      "path": "packages/operator-core/lib/endpoint-route/hive-harness-arg-coverage.ts",
      "sha256": "b4573c80d76c27968f305885359c66528bb8d6dee39c9a1f38891c291d5216b7"
    },
    {
      "path": "apps/operator/scripts/ptool.mjs",
      "sha256": "6f16bc5ebb60ba0a5cec7c05b6cad6546f905ac2720a1ce1d0927ac08cf4d355"
    }
  ],
  "sourceStable": true,
  "finishedAt": "2026-10-29T01:18:35.755633+00:00",
  "interpretation": {
    "cases": [
      {
        "case": "default",
        "exitCode": 0,
        "found": true,
        "id": "infra-reviewer",
        "harnessSlug": "papercusp",
        "consumes": {
          "feature": "none",
          "plan": "none"
        }
      },
      {
        "case": "explicit-home",
        "exitCode": 0,
        "found": true,
        "id": "infra-reviewer",
        "harnessSlug": "papercusp",
        "consumes": {
          "feature": "none",
          "plan": "none"
        }
      },
      {
        "case": "second-known-role",
        "exitCode": 0,
        "found": true,
        "id": "security-reviewer",
        "harnessSlug": "papercusp",
        "consumes": {
          "feature": "none",
          "plan": "none"
        }
      },
      {
        "case": "unknown-role",
        "exitCode": 0,
        "found": false,
        "id": "idop-unregistered-role-fire44",
        "harnessSlug": "papercusp",
        "consumes": {
          "feature": "none",
          "plan": "none"
        }
      },
      {
        "case": "missing-id",
        "exitCode": 1,
        "refusal": "invalid_input: invalid_args: id: Invalid input: expected string, received undefined — the field(s) that failed, in full: `id` accepts {\"type\":\"string\",\"minLength\":1}"
      },
      {
        "case": "empty-id",
        "exitCode": 1,
        "refusal": "invalid_input: invalid_args: id: Too small: expected string to have >=1 characters This server is running build b30d5f83fa, started 15min ago. If this CONSTRAINT was relaxed after that build, the running process is still enforcing the OLD one — the tool's source in the tree can disagree with what just refused you, so verify against the serving build before treating this as a defect. For the current source tree, retry this call against the Papercusp staging operator at :3170 — add build: 'staging' to this call's arguments (or call tools:invoke { name, args, build: 'staging' }) and the MCP proxy routes it there; with ptool, pass --url=http://127.0.0.1:3170 explicitly."
      },
      {
        "case": "numeric-id",
        "exitCode": 1,
        "refusal": "invalid_input: invalid_args: id: Invalid input: expected string, received number CORRECTED CALL — send this: roles:get({ \"id\": \"<string>\" }) (retyped `id` (`<string>`) to the declared type). Every `<type>` above is a PLACEHOLDER, not a guess: those are the fields this refusal could identify but cannot fill for you — replace each with a real value before sending. — the field(s) that failed, in full: `id` accepts {\"type\":\"string\",\"minLength\":1}"
      },
      {
        "case": "unknown-key",
        "exitCode": 1,
        "refusal": "invalid_input: invalid_args: Unrecognized key: \"harness\" CORRECTED CALL — send this: roles:get({ \"id\": \"infra-reviewer\", \"harnessSlug\": \"papercusp\" }) (moved `harness` -> `harnessSlug`). This resolves the rejected keys against the args you actually sent; it does not guarantee the call validates, since a value-level error would not have been visible to this check. — this tool accepts ONLY: id, harnessSlug. (Dispatch-level args, handled by the transport before this tool's own schema and therefore not in the list above but also accepted: payloadTier, projection, view.) Did you mean `harnessSlug` for `harness`? An undeclared arg is REJECTED, not silently ignored (EI-10883): passing an arg a tool does not declare used to return ok:true while quietly doing something else, which is indistinguishable from success. Re-send using only the keys above (or the dispatch-level ones just listed). This server is running build b30d5f83fa, started 15min ago. If this argument was added after that build, the running process has never seen it — restart the app/process to pick up the new code. For the current source tree, retry this call against the Papercusp staging operator at :3170 — add build: 'staging' to this call's arguments (or call tools:invoke { name, args, build: 'staging' }) and the MCP proxy routes it there; with ptool, pass --url=http://127.0.0.1:3170 explicitly."
      },
      {
        "case": "all-sentinel",
        "exitCode": 1,
        "refusal": "harness_forbidden: harnessSlug \"all\" names a harness outside this session's hive \"papercusp\". A cross-hive call made this way could not later be claimed, commented on, or closed by this session."
      },
      {
        "case": "star-sentinel",
        "exitCode": 1,
        "refusal": "harness_forbidden: harnessSlug \"*\" names a harness outside this session's hive \"papercusp\". A cross-hive call made this way could not later be claimed, commented on, or closed by this session."
      },
      {
        "case": "unregistered-harness",
        "exitCode": 1,
        "refusal": "harness_forbidden: harnessSlug \"idop-argument-scope-unregistered-fire44\" names a harness outside this session's hive \"papercusp\". A cross-hive call made this way could not later be claimed, commented on, or closed by this session."
      },
      {
        "case": "numeric-harness",
        "exitCode": 1,
        "refusal": "invalid_input: invalid_args: harnessSlug: Invalid input: expected string, received number CORRECTED CALL — send this: roles:get({ \"id\": \"infra-reviewer\", \"harnessSlug\": \"<string>\" }) (retyped `harnessSlug` (`<string>`) to the declared type). Every `<type>` above is a PLACEHOLDER, not a guess: those are the fields this refusal could identify but cannot fill for you — replace each with a real value before sending. — the field(s) that failed, in full: `harnessSlug` accepts {\"type\":\"string\"}"
      }
    ],
    "defaultAndHomeStdoutIdentical": true,
    "knownRoleLookups": 3,
    "unknownRoleFoundFalse": 1,
    "invalidInputRefusals": 5,
    "harnessForbiddenRefusals": 3,
    "sourceStable": true,
    "streamPinsVerified": 26,
    "measuredStagingBuild": "b30d5f83fa",
    "sourceComparator": "git show at measured build proves committed bytes; does not prove complete import closure or original native role population.",
    "testSuiteClaim": false,
    "historicalBaselineClaim": false,
    "universalPermissionClaim": false,
    "runtimeReceiptPartial": true
  }
}

