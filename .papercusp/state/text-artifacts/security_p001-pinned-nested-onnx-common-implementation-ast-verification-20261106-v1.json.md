---
rel_path: "security/p001-pinned-nested-onnx-common-implementation-ast-verification-20261106-v1.json"
updated_at: 1793944803215
_body: "content"
---

{
  "schema": "p001-pinned-nested-onnx-common-source-ast-verification-v1",
  "recordedAt": "2026-11-06T05:57:32.752Z",
  "records": [
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:57:32.731Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/backend-impl.js",
      "bytes": 5339,
      "sha256": "97dd81b055a06f61120f09468fe59f046a9262b7b87bf5d05bceb085bf4f5558",
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      },
      "parseDiagnostics": [],
      "moduleEdges": [],
      "effects": [
        {
          "kind": "NewExpression",
          "callee": "Map",
          "expression": "new Map()",
          "start": 113,
          "end": 122,
          "line": 3,
          "column": 18,
          "functionAncestors": []
        },
        {
          "callee": "backends.get",
          "expression": "backends.get(name)",
          "start": 759,
          "end": 777,
          "line": 17,
          "column": 32,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "backends.set",
          "expression": "backends.set(name, { backend, priority })",
          "start": 835,
          "end": 876,
          "line": 19,
          "column": 13,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error(`cannot register backend \"${name}\" using priority ${priority}`)",
          "start": 1197,
          "end": 1270,
          "line": 27,
          "column": 23,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "backendsSortedByPriority.indexOf",
          "expression": "backendsSortedByPriority.indexOf(name)",
          "start": 1347,
          "end": 1385,
          "line": 31,
          "column": 23,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "backendsSortedByPriority.splice",
          "expression": "backendsSortedByPriority.splice(i, 1)",
          "start": 1431,
          "end": 1468,
          "line": 33,
          "column": 17,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "backends.get",
          "expression": "backends.get(backendsSortedByPriority[i])",
          "start": 1576,
          "end": 1617,
          "line": 36,
          "column": 21,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "backendsSortedByPriority.splice",
          "expression": "backendsSortedByPriority.splice(i, 0, name)",
          "start": 1662,
          "end": 1705,
          "line": 37,
          "column": 21,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "backendsSortedByPriority.push",
          "expression": "backendsSortedByPriority.push(name)",
          "start": 1779,
          "end": 1814,
          "line": 41,
          "column": 13,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError('not a valid backend')",
          "start": 1858,
          "end": 1894,
          "line": 45,
          "column": 11,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "backends.get",
          "expression": "backends.get(backendName)",
          "start": 2197,
          "end": 2222,
          "line": 54,
          "column": 25,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "backendInfo.backend.init",
          "expression": "backendInfo.backend.init(backendName)",
          "start": 2604,
          "end": 2641,
          "line": 68,
          "column": 43,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "eps.map",
          "expression": "eps.map((i) => (typeof i === 'string' ? i : i.name))",
          "start": 3553,
          "end": 3605,
          "line": 98,
          "column": 26,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Set",
          "expression": "new Set()",
          "start": 3835,
          "end": 3844,
          "line": 103,
          "column": 35,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "tryResolveAndInitializeBackend",
          "expression": "tryResolveAndInitializeBackend(backendName)",
          "start": 3928,
          "end": 3971,
          "line": 105,
          "column": 37,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "errors.push",
          "expression": "errors.push({ name: backendName, err: resolveResult })",
          "start": 4034,
          "end": 4088,
          "line": 107,
          "column": 13,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "availableBackendNames.add",
          "expression": "availableBackendNames.add(backendName)",
          "start": 4259,
          "end": 4297,
          "line": 114,
          "column": 17,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error(`no available backend found. ERR: ${errors.map((e) => `[${e.name}] ${e.err}`).join(', ')}`)",
          "start": 4411,
          "end": 4512,
          "line": 120,
          "column": 15,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "errors.map((e) => `[${e.name}] ${e.err}`).join",
          "expression": "errors.map((e) => `[${e.name}] ${e.err}`).join(', ')",
          "start": 4457,
          "end": 4509,
          "line": 120,
          "column": 61,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "errors.map",
          "expression": "errors.map((e) => `[${e.name}] ${e.err}`)",
          "start": 4457,
          "end": 4498,
          "line": 120,
          "column": 61,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "backendHints.includes",
          "expression": "backendHints.includes(name)",
          "start": 4667,
          "end": 4694,
          "line": 124,
          "column": 13,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "console.warn",
          "expression": "console.warn(`removing requested execution provider \"${name}\" from session options because it is not available: ${err}`)",
          "start": 4761,
          "end": 4881,
          "line": 126,
          "column": 13,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "eps.filter",
          "expression": "eps.filter((i) => availableBackendNames.has(typeof i === 'string' ? i : i.name))",
          "start": 4923,
          "end": 5003,
          "line": 129,
          "column": 25,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "availableBackendNames.has",
          "expression": "availableBackendNames.has(typeof i === 'string' ? i : i.name)",
          "start": 4941,
          "end": 5002,
          "line": 129,
          "column": 43,
          "functionAncestors": [
            "ArrowFunction:<anonymous>",
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Proxy",
          "expression": "new Proxy(options, {\n            get: (target, prop) => {\n                if (prop === 'executionProviders') {\n                    return filteredEps;\n                }\n                return Reflect.get(target, prop);\n            },\n        })",
          "start": 5043,
          "end": 5287,
          "line": 132,
          "column": 9,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "Reflect.get",
          "expression": "Reflect.get(target, prop)",
          "start": 5235,
          "end": 5260,
          "line": 137,
          "column": 24,
          "functionAncestors": [
            "ArrowFunction:<anonymous>",
            "ArrowFunction:<anonymous>"
          ]
        }
      ],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": true,
      "pythonSourceSpansVerified": true
    },
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:57:32.734Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/env-impl.js",
      "bytes": 848,
      "sha256": "0da4c562a49fe147e19320a64cbb456184eb0e6242b1fe69c65c8368c55f3d97",
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
          "specifier": "./version.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./version.js'",
          "start": 96,
          "end": 135,
          "line": 3,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "effects": [
        {
          "callee": "['verbose', 'info', 'warning', 'error', 'fatal'].indexOf",
          "expression": "['verbose', 'info', 'warning', 'error', 'fatal'].indexOf(value)",
          "start": 400,
          "end": 463,
          "line": 14,
          "column": 42,
          "functionAncestors": [
            "SetAccessor:logLevel"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error(`Unsupported logging level: ${value}`)",
          "start": 492,
          "end": 540,
          "line": 15,
          "column": 19,
          "functionAncestors": [
            "SetAccessor:logLevel"
          ]
        },
        {
          "callee": "Object.defineProperty",
          "expression": "Object.defineProperty(env, 'logLevel', { enumerable: true })",
          "start": 750,
          "end": 810,
          "line": 24,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": true,
      "pythonSourceSpansVerified": true
    },
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:57:32.742Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/inference-session-impl.js",
      "bytes": 8703,
      "sha256": "0446814a392c147b5c38ba242d9911ee54002b5d01a8e19fb4895fb8f8a0cdd3",
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
          "specifier": "./backend-impl.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./backend-impl.js'",
          "start": 96,
          "end": 168,
          "line": 3,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "ImportDeclaration",
          "specifier": "./tensor.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./tensor.js'",
          "start": 169,
          "end": 206,
          "line": 4,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "ImportDeclaration",
          "specifier": "./trace.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./trace.js'",
          "start": 207,
          "end": 305,
          "line": 5,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "effects": [
        {
          "callee": "TRACE_FUNC_BEGIN",
          "expression": "TRACE_FUNC_BEGIN()",
          "start": 446,
          "end": 464,
          "line": 11,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "callee": "TRACE_EVENT_BEGIN",
          "expression": "TRACE_EVENT_BEGIN('InferenceSession.run')",
          "start": 474,
          "end": 515,
          "line": 12,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "callee": "Array.isArray",
          "expression": "Array.isArray(feeds)",
          "start": 681,
          "end": 701,
          "line": 16,
          "column": 87,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"'feeds' must be an object that use input names as keys and OnnxValue as corresponding values.\")",
          "start": 723,
          "end": 833,
          "line": 17,
          "column": 19,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError('Unexpected argument[1]: cannot be null.')",
          "start": 1025,
          "end": 1081,
          "line": 23,
          "column": 23,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"'fetches' cannot be a Tensor\")",
          "start": 1161,
          "end": 1206,
          "line": 26,
          "column": 23,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "callee": "Array.isArray",
          "expression": "Array.isArray(arg1)",
          "start": 1238,
          "end": 1257,
          "line": 28,
          "column": 17,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"'fetches' cannot be an empty array.\")",
          "start": 1328,
          "end": 1380,
          "line": 30,
          "column": 27,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"'fetches' must be a string array or an object.\")",
          "start": 1597,
          "end": 1660,
          "line": 36,
          "column": 31,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "callee": "this.outputNames.indexOf",
          "expression": "this.outputNames.indexOf(name)",
          "start": 1708,
          "end": 1738,
          "line": 38,
          "column": 25,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "RangeError",
          "expression": "new RangeError(`'fetches' contains invalid output name: ${name}.`)",
          "start": 1779,
          "end": 1845,
          "line": 39,
          "column": 31,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"'options' must be an object.\")",
          "start": 2130,
          "end": 2175,
          "line": 47,
          "column": 27,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "callee": "Object.getOwnPropertyNames",
          "expression": "Object.getOwnPropertyNames(arg1)",
          "start": 2467,
          "end": 2499,
          "line": 54,
          "column": 34,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "callee": "arg1Keys.indexOf",
          "expression": "arg1Keys.indexOf(name)",
          "start": 2580,
          "end": 2602,
          "line": 56,
          "column": 25,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"'options' must be an object.\")",
          "start": 3189,
          "end": 3234,
          "line": 70,
          "column": 31,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"Unexpected argument[1]: must be 'fetches' or 'options'.\")",
          "start": 3443,
          "end": 3515,
          "line": 79,
          "column": 19,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error(`input '${name}' is missing in 'feeds'.`)",
          "start": 3692,
          "end": 3743,
          "line": 84,
          "column": 23,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "callee": "this.handler.run",
          "expression": "this.handler.run(feeds, fetches, options)",
          "start": 4066,
          "end": 4107,
          "line": 94,
          "column": 31,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "callee": "Object.hasOwnProperty.call",
          "expression": "Object.hasOwnProperty.call(results, key)",
          "start": 4194,
          "end": 4234,
          "line": 97,
          "column": 17,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Tensor",
          "expression": "new Tensor(result.type, result.data, result.dims)",
          "start": 4458,
          "end": 4507,
          "line": 103,
          "column": 40,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "callee": "TRACE_EVENT_END",
          "expression": "TRACE_EVENT_END('InferenceSession.run')",
          "start": 4559,
          "end": 4598,
          "line": 107,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "callee": "TRACE_FUNC_END",
          "expression": "TRACE_FUNC_END()",
          "start": 4608,
          "end": 4624,
          "line": 108,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:run"
          ]
        },
        {
          "callee": "this.handler.dispose",
          "expression": "this.handler.dispose()",
          "start": 4697,
          "end": 4719,
          "line": 112,
          "column": 16,
          "functionAncestors": [
            "MethodDeclaration:release"
          ]
        },
        {
          "callee": "TRACE_FUNC_BEGIN",
          "expression": "TRACE_FUNC_BEGIN()",
          "start": 4785,
          "end": 4803,
          "line": 115,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "callee": "TRACE_EVENT_BEGIN",
          "expression": "TRACE_EVENT_BEGIN('InferenceSession.create')",
          "start": 4813,
          "end": 4857,
          "line": 116,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"'options' must be an object.\")",
          "start": 5226,
          "end": 5271,
          "line": 126,
          "column": 23,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"'options' must be an object.\")",
          "start": 5566,
          "end": 5611,
          "line": 135,
          "column": 23,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "callee": "Number.isSafeInteger",
          "expression": "Number.isSafeInteger(byteOffset)",
          "start": 6103,
          "end": 6135,
          "line": 148,
          "column": 22,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "RangeError",
          "expression": "new RangeError(\"'byteOffset' must be an integer.\")",
          "start": 6165,
          "end": 6215,
          "line": 149,
          "column": 27,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "RangeError",
          "expression": "new RangeError(`'byteOffset' is out of range [0, ${buffer.byteLength}).`)",
          "start": 6334,
          "end": 6407,
          "line": 152,
          "column": 27,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "callee": "Number.isSafeInteger",
          "expression": "Number.isSafeInteger(byteLength)",
          "start": 6598,
          "end": 6630,
          "line": 157,
          "column": 26,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "RangeError",
          "expression": "new RangeError(\"'byteLength' must be an integer.\")",
          "start": 6664,
          "end": 6714,
          "line": 158,
          "column": 31,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "RangeError",
          "expression": "new RangeError(`'byteLength' is out of range (0, ${buffer.byteLength - byteOffset}].`)",
          "start": 6858,
          "end": 6944,
          "line": 161,
          "column": 31,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"'options' must be an object.\")",
          "start": 7189,
          "end": 7234,
          "line": 167,
          "column": 31,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"'byteLength' must be a number.\")",
          "start": 7358,
          "end": 7405,
          "line": 171,
          "column": 27,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"'options' must be an object.\")",
          "start": 7513,
          "end": 7558,
          "line": 175,
          "column": 23,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Uint8Array",
          "expression": "new Uint8Array(buffer, byteOffset, byteLength)",
          "start": 7609,
          "end": 7655,
          "line": 177,
          "column": 36,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"Unexpected argument[0]: must be 'path' or 'buffer'.\")",
          "start": 7700,
          "end": 7768,
          "line": 180,
          "column": 19,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "callee": "resolveBackendAndExecutionProviders",
          "expression": "resolveBackendAndExecutionProviders(options)",
          "start": 7935,
          "end": 7979,
          "line": 183,
          "column": 58,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "callee": "backend.createInferenceSessionHandler",
          "expression": "backend.createInferenceSessionHandler(filePathOrUint8Array, optionsWithValidatedEPs)",
          "start": 8011,
          "end": 8095,
          "line": 184,
          "column": 31,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "callee": "TRACE_EVENT_END",
          "expression": "TRACE_EVENT_END('InferenceSession.create')",
          "start": 8105,
          "end": 8147,
          "line": 185,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "callee": "TRACE_FUNC_END",
          "expression": "TRACE_FUNC_END()",
          "start": 8157,
          "end": 8173,
          "line": 186,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "InferenceSession",
          "expression": "new InferenceSession(handler)",
          "start": 8190,
          "end": 8219,
          "line": 187,
          "column": 16,
          "functionAncestors": [
            "MethodDeclaration:create"
          ]
        },
        {
          "callee": "this.handler.startProfiling",
          "expression": "this.handler.startProfiling()",
          "start": 8258,
          "end": 8287,
          "line": 190,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:startProfiling"
          ]
        },
        {
          "callee": "this.handler.endProfiling",
          "expression": "this.handler.endProfiling()",
          "start": 8324,
          "end": 8351,
          "line": 193,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:endProfiling"
          ]
        }
      ],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": true,
      "pythonSourceSpansVerified": true
    },
    {
      "schema": "p001-pinned-nested-onnx-common-source-ast-verification-record-v1",
      "recordedAt": "2026-11-06T05:57:32.752Z",
      "archive": {
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "retainedIntegrityMatched": true
      },
      "path": "dist/esm/tensor-impl.js",
      "bytes": 16091,
      "sha256": "6a749be63055f9d21069566b1515412484a3a03448ca20427c8f8d29328a2843",
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
          "specifier": "./tensor-conversion-impl.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./tensor-conversion-impl.js'",
          "start": 96,
          "end": 177,
          "line": 3,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "ImportDeclaration",
          "specifier": "./tensor-factory-impl.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./tensor-factory-impl.js'",
          "start": 178,
          "end": 322,
          "line": 4,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "ImportDeclaration",
          "specifier": "./tensor-impl-type-mapping.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./tensor-impl-type-mapping.js'",
          "start": 323,
          "end": 466,
          "line": 5,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "ImportDeclaration",
          "specifier": "./tensor-utils-impl.js",
          "argumentKind": "StringLiteral",
          "argumentText": "'./tensor-utils-impl.js'",
          "start": 467,
          "end": 537,
          "line": 6,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "effects": [
        {
          "callee": "checkTypedArray",
          "expression": "checkTypedArray()",
          "start": 774,
          "end": 791,
          "line": 18,
          "column": 9,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.get",
          "expression": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.get(type)",
          "start": 1218,
          "end": 1265,
          "line": 30,
          "column": 59,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(`unsupported type \"${type}\" to create tensor from pinned buffer`)",
          "start": 1355,
          "end": 1434,
          "line": 32,
          "column": 31,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(`buffer should be of type ${expectedTypedArrayConstructor.name}`)",
          "start": 1569,
          "end": 1648,
          "line": 35,
          "column": 31,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(`unsupported type \"${type}\" to create tensor from texture`)",
          "start": 1873,
          "end": 1946,
          "line": 42,
          "column": 31,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(`unsupported type \"${type}\" to create tensor from gpu buffer`)",
          "start": 2640,
          "end": 2716,
          "line": 59,
          "column": 31,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(`unsupported type \"${type}\" to create tensor from MLTensor`)",
          "start": 3498,
          "end": 3572,
          "line": 78,
          "column": 31,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error(`Tensor constructor: unsupported location '${this.dataLocation}'`)",
          "start": 3850,
          "end": 3926,
          "line": 86,
          "column": 27,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "Array.isArray",
          "expression": "Array.isArray(arg1)",
          "start": 4455,
          "end": 4474,
          "line": 104,
          "column": 26,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"A string tensor's data must be a string array.\")",
          "start": 4508,
          "end": 4571,
          "line": 105,
          "column": 31,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.get",
          "expression": "NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.get(arg0)",
          "start": 4946,
          "end": 4993,
          "line": 113,
          "column": 51,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(`Unsupported tensor type: ${arg0}.`)",
          "start": 5088,
          "end": 5138,
          "line": 115,
          "column": 31,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "Array.isArray",
          "expression": "Array.isArray(arg1)",
          "start": 5186,
          "end": 5205,
          "line": 117,
          "column": 25,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(`Creating a ${arg0} tensor from number array is not supported. Please use ${typedArrayConstructor.name} as data.`)",
          "start": 6090,
          "end": 6218,
          "line": 129,
          "column": 35,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "typedArrayConstructor.from",
          "expression": "typedArrayConstructor.from(arg1, BigInt)",
          "start": 7176,
          "end": 7216,
          "line": 141,
          "column": 36,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "typedArrayConstructor.from",
          "expression": "typedArrayConstructor.from(arg1)",
          "start": 7483,
          "end": 7515,
          "line": 146,
          "column": 36,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "Uint8Array.from",
          "expression": "Uint8Array.from(arg1)",
          "start": 7843,
          "end": 7864,
          "line": 154,
          "column": 36,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(`A Uint8ClampedArray tensor's data must be type of uint8`)",
          "start": 7957,
          "end": 8029,
          "line": 157,
          "column": 35,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "globalThis.Float16Array",
          "expression": "new globalThis.Float16Array(arg1.buffer, arg1.byteOffset, arg1.length)",
          "start": 8600,
          "end": 8670,
          "line": 165,
          "column": 32,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(`A ${type} tensor's data must be type of ${typedArrayConstructor}`)",
          "start": 8751,
          "end": 8832,
          "line": 168,
          "column": 31,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "Array.isArray",
          "expression": "Array.isArray(arg0)",
          "start": 9051,
          "end": 9070,
          "line": 177,
          "column": 21,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError('Tensor type cannot be inferred from an empty array.')",
          "start": 9213,
          "end": 9281,
          "line": 180,
          "column": 31,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "Uint8Array.from",
          "expression": "Uint8Array.from(arg0)",
          "start": 9947,
          "end": 9968,
          "line": 192,
          "column": 32,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(`Invalid element type of data array: ${firstElementType}.`)",
          "start": 10049,
          "end": 10122,
          "line": 195,
          "column": 31,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "Uint8Array.from",
          "expression": "Uint8Array.from(arg0)",
          "start": 10289,
          "end": 10310,
          "line": 200,
          "column": 28,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "NUMERIC_TENSOR_TYPEDARRAY_TO_TYPE_MAP.get",
          "expression": "NUMERIC_TENSOR_TYPEDARRAY_TO_TYPE_MAP.get(arg0.constructor)",
          "start": 10447,
          "end": 10506,
          "line": 204,
          "column": 40,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(`Unsupported type for tensor data: ${arg0.constructor}.`)",
          "start": 10590,
          "end": 10661,
          "line": 206,
          "column": 31,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "Array.isArray",
          "expression": "Array.isArray(maybeDims)",
          "start": 11027,
          "end": 11051,
          "line": 217,
          "column": 23,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "TypeError",
          "expression": "new TypeError(\"A tensor's dims must be a number array\")",
          "start": 11077,
          "end": 11132,
          "line": 218,
          "column": 23,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "calculateSize",
          "expression": "calculateSize(dims)",
          "start": 11314,
          "end": 11333,
          "line": 225,
          "column": 22,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "Math.ceil",
          "expression": "Math.ceil(size / 2)",
          "start": 11528,
          "end": 11547,
          "line": 228,
          "column": 58,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error(`Tensor's size(${size}) does not match data length(${this.cpuData.length}).`)",
          "start": 11754,
          "end": 11841,
          "line": 232,
          "column": 23,
          "functionAncestors": [
            "Constructor:<anonymous>"
          ]
        },
        {
          "callee": "tensorFromImage",
          "expression": "tensorFromImage(image, options)",
          "start": 12052,
          "end": 12083,
          "line": 242,
          "column": 16,
          "functionAncestors": [
            "MethodDeclaration:fromImage"
          ]
        },
        {
          "callee": "tensorFromTexture",
          "expression": "tensorFromTexture(texture, options)",
          "start": 12149,
          "end": 12184,
          "line": 245,
          "column": 16,
          "functionAncestors": [
            "MethodDeclaration:fromTexture"
          ]
        },
        {
          "callee": "tensorFromGpuBuffer",
          "expression": "tensorFromGpuBuffer(gpuBuffer, options)",
          "start": 12254,
          "end": 12293,
          "line": 248,
          "column": 16,
          "functionAncestors": [
            "MethodDeclaration:fromGpuBuffer"
          ]
        },
        {
          "callee": "tensorFromMLTensor",
          "expression": "tensorFromMLTensor(mlTensor, options)",
          "start": 12361,
          "end": 12398,
          "line": 251,
          "column": 16,
          "functionAncestors": [
            "MethodDeclaration:fromMLTensor"
          ]
        },
        {
          "callee": "tensorFromPinnedBuffer",
          "expression": "tensorFromPinnedBuffer(type, buffer, dims)",
          "start": 12471,
          "end": 12513,
          "line": 254,
          "column": 16,
          "functionAncestors": [
            "MethodDeclaration:fromPinnedBuffer"
          ]
        },
        {
          "callee": "tensorToDataURL",
          "expression": "tensorToDataURL(this, options)",
          "start": 12606,
          "end": 12636,
          "line": 259,
          "column": 16,
          "functionAncestors": [
            "MethodDeclaration:toDataURL"
          ]
        },
        {
          "callee": "tensorToImageData",
          "expression": "tensorToImageData(this, options)",
          "start": 12686,
          "end": 12718,
          "line": 262,
          "column": 16,
          "functionAncestors": [
            "MethodDeclaration:toImageData"
          ]
        },
        {
          "callee": "this.ensureValid",
          "expression": "this.ensureValid()",
          "start": 12795,
          "end": 12813,
          "line": 267,
          "column": 9,
          "functionAncestors": [
            "GetAccessor:data"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error('The data is not on CPU. Use `getData()` to download GPU data to CPU, ' +\n                'or use `texture` or `gpuBuffer` property to access the GPU data directly.')",
          "start": 12862,
          "end": 13038,
          "line": 269,
          "column": 19,
          "functionAncestors": [
            "GetAccessor:data"
          ]
        },
        {
          "callee": "this.ensureValid",
          "expression": "this.ensureValid()",
          "start": 13174,
          "end": 13192,
          "line": 278,
          "column": 9,
          "functionAncestors": [
            "GetAccessor:texture"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error('The data is not stored as a WebGL texture.')",
          "start": 13248,
          "end": 13303,
          "line": 280,
          "column": 19,
          "functionAncestors": [
            "GetAccessor:texture"
          ]
        },
        {
          "callee": "this.ensureValid",
          "expression": "this.ensureValid()",
          "start": 13387,
          "end": 13405,
          "line": 285,
          "column": 9,
          "functionAncestors": [
            "GetAccessor:gpuBuffer"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error('The data is not stored as a WebGPU buffer.')",
          "start": 13460,
          "end": 13515,
          "line": 287,
          "column": 19,
          "functionAncestors": [
            "GetAccessor:gpuBuffer"
          ]
        },
        {
          "callee": "this.ensureValid",
          "expression": "this.ensureValid()",
          "start": 13597,
          "end": 13615,
          "line": 292,
          "column": 9,
          "functionAncestors": [
            "GetAccessor:mlTensor"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error('The data is not stored as a WebNN MLTensor.')",
          "start": 13669,
          "end": 13725,
          "line": 294,
          "column": 19,
          "functionAncestors": [
            "GetAccessor:mlTensor"
          ]
        },
        {
          "callee": "this.ensureValid",
          "expression": "this.ensureValid()",
          "start": 13859,
          "end": 13877,
          "line": 301,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:getData"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error('The current tensor is not created with a specified data downloader.')",
          "start": 14162,
          "end": 14242,
          "line": 310,
          "column": 27,
          "functionAncestors": [
            "MethodDeclaration:getData"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error('The current tensor is being downloaded.')",
          "start": 14330,
          "end": 14382,
          "line": 313,
          "column": 27,
          "functionAncestors": [
            "MethodDeclaration:getData"
          ]
        },
        {
          "callee": "this.downloader",
          "expression": "this.downloader()",
          "start": 14510,
          "end": 14527,
          "line": 317,
          "column": 40,
          "functionAncestors": [
            "MethodDeclaration:getData"
          ]
        },
        {
          "callee": "this.disposer",
          "expression": "this.disposer()",
          "start": 14746,
          "end": 14761,
          "line": 322,
          "column": 25,
          "functionAncestors": [
            "MethodDeclaration:getData"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error(`cannot get data from location: ${this.dataLocation}`)",
          "start": 15036,
          "end": 15100,
          "line": 332,
          "column": 23,
          "functionAncestors": [
            "MethodDeclaration:getData"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error('The current tensor is being downloaded.')",
          "start": 15186,
          "end": 15238,
          "line": 337,
          "column": 19,
          "functionAncestors": [
            "MethodDeclaration:dispose"
          ]
        },
        {
          "callee": "this.disposer",
          "expression": "this.disposer()",
          "start": 15291,
          "end": 15306,
          "line": 340,
          "column": 13,
          "functionAncestors": [
            "MethodDeclaration:dispose"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error('The tensor is disposed.')",
          "start": 15762,
          "end": 15798,
          "line": 355,
          "column": 19,
          "functionAncestors": [
            "MethodDeclaration:ensureValid"
          ]
        },
        {
          "callee": "this.ensureValid",
          "expression": "this.ensureValid()",
          "start": 15844,
          "end": 15862,
          "line": 359,
          "column": 9,
          "functionAncestors": [
            "MethodDeclaration:reshape"
          ]
        },
        {
          "kind": "NewExpression",
          "callee": "Error",
          "expression": "new Error('Cannot reshape a tensor that owns GPU resource.')",
          "start": 15930,
          "end": 15990,
          "line": 361,
          "column": 19,
          "functionAncestors": [
            "MethodDeclaration:reshape"
          ]
        },
        {
          "callee": "tensorReshape",
          "expression": "tensorReshape(this, dims)",
          "start": 16017,
          "end": 16042,
          "line": 363,
          "column": 16,
          "functionAncestors": [
            "MethodDeclaration:reshape"
          ]
        }
      ],
      "targetExecuted": false,
      "installedRuntimeIdentityProven": false,
      "independentMatchesPython": true,
      "pythonSourceSpansVerified": true
    }
  ],
  "targetExecuted": false,
  "installedRuntimeIdentityProven": false,
  "sourceRef": "security/p001-pinned-nested-onnx-common-implementation-source-20261106-v1.json",
  "captureCommand": "node <<'NODE'\nconst crypto=require('node:crypto'),zlib=require('node:zlib'),fs=require('node:fs'),ts=require('typescript');\nconst sha=b=>crypto.createHash('sha256').update(b).digest('hex');\n(async()=>{\n const response=await fetch('https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz'); if(!response.ok)throw new Error('HTTP '+response.status);\n const archive=Buffer.from(await response.arrayBuffer());\n if(archive.length!==66168||sha(archive)!=='00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f'||'sha512-'+crypto.createHash('sha512').update(archive).digest('base64')!=='sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw==')throw new Error('archive identity mismatch');\n const tar=zlib.gunzipSync(archive),entries=new Map();\n for(let at=0;at+512<=tar.length;){const header=tar.subarray(at,at+512);if(header.every(x=>x===0))break;\n const name=header.subarray(0,100).toString().split('\\0')[0],prefix=header.subarray(345,500).toString().split('\\0')[0],size=parseInt(header.subarray(124,136).toString().replaceAll('\\0','').trim()||'0',8);\n entries.set((prefix?prefix+'/':'')+name,tar.subarray(at+512,at+512+size));at+=512+Math.ceil(size/512)*512;}\n const records=[]; for(const path of [\"dist/esm/backend-impl.js\",\"dist/esm/env-impl.js\",\"dist/esm/inference-session-impl.js\",\"dist/esm/tensor-impl.js\"]) { const bytes=entries.get('package/'+path);if(!bytes)throw new Error('missing '+path);\n const text=bytes.toString('utf8'),source=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),moduleEdges=[],effects=[];\n const position=n=>{const start=n.getStart(source),lc=source.getLineAndCharacterOfPosition(start);return{start,end:n.end,line:lc.line+1,column:lc.character+1};};\n const scope=n=>{const out=[];for(let p=n.parent;p&&!ts.isSourceFile(p);p=p.parent)if(ts.isFunctionLike(p))out.push(ts.SyntaxKind[p.kind]+':'+(p.name?.getText(source)||'<anonymous>'));return out;};\n const selected=new Set(['createRequire','runtimePlatformArch','isUnsupportedNodeRuntime','familySync','versionSync','sharp._isUsingX64V2','process.emitWarning','util.debuglog','util.inherits','stream.Duplex.call','Object.assign','this._createInputDescriptor','this.constructor.call','structuredClone','this._whenStreamInFinished','this._flattenBufferIn','clone.emit','Sharp.queue.emit']);\n function visit(n){\n  if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n)&&n.moduleSpecifier){const arg=n.moduleSpecifier;moduleEdges.push({kind:ts.SyntaxKind[n.kind],specifier:arg.text,argumentKind:ts.SyntaxKind[arg.kind],argumentText:arg.getText(source),...position(n),functionAncestors:scope(n)});}\n  if(ts.isCallExpression(n)){const callee=n.expression.getText(source);\n   if(callee==='require'||n.expression.kind===ts.SyntaxKind.ImportKeyword){const arg=n.arguments[0];moduleEdges.push({kind:callee==='require'?'RequireCall':'DynamicImport',specifier:arg&&ts.isStringLiteralLike(arg)?arg.text:null,argumentKind:arg?ts.SyntaxKind[arg.kind]:null,argumentText:arg?.getText(source),...position(n),functionAncestors:scope(n)});}\n   if(true)effects.push({callee,expression:n.getText(source),...position(n),functionAncestors:scope(n)});\n  }\n  if(ts.isNewExpression(n))effects.push({kind:'NewExpression',callee:n.expression.getText(source),expression:n.getText(source),...position(n),functionAncestors:scope(n)});\n  ts.forEachChild(n,visit);\n }visit(source);\n records.push({schema:'p001-pinned-nested-onnx-common-source-ast-verification-record-v1',recordedAt:new Date().toISOString(),archive:{bytes:archive.length,sha256:sha(archive),retainedIntegrityMatched:true},path,bytes:bytes.length,sha256:sha(bytes),parser:{tool:'typescript',version:ts.version,path:require.resolve('typescript'),sha256:sha(fs.readFileSync(require.resolve('typescript')))},parseDiagnostics:source.parseDiagnostics.map(x=>({code:x.code,start:x.start,message:ts.flattenDiagnosticMessageText(x.messageText,' ')})),moduleEdges,effects,targetExecuted:false,installedRuntimeIdentityProven:false} );\n}\nconsole.log(JSON.stringify({schema:'p001-pinned-nested-onnx-common-source-ast-verification-v1',recordedAt:new Date().toISOString(),records,targetExecuted:false,installedRuntimeIdentityProven:false}));\n})().catch(e=>{console.error(e);process.exitCode=1});\nNODE"
}
