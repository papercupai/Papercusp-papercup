---
rel_path: "security/p001-transformers-onnx-common-package-identities-20261106-v1.json"
updated_at: 1793942061719
_body: "content"
---

{
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
}
