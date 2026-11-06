---
rel_path: "security/p001-sharp-dist-sharp-cjs-ast-verification-20261106-v1.json"
updated_at: 1793942906709
_body: "content"
---

{
  "schema": "p001-sharp-independent-source-ast-verification-v1",
  "recordedAt": "2026-11-06T05:28:26.473Z",
  "archive": {
    "bytes": 214749,
    "sha256": "3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac",
    "retainedIntegrityMatched": true
  },
  "path": "dist/sharp.cjs",
  "bytes": 6262,
  "sha256": "76120d3971051fcc469c0bfa36e7b23d3c388b6a2f5785bf1491bbdb90ff0176",
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
  "effects": [
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
  "targetExecuted": false,
  "installedRuntimeIdentityProven": false,
  "independentMatchesPython": {
    "bytes": true,
    "sha256": true,
    "archiveSha256": true
  },
  "captureCommand": "node <<'NODE'\nconst crypto=require('node:crypto'),zlib=require('node:zlib'),fs=require('node:fs'),ts=require('typescript');\nconst sha=b=>crypto.createHash('sha256').update(b).digest('hex');\n(async()=>{\n const response=await fetch('https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz'); if(!response.ok)throw new Error('HTTP '+response.status);\n const archive=Buffer.from(await response.arrayBuffer());\n if(archive.length!==214749||sha(archive)!=='3b6bbbe6b308f5c383938ca4a31926cd5d79c4651ed8c5fda16a97da2014a9ac'||'sha512-'+crypto.createHash('sha512').update(archive).digest('base64')!=='sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==')throw new Error('archive identity mismatch');\n const tar=zlib.gunzipSync(archive),entries=new Map();\n for(let at=0;at+512<=tar.length;){const header=tar.subarray(at,at+512);if(header.every(x=>x===0))break;\n const name=header.subarray(0,100).toString().split('\\0')[0],prefix=header.subarray(345,500).toString().split('\\0')[0],size=parseInt(header.subarray(124,136).toString().replaceAll('\\0','').trim()||'0',8);\n entries.set((prefix?prefix+'/':'')+name,tar.subarray(at+512,at+512+size));at+=512+Math.ceil(size/512)*512;}\n const path=\"dist/sharp.cjs\",bytes=entries.get('package/'+path);if(!bytes)throw new Error('missing '+path);\n const text=bytes.toString('utf8'),source=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),moduleEdges=[],effects=[];\n const position=n=>{const start=n.getStart(source),lc=source.getLineAndCharacterOfPosition(start);return{start,end:n.end,line:lc.line+1,column:lc.character+1};};\n const scope=n=>{const out=[];for(let p=n.parent;p&&!ts.isSourceFile(p);p=p.parent)if(ts.isFunctionLike(p))out.push(ts.SyntaxKind[p.kind]+':'+(p.name?.getText(source)||'<anonymous>'));return out;};\n const selected=new Set(['createRequire','runtimePlatformArch','isUnsupportedNodeRuntime','familySync','versionSync','sharp._isUsingX64V2','process.emitWarning','util.debuglog','util.inherits','stream.Duplex.call','Object.assign','this._createInputDescriptor','this.constructor.call','structuredClone','this._whenStreamInFinished','this._flattenBufferIn','clone.emit','Sharp.queue.emit']);\n function visit(n){\n  if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n)&&n.moduleSpecifier){const arg=n.moduleSpecifier;moduleEdges.push({kind:ts.SyntaxKind[n.kind],specifier:arg.text,argumentKind:ts.SyntaxKind[arg.kind],argumentText:arg.getText(source),...position(n),functionAncestors:scope(n)});}\n  if(ts.isCallExpression(n)){const callee=n.expression.getText(source);\n   if(callee==='require'||n.expression.kind===ts.SyntaxKind.ImportKeyword){const arg=n.arguments[0];moduleEdges.push({kind:callee==='require'?'RequireCall':'DynamicImport',specifier:arg&&ts.isStringLiteralLike(arg)?arg.text:null,argumentKind:arg?ts.SyntaxKind[arg.kind]:null,argumentText:arg?.getText(source),...position(n),functionAncestors:scope(n)});}\n   if(selected.has(callee))effects.push({callee,expression:n.getText(source),...position(n),functionAncestors:scope(n)});\n  }\n  ts.forEachChild(n,visit);\n }visit(source);\n console.log(JSON.stringify({schema:'p001-sharp-independent-source-ast-verification-v1',recordedAt:new Date().toISOString(),archive:{bytes:archive.length,sha256:sha(archive),retainedIntegrityMatched:true},path,bytes:bytes.length,sha256:sha(bytes),parser:{tool:'typescript',version:ts.version,path:require.resolve('typescript'),sha256:sha(fs.readFileSync(require.resolve('typescript')))},parseDiagnostics:source.parseDiagnostics.map(x=>({code:x.code,start:x.start,message:ts.flattenDiagnosticMessageText(x.messageText,' ')})),moduleEdges,effects,targetExecuted:false,installedRuntimeIdentityProven:false}));\n})().catch(e=>{console.error(e);process.exitCode=1});\nNODE"
}
