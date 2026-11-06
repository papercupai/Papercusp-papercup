---
rel_path: "security/p001-sharp-native-loader-source-preparation-20261106-v1.json"
updated_at: 1793943009207
_body: "content"
---

{
  "schema": "p001-sharp-native-loader-source-preparation-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "currentWorkItem": "WI-6554700010045753",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "recordedAt": "2026-11-06T05:30:09.184Z",
  "status": "pinned-constructor-and-loader-source-only-unqualified",
  "sources": {
    "priorCanonical": "security/p001-native-distribution-source-classification-20261106-transformers-native-dependency-v21.json",
    "files": [
      {
        "path": "dist/constructor.cjs",
        "sourceRef": "security/p001-sharp-dist-constructor-cjs-source-20261106-v1.json",
        "astRef": "security/p001-sharp-dist-constructor-cjs-ast-verification-20261106-v1.json"
      },
      {
        "path": "dist/constructor.mjs",
        "sourceRef": "security/p001-sharp-dist-constructor-mjs-source-20261106-v1.json",
        "astRef": "security/p001-sharp-dist-constructor-mjs-ast-verification-20261106-v1.json"
      },
      {
        "path": "dist/sharp.cjs",
        "sourceRef": "security/p001-sharp-dist-sharp-cjs-source-20261106-v1.json",
        "astRef": "security/p001-sharp-dist-sharp-cjs-ast-verification-20261106-v1.json"
      },
      {
        "path": "dist/sharp.mjs",
        "sourceRef": "security/p001-sharp-dist-sharp-mjs-source-20261106-v1.json",
        "astRef": "security/p001-sharp-dist-sharp-mjs-ast-verification-20261106-v1.json"
      }
    ]
  },
  "inputs": [
    {
      "path": "dist/constructor.cjs",
      "bytes": 20364,
      "sha256": "6b8978e0f1614d83a219cbbd455e3eed7922bc4212a5b3b99c5d37c3af3b3226",
      "archive": {
        "url": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
        "bytes": 214749,
        "sha256": "3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac",
        "retainedIntegrityMatched": true
      },
      "moduleEdges": [
        {
          "kind": "RequireCall",
          "specifier": "node:util",
          "argumentKind": "StringLiteral",
          "argumentText": "'node:util'",
          "start": 102,
          "end": 122,
          "line": 6,
          "column": 14,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "node:stream",
          "argumentKind": "StringLiteral",
          "argumentText": "'node:stream'",
          "start": 139,
          "end": 161,
          "line": 7,
          "column": 16,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "./is.cjs",
          "argumentKind": "StringLiteral",
          "argumentText": "'./is.cjs'",
          "start": 174,
          "end": 193,
          "line": 8,
          "column": 12,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "./sharp.cjs",
          "argumentKind": "StringLiteral",
          "argumentText": "'./sharp.cjs'",
          "start": 196,
          "end": 218,
          "line": 10,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "selectedEffectLocations": [
        {
          "callee": "util.debuglog",
          "expression": "util.debuglog('sharp')",
          "start": 289,
          "end": 311,
          "line": 13,
          "column": 18,
          "functionAncestors": []
        },
        {
          "callee": "Sharp.queue.emit",
          "expression": "Sharp.queue.emit('change', queueLength)",
          "start": 357,
          "end": 396,
          "line": 16,
          "column": 3,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "stream.Duplex.call",
          "expression": "stream.Duplex.call(this)",
          "start": 13265,
          "end": 13289,
          "line": 232,
          "column": 3,
          "functionAncestors": [
            "FunctionExpression:<anonymous>"
          ]
        },
        {
          "callee": "this._createInputDescriptor",
          "expression": "this._createInputDescriptor(input, options, { allowStream: true })",
          "start": 17894,
          "end": 17960,
          "line": 426,
          "column": 24,
          "functionAncestors": [
            "FunctionExpression:<anonymous>"
          ]
        },
        {
          "callee": "this.constructor.call",
          "expression": "this.constructor.call()",
          "start": 19702,
          "end": 19725,
          "line": 488,
          "column": 17,
          "functionAncestors": [
            "FunctionDeclaration:clone"
          ]
        },
        {
          "callee": "structuredClone",
          "expression": "structuredClone(options)",
          "start": 19809,
          "end": 19833,
          "line": 490,
          "column": 19,
          "functionAncestors": [
            "FunctionDeclaration:clone"
          ]
        },
        {
          "callee": "this._whenStreamInFinished",
          "expression": "this._whenStreamInFinished(() => {\n      // Clone inherits input data\n      this._flattenBufferIn();\n      clone.options.input.buffer = this.options.input.buffer;\n      clone.emit('finish');\n    })",
          "start": 20011,
          "end": 20208,
          "line": 495,
          "column": 5,
          "functionAncestors": [
            "FunctionDeclaration:clone"
          ]
        },
        {
          "callee": "this._flattenBufferIn",
          "expression": "this._flattenBufferIn()",
          "start": 20087,
          "end": 20110,
          "line": 497,
          "column": 7,
          "functionAncestors": [
            "ArrowFunction:<anonymous>",
            "FunctionDeclaration:clone"
          ]
        },
        {
          "callee": "clone.emit",
          "expression": "clone.emit('finish')",
          "start": 20180,
          "end": 20200,
          "line": 499,
          "column": 7,
          "functionAncestors": [
            "ArrowFunction:<anonymous>",
            "FunctionDeclaration:clone"
          ]
        },
        {
          "callee": "Object.assign",
          "expression": "Object.assign(Sharp.prototype, { clone })",
          "start": 20232,
          "end": 20273,
          "line": 504,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      }
    },
    {
      "path": "dist/constructor.mjs",
      "bytes": 20340,
      "sha256": "8be8da679d2a028d0f53b02ce52f07f295134a297caf3068944cd8d0b57ab3d1",
      "archive": {
        "url": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
        "bytes": 214749,
        "sha256": "3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac",
        "retainedIntegrityMatched": true
      },
      "moduleEdges": [
        {
          "kind": "ImportDeclaration",
          "specifier": "node:util",
          "argumentKind": "StringLiteral",
          "argumentText": "'node:util'",
          "start": 89,
          "end": 118,
          "line": 6,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "ImportDeclaration",
          "specifier": "node:stream",
          "argumentKind": "StringLiteral",
          "argumentText": "'node:stream'",
          "start": 119,
          "end": 152,
          "line": 7,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "ImportDeclaration",
          "specifier": "./is.mjs",
          "argumentKind": "StringLiteral",
          "argumentText": "'./is.mjs'",
          "start": 153,
          "end": 179,
          "line": 8,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "ImportDeclaration",
          "specifier": "./sharp.mjs",
          "argumentKind": "StringLiteral",
          "argumentText": "'./sharp.mjs'",
          "start": 181,
          "end": 202,
          "line": 10,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "selectedEffectLocations": [
        {
          "callee": "util.debuglog",
          "expression": "util.debuglog('sharp')",
          "start": 272,
          "end": 294,
          "line": 13,
          "column": 18,
          "functionAncestors": []
        },
        {
          "callee": "Sharp.queue.emit",
          "expression": "Sharp.queue.emit('change', queueLength)",
          "start": 340,
          "end": 379,
          "line": 16,
          "column": 3,
          "functionAncestors": [
            "ArrowFunction:<anonymous>"
          ]
        },
        {
          "callee": "stream.Duplex.call",
          "expression": "stream.Duplex.call(this)",
          "start": 13243,
          "end": 13267,
          "line": 232,
          "column": 3,
          "functionAncestors": [
            "FunctionExpression:<anonymous>"
          ]
        },
        {
          "callee": "this._createInputDescriptor",
          "expression": "this._createInputDescriptor(input, options, { allowStream: true })",
          "start": 17872,
          "end": 17938,
          "line": 426,
          "column": 24,
          "functionAncestors": [
            "FunctionExpression:<anonymous>"
          ]
        },
        {
          "callee": "this.constructor.call",
          "expression": "this.constructor.call()",
          "start": 19680,
          "end": 19703,
          "line": 488,
          "column": 17,
          "functionAncestors": [
            "FunctionDeclaration:clone"
          ]
        },
        {
          "callee": "structuredClone",
          "expression": "structuredClone(options)",
          "start": 19787,
          "end": 19811,
          "line": 490,
          "column": 19,
          "functionAncestors": [
            "FunctionDeclaration:clone"
          ]
        },
        {
          "callee": "this._whenStreamInFinished",
          "expression": "this._whenStreamInFinished(() => {\n      // Clone inherits input data\n      this._flattenBufferIn();\n      clone.options.input.buffer = this.options.input.buffer;\n      clone.emit('finish');\n    })",
          "start": 19989,
          "end": 20186,
          "line": 495,
          "column": 5,
          "functionAncestors": [
            "FunctionDeclaration:clone"
          ]
        },
        {
          "callee": "this._flattenBufferIn",
          "expression": "this._flattenBufferIn()",
          "start": 20065,
          "end": 20088,
          "line": 497,
          "column": 7,
          "functionAncestors": [
            "ArrowFunction:<anonymous>",
            "FunctionDeclaration:clone"
          ]
        },
        {
          "callee": "clone.emit",
          "expression": "clone.emit('finish')",
          "start": 20158,
          "end": 20178,
          "line": 499,
          "column": 7,
          "functionAncestors": [
            "ArrowFunction:<anonymous>",
            "FunctionDeclaration:clone"
          ]
        },
        {
          "callee": "Object.assign",
          "expression": "Object.assign(Sharp.prototype, { clone })",
          "start": 20210,
          "end": 20251,
          "line": 504,
          "column": 1,
          "functionAncestors": []
        }
      ],
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      }
    },
    {
      "path": "dist/sharp.cjs",
      "bytes": 6262,
      "sha256": "76120d3971051fcc469c0bfa36e7b23d3c388b6a2f5785bf1491bbdb90ff0176",
      "archive": {
        "url": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
        "bytes": 214749,
        "sha256": "3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac",
        "retainedIntegrityMatched": true
      },
      "moduleEdges": [
        {
          "kind": "RequireCall",
          "specifier": "detect-libc",
          "argumentKind": "StringLiteral",
          "argumentText": "\"detect-libc\"",
          "start": 206,
          "end": 228,
          "line": 9,
          "column": 37,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "./libvips.cjs",
          "argumentKind": "StringLiteral",
          "argumentText": "\"./libvips.cjs\"",
          "start": 247,
          "end": 271,
          "line": 11,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "../package.json",
          "argumentKind": "StringLiteral",
          "argumentText": "'../package.json'",
          "start": 285,
          "end": 311,
          "line": 12,
          "column": 13,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": null,
          "argumentKind": "TemplateExpression",
          "argumentText": "`../src/build/Release/sharp-${runtimePlatform}-${version}.node`",
          "start": 573,
          "end": 645,
          "line": 25,
          "column": 11,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": null,
          "argumentKind": "TemplateExpression",
          "argumentText": "`../src/build/Release/sharp-wasm32-${version}.node`",
          "start": 719,
          "end": 779,
          "line": 31,
          "column": 13,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-darwin-arm64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-darwin-arm64/sharp.node\"",
          "start": 923,
          "end": 968,
          "line": 40,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-darwin-x64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-darwin-x64/sharp.node\"",
          "start": 1026,
          "end": 1069,
          "line": 43,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-arm/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-arm/sharp.node\"",
          "start": 1126,
          "end": 1168,
          "line": 46,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-arm64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-arm64/sharp.node\"",
          "start": 1227,
          "end": 1271,
          "line": 49,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-ppc64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-ppc64/sharp.node\"",
          "start": 1330,
          "end": 1374,
          "line": 52,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-riscv64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-riscv64/sharp.node\"",
          "start": 1435,
          "end": 1481,
          "line": 55,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-s390x/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-s390x/sharp.node\"",
          "start": 1540,
          "end": 1584,
          "line": 58,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-x64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-x64/sharp.node\"",
          "start": 1641,
          "end": 1683,
          "line": 61,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linuxmusl-arm64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linuxmusl-arm64/sharp.node\"",
          "start": 1746,
          "end": 1794,
          "line": 64,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linuxmusl-x64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linuxmusl-x64/sharp.node\"",
          "start": 1855,
          "end": 1901,
          "line": 67,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-win32-arm64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-win32-arm64/sharp.node\"",
          "start": 1960,
          "end": 2004,
          "line": 70,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-win32-ia32/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-win32-ia32/sharp.node\"",
          "start": 2062,
          "end": 2105,
          "line": 73,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-win32-x64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-win32-x64/sharp.node\"",
          "start": 2162,
          "end": 2204,
          "line": 76,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-freebsd-wasm32/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-freebsd-wasm32/sharp.node\"",
          "start": 2291,
          "end": 2338,
          "line": 80,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-webcontainers-wasm32/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-webcontainers-wasm32/sharp.node\"",
          "start": 2398,
          "end": 2451,
          "line": 83,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-wasm32/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-wasm32/sharp.node\"",
          "start": 3156,
          "end": 3195,
          "line": 104,
          "column": 13,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": null,
          "argumentKind": "TemplateExpression",
          "argumentText": "`@img/sharp-libvips-${runtimePlatform}/package`",
          "start": 4934,
          "end": 4990,
          "line": 146,
          "column": 26,
          "functionAncestors": []
        }
      ],
      "selectedEffectLocations": [
        {
          "callee": "runtimePlatformArch",
          "expression": "runtimePlatformArch()",
          "start": 474,
          "end": 495,
          "line": 18,
          "column": 25,
          "functionAncestors": []
        },
        {
          "callee": "sharp._isUsingX64V2",
          "expression": "sharp._isUsingX64V2()",
          "start": 2552,
          "end": 2573,
          "line": 86,
          "column": 79,
          "functionAncestors": []
        },
        {
          "callee": "process.emitWarning",
          "expression": "process.emitWarning(\n        \"Binaries provided by Electron for use on Linux may be incompatible with sharp - see https://sharp.pixelplumbing.com/install#electron-and-linux\",\n        { code: \"SharpElectronLinux\" }\n      )",
          "start": 2847,
          "end": 3068,
          "line": 93,
          "column": 7,
          "functionAncestors": []
        },
        {
          "callee": "isUnsupportedNodeRuntime",
          "expression": "isUnsupportedNodeRuntime()",
          "start": 3760,
          "end": 3786,
          "line": 122,
          "column": 7,
          "functionAncestors": []
        },
        {
          "callee": "isUnsupportedNodeRuntime",
          "expression": "isUnsupportedNodeRuntime()",
          "start": 3822,
          "end": 3848,
          "line": 123,
          "column": 33,
          "functionAncestors": []
        },
        {
          "callee": "familySync",
          "expression": "familySync()",
          "start": 5019,
          "end": 5031,
          "line": 147,
          "column": 28,
          "functionAncestors": []
        },
        {
          "callee": "versionSync",
          "expression": "versionSync()",
          "start": 5035,
          "end": 5048,
          "line": 147,
          "column": 44,
          "functionAncestors": []
        }
      ],
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      }
    },
    {
      "path": "dist/sharp.mjs",
      "bytes": 6357,
      "sha256": "d0c3ce3837636a140e8363850823e3b8dc2b000928303664cc9fc1aa2ba326ee",
      "archive": {
        "url": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
        "bytes": 214749,
        "sha256": "3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac",
        "retainedIntegrityMatched": true
      },
      "moduleEdges": [
        {
          "kind": "ImportDeclaration",
          "specifier": "node:module",
          "argumentKind": "StringLiteral",
          "argumentText": "\"node:module\"",
          "start": 169,
          "end": 212,
          "line": 8,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "ImportDeclaration",
          "specifier": "detect-libc",
          "argumentKind": "StringLiteral",
          "argumentText": "\"detect-libc\"",
          "start": 213,
          "end": 267,
          "line": 9,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "ImportDeclaration",
          "specifier": "./libvips.mjs",
          "argumentKind": "StringLiteral",
          "argumentText": "\"./libvips.mjs\"",
          "start": 269,
          "end": 305,
          "line": 11,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "ImportDeclaration",
          "specifier": "../package.json",
          "argumentKind": "StringLiteral",
          "argumentText": "'../package.json'",
          "start": 306,
          "end": 362,
          "line": 12,
          "column": 1,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": null,
          "argumentKind": "TemplateExpression",
          "argumentText": "`../src/build/Release/sharp-${runtimePlatform}-${version}.node`",
          "start": 670,
          "end": 742,
          "line": 25,
          "column": 11,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": null,
          "argumentKind": "TemplateExpression",
          "argumentText": "`../src/build/Release/sharp-wasm32-${version}.node`",
          "start": 816,
          "end": 876,
          "line": 31,
          "column": 13,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-darwin-arm64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-darwin-arm64/sharp.node\"",
          "start": 1020,
          "end": 1065,
          "line": 40,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-darwin-x64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-darwin-x64/sharp.node\"",
          "start": 1123,
          "end": 1166,
          "line": 43,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-arm/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-arm/sharp.node\"",
          "start": 1223,
          "end": 1265,
          "line": 46,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-arm64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-arm64/sharp.node\"",
          "start": 1324,
          "end": 1368,
          "line": 49,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-ppc64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-ppc64/sharp.node\"",
          "start": 1427,
          "end": 1471,
          "line": 52,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-riscv64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-riscv64/sharp.node\"",
          "start": 1532,
          "end": 1578,
          "line": 55,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-s390x/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-s390x/sharp.node\"",
          "start": 1637,
          "end": 1681,
          "line": 58,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linux-x64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linux-x64/sharp.node\"",
          "start": 1738,
          "end": 1780,
          "line": 61,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linuxmusl-arm64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linuxmusl-arm64/sharp.node\"",
          "start": 1843,
          "end": 1891,
          "line": 64,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-linuxmusl-x64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-linuxmusl-x64/sharp.node\"",
          "start": 1952,
          "end": 1998,
          "line": 67,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-win32-arm64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-win32-arm64/sharp.node\"",
          "start": 2057,
          "end": 2101,
          "line": 70,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-win32-ia32/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-win32-ia32/sharp.node\"",
          "start": 2159,
          "end": 2202,
          "line": 73,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-win32-x64/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-win32-x64/sharp.node\"",
          "start": 2259,
          "end": 2301,
          "line": 76,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-freebsd-wasm32/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-freebsd-wasm32/sharp.node\"",
          "start": 2388,
          "end": 2435,
          "line": 80,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-webcontainers-wasm32/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-webcontainers-wasm32/sharp.node\"",
          "start": 2495,
          "end": 2548,
          "line": 83,
          "column": 17,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": "@img/sharp-wasm32/sharp.node",
          "argumentKind": "StringLiteral",
          "argumentText": "\"@img/sharp-wasm32/sharp.node\"",
          "start": 3253,
          "end": 3292,
          "line": 104,
          "column": 13,
          "functionAncestors": []
        },
        {
          "kind": "RequireCall",
          "specifier": null,
          "argumentKind": "TemplateExpression",
          "argumentText": "`@img/sharp-libvips-${runtimePlatform}/package`",
          "start": 5031,
          "end": 5087,
          "line": 146,
          "column": 26,
          "functionAncestors": []
        }
      ],
      "selectedEffectLocations": [
        {
          "callee": "createRequire",
          "expression": "createRequire(import.meta.url)",
          "start": 380,
          "end": 410,
          "line": 14,
          "column": 17,
          "functionAncestors": []
        },
        {
          "callee": "runtimePlatformArch",
          "expression": "runtimePlatformArch()",
          "start": 571,
          "end": 592,
          "line": 18,
          "column": 25,
          "functionAncestors": []
        },
        {
          "callee": "sharp._isUsingX64V2",
          "expression": "sharp._isUsingX64V2()",
          "start": 2649,
          "end": 2670,
          "line": 86,
          "column": 79,
          "functionAncestors": []
        },
        {
          "callee": "process.emitWarning",
          "expression": "process.emitWarning(\n        \"Binaries provided by Electron for use on Linux may be incompatible with sharp - see https://sharp.pixelplumbing.com/install#electron-and-linux\",\n        { code: \"SharpElectronLinux\" }\n      )",
          "start": 2944,
          "end": 3165,
          "line": 93,
          "column": 7,
          "functionAncestors": []
        },
        {
          "callee": "isUnsupportedNodeRuntime",
          "expression": "isUnsupportedNodeRuntime()",
          "start": 3857,
          "end": 3883,
          "line": 122,
          "column": 7,
          "functionAncestors": []
        },
        {
          "callee": "isUnsupportedNodeRuntime",
          "expression": "isUnsupportedNodeRuntime()",
          "start": 3919,
          "end": 3945,
          "line": 123,
          "column": 33,
          "functionAncestors": []
        },
        {
          "callee": "familySync",
          "expression": "familySync()",
          "start": 5116,
          "end": 5128,
          "line": 147,
          "column": 28,
          "functionAncestors": []
        },
        {
          "callee": "versionSync",
          "expression": "versionSync()",
          "start": 5132,
          "end": 5145,
          "line": 147,
          "column": 44,
          "functionAncestors": []
        }
      ],
      "parser": {
        "tool": "typescript",
        "version": "6.0.3",
        "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
        "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
      }
    }
  ],
  "verification": {
    "method": "Independent Python urllib/hashlib/tarfile versus Node fetch/crypto/zlib/raw-tar; offline TypeScript 6.0.3 AST; node spans rechecked against Python source.",
    "checks": [
      {
        "path": "dist/constructor.cjs",
        "pythonVersusNodeSourceIdentityExact": true,
        "moduleEdgeLocationsMatchPythonSource": true,
        "selectedEffectLocationsMatchPythonSource": true,
        "parseDiagnosticCount": 0
      },
      {
        "path": "dist/constructor.mjs",
        "pythonVersusNodeSourceIdentityExact": true,
        "moduleEdgeLocationsMatchPythonSource": true,
        "selectedEffectLocationsMatchPythonSource": true,
        "parseDiagnosticCount": 0
      },
      {
        "path": "dist/sharp.cjs",
        "pythonVersusNodeSourceIdentityExact": true,
        "moduleEdgeLocationsMatchPythonSource": true,
        "selectedEffectLocationsMatchPythonSource": true,
        "parseDiagnosticCount": 0
      },
      {
        "path": "dist/sharp.mjs",
        "pythonVersusNodeSourceIdentityExact": true,
        "moduleEdgeLocationsMatchPythonSource": true,
        "selectedEffectLocationsMatchPythonSource": true,
        "parseDiagnosticCount": 0
      }
    ],
    "sharedLoaderBodyExact": true
  },
  "sourceFindings": [
    {
      "source": "dist/constructor.cjs and .mjs:6-13",
      "finding": "Both constructors load node:util, node:stream, is and the sharp loader as module initialization; CJS require and ESM side-effect import at line10 precede a Sharp constructor invocation. util.debuglog at13 is a module body call; input creation and stream/clone callback effects occur later in function bodies."
    },
    {
      "source": "dist/sharp.cjs and .mjs:18-108",
      "finding": "runtimePlatformArch() at18 selects the runtime platform through libvips. Loader attempts local platform/version .node at25, local wasm32/version .node at31, platform packages in the switch at38-85, and generic @img/sharp-wasm32/sharp.node at104. The local path arguments are TemplateExpression, not literal installed identities."
    },
    {
      "source": "dist/sharp.mjs:8-14",
      "finding": "ESM imports createRequire from node:module and binds require=createRequire(import.meta.url); native loads use this require in ESM too."
    },
    {
      "source": "dist/sharp.cjs and .mjs:86-171",
      "finding": "The loader calls native sharp._isUsingX64V2 on Linux x64 variants and can emit an Electron warning. Failed paths accumulate errors; absent bindings produce a thrown Error. The conditional libvips package read at146 is a computed error-diagnostic load. Printed npm, brew, snap instructions are strings, not executed shell commands."
    },
    {
      "source": "Named loader boundaries",
      "finding": "Native selection depends on libvips helpers, detect-libc, package metadata and installed module resolution. These artifacts do not show which native bytes were actually loaded, qualify confinement or close a population."
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
    "Exact installed resolver and native binary identity/custody, including local build candidates and optional native/WASM dependencies.",
    "Pinned libvips helper and detect-libc transitive source/effect review, plus Sharp sibling setup modules.",
    "Independent committed row applicability and positive/negative runtime observations for all seven populations.",
    "Retained unpinned ONNX root/common/web/node historical byte gaps remain; public same-version archive bytes cannot establish historical installed identity."
  ],
  "applicabilityCommitted": false,
  "populationComplete": false,
  "closureAccepted": false,
  "executionAdmitted": false,
  "qualificationExecuted": false,
  "targetExecuted": false,
  "nextNamedSourceUnit": {
    "kind": "pinned-nested-onnx-common-esm-reexports",
    "package": "onnxruntime-common",
    "version": "1.24.0-dev.20251116-b39e144322",
    "archiveSha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
    "archiveBytes": 66168,
    "files": [
      "dist/esm/backend.js",
      "dist/esm/env.js",
      "dist/esm/inference-session.js",
      "dist/esm/tensor.js",
      "dist/esm/tensor-conversion.js",
      "dist/esm/tensor-factory.js",
      "dist/esm/trace.js",
      "dist/esm/onnx-model.js",
      "dist/esm/onnx-value.js"
    ],
    "instruction": "Read only these named static source modules from exact retained-integrity archive; no target code/native/WASM/worker execution or historical identity inference."
  }
}
