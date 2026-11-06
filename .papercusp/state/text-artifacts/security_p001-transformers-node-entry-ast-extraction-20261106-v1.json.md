---
rel_path: "security/p001-transformers-node-entry-ast-extraction-20261106-v1.json"
updated_at: 1793941502418
_body: "content"
---

{
  "schema": "p001-transformers-node-entry-ast-extraction-v1",
  "recordedAt": "2026-11-06T05:05:01.832Z",
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
          "specifier": "a",
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
        },
        {
          "line": 20,
          "callee": "isEmpty",
          "expression": "isEmpty(path)"
        },
        {
          "line": 28,
          "callee": "[\"DedicatedWorkerGlobalScope\", \"ServiceWorkerGlobalScope\", \"SharedWorkerGlobalScope\"].includes",
          "expression": "[\"DedicatedWorkerGlobalScope\", \"ServiceWorkerGlobalScope\", \"SharedWorkerGlobalScope\"].includes( self.constructor?.name )"
        },
        {
          "line": 53,
          "callee": "isSafari",
          "expression": "isSafari()"
        },
        {
          "line": 54,
          "callee": "Object.freeze",
          "expression": "Object.freeze({ /** Whether we are running in a browser environment (and not a web worker) */ IS_BROWSER_ENV, /** Whether we are running in a web worker environment */ IS_WEBWORKER_ENV, /** Whether we are running in a web-like env"
        },
        {
          "line": 89,
          "callee": "Object",
          "expression": "Object(import.meta)"
        },
        {
          "line": 91,
          "callee": "path.dirname",
          "expression": "path.dirname(path.dirname(url.fileURLToPath(_import_meta_url)))"
        }
      ],
      "topLevelCallsOmitted": 195
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
          "expression": "require(\"fs\")",
          "withinFunction": false
        },
        {
          "kind": "require",
          "line": 972,
          "specifier": "path",
          "expression": "require(\"path\")",
          "withinFunction": false
        },
        {
          "kind": "require",
          "line": 973,
          "specifier": "url",
          "expression": "require(\"url\")",
          "withinFunction": false
        },
        {
          "kind": "require",
          "line": 6532,
          "specifier": "fs",
          "expression": "require(\"fs\")",
          "withinFunction": false
        },
        {
          "kind": "require",
          "line": 6645,
          "specifier": "fs",
          "expression": "require(\"fs\")",
          "withinFunction": false
        },
        {
          "kind": "require",
          "line": 6646,
          "specifier": "path",
          "expression": "require(\"path\")",
          "withinFunction": false
        },
        {
          "kind": "require",
          "line": 8504,
          "specifier": "onnxruntime-node",
          "expression": "require(\"onnxruntime-node\")",
          "withinFunction": false
        },
        {
          "kind": "dynamic-import",
          "line": 10944,
          "specifier": "a",
          "expression": "import( /*webpackIgnore:true*/ /*@vite-ignore*/ a )",
          "withinFunction": true
        },
        {
          "kind": "require",
          "line": 12460,
          "specifier": "onnxruntime-common",
          "expression": "require(\"onnxruntime-common\")",
          "withinFunction": false
        },
        {
          "kind": "require",
          "line": 16888,
          "specifier": "fs",
          "expression": "require(\"fs\")",
          "withinFunction": false
        },
        {
          "kind": "require",
          "line": 16889,
          "specifier": "stream",
          "expression": "require(\"stream\")",
          "withinFunction": false
        },
        {
          "kind": "require",
          "line": 16890,
          "specifier": "stream/promises",
          "expression": "require(\"stream/promises\")",
          "withinFunction": false
        },
        {
          "kind": "require",
          "line": 18701,
          "specifier": "sharp",
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
        },
        {
          "line": 971,
          "callee": "__toESM",
          "expression": "__toESM(require(\"fs\"), 1)"
        },
        {
          "line": 971,
          "callee": "require",
          "expression": "require(\"fs\")"
        },
        {
          "line": 972,
          "callee": "__toESM",
          "expression": "__toESM(require(\"path\"), 1)"
        },
        {
          "line": 972,
          "callee": "require",
          "expression": "require(\"path\")"
        },
        {
          "line": 973,
          "callee": "__toESM",
          "expression": "__toESM(require(\"url\"), 1)"
        },
        {
          "line": 973,
          "callee": "require",
          "expression": "require(\"url\")"
        }
      ],
      "topLevelCallsOmitted": 217
    }
  ],
  "captureCommand": "node <<'NODE'\n\nconst crypto=require('node:crypto'),zlib=require('node:zlib'),ts=require('typescript');\n(async()=>{\nconst url='https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz';\nconst archive=Buffer.from(await (await fetch(url)).arrayBuffer());\nif(crypto.createHash('sha256').update(archive).digest('hex')!=='0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee')throw Error('archive mismatch');\nconst tar=zlib.gunzipSync(archive), files=new Map();for(let off=0;off+512<=tar.length;){const h=tar.subarray(off,off+512);if(h.every(x=>x===0))break;const name=h.subarray(0,100).toString().replace(/\\0.*$/s,''), size=parseInt(h.subarray(124,136).toString().replace(/\\0.*$/s,'').trim(),8)||0;files.set(name,tar.subarray(off+512,off+512+size));off+=512+Math.ceil(size/512)*512;}\nconst expected={'dist/transformers.node.mjs':'4932ec78a6b136d97d09a12093afb476530d9aa099dbaf1f9822ad56bfe2bc3d','dist/transformers.node.cjs':'398bcef3e3b36d189d39c00dcf2e1c31e22e72ca83969c753800fa158c8df5a4'};\nconst out=[];\nfor(const [path,hash] of Object.entries(expected)){\n const b=files.get('package/'+path);if(!b||crypto.createHash('sha256').update(b).digest('hex')!==hash)throw Error('entry mismatch');\n const text=b.toString(), sf=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);\n const modules=[],effectCalls=[],topLevelCalls=[];let calls=0;\n const line=n=>sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1;\n const excerpt=n=>n.getText(sf).replace(/\\s+/g,' ').slice(0,230);\n const inFunction=n=>{for(let p=n.parent;p;p=p.parent){if(ts.isFunctionLike(p))return true;}return false};\n function visit(n){\n if(ts.isImportDeclaration(n))modules.push({kind:'static-import',line:line(n),specifier:n.moduleSpecifier.text,statement:excerpt(n)});\n if(ts.isCallExpression(n)||ts.isNewExpression(n)){calls++;const callee=n.expression.getText(sf);\n if(n.expression.kind===ts.SyntaxKind.ImportKeyword||/^(require|__require)$/.test(callee))modules.push({kind:n.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic-import':'require',line:line(n),specifier:n.arguments?.[0]?.text??null,expression:excerpt(n),withinFunction:inFunction(n)});\n if(/(?:fetch|readFile|writeFile|mkdir|access|stat|existsSync|readFileSync|createReadStream|createWriteStream|unlink|rename|InferenceSession.create|Worker|AudioContext|importScripts|createRequire|loadDynamicLibrary|dlopen|createObjectURL)$/.test(callee))effectCalls.push({line:line(n),callee,withinFunction:inFunction(n),expression:excerpt(n)});\n if(!inFunction(n))topLevelCalls.push({line:line(n),callee,expression:excerpt(n)});\n }\n ts.forEachChild(n,visit);\n }visit(sf);\n const report={path,bytes:b.length,sha256:hash,lines:text.split('\\n').length,parseDiagnostics:sf.parseDiagnostics.map(x=>ts.flattenDiagnosticMessageText(x.messageText,' ')),modules,astCallCount:calls,effectCallCount:effectCalls.length,effectCalls,topLevelCallCount:topLevelCalls.length,topLevelCalls:topLevelCalls.slice(0,8),topLevelCallsOmitted:Math.max(0,topLevelCalls.length-8)};\n out.push(report);\n}\nconst record={schema:'p001-transformers-node-entry-ast-extraction-v1',recordedAt:new Date().toISOString(),method:'Node crypto and bounded raw tar reader; offline TypeScript parse only; no target import or execution',candidateExecution:false,installedRuntimeIdentityProven:false,records:out};\nconst output=JSON.stringify(record);if(output.length>14000)throw Error('record over bounded output '+output.length);process.stdout.write(output);\n})().catch(e=>{console.error(e);process.exitCode=1});\n\nNODE"
}
