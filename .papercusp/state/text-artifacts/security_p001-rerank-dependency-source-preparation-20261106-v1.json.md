---
rel_path: "security/p001-rerank-dependency-source-preparation-20261106-v1.json"
updated_at: 1793940708331
_body: "content"
---

{
  "schema": "p001-rerank-dependency-source-preparation-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "currentWorkItem": "WI-6554700010045753",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "status": "source-preparation-only-unqualified",
  "recordedAt": "2026-11-06T04:51:48.297Z",
  "sources": {
    "priorCanonical": "security/p001-native-distribution-source-classification-20261106-rerank-worker-script-v17.json",
    "lock": "security/p001-rerank-dependency-lock-identities-20261106-v1.json",
    "lockVerification": "security/p001-rerank-dependency-lock-verification-20261106-v1.json",
    "singleton": "security/p001-rerank-singleton-source-extraction-20261106-v1.json",
    "singletonVerification": "security/p001-rerank-singleton-source-verification-20261106-v1.json"
  },
  "evidenceScope": "Retained lock-specific rows and exact two-file singleton source only; no product edit, target import, test, native/worker execution or runtime qualification.",
  "rootIdentityReused": {
    "revision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
    "memoryRevision": "fe9878936d3da86d872fc1a5fdd29877e903d1f0",
    "rerankRevision": "40e78e06b07a94203e151a44979394acc2dbc871",
    "note": "Reused retained v13 root/gitlink/package/entry identity. This unit does not replay those measurements."
  },
  "lockIdentities": {
    "schema": "p001-rerank-dependency-lock-identities-v1",
    "source": {
      "rootRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
      "path": "package-lock.json",
      "gitBlob": "a8cb14da54bc33aedff29301c9abdcf1cab23133",
      "sha256": "a20ed6c4aa15befa12baf21a955bcadb1d91523c42b834961f1d28170e98cf42",
      "bytes": 1432077,
      "reusedRetainedIdentity": true
    },
    "names": [
      "@papercusp/module-singleton",
      "@huggingface/transformers",
      "onnxruntime-node"
    ],
    "rows": [
      {
        "path": "apps/slack-asana-bug-drill/node_modules/@papercusp/module-singleton",
        "entry": {
          "version": "0.1.0",
          "resolved": "file:apps/slack-asana-bug-drill/vendor/papercusp-module-singleton-0.1.0.tgz",
          "integrity": "sha512-dg9OQ25LhfiKsF061H4W1VD4UZl22OprQaIiYXPqzl6U339ZPK+aXP15vQzCAhVoVTU7+nfwA4BS3fbMmplkBA=="
        }
      },
      {
        "path": "node_modules/@huggingface/transformers",
        "entry": {
          "version": "4.2.0",
          "resolved": "https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz",
          "integrity": "sha512-8BRCoBMH0XsWaEIamuR0LrJGAfftgHAfb2Vrffy0VKlSAE/MnUJ5/h/zTfEP3fDIft+nk7TqB8xXEyABGitBjQ==",
          "license": "Apache-2.0",
          "dependencies": {
            "@huggingface/jinja": "^0.5.6",
            "@huggingface/tokenizers": "^0.1.3",
            "onnxruntime-node": "1.24.3",
            "onnxruntime-web": "1.26.0-dev.20260416-b7804b056c",
            "sharp": "^0.34.5"
          }
        }
      },
      {
        "path": "node_modules/@papercusp/module-singleton",
        "entry": {
          "resolved": "libs/generic/module-singleton",
          "link": true
        }
      },
      {
        "path": "node_modules/onnxruntime-node",
        "entry": {
          "version": "1.24.3",
          "hasInstallScript": true,
          "license": "MIT",
          "os": [
            "win32",
            "darwin",
            "linux"
          ],
          "dependencies": {
            "adm-zip": "^0.5.16",
            "global-agent": "^3.0.0",
            "onnxruntime-common": "1.24.3"
          }
        }
      }
    ],
    "links": [
      {
        "path": "libs/generic/module-singleton",
        "entry": {
          "name": "@papercusp/module-singleton",
          "version": "0.1.0",
          "devDependencies": {
            "@papercusp/test-config": "*",
            "vitest": "^4.1.4"
          }
        },
        "tree": "040000 tree 396c3255fa8758c2e6fae45668e9266594e7ee07\tlibs/generic/module-singleton"
      }
    ],
    "installedOrResolvedRuntimeIdentityProven": false,
    "candidateExecution": false
  },
  "lockVerification": {
    "schema": "p001-rerank-dependency-lock-verification-v1",
    "method": "Python hashlib/git-show versus Nodecrypto/git-cat-file; independent suffix selection of named lock rows and exact workspace tree",
    "lockIdentityMatches": true,
    "allNamedLockRowsMatch": true,
    "workspaceLinkTreesMatch": true,
    "namedRows": 4,
    "onnxruntimeNodeIntegrityPresent": false,
    "candidateExecution": false
  },
  "singletonExtraction": {
    "schema": "p001-rerank-singleton-source-extraction-v1",
    "rootRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
    "analyzer": {
      "name": "typescript compiler API",
      "version": "6.0.3",
      "purpose": "offline parse only; no target import"
    },
    "scope": {
      "files": 2,
      "candidateExecution": false
    },
    "rows": [
      {
        "repository": ".",
        "repositoryRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
        "path": "libs/generic/module-singleton/package.json",
        "gitBlob": "aefe90a72354b70a7f70d5872e7d1fac7837395b",
        "bytes": 686,
        "sha256": "a81652fbd3de2c87503a3176029a7cb83986dd5c95aeafea951384e5ba9197ff",
        "text": "{\n  \"name\": \"@papercusp/module-singleton\",\n  \"version\": \"0.1.0\",\n  \"private\": true,\n  \"type\": \"module\",\n  \"description\": \"Pin a module's mutable state to the realm under a Symbol.for key AND count module evaluations, so a split module-singleton (tsx CJS/ESM double-load, bare-vs-relative specifier, symlinked node_modules) is both fixed and observable instead of silently halving every reader's view. Domain-free; no host coupling; no dependencies.\",\n  \"main\": \"./src/index.ts\",\n  \"types\": \"./src/index.ts\",\n  \"exports\": {\n    \".\": \"./src/index.ts\"\n  },\n  \"scripts\": {\n    \"test\": \"vitest run\"\n  },\n  \"devDependencies\": {\n    \"@papercusp/test-config\": \"*\",\n    \"vitest\": \"^4.1.4\"\n  }\n}\n",
        "parsed": {
          "name": "@papercusp/module-singleton",
          "version": "0.1.0",
          "private": true,
          "type": "module",
          "description": "Pin a module's mutable state to the realm under a Symbol.for key AND count module evaluations, so a split module-singleton (tsx CJS/ESM double-load, bare-vs-relative specifier, symlinked node_modules) is both fixed and observable instead of silently halving every reader's view. Domain-free; no host coupling; no dependencies.",
          "main": "./src/index.ts",
          "types": "./src/index.ts",
          "exports": {
            ".": "./src/index.ts"
          },
          "scripts": {
            "test": "vitest run"
          },
          "devDependencies": {
            "@papercusp/test-config": "*",
            "vitest": "^4.1.4"
          }
        }
      },
      {
        "repository": ".",
        "repositoryRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
        "path": "libs/generic/module-singleton/src/index.ts",
        "gitBlob": "a95df5c32acb4f4b5227c3b2f00ffe207afbf29e",
        "bytes": 7739,
        "sha256": "4d8852efe38c7fddf07a77c821ba0bb704df0e52c7324182a2941db564712dbf",
        "text": "/**\n * @papercusp/module-singleton — pin a module's mutable state to the realm, and\n * COUNT how many times the module body was evaluated.\n *\n * ## The hazard\n *\n * A module that holds mutable state in module scope:\n *\n *     const registry = new Map();   // module-scoped\n *\n * is a singleton only as long as the loader produces exactly ONE module record\n * for it. Several ordinary seams break that assumption without any error:\n *\n *   - a tsx/ts-node CJS preflight alongside the ESM loader (two module systems),\n *   - the same package reached through both a bare specifier\n *     (`@scope/pkg`) and a relative path (`../pkg/src/index.ts`),\n *   - `node_modules/@scope/*` symlinked into a monorepo (two real paths),\n *   - a bundled copy living beside the source copy.\n *\n * When it splits, each module record gets its OWN `registry`, and writes to one\n * are invisible to readers of the other. Nothing throws. The symptom is a\n * *partial* view that looks like a complete one.\n *\n * ## Why counting matters as much as pinning\n *\n * Pinning the state to `globalThis` under a `Symbol.for` key fixes correctness —\n * both module records then share one object. But it also makes the duplication\n * INVISIBLE: once the state is shared, nothing distinguishes one module record\n * from two, so the underlying packaging fault is never noticed or fixed.\n *\n * This module therefore does both in one call. `pinModuleState` returns the\n * shared state (correctness) and increments an evaluation counter\n * (observability). `listModuleDuplications()` reports every key whose module body\n * ran more than once, so a split singleton can be surfaced by a health check\n * instead of being discovered days later from a contradictory reading.\n *\n * Observed live: `@papercusp/scheduled-registry` was evaluated twice inside one\n * process. A timer armed against instance A fired every 2 minutes while being\n * absent from the inventory served by instance B — in the same pid. It went\n * unnoticed for 6+ days because the surface meant to report the timers was the\n * surface that had gone blind (EI-19451658870832332 / EI-19463700807328229).\n *\n * ## Contract — call it ONCE, at module scope\n *\n *     const state = pinModuleState('@scope/pkg.state', () => ({ registry: new Map() }));\n *\n * `evaluations` counts CALLS, so this is only a module-record count when the call\n * happens exactly once per module evaluation. Calling it from a function that\n * runs repeatedly makes the count meaningless. `init` runs at most once per\n * realm; later evaluations receive the state the first one built.\n *\n * This module deliberately holds NO module-scoped state of its own — every read\n * goes through `globalThis` — so the detector cannot split the way its subjects\n * can.\n */\n\n/** A key whose module body was evaluated more than once in this realm. */\nexport interface ModuleDuplication {\n  /** The key passed to `pinModuleState`. */\n  key: string;\n  /** How many times `pinModuleState` was called for this key (>= 2 to be a duplication). */\n  evaluations: number;\n  /** Epoch ms when the first evaluation pinned the state. */\n  firstSeenAt: number;\n  /** Epoch ms of the most recent evaluation. */\n  lastSeenAt: number;\n}\n\ninterface Slot {\n  value: unknown;\n  evaluations: number;\n  firstSeenAt: number;\n  lastSeenAt: number;\n}\n\n/**\n * `Symbol.for` is the cross-realm symbol registry: a second module record\n * resolves the SAME symbol, which is exactly the property that lets two module\n * records find one store. A plain `Symbol()` would mint a distinct key per\n * evaluation and silently reintroduce the split this module exists to close.\n */\nconst SLOTS_KEY = Symbol.for('@papercusp/module-singleton.slots');\n\nfunction slots(): Map<string, Slot> {\n  const store = globalThis as unknown as Record<symbol, Map<string, Slot> | undefined>;\n  let map = store[SLOTS_KEY];\n  if (!map) {\n    map = new Map<string, Slot>();\n    store[SLOTS_KEY] = map;\n  }\n  return map;\n}\n\n/**\n * Pin a module's mutable state to the realm and record this evaluation.\n *\n * Returns the SAME object for every module record that uses `key`, so\n * module-scoped state stops being per-module-record. Call once, at module scope.\n *\n * @param key    A stable, globally unique id — use the package name plus a\n *               suffix, e.g. `'@papercusp/scheduled-registry.state'`. Two\n *               unrelated modules sharing a key would share state, so the\n *               package name is not optional decoration.\n * @param init   Builds the initial state. Runs at most once per realm.\n */\nexport function pinModuleState<T>(key: string, init: () => T): T {\n  if (typeof key !== 'string' || key.length === 0) {\n    throw new TypeError('pinModuleState: key must be a non-empty string');\n  }\n  const map = slots();\n  const now = Date.now();\n  const existing = map.get(key);\n  if (existing) {\n    existing.evaluations += 1;\n    existing.lastSeenAt = now;\n    return existing.value as T;\n  }\n  const value = init();\n  map.set(key, { value, evaluations: 1, firstSeenAt: now, lastSeenAt: now });\n  return value;\n}\n\n/** Read an existing pin without initializing it or counting a module evaluation. */\nexport function readPinnedModuleState<T>(key: string): T | undefined {\n  return slots().get(key)?.value as T | undefined;\n}\n\n/**\n * How many times `pinModuleState` ran for `key` in this realm.\n *\n * `0` means the module was never evaluated — which is NOT the same as \"evaluated\n * once\". A caller reporting on a module it expects to be loaded should treat `0`\n * as \"not loaded / not observable\", never as a healthy singleton.\n */\nexport function moduleEvaluationCount(key: string): number {\n  return slots().get(key)?.evaluations ?? 0;\n}\n\n/**\n * Every key whose module body was evaluated more than once — i.e. every split\n * singleton in this realm. An empty array means no duplication was observed\n * AMONG KEYS THAT USE THIS MODULE; it says nothing about modules that pin their\n * state by hand.\n *\n * Sorted by `evaluations` descending, then `key`, so the report is stable.\n */\nexport function listModuleDuplications(): ModuleDuplication[] {\n  const out: ModuleDuplication[] = [];\n  for (const [key, slot] of slots()) {\n    if (slot.evaluations > 1) {\n      out.push({\n        key,\n        evaluations: slot.evaluations,\n        firstSeenAt: slot.firstSeenAt,\n        lastSeenAt: slot.lastSeenAt,\n      });\n    }\n  }\n  out.sort((a, b) => b.evaluations - a.evaluations || a.key.localeCompare(b.key));\n  return out;\n}\n\n/** Every pinned key in this realm, duplicated or not. Diagnostics only. */\nexport function listPinnedModuleKeys(): string[] {\n  return [...slots().keys()].sort();\n}\n\n/**\n * Render a one-line human warning per duplication, or `[]` when clean.\n *\n * Kept here so every surface that reports duplication says the same thing —\n * including that a duplication is a PACKAGING fault, not a runtime error to\n * retry.\n */\nexport function formatModuleDuplicationWarnings(\n  duplications: ModuleDuplication[] = listModuleDuplications(),\n): string[] {\n  return duplications.map(\n    (d) =>\n      `SPLIT MODULE SINGLETON: '${d.key}' was evaluated ${d.evaluations}x in this process. ` +\n      `State is shared (pinned), so behavior is correct, but the duplicate module record is a ` +\n      `packaging fault — check for a bare-vs-relative import of the same file, a symlinked ` +\n      `node_modules copy, or a CJS/ESM double-load.`,\n  );\n}\n\n/**\n * Drop all pinned state in this realm. TEST-ONLY.\n *\n * Production code must never call this: it detaches live state from every module\n * record already holding a reference, which is the very split this module exists\n * to prevent.\n */\nexport function resetPinnedModuleStateForTest(): void {\n  slots().clear();\n}\n",
        "imports": [],
        "exports": [
          {
            "line": 106,
            "column": 1,
            "name": "pinModuleState"
          },
          {
            "line": 124,
            "column": 1,
            "name": "readPinnedModuleState"
          },
          {
            "line": 135,
            "column": 1,
            "name": "moduleEvaluationCount"
          },
          {
            "line": 147,
            "column": 1,
            "name": "listModuleDuplications"
          },
          {
            "line": 164,
            "column": 1,
            "name": "listPinnedModuleKeys"
          },
          {
            "line": 175,
            "column": 1,
            "name": "formatModuleDuplicationWarnings"
          },
          {
            "line": 194,
            "column": 1,
            "name": "resetPinnedModuleStateForTest"
          }
        ],
        "calls": [
          {
            "line": 82,
            "column": 19,
            "kind": "call",
            "callee": "Symbol.for",
            "arguments": [
              "'@papercusp/module-singleton.slots'"
            ]
          },
          {
            "line": 88,
            "column": 11,
            "kind": "construct",
            "callee": "Map",
            "arguments": []
          },
          {
            "line": 108,
            "column": 11,
            "kind": "construct",
            "callee": "TypeError",
            "arguments": [
              "'pinModuleState: key must be a non-empty string'"
            ]
          },
          {
            "line": 110,
            "column": 15,
            "kind": "call",
            "callee": "slots",
            "arguments": []
          },
          {
            "line": 111,
            "column": 15,
            "kind": "call",
            "callee": "Date.now",
            "arguments": []
          },
          {
            "line": 112,
            "column": 20,
            "kind": "call",
            "callee": "map.get",
            "arguments": [
              "key"
            ]
          },
          {
            "line": 118,
            "column": 17,
            "kind": "call",
            "callee": "init",
            "arguments": []
          },
          {
            "line": 119,
            "column": 3,
            "kind": "call",
            "callee": "map.set",
            "arguments": [
              "key",
              "{ value, evaluations: 1, firstSeenAt: now, lastSeenAt: now }"
            ]
          },
          {
            "line": 125,
            "column": 10,
            "kind": "call",
            "callee": "slots().get",
            "arguments": [
              "key"
            ]
          },
          {
            "line": 125,
            "column": 10,
            "kind": "call",
            "callee": "slots",
            "arguments": []
          },
          {
            "line": 136,
            "column": 10,
            "kind": "call",
            "callee": "slots().get",
            "arguments": [
              "key"
            ]
          },
          {
            "line": 136,
            "column": 10,
            "kind": "call",
            "callee": "slots",
            "arguments": []
          },
          {
            "line": 149,
            "column": 29,
            "kind": "call",
            "callee": "slots",
            "arguments": []
          },
          {
            "line": 151,
            "column": 7,
            "kind": "call",
            "callee": "out.push",
            "arguments": [
              "{\n        key,\n        evaluations: slot.evaluations,\n        firstSeenAt: slot.firstSeenAt,\n        lastSeenAt: slot.lastSeenAt,\n      }"
            ]
          },
          {
            "line": 159,
            "column": 3,
            "kind": "call",
            "callee": "out.sort",
            "arguments": [
              "(a, b) => b.evaluations - a.evaluations || a.key.localeCompare(b.key)"
            ]
          },
          {
            "line": 159,
            "column": 55,
            "kind": "call",
            "callee": "a.key.localeCompare",
            "arguments": [
              "b.key"
            ]
          },
          {
            "line": 165,
            "column": 10,
            "kind": "call",
            "callee": "[...slots().keys()].sort",
            "arguments": []
          },
          {
            "line": 165,
            "column": 14,
            "kind": "call",
            "callee": "slots().keys",
            "arguments": []
          },
          {
            "line": 165,
            "column": 14,
            "kind": "call",
            "callee": "slots",
            "arguments": []
          },
          {
            "line": 176,
            "column": 39,
            "kind": "call",
            "callee": "listModuleDuplications",
            "arguments": []
          },
          {
            "line": 178,
            "column": 10,
            "kind": "call",
            "callee": "duplications.map",
            "arguments": [
              "(d) =>\n      `SPLIT MODULE SINGLETON: '${d.key}' was evaluated ${d.evaluations}x in this process. ` +\n      `State is shared (pinned), so behavior is correct, but the duplicate module record is a ` +\n      `packaging fault — check for a bare-vs-relative import of the same file, a symlinked ` +\n      `node_modules copy, or a CJS/ESM double-load.`"
            ]
          },
          {
            "line": 195,
            "column": 3,
            "kind": "call",
            "callee": "slots().clear",
            "arguments": []
          },
          {
            "line": 195,
            "column": 3,
            "kind": "call",
            "callee": "slots",
            "arguments": []
          }
        ],
        "parseDiagnostics": []
      }
    ]
  },
  "singletonVerification": {
    "schema": "p001-rerank-singleton-source-verification-v1",
    "method": "independent Python hashlib and git-show versus Nodecrypto/git-cat-file; package entry and every captured call location checked",
    "checks": [
      {
        "path": "libs/generic/module-singleton/package.json",
        "gitBlob": "aefe90a72354b70a7f70d5872e7d1fac7837395b",
        "sha256": "a81652fbd3de2c87503a3176029a7cb83986dd5c95aeafea951384e5ba9197ff",
        "bytes": 686,
        "textAndIdentityMatch": true,
        "entryOrCallAssertionsMatch": true
      },
      {
        "path": "libs/generic/module-singleton/src/index.ts",
        "gitBlob": "a95df5c32acb4f4b5227c3b2f00ffe207afbf29e",
        "sha256": "4d8852efe38c7fddf07a77c821ba0bb704df0e52c7324182a2941db564712dbf",
        "bytes": 7739,
        "textAndIdentityMatch": true,
        "entryOrCallAssertionsMatch": true
      }
    ],
    "candidateExecution": false
  },
  "sourceFindings": [
    {
      "source": "retained package-lock.json",
      "finding": "Root @papercusp/module-singleton is a link to tracked libs/generic/module-singleton, tree396c3255fa8758c2e6fae45668e9266594e7ee07. A separate vendor tarball occurrence under apps/slack-asana-bug-drill is retained and must not be substituted for the rerank parent link."
    },
    {
      "source": "singleton package.json and src/index.ts",
      "finding": "Package entry exports src/index.ts; no static imports in that source. pinModuleState stores/retrieves state through globalThis/Symbol.for and invokes an injected initializer on first access. Shared mutable realm state and callback effects are retained obligations; package identity does not establish loaded/runtime identity."
    },
    {
      "source": "retained Transformers lock row",
      "finding": "@huggingface/transformers4.2.0 has exact registry tarball URL and SHA512 integrity; declared dependencies include ONNX node/web, sharp and Hugging Face tokenizer/template packages."
    },
    {
      "source": "retained onnxruntime-node lock row",
      "finding": "onnxruntime-node1.24.3 is marked hasInstallScript and supports win32/darwin/linux, but its retained row contains neither resolved URL nor integrity. Version alone cannot qualify exact native distribution/install bytes."
    }
  ],
  "populationStates": [
    {
      "population": "handler",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "effect",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "entry-point",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "loader",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "native-helper",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "distribution",
      "status": "unknown",
      "closureAccepted": false
    },
    {
      "population": "observed-route",
      "status": "unknown",
      "closureAccepted": false
    }
  ],
  "missing": [
    "Complete configured occurrence and package-entry populations.",
    "Worker script, @papercusp/module-singleton entry, Transformers/onnx native resolution/cache/model effects and both parent/worker/inline execution paths.",
    "Independently committed row applicability, exact loaded/distribution/platform identities and actual positive/negative enforcement proof.",
    "Outside-lineage review, authenticated complete authors/admin bootstrap and final exact signed installed-artifact proof.",
    "WorkerData override, installed dependency/model asset identities and cache/network/native/device effects remain unqualified.",
    "Exact installed onnxruntime-node distribution/native bytes lack a binding in the retained lock row. Public same-version candidates do not repair that historical binding."
  ],
  "applicabilityCommitted": false,
  "populationComplete": false,
  "closureAccepted": false,
  "executionAdmitted": false,
  "qualificationExecuted": false,
  "nextNamedSourceUnit": {
    "externalDependencies": [
      {
        "path": "node_modules/@huggingface/transformers",
        "entry": {
          "version": "4.2.0",
          "resolved": "https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz",
          "integrity": "sha512-8BRCoBMH0XsWaEIamuR0LrJGAfftgHAfb2Vrffy0VKlSAE/MnUJ5/h/zTfEP3fDIft+nk7TqB8xXEyABGitBjQ==",
          "license": "Apache-2.0",
          "dependencies": {
            "@huggingface/jinja": "^0.5.6",
            "@huggingface/tokenizers": "^0.1.3",
            "onnxruntime-node": "1.24.3",
            "onnxruntime-web": "1.26.0-dev.20260416-b7804b056c",
            "sharp": "^0.34.5"
          }
        }
      },
      {
        "path": "node_modules/onnxruntime-node",
        "entry": {
          "version": "1.24.3",
          "hasInstallScript": true,
          "license": "MIT",
          "os": [
            "win32",
            "darwin",
            "linux"
          ],
          "dependencies": {
            "adm-zip": "^0.5.16",
            "global-agent": "^3.0.0",
            "onnxruntime-common": "1.24.3"
          }
        }
      }
    ],
    "instruction": "Inspect the exact Transformers4.2.0 tarball pinned by retained lock SHA512, recording static package entry and dependency/native effect leads without imports or install scripts. onnxruntime-node1.24.3 retained lock row has no resolved URL or integrity: preserve this identity gap, acquire any public metadata/tarball only as separately dated candidate evidence, and do not infer it matches the retained installation. Parent native require remains before Worker."
  }
}
