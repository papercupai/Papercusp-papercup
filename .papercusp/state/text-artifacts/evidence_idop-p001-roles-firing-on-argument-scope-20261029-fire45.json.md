---
rel_path: "evidence/idop-p001-roles-firing-on-argument-scope-20261029-fire45.json"
updated_at: 1793238604987
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
  "startedAt": "2026-10-29T01:46:33.239340+00:00",
  "caller": {
    "ownerId": "su-4a84c93a-e530-450c-b01e-8beb7bdc670f",
    "nativeSessionId": "01a18535-e060-70b1-a0ee-4f50741f39db",
    "roleEnvironment": null,
    "workspace": "papercusp-workspace",
    "harness": "papercusp",
    "route": "http://127.0.0.1:3170",
    "authority": "Existing current-parent credential unchanged; no role/grant substitution"
  },
  "schema": {
    "sourceArtifact": "evidence/idop-p001-supplemental-raw-schemas-20261028-fire42.json",
    "sourceArtifactSha256": "8c2dfb092eda7a0c3f6ea88799f7e2f2d77745efb1ef2e9aeb8b38557e3fbecd",
    "entry": {
      "name": "roles:firing_on",
      "description": "Return role manifests whose `firesOn` array includes the given hook event.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "event": {
            "type": "string",
            "minLength": 1
          },
          "harnessSlug": {
            "type": "string"
          }
        },
        "required": [
          "event"
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
    "inputSchemaSha256": "c9656bb15b7d8701355822eb9852257f471781bf3bffc1e59548a9b94cf881c9"
  },
  "sourceBefore": [
    {
      "path": "packages/operator-core/lib/agent-tools/roles/firing_on.ts",
      "sha256": "8b04b4e51b39b797997a93d24179821813f4e37adc24334694b341af39df7ace"
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
      "path": "packages/operator-core/lib/agent-tools/roles/firing_on.ts",
      "buildSha": "b30d5f83fa",
      "committedBuildFileSha256": "8b04b4e51b39b797997a93d24179821813f4e37adc24334694b341af39df7ace",
      "observedSourceSha256": "8b04b4e51b39b797997a93d24179821813f4e37adc24334694b341af39df7ace",
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
        "path": "packages/operator-core/lib/agent-tools/roles/firing_on.ts",
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
          "buildSha": "3b6ae73b92",
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
        "originalChars": 3510,
        "returnedChars": 2759,
        "omittedCount": 1,
        "omitted": [],
        "cursor": {
          "kind": "scratch-page",
          "tool": "capability:read",
          "args": {
            "file_path": "papercusp://scratch/papercusp-workspace/dev:pipeline_position/d368c8cf-67db-4b58-8fab-ce4a93370a5f/result-door-1793238355108-4b8fdf01.spill",
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
      "bytes": 2765,
      "sha256": "5f52f1e3c656096cb508427044c0e665736d866f08d84c79956c6077c490f942",
      "payload": "eNrFVttu4zYQfe9XEHppFrUs+RZf8tYFiqJAW2CzfSoWMUWObDa0qJKUvUawQD+iX9gv6RlKzqVN96UPiyBBRA1nzpw5M6OHTHXeUxO/7YzV7ynEd66LlG0eMqOzTeZa8jI6n8vWZKMsuM4rvM3eusPBxEhaWKekFaaJtIOlcY2ovGzUXlyFKHem2YnqLDTVsrPxzQjmUuMWzg4Sl/CLp4tlODcKUXzXRHPgMMOL/AKDX/b4sn2M7aYoJtPluMTPZDObLEsh60ge4Y6b1rRk4f2udcEkXMqleAdkK9Se1P3F23fGskfZtqG4RCqC8qaNoQjnEOmgi1bijera/IIJjIwD+aNRNNbFonx8kXzD7xgBa8QwwdnEDGLcUivhn0TrfByJ1jtFIQjZaHG5diO0jLKSgdLxyfn70EqFJ0+icVH0/kiP4bv15On3ziBFCtnmVxQmJZnYHFhVqVYD8+mOOTIE3IAzDTpMPBccVNTOi5NPvj6MsiN5Uxt1wf4jydB5lKunumLFPN4Xre2CYCzwWngKrWuQAWiPexl7YwbsSWpUJQBs+v+cfRpldyAlGmmzTfQdgbGm7SJrsJVxD0Okfy939FSdXDlPhTVVgeMm5tE5GwrvLGxq45H1nWvGMbBk9zLbNJ21iBOl31G85ZNsslTzeqbX81LT9Wq1Xi5pWq71YoF/r0s5L6/n07mu1nChjY/nXxp10Xy2qaUNwJnK3+ze9Xpl/h+yA8W949aprKteiNmTBYP0UsxJee7UED8mlnp4ejkvazVbldNn57eX9tuTtGBmlA2aDm/3stnRE3+ofaMYEWc+yrrmvkGQd4jPpezp+BzWVxvvv7BWs1Iv6tWsll8Ea7XL9y7EJ4gouU9Kf4ZxVl1LWs6q9Zfhc4eGO8nz5zFO9XI6W9eLBb2GcXCWH3ls7uj/gf3ATefdb6T65n7I7k2TkLuuwZjIW3nmgYEo8NoomWTfB4gGAkgSabT0bIKxoZ7eO2+gHWkBywPEbDEpue9j5zHrh8PpcrGGZd9PbxET7T55PEAjASA2U4DynrBhJMuo9sCW0uemx6mSrayMxQza8EDBC3R54Gs15vrd4whJ4zvwzhj8FI9n+eOQLV5dHYWeXa/UStX59VJX+bxarPJVLatc0VyuZ7NlKRc1Dz3suFw7zKfJcj2bzlazBZJf4cKq1nU5GYfWWMvFPUe6c3UdCHmXw7M1yB58lcspZlXl9BlbtrXE6y4NHJw29BEm2fs9CRoWcB9WnGRIozsSRq7D1CW8qbEdIAWsZ7FltWBWbsVff/wpmEKBpQBL6KWFDMSJ5zRfY14v3seCQ207b7YvnRgsLVF7eeD1PdTlKd6gTPKjtLGk8PIkfrj9+SfBNRkLaFFz+JOJezh9WcGtYDoSxCCuts+42opvxPaJq+0oOcDOFFsE2L5JC7N21rqT2DJVd72GtpznUVqjee+xUdecvGwBIeA7pDE1r8KKoGOO6wOvTaZi6IKb9DB8xIimO1TEe5A1Io6GTkJJkD70CbK1jtcvnFjKk9HgZyy+dyc6Mi3x3xWUNi1EOPPeIPWuDREnBzFsRyD19+SvwhtxFZHc+0tjvrlhsnrMJjwrO2Ax/Z6UQ9AUc+gw1IGsDiPh3Ql/sfbZY1/t17+e/gEyYdGsAXYkIL7HOcHlzdlKdAOREFYy+zoI7VTHX2Ap7QTrLDC+tCUG0SB1MOTxrbNLZuEGIU74yPACvZr3wVLxgeCcxEUfTYjj7NOnr/4GMbHPJQ=="
    },
    "stderr": {
      "encoding": "base64+zlib",
      "bytes": 15746,
      "sha256": "4fced27a6b287047362875c179151b715fed35597e4dac30553d9acb8fb9f95d",
      "payload": "eNrtWt1v2zYQf+9fYehpA0KbpChK8lsX7KHYWgxLsAEdhoGiTrFWWeJEKWtR5H/vUf6I4zjegOZLKZGHUNR98I73uzvKNMpAq3trJjkUZQ3nTVNNTn9+M/nOdDj8fj6pVF/rBbSvZotmCbOlau2CNEVRapiZFbdRJfm3aT9Yo64nrZkpY+yswSfVNe3M6rY0nZ0NgqfLv+2rYTSf6KauQXdlU0+6FiVMPgcWNS7Vb9BanA3mwUBJrgnJQEguWXASDMM3OVJpHmZKsZQApyERoaQkSakgWRRnNBKSJkWEDJsVna7EncE/PdQagjk7CTbWnjV966YCXZWkbytSVOoi2Hk/GPOL6hZIc++eQUWoF+puMMv2RKhE6DRUBKKQEhFRTTLKgCQZZHGWaxnTwrkC+d+ppVt3DpdzUxqocFP/Mo0tnducXFXnZa46+LXpO7DB/I/PQeuGp5Wy+BhUjVYVycsWXYP0i8Z2OMt4PKX45xxumhanQhbTk0B1HSxNd14uAYW8RQEsopRe/XkStNC1n37o8wtYzXOcRw7TluipT6ebdbxVH1+vhAxEuAeFqqpM6Q9HSNZqId9agQrhEj2Ga934dRMvxHaqdbbg/ws4QOBsWigLZ44O8tdOCKdcEkYJT88pm4tozqMpk+x9cPUcw7Z1D7Y738qkEEMoVUh0kQmUyQqiIspJEiWSKiWjLE2Da5ctus6QtZBb7lq/tKapLZAFqBwNxPdD2ATzB4mfF+nlIchwoUtTAXruaT38v2JeTmks3zsTKmUs5I6dxyfDgpGz690zChvFbgkBEUQFypR5TgTNJEkLVK1DVRSglU4Z9Zh4ZC+PDxPJVNJwDxNyHxJ8HJsFGVcF1YLQhEdEiKTAzeKKMEGTOOW4VVnkIeF7yG+jh3wIK7Yv3MTVsS71QA480Kg+efpbt8E30l+I0TSOhKfiQiuKkkRcxEQkMiYJRClJJWihFUiWFT7hPXJZGWUPwOg+CG72AIJGLxIS49wsvrdZ0TjOML6V8K3Ef7cSK0gawPXVFzuIdP63pCpt91xguN84DNyjyJJaiFjKjBEtE04EYzlJU5qTUBcCVeVY1Hzj4NObT28Plt7a5gIxY58ov621/1TWQ8+0IiSFKivIgy3nENXr8Y/XaY6hkMHVZdW3sJaBSKrtoB1NbVuHkBwNICEfiOEWe4sgLWtM8TvbTNM0xe+xZnAIcwHXqaq52NPNPfo9+j367wv9g7eJw03e34b/8PZ3Va4lpNFR4O8B9eWh/Gs7qdGdN8ND582R/EDgU7JPyaNuyDZHrW1C5geFrPZiN/liopZ3JN9E0PB48nXMI/kyKzItIxQSUsAvs3GakCyPE/ydlgn84CdBgPDH2Ef28uhKnKBTTlP/SdWXOF/iHr3E7eSJA1VupyzFSRKvIua06Z1VDHF8s+qlIgnvqHo0YvJ41XPMHuIe4h7i9wVxh7ZdfG/RdwvEuPZ38BFj1xGgry3cCdEj+Pbo9egdNXoP9MzP/0dPh8qR3A3JBU8jmeEFd7ziRUQOjCjh7rsnCcNBGoUs88fFR/by+I6LyZSz/eNiEvrzoi9H38YVHNRcPQ8cMhaP5QqOB54H3lf3gc8ZeTHj4urVF3H/IGw="
    }
  },
  "requests": [
    {
      "case": "known-default",
      "tool": "roles:firing_on",
      "arguments": {
        "event": "onProvisioned"
      },
      "expectedNegative": false,
      "startedAt": "2026-10-29T01:46:33.249651+00:00",
      "finishedAt": "2026-10-29T01:46:35.346064+00:00",
      "durationMs": 2096,
      "exitCode": 0,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 676,
        "sha256": "19823a7551d149afedaca52f6dce6c4481b71272d9d5f1c2377866ba95ead840",
        "payload": "eNpdUsGO00AMvfMV1pxASrtcuJQbXZBWCHalsie0h2niJNZOPSN7plGoKvERfCFfgictaMUlycyL33t+9snhETm7jYv8IPFISpGxc40bvTCq7kIZDE0+obRFkyESA6rbfD856gwi7sWvBI+EE4rh04j8qNiXYOg2spaQoV7C7uHjFnzXUTYVhQMNYwbf99hmyCNChynE+WCGIFHCQIzw++cvuP0A2o548BClVolfCBpgnAD5CEcvdtoXCh0Qp5L1JpZc3w0k64AY2sg9DeVS2lylIHsZsP5lxJ7nPBIPZsVnoEMKhLr4uhBrK5SyaWJn1xHa0fOAa7iN8PX+WxVYOu2NKhXBVZLYFeusR5/trPD68e5atJhVqgFDiAO1jZWnuYFeImfkbhU5zKDZZ3yzhi9RM4g59paajrGYm5eSZlvfw1Ky5Fw912j2JQTrDtqAXgysPdmzDkyzmDezBVOU57WN7RKY25zcM3Ed7F/fhl0/P1+AhcCdG+fD5Gf9RIL3bAvx3w49NW5fOot3awO1hXn39h/Rjn6gEenBh2D0Gou0+EK6Bp6J3fn8dH71B/gh83Q="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5654,
        "sha256": "81544acb12543fdd8d2ed1723eae6485b88888be8308e5a8cc6d4226fa5a1f27",
        "payload": "eNrtV0tv3DYQvudXLHRqgB0vKVLU45b6FCApitrIIUFRkNTQq0YrsSSVNgj83zOSvXazNYIeGjdrLPaw5HCen2aGQ689BjtFv2rRdQNejmO/On/1cvWDT7R83qx6PQ12i+HZZjvucLPTIW5hdK6zuPE30l538OcY3kev74nRb7T3cTPSTqcxbKINnU9xsyg+2/0eny2rZmXHYUCbunFYpUAaVp+ySBZ3+g2GSNSsyRZOuGeEhRE+8GydLcuXLXHVhstamgrKvKxAFkaCqRSHUonKSmlLVpQksPfo/EbdBf4x4WAxa/g620d7MU5hJmW272AKPbheX2V/O1+C+VmnLfH858iQIbKLQ1rCihNIXUlbCw1YCEaRMQuGcYTKoClNa1XJ3AwFyf+kd7PfYewxNq4L3XD1G2FIGvXQdq1O+Ms4JYxZ8+4TcdHyvNeRtlk/Wt1D2wUChfi3Y0xE5Xl5xug3Q+3HQCTBS7bOdEq48+my2yEpeU0KeMEYu/51nQVM4eOPU3uFN/Sc6CThQ0cYfTzf+/Fa//XiRsnCROg73fdG2/dfYbk1i+1dFGQQPxBW5Ose0X2mQEw6zLHQ/xU+wDDHtNURL2Y+bF/MSnKWK+AM8vqS8UaqRogzIeu32fX3mLBh3sR0eadTCWTcVQ60QwtSWQO1qR0YkQtes6KoapbdQ7ZNycOtkn/AdXsY/ThEhC3qlgKk8yVtsuab5M+TRHlJMnJ053sk5P5fhP9lziuVv51D6LWP2M7iQsr14jGJpokIVNjH8bmEYmWrKwVVYQV107wC3SoERFEUEmVec30qikdG+fiKQp4pzg6Koj4sifw4PpYrKutaw0ExzEFizUDnToFBLZlrLXJTnkriND4+9fHxW0RxdzATrr82oD7Q/R6YUb+DaWCZgL9ofGSIH0erk7k1TGoE4yQNa0IL0AoFFHXLS8ukFIU4tbpHvlCO8vbPD29/8eXtL1nxJEviOD/W4fuFl0f6fDFClVUuHChXcHptOrq/uSuAnp15bU1ZF0V+amCPjPIx1kRdFwc1ocQDNfEZdgEkyA=="
      },
      "decodedResponse": {
        "event": "onProvisioned",
        "harnessSlug": "papercusp",
        "roles": [
          {
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
          }
        ]
      }
    },
    {
      "case": "known-explicit-home",
      "tool": "roles:firing_on",
      "arguments": {
        "event": "onProvisioned",
        "harnessSlug": "papercusp"
      },
      "expectedNegative": false,
      "startedAt": "2026-10-29T01:46:35.347992+00:00",
      "finishedAt": "2026-10-29T01:46:36.424381+00:00",
      "durationMs": 1076,
      "exitCode": 0,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 676,
        "sha256": "19823a7551d149afedaca52f6dce6c4481b71272d9d5f1c2377866ba95ead840",
        "payload": "eNpdUsGO00AMvfMV1pxASrtcuJQbXZBWCHalsie0h2niJNZOPSN7plGoKvERfCFfgictaMUlycyL33t+9snhETm7jYv8IPFISpGxc40bvTCq7kIZDE0+obRFkyESA6rbfD856gwi7sWvBI+EE4rh04j8qNiXYOg2spaQoV7C7uHjFnzXUTYVhQMNYwbf99hmyCNChynE+WCGIFHCQIzw++cvuP0A2o548BClVolfCBpgnAD5CEcvdtoXCh0Qp5L1JpZc3w0k64AY2sg9DeVS2lylIHsZsP5lxJ7nPBIPZsVnoEMKhLr4uhBrK5SyaWJn1xHa0fOAa7iN8PX+WxVYOu2NKhXBVZLYFeusR5/trPD68e5atJhVqgFDiAO1jZWnuYFeImfkbhU5zKDZZ3yzhi9RM4g59paajrGYm5eSZlvfw1Ky5Fw912j2JQTrDtqAXgysPdmzDkyzmDezBVOU57WN7RKY25zcM3Ed7F/fhl0/P1+AhcCdG+fD5Gf9RIL3bAvx3w49NW5fOot3awO1hXn39h/Rjn6gEenBh2D0Gou0+EK6Bp6J3fn8dH71B/gh83Q="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5650,
        "sha256": "a90fd0a81a1327de3d40e7c928b841ca3d2154dbdb5c4c962d841cf91f6ccc35",
        "payload": "eNrtV0tv3DYQvudXLHRKgB0vSZF63VKfAiRFURs9pCgCPkZeNVqJJam0QeD/npHsjZuNEeTQuFljsYclh/P8OMMZee0x2Cn6lcO2G/ByHPvV+csXq6c+0fJZs+r1NNgthieb7bjDzU6HuIWxbTuLG38j7XUHf4/hbfT6jhj9RnsfNyPtdBrDJtrQ+RQ3i+Kz3Z/xybJqVnYcBrSpG4dVCqRh9SGLZHGnf8MQiZo12cIJd4ywMMI7nq2zZfnCEZdULVomGTAnBEhUDIyoS9CldspUgktdkcDeo/MbdRf414SDxazh62wf7cU4hZmU2b6DKfTQ9voq+9f5EswvOm2J5z9HhgyRXRzSElacgByXts41oMoZSMUsGMYRKoOmNM4WJWtnKEj+Z72b/Q5jj7Fpu9ANV28IQ9KoB9c5nfDXcUoYs+b3D8RFy/NeR9pm/Wh1D64LBArxb8eYiMpFecboN0Ptx0CknJdsnemUcOfTZbdDUvKKFHDFGLv+Y50FTOH9T5O7whu6IDpJ+NARRu/P93680v88v1GyMBH6re57o+3br7DcmkX3KQoyiO8IK/J1j+g+UyAmHeZY6P8K72GYY9rqiBczH7rnsxLBRAGcgagvGW9k0eTqTBb8dXb9IyZsmDcxXd7pNCTkWgPGiBIkJ6tVrS1w1RbMOCWlwOwOsm1KHm6VfAHX7WH04xARtqgdBUjnS9pkzXfJn0eJ8pJk5OjO95jwf0b4G3O+zPPXcwi99hHdLC7K9eIwSaZp3pOyo7gt5JbnTkrgTnOQdZWD4ShJO91jK3iBRp1q4oFRPr6aKM5YVRzURH1YEuI4LqtUrSXRCpSdH7DcVGBySWNFRUod2bGCn0riND0+9unxe0Tx6WAmXH9tPr3n9btnRP0BhoFlAP7s4Svy4jheOsNMbbhx1Iwo8aXkGqq8oN6kOa+Uq0rTnpr/Q/eTo2z+9WHzV583f8nUoyyJ47ys+uCyqiP9eNFVqaocDVhjaKyWRkElCgmu5poMtM6406T20CgfY0mIWh728HtK4iNuaS6g"
      },
      "decodedResponse": {
        "event": "onProvisioned",
        "harnessSlug": "papercusp",
        "roles": [
          {
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
          }
        ]
      }
    },
    {
      "case": "unknown-event",
      "tool": "roles:firing_on",
      "arguments": {
        "event": "idop-unregistered-hook-fire45"
      },
      "expectedNegative": false,
      "startedAt": "2026-10-29T01:46:36.426368+00:00",
      "finishedAt": "2026-10-29T01:46:41.232688+00:00",
      "durationMs": 4806,
      "exitCode": 0,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 79,
        "sha256": "43af3dd33a601d82a040a475b0e33cb0656258aeb7454b85e21a3776de6dc8bd",
        "payload": "eNoNyjEOgCAMBdDdY3SWTReu4WgciHyBSChpwcV4d5nfewkPSiNLyXM1vQhC0gaBN5H5NlcSLCvNFJ0UqG65h7Grq5Czax0inKFk9+Obfm5AG8I="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5655,
        "sha256": "d154c27b773440b15d741ee343ffc6190733a52e66ea1e0327783c4ecb43c0b6",
        "payload": "eNrtV8Fu3DYQvecrFjq1gMdLUpRI6Zb6FKApitroIUURUOTQq0YrsSQ3bRD43zuSvXZiG0EPjZs1FntYcjjzOPM4Q46CCRjtLoWVQ9+PeDFNw+rsx1er70Km4fftajC70W4wvlhvpi2utyamDUze9xbX4do6mB7+muK7FMydMIW1CSGtJ5qZPMV1srEPOa0X4NPtH+nFMmpXdhpHtLmfxlWOhLD6WCTacWt+xZhIWrTFogl3irAowntenBTL8JUjLdlo63VdgkXdgHSqBCOwBKlL6XQnVek0Gew9OruGO8c/dzhaLFp+UuyjPZ92cRYVduhhFwfwg7ksPllfgvnZ5A3p/OfM0Ea0L455CSvtQBotbVMawKpkICtmoWMcQXfYqc7ZWjE/U0H2P5nt7HecBkyt72M/Xr4lDgnRjK53JuMv0y5jKtrfPpIWDc8Gk2haDJM1A7g+Eimkv5lSJikX6pTRb6Y6TJFEJVfspDA54zbki36LBPKaAHjFGLv6/aSImOOHH3buEq/lguRkEWJPHH042/vx2vz98hpkUSL2vRmGzth3X1C52RbdbRS0Ib4nrsjXPaP7TIGUTZxjof9LfERhjmljEp7PeuheziCCiRo4A9FcMN7Kui3r04rVb4qrbzFh4zxJ+eIWkyljGxQddLUSILn1oCuJ4FxpJO8ao7gr7ijb5BzgBuQBXTeLKUxjQtigcRQgrS9pU7RfJX+eJctLkpGj2zAgMff/Mvwvc14z+WYOYTAhoZvNSwKdHSbLvKM51fVhnJarOs+0VcBLRqdlBYdOswpk1wjPuDClU8eaeGKWD64mJDuV4kFN6Ps1IQ7jtOra10rXEiqhOpBNo6FRtgPvK2Eq0Rnf4LEmju3jc28fv0YUtwuz4OpLDeoj198jPeo30A0sHfDnN19TNQfSrHlhGsbpqvMELK2W0EjmwMlKlLVVneLyeNU98YNykM9//eD5F58//5JVz7ImDvO07l9ZdX2gHzCanmmppICy4oRUeQ8GtQbuGWs6KxXT5niDPTHLh1gTqrpfE5V+pCb+AXPVKrg="
      },
      "decodedResponse": {
        "event": "idop-unregistered-hook-fire45",
        "harnessSlug": "papercusp",
        "roles": []
      }
    },
    {
      "case": "empty-harness",
      "tool": "roles:firing_on",
      "arguments": {
        "event": "onProvisioned",
        "harnessSlug": ""
      },
      "expectedNegative": false,
      "startedAt": "2026-10-29T01:46:41.233520+00:00",
      "finishedAt": "2026-10-29T01:46:47.210051+00:00",
      "durationMs": 5977,
      "exitCode": 0,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 676,
        "sha256": "19823a7551d149afedaca52f6dce6c4481b71272d9d5f1c2377866ba95ead840",
        "payload": "eNpdUsGO00AMvfMV1pxASrtcuJQbXZBWCHalsie0h2niJNZOPSN7plGoKvERfCFfgictaMUlycyL33t+9snhETm7jYv8IPFISpGxc40bvTCq7kIZDE0+obRFkyESA6rbfD856gwi7sWvBI+EE4rh04j8qNiXYOg2spaQoV7C7uHjFnzXUTYVhQMNYwbf99hmyCNChynE+WCGIFHCQIzw++cvuP0A2o548BClVolfCBpgnAD5CEcvdtoXCh0Qp5L1JpZc3w0k64AY2sg9DeVS2lylIHsZsP5lxJ7nPBIPZsVnoEMKhLr4uhBrK5SyaWJn1xHa0fOAa7iN8PX+WxVYOu2NKhXBVZLYFeusR5/trPD68e5atJhVqgFDiAO1jZWnuYFeImfkbhU5zKDZZ3yzhi9RM4g59paajrGYm5eSZlvfw1Ky5Fw912j2JQTrDtqAXgysPdmzDkyzmDezBVOU57WN7RKY25zcM3Ed7F/fhl0/P1+AhcCdG+fD5Gf9RIL3bAvx3w49NW5fOot3awO1hXn39h/Rjn6gEenBh2D0Gou0+EK6Bp6J3fn8dH71B/gh83Q="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5656,
        "sha256": "a2a65e90003ced996670751b13e75a57cb3309c7628c0761eaf168c0abcde7e6",
        "payload": "eNrtV01v3DYQvedXLHRqgJ1dkqIkSrfEpwBJUdRGDymKgh8jrxKtxJJU2iDwf+9I9tqNYwQ9NG7WWOxhyeHM48zjDDny2mOwU/Qrh2034MU49quz169WP/hEw+fNqtfTYHcYnm134x63ex3iDsa27Sxu/bW11x38OYb30es7YfRb7X3cjjTTaQzbaEPnU9wuwJv9u/hsGTUrOw4D2tSNwyoFQlh9yiLtuNe/YIgkzZps0YQ7RVgU4QPP1tkyfOVIS9uK5TW3IFTLQFZKgFGoQeRW2rIQphYVGRw8OruGO8c/JhwsZg1fZ4doz8cpzKLM9h1MoYe215fZP9aXYH7SaUc6/zkztBHti0NawooTSK2krXMNWOQUWcEsGMYRlEFTGWfLirUzFWT/o97Pfoexx9i0XeiGy9+JQ0LUg+ucTvjzOCWMWfPrJ9Ki4VmvI02zfrS6B9cFIoX0d2NMJOWi2jD6zVT7MZAo5xVbZzol3Pt00e2RQN4QAC8YY1e/rbOAKXx8OblLvJYLkpOFDx1x9PHs4Mcb/deLa5BFidhvdd8bbd9/ReVmW3S3UdCG+IG4Il8PjB4yBWLSYY6F/i/xAYU5pp2OeD7roXsxgwgmSuAMRH3BeCPLRvJNLtnb7Op7TNgwT2K6uMV00tXOoSH/TQHS6QKMtAIsRyUqI3NjiuyOsl1KHm5AvqDrZjH6cYgIO9SOAqT1JW2y5pvkz5NkeUkycnTveyTm/l+G/2XOl6J6O4fQax/RzeaiWC8Ok2Wa5jmBHcVpKacta2sOvDAlXaZFAUqUEuqyLfNKudpYe6qJR2b5+Gqi2Cgl7tUEV/drQhzHaWEtnTHMgRAFgqyVA8VrBTUXRhusUBlzqolT+/jU28dvEcXtwiy4+lqD+sD190CP+h10A0sH/NnNJ4syP46rTnBW5M7l4BivKf2tAtM6DoqpMrdYuxzF6ap75AflGJ//mvH7RSA/f/4lK55kTRznaRX3Tquuj/QDht4u7trSgraSMJVz9IBrC0pXvC3yqpIVO91gj8zy8dVEuanK8ouPev5AUfwNqOgtgw=="
      },
      "decodedResponse": {
        "event": "onProvisioned",
        "harnessSlug": "papercusp",
        "roles": [
          {
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
          }
        ]
      }
    },
    {
      "case": "missing-event",
      "tool": "roles:firing_on",
      "arguments": {},
      "expectedNegative": true,
      "startedAt": "2026-10-29T01:46:47.211266+00:00",
      "finishedAt": "2026-10-29T01:46:50.245854+00:00",
      "durationMs": 3035,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5854,
        "sha256": "06cbf9ab49bccc94513c4f1ff79c57924582273a2b7963955d01e28e26036409",
        "payload": "eNrtWMFu3DYQvfsrCJ0SYOklJUqUdEt9MpAURW30kKJIKHK4q0YrsSTlxggM9CMK9NKvy5d0pPXa7dYIcmjcrLHYw3KGM4+cxxlxJKcceD0GRwzYtofLYejI2ctz8sxFHD6vSafGXq/BnyzXwwaWG+XDmg7WthqWbuvtVEt/Hfy74NS9Mrilci4sB5RUHPwyaN+6GJYz8Onm53Ayj2qih74HHduhJ9EjAvmQBFxxo34AH1Cb1MlsSe8N6WxIr3iySObhuUGrXAteVjmjTKYNFYYXtMkrRm2TgmSZzAueocNuR2dbuAv4ZYReQ1LzRbKL9mIY/aRKdNfS0XfUdmqV/G1+DuY7Fddo858zgwvhutDHOawwUqFKoatMUcgzRkXONG0YB1o20MjG6EIyO1GB/t+qzbRvP3QQatv6tl+9QQ4RUfWmNSrC98MYIST1jx/QCodnnQooJt2gVUdN65EUtF8PIaKWp/KU4W+i2g0eVRmXbJGoGGHj4mW7AQR5hQA8Z4zd/LRIPER//c1oVrDVp6hHD+db5Oj6bLePV+r9iy3IbITsW9V1jdLvPmFyuyyYuyhwQbhCrnCvO0Z3mUJDVH6KBf9X8IDBFNNaBbiY7MC8mEBSlhaUM5pWl4zXoqiFPM1S9jq5+RoT1k9CiJd3mCLLmjQzglZQcSqsZLThGVArGyFZBZnMWHJP2TpGR29B/kXX7WRwQx+ArkEZDBDn57RJ6i+SP0+S5TnJcKMb1wEy9/8y/Jk5X1Ti9RRCp1wAM7mn+WLeMHrGcZIR7CBOq+S2kqAZLblKqdApp6WVKW1kVmWskVzq9FgTj8zy4dVEdYqU7dUEZ/s1kR7GaTVCMavA0ILhkYmmKGlVSkFVYQGwzaiqUh1r4tg+PvX28UtEcTcxKW4+1aA+8Ph7oEf9CrqBuQPe6wZKeRiPOlkVpgHDaKGkxItJTOmPYs7ziheYXtweW+LHvlAO8fqvWLFXBOKft79g+ZMsicM8rGrvsMoDfX3JKpXlKZZSIfGNU5TGUNVgtFmqWG4Lmxpjj8+vR2b54EoiR0ApP6MkPv75B5lOgWAjNvoeDFE9Ae8HX5+0/ZXqWvOm7d0Ya7ITlV+FmszU1OR8qyS3NvDeYWyIEuLUTS4QVkN7hYqx3350NuTjb7+TuAZiW+jMs/AcBRWJVW0HZoFAxI4d5s/beYW3RGkN2Fxh+sRrN3G+hcbQNm3/EvrV1Ffzm5O/AG7ybCk="
      },
      "decodedResponse": null
    },
    {
      "case": "empty-event",
      "tool": "roles:firing_on",
      "arguments": {
        "event": ""
      },
      "expectedNegative": true,
      "startedAt": "2026-10-29T01:46:50.437172+00:00",
      "finishedAt": "2026-10-29T01:46:54.313660+00:00",
      "durationMs": 3876,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 6365,
        "sha256": "92bdd4537be3366eb6664477b2c838c2aeb37b18fc4fa2adfbd23f6d46424d28",
        "payload": "eNrtWNuKHDcQfd+vEP1iG0Yzfb8FB5wNgYX4gnfIg0Mwaqk0I7un1ZHUe8Es5CMCecnX+UtS0uyM7fVi8hA7HrPMw0il0qmqoyp1dY9sBMMnOxIBUg2w1Lonxz+fkPujw+GDlvRsGvgazNFirTew2DBj11RLqTgsxu3ukSl6rs1rO7J3Qjsu2DjahcYZc9osLDdqdHYRgOebV/YojFrC9TAAd0oPxBlEIG8iixY37BcwFqVRGwVN+k6RBkV6lkSzKAxPBGpVddk0TVdTlucNzWXX0RqSlFa86aq4qaHMatyw8+h4C3cKv08wcIjaZBbtoj3Vk/GiiPeKTqansmer6L31EMwz5tao858zg4bQLgwuhGUnmrM6503GKBRZTPMi5rSLE6B1B13VCV5WsfRU4P4nbOP9NroH20pl1LB6iRwiIhuEEszBcz05sFH76xvUwuFxzyxOo15z1lOhDJKC+mttHUqTtJrH+PNUj9qgKEuqeBYx52AzuqXaAII8RoCkiOP46rdZZMCZyx8msYKtPEU57hiNQo4uj3d+PGYXj7YgQQnZl6zvO8Zff0Ll2iyIfRRoEM6QK/R1x+guU6h1zPhY8H8Ftyj4mNbMwqnXA/HIg6RxWtIkpmmzjJM2L9sinhdp8yK6+hoT1viJdcs9ZlynVQZc0jJjGc0rUVJWloIWMaukTIsuq3yq7ChbOzfSa5CP6LpetKMeLNA1MIEB4npIm6j9LPnzTbIckgwd3Yw9IHP/L8P/Mucxwhc+hJ6NFoTfnjaz4DDudJOfI9hBnFZVd3khm5zyJO5onjQJXp9dRsuGlwACMg53NfGlWT68msjmWVXcqImkuFkT6WGcVtGxrBP+8irDaVVAu7QrKbYVTFQFk1lc39XEXfv4rbePnyOK/YIXXH2qQb3l+rulR/0KuoHQAX/YDdRlcSBXHavKVHac5kIUWAy5oE1eJJRnkgFPyqaM87ur7gs/UA7y8d+kN4qg/PDpn8ffZkkc5mGVN3u15EDfXxomY0irgqadSGkOeU1R1NBUyLqrZcNSye4usC/M8iHWRNPEH72/FLcUxdu//yL+HAj2YpMZQBA2EDBGm/ZIDWesV+KlGsbJtWQ3ZWZlWxLIaQl+RiZ2g+0YSi5GjAwRrPPNJMKSNTsD8v3DhPA1Q/Yd0kOWa2WJBXMGhuDITMPgtbtJ9YJ0WSwKWePdNCN2GyLJs40aCFvpOTmRxPntx0+fnC6fPzp5siTnDDEwzAvvukQLqMHcFm6GY9hbGI3mYK03ap3qewKD1IYHV1Ht6c8/Ej0AefvHn2HuWbmHqqHBx+C3QgNAsEEmQlm28pNz5dbk3Jt8NVmHrsgJCSeXesIINMEolbxE75kacNlj+NjfixjQiQDM3NYV9A9jYv47PfI5Jz9pE/bxyRjkfOeRd2VGQgu93YTZ1X9g6Nn+k79PWA++qxKC7oY8C9EyIbbOtOTeteY9f3p7VKQBD33aoHVL7uP2YMoTZFvMCv0ay5sM+D4x83p29jHa1QPMKxG8enz8zB/FxSUJ1YHnEbw18N2Wy3AtzMiIRUOof6V66JO2XSz2lbL1HNOtV1y5/nJ+9A9sQiqT"
      },
      "decodedResponse": null
    },
    {
      "case": "numeric-event",
      "tool": "roles:firing_on",
      "arguments": {
        "event": 7
      },
      "expectedNegative": true,
      "startedAt": "2026-10-29T01:46:54.315556+00:00",
      "finishedAt": "2026-10-29T01:46:58.736381+00:00",
      "durationMs": 4421,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 6152,
        "sha256": "8a13199aaf14f913d1284ead47fdf9a6a068302503de4db327e732684d9b9b84",
        "payload": "eNrtWM1uGzcQvvspiD3ZgCjt/x+CAK5ioAGUJrCNHlIU0Sx3VmJD7W5JrhLBMNCHKNBLny5P0tmVZTeqEfTQuJFh+GByOPw4880Md6gWWtSiMy0rsZI1XjaNYtPZS3bcWhqe5ExBV4sl6qPJslnhZAXaLHlTVVLgpN3ubkHyD41+b1q4E5p2Am1rJg3NwDZ6YoSWrTWTAXi8+sUcDaOciaauUVjZ1MxqQmBXjqETV/AjakNSJ3cGTX6nyAdFvvackTMMX5ak5YVxGAVhxMGvEh5mScaLOHa5W1YhlpBVcRHShp1F0y3cBf7aYS3Qyb2Rs/P2oul0L3KEkrzTilcKFs7f1gdn3oBdks5/zgwdROdibQe3TMdDSEORBcAxClweRq7gheshTwsskqIUceJWPRW0/wdY9XbrRqHJK6llvXhHHBIi1KUsweJ501k0Tv7TFWnRcKrA0NRRjQDFS6mJFNJfNsb2pPrJ2KW/nuq20SQKvMQdOWAtrlp7KVdIIK8IwItc173+eeRotHrzXVcucCv3SU47Wi2Jo810Z8cr+Hi6BRmUiP0KlCpAvP+Cys2xWN56QQfimrgiW3eM7jKFGwu694X+L/Aehd6nJRi86PWwPO1BfNePuedyP7t0vTyM8ygch4H31rn+FhNW9xNjL28xkwCT1KcEQUwpVdKqIPS45IUfEWaSkneuc0fZ0tqW34D8g66bRdM2tUG+RCjJQVof0sbJv0r+PEqWhyQjQ1etQmLu/2X4X+Z8GsRvexcUtAbLfnsQjAaDaaftaE51fRjRcj0v9gKKVlJAwUOMCF3EFc+qzE/9IALwxVNNPDDLh1cTyTiOk72aiMNkvyj8wwgXRKkbZL5PV1hI4SrjjGdBkHGkw0pE8MIEnoriqX987P3j1/DidqEXXH+pQ73n/runSf0G2oGhBf68HUjT+DCuOkzjICmykFceZjys/IrQaSQSEfiZG3he6D1ddQ/8QTm87386Drz9njj+/OsfutGjLImDDJbv7gUrO9D3S4Fx4QkBPExSQR/zOOH0OvPo3SkgcmMQblE83V8PzPIhlkSUZnslkd5TEp/+/IP1UWDUiHW6xpJBzVDrRudHsl6DkuU7WbedzdluCnphcjZQk7OXWyG70cGPLflGKMb23eSIYAXKNQnqblWgZtPX5+dn08uzF2x6OpuxT7/9zgzWJbNLSaB7nejxFduFgDnPtpDPHXZ9wo7J3E1LsPNhfc6O57v1+Qk5RHhIP3MLBZqUetWTMTtbo96w+bN++nzOoGjWyKRhwN7MTqdn37+evTg7H7G6sSRaUMKQRZaChIxQBsRKoirNYCx5VnUGFOV5p8j/ksyQ1YYVnWXUPvcglVSKVY1mm6YbPNXYqr4SEMSSfZB2SedoJAzisENWICnjwAc5Mh623J56bMivJRAqSIXliBhnVaeo0HYUgBBIXSjVWe9g/xgYCKEcWMl6hvWif4B410d/Abcu3Sg="
      },
      "decodedResponse": null
    },
    {
      "case": "unknown-key",
      "tool": "roles:firing_on",
      "arguments": {
        "event": "onProvisioned",
        "harness": "papercusp"
      },
      "expectedNegative": true,
      "startedAt": "2026-10-29T01:46:58.739028+00:00",
      "finishedAt": "2026-10-29T01:47:03.472172+00:00",
      "durationMs": 4733,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 7080,
        "sha256": "712af8e7cf776eb3d4ad39642c85d5293102713dca7f174db8a62b530c0b488f",
        "payload": "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"
      },
      "decodedResponse": null
    },
    {
      "case": "all-sentinel",
      "tool": "roles:firing_on",
      "arguments": {
        "event": "onProvisioned",
        "harnessSlug": "all"
      },
      "expectedNegative": true,
      "startedAt": "2026-10-29T01:47:03.473799+00:00",
      "finishedAt": "2026-10-29T01:47:05.809844+00:00",
      "durationMs": 2336,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5875,
        "sha256": "e982870880c7665d45e5eee6c47b1dec6e30d1cc47fbc82362700bdb57b0301a",
        "payload": "eNrtWM1u4zYQvucpCF3aAqZNUdSPdUtzWqBbFE3QwxbFYkSOLHUlUSWpbINFnqOXPl2fpCPFTpo0WOyhm62DwAeT88eZjzPDsUcY0enJj8xg3Q54YW3Hzr57xb4eAy2/KVkH06AbdCebxva46cH5htu6bjVuxhvtEVr+3rp3foQ7oh83MI5+Y2kHwbqN164dg98shtf9r/5kWZVM22FAHVo7sODIAvsQeTqxh5/QeaJGZbRI8jtBvgjyyzhaRcvylSGpyhRZnuiEQyENV0kFHHQueI2pLGJjwKAmhYNHZzfmzvG3CQeNURmvokO053ZyMynSXcsn1/G6g130D/4SzA8QGpL5z5Ghg+hcHMISlp+4gkLpbQIc00RwlQrNKxEjLyqs8sroLBf1DAXpfw/97LezHfqybl077N4ShmQRBtMaCPijnQL6qPz5A0nR8qwDT9uosxo6blpHoJB8Y30gaizztaDPDPVoHZGSOBerCELAfgwXbY9k5DUZiFMhxPUvq8hhcFffTmaHN3RJdNIYXUsYXZ0d/HgNv5/eGFmECP0auq4C/e4jIvtj0dxGQQfiJWFFvh4QPWQK9wHcHAt97/ARgTmmBjyez3JoTmcjUsiMx4LL7YWIS5WXIllncfEmuv4/JqybNz5c3NpMMMsSIwqe51nOlUg036Yi41kq80JRrtQKojvImhBGvjfyL7j2TD/awSNvkPxxc3IuaROVnyV/niXKS5KRo/3YISH3ZRH+pJxXayHSN3MIHYwezayeF6vFYdIME+2pro/jtvICk0SA4TqTwFUhcl5tK8kzabJUp5CrNH+piSdG+fhqIl2rZPugJmLxsCbkkXQwmUopIOYyloorWZF1mdFwkSuF2zgrZIwvNfEyPj738fFzRHHLmAnXHxtQH2l/j8yoX7zz7Sfg+52vSJIjeZi2ShWSXiJIk5SruqCVQcPjSlVCYJHndfXS6p74QTnK5z8VD4pA3X/9lUifZUkc52UlDy4rO9KfL0We0ZMNBTeZLriKjeZFLQXXW0kTt4EtqO1L/3pilI+xJLLiU0rirz//YPMtMBrEJjegYTAwdM668qQBInj/trauao3BoWR70nk37VhEE1jEBpohPYMDh5GrvjXIQtN65olC9/qVZ017iSy6nWqjNTtl2lnv+cIhXDrWw0HvPVxR/kydYYMN9K90QMcqkuqAwDAr4vU93Qx5a4cVs444loJk1dW9c9cnfwOY9Ia1"
      },
      "decodedResponse": null
    },
    {
      "case": "star-sentinel",
      "tool": "roles:firing_on",
      "arguments": {
        "event": "onProvisioned",
        "harnessSlug": "*"
      },
      "expectedNegative": true,
      "startedAt": "2026-10-29T01:47:05.810753+00:00",
      "finishedAt": "2026-10-29T01:47:06.848216+00:00",
      "durationMs": 1037,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5871,
        "sha256": "9a69cc7f238d002f5581610bcc095ece46cf6890c8c7f6faca14c9d32c2ce240",
        "payload": "eNrtWM1u3DYQvvspCF36g+UuJVESpZvrU4CmKGqjhxRFwJ+hpUYSVZJyagR+jlz6dH2SjmSvU7tGkEPjdA1jD0vOH2c+zoxGmuQEXs9hIgZsN8KZcz05+f4F+XqKuPymIb2cR92CP9q1boDdIH1oqbO207CbrrUn2dG3zr8Jk/xADNNOTlPYOdzJ6PwuaN9NMexWw9vht3C0rhqi3TiCjp0bSfRogbxLAp44yJ/BB6QmTbJK0g+CdBWkF2mySdblC4NSkglr09xQrVlBOTBFRSkKWmWFMlmpaqsKVNh7dHJt7hR+n2HUkDTpJtlHe+pmv5AS3Xd09j21vTxP/sFfg/lRxhZl/nNk8CA8F8a4hhVmyqXgus4lhSJnlBdMU8VSoEKBqpTRZcXsAgXq/yCHxW/vegiN7Xw3nr9GDNGiHE1nZISf3BwhJM0v71AKlye9DLhNeqdlT03nERSUb12ISE2zasvwt0A9OY+kPK3YJpExwjDFs24ANPISDaQFY+zq103iIfrL72ZzDtf0DOmoMfkOMbo82fvxUv5xfG1kFUL0rex7JfWbj4jcHAvmNgo8EC4QK/R1j+g+U2iI0i+x4P85PCCwxNTKAKeLHJjjxUjGspKmjGb1GUsbXjWs2NYse5Vc/R8T1i+bEM9ubdZalUyKjII0lvKaA1VQScqVttowpQwsTuwha2Oc6I2Rf8F1wwyTGwPQFi1igMhf0yZpPkv+PEmU1yRDR4epB0TuyyL8STlfbrM0fbWE0MspgFnU83yzOoyaccY91vVh3FZmuNA6lbSAsqLcckGF5hk1eV4JYesiy/LnmnhklA+xJopK3KuJ+n5JZIdxWanVojSVoqpWOTawosBVbaiUrDQ8Y5BL9lwSz9PjU58eP0cUt4yFcPWx+fSB7vfAiPrFG9/NAHyn8ZWiOoxOl0uhMl7UVOSFodxYQ+uyBFoabYQuMi4K9dzpHvl5cpAPf1HfqwF+9+HPWfEkS+IgL6u+//ZSHejLi5WW2zznlGdG4AumLanMy5SWItW5LkrOmXjuX4+M8iGWRFXkn1ASf/35niy3QHAOm/0IhsiRgPfON0etREIIr63zqjMGxobckE77+Zwk3yZkxAEyELmnE3Q0dAZIbLtAAlLwVr8KpO0ugCS3I22yJcdEexcCXTmISk8Gudd7Ky8xe+bekNFF/CIdwROFUr1EKMwGecOA94K+unFDnEeOwxCJurxz7vbob1Wlg3Y="
      },
      "decodedResponse": null
    },
    {
      "case": "unregistered-harness",
      "tool": "roles:firing_on",
      "arguments": {
        "event": "onProvisioned",
        "harnessSlug": "idop-unregistered-harness-fire45"
      },
      "expectedNegative": true,
      "startedAt": "2026-10-29T01:47:06.849203+00:00",
      "finishedAt": "2026-10-29T01:47:07.839804+00:00",
      "durationMs": 991,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5902,
        "sha256": "08aafec2d3797f5f8535b6fe91996a438052624874f5b7e7e9e61fd5454dc347",
        "payload": "eNrtWM1u3DYQvvspCF3aAstdUqJ+b45PAZqiqI0eUhTBSBytlEiiSlJOjcDPkUueLk/SkbzrxK4R5NA4XWOxhyXnf77hkLM7woi2mtzINNbtgBfGdOzs5+fsx9HT8qeCdTANVYP2ZNOYHjc9WNdwU9dthZvxRnuElr819o0b4RPRjRsYR7cxtANv7MZVth292yyG1/1rd7KsClaZYcDKt2Zg3pIF9i5w5LGH39E6ogZFsEjyT4J8EeSXMlgFy/K5JqlEplhrFfE6wYgrmUieoSq5AqXzSOukTJEU9hGd3Zg7x78mHCoMCrkK9tmem8nOpKDqWj7ZjtcdbIPP+Esyv4JvSOY/R4YckV8c/JKWmyiDTFV5BBzjSHAVi4qXQiLPSizTUldJKuoZCtL/Bfo5bms6dEXd2nbYviIMySIMutXg8TczeXRB8cc7kqLlWQeOtkFnKui4bi2BQvKNcZ6oMkzXgj4z1KOxRIpkKlYBeI/96C/aHsnICzIgYyHE9Z+rwKK3V88mvcUbekh00hhtSxhdne3jeAF/n94YWYQI/Rq6roTqzRdEdm5R32ZBDvGSsKJY94juTwp3HuycC31v8QGBOacGHJ7PcqhPZyOhCBMuBQ/zCyELlRYiWecqfRlc/x8PrJ03zl98ZhOqMMwiHmZVzpXIJc9BApe6knmidRlGcxB7yBrvR74z8i+4dkw3msEhbxA0JUj85dgExTc5P08S5eWQUaD92KHH74zwV535dB0q+XJOoYPRoZ7VI0JiDpg0/UR76uvDqBboKoNY5lyWQNUKseYZiITrNA/zKENIy/TYE4+M8iH2BL2+93oiu98S4WEUS+SooiSuOEY1coVZyqGsJa9rSMIkhBwicWyJ4/T41KfHb5HFLWMmXH9pPn3g9ntgRP3uF99uAL5z8cW5OpCbLs4wL2PNZRRLrpI05GUKIYccdaLLKIdQH2+6R35PDvLxV/cff3X38VcifpItcZjFiu4VKznQHy+1qHUqk4wrVdJYHemY01QNPEtRxArLSkTJ8f56ZJQPsSVSKb6iJT5+eM/mKjCawyY7oGYwMLTW2OKkASI496o2tmy1xqFgO9J5N21Z0Goz8mmwuG2dR4ua79icRklUccAGmi8dg70aozxcq5H5pnXMEYWK/oNjTXuJLLideIM1O2WVNWRo4RBoHethr/cWruhwTZ1mg/H0hzW5ZiVJdUBI6RXx+p7KRqmYYcWMJY4hBFh5dcfv+uQf9CiOOA=="
      },
      "decodedResponse": null
    },
    {
      "case": "numeric-harness",
      "tool": "roles:firing_on",
      "arguments": {
        "event": "onProvisioned",
        "harnessSlug": 7
      },
      "expectedNegative": true,
      "startedAt": "2026-10-29T01:47:07.861366+00:00",
      "finishedAt": "2026-10-29T01:47:12.961733+00:00",
      "durationMs": 5100,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eNoDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 6190,
        "sha256": "6a1cb11998e930b67e1acea4b6f8b8c345dfcc31fd65132c39005debee551c50",
        "payload": "eNrtWFFv2zYQfs+vIPSUAKZNUrIkC0WBzA2wAGkbJMEeOgw1RZ4srbKkkZRbIwiwHzFgL/t1/SU7yXaSekGxhzWdgyAPEY/H7/h9vKNObmQDRrW2IRqyooKrui7J9OyUHDYOH48SUsq2UjmYg1FeL2C0kMbmtM6yQsGoWa9uZEE/1uaDbeSd0TYj2TR2VONIutqMrDJF4+yoBx4ufrUH/VNCVF1VoFxRV8QZRCDXnsWIC/kTGItWL/F6T3rnSHtHuuTewOsfTzV68UhyISTQjAeCBhOpqBRRSFUY8jgMWBSLDBdsdzRdw13Cby1UCryED7wt28u6NZ3JU2VBW1PSrJRz7958T+Zcuhx9/nNlMBDGhcr1tGxLAxkHauJLCmOf0WDMFE0ZBxqnkEapVmHEOmbd+jdy0e3b1CXYJCtMUc3fo4aIKCtdaOngom4dWC/5+Rq98HFaSotDr6yVLKkuDIqC/nltXSeqiIYM/zqpm9qgyecRG3jSOVg07qpYAIK8RgA+Zozd/DLwDDiz+qHVc1jbBdpxRWMK1Gg13e7jtfx0vAbpnVD9TJZlKtWHr7hswoK+ZYEBYYla4V63im4zhVonTccF/8/hAYeOUy4tXHZ+oI87EMFESDmjYnLFeBJECYuGk3H0zrv5Pyas6QbWXd1i6rFkoVaMTlIIaaCzlE4iIajva4aJEvBxFHp3kuXONXQD8g+5NpO2qSsLNAepkSDO92njJd8kf56kyn2S4UYXTQmo3PdV+F/lfDwUweRdR6GUjQW9KeTxoN8yrnUtWrCy9+O8JmoSx1nAaMx8TgM/C+nEF0DTCQbhXEYqSp+r4pFV3ruq4BzfBPFuVbDdmhD7cVosZmMRg6DjINM04CmnsdA+lTxWPBMhxD57ronnBvKpN5DfgsXtRGe4+VqL+sD190CX+t37gU0P/MXNFzAe7MdVN+YhzxSmfybiiAYq0lTGPKAhJkuQZjrWITxfdY/8QtnL13/EdopgpyMO2PhJlsR+Hpa/c1gi3NPvFzYGKeLYpxGPMvzeDLGq/EhQAKHxFg5TH+TzBfbIKu9fTYhhzMOdmnioJD7/9SfpToFgJ9aaCjSRFQFjapMcFNVSloV+X1RN6xKyHUoztwnJJXpbe1m284ScrqfIxhM+NcgQsazrmsoBgisolmio2kUKhkzfXlycTK9OXpHp8dkZ+fz7H8RCpYnLC4TeaUgPr8n2IIhXV+emXhZdAoH2BsS7t49u/sU65EuP3ByRQyS1ajDs7J7XjBzOtl6zIySPUQF/FFelNOjaLTgakpMlmBWZveiGL2dEpvUSSGGJJOdnx9OTH9+evTq5GJCqdmiaY3Lhvh0eKBBE6RGzAkpte0rIP2utLLEm2hJV0kimyFYkbR3BXrsDyYqyJFltyKpuez0MNGVXNSBVTj4WLsc4BhADlW6BpIDO0KuGRIb9ktuohxZ55RJRZVGCHuC5kKwtsSi/FEIqBdi4YmV2NLvvh14W7+bgb6zN534="
      },
      "decodedResponse": null
    }
  ],
  "limits": [
    "Current parent only; not original native/full-role/identity/legal-stack or exhaustive argument acceptance.",
    "Reader filters alwaysFireOn subscriptions; no hook is emitted by this handler.",
    "Deliberate distinct malformed/scope requests are expected negative controls, not retries.",
    "No product, role, grant, identity, mode or policy writes."
  ],
  "sourceAfter": [
    {
      "path": "packages/operator-core/lib/agent-tools/roles/firing_on.ts",
      "sha256": "8b04b4e51b39b797997a93d24179821813f4e37adc24334694b341af39df7ace"
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
  "finishedAt": "2026-10-29T01:47:12.963967+00:00",
  "interpretation": {
    "cases": [
      {
        "case": "known-default",
        "exitCode": 0,
        "roleIds": [
          "infra-reviewer"
        ],
        "harnessSlug": "papercusp"
      },
      {
        "case": "known-explicit-home",
        "exitCode": 0,
        "roleIds": [
          "infra-reviewer"
        ],
        "harnessSlug": "papercusp"
      },
      {
        "case": "unknown-event",
        "exitCode": 0,
        "roleIds": [],
        "harnessSlug": "papercusp"
      },
      {
        "case": "empty-harness",
        "exitCode": 0,
        "roleIds": [
          "infra-reviewer"
        ],
        "harnessSlug": "papercusp"
      },
      {
        "case": "missing-event",
        "exitCode": 1,
        "refusal": "invalid_input: invalid_args: event: Invalid input: expected string, received undefined — the field(s) that failed, in full: `event` accepts {\"type\":\"string\",\"minLength\":1}"
      },
      {
        "case": "empty-event",
        "exitCode": 1,
        "refusal": "invalid_input: invalid_args: event: Too small: expected string to have >=1 characters This server is running build b30d5f83fa, started 43min ago. If this CONSTRAINT was relaxed after that build, the running process is still enforcing the OLD one — the tool's source in the tree can disagree with what just refused you, so verify against the serving build before treating this as a defect. For the current source tree, retry this call against the Papercusp staging operator at :3170 — add build: 'staging' to this call's arguments (or call tools:invoke { name, args, build: 'staging' }) and the MCP proxy routes it there; with ptool, pass --url=http://127.0.0.1:3170 explicitly."
      },
      {
        "case": "numeric-event",
        "exitCode": 1,
        "refusal": "invalid_input: invalid_args: event: Invalid input: expected string, received number CORRECTED CALL — send this: roles:firing_on({ \"event\": \"<string>\" }) (retyped `event` (`<string>`) to the declared type). Every `<type>` above is a PLACEHOLDER, not a guess: those are the fields this refusal could identify but cannot fill for you — replace each with a real value before sending. — the field(s) that failed, in full: `event` accepts {\"type\":\"string\",\"minLength\":1}"
      },
      {
        "case": "unknown-key",
        "exitCode": 1,
        "refusal": "invalid_input: invalid_args: Unrecognized key: \"harness\" CORRECTED CALL — send this: roles:firing_on({ \"event\": \"onProvisioned\", \"harnessSlug\": \"papercusp\" }) (moved `harness` -> `harnessSlug`). This resolves the rejected keys against the args you actually sent; it does not guarantee the call validates, since a value-level error would not have been visible to this check. — this tool accepts ONLY: event, harnessSlug. (Dispatch-level args, handled by the transport before this tool's own schema and therefore not in the list above but also accepted: payloadTier, projection, view.) Did you mean `harnessSlug` for `harness`? An undeclared arg is REJECTED, not silently ignored (EI-10883): passing an arg a tool does not declare used to return ok:true while quietly doing something else, which is indistinguishable from success. Re-send using only the keys above (or the dispatch-level ones just listed). This server is running build b30d5f83fa, started 44min ago. If this argument was added after that build, the running process has never seen it — restart the app/process to pick up the new code. For the current source tree, retry this call against the Papercusp staging operator at :3170 — add build: 'staging' to this call's arguments (or call tools:invoke { name, args, build: 'staging' }) and the MCP proxy routes it there; with ptool, pass --url=http://127.0.0.1:3170 explicitly."
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
        "refusal": "harness_forbidden: harnessSlug \"idop-unregistered-harness-fire45\" names a harness outside this session's hive \"papercusp\". A cross-hive call made this way could not later be claimed, commented on, or closed by this session."
      },
      {
        "case": "numeric-harness",
        "exitCode": 1,
        "refusal": "invalid_input: invalid_args: harnessSlug: Invalid input: expected string, received number CORRECTED CALL — send this: roles:firing_on({ \"event\": \"onProvisioned\", \"harnessSlug\": \"<string>\" }) (retyped `harnessSlug` (`<string>`) to the declared type). Every `<type>` above is a PLACEHOLDER, not a guess: those are the fields this refusal could identify but cannot fill for you — replace each with a real value before sending. — the field(s) that failed, in full: `harnessSlug` accepts {\"type\":\"string\"}"
      }
    ],
    "argumentSuccesses": 4,
    "invalidInputRefusals": 5,
    "harnessForbiddenRefusals": 3,
    "defaultHomeEmptyHarnessStdoutIdentical": true,
    "unknownEventSucceedsWithEmptyRoles": true,
    "knownSubscriptionRoleIds": [
      "infra-reviewer"
    ],
    "streamPinsVerified": 26,
    "measuredStagingBuild": "b30d5f83fa",
    "sourceStable": true,
    "testSuiteClaim": false,
    "historicalBaselineClaim": false,
    "universalPermissionClaim": false,
    "sourceComparator": "Measured committed source bytes, not complete import closure."
  }
}

