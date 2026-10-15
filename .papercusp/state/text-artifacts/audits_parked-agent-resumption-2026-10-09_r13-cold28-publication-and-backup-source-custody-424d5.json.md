---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold28-publication-and-backup-source-custody-424d5.json"
updated_at: 1791901474376
_body: "content"
---

{
  "schemaVersion": "cold28-report-and-backup-custody-v1",
  "reportSourceArtifact": "audits/parked-agent-resumption-2026-10-09/r13-cold27-owner-analysis-pending-report-424d5.md",
  "reportReceipt": {
    "ok": true,
    "results": [
      {
        "ok": true,
        "id": "rpt_31d27f5a-2cfe-4dc0-b6e5-ec84eed8305f",
        "report": {
          "report_id": "rpt_31d27f5a-2cfe-4dc0-b6e5-ec84eed8305f",
          "request_key": "parked-cold27-r13-source-custody-424d5-20261013-v1",
          "workspace_id": "papercusp-workspace",
          "title": "R13 original-source custody \u2014 Cold27 assessment",
          "summary": "92 complete receipts preserved; 45 original requests remain unresolved. Backup custody and whole-plan acceptance remain open.",
          "kind": "analysis",
          "subject": {
            "kind": "plan",
            "ref": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "label": null
          },
          "origin": {
            "harness_slug": "papercusp",
            "author_owner_id": "su-424d5476-0b13-401a-a926-0aaa9f212391",
            "author_session_ref": "5d3892d6-8dcb-467b-8541-5e3c13ae138b"
          },
          "visibility": "owner",
          "supersedes_report_id": null,
          "lineage_id": "rpt_31d27f5a-2cfe-4dc0-b6e5-ec84eed8305f",
          "source": "agent",
          "tags": [
            "parked-agent",
            "r13",
            "source-custody",
            "cold27"
          ],
          "published_at": "2026-10-13T14:05:41.177Z",
          "updated_at": "2026-10-13T14:05:41.177Z",
          "retired_at": null,
          "path": "/reports?sel=rpt_31d27f5a-2cfe-4dc0-b6e5-ec84eed8305f",
          "body_bytes": 2157,
          "body_sha256": "4e743a1558adf17445ae296a2233435e6984f1e0ecac1ec14339def5e267f923",
          "goal_owner_report": null,
          "body_md": "R13 source recovery remains incomplete. The original 137-request cohort still has 92 complete receipts: 90 queued, one flush refusal, and one no-host refusal. All 92 prior records are preserved exactly; 45 requests remain unresolved. Queued receipts establish receipt custody only.\n\nFor those 45 requests, I checked 56 indexed native sessions. Their recorded files and matching files in the recorded homes\u2019 sessions/archived_sessions trees are missing, and the exact session keys have no canonical default-corpus archive manifests or files. A recent native-file positive control passed. This finding is limited to those locations; it does not establish global source absence. A remaining backup-custody search has not been completed.\n\nThe unchanged Cold26 parser plus lineage-candidate augmentation passed 12 positive and negative controls. Four bounded batches cover all 45 requests, with 65 native assessment executions, no native parser failures or timeouts, and no new complete receipts. All batch contents passed exact full SHA256 readback. Batch 3 was saved despite its wrapper reporting a timeout; I reconciled the persisted result and did not rerun it. The conflicting terminal verdict is captured as EI-25872050036961683; its claim was refused by admission-pending, so it is not represented as owned or fixed.\n\nThe combined assessment is `papercusp/audits/parked-agent-resumption-2026-10-09/r13-cold27-original137-custody-assessment-424d5.json`, 635,693 characters, SHA256 `b0c218f70d54bde66da822d0a14fec696115357e346400294b585239d7935c51`, with exact full readback verified. The companion acquisition procedure preserves the programs and evidence references. The 31,892-character orphan-lock checkpoint was archived with exact readback before condensation.\n\nWhole-116 continuity and eligibility remain unaccepted; outcomes joined = 0. R5, the orphan-lock root cause, R12, malformed-native/source-loss attribution, the final-fix runtime anchor, and the actual \u226524-hour R14 census remain open. The approved SELF/AUTO/P-013 route continues. No product source edits, product-test reruns, terminal-item redo, or live-gate operations were performed."
        }
      }
    ],
    "counts": {
      "ok": 1,
      "failed": 0
    }
  },
  "reportBodyExactReadback": true,
  "reportVisibility": "owner",
  "hostInventoryRawPath": "/tmp/parked-cold28-host-snapshots-424d5.json",
  "hostInventorySha256": "be41a6f9f9e255c0d65f5e7fadc1f0e12cfe3caa22822b236e9cf4ea70eddc42",
  "hostInventoryRecipeCall": {
    "script": "const result=await tools.capability.bash({\"command\": \"python3 - <<'BACKUP_READ'\\nimport subprocess,json,hashlib,datetime\\nout='/tmp/parked-cold28-host-snapshots-424d5.json';err='/tmp/parked-cold28-host-snapshots-424d5.err'\\nstart=datetime.datetime.now(datetime.timezone.utc).isoformat()\\nwith open(out,'wb') as f,open(err,'wb') as e:\\n p=subprocess.run(['/usr/bin/sudo','-n','--','/usr/bin/env','KOPIA_LOG_DIR=/mnt/backup/kopia-cli-logs','/usr/bin/kopia','snapshot','list','--all','--json'],stdout=f,stderr=e,timeout=100)\\nif p.returncode: print(json.dumps({'exitCode':p.returncode,'evidence':err,'errorTail':open(err).read()[-1600:]}))\\nelse:\\n raw=open(out,'rb').read();rows=json.loads(raw);by={}\\n for r in rows:\\n  source=r.get('source',{});key=source.get('path','');by.setdefault(key,[]).append(r)\\n summaries=[]\\n for path,rs in by.items():\\n  if path.startswith('/home/marsh-office'):\\n   rs.sort(key=lambda r:r.get('startTime',''),reverse=True)\\n   summaries.append({'sourcePath':path,'retainedSnapshots':len(rs),'newestId':rs[0].get('id'),'newestTime':rs[0].get('startTime'),'oldestTime':rs[-1].get('startTime')})\\n print(json.dumps({'operation':'read-only host snapshot inventory','observedAt':start,'exitCode':p.returncode,'evidence':out,'sha256':hashlib.sha256(raw).hexdigest(),'snapshotRows':len(rows),'allSourceCount':len(by),'homeSources':summaries}))\\nBACKUP_READ\", \"description\": \"Inspect retained host backup source metadata\", \"timeout\": 120000, \"yield_after_ms\": 25000, \"work_item_id\": \"EI-25855583682954393\"});return typeof result === \"string\" ? JSON.parse(result) : result;",
    "title": "Inspect native source backup custody",
    "description": "Read host Kopia snapshot metadata with raw data retained outside context; return scoped source inventory.",
    "timeoutSec": 40
  },
  "retainedRelevantSnapshotMetadata": [
    {
      "id": "0011c13d84e9073794e934b028ec7764",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T08:48:09.346171477Z",
      "endTime": "2026-10-13T09:33:09.853365575Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T08:48:09.215957721Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k75ad0d477f33407c39b488ed29b99607",
        "summ": {
          "size": 38946142457,
          "files": 483883,
          "symlinks": 31,
          "dirs": 74710,
          "maxTime": "2026-10-13T09:19:11.676025617Z",
          "incomplete": "checkpoint",
          "numFailed": 0
        }
      }
    },
    {
      "id": "6b3fc03c0b35a25277cdc2f627510ed1",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T08:48:09.346171477Z",
      "endTime": "2026-10-13T10:18:11.242700177Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T08:48:09.215957721Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k6bcee804e2b15f5fae4e2efc542968d4",
        "summ": {
          "size": 43412022803,
          "files": 551400,
          "symlinks": 33,
          "dirs": 84824,
          "maxTime": "2026-10-13T09:19:11.676025617Z",
          "incomplete": "checkpoint",
          "numFailed": 0
        }
      }
    },
    {
      "id": "4525c40b2e00884dc1f3a861f302a3ed",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T08:48:09.346171477Z",
      "endTime": "2026-10-13T11:03:09.387867925Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T08:48:09.215957721Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k63f47c4773927240d99b428b41ab6711",
        "summ": {
          "size": 60737393462,
          "files": 845252,
          "symlinks": 37,
          "dirs": 132128,
          "maxTime": "2026-10-13T09:19:11.676025617Z",
          "incomplete": "checkpoint",
          "numFailed": 0
        }
      }
    },
    {
      "id": "46f0c466c62c0cc2f211409165db8341",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T08:48:09.346171477Z",
      "endTime": "2026-10-13T11:51:28.624150176Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T08:48:09.215957721Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k4f85200c1d4c5c38756231cf5a296057",
        "summ": {
          "size": 84198490529,
          "files": 957025,
          "symlinks": 42,
          "dirs": 150191,
          "maxTime": "2026-10-13T11:31:19.231135244Z",
          "incomplete": "checkpoint",
          "numFailed": 0
        }
      }
    },
    {
      "id": "b5318218c0a5019f7fe5cb7e5541a1c7",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T08:48:09.346171477Z",
      "endTime": "2026-10-13T12:33:09.472808037Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T08:48:09.215957721Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k5f3710fb9aed6317ccb6d2c4e0159c3e",
        "summ": {
          "size": 111648106510,
          "files": 1421775,
          "symlinks": 10460,
          "dirs": 190751,
          "maxTime": "2026-10-13T12:15:43.939067665Z",
          "incomplete": "checkpoint",
          "numFailed": 0
        }
      }
    },
    {
      "id": "fbb58862f1c09d6d5d6f387a78257da4",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T08:48:09.346171477Z",
      "endTime": "2026-10-13T13:18:10.369822533Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T08:48:09.215957721Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k61c8ce332ed7f295def7fa727b509261",
        "summ": {
          "size": 142700718487,
          "files": 1511738,
          "symlinks": 10623,
          "dirs": 199671,
          "maxTime": "2026-10-13T13:15:00.750516467Z",
          "incomplete": "checkpoint",
          "numFailed": 0
        }
      }
    },
    {
      "id": "9628df770ee5e5ded5f84657dbe79b8a",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T08:48:09.346171477Z",
      "endTime": "2026-10-13T14:03:36.65925745Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T08:48:09.215957721Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k93d41ad69770fd9513cf09cb26a4a944",
        "summ": {
          "size": 157709166744,
          "files": 1593727,
          "symlinks": 10637,
          "dirs": 210716,
          "maxTime": "2026-10-13T13:29:56.13954508Z",
          "incomplete": "checkpoint",
          "numFailed": 0
        }
      }
    },
    {
      "id": "3af5bb83da87da965011fae097e3bba7",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T10:27:50.534293913Z",
      "endTime": "2026-10-13T11:17:27.9298484Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T10:26:45.118034857Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k5460d3f0afbdf1699d855c12335b4863",
        "summ": {
          "size": 59996078694,
          "files": 838970,
          "symlinks": 37,
          "dirs": 131581,
          "maxTime": "2026-10-13T10:43:55.191814786Z",
          "incomplete": "checkpoint",
          "numFailed": 1,
          "errors": [
            {
              "path": "papercupai-workspace/papercusp-staging.generations/.candidate-dfb296f7964c.Z84Bo5/checkout",
              "error": "readdirent /home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-dfb296f7964c.Z84Bo5/checkout: no such file or directory"
            }
          ]
        }
      }
    },
    {
      "id": "90e3de091a82f732fab5e15c4af5645a",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T10:27:50.534293913Z",
      "endTime": "2026-10-13T11:57:50.552276032Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T10:26:45.118034857Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k2338b7e0f2f6debd3e9afbe458a71770",
        "summ": {
          "size": 75662354885,
          "files": 931864,
          "symlinks": 40,
          "dirs": 148875,
          "maxTime": "2026-10-13T11:56:22.832704064Z",
          "incomplete": "checkpoint",
          "numFailed": 1,
          "errors": [
            {
              "path": "papercupai-workspace/papercusp-staging.generations/.candidate-dfb296f7964c.Z84Bo5/checkout",
              "error": "readdirent /home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-dfb296f7964c.Z84Bo5/checkout: no such file or directory"
            }
          ]
        }
      }
    },
    {
      "id": "94437f6f88d53038d4f64420eca0abbb",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T10:27:50.534293913Z",
      "endTime": "2026-10-13T12:42:59.195774403Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T10:26:45.118034857Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k7ca5593ae2a9a3c70b5bb319b16538d8",
        "summ": {
          "size": 108475030290,
          "files": 1370006,
          "symlinks": 10449,
          "dirs": 187358,
          "maxTime": "2026-10-13T12:32:47.577538304Z",
          "incomplete": "checkpoint",
          "numFailed": 1,
          "errors": [
            {
              "path": "papercupai-workspace/papercusp-staging.generations/.candidate-dfb296f7964c.Z84Bo5/checkout",
              "error": "readdirent /home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-dfb296f7964c.Z84Bo5/checkout: no such file or directory"
            }
          ]
        }
      }
    },
    {
      "id": "c4f67b968b79cf4a33adc4e1268ef96c",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T10:27:50.534293913Z",
      "endTime": "2026-10-13T13:28:05.433040192Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T10:26:45.118034857Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "kab0ef7a3a7fed6242e54010256a441de",
        "summ": {
          "size": 115030919083,
          "files": 1453172,
          "symlinks": 10460,
          "dirs": 192604,
          "maxTime": "2026-10-13T13:21:40.341955405Z",
          "incomplete": "checkpoint",
          "numFailed": 1,
          "errors": [
            {
              "path": "papercupai-workspace/papercusp-staging.generations/.candidate-dfb296f7964c.Z84Bo5/checkout",
              "error": "readdirent /home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-dfb296f7964c.Z84Bo5/checkout: no such file or directory"
            }
          ]
        }
      }
    },
    {
      "id": "6179ac52ce973d89f816946de2ec5561",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T12:17:07.719873358Z",
      "endTime": "2026-10-13T13:02:08.308565309Z",
      "incomplete": "checkpoint",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T12:16:44.800963318Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k50cfe1953be21883fe05f7b203c4c00f",
        "summ": {
          "size": 44495975506,
          "files": 593785,
          "symlinks": 33,
          "dirs": 91687,
          "maxTime": "2026-10-13T12:43:33.742245103Z",
          "incomplete": "checkpoint",
          "numFailed": 1,
          "errors": [
            {
              "path": "papercupai-workspace/papercusp-checkpoint/libs/generic/ipc-endpoint-server",
              "error": "readdirent /home/marsh-office/papercupai-workspace/papercusp-checkpoint/libs/generic/ipc-endpoint-server: no such file or directory"
            }
          ]
        }
      }
    },
    {
      "id": "aa12a92b2af26bded11fbb851015fbe2",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office"
      },
      "startTime": "2026-10-13T12:17:07.719873358Z",
      "endTime": "2026-10-13T13:30:19.207984719Z",
      "incomplete": "canceled",
      "rootEntry": {
        "name": "marsh-office",
        "type": "d",
        "mode": "0775",
        "mtime": "2026-10-13T12:16:44.800963318Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k3121ae8bc7229a853a4837a176c49dd3",
        "summ": {
          "size": 58832072690,
          "files": 819509,
          "symlinks": 37,
          "dirs": 125557,
          "maxTime": "2026-10-13T12:43:33.742245103Z",
          "incomplete": "canceled",
          "numFailed": 2,
          "errors": [
            {
              "path": "papercupai-workspace/papercusp-checkpoint/libs/generic/ipc-endpoint-server",
              "error": "readdirent /home/marsh-office/papercupai-workspace/papercusp-checkpoint/libs/generic/ipc-endpoint-server: no such file or directory"
            },
            {
              "path": "papercupai-workspace/papercusp-staging.generations/.candidate-38fea72ed3af.AkdhEt",
              "error": "readdirent /home/marsh-office/papercupai-workspace/papercusp-staging.generations/.candidate-38fea72ed3af.AkdhEt: no such file or directory"
            }
          ]
        }
      }
    },
    {
      "id": "8deb56ebe3a15ce2cb110fea5d66033d",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-05T16:05:13.756298261Z",
      "endTime": "2026-10-05T16:14:39.106478124Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-05T16:05:09.542582661Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "kdded7517364832d1bd5768b4ea9ee259",
        "summ": {
          "size": 156142062032,
          "files": 1113436,
          "symlinks": 29948,
          "dirs": 103016,
          "maxTime": "2026-10-05T16:14:18.262206966Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "b5189a18ebcb23aa6a603d605e2a8a38",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-05T17:46:40.284839035Z",
      "endTime": "2026-10-05T18:08:06.677445972Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-05T17:46:37.882744451Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k0e7f79b3a439a88d8752affd5726440a",
        "summ": {
          "size": 155122551759,
          "files": 1112608,
          "symlinks": 31868,
          "dirs": 104391,
          "maxTime": "2026-10-05T18:07:14.119125079Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "10d01deacfec9fd22de3865ef299498c",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-05T20:33:06.126100358Z",
      "endTime": "2026-10-05T20:38:09.846403452Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-05T20:33:05.227834364Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k4991d044190f53d96f3039a1645365f7",
        "summ": {
          "size": 156581118787,
          "files": 1120216,
          "symlinks": 35102,
          "dirs": 107208,
          "maxTime": "2026-10-05T20:37:57.456487272Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "d943e26384ffcc91331e7b1290a36ad3",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-05T22:57:37.937558688Z",
      "endTime": "2026-10-05T23:05:33.329952711Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-05T22:57:35.789138347Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k7dd50c273d5ccd8e15af8f386f2fe3d3",
        "summ": {
          "size": 153883256235,
          "files": 1137600,
          "symlinks": 38200,
          "dirs": 109787,
          "maxTime": "2026-10-05T23:05:19.906582307Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "8789d2073f08361f3f3901b002e38cfb",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-06T00:50:57.725976068Z",
      "endTime": "2026-10-06T01:07:24.305271883Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-06T00:50:54.361674728Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k58486c50c50d35513bd5506ee595496a",
        "summ": {
          "size": 154927090160,
          "files": 1139950,
          "symlinks": 37833,
          "dirs": 112403,
          "maxTime": "2026-10-06T01:07:09.174064626Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "8d45f19d392d1448d85d831f082c71ff",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-06T04:09:48.812255422Z",
      "endTime": "2026-10-06T04:48:51.576258774Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-06T04:09:45.003623432Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k774afd73e035be540c2f02a6f9553f66",
        "summ": {
          "size": 161140623003,
          "files": 1187526,
          "symlinks": 49122,
          "dirs": 119182,
          "maxTime": "2026-10-06T04:48:20.4838933Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "f0c35d92315a6900a4acc92c5cc6b986",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-07T02:31:22.840725655Z",
      "endTime": "2026-10-07T03:37:05.297760753Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-07T02:24:45.708986203Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "kd85b8c408ac7bce4af5a5b146a95efa8",
        "summ": {
          "size": 188631713626,
          "files": 1947401,
          "symlinks": 68677,
          "dirs": 157187,
          "maxTime": "2026-10-07T03:35:23.591905343Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "0331a21c7a99aef7fb8e2cc96106bab3",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-07T14:24:48.968727645Z",
      "endTime": "2026-10-07T15:14:00.303986187Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-07T13:55:09.919344663Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "kcddc0ea89472cdb0b915a3d7575d9091",
        "summ": {
          "size": 195992316769,
          "files": 1796477,
          "symlinks": 43737,
          "dirs": 121073,
          "maxTime": "2026-10-07T15:13:36.011798659Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "0f0e74db9bcfe48c683d0a3365589b2e",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-07T20:22:10.296179264Z",
      "endTime": "2026-10-07T21:03:04.593862502Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-07T20:07:36.55741358Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k3082e8dd5a4901c5189215c616e2b41c",
        "summ": {
          "size": 167051239966,
          "files": 1732760,
          "symlinks": 40143,
          "dirs": 126690,
          "maxTime": "2026-10-07T21:01:59.108678691Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "ed8cb742b5e2015ec9f6e35fba80729d",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-07T22:50:32.24095771Z",
      "endTime": "2026-10-07T22:59:38.445110271Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-07T22:43:09.641142079Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k6e0ab17f60ca106e65cbb93d26bc6454",
        "summ": {
          "size": 168097887549,
          "files": 1719336,
          "symlinks": 49411,
          "dirs": 129453,
          "maxTime": "2026-10-07T22:59:32.733788302Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "fd3bef39b2bf94696cd0b0a4e2525251",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-08T00:41:50.687243831Z",
      "endTime": "2026-10-08T00:53:35.056724497Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-08T00:39:30.128730707Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k4736d1700436fd1a5208c10bb8be61b4",
        "summ": {
          "size": 161600849374,
          "files": 1684054,
          "symlinks": 24044,
          "dirs": 127820,
          "maxTime": "2026-10-08T00:53:04.905639531Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "83ed14e0f041d7c7b83de474d3a38924",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-08T07:17:20.269830453Z",
      "endTime": "2026-10-08T07:48:25.42834309Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-08T07:14:49.655919976Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k44c9866091dd843479268485963036e1",
        "summ": {
          "size": 109279091124,
          "files": 1154460,
          "symlinks": 25468,
          "dirs": 116824,
          "maxTime": "2026-10-08T07:48:13.582985206Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "4eb1baed8b65d7e08bc941d4c1e56ec0",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-08T10:35:53.145797168Z",
      "endTime": "2026-10-08T10:52:38.874353685Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-08T10:35:35.463035848Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "kac9a2f1aa16dfc7569664942308403f9",
        "summ": {
          "size": 103733118700,
          "files": 1089749,
          "symlinks": 30178,
          "dirs": 118534,
          "maxTime": "2026-10-08T10:52:23.164339505Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "c3ce46d539f5e1b8532d8ac54cf97edb",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-08T14:08:12.563130288Z",
      "endTime": "2026-10-08T14:36:48.765454653Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-08T14:02:19.022104874Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "ka73f593a161adec979be6580bd1e119c",
        "summ": {
          "size": 104061255655,
          "files": 1095787,
          "symlinks": 31670,
          "dirs": 123998,
          "maxTime": "2026-10-08T14:35:56.848827693Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "c9928d4f16a0fd1d120360da8963ce38",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-08T19:39:09.706590164Z",
      "endTime": "2026-10-08T20:38:56.802619526Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-08T19:07:18.920254281Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k5bc3c0a9fc118554d96568a098cc4ff8",
        "summ": {
          "size": 99542434047,
          "files": 1030228,
          "symlinks": 27234,
          "dirs": 117119,
          "maxTime": "2026-10-08T20:38:46.686329586Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "7ca3379927d26e850ef32896e3ed2671",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-09T17:01:43.411481435Z",
      "endTime": "2026-10-09T17:42:31.727051398Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-09T16:37:25.899572435Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "kd4235b90bc920cd56d0556d78cd64f37",
        "summ": {
          "size": 112117236235,
          "files": 1255958,
          "symlinks": 14039,
          "dirs": 149543,
          "maxTime": "2026-10-09T17:40:38.531577594Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "9d8c3a1c12cd58e862dbdbdebeba4a31",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-10T03:52:59.092489324Z",
      "endTime": "2026-10-10T04:07:09.537946292Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-10T03:39:53.537461937Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "kac1824e87bfd9bc4646253f908678000",
        "summ": {
          "size": 115549512127,
          "files": 1350232,
          "symlinks": 14668,
          "dirs": 169743,
          "maxTime": "2026-10-10T04:06:42.456467428Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "8d33cf6c53aff70cf52f0a8d00665faa",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-10T06:57:24.779075654Z",
      "endTime": "2026-10-10T07:15:14.864471177Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-10T06:45:54.580026639Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k4a5815dec61cb2b3b0113ae896673254",
        "summ": {
          "size": 115024925440,
          "files": 1331045,
          "symlinks": 16120,
          "dirs": 139282,
          "maxTime": "2026-10-10T07:14:52.992120462Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "82b13afc002480d5d8187a827d549ddf",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-11T23:20:41.419151163Z",
      "endTime": "2026-10-12T01:17:50.843216768Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-11T23:19:49.290574437Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "ka5805344601269e9e5ca88283542991c",
        "summ": {
          "size": 138534350272,
          "files": 1511338,
          "symlinks": 24448,
          "dirs": 181202,
          "maxTime": "2026-10-12T00:56:48.272165443Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "599ad66688d05ebb44fcfdccfbb931d7",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-12T03:30:57.254459197Z",
      "endTime": "2026-10-12T04:57:07.17521977Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-12T03:13:22.079993021Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k6b07bc83c0311fa9732b06749ebf8b8c",
        "summ": {
          "size": 145507924233,
          "files": 1568495,
          "symlinks": 24188,
          "dirs": 190668,
          "maxTime": "2026-10-12T04:55:05.005655468Z",
          "numFailed": 0
        }
      }
    },
    {
      "id": "38e9ae53eaa0e84e43b006f5e46538f4",
      "source": {
        "host": "main-server-precision-7865-tower",
        "userName": "marsh-office",
        "path": "/home/marsh-office/.papercusp"
      },
      "startTime": "2026-10-12T07:30:27.184426205Z",
      "endTime": "2026-10-12T08:08:31.653672062Z",
      "incomplete": null,
      "rootEntry": {
        "name": ".papercusp",
        "type": "d",
        "mode": "0700",
        "mtime": "2026-10-12T07:22:18.063551771Z",
        "uid": 1000,
        "gid": 1000,
        "obj": "k4c36d8778214c6171f030676d878346a",
        "summ": {
          "size": 145910941009,
          "files": 1531875,
          "symlinks": 18890,
          "dirs": 160647,
          "maxTime": "2026-10-12T08:05:45.62143076Z",
          "numFailed": 0
        }
      }
    }
  ],
  "directoryProbe": {
    "schemaVersion": "cold28-native-backup-directory-probe-v1",
    "observedAt": "2026-10-13T14:12:09.925087+00:00",
    "scopeSha256": "fa68760b6856ae318d28d957f014efba6830b218cc339df2a49be0a3b7c9e31f",
    "nativeSessionPopulation": 56,
    "unresolvedRequestPopulation": 45,
    "homePopulation": [
      "session-35023",
      "session-35773",
      "session-38834",
      "session-38868",
      "session-38896",
      "session-38917",
      "session-39024",
      "session-39228",
      "session-39230",
      "session-39232",
      "session-39233",
      "session-39241",
      "session-39262",
      "session-39263",
      "session-39271",
      "session-39328",
      "session-39329",
      "session-39333",
      "session-39341",
      "session-39345",
      "session-39354",
      "session-39355",
      "session-39565"
    ],
    "rows": [
      {
        "snapshotId": "f0c35d92315a6900a4acc92c5cc6b986",
        "path": "f0c35d92315a6900a4acc92c5cc6b986/su-codex-homes",
        "exitCode": 0,
        "stdout": "k0a3af0dca59edb173d953cf6ab85e425  session-33961\nkb5617a23c027e5b9ee893e3d985d4c17  session-34275\nk8529afcb08b4f2375a26945334f934f5  session-34673\nk4cb79c57376ead9bd8190c603d6fb3af  session-35825\nkedab1509ccfc723dfde1db89cf1574af  session-35348\nk4c37c2a7118ba08bd2d667ef1fa7b991  session-35582\nk5c6513657142458db0318c089270b324  session-29704\nk2673d5cf43697d22ed1c71c3a7a1adbc  session-33002\nk3320115bbeca754418b8b40d41990076  session-35405\nkb9a96dc8312542def846a417816be6ec  session-35554\nk1697a86a4edda5db14007fe97fbeb2b2  session-35878\nk703a5534b8f1506d95d775500a02c99d  session-35941\nkffa21a541625c7ba70783b2a444ccbba  session-36018\nk6ad6dae1aa964b37808f4e5e9b2ef7c3  session-36052\nk5e56b3e1889f3673d344f8d9d2de5d90  session-35753\nk40d8cdb96feccaa27241e850f3b4147f  session-35828\nkdcaae0cefa04015b5cac914bc2c826c4  session-35904\nk03627183050abf33a43ae64c8cdb7ea5  session-35966\nke6f01ed6c5e73b8c92bef2975f06fbc1  session-35994\nk715769ab5b2dbb92c9fcaeb01a61cef4  session-35998\nk42e7f5368721d6b4c471d0beb12265f4  session-36003\nk56d6d81024ac69edba0c561a3de04030  session-36054\nk172ab6686bf877441d026f8940ed9298  session-34459\nk2345b67c4cca07c9162e70738a29c065  session-14798\nk502516a088effee5975b9319b32a6cd6  session-29969\nk4f9259b5c7d5c007afe5c7c85b62d3b8  session-34700\nk4ba423e3ceca324a260845afa91da72a  session-35168\nk21a60bd1cd10445b7f3e32a464eb8c87  session-35763\nkcc4ce3b3b5142e7c7b41193880a8b0e8  session-35921\nkcbc895659021636c6f9ed146b9db09af  session-36108\nkaac37f7b970206f9ccf01ee213e2c380  session-32841\nk3d84fc4919fa9a7aaaee92dd66cbfc3f  session-32850\nkdf15d1c5ecbcc184b8da50f8fb5a11eb  session-34909\nk3dfde287d3d03477f54111296f88ea95  session-35401\nk30537871611fb000de57f179ad4289bf  session-36028\nk5357ab717b47752e42bf226a8e4b2011  session-36038\nke33a8a40b18ad81fc555f5d57efe9cb7  session-36094\nk5b4644e4dc113e253232e1b83c301abb  session-36289\nkea7bc83d7c5b344ae396309d49d671de  session-32844\nk3d3e3ba4f8426a508a9bfddfbd5e01f5  session-34428\nke77877561bdf1c16111ee85b915a86fe  session-34979\nk4ffd0835ac20083519305839b567f462  session-35592\nkd8882822d71d9ea5eadcb4b8e6e2dde6  session-36183\nka6590ed7c2e9e8477b2099dae63594c2  session-36196\nkeb370fc169455da002a375dae6d51f1e  session-36200\nk588045e8d0e8ab089f11fc904b411ae7  session-36262\nkd51546ef05c24e0bac5834363d18eb68  session-33570\nk0e9aaac2e0b4bdfaec7d4ca0a6639d8a  session-35895\nk6d92e171505979017c57ed02ecf4fbee  session-35919\nk70c67c49e3853c444894189be4f71f77  session-36012\nk6bdfb5b901d7e269fbaccb19b84006f1  session-36062\nkc79a2f1f9f23cbf65001b470da3c10b8  session-36214\nk978c338d94edaca383f0a80acc86a749  session-36230\nkd778901671492c9602b909a84072007d  session-36281\nkb355fe1bc55e579c70a3976fa2fc36f7  session-30860\nkef0f72e115d636e00fb3c14816cd4535  session-32453\nk1f96b8d8ea4c8bc72d99b5c61835f4f5  session-34173\nk77f6665df9ecdcd4f8bdaaec436a8935  session-35331\nk81e1e0188e42c47024179826b9ec7fd5  session-35946\nk3615bbd5a5cbdce7db623afe1719edc7  session-36011\nk540c1cce97defa94bad6ca0ad416e7ef  session-36031\nk832c6056f0d4ff05b5804c73230c9a26  session-19943\nk797791feed87a5b8cf3f1b2c55c32424  session-30275\nk7246d678414ea19619a28d5d0e77d76f  session-32810\nk24bc27dd82301bfe9a03944dfcb6079a  session-35099\nk3557668ec279d5f98630310931284ac5  session-35213\nkcffe6e8cad29d0bca9cf2ab4904ed9f8  session-35327\nk438d2ffacc2dd390205b7916a0faa709  session-35454\nka853863c111523f827fdaef41cff72ab  session-35912\nk3c52a431ea77812bdfc33a2f5389419f  session-33981\nkdf16d5ef5e2663e2314564ef4ff41bbd  session-34303\nkf0b0f692041f7e404e101dd6503c73be  session-34604\nk73d2d84b20ffbfa17facb2f27d28e391  session-35928\nkbe0f057b2d9e7c164f1e93299b1d81e9  session-35947\nk3676adc7e2401f9c5967e979a8831365  session-35988\nk2617ef54d33d8b29c7763da97b27201a  session-36069\nk9c21dcc043e14dfff8697aac871f542d  session-36255\nk59b67068904cf2063eb024f142b2d746  session-33932\nk8574b77d48c1c323f8f5e8ffe76c2ad7  session-35189\nk1bc39c9d13f715bc88d28e74231dd83e  session-35979\nka886fa70ece6b49559558bc69f9c504e  session-36080\nk4f966582d9803d14d4eaa2e650b154c3  session-36174\nk5d1a3157624ffd05608b717bc492afef  session-36237\nk37038523dbc57259e15fecc72e1e1e85  session-36301\nk9ef17f05450325ec35cfef21e157ce83  session-36318\nkb025480d411391feac2b64964b1c9ca6  session-34307\nk62f23bd50a48982e39e629287a390c78  session-35078\nk56e28b401baac59d2809e054fb01f16b  session-35903\nkd5ef31cca696060e006b7c8470dd9513  session-35918\nk56c89ef6ea52c7003be9f3fcbf966f8b  session-35926\nk0b0364a7610faffac4f3cae84cf1bd74  session-35945\nke44e374c762bc71589c0776bc070022d  session-36206\nkaea47b280a76e1b53929913f6b3d516c  session-36295\nka6970b1c3d66ad54940e36959ee5116c  session-33294\nke3a3c9901d56c328f874280f6392e9f9  session-35108\nkdfba2fda17f0902c0496bdba6101b543  session-35572\nkfa4cb74bf359c20e748dbbe8ceb53672  session-36008\nkac2ea112ce25dfbf61aa033bdd6742ba  session-36082\nk2bfdf68a1bb7a85d406b6e0708b1b15a  session-36091\nk3250410c228de7655582658359cf97b0  session-36118\nk00e16d34cfc1071556066684e8fba931  session-36229\nk6f41ed20ce37186a2b7805813deb4a81  session-34158\nk41c838b2ba4f48669db15ecf22467845  session-36224\nk41ba9d67d9bd59922c19ba92db42a41d  session-36298\nkd76d7970caaee1e6efc6b5094e9ff5c1  session-19985\nk1bb9c260a1feded0c0239b207dcbca7a  session-35870\nk82bd988b1bd387e3bdcfd0f4ec629f92  session-36043\nk674a5d2aa7a1969698b19e61a12e2e8f  session-36047\nk976a72210be6d73b87d271c196220738  session-36050\nk471d6e9b9eac32c8956b402a833af2ad  session-36071\nk2a7cbf8e61cb7534d34ff4d0a57514d7  session-36260\nk5d973278794bd4b47d577e0e045284af  session-36291\nke22cb2ed6a17604656cae6a18d4141cc  session-21446\nk0aa49024cb297a3a9d14cbba2828d7cb  session-33141\nk898a472c6925a36f042ad587d3338799  session-35897\nk15d55751c4a51d3f3e9c623d322f5dab  session-36097\nk15e7ea37f8fb928bee9219398a9ca541  session-36099\nk6e1fa7c9cf4b3c88bf3b5830385a2866  session-36211\nk392b45e2c66a61a82079ff77fc9076fc  session-36219\nk909ee1c487d29f86bd5efecb9a2db6da  session-36302\nk964060f1ecc1c7a916ec3abc2f4966b0  session-33940\nk8e86945bf099438fa0e96265f686936c  session-34007\nkfa467a8ae3d1de4f52fa2c4ca0d9d757  session-34653\nk2db324757863971533871ce6af593652  session-35243\nk527f02a82f6fafa189e29736a4f3a80a  session-35920\nk9987cb9036ba1f288e17912f6ff5d797  session-36066\nk4b056e51081f7f9c79d82c6444604d6c  session-34671\nk11d2bb7df88dbc8683477cae2b26ae21  session-35414\nk6795c6b9f25f148b8d098253344d2434  session-35416\nk9398ed1250c4d7ff4ba98ef5726b374a  session-35932\nkd8c2ff61ec770037716331ebc6a270f2  session-36057\nk6ce5c5787bff7de03adc1356c40d8310  session-36287\nk313e1f93d36684e13749d89be9c21616  session-36290\nk56a6c69411cbb0acfe39d3e8e8d2868e  session-34133\nk234d74d63e36e87865717a202d692dd6  session-35770\nkab2642f5021ba76ea3563037e5918ee6  session-36014\nk76f021342c13c06b9fd183b9767a6252  session-36076\nk48079de3406531ee46496a0302c90418  session-36098\nk5ee33d3ee5bb952b1cf06c2800fe2a44  session-36258\nk352e861917d552f2884f4f58e01d74c3  session-36274\nkf6017201da70240453e2bbf0fb474052  session-83\nk55202fed944261b92996a3090bcde7e4  session-34265\nk3a14359430e63638763d6e68d8db7618  session-34549\nkba1d842a194421874194dea3edb2a079  session-29473\nkea8a6e40a99b23cf6be975f6d9cb0750  session-33956\nkf015628c5132982db2c4aad3715124c3  session-34881\nk232691fd123aeb8101d5319e68ad7b0b  session-35335\nkeec86b1d4981d060d866ed587ceaf218  session-35493\nk841069ec6d1cab9ca72bf754dd4da321  session-35938\nka462bb52f1583280d0d1bbc96076dbb1  session-34286\nk22cd754e487d1634e575e7df3f344c3c  session-35332\nk1207c7570e396f3021662b5ca0765418  session-35873\nk25858cc55b6217b29a386f1d41e91f58  session-35936\nk5218d1213bcac5576625197a748d796c  session-36130\nke9ba9f4c737de09f1e7bab097c0fad83  session-34358\nke0c111429722ab936f93b1682561908e  session-35875\nkfe8a8a998f08dbbedf64adb3d1043d31  session-35907\nk835fa8a5b94cc192531cb232024a614a  session-36100\nk88283a88c41e0a61c0fcfd9207b32de2  session-33560\nka509fc86b18ab7ad4ae454d7ab605979  session-33885\nk957f73871d8a1945d92a88d7facda1f2  session-34617\nk168554279c3a69b4df62d18bfc37d80d  session-35759\nk7bd323ec47ee7ad7942bd1d0f17dee34  session-35885\nk6792be0d6050b7c63118f293917787d4  session-35942\nkf25005b0fa1c0da53aaae62ebaba27c1  session-36033\nkaef7b2e3c4801ae9f3dcc8962bf5c8bf  session-36113\nke134383bb0950c57a892298cb5324a5a  session-32856\nk8cd8f72eacff83a47ffd4125cf870039  session-34079\nk75c99f3ee58c0e8c77aec2f7c60d8955  session-34578\nkf739fa05dbd6fe1bc9ce3fd02952f314  session-34907\nkf586f447bc3f63faf6957d98979a1986  session-35276\nkebb89b1b85d00c63c909148ef4a5b0e0  session-35447\nka806c7e07e0f38a5439fdebbcf3fefd6  session-35709\nk969a56603a342bf3b334ce258abe33a9  session-36072\nkaff021bdf47ae9d7f24235fe24594f97  session-35425\nk7c4fae744a34b0be79d585650bec7cdb  session-36077\nkddd44ff67092c4311ba2618920049e40  session-36133\nkda3d2979e4a3759053f1d4abe8f1474f  session-36210\nkf4c03c737f172490c53d584491652138  session-36254\nk32ee7e3d2a405edecba36af7d1371e52  session-32100\nk9bd2db5cd4d450e04847643d06204c21  session-33987\nk94fdf089d1873c1667b4f1fd186d458b  session-34353\nk5b0cf545ce718b19e05c0266a5da363a  session-34377\nk7e9570f87e6c4e79c6896cfb2fa9928b  session-36207\nkea7aa9afd7568eee7112d923f91b5598  session-35583\nk1b2ddc1af5ab617321b82f3d3dbe3381  session-35584\nk245ef1c70f4f0789cae92d8a67c8507f  session-36005\nkeb3c7256b63ac41046b96f712fed2030  session-36208\nk93b81571fac72ccc6b95c37d82a507ef  session-29471\nkaee1aff8d630e3f6a5777116e0006abd  session-33995\nkb2d34a4345c01520cd7be4d5920b2e9e  session-34596\nkabf456d78787c8888918deef5090b66e  session-35728\nkc97df219eb4f1eb8c2e14d63acd8b961  session-35908\nk1654cd25a09cfc754bb4da86452d75a6  session-36195\nkb22066c0ecd1f1f0d0a58f725b54f9de  session-34577\nk3a8f1184271b6b5d86fb1e3353c3f536  session-34050\nk999806814b7050d1bfe21c3d3ea7c1f7  session-35762\nk589be3ffb0a7001a0c52fc4d23657eaf  session-35957\nk4af9db135585f4525d0f1d3b11dca3e4  session-35829\nk9bbc9d9f42935a92dcde50f4a66bff7e  session-35849\nkdc06dc49ad24bbbf538b0adee0000b6e  session-21053\nk7be34ea8d24b18e92373eb17b282e843  session-34305\nk26ccfe03370f46afe89dc4b10a0e5f46  session-35422\nke26a26d7163b8b8fd181a9a6ce34449c  session-35530\nkc3444d3700569c6bb554c96cac4b5df0  session-35593\nk2b0d4f006e5f8db64153bc29b9b3855c  session-35917\nke315b469629670d34559f7187c1513c5  session-35651\nk4da5d2e682fd71d062447a796f76650a  session-32088\nke96b2e8cb65ab8c148d8103ec17965f1  session-32105\nk3ac9a78bd5b4c1c700f25000f9a47906  session-33953\nkadf1dbecb9cf549622d0f9e12f8fd13f  session-35587\nk8100c7da44d848faa8a3af28d6c88a72  session-35944\nk21885175bc45c0d50759fb7afb435589  session-35991\nkd741d26bf649b204d95c654700e41302  session-36030\nkcc01726f5332600198339b645407244a  session-34548\nk8a8706cba54e671f975df2a885f89e89  session-16506\nkf02ded38cc80222319edf0bfa9bbf82c  session-34359\nk1de2b5312907030b97b3e81db036e12a  session-34652\nk45c4597495916c06e54e48c5aff5dcdc  session-36257\nk5a36086ca06b81cd017f65c29a8b4a2c  session-36283\nk55d5290d293bf08254341f976442c10c  session-82\nke784f0b9ca8ce58d3e2ec0a552ffd52a  session-35594\nk47d221b2d4debd410bbdabc15a576310  session-35839\nkf32178fff838e89961ec6c6fb42dd7f5  session-32928\nk16b415c4ac143dd8114852596b258ee7  session-33973\nkbe3731196c70c450c6ef4701ec0cde13  session-35394\nkf7290c19e1b0896c53fbdba2ac414105  session-35896\nk231f256220bcfe9387cb66ee326a24bd  session-35915\nk98472a0639888dfe744245f63937a8e2  session-36114\nke3581d417a90b9715d9ceea71d609c44  session-33959\nkdcd559151b18bf4831e60ff6b58db403  session-34009\nk8b0c5d1b7402a8b56000f48bc1055499  session-35315\nkd2f0a60599a2f27d6f04097229f48ff6  session-35428\nk3011a713435b755efc5f4b9ba23216d0  session-35613\nk523558f9dc1355d5ec84188d5ea11f0d  session-35691\nkf0a525afeb5d35998b46162fc3a25760  session-35962\nkf029d2fb1c564dc22d1bc1fa6a0e94e6  session-36278\nk26b99da0f4a3cf4eb5c3674e41c80645  session-35758\nk1ccd8072b97b81bad6d5acd537abdc63  session-29971\nk762c607ad1b668c8fad319e0a53a85f7  session-29978\nk0346a09168b17660f87e34c8b4c6475e  session-34806\nkcbc6623883c95e59d13a5530f9098c32  session-35184\nk271666166d666026ac65776f790f9d4c  session-35449\nk0036390e09f1722b6f91a394a76233e3  session-36117\nk17bcbff9340a3948de0cb8a4dcb06107  session-36234\nkdf9e6f922413c3ccb623f9381180e4e6  session-32021\nk9a4b67eb77f6a9f2034543ec7a9eb27d  session-33942\nk4029c867a2af93d13994e19b83852a30  session-33949\nkcdf3e59590d3e42d42b9262c1b641065  session-35638\nk5b77a7ee7caac73e6121133dce8c47e7  session-35705\nkba78cefd4417e0a2aa2e68c85ddc98ee  session-36055\nkdce05674248b15b0a51baddfd9f8cb15  session-36276\nk612a584df750e143201cc34ee555e14b  session-36306\nk95c7cba5311f4b034701cdebcec0395e  session-33090\nk4701634f1515ca7561895fa8f44e76b9  session-33111\nkccc731cca68f438fb120d0a71f5103c0  session-35934\nk061f6417744b83268827bb2fc4a53de4  session-35958\nkacc9ea391be694e512da3083945bb157  session-35999\nk0dc03e4d27c1792b1d98de76a69ef4a2  session-36067\nk4edb00be35d047f45daf636c90c7fa33  session-36188\nk33416a26f70e663f908392a17f0d0c1e  session-36305\nkb7c109111c8e4278ec7e2286800d5b43  session-22389\nk8b0d39dd9036123ea605da53f0a8f0b9  session-34639\nk5b48ac588ccc7bed6791d68b21a6ed12  session-35707\nkb48702a692a634d2e1d04418ae253ee3  session-35901\nkc3806f5c142399261d79e73de8fadaa0  session-36146\nkb8bd1cccf7ae78b36d18caadbfaff509  session-21073\nk67773c397fa4a6a595d6d593d7658e79  session-33966\nk4de55487389b5277972a3124eb14320a  session-35329\nkd0a662ef907969783d2fd384f287aa44  session-35654\nk7ad3c513718c79db87f37a7eefcdc963  session-36107\nkae85c9ce99145fe0c5f148c5311071ee  session-36233\nk1928756a9a62dc4573afe57bc388561a  session-36266\nkd67e5a5e038227167df07b2745a0226b  session-32034\nkaffa3b555585b0a913d9bc751e105fe4  session-32847\nkcebd7ad6ab7aa89b1f73226874905565  session-36025\nke3f6bbae9ae32aef07a525967a4aa8df  session-36049\nk6b3e5fc4f57741b58a99b155efd27a4f  session-36079\nk99f9cee48409a2e6eff8a7519fc28abc  session-36221\nk8d8f23e318fdabfb97224c714ea5a9ef  session-36310\nke5c55ad5aaeb311eb296cf9b87f60d6b  session-35374\nke02bfdb2c3d133f94cead3e119d0d888  session-35661\nk1b032f8bdce3574c7ce45ed18233c364  session-36095\nk23ceea403813c2a200e648dc59edfb30  session-32710\nkc672fcae8da510d2e0255d16fbe0e56e  session-34466\nk7a0c94684fe92f5886a2e392e7d9c65c  session-35899\nk939101525900afb46a2251c6ae8cdaa8  session-35956\nk562ed02cf4d9f14d42f3aa55e77863b2  session-35983\nka243cedb48637e5c8cdf13ef6b03446a  session-36225\nk8fbf1e338376483172e68557396e648b  session-33009\nk594749652d4d9a807d537f3f34b749f8  session-34269\nk4c5d9dd37c149b9be08753e9f37e6236  session-34366\nkc62d80fecfba07fdd82383943572afec  session-35571\nk4369ea7343e89d39fb27fa6d63538677  session-35929\nk4d4e5b2f833e176a0b5aba925fb5919b  session-36222\nk517f79cd0f07df191f12f2586f871c1f  session-32446\nk3e197c3b3d04ded84dc13ad1b1be889a  session-33917\nk4faf78c424660dda3fcf71af9f0b7e4b  session-33983\nk0c919d6e841c51698cb673223146fd0b  session-35630\nkb118d68298db356f7ccaa943338e26d6  session-35900\nkffe4da57a173506b875e4898ccff0d68  session-35952\nkc7109d6316e3d0df86a01dcf8c65d9df  session-36147\nk08508362b38ad5c9a1c1b32f9b0f7802  session-33085\nk37c60c6fc7f9923c9e76e22fe0a348a8  session-35432\nk22e2f7fd57b8c23d24ee24a6167dde80  session-35704\nk88389d4b69d2b20265cf1aa5efb5af11  session-36036\nk49f3739a7c8b453e897b4f47f8ab8991  session-36104\nk07a86a97dbef1de4d7a9e6575cc27183  session-36246\nke5dfd55c6406d38f52dd4ce36c7f8d58  session-36249\nkf2c20073aa35e21848977a382ecf692d  session-34055\nk06a6b850ffb7771b11ff18488aa942cd  session-34273\nk3bdfb7a5d07f5aa266ca311a58bf2852  session-34370\nk5ad167699c429411ba3ad1268d318136  session-34595\nkd6d1eb85f6c372ca27dd514342a26408  session-35674\nk0c734e38f4cecc37102bae71fe10f65b  session-35935\nk188c0ed80dc76896a1b7fc311d42c48d  session-35970\nk962864146616d7157effa764afe295ec  session-32939\nkc5396e1dfd6ca41cfda18ec2d6fdfcf1  session-34154\nk4afd3b0d9ef832711824e328bdbfc1a2  session-34776\nkc4bd8477c18d2b8397135c0738785f5b  session-35395\nk0d15a25beae6186d03a6c55749ac462d  session-35889\nkea1881913e83545b329300730b218268  session-36180\nk99578f1bbcb33e4d933fe2207008cc97  session-33948\nkd2eb6265a836abbfb92c1d83c4de37ab  session-35943\nka8786f0f2a418072a7dcd7c0b518daa5  session-36131\nk9f98fefd5462e640dbf0b0f6bf542270  session-36176\nk33b0a78b01a9829ab8cc78feab20f569  session-36193\nkc5095fa77072167d5743cd46b94eac66  session-32118\nka1cb83f9762f24607b5c73d12d185af1  session-34440\nkd55fa2d9fbfa0b4167c947953554a01c  session-35754\nk601bcf796c8a4e4cea891a15a44d44ae  session-35922\nk6af5fd500a0317fba95ce21e8f5df77d  session-35954\nkfea4bdad3b78a528c2ae584d965ec047  session-36010\nkaa233a651a1bf719b410409ba9b54319  session-34876\nk30f85f494c2c04c77daff4b5fefcdbf3  session-35437\nk872046e81524cd7ccdf7b782610cebe4  session-35880\nk0509ce71cc6f1c96675d7da2f6a2999b  session-36035\nk463dcc6e55b1f5c38655f87ac7b673a9  session-36081\nk83c11a8dacaec947b033f640627b8779  session-36116\nk2ce04f51548a8db186c0dbe24f7caa70  session-36139\nke255a47ce1a5dd99849a94e98b853f16  session-22353\nk82e6d322c6df41630d3ff712ee7a4bc9  session-35645\nkfba197f241ca4ebd700c09f7d0331001  session-35690\nk3d1f88346668bb74f6398f5ad579fda1  session-35995\nk1945e39d406db3419997b231a129d4af  session-36123\nk0a95b1e2b9832af05a5092c84f455f47  session-36292\nk1680b60029a83faa474799762ae16043  session-35435\nk7869f8510ea85e77940caab69cd9e7a6  session-35576\nk9bd1d455ac0de671a2f20448dc2b66a7  session-36051\nk917e6d073973f7b4521483bed31a2d65  session-36128\nk6d025893b730705240243d8a33cf254e  session-36184\nk70404468832fee4f08aa8ae45dec47e1  session-36243\nkd9752b981104dfa191899ab7f785bb0e  session-32707\nk15a829b755ea223c8d1754877f8b7d18  session-34178\nk35fc92cd377c4ef95a3cef4fd3da16f5  session-35397\nk3410e520b332f99572a4c9be978d9264  session-35588\nkb05a6e67c3bbc598d3c05d0419221a29  session-35628\nkdaa8b19408776c6ede1c7ef3664d23fa  session-35751\nkb3880e0415490acb744541d3736e1072  session-35914\nkfd05f31819c5255740132bffa1c57dd8  session-36060\nk3fd9caeacaa6d695591da2aca3d2fd1b  session-21517\nk200f8aceca571bd42fa00429e03960ae  session-32816\nk1fa759b5c64435779b69db09365f7e85  session-34343\nkb5f77888c96c602a152a059a0cfd4916  session-35760\nk63089a3c6dce0d1222295d692d176afb  session-35939\nkc8644c9023b8774ce699ffa851e18170  session-36027\nk8d3902a7752711db24a5e60a2bbf3c53  session-36217\nk4d53ac365a98feb0471cec2b7bc29235  session-36238\nk1dfacab8c81a10229bcac3bc91b4e28a  session-15603\nk0517e80b0a2e292acca7622d7d157fb5  session-34744\nk248002708c310d68c5c4ad94fd108ab4  session-34785\nk5829c03298250ed22bf87d809a3e99da  session-36013\nk1e5b3b7c92c1eb4956d4345acbec34be  session-36022\nk947d393b85e28dacb46d5c9b05678093  session-36282\nk4bcdfc55168f7596b91cad1d725aa543  session-36300\nk932014b3ad6d8252590da0a81ee32d60  session-17547\nkccd11cb02d7e4609cf63b43a49d28c5d  session-22349\nk1333e947c66f1b1fc726ae009c2ee6d3  session-29966\nka1e6e907223d42c052cea715f7188862  session-29968\nkba92536734027eec6dcc371a75458ea7  session-34808\nk896b78d77bdf5ed5cb47b96efffb07ee  session-34976\nkd723e628ecba191ac224a008601f2569  session-35964\nkda1fff9d9d9c94c2447cc534b6858751  session-36182\nk770ea07c277116c723b271b0c739f75c  session-35577\nk6e107c633e2adafa8887abd96b3f0afe  session-35833\nk1c440e192e86dc62c769729090271a2c  session-35951\nk931eb1cd85a1625fe6b4ebcaa0e66afb  session-36061\nk528711582e3221b6e4fa3ff3e7d7e413  session-36064\nk591c35b66b4da121ff958d015fcfd7e4  session-36126\nkda962005bcc2d0442c6726ad61214693  session-33954\nkfb3518890df8f408537642f23c459d55  session-34346\nkbcc2b62437b9e1d5847335ae113e80c9  session-34599\nk896f5c9cbada64ed7f67e07987bdc9b4  session-34641\nk05a423330302c43008c34a7ea824787f  session-35430\nk4a164910034e66b13b7bafff18ee059d  session-35448\nk55b9b81ffdc2e41c1dcd344bca7b5de0  session-35892\nk629a813e66f16eecbc91bbf3eb507939  session-35963\nk0f32f3aa59efb361223c40af0b072f2f  session-32915\nk0eaf56fac64931d4a34249a37c5b8377  session-35429\nkae4d8dffc432720df5e7fb4ddf95b895  session-36002\nk3768b739770eac70fa8a7685c0c5ce3f  session-36089\nkb29426fce18563e7317399b59a072f48  session-36103\nkbee9f6edc06dd0d592199efba5778f7b  session-36235\nk0ff5b5439e38a73ab42e465ee0a332be  session-34457\nk2ec7a8ab5b73a0fd0b1226718fcf9942  session-29970\nk0bbf1290faecfa306fe259802e6190cf  session-29981\nk0126f0e416dbb20287bb7a50c8d9483f  session-34291\nkcb8c778d800bf85447025372281434fe  session-35879\nk1529f69a1c73fb0f830ffe87f83d71ae  session-35959\nkaf05f75a7494423197a054054edc7c80  session-36125\nk977968d567f7920e5d3ae25514f62f50  session-36138\nk256e03371f86c03ba1cd48072f19830c  session-34470\nk32d7121c02a757ac8e064f5c54021a53  session-23430\nk6c121c6baa89d9dbc2c1ed52491e783c  session-33999\nk6c7dbc5e14417120577b3cd7f2cbb69b  session-35020\nk41757fc88efe5c995d6421c714b3ef8f  session-35023\nk7a632a42d74e42289ae6585fe9a1714f  session-35431\nke53b946a9255681a3f48558b4e759204  session-33835\nkabbec14153226b9a5dba58d5316e0153  session-34618\nk48ce4461877e222ececbddcd18804b05  session-36121\nk108a654fe3e2c1a4f1b1d2349bdadd5e  session-36294\nk45f60cdf9b5ac4313080ff93fd3832dc  session-34579\nkd6c4d49bf21457800eb5de1a0964af01  session-29976\nk55d2b236931139e28f71cffca518db72  session-33260\nk11c7c0410e082fb0eb51128b4a59ef06  session-35290\nk26682cdf4087d1cc6ab92c24642dcde3  session-35961\nk2ae45dc1cadcd621cb7b5d97b8703b74  session-36004\nk35d5604abffcc8c885d938c0c1b05dc2  session-36073\nk661f84b6733b127af5559875c7bb9849  session-36127\nk9d902fff5dfcbebd0b17b173faab739f  session-30447\nk5cf9a37e54d4894616cddd86321c7944  session-32408\nk9d3fa825475b9c103994af0b6c211c6b  session-34090\nk12905f3c5105cbfb351b7fde0766f943  session-34790\nk6c7cddd2379d42b74816ab66e3ca496b  session-35082\nkf64ca4f00ba4ed26efffc363b2743860  session-36220\nkb083bded074f0d1cc466231ac055c20b  session-36264\nkc58644acf00c2b528fe77e4a4aaf6ec4  session-34054\nkfee818f439a212dc2bd24ea895f28f5a  session-35814\nk1ee6d95133555c21c068dd74e43a0e2e  session-35881\nk88cb0d94d04505770e9d5ae6b8dea951  session-35948\nk1aa7de5b914b537f034a5d8cd986f3da  session-35996\nkb986fc3a548cd135915b279c79c91714  session-36132\nk52ddb6c8685d17cb098e797267080736  session-36293\nkc6c8922bf93a91b3d74d6808efefc651  session-33993\nk647a9388efe97d9eff713452f5a41c17  session-34654\nkd612815fe05e5d748d45243bf911d452  session-34773\nkbbd5eb2a65d05a59b96f8a1458f15ef4  session-35330\nk21554bfe26b8cfc5876a0c04ea06082c  session-35623\nk3cca48432ced8ad6bdb34fadad296f1d  session-35650\nk3abb787bd7cf5c570e6227e939c7bcb3  session-36110\nk887e03b3055ec271db57f979793c485a  session-36194\nk32366639e2976745d495ea53c2ed6f57  session-31951\nk420bae3a75651571dad4c7530d554cbb  session-32815\nk7c436d9ea3088458cbb735810758bc16  session-34300\nk38c7895bc677c91bd83a34b20b28b4d6  session-35561\nkd3735b7c2fc93fd6e1050e53ab25d0e1  session-35578\nkac3c404fa34d593c6aaa3786488886c6  session-36059\nk71a6320aef219a4ba8feeb6851cc9967  session-36213\nk5946ee44baf81c22dd2e1767b1553fa0  session-36231\nk38117c9f702599731c1c510d07a246f6  session-35589\nk0ca2462aa314372798a3c10138a5552e  session-36253\nka573ad034da9b65fdab4da7faa0659d1  session-36304\nk7d53d13675bd756c13aef180b2bf7892  session-22522\nkd21320f2ebbb06e2eaf7dc27b1540865  session-34994\nkc6ad0bdfd3981edc40d0b81b4991235f  session-36122\nk8f2cb3b58ea52ea8bcf6a6a270cb7fd2  session-36189\nk4035524032f72b1d0171736a006521e8  session-36209\nk77cb14992341a5e62be6f864d5e86bc2  session-36267\nk9b2adb64621aa968b1459fa1f374595f  session-36273\nk9799c5468968c87c328d49f0db9683e2  session-33542\nkb04c21bd685eeb392df123104cdec367  session-34468\nka139cb7b6b7877254fa1ab92ffa371bc  session-35743\nk233dc8d6c47b9bbbbe630a1baa856797  session-35854\nk70b1fad057f7b61f06246622330c3741  session-36017\nk5497cc95c1e023da6a402f158e26052b  session-36129\nk825abeefefd554d11c73e308aafe94a4  session-35048\nk5543c9eddd7196fb2a8d540b43c18984  session-35337\nk26ad12ef558d4c0e179be57134f44981  session-35729\nk371072f792d6ae40ff8f411b3d2fe63f  session-35820\nk71886253cf7bb4782955dd024aeee4f7  session-35882\nka1974eb3eb567a911c8e35a033fb8d19  session-35992\nk37a85c46fb695bd8ffcfcaf0ee0b4d91  session-36084\nk59226cd609bb81669c38c87975beeda7  session-36297\nke173d85ad0f713a8ce7b364d9cd6587c  session-34258\nk3c600d599d206a90e0d9121d98d61e57  session-34314\nk0b53879bda27886e571612763d4723da  session-34759\nk6848543ceedaf0a70fbd2964d3329737  session-35775\nk0884156805ca9f6199f7defc976ef523  session-35925\nk466483f8b8b6b0ebf9e5f80c3a08b032  session-36023\nk1baf811a8f63b57eb15552d3cecb7ff7  session-36105\nk7a22a5bc2f54528eb02a10c49f4ac70e  session-36256\nk7dff7e51994e35403138e5a1316ecf21  session-34398\nk3f52a075df6d29e57cccdc5bb28614fc  session-34556\nkcdf83157cee12555ca08085266591be1  session-36053\nk880ce66489cef0cec44fa3901b7a9de5  session-36070\nkd23dcdac9592e98442c3f322644be0e0  session-36124\nk65d007e7023e2ab910c0392df337e53b  session-36331\nkc91df307acb608e09909953fa2b6d5a7  session-31927\nkdf3f5ab51996d4de3188794c4cd7f1a5  session-33996\nk2d1bb06ed516f7910ddbf10412699124  session-34311\nkca8ddc1a2f8d4b255ffd08ac50dd2a6b  session-34514\nkf1bd519f86519cb36b02e3b775dbc317  session-35893\nk0d67b081da17d6d20ed8a3728e975609  session-35927\nk9d1dd3e788285e5f2012946f4d146f02  session-35183\nk4e53ea1d1b2f3b17539177fb68c7703f  session-35342\nkc483cfe63cafdc264f1f7d24f184c1c7  session-35750\nkf14afbef6a35368005f3a56fb0fbfd3b  session-36148\nk6f52794e8bccceb98225609a32e41729  session-36201\nk43647d5c41bf35e3dad1ebbf7cc1cf1c  session-33828\nk3510ae13eddfeac6c7b41b751aa96979  session-34408\nka01e476e29c60cd2966844977593f7a6  session-35771\nkfa3d20c9bc057b61eaccf95d5f933c00  session-35931\nk9c757fd46a3cc4185b37c727c15e1690  session-36021\nk2815e62b9332811fdb2e2dd76abaf60e  session-36096\nk2b35b4996ef2ad5a95b48ff86762734d  session-36187\nkabaca9f25f7129f7693eef8098924310  session-36285\nkd0b23320a0ef6f4367ce12c45867cfa2  session-35529\nk75fccf98a5bc1eb45b12977f65ca5dce  session-35968\nk71905461d254167e1c235506dd3a5140  session-36009\nkc912522ea0733e6036f6b24ca4413daf  session-36088\nk9a54edef677209258e000df71186f2df  session-36119\nk9a38de2e70635b54b3f8b70da9fa87c9  session-36327\nkda03dd0b79d0fe46634ff2cc95cf28a8  session-20618\nk9c462bf5b9de6a93887d10aedbfaf5e8  session-33947\nk27b312b2b955baebea2400425ad74749  session-34471\nkdfa21ed8c42889ba4f6c640c950d59a3  session-34678\nk3bbd541600311a2cd1fe8a61f306ee68  session-35744\nk94b6d4baba324f45a8dd1d470978fe80  session-35818\nk1525c4ff5f431ef31962e173f7e8d8cb  session-36204\nk207a56d47c5bbb05fba7cda89d5c440a  session-31143\nk6a010b5f83a032aaecf4a879bf98daa5  session-35339\nk16f851149503a92e4c3f9a39b0163bca  session-35708\nke4c16befb37421d3f896dff3165bb89a  session-35831\nk0d4b57a9a439e2805cdd639d717096c3  session-35902\nkd4b0d8cea8b2c614b9c73d146e9081ed  session-36000\nkbedbab584b0458b2276d82f995ad7f5d  session-36093\nk953dee9be8eab1dfa035d477e34ea2d8  session-36279\nkae139635970f360bd89b5d1043c31c89  session-29900\nkb231cb85ec1c4b02669551111e45cdd4  session-35409\nk81c4cd884e9aafdfc7dc17f0d9dabcce  session-35671\nka9a681a42413df4d560c23fd518c6679  session-35993\nk0ab52fd83b91a2196f7ee0303101a087  session-36178\nk3e3e25992f9c18d1b396448015d16f65  session-34337\nk4965606e1e70b153ae77ead2fe1732f7  session-35796\nkebdec240969b657f1604b6e1dc6e7c97  session-35933\nk41cb204da40ab003922b451c461dfa0c  session-36026\nkf6a16e2534c2c31e21d3843978c4379a  session-36037\nk145efaabe08495e9aa0cd6f4e35422ab  session-36177\nk904f6277bb38f5212941235e8119ab7a  session-35033\nk7edae88c306261cd087536b9cdd5a7da  session-35338\nk5b2dbdbc60f1b9f4fce7c807064f4b8e  session-35398\nka9cad2fc9b8ddc310494a69a85b313cb  session-36019\nkfa5578b70aceb4f4331a5417854ab3e3  session-36228\nkea93ebffabd5b044d363403421fe9133  session-36288\nk16361da7ccee1d4e595b5c9dbe5971c9  session-34121\nkaf571d526de57069f1a8ca9971b3c961  session-34462\nk9d8e63dd7e05760d58c46e2bebe62041  session-34672\nked8583a37c86ae76a43773b379bc1021  session-35322\nk47e1cb576dd7a5c3b7a1537642df2f93  session-35402\nkf882e63ad92c971a0234cf1137679c1e  session-35913\nk786cb06f08ea1b01dbcd919e43ab3d22  session-35494\nk59feb68f9d1c339c98bb2564b6f30861  session-35749\nkaed6b4badfab31899237a03cd496e117  session-35888\nkb9eb90b328b41a40d5c180d156238287  session-36042\nk521bfa122e3d8c2e605fed53cb7a0f40  session-36078\nk3232093ab23640aa6c29778e16c482d4  session-36112\nkf2f531eeb71e5902f91f5061b859908b  session-29449\nkdfc37e43172e5385e4d604c4cea22a5b  session-33544\nk468dd0cf4b0acb389e3785c6c26d44d3  session-35595\nk73a87decd7cc35349294a30caf8406d5  session-35731\nkb1dd97584770d34a05a6214f32cc3467  session-35781\nkd8e0d61691fbbdf78011611256b7c0d4  session-35850\nka91eb5f3a21392375a5ac252c032ea0f  session-36212\nkb734a66dde244761e7244598640a52a6  session-29935\nk399f5bc3302011009eebda5b74163be9  session-34656\nkc381682c4bd5e21664c2ac34d839657b  session-35258\nke2aecce706ebc97cf6ed81874cd1d80d  session-35960\nka4464186c6fad2effef9072c9a78b457  session-36020\nk1356077715c3cfa9c430342268897258  session-36056\nk1c7c0dfb65c020f20a26b2b73edb45eb  session-36252\nk0ccf5342dbaa1b69f8e2f46163fab922  session-36272\nk55ab69ffb36d43c80c9ff5e3e5c1c300  session-35752\nk7b37de6f687d300065d193aaec0f6851  session-31928\nkb74a6a37b890feec9a08b9721144b312  session-33944\nke445151ecf4eabcb4235a550d9698637  session-34640\nka71186088112b638a2e3dc2d7f320b96  session-34663\nkb03990bd1e224f77397562eb9bfc46bc  session-35894\nka6a7fe7d2bb1b973bf6ad596510c101a  session-35898\nka37a60ae74d83537b186a422a157a045  session-36063\nk924cca8384fba1609ea273d9173ab249  session-32502\nk6f287ab0675be9a31d16db7fd51eb82e  session-33910\nka6ad85f937ab45e9ecc11453a52d5c08  session-34077\nk38250b8923de0d3ec3b48f28b676fb34  session-34134\nkb1978a0f95bee389af18dbe3ec4d25d3  session-34215\nk0a5ba8e41b532c6672b3574305f1fb6f  session-35411\nk2985eed6488fcc417da35cd29da4a929  session-35809\nk1506ee99be99e60a1bb9b8c0454c3597  session-35980\nkac6b529a3128e1aac15302eb200fa355  session-16326\nk7dde412aa4414f4eeb9be18983aead9f  session-16359\nk5fd28bded5e7fa32384ebaa44120dfc0  session-33985\nk9fa268f6148a7ee937a8c20d8c77b95b  session-35134\nk336611a2b54662623aa40a8a413086d1  session-35860\nka50a207a78cb7ef962d95437acb1de99  session-35861\nk9987ccf2efb016be48de0e996e81a3d3  session-35891\nk1215bb3695c88d6224c1f7e4bfed98a1  session-36120\nkd58f0637ab5173f508304a9c85c1e70b  session-22460\nk8e7b9208d3708f07f03897abb729058f  session-16251\nk952de1148ca44cd42865e588db0582a5  session-34231\nk06507ac5d002252ee658fdc39ef4eb61  session-34632\nkc7674946e7bc6c2bc271fd151d98ca52  session-36111\nkd8834c30a3abef34fbafbeeae65fe702  session-36296\nkb3d7dbfebf5a8172f28ca601c1d5c64a  session-36299\nk7dab276767832df4eacc28225eaec8d1  session-33340\nk15c8aa80082978be514ab4ad13b3f884  session-34349\nk9180e416594f10d6e9cd5ed72af40fa5  session-35834\nka4dcd35db88b89097de3228b6eebf8c9  session-36087\nkf7713c56d1ea1250ea46703c642abb69  session-36192\nk683f46616b5fa72718a0a2b891dca115  session-36227\nk7b2a635df1aa0906eaf827cf09c0c305  session-15592\nkdc49e30aed05ff71c44ad2f31f9f25c0  session-34094\nk18c0b0fb28b564e927c00cdb3236179b  session-34691\nkafc23aca19db7628e8d90b1afa5451b3  session-35727\nk3fe9cac6ffaa09756504049f034a440a  session-35916\nkd5c3839a12e2bf24f810303858b326e7  session-35997\nk9d20a5670961947ff23e0ac56d557d70  session-36006\nk5e5fec8b3135899ee91fa1d9fda5254a  session-36137\nk29c0793ec5211245b0309a3f394fc331  session-31060\nk1f054fc0bf7257e22b895633241557d0  session-33992\nk2171a13e96c89d7c9d6c9f31951db671  session-34872\nk9267daba9702d3460b9b9c6b2edf8a61  session-34883\nkf1d0c6ea161de220e0ed34d4e93dad9e  session-35389\nkf13ed29ef41a2bd45e1aa6133b17d2ee  session-35930\nk1535f19c141f0943ac2f4b328b7e2359  session-33360\nkac27f6cee65c43d44cd344155d714f89  session-35444\nk21b1cdd81386e398a99820ff3ef38217  session-35862\nk17ea03df3c52ddc5e6f0fa2c59574810  session-36203\nk4a901d90d68cd3a942dbe0493f0524fd  session-36226\nkf11797b3491f76b5f18025c25eeb1fd5  session-23035\nk51bb73d6d44b72dba613b89a6f96bafd  session-34605\nkdd40ea66acf91059ef6933b7b6a45446  session-35346\nk9b07f1e502695b0a6677299825ec92b1  session-35396\nkfcfc22acb1512d69b3b31d0a974c8e17  session-35874\nka61fc9c65b05c76d8831ce0ad7f661eb  session-35976\nk8585fc2a971f4872259edda7db1b51c0  session-36007\nkf3da19b002d364e7bff1073edbc48f33  session-36068\nk70262bf60250d236fac503d21e82bbe1  session-35706\nk965411bf38158161112dbb6c7fdddede  session-24049\nk41c8821d1569c8babbbda033e6774490  session-32122\nk574c94e0e24735f44c1c3e2ef1559c99  session-33886\nk402da37740a295ad518e30f1fbd01b50  session-33952\nkbf230011e4e0295a62ce323b2c664fe7  session-34455\nk90fe6f575766a14c95cb81488c3c96c0  session-35969\nk0a9764d482133fe1106ba3159b04c72d  session-36240\nkc0bd2d58f2cc4a1a61986ba79d9d2c66  session-35022\nk98f5daa19ee735e728288df9edf0c0a6  session-35320\nkb1bea4867699c4572ea0df703016eb91  session-35336\nk1b9c562ef86f635156fe6c09266baa90  session-35542\nkbf6e8ef810af16a3d678160877a22965  session-36046\nk7391650df1cf0a8a8e7bc6a6a5966707  session-36085\nk54af2762c376f555b08d1c31df6d06c4  session-36101\nk40b4adfc89ae7c8774164e15f6a1f929  session-36106\nk195ff19fc6ee2639fbb94fca0e4948d3  session-34201\nk7015d0afb0b4bd6e47f01d957cc975cc  session-35967\nk159a7f7e368a87d42069b62ec332472e  session-35987\nk0851ae199cfa1b1ce8d16ae4af331626  session-36190\nk7d006d42c1c41d8addd99ff90bd74100  session-36312\nk3af384313d7000438c6b67112b166881  session-16499\nk9ae1cafa4f49088d69bea21047ebcde3  session-34288\nk5d2337c69b48bc393583bd64e8ab26ae  session-34884\nk096b3cce7cf2249ff372ba45e69b04b3  session-35038\nkb85d4b5a56124cae2cd5ec6ef2ce674a  session-35890\nk60cfd0a07a3c3b826d6ec1010b8fbd2c  session-36048\nkae5ba9e0821fb10def72379e195ce0ff  session-36191\nkb28c434ecd322958d3115f699036b83d  session-35403\nk248742c45d57d5e9ec14841c37807d20  session-35742\nk62174aefe58df64e585ac9ec6a8177d8  session-36016\nk4455e2a3e7bb9bd5b0a945a2d6500ce4  session-36115\nk926b5bbb574d8142462973271733590c  session-34800\nk4311dfd84b2366318ab1f845eff09167  session-35421\nk7f387cc740c8319e706510ff25a86fc7  session-35520\nke897605e5135e5628293f8bbfae1ed99  session-35552\nk50ca47c7ed6d06e6281b0ef6a64e58da  session-36092\nk488063e90b4d783da19e19f08e655176  session-36275\nk9fb83386dcc7de335fcbdb5883470bfc  session-31981\nk8414879cc8233d1f3e8e3abed9bddd1f  session-33548\nk25c71ef98aac17771c3de37a7d470975  session-34453\nkdc2c5751a69f55c162ce591173105e8f  session-35819\nk12fa9a59dc8fcdf43a5baa70c670bd7f  session-36039\nk2dd41a9b085de2aedf379d8cc1b6f2d9  session-36284\nk42a1de2eb102b3c782ede0d21dfed843  session-34189\nk5261bd851342ead146e9c8b598d9657e  session-35410\nkd00c5d4c18573820ff90ade5384c3c09  session-35761\nk5d5cece5bfad096e74a5a10fcfbde40b  session-35955\nk3b12ab5a172176b39560e0848c89875e  session-32128\nke03fed315e8341ceae84c1c6bc80408c  session-35173\nkcbb04c96e952f32ed5f4dca2684c744a  session-35906\nk8022fce050ac09f8a466d12f3806e016  session-36309\nk8cc09dea2b1960328f0016dd456ec43b  session-22907\nk6bfbd8f727e8b8f845a84e39fcf4d361  session-34279\nkb43dd1092cdc600d92badf87d50fcff6  session-34838\nk5952d21548d9ac828a01ecaaf2350ce7  session-35905\nk73480649922b265171a4c6236c83298b  session-35937\nk3f5239fbf5178cfdf09022201cf79c77  session-36041\nk51336f37c75a5978c906459636acaf28  session-36058\nk1b4708f7ccef9974487e4192cd147788  session-36286\nk79e373c08d3e9804c372319cb36cd2ba  session-15073\nk6d594f53d3cb92a3b1953411b3b78eae  session-33527\nkb139901372d7bb831b14be04fca3a825  session-34619\nkebbe1d8d15b0e8403237e6621b0d3c3b  session-34875\nk8ee4efda877d9e97462f1d6ee23282b2  session-35361\nka2e3ccf668afcabb8d2fac78b3671620  session-35975\nk7ef06439394da3b08980d2ae4516bfb0  session-36268\nka977df62b213e9846f76818cee4d5a75  session-36323\nk5e719b4ecefc28e9ba45024be446ed37  session-35029\nk3528869a00863b1f0ed6e388f88a1e64  session-35390\nk68101950535b1265d14688c5cf0cfbe7  session-35400\nk8f08126fa0c8a5d6ffe85ba10f563829  session-35872\nke74274e8814ed9a6728c368339d76677  session-35949\nk24b22674e650c9b62abedd9af1dc7396  session-36134\nk72764b392f2c23ee896aa67adcf2d720  session-31051\nk2b8df21fe79bb9faae92a7ed41ba16d4  session-35261\nkfd9bb14eb5cf67b291f11e9352b5b9f6  session-35328\nkc3e67d0d298a7379aa055040cc5d25cd  session-35453\nkf8d4b59220302e7e432049172ccc5c3b  session-35692\nk8d6b0843c74714b26c92ea892a2b6e45  session-36086\nkddc9942e4173ffe1d992431d264e0582  session-36197\nkf81294f61db72a5dcea13829a9de4ac1  session-29267\nk77eb880570f7080fdfb2617eab377c71  session-33445\nk2aa873ac3717a251499bf28022c7ee2e  session-34330\nk54caef6ee289819d2127f67160888487  session-34463\nkaa9506b9ed00836546109b3cf58071d9  session-35848\nk55a45f48155fcef1e72562903f7a4aa3  session-35950\nk16ba2858f7f463d2b2316ece36740300  session-35972\nkcf5a37afa44fada4f9b87bc1f1409b0e  session-36065\nkaa04dc31c08d1ef3d7d719782b1d29b9  session-34594\nkd0785eeb02f92958ca93010260f2eb97  session-36179\nk2a92ff0eda4c6f6016aa302d38fb6a8c  session-36215\nkbff9baf77984cbdf5959c3573da75b42  session-36232\nkc2f85ec9e0d8c9c601b1a39097d725f9  session-29959\nkb6e923b0fefcc7fdfa3ac8fcd3221df1  session-32129\nk3ef1c1b0055fd572d7dfc11d356a84cb  session-35953\nk91dec4649cefd6ae5ea5fc21832adc99  session-35971\nke0dbed6e5c82cdcf098112113541adc5  session-36024\nk8fafd14f0b31ee299f0764489cd9237f  session-36145\nk2c460f9b62e36c10c63c49b94413d979  session-20469\nk42340190b2216c2be4d4d8e7c07f0125  session-34293\nkd580fe8d8e71763b7811aae9e48baeb2  session-34469\nkcd29aacb29d5c3b0eef07847df448fdf  session-35349\nk3a89f2167fdbed768e9d28d04c196d02  session-35436\nka8dfdaf80a52916c871eefb3b4bd58eb  session-35974\nk7a3379b4ff8cce09d2fbd58d96559c5d  session-35989\nkfa9cd7caaa2f26667f27b9e67a55a926  session-36102\nk6cad33937ed76d46e66c1f284cd1f523  session-33339\nka8f65168a95e3aa119c86ee26f3e23fc  session-35062\nka65b63b4d0cf8f9670008e4a3a04a303  session-35757\nkfd275bcb6d76b112f163148805d2550b  session-35772\nk36512380a694b78468f749a5d4212f15  session-175\nkc4ccdade1e326d86246fdd0eddb52f28  session-34253\nk1121bd60562bd95226b4fc4e15fa16fc  session-34603\nk815c6b95095a1bb0d2e9f3165e6dc680  session-35289\nk32e88b4cd5ab13b70d28913aeccaf12c  session-35732\nk5595c6c1663c3e97c1fda8876ceec9a4  session-35965\nk3387ad5c517a228e41b1178b682aa3fa  session-36074\nke3d666f9be4da41667ab17414eda59de  session-33574\nk4a06d19625c64177470272482d8ef4c5  session-33986\nka83ae67f74399ccc9dcbe4fa6b435161  session-34547\nk4f5af46238437624ce6c6e38c3e16bea  session-35978\nk27315474bc6d3a534cf07da7e1afb37a  session-36029\nka14629ee88fc0e1b4bfd53740b6b9df0  session-36136\nkbaddc9bdfeeb38208b73577394e1e209  session-36202\nk51310012295ce4a53d9688dd5bfb978a  session-36316\nkddaeb2f76e773db27369b0bf1932e843  session-21680\nk79ebec5d71c5caf25e6b626734420055  session-36271\nk8d282cdc29360372f9734b4a43acfe52  session-36307\nk7d016b1eb5af9c35a3777fc3737551d3  session-36311\nk6173ca33a4a5ae6f12469b58cdd8fac1  session-32933\nk094f6fef94c1ea3bb56820f2e3dd9331  session-33911\nka5dab13be0310f4e8865c8fb431654b4  session-35981\nkdcb6e526de3e4994eb516508fe829bcb  session-36015\nk2561f9b765b19f90950eead00ed513ad  session-36045\nk74854159f968a7da769a3bd34f0fa1a4  session-36218\nkadfe0cf4de4973626d555c13616615fa  session-36313\nk542403ffbadbad78322baa6514d11de3  session-33975\nk42e9f918e45828eab677f9b558e77020  session-34892\nkb8779a4d88547b3949cda1a66bc3407f  session-35669\nk565e01e26b4bba0bd15d43083959e9bd  session-35923\nk2591852b0cd433233d4032ab14d09cfa  session-35924\nk1714905a7f8fa5aeef057d96cabcbc92  session-35940\nkfab3513b3499dc3adaea9ef2af316aa3  session-35990\nk805eebe66e2bb68b77ec1666b47f8480  session-36075\nk524bd2dac3fdcad96c29244f775e2dbf  session-35852\nk0b3d406d25e6b07c86797d3804ef1f94  session-36109\nk4a4cefb9c644ba999ecbf4c74240d748  session-36181\nk292cc10e1e16106f0723ecb0c7d140f8  session-36308\nk2bdc8e032714079506c9f2d95291e184  session-21241\nkfc07db96697141000f2a0b7ed6bb0265  session-23060\nkf599c42d71963b852a4afee89891a2e2  session-33989\nk9ed02df17793cbb7b6285217766b92ae  session-34299\nk7590e948a989da6145742ae61c90ecc4  session-35815\nkb4257ad017b6f226820097d0b6497581  session-34456\nkfb785b705e64bb8300bc297b66dbab94  session-36001\nk4d1073fbc66efed7247608e8be4bf5ae  session-36032\nkeeca675a98225985410e284eccf57fe5  session-36040\nk9dad18225343aa42bc841d0648c818d8  session-36205\nk5ca3d1bbcb3a83914ed71c22d202dcb3  session-36303\nk07d39a5753084909544c68abcc502418  session-36314\nk5ae5138f7809e50c40688dd485893a74  session-33927\nkc9f444925d542a05533a41d8fa35fac2  session-35773\nk55ad741fb29a810d3842c7be163c6a28  session-36083\nkb93f31335b7f324fe396a06a5b5d6c46  session-36223\nk4d9fbe990d0572935c9af4b578260902  session-35647\nk778f6d559a69d98cdb8f0c49e3159b5f  session-35986\nk4071a870cbce986146f7d7bd5d203847  session-36044\nke6cd378135843049cd6a5af272f51077  session-36090\nk506d0c2a1ac2599dd65e0fb03de17e2a  session-36269\nkb86133f30e747a302a4224a7e854f6ac  session-36277\nk60ded7a70762c1aff9f784f34be0e35a  session-33024\nkcdb80db34173786cda2df54a79864285  session-33838\nkb6a31e4a2e9f1d39644ee20d630c82be  session-34223\nkcab4de7fbf9692357f236ff57ebd7dff  session-34272\nkeed30f1ce44cc34a254d04b06c6dcf01  session-35846\nk207c1e93ab1057c780781119892de35e  session-35883\nkfd92e0975af25161ac492fc022358dd3  session-36135\nk4c160f11055aaf9150a680d5fe11b14c  session-29619\nk485082030a8adb5cdc6dc33528398199  session-33962\nk518ee8baba28b0dbc2b78eb9ca567f90  session-34266\nk08684a5cc6b2d912ed708b8abe519a58  session-34664\nk833411da99ab40ef9c8ebd0a50d3f9b5  session-35632\nkdc1f4f52f1df3e4c1c5b028f87b497b7  session-33974\nkc4ef5e51c0ba7a5cc719ecd2ab79d022  session-34465\nk817e2fc261f785d2885cb6dba037b038  session-34908\nkfe16c1661a4e1056bcc25e561d6a6abf  session-35021\nkb4ae4bd19065bc18ac65e3f9b79c7b61  session-35032\nk06a790a34f735b3837d61c5a303a158f  session-35334\nkf20fb42c6e95ed332fa7d9518ef4ab58  session-35344\nka3db9297e3349d93b041fb549cc8e5d3  session-35404\nkdf47ebbaacb569df9d4bba19d2f01ca1  session-34550\nkdc0a688b8eec9cce8efe2a9872ccf9eb  session-33955\n",
        "stderr": "",
        "directoryEntries": 838,
        "matchingHomes": {
          "session-35023": "k41757fc88efe5c995d6421c714b3ef8f",
          "session-35773": "kc9f444925d542a05533a41d8fa35fac2"
        },
        "parserFormatControlsPass": 2
      },
      {
        "snapshotId": "7ca3379927d26e850ef32896e3ed2671",
        "path": "7ca3379927d26e850ef32896e3ed2671/su-codex-homes",
        "exitCode": 0,
        "stdout": "k68cf0a9f6b82531784a88c8846cd7276  session-34790\nk004fc948a1928934ba70948cd26c7968  session-35552\nkce763a4b92d6390b77aa49553b4f5288  session-35554\nk1c78430354235f8f21774e6ef8d49653  session-37258\nk82f793251a4f9246c3d0b85db47b4ac9  session-38284\nkba35357fc9d2810b6e04a6b88cc2be0f  session-38463\nka340728fa2f23d09df1ccfb688f104c9  session-38899\nkc44905a5879262e726e7fc84b8e99e34  session-34673\nk9cc3f0504c7608e646215646c959f579  session-35337\nkf121f748192fe88045bff93de957f4e9  session-35390\nkca17c9391c9d26f81bb700373cc08f23  session-35938\nk22cd90a26d9fc1d98d683e14432cf2b1  session-37157\nk4c9d6089a5a1ea040334a43e1f910655  session-37348\nk5fed078fb2c0c59b994337355fd84bca  session-37458\nk180255328b14cbaf5eb95a97b13fedfa  session-38827\nk349cbabee1a423e371f6371c5b49904f  session-34556\nk5b9b15c14847d5edac0e10cbe50f818d  session-35334\nkcd51d5a930f564593d5890db20b4ef9a  session-36386\nk9a3ece0dd78764c50d6869a918ab37ec  session-36676\nkde377e619382847bf920d564087fa0b4  session-36871\nk831d647a5c2b008e9b49152409729fe7  session-37176\nk2eb4cdc2fcd549118cb924683874ca3f  session-38863\nk45a2c114d5266ab6642d3c9e6aaff082  session-36839\nkf5ac7bc80127a91effcf1e0b3e2a6e42  session-37767\nk1de14a51989e67a3fb9950cd1b2e6363  session-38787\nkebd7c961bf8cfbc4ef02de70d9771def  session-38839\nkdf65c5af038bcd4e1437d78d03e38a2b  session-38862\nk0681515d3b58db341b73136d715ddd3a  session-35449\nk098baecc428b6a8515241d4715de9200  session-35852\nk88278fbe4dd18ea32d4700f191e5f6b3  session-36756\nk138ecb9822d141629c4f039cecf30742  session-37023\nk8b9162a10c062ba6755fdd213fbe5be5  session-37248\nk41a752a1905c875cb7a674e2c2075584  session-38142\nka1285718e63067951068d81ab65583b1  session-35926\nkc34625d256b134aa5a3169cb29909ae4  session-36749\nk9996c1feb94dd84ea516503f4e585b9b  session-36969\nk103619d026a58ddcfdad8863fc83596e  session-37225\nk8359468fe12013de507ad8e469ffd500  session-37318\nk4a4db20a67f42890e4ac5f24487129f0  session-38394\nkd27bc5ec58270a371dd1cf2d8bd9072e  session-38735\nka49b13f181623e85c47f5516ef0fcfac  session-38881\nk6eceff76f1b8a7cba8462b977073451f  session-34672\nkbe8c0c227304de448835c34f402377a7  session-35410\nk5a12cb36857e17ed2cefe97f5c1756cb  session-35952\nk3ef0a8c8096429382348ceda3cd18bb4  session-36958\nk630ea0892b40255addd16c35b9016f4c  session-38408\nk1dee3399556d7057b3521b29f461737a  session-38842\nk8bff829323db39b8a69ebe4c4fec1a5a  session-38894\nk19590180124f615906d16a7fea4e9063  session-35173\nk8d59a5b98d98ded32e4d8b5f80e1c7d4  session-37332\nk2a4c089b9843465a1d5ef6ec32b46c38  session-38084\nk0d2e14dbbc47ba167846c4ecb44442dd  session-38828\nkdc92f99a7907344a5f186824a946b293  session-35907\nk8766b9aa44f6347f85f486e08fb3fd18  session-35944\nk0514cf2a3edd615f1b0f84235a3e943f  session-36110\nk7acc4f8fa8341b0f00bf0fa228490326  session-36858\nk43e94542e7c9bdabacef556cd18d5eff  session-37415\nkd9d9b463a41f66fed300ea9e7bcd1197  session-37454\nk2d40e9a20d9e5a40befdd8efb2be3a33  session-38358\nk1d12f2b38d4c72e0b7fd17ae0ffd4f11  session-38395\nk8d389a2a61b54568578e54eb0fb56bdb  session-34077\nk1a816db9401fb610bd5bfb1d2aa2af18  session-35416\nk97e9e937e6b1160b26901d9d175c319c  session-35878\nk659fd95e7d51a060bf3df2cedf9caa88  session-36742\nk53406c2a81fc4c854f8af7ce08c66139  session-37456\nk5932204651e7fb0a94684965d3a69eca  session-38401\nka435cf98b2a22aae6aa62c2d301f4a2f  session-38843\nk1e4f86d6e0e48bf6647a8c71b440100f  session-38870\nk050b00b4edde84ddf86ad3fd8b4dfd56  session-36026\nk9619c4e6197de812ef034372cc75e323  session-38317\nk01e84d6302317a906c58878ffa826281  session-38874\nkcf7e064f9ce6e17779d60d158300552a  session-38886\nk92334f53428c902a59b6617725980d88  session-38898\nkae63226c3b05f7698a9433b05a524309  session-38901\nk560a82d6e6b92f02bab55208abf5b459  session-35928\nka0fa64606a81b8ec41fc40fd99ff6c26  session-35315\nk043f6ae13e6620ed4c0df75599b726f6  session-36018\nk152417491a2b7a99841ad1a9da4b1710  session-38238\nkf55a799ecd7633f9cd748b0c2ed5981a  session-38801\nkaea59d69da95ec3e9b50ba9626094e39  session-35389\nk75641a2ee3033f9cc129f205a94e57e9  session-35448\nk58df2e6cc91549763b30eddfdc91803c  session-36748\nkc5e9d34bb96c8561320b584b65f5d1f0  session-38834\nke34f4106c93a3e45d30ef9d459f467b8  session-34305\nkb82050e180323edfd3b90c8a68554e04  session-35561\nk48975cacf50d9228cd1c97e254904a41  session-35894\nk3c511312e7aabc7f692a2e9ad754904c  session-36747\nkab8f4168fa8425c33b3665913bd25483  session-38716\nk3dbe39e1ec5d701b27d20ce55262dc65  session-34055\nk5d7a8151dc7859e2de36bf5bab2b1b78  session-35327\nk2e8d7041ce0753aef33231b528380068  session-35647\nk372510c049852c32777a5042258e3c78  session-37020\nkcab1660d546dcb0f0318b2457f617310  session-37175\nk23a0667854c7c2365788f2dddd7e88a0  session-37529\nk09d15ae515eda66185fe561447c41c3a  session-38361\nk7fdf2b76d9bff035a23427ba4ca1731b  session-38838\nk3967c91306951fec235a7ba4b563f16e  session-36757\nk77d8ef10c00295016d9ad66be094cf3d  session-37379\nk25f120bbcb9922eced00369022fb049c  session-38835\nk9cf9e78d05b362da75988556263e9be9  session-38895\nk322c6945c3dc541acf3e61c3e60f5d3e  session-33574\nk433b8bb9af7f6072797337f2be3bf58e  session-35405\nkb4b866771f5f6681b04fc44f3a6d3a24  session-35638\nk008210aa278531b4b0f72699404bdc55  session-37923\nkca841172495d63c4963bb5a58c1b2c40  session-38288\nkf5c27f34d3f5e05750f253a5b727b87e  session-38321\nkbd0710977d10601a0bf82d77bd3836fa  session-38837\nk1fedf782dbc684d52d6dec4302392d2e  session-35613\nke640dbb7600c59ecf68798ed71a0007d  session-36177\nk52b6119f5c86176450e2e5af31335bdf  session-36967\nk0b1f9ba37a61df6d3da7abe0b4bcac7a  session-36998\nkc48f062599be9bc28e8307faf09eeb51  session-37047\nk8e855b712e2e9d1e19109f52535d617e  session-38128\nka6f125631a7b5498eed17f7a405f0eb3  session-38407\nk0bcfc72b114e1b8ffd1fee2843784982  session-34908\nk03f33a9efe190731f0ed3b9aa3386623  session-35630\nk444b025c3ea56f96ff23bb2be92c437f  session-35957\nkf6c37029e922703f9a4cf35b9d3fa7ad  session-36846\nk50cdfac947c66377dfdc82eb2da31d92  session-37417\nka81a44a8e080b1b66842ab842eb53a54  session-37741\nke6a279ab882120955bfbdc9d88463bb0  session-38239\nk4422d7c8a1281ead6054b0b2e2727c83  session-34455\nk609376f78a964a6ac14aed76b98e4525  session-36817\nkd5c9b1d662a3f3f582734f995fbc5b39  session-36952\nkdc4411eb236cc42196a70876f67f7b45  session-37330\nk14a2e1503b789cb44fad946eaf16ac01  session-37622\nk8643fbc4e75a67791929cde29fcda702  session-38140\nka507e91634bec77c1fd4a84767fb23ef  session-38237\nk6654d02ec2362e2bcf903cabded53edc  session-38431\nkd252646b2a072dfb569e8bac999af9d7  session-35674\nk042fd90d86d4288d2a46a69a4db47231  session-35773\nk967f9e9477b1a89c0a4042b4d830be05  session-36883\nk635662e0e0a5b877723cb022919d7e89  session-38448\nk5be887e503bbd6ac67499f19c1eaae30  session-38852\nk1837d03d7515978fb78136a57f04cb71  session-38856\nk631756245eb28d332c0a224d6c7195eb  session-38872\nkae14c5026269780d1950947d47cfa6c5  session-38896\nk0c89eb3ff5270267a93e4c7c0ba85f68  session-35336\nkc722595e9cb4ebf0582046e73ff8e3fd  session-36711\nk6840995488eb513de4a5b4c2f3feacf6  session-37001\nkef898b978384cbe22b507e6b2447fecf  session-37434\nk31feff7b6cb8ec218812934dca7d8a30  session-38148\nk1f1aede4ba031fa5bcb9429edb1c63f4  session-38370\nkd9ee09584c1d4707c140ccebb9342a3b  session-38836\nkd78c9e0528ed6790f629f11c9d02e952  session-35880\nkfba9bcccd82ee6ae13bd07e84cf7b0dc  session-35940\nkbc9f9f9e675ed7764df3fe411c851598  session-36888\nkc10c2429796b8c0807c0fb4564677b6d  session-37022\nkf6bdcc4506029992c36ad691b9ad5251  session-37122\nk2ff53332f2437996aaa1e0886fb34c01  session-38430\nk004d7195b696f328dfa63aa5c78b7264  session-38850\nka06fa514ec4dadd7737aaa3a15c58d2b  session-35243\nk53fe9bbd0e0227137e787c9769ac2834  session-37218\nkd4e516b42a5d61d7e5bcbe8b4ca87142  session-37315\nk83e42755262206b179a3a4b395e199fc  session-37809\nk7dfd3f8b6f7aaf46b7e97ab59e83e23f  session-38849\nk2bdb942e458bf92f21d799becf3a8445  session-38854\nk065098ddbaee386a3981890e05fda45e  session-38892\nk65c04eeb33443989fd1e7844d9d8a7c3  session-38900\nk0f1fca58e3aea142b4bf719bea3f825c  session-35330\nkeda3172bf926db43cf42e566cc9456f9  session-36815\nk4a81771908dbdbd9596c264fcd318a15  session-38438\nk8c5927bb51c51b6b9e20721026c36eb6  session-38681\nkd31666478ae1df2fda6663d895a6b943  session-38780\nkf32d023fec0c493a5844e288f6a6decf  session-38871\nk84b6600333c274ca98d08d4626d28621  session-35374\nk39bb999b0f3c99d13bbe0222ca4b6087  session-36699\nk544770b82d99b27fa73a17b180503af9  session-36728\nk7d1c66b0527e8376d92ca361223b6fdc  session-38365\nk27022af4cee042bb980effebadd37b32  session-38778\nk8fa136ae3e034385a74cb4007cb07a4b  session-34408\nkceaff8576baddc16a88766b1b30c948c  session-37159\nka491153ba81294c26fa801abf52408a1  session-37216\nka1fc4d5a6b38b582ac82f294f19be22a  session-37813\nk32d82038c57a4a742168d735f2088278  session-38221\nk5ab9d5a84a8cf2179ad286433458c60c  session-38223\nk19fedb53cb317b6a71d726e172dfe31d  session-38309\nk9151fba5e782d14712494e71b904e866  session-38344\nka05880cc2df696f56da5844a77133edf  session-33952\nk65f9eb00dec26e80ac94e5bfb12f8fae  session-37441\nk7ff0d0ca765888e9d790678adccf8a93  session-38422\nka897d25d9ba4754074fc399816e9ddb8  session-38789\nk5a2015b45815cbdfc8b41272c4723df6  session-35453\nk72068db6c7b78f74a5d85f3a7ea60b5e  session-35623\nk1b552b63dc6010b7ff0ea588283eac57  session-36973\nka8b8962fccb176a4f890a8d089ff4d7f  session-37219\nk6d837ad310095483cbc9a81f87914f59  session-37253\nkb01d2c34401d5c5d2cd1c5830bfac720  session-37569\nkd1c81d9fa8006cd34d31797deb1899ca  session-38784\nk4561309e5cf79a8e94036d5cd1063cc9  session-38790\nk2ca8c8f0bf4a7ce3961a05f95c4bf82d  session-35429\nk957211ac94ed404f48e7980f6fca0ab9  session-36147\nkcb829da9ab6d334c4541983f1d8ecb7d  session-36790\nk77cbb7ac4673fe3efe8c56aaa81fe09e  session-37370\nk9e03ba8756133e1f9ccd087071b32014  session-37502\nk9a06695eaa2e0a10006ddebb51a40386  session-37705\nk86cfb58f7fe22ae6d4cfe2f33803e9e6  session-38083\nkc067ac654868009f36d4fb859b8995fa  session-38883\nk6ee0fe3bfaf36cb4e4e4a998c3542b1e  session-36102\nk5332246334b01dcd4a09c06c544be374  session-36369\nk8a313e5c8af644fd5cf42359cce8822a  session-38400\nkdc20e2dc84f5389d4e1e09bfd1a902e6  session-34054\nkbb46067c05fa6b574d67e986bc156142  session-36820\nkfcb21a89231a44eb63a3823165f35b62  session-37634\nkb4fe1761a5bfe20bbaaba7ca3ff23a36  session-38234\nk7ff84ac927a156dc6ff5e23491ef0c37  session-38779\nk9197e05daafed4486107b595ce51490b  session-38890\nk4d3be26d6bdd04e471e9ce0d62b20a11  session-35763\nk7be9d37f4be59c0821c3784e37217377  session-36423\nk93e4333e0b7621b6eb49b4609cff02b1  session-37324\nk68d45a45865c88d8886a30ad0194915a  session-35942\nk45a8c768332e738adb047ff147733a18  session-36760\nk1500693cf5f4d6a8212f898b23c9cb96  session-36805\nk4e6e9d171f55fa9f7d888f4a5604b218  session-36946\nk2bd5974da28f89396ca8c6c1b5bac2b8  session-37336\nk5267343ccf72616a56e940f9be4fcf95  session-37688\nkec30e45ef4348b933b204b4088f347f2  session-38685\nk4d0e7ca2085ba3d17b514ba52ec7b478  session-38861\nk88afb17c03f088eea875dff5dfb96d3d  session-33445\nk53e552b1549539de8c4c932aec8266ee  session-35348\nkd5d55c39b74e6bd665650cf539852f0a  session-36103\nk59460d54406bebaad2576755ceb4ae18  session-36407\nkfa154ca0aefcee769b60cd639125b6b8  session-37374\nke0f5375ccf7d6ddd54a22122049eed8d  session-38384\nk7c6b9caf8454b7fc375506de4ee561fe  session-38440\nka8f36062793c3f6efd549e7e0a0cdac4  session-38604\nkd292a11551c8368679de6ee0a42e0eb0  session-34605\nk06af40c0388e562638732a4e32824900  session-34654\nkf53b4546f31cf716ec07e2d74b22e738  session-37568\nk410e293ce64c8d7bb9e788b159c97685  session-38299\nk1c4673f62205042d054d7e5151b82c93  session-38398\nkc71ba1e0711c1a21f456df78b4ef333e  session-38414\nk089a5e33abc1ad25eeb250a4e5899b57  session-38855\nk0d33b27c97b40e5352951ff0f301cf66  session-35328\nk5f8de806127afd17b7159ac5d860bf6f  session-35913\nkab2b1361d37103f310f3cc4136fc3783  session-36891\nk1d6c87a5fb7f18de1cf8845637fdbe4f  session-36965\nked949ec789bbb377a32ed6f9e1e9173a  session-37321\nk995afaf0c6c82b5309a29b5ab66f001e  session-37864\nk1f4a879bf0f536ba6a4649df0dd024ea  session-38708\nkb924df2ac770536f487f5644a52a3bc6  session-35183\nk0e7c4ec79466f3ad949c72f5a9247a26  session-35901\nka05e61a74ed9fa4eb102aea7cdcbcc29  session-36976\nk11a5f483d65a98a6a02aed4a01ebec94  session-38882\nk73718bb45da585e3dd70a65c6e6439ad  session-38885\nkd5b9ff7bb2a17a4a24b2f932744a2a8d  session-34577\nk4d5c93eaa007d429f4f6e91fbc09be0d  session-35022\nk89a8697d59c13dd5bdb8b94a1febce5e  session-36833\nk65120065efadf3b4e3064595cc84590b  session-37021\nkf1cf610dea99db57cb21ab99631e5eea  session-38412\nk6d56a4f31310d0ed45076802ae90af07  session-38887\nk74febd9d6909f5857ae61b408d74d792  session-35029\nk7e48e8b7dde68a7aae50aa70b62d6451  session-35361\nk5af69125a10863004fcd8c29c4b22728  session-37076\nk16a5e70b439f755414b50f95d290d442  session-37997\nk93bd2e64ee5c41d62416bfa25c916ec2  session-38269\nk8fd05f332f63a5ca8a9e7c80c6f96003  session-38891\nk038f8ef7e7e8a60e30b63fa36dcc271e  session-36806\nk18dc8378dee4f936bee45519b0e02164  session-37235\nk4bac003b17159cb53c9814f4336c28d9  session-38222\nk8f1ad31b5c2e289f1c97256a97f5921e  session-38851\nk167bd36533c33d76914979994633a2f3  session-38876\nkb16a89aed40b19bfabe51ddb86989069  session-35078\nkb1f253b5feab99ecd2081bef1f232b6b  session-35396\nk6bcad5d578a4de4110a1bd7827a1291c  session-36389\nk0fc35437e618a0b55d1ff86d1b6cebea  session-37831\nk401d7f75a728c04c72db19908329a90d  session-38410\nk6bd273eb126e35485b13f4f125c10c83  session-38840\nk4ff2dc30abba1e517b2822506ddfd1e0  session-38866\nk6083ba1f6decf7d41002048501bd9dd9  session-34808\nkf3c1f197dd0b385e2e0fea73d9285bf9  session-35134\nka595f3ec0ce35e64c9fd4488f2bcf30f  session-35430\nkbd35acb90d79da57504426f756de4537  session-38191\nkc5ea82d4a8e0bc5186fcbff169faef4b  session-38436\nk3d3abdea0ad2b3964a88376813f498d6  session-38869\nkccba036bc1a5f4a8f0d77615cfa3591c  session-38880\nk438f2268ed3473e360ff85bb9baf38d6  session-34594\nk611a833aaf43909e25f6a0a5141555e1  session-35743\nkd3db8443fd6be74a2f82dc24dc6d024e  session-35744\nk0231d6a669a49a3f408d0ca115ba16fd  session-35762\nkb94ed1da83bd6e557f10f677da65b65e  session-35932\nkd25dff8861bacb9e39b484ab3fc04350  session-36966\nk825782a901c985c3f218c314ebb0898b  session-37400\nk989098c55c6d526a15df761071f3e264  session-38413\nka59d1e039af680849d06f2db3e033e90  session-35289\nkc2e92c1193ea6bdbdfc66b77af65d09c  session-37459\nk97ce2029ca6cd6848f11a3c2d788ae58  session-38215\nk51ce1531e8f5624c78bf277985f5846f  session-38240\nkcfaa437e0e36f64f6066aa3e6033f1a2  session-38385\nkadf5492161fadd0b317e1ad1c52d5ef4  session-38432\nka8b9ae481497ce6139381d6933023dc6  session-38864\nke96cd04b717bfd694f171c8e48a7064f  session-35691\nk6de160044f1e11f5b7965e670223afa2  session-35931\nk627161de84b60f92dd032c7cede53e09  session-37057\nk3214cf2f479d37a6d43412ada2761e47  session-37841\nk7e7a6ef6a2e039804c2d5a256b9c45a9  session-38845\nkb47e837f3558a658f792615a6f32e9fb  session-34353\nk65c0f5680c2c7efbae66042b389689bb  session-35411\nk063a9340feea4ab7688fb847f91adf4d  session-37017\nk776f4c7a325964dcd21aaf81776bf1ec  session-38196\nk4c984778a53cee568af49217aced96e4  session-35082\nkfd2705e37e0c7ca8cc815b291ed08724  session-35400\nkfadcda0723e9c447871fbf8203a30a6f  session-35431\nkd1448c083dd05374f1e634c28f7af2fb  session-35921\nk58c031582f208e9aad9ada28b6a13b9c  session-36493\nk0964120ef70ebc602708b9fc90b3eedc  session-37457\nk31e6e9edd8d64e34dcdae19418a4fc36  session-38717\nk2b849674b011313118c3a02ffa2d7a20  session-38889\nkbed1cd34a1ca581f0db6265a2faf0db6  session-34700\nka0d9befababe3470e4446025b933df49  session-35033\nk26987eb2ed9b13d071bde34d9a7ce372  session-37401\nka49f7588ca6238e611f2c2f7fd13c1c9  session-38846\nkb2ddb6bcac2a02349525b9d9291c96dc  session-38879\nkd7621875d98453a24a7968aaa6ed6ac2  session-38884\nk466749386dc7d04a988fb59efc82754a  session-35943\nk173d9007a41c858a67af19c8a4bbf108  session-36187\nk39fccf1e96cecc83df450a6c14dcb320  session-38262\nkcf533a26296d42053a85ec3f1c1119c3  session-38796\nk0efce7c90054b32dce1a1ca7a8ddb91a  session-33927\nkabab3fda4886826fe60b4ebd10c8005b  session-35571\nkc960d744059a1742a6fd1517628c70cb  session-37331\nk4364f6904a82e9eb5f1954f3b70404a5  session-38873\nkf34e29b9e3c1084746559c2ca0620722  session-35332\nkab071a61faefc9875c0edc13488f3078  session-35889\nk8f1ef918ba5e09629fd9b1d2bd65c3c7  session-36100\nkac674374dbb50211ff5f7ce34cbaba32  session-36291\nk7948381c9121d510fad611910e382ec2  session-36382\nke6a0e7cfcab74d4f7e40f9030dfff3a5  session-36801\nk98b403852c303761c3f724194bd010e5  session-37129\nke3d310f37ee4dc252a55d35f6a2997f6  session-37243\nkfa90ecca8d361b2cc5db3c0a09323acf  session-37334\nk39c54016d2b29222b925fa2af96debf9  session-38185\nk0cd7972ec6017483a3437a09396831e1  session-38868\nk80a205afe87284c59dfa3b7180b65c76  session-35404\nk460a9ec34e9ee8065f6a9c31ff2b94c4  session-36101\nk1a873a3093f702adf921650a9f1ae00d  session-36445\nk074079f85feda6dc94645dea5140bea1  session-36872\nka5533fe0d3dbd4b14818d246be15238e  session-37152\nk602bbd204facab23cde2334565565438  session-37274\nk07730c2f3b0de378e333f4e373842b00  session-37307\nka50f5b6fcfde8b8760ea4f0070b24b66  session-38867\nk5a0c948d0a33ac6a8cc2da845a1d9875  session-34178\nk1eb53dde961ef4c71f2f1d7c7724afc8  session-34273\nk8d8ce3f1998a41741a4589a14a1ec7a2  session-34359\nk16b10ad5dc123981016da737307fbf2e  session-36201\nkc723bd8047f2cc51ccaecafdfd378ca6  session-36826\nk5d4a1b53a2c9e51518ad07c62704d401  session-37617\nk9a4d4f3c9fb0a989052cea98194d4879  session-38268\nk628d1d6d9b2c8cb3ea3aa3a72a35ac14  session-38283\nkcedf3cd641a1f305411bfe177ea44245  session-35320\nkac497fcf125abbf49bb196b94b9ac8d6  session-35331\nk2c3ee3857a152fb0a304013c921acd0c  session-35342\nk7fee2c2da96c4fad238240a135fbba6e  session-37548\nk1c6795ceba029485d6e2542117dfab1d  session-38233\nkd14f007b98639f1581530dba47741107  session-38697\nke258e02dd98c1165b811259dc6e52421  session-38794\nk77c648d154c6c21954eae1380e91894d  session-38841\nk252009381588fcd86c96b91e8c47a221  session-32933\nk18574e00a6128baeac64df5fc53a4c4b  session-36418\nkb547ba4257ac7a52400ad6b43769617e  session-37335\nkb3fafeaff69abd619d43cf0439c6202f  session-37402\nk73a619e9f751d6df443d31d1e5ccf955  session-38232\nk3467df1e2d6a5828316831c1da9708a8  session-38286\nk8b02d4d53a008c497aa3da8194cc4b17  session-38314\nkf1896d6b1359453d0761a1c90e6b9d72  session-38888\nkeeba2885b1feee69fdef512d6cc5bd2d  session-33944\nk93ef1a9c513aabf04930796a31177dd4  session-35692\nk7606b72888ae5833f244516250bb319c  session-36612\nk18a6e1ae852fab6b8dd5b8f0cd4ffdd1  session-38893\nkeff50a7b935d086e490961b4c960f60e  session-38897\nk4231ddc2c5743b9763b7a60397867ead  session-34173\nk9fec57dd444b64b39744b39cb2ee2fa6  session-35428\nk800f6899530b23bfc5e33941ebb7409f  session-35839\nkd2b5556f9e087f9d2a5fd1fa972baa32  session-35895\nk65518c7abd232aa0a33fdccd572ebd8c  session-36661\nk480802108a751c272e339aa33747a2e6  session-37275\nk3bf7f9d670431e786f7780464851e47c  session-37425\nk2138816738b57ae5dea4e06d67283a98  session-38865\nk18b4fe278047ea6cd77d46075921a082  session-35032\nk00cdbab2cfdc61d8130d3666b4414459  session-36985\nk3629079ac507736172bddaf2febc2bc7  session-37302\nk3516d2ace962286e0c6af5c81536e434  session-37495\nk1ab79ecf2aede327f118569c22a3ddf3  session-37890\nkf463923975ebbd9fa1e350527666690f  session-38777\nk28a47fc3671a2732f9241ec2f64e5e2f  session-38829\nk2233380f73c53454327d1cef85b3af2a  session-38844\nkfd092bb0059c2eff425cd0d0bfc7bfec  session-34617\nk89c35e7dd148e66d688c53b7e6705062  session-36634\nkfce56c759c6f9e8049395cb5da8f962d  session-37319\nk4c9c8c151778e9ba3a82cd4c59d6dc80  session-38859\nkd57bdb864b9a324fab6da25c52e0766a  session-35329\nk144ba1e0a4c9526f7e94b4f2a01be81a  session-35432\nk633d3c0caa7c01e1651a61f25e8ee374  session-35912\nk0585544d919265f436dc5c419bdf3e8c  session-35968\nk2e17a02f616073e51d4f52723128b68b  session-36987\nkff49710545a6d51482bc3aa2fe2935ab  session-37179\nkb71a2c66dc6488f60db77ca55f0ae9cd  session-37470\nkd69ac03d822075f457d4d8a761cf01dd  session-37482\nkcf4011405a96f1fa73e5bbadd2d28708  session-35530\nk537a749cca7c631755f236c43101f1ba  session-36669\nk12abbfb8f2ec5b1b80fe06a88ee61110  session-36813\nk22287c48a2cbef83c1af442af9a05101  session-36895\nk8a6c72fb5c080013da16cc4a8ab7928d  session-37171\nk46db4aa6ff5896828880de24d5ee2f21  session-38341\nkc3051ea98ce9acca4f898f920841ecbb  session-38437\nkeabb53085881933033efe450ca953bfe  session-38550\nk7e412fa201bc44b6b88e4201cb9e29be  session-34358\n",
        "stderr": "",
        "directoryEntries": 407,
        "matchingHomes": {
          "session-35773": "k042fd90d86d4288d2a46a69a4db47231",
          "session-38834": "kc5e9d34bb96c8561320b584b65f5d1f0",
          "session-38868": "k0cd7972ec6017483a3437a09396831e1",
          "session-38896": "kae14c5026269780d1950947d47cfa6c5"
        },
        "parserFormatControlsPass": 2
      },
      {
        "snapshotId": "38e9ae53eaa0e84e43b006f5e46538f4",
        "path": "38e9ae53eaa0e84e43b006f5e46538f4/su-codex-homes",
        "exitCode": 0,
        "stdout": "k1fd65c0d6636a5ac39910e334f332745  session-40911\nkc261103119b13bcbe82aef1b63ca92f9  session-41234\nkc121a786f11ee5bcd1b8ddad931ddcbf  session-36748\nk00e1d27741290430557965741afa0ddb  session-37332\nkee72a1f5a983c4d3cb1cf69c216c74ad  session-39080\nk2fe966a680d55c765ff39f9f10aa55f9  session-40573\nk3e8897fd7846cf9d795d4c2bbe1dc712  session-40597\nk173ed8fb2f17a483ef9fcd052022f3e5  session-41075\nk4c6519663883d908f22f1eb178b3b29f  session-35894\nk66868e1b78f63bef6537530c7dddecde  session-33927\nkeb3a791583df3159f541d61056e0d21c  session-33952\nkd068c6c03d361aa107a50943cbf5a343  session-37248\nk8bd55b31ea37c303ded15344ae28f025  session-38414\nkabd7d4efb37901e088cf006c3a242356  session-38900\nk2aef88cddbafcfd06d81177b5dc028b6  session-39208\nk803cd0dafc1663733cbac8edfdf32175  session-40974\nkec60eece1b2711c8fb5aeeb6d937a4bf  session-39614\nk052e0219ab1cb2154b2b3d48dc9b3d09  session-40605\nk0d5c4187d34f523bfbde2c726125a92f  session-40796\nk2d9e204a848d0c2aaea9add971c4452c  session-40797\nk8f9346cbd34144d6ea4d522536a1e1c8  session-40910\nk4619e36db443ee9764a10013eb0dec4e  session-41090\nk01a85badce2b16acdd64c26e8385c2a7  session-41326\nkc06d5b0d15a29bfda5757537d4714ff6  session-32933\nk2748b0641f9dd33c7edf73d99b2a5247  session-36201\nk4f9c211ce93666645f0bb26fe2693fd5  session-40712\nk9e03be0765b49fca9f25790fd7435a44  session-41236\nk5b8355783387723430b0037f83d40452  session-41355\nk0e38a96be327f18f5884c64cb8634315  session-41359\nk0ff2595e9f5cca0ae784c17e9b3de084  session-33445\nked636f15f0a32a24c272fc4096bf4c3d  session-34054\nk84f6d59a16eab57941f0fc6542db04b8  session-38911\nk91e4f0f7c79f91865dae2f126d0fbcd8  session-39237\nk0b9e5dffe1972a83ccf94857d4e73ce5  session-40166\nke9edd7421b5864303ddd0b4b0a5c1223  session-40221\nk36530b15d417ce2aef5112786a6ce61e  session-40284\nk08f2936d56e83c73813e87cffe5ddbd7  session-40887\nk39f1bff28a26b56ea04e77f00ddd23e6  session-40600\nkb6fdb3b68bb17762d88ab2f58c9bd240  session-34353\nkfc469a1120bc3659b4f30dfd82e3a743  session-34358\nka2de3fcaec0d53a4d3cd4305cf919c33  session-37321\nk3fcce71e93aa591c1933b1e78db834f9  session-39824\nkd2195e9606339eac706bebd2c0018ed7  session-40107\nkd34816fa8e5d5334222720320c3f4d43  session-40246\nkc197e473955c24049ea23f63a2841cee  session-41023\nk7e63465d685e9a08b13be2c8c98aeb9f  session-39665\nk3f9a605f275abbef70f1ebdbd82a5953  session-39668\nkb5c2cb862a88932a3c4944b445474986  session-40023\nkb8cf10469fd9bf420868097590e46eaf  session-34654\nk68f81974052593d336dc08444d6a67b6  session-36883\nkc2f7fa356da8ce71898d62d9321418dd  session-37315\nka4e4049925ed4d03c918c6876943037b  session-38262\nk6014233161cf3ac73eca38429485e22e  session-38787\nkb16056596ada864d53a79e4787268e15  session-36728\nk012f1c64eeca8e283d03749c1557364a  session-38969\nkbec6571f0172d64b8690c8b975b41508  session-40886\nk2db0647ed2c7038f4923ad0b24fbd3c3  session-41088\nke19d3e70f4c4d9a205197a934a3ba24e  session-41220\nk8fbf10ff7ee5d74b4795796157e8dfdd  session-41255\nk7618094d050ba98a2ce82318beec80a2  session-41402\nk4f9d7f21af4fb3a82a198da2130aa1ce  session-40295\nkebb7738066b4df6eab13e4b3a43f1a2e  session-40884\nkfdaa67605530b2c46a558e18363614ff  session-40909\nkb0d27dab4c770a8d8b7f694ebae4128e  session-41036\nk5d629a7f7f59b266f0bbb806e755d2f9  session-41362\nk0fa1135403968fd8552830b1e27972ac  session-41371\nk1a6d5131078a3b9b3a36ca6bfed183ef  session-34178\nk18a66da41b4226b18fc9d63acd622af9  session-35928\nkd295088681dc6e3e685b9ce4046f1496  session-36110\nkfae2d68e0da193d1adf2e64ca592627b  session-39377\nk396f74ed73591897c6a7fba189b831b6  session-39987\nk8a1029a4d4b683299297849d1d78229f  session-40247\nka92f8c260092a6fc85cca403e1373bca  session-40795\nk4c6417e628d6ed2aa74294439b92b298  session-41215\nkd419995918203ba0d2c5239f9703db22  session-37923\nkbe1c5d31f4aaf2a8e77a62dc87b57b1d  session-39017\nkab3668b024c3660b8bef99c4cf718989  session-39613\nkae6f7e7f9252e2074ec0a920c022624c  session-39739\nk1c915f64e727005ca0ba278522c5bb78  session-40444\nk387467cd35408739dfd262dbc8e1dc45  session-40596\nkabd41997a6930ac3de565a761c6f25f4  session-40858\nkd4b90193fa610fbf45dcf1a71bf10a5c  session-41329\nke047afcb657264c9da2fa0f502d15733  session-39434\nk00f699b015be8731d22eb38161e7c847  session-40580\nkf6e4cd190c97e5a54a36c664d1f69a89  session-40742\nkfb768502a7a3c0f21c42db0f77dc6aff  session-40770\nk9aa501ea180efedbf9d8934565bce68a  session-40998\nk51552e1aa52a0c212f7c4b3bf50d63e0  session-41351\nk5a7262d16b81043730773aacec1e3469  session-41381\nk8d033612a2622dac516cec9997cdfe7e  session-41401\nk03cbaa6380e6a45f0ca4ec6126265c9b  session-38238\nk3c1f85d72827c869babf600eaa41c93f  session-38919\nkda2236a76aa9b9732410e34e8f3fc3e6  session-40610\nk609a08bdfa61d76171446c1bfe14544c  session-41112\nke2f4d2f83446e3607645c83984dc2d6f  session-41369\nk28034094f170e2a27bf79a3364a9d746  session-39669\nk718c21e77ebf0ac04b4fc23c4b77a23b  session-40892\nk0e16e0f409f3ea0a35a2791ab344a906  session-40923\nk465f9869bec39f3019026ebd5987cdd6  session-36100\nkbc308826d403e70468e87a2248ea40b9  session-38777\nk575b31d11500ec831badf4d299066b4c  session-40741\nkea3b53c679b90760808cdc8282fe2474  session-36747\nke63c6367450a346e10eba9611d6f9e7e  session-38268\nk85c420d4abab868f62555326076b33c7  session-39776\nk6224d35002ddddaeb007f61205e192f9  session-39831\nk437f5fcba3e8951719b093c4af0eb65c  session-39860\nka7ac2678b95d2171642ad28ed744ad51  session-40966\nk9ae228ad87634d497bfc4697f2d9daaa  session-40967\nk3acda692780d496198e7fbafdf698768  session-41000\nk7e6331bac591ae769aad777e46ad6f97  session-35926\nk35442d77ddeae0128a2e01c83a5bf2f7  session-35289\nk96401fd4d3de8eb13686a67b6292e6d6  session-35839\nk25d3effa4a6fb0ec3fb66f0ca8fb6e9e  session-37569\nkd9a5526216fed4fa0f92319da0a969b8  session-38902\nkfd8d9bcc06bf43dceb1468508a16c35b  session-40168\nk52be3fa53442bc79894aa8f85adb1b85  session-40528\nke598bfe7fa11a284815d5b446169a7b2  session-39846\nka540ecb61abcf5166ad24ba2371e9081  session-35889\nk15a9461a627ba22f5be03db5d28facf6  session-37318\nk723836fece82c97e8ccb0dcd4aca9701  session-38410\nk3e262c1f615d2529e432d388fbae04c0  session-40620\nk700d23f3e1aeac60994a25e66de05f5e  session-40621\nke8bc94d86de861ec4b2c074bfc41587d  session-40990\nk7098fc980d0110936adf3d2bd940b352  session-37122\nk12d874b2c6f161b48070374d2f185bdd  session-37243\nke25a11ae5a7c109c62d35754bf9ead63  session-39313\nk6dc42747f1a36aaadce8509a217f99ff  session-39937\nkdf4b95f83c91bcf9f8fb34315edeaea7  session-41025\nke066916c382bdf7113efaeaf5917df7f  session-41205\nk5dab1f4385a5886a1cd89e5a228a8579  session-37319\nk0d1995294607bc352838850bac342e0a  session-37379\nk1de0509508e66bf0cf3952c9f3d790c3  session-37417\nk7cf1b748f3b3a5bab4c37a52254a5240  session-38413\nk0d35856b16f581729cae6ef5265d82ac  session-38463\nkdf404619c917302c4ed96045783671c9  session-40443\nk730da8211babaa987030b184b3f227e6  session-39236\nk5da5e64222693d70b0f2869184891351  session-40819\nk8d93a350cb1fa4d968d226121b12c30c  session-40902\nk2049d1cb0d4d9acfe5505bf518df37e4  session-40895\nk15a25080082a0700a9b4285cb5b9cb64  session-35901\nkad91f958c36daac4ec5c2c6917a692b2  session-40293\nkd00b98088d30536dca216ad69af7d858  session-40743\nkba33002bc4075110384359a45779350f  session-35913\nk594b8158b599f98d5018b70e1fb9a0be  session-35400\nke743604e75253e0cda764cc165bf14fa  session-35943\nkb61a9082dc0f2ddacd33011eff1c10a7  session-39785\nkf1db5b625086da725cab2016ca5ca6df  session-41327\nk0f71716bac4bea23c4f478bd7b741c50  session-41335\nk6f657eaf15daa984e7f704abc7589054  session-36888\nk05e99c42c7e022b75476309f4a9bb3c2  session-36815\nk9491fda9bd43bc41675a36a8c09280e5  session-38779\nke162dbe63b5976fad22708376ffa33d7  session-39861\nk9e9c07e916da622e15b47ea723aa3e3d  session-39895\nk2fbdf9b699807a496a47a47f4f0570f1  session-40977\nkb8cee06f9ce831c1af0c078bb4db0274  session-35952\nk7238e99be2a22d48e2d12e8bf9dedf08  session-36026\nk582dcd464733d0df30ed23079f5eae83  session-37402\nk71b6d1587388cdf5aa8c40c2635ec9d9  session-39649\nk985bf1707bf5526688d5455258cf0c46  session-41011\nk5497df63628df53e47a99570fa545423  session-41378\nk2cda419c5271ce2e3b2deef6bee210a2  session-41392\nkd8e915edf374716f1d89ccb5679b0496  session-40762\nk2a4b0edae8c4ee0c4935bdaa728f8fd6  session-35530\nk15216d9d283a17836a7695dd3224be85  session-37415\nk73b3883288297fccb2d133b97c631ecc  session-37454\nkd0f3fd8fbe2a145df72f6de57e1a0b31  session-39543\nk1399ed175a15ee583b58de38c636f6be  session-39560\nk8eff68296264b7dc67127014596060c6  session-41066\nke67331285477e04bc27ec8a73e2b8b4e  session-41398\nk9d0fbb3ec79fefc67d2675f2ce768abd  session-39407\nk8025de3d23a519e6ab6a1f1e16244aca  session-39886\nk8ebcfd881be9de21927e8a2f88cdca76  session-39924\nk5487d87b64f83853cabfa93355083bda  session-40462\nk21e91228ac91839174a1b7bb4c5b87ca  session-41389\nk2d531a6112d57f763da47233c2e716ce  session-40036\nk7fb5fdb5c7e61723b918c71ef7610878  session-40607\nk08711a607bda4abe88f3ffc1b71522df  session-40750\nk2a907c02c9f3865ccf9dac591decc17b  session-35912\nkb5aa1b7ea7a80a91d957dce3de7443e0  session-35931\nk6541a481829e379f9520bed862af1aa4  session-38922\nk454aadc9a39b995954ff2b3ab51c740c  session-40947\nkdbd5ca8b1f2e958d18467822b0087819  session-34173\nk4ab46cb16710b1158d8485279658484c  session-38395\nk9191d30fc9a49c3677bd9b0a1a1e2c80  session-38708\nk031db924cfa53f141169db3554f105d8  session-38790\nkbe1ced58d7d6a92086de939efbdb8291  session-38980\nk8458cc3b02c6c7e0760ff4abad4a8264  session-39801\nk1552284e2d020dd6513a250e52712eba  session-40336\nk595d7a1d979881e0e23a73ed2e352e24  session-40630\nk6787c42e07e2f2fd7fea323df6915b88  session-36177\nk31d315177546e7f37e143fa3d4e53417  session-36976\nk2c1153285fc5dd5d570fbe01f218805f  session-39379\nk1f70ca8d46d7279ce33a21cec6948a96  session-40219\nk1723607385ae3b75b14f743c891ca38c  session-40787\nke4113b9ad321b37596c75ffc91a67f18  session-40860\nkcfa98fe81ce41de0e66c009966d0f34c  session-40976\nk5e902e010b7ab749d17e8915836d27f2  session-40993\nk8b281cd2121e0579dd9011af0cd7c97f  session-38269\nkb99f4c10b3b43625100417250551f98c  session-38398\nkcf0e34bd1aac8f15396a45c8073790b6  session-39504\nk2f1f7ca54f62d9d8093aa7c20d923fcf  session-40249\nk2375fc060364e1ac37dd9b607641061d  session-40995\nkf894dd299d52c13c37f30d36f98afa5d  session-41038\nk3ae7bc1a49b14c4b2a60e95872bd3304  session-41245\nkf8f874059a43aed484a858c66de24ef9  session-41400\nk9a2ec4dcf47abe8e2194c87ca3596c45  session-38140\nk0af5e648bfcf788c2a3d4c4e0743773f  session-39713\nkb0168bbf8f37889947c9af035a034935  session-39820\nk105ac29d6ace43aed5850c22d26f43c1  session-40242\nk2fdd05604440cce0e2f940a7e6a19c65  session-40302\nk4e5e10b09181cb01686fce399ea0d364  session-40622\nk6f8f8e86962dd97ce1c2c2464c9a4516  session-40763\nkf2cf832a5765e1d79f8930aee4b0d60c  session-41037\nkeff54d2685c3ef8482cbafe9b8bd11e8  session-40611\nkc4958e65ef90462cd135c7c1d7131310  session-38794\nked46fa70180c1d2bc34e42677c1784e5  session-40749\nk50261ce4ea4871491729f66fb50f2040  session-40793\nkd7b6b1b976fed721190eb1fbe1dce034  session-40888\nk38c6f516b319d3cb619bbb02548d5b11  session-41187\nk0d73217e77073b17b61c09ebc0e3b9e7  session-41214\nk6ea0cded8d9c97eadc2235a0aee2f382  session-41367\nk4a6940e7735081034cefd20291623b86  session-40437\nkca3cbe88b31c36d5bbf567547d007e79  session-36101\nk91eb82342b37a00fd7025a105790c56e  session-36826\nkefc19c0728bdaee09470c415cb391958  session-39926\nk774239f54a20e4566bddc622f83400a3  session-40283\nkc79d2d1d6695eb1df8d54e56fbe4a584  session-36760\nk9c6bad9ac4eaa41cedcedf3d668c843f  session-37401\nk85c06af12a9c2f6da28e2a9e2958f0f1  session-41397\nk7cdcf13bb5775bbfb10fec11197aca1c  session-38796\nk3787d5cf228f2dc05dd37e9586ba2c15  session-39342\nk7c2a75e33ecbb540d80efe9f42d6309d  session-40721\nk39431fff2b3f586cce342db5c128cb65  session-40756\nk3f59a3c6bf82a881a26996d25f498944  session-40996\nka8e1668c9791457d80bf1703cfce2741  session-41049\nka1ca16521684d9126cf6ddf87a4e897c  session-37741\nk3475d399ab0f55ae645d82b0ff824a14  session-38866\nk3e519cd381c700117c28d9657a54e42e  session-38889\nkc093bb4bbd3857fb65423130ba6c7736  session-40752\nkf743c4bf22892c6b8a4ea4733c562876  session-41050\nkfe6567b9c632c9d48d4d0ee2726db822  session-41370\nk1bef2faba593c797416eff12c535e368  session-38288\nkdee7b397175bbe0a1ace64685e9edede  session-39925\nkdd9e8e6b5cc6f84257d3a2b4a3ad0d55  session-39942\nkaa5db1db4790efab9ca704a7217ea133  session-39976\nke390f7a503aec145957e2a80edce49ad  session-40965\nkac7ee262dd459b542af4bb66f6cd6d26  session-37225\nke94254918ead71377dd4a64061ecf0fd  session-38983\nkf6d4a6521f6ee12e47f18a684eaeb84f  session-40475\nked2b3f4b5dfa8ed0dcdbdd8b23ab3913  session-36676\nk04f713282ebed27d0c2613746c4fa522  session-38240\nkfebb52528ce82fa30cf6f9903ee85f7d  session-40925\nk0e398225b20d6fe2ba50ee3a7a142c06  session-41235\nk8b3f468590997c1a6d7e4a5a93d69290  session-41379\nk65dc954dabedeea3bee164c43d91a79c  session-35932\nkd8e175afe7da23ae3db44bcddce5a6e0  session-34055\nk540f18eb71db478fa48855245fac9d30  session-35315\nk132a2c17c5bbf85792e6661b28554b79  session-38394\nkf82e93581f15c57a404de5b7baddfdeb  session-38978\nk58bab187d0577b25e237407b78bf4e4c  session-39823\nk2a8d610e8d855f15ee2217fd2a60dec3  session-39980\nk71fbfea6c868cacd9a7ff49a9081237b  session-40244\nke5e1dbcfca5c05afca90a1907e71507e  session-36742\nk4583738ac080089503a884f04b1ce295  session-36966\nk83d333b74f40f74e5d7b5e98d2fd2fca  session-37330\nk7e643999ccb5f964bfdac1054bbb8e34  session-38801\nk77846d29da561ae11c8ca3f6b410f4ec  session-38984\nkbf418baf175ea1b9d2934dd524bc928f  session-40169\nk0b91c07e1c216b00559be30fb71c3ba2  session-40567\nka879bb3669cf13563eb3d2a0e5f180d6  session-40740\nk0d9e1bbb2d1ee1880fdcc8a373f283e3  session-37235\nk41f9a3543853b8b87cd65cb129e271ed  session-37568\nk36404d43949eea0bb6dd1b9ee10bd3ab  session-38317\nk728b70dc3d40ac97a4889893b4d8c3ba  session-39841\nk341f81400dbb1d4c28e6db9de41f256b  session-40632\nk799ce342ea3cf3e744f7cb67231fec0e  session-40755\nkf72ea0888543f74d86fb9298b55b082e  session-40999\nk83b6975b452ee64736e734c314e46212  session-41293\nka1ce40368acfde906da06fd8d94e6ef7  session-38237\nk4028cbe00c56811a86f45bcf3fcd4dfb  session-38239\nkf357925d052e3d064623558e2c652a5e  session-38890\nk6a15532cd600acf83079a827577403fe  session-39555\nk4e4f7ad239e3cf3fd07a25ac7fe470b9  session-40883\nkd85ab6dfbd871fced2bb649ee76a4016  session-40897\nk6ea5aed9761042ad20a93e81a7fb3c9b  session-41352\nkb4c8c9106568050b5575f3ae5aab3cb2  session-41356\nk3be68becc22cfbac1d8d59e5c2d1aafc  session-36967\nk38c642364619f510f1063f02d6f8d944  session-39866\nkefbf48c1a9b1c2fd18441a86c95babdd  session-40096\nk041fe3c966cb0f93575d73c48ff6da04  session-40745\nk0242b6a4fd65509ae932efc6347a5462  session-41240\nkf123bfd79cc0ec957e1ab9c7e6869315  session-41361\nk4e1dc1b1bb2bd804b086f1b912020c27  session-41365\nk93bdd30c1a9dcdb481a3eb4997337789  session-33944\nkea9fbdc847f4f6d86c1140721c7c2573  session-41394\nk84e87b4b9c3bdd3d1e3192886262239c  session-40587\nkfa146c410717326bbf50c880929c4271  session-40805\nk3bf66875d3077b11894c9ca7ea75bbac  session-41364\nk74b4b074865caf0eafc0c2c2af57b427  session-36711\nkb88f3b0ed6bd66ccd70ddf079ac76b0a  session-41363\nk791c8816a095deaef0b16d96d49d00b6  session-41376\nkeea82dee5d1820cf6f2cf261dc515e61  session-41390\nkfe674342d3824be5bd6a7e3272546e6d  session-35942\nkd95595823b2bbef804457c4b8ea040df  session-38232\nk97675bff6437676df75f12a5c8b83c0a  session-39417\nk9fcce3bd4cabb50d6c64ee8dbfbc296d  session-39712\nk0977965bd15042cb3ca24bc64450f4f9  session-39724\nka2e4b4ca374674e8aecc650492fbd315  session-39941\nk6ece563536361b0db0753be6cd47d29f  session-41276\nkb65e2bdfb94498a00421c464e2fcd6c4  session-35957\nk93c21b186cab31e9f0d3e19b878743b3  session-38370\nk9b376cec61404a2dc006792c0d71e21c  session-39554\nk7c679c1790772a2997b1f47987c972ff  session-41274\nk3b9689d9fb971b409fc493804a28da1e  session-36018\nk2e44a0dd62614b1f270a46ce84cf85a2  session-39815\nkac9c573a39b645098994373cf262ad7a  session-40578\nk640cdbff0e7539a7ab054fe980ab4ae5  session-40992\nk8d05d5318ed05e4e21e847c9bbf5c4a7  session-41076\nk1b89026cb4d6f144745124266208c2bf  session-41353\nk6742cbd826695a6cf70f6ed472c093f5  session-41368\nkde0d8517dffd611ffa052e857f6bad62  session-36946\nk7dbc6adea2744e9befc8138291147ef2  session-36973\nk5508768441755ed8861843633b223f3e  session-38893\nk95f1a228decdf140592876b547421ecc  session-39927\nk826c581d12595c62862bb6c561e8f1cd  session-40623\nk0ae5952fe171f0844988d3affdc55c42  session-40627\nk5d737acbdefd9969a003c53c2e905ff5  session-40753\nk8786e21ac69f49ab8bc94f1240ffa190  session-41065\nkc55b2005e4ade76a70404cc5b9133996  session-36187\nkee2b2e2d5993640fdb4010c6dc726741  session-40924\nk0fccb34e7463a6a53025acf6cb6d091e  session-41246\nk3da36d6c51a5bfbc5dcf9ed3048ab741  session-41358\nka1da5a05bbbbadee5ddc07e80235143b  session-41404\nk121dcc06913c3d853a96d6b1698fea41  session-33574\nk94f6e321502cc9cd931ccc2fb2f3df0b  session-35940\nkc9dc206fc02abb55717dfba8c824528b  session-36382\nkc67bc3be6319284039bcdf7fc7f69f12  session-36445\nkf63c6749e426a53a20c97a8a3fc32abc  session-38412\nk8a7422e6669f7ebdd05bb4f8787bd7d0  session-40744\nk155e325e68ea1d7c796d2da252634336  session-40823\nkb65625725365609fb7571444284db9e0  session-40988\nkaeff765049a4cc20442c5459a6ca65b9  session-38128\nk3891c2ec97d263ab42c0db7609223e83  session-38321\nkb763eb3948d87a9e41292e145b7de5bd  session-39928\nk0a1b7e805afac341b29b88347a248cb8  session-40624\nk34e98b6ba824f69d07deca493a1302b1  session-41360\nk2919da85a860fe7ce5a217e40c3924f5  session-41366\nk0f88b0c4cd87faef0d59e11037c99ded  session-41393\nk509bbbd60571145b8f9f161736c2d5bf  session-41354\nk1171add24e356f76fa50d3bde49bbc78  session-41377\nk26e01c6431b20a6af769e4f671c409bd  session-41380\nk96e588a6d0069c791e7099c261552de9  session-37370\nk5822134deec0aa120d14fe604bb1a2c5  session-40248\nk0c8ad8772bb16cdb387269c3c5294236  session-40827\nk81c24374e0ec1d34c07442ed825ed2b9  session-41203\nk13149b46954871376e246976aa8b244a  session-41391\nkd9ca289139fadab266ddad01235efadf  session-35938\nk0effc9c9c5d67de2c077cdbe7a7d9db7  session-40885\nk8d5fd8728e3394b4b4e2e3810de22477  session-41248\nkf340f402567ca4edb77aeff0917caa31  session-41399\nk370c4ab85537e080c32d92fd84edbcb2  session-35907\nk60ad243d723d2904f4f547275dc11745  session-38843\nk988585c1818ce2f8784e4a03c4fea163  session-39856\nk989d4afaa247ada0084cdd9fdb0617a2  session-39935\nk6a0a40425e9c892a51f955b09220940b  session-39986\nk68ad125d9b3f407d9c3575dff06594b8  session-40410\n",
        "stderr": "",
        "directoryEntries": 366,
        "matchingHomes": {},
        "parserFormatControlsPass": 2
      }
    ],
    "limits": [
      "Three named host .papercusp snapshot subtrees only. Home directory presence is not a retained session receipt. No restore or source mutation."
    ],
    "invalidPriorDerivation": "Slash-suffix assumption yielded invalid initial matchingHomes. Corrected from identical retained stdout without rerunning any backup read.",
    "parserFormatControls": [
      {
        "input": "k0a3af0dca59edb173d953cf6ab85e425  session-33961",
        "expected": "session-33961",
        "actual": "session-33961",
        "passed": true
      },
      {
        "input": "k1  session-35023/",
        "expected": "session-35023",
        "actual": "session-35023",
        "passed": true
      }
    ]
  },
  "directoryProbeRecipeCall": {
    "script": "const r=await tools.capability.bash({\"command\": \"python3 - <<'BACKUP_READ'\\nimport json,subprocess,hashlib,datetime,re,concurrent.futures\\nx=json.load(open('/tmp/parked-cold28-native-scope-424d5.json'))\\nb=open(x['_projection']['cursor']['args']['file_path'],'rb').read();_,m,r=b.split(b'\\\\n',2);x=json.loads(r[json.loads(m).get('bodyOffsetInPayload',0):]);scope=json.loads(x['results'][0]['content']);assert hashlib.sha256(x['results'][0]['content'].encode()).hexdigest()=='fa68760b6856ae318d28d957f014efba6830b218cc339df2a49be0a3b7c9e31f'\\nhomes=sorted(set(re.search(r'/su-codex-homes/([^/]+)/',t['file_path']).group(1) for n in scope['native'] for t in n['tracked']))\\nids=['f0c35d92315a6900a4acc92c5cc6b986','7ca3379927d26e850ef32896e3ed2671','38e9ae53eaa0e84e43b006f5e46538f4']\\ndef inspect(sid):\\n path=sid+'/su-codex-homes';p=subprocess.run(['/usr/bin/sudo','-n','--','/usr/bin/env','KOPIA_LOG_DIR=/mnt/backup/kopia-cli-logs','/usr/bin/kopia','ls','-o',path],capture_output=True,text=True,timeout=60)\\n lines=p.stdout.splitlines();matched={h:[line for line in lines if line.rstrip().endswith(' '+h+'/') or line.rstrip()==h+'/'] for h in homes};return {'snapshotId':sid,'path':path,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr,'directoryEntries':len(lines),'matchingHomes':{h:v for h,v in matched.items() if v}}\\nwith concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:rows=list(pool.map(inspect,ids))\\na={'schemaVersion':'cold28-native-backup-directory-probe-v1','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scopeSha256':'fa68760b6856ae318d28d957f014efba6830b218cc339df2a49be0a3b7c9e31f','nativeSessionPopulation':56,'unresolvedRequestPopulation':45,'homePopulation':homes,'rows':rows,'limits':['Three named host .papercusp snapshot subtrees only. Home directory presence is not a retained session receipt. No restore or source mutation.']};text=json.dumps(a,indent=2);out='/tmp/parked-cold28-backup-directory-probe-424d5.json';open(out,'w').write(text)\\nprint(json.dumps({'evidence':out,'sha256':hashlib.sha256(text.encode()).hexdigest(),'homePopulation':len(homes),'probes':[{'snapshotId':r['snapshotId'],'exitCode':r['exitCode'],'directoryEntries':r['directoryEntries'],'matchingHomes':list(r['matchingHomes']),'stderr':r['stderr'][-500:]} for r in rows]}))\\nBACKUP_READ\", \"description\": \"Read three exact backup homes directories\", \"timeout\": 100000, \"yield_after_ms\": 25000, \"work_item_id\": \"EI-25855583682954393\"});const v=typeof r===\"string\"?JSON.parse(r):r;return {status:v.status,exit_code:v.exit_code,running:v.running,bash_id:v.bash_id,task_id:v.task_id,output:v.output,log_path:v.log_path};",
    "timeoutSec": 40,
    "title": "Probe retained native home directories",
    "description": "Read three exact historical host backup subtrees for the frozen unresolved source homes."
  },
  "failedExactRead": {
    "ok": true,
    "bash_id": "d36ff827-838",
    "task_id": "0mv6risfzdw7bt41su3",
    "status": "failed",
    "exit_code": 1,
    "running": false,
    "total_bytes": 2408,
    "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-d36ff827-838.log",
    "cpu_unavailable": "job-not-running",
    "output": "  File \"/home/linuxbrew/.linuxbrew/Cellar/python@3.14/3.14.7/lib/python3.14/subprocess.py\", line 1221, in communicate\n    stdout, stderr = self._communicate(input, endtime, timeout)\n                     ~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^\n  File \"/home/linuxbrew/.linuxbrew/Cellar/python@3.14/3.14.7/lib/python3.14/subprocess.py\", line 2154, in _communicate\n    self._check_timeout(endtime, orig_timeout, stdout, stderr)\n    ~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n  File \"/home/linuxbrew/.linuxbrew/Cellar/python@3.14/3.14.7/lib/python3.14/subprocess.py\", line 1268, in _check_timeout\n    raise TimeoutExpired(\n    ...<2 lines>...\n            stderr=b''.join(stderr_seq) if stderr_seq else None)\nsubprocess.TimeoutExpired: Command '['/usr/bin/sudo', '-n', '--', '/usr/bin/env', 'KOPIA_LOG_DIR=/mnt/backup/kopia-cli-logs', '/usr/bin/kopia', 'ls', '-o', 'f0c35d92315a6900a4acc92c5cc6b986/su-codex-homes/session-35023/sessions/2026/10/06']' timed out after 45 seconds\n"
  },
  "failedExactReadRecipeCall": {
    "script": "const r=await tools.capability.bash({\"command\": \"python3 - <<'BACKUP_READ'\\nimport json,subprocess,hashlib,datetime,re,concurrent.futures\\nx=json.load(open('/tmp/parked-cold28-native-scope-424d5.json'));b=open(x['_projection']['cursor']['args']['file_path'],'rb').read();_,m,r=b.split(b'\\\\n',2);x=json.loads(r[json.loads(m).get('bodyOffsetInPayload',0):]);scope=json.loads(x['results'][0]['content']);probe=json.load(open('/tmp/parked-cold28-backup-directory-probe-v2-424d5.json'))\\ntargets=[]\\nfor row in probe['rows']:\\n for native in scope['native']:\\n  for t in native['tracked']:\\n   home=re.search(r'/su-codex-homes/([^/]+)/',t['file_path']).group(1)\\n   if home in row['matchingHomes']:\\n    relative=t['file_path'].split('/.papercusp/',1)[1];targets.append({'sid':native['sid'],'originalPath':t['file_path'],'ingestedByteOffset':t['byte_offset'],'snapshotId':row['snapshotId'],'relative':relative,'directory':row['snapshotId']+'/'+relative.rsplit('/',1)[0],'basename':relative.rsplit('/',1)[1]})\\nunique={t['directory']:t for t in targets}\\ndef inspect(path):\\n p=subprocess.run(['/usr/bin/sudo','-n','--','/usr/bin/env','KOPIA_LOG_DIR=/mnt/backup/kopia-cli-logs','/usr/bin/kopia','ls','-o',path],capture_output=True,text=True,timeout=45)\\n return {'path':path,'exitCode':p.returncode,'stdout':p.stdout,'stderr':p.stderr}\\nwith concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:reads=list(pool.map(inspect,unique))\\nfor t in targets:\\n read=next(r for r in reads if r['path']==t['directory']);entries=[line.split(None,1) for line in read['stdout'].splitlines()];t['matchingObjects']=[parts[0] for parts in entries if len(parts)==2 and parts[1].strip().rstrip('/')==t['basename']];t['directoryExitCode']=read['exitCode']\\na={'schemaVersion':'cold28-original-native-backup-files-v1','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'directoryProbeSha256':'f2ea40fc82f1737be455e72ded1fd67880868c92b2f14b18ef47ae59d5e98fc9','targets':targets,'reads':reads,'limits':['Five home directories at two historical snapshots only; matching filename is custody candidate, not complete accepted receipt.']};c=json.dumps(a,indent=2);out='/tmp/parked-cold28-exact-backup-file-probe-424d5.json';open(out,'w').write(c)\\nprint(json.dumps({'evidence':out,'sha256':hashlib.sha256(c.encode()).hexdigest(),'targetSessions':len(set(t['sid'] for t in targets)),'directoryReads':len(reads),'matchingSessions':[t['sid'] for t in targets if t['matchingObjects']],'objects':[{'sid':t['sid'],'object':t['matchingObjects'],'snapshotId':t['snapshotId']} for t in targets if t['matchingObjects']],'directoryErrors':[r['stderr'][-500:] for r in reads if r['exitCode']]}))\\nBACKUP_READ\", \"description\": \"Inspect exact original session filenames in backups\", \"timeout\": 120000, \"yield_after_ms\": 25000, \"work_item_id\": \"EI-25855583682954393\"});const v=typeof r===\"string\"?JSON.parse(r):r;return {status:v.status,exit_code:v.exit_code,running:v.running,bash_id:v.bash_id,task_id:v.task_id,output:v.output,log_path:v.log_path};",
    "timeoutSec": 40,
    "title": "Find exact backed-up native filenames",
    "description": "Read exact frozen source directories in existing host backups; no restore."
  },
  "priorAssessmentSha256": "b0c218f70d54bde66da822d0a14fec696115357e346400294b585239d7935c51",
  "preservedCompleteReceipts": 92,
  "unresolvedRequests": 45,
  "newAcceptedReceipts": 0,
  "continuityAccepted": 0,
  "eligibilityAccepted": 0,
  "outcomesJoined": 0,
  "limits": [
    "Published original Cold27 ownerMarkdown unchanged; later backup evidence does not change that edition.",
    "Only three host .papercusp snapshot su-codex-homes roots examined; five distinct home directories found, one exact native source recovered; receipt acceptance still pending.",
    "Initial slash-suffix parser derivation invalid; corrected from retained exact stdout with two format controls, no backup read rerun.",
    "Failed exact filename task is not evidence of file absence. Per-target persistence required before further reads.",
    "No product source edit, product test rerun, terminal item redo, route change, restore or LIVE_GATE_OPS."
  ],
  "originalSourceMetadata": {
    "schemaVersion": "cold28-original-native-backup-source-v1",
    "nativeSessionId": "01a1113e-65dd-7822-9033-cde625ea52e3",
    "snapshotId": "f0c35d92315a6900a4acc92c5cc6b986",
    "parentObjectId": "kd3ea317217d3ca3de9f63cb61a224797",
    "objectId": "52e859865555fb3de80487c0230fc5e6",
    "operation": "read-only kopia show immutable original transcript object",
    "observedAt": "2026-10-13T14:22:15.780163+00:00",
    "recoveredCopyPath": "/tmp/parked-cold28-original-native-01a1113e-65dd-7822-9033-cde625ea52e3-424d5.jsonl",
    "exitCode": 0,
    "stderr": "",
    "timeout": false,
    "bytes": 2536442,
    "sha256": "3bfaaf16eeda428205069f642a3e9a105cfefc7ed82b072debab1344200b0c5e",
    "lines": 676,
    "parseErrors": [],
    "sessionMetaIds": [
      "01a1113e-65dd-7822-9033-cde625ea52e3"
    ],
    "exactSessionIdentity": true,
    "firstTimestamp": "2026-10-06T12:44:27.018Z",
    "lastTimestamp": "2026-10-06T13:13:05.111Z",
    "ingestedByteOffset": 2536442,
    "atLeastIndexedBytes": true
  },
  "originalSourceArtifact": "audits/parked-agent-resumption-2026-10-09/r13-cold28-backup-original-native-01a1113e-65dd-7822-9033-cde625ea52e3-424d5.jsonl",
  "sourceObjectRead": {
    "schemaVersion": "cold28-exact-object-read-v1",
    "originalHome": "session-35023",
    "snapshotId": "f0c35d92315a6900a4acc92c5cc6b986",
    "objectId": "k41757fc88efe5c995d6421c714b3ef8f",
    "operation": "ls -o immutable home object",
    "observedAt": "2026-10-13T14:18:49.120680+00:00",
    "exitCode": 0,
    "stdout": "24cb91607d22c1f4dbd7bd1401b486a7   papercusp-diagnostics.json\n00a088842833dd440ec8f9f1fc0e430e   session_index.jsonl\nk3e9a84299288ec621e676bcb6b0dbc02  mcp-oauth-locks\nk1aefc012349ad08758bf431c0c219445  prompts\nk73d1ca767fc2e47cc19ebff40aa82e44  shell_snapshots\n45259c2af63061a5f016feb34064b998   .owner-sid\nd80d9a19e84063f3cba353d36eb641a8   models_cache.json\nde4386dda8ca2595cf8c2285c5b14096   plugins\n51b665bdfb2b043dec008340940add73   skills\nkbebfdae5928ab4009ab47a2051bfda1b  cache\nk9d80a701bbadcba562495a0880353880  thread-writer-locks\n92221f5c13f176f1c31cbd69e5f54bb5   AGENTS.md\n5392b5193c1c846d962ad0941360fa87   config.toml\n8cbd6ca74b64679e3c53256049a49283   installation_id\n6b2b38c86fad1a81b4bf94caff0cbb94   version.json\nk7457ac324c74ed0dc956d1578ad122ad  log\nkd3ea317217d3ca3de9f63cb61a224797  sessions\n871b51209f205048bcaf70e0fbdf5357   .papercusp-carry-base-AGENTS.md\n1e3f35ab1bf7e7b8a028bc62e655a363   .sandbox_migration\ndfe8856b0fa446ec24dd28583b203ec7   auth.json\n755b7422fcbce1b941b8c8c45358a941   hooks.json\n8b15d228cf76195db1f41fcd9dd29d0c   history.jsonl\n",
    "stderr": "",
    "timeout": false
  },
  "sourceSessionsObjectRead": {
    "schemaVersion": "cold28-exact-object-read-v1",
    "originalHome": "session-35023",
    "snapshotId": "f0c35d92315a6900a4acc92c5cc6b986",
    "parentObjectId": "k41757fc88efe5c995d6421c714b3ef8f",
    "objectId": "kd3ea317217d3ca3de9f63cb61a224797",
    "operation": "ls -r -o immutable sessions object",
    "observedAt": "2026-10-13T14:20:18.987205+00:00",
    "exitCode": 0,
    "stdout": "ka2aed8eb278cdb130484c0105284a3d4  kd3ea317217d3ca3de9f63cb61a224797/2026/\nk6dfbe27671391e0598a30186c8d7915f  kd3ea317217d3ca3de9f63cb61a224797/2026/10/\nkbb04292a2ef08c47f91eb2a0e6681ee4  kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/\nIxc769b621be3d86fb2fb22fd65700ef12 kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/rollout-2026-10-06T06-09-15-01a110b0-5922-7801-98c8-d6136f8d1e81.jsonl\n38925b21256221228b6ea1766462461e   kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/rollout-2026-10-06T07-00-02-01a110de-da18-77a1-ae59-266572a9581f.jsonl\nIx946d94b25ddb750a413193cd60f4791d kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/rollout-2026-10-06T07-54-05-01a11110-5644-7cd1-ae08-0fa1ab812d13.jsonl\n0ae4b8caca1316b400afabcbd62a9bc0   kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/rollout-2026-10-06T08-23-33-01a1112b-5115-7990-a36b-c354420236b0.jsonl\n52e859865555fb3de80487c0230fc5e6   kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/rollout-2026-10-06T08-44-24-01a1113e-65dd-7822-9033-cde625ea52e3.jsonl\n99f9f08cff7f888b4508655ea6a8745d   kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/rollout-2026-10-06T09-13-09-01a11158-b6c7-7c23-8712-bc632b5004fa.jsonl\ndf3f2fa7017ab517919f47cbeedbd831   kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/rollout-2026-10-06T09-35-19-01a1116d-047a-71f2-a719-b43eb100ae49.jsonl\n5a316b9a8dfc7922bfffc8d1dad2003e   kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/rollout-2026-10-06T10-39-15-01a111a7-8cf1-7423-908a-2593a8fe6558.jsonl\n674c754e545aea442a92b6143ef73bd2   kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/rollout-2026-10-06T10-04-11-01a11187-7047-7ab3-9835-c40a05024551.jsonl\nfe20735d8bc2ffbfe7d4c2a537d3b863   kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/rollout-2026-10-06T10-50-01-01a111b1-68e4-7d72-b2ed-947b5258ff93.jsonl\naaa7d4762dcbe73a01582cf256969fbc   kd3ea317217d3ca3de9f63cb61a224797/2026/10/06/rollout-2026-10-06T11-18-41-01a111cb-a843-73d3-b9d7-2bda35ec8d97.jsonl\n",
    "stderr": "",
    "timeout": false
  },
  "sourceAcquisitionRecipeCall": {
    "script": "const r=await tools.capability.bash({\"command\": \"python3 - <<'BACKUP_READ'\\nimport json,subprocess,hashlib,datetime,os\\nprior=json.load(open('/tmp/parked-cold28-home35023-sessions-object-read-424d5.json'));sid='01a1113e-65dd-7822-9033-cde625ea52e3';hits=[l.split(None,1) for l in prior['stdout'].splitlines() if sid in l];assert len(hits)==1;obj=hits[0][0];source='/tmp/parked-cold28-original-native-'+sid+'-424d5.jsonl';out='/tmp/parked-cold28-native-source-custody-424d5.json';a={'schemaVersion':'cold28-original-native-backup-source-v1','nativeSessionId':sid,'snapshotId':prior['snapshotId'],'parentObjectId':prior['objectId'],'objectId':obj,'operation':'read-only kopia show immutable original transcript object','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'recoveredCopyPath':source}\\nwith open(source+'.pending','wb') as f:\\n try:\\n  p=subprocess.run(['/usr/bin/sudo','-n','--','/usr/bin/env','KOPIA_LOG_DIR=/mnt/backup/kopia-cli-logs','/usr/bin/kopia','show',obj],stdout=f,stderr=subprocess.PIPE,timeout=40);a.update(exitCode=p.returncode,stderr=p.stderr.decode(),timeout=False)\\n except subprocess.TimeoutExpired as e:a.update(exitCode=None,timeout=True,stderr=(e.stderr or b'').decode() if isinstance(e.stderr,bytes) else (e.stderr or ''))\\nif a['exitCode']==0 and not a['timeout']:\\n os.replace(source+'.pending',source);raw=open(source,'rb').read();lines=raw.splitlines();errors=[];meta=[];stamps=[]\\n for n,line in enumerate(lines,1):\\n  try:r=json.loads(line)\\n  except Exception as e:errors.append({'line':n,'message':str(e)});continue\\n  if r.get('type')=='session_meta':meta.append(r.get('payload',{}).get('id'))\\n  if isinstance(r.get('timestamp'),str):stamps.append(r['timestamp'])\\n a.update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),lines=len(lines),parseErrors=errors,sessionMetaIds=meta,exactSessionIdentity=(meta==[sid]),firstTimestamp=min(stamps) if stamps else None,lastTimestamp=max(stamps) if stamps else None,ingestedByteOffset=2536442,atLeastIndexedBytes=len(raw)>=2536442)\\nelse:a['partialSourcePath']=source+'.pending'\\nc=json.dumps(a,indent=2);open(out+'.pending','w').write(c);os.replace(out+'.pending',out);print(json.dumps({'evidence':out,'metadataSha256':hashlib.sha256(c.encode()).hexdigest(),**{k:a.get(k) for k in ('nativeSessionId','objectId','exitCode','timeout','bytes','sha256','lines','sessionMetaIds','exactSessionIdentity','atLeastIndexedBytes','firstTimestamp','lastTimestamp')},'parseErrorCount':len(a.get('parseErrors',[]))}))\\nBACKUP_READ\", \"description\": \"Read immutable original native transcript bytes\", \"timeout\": 55000, \"yield_after_ms\": 25000, \"work_item_id\": \"EI-25855583682954393\"});const v=typeof r===\"string\"?JSON.parse(r):r;return {status:v.status,running:v.running,bash_id:v.bash_id,task_id:v.task_id,output:v.output,log_path:v.log_path};",
    "timeoutSec": 40,
    "title": "Acquire exact original source from backup",
    "description": "Stream one immutable original transcript object into an evidence copy; verify identity and full byte hash; no restore."
  },
  "newRecoveredNativeSources": 1,
  "next": "Re-read this full acquisition evidence and original Cold27 procedure/assessment; preserve92. Reuse original Codex native parser/writer to map recovered session01a1113e into exact complete original request pair32231391. Validate existing owner/args/status/time/cell/adjacent-original-result guards before reclassifying any row. Continue four other retained home-object paths and remaining historical snapshot directory coverage without repeating completed reads. No product tests, terminal redo, restore, route change or LIVE_GATE_OPS."
}
