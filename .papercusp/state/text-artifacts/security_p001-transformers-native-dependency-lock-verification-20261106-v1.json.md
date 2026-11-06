---
rel_path: "security/p001-transformers-native-dependency-lock-verification-20261106-v1.json"
updated_at: 1793942031108
_body: "content"
---

{
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
}
