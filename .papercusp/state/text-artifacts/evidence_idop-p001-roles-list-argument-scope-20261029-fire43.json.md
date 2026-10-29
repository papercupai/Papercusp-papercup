---
rel_path: "evidence/idop-p001-roles-list-argument-scope-20261029-fire43.json"
updated_at: 1793234309162
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
  "startedAt": "2026-10-29T00:34:50.119310+00:00",
  "caller": {
    "ownerId": "su-4a84c93a-e530-450c-b01e-8beb7bdc670f",
    "nativeSessionId": "01a18508-b16c-7d02-9928-528c05a2043c",
    "role": null,
    "workspace": "papercusp-workspace",
    "harness": "papercusp",
    "route": "http://127.0.0.1:3170",
    "authority": "Existing parent superuser credential via maintained ptool, unchanged; no fabricated role/capability envelope"
  },
  "schema": {
    "sourceArtifact": "evidence/idop-p001-supplemental-raw-schemas-20261028-fire42.json",
    "sourceArtifactSha256": "8c2dfb092eda7a0c3f6ea88799f7e2f2d77745efb1ef2e9aeb8b38557e3fbecd",
    "inputSchema": {
      "type": "object",
      "properties": {
        "harnessSlug": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "inputSchemaSha256": "15df0979eb0b4cb4747fc98e48771ff08051346845b092227928a488ee96e6f2",
    "annotations": {
      "readOnlyHint": true
    }
  },
  "sourceBefore": [
    {
      "path": "packages/operator-core/lib/agent-tools/roles/list.ts",
      "sha256": "e3d97089a6d5adb6b8f1eb6f9cb7c8fa8caf5da4e6b48324e7f8cd2efc5dacf9"
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
  "requests": [
    {
      "tool": "roles:list",
      "arguments": {},
      "startedAt": "2026-10-29T00:34:50.128847+00:00",
      "finishedAt": "2026-10-29T00:34:54.055848+00:00",
      "durationMs": 3927,
      "exitCode": 0,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 1228,
        "sha256": "30e11023e5bf44746f02564c6cd63dd45a8e3232654fe1348702d59ce1ca0159",
        "payload": "eJytk89u1EAMxu88hTUnkKZdLlyWG0srIf4UCCAkxGE6cRKrs+OR7dlVqCrxEDwhT4Imu61A4gCIUzJJ/Pnz51+u3RQko2qX6ujWroSCEqsW551wQnXrT9eOerd2lAcJJ4I7wj2K824/YX6vONTk1m7DWWsyaA+he322gdD3ZMRZYUvjZBCGAaOBTQg9lsTzFrNBoYKJMsL3r9/g6RPQOOE2AEurkrAIeMi4B8w72AVRD5eVUg+USzVdcbV29VBSHSlD5DzQWA+l/tgKLMiI7SsWCHm2ifIINgUD2pZEqIuvg7BGoWKQEXsFY4hTyCOewlOGVxfvWoNl0oEFShU8KcJ9jQYDBquCCvffPzsWLWaVWsCQeKToIXKZPQzC2TD3J5zTDGrB8MEpvGQ1ECwpZAWduKb+l5Y2kT6GpWTJuXlu0VzWlNAUYsIgaV5mmmFZmJrU2GzBnuXq1Hl3CMytr90V5bbYW9/O394+P7xYBNyNdyHtw6znJHiR3fqT4/xaeEdKnLF3n727rP2ItsFs6taPHt4JdfQF3drpNqTkvFOuEvGn1i1wo+xubvyRMsVYhWz+J9CMa5wgVJswG8UjAu3MQno8VkU5wANTyH1qJNz/2HWr7s0LWnXd2/NVCTaBSdihaEiww2gs+sCDYhS0VRTsW4eQ7iQ8bC7edg0vtgkForDqCQs1JrXKEGKjYaCEUEvi0B9gbOvrsWDuMce2MzvQtMzDGUqIV2Fc+AwGcUEiBpEZNh/O9C+g3JNNXBtDrHjn6BRe0BXCr/+2h+0fgPh3LN3u9Tc4/Rd+Pt/c+wEGx7nu"
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5646,
        "sha256": "ba221d18bc5277432fbe134022f04ba3036cc61abd3e35ec69b995f58eb4c6e1",
        "payload": "eJztV02P3DYMvedXDHRqgOGMJMsf8i3ZU4CkKLqLHFLkQEn0jhuP5Uhy2iDY/17Iu7PbZBdBCzSbTjA3maIo8pGPoiecKNg5TitHXT/ShffD6uzli9VPU/J+eNquBpxHu6PwZLvze9ruMcQd+K7rLW2n69MT9vCHD+/ihHfCOG1xmuLWTxQw+bCNNvRTitvF8Gb/e3yyrNqV9eNINvV+XKWAllafWLQ72uNrCrH3I2vZogl3irAowgfB1mxZvnCsZaVwsiysANnxCpTjHLSxFShZdM4aznWTDxw8Ors2d07vZxotsVas2SHacz+HLGJ26GEOA3QDXrK/7S/B/IJpx1r2nyPD1vleGtMSVpxBYaOsLhCoLDioklswXBA0hkxtnK1q3mUovB9+xn32O/iBYjv0MWVjOLreYaJf/Zwosva3Tyzk5dmAMbKWDd7iAK4PZLP+zsfEWiZkveEbvsmgTT4k1hai5muGKdF+Shf9nvycXkXWipJzfvV2zQKl8PH57C7pWi4553zNptDvMXw8O/jxCv98dm1kURJr1uEwGLTvvqJycy252yjerhl9oDH7egDzUCQQE4YcS0x4SQ8o5Jh2GOk865F7lo1ILisQHKS+4LwtVFvyTcGbN+zq/1irIX/EdHFrU2JnbKcc8MZ0oJw2oKXLpcK72gktqK7ZHWS7lCa4MXIPrpvNOPkxEuwIHYVcl0vZsPab1M8PifJSZGD9fhoo0XdG+B/WfFVVb3IIA06R3HK81uvF4/OEaY6slZwfR7rKUgrqVAVdXSlQVhvAChtwuiKsjbFCyBMpHhnl4yNFsSm0+JIU5ZeckMeRLSkKW3e6AeSFBNXwEprSaOg6rYQrbYFEJ06cRscfeHT8FlHcbmTB1deG0wc63wPz6XdvejfT72dNrxDH0uWEVbyoqAQtVQXKYAVauwYKKbjmtS0rwU9d7pHfkmN8+dU9Egjx+cuveHkc2fqXnDjKbIl7Py/Vkf67NFaWtWpqcI2uQblOgzGGAAujCmtdQXia0x4b5WPkRMPvcUI8wIm/AEFvJ8Y="
      },
      "decodedResponse": {
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
          },
          {
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
          }
        ]
      },
      "case": "default"
    },
    {
      "tool": "roles:list",
      "arguments": {
        "harnessSlug": "papercusp"
      },
      "startedAt": "2026-10-29T00:34:54.056854+00:00",
      "finishedAt": "2026-10-29T00:34:58.025470+00:00",
      "durationMs": 3969,
      "exitCode": 0,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 1228,
        "sha256": "30e11023e5bf44746f02564c6cd63dd45a8e3232654fe1348702d59ce1ca0159",
        "payload": "eJytk89u1EAMxu88hTUnkKZdLlyWG0srIf4UCCAkxGE6cRKrs+OR7dlVqCrxEDwhT4Imu61A4gCIUzJJ/Pnz51+u3RQko2qX6ujWroSCEqsW551wQnXrT9eOerd2lAcJJ4I7wj2K824/YX6vONTk1m7DWWsyaA+he322gdD3ZMRZYUvjZBCGAaOBTQg9lsTzFrNBoYKJMsL3r9/g6RPQOOE2AEurkrAIeMi4B8w72AVRD5eVUg+USzVdcbV29VBSHSlD5DzQWA+l/tgKLMiI7SsWCHm2ifIINgUD2pZEqIuvg7BGoWKQEXsFY4hTyCOewlOGVxfvWoNl0oEFShU8KcJ9jQYDBquCCvffPzsWLWaVWsCQeKToIXKZPQzC2TD3J5zTDGrB8MEpvGQ1ECwpZAWduKb+l5Y2kT6GpWTJuXlu0VzWlNAUYsIgaV5mmmFZmJrU2GzBnuXq1Hl3CMytr90V5bbYW9/O394+P7xYBNyNdyHtw6znJHiR3fqT4/xaeEdKnLF3n727rP2ItsFs6taPHt4JdfQF3drpNqTkvFOuEvGn1i1wo+xubvyRMsVYhWz+J9CMa5wgVJswG8UjAu3MQno8VkU5wANTyH1qJNz/2HWr7s0LWnXd2/NVCTaBSdihaEiww2gs+sCDYhS0VRTsW4eQ7iQ8bC7edg0vtgkForDqCQs1JrXKEGKjYaCEUEvi0B9gbOvrsWDuMce2MzvQtMzDGUqIV2Fc+AwGcUEiBpEZNh/O9C+g3JNNXBtDrHjn6BRe0BXCr/+2h+0fgPh3LN3u9Tc4/Rd+Pt/c+wEGx7nu"
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5644,
        "sha256": "159ba5891e1b9585c7c7e09493addaecf5b7a6c61be4afd6cd051e6fc8d96108",
        "payload": "eJztV8Fu3DYQvecrFjy1gGaXlEhR1C31KUBTFLXRQ4ocRuTIq0YSVZJKGwT+90Ky1242RtACjZMN9kaRo+G8x3nD4YQTBTvHaeOo7Ua68r7fXPz4YvPdlLzvv683Pc6j3VN4ttv7gXYDhrgH37adpd10+/eEHfzpw5s44cNknHY4TXHnJwqYfNhFG7opxd3qeDv8Hp+to3pj/TiSTZ0fNymgpc17Fu2eBvyVQuz8yGq2WsKDIayG8FawjK3DF47VDG3RVtIasNJJkFI2YLThYPJCNnlVClM4lrFDRBe37i7pj5lGS6wWGTugvfRzWKaY7TuYQw9tj9fsH+srmJ8x7VnN/ndmWLbsS2NaYcUZJC64CgRSBQepuIWGC4KqoUY3zpaatwsV3vc/4bDEHXxPse67mBZnOLrOYaJf/Jwosvq39ywsw4seY2Q1673FHlwXyC72ex8Tq5nI9ZZv+XZhefIhsboQmmcMU6JhSlfdQH5OLyOrheKc37zOWKAU3v0wu2u6nc855zxjU+gGDO8uDnG8xL+e3zpZjUTGWuz7Bu2bT5jcbUvuHsXrjNFbGpdYD2QekgRiwrBgiQmv6RGDBdMeI10uduSeL05ynpcgOOTmivO6kLWSW6HNK3bzNeZqWD5iurr3ScitFJSDKFQFUhCHpswNOGqlbArOsVHsgbJ9ShPcOfmIrrvFOPkxEuwJHYUlL9e0YfVnyZ9vkuU1ycD6Yeop0Rdm+F/mvOL61QKhxymSW37XKlsDvkyY5sjqnPPTOC2uyUiLJVQVGpBILVSyEZBjyblDVShRnTXxxCyfnib0VvDqSBO5PNZEfhqnZbjjuc4llKYsQVaKg5HoQGNTtY1ubdueNXHuHL/lzvFzoLhfWCZuPtWbPlL5HmlPv3jRu2t+Pyx6RpVfpf4+qnLYtEWhOIJwKEC2hFCVIoe8UrZBqpRW9lzlnvguOcmbv5BHIjAfXvySq9M4rP8oidM8rOOnS6FP9OlC2lZoSAEqo0HKogCjtAHdNtYVTZs35fk5/9Qsn6ImSpEf3+L8EU38DeeBJhw="
      },
      "decodedResponse": {
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
          },
          {
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
          }
        ]
      },
      "case": "explicit-home"
    },
    {
      "tool": "roles:list",
      "arguments": {
        "harnessSlug": "all"
      },
      "startedAt": "2026-10-29T00:34:58.026718+00:00",
      "finishedAt": "2026-10-29T00:35:07.921466+00:00",
      "durationMs": 9895,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eJwDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 7659,
        "sha256": "20bd63e66485d3f8f35fae28b8e646cae0e0a7fcb2561f21ee4afd6ea6f2063b",
        "payload": "eJztWM1u3DYQvvspCF7aAuIuSVE/q5vrU4CmKGqjhxRGwZ+hpYYSVZJy6gZ+jlz6dH2SQrLXiddGkUPseoO9UZzhcP4+zmhGOULQUxyRAdsNcOa9Qyc/vELfjsl7912DnJwG3UI4Wre+h3UvQ2yJt7bTsB5vTo+yI+98eBtH+XEzjms5jnHtRwgy+bCOOnRjiutF8Kr/PR4tqwZpPwygU+cHlILUgN7jqFvo5S8QYucH3OCFk3xkJAsjuWQ4w8vylcEN1raWUoEmYG1NBM05UZoBKWQhuNBaa17jDG81OrkRdwp/TDBowA3L8NbaUz+FeQtr15EpOGKdvMCf0BdjfpKpxQ3+4p7B2XwvDGkxK05EyFroTS4JFDkloqCaKMqA1ApUpYwuK2pnV3jvfpT9rHfwDmLjuphmYXIwnZEJfvZTgoibX9/jMC9PnIwRN9h5LR0xXQA987c+JtxgxqsVXdHV7OXRh4SbnFU0wzIl6Md01vXgp/Q64oYVlNLr8wwHSOHq+8lcwM0+p5TSDI+h62W4Otnq8Vr+eXwjZGFiGbbSOSX12/9gub0WzJ0V5xmGSxhmXbfO3CYJiUmG2ZaY5AU8wjDb1MoIpzMfmONZCKe8JIwSvjmjtMlFU9QrJsQbfP0SczXMHzGd3clUqrCsKgQpdaWIUFyTjRWUVFaUqs5zy+Qsc+uyNqWR3Ap54K5bYhz9EIG0IA2EOS+XtMHNk+TPV+nlJcmI9v3oIMH/7OHPzHlRV29mE5wcI5j5eJmX2aLxaZJpirjhlL7IcB0e8H16wJ/CijvCvHF9vovEEQbTDRefALHXI+mGLnXSdX/B0yLwjjDr9rlopPkOGgtK+YtE34PHkvGNFtowUue5IsIKS2paM1JYDqawNWz0oSQ9t5f3rCQVDRWrvOY7IOC52C1JewIKq5m0oqqI5bwiQjNDVF0rslEbVuR8U9Xl5gCKQ+E/FP4vWfgfee/2r/KXnJUH+B3gt0/wezCaeQSJj0xnXsB/8DL7uY8/URUvEn8PmgwBlRE0rwgFQYmgnBNJFSNaVVLVhRHawKHJeOZWbh8775LtDoNYcb/xFvTrxMReRotvdqOV78fk7kG0jFESNLekrGxJBKecbMBoUjNQNeValMweXrBn9vL+YaJaiaLcLeOPTbP/+fsDmsOAAqQpDGCQHBCE4ENz1MowQIy/WR9UZwwMDbrdOnXTBcLSOYwG2UNEcktBfkqxM4BS20UUIc6x/iaitrsEhO96WrxCx0gHHyNZKFo6h3q5PfdOXiHtJ2fQ4BNyMkFACpB2suvBZEj7vochgUF+yJAPSDsfwSB1de/e1dG/25Laug=="
      },
      "decodedResponse": null,
      "case": "all-sentinel"
    },
    {
      "tool": "roles:list",
      "arguments": {
        "harnessSlug": "*"
      },
      "startedAt": "2026-10-29T00:35:07.922258+00:00",
      "finishedAt": "2026-10-29T00:35:12.044212+00:00",
      "durationMs": 4122,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eJwDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5867,
        "sha256": "f8bdd88b55eec3e38a481724c50b7cfd63699efa619280a0090f9ee365622bce",
        "payload": "eJztV81u3DYQvvspCF76A3GXlKjfm+tTgKYoukYPCYJiRI4sNZSokpRTI/Bz5NKn65MUlL127BhBCzRONvCNGg6HM9/MxxnNMKNTi5+Jxm6Y8NRaQ05+fEa+nYO15ruGGFgm1aM72vZ2xO0IzvfMdt2gcDtfnZ5hYG+se+1nuBX6eQvz7Ld2RgfBuq1XbpiD366GN+Pv/mhdNUTZaUIVBjuR4EAheUu96nGEX9H5wU60oasmu1VkqyI7FzSh6/KZpg1N01qCTgtWtnnGZF4WrK4ksEzlvM2LIi2gpQnde3RyZW6Hfyw4KaSNSOg+2p1dXBRRZQa2OMM6A2f0vf01mJ8h9LSh/zsyNIn34hTWsPzCJFRS1RkwzDPOZM4Va7lAVrXYlq1WRcm7CIW15icYo9/OGvSNGXyIxmDSg4aAv9gloKfNy7fUxeWJAe9pQ41VYJgeHKqo31sfaENFWm74hm8iyrN1gTaZKHlCIQQc53A6jGiX8NzTRuSc88tXCXUY3MUPiz7DK3nKOecJnd0wgrs42fvxHP48vjKyKomEdmBMC+r1R1Sur0V9E8WrhOI5TtHXPZj7ImE+gIux+ABn+IBCjKkHj7uoh/o4Gkl5WjDBWVqfct5kecOrDc/yF/TyS6xVFz98OL2xyQuV8TbTDKtWM6lSxaqsUCwTwIXMs6rTBb2FrA9hZtdGPoDretPPdvLIegSNLtblWja0+ST181WivBYZU3acDQb8zAj/y5rPCvkihmBg9qjj8TQvk9XjXYCwRAHnh5GurC0k5KhYKVpksoCO1VoVLOMZBywrKdvqiRSPjPLBkUKIjZD8HimkuM+J9DCyJXPokBeKdSItmQQsGKi8ZV2HdalQV9iJJ048jY5f8ej4KaK42YiCy48Npw+8fA/Mp5/70dtPv3cevUzI+ovk3wevXJspVXUlZ7ptayYhFayueMoqJasK6xK7/KnzP3YvOcjOX2X3SFDcbfyS54eRrP9IicNMVnH/3yU90F8XWWMnFKSsiv1bqqpgNULBMijKNM+h1ln99IA9MsqHyIk8v88JwR8ixd9/vSMxD8RhWNyEmsBE0DnrmqMe3ITe/9ZZ1w5a49SQa9HOLGeEfk/JBCN6Ans5sUvwg0YS+sETjz6m+htP+uEcCb2ZaOmGHBPlrPds3VFgDBlhf+4NXBBlF6PJZAMxENCRFokyMIyoE6LsOOIUUBM7JcQ6ooz1qEl7cefezdE/Z511+A=="
      },
      "decodedResponse": null,
      "case": "star-sentinel"
    },
    {
      "tool": "roles:list",
      "arguments": {
        "harnessSlug": "idop-argument-scope-unregistered-fire43"
      },
      "startedAt": "2026-10-29T00:35:12.048161+00:00",
      "finishedAt": "2026-10-29T00:35:19.526283+00:00",
      "durationMs": 7478,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eJwDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 5904,
        "sha256": "b5f7421684b2af2426b99620945a6a67af580e97a358beeddef6f7fd6bed9060",
        "payload": "eJztV81u3DYQvvspCF7aAju7JCXq7+b6FKApitroIUVQjMiRpUYSVZJKagR+jlz6dH2SQrLXqX8QpEDjZAPfqOFwOPPNfMPRhBN5M4eJWWq6kc6c69nJD8/Yt1N0rv+uYj3Oo2nJH+1aN9BuQB9acE3TGdpNV6cn7OCN86/ChO+FYdrhNIWdm8hjdH4XjO+mGHar4e3wezhaVxUzbhzJxM6NLHo0xN7yYFoa8BfyoXMjr/iqCe8VYVWE15Jv+Lp8ZnnFlSm0LlBDXhoJqUgtFNQgJCiyXMtMWYl8w/cenVyZO6U/ZhoN8Upu+D7aUzf7RcRN38Hse2h6POf/2l+D+Qljyyv+vyPDN8u9NMY1rDBDikVqygSBdCIg1cJALSRBUVOd19ZkuWgWKJzrf8Rh8du7nkLVdyEuxnC0ncVIP7s5UuDVr2+5X5YnPYbAK947gz3YzpNZ9FsXIq+4VPlWbMV2QXlyPvIqkbnYcIyRhimedQO5OT4PvJJaCHH5csM9RX/x/WzP6UquhBBiwyffDegvTvZ+PMc/j6+MrEpywxvs+xrNqw+oXF9L9iaKlxtOr2lcfN2DuS8SCBH9EkuIeE4PKCwxtRjodNEje7wYUUJlIAWo8kyIKtGVVFtZ6Bf88kusVb98hHh2YzNLSDXCNCBMQpAWJKBsVAFaERWETaPTxYk9ZG2ME1wbuQfX9WaY3BgIWkJLfqnLtWx49Unq56tEeS0yMG6Yeor0mRH+yJrPkuzFEkKPUyC7HC/lZnX4NGKcA6+UEIeRrdImok6SDHReFpAWZQ51gSkoUUiyhJnM9BMnHhnlw+OE3qoyucOJPL3LCXUY2RK5RmNqAXWdpJAKW0NZNDmUJErCNMUmwydOPE2OX/Hk+CmiuNlYBJcfmk0f6HwPjKefveldD7+3ml4ii+yL5N+9LlfLAnVjDKhcEqSkC6iVQpB1meakpZFaPXW5R35LDvHlT3JxhwQqu/3yp0IfRrb+IycOM1vpnWxl9+a0A/l3ycnoUpkGZF0jpLkqoUhUA1LlyhZa541++nd5bJQPjxPFNlPFx3Di77/esSUNzFOc/UiW4cjIe+eroxb9SCH81jhfd9bSWLFr0Wk/nzPeWTcB+vN5oDFCMG4imEdP512I5MlC03lKE85GHCgw3J9mbo6hs8Ri2wUWKCz18E1gbfeaGL+Ze/mWHTPjXQiw7hjsezbg/twbvGDGzb1lo4usx0ie1cRMj91AdsOMGxa/yDI3bpjzzPQukGX1xa17t0f/AP9yhkE="
      },
      "decodedResponse": null,
      "case": "unregistered"
    },
    {
      "tool": "roles:list",
      "arguments": {
        "harness": "papercusp"
      },
      "startedAt": "2026-10-29T00:35:19.527624+00:00",
      "finishedAt": "2026-10-29T00:35:22.699195+00:00",
      "durationMs": 3172,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eJwDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 7028,
        "sha256": "f8e7fcf1965b45a0fb2570232dad117ef7b062141edbc2c77de5b4b1b481fa47",
        "payload": "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"
      },
      "decodedResponse": null,
      "case": "unknown-key"
    },
    {
      "tool": "roles:list",
      "arguments": {
        "harnessSlug": 17
      },
      "startedAt": "2026-10-29T00:35:22.700391+00:00",
      "finishedAt": "2026-10-29T00:35:30.414943+00:00",
      "durationMs": 7715,
      "exitCode": 1,
      "stdout": {
        "encoding": "base64+zlib",
        "bytes": 0,
        "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "payload": "eJwDAAAAAAE="
      },
      "stderr": {
        "encoding": "base64+zlib",
        "bytes": 6148,
        "sha256": "bb4b71b8224d6d04cb26f7f79be8c35a4a40f294d205e9142750a4a9a751439e",
        "payload": "eJztV1trHDcUfvevOOjJhtVac98dQsDdGBpwmmCbPqSE+ox0Zmca7WgqaTYxxtAfUehLf11+SdHYayeOCS00lw1+0+Xo0znfueiox56sHFwPiuq2o1NjNCyOnsJu743ReyVoHDrZkN3Zb8yK9ldoXcNNXbeS9vur0z22/I2xr12Pt4uu38e+d/umJ4ve2H0nbdt7tz8CT1e/uZ1xVII0XUfSt6YDb1ESXDAnG1rhz2RdazpWslGS3wryUZCvIzZh4/CpYiVLKKMsE8gpSyKeplnBZxkqnuUUibmQeTpTbMI2Gi2u4E7o94E6SayMJmxj7YkZbFhiUrd8sJrXGpfsvf3RmBfoG1ay/50ZNgn3UudHs9zAU5ylcp6MlgmeZkLySkTEZxVVRaVkXog6UGGM/glXQW9rNLlSt84HMOxUq9DTsRk8OVb+csFsGC40OsdKpo1EzVVrSQb5xjjPShbFxVRMxTSw3BvrWZlEhZgw9J5WvT9tV2QG/8yxMsqEEJevJsySt+c/DGpJV+uxEEJMWG/bFdrzxUaPZ/j24ApkFIomrEatK5SvPyFyfS2pGyteTRitqQu6bsjcBAl3Hm2wxXlc0j0CwaYGHZ0EOVIHASQWcc4jweP5qRBlkpVxPJ1F6Ut2+S3Gqg0T509vMOs0JZFSwqlIa55Ws5hXuYh4IaK4EulMZipgbihrvO/5NchHdF1vut50jnhDqMiGuBzDhpWfJX6+S5bHIOPSrHpNnr4yw/8q5pNplGcvgwkae0cqHE+KyajwiUc/OFbGQmyHtySpXIlccZFhwdMkKziGaV5gimmi5lGBDznxhVnevpzIpkUk7uREJO7mRLwd3srzSiY51byaFxFP86zimMiYS5XkRRSrOsvpISceOsfvuHP8HFbcbISFy0/1pvdUvnva069e9K6b3w+KXjwX828y/z6qcnGSIaGIeJXlNU8pVRxJJTzFKiLK85zU7KHKfeG3ZCtf/ji6kwT5hw9/KrLtcNZ/TIntdNbdr0vxUZu2JV+XlJJ5PK9mvJoFH+VxxWciJS6jKElEVWUiyx8K2Bdmeftyopjms+Tudz6/Jyfe/f0XBDeAJT/YjhRgB2StseVO261Rt+rXtusHX8JminbpSmjQduTciR6WJTy92oJrSXrbk/SkwHnbdssJWJLUrklBN6wqsrB4fnx8uDg9fAKLg6MjePfHn+CoU+Cb1pVw24zuXgB77yJWAnt0hfmYweUe7Fry5z0pOHtP6gx2zzZSZ3vgDfiGQJHUaElBOLA3hcM12XM4exSmj88AK7MmaB0gvDg6WBz++PzoyeHxBDrjAWE5kHMl+MY4ArQ0ItYtaeVGncFSPTjUIM2gFbSKOt/W51ANHiR2AaRutYbaWDg3w2iwpV6HvCCUDbxpfQMIllDDGvVAUFFtLI20tN1yOh65uXXX7YFv0EONrSY1gbaDetC6vEMESkm9d3DBgpnhczDSwi53/gEwG9qG"
      },
      "decodedResponse": null,
      "case": "wrong-type"
    }
  ],
  "limits": [
    "Current parent caller only, not a launched non-SU role or universal argument census",
    "Fresh current-build behavior does not authenticate historical source or vault baseline",
    "Raw MCP catalog schema exposure and runtime dispatch authority remain separate",
    "No role, grant, identity, mode or source edits; malformed inputs are read-only boundary observations"
  ],
  "runtimeReceipt": {
    "tool": "dev:pipeline_position",
    "arguments": {
      "path": "packages/operator-core/lib/agent-tools/roles/list.ts",
      "testClass": "operator-api",
      "projection": {
        "pick": [
          "input",
          "targetSha",
          "dirtyUncommitted",
          "currentBuildTestRoute",
          "servingRuntimes"
        ]
      }
    },
    "startedAt": "2026-10-29T00:35:30.416195+00:00",
    "finishedAt": "2026-10-29T00:35:44.699416+00:00",
    "durationMs": 14283,
    "exitCode": 0,
    "stdout": {
      "encoding": "base64+zlib",
      "bytes": 2760,
      "sha256": "9f5354d383ae18d695a5b2626140a8e652f4ef2fa9016fd6721eb143e2473a85",
      "payload": "eJzFVs2O3DYMvvcpCF2aoPaMd/7HuXWBoijQFkjSUxHs0BI9VlcjuRQ9ziBYoA/RJ+yTFLI9u5s2zaWH3GyJIj99/Ejqg9IdM3n5trPOvKUor0MnpMoPyhpVqtASowTOsbUqUzF0rEmV6jacTlaEDLig0YH1QkdGscFDxeh1Ay+i4NH6I1QXMFRj5+RlBi6gIZPWTmi9oPVk4GoZL16rTHHnxZ5SmGkjv8JImyM+1Yi05Xx+s9jOilkxuymXN9sCsBZiMHQuW9uSs57u2hDtgEuHId6JvIBuSN9fvX1nXfKIbRvn10jzqNm2EufxEoVOZt5iS6y7Nr9iwtbOIvHZapqZ+bp43Bh8h05mOvhaZcrG4AZmVKneUIuMQtAGlgxaDppiBPQGrsdegUHBCiMNy33g+9iiJkAm8EFg9EdmpjLVMjH93tlohaIqf1W34yUHNidW9ZCrifnhjD0nCEJRwBryYuUyT0GhDgw9D77eZepMbGurr9h/JIwdk4GR6iop5vE8tK6LkLBQlDlTbIOPBMGDNCijcQLMhMZ6ilGVw/dFPWTqrkUWi06Vwh1lyvq2k6TBFqVRpWpR3+ORnrKT68A0d7aa45G85BKCi3MOjuLc2SgziUmtDarSd849ZEqQjyRv0oq62epVvTT7VWFos9vtt1taFHuzXu/2202Bq2KzWqxMtVeZMpbl8ovXV7mrskYXKVND5v3x9SjVRP0HdSJpQqqayoXqIx0zOcJIH+t4EF3oPaXfgaARntmuilovd8Xi2fqba+U1hE4alalJzvG2QX+kJ+qioNcJUbp5pjp/70PvXxPGlMWRjs9h/WTN/RfWalmYdb1b1vhFsFbHvAlRniDGBnkQ+TOMRbXB1Qq3Zv9FMB5RqMfL5zEuzHax3NfrNX0K4+QsP6eOeaT/B/ZdqjcOv5Ee6/qDurd+QB46b8jkLV5Sr1CZEu68xkH2YwCxxKNEvEFOJnVg/bQf2B6tR3fbIEdVLtfFOpW8dOzJTIuL7XqVqTDW023ovKjy5nFBlb++y9JQioGfYYuaUXSTt+P1U72rUmlssbLOyqVMvURlCvkY07HaOrp77B5D545pXEx+5o9r+WN/nX9yasx322q3LhbrfLNZ3uSrLRV5tS82udktF3tc1fXWbFK/65zkJgTOb7b75WK5ulnud8Um363WxizXOIutdS4l9yJ0F+o6kqiymP6dPVlR5bLYLh4yVQVzuQ2n1lGadEPDeciUp/eiSvW2IaBp9o5hocc4dG0hDxJAGgKmmpi8JrAeDkkt5OUAf/3xJyQKwUqytD62pAX61KLTscTr1fsMUqhDx/bwsRMbAaFmPKXJPeXlKd6kTOJsGFYIjD388ObnnyDlZAavCU0K31tp4PCPDB4g0TFAjPDi8IyrA3wDhyeuDtngIHQCB8b+8HKYlXVwLvRwSFTdjRo6pHue0VmTRl4y6nzP2IKVCCf0tk5TsKI6cIrLMU3MRMVUBa+Gn+n9Ar47VZRGYNIInC31oNHDtU4AwYU0ea0/OsoHo8nPDL4PPZ0TLfLvDKIbZiFoZLYUoWujMOEJpsEIJ+R74hfxJbwQei9vr4X58lUia8Rs47O0a/SJfiYdzsRDzKnCoLbkTMyAQx8zCAzJ45jtTz+c/gFywGKSBpIjwPh4f5PSmycr6CYiUUazryOYoLv0+BquPcC6QIPeOEogPDKHnhiQj4NZfAUIvTXE0BLnY7Ah+XDCyyAuep9mvXp4+Opv21TLqg=="
    },
    "stderr": {
      "encoding": "base64+zlib",
      "bytes": 7446,
      "sha256": "dbfa53bbff79d1890a0de953a4c2ee249b2d34a535fa08f2ccd4e1f325865ca7",
      "payload": "eJztV0tv3DYQvvtXLHhqAc0uH3pQuqU+BWiKojZ6SBEUI3LkVaMVWZLrNgj83wtp/Ui2RtoCjWO1e6PI0Wjmm/mGnzx6CmYf/cpS14906dywOv/25eorn5wbvm5WA+5Hs6Vwttm6HW12GOIWXNf1hjb+8LbHHn5z4W30+LAZ/Qa9jxvnKWByYRNN6H2Km9nxevdLPJtXzcq4cSSTejeuUkBDq/csmi3t8EcKsXcja9hsCQ+GMBvCtWAZm5cvLWuYzttO1rUBVeYccm4ttGWroZJ1KaqqqyuhWcbuIjo/uLugX/c0GmKNyNhdthduH6YtZoYe9mGAbsAr9sH5nMz3mLasYf86MiybvktjmtOKe8hR56ZWCFQoDnnBDbRcEOiW2qq1pqx4N0Hh3PAd7qa4LV03vvc09CP97F3sJ9gmvzja3mKiH9w+UWTNT+9ZmJbnA8bIGjY4gwPYPpBJLGNbFxNrmJDVmq/5egLcu5BYo0TFM4Yp0c6ny35Hbp9eRdaIgnN+8yZjgVJ4983eXtFhX3LOecZ86HcY3p3fxfEKf39xcDIbiYx1OAwtmrefMLn9LNn7LN5kjK5pnGK9w/WuXyAmDFMuMeEVPWIw5bTFSBeTHdkXkxPJZQmCg6wvOW9U0Si+LpR8zW6eY9uG6SGmy3ufxnBlVWGBG1FDjqhBa43QYtWWbS1IFQV7gGybkodbJ3+C6/YwejdGgi2hpTC16Nw2rPks/fOfRHluMjBu5wdK9IUR/ps9X/Pi9ZTCgD6SnV5XVTYHfJEw7SNrJOfLqBYv2rbqbA0FoYJcC4RW8g7KUraFVnWnpTlx4olRXh4n1DrPyyNOlPkxJ+QyqtXJklcSCbqqUJBXWgPqsgVNlrQy1hjSJ06cROT/Q0R+jizuD6aNm0/J1EeG4CNK9YvPv1sd/NH8k7VeyMAr86qytuZglbKQK1uCttQBKsmValvUpjsNvCe+VpYoAgpxTIL6Yw2Q82IZxfqHlFhmseqjYolyoX8xurCyJSygk7yGXFAOiFwAdkWpucix0PVpgD0xykvkRC358Z89XwYnTvr6pK//Wl8fOOlptP149QElJ/wjGByGZ8JDcczDgnNxIt6JeIsm3iOX4fNnnuBlLW/O/gCIHXjH"
    },
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
        "path": "packages/operator-core/lib/agent-tools/roles/list.ts",
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
        "originalChars": 3505,
        "returnedChars": 2754,
        "omittedCount": 1,
        "omitted": [],
        "cursor": {
          "kind": "scratch-page",
          "tool": "capability:read",
          "args": {
            "file_path": "papercusp://scratch/papercusp-workspace/dev:pipeline_position/87b85025-6631-47e0-b906-d8329a4ff7d6/result-door-1793234139806-845dd35a.spill",
            "byte_offset": 0,
            "byte_limit": 3072
          },
          "bodyComplete": false
        },
        "next": "The emitted result was written to the reference in `content` — page it to inspect what the tool emitted. The `uri` in `content` is a framed scratch-reference container, not a raw JSON file. Read it with `capability:read` byte pages (`byte_offset` + `byte_limit`, without `raw`) and follow `next_cursor` to validate and unwrap its manifest before parsing the payload; the default numbered line view can truncate a long single-line payload. However, the emitted result already carries upstream partial marker(s) (textTruncated); paging this reference cannot recover the omitted fields, rows, or text. The dev:pipeline_position result already marked a field as truncated. Re-read using that field's documented recovery handle or narrower arguments; a wider per-field limit may not exist."
      }
    }
  },
  "sourceAfter": [
    {
      "path": "packages/operator-core/lib/agent-tools/roles/list.ts",
      "sha256": "e3d97089a6d5adb6b8f1eb6f9cb7c8fa8caf5da4e6b48324e7f8cd2efc5dacf9"
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
  "finishedAt": "2026-10-29T00:35:44.703042+00:00",
  "interpretation": {
    "cases": [
      {
        "case": "default",
        "exitCode": 0,
        "error": null,
        "stdoutSha256": "30e11023e5bf44746f02564c6cd63dd45a8e3232654fe1348702d59ce1ca0159",
        "returnedHarness": "papercusp",
        "returnedRoleIds": [
          "infra-reviewer",
          "security-reviewer"
        ]
      },
      {
        "case": "explicit-home",
        "exitCode": 0,
        "error": null,
        "stdoutSha256": "30e11023e5bf44746f02564c6cd63dd45a8e3232654fe1348702d59ce1ca0159",
        "returnedHarness": "papercusp",
        "returnedRoleIds": [
          "infra-reviewer",
          "security-reviewer"
        ]
      },
      {
        "case": "all-sentinel",
        "exitCode": 1,
        "error": "harness_forbidden: harnessSlug \"all\" names a harness outside this session's hive \"papercusp\". A cross-hive call made this way could not later be claimed, commented on, or closed by this session.",
        "stdoutSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      },
      {
        "case": "star-sentinel",
        "exitCode": 1,
        "error": "harness_forbidden: harnessSlug \"*\" names a harness outside this session's hive \"papercusp\". A cross-hive call made this way could not later be claimed, commented on, or closed by this session.",
        "stdoutSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      },
      {
        "case": "unregistered",
        "exitCode": 1,
        "error": "harness_forbidden: harnessSlug \"idop-argument-scope-unregistered-fire43\" names a harness outside this session's hive \"papercusp\". A cross-hive call made this way could not later be claimed, commented on, or closed by this session.",
        "stdoutSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      },
      {
        "case": "unknown-key",
        "exitCode": 1,
        "error": "invalid_input: invalid_args: Unrecognized key: \"harness\" CORRECTED CALL — send this: roles:list({ \"harnessSlug\": \"papercusp\" }) (moved `harness` -> `harnessSlug`). This resolves the rejected keys against the args you actually sent; it does not guarantee the call validates, since a value-level error would not have been visible to this check. — this tool accepts ONLY: harnessSlug. (Dispatch-level args, handled by the transport before this tool's own schema and therefore not in the list above but also accepted: payloadTier, projection, view.) Did you mean `harnessSlug` for `harness`? An undeclared arg is REJECTED, not silently ignored (EI-10883): passing an arg a tool does not declare used to return ok:true while quietly doing something else, which is indistinguishable from success. Re-send using only the keys above (or the dispatch-level ones just listed). This server is running build b30d5f83fa, started 44min ago. If this argument was added after that build, the running process has never seen it — restart the app/process to pick up the new code. For the current source tree, retry this call against the Papercusp staging operator at :3170 — add build: 'staging' to this call's arguments (or call tools:invoke { name, args, build: 'staging' }) and the MCP proxy routes it there; with ptool, pass --url=http://127.0.0.1:3170 explicitly.",
        "stdoutSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      },
      {
        "case": "wrong-type",
        "exitCode": 1,
        "error": "invalid_input: invalid_args: harnessSlug: Invalid input: expected string, received number CORRECTED CALL — send this: roles:list({ \"harnessSlug\": \"<string>\" }) (retyped `harnessSlug` (`<string>`) to the declared type). Every `<type>` above is a PLACEHOLDER, not a guess: those are the fields this refusal could identify but cannot fill for you — replace each with a real value before sending. — the field(s) that failed, in full: `harnessSlug` accepts {\"type\":\"string\"}",
        "stdoutSha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      }
    ],
    "successPayloadsIdentical": true,
    "sourceStable": true,
    "loadedBuildSourcePins": [
      {
        "path": "packages/operator-core/lib/agent-tools/roles/list.ts",
        "buildSha": "b30d5f83fa",
        "loadedCommitFileSha256": "e3d97089a6d5adb6b8f1eb6f9cb7c8fa8caf5da4e6b48324e7f8cd2efc5dacf9",
        "observedSourceSha256": "e3d97089a6d5adb6b8f1eb6f9cb7c8fa8caf5da4e6b48324e7f8cd2efc5dacf9",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/agent-tools/_harness-scope.ts",
        "buildSha": "b30d5f83fa",
        "loadedCommitFileSha256": "9522f7a699a19eb814efdf29813fc82a9eae610381fb82297f51a92c9f62af8f",
        "observedSourceSha256": "9522f7a699a19eb814efdf29813fc82a9eae610381fb82297f51a92c9f62af8f",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/role-registry.ts",
        "buildSha": "b30d5f83fa",
        "loadedCommitFileSha256": "336c54895438c72d80d9aa340e5fac6b94245ce0cdf8ca77d73c5bbac66d5a63",
        "observedSourceSha256": "336c54895438c72d80d9aa340e5fac6b94245ce0cdf8ca77d73c5bbac66d5a63",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts",
        "buildSha": "b30d5f83fa",
        "loadedCommitFileSha256": "6ebdeee75c25aa844020e115f28eae3faa1643c82095057bfb19d38de4c98e98",
        "observedSourceSha256": "6ebdeee75c25aa844020e115f28eae3faa1643c82095057bfb19d38de4c98e98",
        "matches": true
      },
      {
        "path": "packages/operator-core/lib/endpoint-route/hive-harness-arg-coverage.ts",
        "buildSha": "b30d5f83fa",
        "loadedCommitFileSha256": "b4573c80d76c27968f305885359c66528bb8d6dee39c9a1f38891c291d5216b7",
        "observedSourceSha256": "b4573c80d76c27968f305885359c66528bb8d6dee39c9a1f38891c291d5216b7",
        "matches": true
      },
      {
        "path": "apps/operator/scripts/ptool.mjs",
        "buildSha": "b30d5f83fa",
        "loadedCommitFileSha256": "bb85e2641dc9a02703dd4faf0c6d7f8e7c8d416f02ee26de4f8377a159477695",
        "observedSourceSha256": "6f16bc5ebb60ba0a5cec7c05b6cad6546f905ac2720a1ce1d0927ac08cf4d355",
        "matches": false
      }
    ],
    "sourceComparator": "git show at measured staging build; proves committed bytes, not import closure",
    "testSuiteClaim": false,
    "historicalBaselineClaim": false,
    "universalPermissionClaim": false,
    "runtimeReceiptPartial": true
  }
}

