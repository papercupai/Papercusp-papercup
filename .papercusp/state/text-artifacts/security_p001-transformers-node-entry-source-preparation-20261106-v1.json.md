---
rel_path: "security/p001-transformers-node-entry-source-preparation-20261106-v1.json"
updated_at: 1793941957794
_body: "content"
---

{
  "schema": "p001-transformers-node-entry-source-preparation-v1",
  "plan": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
  "workItem": "WI-6554700010044289",
  "currentWorkItem": "WI-6554700010045753",
  "producer": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "status": "pinned-entry-static-source-only-unqualified",
  "recordedAt": "2026-11-06T05:12:37.785Z",
  "sources": {
    "priorCanonical": "security/p001-native-distribution-source-classification-20261106-transformers-package-v19.json",
    "ast": "security/p001-transformers-node-entry-ast-extraction-20261106-v2.json",
    "verification": "security/p001-transformers-node-entry-source-verification-20261106-v1.json",
    "excerpts": [
      "security/p001-transformers-node-entry-excerpts1-20261106-v1.json",
      "security/p001-transformers-node-entry-excerpts2-20261106-v1.json",
      "security/p001-transformers-node-entry-excerpts3-20261106-v1.json",
      "security/p001-transformers-node-entry-excerpts4-20261106-v1.json",
      "security/p001-transformers-node-entry-excerpts5-20261106-v1.json",
      "security/p001-transformers-node-entry-excerpts6-20261106-v1.json"
    ]
  },
  "evidenceScope": "Exact checksum-pinned public package Node entries; offline AST and static selected excerpts only. No target import, install script, worker, native or WASM execution. CJS and ESM module/call locations checked; detailed control-flow findings explicitly scoped to ESM.",
  "archivePinReused": {
    "name": "@huggingface/transformers",
    "version": "4.2.0",
    "url": "https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz",
    "integrity": "sha512-8BRCoBMH0XsWaEIamuR0LrJGAfftgHAfb2Vrffy0VKlSAE/MnUJ5/h/zTfEP3fDIft+nk7TqB8xXEyABGitBjQ==",
    "archiveSha256": "0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee",
    "archiveBytes": 2162844
  },
  "ast": {
    "schema": "p001-transformers-node-entry-ast-extraction-v1",
    "recordedAt": "2026-11-06T05:08:55.484Z",
    "supersedes": "security/p001-transformers-node-entry-ast-extraction-20261106-v1.json",
    "correction": "Dynamic argument Identifier.text is not a literal specifier; v2 records literal status and argument expression. Effect calls are selected by the exact captureCommand regex, not an exhaustive effect population. withinFunction is lexical containment, not proof of execution phase.",
    "method": "Node crypto and bounded raw tar reader; offline TypeScript parse only; no target import or execution",
    "candidateExecution": false,
    "installedRuntimeIdentityProven": false,
    "records": [
      {
        "path": "dist/transformers.node.mjs",
        "bytes": 1256499,
        "sha256": "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d",
        "lines": 34820,
        "parseDiagnostics": [],
        "modules": [
          {
            "kind": "static-import",
            "line": 14,
            "specifier": "fs",
            "statement": "import fs from \"fs\";"
          },
          {
            "kind": "static-import",
            "line": 15,
            "specifier": "path",
            "statement": "import path from \"path\";"
          },
          {
            "kind": "static-import",
            "line": 16,
            "specifier": "url",
            "statement": "import url from \"url\";"
          },
          {
            "kind": "static-import",
            "line": 5574,
            "specifier": "fs",
            "statement": "import fs2 from \"fs\";"
          },
          {
            "kind": "static-import",
            "line": 5687,
            "specifier": "fs",
            "statement": "import fs3 from \"fs\";"
          },
          {
            "kind": "static-import",
            "line": 5688,
            "specifier": "path",
            "statement": "import path2 from \"path\";"
          },
          {
            "kind": "static-import",
            "line": 7545,
            "specifier": "onnxruntime-node",
            "statement": "import * as ONNX_NODE from \"onnxruntime-node\";"
          },
          {
            "kind": "dynamic-import",
            "line": 9984,
            "specifier": null,
            "argumentExpression": "a",
            "argumentIsStringLiteral": false,
            "expression": "import( /*webpackIgnore:true*/ /*@vite-ignore*/ a )",
            "withinFunction": true
          },
          {
            "kind": "static-import",
            "line": 11500,
            "specifier": "onnxruntime-common",
            "statement": "import { Tensor } from \"onnxruntime-common\";"
          },
          {
            "kind": "static-import",
            "line": 15928,
            "specifier": "fs",
            "statement": "import fs5 from \"fs\";"
          },
          {
            "kind": "static-import",
            "line": 15929,
            "specifier": "stream",
            "statement": "import { Readable } from \"stream\";"
          },
          {
            "kind": "static-import",
            "line": 15930,
            "specifier": "stream/promises",
            "statement": "import { pipeline as pipe } from \"stream/promises\";"
          },
          {
            "kind": "static-import",
            "line": 17741,
            "specifier": "sharp",
            "statement": "import sharp from \"sharp\";"
          }
        ],
        "astCallCount": 8550,
        "effectCallCount": 30,
        "effectCalls": [
          {
            "line": 5594,
            "callee": "fs2.existsSync",
            "withinFunction": true,
            "expression": "fs2.existsSync(filePath)"
          },
          {
            "line": 5601,
            "callee": "fs2.createReadStream",
            "withinFunction": true,
            "expression": "fs2.createReadStream(filePath)"
          },
          {
            "line": 5646,
            "callee": "fs2.promises.readFile",
            "withinFunction": true,
            "expression": "fs2.promises.readFile(this.filePath)"
          },
          {
            "line": 5659,
            "callee": "fs2.promises.readFile",
            "withinFunction": true,
            "expression": "fs2.promises.readFile(this.filePath)"
          },
          {
            "line": 5672,
            "callee": "fs2.promises.readFile",
            "withinFunction": true,
            "expression": "fs2.promises.readFile(this.filePath, \"utf8\")"
          },
          {
            "line": 5892,
            "callee": "fs3.promises.mkdir",
            "withinFunction": true,
            "expression": "fs3.promises.mkdir(path2.dirname(filePath), { recursive: true })"
          },
          {
            "line": 5893,
            "callee": "fs3.createWriteStream",
            "withinFunction": true,
            "expression": "fs3.createWriteStream(tmpPath)"
          },
          {
            "line": 5916,
            "callee": "fs3.promises.rename",
            "withinFunction": true,
            "expression": "fs3.promises.rename(tmpPath, filePath)"
          },
          {
            "line": 5919,
            "callee": "fs3.promises.unlink",
            "withinFunction": true,
            "expression": "fs3.promises.unlink(tmpPath)"
          },
          {
            "line": 5933,
            "callee": "fs3.promises.unlink",
            "withinFunction": true,
            "expression": "fs3.promises.unlink(filePath)"
          },
          {
            "line": 6233,
            "callee": "fetch",
            "withinFunction": true,
            "expression": "fetch(rawUrl)"
          },
          {
            "line": 6385,
            "callee": "env.fetch",
            "withinFunction": true,
            "expression": "env.fetch(urlOrPath, { method: \"GET\", headers, cache: \"no-store\" })"
          },
          {
            "line": 6480,
            "callee": "env.fetch",
            "withinFunction": true,
            "expression": "env.fetch(urlOrPath, { headers: getFetchHeaders(urlOrPath) })"
          },
          {
            "line": 8216,
            "callee": "Worker",
            "withinFunction": true,
            "expression": "new Worker(a ?? ge, { type: \"module\", name: Xa })"
          },
          {
            "line": 8259,
            "callee": "fetch",
            "withinFunction": true,
            "expression": "fetch(e, { credentials: \"same-origin\" })"
          },
          {
            "line": 8335,
            "callee": "fetch",
            "withinFunction": true,
            "expression": "fetch(u, { credentials: \"same-origin\" })"
          },
          {
            "line": 8423,
            "callee": "Worker",
            "withinFunction": true,
            "expression": "new Worker((() => { let t = URL; return import.meta.url > \"file:\" && import.meta.url < \"file;\" ? new t(\"ort.webgpu.bundle.min.mjs\", import.meta.url) : new URL(import.meta.url); })(), { type: \"module\", workerData: \"em-pthread\", nam"
          },
          {
            "line": 9982,
            "callee": "fetch",
            "withinFunction": true,
            "expression": "fetch(a, { credentials: \"same-origin\" })"
          },
          {
            "line": 9983,
            "callee": "URL.createObjectURL",
            "withinFunction": true,
            "expression": "URL.createObjectURL(s)"
          },
          {
            "line": 10412,
            "callee": "fetch",
            "withinFunction": true,
            "expression": "fetch(a)"
          },
          {
            "line": 11459,
            "callee": "env.fetch",
            "withinFunction": true,
            "expression": "env.fetch(url2)"
          },
          {
            "line": 11492,
            "callee": "URL.createObjectURL",
            "withinFunction": true,
            "expression": "URL.createObjectURL(blob)"
          },
          {
            "line": 11652,
            "callee": "InferenceSession.create",
            "withinFunction": true,
            "expression": "InferenceSession.create(buffer_or_path, { // Set default log severity level, but allow overriding through session options logSeverityLevel, ...session_options })"
          },
          {
            "line": 15936,
            "callee": "URL.createObjectURL",
            "withinFunction": true,
            "expression": "URL.createObjectURL(blob)"
          },
          {
            "line": 15946,
            "callee": "fs5.createWriteStream",
            "withinFunction": true,
            "expression": "fs5.createWriteStream(path3)"
          },
          {
            "line": 15961,
            "callee": "AudioContext",
            "withinFunction": true,
            "expression": "new AudioContext({ sampleRate: sampling_rate })"
          },
          {
            "line": 32272,
            "callee": "env.fetch",
            "withinFunction": true,
            "expression": "env.fetch(speaker_embeddings)"
          },
          {
            "line": 33434,
            "callee": "URL.createObjectURL",
            "withinFunction": true,
            "expression": "URL.createObjectURL(src)"
          },
          {
            "line": 33442,
            "callee": "env.fetch",
            "withinFunction": true,
            "expression": "env.fetch(video.src)"
          },
          {
            "line": 33444,
            "callee": "URL.createObjectURL",
            "withinFunction": true,
            "expression": "URL.createObjectURL(blob)"
          }
        ],
        "topLevelCallCount": 203,
        "topLevelCalls": [
          {
            "line": 2,
            "callee": "((x) => typeof require !== \"undefined\" ? require : typeof Proxy !== \"undefined\" ? new Proxy(x, {\n  get: (a, b) => (typeof require !== \"undefined\" ? require : a)[b]\n}) : x)",
            "expression": "((x) => typeof require !== \"undefined\" ? require : typeof Proxy !== \"undefined\" ? new Proxy(x, { get: (a, b) => (typeof require !== \"undefined\" ? require : a)[b] }) : x)(function(x) { if (typeof require !== \"undefined\") return req"
          },
          {
            "line": 19,
            "callee": "isEmpty",
            "expression": "isEmpty(fs)"
          }
        ],
        "topLevelCallsOmitted": 201
      },
      {
        "path": "dist/transformers.node.cjs",
        "bytes": 1307721,
        "sha256": "398bcef3e3b36d189d39c00dcf2e1c31e22e72ca83969c753800fa158c8df5a4",
        "lines": 35781,
        "parseDiagnostics": [],
        "modules": [
          {
            "kind": "require",
            "line": 971,
            "specifier": "fs",
            "argumentExpression": "\"fs\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"fs\")",
            "withinFunction": false
          },
          {
            "kind": "require",
            "line": 972,
            "specifier": "path",
            "argumentExpression": "\"path\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"path\")",
            "withinFunction": false
          },
          {
            "kind": "require",
            "line": 973,
            "specifier": "url",
            "argumentExpression": "\"url\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"url\")",
            "withinFunction": false
          },
          {
            "kind": "require",
            "line": 6532,
            "specifier": "fs",
            "argumentExpression": "\"fs\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"fs\")",
            "withinFunction": false
          },
          {
            "kind": "require",
            "line": 6645,
            "specifier": "fs",
            "argumentExpression": "\"fs\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"fs\")",
            "withinFunction": false
          },
          {
            "kind": "require",
            "line": 6646,
            "specifier": "path",
            "argumentExpression": "\"path\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"path\")",
            "withinFunction": false
          },
          {
            "kind": "require",
            "line": 8504,
            "specifier": "onnxruntime-node",
            "argumentExpression": "\"onnxruntime-node\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"onnxruntime-node\")",
            "withinFunction": false
          },
          {
            "kind": "dynamic-import",
            "line": 10944,
            "specifier": null,
            "argumentExpression": "a",
            "argumentIsStringLiteral": false,
            "expression": "import( /*webpackIgnore:true*/ /*@vite-ignore*/ a )",
            "withinFunction": true
          },
          {
            "kind": "require",
            "line": 12460,
            "specifier": "onnxruntime-common",
            "argumentExpression": "\"onnxruntime-common\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"onnxruntime-common\")",
            "withinFunction": false
          },
          {
            "kind": "require",
            "line": 16888,
            "specifier": "fs",
            "argumentExpression": "\"fs\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"fs\")",
            "withinFunction": false
          },
          {
            "kind": "require",
            "line": 16889,
            "specifier": "stream",
            "argumentExpression": "\"stream\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"stream\")",
            "withinFunction": false
          },
          {
            "kind": "require",
            "line": 16890,
            "specifier": "stream/promises",
            "argumentExpression": "\"stream/promises\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"stream/promises\")",
            "withinFunction": false
          },
          {
            "kind": "require",
            "line": 18701,
            "specifier": "sharp",
            "argumentExpression": "\"sharp\"",
            "argumentIsStringLiteral": true,
            "expression": "require(\"sharp\")",
            "withinFunction": false
          }
        ],
        "astCallCount": 8579,
        "effectCallCount": 30,
        "effectCalls": [
          {
            "line": 6552,
            "callee": "import_node_fs2.default.existsSync",
            "withinFunction": true,
            "expression": "import_node_fs2.default.existsSync(filePath)"
          },
          {
            "line": 6559,
            "callee": "import_node_fs2.default.createReadStream",
            "withinFunction": true,
            "expression": "import_node_fs2.default.createReadStream(filePath)"
          },
          {
            "line": 6604,
            "callee": "import_node_fs2.default.promises.readFile",
            "withinFunction": true,
            "expression": "import_node_fs2.default.promises.readFile(this.filePath)"
          },
          {
            "line": 6617,
            "callee": "import_node_fs2.default.promises.readFile",
            "withinFunction": true,
            "expression": "import_node_fs2.default.promises.readFile(this.filePath)"
          },
          {
            "line": 6630,
            "callee": "import_node_fs2.default.promises.readFile",
            "withinFunction": true,
            "expression": "import_node_fs2.default.promises.readFile(this.filePath, \"utf8\")"
          },
          {
            "line": 6850,
            "callee": "import_node_fs3.default.promises.mkdir",
            "withinFunction": true,
            "expression": "import_node_fs3.default.promises.mkdir(import_node_path2.default.dirname(filePath), { recursive: true })"
          },
          {
            "line": 6851,
            "callee": "import_node_fs3.default.createWriteStream",
            "withinFunction": true,
            "expression": "import_node_fs3.default.createWriteStream(tmpPath)"
          },
          {
            "line": 6874,
            "callee": "import_node_fs3.default.promises.rename",
            "withinFunction": true,
            "expression": "import_node_fs3.default.promises.rename(tmpPath, filePath)"
          },
          {
            "line": 6877,
            "callee": "import_node_fs3.default.promises.unlink",
            "withinFunction": true,
            "expression": "import_node_fs3.default.promises.unlink(tmpPath)"
          },
          {
            "line": 6891,
            "callee": "import_node_fs3.default.promises.unlink",
            "withinFunction": true,
            "expression": "import_node_fs3.default.promises.unlink(filePath)"
          },
          {
            "line": 7192,
            "callee": "fetch",
            "withinFunction": true,
            "expression": "fetch(rawUrl)"
          },
          {
            "line": 7344,
            "callee": "env.fetch",
            "withinFunction": true,
            "expression": "env.fetch(urlOrPath, { method: \"GET\", headers, cache: \"no-store\" })"
          },
          {
            "line": 7439,
            "callee": "env.fetch",
            "withinFunction": true,
            "expression": "env.fetch(urlOrPath, { headers: getFetchHeaders(urlOrPath) })"
          },
          {
            "line": 9176,
            "callee": "Worker",
            "withinFunction": true,
            "expression": "new Worker(a ?? ge, { type: \"module\", name: Xa })"
          },
          {
            "line": 9219,
            "callee": "fetch",
            "withinFunction": true,
            "expression": "fetch(e, { credentials: \"same-origin\" })"
          },
          {
            "line": 9295,
            "callee": "fetch",
            "withinFunction": true,
            "expression": "fetch(u, { credentials: \"same-origin\" })"
          },
          {
            "line": 9383,
            "callee": "Worker",
            "withinFunction": true,
            "expression": "new Worker((() => { let t = URL; return import_meta3.url > \"file:\" && import_meta3.url < \"file;\" ? new t(\"ort.webgpu.bundle.min.mjs\", import_meta3.url) : new URL(import_meta3.url); })(), { type: \"module\", workerData: \"em-pthread\","
          },
          {
            "line": 10942,
            "callee": "fetch",
            "withinFunction": true,
            "expression": "fetch(a, { credentials: \"same-origin\" })"
          },
          {
            "line": 10943,
            "callee": "URL.createObjectURL",
            "withinFunction": true,
            "expression": "URL.createObjectURL(s)"
          },
          {
            "line": 11372,
            "callee": "fetch",
            "withinFunction": true,
            "expression": "fetch(a)"
          },
          {
            "line": 12419,
            "callee": "env.fetch",
            "withinFunction": true,
            "expression": "env.fetch(url2)"
          },
          {
            "line": 12452,
            "callee": "URL.createObjectURL",
            "withinFunction": true,
            "expression": "URL.createObjectURL(blob)"
          },
          {
            "line": 12612,
            "callee": "InferenceSession.create",
            "withinFunction": true,
            "expression": "InferenceSession.create(buffer_or_path, { // Set default log severity level, but allow overriding through session options logSeverityLevel, ...session_options })"
          },
          {
            "line": 16896,
            "callee": "URL.createObjectURL",
            "withinFunction": true,
            "expression": "URL.createObjectURL(blob)"
          },
          {
            "line": 16906,
            "callee": "import_node_fs4.default.createWriteStream",
            "withinFunction": true,
            "expression": "import_node_fs4.default.createWriteStream(path3)"
          },
          {
            "line": 16921,
            "callee": "AudioContext",
            "withinFunction": true,
            "expression": "new AudioContext({ sampleRate: sampling_rate })"
          },
          {
            "line": 33232,
            "callee": "env.fetch",
            "withinFunction": true,
            "expression": "env.fetch(speaker_embeddings)"
          },
          {
            "line": 34394,
            "callee": "URL.createObjectURL",
            "withinFunction": true,
            "expression": "URL.createObjectURL(src)"
          },
          {
            "line": 34402,
            "callee": "env.fetch",
            "withinFunction": true,
            "expression": "env.fetch(video.src)"
          },
          {
            "line": 34404,
            "callee": "URL.createObjectURL",
            "withinFunction": true,
            "expression": "URL.createObjectURL(blob)"
          }
        ],
        "topLevelCallCount": 225,
        "topLevelCalls": [
          {
            "line": 31,
            "callee": "__export",
            "expression": "__export(transformers_exports, { ASTFeatureExtractor: () => ASTFeatureExtractor, ASTForAudioClassification: () => ASTForAudioClassification, ASTModel: () => ASTModel, ASTPreTrainedModel: () => ASTPreTrainedModel, AfmoeForCausalLM:"
          },
          {
            "line": 968,
            "callee": "__toCommonJS",
            "expression": "__toCommonJS(transformers_exports)"
          }
        ],
        "topLevelCallsOmitted": 223
      }
    ],
    "captureCommand": "node <<'NODE'\n\nconst crypto=require('node:crypto'),zlib=require('node:zlib'),ts=require('typescript');\n(async()=>{\nconst url='https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz';\nconst archive=Buffer.from(await (await fetch(url)).arrayBuffer());\nif(crypto.createHash('sha256').update(archive).digest('hex')!=='0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee')throw Error('archive mismatch');\nconst tar=zlib.gunzipSync(archive), files=new Map();for(let off=0;off+512<=tar.length;){const h=tar.subarray(off,off+512);if(h.every(x=>x===0))break;const name=h.subarray(0,100).toString().replace(/\\0.*$/s,''), size=parseInt(h.subarray(124,136).toString().replace(/\\0.*$/s,'').trim(),8)||0;files.set(name,tar.subarray(off+512,off+512+size));off+=512+Math.ceil(size/512)*512;}\nconst expected={'dist/transformers.node.mjs':'4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d','dist/transformers.node.cjs':'398bcef3e3b36d189d39c00dcf2e1c31e22e72ca83969c753800fa158c8df5a4'};\nconst out=[];\nfor(const [path,hash] of Object.entries(expected)){\n const b=files.get('package/'+path);if(!b||crypto.createHash('sha256').update(b).digest('hex')!==hash)throw Error('entry mismatch');\n const text=b.toString(), sf=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);\n const modules=[],effectCalls=[],topLevelCalls=[];let calls=0;\n const line=n=>sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1;\n const excerpt=n=>n.getText(sf).replace(/\\s+/g,' ').slice(0,230);\n const inFunction=n=>{for(let p=n.parent;p;p=p.parent){if(ts.isFunctionLike(p))return true;}return false};\n function visit(n){\n if(ts.isImportDeclaration(n))modules.push({kind:'static-import',line:line(n),specifier:n.moduleSpecifier.text,statement:excerpt(n)});\n if(ts.isCallExpression(n)||ts.isNewExpression(n)){calls++;const callee=n.expression.getText(sf);\n if(n.expression.kind===ts.SyntaxKind.ImportKeyword||/^(require|__require)$/.test(callee))modules.push({kind:n.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic-import':'require',line:line(n),specifier:n.arguments?.[0]&&ts.isStringLiteralLike(n.arguments[0])?n.arguments[0].text:null,argumentExpression:n.arguments?.[0]?.getText(sf)??null,argumentIsStringLiteral:!!n.arguments?.[0]&&ts.isStringLiteralLike(n.arguments[0]),expression:excerpt(n),withinFunction:inFunction(n)});\n if(/(?:fetch|readFile|writeFile|mkdir|access|stat|existsSync|readFileSync|createReadStream|createWriteStream|unlink|rename|InferenceSession.create|Worker|AudioContext|importScripts|createRequire|loadDynamicLibrary|dlopen|createObjectURL)$/.test(callee))effectCalls.push({line:line(n),callee,withinFunction:inFunction(n),expression:excerpt(n)});\n if(!inFunction(n))topLevelCalls.push({line:line(n),callee,expression:excerpt(n)});\n }\n ts.forEachChild(n,visit);\n }visit(sf);\n const report={path,bytes:b.length,sha256:hash,lines:text.split('\\n').length,parseDiagnostics:sf.parseDiagnostics.map(x=>ts.flattenDiagnosticMessageText(x.messageText,' ')),modules,astCallCount:calls,effectCallCount:effectCalls.length,effectCalls,topLevelCallCount:topLevelCalls.length,topLevelCalls:topLevelCalls.slice(0,2),topLevelCallsOmitted:Math.max(0,topLevelCalls.length-2)};\n out.push(report);\n}\nconst record={schema:'p001-transformers-node-entry-ast-extraction-v1',recordedAt:new Date().toISOString(),supersedes:'security/p001-transformers-node-entry-ast-extraction-20261106-v1.json',correction:'Dynamic argument Identifier.text is not a literal specifier; v2 records literal status and argument expression. Effect calls are selected by the exact captureCommand regex, not an exhaustive effect population. withinFunction is lexical containment, not proof of execution phase.',method:'Node crypto and bounded raw tar reader; offline TypeScript parse only; no target import or execution',candidateExecution:false,installedRuntimeIdentityProven:false,records:out};\nconst output=JSON.stringify(record);if(output.length>14000)throw Error('record over bounded output '+output.length);process.stdout.write(output);\n})().catch(e=>{console.error(e);process.exitCode=1});\n\nNODE"
  },
  "verification": {
    "schema": "p001-transformers-node-entry-source-verification-v1",
    "recordedAt": "2026-11-06T05:09:48.305307+00:00",
    "method": "Independent Python urllib/hashlib/tarfile and line-anchored import/require reads; compare every selected AST effect expression at its pinned source line. No candidate execution.",
    "records": [
      {
        "path": "dist/transformers.node.mjs",
        "bytes": 1256499,
        "sha256": "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d",
        "literalModuleEdges": [
          [
            14,
            "fs"
          ],
          [
            15,
            "path"
          ],
          [
            16,
            "url"
          ],
          [
            5574,
            "fs"
          ],
          [
            5687,
            "fs"
          ],
          [
            5688,
            "path"
          ],
          [
            7545,
            "onnxruntime-node"
          ],
          [
            11500,
            "onnxruntime-common"
          ],
          [
            15928,
            "fs"
          ],
          [
            15929,
            "stream"
          ],
          [
            15930,
            "stream/promises"
          ],
          [
            17741,
            "sharp"
          ]
        ],
        "selectedEffectCallLocationsMatched": 30,
        "computedImportArgumentVerified": "Identifier a; no literal module specifier",
        "sourceIdentityMatches": true
      },
      {
        "path": "dist/transformers.node.cjs",
        "bytes": 1307721,
        "sha256": "398bcef3e3b36d189d39c00dcf2e1c31e22e72ca83969c753800fa158c8df5a4",
        "literalModuleEdges": [
          [
            971,
            "fs"
          ],
          [
            972,
            "path"
          ],
          [
            973,
            "url"
          ],
          [
            6532,
            "fs"
          ],
          [
            6645,
            "fs"
          ],
          [
            6646,
            "path"
          ],
          [
            8504,
            "onnxruntime-node"
          ],
          [
            12460,
            "onnxruntime-common"
          ],
          [
            16888,
            "fs"
          ],
          [
            16889,
            "stream"
          ],
          [
            16890,
            "stream/promises"
          ],
          [
            18701,
            "sharp"
          ]
        ],
        "selectedEffectCallLocationsMatched": 30,
        "computedImportArgumentVerified": "Identifier a; no literal module specifier",
        "sourceIdentityMatches": true
      }
    ],
    "candidateExecution": false,
    "installedRuntimeIdentityProven": false,
    "captureCommand": "python3 - <<'PY'\n\nimport urllib.request,tarfile,io,hashlib,json,re,datetime\nexpected=json.loads(\"[{\\\"path\\\":\\\"dist/transformers.node.mjs\\\",\\\"bytes\\\":1256499,\\\"sha256\\\":\\\"4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d\\\",\\\"lines\\\":34820,\\\"parseDiagnostics\\\":[],\\\"modules\\\":[{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":14,\\\"specifier\\\":\\\"fs\\\",\\\"statement\\\":\\\"import fs from \\\\\\\"fs\\\\\\\";\\\"},{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":15,\\\"specifier\\\":\\\"path\\\",\\\"statement\\\":\\\"import path from \\\\\\\"path\\\\\\\";\\\"},{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":16,\\\"specifier\\\":\\\"url\\\",\\\"statement\\\":\\\"import url from \\\\\\\"url\\\\\\\";\\\"},{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":5574,\\\"specifier\\\":\\\"fs\\\",\\\"statement\\\":\\\"import fs2 from \\\\\\\"fs\\\\\\\";\\\"},{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":5687,\\\"specifier\\\":\\\"fs\\\",\\\"statement\\\":\\\"import fs3 from \\\\\\\"fs\\\\\\\";\\\"},{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":5688,\\\"specifier\\\":\\\"path\\\",\\\"statement\\\":\\\"import path2 from \\\\\\\"path\\\\\\\";\\\"},{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":7545,\\\"specifier\\\":\\\"onnxruntime-node\\\",\\\"statement\\\":\\\"import * as ONNX_NODE from \\\\\\\"onnxruntime-node\\\\\\\";\\\"},{\\\"kind\\\":\\\"dynamic-import\\\",\\\"line\\\":9984,\\\"specifier\\\":null,\\\"argumentExpression\\\":\\\"a\\\",\\\"argumentIsStringLiteral\\\":false,\\\"expression\\\":\\\"import( /*webpackIgnore:true*/ /*@vite-ignore*/ a )\\\",\\\"withinFunction\\\":true},{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":11500,\\\"specifier\\\":\\\"onnxruntime-common\\\",\\\"statement\\\":\\\"import { Tensor } from \\\\\\\"onnxruntime-common\\\\\\\";\\\"},{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":15928,\\\"specifier\\\":\\\"fs\\\",\\\"statement\\\":\\\"import fs5 from \\\\\\\"fs\\\\\\\";\\\"},{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":15929,\\\"specifier\\\":\\\"stream\\\",\\\"statement\\\":\\\"import { Readable } from \\\\\\\"stream\\\\\\\";\\\"},{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":15930,\\\"specifier\\\":\\\"stream/promises\\\",\\\"statement\\\":\\\"import { pipeline as pipe } from \\\\\\\"stream/promises\\\\\\\";\\\"},{\\\"kind\\\":\\\"static-import\\\",\\\"line\\\":17741,\\\"specifier\\\":\\\"sharp\\\",\\\"statement\\\":\\\"import sharp from \\\\\\\"sharp\\\\\\\";\\\"}],\\\"astCallCount\\\":8550,\\\"effectCallCount\\\":30,\\\"effectCalls\\\":[{\\\"line\\\":5594,\\\"callee\\\":\\\"fs2.existsSync\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fs2.existsSync(filePath)\\\"},{\\\"line\\\":5601,\\\"callee\\\":\\\"fs2.createReadStream\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fs2.createReadStream(filePath)\\\"},{\\\"line\\\":5646,\\\"callee\\\":\\\"fs2.promises.readFile\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fs2.promises.readFile(this.filePath)\\\"},{\\\"line\\\":5659,\\\"callee\\\":\\\"fs2.promises.readFile\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fs2.promises.readFile(this.filePath)\\\"},{\\\"line\\\":5672,\\\"callee\\\":\\\"fs2.promises.readFile\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fs2.promises.readFile(this.filePath, \\\\\\\"utf8\\\\\\\")\\\"},{\\\"line\\\":5892,\\\"callee\\\":\\\"fs3.promises.mkdir\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fs3.promises.mkdir(path2.dirname(filePath), { recursive: true })\\\"},{\\\"line\\\":5893,\\\"callee\\\":\\\"fs3.createWriteStream\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fs3.createWriteStream(tmpPath)\\\"},{\\\"line\\\":5916,\\\"callee\\\":\\\"fs3.promises.rename\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fs3.promises.rename(tmpPath, filePath)\\\"},{\\\"line\\\":5919,\\\"callee\\\":\\\"fs3.promises.unlink\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fs3.promises.unlink(tmpPath)\\\"},{\\\"line\\\":5933,\\\"callee\\\":\\\"fs3.promises.unlink\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fs3.promises.unlink(filePath)\\\"},{\\\"line\\\":6233,\\\"callee\\\":\\\"fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fetch(rawUrl)\\\"},{\\\"line\\\":6385,\\\"callee\\\":\\\"env.fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"env.fetch(urlOrPath, { method: \\\\\\\"GET\\\\\\\", headers, cache: \\\\\\\"no-store\\\\\\\" })\\\"},{\\\"line\\\":6480,\\\"callee\\\":\\\"env.fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"env.fetch(urlOrPath, { headers: getFetchHeaders(urlOrPath) })\\\"},{\\\"line\\\":8216,\\\"callee\\\":\\\"Worker\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"new Worker(a ?? ge, { type: \\\\\\\"module\\\\\\\", name: Xa })\\\"},{\\\"line\\\":8259,\\\"callee\\\":\\\"fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fetch(e, { credentials: \\\\\\\"same-origin\\\\\\\" })\\\"},{\\\"line\\\":8335,\\\"callee\\\":\\\"fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fetch(u, { credentials: \\\\\\\"same-origin\\\\\\\" })\\\"},{\\\"line\\\":8423,\\\"callee\\\":\\\"Worker\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"new Worker((() => { let t = URL; return import.meta.url > \\\\\\\"file:\\\\\\\" && import.meta.url < \\\\\\\"file;\\\\\\\" ? new t(\\\\\\\"ort.webgpu.bundle.min.mjs\\\\\\\", import.meta.url) : new URL(import.meta.url); })(), { type: \\\\\\\"module\\\\\\\", workerData: \\\\\\\"em-pthread\\\\\\\", nam\\\"},{\\\"line\\\":9982,\\\"callee\\\":\\\"fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fetch(a, { credentials: \\\\\\\"same-origin\\\\\\\" })\\\"},{\\\"line\\\":9983,\\\"callee\\\":\\\"URL.createObjectURL\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"URL.createObjectURL(s)\\\"},{\\\"line\\\":10412,\\\"callee\\\":\\\"fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fetch(a)\\\"},{\\\"line\\\":11459,\\\"callee\\\":\\\"env.fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"env.fetch(url2)\\\"},{\\\"line\\\":11492,\\\"callee\\\":\\\"URL.createObjectURL\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"URL.createObjectURL(blob)\\\"},{\\\"line\\\":11652,\\\"callee\\\":\\\"InferenceSession.create\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"InferenceSession.create(buffer_or_path, { // Set default log severity level, but allow overriding through session options logSeverityLevel, ...session_options })\\\"},{\\\"line\\\":15936,\\\"callee\\\":\\\"URL.createObjectURL\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"URL.createObjectURL(blob)\\\"},{\\\"line\\\":15946,\\\"callee\\\":\\\"fs5.createWriteStream\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fs5.createWriteStream(path3)\\\"},{\\\"line\\\":15961,\\\"callee\\\":\\\"AudioContext\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"new AudioContext({ sampleRate: sampling_rate })\\\"},{\\\"line\\\":32272,\\\"callee\\\":\\\"env.fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"env.fetch(speaker_embeddings)\\\"},{\\\"line\\\":33434,\\\"callee\\\":\\\"URL.createObjectURL\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"URL.createObjectURL(src)\\\"},{\\\"line\\\":33442,\\\"callee\\\":\\\"env.fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"env.fetch(video.src)\\\"},{\\\"line\\\":33444,\\\"callee\\\":\\\"URL.createObjectURL\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"URL.createObjectURL(blob)\\\"}],\\\"topLevelCallCount\\\":203,\\\"topLevelCalls\\\":[{\\\"line\\\":2,\\\"callee\\\":\\\"((x) => typeof require !== \\\\\\\"undefined\\\\\\\" ? require : typeof Proxy !== \\\\\\\"undefined\\\\\\\" ? new Proxy(x, {\\\\n  get: (a, b) => (typeof require !== \\\\\\\"undefined\\\\\\\" ? require : a)[b]\\\\n}) : x)\\\",\\\"expression\\\":\\\"((x) => typeof require !== \\\\\\\"undefined\\\\\\\" ? require : typeof Proxy !== \\\\\\\"undefined\\\\\\\" ? new Proxy(x, { get: (a, b) => (typeof require !== \\\\\\\"undefined\\\\\\\" ? require : a)[b] }) : x)(function(x) { if (typeof require !== \\\\\\\"undefined\\\\\\\") return req\\\"},{\\\"line\\\":19,\\\"callee\\\":\\\"isEmpty\\\",\\\"expression\\\":\\\"isEmpty(fs)\\\"}],\\\"topLevelCallsOmitted\\\":201},{\\\"path\\\":\\\"dist/transformers.node.cjs\\\",\\\"bytes\\\":1307721,\\\"sha256\\\":\\\"398bcef3e3b36d189d39c00dcf2e1c31e22e72ca83969c753800fa158c8df5a4\\\",\\\"lines\\\":35781,\\\"parseDiagnostics\\\":[],\\\"modules\\\":[{\\\"kind\\\":\\\"require\\\",\\\"line\\\":971,\\\"specifier\\\":\\\"fs\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"fs\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"fs\\\\\\\")\\\",\\\"withinFunction\\\":false},{\\\"kind\\\":\\\"require\\\",\\\"line\\\":972,\\\"specifier\\\":\\\"path\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"path\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"path\\\\\\\")\\\",\\\"withinFunction\\\":false},{\\\"kind\\\":\\\"require\\\",\\\"line\\\":973,\\\"specifier\\\":\\\"url\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"url\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"url\\\\\\\")\\\",\\\"withinFunction\\\":false},{\\\"kind\\\":\\\"require\\\",\\\"line\\\":6532,\\\"specifier\\\":\\\"fs\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"fs\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"fs\\\\\\\")\\\",\\\"withinFunction\\\":false},{\\\"kind\\\":\\\"require\\\",\\\"line\\\":6645,\\\"specifier\\\":\\\"fs\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"fs\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"fs\\\\\\\")\\\",\\\"withinFunction\\\":false},{\\\"kind\\\":\\\"require\\\",\\\"line\\\":6646,\\\"specifier\\\":\\\"path\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"path\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"path\\\\\\\")\\\",\\\"withinFunction\\\":false},{\\\"kind\\\":\\\"require\\\",\\\"line\\\":8504,\\\"specifier\\\":\\\"onnxruntime-node\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"onnxruntime-node\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"onnxruntime-node\\\\\\\")\\\",\\\"withinFunction\\\":false},{\\\"kind\\\":\\\"dynamic-import\\\",\\\"line\\\":10944,\\\"specifier\\\":null,\\\"argumentExpression\\\":\\\"a\\\",\\\"argumentIsStringLiteral\\\":false,\\\"expression\\\":\\\"import( /*webpackIgnore:true*/ /*@vite-ignore*/ a )\\\",\\\"withinFunction\\\":true},{\\\"kind\\\":\\\"require\\\",\\\"line\\\":12460,\\\"specifier\\\":\\\"onnxruntime-common\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"onnxruntime-common\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"onnxruntime-common\\\\\\\")\\\",\\\"withinFunction\\\":false},{\\\"kind\\\":\\\"require\\\",\\\"line\\\":16888,\\\"specifier\\\":\\\"fs\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"fs\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"fs\\\\\\\")\\\",\\\"withinFunction\\\":false},{\\\"kind\\\":\\\"require\\\",\\\"line\\\":16889,\\\"specifier\\\":\\\"stream\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"stream\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"stream\\\\\\\")\\\",\\\"withinFunction\\\":false},{\\\"kind\\\":\\\"require\\\",\\\"line\\\":16890,\\\"specifier\\\":\\\"stream/promises\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"stream/promises\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"stream/promises\\\\\\\")\\\",\\\"withinFunction\\\":false},{\\\"kind\\\":\\\"require\\\",\\\"line\\\":18701,\\\"specifier\\\":\\\"sharp\\\",\\\"argumentExpression\\\":\\\"\\\\\\\"sharp\\\\\\\"\\\",\\\"argumentIsStringLiteral\\\":true,\\\"expression\\\":\\\"require(\\\\\\\"sharp\\\\\\\")\\\",\\\"withinFunction\\\":false}],\\\"astCallCount\\\":8579,\\\"effectCallCount\\\":30,\\\"effectCalls\\\":[{\\\"line\\\":6552,\\\"callee\\\":\\\"import_node_fs2.default.existsSync\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"import_node_fs2.default.existsSync(filePath)\\\"},{\\\"line\\\":6559,\\\"callee\\\":\\\"import_node_fs2.default.createReadStream\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"import_node_fs2.default.createReadStream(filePath)\\\"},{\\\"line\\\":6604,\\\"callee\\\":\\\"import_node_fs2.default.promises.readFile\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"import_node_fs2.default.promises.readFile(this.filePath)\\\"},{\\\"line\\\":6617,\\\"callee\\\":\\\"import_node_fs2.default.promises.readFile\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"import_node_fs2.default.promises.readFile(this.filePath)\\\"},{\\\"line\\\":6630,\\\"callee\\\":\\\"import_node_fs2.default.promises.readFile\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"import_node_fs2.default.promises.readFile(this.filePath, \\\\\\\"utf8\\\\\\\")\\\"},{\\\"line\\\":6850,\\\"callee\\\":\\\"import_node_fs3.default.promises.mkdir\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"import_node_fs3.default.promises.mkdir(import_node_path2.default.dirname(filePath), { recursive: true })\\\"},{\\\"line\\\":6851,\\\"callee\\\":\\\"import_node_fs3.default.createWriteStream\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"import_node_fs3.default.createWriteStream(tmpPath)\\\"},{\\\"line\\\":6874,\\\"callee\\\":\\\"import_node_fs3.default.promises.rename\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"import_node_fs3.default.promises.rename(tmpPath, filePath)\\\"},{\\\"line\\\":6877,\\\"callee\\\":\\\"import_node_fs3.default.promises.unlink\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"import_node_fs3.default.promises.unlink(tmpPath)\\\"},{\\\"line\\\":6891,\\\"callee\\\":\\\"import_node_fs3.default.promises.unlink\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"import_node_fs3.default.promises.unlink(filePath)\\\"},{\\\"line\\\":7192,\\\"callee\\\":\\\"fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fetch(rawUrl)\\\"},{\\\"line\\\":7344,\\\"callee\\\":\\\"env.fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"env.fetch(urlOrPath, { method: \\\\\\\"GET\\\\\\\", headers, cache: \\\\\\\"no-store\\\\\\\" })\\\"},{\\\"line\\\":7439,\\\"callee\\\":\\\"env.fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"env.fetch(urlOrPath, { headers: getFetchHeaders(urlOrPath) })\\\"},{\\\"line\\\":9176,\\\"callee\\\":\\\"Worker\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"new Worker(a ?? ge, { type: \\\\\\\"module\\\\\\\", name: Xa })\\\"},{\\\"line\\\":9219,\\\"callee\\\":\\\"fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fetch(e, { credentials: \\\\\\\"same-origin\\\\\\\" })\\\"},{\\\"line\\\":9295,\\\"callee\\\":\\\"fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fetch(u, { credentials: \\\\\\\"same-origin\\\\\\\" })\\\"},{\\\"line\\\":9383,\\\"callee\\\":\\\"Worker\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"new Worker((() => { let t = URL; return import_meta3.url > \\\\\\\"file:\\\\\\\" && import_meta3.url < \\\\\\\"file;\\\\\\\" ? new t(\\\\\\\"ort.webgpu.bundle.min.mjs\\\\\\\", import_meta3.url) : new URL(import_meta3.url); })(), { type: \\\\\\\"module\\\\\\\", workerData: \\\\\\\"em-pthread\\\\\\\",\\\"},{\\\"line\\\":10942,\\\"callee\\\":\\\"fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fetch(a, { credentials: \\\\\\\"same-origin\\\\\\\" })\\\"},{\\\"line\\\":10943,\\\"callee\\\":\\\"URL.createObjectURL\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"URL.createObjectURL(s)\\\"},{\\\"line\\\":11372,\\\"callee\\\":\\\"fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"fetch(a)\\\"},{\\\"line\\\":12419,\\\"callee\\\":\\\"env.fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"env.fetch(url2)\\\"},{\\\"line\\\":12452,\\\"callee\\\":\\\"URL.createObjectURL\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"URL.createObjectURL(blob)\\\"},{\\\"line\\\":12612,\\\"callee\\\":\\\"InferenceSession.create\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"InferenceSession.create(buffer_or_path, { // Set default log severity level, but allow overriding through session options logSeverityLevel, ...session_options })\\\"},{\\\"line\\\":16896,\\\"callee\\\":\\\"URL.createObjectURL\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"URL.createObjectURL(blob)\\\"},{\\\"line\\\":16906,\\\"callee\\\":\\\"import_node_fs4.default.createWriteStream\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"import_node_fs4.default.createWriteStream(path3)\\\"},{\\\"line\\\":16921,\\\"callee\\\":\\\"AudioContext\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"new AudioContext({ sampleRate: sampling_rate })\\\"},{\\\"line\\\":33232,\\\"callee\\\":\\\"env.fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"env.fetch(speaker_embeddings)\\\"},{\\\"line\\\":34394,\\\"callee\\\":\\\"URL.createObjectURL\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"URL.createObjectURL(src)\\\"},{\\\"line\\\":34402,\\\"callee\\\":\\\"env.fetch\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"env.fetch(video.src)\\\"},{\\\"line\\\":34404,\\\"callee\\\":\\\"URL.createObjectURL\\\",\\\"withinFunction\\\":true,\\\"expression\\\":\\\"URL.createObjectURL(blob)\\\"}],\\\"topLevelCallCount\\\":225,\\\"topLevelCalls\\\":[{\\\"line\\\":31,\\\"callee\\\":\\\"__export\\\",\\\"expression\\\":\\\"__export(transformers_exports, { ASTFeatureExtractor: () => ASTFeatureExtractor, ASTForAudioClassification: () => ASTForAudioClassification, ASTModel: () => ASTModel, ASTPreTrainedModel: () => ASTPreTrainedModel, AfmoeForCausalLM:\\\"},{\\\"line\\\":968,\\\"callee\\\":\\\"__toCommonJS\\\",\\\"expression\\\":\\\"__toCommonJS(transformers_exports)\\\"}],\\\"topLevelCallsOmitted\\\":223}]\")\narchive=urllib.request.urlopen('https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz',timeout=20).read()\nassert len(archive)==2162844 and hashlib.sha256(archive).hexdigest()=='0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee'\nt=tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz');rows=[]\nfor e in expected:\n b=t.extractfile('package/'+e['path']).read();s=b.decode();lines=s.splitlines()\n assert len(b)==e['bytes'] and hashlib.sha256(b).hexdigest()==e['sha256']\n literal=[]\n for i,l in enumerate(lines,1):\n  m=re.match(r'^import\\s+.+?\\s+from\\s+\"([^\"]+)\"\\s*;',l)\n  if m:literal.append([i,m.group(1)])\n  if e['path'].endswith('.cjs'):\n   for m in re.finditer(r'\\brequire\\(\"([^\"]+)\"\\)',l):literal.append([i,m.group(1)])\n astLiteral=[[m['line'],m['specifier']] for m in e['modules'] if m['kind']=='static-import' or m.get('argumentIsStringLiteral')]\n assert literal==astLiteral,(literal,astLiteral)\n for c in e['effectCalls']:\n  window=' '.join(lines[c['line']-1:c['line']+60]);normalized=re.sub(r'\\s+',' ',window)\n  assert c['expression'] in normalized,(e['path'],c['line'],c['expression'])\n for m in e['modules']:\n  if m['kind']=='dynamic-import':\n   assert m['specifier'] is None and not m['argumentIsStringLiteral'] and m['argumentExpression']=='a'\n   assert re.search(r'\\bimport\\s*\\(\\s*/\\*webpackIgnore:true\\*/\\s*/\\*@vite-ignore\\*/\\s*a\\s*\\)',s)\n rows.append({'path':e['path'],'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest(),'literalModuleEdges':literal,'selectedEffectCallLocationsMatched':len(e['effectCalls']),'computedImportArgumentVerified':'Identifier a; no literal module specifier','sourceIdentityMatches':True})\nprint(json.dumps({'schema':'p001-transformers-node-entry-source-verification-v1','recordedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'Independent Python urllib/hashlib/tarfile and line-anchored import/require reads; compare every selected AST effect expression at its pinned source line. No candidate execution.','records':rows,'candidateExecution':False,'installedRuntimeIdentityProven':False}))\n\nPY"
  },
  "excerpts": [
    {
      "path": "security/p001-transformers-node-entry-excerpts1-20261106-v1.json",
      "content": {
        "schema": "p001-transformers-node-entry-static-excerpts-v1",
        "path": "dist/transformers.node.mjs",
        "sha256": "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d",
        "candidateExecution": false,
        "ranges": [
          {
            "start": 5687,
            "end": 5760,
            "text": "5687: import fs3 from \"fs\";\n5688: import path2 from \"path\";\n5689: \n5690: // src/utils/random.js\n5691: var Random = class {\n5692:   constructor(seed) {\n5693:     this._mt = new Uint32Array(624);\n5694:     this._idx = 625;\n5695:     this._gauss_next = null;\n5696:     this._random_fn = this.random.bind(this);\n5697:     this.seed(seed);\n5698:   }\n5699:   /**\n5700:    * Seeds this instance's PRNG.\n5701:    *\n5702:    * When called with a number, initializes the state deterministically from that value.\n5703:    * When called with no arguments (or `undefined`/`null`), seeds from OS entropy\n5704:    * via `crypto.getRandomValues`, matching Python's `random.seed()` behaviour.\n5705:    *\n5706:    * @param {number} [n] The seed value. Omit to seed from OS entropy.\n5707:    */\n5708:   seed(n) {\n5709:     if (n === void 0 || n === null) {\n5710:       if (apis.IS_CRYPTO_AVAILABLE) {\n5711:         const buf = new Uint32Array(1);\n5712:         crypto.getRandomValues(buf);\n5713:         n = buf[0];\n5714:       } else {\n5715:         n = Date.now() >>> 0;\n5716:       }\n5717:     }\n5718:     const mt2 = this._mt;\n5719:     const u = (a, b) => Math.imul(a, b) >>> 0, key = [];\n5720:     for (let v = n || 0; v > 0; v = Math.floor(v / 4294967296)) key.push(v & 4294967295);\n5721:     if (!key.length) key.push(0);\n5722:     mt2[0] = 19650218;\n5723:     for (let k2 = 1; k2 < 624; ++k2) mt2[k2] = u(1812433253, mt2[k2 - 1] ^ mt2[k2 - 1] >>> 30) + k2 >>> 0;\n5724:     let i = 1, j = 0;\n5725:     for (let k2 = Math.max(624, key.length); k2 > 0; --k2, ++i, ++j) {\n5726:       if (i >= 624) {\n5727:         mt2[0] = mt2[623];\n5728:         i = 1;\n5729:       }\n5730:       if (j >= key.length) j = 0;\n5731:       mt2[i] = (mt2[i] ^ u(mt2[i - 1] ^ mt2[i - 1] >>> 30, 1664525)) + key[j] + j >>> 0;\n5732:     }\n5733:     for (let k2 = 623; k2 > 0; --k2, ++i) {\n5734:       if (i >= 624) {\n5735:         mt2[0] = mt2[623];\n5736:         i = 1;\n5737:       }\n5738:       mt2[i] = (mt2[i] ^ u(mt2[i - 1] ^ mt2[i - 1] >>> 30, 1566083941)) - i >>> 0;\n5739:     }\n5740:     mt2[0] = 2147483648;\n5741:     this._idx = 624;\n5742:     this._gauss_next = null;\n5743:   }\n5744:   /**\n5745:    * Generates a random unsigned 32-bit integer.\n5746:    *\n5747:    * Performs the \"twist\" step when the state buffer is exhausted,\n5748:    * then applies the standard MT19937 tempering transform.\n5749:    *\n5750:    * @returns {number} A random integer in the range [0, 2^32 - 1].\n5751:    */\n5752:   _int32() {\n5753:     const mt2 = this._mt;\n5754:     if (this._idx >= 624) {\n5755:       for (let k2 = 0; k2 < 624; ++k2) {\n5756:         const y2 = mt2[k2] & 2147483648 | mt2[(k2 + 1) % 624] & 2147483647;\n5757:         mt2[k2] = (mt2[(k2 + 397) % 624] ^ y2 >>> 1 ^ (y2 & 1 ? 2567483615 : 0)) >>> 0;\n5758:       }\n5759:       this._idx = 0;\n5760:     }"
          },
          {
            "start": 5865,
            "end": 5940,
            "text": "5865:    */\n5866:   async match(request) {\n5867:     let filePath = path2.join(this.path, request);\n5868:     let file = new FileResponse(filePath);\n5869:     if (file.exists) {\n5870:       return file;\n5871:     } else {\n5872:       return void 0;\n5873:     }\n5874:   }\n5875:   /**\n5876:    * Adds the given response to the cache.\n5877:    * @param {string} request\n5878:    * @param {Response} response\n5879:    * @param {(data: {progress: number, loaded: number, total: number}) => void} [progress_callback] Optional.\n5880:    * The function to call with progress updates\n5881:    * @returns {Promise<void>}\n5882:    */\n5883:   async put(request, response, progress_callback = void 0) {\n5884:     const filePath = path2.join(this.path, request);\n5885:     const id = apis.IS_PROCESS_AVAILABLE ? process.pid : Date.now();\n5886:     const randomSuffix = rng._int32().toString(36);\n5887:     const tmpPath = filePath + `.tmp.${id}.${randomSuffix}`;\n5888:     try {\n5889:       const contentLength = response.headers.get(\"Content-Length\");\n5890:       const total = parseInt(contentLength ?? \"0\");\n5891:       let loaded = 0;\n5892:       await fs3.promises.mkdir(path2.dirname(filePath), { recursive: true });\n5893:       const fileStream = fs3.createWriteStream(tmpPath);\n5894:       const reader = response.body.getReader();\n5895:       while (true) {\n5896:         const { done, value } = await reader.read();\n5897:         if (done) {\n5898:           break;\n5899:         }\n5900:         await new Promise((resolve, reject) => {\n5901:           fileStream.write(value, (err) => {\n5902:             if (err) {\n5903:               reject(err);\n5904:               return;\n5905:             }\n5906:             resolve();\n5907:           });\n5908:         });\n5909:         loaded += value.length;\n5910:         const progress = total ? loaded / total * 100 : 0;\n5911:         progress_callback?.({ progress, loaded, total });\n5912:       }\n5913:       await new Promise((resolve, reject) => {\n5914:         fileStream.close((err) => err ? reject(err) : resolve());\n5915:       });\n5916:       await fs3.promises.rename(tmpPath, filePath);\n5917:     } catch (error) {\n5918:       try {\n5919:         await fs3.promises.unlink(tmpPath);\n5920:       } catch {\n5921:       }\n5922:       throw error;\n5923:     }\n5924:   }\n5925:   /**\n5926:    * Deletes the cache entry for the given request.\n5927:    * @param {string} request\n5928:    * @returns {Promise<boolean>} A Promise that resolves to `true` if the cache entry was deleted, `false` otherwise.\n5929:    */\n5930:   async delete(request) {\n5931:     let filePath = path2.join(this.path, request);\n5932:     try {\n5933:       await fs3.promises.unlink(filePath);\n5934:       return true;\n5935:     } catch (error) {\n5936:       return false;\n5937:     }\n5938:   }\n5939:   // TODO add the rest?\n5940:   // addAll(requests: RequestInfo[]): Promise<void>;"
          },
          {
            "start": 7540,
            "end": 7605,
            "text": "7540:     return out;\n7541:   };\n7542: })();\n7543: \n7544: // src/backends/onnx.js\n7545: import * as ONNX_NODE from \"onnxruntime-node\";\n7546: \n7547: // ../../node_modules/.pnpm/onnxruntime-web@1.26.0-dev.20260416-b7804b056c/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs\n7548: var ort_webgpu_bundle_min_exports = {};\n7549: __export(ort_webgpu_bundle_min_exports, {\n7550:   InferenceSession: () => qf,\n7551:   TRACE: () => Ga,\n7552:   TRACE_EVENT_BEGIN: () => $e,\n7553:   TRACE_EVENT_END: () => ze,\n7554:   TRACE_FUNC_BEGIN: () => tt,\n7555:   TRACE_FUNC_END: () => rt,\n7556:   Tensor: () => Le,\n7557:   default: () => gl,\n7558:   env: () => K,\n7559:   registerBackend: () => Ke\n7560: });\n7561: var jr = Object.defineProperty;\n7562: var zf = Object.getOwnPropertyDescriptor;\n7563: var Vf = Object.getOwnPropertyNames;\n7564: var jf = Object.prototype.hasOwnProperty;\n7565: var Hr = ((a) => typeof __require < \"u\" ? __require : typeof Proxy < \"u\" ? new Proxy(a, { get: (r, s) => (typeof __require < \"u\" ? __require : r)[s] }) : a)(function(a) {\n7566:   if (typeof __require < \"u\") return __require.apply(this, arguments);\n7567:   throw Error('Dynamic require of \"' + a + '\" is not supported');\n7568: });\n7569: var k = (a, r) => () => (a && (r = a(a = 0)), r);\n7570: var At = (a, r) => {\n7571:   for (var s in r) jr(a, s, { get: r[s], enumerable: true });\n7572: };\n7573: var Hf = (a, r, s, f) => {\n7574:   if (r && typeof r == \"object\" || typeof r == \"function\") for (let i of Vf(r)) !jf.call(a, i) && i !== s && jr(a, i, { get: () => r[i], enumerable: !(f = zf(r, i)) || f.enumerable });\n7575:   return a;\n7576: };\n7577: var $t = (a) => Hf(jr({}, \"__esModule\", { value: true }), a);\n7578: var zt;\n7579: var Ze;\n7580: var Ke;\n7581: var Yf;\n7582: var Ta;\n7583: var Yr = k(() => {\n7584:   \"use strict\";\n7585:   zt = /* @__PURE__ */ new Map(), Ze = [], Ke = (a, r, s) => {\n7586:     if (r && typeof r.init == \"function\" && typeof r.createInferenceSessionHandler == \"function\") {\n7587:       let f = zt.get(a);\n7588:       if (f === void 0) zt.set(a, { backend: r, priority: s });\n7589:       else {\n7590:         if (f.priority > s) return;\n7591:         if (f.priority === s && f.backend !== r) throw new Error(`cannot register backend \"${a}\" using priority ${s}`);\n7592:       }\n7593:       if (s >= 0) {\n7594:         let i = Ze.indexOf(a);\n7595:         i !== -1 && Ze.splice(i, 1);\n7596:         for (let d = 0; d < Ze.length; d++) if (zt.get(Ze[d]).priority <= s) {\n7597:           Ze.splice(d, 0, a);\n7598:           return;\n7599:         }\n7600:         Ze.push(a);\n7601:       }\n7602:       return;\n7603:     }\n7604:     throw new TypeError(\"not a valid backend\");\n7605:   }, Yf = async (a) => {"
          },
          {
            "start": 17730,
            "end": 17775,
            "text": "17730:   /**\n17731:    * Calls the feature_extractor function with the given audio input.\n17732:    * @param {any} audio The audio input to extract features from.\n17733:    * @returns {Promise<any>}\n17734:    */\n17735:   async _call(audio) {\n17736:     return await this.feature_extractor(audio);\n17737:   }\n17738: };\n17739: \n17740: // src/utils/image.js\n17741: import sharp from \"sharp\";\n17742: var createCanvasFunction;\n17743: var ImageDataClass;\n17744: var loadImageFunction;\n17745: if (apis.IS_WEB_ENV) {\n17746:   createCanvasFunction = (width, height) => {\n17747:     if (!self.OffscreenCanvas) {\n17748:       throw new Error(\"OffscreenCanvas not supported by this environment.\");\n17749:     }\n17750:     return new self.OffscreenCanvas(width, height);\n17751:   };\n17752:   loadImageFunction = self.createImageBitmap;\n17753:   ImageDataClass = self.ImageData;\n17754: } else if (sharp) {\n17755:   loadImageFunction = async (img) => {\n17756:     const metadata = await img.metadata();\n17757:     const rawChannels = metadata.channels;\n17758:     const { data, info } = await img.rotate().raw().toBuffer({ resolveWithObject: true });\n17759:     const newImage = new RawImage(new Uint8ClampedArray(data), info.width, info.height, info.channels);\n17760:     if (rawChannels !== void 0 && rawChannels !== info.channels) {\n17761:       newImage.convert(rawChannels);\n17762:     }\n17763:     return newImage;\n17764:   };\n17765: } else {\n17766:   throw new Error(\"Unable to load image processing library.\");\n17767: }\n17768: var RESAMPLING_MAPPING = {\n17769:   0: \"nearest\",\n17770:   1: \"lanczos\",\n17771:   2: \"bilinear\",\n17772:   3: \"bicubic\",\n17773:   4: \"box\",\n17774:   5: \"hamming\"\n17775: };"
          }
        ],
        "captureCommand": "python3 - <<'PY'\n\nimport urllib.request,tarfile,io,hashlib,json,re\nurl='https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz'\nb=urllib.request.urlopen(url,timeout=20).read()\nassert len(b)==2162844 and hashlib.sha256(b).hexdigest()=='0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee'\nt=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz')\np='dist/transformers.node.mjs'; source=t.extractfile('package/'+p).read()\nassert len(source)==1256499 and hashlib.sha256(source).hexdigest()=='4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d'\nlines=source.decode().splitlines()\nranges=[[5687,5760],[5865,5940],[7540,7605],[17730,17775]]\nrecord={'schema':'p001-transformers-node-entry-static-excerpts-v1','path':p,'sha256':hashlib.sha256(source).hexdigest(),'candidateExecution':False,'ranges':[{'start':a,'end':z,'text':'\\n'.join(str(i)+': '+lines[i-1] for i in range(a,z+1))} for a,z in ranges]}\nout=json.dumps(record)\nassert len(out)<14000,len(out)\nprint(out)\n\nPY"
      }
    },
    {
      "path": "security/p001-transformers-node-entry-excerpts2-20261106-v1.json",
      "content": {
        "schema": "p001-transformers-node-entry-static-excerpts-v1",
        "path": "dist/transformers.node.mjs",
        "sha256": "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d",
        "candidateExecution": false,
        "ranges": [
          {
            "start": 14,
            "end": 155,
            "text": "14: import fs from \"fs\";\n15: import path from \"path\";\n16: import url from \"url\";\n17: var VERSION = \"4.2.0\";\n18: var HAS_SELF = typeof self !== \"undefined\";\n19: var IS_FS_AVAILABLE = !isEmpty(fs);\n20: var IS_PATH_AVAILABLE = !isEmpty(path);\n21: var IS_WEB_CACHE_AVAILABLE = HAS_SELF && \"caches\" in self;\n22: var IS_DENO_RUNTIME = typeof globalThis.Deno !== \"undefined\";\n23: var IS_BUN_RUNTIME = typeof globalThis.Bun !== \"undefined\";\n24: var IS_DENO_WEB_RUNTIME = IS_DENO_RUNTIME && IS_WEB_CACHE_AVAILABLE && !IS_FS_AVAILABLE;\n25: var IS_PROCESS_AVAILABLE = typeof process !== \"undefined\";\n26: var IS_NODE_ENV = IS_PROCESS_AVAILABLE && process?.release?.name === \"node\" && !IS_DENO_WEB_RUNTIME;\n27: var IS_BROWSER_ENV = typeof window !== \"undefined\" && typeof window.document !== \"undefined\";\n28: var IS_WEBWORKER_ENV = HAS_SELF && [\"DedicatedWorkerGlobalScope\", \"ServiceWorkerGlobalScope\", \"SharedWorkerGlobalScope\"].includes(\n29:   self.constructor?.name\n30: );\n31: var IS_WEB_ENV = IS_BROWSER_ENV || IS_WEBWORKER_ENV || IS_DENO_WEB_RUNTIME;\n32: var IS_WEBGPU_AVAILABLE = IS_NODE_ENV || typeof navigator !== \"undefined\" && \"gpu\" in navigator;\n33: var IS_WEBNN_AVAILABLE = typeof navigator !== \"undefined\" && \"ml\" in navigator;\n34: var IS_CRYPTO_AVAILABLE = typeof crypto !== \"undefined\" && typeof crypto.getRandomValues === \"function\";\n35: var IS_CHROME_AVAILABLE = (\n36:   // @ts-ignore - chrome may not exist in all environments\n37:   typeof chrome !== \"undefined\" && typeof chrome.runtime !== \"undefined\" && typeof chrome.runtime.id === \"string\"\n38: );\n39: var IS_SERVICE_WORKER_ENV = (\n40:   // @ts-ignore - ServiceWorkerGlobalScope may not exist in all environments\n41:   typeof ServiceWorkerGlobalScope !== \"undefined\" && HAS_SELF && self instanceof ServiceWorkerGlobalScope\n42: );\n43: var isSafari = () => {\n44:   if (typeof navigator === \"undefined\") {\n45:     return false;\n46:   }\n47:   const userAgent = navigator.userAgent;\n48:   const vendor = navigator.vendor || \"\";\n49:   const isAppleVendor = vendor.indexOf(\"Apple\") > -1;\n50:   const notOtherBrowser = !userAgent.match(/CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i) && !userAgent.includes(\"Chrome\") && !userAgent.includes(\"Android\");\n51:   return isAppleVendor && notOtherBrowser;\n52: };\n53: var IS_SAFARI = isSafari();\n54: var apis = Object.freeze({\n55:   /** Whether we are running in a browser environment (and not a web worker) */\n56:   IS_BROWSER_ENV,\n57:   /** Whether we are running in a web worker environment */\n58:   IS_WEBWORKER_ENV,\n59:   /** Whether we are running in a web-like environment (browser, web worker, or Deno web runtime) */\n60:   IS_WEB_ENV,\n61:   /** Whether we are running in a service worker environment */\n62:   IS_SERVICE_WORKER_ENV,\n63:   /** Whether we are running in Deno's web runtime (CDN imports, Cache API available, no filesystem) */\n64:   IS_DENO_WEB_RUNTIME,\n65:   /** Whether the Cache API is available */\n66:   IS_WEB_CACHE_AVAILABLE,\n67:   /** Whether the WebGPU API is available */\n68:   IS_WEBGPU_AVAILABLE,\n69:   /** Whether the WebNN API is available */\n70:   IS_WEBNN_AVAILABLE,\n71:   /** Whether we are running in a Safari browser */\n72:   IS_SAFARI,\n73:   /** Whether the Node.js process API is available */\n74:   IS_PROCESS_AVAILABLE,\n75:   /** Whether we are running in a Node.js-like environment (node, deno, bun) */\n76:   IS_NODE_ENV,\n77:   /** Whether the filesystem API is available */\n78:   IS_FS_AVAILABLE,\n79:   /** Whether the path API is available */\n80:   IS_PATH_AVAILABLE,\n81:   /** Whether the crypto API is available */\n82:   IS_CRYPTO_AVAILABLE,\n83:   /** Whether the Chrome runtime API is available */\n84:   IS_CHROME_AVAILABLE\n85: });\n86: var RUNNING_LOCALLY = IS_FS_AVAILABLE && IS_PATH_AVAILABLE;\n87: var dirname__ = \"./\";\n88: if (RUNNING_LOCALLY) {\n89:   const _import_meta_url = Object(import.meta).url;\n90:   if (_import_meta_url) {\n91:     dirname__ = path.dirname(path.dirname(url.fileURLToPath(_import_meta_url)));\n92:   } else if (typeof __dirname !== \"undefined\") {\n93:     dirname__ = path.dirname(__dirname);\n94:   }\n95: }\n96: var DEFAULT_CACHE_DIR = RUNNING_LOCALLY ? path.join(dirname__, \"/.cache/\") : null;\n97: var DEFAULT_LOCAL_MODEL_PATH = \"/models/\";\n98: var localModelPath = RUNNING_LOCALLY ? path.join(dirname__, DEFAULT_LOCAL_MODEL_PATH) : DEFAULT_LOCAL_MODEL_PATH;\n99: var DEFAULT_FETCH = typeof globalThis.fetch === \"function\" ? globalThis.fetch.bind(globalThis) : void 0;\n100: var LogLevel = Object.freeze({\n101:   /** All messages including debug output (value: 10) */\n102:   DEBUG: 10,\n103:   /** Errors, warnings, and info messages (value: 20) */\n104:   INFO: 20,\n105:   /** Errors and warnings (value: 30) */\n106:   WARNING: 30,\n107:   /** Only error messages (value: 40) */\n108:   ERROR: 40,\n109:   /** No logging output (value: 50) */\n110:   NONE: 50\n111: });\n112: var logLevel = LogLevel.WARNING;\n113: var env = {\n114:   version: VERSION,\n115:   /////////////////// Backends settings ///////////////////\n116:   // NOTE: These will be populated later by the backends themselves.\n117:   backends: {\n118:     // onnxruntime-web/onnxruntime-node\n119:     onnx: {}\n120:   },\n121:   /////////////////// Logging settings ///////////////////\n122:   get logLevel() {\n123:     return logLevel;\n124:   },\n125:   set logLevel(level) {\n126:     logLevel = level;\n127:     env.backends.onnx?.setLogLevel?.(level);\n128:   },\n129:   /////////////////// Model settings ///////////////////\n130:   allowRemoteModels: true,\n131:   remoteHost: \"https://huggingface.co/\",\n132:   remotePathTemplate: \"{model}/resolve/{revision}/\",\n133:   allowLocalModels: !(IS_BROWSER_ENV || IS_WEBWORKER_ENV || IS_DENO_WEB_RUNTIME),\n134:   // Default to true for non-web environments, false for web environments\n135:   localModelPath,\n136:   useFS: IS_FS_AVAILABLE,\n137:   /////////////////// Cache settings ///////////////////\n138:   useBrowserCache: IS_WEB_CACHE_AVAILABLE,\n139:   useFSCache: IS_FS_AVAILABLE,\n140:   cacheDir: DEFAULT_CACHE_DIR,\n141:   useCustomCache: false,\n142:   customCache: null,\n143:   useWasmCache: IS_WEB_CACHE_AVAILABLE || IS_FS_AVAILABLE,\n144:   cacheKey: \"transformers-cache\",\n145:   experimental_useCrossOriginStorage: false,\n146:   /////////////////// Custom fetch /////////////////////\n147:   fetch: DEFAULT_FETCH\n148:   //////////////////////////////////////////////////////\n149: };\n150: function isEmpty(obj) {\n151:   return Object.keys(obj).length === 0;\n152: }\n153: \n154: // src/utils/generic.js\n155: var Callable = ("
          }
        ],
        "captureCommand": "python3 - <<'PY'\n\nimport urllib.request,tarfile,io,hashlib,json,re\nurl='https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz'\nb=urllib.request.urlopen(url,timeout=20).read()\nassert len(b)==2162844 and hashlib.sha256(b).hexdigest()=='0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee'\nt=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz')\np='dist/transformers.node.mjs'; source=t.extractfile('package/'+p).read()\nassert len(source)==1256499 and hashlib.sha256(source).hexdigest()=='4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d'\nlines=source.decode().splitlines()\nranges=[[14,155]]\nrecord={'schema':'p001-transformers-node-entry-static-excerpts-v1','path':p,'sha256':hashlib.sha256(source).hexdigest(),'candidateExecution':False,'ranges':[{'start':a,'end':z,'text':'\\n'.join(str(i)+': '+lines[i-1] for i in range(a,z+1))} for a,z in ranges]}\nout=json.dumps(record)\nassert len(out)<14000,len(out)\nprint(out)\n\nPY"
      }
    },
    {
      "path": "security/p001-transformers-node-entry-excerpts3-20261106-v1.json",
      "content": {
        "schema": "p001-transformers-node-entry-static-excerpts-v1",
        "path": "dist/transformers.node.mjs",
        "sha256": "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d",
        "candidateExecution": false,
        "ranges": [
          {
            "start": 6170,
            "end": 6310,
            "text": "6170:    * permanently prevents `match` from resolving the file. For LFS-backed URLs, `match` will\n6171:    * re-fetch the LFS pointer file on the next call and repopulate the hash cache automatically.\n6172:    *\n6173:    * Implements `CacheInterface.delete`.\n6174:    *\n6175:    * @param {string} request\n6176:    * @returns {Promise<boolean>} Resolves to `true` if the hash entry was deleted, `false` otherwise.\n6177:    */\n6178:   delete = async (request) => {\n6179:     try {\n6180:       const hashCache = await this._getHashCache();\n6181:       return await hashCache.delete(request);\n6182:     } catch {\n6183:       return false;\n6184:     }\n6185:   };\n6186:   /**\n6187:    * Resolves the SHA-256 hash for a given URL.\n6188:    *\n6189:    * Returns the cached hash immediately if one has been persisted to `HASH_CACHE_NAME`.\n6190:    * Otherwise falls back to `_getLfsFileHash` to retrieve the hash from the Hugging Face\n6191:    * LFS pointer file, persisting the result to `HASH_CACHE_NAME` for future lookups.\n6192:    *\n6193:    * Returns `null` if the hash cannot be determined (e.g. non-LFS URL with no cached entry).\n6194:    *\n6195:    * @param {string} url The resource URL to resolve a hash for.\n6196:    * @returns {Promise<string|null>} The hex-encoded SHA-256 hash, or `null` if unavailable.\n6197:    */\n6198:   _getFileHash = async (url2) => {\n6199:     try {\n6200:       const hashCache = await this._getHashCache();\n6201:       const cached = await hashCache.match(url2);\n6202:       if (cached) {\n6203:         return cached.text();\n6204:       }\n6205:       const hash = await this._getLfsFileHash(url2);\n6206:       if (hash) {\n6207:         await hashCache.put(url2, new Response(hash));\n6208:         return hash;\n6209:       }\n6210:       return null;\n6211:     } catch {\n6212:       return null;\n6213:     }\n6214:   };\n6215:   /**\n6216:    * Attempts to retrieve the SHA-256 hash for a Hugging Face resource URL from its raw\n6217:    * Git LFS pointer file.\n6218:    *\n6219:    * Only applicable to URLs containing `/resolve/` (i.e. Hugging Face resolved file URLs).\n6220:    * The `/resolve/` segment is rewritten to `/raw/` to fetch the LFS pointer directly.\n6221:    * Returns `null` for non-LFS URLs or when the network request fails.\n6222:    *\n6223:    * @see https://huggingface.co/docs/hub/en/storage-backends#xet\n6224:    * @param {string} url The resolved Hugging Face URL of the resource.\n6225:    * @returns {Promise<string|null>} The hex-encoded SHA-256 hash, or `null` if unavailable.\n6226:    */\n6227:   _getLfsFileHash = async (url2) => {\n6228:     if (!url2.includes(\"/resolve/\")) {\n6229:       return null;\n6230:     }\n6231:     const rawUrl = url2.replace(\"/resolve/\", \"/raw/\");\n6232:     try {\n6233:       const text = await fetch(rawUrl).then((r) => r.text());\n6234:       const match = text.match(/^oid sha256:([0-9a-f]+)$/m);\n6235:       return match ? match[1] : null;\n6236:     } catch {\n6237:       return null;\n6238:     }\n6239:   };\n6240:   /**\n6241:    * Computes the SHA-256 hash of a `Blob`'s contents.\n6242:    *\n6243:    * @param {Blob} blob The blob to hash.\n6244:    * @returns {Promise<string>} The lowercase hex-encoded SHA-256 hash.\n6245:    */\n6246:   _getBlobHash = async (blob) => {\n6247:     const arrayBuffer = await blob.arrayBuffer();\n6248:     const hashBuffer = await crypto.subtle.digest(HASH_ALGORITHM, arrayBuffer);\n6249:     const hashArray = Array.from(new Uint8Array(hashBuffer));\n6250:     return hashArray.map((byte) => byte.toString(16).padStart(2, \"0\")).join(\"\");\n6251:   };\n6252: };\n6253: \n6254: // src/utils/cache.js\n6255: async function getCache(file_cache_dir = null) {\n6256:   let cache2 = null;\n6257:   if (env.useCustomCache) {\n6258:     if (!env.customCache) {\n6259:       throw Error(\"`env.useCustomCache=true`, but `env.customCache` is not defined.\");\n6260:     }\n6261:     if (!env.customCache.match || !env.customCache.put) {\n6262:       throw new Error(\n6263:         \"`env.customCache` must be an object which implements the `match` and `put` functions of the Web Cache API. For more information, see https://developer.mozilla.org/en-US/docs/Web/API/Cache\"\n6264:       );\n6265:     }\n6266:     cache2 = env.customCache;\n6267:   }\n6268:   if (!cache2 && env.experimental_useCrossOriginStorage && CrossOriginStorage.isAvailable()) {\n6269:     cache2 = new CrossOriginStorage();\n6270:   }\n6271:   if (!cache2 && env.useBrowserCache) {\n6272:     if (typeof caches === \"undefined\") {\n6273:       throw Error(\"Browser cache is not available in this environment.\");\n6274:     }\n6275:     try {\n6276:       cache2 = await caches.open(env.cacheKey);\n6277:     } catch (e) {\n6278:       logger.warn(\"An error occurred while opening the browser cache:\", e);\n6279:     }\n6280:   }\n6281:   if (!cache2 && env.useFSCache) {\n6282:     if (!apis.IS_FS_AVAILABLE) {\n6283:       throw Error(\"File System Cache is not available in this environment.\");\n6284:     }\n6285:     cache2 = new FileCache(file_cache_dir ?? env.cacheDir);\n6286:   }\n6287:   return cache2;\n6288: }\n6289: async function tryCache(cache2, ...names) {\n6290:   for (let name of names) {\n6291:     try {\n6292:       let result = await cache2.match(name);\n6293:       if (result) return result;\n6294:     } catch (e) {\n6295:       continue;\n6296:     }\n6297:   }\n6298:   return void 0;\n6299: }\n6300: \n6301: // src/utils/lru_cache.js\n6302: var LRUCache2 = class {\n6303:   /** @type {number} */\n6304:   #capacity;\n6305:   /** @type {Map<any, any>} */\n6306:   #cache;\n6307:   /**\n6308:    * Creates an LRUCache instance.\n6309:    * @param {number} capacity The maximum number of items the cache can hold.\n6310:    */"
          }
        ],
        "captureCommand": "python3 - <<'PY'\n\nimport urllib.request,tarfile,io,hashlib,json,re\nurl='https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz'\nb=urllib.request.urlopen(url,timeout=20).read()\nassert len(b)==2162844 and hashlib.sha256(b).hexdigest()=='0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee'\nt=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz')\np='dist/transformers.node.mjs'; source=t.extractfile('package/'+p).read()\nassert len(source)==1256499 and hashlib.sha256(source).hexdigest()=='4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d'\nlines=source.decode().splitlines()\nranges=[[6170,6310]]\nrecord={'schema':'p001-transformers-node-entry-static-excerpts-v1','path':p,'sha256':hashlib.sha256(source).hexdigest(),'candidateExecution':False,'ranges':[{'start':a,'end':z,'text':'\\n'.join(str(i)+': '+lines[i-1] for i in range(a,z+1))} for a,z in ranges]}\nout=json.dumps(record)\nassert len(out)<14000,len(out)\nprint(out)\n\nPY"
      }
    },
    {
      "path": "security/p001-transformers-node-entry-excerpts4-20261106-v1.json",
      "content": {
        "schema": "p001-transformers-node-entry-static-excerpts-v1",
        "path": "dist/transformers.node.mjs",
        "sha256": "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d",
        "candidateExecution": false,
        "ranges": [
          {
            "start": 6365,
            "end": 6435,
            "text": "6365:     return cached;\n6366:   }\n6367:   const promise = factory().then(\n6368:     (value) => value,\n6369:     (err) => {\n6370:       cache.delete(key);\n6371:       return Promise.reject(err);\n6372:     }\n6373:   );\n6374:   cache.put(key, promise);\n6375:   return promise;\n6376: }\n6377: \n6378: // src/utils/model_registry/get_file_metadata.js\n6379: async function fetch_file_head(urlOrPath) {\n6380:   if (!isValidUrl(urlOrPath, [\"http:\", \"https:\"])) {\n6381:     return null;\n6382:   }\n6383:   const headers = getFetchHeaders(urlOrPath);\n6384:   headers.set(\"Range\", \"bytes=0-0\");\n6385:   return env.fetch(urlOrPath, { method: \"GET\", headers, cache: \"no-store\" });\n6386: }\n6387: function get_file_metadata(path_or_repo_id, filename, options = {}) {\n6388:   const key = JSON.stringify([\n6389:     path_or_repo_id,\n6390:     filename,\n6391:     options?.revision,\n6392:     options?.cache_dir,\n6393:     options?.local_files_only\n6394:   ]);\n6395:   return memoizePromise(key, () => _get_file_metadata(path_or_repo_id, filename, options));\n6396: }\n6397: async function _get_file_metadata(path_or_repo_id, filename, options) {\n6398:   const cache2 = await getCache(options?.cache_dir);\n6399:   const { localPath, remoteURL, proposedCacheKey, validModelId } = buildResourcePaths(\n6400:     path_or_repo_id,\n6401:     filename,\n6402:     options,\n6403:     cache2\n6404:   );\n6405:   const cachedResponse = await checkCachedResource(cache2, localPath, proposedCacheKey);\n6406:   if (cachedResponse !== void 0 && typeof cachedResponse !== \"string\") {\n6407:     const size = cachedResponse.headers.get(\"content-length\");\n6408:     const contentType = cachedResponse.headers.get(\"content-type\");\n6409:     return {\n6410:       exists: true,\n6411:       size: size ? parseInt(size, 10) : void 0,\n6412:       contentType: contentType || void 0,\n6413:       fromCache: true\n6414:     };\n6415:   }\n6416:   if (env.allowLocalModels) {\n6417:     const isURL = isValidUrl(localPath, [\"http:\", \"https:\"]);\n6418:     if (!isURL) {\n6419:       try {\n6420:         const response = await getFile(localPath);\n6421:         if (typeof response !== \"string\" && response.status !== 404) {\n6422:           const size = response.headers.get(\"content-length\");\n6423:           const contentType = response.headers.get(\"content-type\");\n6424:           return {\n6425:             exists: true,\n6426:             size: size ? parseInt(size, 10) : void 0,\n6427:             contentType: contentType || void 0,\n6428:             fromCache: false\n6429:           };\n6430:         }\n6431:       } catch (e) {\n6432:       }\n6433:     }\n6434:   }\n6435:   if (env.allowRemoteModels && !options.local_files_only && validModelId) {"
          },
          {
            "start": 6470,
            "end": 6530,
            "text": "6470:   return { exists: false, fromCache: false };\n6471: }\n6472: \n6473: // src/utils/hub.js\n6474: async function getFile(urlOrPath) {\n6475:   if (env.useFS && !isValidUrl(urlOrPath, [\"http:\", \"https:\", \"blob:\"])) {\n6476:     return new FileResponse(\n6477:       urlOrPath instanceof URL ? urlOrPath.protocol === \"file:\" ? urlOrPath.pathname : urlOrPath.toString() : urlOrPath\n6478:     );\n6479:   } else {\n6480:     return env.fetch(urlOrPath, {\n6481:       headers: getFetchHeaders(urlOrPath)\n6482:     });\n6483:   }\n6484: }\n6485: function getFetchHeaders(urlOrPath) {\n6486:   const isNode = typeof process !== \"undefined\" && process?.release?.name === \"node\";\n6487:   const headers = new Headers();\n6488:   if (isNode) {\n6489:     const IS_CI = !!process.env?.TESTING_REMOTELY;\n6490:     const version = env.version;\n6491:     headers.set(\"User-Agent\", `transformers.js/${version}; is_ci/${IS_CI};`);\n6492:     const isHFURL = isValidUrl(urlOrPath, [\"http:\", \"https:\"], [\"huggingface.co\", \"hf.co\"]);\n6493:     if (isHFURL) {\n6494:       const token = process.env?.HF_TOKEN ?? process.env?.HF_ACCESS_TOKEN;\n6495:       if (token) {\n6496:         headers.set(\"Authorization\", `Bearer ${token}`);\n6497:       }\n6498:     }\n6499:   } else {\n6500:   }\n6501:   return headers;\n6502: }\n6503: function buildResourcePaths(path_or_repo_id, filename, options = {}, cache2 = null) {\n6504:   const revision = options.revision ?? \"main\";\n6505:   const requestURL = pathJoin(path_or_repo_id, filename);\n6506:   const validModelId = isValidHfModelId(path_or_repo_id);\n6507:   const localPath = validModelId ? pathJoin(env.localModelPath, requestURL) : requestURL;\n6508:   const remoteURL = pathJoin(\n6509:     env.remoteHost,\n6510:     env.remotePathTemplate.replaceAll(\"{model}\", path_or_repo_id).replaceAll(\"{revision}\", encodeURIComponent(revision)),\n6511:     filename\n6512:   );\n6513:   const proposedCacheKey = cache2 instanceof FileCache ? (\n6514:     // Choose cache key for filesystem cache\n6515:     // When using the main revision (default), we use the request URL as the cache key.\n6516:     // If a specific revision is requested, we account for this in the cache key.\n6517:     revision === \"main\" ? requestURL : pathJoin(path_or_repo_id, revision, filename)\n6518:   ) : remoteURL;\n6519:   return {\n6520:     requestURL,\n6521:     localPath,\n6522:     remoteURL,\n6523:     proposedCacheKey,\n6524:     validModelId\n6525:   };\n6526: }\n6527: async function checkCachedResource(cache2, localPath, proposedCacheKey) {\n6528:   if (!cache2) {\n6529:     return void 0;\n6530:   }"
          },
          {
            "start": 6570,
            "end": 6630,
            "text": "6570:     filename,\n6571:     options,\n6572:     cache2\n6573:   );\n6574:   let cacheKey;\n6575:   let toCacheResponse = false;\n6576:   let response;\n6577:   response = await checkCachedResource(cache2, localPath, proposedCacheKey);\n6578:   const cacheHit = response !== void 0;\n6579:   if (cacheHit) {\n6580:     cacheKey = proposedCacheKey;\n6581:   } else {\n6582:     if (env.allowLocalModels) {\n6583:       const isURL = isValidUrl(requestURL, [\"http:\", \"https:\"]);\n6584:       if (!isURL) {\n6585:         try {\n6586:           response = await getFile(localPath);\n6587:           cacheKey = localPath;\n6588:         } catch (e) {\n6589:           logger.warn(`Unable to load from local path \"${localPath}\": \"${e}\"`);\n6590:         }\n6591:       } else if (options.local_files_only) {\n6592:         throw new Error(`\\`local_files_only=true\\`, but attempted to load a remote file from: ${requestURL}.`);\n6593:       } else if (!env.allowRemoteModels) {\n6594:         throw new Error(\n6595:           `\\`env.allowRemoteModels=false\\`, but attempted to load a remote file from: ${requestURL}.`\n6596:         );\n6597:       }\n6598:     }\n6599:     if (response === void 0 || typeof response !== \"string\" && response.status === 404) {\n6600:       if (options.local_files_only || !env.allowRemoteModels) {\n6601:         if (fatal) {\n6602:           throw Error(\n6603:             `\\`local_files_only=true\\` or \\`env.allowRemoteModels=false\\` and file was not found locally at \"${localPath}\".`\n6604:           );\n6605:         } else {\n6606:           return null;\n6607:         }\n6608:       }\n6609:       if (!validModelId) {\n6610:         throw Error(\n6611:           `Local file missing at \"${localPath}\" and download aborted due to invalid model ID \"${path_or_repo_id}\".`\n6612:         );\n6613:       }\n6614:       response = await getFile(remoteURL);\n6615:       if (response.status !== 200) {\n6616:         return handleError(response.status, remoteURL, fatal);\n6617:       }\n6618:       cacheKey = proposedCacheKey;\n6619:     }\n6620:     toCacheResponse = cache2 && // 1. A caching system is available\n6621:     typeof Response !== \"undefined\" && // 2. `Response` is defined (i.e., we are in a browser-like environment)\n6622:     response instanceof Response && // 3. result is a `Response` object (i.e., not a `FileResponse`)\n6623:     response.status === 200;\n6624:   }\n6625:   dispatchCallback(options.progress_callback, {\n6626:     status: \"download\",\n6627:     name: path_or_repo_id,\n6628:     file: filename\n6629:   });\n6630:   let result;"
          }
        ],
        "captureCommand": "python3 - <<'PY'\n\nimport urllib.request,tarfile,io,hashlib,json,re\nurl='https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz'\nb=urllib.request.urlopen(url,timeout=20).read()\nassert len(b)==2162844 and hashlib.sha256(b).hexdigest()=='0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee'\nt=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz')\np='dist/transformers.node.mjs'; source=t.extractfile('package/'+p).read()\nassert len(source)==1256499 and hashlib.sha256(source).hexdigest()=='4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d'\nlines=source.decode().splitlines()\nranges=[[6365,6435],[6470,6530],[6570,6630]]\nrecord={'schema':'p001-transformers-node-entry-static-excerpts-v1','path':p,'sha256':hashlib.sha256(source).hexdigest(),'candidateExecution':False,'ranges':[{'start':a,'end':z,'text':'\\n'.join(str(i)+': '+lines[i-1] for i in range(a,z+1))} for a,z in ranges]}\nout=json.dumps(record)\nassert len(out)<14000,len(out)\nprint(out)\n\nPY"
      }
    },
    {
      "path": "security/p001-transformers-node-entry-excerpts5-20261106-v1.json",
      "content": {
        "schema": "p001-transformers-node-entry-static-excerpts-v1",
        "path": "dist/transformers.node.mjs",
        "sha256": "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d",
        "candidateExecution": false,
        "ranges": [
          {
            "start": 11425,
            "end": 11500,
            "text": "11425:       Ws(), await Ms(), await Cs(r);\n11426:     }\n11427:     async createInferenceSessionHandler(r, s) {\n11428:       let f = new pr();\n11429:       return await f.loadModel(r, s), f;\n11430:     }\n11431:   }, Tc = new mr();\n11432: });\n11433: Ve();\n11434: Ve();\n11435: Ve();\n11436: var Ja = \"1.26.0-dev.20260416-b7804b056c\";\n11437: var gl = Zr;\n11438: {\n11439:   let a = (Gs(), $t(Fs)).wasmBackend;\n11440:   Ke(\"webgpu\", a, 5), Ke(\"webnn\", a, 5), Ke(\"cpu\", a, 10), Ke(\"wasm\", a, 10);\n11441: }\n11442: Object.defineProperty(K.versions, \"web\", { value: Ja, enumerable: true });\n11443: \n11444: // src/backends/utils/cacheWasm.js\n11445: async function loadAndCacheFile(url2) {\n11446:   const fileName = url2.split(\"/\").pop();\n11447:   let cache2;\n11448:   try {\n11449:     cache2 = await getCache();\n11450:     if (cache2) {\n11451:       const result = await cache2.match(url2);\n11452:       if (result) {\n11453:         return result;\n11454:       }\n11455:     }\n11456:   } catch (error) {\n11457:     logger.warn(`Failed to load ${fileName} from cache:`, error);\n11458:   }\n11459:   const response = await env.fetch(url2);\n11460:   if (!response.ok) {\n11461:     throw new Error(`Failed to fetch ${fileName}: ${response.status} ${response.statusText}`);\n11462:   }\n11463:   if (cache2) {\n11464:     try {\n11465:       await cache2.put(url2, response.clone());\n11466:     } catch (e) {\n11467:       logger.warn(`Failed to cache ${fileName}:`, e);\n11468:     }\n11469:   }\n11470:   return response;\n11471: }\n11472: async function loadWasmBinary(wasmURL) {\n11473:   const response = await loadAndCacheFile(wasmURL);\n11474:   if (!response || typeof response === \"string\") return null;\n11475:   try {\n11476:     return await response.arrayBuffer();\n11477:   } catch (error) {\n11478:     logger.warn(\"Failed to read WASM binary:\", error);\n11479:     return null;\n11480:   }\n11481: }\n11482: async function loadWasmFactory(libURL) {\n11483:   if (apis.IS_SERVICE_WORKER_ENV || apis.IS_CHROME_AVAILABLE) {\n11484:     return libURL;\n11485:   }\n11486:   const response = await loadAndCacheFile(libURL);\n11487:   if (!response || typeof response === \"string\") return null;\n11488:   try {\n11489:     let code = await response.text();\n11490:     code = code.replaceAll(\"globalThis.process?.versions?.node\", \"false\");\n11491:     const blob = new Blob([code], { type: \"text/javascript\" });\n11492:     return URL.createObjectURL(blob);\n11493:   } catch (error) {\n11494:     logger.warn(\"Failed to read WASM factory:\", error);\n11495:     return null;\n11496:   }\n11497: }\n11498: \n11499: // src/backends/onnx.js\n11500: import { Tensor } from \"onnxruntime-common\";"
          },
          {
            "start": 11540,
            "end": 11680,
            "text": "11540: var ONNX_LOG_LEVEL_NAMES = {\n11541:   0: \"verbose\",\n11542:   1: \"info\",\n11543:   2: \"warning\",\n11544:   3: \"error\",\n11545:   4: \"fatal\"\n11546: };\n11547: var supportedDevices = [];\n11548: var defaultDevices;\n11549: var ONNX;\n11550: var ORT_SYMBOL = /* @__PURE__ */ Symbol.for(\"onnxruntime\");\n11551: if (ORT_SYMBOL in globalThis) {\n11552:   ONNX = globalThis[ORT_SYMBOL];\n11553: } else if (apis.IS_NODE_ENV) {\n11554:   ONNX = ONNX_NODE;\n11555:   switch (process.platform) {\n11556:     case \"win32\":\n11557:       supportedDevices.push(\"dml\");\n11558:       break;\n11559:     case \"linux\":\n11560:       if (process.arch === \"x64\") {\n11561:         supportedDevices.push(\"cuda\");\n11562:       }\n11563:       break;\n11564:     case \"darwin\":\n11565:       supportedDevices.push(\"coreml\");\n11566:       break;\n11567:   }\n11568:   supportedDevices.push(\"webgpu\");\n11569:   supportedDevices.push(\"cpu\");\n11570:   defaultDevices = [\"cpu\"];\n11571: } else {\n11572:   ONNX = ort_webgpu_bundle_min_exports;\n11573:   if (apis.IS_WEBNN_AVAILABLE) {\n11574:     supportedDevices.push(\"webnn-npu\", \"webnn-gpu\", \"webnn-cpu\", \"webnn\");\n11575:   }\n11576:   if (apis.IS_WEBGPU_AVAILABLE) {\n11577:     supportedDevices.push(\"webgpu\");\n11578:   }\n11579:   supportedDevices.push(\"wasm\");\n11580:   defaultDevices = [\"wasm\"];\n11581: }\n11582: var InferenceSession = ONNX.InferenceSession;\n11583: function deviceToExecutionProviders(device = null) {\n11584:   if (!device) return defaultDevices;\n11585:   switch (device) {\n11586:     case \"auto\":\n11587:       return supportedDevices;\n11588:     case \"gpu\":\n11589:       return supportedDevices.filter((x) => [\"webgpu\", \"cuda\", \"dml\", \"webnn-gpu\"].includes(x));\n11590:   }\n11591:   if (supportedDevices.includes(device)) {\n11592:     return [DEVICE_TO_EXECUTION_PROVIDER_MAPPING[device] ?? device];\n11593:   }\n11594:   throw new Error(`Unsupported device: \"${device}\". Should be one of: ${supportedDevices.join(\", \")}.`);\n11595: }\n11596: var webInitChain = Promise.resolve();\n11597: var wasmLoadPromise = null;\n11598: async function ensureWasmLoaded() {\n11599:   if (wasmLoadPromise) {\n11600:     return wasmLoadPromise;\n11601:   }\n11602:   const shouldUseWasmCache = env.useWasmCache && typeof ONNX_ENV?.wasm?.wasmPaths === \"object\" && ONNX_ENV?.wasm?.wasmPaths?.wasm && ONNX_ENV?.wasm?.wasmPaths?.mjs;\n11603:   if (!shouldUseWasmCache) {\n11604:     if (apis.IS_DENO_WEB_RUNTIME) {\n11605:       throw new Error(\n11606:         \"env.useWasmCache=false is not supported in Deno's web runtime. Remove the useWasmCache override.\"\n11607:       );\n11608:     }\n11609:     wasmLoadPromise = Promise.resolve();\n11610:     return wasmLoadPromise;\n11611:   }\n11612:   wasmLoadPromise = (async () => {\n11613:     const urls = (\n11614:       /** @type {{ wasm: string, mjs: string }} */\n11615:       ONNX_ENV.wasm.wasmPaths\n11616:     );\n11617:     let wasmBinaryLoaded = false;\n11618:     await Promise.all([\n11619:       // Load and cache the WASM binary\n11620:       urls.wasm && !isBlobURL(urls.wasm) ? (async () => {\n11621:         try {\n11622:           const wasmBinary = await loadWasmBinary(toAbsoluteURL(urls.wasm));\n11623:           if (wasmBinary) {\n11624:             ONNX_ENV.wasm.wasmBinary = wasmBinary;\n11625:             wasmBinaryLoaded = true;\n11626:           }\n11627:         } catch (err) {\n11628:           logger.warn(\"Failed to pre-load WASM binary:\", err);\n11629:         }\n11630:       })() : Promise.resolve(),\n11631:       // Load and cache the WASM factory as a blob URL\n11632:       urls.mjs && !isBlobURL(urls.mjs) ? (async () => {\n11633:         try {\n11634:           const wasmFactoryBlob = await loadWasmFactory(toAbsoluteURL(urls.mjs));\n11635:           if (wasmFactoryBlob) {\n11636:             ONNX_ENV.wasm.wasmPaths.mjs = wasmFactoryBlob;\n11637:           }\n11638:         } catch (err) {\n11639:           logger.warn(\"Failed to pre-load WASM factory:\", err);\n11640:         }\n11641:       })() : Promise.resolve()\n11642:     ]);\n11643:     if (!wasmBinaryLoaded) {\n11644:       ONNX_ENV.wasm.wasmPaths.mjs = urls.mjs;\n11645:     }\n11646:   })();\n11647:   return wasmLoadPromise;\n11648: }\n11649: async function createInferenceSession(buffer_or_path, session_options, session_config) {\n11650:   await ensureWasmLoaded();\n11651:   const logSeverityLevel = getOnnxLogSeverityLevel(env.logLevel ?? LogLevel.WARNING);\n11652:   const load = () => InferenceSession.create(buffer_or_path, {\n11653:     // Set default log severity level, but allow overriding through session options\n11654:     logSeverityLevel,\n11655:     ...session_options\n11656:   });\n11657:   const session = await (apis.IS_WEB_ENV ? webInitChain = webInitChain.then(load) : load());\n11658:   session.config = session_config;\n11659:   return session;\n11660: }\n11661: var webInferenceChain = Promise.resolve();\n11662: async function runInferenceSession(session, ortFeed) {\n11663:   const run = () => session.run(ortFeed);\n11664:   return apis.IS_WEB_ENV ? webInferenceChain = webInferenceChain.then(run) : run();\n11665: }\n11666: function isONNXTensor(x) {\n11667:   return x instanceof ONNX.Tensor;\n11668: }\n11669: var ONNX_ENV = ONNX?.env;\n11670: function isONNXProxy() {\n11671:   return ONNX_ENV?.wasm?.proxy;\n11672: }\n11673: if (ONNX_ENV) {\n11674:   let setLogLevel = function(logLevel2) {\n11675:     const severityLevel = getOnnxLogSeverityLevel(logLevel2);\n11676:     ONNX_ENV.logLevel = ONNX_LOG_LEVEL_NAMES[severityLevel];\n11677:   };\n11678:   if (ONNX_ENV.wasm) {\n11679:     if (\n11680:       // @ts-ignore Cannot find name 'ServiceWorkerGlobalScope'.ts(2304)"
          }
        ],
        "captureCommand": "python3 - <<'PY'\n\nimport urllib.request,tarfile,io,hashlib,json,re\nurl='https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz'\nb=urllib.request.urlopen(url,timeout=20).read()\nassert len(b)==2162844 and hashlib.sha256(b).hexdigest()=='0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee'\nt=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz')\np='dist/transformers.node.mjs'; source=t.extractfile('package/'+p).read()\nassert len(source)==1256499 and hashlib.sha256(source).hexdigest()=='4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d'\nlines=source.decode().splitlines()\nranges=[[11425,11500],[11540,11680]]\nrecord={'schema':'p001-transformers-node-entry-static-excerpts-v1','path':p,'sha256':hashlib.sha256(source).hexdigest(),'candidateExecution':False,'ranges':[{'start':a,'end':z,'text':'\\n'.join(str(i)+': '+lines[i-1] for i in range(a,z+1))} for a,z in ranges]}\nout=json.dumps(record)\nassert len(out)<14000,len(out)\nprint(out)\n\nPY"
      }
    },
    {
      "path": "security/p001-transformers-node-entry-excerpts6-20261106-v1.json",
      "content": {
        "schema": "p001-transformers-node-entry-static-excerpts-v1",
        "path": "dist/transformers.node.mjs",
        "sha256": "4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d",
        "candidateExecution": false,
        "ranges": [
          {
            "start": 6435,
            "end": 6485,
            "text": "6435:   if (env.allowRemoteModels && !options.local_files_only && validModelId) {\n6436:     try {\n6437:       const rangeResponse = await fetch_file_head(remoteURL);\n6438:       if (rangeResponse && rangeResponse.status >= 200 && rangeResponse.status < 300) {\n6439:         let size;\n6440:         const contentType = rangeResponse.headers.get(\"content-type\");\n6441:         if (rangeResponse.status === 206) {\n6442:           const contentRange = rangeResponse.headers.get(\"content-range\");\n6443:           if (contentRange) {\n6444:             const match = contentRange.match(/bytes \\d+-\\d+\\/(\\d+)/);\n6445:             if (match) {\n6446:               size = parseInt(match[1], 10);\n6447:             }\n6448:           }\n6449:         } else if (rangeResponse.status === 200) {\n6450:           try {\n6451:             await rangeResponse.body?.cancel();\n6452:           } catch (cancelError) {\n6453:           }\n6454:         }\n6455:         if (size === void 0) {\n6456:           const contentLength = rangeResponse.headers.get(\"content-length\");\n6457:           size = contentLength ? parseInt(contentLength, 10) : void 0;\n6458:         }\n6459:         return {\n6460:           exists: true,\n6461:           size,\n6462:           contentType: contentType || void 0,\n6463:           fromCache: false\n6464:         };\n6465:       }\n6466:     } catch (e) {\n6467:       logger.warn(`Unable to fetch file metadata for \"${remoteURL}\": ${e}`);\n6468:     }\n6469:   }\n6470:   return { exists: false, fromCache: false };\n6471: }\n6472: \n6473: // src/utils/hub.js\n6474: async function getFile(urlOrPath) {\n6475:   if (env.useFS && !isValidUrl(urlOrPath, [\"http:\", \"https:\", \"blob:\"])) {\n6476:     return new FileResponse(\n6477:       urlOrPath instanceof URL ? urlOrPath.protocol === \"file:\" ? urlOrPath.pathname : urlOrPath.toString() : urlOrPath\n6478:     );\n6479:   } else {\n6480:     return env.fetch(urlOrPath, {\n6481:       headers: getFetchHeaders(urlOrPath)\n6482:     });\n6483:   }\n6484: }\n6485: function getFetchHeaders(urlOrPath) {"
          },
          {
            "start": 9970,
            "end": 10005,
            "text": "9970:       return (s ? new URL(a, s) : new URL(a)).origin === as;\n9971:     } catch {\n9972:       return false;\n9973:     }\n9974:   }, Kf = (a, r) => {\n9975:     let s = r ?? ge;\n9976:     try {\n9977:       return (s ? new URL(a, s) : new URL(a)).href;\n9978:     } catch {\n9979:       return;\n9980:     }\n9981:   }, ec = (a, r) => `${r ?? \"./\"}${a}`, is = async (a) => {\n9982:     let s = await (await fetch(a, { credentials: \"same-origin\" })).blob();\n9983:     return URL.createObjectURL(s);\n9984:   }, tc = async (a) => (await import(\n9985:     /*webpackIgnore:true*/\n9986:     /*@vite-ignore*/\n9987:     a\n9988:   )).default, ns = (Ka(), $t(Za)).default, us = async () => {\n9989:     if (!ge) throw new Error(\"Failed to load proxy worker: cannot determine the script source URL.\");\n9990:     if (en(ge)) return [void 0, ns()];\n9991:     let a = await is(ge);\n9992:     return [a, ns(a)];\n9993:   }, os = (rs(), $t(ts)).default, fs4 = async (a, r, s, f) => {\n9994:     let i = os && !(a || r);\n9995:     if (i) if (ge) i = en(ge) || f && !s;\n9996:     else if (f && !s) i = true;\n9997:     else throw new Error(\"cannot determine the script source URL.\");\n9998:     if (i) return [void 0, os];\n9999:     {\n10000:       let d = \"ort-wasm-simd-threaded.asyncify.mjs\", l = a ?? Kf(d, r), m = s && l && !en(l, r), y = m ? await is(l) : l ?? ec(d, r);\n10001:       return [m ? y : void 0, await tc(y)];\n10002:     }\n10003:   };\n10004: });\n10005: var rn;"
          },
          {
            "start": 11673,
            "end": 11745,
            "text": "11673: if (ONNX_ENV) {\n11674:   let setLogLevel = function(logLevel2) {\n11675:     const severityLevel = getOnnxLogSeverityLevel(logLevel2);\n11676:     ONNX_ENV.logLevel = ONNX_LOG_LEVEL_NAMES[severityLevel];\n11677:   };\n11678:   if (ONNX_ENV.wasm) {\n11679:     if (\n11680:       // @ts-ignore Cannot find name 'ServiceWorkerGlobalScope'.ts(2304)\n11681:       !(typeof ServiceWorkerGlobalScope !== \"undefined\" && self instanceof ServiceWorkerGlobalScope) && ONNX_ENV.versions?.web && !ONNX_ENV.wasm.wasmPaths\n11682:     ) {\n11683:       const wasmPathPrefix = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNX_ENV.versions.web}/dist/`;\n11684:       ONNX_ENV.wasm.wasmPaths = apis.IS_SAFARI ? {\n11685:         mjs: `${wasmPathPrefix}ort-wasm-simd-threaded.mjs`,\n11686:         wasm: `${wasmPathPrefix}ort-wasm-simd-threaded.wasm`\n11687:       } : {\n11688:         mjs: `${wasmPathPrefix}ort-wasm-simd-threaded.asyncify.mjs`,\n11689:         wasm: `${wasmPathPrefix}ort-wasm-simd-threaded.asyncify.wasm`\n11690:       };\n11691:     }\n11692:     ONNX_ENV.wasm.proxy = false;\n11693:   }\n11694:   if (ONNX_ENV.webgpu) {\n11695:     ONNX_ENV.webgpu.powerPreference = \"high-performance\";\n11696:   }\n11697:   setLogLevel(env.logLevel ?? LogLevel.WARNING);\n11698:   env.backends.onnx = {\n11699:     ...ONNX_ENV,\n11700:     setLogLevel\n11701:   };\n11702: }\n11703: \n11704: // src/ops/registry.js\n11705: var wrap = async (session_bytes, session_options, names) => {\n11706:   const session = await createInferenceSession(new Uint8Array(session_bytes), session_options);\n11707:   return (\n11708:     /** @type {any} */\n11709:     (async (inputs) => {\n11710:       const proxied = isONNXProxy();\n11711:       const ortFeed = Object.fromEntries(\n11712:         Object.entries(inputs).map(([k2, v]) => [k2, (proxied ? v.clone() : v).ort_tensor])\n11713:       );\n11714:       const outputs = await runInferenceSession(session, ortFeed);\n11715:       if (Array.isArray(names)) {\n11716:         return names.map((n) => new Tensor2(outputs[n]));\n11717:       } else {\n11718:         return new Tensor2(outputs[\n11719:           /** @type {string} */\n11720:           names\n11721:         ]);\n11722:       }\n11723:     })\n11724:   );\n11725: };\n11726: var TensorOpRegistry = class {\n11727:   static session_options = {\n11728:     // TODO: Allow for multiple execution providers\n11729:     // executionProviders: ['webgpu'],\n11730:   };\n11731:   static get nearest_interpolate_4d() {\n11732:     if (!this._nearest_interpolate_4d) {\n11733:       this._nearest_interpolate_4d = wrap(\n11734:         [\n11735:           8,\n11736:           10,\n11737:           18,\n11738:           0,\n11739:           58,\n11740:           129,\n11741:           1,\n11742:           10,\n11743:           41,\n11744:           10,\n11745:           1,"
          }
        ],
        "captureCommand": "python3 - <<'PY'\n\nimport urllib.request,tarfile,io,hashlib,json,re\nurl='https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz'\nb=urllib.request.urlopen(url,timeout=20).read()\nassert len(b)==2162844 and hashlib.sha256(b).hexdigest()=='0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee'\nt=tarfile.open(fileobj=io.BytesIO(b),mode='r:gz')\np='dist/transformers.node.mjs'; source=t.extractfile('package/'+p).read()\nassert len(source)==1256499 and hashlib.sha256(source).hexdigest()=='4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d'\nlines=source.decode().splitlines()\nranges=[[6435,6485],[9970,10005],[11673,11745]]\nrecord={'schema':'p001-transformers-node-entry-static-excerpts-v1','path':p,'sha256':hashlib.sha256(source).hexdigest(),'candidateExecution':False,'ranges':[{'start':a,'end':z,'text':'\\n'.join(str(i)+': '+lines[i-1] for i in range(a,z+1))} for a,z in ranges]}\nout=json.dumps(record)\nassert len(out)<14000,len(out)\nprint(out)\n\nPY"
      }
    }
  ],
  "sourceFindings": [
    {
      "scope": "Both checksum-pinned Node entries; module-edge extraction",
      "source": "dist/transformers.node.mjs:7545,11500,17741; dist/transformers.node.cjs:8504,12460,18701",
      "finding": "Both entries load onnxruntime-node, onnxruntime-common and sharp at module scope in addition to built-in fs/path/url/stream modules. Selecting a later CPU backend or a global ONNX override does not remove ESM dependency evaluation or the earlier CJS requires. Native dependency effects and loaded artifact identity remain unqualified."
    },
    {
      "scope": "Pinned ESM environment and source branches",
      "source": "dist/transformers.node.mjs:86-149,11550-11582,11673-11701",
      "finding": "Initialization derives package-relative cache/model paths, captures globalThis.fetch, exposes mutable env settings, prefers globalThis[Symbol.for('onnxruntime')] when present, otherwise selects ONNX_NODE in Node and defaults devices to CPU. Platform alternatives include DML/CUDA/CoreML/WebGPU. Initialization also adjusts the selected ONNX environment/logging. These are source-level branches, not proof any particular provider loaded or was confined."
    },
    {
      "scope": "Pinned ESM filesystem/cache/model-loading branches",
      "source": "dist/transformers.node.mjs:5883-5924,6255-6298,6474-6525,6577-6629",
      "finding": "FileCache.put recursively creates directories, writes a temporary file from a response stream, invokes a progress callback, closes the stream and renames it; error paths remove the temporary file. getFile can open local FileResponse or invoke mutable env.fetch. Model fetch construction depends on supplied model/path, revision, local_files_only, env allowLocalModels/allowRemoteModels and cache settings. A custom cache supplies opaque match/put callbacks. Configured input/resource authority remains unqualified."
    },
    {
      "scope": "Pinned ESM credential-routing source only; no credential values read",
      "source": "dist/transformers.node.mjs:6383-6385,6485-6501",
      "finding": "HTTP fetch metadata uses getFetchHeaders. On Node, matching huggingface.co/hf.co URLs may attach HF_TOKEN or HF_ACCESS_TOKEN to Authorization; this is a source read of variable names only. Fetch, environment, URL and redirect effects require runtime policy and explicit qualification."
    },
    {
      "scope": "Pinned ESM bundled ORT browser/WASM branches; conditional reachability unqualified",
      "source": "dist/transformers.node.mjs:8216,8423,9981-10001,11445-11496,11598-11646",
      "finding": "Bundled ORT contains Worker construction, fetch/blob URLs and a computed dynamic import whose argument is Identifier a. WASM loading depends on env/ONNX wasmPaths and may fetch a binary or JS factory and create blob URLs. These possible code paths are not established as active in the supported Node worker. No native/WASM/worker code was executed."
    },
    {
      "scope": "Two-entry selected-call inventory only",
      "source": "security/p001-transformers-node-entry-ast-extraction-20261106-v2.json; security/p001-transformers-node-entry-source-verification-20261106-v1.json",
      "finding": "Offline TypeScript parsing found no parse diagnostics in either entry; independent Python line reads matched each recorded literal module edge and selected effect expression. The exact capture regex selects a subset of call forms. Lexical withinFunction is not an execution-phase proof; top-level-call samples explicitly omit other calls. This is not an exhaustive effect or occurrence population."
    },
    {
      "scope": "Evidence correction; preserve prior edition",
      "source": "security/p001-transformers-node-entry-ast-extraction-20261106-v1.json -> v2.json",
      "finding": "v1 Identifier.text was unsuitable as a literal-specifier discriminator. v2 labels the dynamic import as nonliteral with specifier:null and argumentExpression:'a'; independent source verification checks the expression. v1 is retained and superseded. A bounded-output preflight refused the first v2 attempt before saving; the reduced explicit top-level sample succeeded."
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
    "rootRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
    "lockSource": {
      "rootRevision": "42d905b5b2fcbea2bb651178a7ff3c905cf89626",
      "path": "package-lock.json",
      "gitBlob": "a8cb14da54bc33aedff29301c9abdcf1cab23133",
      "sha256": "a20ed6c4aa15befa12baf21a955bcadb1d91523c42b834961f1d28170e98cf42",
      "bytes": 1432077,
      "reusedRetainedIdentity": true
    },
    "packageRows": [
      "node_modules/sharp",
      "node_modules/onnxruntime-common"
    ],
    "instruction": "Read only these newly exposed named rows from the retained lock. Resolve pinned package entry source if integrity exists; otherwise preserve the historical artifact identity gap. Do not install/import or substitute current same-version registry bytes for unpinned historical installation."
  }
}
