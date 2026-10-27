---
rel_path: "evidence/ei267253-source-external-d010-20261024-v5.json"
updated_at: 1792874236322
_body: "content"
---

{
  "schemaVersion": "ei267253-d010-external-partial-v5",
  "at": "2026-10-24T20:36:04.186Z",
  "owningWorkItem": "EI-26725363534104440",
  "authority": "dream-loaded-control-observations-2026-10-17#D-010",
  "partial": true,
  "receipt": false,
  "fullClosureQualified": false,
  "status": "STOPPED-bound-at-retained-commonjs-candidate",
  "headBefore": "4d8b82a92ccba9482344051c23924248f2bd88ec",
  "headAfter": "4d8b82a92ccba9482344051c23924248f2bd88ec",
  "predecessor": {
    "path": ".papercusp/scratch/ei267253-source-frontier-d008-20261024-v4.json",
    "sha256": "6163a8bd410c2eb46ccd30d256d27146ebb9440c810a5eaa66a9fcef8880e309",
    "archive": "evidence/ei267253-source-frontier-d008-20261024-v4.json"
  },
  "baseline": {
    "path": ".papercusp/scratch/ei267083-current-inputs-20261024q.json",
    "sha256": "29a742aea0c4ecddc7ad89aaf86cccff0bd14339d1d01c80c5d858a873a531fa",
    "role": "counting membership only; not inherited runtime closure"
  },
  "package": {
    "name": "hono",
    "version": "4.13.7",
    "type": "module",
    "exportMap": {
      "types": "./dist/types/middleware/cors/index.d.ts",
      "import": "./dist/middleware/cors/index.js",
      "require": "./dist/cjs/middleware/cors/index.js"
    },
    "lockInputs": [
      {
        "path": "package-lock.json",
        "sha256": "e16502a07b06cfed7ec160d6484922c45d0ffbb94085fa8c5292d46253525b68",
        "lockfileVersion": 3,
        "entry": {
          "version": "4.13.7",
          "resolved": "https://registry.npmjs.org/hono/-/hono-4.13.7.tgz",
          "integrity": "sha512-c8/gF9ac8Y78/agExVocyLevgR+JlpNB444Py0FSX8pJoPdYUfUzRcXtYEYGwt6l19qIlVZPN5Mfsw9jFShmQQ==",
          "license": "MIT",
          "engines": {
            "node": ">=16.9.0"
          }
        }
      },
      {
        "path": "node_modules/.package-lock.json",
        "sha256": "e2088158839a74af5737dd82f584eaf72602d5d6dc810d568bb872589339d773",
        "lockfileVersion": 3,
        "entry": {
          "version": "4.13.7",
          "resolved": "https://registry.npmjs.org/hono/-/hono-4.13.7.tgz",
          "integrity": "sha512-c8/gF9ac8Y78/agExVocyLevgR+JlpNB444Py0FSX8pJoPdYUfUzRcXtYEYGwt6l19qIlVZPN5Mfsw9jFShmQQ==",
          "license": "MIT",
          "engines": {
            "node": ">=16.9.0"
          }
        }
      }
    ],
    "cjsScope": {
      "type": "commonjs"
    },
    "provenanceLimit": "Lock/install metadata entries agree, and exact installed bytes are hashed. No tarball-to-installed byte attestation, actual serving-loader selection or live runtime state is asserted."
  },
  "loaderConditions": {
    "source": "TS import syntax and createRequire probe do not select one serving route. Root/operator manifests advertise tsx routes; transformed/serving artifact and its conditions are not proved.",
    "candidateSet": [
      {
        "condition": "package exports import condition; root package type module",
        "path": "node_modules/hono/dist/middleware/cors/index.js",
        "sha256": "b4084f07f48ab369a8b58cfd90ac277cd590ca618842ba4132bc53642ad990fd",
        "selection": "RETAINED; actual serving-loader/transform choice UNKNOWN"
      },
      {
        "condition": "package exports require condition; nested dist/cjs package type commonjs",
        "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
        "sha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
        "selection": "RETAINED; createRequire result is not serving-loader proof"
      }
    ],
    "policy": "Retain both candidates; require complete conservative analysis before discharging ambiguity."
  },
  "runtimeAccounting": {
    "policy": "Retain original58. Count required runtime export/package-scope metadata and implementations in one60 union; no JSON/vendor exemption.",
    "requiredRuntimePaths": [
      {
        "path": "node_modules/hono/package.json",
        "role": "runtime package export-map and package-scope input",
        "from": {
          "path": "packages/operator-core/lib/endpoint-route/cors.ts",
          "start": 984,
          "end": 1017,
          "byteStart": 998,
          "byteEnd": 1031,
          "line": 23,
          "column": 1,
          "sha256": "a0805dac79c5de8e10e8e743a5655151f6fce43ddfc14add90ea148bbc9ddf34",
          "sourceSha256": "1ef8e0abb4ab8c627b99c2904a7b70f92b6eb194eb0a1c755015b695b2a15547",
          "source": "import { cors } from 'hono/cors';",
          "sourceTruncated": false
        }
      },
      {
        "path": "node_modules/hono/dist/middleware/cors/index.js",
        "role": "retained import candidate implementation",
        "from": {
          "path": "node_modules/hono/package.json",
          "exportKey": "./cors.import"
        }
      },
      {
        "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
        "role": "retained require candidate implementation",
        "from": {
          "path": "node_modules/hono/package.json",
          "exportKey": "./cors.require"
        }
      },
      {
        "path": "node_modules/hono/dist/cjs/package.json",
        "role": "retained require candidate package-scope input",
        "from": {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js"
        }
      }
    ],
    "frontier": {
      "status": "STOPPED-bound",
      "bound": 60,
      "additions": [
        "apps/operator/scripts/psu-carry-fence.mjs",
        "libs/host-platform/src/home.mjs",
        "packages/operator-core/lib/claude-sessions.ts",
        "packages/operator-core/lib/endpoint-route/cors.ts",
        "packages/operator-core/lib/endpoint-route/route-stack.ts",
        "packages/operator-core/lib/endpoint-route/cookies.ts",
        "packages/operator-core/lib/auth.ts",
        "packages/agent-mcp/src/index.ts",
        "packages/operator-core/lib/search/query-embedder-warmup.ts",
        "packages/operator-core/lib/search/prose-vector-dims.ts",
        "packages/operator-core/lib/adv-session-windows.ts",
        "packages/operator-core/lib/adv-session-focus.ts",
        "packages/operator-core/lib/adv-sessions.ts",
        "packages/operator-core/lib/field-reliability.ts",
        "packages/operator-core/lib/sync-sse.ts",
        "packages/operator-core/lib/adv-roster.ts",
        "packages/operator-core/lib/adv-session-search.ts",
        "packages/operator-core/lib/desktop-window-liveness.ts",
        "packages/operator-core/lib/windows-desktop-windows.ts",
        "packages/operator-core/lib/omp-config.ts",
        "packages/operator-core/lib/session-port/types.ts",
        "packages/operator-core/lib/session-port/source.ts",
        "packages/operator-core/lib/su-context-size.mjs",
        "packages/operator-core/lib/session-port/telemetry.ts",
        "packages/operator-core/lib/omp-sessions.ts",
        "packages/operator-core/lib/su-persona-render.ts",
        "packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts",
        "packages/operator-core/lib/superuser-token.ts",
        "packages/operator-core/lib/agent-tools/coordination/control-anchor.ts",
        "packages/operator-core/lib/model-context-budget.mjs",
        "packages/operator-core/lib/role-launch-spec.ts",
        "packages/operator-core/lib/inference-gateway/spawn-env.ts",
        "packages/operator-core/lib/events/await/wake-executor.ts",
        "packages/operator-core/lib/capability-envelope/session-confinement-store.ts",
        "packages/operator-core/lib/capability-envelope/session-confinement-port.ts",
        "packages/operator-core/lib/cupboard/identity-activation-gate-io.ts",
        "packages/operator-core/lib/util/cli-entry.ts",
        "packages/operator-core/lib/agent-kickoff/prompt-transport.mjs",
        "packages/operator-core/lib/workspace-host/hosted-agent-admission-client.ts",
        "apps/operator/scripts/psu-connection-front-controller.mjs",
        "apps/operator/scripts/psu-terminal-diagnostics.mjs",
        "apps/operator/scripts/tool-delivery.generated.mjs",
        "packages/operator-core/lib/claude-resume-tool-references.mjs",
        "apps/operator/scripts/psu-recovery.mjs",
        "apps/operator/lib/mcp-proxy/budgets.mjs",
        "apps/operator/scripts/psu-operator-down-diagnosis.mjs",
        "packages/operator-core/lib/workspace-host/hosted-psu-argv.mjs",
        "packages/operator-core/lib/su-model-menu.mjs",
        "packages/operator-core/lib/su-tier-roles.mjs",
        "packages/operator-core/lib/claude-plugin/plugin-rails.mjs",
        "packages/operator-core/lib/local-model-spec.mjs",
        "packages/operator-core/lib/personal-vault/provider-egress.mjs",
        "packages/operator-core/lib/schedule-descriptors.mjs",
        "packages/operator-core/lib/omp-native-lsp-tier.mjs",
        "packages/operator-core/lib/backend-bin-resolve.mjs",
        "packages/operator-core/lib/framework-install-spec.mjs",
        "packages/operator-core/lib/psu-launch-log.mjs",
        "libs/papercusp/packages/orchestrator/src/omp-gateway-config.ts",
        "node_modules/hono/package.json",
        "node_modules/hono/dist/middleware/cors/index.js"
      ],
      "frontier": [
        {
          "path": "node_modules/hono/package.json",
          "role": "runtime package export-map and package-scope input",
          "from": {
            "path": "packages/operator-core/lib/endpoint-route/cors.ts",
            "start": 984,
            "end": 1017,
            "byteStart": 998,
            "byteEnd": 1031,
            "line": 23,
            "column": 1,
            "sha256": "a0805dac79c5de8e10e8e743a5655151f6fce43ddfc14add90ea148bbc9ddf34",
            "sourceSha256": "1ef8e0abb4ab8c627b99c2904a7b70f92b6eb194eb0a1c755015b695b2a15547",
            "source": "import { cors } from 'hono/cors';",
            "sourceTruncated": false
          }
        },
        {
          "path": "node_modules/hono/dist/middleware/cors/index.js",
          "role": "retained import candidate implementation",
          "from": {
            "path": "node_modules/hono/package.json",
            "exportKey": "./cors.import"
          }
        }
      ],
      "refusedEdge": {
        "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
        "role": "retained require candidate implementation",
        "from": {
          "path": "node_modules/hono/package.json",
          "exportKey": "./cors.require"
        }
      },
      "pending": [
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "role": "retained require candidate implementation",
          "from": {
            "path": "node_modules/hono/package.json",
            "exportKey": "./cors.require"
          }
        },
        {
          "path": "node_modules/hono/dist/cjs/package.json",
          "role": "retained require candidate package-scope input",
          "from": {
            "path": "node_modules/hono/dist/cjs/middleware/cors/index.js"
          }
        }
      ],
      "complete": false
    },
    "implementationOnlySensitivity": {
      "count": 60,
      "scope": "Two implementation candidates alone fill the bound. This does not waive the two required package-resolution inputs or qualify the alternative count."
    }
  },
  "initialization": {
    "esm": {
      "statements": [
        {
          "path": "node_modules/hono/dist/middleware/cors/index.js",
          "start": 32,
          "end": 2877,
          "line": 2,
          "column": 1,
          "source": "var cors = (options) => {\n  const opts = {\n    origin: \"*\",\n    allowMethods: [\"GET\", \"HEAD\", \"PUT\", \"POST\", \"DELETE\", \"PATCH\", \"QUERY\"],\n    allowHeaders: [],\n    exposeHeaders: [],\n    ...options\n  };\n  const exposeHeadersStr = opts.exposeHeaders?.length ? opts.exposeHeaders.join(\",\") : void 0;\n  const allowHeadersStr = opts.allowHeaders?.length ? opts.allowHeaders.join(\",\") : void 0;\n  const findAllowOrigin = ((optsOrigin) => {\n    if (typeof optsOrigin === \"string\") {\n      if (optsOrigin === \"*\") {\n        return () => optsOrigin;\n      } else {\n        return (origin) => optsOrigin === origin ? origin : null;\n      }\n    } else if (typeof optsOrigin === \"function\") {\n      return optsOrigin;\n    } else {\n      return (origin) => optsOrigin.includes(origin) ? origin : null;\n    }\n  })(opts.origin);\n  const findAllowMethods = ((optsAllowMethods) => {\n    if (typeof optsAllowMethods === \"function\") {\n      return async (origin, c) => (await optsAllowMethods(origin, c)).join(\",\");\n    } else if (Array.isArray(optsAllowMethods)) {\n      const methodsStr = optsAllowMethods.join(\",\");\n      return () => methodsStr;\n    } else {\n      return () => \"\";\n    }\n  })(opts.allowMethods);\n  return async function cors2(c, next) {\n    function set(key, value) {\n      c.res.headers.set(key, value);\n    }\n    const allowOrigin = await findAllowOrigin(c.req.header(\"origin\") || \"\", c);\n    if (allowOrigin) {\n      set(\"Access-Control-Allow-Origin\", allowOrigin);\n    }\n    if (opts.credentials) {\n      set(\"Access-Control-Allow-Credentials\", \"true\");\n    }\n    if (exposeHeadersStr) {\n      set(\"Access-Control-Expose-Headers\", exposeHeadersStr);\n    }\n    if (c.req.method === \"OPTIONS\") {\n      if (opts.origin !== \"*\") {\n        c.res.headers.append(\"Vary\", \"Origin\");\n      }\n      if (opts.maxAge != null) {\n        set(\"Access-Control-Max-Age\", opts.maxAge.toString());\n      }\n      const allowMethods = await findAllowMethods(c.req.header(\"origin\") || \"\", c);\n      if (allowMethods) {\n        set(\"Access-Control-Allow-Methods\", allowMethods);\n      }\n      let headersStr = allowHeadersStr;\n      if (!headersStr) {\n        const requestHeaders = c.req.header(\"Access-Control-Request-Headers\");\n        if (requestHeaders) {\n          headersStr = requestHeaders.split(\",\").map((h) => h.trim()).join(\",\");\n        }\n      }\n      if (headersStr) {\n        set(\"Access-Control-Allow-Headers\", headersStr);\n        c.res.headers.append(\"Vary\", \"Access-Control-Request-Headers\");\n      }\n      c.res.headers.delete(\"Content-Length\");\n      c.res.headers.delete(\"Content-Type\");\n      return new Response(null, {\n        headers: c.res.headers,\n        status: 204,\n        statusText: \"No Content\"\n      });\n    }\n    await next();\n    if (opts.origin !== \"*\") {\n      c.header(\"Vary\", \"Origin\", { append: true });\n    }\n  };\n};",
          "sourceSha256": "5737f7a54eeab3d2aa6ee4f2bbd074f1765917f636be91d3bc7ca64620763ae5",
          "fileSha256": "b4084f07f48ab369a8b58cfd90ac277cd590ca618842ba4132bc53642ad990fd",
          "kind": "FirstStatement",
          "effect": "binding assignment to deferred arrow function; function body is not invoked by this declaration"
        },
        {
          "path": "node_modules/hono/dist/middleware/cors/index.js",
          "start": 2878,
          "end": 2896,
          "line": 85,
          "column": 1,
          "source": "export {\n  cors\n};",
          "sourceSha256": "fad5206b38c7b90ce20c446eb321885a2fc631b4d37bafb1132ab189fafee2d0",
          "fileSha256": "b4084f07f48ab369a8b58cfd90ac277cd590ca618842ba4132bc53642ad990fd",
          "kind": "ExportDeclaration",
          "effect": "export table declaration; not a function invocation"
        }
      ],
      "scope": "Complete top-level syntactic statement inventory with deferred arrow/export semantics; not an actual-loader or callback execution proof."
    },
    "corsCaller": {
      "calls": [
        {
          "path": "packages/operator-core/lib/endpoint-route/cors.ts",
          "start": 1897,
          "end": 2730,
          "line": 43,
          "column": 10,
          "source": "cors({\n    origin: origins\n      ? (origin) => (origin && origins.includes(origin) ? origin : '')\n      : (origin) => defaultCorsOrigin(origin),\n    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],\n    allowHeaders: [\n      'authorization',\n      'content-type',\n      'last-event-id',\n      'x-papercusp-run-id',\n      // Per-window workspace context — stamped on EVERY operator API fetch by\n      // installWorkspaceHeaderFetch, including the deliberately cross-origin\n      // sibling-loopback calls from crossOriginUrl() (saved-prompts, git/show).\n      // Omitting it here makes those preflights strip the header and the\n      // browser block the call outright (harness-settings e2e, 2026-06-10).\n      'x-papercusp-workspace',\n      'x-papercusp-machine',\n    ],\n    credentials: true,\n    maxAge: 600,\n  })",
          "sourceSha256": "09c28f927aee4dd82273a7518a547a757c66fa554f6e5fccfa9e4c7bb326adf0",
          "fileSha256": "a0805dac79c5de8e10e8e743a5655151f6fce43ddfc14add90ea148bbc9ddf34",
          "deferredWithinDeclaredFunction": true
        }
      ],
      "scope": "cors factory call is inside corsFor declaration; selected CSRF import still eagerly loads the external module."
    },
    "cjs": {
      "preflightStatements": [
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 0,
          "end": 38,
          "line": 1,
          "column": 1,
          "source": "var __defProp = Object.defineProperty;",
          "sourceSha256": "cda030f109e7269529567b0f1d38d339f151936c0644db59d47e89620036e2ec",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "FirstStatement",
          "effect": "requires initialization/body analysis; not discharged by import-list absence"
        },
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 39,
          "end": 94,
          "line": 2,
          "column": 1,
          "source": "var __getOwnPropDesc = Object.getOwnPropertyDescriptor;",
          "sourceSha256": "a0c7cf5bd78aa2e42f4db888b89344a86f374a5c13ca696f9385846e579ee9bb",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "FirstStatement",
          "effect": "requires initialization/body analysis; not discharged by import-list absence"
        },
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 95,
          "end": 146,
          "line": 3,
          "column": 1,
          "source": "var __getOwnPropNames = Object.getOwnPropertyNames;",
          "sourceSha256": "ba2d9c76afed779a25537ec34cb22a9c7a17c67e43103dcdfe7f6ded4d1b93ad",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "FirstStatement",
          "effect": "requires initialization/body analysis; not discharged by import-list absence"
        },
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 147,
          "end": 198,
          "line": 4,
          "column": 1,
          "source": "var __hasOwnProp = Object.prototype.hasOwnProperty;",
          "sourceSha256": "de496e31e2d06a14a1955d80567f4360e90b03214827583762cda8dac4bf6f7a",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "FirstStatement",
          "effect": "requires initialization/body analysis; not discharged by import-list absence"
        },
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 199,
          "end": 326,
          "line": 5,
          "column": 1,
          "source": "var __export = (target, all) => {\n  for (var name in all)\n    __defProp(target, name, { get: all[name], enumerable: true });\n};",
          "sourceSha256": "8880c33da927f05af9f8b8f873eaf291c5c30dbd61d7d1268a09615c7c33da10",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "FirstStatement",
          "effect": "binding assignment to deferred arrow function; function body is not invoked by this declaration"
        },
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 327,
          "end": 692,
          "line": 9,
          "column": 1,
          "source": "var __copyProps = (to, from, except, desc) => {\n  if (from && typeof from === \"object\" || typeof from === \"function\") {\n    for (let key of __getOwnPropNames(from))\n      if (!__hasOwnProp.call(to, key) && key !== except)\n        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n  }\n  return to;\n};",
          "sourceSha256": "8015a73ea65ca543bacba1f0bad626f51249c88ef030db8fc272ad28a95af023",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "FirstStatement",
          "effect": "binding assignment to deferred arrow function; function body is not invoked by this declaration"
        },
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 693,
          "end": 784,
          "line": 17,
          "column": 1,
          "source": "var __toCommonJS = (mod) => __copyProps(__defProp({}, \"__esModule\", { value: true }), mod);",
          "sourceSha256": "e3e742d3d0e0107a603a484ce118687617c7a53a33cf65746908cb9e22ddf6e2",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "FirstStatement",
          "effect": "binding assignment to deferred arrow function; function body is not invoked by this declaration"
        },
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 785,
          "end": 807,
          "line": 18,
          "column": 1,
          "source": "var cors_exports = {};",
          "sourceSha256": "79970f80d5c7eeea4b6537ca93d3f649029f51b82b38be05de177a9267deec80",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "FirstStatement",
          "effect": "requires initialization/body analysis; not discharged by import-list absence"
        },
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 808,
          "end": 855,
          "line": 19,
          "column": 1,
          "source": "__export(cors_exports, {\n  cors: () => cors\n});",
          "sourceSha256": "b48d0aec19209219c698d80d694c75d4029a22e6047f6bafeb6014ec7b2301ea",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "ExpressionStatement",
          "effect": "requires initialization/body analysis; not discharged by import-list absence"
        },
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 856,
          "end": 900,
          "line": 22,
          "column": 1,
          "source": "module.exports = __toCommonJS(cors_exports);",
          "sourceSha256": "1ca976a6f3aba678858836c63679c5a452c10495c9e81c814cff71bf5f9794ac",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "ExpressionStatement",
          "effect": "requires initialization/body analysis; not discharged by import-list absence"
        },
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 901,
          "end": 3748,
          "line": 23,
          "column": 1,
          "source": "const cors = (options) => {\n  const opts = {\n    origin: \"*\",\n    allowMethods: [\"GET\", \"HEAD\", \"PUT\", \"POST\", \"DELETE\", \"PATCH\", \"QUERY\"],\n    allowHeaders: [],\n    exposeHeaders: [],\n    ...options\n  };\n  const exposeHeadersStr = opts.exposeHeaders?.length ? opts.exposeHeaders.join(\",\") : void 0;\n  const allowHeadersStr = opts.allowHeaders?.length ? opts.allowHeaders.join(\",\") : void 0;\n  const findAllowOrigin = ((optsOrigin) => {\n    if (typeof optsOrigin === \"string\") {\n      if (optsOrigin === \"*\") {\n        return () => optsOrigin;\n      } else {\n        return (origin) => optsOrigin === origin ? origin : null;\n      }\n    } else if (typeof optsOrigin === \"function\") {\n      return optsOrigin;\n    } else {\n      return (origin) => optsOrigin.includes(origin) ? origin : null;\n    }\n  })(opts.origin);\n  const findAllowMethods = ((optsAllowMethods) => {\n    if (typeof optsAllowMethods === \"function\") {\n      return async (origin, c) => (await optsAllowMethods(origin, c)).join(\",\");\n    } else if (Array.isArray(optsAllowMethods)) {\n      const methodsStr = optsAllowMethods.join(\",\");\n      return () => methodsStr;\n    } else {\n      return () => \"\";\n    }\n  })(opts.allowMethods);\n  return async function cors2(c, next) {\n    function set(key, value) {\n      c.res.headers.set(key, value);\n    }\n    const allowOrigin = await findAllowOrigin(c.req.header(\"origin\") || \"\", c);\n    if (allowOrigin) {\n      set(\"Access-Control-Allow-Origin\", allowOrigin);\n    }\n    if (opts.credentials) {\n      set(\"Access-Control-Allow-Credentials\", \"true\");\n    }\n    if (exposeHeadersStr) {\n      set(\"Access-Control-Expose-Headers\", exposeHeadersStr);\n    }\n    if (c.req.method === \"OPTIONS\") {\n      if (opts.origin !== \"*\") {\n        c.res.headers.append(\"Vary\", \"Origin\");\n      }\n      if (opts.maxAge != null) {\n        set(\"Access-Control-Max-Age\", opts.maxAge.toString());\n      }\n      const allowMethods = await findAllowMethods(c.req.header(\"origin\") || \"\", c);\n      if (allowMethods) {\n        set(\"Access-Control-Allow-Methods\", allowMethods);\n      }\n      let headersStr = allowHeadersStr;\n      if (!headersStr) {\n        const requestHeaders = c.req.header(\"Access-Control-Request-Headers\");\n        if (requestHeaders) {\n          headersStr = requestHeaders.split(\",\").map((h) => h.trim()).join(\",\");\n        }\n      }\n      if (headersStr) {\n        set(\"Access-Control-Allow-Headers\", headersStr);\n        c.res.headers.append(\"Vary\", \"Access-Control-Request-Headers\");\n      }\n      c.res.headers.delete(\"Content-Length\");\n      c.res.headers.delete(\"Content-Type\");\n      return new Response(null, {\n        headers: c.res.headers,\n        status: 204,\n        statusText: \"No Content\"\n      });\n    }\n    await next();\n    if (opts.origin !== \"*\") {\n      c.header(\"Vary\", \"Origin\", { append: true });\n    }\n  };\n};",
          "sourceSha256": "59d4e30abc804c8d9820b589ad73ff5a0116c720385173644aae21fefac43927",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "FirstStatement",
          "effect": "binding assignment to deferred arrow function; function body is not invoked by this declaration"
        },
        {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
          "start": 3811,
          "end": 3846,
          "line": 107,
          "column": 1,
          "source": "0 && (module.exports = {\n  cors\n});",
          "sourceSha256": "b8bc70f4e18108767d1a5786f8afe3f9440a05e393d2cb00329e0f1c011068b9",
          "fileSha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
          "kind": "ExpressionStatement",
          "effect": "requires initialization/body analysis; not discharged by import-list absence"
        }
      ],
      "qualified": false,
      "reason": "Candidate source was inspected as resolution preflight, but its path is the first refused runtime addition. CJS export helpers/callbacks/intrinsics are not discharged and no FIFO continuation proceeds past the stop."
    }
  },
  "firstUnresolved": {
    "kind": "required-runtime-union-bound",
    "refusedPath": "node_modules/hono/dist/cjs/middleware/cors/index.js",
    "sourceExportMap": {
      "types": "./dist/types/middleware/cors/index.d.ts",
      "import": "./dist/middleware/cors/index.js",
      "require": "./dist/cjs/middleware/cors/index.js"
    },
    "predicate": "Both import/require remain possible. The conservative runtime input set cannot be completed inside the same60 union after retaining58; do not drop metadata, a candidate, prior additions, or reset the bound to manufacture closure.",
    "optionalClassificationRuling": "If metadata is claimed to be outside the bound, that classification is not established here; retain it as pending, not as an exemption."
  },
  "currentness": {
    "workingLauncherSha": "e16210991304372fa9e25419cf5af55e58ddd6b0a7fb1ee986e2851e6b8185d8",
    "committedLauncherSha": "d354fe9d27385673d8feadb2c353245291666b6828565816924e238c245ec31b",
    "equalsCommitted": false,
    "equalsV4": false,
    "limit": "No peer launcher mutation or integrated rebinding was done. Any prospective receipt requires current committed selected-site/callee initialization rebinding, pinned nested inputs, complete reported locks and byte stability."
  },
  "pending": {
    "original55Seeds": [
      {
        "path": "packages/operator-core/lib/endpoint-route/cors.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "4ca0838467d9b36d308b686be935897cfcc88e849ec7f5ef875dfa6bfabda926"
      },
      {
        "path": "packages/operator-core/lib/endpoint-route/route-stack.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "9704934cbed3e5954aa3aa530a426cd28d307d02e346ced88a7e944821986eb4"
      },
      {
        "path": "packages/operator-core/lib/endpoint-route/cookies.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "304d8f1e150512cc2525cff77bc5b953605a63750f1412042986f1a31cdffdfb"
      },
      {
        "path": "packages/operator-core/lib/auth.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "d8bad82d023af1c0a02a771f3f81937f96c97e5cbc7d620da98c4cd16741253e"
      },
      {
        "path": "packages/agent-mcp/src/index.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "1a8f4dae0ffa074775e91c8a8f3eee3c275ab72f8205f26d7e75460beb45a299"
      },
      {
        "path": "packages/operator-core/lib/search/query-embedder-warmup.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "d086d4686354ee5b24388d5155c3172b6adb3043c7c49c05580ef8e6dd70b3fc"
      },
      {
        "path": "packages/operator-core/lib/search/prose-vector-dims.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "38c017ef002e0fbe5784ec5cf3c1a6db1ee96238b43ea9f56db53f60affa832b"
      },
      {
        "path": "packages/operator-core/lib/adv-session-windows.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "788b5933de4d8c61454ed3f0269eee9708e6de25c04a475de82dc83287fe44b4"
      },
      {
        "path": "packages/operator-core/lib/adv-session-focus.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "921756173be621e1afacc468e6fc43f5f0b0a2715a9ad8e9f007915d25819b2c"
      },
      {
        "path": "packages/operator-core/lib/adv-sessions.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "ef96ab3237a5ec475d4d266651c37f824b465b9c6182229499195cf4ace8893a"
      },
      {
        "path": "packages/operator-core/lib/field-reliability.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "ef820e4e2b2b5e9fd7ef1c046c84fd326c737fc097b7767a78ee6e02f176fdc1"
      },
      {
        "path": "packages/operator-core/lib/sync-sse.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "3918dc6316ca7ffe4cb752b118192bcadcd8a35ad1318e9ca27c331dc15f8e36"
      },
      {
        "path": "packages/operator-core/lib/adv-roster.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "89531930ca325c75c3ceac7d5eedd07837ea8f3ccf3e34d322a1637c5d1aa4cb"
      },
      {
        "path": "packages/operator-core/lib/adv-session-search.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "a7b273a438cbb70771040e4965d1d57dcbdd3946b64094ade22b5d1e7ea2fac9"
      },
      {
        "path": "packages/operator-core/lib/desktop-window-liveness.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "72641d9250db1914c396059d66e52e282a682c76dfc83659a4825f101a8d300e"
      },
      {
        "path": "packages/operator-core/lib/windows-desktop-windows.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "649af250ed6cc13cdeebfbb49883ccd4bb4146a9b95a962b07b7e6e0dfdb5787"
      },
      {
        "path": "packages/operator-core/lib/omp-config.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "d6229a72b48582f9a63f57d3beb066b6fe78f0bc449096270a036d8cffb47020"
      },
      {
        "path": "packages/operator-core/lib/session-port/types.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "15b4e12802d2d15091f88ed14058ff0253ecce347bc212c28594936d993bf230"
      },
      {
        "path": "packages/operator-core/lib/session-port/source.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "2afafc1615dcd6b3fcd7627beb62bba8a53188c1021b49c1ae34bc0687187599"
      },
      {
        "path": "packages/operator-core/lib/su-context-size.mjs",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "4ef3b2ac671034377da1fd9dca956a72ab01aa3a3cca68f9d1696f200007cb9f"
      },
      {
        "path": "packages/operator-core/lib/session-port/telemetry.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "211d7142441c42b90de911b41ed1354850a4c3abd26ae56115cd46635d9d22aa"
      },
      {
        "path": "packages/operator-core/lib/omp-sessions.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "df66648bfdf6a4ddd8a88978e8543dfa6fc22343c290edfa2185343275ae5d49"
      },
      {
        "path": "packages/operator-core/lib/su-persona-render.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "f4df15c356644fdfc697a39bdb068fee994170ce51f5e66b5aa71723fc4dee91"
      },
      {
        "path": "packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "dca2e3daef537ec74b3a1e8d9b89cc57a0d22e5a885b9df649bda1d1676b8aaf"
      },
      {
        "path": "packages/operator-core/lib/superuser-token.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "119e5502134077907eba6f4c46165af177b9512f878564f99c1a980def866c07"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/coordination/control-anchor.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "253fc5dadc6b80393b19ca96e8da77ff81ed228128480cbe66b9f277c597057e"
      },
      {
        "path": "packages/operator-core/lib/model-context-budget.mjs",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "a799d185fb2df5937827496e9ddd0c0c51502a4803c01d88482b5f9558f9d45d"
      },
      {
        "path": "packages/operator-core/lib/role-launch-spec.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "13af4a5d114202427128103d3338a66e2218c451dc4e7e03b42c5918650f81e9"
      },
      {
        "path": "packages/operator-core/lib/inference-gateway/spawn-env.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "1c4bf7de56cbdf52f1da030cb7e02003121cb6250fcff7b4008dccfe6b10696d"
      },
      {
        "path": "packages/operator-core/lib/events/await/wake-executor.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "90b848023e709ee834ef6242f682a3924cebc6b164c2034acecb2df7d76e69a7"
      },
      {
        "path": "packages/operator-core/lib/capability-envelope/session-confinement-store.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "709df1824b3d5a4de5e43ae4ade13e4e644d5678bf20b728f998a3bda539e342"
      },
      {
        "path": "packages/operator-core/lib/capability-envelope/session-confinement-port.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "8501d39ba653abe64423adccb8d5a6903dcf0dd6067c892badf80272ee39e442"
      },
      {
        "path": "packages/operator-core/lib/cupboard/identity-activation-gate-io.ts",
        "from": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "16f49c81f3aceaad7a8fa1505dcd3ec0fb48ea0213a13f095ccfe9e47746eeb5"
      },
      {
        "path": "packages/operator-core/lib/util/cli-entry.ts",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "ed252a97da8a9144974f2d97514b22771036a628c0042f8c8d67b7666b204067"
      },
      {
        "path": "packages/operator-core/lib/agent-kickoff/prompt-transport.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "d252bfbb6a5fc16f3f0479032fcc73158408b3628153a1e39e862cce963e2a22"
      },
      {
        "path": "packages/operator-core/lib/workspace-host/hosted-agent-admission-client.ts",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "0400b3bf8ef1355de729e7582907af2951d3bae1a6cc5281d003325df2437c09"
      },
      {
        "path": "apps/operator/scripts/psu-connection-front-controller.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "7264f98d430c4d3f5bf2d0e6598dfb2ab6e7ef7a08ef56383a53ef79a8fdf0a5"
      },
      {
        "path": "apps/operator/scripts/psu-terminal-diagnostics.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "547d8f0f7d080b04f6932df8095d9267e19df0ba9d2488b10dcd75bce53ceb0d"
      },
      {
        "path": "apps/operator/scripts/tool-delivery.generated.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "bb728260f3211993e8d5c58f3e9389efb2cb7453e162efaa4f78d090e8c34042"
      },
      {
        "path": "packages/operator-core/lib/claude-resume-tool-references.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "9a8a6a1016c8208ff88f3de13405e3d90715b9fbc9fbf9c1fdb00308ca30d7f7"
      },
      {
        "path": "apps/operator/scripts/psu-recovery.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "ff19ef775c5e6bc92d5aedf13f6d47e7622486dc503121baff942ab2ad18feed"
      },
      {
        "path": "apps/operator/lib/mcp-proxy/budgets.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "935f0b61832da97743b067ce1e0b9285c65a8734fe8c94d0a0e9a6688630d661"
      },
      {
        "path": "apps/operator/scripts/psu-operator-down-diagnosis.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "ec89e72ca005063c4292d8e8c94415f2995fad4b713363ac85ab742d84f36b7a"
      },
      {
        "path": "packages/operator-core/lib/workspace-host/hosted-psu-argv.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "44d6b2a2959773b16e32a9e449b8f5083bbdb12f89aac9f5e3e18c496a2f1b30"
      },
      {
        "path": "packages/operator-core/lib/su-model-menu.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "5e1403e9055c060fb41607db60e5b5a0630a662bfe3bb73f7222c2462d05151e"
      },
      {
        "path": "packages/operator-core/lib/su-tier-roles.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "07f9d3d408f41ab4339c4687280d5a58caf289353523a1db7035b39e895c406b"
      },
      {
        "path": "packages/operator-core/lib/claude-plugin/plugin-rails.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "ef5138a75a5b992ffb4c89dc3cd18aa76bf0b11b2d717cdb1bec950982ba1251"
      },
      {
        "path": "packages/operator-core/lib/local-model-spec.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "0909919f4c719e3b9683c1e3989b14070873d2d1b7916064d9757f4a1b639428"
      },
      {
        "path": "packages/operator-core/lib/personal-vault/provider-egress.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "58987d4b4a5a29a7481f11a16d56cbd71d357454987d2aaf970eb90a08712f57"
      },
      {
        "path": "packages/operator-core/lib/schedule-descriptors.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "9b98d1f56ea88dfd90cc3a2513e932ef739f146c07a0a09e33c6aba88a604549"
      },
      {
        "path": "packages/operator-core/lib/omp-native-lsp-tier.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "7e29cba3881bd8349bd9268c0c4be66636f5d76dd5e263c70a08aa08e3d72cac"
      },
      {
        "path": "packages/operator-core/lib/backend-bin-resolve.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "4df782377b04c1f9cb03408f7792ea9291d13d0da22ee309afdf109d3d93ec94"
      },
      {
        "path": "packages/operator-core/lib/framework-install-spec.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "66da779cd0f4f6fc45f6db2b0cc727d609176523cc9cfb1695c97ae562c68251"
      },
      {
        "path": "packages/operator-core/lib/psu-launch-log.mjs",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "3898ef26514d80cce7f308988863255d086bef40286b3f0b51558d3cadbdb1a2"
      },
      {
        "path": "libs/papercusp/packages/orchestrator/src/omp-gateway-config.ts",
        "from": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "0a656d7df0591b8fe07b46242d872dd946d816da836449a938b47d3d56bf370b"
      }
    ],
    "original147Sites": [
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "27b20a395f8302ff779255156b08faf2f522645c4b52f6612066683d85223e6a"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "fa13354192ae4c36be2a8964c830dd05a8dc4e5aa7706be0628990ce9a322ed8"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "8fa5611f3058f2e089388f48d2165d5770644963263df7e55abfa030e6706345"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "4542d756bc8ca4b3862d39ffd17a7df7212304b06538a8bd4e86d87058ac92e3"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "183f59b4111194f21ae235c4bf06983241585457ad5ce9d1ea47fccc6ecdf4a3"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "cd78826aa0b92359672b11ceeb42a72f365626f89230ef5581abcd817a2640f6"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "b9823888521bab9fe5d0d3bfd87476a6927ff17acc55b3108afac4144cf85836"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "b68c666706bd852cfdd7f9772d1e4a4af9afc06b6bf8cf7432e4793e6b299e97"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "3e7779c6e5288f489b0d9b4019da2401d3ec949a802b7ccacb97e3800902bfd6"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "2e32952408ffb19ef01d9e5175d29b3b58376a7382b580ddb9208d883b49dc4d"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "f8df233f715ee4c28c9cbbbc17a3685371b6159a695d4fb3cb081c1b9a06c91e"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "0c8e8702ba6bc151f109a91a4d31756ec1045ed1d878385dc8d08e879053e05a"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "dd035c14170d38a5b1107bb8d7d5e723fcf855117d6b88c14e2f2b1cdef0036b"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "abc0ce9304199ffef51506bde413887c7313596502fd9130eb4a1752242450c3"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "3f40b7aa45270b6dfa975147585cf1f6e3bc7b87f11473b5e253e3d028a4f12c"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "d43a497e4ca9445770afe1c22db4d4585153b2dacbc57955e8be4504d153d5cf"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "e9ab99d2f66647420ae8d575fd27a84afe31c0383321644d62bc3bdb60bc0703"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "b74708634ccf399eda6d293167b7ae59623ac4b3812046fb5c50e86bca445927"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "39364ed0297d14ec31f3beaa85fc3cde771ed6f9c080e32a37b5ba6b2bf8668e"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "c3b5ef5ebd9696f00c5f106ac2322193c40f1cd8d28ee343589fb21f10b7fb91"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "c3fd6622bc032aacbacc469391d66aa85fd892a00e64b3fcfe3dda3cdce12086"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "935541107b498b42fe85c0c3d5a86bdfc73702d86005ce6d9cb92f0cce002687"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "743e0086735abb04b1157d9b0c90ed6cb35f7cc5a68405903689663c93224289"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "88f70a963ed8453f16fe1332c147e263c16d9b7b561362e4dbe499299fedf7a2"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "4367947a6ef8eca96a3df6d12c6f9d2432efd6b377cd1ccf4a7ea23fb1b472c4"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "fdf30dfef740e0a63df0f19bdce84646ded43bab504a91207c87701094adf89b"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "3b83450f1b5aa1c1ab3a49b74acd367dc6666bd53b1bc64b70e41f2e458e1e74"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "2ac399ed8307e539234d27156a8eb45052ad9778527d98db68c56e3febffa08e"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "0f86affedb054343d856a30fe08caf3399a7645e4cb128d2e7a6b093d47588c0"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "f612ba66610482fc2aeaa78d021599571f11dd618b5e96cac4e60df06f3f8cfc"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "304ffc231e46afc8ed277458dee0f3263037ef25146bbd67c747975c02f916f2"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "95e97d3461e6fba4fa7ad0244f734269f3c03ccb9d414d5673edf89ac54e47b4"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "71ed22efe9982e9bfe12854938bf91e2fdaf342320e6acf76e29cdaa80c41d55"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "2127da8349bae127b35101f1d0ce77ac912998f950633bded5a7fe001ab6f3dc"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "5373421d7d3858cf7a5da8dec486c8eaf2974c0f6627a0fbd7bf7f91f4dd6937"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "273ee732fbfa92c6b32bb62305d710f9104d53fdc8048bfd37dcabfe47bd44ac"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "0be548f14b4a2a663e5ae75421027cd1408edb717e3b3a716afcfb1b021abe7c"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "a9fc9d648a4c5f991f394c18f99283cbb34ca9e3eb2f3ca59a22751a34b64ccf"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "bb0360876ce4da1c3d64cb1bc02cd2248045c419d86be0d1871dabe93295840b"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "a721130953e0408bd92405bbaeb948ea51df44d9376c0e9c30c8ce1ad05c8f6e"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "ccad4042e3a5256fce8f0c59f854b20a94675629438bbecc9367c18257da3aee"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "4e149de158cb48269d33493051cc6ea8b5c3bf180635c091ec9f680144ab63cf"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "f31bc95d554dd68fe3a2a5a37454e63975b6e7e05119b527ab0cb485e2b92728"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "cd1df393f8882898affa2405131fc068e3039dd750711826ebb5d66061adbb6a"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "dd3f7b50bebf7a2c67c09febb33f99a83f9b05c2a4cbdb50e5da8b9bd15ae7a4"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "36a95bce87b0dea60ed665882e1a55124c2516db468224b4be087d92f7cdd5aa"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "ca5e068861feca3cae8772b3f43b4f6b4146f594287a1c1055ef5080db935224"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "6b6f97b5818612d6fc1bd81ed3525322afe4c0ba3df4ed54639c8bedf752588c"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "7d7e75515360f2e84002f404efe5dc434a2aaf7996d587d010ae557b05ddef10"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "e133e3a0bc0bb091db767d2bf39c5901a1f92b40b045e3eca35806f27d973b6d"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "e65f3e8bf80b0361ed629e37e1b76458fa0f94a45afff6f16d2ae95d9a287360"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "cac0782c7e9ad2fc747946b26a87a32b61b5548f139216cc6959ac5d3bfe39c9"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "d756690b77411833d51ba367f29a90ec3a3e19d4edff1f76ae67d8cbe4d1f75d"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "4d5f1f2ce0bddf12052b87ae3c9363dd31da8e773552b6b3450d71031fdde12c"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "60ee7dab1d37d8f533ba23e2e902ca75dcb4e673c52a934ec88a7b75ec123571"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "3aba273c769e86f51f5c1f7afc3b0bd588caadaa4b8fe178dd0de4473bd03ef2"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "a5030a490c5269293b2f3d8de20d2166e629a35f8cdf2cf328850ba8dc4b881d"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "ef060e09faf5eebe8fe45fb7ed548d212898735eb98413f975e914049ba0a2c4"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "69da2e823be5bf595cce168d01c259cac4e14da3954d653bdad8819161cf54fa"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "23861a3f7e91f15d65e31a577097883617f9240740525d7b19e80a1178061332"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "a9685b2c00626dda9c837e2387f2215f27234b4cb384efbd358a5629bcca2c92"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "3d1c3bc3e6cd9090becc8403e04f0c2814c7f99e1e7dc058124fe92c289f3dc5"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "9da38bc40717e35952f18225556938b2fde6a53cff830961fbed4bd98afb6f54"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "322635e18c4aa1a00ecf00d37a3ac23571eaba252e07b47bc6011bfdefc36d9c"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "93ec1b0fca7ebad19aee262a63f2ddf2d2f8e045ba4d252b14563bb72a863ec6"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "3e7314e6631d43a4153d70728a1b680dee3994b3737b4486cc10209ad95e2276"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "078ec91082472dee62490ca4b67cb586fb90d0eb3806fe106d09d319f2959725"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "5dc209e50eaca3b67c4797cf76e646f291838170afdcc10328f2ffad98d9b112"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "0bf8d42a102ebd1a7f54f126b2cfbaaf74688f1d8d594f108b1aa8d86e46c611"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "63ada31da2c89de7a3e46980dc37f57d5658523f5e54dc847d8fccae4781110e"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "bfc2e5399a13a780a204f615ee1bf2aef36c8d5147ef871e64713c55f6207574"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "25fbad132ddfa07fdaaac932efe45379088672a1302dc4c429bd1eb25b140146"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "82353d95b6538782afdf8bd60078d88127549b98c4982048dc86fafb12e42905"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "5fcf032ebc35a5dc109a045876eb7ca4140c03b56f903a0664880f268d361446"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "5879bf42c375d5f844b3dd74e0cf18ffff86f5144366414e3124e33cdfdadf7f"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "7519b2d77d6d54b04347f6a46fe1548afb4e227226694f270c0dfb4a6d7ad88d"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "f731dcc1e08eb44d65dadf0eebe8c7aec8559d765b462b0c16c85d5eaba1b330"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "d461888ff596cdbde4e5dec986fd43277afb7258ac09e8caa3a9f4a7dbd50377"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "836aecc1f288353ba35180a0e67b8835f654c075d26cc2aae826ce3dce1a96a9"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "2f67dea3fd27848c0df0f64c8a38983ecd484f0a50b76d971afefd8ed740ca8d"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "dfd45879aa9c3069fd263fa81518a967b7fdfdcf4c73f4a6a5e452ad2d772cdb"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "a084581c473b48d799d75902a4c1a40d61ff2322222bb73127abc1c59518530c"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "8337b4457bdbaf584304ba3ed02cc2807c9b8140f0ced5a217250840359f2223"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "9f8a31eb7115aa40c93e5e3da9e2e486975394b8f1277ed84f4378b3d9e5f341"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "7d54667f18a958cb1b382f1a9d912d398c43aa6e84932da6781d29ceb75c2af3"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "15c886c0476b4e00b06ae9a74f5f207f3d1b1fa7d4b60706b7deca655e32f5f6"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "8b38ff429e1e110efc4a2e3dc833dc7b7ba03483aa958513c851e6833eef3609"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "47275d2a26dbb49743a7c244e08115ad188126f6913ff0016caa95d3ab515a5c"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "03330eac66335e64c3c03009e5137e05e35d15dc0a6bd7dbee9ddd1a21826a86"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "e233a8a614d6c729999d48e9317c49df213c633a19232195a0e64323705fe3b8"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts",
        "siteFingerprint": "8b217e84ab44993bdc0328fd76fb465bbe98aa26faf9a01849ad7d6a01c6219a"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "a6cd4a4fea9b700499ab336717833370c781857ac5ef1746a2fa7c2125b6e7f1"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "563067d11105ca07b670ef70fc668005582c1885baa9b63c9b9283fc09987279"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "82e6ec692b9f1c136f209df69bb4e0f1ca58a681a36439cac3654e367b0b4e3e"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "bf7c4e5e42f76849b9f3c1640153cc509f7358a35a79ec6c894356a4898f296d"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "52fb1c6d19dd6b61f953013e2d86b8b1cabc3c6fa6440283207a6677d5b07788"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "d4bab7e347d391f4915ebc1634f62e43a5e40c6e6d5e27e11e2d0635d3d88e46"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "a7ccb9305df97486f63c28f403d678449a2e399d13d7c37c7af8df2e4b0ec862"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "14aed7d67a69edd5d50c9a54babff1dbb9704e5130ca233d0acc0b4ae231d8ef"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "780b1054720faf0dadefe49e70944a39d0bd0cefe96876aebdbb981eeff0040d"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "9adf98ecabbfdc9836a4678a663633c0d9de96fa729f73e989d3afdef187a076"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "73ebf1c38ec1e6395743f47ea69d19376e85457f9502f666294c5ecb2eb892f1"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "37a71ca7c3ecea307bea863e1118e40c4d2b7bc537f48c83cad2205ee1307ce8"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "ecda83e016e2e52c45fe402e1a31688df5a5cd75e8cffbc937adfe981b1687c1"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "f18e035620d6395eb29b53847471d9d6800071593f0b2c4a997329385d712f42"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "f1a568e7a46559e1e26dffdb3dcfc02c94f72961e4450e5561b29bb4e4bc2009"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "240a19f2a3d9ddf6f968b2218438127795639ea736c3b254fe8cdb9268281075"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "4edf77449be29afa6c32a4f631c1f06fcba267f262a93d71315066ae5db79677"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "548e73972da526c6e0f880debc0e17804d24953d3b1623443bec3c2453974041"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "cc6fa164f2dd71664240d55b0cfe148f6b2ba80f891aa5a31cfd1308c65dbd22"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "d2189ca64a70b97e9a69b9fc07a7128b354fa91bcd1121317147293abc8b200e"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "cefef3505f839762a16ddc71f14c17c1bedde44cf7cec6a57381a59d207f025f"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "f1b60e058dd8ce2b20381a26024ebda10c7c1e2795fa39cc123c412217d2af62"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "7f3a4f04f6c63a297ba2dac379b40effc4c15a22ef3be84f743bea1cd581d967"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "37e96b79aa9a521a5c4ed1f4cae3169ee40d7aedf7ef777bc630f96605988645"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "0bdc7a52963e24df2df6b046c0df6be3cf9965341bfdd6f29575137698f0e33b"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "54f735ce7a8526d45f71b206f9a09a9181b4f14030bd56e8a0e4a2ed2c6a0563"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "1ef8f95058670391735aeb7b2dc80f35d7a3381c73631fc32ba9bb261e5f62f0"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "76b5a7670fa51c35d929a8455e5287dbec251fc383af9909aa332dffb1478503"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "b1df237f8ccb7c65578eb92f1d2b4c2f311ed87281cf1fb7fefe5a3790893962"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "dfad20eac73332a33945ed9bd20e6469571be57c2baf779c2dc365afecde814f"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "2e1bb01ba665ba89ae0927e94c0848aa8b50b025a358408d7a89f34bdb58404c"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "3f3dd14a4444d1be27e2b61b29f6c329ba34af2455bc65e9d5247fcfa6d4efdc"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "4e7a08d57f6cf353157e760f31d90090490e6a6c3b3ce9a778b981f7f57d653c"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "fa06ea956b79d532253296c6fe220508c530f561ba004b21e58bd3c1f5618186"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "29f0af61ce6caad3ea986df6e00f37e98e3f0ae86c29e3fe3fe9f25eac53f139"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "6b5199890fccf48d8b4feb73d1066cc36fb354993018cf8d2b421bb64d39197e"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "d42b85660d76b51cf2418289211b21319c6635cb3555ca7fe25c3a7f29a62a19"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "2aca39d7cfaebaf432d3b93883cdb9abb6fed8bdb08f640acc6061386efa1804"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "00928d545536f371e88ab0c6c5fd665e63dedfade0f94fa3b18e134a39600b3b"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "9ca9973f51ee2a5731575432a56785fe673d436e839015c5287998d0c48522b9"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "53e6aadb6f91406ae25f846a6f03b70c2d3c7c8243c74a07c1979c8878243b36"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "854864ca373b2e958195c026bce1ca1539906b4a44b32f8d40ab024d91d72417"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "07576104ce767d6c86eee9dac7ed02943f46e36d0c03a9e9bf938bf8d804995f"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "34312a9a2f106420c38cd6837c98b72a38556c054b25b29d90aa4bb0177de18e"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "ed5b9c83c446d985dc5cc23254034e8531bdf0ca0b9c56b74e294e112aa0dd22"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "abb5b4e968c9bb112a66c88ab5bbd06ef71397cd70e0891f9e8dc9c826cea31b"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "8d5d7c2bee1c3c26338a648ec46b6192d44e592c093cf31d98cafe9c02c567ab"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "3a3c9e25b5ce2079da13d962057778f33c9d6348c40ddbd43bf6468f7ebcfb20"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "98fe8cecffc7adf4e4ff42a4ecaaf4a22208d5f033c776d9c565101d72d48a7a"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "c589e0a51bd58a60969ab0195723949dd2db98ce167b478f0184ae2dc11466e8"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "e9db962238a0fda0830ef6abc2f13a62942d8b8e7253bc5c89c264ff9d82cdd9"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "3590f116fdf4d6de9ef91f9550940375d98b5e29eb95f110e8e2920b6c53c69f"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "0351ad7c9584c196e306995f778e5d610503c3b1b2d6219bb63112329b2056e4"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "118230201cd04635947d87b520e76915b2ecd06c5341debd611e2b0a129bc0dd"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "38e503537769deae05c406695d679a2c0e2310127d11c949fe94f1ce38935551"
      },
      {
        "reason": "callee-or-callback-runtime-coverage-unresolved",
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "siteFingerprint": "15cf9c09fa18134d3ddabacde71efdb849eb467ffe4a95f7969a40581b542cd7"
      }
    ],
    "originalHostInitialization": [
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 0,
        "end": 80,
        "byteStart": 0,
        "byteEnd": 80,
        "line": 1,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "@papercusp/host-platform/home",
        "source": "import { papercuspPath, papercuspPtyPath } from '@papercusp/host-platform/home';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "d0474db483323acbdac9b6db1deff751f9e53e93ec761764b9c7db155966809a",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "19dd00fd39bb2a360ab7a84c3cb90dbe3851f9156f09573185de0a4faa46023d",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 2530,
        "end": 2574,
        "byteStart": 2540,
        "byteEnd": 2584,
        "line": 42,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "node:module",
        "source": "import { createRequire } from 'node:module';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "d36c2fe7b71bbb58931d680a02545c0039b3859e20be60775ac7f6ad6feba172",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "913a57dbbfc8be28932075d6a2d4a702d8cac0ea6d4a8f5130674166f7b21c2a",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 2575,
        "end": 2629,
        "byteStart": 2585,
        "byteEnd": 2639,
        "line": 43,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "node:crypto",
        "source": "import { createHash, randomBytes } from 'node:crypto';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "608583c43b94f4329bd1492b34ef3a98c8762b0c66ad3c02a3ef69c7d60e74cd",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "03db4c242ef9481eb86c842592810228259d111d125cfbc4bd67cdf00fb3aae5",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 2630,
        "end": 2690,
        "byteStart": 2640,
        "byteEnd": 2700,
        "line": 44,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "node:os",
        "source": "import { constants as osConstants, homedir } from 'node:os';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "267d40ecc39bc1d7d3c7eb38d0c461b4c1d9a8eb5510224eac682162c4a206f6",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "d3780e361bc91cc54c709610a89dad5c2f7223f0ba71b6b67b09a8974a370ff8",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 2691,
        "end": 2774,
        "byteStart": 2701,
        "byteEnd": 2784,
        "line": 45,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "node:path",
        "source": "import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "596ce2ae8aa9ad136a251766dfb1cb36953687872b690d4a6452d0358c90ffde",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "89f058c7450d3076ee00487a43f110c5b9bfb953c840ad3113f3aa57c51a9b66",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 2775,
        "end": 2816,
        "byteStart": 2785,
        "byteEnd": 2826,
        "line": 46,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "node:url",
        "source": "import { fileURLToPath } from 'node:url';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "9bdc8db677e168091af592f6ff057a4fd2bc1e373d4739278aedbac085952e79",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "c911664f1383262f472f293bf37442ecc966e75f7783f63641e87892a5d649c8",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 2817,
        "end": 2860,
        "byteStart": 2827,
        "byteEnd": 2870,
        "line": 47,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "node:child_process",
        "source": "import { spawn } from 'node:child_process';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "5dc268da2fb7715f7ad3af027cf4990a59ac1976db317d49fa8f38a99d312ec6",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "ac53079c057b392682a02aa85a8a87720531c97cbf92c65c12631b2343b94c01",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 3009,
        "end": 3164,
        "byteStart": 3019,
        "byteEnd": 3174,
        "line": 50,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "../../../libs/papercusp-shared/src/agent/model-capacity.mjs",
        "source": "import { makeModelCapacityDetector, modelCapacityLineMatch, modelCapacityRetryAfterMs } from '../../../libs/papercusp-shared/src/agent/model-capacity.mjs';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "d4006f11ed6327d8295c0679bce14336f8ff46c592ed029446fcc148f02c3349",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "a877d88abe05bf15f373fae25f42f5e7da12de8ccf3de4e98dd02952808e8577",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 3165,
        "end": 3271,
        "byteStart": 3175,
        "byteEnd": 3281,
        "line": 51,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "../../../packages/operator-core/lib/psu-launch-log.mjs",
        "source": "import { isCodexWorkspaceDiscoveryTimeout } from '../../../packages/operator-core/lib/psu-launch-log.mjs';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "958c9cef91893413db3521f310d7e64fc95bf7a821a85722d24dfc6311c7e257",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "ea537842397b06f93943c7e5d854b0a2b37f9a4f6e482d0da10aa1513f128028",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 3272,
        "end": 3376,
        "byteStart": 3282,
        "byteEnd": 3386,
        "line": 52,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "../../../packages/operator-core/lib/control-plane-temp.mjs",
        "source": "import { controlPlaneTempCandidates } from '../../../packages/operator-core/lib/control-plane-temp.mjs';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "e0784d8ce4baa723d498b7433e1457e56d75baac79153e903cbe862a66ea1f22",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "d78734f80a6b194d9f377e302d6a869a4244b985ced065a248adaf8869375863",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 3377,
        "end": 3514,
        "byteStart": 3387,
        "byteEnd": 3524,
        "line": 53,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs",
        "source": "import {\n  AGENT_IDENTITY_SPEC_ENV,\n  stageAgentIdentityTty,\n} from '../../../libs/papercusp-shared/src/agent/loopback-identity-tty.mjs';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "b0d72de183a3f4407ae22355693528eb94c5e5008ee50b3736d2699e3638cfd8",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "1949162a09a20bb5eedf836169dc9229ac5a5a9d2c19966371cfdff556e10f5b",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 3515,
        "end": 3847,
        "byteStart": 3525,
        "byteEnd": 3857,
        "line": 57,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "node:fs",
        "source": "import {\n  mkdirSync,\n  readdirSync,\n  writeFileSync,\n  unlinkSync,\n  existsSync,\n  readFileSync,\n  readlinkSync,\n  realpathSync,\n  chmodSync,\n  renameSync,\n  appendFileSync,\n  closeSync,\n  fsyncSync,\n  constants,\n  fstatSync,\n  lstatSync,\n  openSync,\n  readSync,\n  statSync,\n  writeSync,\n  promises as fsPromises,\n} from 'node:fs';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "f6a2d7817cbd9af44b015173f7b403a6956be8e6566464d419389fc35bdabb9f",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "d4f0ddf5705d80e61ddb381a12a808b256eb2167f0cfbdad401eaa5527cda2e8",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 3848,
        "end": 3875,
        "byteStart": 3858,
        "byteEnd": 3885,
        "line": 80,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "node:net",
        "source": "import net from 'node:net';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "e06fe82ba81af34c4f52debb36bebd01f78aee00a7926a01dcad61f65ff10a7c",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "2528037a3b803969f234c5d47aa781898b6ab75743c15ce510f1a37f1601da78",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 3876,
        "end": 3941,
        "byteStart": 3886,
        "byteEnd": 3951,
        "line": 81,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "./psu-terminal-output.mjs",
        "source": "import { createTerminalOutput } from './psu-terminal-output.mjs';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "29e1bb5bc63d92591e50efa5aa78462f8fb4bf3f15f7ea961c817bf3cd81a8f9",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "7c633f7080f3467946f73ef6022aef67543d6cf653a09dd1bd9d1cfc64ee928b",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 3942,
        "end": 4006,
        "byteStart": 3952,
        "byteEnd": 4016,
        "line": 82,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "./psu-carry-fence.mjs",
        "source": "import { createPendingCarryFence } from './psu-carry-fence.mjs';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "4a6943e74a51c7a464a19649fa8058fd576e1082bb16177e647a87dc053ce119",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "3d9b0a2f19b76f88f6def79124b770c95195f3d593dd226566e1ad6f9472bb8f",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 4007,
        "end": 4091,
        "byteStart": 4017,
        "byteEnd": 4101,
        "line": 83,
        "column": 1,
        "kind": "import",
        "typeOnly": false,
        "expression": "import",
        "specifier": "./hooks/cc/dialog-answer-provenance.mjs",
        "source": "import { observeClaudeDialogWrites } from './hooks/cc/dialog-answer-provenance.mjs';",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "f61862c1f747e2d94113e7681a698306cf3eac857cbf06c72e7c9bd36aa3953f",
        "binding": null,
        "calleeCoverage": null,
        "sourceSha256": "5dbccb9e3090b8d7f92edb4058877233c229841a2b7d3f17918976d72bdcd71b",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 6219,
        "end": 6249,
        "byteStart": 6229,
        "byteEnd": 6259,
        "line": 154,
        "column": 17,
        "kind": "call",
        "typeOnly": false,
        "expression": "createRequire",
        "specifier": null,
        "source": "createRequire(import.meta.url)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "563067d11105ca07b670ef70fc668005582c1885baa9b63c9b9283fc09987279",
        "binding": {
          "imported": "createRequire",
          "specifiers": [
            "node:module"
          ]
        },
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "4506161869017b711ca726ab9062e3926fac759a584ad0e460e825635a24fb53",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 9585,
        "end": 9624,
        "byteStart": 9597,
        "byteEnd": 9636,
        "line": 227,
        "column": 25,
        "kind": "call",
        "typeOnly": false,
        "expression": "dirname",
        "specifier": null,
        "source": "dirname(fileURLToPath(import.meta.url))",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "49f5ae82dfe7e7d163184c1d4a32d475985c03c0b1e6ea84925bab2e7918d24f",
        "binding": {
          "imported": "dirname",
          "specifiers": [
            "node:path"
          ]
        },
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "fb7a7a3f69caae67819e30e84b8aacec36951aabd51fe707dc090503411d5b26",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 9593,
        "end": 9623,
        "byteStart": 9605,
        "byteEnd": 9635,
        "line": 227,
        "column": 33,
        "kind": "call",
        "typeOnly": false,
        "expression": "fileURLToPath",
        "specifier": null,
        "source": "fileURLToPath(import.meta.url)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "d98aa4feb44288f202d80105fd166f09dbc10048a636f0ef2750fa106c833deb",
        "binding": {
          "imported": "fileURLToPath",
          "specifiers": [
            "node:url"
          ]
        },
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "fe09cb02231e621974446e011a4bc12ce81eaf34a3d663aa102d6b1c60e41586",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 9814,
        "end": 9844,
        "byteStart": 9828,
        "byteEnd": 9858,
        "line": 231,
        "column": 26,
        "kind": "call",
        "typeOnly": false,
        "expression": "fileURLToPath",
        "specifier": null,
        "source": "fileURLToPath(import.meta.url)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "b37f440cbba45b3cb1d52b1cf796dc559964934d55c36f96df6f05b74644384d",
        "binding": {
          "imported": "fileURLToPath",
          "specifiers": [
            "node:url"
          ]
        },
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "fe09cb02231e621974446e011a4bc12ce81eaf34a3d663aa102d6b1c60e41586",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 9875,
        "end": 9916,
        "byteStart": 9889,
        "byteEnd": 9930,
        "line": 232,
        "column": 30,
        "kind": "call",
        "typeOnly": false,
        "expression": "join",
        "specifier": null,
        "source": "join(HOST_SCRIPT_DIR, 'psu-launcher.mjs')",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "ea655464bca0b3dc4f05d84e8352465950ad3c65abff61f72964d9f5f947e09a",
        "binding": {
          "imported": "join",
          "specifiers": [
            "node:path"
          ]
        },
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "c180d3bb2a5b1f0331a7926f0a3ee89cabaabbe581340c297a97ebd9835fe8d1",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 11266,
        "end": 11282,
        "byteStart": 11282,
        "byteEnd": 11298,
        "line": 256,
        "column": 57,
        "kind": "call",
        "typeOnly": false,
        "expression": "hashHostScript",
        "specifier": null,
        "source": "hashHostScript()",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "e3216c371c2d78f2b0b28a7194759475cb064f66b6ed54c733cc4f9c71a2df6b",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "39a841b3b50bbe5e3b16eb4ed28eef1807d80c94d74eca776831858629295b1b",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 12449,
        "end": 12485,
        "byteStart": 12465,
        "byteEnd": 12501,
        "line": 290,
        "column": 54,
        "kind": "call",
        "typeOnly": false,
        "expression": "hashHostScript",
        "specifier": null,
        "source": "hashHostScript(LAUNCHER_SCRIPT_PATH)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "c1527e41eb3ccf6c6da56ae4acb410e7e96a4637dc0d4d1644b339e905661bd7",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "e673ac59720bc89ff0e48e6833465ebed1f524476edb86c43e6cea2daf238f3b",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 23444,
        "end": 23462,
        "byteStart": 23514,
        "byteEnd": 23532,
        "line": 513,
        "column": 28,
        "kind": "call",
        "typeOnly": false,
        "expression": "papercuspPtyPath",
        "specifier": null,
        "source": "papercuspPtyPath()",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "9de16904d0a21f47415128820e31d8a67d08392e42da42e56366a4f68dba40c4",
        "binding": {
          "imported": "papercuspPtyPath",
          "specifiers": [
            "@papercusp/host-platform/home"
          ]
        },
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "d4caeb85d04e2fcbf28b9ea30ef2382c03c3776edd2e1df4697535deed4e2c5f",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 23710,
        "end": 23755,
        "byteStart": 23780,
        "byteEnd": 23825,
        "line": 518,
        "column": 25,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_IDLE_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "26a2777fe4b1fab9df85402b6839c9ede47b9f102497c4a58d4f959cfa580c7f",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "8248c07c696867d92279a291f464a080a176335f6c18b489bf5a8a2d05017487",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 23955,
        "end": 24004,
        "byteStart": 24027,
        "byteEnd": 24076,
        "line": 521,
        "column": 34,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_IDLE_CAP_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "43efb6aff01414dd0a831b6bfa5dee9e451e1cf4447f61bcc6c0a608f49c17a1",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "d50436000a1e8add8e45705862aa13cd1847bd73d6a9d2aaef6ae5e3b254a794",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 34142,
        "end": 34194,
        "byteStart": 34220,
        "byteEnd": 34272,
        "line": 744,
        "column": 38,
        "kind": "call",
        "typeOnly": false,
        "expression": "Object.freeze",
        "specifier": null,
        "source": "Object.freeze(['reset', 'recycle', 'carry-respawn'])",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "3acf6f6a4cc7eb66c57cb14d1c5eb07bd507eedd6f7d17698ebbacef07709300",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "b13528a6ea22ec53da3fe5445739f1bd8ee8fd90057a373abba918ce49c24160",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 64352,
        "end": 64448,
        "byteStart": 64486,
        "byteEnd": 64582,
        "line": 1349,
        "column": 34,
        "kind": "call",
        "typeOnly": false,
        "expression": "Object.freeze",
        "specifier": null,
        "source": "Object.freeze({\n  codex: 'CODEX_HOME',\n  claude: 'CLAUDE_CONFIG_DIR',\n  omp: 'PI_CONFIG_DIR',\n})",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "3f8dabf1a87dedcc2671999eda849b7501155f99ed68ecd906e59eaf5324fba7",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "2ed001fcc88d3437ffb119d48733b65ec099e3b7ad6b34bebd9f124ac30ac86a",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 70685,
        "end": 70812,
        "byteStart": 70847,
        "byteEnd": 70974,
        "line": 1473,
        "column": 37,
        "kind": "call",
        "typeOnly": false,
        "expression": "Object.freeze",
        "specifier": null,
        "source": "Object.freeze({\n  codex: classifyCodexTranscriptRow,\n  claude: classifyClaudeTranscriptRow,\n  omp: classifyOmpTranscriptRow,\n})",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "c78b2031d925fcb11e7cdde72a8eff0f7e5db9993d3f41e5d8d9bf369fad8cc0",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "125d1698c62b07c5867f71f4cf6be5950ec3ea7a51c846555fd060d102b14a21",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 94291,
        "end": 94357,
        "byteStart": 94457,
        "byteEnd": 94523,
        "line": 1971,
        "column": 38,
        "kind": "call",
        "typeOnly": false,
        "expression": "Set",
        "specifier": null,
        "source": "new Set(['AskUserQuestion', 'ExitPlanMode', 'request_user_input'])",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "90fe0c3610e6983e4b8de05259a8acacbdcd4259c22cd879e607f110a42d5398",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "107f363ff1f4116ee758c421047ebc3b9a744dbbb5f7c814ebfa9fa1ac1ad86f",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 118355,
        "end": 118413,
        "byteStart": 118533,
        "byteEnd": 118591,
        "line": 2512,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLL_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "0f0d7532253457319176e2af38cb2db33c18c974a6da8afbbe3f7026440db98f",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "8ef6225ebbe90f273bdc6a2d8ff0ae14dc9462a77f6b417d6049b557dc7a16f1",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 118457,
        "end": 118746,
        "byteStart": 118635,
        "byteEnd": 118924,
        "line": 2513,
        "column": 34,
        "kind": "call",
        "typeOnly": false,
        "expression": "(() => {\n  // NOT `Number(...) || 6`: that maps an explicit 0 back to the default and\n  // silently removes the kill switch for a path every fleet launch runs.\n  const raw = Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS);\n  return Number.isFinite(raw) && raw >= 0 ? raw : 6;\n})",
        "specifier": null,
        "source": "(() => {\n  // NOT `Number(...) || 6`: that maps an explicit 0 back to the default and\n  // silently removes the kill switch for a path every fleet launch runs.\n  const raw = Number(process.env.PAPERCUSP_PSU_PTY_KICKOFF_TURN_POLLS);\n  return Number.isFinite(raw) && raw >= 0 ? raw : 6;\n})()",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "bb25aae57d7cbc33a3c47ba5fe37f399be2ce470e11aca45e5823cd95a907ae4",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "92c8a6fbf417e969821a0f3d63b9b31d020a9795dbb2776c282215f2b8f6d6e2",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 129655,
        "end": 129705,
        "byteStart": 129835,
        "byteEnd": 129885,
        "line": 2734,
        "column": 33,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_CR_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "fb3a93173bd65f71036a2844e8e2967d3601c9a056046585683ff45b06049894",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "9ffc92a5fde1b1d57af4b74b5169a6159e3cba9f01fa89a9c61de15239fe3713",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 129961,
        "end": 130017,
        "byteStart": 130141,
        "byteEnd": 130197,
        "line": 2739,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_CODEX_SUBMIT_CR_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "f260e2fbe07b62a3a1c59aaaea6821964e3165e2e1c0f9f04628fb0dbfd1a54d",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "d053a577b8efd0a1f1b0879a27cecce8d823f3f34dc0e013e082ecff285af98c",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 130314,
        "end": 130372,
        "byteStart": 130494,
        "byteEnd": 130552,
        "line": 2744,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_CODEX_RESUBMIT_CR_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "427a8bba0d3606af95233850b7f6ff812fc5e107d87fef9335a86b9b946f4ace",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "cfd1ac1fe4938acd1f8a515784970c967ba7575a7b4b296cf8e3ea5f582da35d",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 131959,
        "end": 132018,
        "byteStart": 132145,
        "byteEnd": 132204,
        "line": 2766,
        "column": 31,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLL_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "ba5a68047ee00a15181db901783f1643085cfe4c5b0e3de396e8e2d4be211296",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "3e7d70b487bd2da3a0d541ced15b98b06b0b4697618a04bc2ddee17cc47c7e7f",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 132057,
        "end": 132114,
        "byteStart": 132243,
        "byteEnd": 132300,
        "line": 2767,
        "column": 29,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_POLLS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "5bcab15bc5149095f57c653cefa942ba99c59baecea0a8cf34c1d06464f43d93",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "c50d8235807a5e70d6d0510775fad89a49045b3460fc7295ba63f861f40db55e",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 132157,
        "end": 132215,
        "byteStart": 132343,
        "byteEnd": 132401,
        "line": 2768,
        "column": 37,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_MAX_CR)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "e49dcb5e872b3107383d99f299e0bd27915f0e60b8f322c59370b170a1646dad",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "25e4b3664cecd46819d78ac02cbb4e12ad4d03e6156232cd6b7250dd3e03ceba",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 133532,
        "end": 133592,
        "byteStart": 133732,
        "byteEnd": 133792,
        "line": 2787,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_SUBMIT_VERIFY_QUIET_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "1f45147c08482ddd838c2032a79b73dd6b9e33175c6377faf1f803eb53525b58",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "8561a57b5000736198ae726a125b53cb77c246eaaedc9bcd5eda780a5a63dc3d",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 134830,
        "end": 134883,
        "byteStart": 135040,
        "byteEnd": 135093,
        "line": 2804,
        "column": 25,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_OUTPUT_QUIET_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "7d2d7d9e3633e653e81d3cc545cbb8461516c820a4ef6e81c449603336ce275a",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "99679c143cebdfb67507eb5c48e064708548ca489282c34a5ac508ca956fb33b",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 135418,
        "end": 135467,
        "byteStart": 135630,
        "byteEnd": 135679,
        "line": 2811,
        "column": 33,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_BUSY_CAP_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "d347fc67f2f11ad791dbc12701f4759f1483b1dbaff7735f0da3e0939e72d51e",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "ed96d89affe0cc16d5424003eb4e8160ee97f9b83dfbea0ac70659af674930a5",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 135896,
        "end": 135949,
        "byteStart": 136108,
        "byteEnd": 136161,
        "line": 2818,
        "column": 25,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_CLEAR_SETTLE_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "bc16d473c4f9600c96fde8c2e2158ea957271faa8312d029cba141d51568f34e",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "a64db47a96842a2bf85aa9a81822b33af0dcfb23ff9d75388d2fdb1a50fac9be",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 136224,
        "end": 136277,
        "byteStart": 136436,
        "byteEnd": 136489,
        "line": 2822,
        "column": 33,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_KILL_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "54994ced70401c28f3077e66c988ff80314a4244369d25fd7e23ac5d7f715f8d",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "5764406090c8d6293402e95a5ad794a0649c97bc939af18f79203269b4d3c581",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 136481,
        "end": 136545,
        "byteStart": 136693,
        "byteEnd": 136757,
        "line": 2825,
        "column": 36,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_FORCE_KILL_WAIT_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "8161d3d4b87aba4b5686f5fa7a1e4196effaac3ec13699bdf9e1207b55f18191",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "4431e9d4da5ce4b72859c03a059c5d81572faa40b4267929ce586fb385876ba3",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 137026,
        "end": 137089,
        "byteStart": 137238,
        "byteEnd": 137301,
        "line": 2836,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_RESPAWN_REPORT_TIMEOUT_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "1e7bcdb4b3ed42bb00a74b548ed438249c62371195b72e818b4ff27732b35260",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "cab67ad7f4fb00fa69b8d6a741c47e22375fa70ab9b4cb5f01fd4ed6fb1ae5c3",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 137688,
        "end": 137749,
        "byteStart": 137902,
        "byteEnd": 137963,
        "line": 2846,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BUDGET_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "dcee8c8d8d291f6d3003c09021a395a9069707eba71b61bdadf4ca9ea01ce3ba",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "03145cfa45e14e3eebffa7947b5cb22e61f5e89f7b3a0b0e481f9db917d2dced",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 138004,
        "end": 138066,
        "byteStart": 138218,
        "byteEnd": 138280,
        "line": 2851,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_RECYCLE_CARRY_BACKOFF_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "5912b56d208fdf67ff42bc0f274652134e753a7d68b953a78d86f6043eb02f10",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "a8b2d3c391cac676f209461ebba518a01902ef5c9a3d6a7605b107773f85fac9",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 138769,
        "end": 138837,
        "byteStart": 138983,
        "byteEnd": 139051,
        "line": 2861,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_CODEX_STARTING_HOLD_CEILING_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "1174ff601b4d8d7cabb99836bb45e13d7311c4aa196e096a35988e82a57f636c",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "5a579e2e64c1a900a98c33e6a052a6b3afaa6215af7fa86fe22e8d6fe749fe7b",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 139789,
        "end": 139856,
        "byteStart": 140003,
        "byteEnd": 140070,
        "line": 2874,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_CODEX_CARRY_STARTING_STUCK_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "0c6c27d321fd9e120ec123c85bcf485441dd55525fdb74ecc4bdb25aaf20f11f",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "7f2c517866a5e71da808ae5d0b65b4ff4be83b92b3b24c5aa88dedb19eb9ad44",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 149508,
        "end": 149572,
        "byteStart": 149722,
        "byteEnd": 149786,
        "line": 3073,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_STARTUP_MARKER_FALLBACK_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "5670fb14f737ef718fc6aa676e62e1747f3b2225c857d77d104e945a10404020",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "209672012fed3c6cb90b1fcae7869034949673b1a7024fc8e360baaca3e000f2",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 151414,
        "end": 151472,
        "byteStart": 151647,
        "byteEnd": 151705,
        "line": 3100,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_INJECT_MUTEX_WARN_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "e163c320fcc72986f486671c3e9f37ab4d4c5998c6d85bb077fd3a919cd099e4",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "400bda92953bfbe5ca2b127964e3f924f11fd78ede12d14b6ec0864a4a7967fe",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 151534,
        "end": 151601,
        "byteStart": 151767,
        "byteEnd": 151834,
        "line": 3102,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_INJECT_MUTEX_FORCE_RELEASE_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "8b696109d460b5578602d3f1f9cfdb7e52ee79df58cebfc08e8582d49ff6bb50",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "83db1273610e8228b68110ee785f26d02de99f7c497676c6fb6cbfe5f268f507",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 153467,
        "end": 153519,
        "byteStart": 153710,
        "byteEnd": 153762,
        "line": 3128,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_CARRY_STALE_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "76a5c1653f52c40859d8a5155ddbfee87eb883ac2d7447b2d484616a28404b33",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "7bbb55b3b7440a28766669126acf1db696db267e4034ac3928caab5888896770",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 154334,
        "end": 154386,
        "byteStart": 154579,
        "byteEnd": 154631,
        "line": 3140,
        "column": 24,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_ORPHAN_POLL_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "25af3f7def1f74dd36d40cb3415f5463e97b7663d97f5087f43f1a256a9f2fab",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "4ab2074641e57d95f97c55c8fd475705fc5ea8c2e1b8631d04d88cd76af243e1",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 167195,
        "end": 167241,
        "byteStart": 167448,
        "byteEnd": 167494,
        "line": 3448,
        "column": 33,
        "kind": "call",
        "typeOnly": false,
        "expression": "RegExp",
        "specifier": null,
        "source": "new RegExp(`^--?${SNAPSHOT_SECRET_KEY}$`, 'i')",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "1d2385124b61e6a1417530eafab964ba76f13fec2ee6008f3e8eeae09aab4bd4",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "5d3c7668383f17ed8c039055f935a7368ffcdbae90ba4a78935481d284f877c7",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 167275,
        "end": 167363,
        "byteStart": 167528,
        "byteEnd": 167616,
        "line": 3449,
        "column": 33,
        "kind": "call",
        "typeOnly": false,
        "expression": "RegExp",
        "specifier": null,
        "source": "new RegExp(`(${SNAPSHOT_SECRET_KEY})(\\\\s*[=:]\\\\s*)(\"[^\"]*\"|'[^']*'|[^\\\\s,;&\"']+)`, 'gi')",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "02465aeaae579dddc3ce1e561359dce03332d49f8869a73cb75a5f617e8ca0ef",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "2b1f5ef3c9f14799e2d98112e819a3c455b94ee766724b06dd24f8f92d582b74",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 180374,
        "end": 180482,
        "byteStart": 180633,
        "byteEnd": 180741,
        "line": 3775,
        "column": 30,
        "kind": "call",
        "typeOnly": false,
        "expression": "Set",
        "specifier": null,
        "source": "new Set([\n  'carry-drill-carry-delivered',\n  'carry-drill-carry-dropped',\n  'carry-drill-respawn-failed',\n])",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "520f37911aab05a22766290cd9cce355955a404faa4f79047ce6d88e4bca32df",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "5bf1dc941cc9d0b31c515aa40a782ee05d15e1754f589d3f9c321e7b6d3dac9c",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 189935,
        "end": 192928,
        "byteStart": 190216,
        "byteEnd": 193217,
        "line": 3965,
        "column": 38,
        "kind": "call",
        "typeOnly": false,
        "expression": "Object.freeze",
        "specifier": null,
        "source": "Object.freeze([\n  // The same native host keeps its tenant slot while adopting updated code.\n  'PAPERCUSP_HOSTED_NATIVE_SLOT',\n  'PAPERCUSP_SID',\n  'PAPERCUSP_AGENT',\n  // Recorded role authority must survive the same-host adoption preflight.\n  'PAPERCUSP_AGENT_ROLE',\n  'PAPERCUSP_ADV_SESSION_ID',\n  // Keep the proven launcher actor through host-code adoption. Without it,\n  // the successor advertises human-owned provenance and quota recovery refuses.\n  'PAPERCUSP_LAUNCHED_BY',\n  // A re-exec ta",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "ac6321efdb4361b5f94182a65f9b5bee9f92efa02a6640570262d36de6516bef",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "c3a17717c9e82e2488204347d3bf2bef37d97af94dcb1372ec67eb0aee6facc6",
        "sourceTruncated": true
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 207279,
        "end": 207343,
        "byteStart": 207602,
        "byteEnd": 207666,
        "line": 4392,
        "column": 3,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_OWNER_PRESENCE_THROTTLE_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "51a833e25b88aff8e269a3c67c6e27cf72e42576063c7209db19de08db75293a",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "7c019b67dca7c12effe9595c925f930e4dd1c0e3d10adcaf33ae78976ce3101b",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 214156,
        "end": 214366,
        "byteStart": 214485,
        "byteEnd": 214705,
        "line": 4554,
        "column": 37,
        "kind": "call",
        "typeOnly": false,
        "expression": "Set",
        "specifier": null,
        "source": "new Set([\n  0x50, // ESC P — DCS (XTVERSION, DA3 and DECRQSS replies)\n  0x58, // ESC X — SOS\n  0x5d, // ESC ] — OSC (window title, color queries)\n  0x5e, // ESC ^ — PM\n  0x5f, // ESC _ — APC (kitty graphics)\n])",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "900e18aa39c0425ed57c22382461873b715a8b31ceef4d318a4ed795cf22bc10",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "3f74286dbac09842903b29d7f4656b354424aa64c7524d180883593b4427283e",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 240251,
        "end": 240306,
        "byteStart": 240656,
        "byteEnd": 240711,
        "line": 5177,
        "column": 34,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_SHUTDOWN_GRACE_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "7096b22565a7fd0aceef7036ca14cc1573558d29a3f3a75006062096a69fefc9",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "4734ae98e5aa090d96d1a62514be9842c1d8c4d0d7e7be5bd86690b9e3a9f351",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 240718,
        "end": 240777,
        "byteStart": 241125,
        "byteEnd": 241184,
        "line": 5186,
        "column": 38,
        "kind": "call",
        "typeOnly": false,
        "expression": "Number",
        "specifier": null,
        "source": "Number(process.env.PAPERCUSP_PSU_PTY_SHUTDOWN_ACK_DELAY_MS)",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "dfe8bd333770b5f7a8f3b883a71549b1624292cfb75eddcdd27293bd177ddd7d",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "cdcca2a3aea6d5aea64ab02c29a22a42fd4c42302568de6d2c93fd93a9fc1344",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 296252,
        "end": 297269,
        "byteStart": 296793,
        "byteEnd": 297810,
        "line": 6237,
        "column": 46,
        "kind": "call",
        "typeOnly": false,
        "expression": "Object.freeze",
        "specifier": null,
        "source": "Object.freeze({\n  'no-startup-ready-marker-last-resort-failed':\n    'the child never emitted its startup-ready marker AND the last-resort attempt found no prompt',\n  'no-startup-ready-marker': 'the child never emitted its startup-ready marker',\n  'kickoff-marker-echo-unconfirmed': 'the exact Codex kickoff marker never appeared in the composer echo',\n  'submit-verification-exhausted': 'submit verification exhausted without observing output after a resubmit',\n  'fresh-child-owner-input': 'the owne",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "27fbf25738a55ad13d2d3b03cd0181f04f769178c1d468a3a78e16f92c41a8d9",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "0a64fd7d36f9f61e1ab39d24f6d3bf79c2e6dbb5bb6944ab907dc8b9b5ddafa4",
        "sourceTruncated": true
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 437558,
        "end": 437701,
        "byteStart": 438464,
        "byteEnd": 438607,
        "line": 9320,
        "column": 45,
        "kind": "call",
        "typeOnly": false,
        "expression": "Object.freeze",
        "specifier": null,
        "source": "Object.freeze({\n  crDelayMs: 150,\n  settleMs: 300,\n  paintBudgetMs: 8_000,\n  reconnectBudgetMs: 20_000,\n  maxArrows: 40,\n  closeWaitMs: 400,\n})",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "f61b15222ef3f0e4ea03b0a42f2100c6f0d6a4f253372495a29572a1f3803823",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "57b0156da5fae351ea8d47e4b9b7f2fe2cefa82dc1eeae5bd070da9c5720858d",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 466880,
        "end": 467244,
        "byteStart": 467875,
        "byteEnd": 468239,
        "line": 9942,
        "column": 42,
        "kind": "call",
        "typeOnly": false,
        "expression": "Set",
        "specifier": null,
        "source": "new Set([\n  'carry-respawn-pending',\n  'native-turn-start-pending',\n  'successor-native-id-missing',\n  // This check runs before injectTurnAtPrompt writes any bytes. A Codex quota\n  // recovery can replace the child and clear the latch, after which the same\n  // accepted wake may safely make its first submission.\n  'submit-verification-aborted-quota-blocked',\n])",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "00e20a3ad7b959d5d4eded3d1c64e6fc2a196953b7790c4b55776bf2c89745dd",
        "binding": null,
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "e15b51a68351e7f7d90591d508a60af4201298cfc0db102f87ef4af10e0fc191",
        "sourceTruncated": false
      },
      {
        "path": "apps/operator/scripts/psu-pty-host.mjs",
        "start": 500331,
        "end": 500381,
        "byteStart": 501510,
        "byteEnd": 501560,
        "line": 10578,
        "column": 45,
        "kind": "call",
        "typeOnly": false,
        "expression": "join",
        "specifier": null,
        "source": "join(HOST_SCRIPT_DIR, 'emit-session-compacted.ts')",
        "enclosingFunctions": [],
        "predicates": [],
        "initialization": true,
        "fingerprint": "0d16c218db1b7467431d31960f19f45bd09c3df146ce09a0fd79767e19bfcbe4",
        "binding": {
          "imported": "join",
          "specifiers": [
            "node:path"
          ]
        },
        "calleeCoverage": "UNKNOWN",
        "sourceSha256": "307a290e30a8cace4082377e4775edb855d0622f90e0685f314a97050918edcd",
        "sourceTruncated": false
      }
    ],
    "resolutionResidue": [
      {
        "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
        "role": "retained require candidate implementation",
        "from": {
          "path": "node_modules/hono/package.json",
          "exportKey": "./cors.require"
        }
      },
      {
        "path": "node_modules/hono/dist/cjs/package.json",
        "role": "retained require candidate package-scope input",
        "from": {
          "path": "node_modules/hono/dist/cjs/middleware/cors/index.js"
        }
      }
    ],
    "needed": "Actual admissible loader/transform proof that narrows alternatives, or source-method disposition of this non-dischargeable bound. No new source traversal until disposition."
  },
  "inputs": [
    {
      "path": "node_modules/hono/package.json",
      "canonical": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/package.json",
      "sha256": "2bde0291b747985deffb5e9d8c25ce16b45becd59205987b448affdc1c2d9e7e",
      "bytes": 23613,
      "source": "{\n  \"name\": \"hono\",\n  \"version\": \"4.13.7\",\n  \"description\": \"Web framework built on Web Standards\",\n  \"main\": \"dist/cjs/index.js\",\n  \"type\": \"module\",\n  \"module\": \"dist/index.js\",\n  \"types\": \"dist/types/index.d.ts\",\n  \"files\": [\n    \"dist\",\n    \"!dist/**/*.tsbuildinfo\"\n  ],\n  \"scripts\": {\n    \"test\": \"tsc -p tsconfig.spec.json && vitest --run\",\n    \"test:watch\": \"vitest --watch\",\n    \"test:deno\": \"deno test --allow-read --allow-env --allow-write --allow-net -c runtime-tests/deno/deno.json runtime-tests/deno && deno test --no-lock -c runtime-tests/deno-jsx/deno.precompile.json runtime-tests/deno-jsx && deno test --no-lock -c runtime-tests/deno-jsx/deno.react-jsx.json runtime-tests/deno-jsx\",\n    \"test:bun\": \"bun test --jsx-import-source ../../src/jsx runtime-tests/bun/*\",\n    \"test:fastly\": \"vitest --run --project fastly\",\n    \"test:node\": \"vitest --run --project node\",\n    \"test:workerd\": \"vitest --run --project workerd\",\n    \"test:lambda\": \"vitest --run --project lambda\",\n    \"test:lambda-edge\": \"vitest --run --project lambda-edge\",\n    \"test:all\": \"bun run test && bun test:deno && bun test:bun\",\n    \"lint\": \"eslint src runtime-tests build perf-measures benchmarks\",\n    \"lint:fix\": \"eslint src runtime-tests build perf-measures benchmarks --fix\",\n    \"format\": \"prettier --check --cache \\\"src/**/*.{js,ts,tsx}\\\" \\\"runtime-tests/**/*.{js,ts,tsx}\\\" \\\"build/**/*.{js,ts,tsx}\\\" \\\"perf-measures/**/*.{js,ts,tsx}\\\" \\\"benchmarks/**/*.{js,ts,tsx}\\\"\",\n    \"format:fix\": \"prettier --write --cache --cache-strategy metadata \\\"src/**/*.{js,ts,tsx}\\\" \\\"runtime-tests/**/*.{js,ts,tsx}\\\" \\\"build/**/*.{js,ts,tsx}\\\" \\\"perf-measures/**/*.{js,ts,tsx}\\\" \\\"benchmarks/**/*.{js,ts,tsx}\\\"\",\n    \"editorconfig-checker\": \"editorconfig-checker\",\n    \"copy:package.cjs.json\": \"cp ./package.cjs.json ./dist/cjs/package.json && cp ./package.cjs.json ./dist/types/package.json\",\n    \"build\": \"bun run --shell bun remove-dist && bun ./build/build.ts && bun run copy:package.cjs.json\",\n    \"postbuild\": \"publint\",\n    \"watch\": \"bun run --shell bun remove-dist && bun ./build/build.ts --watch && bun run copy:package.cjs.json\",\n    \"coverage\": \"vitest --run --coverage\",\n    \"prerelease\": \"bun test:deno && bun run build\",\n    \"release\": \"np --no-publish\",\n    \"remove-dist\": \"rm -rf dist\"\n  },\n  \"exports\": {\n    \".\": {\n      \"types\": \"./dist/types/index.d.ts\",\n      \"import\": \"./dist/index.js\",\n      \"require\": \"./dist/cjs/index.js\"\n    },\n    \"./request\": {\n      \"types\": \"./dist/types/request.d.ts\",\n      \"import\": \"./dist/request.js\",\n      \"require\": \"./dist/cjs/request.js\"\n    },\n    \"./types\": {\n      \"types\": \"./dist/types/types.d.ts\",\n      \"import\": \"./dist/types.js\",\n      \"require\": \"./dist/cjs/types.js\"\n    },\n    \"./hono-base\": {\n      \"types\": \"./dist/types/hono-base.d.ts\",\n      \"import\": \"./dist/hono-base.js\",\n      \"require\": \"./dist/cjs/hono-base.js\"\n    },\n    \"./tiny\": {\n      \"types\": \"./dist/types/preset/tiny.d.ts\",\n      \"import\": \"./dist/preset/tiny.js\",\n      \"require\": \"./dist/cjs/preset/tiny.js\"\n    },\n    \"./quick\": {\n      \"types\": \"./dist/types/preset/quick.d.ts\",\n      \"import\": \"./dist/preset/quick.js\",\n      \"require\": \"./dist/cjs/preset/quick.js\"\n    },\n    \"./http-exception\": {\n      \"types\": \"./dist/types/http-exception.d.ts\",\n      \"import\": \"./dist/http-exception.js\",\n      \"require\": \"./dist/cjs/http-exception.js\"\n    },\n    \"./basic-auth\": {\n      \"types\": \"./dist/types/middleware/basic-auth/index.d.ts\",\n      \"import\": \"./dist/middleware/basic-auth/index.js\",\n      \"require\": \"./dist/cjs/middleware/basic-auth/index.js\"\n    },\n    \"./bearer-auth\": {\n      \"types\": \"./dist/types/middleware/bearer-auth/index.d.ts\",\n      \"import\": \"./dist/middleware/bearer-auth/index.js\",\n      \"require\": \"./dist/cjs/middleware/bearer-auth/index.js\"\n    },\n    \"./body-limit\": {\n      \"types\": \"./dist/types/middleware/body-limit/index.d.ts\",\n      \"import\": \"./dist/middleware/body-limit/index.js\",\n      \"require\": \"./dist/cjs/middleware/body-limit/index.js\"\n    },\n    \"./ip-restriction\": {\n      \"types\": \"./dist/types/middleware/ip-restriction/index.d.ts\",\n      \"import\": \"./dist/middleware/ip-restriction/index.js\",\n      \"require\": \"./dist/cjs/middleware/ip-restriction/index.js\"\n    },\n    \"./cache\": {\n      \"types\": \"./dist/types/middleware/cache/index.d.ts\",\n      \"import\": \"./dist/middleware/cache/index.js\",\n      \"require\": \"./dist/cjs/middleware/cache/index.js\"\n    },\n    \"./route\": {\n      \"types\": \"./dist/types/helper/route/index.d.ts\",\n      \"import\": \"./dist/helper/route/index.js\",\n      \"require\": \"./dist/cjs/helper/route/index.js\"\n    },\n    \"./cookie\": {\n      \"types\": \"./dist/types/helper/cookie/index.d.ts\",\n      \"import\": \"./dist/helper/cookie/index.js\",\n      \"require\": \"./dist/cjs/helper/cookie/index.js\"\n    },\n    \"./accepts\": {\n      \"types\": \"./dist/types/helper/accepts/index.d.ts\",\n      \"import\": \"./dist/helper/accepts/index.js\",\n      \"require\": \"./dist/cjs/helper/accepts/index.js\"\n    },\n    \"./compress\": {\n      \"types\": \"./dist/types/middleware/compress/index.d.ts\",\n      \"import\": \"./dist/middleware/compress/index.js\",\n      \"require\": \"./dist/cjs/middleware/compress/index.js\"\n    },\n    \"./context-storage\": {\n      \"types\": \"./dist/types/middleware/context-storage/index.d.ts\",\n      \"import\": \"./dist/middleware/context-storage/index.js\",\n      \"require\": \"./dist/cjs/middleware/context-storage/index.js\"\n    },\n    \"./cors\": {\n      \"types\": \"./dist/types/middleware/cors/index.d.ts\",\n      \"import\": \"./dist/middleware/cors/index.js\",\n      \"require\": \"./dist/cjs/middleware/cors/index.js\"\n    },\n    \"./csrf\": {\n      \"types\": \"./dist/types/middleware/csrf/index.d.ts\",\n      \"import\": \"./dist/middleware/csrf/index.js\",\n      \"require\": \"./dist/cjs/middleware/csrf/index.js\"\n    },\n    \"./etag\": {\n      \"types\": \"./dist/types/middleware/etag/index.d.ts\",\n      \"import\": \"./dist/middleware/etag/index.js\",\n      \"require\": \"./dist/cjs/middleware/etag/index.js\"\n    },\n    \"./trailing-slash\": {\n      \"types\": \"./dist/types/middleware/trailing-slash/index.d.ts\",\n      \"import\": \"./dist/middleware/trailing-slash/index.js\",\n      \"require\": \"./dist/cjs/middleware/trailing-slash/index.js\"\n    },\n    \"./html\": {\n      \"types\": \"./dist/types/helper/html/index.d.ts\",\n      \"import\": \"./dist/helper/html/index.js\",\n      \"require\": \"./dist/cjs/helper/html/index.js\"\n    },\n    \"./css\": {\n      \"types\": \"./dist/types/helper/css/index.d.ts\",\n      \"import\": \"./dist/helper/css/index.js\",\n      \"require\": \"./dist/cjs/helper/css/index.js\"\n    },\n    \"./jsx\": {\n      \"types\": \"./dist/types/jsx/index.d.ts\",\n      \"import\": \"./dist/jsx/index.js\",\n      \"require\": \"./dist/cjs/jsx/index.js\"\n    },\n    \"./jsx/jsx-dev-runtime\": {\n      \"types\": \"./dist/types/jsx/jsx-dev-runtime.d.ts\",\n      \"import\": \"./dist/jsx/jsx-dev-runtime.js\",\n      \"require\": \"./dist/cjs/jsx/jsx-dev-runtime.js\"\n    },\n    \"./jsx/jsx-runtime\": {\n      \"types\": \"./dist/types/jsx/jsx-runtime.d.ts\",\n      \"import\": \"./dist/jsx/jsx-runtime.js\",\n      \"require\": \"./dist/cjs/jsx/jsx-runtime.js\"\n    },\n    \"./jsx/streaming\": {\n      \"types\": \"./dist/types/jsx/streaming.d.ts\",\n      \"import\": \"./dist/jsx/streaming.js\",\n      \"require\": \"./dist/cjs/jsx/streaming.js\"\n    },\n    \"./jsx-renderer\": {\n      \"types\": \"./dist/types/middleware/jsx-renderer/index.d.ts\",\n      \"import\": \"./dist/middleware/jsx-renderer/index.js\",\n      \"require\": \"./dist/cjs/middleware/jsx-renderer/index.js\"\n    },\n    \"./jsx/dom\": {\n      \"types\": \"./dist/types/jsx/dom/index.d.ts\",\n      \"import\": \"./dist/jsx/dom/index.js\",\n      \"require\": \"./dist/cjs/jsx/dom/index.js\"\n    },\n    \"./jsx/dom/jsx-dev-runtime\": {\n      \"types\": \"./dist/types/jsx/dom/jsx-dev-runtime.d.ts\",\n      \"import\": \"./dist/jsx/dom/jsx-dev-runtime.js\",\n      \"require\": \"./dist/cjs/jsx/dom/jsx-dev-runtime.js\"\n    },\n    \"./jsx/dom/jsx-runtime\": {\n      \"types\": \"./dist/types/jsx/dom/jsx-runtime.d.ts\",\n      \"import\": \"./dist/jsx/dom/jsx-runtime.js\",\n      \"require\": \"./dist/cjs/jsx/dom/jsx-runtime.js\"\n    },\n    \"./jsx/dom/client\": {\n      \"types\": \"./dist/types/jsx/dom/client.d.ts\",\n      \"import\": \"./dist/jsx/dom/client.js\",\n      \"require\": \"./dist/cjs/jsx/dom/client.js\"\n    },\n    \"./jsx/dom/css\": {\n      \"types\": \"./dist/types/jsx/dom/css.d.ts\",\n      \"import\": \"./dist/jsx/dom/css.js\",\n      \"require\": \"./dist/cjs/jsx/dom/css.js\"\n    },\n    \"./jsx/dom/server\": {\n      \"types\": \"./dist/types/jsx/dom/server.d.ts\",\n      \"import\": \"./dist/jsx/dom/server.js\",\n      \"require\": \"./dist/cjs/jsx/dom/server.js\"\n    },\n    \"./jwt\": {\n      \"types\": \"./dist/types/middleware/jwt/index.d.ts\",\n      \"import\": \"./dist/middleware/jwt/index.js\",\n      \"require\": \"./dist/cjs/middleware/jwt/index.js\"\n    },\n    \"./jwk\": {\n      \"types\": \"./dist/types/middleware/jwk/index.d.ts\",\n      \"import\": \"./dist/middleware/jwk/index.js\",\n      \"require\": \"./dist/cjs/middleware/jwk/index.js\"\n    },\n    \"./timeout\": {\n      \"types\": \"./dist/types/middleware/timeout/index.d.ts\",\n      \"import\": \"./dist/middleware/timeout/index.js\",\n      \"require\": \"./dist/cjs/middleware/timeout/index.js\"\n    },\n    \"./timing\": {\n      \"types\": \"./dist/types/middleware/timing/index.d.ts\",\n      \"import\": \"./dist/middleware/timing/index.js\",\n      \"require\": \"./dist/cjs/middleware/timing/index.js\"\n    },\n    \"./logger\": {\n      \"types\": \"./dist/types/middleware/logger/index.d.ts\",\n      \"import\": \"./dist/middleware/logger/index.js\",\n      \"require\": \"./dist/cjs/middleware/logger/index.js\"\n    },\n    \"./method-not-allowed\": {\n      \"types\": \"./dist/types/middleware/method-not-allowed/index.d.ts\",\n      \"import\": \"./dist/middleware/method-not-allowed/index.js\",\n      \"require\": \"./dist/cjs/middleware/method-not-allowed/index.js\"\n    },\n    \"./method-override\": {\n      \"types\": \"./dist/types/middleware/method-override/index.d.ts\",\n      \"import\": \"./dist/middleware/method-override/index.js\",\n      \"require\": \"./dist/cjs/middleware/method-override/index.js\"\n    },\n    \"./powered-by\": {\n      \"types\": \"./dist/types/middleware/powered-by/index.d.ts\",\n      \"import\": \"./dist/middleware/powered-by/index.js\",\n      \"require\": \"./dist/cjs/middleware/powered-by/index.js\"\n    },\n    \"./pretty-json\": {\n      \"types\": \"./dist/types/middleware/pretty-json/index.d.ts\",\n      \"import\": \"./dist/middleware/pretty-json/index.js\",\n      \"require\": \"./dist/cjs/middleware/pretty-json/index.js\"\n    },\n    \"./request-id\": {\n      \"types\": \"./dist/types/middleware/request-id/index.d.ts\",\n      \"import\": \"./dist/middleware/request-id/index.js\",\n      \"require\": \"./dist/cjs/middleware/request-id/index.js\"\n    },\n    \"./language\": {\n      \"types\": \"./dist/types/middleware/language/index.d.ts\",\n      \"import\": \"./dist/middleware/language/index.js\",\n      \"require\": \"./dist/cjs/middleware/language/index.js\"\n    },\n    \"./secure-headers\": {\n      \"types\": \"./dist/types/middleware/secure-headers/index.d.ts\",\n      \"import\": \"./dist/middleware/secure-headers/index.js\",\n      \"require\": \"./dist/cjs/middleware/secure-headers/index.js\"\n    },\n    \"./combine\": {\n      \"types\": \"./dist/types/middleware/combine/index.d.ts\",\n      \"import\": \"./dist/middleware/combine/index.js\",\n      \"require\": \"./dist/cjs/middleware/combine/index.js\"\n    },\n    \"./ssg\": {\n      \"types\": \"./dist/types/helper/ssg/index.d.ts\",\n      \"import\": \"./dist/helper/ssg/index.js\",\n      \"require\": \"./dist/cjs/helper/ssg/index.js\"\n    },\n    \"./streaming\": {\n      \"types\": \"./dist/types/helper/streaming/index.d.ts\",\n      \"import\": \"./dist/helper/streaming/index.js\",\n      \"require\": \"./dist/cjs/helper/streaming/index.js\"\n    },\n    \"./validator\": {\n      \"types\": \"./dist/types/validator/index.d.ts\",\n      \"import\": \"./dist/validator/index.js\",\n      \"require\": \"./dist/cjs/validator/index.js\"\n    },\n    \"./router\": {\n      \"types\": \"./dist/types/router.d.ts\",\n      \"import\": \"./dist/router.js\",\n      \"require\": \"./dist/cjs/router.js\"\n    },\n    \"./router/reg-exp-router\": {\n      \"types\": \"./dist/types/router/reg-exp-router/index.d.ts\",\n      \"import\": \"./dist/router/reg-exp-router/index.js\",\n      \"require\": \"./dist/cjs/router/reg-exp-router/index.js\"\n    },\n    \"./router/smart-router\": {\n      \"types\": \"./dist/types/router/smart-router/index.d.ts\",\n      \"import\": \"./dist/router/smart-router/index.js\",\n      \"require\": \"./dist/cjs/router/smart-router/index.js\"\n    },\n    \"./router/trie-router\": {\n      \"types\": \"./dist/types/router/trie-router/index.d.ts\",\n      \"import\": \"./dist/router/trie-router/index.js\",\n      \"require\": \"./dist/cjs/router/trie-router/index.js\"\n    },\n    \"./router/pattern-router\": {\n      \"types\": \"./dist/types/router/pattern-router/index.d.ts\",\n      \"import\": \"./dist/router/pattern-router/index.js\",\n      \"require\": \"./dist/cjs/router/pattern-router/index.js\"\n    },\n    \"./router/linear-router\": {\n      \"types\": \"./dist/types/router/linear-router/index.d.ts\",\n      \"import\": \"./dist/router/linear-router/index.js\",\n      \"require\": \"./dist/cjs/router/linear-router/index.js\"\n    },\n    \"./utils/jwt\": {\n      \"types\": \"./dist/types/utils/jwt/index.d.ts\",\n      \"import\": \"./dist/utils/jwt/index.js\",\n      \"require\": \"./dist/cjs/utils/jwt/index.js\"\n    },\n    \"./utils/*\": {\n      \"types\": \"./dist/types/utils/*.d.ts\",\n      \"import\": \"./dist/utils/*.js\",\n      \"require\": \"./dist/cjs/utils/*.js\"\n    },\n    \"./client\": {\n      \"types\": \"./dist/types/client/index.d.ts\",\n      \"import\": \"./dist/client/index.js\",\n      \"require\": \"./dist/cjs/client/index.js\"\n    },\n    \"./adapter\": {\n      \"types\": \"./dist/types/helper/adapter/index.d.ts\",\n      \"import\": \"./dist/helper/adapter/index.js\",\n      \"require\": \"./dist/cjs/helper/adapter/index.js\"\n    },\n    \"./factory\": {\n      \"types\": \"./dist/types/helper/factory/index.d.ts\",\n      \"import\": \"./dist/helper/factory/index.js\",\n      \"require\": \"./dist/cjs/helper/factory/index.js\"\n    },\n    \"./serve-static\": {\n      \"types\": \"./dist/types/middleware/serve-static/index.d.ts\",\n      \"import\": \"./dist/middleware/serve-static/index.js\",\n      \"require\": \"./dist/cjs/middleware/serve-static/index.js\"\n    },\n    \"./cloudflare-workers\": {\n      \"types\": \"./dist/types/adapter/cloudflare-workers/index.d.ts\",\n      \"import\": \"./dist/adapter/cloudflare-workers/index.js\",\n      \"require\": \"./dist/cjs/adapter/cloudflare-workers/index.js\"\n    },\n    \"./cloudflare-pages\": {\n      \"types\": \"./dist/types/adapter/cloudflare-pages/index.d.ts\",\n      \"import\": \"./dist/adapter/cloudflare-pages/index.js\",\n      \"require\": \"./dist/cjs/adapter/cloudflare-pages/index.js\"\n    },\n    \"./deno\": {\n      \"types\": \"./dist/types/adapter/deno/index.d.ts\",\n      \"import\": \"./dist/adapter/deno/index.js\",\n      \"require\": \"./dist/cjs/adapter/deno/index.js\"\n    },\n    \"./bun\": {\n      \"types\": \"./dist/types/adapter/bun/index.d.ts\",\n      \"import\": \"./dist/adapter/bun/index.js\",\n      \"require\": \"./dist/cjs/adapter/bun/index.js\"\n    },\n    \"./aws-lambda\": {\n      \"types\": \"./dist/types/adapter/aws-lambda/index.d.ts\",\n      \"import\": \"./dist/adapter/aws-lambda/index.js\",\n      \"require\": \"./dist/cjs/adapter/aws-lambda/index.js\"\n    },\n    \"./vercel\": {\n      \"types\": \"./dist/types/adapter/vercel/index.d.ts\",\n      \"import\": \"./dist/adapter/vercel/index.js\",\n      \"require\": \"./dist/cjs/adapter/vercel/index.js\"\n    },\n    \"./netlify\": {\n      \"types\": \"./dist/types/adapter/netlify/index.d.ts\",\n      \"import\": \"./dist/adapter/netlify/index.js\",\n      \"require\": \"./dist/cjs/adapter/netlify/index.js\"\n    },\n    \"./lambda-edge\": {\n      \"types\": \"./dist/types/adapter/lambda-edge/index.d.ts\",\n      \"import\": \"./dist/adapter/lambda-edge/index.js\",\n      \"require\": \"./dist/cjs/adapter/lambda-edge/index.js\"\n    },\n    \"./service-worker\": {\n      \"types\": \"./dist/types/adapter/service-worker/index.d.ts\",\n      \"import\": \"./dist/adapter/service-worker/index.js\",\n      \"require\": \"./dist/cjs/adapter/service-worker/index.js\"\n    },\n    \"./testing\": {\n      \"types\": \"./dist/types/helper/testing/index.d.ts\",\n      \"import\": \"./dist/helper/testing/index.js\",\n      \"require\": \"./dist/cjs/helper/testing/index.js\"\n    },\n    \"./dev\": {\n      \"types\": \"./dist/types/helper/dev/index.d.ts\",\n      \"import\": \"./dist/helper/dev/index.js\",\n      \"require\": \"./dist/cjs/helper/dev/index.js\"\n    },\n    \"./ws\": {\n      \"types\": \"./dist/types/helper/websocket/index.d.ts\",\n      \"import\": \"./dist/helper/websocket/index.js\",\n      \"require\": \"./dist/cjs/helper/websocket/index.js\"\n    },\n    \"./conninfo\": {\n      \"types\": \"./dist/types/helper/conninfo/index.d.ts\",\n      \"import\": \"./dist/helper/conninfo/index.js\",\n      \"require\": \"./dist/cjs/helper/conninfo/index.js\"\n    },\n    \"./proxy\": {\n      \"types\": \"./dist/types/helper/proxy/index.d.ts\",\n      \"import\": \"./dist/helper/proxy/index.js\",\n      \"require\": \"./dist/cjs/helper/proxy/index.js\"\n    }\n  },\n  \"typesVersions\": {\n    \"*\": {\n      \"request\": [\n        \"./dist/types/request\"\n      ],\n      \"types\": [\n        \"./dist/types/types\"\n      ],\n      \"hono-base\": [\n        \"./dist/types/hono-base\"\n      ],\n      \"tiny\": [\n        \"./dist/types/preset/tiny\"\n      ],\n      \"quick\": [\n        \"./dist/types/preset/quick\"\n      ],\n      \"http-exception\": [\n        \"./dist/types/http-exception\"\n      ],\n      \"basic-auth\": [\n        \"./dist/types/middleware/basic-auth\"\n      ],\n      \"bearer-auth\": [\n        \"./dist/types/middleware/bearer-auth\"\n      ],\n      \"body-limit\": [\n        \"./dist/types/middleware/body-limit\"\n      ],\n      \"ip-restriction\": [\n        \"./dist/types/middleware/ip-restriction\"\n      ],\n      \"cache\": [\n        \"./dist/types/middleware/cache\"\n      ],\n      \"route\": [\n        \"./dist/types/helper/route\"\n      ],\n      \"cookie\": [\n        \"./dist/types/helper/cookie\"\n      ],\n      \"accepts\": [\n        \"./dist/types/helper/accepts\"\n      ],\n      \"compress\": [\n        \"./dist/types/middleware/compress\"\n      ],\n      \"context-storage\": [\n        \"./dist/types/middleware/context-storage\"\n      ],\n      \"cors\": [\n        \"./dist/types/middleware/cors\"\n      ],\n      \"csrf\": [\n        \"./dist/types/middleware/csrf\"\n      ],\n      \"etag\": [\n        \"./dist/types/middleware/etag\"\n      ],\n      \"trailing-slash\": [\n        \"./dist/types/middleware/trailing-slash\"\n      ],\n      \"html\": [\n        \"./dist/types/helper/html\"\n      ],\n      \"css\": [\n        \"./dist/types/helper/css\"\n      ],\n      \"jsx\": [\n        \"./dist/types/jsx\"\n      ],\n      \"jsx/jsx-runtime\": [\n        \"./dist/types/jsx/jsx-runtime.d.ts\"\n      ],\n      \"jsx/jsx-dev-runtime\": [\n        \"./dist/types/jsx/jsx-dev-runtime.d.ts\"\n      ],\n      \"jsx/streaming\": [\n        \"./dist/types/jsx/streaming.d.ts\"\n      ],\n      \"jsx-renderer\": [\n        \"./dist/types/middleware/jsx-renderer\"\n      ],\n      \"jsx/dom\": [\n        \"./dist/types/jsx/dom\"\n      ],\n      \"jsx/dom/client\": [\n        \"./dist/types/jsx/dom/client.d.ts\"\n      ],\n      \"jsx/dom/css\": [\n        \"./dist/types/jsx/dom/css.d.ts\"\n      ],\n      \"jsx/dom/server\": [\n        \"./dist/types/jsx/dom/server.d.ts\"\n      ],\n      \"jsx/dom/jsx-dev-runtime\": [\n        \"./dist/types/jsx/dom/jsx-dev-runtime.d.ts\"\n      ],\n      \"jsx/dom/jsx-runtime\": [\n        \"./dist/types/jsx/dom/jsx-runtime.d.ts\"\n      ],\n      \"jwt\": [\n        \"./dist/types/middleware/jwt\"\n      ],\n      \"jwk\": [\n        \"./dist/types/middleware/jwk\"\n      ],\n      \"timeout\": [\n        \"./dist/types/middleware/timeout\"\n      ],\n      \"timing\": [\n        \"./dist/types/middleware/timing\"\n      ],\n      \"logger\": [\n        \"./dist/types/middleware/logger\"\n      ],\n      \"method-not-allowed\": [\n        \"./dist/types/middleware/method-not-allowed\"\n      ],\n      \"method-override\": [\n        \"./dist/types/middleware/method-override\"\n      ],\n      \"powered-by\": [\n        \"./dist/types/middleware/powered-by\"\n      ],\n      \"pretty-json\": [\n        \"./dist/types/middleware/pretty-json\"\n      ],\n      \"request-id\": [\n        \"./dist/types/middleware/request-id\"\n      ],\n      \"language\": [\n        \"./dist/types/middleware/language\"\n      ],\n      \"streaming\": [\n        \"./dist/types/helper/streaming\"\n      ],\n      \"ssg\": [\n        \"./dist/types/helper/ssg\"\n      ],\n      \"secure-headers\": [\n        \"./dist/types/middleware/secure-headers\"\n      ],\n      \"combine\": [\n        \"./dist/types/middleware/combine\"\n      ],\n      \"validator\": [\n        \"./dist/types/validator/index.d.ts\"\n      ],\n      \"router\": [\n        \"./dist/types/router.d.ts\"\n      ],\n      \"router/reg-exp-router\": [\n        \"./dist/types/router/reg-exp-router\"\n      ],\n      \"router/smart-router\": [\n        \"./dist/types/router/smart-router\"\n      ],\n      \"router/trie-router\": [\n        \"./dist/types/router/trie-router\"\n      ],\n      \"router/pattern-router\": [\n        \"./dist/types/router/pattern-router\"\n      ],\n      \"router/linear-router\": [\n        \"./dist/types/router/linear-router\"\n      ],\n      \"utils/jwt\": [\n        \"./dist/types/utils/jwt/index.d.ts\"\n      ],\n      \"utils/*\": [\n        \"./dist/types/utils/*\"\n      ],\n      \"client\": [\n        \"./dist/types/client/index.d.ts\"\n      ],\n      \"adapter\": [\n        \"./dist/types/helper/adapter/index.d.ts\"\n      ],\n      \"factory\": [\n        \"./dist/types/helper/factory/index.d.ts\"\n      ],\n      \"serve-static\": [\n        \"./dist/types/middleware/serve-static\"\n      ],\n      \"cloudflare-workers\": [\n        \"./dist/types/adapter/cloudflare-workers\"\n      ],\n      \"cloudflare-pages\": [\n        \"./dist/types/adapter/cloudflare-pages\"\n      ],\n      \"deno\": [\n        \"./dist/types/adapter/deno\"\n      ],\n      \"bun\": [\n        \"./dist/types/adapter/bun\"\n      ],\n      \"aws-lambda\": [\n        \"./dist/types/adapter/aws-lambda\"\n      ],\n      \"vercel\": [\n        \"./dist/types/adapter/vercel\"\n      ],\n      \"netlify\": [\n        \"./dist/types/adapter/netlify\"\n      ],\n      \"lambda-edge\": [\n        \"./dist/types/adapter/lambda-edge\"\n      ],\n      \"service-worker\": [\n        \"./dist/types/adapter/service-worker\"\n      ],\n      \"testing\": [\n        \"./dist/types/helper/testing\"\n      ],\n      \"dev\": [\n        \"./dist/types/helper/dev\"\n      ],\n      \"ws\": [\n        \"./dist/types/helper/websocket\"\n      ],\n      \"conninfo\": [\n        \"./dist/types/helper/conninfo\"\n      ],\n      \"proxy\": [\n        \"./dist/types/helper/proxy\"\n      ]\n    }\n  },\n  \"author\": \"Yusuke Wada <yusuke@kamawada.com> (https://github.com/yusukebe)\",\n  \"license\": \"MIT\",\n  \"repository\": {\n    \"type\": \"git\",\n    \"url\": \"git+https://github.com/honojs/hono.git\"\n  },\n  \"publishConfig\": {\n    \"registry\": \"https://registry.npmjs.org\"\n  },\n  \"homepage\": \"https://hono.dev\",\n  \"keywords\": [\n    \"hono\",\n    \"web\",\n    \"app\",\n    \"http\",\n    \"application\",\n    \"framework\",\n    \"router\",\n    \"cloudflare\",\n    \"workers\",\n    \"fastly\",\n    \"compute\",\n    \"deno\",\n    \"bun\",\n    \"lambda\",\n    \"nodejs\"\n  ],\n  \"devDependencies\": {\n    \"@hono/eslint-config\": \"^2.1.1\",\n    \"@hono/node-server\": \"^2.0.12\",\n    \"@types/jsdom\": \"^21.1.7\",\n    \"@types/node\": \"^24.3.0\",\n    \"@types/ws\": \"^8.18.1\",\n    \"@typescript/native-preview\": \"7.0.0-dev.20260210.1\",\n    \"@vitest/coverage-v8\": \"^4.1.7\",\n    \"bun-types\": \"^1.2.20\",\n    \"editorconfig-checker\": \"6.2.0\",\n    \"esbuild\": \"^0.27.1\",\n    \"eslint\": \"^9.39.3\",\n    \"jsdom\": \"22.1.0\",\n    \"msw\": \"^2.6.0\",\n    \"np\": \"11.2.1\",\n    \"oxc-parser\": \"^0.96.0\",\n    \"pkg-pr-new\": \"^0.0.53\",\n    \"prettier\": \"3.7.4\",\n    \"publint\": \"0.3.15\",\n    \"typescript\": \"^6.0.3\",\n    \"vite-plugin-fastly-js-compute\": \"^0.4.2\",\n    \"vitest\": \"^4.1.9\",\n    \"wrangler\": \"4.107.0\",\n    \"ws\": \"^8.21.0\",\n    \"zod\": \"^3.23.8\"\n  },\n  \"packageManager\": \"bun@1.2.20\",\n  \"engines\": {\n    \"node\": \">=16.9.0\"\n  }\n}\n"
    },
    {
      "path": "node_modules/hono/dist/middleware/cors/index.js",
      "canonical": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/middleware/cors/index.js",
      "sha256": "b4084f07f48ab369a8b58cfd90ac277cd590ca618842ba4132bc53642ad990fd",
      "bytes": 2897,
      "source": "// src/middleware/cors/index.ts\nvar cors = (options) => {\n  const opts = {\n    origin: \"*\",\n    allowMethods: [\"GET\", \"HEAD\", \"PUT\", \"POST\", \"DELETE\", \"PATCH\", \"QUERY\"],\n    allowHeaders: [],\n    exposeHeaders: [],\n    ...options\n  };\n  const exposeHeadersStr = opts.exposeHeaders?.length ? opts.exposeHeaders.join(\",\") : void 0;\n  const allowHeadersStr = opts.allowHeaders?.length ? opts.allowHeaders.join(\",\") : void 0;\n  const findAllowOrigin = ((optsOrigin) => {\n    if (typeof optsOrigin === \"string\") {\n      if (optsOrigin === \"*\") {\n        return () => optsOrigin;\n      } else {\n        return (origin) => optsOrigin === origin ? origin : null;\n      }\n    } else if (typeof optsOrigin === \"function\") {\n      return optsOrigin;\n    } else {\n      return (origin) => optsOrigin.includes(origin) ? origin : null;\n    }\n  })(opts.origin);\n  const findAllowMethods = ((optsAllowMethods) => {\n    if (typeof optsAllowMethods === \"function\") {\n      return async (origin, c) => (await optsAllowMethods(origin, c)).join(\",\");\n    } else if (Array.isArray(optsAllowMethods)) {\n      const methodsStr = optsAllowMethods.join(\",\");\n      return () => methodsStr;\n    } else {\n      return () => \"\";\n    }\n  })(opts.allowMethods);\n  return async function cors2(c, next) {\n    function set(key, value) {\n      c.res.headers.set(key, value);\n    }\n    const allowOrigin = await findAllowOrigin(c.req.header(\"origin\") || \"\", c);\n    if (allowOrigin) {\n      set(\"Access-Control-Allow-Origin\", allowOrigin);\n    }\n    if (opts.credentials) {\n      set(\"Access-Control-Allow-Credentials\", \"true\");\n    }\n    if (exposeHeadersStr) {\n      set(\"Access-Control-Expose-Headers\", exposeHeadersStr);\n    }\n    if (c.req.method === \"OPTIONS\") {\n      if (opts.origin !== \"*\") {\n        c.res.headers.append(\"Vary\", \"Origin\");\n      }\n      if (opts.maxAge != null) {\n        set(\"Access-Control-Max-Age\", opts.maxAge.toString());\n      }\n      const allowMethods = await findAllowMethods(c.req.header(\"origin\") || \"\", c);\n      if (allowMethods) {\n        set(\"Access-Control-Allow-Methods\", allowMethods);\n      }\n      let headersStr = allowHeadersStr;\n      if (!headersStr) {\n        const requestHeaders = c.req.header(\"Access-Control-Request-Headers\");\n        if (requestHeaders) {\n          headersStr = requestHeaders.split(\",\").map((h) => h.trim()).join(\",\");\n        }\n      }\n      if (headersStr) {\n        set(\"Access-Control-Allow-Headers\", headersStr);\n        c.res.headers.append(\"Vary\", \"Access-Control-Request-Headers\");\n      }\n      c.res.headers.delete(\"Content-Length\");\n      c.res.headers.delete(\"Content-Type\");\n      return new Response(null, {\n        headers: c.res.headers,\n        status: 204,\n        statusText: \"No Content\"\n      });\n    }\n    await next();\n    if (opts.origin !== \"*\") {\n      c.header(\"Vary\", \"Origin\", { append: true });\n    }\n  };\n};\nexport {\n  cors\n};\n"
    },
    {
      "path": "node_modules/hono/dist/cjs/middleware/cors/index.js",
      "canonical": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/cjs/middleware/cors/index.js",
      "sha256": "de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7",
      "bytes": 3847,
      "source": "var __defProp = Object.defineProperty;\nvar __getOwnPropDesc = Object.getOwnPropertyDescriptor;\nvar __getOwnPropNames = Object.getOwnPropertyNames;\nvar __hasOwnProp = Object.prototype.hasOwnProperty;\nvar __export = (target, all) => {\n  for (var name in all)\n    __defProp(target, name, { get: all[name], enumerable: true });\n};\nvar __copyProps = (to, from, except, desc) => {\n  if (from && typeof from === \"object\" || typeof from === \"function\") {\n    for (let key of __getOwnPropNames(from))\n      if (!__hasOwnProp.call(to, key) && key !== except)\n        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n  }\n  return to;\n};\nvar __toCommonJS = (mod) => __copyProps(__defProp({}, \"__esModule\", { value: true }), mod);\nvar cors_exports = {};\n__export(cors_exports, {\n  cors: () => cors\n});\nmodule.exports = __toCommonJS(cors_exports);\nconst cors = (options) => {\n  const opts = {\n    origin: \"*\",\n    allowMethods: [\"GET\", \"HEAD\", \"PUT\", \"POST\", \"DELETE\", \"PATCH\", \"QUERY\"],\n    allowHeaders: [],\n    exposeHeaders: [],\n    ...options\n  };\n  const exposeHeadersStr = opts.exposeHeaders?.length ? opts.exposeHeaders.join(\",\") : void 0;\n  const allowHeadersStr = opts.allowHeaders?.length ? opts.allowHeaders.join(\",\") : void 0;\n  const findAllowOrigin = ((optsOrigin) => {\n    if (typeof optsOrigin === \"string\") {\n      if (optsOrigin === \"*\") {\n        return () => optsOrigin;\n      } else {\n        return (origin) => optsOrigin === origin ? origin : null;\n      }\n    } else if (typeof optsOrigin === \"function\") {\n      return optsOrigin;\n    } else {\n      return (origin) => optsOrigin.includes(origin) ? origin : null;\n    }\n  })(opts.origin);\n  const findAllowMethods = ((optsAllowMethods) => {\n    if (typeof optsAllowMethods === \"function\") {\n      return async (origin, c) => (await optsAllowMethods(origin, c)).join(\",\");\n    } else if (Array.isArray(optsAllowMethods)) {\n      const methodsStr = optsAllowMethods.join(\",\");\n      return () => methodsStr;\n    } else {\n      return () => \"\";\n    }\n  })(opts.allowMethods);\n  return async function cors2(c, next) {\n    function set(key, value) {\n      c.res.headers.set(key, value);\n    }\n    const allowOrigin = await findAllowOrigin(c.req.header(\"origin\") || \"\", c);\n    if (allowOrigin) {\n      set(\"Access-Control-Allow-Origin\", allowOrigin);\n    }\n    if (opts.credentials) {\n      set(\"Access-Control-Allow-Credentials\", \"true\");\n    }\n    if (exposeHeadersStr) {\n      set(\"Access-Control-Expose-Headers\", exposeHeadersStr);\n    }\n    if (c.req.method === \"OPTIONS\") {\n      if (opts.origin !== \"*\") {\n        c.res.headers.append(\"Vary\", \"Origin\");\n      }\n      if (opts.maxAge != null) {\n        set(\"Access-Control-Max-Age\", opts.maxAge.toString());\n      }\n      const allowMethods = await findAllowMethods(c.req.header(\"origin\") || \"\", c);\n      if (allowMethods) {\n        set(\"Access-Control-Allow-Methods\", allowMethods);\n      }\n      let headersStr = allowHeadersStr;\n      if (!headersStr) {\n        const requestHeaders = c.req.header(\"Access-Control-Request-Headers\");\n        if (requestHeaders) {\n          headersStr = requestHeaders.split(\",\").map((h) => h.trim()).join(\",\");\n        }\n      }\n      if (headersStr) {\n        set(\"Access-Control-Allow-Headers\", headersStr);\n        c.res.headers.append(\"Vary\", \"Access-Control-Request-Headers\");\n      }\n      c.res.headers.delete(\"Content-Length\");\n      c.res.headers.delete(\"Content-Type\");\n      return new Response(null, {\n        headers: c.res.headers,\n        status: 204,\n        statusText: \"No Content\"\n      });\n    }\n    await next();\n    if (opts.origin !== \"*\") {\n      c.header(\"Vary\", \"Origin\", { append: true });\n    }\n  };\n};\n// Annotate the CommonJS export names for ESM import in node:\n0 && (module.exports = {\n  cors\n});\n"
    },
    {
      "path": "node_modules/hono/dist/cjs/package.json",
      "canonical": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/hono/dist/cjs/package.json",
      "sha256": "8005a3491db7d92f36ac66369861589f9c47123d3a7c71e643fc2c06168cd45a",
      "bytes": 25,
      "source": "{\n  \"type\": \"commonjs\"\n}\n"
    },
    {
      "path": "package-lock.json",
      "canonical": "/home/marsh-office/papercupai-workspace/papercusp/package-lock.json",
      "sha256": "e16502a07b06cfed7ec160d6484922c45d0ffbb94085fa8c5292d46253525b68",
      "bytes": 1418571,
      "selectedEntry": {
        "version": "4.13.7",
        "resolved": "https://registry.npmjs.org/hono/-/hono-4.13.7.tgz",
        "integrity": "sha512-c8/gF9ac8Y78/agExVocyLevgR+JlpNB444Py0FSX8pJoPdYUfUzRcXtYEYGwt6l19qIlVZPN5Mfsw9jFShmQQ==",
        "license": "MIT",
        "engines": {
          "node": ">=16.9.0"
        }
      }
    },
    {
      "path": "node_modules/.package-lock.json",
      "canonical": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/.package-lock.json",
      "sha256": "e2088158839a74af5737dd82f584eaf72602d5d6dc810d568bb872589339d773",
      "bytes": 1235648,
      "selectedEntry": {
        "version": "4.13.7",
        "resolved": "https://registry.npmjs.org/hono/-/hono-4.13.7.tgz",
        "integrity": "sha512-c8/gF9ac8Y78/agExVocyLevgR+JlpNB444Py0FSX8pJoPdYUfUzRcXtYEYGwt6l19qIlVZPN5Mfsw9jFShmQQ==",
        "license": "MIT",
        "engines": {
          "node": ">=16.9.0"
        }
      }
    },
    {
      "path": "package.json",
      "canonical": "/home/marsh-office/papercupai-workspace/papercusp/package.json",
      "sha256": "52b0f18baa476cfead93908efe9f8800348722756446d1be2c724c2d3550e14e",
      "bytes": 35057,
      "source": "{\n  \"name\": \"@papercupai/papercusp-monorepo\",\n  \"private\": true,\n  \"version\": \"0.0.1\",\n  \"packageManager\": \"npm@11.19.0\",\n  \"engines\": {\n    \"//\": \"Pin the runtime to Node 25 (ABI 141 / NODE_MODULE_VERSION 141). The fleet runs linuxbrew node 25; native addons (better-sqlite3) built under any other major (e.g. nvm 22 = ABI 127) fail to load at runtime ('Module did not self-register'). See infra-fail-fast-build-integrity-2026-06-19 P-003 + .nvmrc. Advisory (no engine-strict) — declares the pin for nvm/CI/contributors; the deploy-gate native-addon preflight is the hard ABI enforcer.\",\n    \"node\": \">=25\",\n    \"npm\": \">=11.19.0\"\n  },\n  \"workspaces\": [\n    \"apps/*\",\n    \"!apps/*-checkpoint\",\n    \"packages/*\",\n    \"libs/agent-chat\",\n    \"libs/generic/card-stack\",\n    \"libs/generic/chat-protocol\",\n    \"libs/generic/seed-bundle\",\n    \"libs/generic/git-graph\",\n    \"libs/generic/ui-primitives\",\n    \"libs/generic/dock-workbench\",\n    \"libs/generic/kokoro-tts\",\n    \"libs/marketplace-public-ui\",\n    \"libs/papercusp-db\",\n    \"libs/papercusp-shared\",\n    \"libs/papercusp-publish-auth\",\n    \"libs/generic/sync\",\n    \"libs/generic/result-encoding\",\n    \"libs/generic/token-kit\",\n    \"libs/generic/rerank\",\n    \"libs/generic/search-core\",\n    \"libs/testing-shell\",\n    \"libs/host-platform\",\n    \"libs/flags\",\n    \"libs/generic/papergrid/grid-core\",\n    \"libs/generic/papergrid/grid\",\n    \"libs/papercusp/libs/db\",\n    \"libs/generic/sse\",\n    \"libs/papercusp/packages/harness\",\n    \"libs/papercusp/packages/orchestrator\",\n    \"libs/generic/model-pricing\",\n    \"libs/papercusp/packages/blueprint-distribution\",\n    \"libs/papercusp/packages/cli\",\n    \"libs/papercusp/packages/locks\",\n    \"libs/papercusp/packages/embedded-postgres-server\",\n    \"libs/papercusp/plugins/gitnexus-bridge\",\n    \"libs/test-config\",\n    \"libs/generic/papergrid/bloom-grid\",\n    \"libs/generic/rrf\",\n    \"libs/generic/rules\",\n    \"libs/generic/artifact-registry\",\n    \"libs/generic/event-reaction\",\n    \"libs/generic/step-program\",\n    \"libs/generic/failure-detector\",\n    \"libs/generic/fanout-resolver\",\n    \"libs/generic/projection-index\",\n    \"libs/generic/cache\",\n    \"libs/generic/activity-bridge\",\n    \"libs/generic/pubsub-substrate\",\n    \"libs/generic/plugin-loader\",\n    \"libs/generic/embedded-pg-discovery\",\n    \"libs/generic/control-mutation\",\n    \"libs/generic/prospect-contract\",\n    \"libs/generic/linkable-edges\",\n    \"libs/generic/plan-parser\",\n    \"libs/generic/rate-limit\",\n    \"libs/generic/ipc-framing\",\n    \"libs/generic/tooldef\",\n    \"libs/generic/tooldef-http\",\n    \"libs/generic/ipc-endpoint-server\",\n    \"libs/generic/desktop-ipc\",\n    \"libs/generic/search\",\n    \"libs/generic/memory\",\n    \"libs/generic/papergrid/kv-persist\",\n    \"libs/generic/papergrid/kv-persist-indexeddb\",\n    \"libs/generic/locks-core\",\n    \"libs/generic/structured-concurrency\",\n    \"libs/generic/debounce-coalesce\",\n    \"libs/generic/scheduled-registry\",\n    \"libs/generic/module-singleton\",\n    \"libs/generic/ranked-selection\",\n    \"libs/generic/decision-model\",\n    \"libs/generic/dependency-order\",\n    \"libs/generic/p2p-voice\",\n    \"libs/generic/audio-dsp\",\n    \"libs/generic/deployment-driver\",\n    \"libs/generic/tauri-release-kit\",\n    \"libs/generic/pot-app-seam\",\n    \"libs/generic/template-kit\",\n    \"libs/generic/lexicon\",\n    \"libs/generic/facets\",\n    \"libs/generic/eval-battery\",\n    \"libs/generic/verification-harness\",\n    \"libs/generic/bench-metrics\",\n    \"libs/generic/resource-profile\",\n    \"libs/generic/resumable-download\",\n    \"libs/generic/tauri-verify\",\n    \"libs/generic/gui-readiness\",\n    \"libs/generic/release-profile\",\n    \"libs/generic/image-blankness\",\n    \"libs/generic/overlap-clusters\",\n    \"libs/generic/sequence-patterns\",\n    \"libs/generic/agent-roster\",\n    \"libs/generic/hash-chain\",\n    \"libs/generic/merkle-log\",\n    \"libs/generic/ast-fingerprint\"\n  ],\n  \"scripts\": {\n    \"lint:new-clones\": \"tsx scripts/check-new-clones.mts\",\n    \"preinstall\": \"node scripts/guard-shared-tree-install.mjs && npx --yes only-allow npm\",\n    \"install:safe\": \"node scripts/npm-install-safe.mjs\",\n    \"check:screenshot\": \"tsx libs/generic/image-blankness/src/cli.ts\",\n    \"doctor:deps\": \"node scripts/check-declared-deps-extracted.mjs\",\n    \"doctor:fixed-but-open\": \"node scripts/check-fixed-but-open.mjs\",\n    \"measure:launch-cost\": \"tsx scripts/measure-launch-cost.ts\",\n    \"measure:startup-cache\": \"tsx scripts/measure-startup-cache.ts\",\n    \"measure:tool-output\": \"node scripts/measure-tool-output.mjs\",\n    \"census:leaks\": \"tsx scripts/leak-census.ts\",\n    \"leaks:ratchet\": \"tsx scripts/leak-ratchet.ts\",\n    \"stats:proof\": \"tsx scripts/stats-proof.ts\",\n    \"audit:dark-flags\": \"tsx scripts/audit-dark-flags-live-state.ts\",\n    \"release:publish-workspace-host-artifacts\": \"tsx scripts/publish-workspace-host-artifacts.mjs\",\n    \"tokens\": \"style-dictionary build --config design-tokens/style-dictionary.config.mjs\",\n    \"tokens:check\": \"node design-tokens/tokens-check.mjs\",\n    \"design:evidence-report\": \"tsx packages/operator-core/lib/design-compare/report-cli.ts --mode=report --work=design-evidence-report/captures\",\n    \"design:evidence-calibrate\": \"tsx packages/operator-core/lib/design-compare/report-cli.ts --mode=calibrate\",\n    \"gen:borrowable\": \"node scripts/gen-borrowable-catalog.mjs\",\n    \"p2p:two-peer-commerce\": \"node --import tsx packages/operator-core/lib/p2p/two-peer-commerce/run-two-peer-commerce.ts\",\n    \"gen:borrowable:check\": \"node scripts/gen-borrowable-catalog.mjs --check\",\n    \"gen:gitnexus-bridge\": \"node scripts/gen-gitnexus-bridge-runtime.mjs\",\n    \"gen:gitnexus-bridge:check\": \"node scripts/gen-gitnexus-bridge-runtime.mjs --check\",\n    \"gen:contract\": \"tsx scripts/gen-testing-domains-contract.ts\",\n    \"gen:contract:check\": \"tsx scripts/gen-testing-domains-contract.ts --check\",\n    \"gen:agent-env\": \"tsx scripts/gen-agent-env.ts\",\n    \"gen:agent-env:check\": \"tsx scripts/gen-agent-env.ts --check\",\n    \"gen:knowledge-packs\": \"node scripts/gen-knowledge-packs.mjs\",\n    \"gen:knowledge-packs:check\": \"node scripts/gen-knowledge-packs.mjs --check\",\n    \"gen:claude-md-manifest\": \"node scripts/gen-claude-md-manifest.mjs\",\n    \"gen:client-docs\": \"node scripts/project-doc-parts.mjs --write\",\n    \"set-doc-part\": \"tsx scripts/set-doc-part.ts\",\n    \"gen:authored-docs\": \"tsx scripts/project-authored-docs.mts --write\",\n    \"gen:authored-docs:check\": \"tsx scripts/project-authored-docs.mts --check\",\n    \"gen:authored-docs:ingest\": \"tsx scripts/project-authored-docs.mts --ingest\",\n    \"gen:authored-docs:materialize\": \"tsx scripts/project-authored-docs.mts --materialize\",\n    \"gen:authored-docs:retire-orphans\": \"tsx scripts/project-authored-docs.mts --retire-orphans\",\n    \"gen:client-docs:check\": \"node scripts/project-doc-parts.mjs\",\n    \"gen:doc-corpus\": \"node scripts/project-doc-parts.mjs --write-corpus\",\n    \"gen:fleet-lessons\": \"tsx scripts/gen-fleet-lessons.ts\",\n    \"gen:fleet-lessons:check\": \"tsx scripts/gen-fleet-lessons.ts --check\",\n    \"gen:prompt-projections\": \"node scripts/check-prompt-projections.mjs --write\",\n    \"gen:prompt-projections:check\": \"node scripts/check-prompt-projections.mjs\",\n    \"gen:tool-catalog\": \"tsx scripts/gen-tool-catalog.ts\",\n    \"gen:tool-catalog:check\": \"tsx scripts/gen-tool-catalog.ts --check\",\n    \"gen:tool-routing\": \"tsx scripts/gen-tool-routing.ts\",\n    \"gen:tool-routing:check\": \"tsx scripts/gen-tool-routing.ts --check\",\n    \"tool-weight\": \"tsx scripts/tool-weight.ts\",\n    \"refresh:tool-demand\": \"node scripts/refresh-tool-demand.mjs\",\n    \"gen:tool-delivery\": \"tsx scripts/gen-tool-delivery.ts\",\n    \"gen:tool-delivery:check\": \"tsx scripts/gen-tool-delivery.ts --check\",\n    \"gen:declarations\": \"tsx scripts/gen-declarations.ts\",\n    \"gen:declarations:check\": \"tsx scripts/gen-declarations.ts --check\",\n    \"seed:substitutions\": \"tsx scripts/seed-substitution-registry.ts\",\n    \"seed:substitutions:check\": \"tsx scripts/seed-substitution-registry.ts --check\",\n    \"gen:baseline\": \"tsx libs/papercusp/libs/db/scripts/build-reference-schema.ts /tmp/papercusp-reference-schema.raw.sql && tsx packages/operator-core/lib/db-tools/sanitize-baseline.ts /tmp/papercusp-reference-schema.raw.sql /tmp/000-baseline.sql\",\n    \"gen:baseline:diff\": \"npm run gen:baseline && diff -u libs/papercusp/libs/db/sql/000-baseline.sql /tmp/000-baseline.sql\",\n    \"scan:lexicon\": \"node scripts/scan-lexicon.mjs\",\n    \"scan:lexicon:check\": \"node scripts/scan-lexicon.mjs --check\",\n    \"gen:openapi\": \"tsx scripts/gen-openapi-spec.ts\",\n    \"gen:lib-api\": \"tsx scripts/gen-lib-api-docs.ts\",\n    \"gen:compaction\": \"tsx scripts/gen-compaction.ts\",\n    \"gen:compaction:check\": \"tsx scripts/gen-compaction.ts --check\",\n    \"lint:post-compaction-recovery-contract\": \"tsx scripts/check-post-compaction-recovery-contract.ts\",\n    \"lint:resource-governor-enforcement\": \"node scripts/check-resource-governor-enforcement.mjs\",\n    \"docs:preview\": \"npm run gen:openapi && npm run build:preview -w @papercupai/operator-docs\",\n    \"docs:preview:serve\": \"npm run serve:preview -w @papercupai/operator-docs\",\n    \"docs:rebuild\": \"PC_HEAVY_RETRY_PREEMPTIONS=3 bash scripts/pc-heavy.sh -- npm run build -w @papercupai/operator-docs\",\n    \"gen:doc-projections\": \"tsx scripts/gen-doc-projections.ts\",\n    \"gen:doc-blueprint-catalog\": \"tsx scripts/gen-doc-blueprint-catalog.ts\",\n    \"gen:doc-blueprint-catalog:check\": \"tsx scripts/gen-doc-blueprint-catalog.ts --check\",\n    \"gen:su-decomposition\": \"tsx libs/papercusp/packages/orchestrator/bin/gen-su-decomposition.ts\",\n    \"gen:su-decomposition:check\": \"tsx libs/papercusp/packages/orchestrator/bin/gen-su-decomposition.ts --check\",\n    \"gen:identity-surface-census\": \"tsx scripts/gen-identity-surface-census.mts\",\n    \"lint:identity-surfaces\": \"tsx scripts/gen-identity-surface-census.mts --check\",\n    \"gen:doc-role-registry\": \"tsx scripts/gen-doc-role-registry.ts\",\n    \"gen:doc-role-registry:check\": \"tsx scripts/gen-doc-role-registry.ts --check\",\n    \"gen:doc-insights-index\": \"tsx scripts/gen-doc-insights-index.ts\",\n    \"gen:doc-insights-index:check\": \"tsx scripts/gen-doc-insights-index.ts --check\",\n    \"gen:doc-tool-catalog\": \"tsx scripts/gen-doc-tool-catalog.ts\",\n    \"gen:doc-tool-catalog:check\": \"tsx scripts/gen-doc-tool-catalog.ts --check\",\n    \"gen:doc-plans-index\": \"tsx scripts/gen-doc-plans-index.ts\",\n    \"gen:doc-plans-index:check\": \"tsx scripts/gen-doc-plans-index.ts --check\",\n    \"dev:operator\": \"npm --workspace @papercusp/operator-vite run dev:nohmr\",\n    \"dev:operator:hmr\": \"npm --workspace @papercusp/operator-vite run dev\",\n    \"dev:operator:nohmr\": \"npm --workspace @papercusp/operator-vite run dev:nohmr\",\n    \"build:operator\": \"npm --workspace @papercusp/operator-vite run build\",\n    \"format:check\": \"git diff --check --\",\n    \"format:check:scoped\": \"node scripts/check-format.mjs\",\n    \"format:write:scoped\": \"node scripts/check-format.mjs --write\",\n    \"test\": \"PAPERCUSP_TEST_RUN_HARNESS=papercusp AFFECTED_TASK_VERDICT_RESUME=1 PC_HEAVY_KEY_ENV=AFFECTED_BASE,AFFECTED_RETRY_FAILED bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node scripts/affected-tests.mjs\",\n    \"test:file\": \"NODE_OPTIONS=\\\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\\\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs\",\n    \"ensure:playwright-browsers\": \"node scripts/ensure-playwright-browsers.mjs\",\n    \"test:affected\": \"PAPERCUSP_TEST_RUN_HARNESS=papercusp AFFECTED_TASK_VERDICT_RESUME=1 PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_KEY_ENV=AFFECTED_BASE,AFFECTED_RETRY_FAILED bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node scripts/affected-tests.mjs\",\n    \"test:related\": \"PAPERCUSP_TEST_RUN_HARNESS=papercusp PC_HEAVY_KEY_ENV=AFFECTED_BASE,AFFECTED_RETRY_FAILED bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node scripts/affected-tests.mjs --related\",\n    \"test:affected:integration\": \"PAPERCUSP_TEST_RUN_HARNESS=papercusp AFFECTED_TASK_VERDICT_RESUME=1 PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_KEY_ENV=AFFECTED_BASE,AFFECTED_RETRY_FAILED bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node scripts/affected-tests.mjs --integration\",\n    \"test:all\": \"PAPERCUSP_TEST_RUN_HARNESS=papercusp PC_HEAVY_KEY_ENV=AFFECTED_BASE,AFFECTED_RETRY_FAILED bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node scripts/affected-tests.mjs --all\",\n    \"test:all:integration\": \"PAPERCUSP_TEST_RUN_HARNESS=papercusp PC_HEAVY_KEY_ENV=AFFECTED_BASE,AFFECTED_RETRY_FAILED bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node scripts/affected-tests.mjs --all --integration\",\n    \"test:integration-only\": \"PAPERCUSP_TEST_RUN_HARNESS=papercusp PC_HEAVY_KEY_ENV=AFFECTED_BASE,AFFECTED_RETRY_FAILED bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node scripts/affected-tests.mjs --all --integration-only\",\n    \"coverage:merge\": \"tsx scripts/merge-coverage.ts\",\n    \"gate:patch-coverage\": \"tsx scripts/patch-coverage.ts\",\n    \"gate:cover-loop\": \"tsx scripts/cover-loop.ts\",\n    \"gate:schemathesis\": \"tsx scripts/schemathesis-routes.ts\",\n    \"perf:desktop\": \"cd tools/perf-test/wdio && mkdir -p results && bash -o pipefail -c 'npm run test:all 2>&1 | tee \\\"results/run-$(date -u +%Y%m%dT%H%M%SZ).log\\\"'\",\n    \"test:doctor\": \"node scripts/test-doctor.mjs\",\n    \"doctor\": \"node scripts/test-doctor.mjs\",\n    \"test:flake-soak\": \"bash scripts/flake-soak.sh\",\n    \"check:fleet-auth\": \"node scripts/check-fleet-auth.mjs\",\n    \"preflight:addons\": \"tsx scripts/preflight-native-addons.ts\",\n    \"mcp:call\": \"node scripts/mcp-call.mjs\",\n    \"lint:knip\": \"knip --no-config-hints\",\n    \"lint:knip:fix\": \"knip --fix --no-config-hints\",\n    \"lint:drizzle-drift\": \"node scripts/check-drizzle-drift.mjs\",\n    \"lint:migration-forward-compat\": \"node scripts/check-migration-forward-compat.mjs\",\n    \"lint:drop-database-force\": \"node scripts/check-drop-database-force.mjs\",\n    \"lint:affected-gate\": \"node scripts/lint-affected-gate.mjs\",\n    \"lint:workspace-deps-complete\": \"node scripts/check-workspace-deps-complete.mjs\",\n    \"lint:vitest-config-enrollment\": \"node scripts/check-vitest-config-enrollment.mjs\",\n    \"lint:peer-dep-conflicts\": \"node scripts/check-peer-dep-conflicts.mjs\",\n    \"lint:reachable-advisories\": \"node scripts/check-reachable-advisories.mjs --strict\",\n    \"lint:reachable-advisories:report\": \"node scripts/check-reachable-advisories.mjs\",\n    \"lint:rust-advisories\": \"node scripts/check-rust-advisories.mjs --strict\",\n    \"lint:rust-advisories:report\": \"node scripts/check-rust-advisories.mjs\",\n    \"lint:licenses\": \"node scripts/check-licenses.mjs --strict\",\n    \"lint:licenses:list\": \"node scripts/check-licenses.mjs --list\",\n    \"lint:lockfile-census\": \"node scripts/check-lockfile-census.mjs --strict\",\n    \"lint:lockfile-census:sbom\": \"node scripts/check-lockfile-census.mjs --strict --sbom .papercusp/tmp/lockfile-census.sbom.json\",\n    \"lint:no-restart\": \"node scripts/check-no-restart-imports.mjs\",\n    \"lint:no-tracked-node-modules\": \"node scripts/check-tracked-node-modules.mjs\",\n    \"lint:no-tracked-src-entry-dist\": \"node scripts/check-tracked-src-entry-dist.mjs\",\n    \"lint:no-tracked-ignored\": \"node scripts/check-tracked-ignored.mjs\",\n    \"lint:submodule-coverage-ignore\": \"node scripts/check-submodule-coverage-ignore.mjs\",\n    \"lint:smart-quotes\": \"tsx scripts/check-smart-quotes.mjs\",\n    \"lint:constant-conditional\": \"tsx scripts/check-constant-conditional.mjs\",\n    \"lint:mdx\": \"tsx scripts/check-mdx.mjs\",\n    \"lint:github-identity-terms\": \"node scripts/check-github-identity-terms.mjs\",\n    \"lint:shell-syntax\": \"tsx scripts/check-shell-syntax.mjs\",\n    \"lint:js-syntax\": \"node scripts/check-js-syntax.mjs\",\n    \"lint:mac-bash-portability\": \"node scripts/check-mac-bash-portability.mjs\",\n    \"lint:pipefail-sigpipe\": \"node scripts/check-pipefail-sigpipe.mjs\",\n    \"lint:pipefail-sigpipe:census\": \"node scripts/check-pipefail-sigpipe.mjs --census\",\n    \"lint:assert-integrity\": \"node scripts/check-assert-integrity.mjs\",\n    \"lint:vacuous-negatives\": \"node scripts/check-vacuous-negative-assertions.mjs\",\n    \"lint:vacuous-negatives:report\": \"node scripts/check-vacuous-negative-assertions.mjs --report\",\n    \"lint:insight-citations\": \"tsx scripts/check-insight-citations.mjs\",\n    \"lint:insight-normative\": \"tsx scripts/check-insight-normative.mjs\",\n    \"lint:docs-mirror\": \"node scripts/check-docs-mirror.mjs\",\n    \"lint:okf-conformance\": \"tsx scripts/check-okf-conformance.mjs\",\n    \"okf:sweep\": \"tsx scripts/okf-frontmatter-sweep.mjs\",\n    \"okf:backfill\": \"tsx scripts/okf-backfill-insights.mjs\",\n    \"okf:backfill:packs\": \"tsx scripts/okf-backfill-packs.mjs\",\n    \"lint:no-retired\": \"node scripts/check-no-retired-imports.mjs\",\n    \"lint:no-retired-resurrection\": \"node scripts/check-retired-resurrection.mjs\",\n    \"lint:no-retired-style\": \"node scripts/check-no-retired-style.mjs\",\n    \"lint:no-ungated-infinite-animation\": \"node scripts/check-no-ungated-infinite-animation.mjs\",\n    \"lint:no-ungated-infinite-animation:report\": \"node scripts/check-no-ungated-infinite-animation.mjs --report\",\n    \"scan:retirement-surface\": \"node scripts/scan-retirement-surface.mjs\",\n    \"lint:no-raw-spawn\": \"node scripts/check-no-raw-agent-spawn.mjs\",\n    \"lint:no-unenrolled-spawn\": \"node scripts/check-no-unenrolled-detached-spawn.mjs\",\n    \"lint:no-unenrolled-injector\": \"node scripts/check-no-unenrolled-injector.mjs\",\n    \"lint:no-unbounded-inbox-read\": \"node scripts/check-unbounded-inbox-read.mjs\",\n    \"lint:no-unenrolled-mjs-imports\": \"node scripts/check-unenrolled-mjs-imports.mjs\",\n    \"lint:no-unenrolled-detached-import\": \"node scripts/check-no-unenrolled-detached-import.mjs\",\n    \"lint:no-raw-setinterval\": \"node scripts/check-no-raw-setinterval.mjs\",\n    \"lint:harness-arg-coverage\": \"tsx scripts/check-harness-arg-coverage.ts\",\n    \"lint:integration-teardown-nullsafe\": \"node scripts/check-integration-teardown-nullsafe.mjs\",\n    \"lint:no-fake-timers-in-integration\": \"node scripts/check-fake-timers-in-integration-tests.mjs\",\n    \"lint:no-fake-timers-in-integration:report\": \"node scripts/check-fake-timers-in-integration-tests.mjs --report\",\n    \"lint:documented-test-run-cwd\": \"node scripts/check-documented-test-run-cwd.mjs\",\n    \"lint:sidecar-fallback-reported\": \"node scripts/check-sidecar-fallback-reported.mjs\",\n    \"lint:no-ungated-mug-kettle\": \"node scripts/check-ungated-mug-kettle.mjs\",\n    \"lint:vacuous-flag-guard\": \"node scripts/check-vacuous-flag-guard.mjs\",\n    \"lint:vacuous-flag-guard:report\": \"node scripts/check-vacuous-flag-guard.mjs --report\",\n    \"lint:narrowing-gated-assertions\": \"node scripts/check-narrowing-gated-assertions.mjs\",\n    \"lint:narrowing-gated-assertions:report\": \"node scripts/check-narrowing-gated-assertions.mjs --report\",\n    \"lint:narrowing-gated-assertions:census\": \"node scripts/check-narrowing-gated-assertions.mjs --census\",\n    \"lint:no-hand-rolled-module-pin\": \"node scripts/check-no-hand-rolled-module-pin.mjs\",\n    \"lint:refusal-contracts\": \"node scripts/check-refusal-contracts.mjs\",\n    \"lint:no-new-result-door-optout\": \"node scripts/check-result-door-optouts.mjs\",\n    \"lint:no-new-result-door-optout:census\": \"node scripts/check-result-door-optouts.mjs --list\",\n    \"lint:no-capacity-maxima\": \"node scripts/check-no-capacity-maxima.mjs\",\n    \"lint:no-hand-rolled-cli-entry\": \"node scripts/check-no-hand-rolled-cli-entry.mjs\",\n    \"lint:no-unhosted-remote-core\": \"node scripts/check-no-unhosted-remote-core.mjs\",\n    \"lint:no-unthreaded-apply\": \"node scripts/check-no-unthreaded-apply.mjs\",\n    \"lint:partial-index-alignment\": \"node scripts/check-partial-index-alignment.mjs\",\n    \"lint:partial-install\": \"node scripts/check-partial-install.mjs\",\n    \"lint:no-undrained-stdout-exit\": \"node scripts/check-undrained-stdout-exit.mjs\",\n    \"lint:no-undrained-stdout-exit:report\": \"node scripts/check-undrained-stdout-exit.mjs --report\",\n    \"lint:typeless-reexport\": \"node scripts/check-typeless-reexport-trap.mjs\",\n    \"lint:full-replacement-mocks\": \"node scripts/check-full-replacement-mocks.mjs\",\n    \"lint:no-unreachable-tier-mock\": \"node scripts/check-unreachable-tier-mock.mjs\",\n    \"lint:systemd-startlimit-placement\": \"node scripts/check-systemd-startlimit-placement.mjs\",\n    \"lint:no-proc-path-fixture\": \"node scripts/check-no-proc-path-fixture.mjs\",\n    \"lint:no-raw-block-edge\": \"node scripts/check-no-raw-block-edge.mjs\",\n    \"lint:no-raw-install-slug\": \"node scripts/check-no-raw-install-slug-filter.mjs\",\n    \"lint:no-raw-harness-sentinel\": \"node scripts/check-no-raw-harness-sentinel.mjs\",\n    \"lint:no-raw-goal-holder-read\": \"node scripts/check-no-raw-goal-holder-read.mjs\",\n    \"lint:no-bespoke-state-read\": \"node scripts/check-no-bespoke-state-read.mjs\",\n    \"report:no-bespoke-state-read-volume\": \"node scripts/check-no-bespoke-state-read.mjs --volume-report\",\n    \"lint:plane-producers\": \"node scripts/check-plane-producers.mjs\",\n    \"lint:declared-consumed\": \"node scripts/check-declared-consumed.mjs\",\n    \"lint:plane-adoption\": \"node scripts/check-plane-adoption.mjs\",\n    \"lint:derived-signal-firings\": \"node scripts/check-derived-signal-firings.mjs\",\n    \"lint:plane-ratchet\": \"npx tsx scripts/check-plane-ratchet.ts\",\n    \"lint:cell-matrix\": \"npx tsx scripts/check-cell-live-matrix.ts\",\n    \"lint:plane-guards\": \"node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/cell-assessment-reality.test.ts packages/operator-core/lib/no-bespoke-state-read-guard.test.ts packages/operator-core/lib/cell-registrations.test.ts packages/operator-core/lib/declared-consumed-sweep.test.ts packages/operator-core/lib/agent-tools/coordination/holder-context-parity.test.ts packages/operator-core/lib/derived-signal-firings-probe.test.ts packages/operator-core/lib/coord/derived-signal-census.test.ts\",\n    \"lint:timer-classification\": \"node scripts/check-timer-classification.mjs\",\n    \"lint:fire-and-forget-classification\": \"bash scripts/pc-heavy.sh node scripts/check-fire-and-forget-classification.mjs\",\n    \"lint:fire-and-forget-classification:list\": \"bash scripts/pc-heavy.sh node scripts/check-fire-and-forget-classification.mjs --list --json\",\n    \"lint:test-timing-budgets\": \"node scripts/check-test-timing-budgets.mjs\",\n    \"lint:test-timing-budgets:list\": \"node scripts/check-test-timing-budgets.mjs --list\",\n    \"lint:no-wire-compression\": \"node scripts/check-no-wire-compression.mjs\",\n    \"lint:no-eager-execfile-promisify\": \"node scripts/check-no-eager-execfile-promisify.mjs\",\n    \"lint:no-module-scope-flag-subscribe\": \"node scripts/check-no-module-scope-flag-subscribe.mjs\",\n    \"lint:no-sql-json\": \"node scripts/check-no-sql-json.mjs\",\n    \"lint:no-sql-comment-backtick\": \"tsx scripts/check-sql-comment-backtick.mjs\",\n    \"content-lint\": \"node scripts/content-lint-runner.mjs\",\n    \"lint:sql-guidance-justified\": \"node scripts/check-sql-guidance-justified.mjs\",\n    \"lint:sql-guidance-justified:report\": \"node scripts/check-sql-guidance-justified.mjs --report\",\n    \"lint:no-control-bytes\": \"node scripts/check-no-control-bytes.mjs\",\n    \"lint:guard-reachability\": \"node scripts/check-lint-guard-reachability.mjs\",\n    \"lint:condition-rail\": \"tsx scripts/condition-rail-inventory.mjs --lint\",\n    \"lint:guidance-returns-schema\": \"node scripts/check-guidance-returns-schema.mjs\",\n    \"lint:guard-reachability:census\": \"node scripts/check-lint-guard-reachability.mjs --census\",\n    \"lint:mock-cast-escape\": \"node scripts/check-mock-cast-escape.mjs\",\n    \"lint:mock-cast-escape:update\": \"node scripts/check-mock-cast-escape.mjs --update\",\n    \"lint:required-field-strands\": \"node scripts/check-required-field-strands.mjs\",\n    \"lint:required-field-strands:typecheck\": \"node scripts/check-required-field-strands.mjs --typecheck\",\n    \"lint:behavioural-strands\": \"node scripts/check-behavioural-strands.mjs\",\n    \"lint:behavioural-strands:run\": \"node scripts/check-behavioural-strands.mjs --run\",\n    \"lint:vimock-export-strands\": \"node scripts/check-vimock-export-strands.mjs\",\n    \"lint:optional-seam-strands\": \"node scripts/check-optional-seam-strands.mjs\",\n    \"lint:optional-seam-strands:fail\": \"node scripts/check-optional-seam-strands.mjs --fail\",\n    \"lint:di-seam-arity-strands\": \"node scripts/check-di-seam-arity-strands.mjs\",\n    \"lint:di-seam-arity-strands:fail\": \"node scripts/check-di-seam-arity-strands.mjs --fail\",\n    \"lint:deps-wiring-parity\": \"node scripts/check-deps-wiring-parity.mjs\",\n    \"lint:deps-wiring-parity:fail\": \"node scripts/check-deps-wiring-parity.mjs --fail\",\n    \"lint:no-box-identity\": \"node scripts/check-no-box-identity.mjs\",\n    \"lint:no-box-identity:all\": \"node scripts/check-no-box-identity.mjs --all\",\n    \"lint:no-owner-name-tags\": \"node scripts/check-no-owner-name-tags.mjs\",\n    \"lint:no-identity-literals\": \"node scripts/check-no-identity-literals.mjs\",\n    \"lint:no-identity-literals:all\": \"node scripts/check-no-identity-literals.mjs --all\",\n    \"lint:no-agent-intent-comments\": \"node scripts/check-no-agent-intent-comments.mjs\",\n    \"lint:no-agent-intent-comments:report\": \"node scripts/check-no-agent-intent-comments.mjs --report\",\n    \"lint:no-agent-intent-comments:census\": \"node scripts/check-no-agent-intent-comments.mjs --census\",\n    \"lint:systemd-dropins-installed\": \"node scripts/check-systemd-dropins-installed.mjs\",\n    \"lint:as-committed\": \"node scripts/lint-as-committed.mjs\",\n    \"lint:no-conflict-markers\": \"node scripts/check-conflict-markers.mjs\",\n    \"lint:no-self-referential-export\": \"node scripts/check-no-self-referential-export.mjs\",\n    \"lint:vitest-mock-paths\": \"node apps/operator/scripts/check-vitest-mock-paths.mjs\",\n    \"lint:host-bundle-builds\": \"node scripts/check-host-bundle-builds.mjs\",\n    \"lint:bundle-budget\": \"node scripts/check-bundle-budget.mjs\",\n    \"lint:no-cdn-egress\": \"node scripts/check-no-cdn-egress.mjs\",\n    \"lint:no-cdn-egress:report\": \"node scripts/check-no-cdn-egress.mjs --report\",\n    \"lint:no-cdn-egress:update\": \"node scripts/check-no-cdn-egress.mjs --update\",\n    \"lint:rubric-method-ref-parity\": \"node scripts/check-rubric-method-ref-parity.mjs\",\n    \"lint:generic-first\": \"node scripts/check-generic-first.mjs\",\n    \"lint:generic-first:all\": \"node scripts/check-generic-first.mjs --all\",\n    \"lint:generic-independence\": \"node scripts/check-generic-independence.mjs\",\n    \"lint:generic-independence:strict\": \"node scripts/check-generic-independence.mjs --strict\",\n    \"lint:explicit-presence\": \"node scripts/check-explicit-presence.mjs\",\n    \"lint:explicit-presence:all\": \"node scripts/check-explicit-presence.mjs --all\",\n    \"lint:env-feature-gates\": \"node scripts/check-env-feature-gates.mjs\",\n    \"lint:env-feature-gates:strict\": \"node scripts/check-env-feature-gates.mjs --strict\",\n    \"lint:scope-defaults\": \"node scripts/check-scope-defaults.mjs\",\n    \"lint:scope-defaults:strict\": \"node scripts/check-scope-defaults.mjs --strict\",\n    \"lint:no-workspace-default\": \"node scripts/check-workspace-default-sql.mjs\",\n    \"lint:no-workspace-default:strict\": \"node scripts/check-workspace-default-sql.mjs --strict\",\n    \"lint:tool-prompts\": \"PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/__tests__/tools-md-sync.test.ts\",\n    \"lint:launch-prose-budget\": \"tsx scripts/check-launch-prose-budget.ts\",\n    \"lint:tsc\": \"node scripts/lint-tsc.mjs\",\n    \"lint:tsc:operator-vite\": \"node scripts/lint-tsc-operator-vite.mjs\",\n    \"lint:tsc:orchestrator\": \"node scripts/lint-tsc-orchestrator.mjs\",\n    \"lint:tsc:operator\": \"node scripts/lint-tsc-operator.mjs\",\n    \"lint:tsc:papercusp-libs\": \"bash scripts/pc-heavy.sh node scripts/lint-tsc-papercusp-libs.mjs\",\n    \"lint:tsc:scripts\": \"node scripts/lint-tsc-scripts.mjs\",\n    \"lint:tsc:workspaces\": \"bash scripts/pc-heavy.sh node scripts/lint-tsc-workspaces.mjs\",\n    \"typecheck\": \"node scripts/lint-tsc.mjs\",\n    \"typecheck:operator\": \"npm --workspace @papercusp/web run typecheck --\",\n    \"typecheck:operator-core\": \"npm --workspace @papercusp/operator-core run typecheck --\",\n    \"lint:vite-externalized\": \"node scripts/check-vite-externalized-warnings.mjs\",\n    \"trace:vite-externalized\": \"node scripts/trace-vite-externalized.mjs\",\n    \"trace:vite-externalized:json-file\": \"node scripts/trace-vite-externalized.mjs --json-file\",\n    \"lint:vite-eager\": \"node scripts/trace-vite-externalized.mjs --check\",\n    \"lint:boundary-check\": \"node scripts/check-transitive-boundary.mjs\",\n    \"lint:migrations\": \"node scripts/lint-migrations.mjs\",\n    \"lint:design-primitives\": \"node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs apps/operator/app/_lints/design-primitives.test.ts apps/operator/app/_lints/css-tokens.test.ts apps/operator/app/_lints/contrast.test.ts\",\n    \"db:next-migration\": \"node scripts/next-migration.mjs\",\n    \"mirror:check\": \"node scripts/templates-mirror-sync.mjs\",\n    \"mirror:push\": \"node scripts/templates-mirror-sync.mjs --push\",\n    \"preview:export\": \"node scripts/source-preview.mjs export\",\n    \"preview:gate\": \"node scripts/source-preview.mjs gate\",\n    \"preview:check\": \"node scripts/source-preview.mjs check\",\n    \"preview:push\": \"node scripts/source-preview.mjs push\",\n    \"share-source\": \"node scripts/share-source.mjs\",\n    \"test:el-suite\": \"npm --workspace @papercusp/web run test:el-suite\",\n    \"patch:regen\": \"patch-package --exclude '(^package\\\\.json$|(^|/)\\\\.verdict-data/)'\",\n    \"postinstall\": \"node scripts/patch-noble-ciphers-exports.mjs && node scripts/install-onnxruntime-node.mjs && node scripts/install-embedded-pgvector.mjs && patch-package && node scripts/check-installed-patch-postimages.mjs\"\n  },\n  \"dependencies\": {\n    \"@assistant-ui/react\": \"^0.12.25\",\n    \"@astrojs/partytown\": \"^2.1.7\",\n    \"@astrojs/react\": \"^5.0.0\",\n    \"@astrojs/sitemap\": \"^3.7.2\",\n    \"@blocknote/core\": \"^0.51.3\",\n    \"@blocknote/mantine\": \"^0.51.3\",\n    \"@blocknote/react\": \"^0.51.3\",\n    \"@bufbuild/protobuf\": \"^2.11.0\",\n    \"@excalidraw/excalidraw\": \"^0.18.1\",\n    \"@lydell/node-pty\": \"^1.2.0-beta.12\",\n    \"@mantine/core\": \"^9.1.0\",\n    \"@mantine/hooks\": \"^9.1.0\",\n    \"@mcp-ui/server\": \"^6.1.0\",\n    \"@monaco-editor/react\": \"^4.7.0\",\n    \"@nestjs/common\": \"^11.2.7\",\n    \"@radix-ui/react-checkbox\": \"^1.3.3\",\n    \"@radix-ui/react-collapsible\": \"^1.1.12\",\n    \"@radix-ui/react-dialog\": \"^1.1.15\",\n    \"@radix-ui/react-popover\": \"^1.1.6\",\n    \"@radix-ui/react-select\": \"^2.2.6\",\n    \"@radix-ui/react-tabs\": \"^1.1.13\",\n    \"@radix-ui/react-tooltip\": \"^1.2.8\",\n    \"@tailwindcss/postcss\": \"^4.2.4\",\n    \"@tailwindcss/vite\": \"^4.0.0\",\n    \"@tanstack/react-query\": \"^5.99.0\",\n    \"@tanstack/react-virtual\": \"^3.13.23\",\n    \"@tanstack/virtual-core\": \"^3.13.23\",\n    \"@types/better-sqlite3\": \"^7.6.13\",\n    \"@udecode/plate-markdown\": \"^48.0.2\",\n    \"@xterm/addon-fit\": \"^0.11.0\",\n    \"@xterm/addon-web-links\": \"^0.12.0\",\n    \"@xterm/xterm\": \"^6.0.0\",\n    \"@xyflow/react\": \"^12.10.2\",\n    \"anser\": \"^2.3.5\",\n    \"astro\": \"6.4.8\",\n    \"astro-robots-txt\": \"^1.0.0\",\n    \"better-sqlite3\": \"^12.9.0\",\n    \"brace-expansion\": \"^1.1.21\",\n    \"cmdk\": \"^1.1.1\",\n    \"dockview\": \"^6.2.2\",\n    \"dockview-react\": \"^6.2.2\",\n    \"drizzle-orm\": \"^0.45.2\",\n    \"hast-util-from-html\": \"^2.0.3\",\n    \"lucide-react\": \"^1.14.0\",\n    \"mailparser\": \"^3.9.31\",\n    \"motion\": \"^12.38.0\",\n    \"nuqs\": \"^2.8.9\",\n    \"postgres\": \"^3.4.9\",\n    \"qrcode\": \"^1.5.4\",\n    \"react\": \"^19.2.6\",\n    \"react-dom\": \"^19.2.6\",\n    \"react-json-view-lite\": \"^2.5.0\",\n    \"react-markdown\": \"^10.1.0\",\n    \"react-responsive-carousel\": \"^3.2.23\",\n    \"react-virtuoso\": \"^4.18.6\",\n    \"reflect-metadata\": \"^0.2.2\",\n    \"remark-gfm\": \"^4.0.1\",\n    \"sonner\": \"^2.0.7\",\n    \"tailwindcss\": \"^4.2.4\",\n    \"unist-util-visit\": \"^5.0.0\",\n    \"vaul\": \"^1.1.2\",\n    \"verdict-cli\": \"^0.1.1\",\n    \"yauzl\": \"^3.4.0\",\n    \"zod\": \"^4.4.2\"\n  },\n  \"optionalDependencies\": {\n    \"onnxruntime-node\": \"1.24.3\"\n  },\n  \"overrides\": {\n    \"vitest\": \"$vitest\",\n    \"livekit-client\": \"^2.16.1\",\n    \"@assistant-ui/store\": \"0.2.9\",\n    \"@assistant-ui/tap\": \"0.5.16\",\n    \"axios\": \"^1.20.0\",\n    \"form-data\": \"^4.0.6\",\n    \"follow-redirects\": \"^1.16.1\",\n    \"brace-expansion@1\": \"^1.1.21\",\n    \"brace-expansion@2\": \"^2.1.7\",\n    \"minimatch@3\": \"^3.1.5\",\n    \"brace-expansion@5\": \"^5.0.12\",\n    \"sharp\": \"^0.35.5\",\n    \"lost-pixel\": {\n      \"esbuild\": \"0.28.2\"\n    },\n    \"@huggingface/transformers\": {\n      \"sharp\": \"^0.35.5\"\n    },\n    \"adm-zip\": \"^0.6.1\",\n    \"lodash-es\": \"^4.18.1\",\n    \"svgo\": \"^4.1.0\",\n    \"@qdrant/js-client-rest\": {\n      \"undici\": \"^7.29.1\"\n    },\n    \"@ai-sdk/provider-utils\": {\n      \"undici\": \"^6.28.1\"\n    },\n    \"@modelcontextprotocol/sdk\": \"^1.29.0\",\n    \"tsconfck\": {\n      \"typescript\": \"$typescript\"\n    },\n    \"@nx/jest\": {\n      \"@phenomnomnominal/tsquery\": \"^6.2.0\"\n    },\n    \"mem0ai\": {\n      \"@anthropic-ai/sdk\": \"^0.93.0\"\n    }\n  },\n  \"devDependencies\": {\n    \"@astrojs/check\": \"^0.9.8\",\n    \"@astrojs/node\": \"^10.0.0\",\n    \"@nx/jest\": \"22.6.5\",\n    \"@nx/nest\": \"22.6.5\",\n    \"@nx/node\": \"22.6.5\",\n    \"@nx/workspace\": \"22.6.5\",\n    \"@testcontainers/postgresql\": \"^11.14.0\",\n    \"@types/adm-zip\": \"^0.5.8\",\n    \"@types/cors\": \"^2.8.19\",\n    \"@types/jsdom\": \"^30.0.0\",\n    \"@types/mailparser\": \"^3.4.6\",\n    \"@types/node\": \"^22.0.0\",\n    \"@types/react\": \"^19.2.14\",\n    \"@types/yauzl\": \"^3.4.0\",\n    \"@typescript/native\": \"npm:typescript@7.0.2\",\n    \"@vitest/coverage-v8\": \"4.1.8\",\n    \"@vitest/ui\": \"4.1.8\",\n    \"@vscode/v8-heap-parser\": \"0.1.0\",\n    \"adm-zip\": \"^0.6.1\",\n    \"concurrently\": \"^9.2.0\",\n    \"drizzle-kit\": \"^0.31.10\",\n    \"eslint\": \"^10.4.1\",\n    \"eslint-plugin-react-hooks\": \"^7.1.1\",\n    \"fast-xml-parser\": \"^5.5.11\",\n    \"knip\": \"^5.88.1\",\n    \"msw\": \"^2.13.6\",\n    \"nx\": \"22.6.5\",\n    \"patch-package\": \"^8.0.1\",\n    \"puppeteer-core\": \"^24.43.1\",\n    \"shell-quote\": \"1.8.3\",\n    \"stream-chain\": \"^3.6.1\",\n    \"stream-json\": \"^2.1.0\",\n    \"style-dictionary\": \"^4.4.0\",\n    \"tar-stream\": \"^3.2.0\",\n    \"testcontainers\": \"^11.14.0\",\n    \"tsx\": \"^4.21.0\",\n    \"typedoc\": \"^0.28.19\",\n    \"typedoc-plugin-markdown\": \"^4.12.0\",\n    \"typescript\": \"npm:@typescript/typescript6@6.0.2\",\n    \"typescript-eslint\": \"^8.61.0\",\n    \"vite-tsconfig-paths\": \"^5.1.4\",\n    \"vitest\": \"4.1.8\",\n    \"vitest-fail-on-console\": \"^0.7.1\",\n    \"winston\": \"^3.19.0\",\n    \"winston-transport\": \"^4.9.0\",\n    \"wrangler\": \"^4.85.0\"\n  }\n}\n",
      "selectedFields": {
        "type": null,
        "engines": {
          "//": "Pin the runtime to Node 25 (ABI 141 / NODE_MODULE_VERSION 141). The fleet runs linuxbrew node 25; native addons (better-sqlite3) built under any other major (e.g. nvm 22 = ABI 127) fail to load at runtime ('Module did not self-register'). See infra-fail-fast-build-integrity-2026-06-19 P-003 + .nvmrc. Advisory (no engine-strict) — declares the pin for nvm/CI/contributors; the deploy-gate native-addon preflight is the hard ABI enforcer.",
          "node": ">=25",
          "npm": ">=11.19.0"
        }
      }
    },
    {
      "path": "apps/operator/package.json",
      "canonical": "/home/marsh-office/papercupai-workspace/papercusp/apps/operator/package.json",
      "sha256": "49fd999f0961e8e106e4412087ea8caa2f68b42bd0ce4e9454d9774d6c4815b1",
      "bytes": 15689,
      "source": "{\n  \"name\": \"@papercusp/web\",\n  \"version\": \"0.0.1\",\n  \"private\": true,\n  \"scripts\": {\n    \"dev\": \"npm --workspace @papercusp/operator-vite run dev\",\n    \"build\": \"npm --workspace @papercupai/operator-docs run build && npm --workspace @papercusp/operator-vite run build\",\n    \"start\": \"tsx bin/hono-host.ts\",\n    \"serve\": \"tsx bin/serve.ts\",\n    \"test:integration\": \"node ../../scripts/workspace-test.mjs --workspace-integration\",\n    \"pretest:e2e\": \"node ../../scripts/ensure-playwright-browsers.mjs\",\n    \"test:e2e\": \"playwright test --config playwright.config.mts\",\n    \"test:e2e:css-preload\": \"npm run build:operator --prefix ../.. && npm run test:e2e -- --config playwright.production-preview.config.ts e2e/adv-shell-nav.spec.ts --grep \\\"first lazy HUD CSS preload failure\\\" --workers=1\",\n    \"test:e2e:fixture-affected\": \"node ../../scripts/e2e-fixture-affected.mjs\",\n    \"test:e2e:isolated\": \"bash ../../scripts/run-operator-e2e-isolated.sh\",\n    \"test:e2e:hosted-http1\": \"playwright test --config playwright.hosted-http1.config.ts\",\n    \"test:e2e:ui\": \"playwright test --config playwright.config.mts --ui\",\n    \"test\": \"node ../../scripts/workspace-test.mjs --passWithNoTests\",\n    \"typecheck\": \"node ../../scripts/lint-tsc-operator.mjs\",\n    \"test:release-script-guards\": \"vitest run lib/release/tauri-signer-key-contract.test.ts lib/release/windows-rootfs-preflight.test.ts lib/release/android-versionname-preflight.test.ts lib/release/parallel-leg-supervisor.test.ts\",\n    \"test:phone-media\": \"vitest run scripts/__tests__/phone-app-hosted-config.test.ts scripts/__tests__/phone-app-edge-config.test.ts --config vitest.config.ts && vitest run scripts/__tests__/phone-app-hosted-config.integration.test.ts --config vitest.integration.config.ts && OPERATOR_E2E_REUSE_SERVER=1 playwright test e2e/phone-media-probe.spec.ts --workers=1\",\n    \"setup-wake-runtime\": \"bash scripts/setup-wake-runtime.sh\",\n    \"setup-vad-runtime\": \"bash scripts/setup-vad-runtime.sh\",\n    \"setup-vditor-runtime\": \"bash scripts/setup-vditor-runtime.sh\",\n    \"setup-monaco-runtime\": \"bash scripts/setup-monaco-runtime.sh\",\n    \"setup-excalidraw-runtime\": \"bash scripts/setup-excalidraw-runtime.sh\",\n    \"setup-porcupine-runtime\": \"bash scripts/setup-porcupine-runtime.sh\",\n    \"postinstall\": \"bash scripts/setup-wake-runtime.sh && bash scripts/setup-vad-runtime.sh && bash scripts/setup-vditor-runtime.sh && bash scripts/setup-monaco-runtime.sh && bash scripts/setup-excalidraw-runtime.sh && bash scripts/setup-porcupine-runtime.sh && node scripts/setup-elevenlabs-runtime.mjs\",\n    \"test:el-suite\": \"node scripts/el-suite-test.mjs\",\n    \"test:el-suite:required\": \"EL_SUITE_REQUIRED=1 node scripts/el-suite-test.mjs\",\n    \"verify:dogfood-bootstrap\": \"tsx scripts/run-dogfood-bootstrap.ts\",\n    \"verify:trigger-consolidation\": \"node scripts/verify-trigger-consolidation.mjs\",\n    \"verify:reactivity-e2e\": \"tsx scripts/verify-reactivity-e2e.ts\",\n    \"verify:dogfood-types\": \"vitest run lib/harness/binding-types.test.ts lib/identity/binding-verifier-types.test.ts lib/identity/attestation-types.test.ts lib/identity/contributor-file-types.test.ts lib/harness/contributor-usage-event-types.test.ts lib/harness/feature-claim-types.test.ts lib/pr-host/types.test.ts lib/pr-host/auto-review-decision-types.test.ts lib/pr-host/harness-feature-pr-row-types.test.ts lib/pr-host/retry-policy-types.test.ts lib/harness/harness-link-types.test.ts lib/harness/hyperbee-key-types.test.ts lib/cupboard/types.test.ts lib/harness/harness-shared-config-types.test.ts lib/harness/contributor-row-types.test.ts lib/harness/completion-ref-types.test.ts lib/pr-host/pr-reviewer-settings-types.test.ts lib/harness/feature-queue-row-types.test.ts lib/harness/local-audit-row-types.test.ts lib/harness/schema-version-types.test.ts lib/harness/share-wizard-step-types.test.ts lib/pr-host/pr-check-status-cache-types.test.ts lib/harness/sync-with-main-types.test.ts lib/harness/stat-tier-types.test.ts lib/harness/insights-card-types.test.ts lib/harness/user-profile-types.test.ts lib/harness/user-tree-types.test.ts lib/harness/feature-state-types.test.ts lib/harness/orchestrator-claim-decision-types.test.ts lib/harness/harness-state-types.test.ts lib/harness/create-harness-entry-types.test.ts\",\n    \"verify:all-dogfood\": \"npm run verify:dogfood-bootstrap && npm run verify:trigger-consolidation && npm run verify:dogfood-types\",\n    \"substrate:status\": \"tsx scripts/substrate-status.ts\",\n    \"cut-seed\": \"tsx lib/release/cut-seed-cli.ts\",\n    \"release:aws-ami\": \"tsx lib/release/aws-ami-release-cli.ts\",\n    \"release:gcp-image-family\": \"tsx lib/release/gcp-image-family-release-cli.ts\",\n    \"release:gcp-image-request\": \"tsx lib/release/gcp-image-release-request-cli.ts\",\n    \"release:workspace-host-publication-manifest\": \"tsx lib/release/workspace-host-publication-manifest-cli.ts\",\n    \"release:clean-room-acceptance\": \"tsx lib/release/workspace-host-clean-room-acceptance-cli.ts\",\n    \"release:p2p-candidate-manifest\": \"tsx lib/release/run-p2p-candidate-manifest.ts\",\n    \"release:p521-drill-journey-evidence\": \"tsx lib/release/run-p521-drill-journey-evidence.ts\",\n    \"release:precut-containment\": \"tsx lib/release/precut-containment-cli.ts\",\n    \"lint:el-tools\": \"node scripts/el-tools-check.mjs\",\n    \"lint:plans\": \"tsx scripts/lint-plans.ts\",\n    \"lint:plans-pg\": \"node scripts/check-plans-pg-canonical.mjs\",\n    \"lint:tests\": \"tsx scripts/lint-tests.ts\",\n    \"lint:no-hand-rolled-cli-entry\": \"node ../../scripts/check-no-hand-rolled-cli-entry.mjs\",\n    \"lint:partial-install\": \"node ../../scripts/check-partial-install.mjs\",\n    \"lint:no-fake-timers-in-integration\": \"node ../../scripts/check-fake-timers-in-integration-tests.mjs\",\n    \"storybook\": \"storybook dev -p 6009\",\n    \"build-storybook\": \"storybook build -o storybook-static\",\n    \"lostpixel\": \"lost-pixel\",\n    \"lostpixel:update\": \"LOST_PIXEL_GENERATE_ONLY=1 lost-pixel\",\n    \"rotate:spawn-key\": \"node scripts/rotate-spawn-signing-key.mjs\",\n    \"llm-test\": \"tsx bin/llm-test.ts\"\n  },\n  \"dependencies\": {\n    \"@alexanderolsen/libsamplerate-js\": \"2.1.2\",\n    \"@anthropic-ai/sdk\": \"^0.93.0\",\n    \"@assistant-ui/react\": \"^0.12.25\",\n    \"@azure/identity\": \"^4.13.1\",\n    \"@azure/search-documents\": \"^12.2.0\",\n    \"@blocknote/core\": \"^0.51.3\",\n    \"@blocknote/mantine\": \"^0.51.3\",\n    \"@blocknote/react\": \"^0.51.3\",\n    \"@bprogress/react\": \"^1.2.7\",\n    \"@browserbasehq/stagehand\": \"^3.7.3\",\n    \"@codemirror/lang-markdown\": \"^6.5.0\",\n    \"@codemirror/theme-one-dark\": \"^6.1.3\",\n    \"@dagrejs/dagre\": \"^3.0.0\",\n    \"@dbos-inc/dbos-sdk\": \"^4.27.6\",\n    \"@dnd-kit/core\": \"^6.3.1\",\n    \"@dnd-kit/sortable\": \"^8.0.0\",\n    \"@dnd-kit/utilities\": \"^3.2.2\",\n    \"@elevenlabs/client\": \"^1.4.0\",\n    \"@excalidraw/excalidraw\": \"^0.18.1\",\n    \"@formkit/auto-animate\": \"^0.9.0\",\n    \"@fullcalendar/core\": \"^6.1.20\",\n    \"@fullcalendar/daygrid\": \"^6.1.20\",\n    \"@fullcalendar/interaction\": \"^6.1.20\",\n    \"@fullcalendar/react\": \"^6.1.20\",\n    \"@fullcalendar/timegrid\": \"^6.1.20\",\n    \"@google/genai\": \"^1.52.0\",\n    \"@hono/node-server\": \"^2.0.3\",\n    \"@hookform/resolvers\": \"^5.2.2\",\n    \"@huggingface/transformers\": \"4.2.0\",\n    \"@inquirer/core\": \"^11.1.9\",\n    \"@inquirer/prompts\": \"^8.4.2\",\n    \"@jitsi/rnnoise-wasm\": \"^0.2.1\",\n    \"@langchain/core\": \"^1.2.3\",\n    \"@lexical/code\": \"^0.35.0\",\n    \"@lexical/link\": \"^0.35.0\",\n    \"@lexical/list\": \"^0.35.0\",\n    \"@lexical/markdown\": \"^0.35.0\",\n    \"@lexical/react\": \"^0.35.0\",\n    \"@lexical/rich-text\": \"^0.35.0\",\n    \"@lexical/selection\": \"^0.35.0\",\n    \"@lydell/node-pty\": \"^1.2.0-beta.12\",\n    \"@mantine/core\": \"^9.1.0\",\n    \"@mantine/hooks\": \"^9.1.0\",\n    \"@mantine/tiptap\": \"^9.1.1\",\n    \"@milkdown/crepe\": \"^7.20.0\",\n    \"@mistralai/mistralai\": \"^1.15.1\",\n    \"@modelcontextprotocol/sdk\": \"^1.29.0\",\n    \"@monaco-editor/loader\": \"^1.7.0\",\n    \"@monaco-editor/react\": \"^4.7.0\",\n    \"@octokit/rest\": \"^22.0.0\",\n    \"@openai/agents-realtime\": \"^0.8.5\",\n    \"@papercusp/agent-chat\": \"file:../../libs/agent-chat\",\n    \"@papercusp/agent-mcp\": \"file:../../packages/agent-mcp\",\n    \"@papercusp/agent-roster\": \"file:../../libs/generic/agent-roster\",\n    \"@papercusp/backup\": \"file:../../packages/backup\",\n    \"@papercusp/card-stack\": \"file:../../libs/generic/card-stack\",\n    \"@papercusp/chat-cards\": \"file:../../libs/generic/chat-cards\",\n    \"@papercusp/chat-protocol\": \"file:../../libs/generic/chat-protocol\",\n    \"@papercusp/coordination\": \"file:../../packages/coordination\",\n    \"@papercusp/db-org\": \"file:../../libs/papercusp/libs/db\",\n    \"@papercusp/deployment-driver\": \"file:../../libs/generic/deployment-driver\",\n    \"@papercusp/desktop-ipc\": \"file:../../libs/generic/desktop-ipc\",\n    \"@papercusp/dock-workbench\": \"file:../../libs/generic/dock-workbench\",\n    \"@papercusp/docs-engine\": \"file:../../packages/docs-engine\",\n    \"@papercusp/embedded-pg-discovery\": \"file:../../libs/generic/embedded-pg-discovery\",\n    \"@papercusp/embedded-postgres-server\": \"file:../../libs/papercusp/packages/embedded-postgres-server\",\n    \"@papercusp/facets\": \"file:../../libs/generic/facets\",\n    \"@papercusp/file-claim\": \"file:../../libs/papercusp/packages/file-claim\",\n    \"@papercusp/flags\": \"file:../../libs/flags\",\n    \"@papercusp/git-graph\": \"file:../../libs/generic/git-graph\",\n    \"@papercusp/grid-core\": \"file:../../libs/generic/papergrid/grid-core\",\n    \"@papercusp/harness\": \"file:../../libs/papercusp/packages/harness\",\n    \"@papercusp/host-platform\": \"file:../../libs/host-platform\",\n    \"@papercusp/ipc-endpoint-server\": \"file:../../libs/generic/ipc-endpoint-server\",\n    \"@papercusp/ipc-framing\": \"file:../../libs/generic/ipc-framing\",\n    \"@papercusp/kv-persist\": \"file:../../libs/generic/papergrid/kv-persist\",\n    \"@papercusp/kv-persist-indexeddb\": \"file:../../libs/generic/papergrid/kv-persist-indexeddb\",\n    \"@papercusp/lexicon\": \"file:../../libs/generic/lexicon\",\n    \"@papercusp/locks\": \"file:../../libs/papercusp/packages/locks\",\n    \"@papercusp/memory\": \"file:../../libs/generic/memory\",\n    \"@papercusp/model-pricing\": \"file:../../libs/generic/model-pricing\",\n    \"@papercusp/module-singleton\": \"file:../../libs/generic/module-singleton\",\n    \"@papercusp/operator-core\": \"file:../../packages/operator-core\",\n    \"@papercusp/operator-ui\": \"file:../../packages/operator-ui\",\n    \"@papercusp/orchestrator\": \"file:../../libs/papercusp/packages/orchestrator\",\n    \"@papercusp/p2p-voice\": \"file:../../libs/generic/p2p-voice\",\n    \"@papercusp/papercusp-shared\": \"file:../../libs/papercusp-shared\",\n    \"@papercusp/plan-parser\": \"file:../../libs/generic/plan-parser\",\n    \"@papercusp/plugin-loader\": \"file:../../packages/plugin-loader\",\n    \"@papercusp/plugin-sdk\": \"file:../../packages/plugin-sdk\",\n    \"@papercusp/publish-auth\": \"file:../../libs/papercusp-publish-auth\",\n    \"@papercusp/rate-limit\": \"file:../../libs/generic/rate-limit\",\n    \"@papercusp/release-profile\": \"file:../../libs/generic/release-profile\",\n    \"@papercusp/rerank\": \"file:../../libs/generic/rerank\",\n    \"@papercusp/resource-profile\": \"file:../../libs/generic/resource-profile\",\n    \"@papercusp/result-encoding\": \"file:../../libs/generic/result-encoding\",\n    \"@papercusp/rrf\": \"file:../../libs/generic/rrf\",\n    \"@papercusp/rules\": \"file:../../libs/generic/rules\",\n    \"@papercusp/scheduled-registry\": \"file:../../libs/generic/scheduled-registry\",\n    \"@papercusp/search\": \"file:../../libs/generic/search\",\n    \"@papercusp/search-core\": \"file:../../libs/generic/search-core\",\n    \"@papercusp/seed-bundle\": \"file:../../libs/generic/seed-bundle\",\n    \"@papercusp/sse\": \"file:../../libs/generic/sse\",\n    \"@papercusp/sync\": \"file:../../libs/generic/sync\",\n    \"@papercusp/testing-shell\": \"file:../../libs/testing-shell\",\n    \"@papercusp/tooldef\": \"file:../../libs/generic/tooldef\",\n    \"@papercusp/ui-primitives\": \"file:../../libs/generic/ui-primitives\",\n    \"@papercusp/verification-harness\": \"file:../../libs/generic/verification-harness\",\n    \"@picovoice/porcupine-web\": \"^4.0.0\",\n    \"@picovoice/web-voice-processor\": \"^4.0.10\",\n    \"@qdrant/js-client-rest\": \"^1.13.0\",\n    \"@radix-ui/react-checkbox\": \"^1.3.3\",\n    \"@radix-ui/react-collapsible\": \"^1.1.12\",\n    \"@radix-ui/react-dialog\": \"^1.1.15\",\n    \"@radix-ui/react-popover\": \"^1.1.6\",\n    \"@radix-ui/react-select\": \"^2.2.6\",\n    \"@radix-ui/react-slot\": \"^1.2.3\",\n    \"@radix-ui/react-tabs\": \"^1.1.13\",\n    \"@radix-ui/react-tooltip\": \"^1.2.8\",\n    \"@ricky0123/vad-web\": \"^0.0.30\",\n    \"@supabase/supabase-js\": \"^2.110.8\",\n    \"@tauri-apps/api\": \"^2.11.0\",\n    \"@tiptap/react\": \"^3.30.5\",\n    \"@tiptap/starter-kit\": \"^3.30.5\",\n    \"@toast-ui/react-editor\": \"^3.2.3\",\n    \"@udecode/plate\": \"^48.0.5\",\n    \"@udecode/plate-basic-elements\": \"^48.0.0\",\n    \"@udecode/plate-basic-marks\": \"^48.0.0\",\n    \"@udecode/plate-list\": \"^48.0.0\",\n    \"@udecode/plate-markdown\": \"^48.0.2\",\n    \"@uiw/react-codemirror\": \"^4.25.9\",\n    \"@uiw/react-md-editor\": \"^4.1.0\",\n    \"@xterm/addon-clipboard\": \"^0.2.0\",\n    \"@xterm/addon-fit\": \"^0.11.0\",\n    \"@xterm/addon-search\": \"^0.16.0\",\n    \"@xterm/addon-serialize\": \"^0.14.0\",\n    \"@xterm/addon-web-links\": \"^0.12.0\",\n    \"@xterm/addon-webgl\": \"^0.19.0\",\n    \"@xterm/headless\": \"^6.0.0\",\n    \"@xterm/xterm\": \"^6.0.0\",\n    \"@xyflow/react\": \"^12.10.2\",\n    \"ajv\": \"^8.18.0\",\n    \"ajv-errors\": \"^3.0.0\",\n    \"ajv-formats\": \"^3.0.1\",\n    \"anser\": \"^2.3.5\",\n    \"b4a\": \"^1.6.7\",\n    \"better-sqlite3\": \"^12.9.0\",\n    \"chalk\": \"^4.1.2\",\n    \"cloudflare\": \"^4.5.0\",\n    \"cmdk\": \"^1.1.1\",\n    \"compromise\": \"^14.15.0\",\n    \"corestore\": \"^7.4.0\",\n    \"cron-parser\": \"^4.9.0\",\n    \"d3\": \"6.7.0\",\n    \"diff\": \"^8.0.2\",\n    \"dockview\": \"^6.2.2\",\n    \"dockview-react\": \"^6.2.2\",\n    \"drizzle-orm\": \"^0.45.2\",\n    \"elkjs\": \"^0.12.0\",\n    \"fast-check\": \"^4.7.0\",\n    \"gremlins.js\": \"^2.2.0\",\n    \"groq-sdk\": \"^0.3.0\",\n    \"hono\": \"^4.13.7\",\n    \"html-to-image\": \"^1.11.13\",\n    \"hyperbee\": \"^2.20.0\",\n    \"hypercore\": \"^11.5.0\",\n    \"hyperdht\": \"^6.20.0\",\n    \"hyperdrive\": \"^12.0.0\",\n    \"hyperswarm\": \"^4.11.7\",\n    \"lexical\": \"^0.35.0\",\n    \"lucide-react\": \"^1.14.0\",\n    \"marked\": \"^15.0.12\",\n    \"markmap-common\": \"0.14.2\",\n    \"markmap-view\": \"0.14.3\",\n    \"mcp-handler\": \"^1.1.0\",\n    \"mem0ai\": \"^3.3.1\",\n    \"monaco-editor\": \"^0.56.0\",\n    \"motion\": \"^12.38.0\",\n    \"nuqs\": \"^2.8.9\",\n    \"ollama\": \"^0.5.18\",\n    \"openwakeword-js\": \"^0.1.27\",\n    \"opusscript\": \"^0.1.1\",\n    \"postgres\": \"^3.4.9\",\n    \"posthog-js\": \"^1.219.0\",\n    \"posthog-node\": \"^5.34.1\",\n    \"qrcode\": \"^1.5.4\",\n    \"react\": \"^19.2.0\",\n    \"react-diff-view\": \"^3.3.3\",\n    \"react-dom\": \"^19.2.0\",\n    \"react-hook-form\": \"^7.75.0\",\n    \"react-joyride\": \"3.2.0\",\n    \"react-json-view-lite\": \"^2.5.0\",\n    \"react-markdown\": \"^10.1.0\",\n    \"react-virtuoso\": \"^4.18.6\",\n    \"remark-gfm\": \"^4.0.1\",\n    \"rrule\": \"^2.8.1\",\n    \"slate\": \"^0.114.0\",\n    \"sonner\": \"^2.0.7\",\n    \"tar-fs\": \"^2.1.4\",\n    \"unist-util-visit\": \"^5.0.0\",\n    \"vaul\": \"^1.1.2\",\n    \"vditor\": \"^3.11.2\",\n    \"verdict-cli\": \"^0.1.1\",\n    \"webfontloader\": \"1.6.28\",\n    \"winston\": \"^3.19.0\",\n    \"winston-transport\": \"^4.9.0\",\n    \"ws\": \"^8.18.0\",\n    \"zod\": \"^4.4.2\"\n  },\n  \"devDependencies\": {\n    \"@axe-core/playwright\": \"^4.11.3\",\n    \"@papercusp/test-config\": \"*\",\n    \"@playwright/test\": \"^1.59.1\",\n    \"@storybook/addon-docs\": \"^10.3.6\",\n    \"@storybook/react-vite\": \"^10.3.6\",\n    \"@tailwindcss/postcss\": \"^4.2.4\",\n    \"@types/dom-mediacapture-record\": \"^1.0.22\",\n    \"@types/node\": \"^22\",\n    \"@types/qrcode\": \"^1.5.5\",\n    \"@types/react\": \"^19\",\n    \"@types/react-dom\": \"^19\",\n    \"@types/tar-fs\": \"^2.0.4\",\n    \"@typescript/native\": \"npm:typescript@7.0.2\",\n    \"driver.js\": \"1.8.0\",\n    \"lost-pixel\": \"^3.22.0\",\n    \"storybook\": \"^10.3.6\",\n    \"typescript\": \"npm:@typescript/typescript6@6.0.2\",\n    \"vitest\": \"^4.1.4\"\n  }\n}\n",
      "selectedFields": {
        "type": null,
        "scripts": {
          "dev": "npm --workspace @papercusp/operator-vite run dev",
          "build": "npm --workspace @papercupai/operator-docs run build && npm --workspace @papercusp/operator-vite run build",
          "start": "tsx bin/hono-host.ts",
          "serve": "tsx bin/serve.ts",
          "test:integration": "node ../../scripts/workspace-test.mjs --workspace-integration",
          "pretest:e2e": "node ../../scripts/ensure-playwright-browsers.mjs",
          "test:e2e": "playwright test --config playwright.config.mts",
          "test:e2e:css-preload": "npm run build:operator --prefix ../.. && npm run test:e2e -- --config playwright.production-preview.config.ts e2e/adv-shell-nav.spec.ts --grep \"first lazy HUD CSS preload failure\" --workers=1",
          "test:e2e:fixture-affected": "node ../../scripts/e2e-fixture-affected.mjs",
          "test:e2e:isolated": "bash ../../scripts/run-operator-e2e-isolated.sh",
          "test:e2e:hosted-http1": "playwright test --config playwright.hosted-http1.config.ts",
          "test:e2e:ui": "playwright test --config playwright.config.mts --ui",
          "test": "node ../../scripts/workspace-test.mjs --passWithNoTests",
          "typecheck": "node ../../scripts/lint-tsc-operator.mjs",
          "test:release-script-guards": "vitest run lib/release/tauri-signer-key-contract.test.ts lib/release/windows-rootfs-preflight.test.ts lib/release/android-versionname-preflight.test.ts lib/release/parallel-leg-supervisor.test.ts",
          "test:phone-media": "vitest run scripts/__tests__/phone-app-hosted-config.test.ts scripts/__tests__/phone-app-edge-config.test.ts --config vitest.config.ts && vitest run scripts/__tests__/phone-app-hosted-config.integration.test.ts --config vitest.integration.config.ts && OPERATOR_E2E_REUSE_SERVER=1 playwright test e2e/phone-media-probe.spec.ts --workers=1",
          "setup-wake-runtime": "bash scripts/setup-wake-runtime.sh",
          "setup-vad-runtime": "bash scripts/setup-vad-runtime.sh",
          "setup-vditor-runtime": "bash scripts/setup-vditor-runtime.sh",
          "setup-monaco-runtime": "bash scripts/setup-monaco-runtime.sh",
          "setup-excalidraw-runtime": "bash scripts/setup-excalidraw-runtime.sh",
          "setup-porcupine-runtime": "bash scripts/setup-porcupine-runtime.sh",
          "postinstall": "bash scripts/setup-wake-runtime.sh && bash scripts/setup-vad-runtime.sh && bash scripts/setup-vditor-runtime.sh && bash scripts/setup-monaco-runtime.sh && bash scripts/setup-excalidraw-runtime.sh && bash scripts/setup-porcupine-runtime.sh && node scripts/setup-elevenlabs-runtime.mjs",
          "test:el-suite": "node scripts/el-suite-test.mjs",
          "test:el-suite:required": "EL_SUITE_REQUIRED=1 node scripts/el-suite-test.mjs",
          "verify:dogfood-bootstrap": "tsx scripts/run-dogfood-bootstrap.ts",
          "verify:trigger-consolidation": "node scripts/verify-trigger-consolidation.mjs",
          "verify:reactivity-e2e": "tsx scripts/verify-reactivity-e2e.ts",
          "verify:dogfood-types": "vitest run lib/harness/binding-types.test.ts lib/identity/binding-verifier-types.test.ts lib/identity/attestation-types.test.ts lib/identity/contributor-file-types.test.ts lib/harness/contributor-usage-event-types.test.ts lib/harness/feature-claim-types.test.ts lib/pr-host/types.test.ts lib/pr-host/auto-review-decision-types.test.ts lib/pr-host/harness-feature-pr-row-types.test.ts lib/pr-host/retry-policy-types.test.ts lib/harness/harness-link-types.test.ts lib/harness/hyperbee-key-types.test.ts lib/cupboard/types.test.ts lib/harness/harness-shared-config-types.test.ts lib/harness/contributor-row-types.test.ts lib/harness/completion-ref-types.test.ts lib/pr-host/pr-reviewer-settings-types.test.ts lib/harness/feature-queue-row-types.test.ts lib/harness/local-audit-row-types.test.ts lib/harness/schema-version-types.test.ts lib/harness/share-wizard-step-types.test.ts lib/pr-host/pr-check-status-cache-types.test.ts lib/harness/sync-with-main-types.test.ts lib/harness/stat-tier-types.test.ts lib/harness/insights-card-types.test.ts lib/harness/user-profile-types.test.ts lib/harness/user-tree-types.test.ts lib/harness/feature-state-types.test.ts lib/harness/orchestrator-claim-decision-types.test.ts lib/harness/harness-state-types.test.ts lib/harness/create-harness-entry-types.test.ts",
          "verify:all-dogfood": "npm run verify:dogfood-bootstrap && npm run verify:trigger-consolidation && npm run verify:dogfood-types",
          "substrate:status": "tsx scripts/substrate-status.ts",
          "cut-seed": "tsx lib/release/cut-seed-cli.ts",
          "release:aws-ami": "tsx lib/release/aws-ami-release-cli.ts",
          "release:gcp-image-family": "tsx lib/release/gcp-image-family-release-cli.ts",
          "release:gcp-image-request": "tsx lib/release/gcp-image-release-request-cli.ts",
          "release:workspace-host-publication-manifest": "tsx lib/release/workspace-host-publication-manifest-cli.ts",
          "release:clean-room-acceptance": "tsx lib/release/workspace-host-clean-room-acceptance-cli.ts",
          "release:p2p-candidate-manifest": "tsx lib/release/run-p2p-candidate-manifest.ts",
          "release:p521-drill-journey-evidence": "tsx lib/release/run-p521-drill-journey-evidence.ts",
          "release:precut-containment": "tsx lib/release/precut-containment-cli.ts",
          "lint:el-tools": "node scripts/el-tools-check.mjs",
          "lint:plans": "tsx scripts/lint-plans.ts",
          "lint:plans-pg": "node scripts/check-plans-pg-canonical.mjs",
          "lint:tests": "tsx scripts/lint-tests.ts",
          "lint:no-hand-rolled-cli-entry": "node ../../scripts/check-no-hand-rolled-cli-entry.mjs",
          "lint:partial-install": "node ../../scripts/check-partial-install.mjs",
          "lint:no-fake-timers-in-integration": "node ../../scripts/check-fake-timers-in-integration-tests.mjs",
          "storybook": "storybook dev -p 6009",
          "build-storybook": "storybook build -o storybook-static",
          "lostpixel": "lost-pixel",
          "lostpixel:update": "LOST_PIXEL_GENERATE_ONLY=1 lost-pixel",
          "rotate:spawn-key": "node scripts/rotate-spawn-signing-key.mjs",
          "llm-test": "tsx bin/llm-test.ts"
        }
      }
    },
    {
      "path": "packages/operator-core/lib/endpoint-route/cors.ts",
      "canonical": "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/endpoint-route/cors.ts",
      "sha256": "a0805dac79c5de8e10e8e743a5655151f6fce43ddfc14add90ea148bbc9ddf34",
      "bytes": 4381,
      "source": "/**\n * Centralized cross-origin CORS for the route layer.\n *\n * A route opts into cross-origin reachability with `cors: true` (default\n * allowlist) or `cors: { origins }` (explicit override); `registerRoute`\n * applies the matching middleware. Orthogonal to auth — see the `cors`\n * field on the route definition. Not device-specific: any cross-origin\n * client uses the same field.\n *\n * Default origin policy — the cross-origin clients (paired devices, the\n * desktop WebView, dev tabs):\n *   - `*://tauri.localhost`   — the desktop WebView\n *   - `http://localhost:*`    — browser-dev tabs\n *   - `http://127.0.0.1:*`    — same, IP form\n *   - `http://10.0.2.2:*`     — the Android emulator's host alias\n * Anything else is refused (empty `Access-Control-Allow-Origin`).\n *\n * `credentials: true` is required because device requests carry the JWT\n * in `Authorization`; with credentials enabled the origin MUST be echoed\n * exactly (never `*`) — the function form does that.\n */\n\nimport { cors } from 'hono/cors';\nimport type { MiddlewareHandler } from 'hono';\n\n/** Default cross-origin allowlist test — returns the origin if allowed, else ''. */\nexport function defaultCorsOrigin(origin: string | undefined | null): string {\n  if (!origin) return origin ?? '';\n  if (origin.endsWith('://tauri.localhost')) return origin;\n  if (origin.startsWith('http://localhost:')) return origin;\n  if (origin.startsWith('http://127.0.0.1:')) return origin;\n  if (origin.startsWith('http://10.0.2.2:')) return origin;\n  return '';\n}\n\n/**\n * Build a CORS middleware. `origins` undefined → the default allowlist;\n * an explicit list → exact-match against it. Applied by `registerRoute`\n * for `cors`-enabled routes; handles the OPTIONS preflight itself (204 +\n * headers) so the route file never needs an OPTIONS handler.\n */\nexport function corsFor(origins?: readonly string[]): MiddlewareHandler {\n  return cors({\n    origin: origins\n      ? (origin) => (origin && origins.includes(origin) ? origin : '')\n      : (origin) => defaultCorsOrigin(origin),\n    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],\n    allowHeaders: [\n      'authorization',\n      'content-type',\n      'last-event-id',\n      'x-papercusp-run-id',\n      // Per-window workspace context — stamped on EVERY operator API fetch by\n      // installWorkspaceHeaderFetch, including the deliberately cross-origin\n      // sibling-loopback calls from crossOriginUrl() (saved-prompts, git/show).\n      // Omitting it here makes those preflights strip the header and the\n      // browser block the call outright (harness-settings e2e, 2026-06-10).\n      'x-papercusp-workspace',\n      'x-papercusp-machine',\n    ],\n    credentials: true,\n    maxAge: 600,\n  });\n}\n\n/**\n * CSRF guard for state-mutating handlers that admit the cookie-less desktop\n * webview (EI-338) — i.e. routes whose auth tier accepts `unverified-loopback`\n * or the default-user fallback, so the tier no longer blocks a cross-origin\n * browser page from POSTing to 127.0.0.1.\n *\n * Why a guard is still needed despite CORS: CORS stops a foreign page from\n * READING a response, and the JSON preflight stops most writes — but a\n * cross-origin SIMPLE request (e.g. `POST` with `text/plain` to dodge the\n * preflight) still EXECUTES server-side. The `verified/trusted` tier used to\n * be the backstop for that; loosening it to admit the webview removed it. This\n * restores it on the `Origin` header, which a browser always stamps on a\n * cross-origin request and JS cannot forge:\n *   - no `Origin` (non-browser: curl, server-to-server, SU bearer, or a\n *     same-origin GET that omits it) → allow.\n *   - `Origin` present → must pass `defaultCorsOrigin` (the SAME allowlist the\n *     CORS layer already trusts for the desktop/device clients), so every\n *     legitimate webview/device call passes and a foreign page is refused.\n *\n * Returns a 403 `Response` to short-circuit the handler, or `null` to proceed.\n * Call at the top of a mutating handler:\n *\n *   const csrf = requireAllowedOriginOr403(req);\n *   if (csrf) return csrf;\n */\nexport function requireAllowedOriginOr403(req: Request): Response | null {\n  const origin = req.headers.get('origin');\n  if (!origin) return null;\n  if (defaultCorsOrigin(origin)) return null;\n  return Response.json({ error: 'cross_origin_blocked' }, { status: 403 });\n}\n"
    }
  ],
  "instrument": {
    "language": "JavaScript; TypeScript AST/static data only",
    "source": "import fs from 'node:fs';\nimport { createHash } from 'node:crypto';\nimport { execFileSync } from 'node:child_process';\nimport assert from 'node:assert/strict';\nimport ts from 'typescript';\nimport { boundedFrontier } from './scripts/lib/source-path-census.mjs';\nconst sha = x => createHash('sha256').update(x).digest('hex');\nconst git = args => execFileSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024}).trim();\nassert.equal(git(['branch','--show-current']),'staging');\nconst headBefore=git(['rev-parse','HEAD']);\nconst predecessorPath='.papercusp/scratch/ei267253-source-frontier-d008-20261024-v4.json';\nconst predecessorText=fs.readFileSync(predecessorPath,'utf8');\nassert.equal(sha(predecessorText),'6163a8bd410c2eb46ccd30d256d27146ebb9440c810a5eaa66a9fcef8880e309');\nconst prior=JSON.parse(predecessorText);\nassert.equal(prior.union.bound,60);assert.equal(prior.union.additions.length,58);\nconst initial=JSON.parse(fs.readFileSync(prior.predecessor.rawResult,'utf8'));\nconst baselineBytes=fs.readFileSync(initial.baseline.path);\nassert.equal(sha(baselineBytes),initial.baseline.sha256);\nconst baseline=JSON.parse(baselineBytes);\nconst inputs=new Map();\nfunction input(path,full=true){\n const bytes=fs.readFileSync(path),source=bytes.toString('utf8');\n const out={path,canonical:fs.realpathSync(path),sha256:sha(bytes),bytes:bytes.length,...(full?{source}:{})};\n inputs.set(path,out);return {out,source};\n}\nconst packagePath='node_modules/hono/package.json';\nconst packageUnit=input(packagePath), pkg=JSON.parse(packageUnit.source), ex=pkg.exports['./cors'];\nassert.equal(pkg.name,'hono');assert.equal(pkg.version,'4.13.7');\nassert.equal(packageUnit.out.sha256,'2bde0291b747985deffb5e9d8c25ce16b45becd59205987b448affdc1c2d9e7e');\nconst esmPath='node_modules/hono/'+ex.import.replace(/^\\.\\//,'');\nconst cjsPath='node_modules/hono/'+ex.require.replace(/^\\.\\//,'');\nconst scopePath='node_modules/hono/dist/cjs/package.json';\nconst esm=input(esmPath),cjs=input(cjsPath),scope=input(scopePath);\nassert.equal(sha(esm.source),'b4084f07f48ab369a8b58cfd90ac277cd590ca618842ba4132bc53642ad990fd');\nassert.equal(sha(cjs.source),'de0172ee0264fde48a9312bc0d7fdbb6c3c46f8e3df6d968c8acf105af006ae7');\nassert.equal(JSON.parse(scope.source).type,'commonjs');\nconst lockInputs=['package-lock.json','node_modules/.package-lock.json'].map(path=>{\n const unit=input(path,false),lock=JSON.parse(unit.source),entry=lock.packages['node_modules/hono'];\n assert.equal(entry.version,pkg.version);\n unit.out.selectedEntry=entry;\n return {path,sha256:unit.out.sha256,lockfileVersion:lock.lockfileVersion,entry};\n});\nassert.deepEqual(lockInputs[0].entry,lockInputs[1].entry);\nconst rootPackage=input('package.json'),operatorPackage=input('apps/operator/package.json');\nrootPackage.out.selectedFields={type:JSON.parse(rootPackage.source).type??null,engines:JSON.parse(rootPackage.source).engines};\noperatorPackage.out.selectedFields={type:JSON.parse(operatorPackage.source).type??null,scripts:JSON.parse(operatorPackage.source).scripts};\nconst cors=input('packages/operator-core/lib/endpoint-route/cors.ts');\nassert.equal(cors.out.sha256,prior.pins.find(x=>x.path===cors.out.path).sha256);\nfunction astUnit(path,source){\n const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true);\n assert.equal(ast.parseDiagnostics.length,0);\n const span=node=>{const start=node.getStart(ast),end=node.end,point=ast.getLineAndCharacterOfPosition(start);\n return {path,start,end,line:point.line+1,column:point.character+1,source:source.slice(start,end),sourceSha256:sha(source.slice(start,end)),fileSha256:sha(source)};};\n const statements=ast.statements.map(n=>({...span(n),kind:ts.SyntaxKind[n.kind],\n   effect:n.kind===ts.SyntaxKind.VariableStatement&&n.declarationList.declarations.every(d=>d.initializer&&ts.isArrowFunction(d.initializer))\n     ?'binding assignment to deferred arrow function; function body is not invoked by this declaration'\n     :n.kind===ts.SyntaxKind.ExportDeclaration?'export table declaration; not a function invocation'\n     :'requires initialization/body analysis; not discharged by import-list absence'}));\n return {ast,span,statements};\n}\nconst esmAst=astUnit(esmPath,esm.source),cjsAst=astUnit(cjsPath,cjs.source),corsAst=astUnit(cors.out.path,cors.source);\nassert.equal(esmAst.statements.length,2);\nassert.equal(esmAst.statements[0].effect,'binding assignment to deferred arrow function; function body is not invoked by this declaration');\nconst corsCalls=[];\nfunction visitCors(n){if(ts.isCallExpression(n)&&n.expression.getText(corsAst.ast)==='cors'){\n let parent=n.parent,insideFunction=false;while(parent){if(ts.isFunctionLike(parent))insideFunction=true;parent=parent.parent;}\n corsCalls.push({...corsAst.span(n),deferredWithinDeclaredFunction:insideFunction});\n}ts.forEachChild(n,visitCors)}visitCors(corsAst.ast);\nassert.equal(corsCalls.length,1);assert.equal(corsCalls[0].deferredWithinDeclaredFunction,true);\nconst candidateSet=[\n {condition:'package exports import condition; root package type module',path:esmPath,sha256:esm.out.sha256,selection:'RETAINED; actual serving-loader/transform choice UNKNOWN'},\n {condition:'package exports require condition; nested dist/cjs package type commonjs',path:cjsPath,sha256:cjs.out.sha256,selection:'RETAINED; createRequire result is not serving-loader proof'}\n];\n// Resolution metadata participates in the runtime loader. It is not waived merely because it is JSON or vendor-owned.\nconst requiredRuntimePaths=[\n {path:packagePath,role:'runtime package export-map and package-scope input',from:prior.firstUnresolved.chain[1]},\n {path:esmPath,role:'retained import candidate implementation',from:{path:packagePath,exportKey:'./cors.import'}},\n {path:cjsPath,role:'retained require candidate implementation',from:{path:packagePath,exportKey:'./cors.require'}},\n {path:scopePath,role:'retained require candidate package-scope input',from:{path:cjsPath}}\n];\nfor(const row of requiredRuntimePaths){assert.equal(baseline.includes(row.path),false);assert.equal(prior.union.additions.includes(row.path),false);}\nconst frontier=boundedFrontier(requiredRuntimePaths,{baseline,priorAdditions:prior.union.additions,bound:60});\nassert.equal(frontier.status,'STOPPED-bound');\nassert.equal(frontier.refusedEdge.path,cjsPath);\nassert.equal(frontier.additions.length,60);\nassert.deepEqual(frontier.additions.slice(0,58),prior.union.additions);\nconst implementationOnly=boundedFrontier(requiredRuntimePaths.filter(x=>x.role.includes('implementation')),{baseline,priorAdditions:prior.union.additions,bound:60});\nassert.equal(implementationOnly.additions.length,60);\nconst launcherPath='apps/operator/scripts/psu-launcher.mjs';\nconst workingLauncherSha=sha(fs.readFileSync(launcherPath));\nconst committedLauncherSha=sha(execFileSync('git',['show',headBefore+':'+launcherPath],{maxBuffer:16*1024*1024}));\nconst headAfter=git(['rev-parse','HEAD']);\nfor(const row of inputs.values())assert.equal(sha(fs.readFileSync(row.path)),row.sha256,'input moved during static read: '+row.path);\nconst result={\n schemaVersion:'ei267253-d010-external-partial-v5',at:new Date().toISOString(),owningWorkItem:'EI-26725363534104440',\n authority:'dream-loaded-control-observations-2026-10-17#D-010',partial:true,receipt:false,fullClosureQualified:false,\n status:'STOPPED-bound-at-retained-commonjs-candidate',headBefore,headAfter,\n predecessor:{path:predecessorPath,sha256:sha(predecessorText),archive:'evidence/ei267253-source-frontier-d008-20261024-v4.json'},\n baseline:{path:initial.baseline.path,sha256:sha(baselineBytes),role:'counting membership only; not inherited runtime closure'},\n package:{name:pkg.name,version:pkg.version,type:pkg.type,exportMap:ex,lockInputs,cjsScope:JSON.parse(scope.source),\n provenanceLimit:'Lock/install metadata entries agree, and exact installed bytes are hashed. No tarball-to-installed byte attestation, actual serving-loader selection or live runtime state is asserted.'},\n loaderConditions:{source:'TS import syntax and createRequire probe do not select one serving route. Root/operator manifests advertise tsx routes; transformed/serving artifact and its conditions are not proved.',candidateSet,policy:'Retain both candidates; require complete conservative analysis before discharging ambiguity.'},\n runtimeAccounting:{policy:'Retain original58. Count required runtime export/package-scope metadata and implementations in one60 union; no JSON/vendor exemption.',requiredRuntimePaths,frontier,\n implementationOnlySensitivity:{count:implementationOnly.additions.length,scope:'Two implementation candidates alone fill the bound. This does not waive the two required package-resolution inputs or qualify the alternative count.'}},\n initialization:{esm:{statements:esmAst.statements,scope:'Complete top-level syntactic statement inventory with deferred arrow/export semantics; not an actual-loader or callback execution proof.'},\n corsCaller:{calls:corsCalls,scope:'cors factory call is inside corsFor declaration; selected CSRF import still eagerly loads the external module.'},\n cjs:{preflightStatements:cjsAst.statements,qualified:false,reason:'Candidate source was inspected as resolution preflight, but its path is the first refused runtime addition. CJS export helpers/callbacks/intrinsics are not discharged and no FIFO continuation proceeds past the stop.'}},\n firstUnresolved:{kind:'required-runtime-union-bound',refusedPath:frontier.refusedEdge.path,sourceExportMap:ex,\n predicate:'Both import/require remain possible. The conservative runtime input set cannot be completed inside the same60 union after retaining58; do not drop metadata, a candidate, prior additions, or reset the bound to manufacture closure.',\n optionalClassificationRuling:'If metadata is claimed to be outside the bound, that classification is not established here; retain it as pending, not as an exemption.'},\n currentness:{workingLauncherSha,committedLauncherSha,equalsCommitted:workingLauncherSha===committedLauncherSha,equalsV4:workingLauncherSha===prior.pins.find(x=>x.path===launcherPath).sha256,\n limit:'No peer launcher mutation or integrated rebinding was done. Any prospective receipt requires current committed selected-site/callee initialization rebinding, pinned nested inputs, complete reported locks and byte stability.'},\n pending:{original55Seeds:prior.pending.remainingSeededFrontier,original147Sites:prior.pending.savedUnresolvedSites,originalHostInitialization:prior.hostCallback.initializationPending,\n resolutionResidue:frontier.pending,needed:'Actual admissible loader/transform proof that narrows alternatives, or source-method disposition of this non-dischargeable bound. No new source traversal until disposition.'},\n inputs:[...inputs.values()],instrument:{language:'JavaScript; TypeScript AST/static data only',source:instrumentSource,sha256:sha(instrumentSource)},\n effects:'No production module import/execute, host probe, native/provider/test/fullcopy replay, new worker/reviewer, budget/funding/home/control, shared restart, manual git, LIVE_GATE_OPS or shipment action.'\n};\nprocess.stdout.write(JSON.stringify(result,null,2));\n",
    "sha256": "4b2ff02a27d0e0da98e881b52b428425c01082ffa5c0c2fd133f16b13e349d77",
    "helper": {
      "path": "scripts/lib/source-path-census.mjs",
      "sha256": "758a5773eb3854065c5e9106930ed8304baa8c9bcba1d05923017a36fda22a60",
      "unchangedFromD007": true,
      "source": "/** Static preparation only. Sites are syntax evidence, never runtime/callee closure. */\nimport ts from 'typescript';\nimport { createHash } from 'node:crypto';\nconst hash = text => createHash('sha256').update(text).digest('hex');\nconst functions = node => ts.isFunctionLike(node) && !!node.body;\nconst unwrap = node => ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node)\n  ? unwrap(node.expression) : node;\nconst label = node => {\n  if (node.name) return node.name.getText();\n  if (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)) return node.parent.name.getText();\n  if (ts.isCallExpression(node.parent)) return node.parent.expression.getText() + '.callback';\n  return '<anonymous>';\n};\n\n/** Retain every call/import occurrence, its source span, function and predicate context. */\nexport function censusSites(path, text) {\n  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);\n  if (ast.parseDiagnostics.length) throw new Error('Source parse failed: ' + path);\n  const sites = [], bindings = new Map();\n  const span = node => {\n    const start = node.getStart(ast), end = node.end;\n    const point = ast.getLineAndCharacterOfPosition(start);\n    return { start, end, byteStart: Buffer.byteLength(text.slice(0, start)),\n      byteEnd: Buffer.byteLength(text.slice(0, end)), line: point.line + 1, column: point.character + 1 };\n  };\n  const bind = (pattern, expression) => {\n    if (!pattern || !expression) return;\n    expression = unwrap(expression);\n    if (ts.isArrayBindingPattern(pattern) && ts.isCallExpression(expression)\n        && expression.expression.getText() === 'Promise.all' && ts.isArrayLiteralExpression(expression.arguments[0])) {\n      pattern.elements.forEach((element, i) => {\n        if (ts.isBindingElement(element)) bind(element.name, expression.arguments[0].elements[i]);\n      });\n      return;\n    }\n    if (!ts.isObjectBindingPattern(pattern)) return;\n    const imports = [];\n    const find = node => {\n      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword\n          && ts.isStringLiteralLike(node.arguments[0])) imports.push(node.arguments[0].text);\n      ts.forEachChild(node, find);\n    };\n    find(expression);\n    for (const element of pattern.elements) if (ts.isIdentifier(element.name)) {\n      const entry = { imported: (element.propertyName ?? element.name).getText(), specifiers: [...new Set(imports)] };\n      // A second lexical binding is ambiguous; never silently pick one scope.\n      bindings.set(element.name.text, bindings.has(element.name.text) ? null : entry);\n    }\n  };\n  const visit = (node, context = [], predicates = []) => {\n    if (ts.isVariableDeclaration(node)) bind(node.name, node.initializer);\n    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings\n        && ts.isNamedImports(node.importClause.namedBindings)) {\n      for (const element of node.importClause.namedBindings.elements) {\n        const entry = { imported: (element.propertyName ?? element.name).text, specifiers: [node.moduleSpecifier.text] };\n        bindings.set(element.name.text, bindings.has(element.name.text) ? null : entry);\n      }\n    }\n    const isImport = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier;\n    const isCall = ts.isCallExpression(node) || ts.isNewExpression(node);\n    if (isImport || isCall) {\n      const dynamicImport = isCall && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === 'require');\n      const literal = isImport ? node.moduleSpecifier : dynamicImport ? node.arguments?.[0] : null;\n      const kind = isImport ? 'import' : dynamicImport ? 'dynamic-import' : 'call';\n      const typeOnly = !!(isImport && (node.isTypeOnly || node.importClause?.isTypeOnly));\n      sites.push({ path, ...span(node), kind, typeOnly,\n        expression: isImport ? 'import' : node.expression.getText(),\n        specifier: literal && ts.isStringLiteralLike(literal) ? literal.text : null,\n        source: node.getText(ast), enclosingFunctions: context, predicates,\n        initialization: context.length === 0, node });\n    }\n    const nextContext = functions(node) ? [...context, label(node)] : context;\n    if (ts.isIfStatement(node)) {\n      visit(node.expression, nextContext, predicates);\n      visit(node.thenStatement, nextContext, [...predicates, { condition: node.expression.getText(), side: true, ...span(node) }]);\n      if (node.elseStatement) visit(node.elseStatement, nextContext, [...predicates, { condition: node.expression.getText(), side: false, ...span(node) }]);\n    } else ts.forEachChild(node, child => visit(child, nextContext, predicates));\n  };\n  visit(ast);\n  const occurrences = new Map();\n  for (const site of sites) {\n    const base = JSON.stringify([site.kind, site.enclosingFunctions, site.predicates.map(p => [p.condition, p.side]), site.source]);\n    const occurrence = (occurrences.get(base) ?? 0) + 1; occurrences.set(base, occurrence);\n    site.fingerprint = hash(base + '\\0' + occurrence);\n    site.binding = bindings.get(site.expression) ?? null;\n    site.calleeCoverage = site.kind === 'call' ? 'UNKNOWN' : null;\n  }\n  return { path, sha256: hash(text), ast, sites, span };\n}\n\nexport function changedSites(before, after) {\n  const old = new Set(before.sites.map(site => site.fingerprint));\n  const current = new Set(after.sites.map(site => site.fingerprint));\n  return { addedOrChanged: after.sites.filter(site => !old.has(site.fingerprint)),\n    removedOrChanged: before.sites.filter(site => !current.has(site.fingerprint)) };\n}\n\nconst terminal = node => ts.isReturnStatement(node) || ts.isThrowStatement(node)\n  || ts.isBlock(node) && node.statements.length > 0 && terminal(node.statements[node.statements.length - 1]);\n\n/** Select a declared source path. Only exact predicates and unconditional terminal blocks exclude sites. */\nexport function selectSourcePath(unit, { functionName, containerName, branchValues = {} }) {\n  const cutoffs = [];\n  const containers = [];\n  const visit = node => {\n    if (ts.isVariableDeclaration(node) && node.name.getText() === containerName) containers.push(unit.span(node));\n    if (ts.isBlock(node)) for (const statement of node.statements) {\n      if (!ts.isIfStatement(statement)) continue;\n      const condition = statement.expression.getText();\n      if (!Object.hasOwn(branchValues, condition)) continue;\n      const branch = branchValues[condition] ? statement.thenStatement : statement.elseStatement;\n      if (branch && terminal(branch)) cutoffs.push({ after: statement.end, until: node.end,\n        condition, value: branchValues[condition], terminalBranch: unit.span(branch) });\n    }\n    ts.forEachChild(node, visit);\n  };\n  visit(unit.ast);\n  const selected = [], excluded = [];\n  for (const site of unit.sites) {\n    if (site.typeOnly) continue;\n    if (!site.initialization && !site.enclosingFunctions.includes(functionName)) continue;\n    if (!site.initialization && containerName && !containers.some(c => site.start >= c.start && site.end <= c.end)) continue;\n    const mismatch = site.predicates.find(p => Object.hasOwn(branchValues, p.condition) && branchValues[p.condition] !== p.side);\n    const cutoff = cutoffs.find(c => site.start > c.after && site.end <= c.until\n      && !site.predicates.some(p => Object.hasOwn(branchValues, p.condition) && branchValues[p.condition] !== p.side));\n    if (mismatch || cutoff) excluded.push({ site, reason: mismatch ? 'declared-predicate-excludes-branch' : 'selected-branch-terminates-before-site', proof: mismatch ?? cutoff });\n    else selected.push(site);\n  }\n  return { selected, excluded };\n}\n\n/** One bound over a union, including seeds supplied by earlier preparation. Never reset per root. */\nexport function boundedFrontier(edges, { baseline = [], priorAdditions = [], bound = 60 } = {}) {\n  const retained = new Set(baseline), additions = new Set(priorAdditions), frontier = [];\n  for (let i = 0; i < edges.length; i++) {\n    const edge = edges[i];\n    if (!edge.path || retained.has(edge.path) || additions.has(edge.path)) continue;\n    if (additions.size >= bound) return { status: 'STOPPED-bound', bound, additions: [...additions],\n      frontier, refusedEdge: edge, pending: edges.slice(i), complete: false };\n    additions.add(edge.path); frontier.push(edge);\n  }\n  return { status: 'PARTIAL-seeded-frontier', bound, additions: [...additions], frontier, complete: false };\n}\n\n/** Remove parser nodes/functions before persistence; the complete source is separately hash-bound. */\nexport function siteEvidence(site) {\n  const { node, ...evidence } = site;\n  return { ...evidence, sourceSha256: hash(site.source), source: site.source.slice(0, 500),\n    sourceTruncated: site.source.length > 500 };\n}\n"
    }
  },
  "effects": "No production module import/execute, host probe, native/provider/test/fullcopy replay, new worker/reviewer, budget/funding/home/control, shared restart, manual git, LIVE_GATE_OPS or shipment action."
}
