---
rel_path: "security/p001-sharp-dist-constructor-cjs-ast-verification-20261106-v1.json"
updated_at: 1793942904352
_body: "content"
---

{
  "schema": "p001-sharp-independent-source-ast-verification-v1",
  "recordedAt": "2026-11-06T05:28:24.133Z",
  "archive": {
    "bytes": 214749,
    "sha256": "3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac",
    "retainedIntegrityMatched": true
  },
  "path": "dist/constructor.cjs",
  "bytes": 20364,
  "sha256": "6b8978e0f1614d83a219cbbd455e3eed7922bc4212a5b3b99c5d37c3af3b3226",
  "parser": {
    "tool": "typescript",
    "version": "6.0.3",
    "path": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/typescript/lib/typescript.js",
    "sha256": "d3f3cd2b04b7f466f4484df921b744223f7bd1f3e353ec9110bdf52695b983d5"
  },
  "parseDiagnostics": [],
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
  "effects": [
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
  "targetExecuted": false,
  "installedRuntimeIdentityProven": false,
  "independentMatchesPython": {
    "bytes": true,
    "sha256": true,
    "archiveSha256": true
  },
  "captureCommand": "node <<'NODE'\nconst crypto=require('node:crypto'),zlib=require('node:zlib'),fs=require('node:fs'),ts=require('typescript');\nconst sha=b=>crypto.createHash('sha256').update(b).digest('hex');\n(async()=>{\n const response=await fetch('https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz'); if(!response.ok)throw new Error('HTTP '+response.status);\n const archive=Buffer.from(await response.arrayBuffer());\n if(archive.length!==214749||sha(archive)!=='3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac'||'sha512-'+crypto.createHash('sha512').update(archive).digest('base64')!=='sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==')throw new Error('archive identity mismatch');\n const tar=zlib.gunzipSync(archive),entries=new Map();\n for(let at=0;at+512<=tar.length;){const header=tar.subarray(at,at+512);if(header.every(x=>x===0))break;\n const name=header.subarray(0,100).toString().split('\\0')[0],prefix=header.subarray(345,500).toString().split('\\0')[0],size=parseInt(header.subarray(124,136).toString().replaceAll('\\0','').trim()||'0',8);\n entries.set((prefix?prefix+'/':'')+name,tar.subarray(at+512,at+512+size));at+=512+Math.ceil(size/512)*512;}\n const path=\"dist/constructor.cjs\",bytes=entries.get('package/'+path);if(!bytes)throw new Error('missing '+path);\n const text=bytes.toString('utf8'),source=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),moduleEdges=[],effects=[];\n const position=n=>{const start=n.getStart(source),lc=source.getLineAndCharacterOfPosition(start);return{start,end:n.end,line:lc.line+1,column:lc.character+1};};\n const scope=n=>{const out=[];for(let p=n.parent;p&&!ts.isSourceFile(p);p=p.parent)if(ts.isFunctionLike(p))out.push(ts.SyntaxKind[p.kind]+':'+(p.name?.getText(source)||'<anonymous>'));return out;};\n const selected=new Set(['createRequire','runtimePlatformArch','isUnsupportedNodeRuntime','familySync','versionSync','sharp._isUsingX64V2','process.emitWarning','util.debuglog','util.inherits','stream.Duplex.call','Object.assign','this._createInputDescriptor','this.constructor.call','structuredClone','this._whenStreamInFinished','this._flattenBufferIn','clone.emit','Sharp.queue.emit']);\n function visit(n){\n  if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n)&&n.moduleSpecifier){const arg=n.moduleSpecifier;moduleEdges.push({kind:ts.SyntaxKind[n.kind],specifier:arg.text,argumentKind:ts.SyntaxKind[arg.kind],argumentText:arg.getText(source),...position(n),functionAncestors:scope(n)});}\n  if(ts.isCallExpression(n)){const callee=n.expression.getText(source);\n   if(callee==='require'||n.expression.kind===ts.SyntaxKind.ImportKeyword){const arg=n.arguments[0];moduleEdges.push({kind:callee==='require'?'RequireCall':'DynamicImport',specifier:arg&&ts.isStringLiteralLike(arg)?arg.text:null,argumentKind:arg?ts.SyntaxKind[arg.kind]:null,argumentText:arg?.getText(source),...position(n),functionAncestors:scope(n)});}\n   if(selected.has(callee))effects.push({callee,expression:n.getText(source),...position(n),functionAncestors:scope(n)});\n  }\n  ts.forEachChild(n,visit);\n }visit(source);\n console.log(JSON.stringify({schema:'p001-sharp-independent-source-ast-verification-v1',recordedAt:new Date().toISOString(),archive:{bytes:archive.length,sha256:sha(archive),retainedIntegrityMatched:true},path,bytes:bytes.length,sha256:sha(bytes),parser:{tool:'typescript',version:ts.version,path:require.resolve('typescript'),sha256:sha(fs.readFileSync(require.resolve('typescript')))},parseDiagnostics:source.parseDiagnostics.map(x=>({code:x.code,start:x.start,message:ts.flattenDiagnosticMessageText(x.messageText,' ')})),moduleEdges,effects,targetExecuted:false,installedRuntimeIdentityProven:false}));\n})().catch(e=>{console.error(e);process.exitCode=1});\nNODE"
}
