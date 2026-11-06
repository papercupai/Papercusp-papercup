---
rel_path: "security/p001-pinned-nested-onnx-common-implementation-preparation-20261106-v1.json"
updated_at: 1793944803215
_body: "content"
---

{
  "schema": "p001-pinned-nested-onnx-common-implementation-preparation-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "currentWorkItem": "WI-6554700010045753",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "recordedAt": "2026-11-06T06:00:03.191Z",
  "status": "named-pinned-implementation-source-only-unqualified",
  "sources": {
    "priorCanonical": "security/p001-native-distribution-source-classification-20261106-nested-onnx-common-reexports-v23.json",
    "source": "security/p001-pinned-nested-onnx-common-implementation-source-20261106-v1.json",
    "verification": "security/p001-pinned-nested-onnx-common-implementation-ast-verification-20261106-v1.json"
  },
  "archive": {
    "url": "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz",
    "bytes": 66168,
    "sha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
    "retainedIntegrityMatched": true
  },
  "verification": {
    "method": "Independent Python urllib/hashlib/tarfile source extraction and Node fetch/crypto/zlib archive reader plus TypeScript AST; Python independently checked line/column and source text spans.",
    "checks": [
      {
        "path": "dist/esm/backend-impl.js",
        "sha256": "97dd81b055a06f61120f09468fe59f046a9262b7b87bf5d05bceb085bf4f5558",
        "bytes": 5339,
        "moduleEdgeCount": 0,
        "callOrConstructorCount": 26,
        "topLevelCallOrConstructorCount": 1,
        "independentSourceAndSpanMatches": true
      },
      {
        "path": "dist/esm/env-impl.js",
        "sha256": "0da4c562a49fe147e19320a64cbb456184eb0e6242b1fe69c65c8368c55f3d97",
        "bytes": 848,
        "moduleEdgeCount": 1,
        "callOrConstructorCount": 3,
        "topLevelCallOrConstructorCount": 1,
        "independentSourceAndSpanMatches": true
      },
      {
        "path": "dist/esm/inference-session-impl.js",
        "sha256": "0446814a392c147b5c38ba242d9911ee54002b5d01a8e19fb4895fb8f8a0cdd3",
        "bytes": 8703,
        "moduleEdgeCount": 3,
        "callOrConstructorCount": 45,
        "topLevelCallOrConstructorCount": 0,
        "independentSourceAndSpanMatches": true
      },
      {
        "path": "dist/esm/tensor-impl.js",
        "sha256": "6a749be63055f9d21069566b1515412484a3a03448ca20427c8f8d29328a2843",
        "bytes": 16091,
        "moduleEdgeCount": 4,
        "callOrConstructorCount": 59,
        "topLevelCallOrConstructorCount": 0,
        "independentSourceAndSpanMatches": true
      }
    ]
  },
  "sourceModules": [
    {
      "path": "dist/esm/backend-impl.js",
      "bytes": 5339,
      "sha256": "97dd81b055a06f61120f09468fe59f046a9262b7b87bf5d05bceb085bf4f5558",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nconst backends = new Map();\nconst backendsSortedByPriority = [];\n/**\n * Register a backend.\n *\n * @param name - the name as a key to lookup as an execution provider.\n * @param backend - the backend object.\n * @param priority - an integer indicating the priority of the backend. Higher number means higher priority. if priority\n * < 0, it will be considered as a 'beta' version and will not be used as a fallback backend by default.\n *\n * @ignore\n */\nexport const registerBackend = (name, backend, priority) => {\n    if (backend && typeof backend.init === 'function' && typeof backend.createInferenceSessionHandler === 'function') {\n        const currentBackend = backends.get(name);\n        if (currentBackend === undefined) {\n            backends.set(name, { backend, priority });\n        }\n        else if (currentBackend.priority > priority) {\n            // same name is already registered with a higher priority. skip registeration.\n            return;\n        }\n        else if (currentBackend.priority === priority) {\n            if (currentBackend.backend !== backend) {\n                throw new Error(`cannot register backend \"${name}\" using priority ${priority}`);\n            }\n        }\n        if (priority >= 0) {\n            const i = backendsSortedByPriority.indexOf(name);\n            if (i !== -1) {\n                backendsSortedByPriority.splice(i, 1);\n            }\n            for (let i = 0; i < backendsSortedByPriority.length; i++) {\n                if (backends.get(backendsSortedByPriority[i]).priority <= priority) {\n                    backendsSortedByPriority.splice(i, 0, name);\n                    return;\n                }\n            }\n            backendsSortedByPriority.push(name);\n        }\n        return;\n    }\n    throw new TypeError('not a valid backend');\n};\n/**\n * Try to resolve and initialize a backend.\n *\n * @param backendName - the name of the backend.\n * @returns the backend instance if resolved and initialized successfully, or an error message if failed.\n */\nconst tryResolveAndInitializeBackend = async (backendName) => {\n    const backendInfo = backends.get(backendName);\n    if (!backendInfo) {\n        return 'backend not found.';\n    }\n    if (backendInfo.initialized) {\n        return backendInfo.backend;\n    }\n    else if (backendInfo.aborted) {\n        return backendInfo.error;\n    }\n    else {\n        const isInitializing = !!backendInfo.initPromise;\n        try {\n            if (!isInitializing) {\n                backendInfo.initPromise = backendInfo.backend.init(backendName);\n            }\n            await backendInfo.initPromise;\n            backendInfo.initialized = true;\n            return backendInfo.backend;\n        }\n        catch (e) {\n            if (!isInitializing) {\n                backendInfo.error = `${e}`;\n                backendInfo.aborted = true;\n            }\n            return backendInfo.error;\n        }\n        finally {\n            delete backendInfo.initPromise;\n        }\n    }\n};\n/**\n * Resolve execution providers from the specific session options.\n *\n * @param options - the session options object.\n * @returns a promise that resolves to a tuple of an initialized backend instance and a session options object with\n * filtered EP list.\n *\n * @ignore\n */\nexport const resolveBackendAndExecutionProviders = async (options) => {\n    // extract backend hints from session options\n    const eps = options.executionProviders || [];\n    const backendHints = eps.map((i) => (typeof i === 'string' ? i : i.name));\n    const backendNames = backendHints.length === 0 ? backendsSortedByPriority : backendHints;\n    // try to resolve and initialize all requested backends\n    let backend;\n    const errors = [];\n    const availableBackendNames = new Set();\n    for (const backendName of backendNames) {\n        const resolveResult = await tryResolveAndInitializeBackend(backendName);\n        if (typeof resolveResult === 'string') {\n            errors.push({ name: backendName, err: resolveResult });\n        }\n        else {\n            if (!backend) {\n                backend = resolveResult;\n            }\n            if (backend === resolveResult) {\n                availableBackendNames.add(backendName);\n            }\n        }\n    }\n    // if no backend is available, throw error.\n    if (!backend) {\n        throw new Error(`no available backend found. ERR: ${errors.map((e) => `[${e.name}] ${e.err}`).join(', ')}`);\n    }\n    // for each explicitly requested backend, if it's not available, output warning message.\n    for (const { name, err } of errors) {\n        if (backendHints.includes(name)) {\n            // eslint-disable-next-line no-console\n            console.warn(`removing requested execution provider \"${name}\" from session options because it is not available: ${err}`);\n        }\n    }\n    const filteredEps = eps.filter((i) => availableBackendNames.has(typeof i === 'string' ? i : i.name));\n    return [\n        backend,\n        new Proxy(options, {\n            get: (target, prop) => {\n                if (prop === 'executionProviders') {\n                    return filteredEps;\n                }\n                return Reflect.get(target, prop);\n            },\n        }),\n    ];\n};\n//# sourceMappingURL=backend-impl.js.map"
    },
    {
      "path": "dist/esm/env-impl.js",
      "bytes": 848,
      "sha256": "0da4c562a49fe147e19320a64cbb456184eb0e6242b1fe69c65c8368c55f3d97",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nimport { version } from './version.js';\nlet logLevelValue = 'warning';\nexport const env = {\n    wasm: {},\n    webgl: {},\n    webgpu: {},\n    versions: { common: version },\n    set logLevel(value) {\n        if (value === undefined) {\n            return;\n        }\n        if (typeof value !== 'string' || ['verbose', 'info', 'warning', 'error', 'fatal'].indexOf(value) === -1) {\n            throw new Error(`Unsupported logging level: ${value}`);\n        }\n        logLevelValue = value;\n    },\n    get logLevel() {\n        return logLevelValue;\n    },\n};\n// set property 'logLevel' so that they can be correctly transferred to worker by `postMessage()`.\nObject.defineProperty(env, 'logLevel', { enumerable: true });\n//# sourceMappingURL=env-impl.js.map"
    },
    {
      "path": "dist/esm/inference-session-impl.js",
      "bytes": 8703,
      "sha256": "0446814a392c147b5c38ba242d9911ee54002b5d01a8e19fb4895fb8f8a0cdd3",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nimport { resolveBackendAndExecutionProviders } from './backend-impl.js';\nimport { Tensor } from './tensor.js';\nimport { TRACE_FUNC_BEGIN, TRACE_FUNC_END, TRACE_EVENT_BEGIN, TRACE_EVENT_END } from './trace.js';\nexport class InferenceSession {\n    constructor(handler) {\n        this.handler = handler;\n    }\n    async run(feeds, arg1, arg2) {\n        TRACE_FUNC_BEGIN();\n        TRACE_EVENT_BEGIN('InferenceSession.run');\n        const fetches = {};\n        let options = {};\n        // check inputs\n        if (typeof feeds !== 'object' || feeds === null || feeds instanceof Tensor || Array.isArray(feeds)) {\n            throw new TypeError(\"'feeds' must be an object that use input names as keys and OnnxValue as corresponding values.\");\n        }\n        let isFetchesEmpty = true;\n        // determine which override is being used\n        if (typeof arg1 === 'object') {\n            if (arg1 === null) {\n                throw new TypeError('Unexpected argument[1]: cannot be null.');\n            }\n            if (arg1 instanceof Tensor) {\n                throw new TypeError(\"'fetches' cannot be a Tensor\");\n            }\n            if (Array.isArray(arg1)) {\n                if (arg1.length === 0) {\n                    throw new TypeError(\"'fetches' cannot be an empty array.\");\n                }\n                isFetchesEmpty = false;\n                // output names\n                for (const name of arg1) {\n                    if (typeof name !== 'string') {\n                        throw new TypeError(\"'fetches' must be a string array or an object.\");\n                    }\n                    if (this.outputNames.indexOf(name) === -1) {\n                        throw new RangeError(`'fetches' contains invalid output name: ${name}.`);\n                    }\n                    fetches[name] = null;\n                }\n                if (typeof arg2 === 'object' && arg2 !== null) {\n                    options = arg2;\n                }\n                else if (typeof arg2 !== 'undefined') {\n                    throw new TypeError(\"'options' must be an object.\");\n                }\n            }\n            else {\n                // decide whether arg1 is fetches or options\n                // if any output name is present and its value is valid OnnxValue, we consider it fetches\n                let isFetches = false;\n                const arg1Keys = Object.getOwnPropertyNames(arg1);\n                for (const name of this.outputNames) {\n                    if (arg1Keys.indexOf(name) !== -1) {\n                        const v = arg1[name];\n                        if (v === null || v instanceof Tensor) {\n                            isFetches = true;\n                            isFetchesEmpty = false;\n                            fetches[name] = v;\n                        }\n                    }\n                }\n                if (isFetches) {\n                    if (typeof arg2 === 'object' && arg2 !== null) {\n                        options = arg2;\n                    }\n                    else if (typeof arg2 !== 'undefined') {\n                        throw new TypeError(\"'options' must be an object.\");\n                    }\n                }\n                else {\n                    options = arg1;\n                }\n            }\n        }\n        else if (typeof arg1 !== 'undefined') {\n            throw new TypeError(\"Unexpected argument[1]: must be 'fetches' or 'options'.\");\n        }\n        // check if all inputs are in feed\n        for (const name of this.inputNames) {\n            if (typeof feeds[name] === 'undefined') {\n                throw new Error(`input '${name}' is missing in 'feeds'.`);\n            }\n        }\n        // if no fetches is specified, we use the full output names list\n        if (isFetchesEmpty) {\n            for (const name of this.outputNames) {\n                fetches[name] = null;\n            }\n        }\n        // feeds, fetches and options are prepared\n        const results = await this.handler.run(feeds, fetches, options);\n        const returnValue = {};\n        for (const key in results) {\n            if (Object.hasOwnProperty.call(results, key)) {\n                const result = results[key];\n                if (result instanceof Tensor) {\n                    returnValue[key] = result;\n                }\n                else {\n                    returnValue[key] = new Tensor(result.type, result.data, result.dims);\n                }\n            }\n        }\n        TRACE_EVENT_END('InferenceSession.run');\n        TRACE_FUNC_END();\n        return returnValue;\n    }\n    async release() {\n        return this.handler.dispose();\n    }\n    static async create(arg0, arg1, arg2, arg3) {\n        TRACE_FUNC_BEGIN();\n        TRACE_EVENT_BEGIN('InferenceSession.create');\n        // either load from a file or buffer\n        let filePathOrUint8Array;\n        let options = {};\n        if (typeof arg0 === 'string') {\n            filePathOrUint8Array = arg0;\n            if (typeof arg1 === 'object' && arg1 !== null) {\n                options = arg1;\n            }\n            else if (typeof arg1 !== 'undefined') {\n                throw new TypeError(\"'options' must be an object.\");\n            }\n        }\n        else if (arg0 instanceof Uint8Array) {\n            filePathOrUint8Array = arg0;\n            if (typeof arg1 === 'object' && arg1 !== null) {\n                options = arg1;\n            }\n            else if (typeof arg1 !== 'undefined') {\n                throw new TypeError(\"'options' must be an object.\");\n            }\n        }\n        else if (arg0 instanceof ArrayBuffer ||\n            (typeof SharedArrayBuffer !== 'undefined' && arg0 instanceof SharedArrayBuffer)) {\n            const buffer = arg0;\n            let byteOffset = 0;\n            let byteLength = arg0.byteLength;\n            if (typeof arg1 === 'object' && arg1 !== null) {\n                options = arg1;\n            }\n            else if (typeof arg1 === 'number') {\n                byteOffset = arg1;\n                if (!Number.isSafeInteger(byteOffset)) {\n                    throw new RangeError(\"'byteOffset' must be an integer.\");\n                }\n                if (byteOffset < 0 || byteOffset >= buffer.byteLength) {\n                    throw new RangeError(`'byteOffset' is out of range [0, ${buffer.byteLength}).`);\n                }\n                byteLength = arg0.byteLength - byteOffset;\n                if (typeof arg2 === 'number') {\n                    byteLength = arg2;\n                    if (!Number.isSafeInteger(byteLength)) {\n                        throw new RangeError(\"'byteLength' must be an integer.\");\n                    }\n                    if (byteLength <= 0 || byteOffset + byteLength > buffer.byteLength) {\n                        throw new RangeError(`'byteLength' is out of range (0, ${buffer.byteLength - byteOffset}].`);\n                    }\n                    if (typeof arg3 === 'object' && arg3 !== null) {\n                        options = arg3;\n                    }\n                    else if (typeof arg3 !== 'undefined') {\n                        throw new TypeError(\"'options' must be an object.\");\n                    }\n                }\n                else if (typeof arg2 !== 'undefined') {\n                    throw new TypeError(\"'byteLength' must be a number.\");\n                }\n            }\n            else if (typeof arg1 !== 'undefined') {\n                throw new TypeError(\"'options' must be an object.\");\n            }\n            filePathOrUint8Array = new Uint8Array(buffer, byteOffset, byteLength);\n        }\n        else {\n            throw new TypeError(\"Unexpected argument[0]: must be 'path' or 'buffer'.\");\n        }\n        // resolve backend, update session options with validated EPs, and create session handler\n        const [backend, optionsWithValidatedEPs] = await resolveBackendAndExecutionProviders(options);\n        const handler = await backend.createInferenceSessionHandler(filePathOrUint8Array, optionsWithValidatedEPs);\n        TRACE_EVENT_END('InferenceSession.create');\n        TRACE_FUNC_END();\n        return new InferenceSession(handler);\n    }\n    startProfiling() {\n        this.handler.startProfiling();\n    }\n    endProfiling() {\n        this.handler.endProfiling();\n    }\n    get inputNames() {\n        return this.handler.inputNames;\n    }\n    get outputNames() {\n        return this.handler.outputNames;\n    }\n    get inputMetadata() {\n        return this.handler.inputMetadata;\n    }\n    get outputMetadata() {\n        return this.handler.outputMetadata;\n    }\n}\n//# sourceMappingURL=inference-session-impl.js.map"
    },
    {
      "path": "dist/esm/tensor-impl.js",
      "bytes": 16091,
      "sha256": "6a749be63055f9d21069566b1515412484a3a03448ca20427c8f8d29328a2843",
      "sourceText": "// Copyright (c) Microsoft Corporation. All rights reserved.\n// Licensed under the MIT License.\nimport { tensorToDataURL, tensorToImageData } from './tensor-conversion-impl.js';\nimport { tensorFromGpuBuffer, tensorFromImage, tensorFromMLTensor, tensorFromPinnedBuffer, tensorFromTexture, } from './tensor-factory-impl.js';\nimport { checkTypedArray, NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP, NUMERIC_TENSOR_TYPEDARRAY_TO_TYPE_MAP, } from './tensor-impl-type-mapping.js';\nimport { calculateSize, tensorReshape } from './tensor-utils-impl.js';\n/**\n * the implementation of Tensor interface.\n *\n * @ignore\n */\nexport class Tensor {\n    /**\n     * implementation.\n     */\n    constructor(arg0, arg1, arg2) {\n        // perform one-time check for BigInt/Float16Array support\n        checkTypedArray();\n        let type;\n        let dims;\n        if (typeof arg0 === 'object' && 'location' in arg0) {\n            //\n            // constructing tensor from specific location\n            //\n            this.dataLocation = arg0.location;\n            type = arg0.type;\n            dims = arg0.dims;\n            switch (arg0.location) {\n                case 'cpu-pinned': {\n                    const expectedTypedArrayConstructor = NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.get(type);\n                    if (!expectedTypedArrayConstructor) {\n                        throw new TypeError(`unsupported type \"${type}\" to create tensor from pinned buffer`);\n                    }\n                    if (!(arg0.data instanceof expectedTypedArrayConstructor)) {\n                        throw new TypeError(`buffer should be of type ${expectedTypedArrayConstructor.name}`);\n                    }\n                    this.cpuData = arg0.data;\n                    break;\n                }\n                case 'texture': {\n                    if (type !== 'float32') {\n                        throw new TypeError(`unsupported type \"${type}\" to create tensor from texture`);\n                    }\n                    this.gpuTextureData = arg0.texture;\n                    this.downloader = arg0.download;\n                    this.disposer = arg0.dispose;\n                    break;\n                }\n                case 'gpu-buffer': {\n                    if (type !== 'float32' &&\n                        type !== 'float16' &&\n                        type !== 'int32' &&\n                        type !== 'int64' &&\n                        type !== 'uint32' &&\n                        type !== 'uint8' &&\n                        type !== 'bool' &&\n                        type !== 'uint4' &&\n                        type !== 'int4') {\n                        throw new TypeError(`unsupported type \"${type}\" to create tensor from gpu buffer`);\n                    }\n                    this.gpuBufferData = arg0.gpuBuffer;\n                    this.downloader = arg0.download;\n                    this.disposer = arg0.dispose;\n                    break;\n                }\n                case 'ml-tensor': {\n                    if (type !== 'float32' &&\n                        type !== 'float16' &&\n                        type !== 'int32' &&\n                        type !== 'int64' &&\n                        type !== 'uint32' &&\n                        type !== 'uint64' &&\n                        type !== 'int8' &&\n                        type !== 'uint8' &&\n                        type !== 'bool' &&\n                        type !== 'uint4' &&\n                        type !== 'int4') {\n                        throw new TypeError(`unsupported type \"${type}\" to create tensor from MLTensor`);\n                    }\n                    this.mlTensorData = arg0.mlTensor;\n                    this.downloader = arg0.download;\n                    this.disposer = arg0.dispose;\n                    break;\n                }\n                default:\n                    throw new Error(`Tensor constructor: unsupported location '${this.dataLocation}'`);\n            }\n        }\n        else {\n            //\n            // constructing tensor of location 'cpu'\n            //\n            let data;\n            let maybeDims;\n            // check whether arg0 is type or data\n            if (typeof arg0 === 'string') {\n                //\n                // Override: constructor(type, data, ...)\n                //\n                type = arg0;\n                maybeDims = arg2;\n                if (arg0 === 'string') {\n                    // string tensor\n                    if (!Array.isArray(arg1)) {\n                        throw new TypeError(\"A string tensor's data must be a string array.\");\n                    }\n                    // we don't check whether every element in the array is string; this is too slow. we assume it's correct and\n                    // error will be populated at inference\n                    data = arg1;\n                }\n                else {\n                    // numeric tensor\n                    const typedArrayConstructor = NUMERIC_TENSOR_TYPE_TO_TYPEDARRAY_MAP.get(arg0);\n                    if (typedArrayConstructor === undefined) {\n                        throw new TypeError(`Unsupported tensor type: ${arg0}.`);\n                    }\n                    if (Array.isArray(arg1)) {\n                        if ((arg0 === 'float16' && typedArrayConstructor === Uint16Array) || arg0 === 'uint4' || arg0 === 'int4') {\n                            // - 'float16':\n                            //   When no Float16Array polyfill is used, we cannot create 'float16' tensor from number array.\n                            //\n                            //   Throw error here because when user try to use number array as data,\n                            //   e.g. new Tensor('float16', [1, 2, 3, 4], dims)), it will actually call\n                            //   Uint16Array.from(arg1) which generates wrong data.\n                            //\n                            // - 'uint4' and 'int4':\n                            //   Uint8Array.from(arg1) will generate wrong data for 'uint4' and 'int4' tensor.\n                            //\n                            throw new TypeError(`Creating a ${arg0} tensor from number array is not supported. Please use ${typedArrayConstructor.name} as data.`);\n                        }\n                        else if (arg0 === 'uint64' || arg0 === 'int64') {\n                            // use 'as any' here because:\n                            // 1. TypeScript's check on type of 'Array.isArray()' does not work with readonly arrays.\n                            // see https://github.com/microsoft/TypeScript/issues/17002\n                            // 2. TypeScript's check on union type of '(BigInt64ArrayConstructor|BigUint64ArrayConstructor).from()'\n                            // does not accept parameter mapFn.\n                            // 3. parameters of 'SupportedTypedArrayConstructors.from()' does not match the requirement of the union\n                            // type.\n                            // assume 'arg1' is of type \"readonly number[]|readonly bigint[]\" here.\n                            // eslint-disable-next-line @typescript-eslint/no-explicit-any\n                            data = typedArrayConstructor.from(arg1, BigInt);\n                        }\n                        else {\n                            // assume 'arg1' is of type \"readonly number[]\" here.\n                            // eslint-disable-next-line @typescript-eslint/no-explicit-any\n                            data = typedArrayConstructor.from(arg1);\n                        }\n                    }\n                    else if (arg1 instanceof typedArrayConstructor) {\n                        data = arg1;\n                    }\n                    else if (arg1 instanceof Uint8ClampedArray) {\n                        if (arg0 === 'uint8') {\n                            data = Uint8Array.from(arg1);\n                        }\n                        else {\n                            throw new TypeError(`A Uint8ClampedArray tensor's data must be type of uint8`);\n                        }\n                    }\n                    else if (arg0 === 'float16' && arg1 instanceof Uint16Array && typedArrayConstructor !== Uint16Array) {\n                        // when Float16Array is available and data is of type Uint16Array.\n                        // We allow Uint16Array to be passed in as data for 'float16' tensor until Float16Array is generally\n                        // supported in JavaScript environment.\n                        // eslint-disable-next-line @typescript-eslint/no-explicit-any\n                        data = new globalThis.Float16Array(arg1.buffer, arg1.byteOffset, arg1.length);\n                    }\n                    else {\n                        throw new TypeError(`A ${type} tensor's data must be type of ${typedArrayConstructor}`);\n                    }\n                }\n            }\n            else {\n                //\n                // Override: constructor(data, ...)\n                //\n                maybeDims = arg1;\n                if (Array.isArray(arg0)) {\n                    // only boolean[] and string[] is supported\n                    if (arg0.length === 0) {\n                        throw new TypeError('Tensor type cannot be inferred from an empty array.');\n                    }\n                    const firstElementType = typeof arg0[0];\n                    if (firstElementType === 'string') {\n                        type = 'string';\n                        data = arg0;\n                    }\n                    else if (firstElementType === 'boolean') {\n                        type = 'bool';\n                        // 'arg0' is of type 'boolean[]'. Uint8Array.from(boolean[]) actually works, but typescript thinks this is\n                        // wrong type. We use 'as any' to make it happy.\n                        // eslint-disable-next-line @typescript-eslint/no-explicit-any\n                        data = Uint8Array.from(arg0);\n                    }\n                    else {\n                        throw new TypeError(`Invalid element type of data array: ${firstElementType}.`);\n                    }\n                }\n                else if (arg0 instanceof Uint8ClampedArray) {\n                    type = 'uint8';\n                    data = Uint8Array.from(arg0);\n                }\n                else {\n                    // get tensor type from TypedArray\n                    const mappedType = NUMERIC_TENSOR_TYPEDARRAY_TO_TYPE_MAP.get(arg0.constructor);\n                    if (mappedType === undefined) {\n                        throw new TypeError(`Unsupported type for tensor data: ${arg0.constructor}.`);\n                    }\n                    type = mappedType;\n                    data = arg0;\n                }\n            }\n            // type and data is processed, now processing dims\n            if (maybeDims === undefined) {\n                // assume 1-D tensor if dims omitted\n                maybeDims = [data.length];\n            }\n            else if (!Array.isArray(maybeDims)) {\n                throw new TypeError(\"A tensor's dims must be a number array\");\n            }\n            dims = maybeDims;\n            this.cpuData = data;\n            this.dataLocation = 'cpu';\n        }\n        // perform check on dims\n        const size = calculateSize(dims);\n        // if data is on CPU, check whether data length matches tensor size\n        if (this.cpuData && size !== this.cpuData.length) {\n            if ((type === 'uint4' || type === 'int4') && Math.ceil(size / 2) === this.cpuData.length) {\n                // for (u)int4, the data length is half of the tensor size. So we check this special case when size is odd.\n            }\n            else {\n                throw new Error(`Tensor's size(${size}) does not match data length(${this.cpuData.length}).`);\n            }\n        }\n        this.type = type;\n        this.dims = dims;\n        this.size = size;\n    }\n    // #endregion\n    // #region factory\n    static async fromImage(image, options) {\n        return tensorFromImage(image, options);\n    }\n    static fromTexture(texture, options) {\n        return tensorFromTexture(texture, options);\n    }\n    static fromGpuBuffer(gpuBuffer, options) {\n        return tensorFromGpuBuffer(gpuBuffer, options);\n    }\n    static fromMLTensor(mlTensor, options) {\n        return tensorFromMLTensor(mlTensor, options);\n    }\n    static fromPinnedBuffer(type, buffer, dims) {\n        return tensorFromPinnedBuffer(type, buffer, dims);\n    }\n    // #endregion\n    // #region conversions\n    toDataURL(options) {\n        return tensorToDataURL(this, options);\n    }\n    toImageData(options) {\n        return tensorToImageData(this, options);\n    }\n    // #endregion\n    // #region properties\n    get data() {\n        this.ensureValid();\n        if (!this.cpuData) {\n            throw new Error('The data is not on CPU. Use `getData()` to download GPU data to CPU, ' +\n                'or use `texture` or `gpuBuffer` property to access the GPU data directly.');\n        }\n        return this.cpuData;\n    }\n    get location() {\n        return this.dataLocation;\n    }\n    get texture() {\n        this.ensureValid();\n        if (!this.gpuTextureData) {\n            throw new Error('The data is not stored as a WebGL texture.');\n        }\n        return this.gpuTextureData;\n    }\n    get gpuBuffer() {\n        this.ensureValid();\n        if (!this.gpuBufferData) {\n            throw new Error('The data is not stored as a WebGPU buffer.');\n        }\n        return this.gpuBufferData;\n    }\n    get mlTensor() {\n        this.ensureValid();\n        if (!this.mlTensorData) {\n            throw new Error('The data is not stored as a WebNN MLTensor.');\n        }\n        return this.mlTensorData;\n    }\n    // #endregion\n    // #region methods\n    async getData(releaseData) {\n        this.ensureValid();\n        switch (this.dataLocation) {\n            case 'cpu':\n            case 'cpu-pinned':\n                return this.data;\n            case 'texture':\n            case 'gpu-buffer':\n            case 'ml-tensor': {\n                if (!this.downloader) {\n                    throw new Error('The current tensor is not created with a specified data downloader.');\n                }\n                if (this.isDownloading) {\n                    throw new Error('The current tensor is being downloaded.');\n                }\n                try {\n                    this.isDownloading = true;\n                    const data = await this.downloader();\n                    this.downloader = undefined;\n                    this.dataLocation = 'cpu';\n                    this.cpuData = data;\n                    if (releaseData && this.disposer) {\n                        this.disposer();\n                        this.disposer = undefined;\n                    }\n                    return data;\n                }\n                finally {\n                    this.isDownloading = false;\n                }\n            }\n            default:\n                throw new Error(`cannot get data from location: ${this.dataLocation}`);\n        }\n    }\n    dispose() {\n        if (this.isDownloading) {\n            throw new Error('The current tensor is being downloaded.');\n        }\n        if (this.disposer) {\n            this.disposer();\n            this.disposer = undefined;\n        }\n        this.cpuData = undefined;\n        this.gpuTextureData = undefined;\n        this.gpuBufferData = undefined;\n        this.mlTensorData = undefined;\n        this.downloader = undefined;\n        this.isDownloading = undefined;\n        this.dataLocation = 'none';\n    }\n    // #endregion\n    // #region tensor utilities\n    ensureValid() {\n        if (this.dataLocation === 'none') {\n            throw new Error('The tensor is disposed.');\n        }\n    }\n    reshape(dims) {\n        this.ensureValid();\n        if (this.downloader || this.disposer) {\n            throw new Error('Cannot reshape a tensor that owns GPU resource.');\n        }\n        return tensorReshape(this, dims);\n    }\n}\n//# sourceMappingURL=tensor-impl.js.map"
    }
  ],
  "ast": [
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
  "sourceFindings": [
    {
      "source": "dist/esm/backend-impl.js:3,15-45,53-84,95-140",
      "finding": "Module scope creates the backend Map. Registration retains backend callbacks; resolution invokes backend.init, awaits initialization and caches initialized/aborted state, filters execution providers and returns proxied options. Source does not identify the actual registered backend/provider or its native/resource effects."
    },
    {
      "source": "dist/esm/env-impl.js:3-24",
      "finding": "Imports version.js, defines env wasm/webgl/webgpu objects and common version, validates logLevel in its setter, and makes logLevel enumerable through module-scope Object.defineProperty. Actual worker transfer or environment use is not executed."
    },
    {
      "source": "dist/esm/inference-session-impl.js:94,111-113,114-187,189-205",
      "finding": "Session creation accepts path or buffer, resolves backend then calls backend.createInferenceSessionHandler. run delegates feeds/fetches/options to this.handler.run and wraps returned data into Tensor; release and profiling delegate to the supplied handler. These are opaque effect boundaries, not proof of executed file/native/network paths."
    },
    {
      "source": "dist/esm/tensor-impl.js:3-6,16-238,241-263,300-364",
      "finding": "Imports four further tensor helper implementations. Constructor calls checkTypedArray and calculateSize, validates CPU/pinned/GPU/WebNN locations and saves supplied download/dispose callbacks. Factory/conversion/reshape methods delegate to imported helpers. getData invokes downloader and optional disposer; dispose invokes disposer. Those callback and helper paths remain unqualified."
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
    "Five named direct helper/version source targets and their own import/effect paths remain unreviewed in this unit.",
    "Actual installed package resolver, backend registrations, native binding identities and distribution custody are not established by registry source.",
    "Root onnxruntime-node/common 1.24.3 and web-nested common 1.24.1 historical lock rows lack resolved/integrity; same-version public archives cannot prove their historical identities.",
    "Independent immutable row applicability and row-bound positive/negative runtime evidence remain absent."
  ],
  "applicabilityCommitted": false,
  "populationComplete": false,
  "closureAccepted": false,
  "executionAdmitted": false,
  "qualificationExecuted": false,
  "targetExecuted": false,
  "installedRuntimeIdentityProven": false,
  "nextNamedSourceUnit": {
    "kind": "pinned-nested-onnx-common-tensor-helpers-and-version",
    "package": "onnxruntime-common",
    "version": "1.24.0-dev.20251116-b39e144322",
    "archiveUrl": "https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-1.24.0-dev.20251116-b39e144322.tgz",
    "archiveSha256": "00385ed2743575c5d0e1e95c5bacbb12ee4848ca2223c017282a472d7d08556f",
    "archiveBytes": 66168,
    "retainedIntegrity": "sha512-BOoomdHYmNRL5r4iQ4bMvsl2t0/hzVQ3OM3PHD0gxeXu1PmggqBv3puZicEUVOA3AtHHYmqZtjMj9FOfGrATTw==",
    "files": [
      "dist/esm/version.js",
      "dist/esm/tensor-conversion-impl.js",
      "dist/esm/tensor-factory-impl.js",
      "dist/esm/tensor-impl-type-mapping.js",
      "dist/esm/tensor-utils-impl.js"
    ],
    "instruction": "Statically read these five named direct import targets from the same retained-integrity archive. Preserve all source-only scope limits, installed identity gaps and seven unknown closure populations. Do not execute target code."
  }
}
