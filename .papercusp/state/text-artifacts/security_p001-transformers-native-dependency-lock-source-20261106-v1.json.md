---
rel_path: "security/p001-transformers-native-dependency-lock-source-20261106-v1.json"
updated_at: 1793942000406
_body: "content"
---

{
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
}
