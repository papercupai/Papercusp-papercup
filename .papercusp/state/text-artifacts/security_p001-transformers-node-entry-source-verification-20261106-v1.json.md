---
rel_path: "security/p001-transformers-node-entry-source-verification-20261106-v1.json"
updated_at: 1793941789210
_body: "content"
---

{
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
}
