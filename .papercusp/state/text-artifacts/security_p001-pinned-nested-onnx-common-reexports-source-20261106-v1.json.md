---
rel_path: "security/p001-pinned-nested-onnx-common-reexports-source-20261106-v1.json"
updated_at: 1793943082184
_body: "content"
---

{
  "schema": "p001-pinned-nested-onnx-common-reexport-source-extraction-v1",
  "recordedAt": "2026-11-06T05:31:22.079707+00:00",
  "archive": {
    "url": "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz",
    "bytes": 66168,
    "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
    "retainedIntegrityMatched": true
  },
  "records": [
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
  "targetExecuted": false,
  "installedRuntimeIdentityProven": false,
  "captureCommand": "python3 - <<'PY'\nimport urllib.request,tarfile,io,hashlib,base64,json,datetime\nb=urllib.request.urlopen('https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz',timeout=20).read()\nassert len(b)==66168\nassert hashlib.sha256(b).hexdigest()=='00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f'\nassert 'sha512-'+base64.b64encode(hashlib.sha512(b).digest()).decode()=='sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw=='\nt=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz')\nrecords=[]\nfor p in [\"dist/esm/backend.js\",\"dist/esm/env.js\",\"dist/esm/inference-session.js\",\"dist/esm/tensor.js\",\"dist/esm/tensor-conversion.js\",\"dist/esm/tensor-factory.js\",\"dist/esm/trace.js\",\"dist/esm/onnx-model.js\",\"dist/esm/onnx-value.js\"]:\n d=t.extractfile('package/'+p).read()\n records.append({'path':p,'bytes':len(d),'sha256':hashlib.sha256(d).hexdigest(),'sourceText':d.decode()})\nprint(json.dumps({'schema':'p001-pinned-nested-onnx-common-reexport-source-extraction-v1','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive':{'url':'https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz','bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'retainedIntegrityMatched':True},'records':records,'targetExecuted':False,'installedRuntimeIdentityProven':False}))\nPY"
}
