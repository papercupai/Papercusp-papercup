---
rel_path: "security/p001-transformers-native-dependency-source-preparation-20261106-v1.json"
updated_at: 1793942155851
_body: "content"
---

{
  "schema": "p001-transformers-native-dependency-source-preparation-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "currentWorkItem": "WI-6554700010045753",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "status": "named-lock-and-package-entry-identities-only-unqualified",
  "recordedAt": "2026-11-06T05:15:55.841Z",
  "sources": {
    "priorCanonical": "security/p001-native-distribution-source-classification-20261106-transformers-entry-v20.json",
    "lock": "security/p001-transformers-native-dependency-lock-source-20261106-v1.json",
    "lockVerification": "security/p001-transformers-native-dependency-lock-verification-20261106-v1.json",
    "onnxCommon": "security/p001-transformers-onnx-common-package-identities-20261106-v1.json",
    "sharp": "security/p001-transformers-sharp-package-identities-20261106-v1.json",
    "packageVerification": "security/p001-transformers-native-dependency-package-verification-20261106-v1.json"
  },
  "evidenceScope": "New named rows only from retained lock; exact integrity-pinned public package source identities and small distribution entry text. No package install/import/script/native/worker execution, runtime resolution or artifact qualification.",
  "inputs": {
    "lock": {
      "schema": "p001-transformers-native-dependency-lock-source-v1",
      "recordedAt": "2026-11-06T05:13:19.943539+00:00",
      "source": {
        "rootRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
        "path": "package-lock.json",
        "bytes": 1432077,
        "sha256": "a20ed6c4aa15befa12baf21a955bcadb1d91523c42b834961f1d28170e98cf42",
        "gitBlob": "a8cb14da54bc33aedff29301c9abdcf1cab23133"
      },
      "names": [
        "sharp",
        "onnxruntime-common"
      ],
      "rows": [
        {
          "path": "node_modules/@huggingface/transformers/node_modules/onnxruntime-common",
          "entry": {
            "version": "1.24.0-dev.20251116-b39e144322",
            "resolved": "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz",
            "integrity": "sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw==",
            "license": "MIT"
          }
        },
        {
          "path": "node_modules/onnxruntime-common",
          "entry": {
            "version": "1.24.3",
            "license": "MIT"
          }
        },
        {
          "path": "node_modules/onnxruntime-web/node_modules/onnxruntime-common",
          "entry": {
            "version": "1.24.1",
            "license": "MIT"
          }
        },
        {
          "path": "node_modules/sharp",
          "entry": {
            "version": "0.35.5",
            "resolved": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
            "integrity": "sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==",
            "license": "Apache-2.0",
            "dependencies": {
              "@img/colour": "^1.1.0",
              "detect-libc": "^2.1.2",
              "semver": "^7.8.5"
            },
            "engines": {
              "node": ">=20.9.0"
            },
            "funding": {
              "url": "https://opencollective.com/libvips"
            },
            "optionalDependencies": {
              "@img/sharp-darwin-arm64": "0.35.5",
              "@img/sharp-darwin-x64": "0.35.5",
              "@img/sharp-freebsd-wasm32": "0.35.5",
              "@img/sharp-libvips-darwin-arm64": "1.3.4",
              "@img/sharp-libvips-darwin-x64": "1.3.4",
              "@img/sharp-libvips-linux-arm": "1.3.4",
              "@img/sharp-libvips-linux-arm64": "1.3.4",
              "@img/sharp-libvips-linux-ppc64": "1.3.4",
              "@img/sharp-libvips-linux-riscv64": "1.3.4",
              "@img/sharp-libvips-linux-s390x": "1.3.4",
              "@img/sharp-libvips-linux-x64": "1.3.4",
              "@img/sharp-libvips-linuxmusl-arm64": "1.3.4",
              "@img/sharp-libvips-linuxmusl-x64": "1.3.4",
              "@img/sharp-linux-arm": "0.35.5",
              "@img/sharp-linux-arm64": "0.35.5",
              "@img/sharp-linux-ppc64": "0.35.5",
              "@img/sharp-linux-riscv64": "0.35.5",
              "@img/sharp-linux-s390x": "0.35.5",
              "@img/sharp-linux-x64": "0.35.5",
              "@img/sharp-linuxmusl-arm64": "0.35.5",
              "@img/sharp-linuxmusl-x64": "0.35.5",
              "@img/sharp-webcontainers-wasm32": "0.35.5",
              "@img/sharp-win32-arm64": "0.35.5",
              "@img/sharp-win32-ia32": "0.35.5",
              "@img/sharp-win32-x64": "0.35.5"
            },
            "peerDependenciesMeta": {
              "@types/node": {
                "optional": true
              }
            }
          }
        }
      ],
      "candidateExecution": false,
      "installedOrResolvedRuntimeIdentityProven": false,
      "captureCommand": "python3 - <<'PY'\n\nimport subprocess,hashlib,json,datetime\nroot='42d905b5b2fcbea2bb651178a7ff3c905cf89626'\nb=subprocess.check_output(['git','show',root+':package-lock.json'])\nassert len(b)==1432077 and hashlib.sha256(b).hexdigest()=='a20ed6c4aa15befa12baf21a955bcadb1d91523c42b834961f1d28170e98cf42'\nd=json.loads(b);names=['sharp','onnxruntime-common']\nrows=[{'path':p,'entry':e} for p,e in d['packages'].items() if any(p=='node_modules/'+n or p.endswith('/node_modules/'+n) for n in names)]\nrecord={'schema':'p001-transformers-native-dependency-lock-source-v1','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':{'rootRevision':root,'path':'package-lock.json','bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'gitBlob':'a8cb14da54bc33aedff29301c9abdcf1cab23133'},'names':names,'rows':rows,'candidateExecution':False,'installedOrResolvedRuntimeIdentityProven':False}\nout=json.dumps(record);assert len(out)<13000,len(out);print(out)\n\nPY"
    },
    "lockVerification": {
      "schema": "p001-transformers-native-dependency-lock-independent-v1",
      "method": "Independent Node crypto and git cat-file against Python git-show/hashlib",
      "sourceSha256": "a20ed6c4aa15befa12baf21a955bcadb1d91523c42b834961f1d28170e98cf42",
      "rows": [
        {
          "path": "node_modules/@huggingface/transformers/node_modules/onnxruntime-common",
          "entry": {
            "version": "1.24.0-dev.20251116-b39e144322",
            "resolved": "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz",
            "integrity": "sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw==",
            "license": "MIT"
          }
        },
        {
          "path": "node_modules/onnxruntime-common",
          "entry": {
            "version": "1.24.3",
            "license": "MIT"
          }
        },
        {
          "path": "node_modules/onnxruntime-web/node_modules/onnxruntime-common",
          "entry": {
            "version": "1.24.1",
            "license": "MIT"
          }
        },
        {
          "path": "node_modules/sharp",
          "entry": {
            "version": "0.35.5",
            "resolved": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
            "integrity": "sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==",
            "license": "Apache-2.0",
            "dependencies": {
              "@img/colour": "^1.1.0",
              "detect-libc": "^2.1.2",
              "semver": "^7.8.5"
            },
            "engines": {
              "node": ">=20.9.0"
            },
            "funding": {
              "url": "https://opencollective.com/libvips"
            },
            "optionalDependencies": {
              "@img/sharp-darwin-arm64": "0.35.5",
              "@img/sharp-darwin-x64": "0.35.5",
              "@img/sharp-freebsd-wasm32": "0.35.5",
              "@img/sharp-libvips-darwin-arm64": "1.3.4",
              "@img/sharp-libvips-darwin-x64": "1.3.4",
              "@img/sharp-libvips-linux-arm": "1.3.4",
              "@img/sharp-libvips-linux-arm64": "1.3.4",
              "@img/sharp-libvips-linux-ppc64": "1.3.4",
              "@img/sharp-libvips-linux-riscv64": "1.3.4",
              "@img/sharp-libvips-linux-s390x": "1.3.4",
              "@img/sharp-libvips-linux-x64": "1.3.4",
              "@img/sharp-libvips-linuxmusl-arm64": "1.3.4",
              "@img/sharp-libvips-linuxmusl-x64": "1.3.4",
              "@img/sharp-linux-arm": "0.35.5",
              "@img/sharp-linux-arm64": "0.35.5",
              "@img/sharp-linux-ppc64": "0.35.5",
              "@img/sharp-linux-riscv64": "0.35.5",
              "@img/sharp-linux-s390x": "0.35.5",
              "@img/sharp-linux-x64": "0.35.5",
              "@img/sharp-linuxmusl-arm64": "0.35.5",
              "@img/sharp-linuxmusl-x64": "0.35.5",
              "@img/sharp-webcontainers-wasm32": "0.35.5",
              "@img/sharp-win32-arm64": "0.35.5",
              "@img/sharp-win32-ia32": "0.35.5",
              "@img/sharp-win32-x64": "0.35.5"
            },
            "peerDependenciesMeta": {
              "@types/node": {
                "optional": true
              }
            }
          }
        }
      ],
      "candidateExecution": false,
      "installedOrResolvedRuntimeIdentityProven": false,
      "rowsMatch": true,
      "captureCommand": "node <<'NODE'\n\nconst cp=require('node:child_process'),crypto=require('node:crypto');\nconst rev='42d905b5b2fcbea2bb651178a7ff3c905cf89626';\nconst b=cp.execFileSync('git',['cat-file','blob',rev+':package-lock.json'],{maxBuffer:1432077+1024});\nif(b.length!==1432077||crypto.createHash('sha256').update(b).digest('hex')!=='a20ed6c4aa15befa12baf21a955bcadb1d91523c42b834961f1d28170e98cf42')throw Error('lock pin');\nconst d=JSON.parse(b),names=['sharp','onnxruntime-common'],rows=Object.entries(d.packages).filter(([p])=>names.some(n=>p==='node_modules/'+n||p.endsWith('/node_modules/'+n))).map(([path,entry])=>({path,entry}));\nprocess.stdout.write(JSON.stringify({schema:'p001-transformers-native-dependency-lock-independent-v1',method:'Independent Node crypto and git cat-file against Python git-show/hashlib',sourceSha256:crypto.createHash('sha256').update(b).digest('hex'),rows,candidateExecution:false,installedOrResolvedRuntimeIdentityProven:false}));\n\nNODE"
    },
    "onnxCommon": {
      "schema": "p001-transformers-native-dependency-package-identities-v1",
      "recordedAt": "2026-11-06T05:14:21.670778+00:00",
      "lockRow": {
        "path": "node_modules/@huggingface/transformers/node_modules/onnxruntime-common",
        "entry": {
          "version": "1.24.0-dev.20251116-b39e144322",
          "resolved": "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz",
          "integrity": "sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw==",
          "license": "MIT"
        }
      },
      "acquisition": {
        "url": "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz",
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "integrity": "sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw==",
        "matchesRetainedIntegrity": true
      },
      "manifest": {
        "path": "package.json",
        "bytes": 973,
        "sha256": "0b2e5d9ae190f993bb898c752ca0168a97124d980fa66e77738944bc37989106",
        "text": "{\n  \"license\": \"MIT\",\n  \"type\": \"module\",\n  \"name\": \"onnxruntime-common\",\n  \"version\": \"1.24.0-dev.20251116-b39e144322\",\n  \"repository\": {\n    \"url\": \"https://github.com/Microsoft/onnxruntime.git\",\n    \"type\": \"git\"\n  },\n  \"author\": \"fs-eire\",\n  \"scripts\": {\n    \"build:cjs\": \"tsc --module commonjs --moduleResolution node10 --outDir ./dist/cjs\",\n    \"build:esm\": \"tsc\",\n    \"build:bundles\": \"webpack\",\n    \"build\": \"node ./build.js\",\n    \"prepare\": \"npm run build\",\n    \"pretest\": \"tsc --build ./test\",\n    \"test\": \"mocha \\\"./test/**/*.js\\\" --timeout 30000\",\n    \"test:f16\": \"mocha -n js-float16array \\\"./test/**/*.js\\\" --timeout 30000\"\n  },\n  \"devDependencies\": {\n    \"globby\": \"^15.0.0\",\n    \"typedoc\": \"^0.25.7\"\n  },\n  \"main\": \"dist/cjs/index.js\",\n  \"exports\": {\n    \"require\": \"./dist/cjs/index.js\",\n    \"import\": \"./dist/esm/index.js\"\n  },\n  \"keywords\": [\n    \"ONNX\",\n    \"ONNXRuntime\",\n    \"ONNX Runtime\"\n  ],\n  \"description\": \"ONNXRuntime JavaScript API library\"\n}\n"
      },
      "entryIdentities": [
        {
          "path": "dist/cjs/index.js",
          "fields": [
            "main",
            "exports.require"
          ],
          "bytes": 1955,
          "sha256": "d7dd6cc9790e87299099fcd1b0ccb4969c01591d7eec0383a1c64dbea133dd1a",
          "sourceText": "\"use strict\";\n// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nvar __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {\n    if (k2 === undefined) k2 = k;\n    var desc = Object.getOwnPropertyDescriptor(m, k);\n    if (!desc || (\"get\" in desc ? !m.__esModule : desc.writable || desc.configurable)) {\n      desc = { enumerable: true, get: function() { return m[k]; } };\n    }\n    Object.defineProperty(o, k2, desc);\n}) : (function(o, m, k, k2) {\n    if (k2 === undefined) k2 = k;\n    o[k2] = m[k];\n}));\nvar __exportStar = (this && this.__exportStar) || function(m, exports) {\n    for (var p in m) if (p !== \"default\" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);\n};\nObject.defineProperty(exports, \"__esModule\", { value: true });\n/**\n * # ONNX Runtime JavaScript API\n *\n * ONNX Runtime JavaScript API is a unified API for all JavaScript usages, including the following NPM packages:\n *\n * - [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node)\n * - [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web)\n * - [onnxruntime-react-native](https://www.npmjs.com/package/onnxruntime-react-native)\n *\n * See also:\n * - [Get Started](https://onnxruntime.ai/docs/get-started/with-javascript/)\n * - [Inference examples](https://github.com/microsoft/onnxruntime-inference-examples/tree/main/js)\n *\n * @packageDocumentation\n */\n__exportStar(require(\"./backend.js\"), exports);\n__exportStar(require(\"./env.js\"), exports);\n__exportStar(require(\"./inference-session.js\"), exports);\n__exportStar(require(\"./tensor.js\"), exports);\n__exportStar(require(\"./tensor-conversion.js\"), exports);\n__exportStar(require(\"./tensor-factory.js\"), exports);\n__exportStar(require(\"./trace.js\"), exports);\n__exportStar(require(\"./onnx-model.js\"), exports);\n__exportStar(require(\"./onnx-value.js\"), exports);\n//# sourceMappingURL=index.js.map"
        },
        {
          "path": "dist/esm/index.js",
          "fields": [
            "exports.import"
          ],
          "bytes": 1036,
          "sha256": "ad23f6d6ce2c99c449031f24a5181f259516c64a9a67428c98a8539b857729bd",
          "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\n/**\n * # ONNX Runtime JavaScript API\n *\n * ONNX Runtime JavaScript API is a unified API for all JavaScript usages, including the following NPM packages:\n *\n * - [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node)\n * - [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web)\n * - [onnxruntime-react-native](https://www.npmjs.com/package/onnxruntime-react-native)\n *\n * See also:\n * - [Get Started](https://onnxruntime.ai/docs/get-started/with-javascript/)\n * - [Inference examples](https://github.com/microsoft/onnxruntime-inference-examples/tree/main/js)\n *\n * @packageDocumentation\n */\nexport * from './backend.js';\nexport * from './env.js';\nexport * from './inference-session.js';\nexport * from './tensor.js';\nexport * from './tensor-conversion.js';\nexport * from './tensor-factory.js';\nexport * from './trace.js';\nexport * from './onnx-model.js';\nexport * from './onnx-value.js';\n//# sourceMappingURL=index.js.map"
        }
      ],
      "candidateExecution": false,
      "installedRuntimeIdentityProven": false,
      "captureCommand": "python3 - <<'PY'\n\nimport urllib.request,tarfile,io,hashlib,base64,json,posixpath,datetime\nrow=json.loads(\"{\\\"path\\\":\\\"node_modules/@huggingface/transformers/node_modules/onnxruntime-common\\\",\\\"entry\\\":{\\\"version\\\":\\\"1.24.0-dev.20251116-b39e144322\\\",\\\"resolved\\\":\\\"https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz\\\",\\\"integrity\\\":\\\"sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw==\\\",\\\"license\\\":\\\"MIT\\\"}}\");e=row['entry']\nb=urllib.request.urlopen(e['resolved'],timeout=20).read()\nassert 'sha512-'+base64.b64encode(hashlib.sha512(b).digest()).decode()==e['integrity']\nt=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz')\nmb=t.extractfile('package/package.json').read();m=json.loads(mb)\nassert m['version']==e['version']\ntargets=[]\ndef add(v,field):\n if isinstance(v,str) and v.startswith(('./','dist/','lib/','index.')):targets.append((field,v.removeprefix('./')))\n elif isinstance(v,dict):\n  for k,x in v.items():add(x,field+'.'+k)\n elif isinstance(v,list):\n  for i,x in enumerate(v):add(x,field+'.'+str(i))\nfor key in ['main','module','exports']:add(m.get(key),key)\nentries=[]\nfor p in dict.fromkeys(v for _,v in targets):\n f=t.extractfile('package/'+p);data=f.read()\n entries.append({'path':p,'fields':[k for k,v in targets if v==p],'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'sourceText':data.decode() if p.endswith(('.js','.mjs','.cjs')) and len(data)<5000 else None})\nrecord={'schema':'p001-transformers-native-dependency-package-identities-v1','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'lockRow':row,'acquisition':{'url':e['resolved'],'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'integrity':e['integrity'],'matchesRetainedIntegrity':True},'manifest':{'path':'package.json','bytes':len(mb),'sha256':hashlib.sha256(mb).hexdigest(),'text':mb.decode()},'entryIdentities':entries,'candidateExecution':False,'installedRuntimeIdentityProven':False}\nout=json.dumps(record);assert len(out)<14000,len(out);print(out)\n\nPY"
    },
    "sharp": {
      "schema": "p001-transformers-native-dependency-package-identities-v1",
      "recordedAt": "2026-11-06T05:14:22.085650+00:00",
      "lockRow": {
        "path": "node_modules/sharp",
        "entry": {
          "version": "0.35.5",
          "resolved": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
          "integrity": "sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==",
          "license": "Apache-2.0",
          "dependencies": {
            "@img/colour": "^1.1.0",
            "detect-libc": "^2.1.2",
            "semver": "^7.8.5"
          },
          "engines": {
            "node": ">=20.9.0"
          },
          "funding": {
            "url": "https://opencollective.com/libvips"
          },
          "optionalDependencies": {
            "@img/sharp-darwin-arm64": "0.35.5",
            "@img/sharp-darwin-x64": "0.35.5",
            "@img/sharp-freebsd-wasm32": "0.35.5",
            "@img/sharp-libvips-darwin-arm64": "1.3.4",
            "@img/sharp-libvips-darwin-x64": "1.3.4",
            "@img/sharp-libvips-linux-arm": "1.3.4",
            "@img/sharp-libvips-linux-arm64": "1.3.4",
            "@img/sharp-libvips-linux-ppc64": "1.3.4",
            "@img/sharp-libvips-linux-riscv64": "1.3.4",
            "@img/sharp-libvips-linux-s390x": "1.3.4",
            "@img/sharp-libvips-linux-x64": "1.3.4",
            "@img/sharp-libvips-linuxmusl-arm64": "1.3.4",
            "@img/sharp-libvips-linuxmusl-x64": "1.3.4",
            "@img/sharp-linux-arm": "0.35.5",
            "@img/sharp-linux-arm64": "0.35.5",
            "@img/sharp-linux-ppc64": "0.35.5",
            "@img/sharp-linux-riscv64": "0.35.5",
            "@img/sharp-linux-s390x": "0.35.5",
            "@img/sharp-linux-x64": "0.35.5",
            "@img/sharp-linuxmusl-arm64": "0.35.5",
            "@img/sharp-linuxmusl-x64": "0.35.5",
            "@img/sharp-webcontainers-wasm32": "0.35.5",
            "@img/sharp-win32-arm64": "0.35.5",
            "@img/sharp-win32-ia32": "0.35.5",
            "@img/sharp-win32-x64": "0.35.5"
          },
          "peerDependenciesMeta": {
            "@types/node": {
              "optional": true
            }
          }
        }
      },
      "acquisition": {
        "url": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
        "bytes": 214749,
        "sha256": "3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac",
        "integrity": "sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==",
        "matchesRetainedIntegrity": true
      },
      "manifest": {
        "path": "package.json",
        "bytes": 8115,
        "sha256": "ad4a2535d72eb638053a38867b1abf43c328cd1c1dbae5cf4172d498365a8b97",
        "text": "{\n  \"name\": \"sharp\",\n  \"description\": \"High performance Node.js image processing, the fastest module to resize JPEG, PNG, WebP, GIF, AVIF and TIFF images\",\n  \"version\": \"0.35.5\",\n  \"author\": \"Lovell Fuller <npm@lovell.info>\",\n  \"homepage\": \"https://sharp.pixelplumbing.com\",\n  \"contributors\": [\n    \"Pierre Inglebert <pierre.inglebert@gmail.com>\",\n    \"Jonathan Ong <jonathanrichardong@gmail.com>\",\n    \"Chanon Sajjamanochai <chanon.s@gmail.com>\",\n    \"Juliano Julio <julianojulio@gmail.com>\",\n    \"Daniel Gasienica <daniel@gasienica.ch>\",\n    \"Julian Walker <julian@fiftythree.com>\",\n    \"Amit Pitaru <pitaru.amit@gmail.com>\",\n    \"Brandon Aaron <hello.brandon@aaron.sh>\",\n    \"Andreas Lind <andreas@one.com>\",\n    \"Maurus Cuelenaere <mcuelenaere@gmail.com>\",\n    \"Linus Unnebäck <linus@folkdatorn.se>\",\n    \"Victor Mateevitsi <mvictoras@gmail.com>\",\n    \"Alaric Holloway <alaric.holloway@gmail.com>\",\n    \"Bernhard K. Weisshuhn <bkw@codingforce.com>\",\n    \"Chris Riley <criley@primedia.com>\",\n    \"David Carley <dacarley@gmail.com>\",\n    \"John Tobin <john@limelightmobileinc.com>\",\n    \"Kenton Gray <kentongray@gmail.com>\",\n    \"Felix Bünemann <Felix.Buenemann@gmail.com>\",\n    \"Samy Al Zahrani <samyalzahrany@gmail.com>\",\n    \"Chintan Thakkar <lemnisk8@gmail.com>\",\n    \"F. Orlando Galashan <frulo@gmx.de>\",\n    \"Kleis Auke Wolthuizen <info@kleisauke.nl>\",\n    \"Matt Hirsch <mhirsch@media.mit.edu>\",\n    \"Matthias Thoemmes <thoemmes@gmail.com>\",\n    \"Patrick Paskaris <patrick@paskaris.gr>\",\n    \"Jérémy Lal <kapouer@melix.org>\",\n    \"Rahul Nanwani <r.nanwani@gmail.com>\",\n    \"Alice Monday <alice0meta@gmail.com>\",\n    \"Kristo Jorgenson <kristo.jorgenson@gmail.com>\",\n    \"YvesBos <yves_bos@outlook.com>\",\n    \"Guy Maliar <guy@tailorbrands.com>\",\n    \"Nicolas Coden <nicolas@ncoden.fr>\",\n    \"Matt Parrish <matt.r.parrish@gmail.com>\",\n    \"Marcel Bretschneider <marcel.bretschneider@gmail.com>\",\n    \"Matthew McEachen <matthew+github@mceachen.org>\",\n    \"Jarda Kotěšovec <jarda.kotesovec@gmail.com>\",\n    \"Kenric D'Souza <kenric.dsouza@gmail.com>\",\n    \"Oleh Aleinyk <oleg.aleynik@gmail.com>\",\n    \"Marcel Bretschneider <marcel.bretschneider@gmail.com>\",\n    \"Andrea Bianco <andrea.bianco@unibas.ch>\",\n    \"Rik Heywood <rik@rik.org>\",\n    \"Thomas Parisot <hi@oncletom.io>\",\n    \"Nathan Graves <nathanrgraves+github@gmail.com>\",\n    \"Tom Lokhorst <tom@lokhorst.eu>\",\n    \"Espen Hovlandsdal <espen@hovlandsdal.com>\",\n    \"Sylvain Dumont <sylvain.dumont35@gmail.com>\",\n    \"Alun Davies <alun.owain.davies@googlemail.com>\",\n    \"Aidan Hoolachan <ajhoolachan21@gmail.com>\",\n    \"Axel Eirola <axel.eirola@iki.fi>\",\n    \"Freezy <freezy@xbmc.org>\",\n    \"Daiz <taneli.vatanen@gmail.com>\",\n    \"Julian Aubourg <j@ubourg.net>\",\n    \"Keith Belovay <keith@picthrive.com>\",\n    \"Michael B. Klein <mbklein@gmail.com>\",\n    \"Jordan Prudhomme <jordan@raboland.fr>\",\n    \"Ilya Ovdin <iovdin@gmail.com>\",\n    \"Andargor <andargor@yahoo.com>\",\n    \"Paul Neave <paul.neave@gmail.com>\",\n    \"Brendan Kennedy <brenwken@gmail.com>\",\n    \"Brychan Bennett-Odlum <git@brychan.io>\",\n    \"Edward Silverton <e.silverton@gmail.com>\",\n    \"Roman Malieiev <aromaleev@gmail.com>\",\n    \"Tomas Szabo <tomas.szabo@deftomat.com>\",\n    \"Robert O'Rourke <robert@o-rourke.org>\",\n    \"Guillermo Alfonso Varela Chouciño <guillevch@gmail.com>\",\n    \"Christian Flintrup <chr@gigahost.dk>\",\n    \"Manan Jadhav <manan@motionden.com>\",\n    \"Leon Radley <leon@radley.se>\",\n    \"alza54 <alza54@thiocod.in>\",\n    \"Jacob Smith <jacob@frende.me>\",\n    \"Michael Nutt <michael@nutt.im>\",\n    \"Brad Parham <baparham@gmail.com>\",\n    \"Taneli Vatanen <taneli.vatanen@gmail.com>\",\n    \"Joris Dugué <zaruike10@gmail.com>\",\n    \"Chris Banks <christopher.bradley.banks@gmail.com>\",\n    \"Ompal Singh <ompal.hitm09@gmail.com>\",\n    \"Brodan <christopher.hranj@gmail.com>\",\n    \"Ankur Parihar <ankur.github@gmail.com>\",\n    \"Brahim Ait elhaj <brahima@gmail.com>\",\n    \"Mart Jansink <m.jansink@gmail.com>\",\n    \"Lachlan Newman <lachnewman007@gmail.com>\",\n    \"Dennis Beatty <dennis@dcbeatty.com>\",\n    \"Ingvar Stepanyan <me@rreverser.com>\",\n    \"Don Denton <don@happycollision.com>\",\n    \"Dmytro Tiapukhin <cool.gegeg@gmail.com>\",\n    \"Florian Lefebvre <contact@florian-lefebvre.dev>\"\n  ],\n  \"scripts\": {\n    \"build\": \"node install/build.js\",\n    \"build:dist\": \"node scripts/build.mjs\",\n    \"clean\": \"rm -rf src/build/ test/fixtures/output.*\",\n    \"test\": \"npm run lint && npm run test-unit\",\n    \"lint\": \"npm run lint-cpp && npm run lint-js && npm run lint-types && npm run lint-publish\",\n    \"lint-cpp\": \"cpplint --quiet src/*.h src/*.cc\",\n    \"lint-js\": \"biome lint\",\n    \"lint-publish\": \"publint --strict\",\n    \"lint-types\": \"tsd --files ./test/types/sharp.test-d.{cts,mts}\",\n    \"test-leak\": \"./test/leak/leak.sh\",\n    \"test-unit\": \"node --experimental-test-coverage test/unit.mjs\",\n    \"package-from-local-build\": \"node npm/from-local-build.js\",\n    \"package-wasm-wrappers\": \"node npm/wasm-wrappers.js\",\n    \"package-release-notes\": \"node npm/release-notes.js\",\n    \"docs-build\": \"node docs/build.mjs\",\n    \"docs-serve\": \"cd docs && npm start\",\n    \"docs-publish\": \"cd docs && npm run build && npx firebase-tools deploy --project pixelplumbing --only hosting:pixelplumbing-sharp\"\n  },\n  \"type\": \"commonjs\",\n  \"files\": [\n    \"dist\",\n    \"install\",\n    \"lib/index.d.ts\",\n    \"src/*.{cc,h,gyp}\"\n  ],\n  \"main\": \"./dist/index.cjs\",\n  \"module\": \"./dist/index.mjs\",\n  \"types\": \"./dist/index.d.mts\",\n  \"exports\": {\n    \".\": {\n      \"import\": {\n        \"types\": \"./dist/index.d.mts\",\n        \"default\": \"./dist/index.mjs\"\n      },\n      \"require\": {\n        \"types\": \"./dist/index.d.cts\",\n        \"default\": \"./dist/index.cjs\"\n      }\n    }\n  },\n  \"sideEffects\": true,\n  \"repository\": {\n    \"type\": \"git\",\n    \"url\": \"git+https://github.com/lovell/sharp.git\"\n  },\n  \"keywords\": [\n    \"jpeg\",\n    \"png\",\n    \"webp\",\n    \"avif\",\n    \"tiff\",\n    \"gif\",\n    \"svg\",\n    \"jp2\",\n    \"dzi\",\n    \"image\",\n    \"resize\",\n    \"thumbnail\",\n    \"crop\",\n    \"embed\",\n    \"libvips\",\n    \"vips\"\n  ],\n  \"dependencies\": {\n    \"@img/colour\": \"^1.1.0\",\n    \"detect-libc\": \"^2.1.2\",\n    \"semver\": \"^7.8.5\"\n  },\n  \"optionalDependencies\": {\n    \"@img/sharp-darwin-arm64\": \"0.35.5\",\n    \"@img/sharp-darwin-x64\": \"0.35.5\",\n    \"@img/sharp-freebsd-wasm32\": \"0.35.5\",\n    \"@img/sharp-libvips-darwin-arm64\": \"1.3.4\",\n    \"@img/sharp-libvips-darwin-x64\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-arm\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-arm64\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-ppc64\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-riscv64\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-s390x\": \"1.3.4\",\n    \"@img/sharp-libvips-linux-x64\": \"1.3.4\",\n    \"@img/sharp-libvips-linuxmusl-arm64\": \"1.3.4\",\n    \"@img/sharp-libvips-linuxmusl-x64\": \"1.3.4\",\n    \"@img/sharp-linux-arm\": \"0.35.5\",\n    \"@img/sharp-linux-arm64\": \"0.35.5\",\n    \"@img/sharp-linux-ppc64\": \"0.35.5\",\n    \"@img/sharp-linux-riscv64\": \"0.35.5\",\n    \"@img/sharp-linux-s390x\": \"0.35.5\",\n    \"@img/sharp-linux-x64\": \"0.35.5\",\n    \"@img/sharp-linuxmusl-arm64\": \"0.35.5\",\n    \"@img/sharp-linuxmusl-x64\": \"0.35.5\",\n    \"@img/sharp-webcontainers-wasm32\": \"0.35.5\",\n    \"@img/sharp-win32-arm64\": \"0.35.5\",\n    \"@img/sharp-win32-ia32\": \"0.35.5\",\n    \"@img/sharp-win32-x64\": \"0.35.5\"\n  },\n  \"peerDependenciesMeta\": {\n    \"@types/node\": {\n      \"optional\": true\n    }\n  },\n  \"devDependencies\": {\n    \"@biomejs/biome\": \"^2.5.14\",\n    \"@cpplint/cli\": \"^0.1.0\",\n    \"@emnapi/runtime\": \"^1.11.3\",\n    \"@img/sharp-libvips-dev\": \"1.3.4\",\n    \"@img/sharp-libvips-dev-wasm32\": \"1.3.4\",\n    \"@img/sharp-libvips-win32-arm64\": \"1.3.4\",\n    \"@img/sharp-libvips-win32-ia32\": \"1.3.4\",\n    \"@img/sharp-libvips-win32-x64\": \"1.3.4\",\n    \"@types/node\": \"*\",\n    \"emnapi\": \"^1.11.3\",\n    \"exif-reader\": \"^2.0.3\",\n    \"icc\": \"^4.0.0\",\n    \"node-addon-api\": \"^8.9.2\",\n    \"node-gyp\": \"^12.4.0\",\n    \"publint\": \"^0.3.24\",\n    \"tar-fs\": \"^3.1.3\",\n    \"tsd\": \"^0.33.0\",\n    \"yauzl\": \"^3.4.0\"\n  },\n  \"license\": \"Apache-2.0\",\n  \"engines\": {\n    \"node\": \">=20.9.0\"\n  },\n  \"config\": {\n    \"libvips\": \">=8.18.7\"\n  },\n  \"funding\": {\n    \"url\": \"https://opencollective.com/libvips\"\n  }\n}\n"
      },
      "entryIdentities": [
        {
          "path": "dist/index.cjs",
          "fields": [
            "main",
            "exports...require.default"
          ],
          "bytes": 620,
          "sha256": "d69f275bc49fcd2a6188b26b35c986d4db32a1b008653fef88adb4598688232a",
          "sourceText": "/*!\n  Copyright 2013 Lovell Fuller and others.\n  SPDX-License-Identifier: Apache-2.0\n*/\n\nconst Sharp = require('./constructor.cjs');\nconst input = require('./input.cjs');\nconst resize = require('./resize.cjs');\nconst composite = require('./composite.cjs');\nconst operation = require('./operation.cjs');\nconst colour = require('./colour.cjs');\nconst channel = require('./channel.cjs');\nconst output = require('./output.cjs');\nconst utility = require('./utility.cjs');\n\ninput(Sharp);\nresize(Sharp);\ncomposite(Sharp);\noperation(Sharp);\ncolour(Sharp);\nchannel(Sharp);\noutput(Sharp);\nutility(Sharp);\n\nmodule.exports = Sharp;\n"
        },
        {
          "path": "dist/index.mjs",
          "fields": [
            "module",
            "exports...import.default"
          ],
          "bytes": 573,
          "sha256": "0e8f955c68a1b0bccf0ba5343c924dbfa6a46a76a0d491ec27fe6b328311363e",
          "sourceText": "/*!\n  Copyright 2013 Lovell Fuller and others.\n  SPDX-License-Identifier: Apache-2.0\n*/\n\nimport Sharp from './constructor.mjs';\nimport input from './input.mjs';\nimport resize from './resize.mjs';\nimport composite from './composite.mjs';\nimport operation from './operation.mjs';\nimport colour from './colour.mjs';\nimport channel from './channel.mjs';\nimport output from './output.mjs';\nimport utility from './utility.mjs';\n\ninput(Sharp);\nresize(Sharp);\ncomposite(Sharp);\noperation(Sharp);\ncolour(Sharp);\nchannel(Sharp);\noutput(Sharp);\nutility(Sharp);\n\nexport default Sharp;\n"
        },
        {
          "path": "dist/index.d.mts",
          "fields": [
            "exports...import.types"
          ],
          "bytes": 87987,
          "sha256": "b837d41bb8d39398690458f45cc445160dad36ec0db5ba0463d114e560d49d85",
          "sourceText": null
        },
        {
          "path": "dist/index.d.cts",
          "fields": [
            "exports...require.types"
          ],
          "bytes": 92885,
          "sha256": "24adc1ebbf6b05fc1434083b899b9ffd7edda0aa85ac0123d7ddb4ff860e5884",
          "sourceText": null
        }
      ],
      "candidateExecution": false,
      "installedRuntimeIdentityProven": false,
      "captureCommand": "python3 - <<'PY'\n\nimport urllib.request,tarfile,io,hashlib,base64,json,posixpath,datetime\nrow=json.loads(\"{\\\"path\\\":\\\"node_modules/sharp\\\",\\\"entry\\\":{\\\"version\\\":\\\"0.35.5\\\",\\\"resolved\\\":\\\"https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz\\\",\\\"integrity\\\":\\\"sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==\\\",\\\"license\\\":\\\"Apache-2.0\\\",\\\"dependencies\\\":{\\\"@img/colour\\\":\\\"^1.1.0\\\",\\\"detect-libc\\\":\\\"^2.1.2\\\",\\\"semver\\\":\\\"^7.8.5\\\"},\\\"engines\\\":{\\\"node\\\":\\\">=20.9.0\\\"},\\\"funding\\\":{\\\"url\\\":\\\"https://opencollective.com/libvips\\\"},\\\"optionalDependencies\\\":{\\\"@img/sharp-darwin-arm64\\\":\\\"0.35.5\\\",\\\"@img/sharp-darwin-x64\\\":\\\"0.35.5\\\",\\\"@img/sharp-freebsd-wasm32\\\":\\\"0.35.5\\\",\\\"@img/sharp-libvips-darwin-arm64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-darwin-x64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-arm\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-arm64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-ppc64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-riscv64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-s390x\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linux-x64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linuxmusl-arm64\\\":\\\"1.3.4\\\",\\\"@img/sharp-libvips-linuxmusl-x64\\\":\\\"1.3.4\\\",\\\"@img/sharp-linux-arm\\\":\\\"0.35.5\\\",\\\"@img/sharp-linux-arm64\\\":\\\"0.35.5\\\",\\\"@img/sharp-linux-ppc64\\\":\\\"0.35.5\\\",\\\"@img/sharp-linux-riscv64\\\":\\\"0.35.5\\\",\\\"@img/sharp-linux-s390x\\\":\\\"0.35.5\\\",\\\"@img/sharp-linux-x64\\\":\\\"0.35.5\\\",\\\"@img/sharp-linuxmusl-arm64\\\":\\\"0.35.5\\\",\\\"@img/sharp-linuxmusl-x64\\\":\\\"0.35.5\\\",\\\"@img/sharp-webcontainers-wasm32\\\":\\\"0.35.5\\\",\\\"@img/sharp-win32-arm64\\\":\\\"0.35.5\\\",\\\"@img/sharp-win32-ia32\\\":\\\"0.35.5\\\",\\\"@img/sharp-win32-x64\\\":\\\"0.35.5\\\"},\\\"peerDependenciesMeta\\\":{\\\"@types/node\\\":{\\\"optional\\\":true}}}}\");e=row['entry']\nb=urllib.request.urlopen(e['resolved'],timeout=20).read()\nassert 'sha512-'+base64.b64encode(hashlib.sha512(b).digest()).decode()==e['integrity']\nt=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz')\nmb=t.extractfile('package/package.json').read();m=json.loads(mb)\nassert m['version']==e['version']\ntargets=[]\ndef add(v,field):\n if isinstance(v,str) and v.startswith(('./','dist/','lib/','index.')):targets.append((field,v.removeprefix('./')))\n elif isinstance(v,dict):\n  for k,x in v.items():add(x,field+'.'+k)\n elif isinstance(v,list):\n  for i,x in enumerate(v):add(x,field+'.'+str(i))\nfor key in ['main','module','exports']:add(m.get(key),key)\nentries=[]\nfor p in dict.fromkeys(v for _,v in targets):\n f=t.extractfile('package/'+p);data=f.read()\n entries.append({'path':p,'fields':[k for k,v in targets if v==p],'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'sourceText':data.decode() if p.endswith(('.js','.mjs','.cjs')) and len(data)<5000 else None})\nrecord={'schema':'p001-transformers-native-dependency-package-identities-v1','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'lockRow':row,'acquisition':{'url':e['resolved'],'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'integrity':e['integrity'],'matchesRetainedIntegrity':True},'manifest':{'path':'package.json','bytes':len(mb),'sha256':hashlib.sha256(mb).hexdigest(),'text':mb.decode()},'entryIdentities':entries,'candidateExecution':False,'installedRuntimeIdentityProven':False}\nout=json.dumps(record);assert len(out)<14000,len(out);print(out)\n\nPY"
    },
    "packageVerification": {
      "schema": "p001-transformers-native-dependency-package-verification-v1",
      "method": "Independent Node fetch/crypto/zlib/raw tar headers against Python urllib/hashlib/tarfile; compare full manifest text and selected entry identities/text",
      "records": [
        {
          "lockPath": "node_modules/@huggingface/transformers/node_modules/onnxruntime-common",
          "archiveIntegrityMatches": true,
          "archiveSha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
          "manifestTextAndIdentityMatch": true,
          "entries": [
            {
              "path": "dist/cjs/index.js",
              "bytes": 1955,
              "sha256": "d7dd6cc9790e87299099fcd1b0ccb4969c01591d7eec0383a1c64dbea133dd1a",
              "identityMatches": true,
              "retainedSourceTextMatches": true
            },
            {
              "path": "dist/esm/index.js",
              "bytes": 1036,
              "sha256": "ad23f6d6ce2c99c449031f24a5181f259516c64a9a67428c98a8539b857729bd",
              "identityMatches": true,
              "retainedSourceTextMatches": true
            }
          ]
        },
        {
          "lockPath": "node_modules/sharp",
          "archiveIntegrityMatches": true,
          "archiveSha256": "3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac",
          "manifestTextAndIdentityMatch": true,
          "entries": [
            {
              "path": "dist/index.cjs",
              "bytes": 620,
              "sha256": "d69f275bc49fcd2a6188b26b35c986d4db32a1b008653fef88adb4598688232a",
              "identityMatches": true,
              "retainedSourceTextMatches": true
            },
            {
              "path": "dist/index.mjs",
              "bytes": 573,
              "sha256": "0e8f955c68a1b0bccf0ba5343c924dbfa6a46a76a0d491ec27fe6b328311363e",
              "identityMatches": true,
              "retainedSourceTextMatches": true
            },
            {
              "path": "dist/index.d.mts",
              "bytes": 87987,
              "sha256": "b837d41bb8d39398690458f45cc445160dad36ec0db5ba0463d114e560d49d85",
              "identityMatches": true,
              "retainedSourceTextMatches": false
            },
            {
              "path": "dist/index.d.cts",
              "bytes": 92885,
              "sha256": "24adc1ebbf6b05fc1434083b899b9ffd7edda0aa85ac0123d7ddb4ff860e5884",
              "identityMatches": true,
              "retainedSourceTextMatches": false
            }
          ]
        }
      ],
      "candidateExecution": false,
      "installedRuntimeIdentityProven": false,
      "captureCommand": "node <<'NODE'\n\nconst crypto=require('node:crypto'),zlib=require('node:zlib');\nconst expected=[{\"schema\":\"p001-transformers-native-dependency-package-identities-v1\",\"recordedAt\":\"2026-11-06T05:14:21.670778+00:00\",\"lockRow\":{\"path\":\"node_modules/@huggingface/transformers/node_modules/onnxruntime-common\",\"entry\":{\"version\":\"1.24.0-dev.20251116-b39e144322\",\"resolved\":\"https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz\",\"integrity\":\"sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw==\",\"license\":\"MIT\"}},\"acquisition\":{\"url\":\"https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz\",\"bytes\":66168,\"sha256\":\"00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f\",\"integrity\":\"sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw==\",\"matchesRetainedIntegrity\":true},\"manifest\":{\"path\":\"package.json\",\"bytes\":973,\"sha256\":\"0b2e5d9ae190f993bb898c752ca0168a97124d980fa66e77738944bc37989106\",\"text\":\"{\\n  \\\"license\\\": \\\"MIT\\\",\\n  \\\"type\\\": \\\"module\\\",\\n  \\\"name\\\": \\\"onnxruntime-common\\\",\\n  \\\"version\\\": \\\"1.24.0-dev.20251116-b39e144322\\\",\\n  \\\"repository\\\": {\\n    \\\"url\\\": \\\"https://github.com/Microsoft/onnxruntime.git\\\",\\n    \\\"type\\\": \\\"git\\\"\\n  },\\n  \\\"author\\\": \\\"fs-eire\\\",\\n  \\\"scripts\\\": {\\n    \\\"build:cjs\\\": \\\"tsc --module commonjs --moduleResolution node10 --outDir ./dist/cjs\\\",\\n    \\\"build:esm\\\": \\\"tsc\\\",\\n    \\\"build:bundles\\\": \\\"webpack\\\",\\n    \\\"build\\\": \\\"node ./build.js\\\",\\n    \\\"prepare\\\": \\\"npm run build\\\",\\n    \\\"pretest\\\": \\\"tsc --build ./test\\\",\\n    \\\"test\\\": \\\"mocha \\\\\\\"./test/**/*.js\\\\\\\" --timeout 30000\\\",\\n    \\\"test:f16\\\": \\\"mocha -n js-float16array \\\\\\\"./test/**/*.js\\\\\\\" --timeout 30000\\\"\\n  },\\n  \\\"devDependencies\\\": {\\n    \\\"globby\\\": \\\"^15.0.0\\\",\\n    \\\"typedoc\\\": \\\"^0.25.7\\\"\\n  },\\n  \\\"main\\\": \\\"dist/cjs/index.js\\\",\\n  \\\"exports\\\": {\\n    \\\"require\\\": \\\"./dist/cjs/index.js\\\",\\n    \\\"import\\\": \\\"./dist/esm/index.js\\\"\\n  },\\n  \\\"keywords\\\": [\\n    \\\"ONNX\\\",\\n    \\\"ONNXRuntime\\\",\\n    \\\"ONNX Runtime\\\"\\n  ],\\n  \\\"description\\\": \\\"ONNXRuntime JavaScript API library\\\"\\n}\\n\"},\"entryIdentities\":[{\"path\":\"dist/cjs/index.js\",\"fields\":[\"main\",\"exports.require\"],\"bytes\":1955,\"sha256\":\"d7dd6cc9790e87299099fcd1b0ccb4969c01591d7eec0383a1c64dbea133dd1a\",\"sourceText\":\"\\\"use strict\\\";\\n// Copyright (c) Microsoft Corporation. All rights reserved.\\n// Licensed under the MIT License.\\nvar __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {\\n    if (k2 === undefined) k2 = k;\\n    var desc = Object.getOwnPropertyDescriptor(m, k);\\n    if (!desc || (\\\"get\\\" in desc ? !m.__esModule : desc.writable || desc.configurable)) {\\n      desc = { enumerable: true, get: function() { return m[k]; } };\\n    }\\n    Object.defineProperty(o, k2, desc);\\n}) : (function(o, m, k, k2) {\\n    if (k2 === undefined) k2 = k;\\n    o[k2] = m[k];\\n}));\\nvar __exportStar = (this && this.__exportStar) || function(m, exports) {\\n    for (var p in m) if (p !== \\\"default\\\" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);\\n};\\nObject.defineProperty(exports, \\\"__esModule\\\", { value: true });\\n/**\\n * # ONNX Runtime JavaScript API\\n *\\n * ONNX Runtime JavaScript API is a unified API for all JavaScript usages, including the following NPM packages:\\n *\\n * - [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node)\\n * - [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web)\\n * - [onnxruntime-react-native](https://www.npmjs.com/package/onnxruntime-react-native)\\n *\\n * See also:\\n * - [Get Started](https://onnxruntime.ai/docs/get-started/with-javascript/)\\n * - [Inference examples](https://github.com/microsoft/onnxruntime-inference-examples/tree/main/js)\\n *\\n * @packageDocumentation\\n */\\n__exportStar(require(\\\"./backend.js\\\"), exports);\\n__exportStar(require(\\\"./env.js\\\"), exports);\\n__exportStar(require(\\\"./inference-session.js\\\"), exports);\\n__exportStar(require(\\\"./tensor.js\\\"), exports);\\n__exportStar(require(\\\"./tensor-conversion.js\\\"), exports);\\n__exportStar(require(\\\"./tensor-factory.js\\\"), exports);\\n__exportStar(require(\\\"./trace.js\\\"), exports);\\n__exportStar(require(\\\"./onnx-model.js\\\"), exports);\\n__exportStar(require(\\\"./onnx-value.js\\\"), exports);\\n//# sourceMappingURL=index.js.map\"},{\"path\":\"dist/esm/index.js\",\"fields\":[\"exports.import\"],\"bytes\":1036,\"sha256\":\"ad23f6d6ce2c99c449031f24a5181f259516c64a9a67428c98a8539b857729bd\",\"sourceText\":\"// Copyright (c) Microsoft Corporation. All rights reserved.\\n// Licensed under the MIT License.\\n/**\\n * # ONNX Runtime JavaScript API\\n *\\n * ONNX Runtime JavaScript API is a unified API for all JavaScript usages, including the following NPM packages:\\n *\\n * - [onnxruntime-node](https://www.npmjs.com/package/onnxruntime-node)\\n * - [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web)\\n * - [onnxruntime-react-native](https://www.npmjs.com/package/onnxruntime-react-native)\\n *\\n * See also:\\n * - [Get Started](https://onnxruntime.ai/docs/get-started/with-javascript/)\\n * - [Inference examples](https://github.com/microsoft/onnxruntime-inference-examples/tree/main/js)\\n *\\n * @packageDocumentation\\n */\\nexport * from './backend.js';\\nexport * from './env.js';\\nexport * from './inference-session.js';\\nexport * from './tensor.js';\\nexport * from './tensor-conversion.js';\\nexport * from './tensor-factory.js';\\nexport * from './trace.js';\\nexport * from './onnx-model.js';\\nexport * from './onnx-value.js';\\n//# sourceMappingURL=index.js.map\"}],\"candidateExecution\":false,\"installedRuntimeIdentityProven\":false},{\"schema\":\"p001-transformers-native-dependency-package-identities-v1\",\"recordedAt\":\"2026-11-06T05:14:22.085650+00:00\",\"lockRow\":{\"path\":\"node_modules/sharp\",\"entry\":{\"version\":\"0.35.5\",\"resolved\":\"https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz\",\"integrity\":\"sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==\",\"license\":\"Apache-2.0\",\"dependencies\":{\"@img/colour\":\"^1.1.0\",\"detect-libc\":\"^2.1.2\",\"semver\":\"^7.8.5\"},\"engines\":{\"node\":\">=20.9.0\"},\"funding\":{\"url\":\"https://opencollective.com/libvips\"},\"optionalDependencies\":{\"@img/sharp-darwin-arm64\":\"0.35.5\",\"@img/sharp-darwin-x64\":\"0.35.5\",\"@img/sharp-freebsd-wasm32\":\"0.35.5\",\"@img/sharp-libvips-darwin-arm64\":\"1.3.4\",\"@img/sharp-libvips-darwin-x64\":\"1.3.4\",\"@img/sharp-libvips-linux-arm\":\"1.3.4\",\"@img/sharp-libvips-linux-arm64\":\"1.3.4\",\"@img/sharp-libvips-linux-ppc64\":\"1.3.4\",\"@img/sharp-libvips-linux-riscv64\":\"1.3.4\",\"@img/sharp-libvips-linux-s390x\":\"1.3.4\",\"@img/sharp-libvips-linux-x64\":\"1.3.4\",\"@img/sharp-libvips-linuxmusl-arm64\":\"1.3.4\",\"@img/sharp-libvips-linuxmusl-x64\":\"1.3.4\",\"@img/sharp-linux-arm\":\"0.35.5\",\"@img/sharp-linux-arm64\":\"0.35.5\",\"@img/sharp-linux-ppc64\":\"0.35.5\",\"@img/sharp-linux-riscv64\":\"0.35.5\",\"@img/sharp-linux-s390x\":\"0.35.5\",\"@img/sharp-linux-x64\":\"0.35.5\",\"@img/sharp-linuxmusl-arm64\":\"0.35.5\",\"@img/sharp-linuxmusl-x64\":\"0.35.5\",\"@img/sharp-webcontainers-wasm32\":\"0.35.5\",\"@img/sharp-win32-arm64\":\"0.35.5\",\"@img/sharp-win32-ia32\":\"0.35.5\",\"@img/sharp-win32-x64\":\"0.35.5\"},\"peerDependenciesMeta\":{\"@types/node\":{\"optional\":true}}}},\"acquisition\":{\"url\":\"https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz\",\"bytes\":214749,\"sha256\":\"3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac\",\"integrity\":\"sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==\",\"matchesRetainedIntegrity\":true},\"manifest\":{\"path\":\"package.json\",\"bytes\":8115,\"sha256\":\"ad4a2535d72eb638053a38867b1abf43c328cd1c1dbae5cf4172d498365a8b97\",\"text\":\"{\\n  \\\"name\\\": \\\"sharp\\\",\\n  \\\"description\\\": \\\"High performance Node.js image processing, the fastest module to resize JPEG, PNG, WebP, GIF, AVIF and TIFF images\\\",\\n  \\\"version\\\": \\\"0.35.5\\\",\\n  \\\"author\\\": \\\"Lovell Fuller <npm@lovell.info>\\\",\\n  \\\"homepage\\\": \\\"https://sharp.pixelplumbing.com\\\",\\n  \\\"contributors\\\": [\\n    \\\"Pierre Inglebert <pierre.inglebert@gmail.com>\\\",\\n    \\\"Jonathan Ong <jonathanrichardong@gmail.com>\\\",\\n    \\\"Chanon Sajjamanochai <chanon.s@gmail.com>\\\",\\n    \\\"Juliano Julio <julianojulio@gmail.com>\\\",\\n    \\\"Daniel Gasienica <daniel@gasienica.ch>\\\",\\n    \\\"Julian Walker <julian@fiftythree.com>\\\",\\n    \\\"Amit Pitaru <pitaru.amit@gmail.com>\\\",\\n    \\\"Brandon Aaron <hello.brandon@aaron.sh>\\\",\\n    \\\"Andreas Lind <andreas@one.com>\\\",\\n    \\\"Maurus Cuelenaere <mcuelenaere@gmail.com>\\\",\\n    \\\"Linus Unnebäck <linus@folkdatorn.se>\\\",\\n    \\\"Victor Mateevitsi <mvictoras@gmail.com>\\\",\\n    \\\"Alaric Holloway <alaric.holloway@gmail.com>\\\",\\n    \\\"Bernhard K. Weisshuhn <bkw@codingforce.com>\\\",\\n    \\\"Chris Riley <criley@primedia.com>\\\",\\n    \\\"David Carley <dacarley@gmail.com>\\\",\\n    \\\"John Tobin <john@limelightmobileinc.com>\\\",\\n    \\\"Kenton Gray <kentongray@gmail.com>\\\",\\n    \\\"Felix Bünemann <Felix.Buenemann@gmail.com>\\\",\\n    \\\"Samy Al Zahrani <samyalzahrany@gmail.com>\\\",\\n    \\\"Chintan Thakkar <lemnisk8@gmail.com>\\\",\\n    \\\"F. Orlando Galashan <frulo@gmx.de>\\\",\\n    \\\"Kleis Auke Wolthuizen <info@kleisauke.nl>\\\",\\n    \\\"Matt Hirsch <mhirsch@media.mit.edu>\\\",\\n    \\\"Matthias Thoemmes <thoemmes@gmail.com>\\\",\\n    \\\"Patrick Paskaris <patrick@paskaris.gr>\\\",\\n    \\\"Jérémy Lal <kapouer@melix.org>\\\",\\n    \\\"Rahul Nanwani <r.nanwani@gmail.com>\\\",\\n    \\\"Alice Monday <alice0meta@gmail.com>\\\",\\n    \\\"Kristo Jorgenson <kristo.jorgenson@gmail.com>\\\",\\n    \\\"YvesBos <yves_bos@outlook.com>\\\",\\n    \\\"Guy Maliar <guy@tailorbrands.com>\\\",\\n    \\\"Nicolas Coden <nicolas@ncoden.fr>\\\",\\n    \\\"Matt Parrish <matt.r.parrish@gmail.com>\\\",\\n    \\\"Marcel Bretschneider <marcel.bretschneider@gmail.com>\\\",\\n    \\\"Matthew McEachen <matthew+github@mceachen.org>\\\",\\n    \\\"Jarda Kotěšovec <jarda.kotesovec@gmail.com>\\\",\\n    \\\"Kenric D'Souza <kenric.dsouza@gmail.com>\\\",\\n    \\\"Oleh Aleinyk <oleg.aleynik@gmail.com>\\\",\\n    \\\"Marcel Bretschneider <marcel.bretschneider@gmail.com>\\\",\\n    \\\"Andrea Bianco <andrea.bianco@unibas.ch>\\\",\\n    \\\"Rik Heywood <rik@rik.org>\\\",\\n    \\\"Thomas Parisot <hi@oncletom.io>\\\",\\n    \\\"Nathan Graves <nathanrgraves+github@gmail.com>\\\",\\n    \\\"Tom Lokhorst <tom@lokhorst.eu>\\\",\\n    \\\"Espen Hovlandsdal <espen@hovlandsdal.com>\\\",\\n    \\\"Sylvain Dumont <sylvain.dumont35@gmail.com>\\\",\\n    \\\"Alun Davies <alun.owain.davies@googlemail.com>\\\",\\n    \\\"Aidan Hoolachan <ajhoolachan21@gmail.com>\\\",\\n    \\\"Axel Eirola <axel.eirola@iki.fi>\\\",\\n    \\\"Freezy <freezy@xbmc.org>\\\",\\n    \\\"Daiz <taneli.vatanen@gmail.com>\\\",\\n    \\\"Julian Aubourg <j@ubourg.net>\\\",\\n    \\\"Keith Belovay <keith@picthrive.com>\\\",\\n    \\\"Michael B. Klein <mbklein@gmail.com>\\\",\\n    \\\"Jordan Prudhomme <jordan@raboland.fr>\\\",\\n    \\\"Ilya Ovdin <iovdin@gmail.com>\\\",\\n    \\\"Andargor <andargor@yahoo.com>\\\",\\n    \\\"Paul Neave <paul.neave@gmail.com>\\\",\\n    \\\"Brendan Kennedy <brenwken@gmail.com>\\\",\\n    \\\"Brychan Bennett-Odlum <git@brychan.io>\\\",\\n    \\\"Edward Silverton <e.silverton@gmail.com>\\\",\\n    \\\"Roman Malieiev <aromaleev@gmail.com>\\\",\\n    \\\"Tomas Szabo <tomas.szabo@deftomat.com>\\\",\\n    \\\"Robert O'Rourke <robert@o-rourke.org>\\\",\\n    \\\"Guillermo Alfonso Varela Chouciño <guillevch@gmail.com>\\\",\\n    \\\"Christian Flintrup <chr@gigahost.dk>\\\",\\n    \\\"Manan Jadhav <manan@motionden.com>\\\",\\n    \\\"Leon Radley <leon@radley.se>\\\",\\n    \\\"alza54 <alza54@thiocod.in>\\\",\\n    \\\"Jacob Smith <jacob@frende.me>\\\",\\n    \\\"Michael Nutt <michael@nutt.im>\\\",\\n    \\\"Brad Parham <baparham@gmail.com>\\\",\\n    \\\"Taneli Vatanen <taneli.vatanen@gmail.com>\\\",\\n    \\\"Joris Dugué <zaruike10@gmail.com>\\\",\\n    \\\"Chris Banks <christopher.bradley.banks@gmail.com>\\\",\\n    \\\"Ompal Singh <ompal.hitm09@gmail.com>\\\",\\n    \\\"Brodan <christopher.hranj@gmail.com>\\\",\\n    \\\"Ankur Parihar <ankur.github@gmail.com>\\\",\\n    \\\"Brahim Ait elhaj <brahima@gmail.com>\\\",\\n    \\\"Mart Jansink <m.jansink@gmail.com>\\\",\\n    \\\"Lachlan Newman <lachnewman007@gmail.com>\\\",\\n    \\\"Dennis Beatty <dennis@dcbeatty.com>\\\",\\n    \\\"Ingvar Stepanyan <me@rreverser.com>\\\",\\n    \\\"Don Denton <don@happycollision.com>\\\",\\n    \\\"Dmytro Tiapukhin <cool.gegeg@gmail.com>\\\",\\n    \\\"Florian Lefebvre <contact@florian-lefebvre.dev>\\\"\\n  ],\\n  \\\"scripts\\\": {\\n    \\\"build\\\": \\\"node install/build.js\\\",\\n    \\\"build:dist\\\": \\\"node scripts/build.mjs\\\",\\n    \\\"clean\\\": \\\"rm -rf src/build/ test/fixtures/output.*\\\",\\n    \\\"test\\\": \\\"npm run lint && npm run test-unit\\\",\\n    \\\"lint\\\": \\\"npm run lint-cpp && npm run lint-js && npm run lint-types && npm run lint-publish\\\",\\n    \\\"lint-cpp\\\": \\\"cpplint --quiet src/*.h src/*.cc\\\",\\n    \\\"lint-js\\\": \\\"biome lint\\\",\\n    \\\"lint-publish\\\": \\\"publint --strict\\\",\\n    \\\"lint-types\\\": \\\"tsd --files ./test/types/sharp.test-d.{cts,mts}\\\",\\n    \\\"test-leak\\\": \\\"./test/leak/leak.sh\\\",\\n    \\\"test-unit\\\": \\\"node --experimental-test-coverage test/unit.mjs\\\",\\n    \\\"package-from-local-build\\\": \\\"node npm/from-local-build.js\\\",\\n    \\\"package-wasm-wrappers\\\": \\\"node npm/wasm-wrappers.js\\\",\\n    \\\"package-release-notes\\\": \\\"node npm/release-notes.js\\\",\\n    \\\"docs-build\\\": \\\"node docs/build.mjs\\\",\\n    \\\"docs-serve\\\": \\\"cd docs && npm start\\\",\\n    \\\"docs-publish\\\": \\\"cd docs && npm run build && npx firebase-tools deploy --project pixelplumbing --only hosting:pixelplumbing-sharp\\\"\\n  },\\n  \\\"type\\\": \\\"commonjs\\\",\\n  \\\"files\\\": [\\n    \\\"dist\\\",\\n    \\\"install\\\",\\n    \\\"lib/index.d.ts\\\",\\n    \\\"src/*.{cc,h,gyp}\\\"\\n  ],\\n  \\\"main\\\": \\\"./dist/index.cjs\\\",\\n  \\\"module\\\": \\\"./dist/index.mjs\\\",\\n  \\\"types\\\": \\\"./dist/index.d.mts\\\",\\n  \\\"exports\\\": {\\n    \\\".\\\": {\\n      \\\"import\\\": {\\n        \\\"types\\\": \\\"./dist/index.d.mts\\\",\\n        \\\"default\\\": \\\"./dist/index.mjs\\\"\\n      },\\n      \\\"require\\\": {\\n        \\\"types\\\": \\\"./dist/index.d.cts\\\",\\n        \\\"default\\\": \\\"./dist/index.cjs\\\"\\n      }\\n    }\\n  },\\n  \\\"sideEffects\\\": true,\\n  \\\"repository\\\": {\\n    \\\"type\\\": \\\"git\\\",\\n    \\\"url\\\": \\\"git+https://github.com/lovell/sharp.git\\\"\\n  },\\n  \\\"keywords\\\": [\\n    \\\"jpeg\\\",\\n    \\\"png\\\",\\n    \\\"webp\\\",\\n    \\\"avif\\\",\\n    \\\"tiff\\\",\\n    \\\"gif\\\",\\n    \\\"svg\\\",\\n    \\\"jp2\\\",\\n    \\\"dzi\\\",\\n    \\\"image\\\",\\n    \\\"resize\\\",\\n    \\\"thumbnail\\\",\\n    \\\"crop\\\",\\n    \\\"embed\\\",\\n    \\\"libvips\\\",\\n    \\\"vips\\\"\\n  ],\\n  \\\"dependencies\\\": {\\n    \\\"@img/colour\\\": \\\"^1.1.0\\\",\\n    \\\"detect-libc\\\": \\\"^2.1.2\\\",\\n    \\\"semver\\\": \\\"^7.8.5\\\"\\n  },\\n  \\\"optionalDependencies\\\": {\\n    \\\"@img/sharp-darwin-arm64\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-darwin-x64\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-freebsd-wasm32\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-libvips-darwin-arm64\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-darwin-x64\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-linux-arm\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-linux-arm64\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-linux-ppc64\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-linux-riscv64\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-linux-s390x\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-linux-x64\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-linuxmusl-arm64\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-linuxmusl-x64\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-linux-arm\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-linux-arm64\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-linux-ppc64\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-linux-riscv64\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-linux-s390x\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-linux-x64\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-linuxmusl-arm64\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-linuxmusl-x64\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-webcontainers-wasm32\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-win32-arm64\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-win32-ia32\\\": \\\"0.35.5\\\",\\n    \\\"@img/sharp-win32-x64\\\": \\\"0.35.5\\\"\\n  },\\n  \\\"peerDependenciesMeta\\\": {\\n    \\\"@types/node\\\": {\\n      \\\"optional\\\": true\\n    }\\n  },\\n  \\\"devDependencies\\\": {\\n    \\\"@biomejs/biome\\\": \\\"^2.5.14\\\",\\n    \\\"@cpplint/cli\\\": \\\"^0.1.0\\\",\\n    \\\"@emnapi/runtime\\\": \\\"^1.11.3\\\",\\n    \\\"@img/sharp-libvips-dev\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-dev-wasm32\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-win32-arm64\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-win32-ia32\\\": \\\"1.3.4\\\",\\n    \\\"@img/sharp-libvips-win32-x64\\\": \\\"1.3.4\\\",\\n    \\\"@types/node\\\": \\\"*\\\",\\n    \\\"emnapi\\\": \\\"^1.11.3\\\",\\n    \\\"exif-reader\\\": \\\"^2.0.3\\\",\\n    \\\"icc\\\": \\\"^4.0.0\\\",\\n    \\\"node-addon-api\\\": \\\"^8.9.2\\\",\\n    \\\"node-gyp\\\": \\\"^12.4.0\\\",\\n    \\\"publint\\\": \\\"^0.3.24\\\",\\n    \\\"tar-fs\\\": \\\"^3.1.3\\\",\\n    \\\"tsd\\\": \\\"^0.33.0\\\",\\n    \\\"yauzl\\\": \\\"^3.4.0\\\"\\n  },\\n  \\\"license\\\": \\\"Apache-2.0\\\",\\n  \\\"engines\\\": {\\n    \\\"node\\\": \\\">=20.9.0\\\"\\n  },\\n  \\\"config\\\": {\\n    \\\"libvips\\\": \\\">=8.18.7\\\"\\n  },\\n  \\\"funding\\\": {\\n    \\\"url\\\": \\\"https://opencollective.com/libvips\\\"\\n  }\\n}\\n\"},\"entryIdentities\":[{\"path\":\"dist/index.cjs\",\"fields\":[\"main\",\"exports...require.default\"],\"bytes\":620,\"sha256\":\"d69f275bc49fcd2a6188b26b35c986d4db32a1b008653fef88adb4598688232a\",\"sourceText\":\"/*!\\n  Copyright 2013 Lovell Fuller and others.\\n  SPDX-License-Identifier: Apache-2.0\\n*/\\n\\nconst Sharp = require('./constructor.cjs');\\nconst input = require('./input.cjs');\\nconst resize = require('./resize.cjs');\\nconst composite = require('./composite.cjs');\\nconst operation = require('./operation.cjs');\\nconst colour = require('./colour.cjs');\\nconst channel = require('./channel.cjs');\\nconst output = require('./output.cjs');\\nconst utility = require('./utility.cjs');\\n\\ninput(Sharp);\\nresize(Sharp);\\ncomposite(Sharp);\\noperation(Sharp);\\ncolour(Sharp);\\nchannel(Sharp);\\noutput(Sharp);\\nutility(Sharp);\\n\\nmodule.exports = Sharp;\\n\"},{\"path\":\"dist/index.mjs\",\"fields\":[\"module\",\"exports...import.default\"],\"bytes\":573,\"sha256\":\"0e8f955c68a1b0bccf0ba5343c924dbfa6a46a76a0d491ec27fe6b328311363e\",\"sourceText\":\"/*!\\n  Copyright 2013 Lovell Fuller and others.\\n  SPDX-License-Identifier: Apache-2.0\\n*/\\n\\nimport Sharp from './constructor.mjs';\\nimport input from './input.mjs';\\nimport resize from './resize.mjs';\\nimport composite from './composite.mjs';\\nimport operation from './operation.mjs';\\nimport colour from './colour.mjs';\\nimport channel from './channel.mjs';\\nimport output from './output.mjs';\\nimport utility from './utility.mjs';\\n\\ninput(Sharp);\\nresize(Sharp);\\ncomposite(Sharp);\\noperation(Sharp);\\ncolour(Sharp);\\nchannel(Sharp);\\noutput(Sharp);\\nutility(Sharp);\\n\\nexport default Sharp;\\n\"},{\"path\":\"dist/index.d.mts\",\"fields\":[\"exports...import.types\"],\"bytes\":87987,\"sha256\":\"b837d41bb8d39398690458f45cc445160dad36ec0db5ba0463d114e560d49d85\",\"sourceText\":null},{\"path\":\"dist/index.d.cts\",\"fields\":[\"exports...require.types\"],\"bytes\":92885,\"sha256\":\"24adc1ebbf6b05fc1434083b899b9ffd7edda0aa85ac0123d7ddb4ff860e5884\",\"sourceText\":null}],\"candidateExecution\":false,\"installedRuntimeIdentityProven\":false}];\n(async()=>{\nconst out=[];\nfor(const e of expected){\n const archive=Buffer.from(await(await fetch(e.acquisition.url)).arrayBuffer());\n const integrity='sha512-'+crypto.createHash('sha512').update(archive).digest('base64');\n if(integrity!==e.acquisition.integrity||archive.length!==e.acquisition.bytes||crypto.createHash('sha256').update(archive).digest('hex')!==e.acquisition.sha256)throw Error('archive mismatch');\n const tar=zlib.gunzipSync(archive),files=new Map();\n for(let off=0;off+512<=tar.length;){const h=tar.subarray(off,off+512);if(h.every(x=>x===0))break;let name=h.subarray(0,100).toString().replace(/\\0.*$/s,''),prefix=h.subarray(345,500).toString().replace(/\\0.*$/s,'');if(prefix)name=prefix+'/'+name;const size=parseInt(h.subarray(124,136).toString().replace(/\\0.*$/s,'').trim(),8)||0;files.set(name,tar.subarray(off+512,off+512+size));off+=512+Math.ceil(size/512)*512;}\n const m=files.get('package/package.json');if(m.length!==e.manifest.bytes||crypto.createHash('sha256').update(m).digest('hex')!==e.manifest.sha256||m.toString()!==e.manifest.text)throw Error('manifest mismatch');\n const entries=[];for(const f of e.entryIdentities){const b=files.get('package/'+f.path);if(!b||b.length!==f.bytes||crypto.createHash('sha256').update(b).digest('hex')!==f.sha256||(f.sourceText!==null&&b.toString()!==f.sourceText))throw Error('entry mismatch '+f.path);entries.push({path:f.path,bytes:b.length,sha256:f.sha256,identityMatches:true,retainedSourceTextMatches:f.sourceText!==null})}\n out.push({lockPath:e.lockRow.path,archiveIntegrityMatches:true,archiveSha256:e.acquisition.sha256,manifestTextAndIdentityMatch:true,entries});\n}\nprocess.stdout.write(JSON.stringify({schema:'p001-transformers-native-dependency-package-verification-v1',method:'Independent Node fetch/crypto/zlib/raw tar headers against Python urllib/hashlib/tarfile; compare full manifest text and selected entry identities/text',records:out,candidateExecution:false,installedRuntimeIdentityProven:false}));\n})().catch(e=>{console.error(e);process.exitCode=1});\n\nNODE"
    }
  },
  "sourceFindings": [
    {
      "source": "Retained package-lock.json@42d905b5b2fcbea2bb651178a7ff3c905cf89626; new named-row extraction only",
      "finding": "Two pinned rows are available: node_modules/sharp@0.35.5 and node_modules/@huggingface/transformers/node_modules/onnxruntime-common@1.24.0-dev.20251116-b39e144322. Root onnxruntime-common@1.24.3 and the onnxruntime-web nested common@1.24.1 rows have no resolved/integrity. The earlier onnxruntime-node historical artifact gap is preserved."
    },
    {
      "source": "Pinned package archives; independent Python versus Node acquisition/readers",
      "finding": "Full manifest text, retained SHA512, archive SHA256/bytes and selected main/import/require/types entry identities match between independent Python urllib/hashlib/tarfile and Node fetch/crypto/zlib/raw tar reads. This establishes public package source identities matching named lock rows only, not installed resolution, native binaries, dependency traversal or distribution custody."
    },
    {
      "source": "Sharp 0.35.5 dist/index.cjs and dist/index.mjs",
      "finding": "Both small entries eagerly import/require constructor, input, resize, composite, operation, colour, channel, output and utility modules, then invoke eight setup functions with Sharp. Native effects and the transitive loader are not established by these entry-only reads. Sharp 0.35.5 is the retained root lock row; the Transformers declaration ^0.34.5 does not itself establish actual installed resolver behavior."
    },
    {
      "source": "Pinned nested ONNX Common dist/esm/index.js; full CJS source retained separately",
      "finding": "The ESM entry reexports backend, env, inference-session, tensor, tensor-conversion, tensor-factory, trace, onnx-model and onnx-value. Those modules need their own source/effect review. A nested lock location is a resolution lead; actual loaded module identity remains unproven."
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
    "Complete configured occurrence, handler/effect/entry/loader/native/distribution/observed-route populations and immutable independent applicability.",
    "Exact loaded artifact and native dependency provenance, including retained ONNX 1.24.3 lock row without resolved/integrity.",
    "Qualify runtime effects, global/backend/cache/callback/URL/model configuration and supported platforms after the source identity and applicability prerequisites."
  ],
  "applicabilityCommitted": false,
  "populationComplete": false,
  "closureAccepted": false,
  "executionAdmitted": false,
  "qualificationExecuted": false,
  "nextNamedSourceUnit": {
    "package": {
      "url": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
      "bytes": 214749,
      "sha256": "3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac",
      "integrity": "sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==",
      "matchesRetainedIntegrity": true
    },
    "version": "0.35.5",
    "entrySources": [
      "dist/index.cjs",
      "dist/index.mjs"
    ],
    "files": [
      "dist/constructor.cjs",
      "dist/constructor.mjs"
    ],
    "instruction": "Read constructor sources from the exact Sharp0.35.5 archive, record module-edge/native-binding loader identities statically, then follow only the named actual loader. Preserve root/nested ONNX unpinned historical artifact gaps and all configured/runtime/native/distribution obligations. Reuse prior checksums/evidence; no target execution or test/source replay.",
    "followingOnnxCommon": {
      "package": {
        "url": "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz",
        "bytes": 66168,
        "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
        "integrity": "sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw==",
        "matchesRetainedIntegrity": true
      },
      "version": "1.24.0-dev.20251116-b39e144322",
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
      ]
    }
  }
}
