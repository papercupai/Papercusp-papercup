---
rel_path: "security/p001-pinned-nested-onnx-common-reexports-preparation-20261106-v1.json"
updated_at: 1793943177030
_body: "content"
---

{
  "schema": "p001-pinned-nested-onnx-common-reexports-preparation-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "currentWorkItem": "WI-6554700010045753",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "recordedAt": "2026-11-06T05:32:57.022Z",
  "status": "named-pinned-reexports-only-unqualified",
  "sources": {
    "priorCanonical": "security/p001-native-distribution-source-classification-20261106-sharp-native-loader-v22.json",
    "source": "security/p001-pinned-nested-onnx-common-reexports-source-20261106-v1.json",
    "verification": "security/p001-pinned-nested-onnx-common-reexports-ast-verification-20261106-v1.json"
  },
  "archive": {
    "url": "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz",
    "bytes": 66168,
    "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
    "retainedIntegrityMatched": true
  },
  "verification": {
    "method": "Independent Python urllib/hashlib/tarfile and Node fetch/crypto/zlib/raw-tar; offline TypeScript6.0.3 AST module/call/new spans checked against Python source.",
    "checks": [
      {
        "path": "dist/esm/backend.js",
        "sha256": "017ce2ec9dc2021ebc1ef2c4f04e1bc74276c65921b0297e7ed8cc16e640495b",
        "bytes": 184,
        "moduleEdgeCount": 1,
        "callOrConstructorCount": 0,
        "independentSourceAndSpanMatches": true
      },
      {
        "path": "dist/esm/env.js",
        "sha256": "b2bbd3d3b00a95765713c57cd0f5ef73718ae5b8322e07cb47a43e2accb21f15",
        "bytes": 262,
        "moduleEdgeCount": 1,
        "callOrConstructorCount": 0,
        "independentSourceAndSpanMatches": true
      },
      {
        "path": "dist/esm/inference-session.js",
        "sha256": "3ad4271a88edb3d242dc1e0e7bbf66510f9a56eff874c433b3b37f900ac007b1",
        "bytes": 348,
        "moduleEdgeCount": 1,
        "callOrConstructorCount": 0,
        "independentSourceAndSpanMatches": true
      },
      {
        "path": "dist/esm/tensor.js",
        "sha256": "721d24a538de5333057bfc423bc00c3453a1c483f4495c857d0a6f9b8f2d330e",
        "bytes": 286,
        "moduleEdgeCount": 1,
        "callOrConstructorCount": 0,
        "independentSourceAndSpanMatches": true
      },
      {
        "path": "dist/esm/tensor-conversion.js",
        "sha256": "8c43ec1d061ab71032a1b28f45d85ef95f8d7bd2d4cd71d059e96d83e3a8f422",
        "bytes": 152,
        "moduleEdgeCount": 0,
        "callOrConstructorCount": 0,
        "independentSourceAndSpanMatches": true
      },
      {
        "path": "dist/esm/tensor-factory.js",
        "sha256": "68b9f4f4573f25012ce8a4f73c9a2cee3a28db91de8bbb0a20ddb08bcba33c4b",
        "bytes": 149,
        "moduleEdgeCount": 0,
        "callOrConstructorCount": 0,
        "independentSourceAndSpanMatches": true
      },
      {
        "path": "dist/esm/trace.js",
        "sha256": "9b87e6309a1c502b03558aa94b0a65c8ea1e8eb59cb46090f54f6eacd191b841",
        "bytes": 1891,
        "moduleEdgeCount": 1,
        "callOrConstructorCount": 12,
        "independentSourceAndSpanMatches": true
      },
      {
        "path": "dist/esm/onnx-model.js",
        "sha256": "9e9dc8678be0ea04575a542894508db355a4f9f2155ac7f4c17a697c5f843382",
        "bytes": 145,
        "moduleEdgeCount": 0,
        "callOrConstructorCount": 0,
        "independentSourceAndSpanMatches": true
      },
      {
        "path": "dist/esm/onnx-value.js",
        "sha256": "33dc232498753fc9026dfa44c99440cb1a6d29f3e53e1ad2fb8b696705158f06",
        "bytes": 145,
        "moduleEdgeCount": 0,
        "callOrConstructorCount": 0,
        "independentSourceAndSpanMatches": true
      }
    ],
    "traceCallOrConstructorSitesHaveFunctionAncestors": true
  },
  "sourceModules": [
    {
      "path": "dist/esm/backend.js",
      "bytes": 184,
      "sha256": "017ce2ec9dc2021ebc1ef2c4f04e1bc74276c65921b0297e7ed8cc16e640495b",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nexport { registerBackend } from './backend-impl.js';\n//# sourceMappingURL=backend.js.map"
    },
    {
      "path": "dist/esm/env.js",
      "bytes": 262,
      "sha256": "b2bbd3d3b00a95765713c57cd0f5ef73718ae5b8322e07cb47a43e2accb21f15",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nimport { env as envImpl } from './env-impl.js';\n/**\n * Represent a set of flags as a global singleton.\n */\nexport const env = envImpl;\n//# sourceMappingURL=env.js.map"
    },
    {
      "path": "dist/esm/inference-session.js",
      "bytes": 348,
      "sha256": "3ad4271a88edb3d242dc1e0e7bbf66510f9a56eff874c433b3b37f900ac007b1",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nimport { InferenceSession as InferenceSessionImpl } from './inference-session-impl.js';\n// eslint-disable-next-line @typescript-eslint/naming-convention\nexport const InferenceSession = InferenceSessionImpl;\n//# sourceMappingURL=inference-session.js.map"
    },
    {
      "path": "dist/esm/tensor.js",
      "bytes": 286,
      "sha256": "721d24a538de5333057bfc423bc00c3453a1c483f4495c857d0a6f9b8f2d330e",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nimport { Tensor as TensorImpl } from './tensor-impl.js';\n// eslint-disable-next-line @typescript-eslint/naming-convention\nexport const Tensor = TensorImpl;\n//# sourceMappingURL=tensor.js.map"
    },
    {
      "path": "dist/esm/tensor-conversion.js",
      "bytes": 152,
      "sha256": "8c43ec1d061ab71032a1b28f45d85ef95f8d7bd2d4cd71d059e96d83e3a8f422",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nexport {};\n//# sourceMappingURL=tensor-conversion.js.map"
    },
    {
      "path": "dist/esm/tensor-factory.js",
      "bytes": 149,
      "sha256": "68b9f4f4573f25012ce8a4f73c9a2cee3a28db91de8bbb0a20ddb08bcba33c4b",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nexport {};\n//# sourceMappingURL=tensor-factory.js.map"
    },
    {
      "path": "dist/esm/trace.js",
      "bytes": 1891,
      "sha256": "9b87e6309a1c502b03558aa94b0a65c8ea1e8eb59cb46090f54f6eacd191b841",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nimport { env } from './env-impl.js';\n/**\n * @ignore\n */\nexport const TRACE = (deviceType, label) => {\n    if (typeof env.trace === 'undefined' ? !env.wasm.trace : !env.trace) {\n        return;\n    }\n    // eslint-disable-next-line no-console\n    console.timeStamp(`${deviceType}::ORT::${label}`);\n};\nconst TRACE_FUNC = (msg, extraMsg) => {\n    const stack = new Error().stack?.split(/\\r\\n|\\r|\\n/g) || [];\n    let hasTraceFunc = false;\n    for (let i = 0; i < stack.length; i++) {\n        if (hasTraceFunc && !stack[i].includes('TRACE_FUNC')) {\n            let label = `FUNC_${msg}::${stack[i].trim().split(' ')[1]}`;\n            if (extraMsg) {\n                label += `::${extraMsg}`;\n            }\n            TRACE('CPU', label);\n            return;\n        }\n        if (stack[i].includes('TRACE_FUNC')) {\n            hasTraceFunc = true;\n        }\n    }\n};\n/**\n * @ignore\n */\nexport const TRACE_FUNC_BEGIN = (extraMsg) => {\n    if (typeof env.trace === 'undefined' ? !env.wasm.trace : !env.trace) {\n        return;\n    }\n    TRACE_FUNC('BEGIN', extraMsg);\n};\n/**\n * @ignore\n */\nexport const TRACE_FUNC_END = (extraMsg) => {\n    if (typeof env.trace === 'undefined' ? !env.wasm.trace : !env.trace) {\n        return;\n    }\n    TRACE_FUNC('END', extraMsg);\n};\n/**\n * @ignore\n */\nexport const TRACE_EVENT_BEGIN = (extraMsg) => {\n    if (typeof env.trace === 'undefined' ? !env.wasm.trace : !env.trace) {\n        return;\n    }\n    // eslint-disable-next-line no-console\n    console.time(`ORT::${extraMsg}`);\n};\n/**\n * @ignore\n */\nexport const TRACE_EVENT_END = (extraMsg) => {\n    if (typeof env.trace === 'undefined' ? !env.wasm.trace : !env.trace) {\n        return;\n    }\n    // eslint-disable-next-line no-console\n    console.timeEnd(`ORT::${extraMsg}`);\n};\n//# sourceMappingURL=trace.js.map"
    },
    {
      "path": "dist/esm/onnx-model.js",
      "bytes": 145,
      "sha256": "9e9dc8678be0ea04575a542894508db355a4f9f2155ac7f4c17a697c5f843382",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nexport {};\n//# sourceMappingURL=onnx-model.js.map"
    },
    {
      "path": "dist/esm/onnx-value.js",
      "bytes": 145,
      "sha256": "33dc232498753fc9026dfa44c99440cb1a6d29f3e53e1ad2fb8b696705158f06",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nexport {};\n//# sourceMappingURL=onnx-value.js.map"
    }
  ],
  "ast": [
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:32:04.040Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/backend.js",
      "bytes": 184,
      "sha256": "017ce2ec9dc2021ebc1ef2c4f04e1bc74276c65921b0297e7ed8cc16e640495b",
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      },
      "parseDiagnostics": [],
      "moduleEdges": [
        {
          "kind": "ExportDeclaration",
          "specifier": "./backend-impl.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./backend-impl.js'",
          "start": 96,
          "end": 148,
          "line": 3,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "effects": [],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": {
        "bytes": true,
        "sha256": true,
        "archiveSha256": true,
        "moduleEdgeLocations": true,
        "callOrConstructorLocations": true
      }
    },
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:32:04.044Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/env.js",
      "bytes": 262,
      "sha256": "b2bbd3d3b00a95765713c57cd0f5ef73718ae5b8322e07cb47a43e2accb21f15",
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      },
      "parseDiagnostics": [],
      "moduleEdges": [
        {
          "kind": "ImportDeclaration",
          "specifier": "./env-impl.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./env-impl.js'",
          "start": 96,
          "end": 143,
          "line": 3,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "effects": [],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": {
        "bytes": true,
        "sha256": true,
        "archiveSha256": true,
        "moduleEdgeLocations": true,
        "callOrConstructorLocations": true
      }
    },
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:32:04.044Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/inference-session.js",
      "bytes": 348,
      "sha256": "3ad4271a88edb3d242dc1e0e7bbf66510f9a56eff874c433b3b37f900ac007b1",
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      },
      "parseDiagnostics": [],
      "moduleEdges": [
        {
          "kind": "ImportDeclaration",
          "specifier": "./inference-session-impl.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./inference-session-impl.js'",
          "start": 96,
          "end": 183,
          "line": 3,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "effects": [],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": {
        "bytes": true,
        "sha256": true,
        "archiveSha256": true,
        "moduleEdgeLocations": true,
        "callOrConstructorLocations": true
      }
    },
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:32:04.045Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/tensor.js",
      "bytes": 286,
      "sha256": "721d24a538de5333057bfc423bc00c3453a1c483f4495c857d0a6f9b8f2d330e",
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      },
      "parseDiagnostics": [],
      "moduleEdges": [
        {
          "kind": "ImportDeclaration",
          "specifier": "./tensor-impl.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./tensor-impl.js'",
          "start": 96,
          "end": 152,
          "line": 3,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "effects": [],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": {
        "bytes": true,
        "sha256": true,
        "archiveSha256": true,
        "moduleEdgeLocations": true,
        "callOrConstructorLocations": true
      }
    },
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:32:04.045Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/tensor-conversion.js",
      "bytes": 152,
      "sha256": "8c43ec1d061ab71032a1b28f45d85ef95f8d7bd2d4cd71d059e96d83e3a8f422",
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      },
      "parseDiagnostics": [],
      "moduleEdges": [],
      "effects": [],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": {
        "bytes": true,
        "sha256": true,
        "archiveSha256": true,
        "moduleEdgeLocations": true,
        "callOrConstructorLocations": true
      }
    },
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:32:04.045Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/tensor-factory.js",
      "bytes": 149,
      "sha256": "68b9f4f4573f25012ce8a4f73c9a2cee3a28db91de8bbb0a20ddb08bcba33c4b",
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      },
      "parseDiagnostics": [],
      "moduleEdges": [],
      "effects": [],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": {
        "bytes": true,
        "sha256": true,
        "archiveSha256": true,
        "moduleEdgeLocations": true,
        "callOrConstructorLocations": true
      }
    },
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:32:04.053Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/trace.js",
      "bytes": 1891,
      "sha256": "9b87e6309a1c502b03558aa94b0a65c8ea1e8eb59cb46090f54f6eacd191b841",
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      },
      "parseDiagnostics": [],
      "moduleEdges": [
        {
          "kind": "ImportDeclaration",
          "specifier": "./env-impl.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./env-impl.js'",
          "start": 96,
          "end": 132,
          "line": 3,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "effects": [
        {
          "callee": "console.timeStamp",
          "expression": "console.timeStamp(`${deviceType}::ORT::${label}`)",
          "start": 342,
          "end": 391,
          "line": 12,
          "column": 5,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "new Error().stack?.split",
          "expression": "new Error().stack?.split(/\\r\\n|\\r|\\n/g)",
          "start": 454,
          "end": 493,
          "line": 15,
          "column": 19,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error()",
          "start": 454,
          "end": 465,
          "line": 15,
          "column": 19,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "stack[i].includes",
          "expression": "stack[i].includes('TRACE_FUNC')",
          "start": 605,
          "end": 636,
          "line": 18,
          "column": 30,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "stack[i].trim().split",
          "expression": "stack[i].trim().split(' ')",
          "start": 680,
          "end": 706,
          "line": 19,
          "column": 41,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "stack[i].trim",
          "expression": "stack[i].trim()",
          "start": 680,
          "end": 695,
          "line": 19,
          "column": 41,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "TRACE",
          "expression": "TRACE('CPU', label)",
          "start": 809,
          "end": 828,
          "line": 23,
          "column": 13,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "stack[i].includes",
          "expression": "stack[i].includes('TRACE_FUNC')",
          "start": 872,
          "end": 903,
          "line": 26,
          "column": 13,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "TRACE_FUNC",
          "expression": "TRACE_FUNC('BEGIN', extraMsg)",
          "start": 1127,
          "end": 1156,
          "line": 38,
          "column": 5,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "TRACE_FUNC",
          "expression": "TRACE_FUNC('END', extraMsg)",
          "start": 1327,
          "end": 1354,
          "line": 47,
          "column": 5,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "console.time",
          "expression": "console.time(`ORT::${extraMsg}`)",
          "start": 1571,
          "end": 1603,
          "line": 57,
          "column": 5,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "console.timeEnd",
          "expression": "console.timeEnd(`ORT::${extraMsg}`)",
          "start": 1818,
          "end": 1853,
          "line": 67,
          "column": 5,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        }
      ],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": {
        "bytes": true,
        "sha256": true,
        "archiveSha256": true,
        "moduleEdgeLocations": true,
        "callOrConstructorLocations": true
      }
    },
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:32:04.053Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/onnx-model.js",
      "bytes": 145,
      "sha256": "9e9dc8678be0ea04575a542894508db355a4f9f2155ac7f4c17a697c5f843382",
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      },
      "parseDiagnostics": [],
      "moduleEdges": [],
      "effects": [],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": {
        "bytes": true,
        "sha256": true,
        "archiveSha256": true,
        "moduleEdgeLocations": true,
        "callOrConstructorLocations": true
      }
    },
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:32:04.053Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/onnx-value.js",
      "bytes": 145,
      "sha256": "33dc232498753fc9026dfa44c99440cb1a6d29f3e53e1ad2fb8b696705158f06",
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      },
      "parseDiagnostics": [],
      "moduleEdges": [],
      "effects": [],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": {
        "bytes": true,
        "sha256": true,
        "archiveSha256": true,
        "moduleEdgeLocations": true,
        "callOrConstructorLocations": true
      }
    }
  ],
  "sourceFindings": [
    {
      "source": "dist/esm/backend.js; env.js; inference-session.js; tensor.js",
      "finding": "These are runtime reexport/alias wrappers loading backend-impl.js, env-impl.js, inference-session-impl.js and tensor-impl.js respectively. trace.js also imports env-impl.js. These wrappers preserve eager transitive module loading; they do not establish inertness or identity of any currently installed dependency."
    },
    {
      "source": "dist/esm/tensor-conversion.js; tensor-factory.js; onnx-model.js; onnx-value.js",
      "finding": "These exact pinned distribution files contain export {} plus comments/source-map references. Their apparent type/API names do not imply runtime implementation in these files."
    },
    {
      "source": "dist/esm/trace.js",
      "finding": "TRACE and exported trace helpers gate console.timeStamp/time/timeEnd and Error.stack inspection on env.trace or env.wasm.trace. The twelve AST call/new sites are inside function bodies in this module; importing trace still imports env-impl.js. Runtime calls can expose labels derived from inputs and stack names. No runtime trace behavior has been exercised."
    },
    {
      "source": "Retained package scope",
      "finding": "This preparation binds only nested Transformers onnxruntime-common1.24.0-dev.20251116-b39e144322 public source to its retained integrity. Root/common1.24.3, web-nestedcommon1.24.1 and onnxruntime-node1.24.3 historical installed-byte gaps remain open; these nested bytes cannot stand in for those packages."
    }
  ],
  "populations": [
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
    "Four named *-impl.js modules and their own module/effect paths remain to be read from the same pinned archive.",
    "Actual installed package resolver, loaded dependency/native/WASM identity and distribution custody remain unknown.",
    "Configured occurrence census, independent row applicability and row-bound positive/negative confinement evidence remain open."
  ],
  "applicabilityCommitted": false,
  "populationComplete": false,
  "closureAccepted": false,
  "executionAdmitted": false,
  "qualificationExecuted": false,
  "targetExecuted": false,
  "nextNamedSourceUnit": {
    "kind": "pinned-nested-onnx-common-runtime-implementations",
    "package": "onnxruntime-common",
    "version": "1.24.0-dev.20251116-b39e144322",
    "archiveUrl": "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz",
    "archiveSha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
    "archiveBytes": 66168,
    "retainedIntegrity": "sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw==",
    "files": [
      "dist/esm/backend-impl.js",
      "dist/esm/env-impl.js",
      "dist/esm/inference-session-impl.js",
      "dist/esm/tensor-impl.js"
    ],
    "instruction": "Statically read these four named implementation modules from the same retained-integrity archive. Preserve all source-only scope limits, actual installed identity gaps and seven unknown closure populations. Do not execute target code."
  }
}
