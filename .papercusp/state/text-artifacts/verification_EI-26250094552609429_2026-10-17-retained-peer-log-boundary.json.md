---
rel_path: "verification/EI-26250094552609429/2026-10-17-retained-peer-log-boundary.json"
updated_at: 1792271468546
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "archived-plan-history-boundary",
  "workItem": "EI-26250094552609429",
  "capturedAt": "2026-10-17T21:10:58Z",
  "previousEvidence": "verification/EI-26250094552609429/2026-10-17-attribution-boundary.json",
  "sourceRefs": [
    "packages/operator-core/lib/harness-state/hive-log-retention.ts:275",
    "packages/operator-core/lib/sync/hyperbee/peer-log.ts:1",
    "packages/operator-core/lib/agent-tools/dev/dogfood_substrate_status.ts:115",
    "packages/operator-core/lib/sync/hyperbee/substrate-sidecar-host.ts:897",
    "packages/operator-core/lib/sync/hyperbee/remote-booted-harness.ts:193",
    "packages/operator-core/lib/sync/hyperbee/log-snapshot.ts:1883"
  ],
  "contract": {
    "policy": "plans and plan-parts are classified rotating retainEpochs2; policy is not measured deletion",
    "currentRead": "existing dev:dogfood_substrate_status ownLogProbe reads one index via existing booted handle; no new store/transport",
    "requestHost3170": "aggregate reaches substrate owner via snapshot, but exact indexed probe unavailable in this process",
    "backgroundHost3271": "same exact probe available on existing own log",
    "limitations": [
      "Own-log sample only, not every historical remote peer.",
      "No full historical scan, no assumption timestamps are globally monotonic.",
      "Current own log contains encrypted epoch1 payloads; header reading does not establish cleartext part changes.",
      "No claim original corrupting event found, no archive/index/parser repair.",
      "Prior outbox24h retention boundary still governs outbox absence."
    ]
  },
  "sampled": {
    "scope": "own log sampled indexed headers only; not a complete scan and ts may be out of order",
    "rows": [
      {
        "index": 1000,
        "available": true,
        "keyHex": "5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac",
        "length": 9194681,
        "table": "__snapshot__",
        "hbKey": "snapshot/1000/0-of-1",
        "ts": 1783633778743,
        "encrypted": false
      },
      {
        "index": 10000,
        "available": true,
        "keyHex": "5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac",
        "length": 9194681,
        "table": "engineer-issues",
        "hbKey": "WI-3817",
        "ts": 1783694983246,
        "hlc": "001783694983246:00000:2764ac50e15ec6af",
        "epoch": 1,
        "encrypted": true
      },
      {
        "index": 100000,
        "available": true,
        "keyHex": "5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac",
        "length": 9194681,
        "table": "engineer-issues",
        "hbKey": "EI-3561",
        "ts": 1783718773718,
        "hlc": "001783718773717:00000:2764ac50e15ec6af",
        "epoch": 1,
        "encrypted": true
      },
      {
        "index": 500000,
        "available": true,
        "keyHex": "5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac",
        "length": 9194681,
        "table": "engineer-issues",
        "hbKey": "EI-9547",
        "ts": 1784470666296,
        "hlc": "001784470666296:00000:2764ac50e15ec6af",
        "epoch": 1,
        "encrypted": true
      },
      {
        "index": 1000000,
        "available": true,
        "keyHex": "5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac",
        "length": 9194681,
        "table": "engineer-issues",
        "hbKey": "EI-3388",
        "ts": 1785774982213,
        "hlc": "001785774982212:00000:2764ac50e15ec6af",
        "epoch": 1,
        "encrypted": true
      },
      {
        "index": 2000000,
        "available": true,
        "keyHex": "5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac",
        "length": 9194681,
        "table": "engineer-issues",
        "hbKey": "EI-20383213214256180",
        "ts": 1786665627505,
        "hlc": "001786665627505:00000:2764ac50e15ec6af",
        "epoch": 1,
        "encrypted": true
      },
      {
        "index": 4000000,
        "available": true,
        "keyHex": "5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac",
        "length": 9194681,
        "table": "engineer-issues",
        "hbKey": "papercusp/WI-481254",
        "ts": 1787931582700,
        "hlc": "001787931582700:00000:2764ac50e15ec6af",
        "epoch": 1,
        "encrypted": true
      },
      {
        "index": 8000000,
        "available": true,
        "keyHex": "5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac",
        "length": 9194681,
        "table": "engineer-issues",
        "hbKey": "papercusp/EI-24892229591135548",
        "ts": 1790979011933,
        "hlc": "001790979011932:00000:2764ac50e15ec6af",
        "epoch": 1,
        "encrypted": true
      }
    ]
  },
  "observedIndex0": {
    "index": 0,
    "keyHex": "5b00878b7df0637b4f758129d02bc797d6c1928e18bc3751cb27b9ca0d541bac",
    "table": "plans-by-slug",
    "hbKey": "hetzner-restore-2026-07-09",
    "ts": 1783627954018,
    "epoch": 1,
    "encrypted": true
  },
  "next": "Use maintained indexed read on background host for bounded July provenance; any key/header narrowing remains incomplete until exact retained plan-part event payload is read through authorized epoch decrypt/reader and compared with saved sequence97/98."
}
