---
rel_path: "evidence/originals/ee793ed6478cbe163b5f48b51bf3e9e09735cb6ee670900643815e29e70bdcc3.json"
updated_at: 1790936108055
_body: "content"
---

{
  "schemaVersion": 1,
  "incomplete": true,
  "buildSha": "98f502be2781356b14b543d1fa49021e40b2338d",
  "sourcePath": "packages/operator-core/lib/content-lint/esbuild-transform.ts",
  "sourceHash": "f57a776a8af87c95fa614855921eb7981012f063aac5159269433805baa65796",
  "error": "AssertionError: expected [ [ 'warm.ts', …(2) ], [ …(3) ], …(9) ] to deeply equal [ [ 'warm.ts', …(2) ], [ …(3) ], …(9) ]",
  "reports": [
    {
      "mode": "control",
      "samples": [
        {
          "phase": "warm-idle",
          "at": "2026-10-02T06:18:35.263Z",
          "parent": {
            "pid": 2796166,
            "startTicks": "21159381",
            "executable": "/home/marsh-office/.local/node25/bin/node",
            "executableSha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
            "pssKb": 13228,
            "anonymousKb": 12988,
            "privateDirtyKb": 13012
          },
          "memory": {
            "pid": 2796166,
            "at": 1790921914880,
            "uptime": 0.199857103,
            "memory": {
              "rss": 46723072,
              "heapTotal": 8523776,
              "heapUsed": 6006352,
              "external": 2283805,
              "arrayBuffers": 47110
            },
            "heap": {
              "total_heap_size": 8523776,
              "total_heap_size_executable": 262144,
              "total_physical_size": 8523776,
              "total_available_size": 137636361192,
              "used_heap_size": 6011240,
              "heap_size_limit": 137640280064,
              "malloced_memory": 426096,
              "peak_malloced_memory": 1642856,
              "does_zap_garbage": 0,
              "number_of_native_contexts": 1,
              "number_of_detached_contexts": 0,
              "total_global_handles_size": 8192,
              "used_global_handles_size": 2976,
              "external_memory": 2283845,
              "total_allocated_bytes": 25102528
            }
          },
          "children": [
            {
              "pid": 2796354,
              "startTicks": "21159399",
              "executable": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild",
              "executableSha256": "fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c",
              "pssKb": 5868,
              "anonymousKb": 5456,
              "privateDirtyKb": 5456
            }
          ]
        },
        {
          "phase": "ordinary-0",
          "at": "2026-10-02T06:18:35.943Z",
          "parent": {
            "pid": 2796166,
            "startTicks": "21159381",
            "executable": "/home/marsh-office/.local/node25/bin/node",
            "executableSha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
            "pssKb": 15908,
            "anonymousKb": 15660,
            "privateDirtyKb": 15684
          },
          "memory": {
            "pid": 2796166,
            "at": 1790921915535,
            "uptime": 0.854436357,
            "memory": {
              "rss": 49868800,
              "heapTotal": 10756096,
              "heapUsed": 8103504,
              "external": 2932651,
              "arrayBuffers": 695916
            },
            "heap": {
              "total_heap_size": 10756096,
              "total_heap_size_executable": 524288,
              "total_physical_size": 10756096,
              "total_available_size": 137633084848,
              "used_heap_size": 8103728,
              "heap_size_limit": 137640280064,
              "malloced_memory": 426096,
              "peak_malloced_memory": 1642856,
              "does_zap_garbage": 0,
              "number_of_native_contexts": 1,
              "number_of_detached_contexts": 0,
              "total_global_handles_size": 24576,
              "used_global_handles_size": 13664,
              "external_memory": 2932651,
              "total_allocated_bytes": 32052488
            }
          },
          "children": [
            {
              "pid": 2796354,
              "startTicks": "21159399",
              "executable": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild",
              "executableSha256": "fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c",
              "pssKb": 5923,
              "anonymousKb": 5492,
              "privateDirtyKb": 5492
            }
          ]
        },
        {
          "phase": "ordinary-1",
          "at": "2026-10-02T06:18:36.255Z",
          "parent": {
            "pid": 2796166,
            "startTicks": "21159381",
            "executable": "/home/marsh-office/.local/node25/bin/node",
            "executableSha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
            "pssKb": 17037,
            "anonymousKb": 16788,
            "privateDirtyKb": 16812
          },
          "memory": {
            "pid": 2796166,
            "at": 1790921915979,
            "uptime": 1.299027999,
            "memory": {
              "rss": 50917376,
              "heapTotal": 11280384,
              "heapUsed": 7907992,
              "external": 3582514,
              "arrayBuffers": 646149
            },
            "heap": {
              "total_heap_size": 11280384,
              "total_heap_size_executable": 524288,
              "total_physical_size": 11280384,
              "total_available_size": 137633876160,
              "used_heap_size": 7908216,
              "heap_size_limit": 137640280064,
              "malloced_memory": 426096,
              "peak_malloced_memory": 1642856,
              "does_zap_garbage": 0,
              "number_of_native_contexts": 1,
              "number_of_detached_contexts": 0,
              "total_global_handles_size": 24576,
              "used_global_handles_size": 13728,
              "external_memory": 3582514,
              "total_allocated_bytes": 39203552
            }
          },
          "children": [
            {
              "pid": 2796354,
              "startTicks": "21159399",
              "executable": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild",
              "executableSha256": "fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c",
              "pssKb": 5923,
              "anonymousKb": 5492,
              "privateDirtyKb": 5492
            }
          ]
        },
        {
          "phase": "ordinary-2",
          "at": "2026-10-02T06:18:36.547Z",
          "parent": {
            "pid": 2796166,
            "startTicks": "21159381",
            "executable": "/home/marsh-office/.local/node25/bin/node",
            "executableSha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
            "pssKb": 18933,
            "anonymousKb": 18684,
            "privateDirtyKb": 18708
          },
          "memory": {
            "pid": 2796166,
            "at": 1790921916290,
            "uptime": 1.61011715,
            "memory": {
              "rss": 51965952,
              "heapTotal": 12464128,
              "heapUsed": 9382912,
              "external": 3531690,
              "arrayBuffers": 1294955
            },
            "heap": {
              "total_heap_size": 12464128,
              "total_heap_size_executable": 524288,
              "total_physical_size": 12464128,
              "total_available_size": 137631217496,
              "used_heap_size": 9383136,
              "heap_size_limit": 137640280064,
              "malloced_memory": 426096,
              "peak_malloced_memory": 1642856,
              "does_zap_garbage": 0,
              "number_of_native_contexts": 1,
              "number_of_detached_contexts": 0,
              "total_global_handles_size": 24576,
              "used_global_handles_size": 13792,
              "external_memory": 3531690,
              "total_allocated_bytes": 43823056
            }
          },
          "children": [
            {
              "pid": 2796354,
              "startTicks": "21159399",
              "executable": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild",
              "executableSha256": "fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c",
              "pssKb": 5923,
              "anonymousKb": 5492,
              "privateDirtyKb": 5492
            }
          ]
        },
        {
          "phase": "one-second-idle",
          "at": "2026-10-02T06:18:37.837Z",
          "parent": {
            "pid": 2796166,
            "startTicks": "21159381",
            "executable": "/home/marsh-office/.local/node25/bin/node",
            "executableSha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
            "pssKb": 18950,
            "anonymousKb": 18700,
            "privateDirtyKb": 18724
          },
          "memory": {
            "pid": 2796166,
            "at": 1790921917592,
            "uptime": 2.911642916,
            "memory": {
              "rss": 51965952,
              "heapTotal": 12464128,
              "heapUsed": 9405408,
              "external": 3532747,
              "arrayBuffers": 1296012
            },
            "heap": {
              "total_heap_size": 12464128,
              "total_heap_size_executable": 524288,
              "total_physical_size": 12464128,
              "total_available_size": 137631195000,
              "used_heap_size": 9405632,
              "heap_size_limit": 137640280064,
              "malloced_memory": 426096,
              "peak_malloced_memory": 1642856,
              "does_zap_garbage": 0,
              "number_of_native_contexts": 1,
              "number_of_detached_contexts": 0,
              "total_global_handles_size": 24576,
              "used_global_handles_size": 13952,
              "external_memory": 3532747,
              "total_allocated_bytes": 45318416
            }
          },
          "children": [
            {
              "pid": 2796354,
              "startTicks": "21159399",
              "executable": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild",
              "executableSha256": "fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c",
              "pssKb": 5969,
              "anonymousKb": 5492,
              "privateDirtyKb": 5492
            }
          ]
        }
      ],
      "requests": [
        {
          "path": "warm.ts",
          "route": "/warm",
          "sourceSha256": "26bb53bfbb78bc6c5bb57738d95de095cbbd0fb4292309e0525b533e17833f4e",
          "sourceBytes": 21,
          "error": null,
          "elapsedMs": 87.98744699999997
        },
        {
          "path": "packages/operator-core/lib/content-lint/esbuild-transform.ts",
          "route": "/check",
          "sourceSha256": "f57a776a8af87c95fa614855921eb7981012f063aac5159269433805baa65796",
          "sourceBytes": 4913,
          "error": null,
          "elapsedMs": 16.323984999999993
        },
        {
          "path": "packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts",
          "route": "/check",
          "sourceSha256": "4127c8da11e326ed7fc5e354b9fe4b84abd890a52e3ea2c3f365348aad4673a4",
          "sourceBytes": 19126,
          "error": null,
          "elapsedMs": 22.595681999999897
        },
        {
          "path": "packages/operator-core/lib/harness/improvements/watchdog.ts",
          "route": "/check",
          "sourceSha256": "0c615a0a8124a63897778708070dca406a24f8653bd843cdb103668341cb940e",
          "sourceBytes": 293768,
          "error": null,
          "elapsedMs": 30.82523500000002
        },
        {
          "path": "packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts",
          "route": "/check",
          "sourceSha256": "4127c8da11e326ed7fc5e354b9fe4b84abd890a52e3ea2c3f365348aad4673a4",
          "sourceBytes": 19126,
          "error": null,
          "elapsedMs": 28.49707999999987
        },
        {
          "path": "packages/operator-core/lib/content-lint/esbuild-transform.ts",
          "route": "/check",
          "sourceSha256": "f57a776a8af87c95fa614855921eb7981012f063aac5159269433805baa65796",
          "sourceBytes": 4913,
          "error": null,
          "elapsedMs": 26.003959000000123
        },
        {
          "path": "packages/operator-core/lib/harness/improvements/watchdog.ts",
          "route": "/check",
          "sourceSha256": "0c615a0a8124a63897778708070dca406a24f8653bd843cdb103668341cb940e",
          "sourceBytes": 293768,
          "error": null,
          "elapsedMs": 31.92148800000018
        },
        {
          "path": "packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts",
          "route": "/check",
          "sourceSha256": "4127c8da11e326ed7fc5e354b9fe4b84abd890a52e3ea2c3f365348aad4673a4",
          "sourceBytes": 19126,
          "error": null,
          "elapsedMs": 28.3277149999999
        },
        {
          "path": "packages/operator-core/lib/content-lint/esbuild-transform.ts",
          "route": "/check",
          "sourceSha256": "f57a776a8af87c95fa614855921eb7981012f063aac5159269433805baa65796",
          "sourceBytes": 4913,
          "error": null,
          "elapsedMs": 25.555628999999954
        },
        {
          "path": "packages/operator-core/lib/harness/improvements/watchdog.ts",
          "route": "/check",
          "sourceSha256": "0c615a0a8124a63897778708070dca406a24f8653bd843cdb103668341cb940e",
          "sourceBytes": 293768,
          "error": null,
          "elapsedMs": 30.111065999999937
        },
        {
          "path": "invalid.ts",
          "route": "/check",
          "sourceSha256": "a4367937d40ec916dfbd64caa5d0c824d766531f353b123b77e91ea33bc97ee5",
          "sourceBytes": 23,
          "error": null,
          "elapsedMs": 5.595690999999988
        }
      ],
      "windows": [
        {
          "window": 0,
          "concurrency": 3,
          "completed": 3,
          "elapsedMs": 34.80186099999992
        },
        {
          "window": 1,
          "concurrency": 3,
          "completed": 3,
          "elapsedMs": 35.63905700000009
        },
        {
          "window": 2,
          "concurrency": 3,
          "completed": 3,
          "elapsedMs": 34.35578600000008
        }
      ],
      "trace": {
        "pid": 2796166,
        "startedAt": 1790921915457,
        "until": 1790921935457,
        "total": 0,
        "observerMs": 0,
        "calls": {
          "transform": {
            "calls": 0,
            "stacks": []
          }
        },
        "endedAt": 1790921916547,
        "limited": false
      },
      "reaped": true,
      "pid": 2796166,
      "traceLimits": {
        "durationMs": 20000,
        "maxCalls": 64,
        "maxStacks": 4,
        "maxStackChars": 2000
      },
      "pauses": 0,
      "unreaped": []
    },
    {
      "mode": "transform",
      "samples": [
        {
          "phase": "warm-idle",
          "at": "2026-10-02T06:18:38.284Z",
          "parent": {
            "pid": 2798775,
            "startTicks": "21159702",
            "executable": "/home/marsh-office/.local/node25/bin/node",
            "executableSha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
            "pssKb": 13231,
            "anonymousKb": 12988,
            "privateDirtyKb": 13012
          },
          "memory": {
            "pid": 2798775,
            "at": 1790921918015,
            "uptime": 0.114887937,
            "memory": {
              "rss": 48803840,
              "heapTotal": 8785920,
              "heapUsed": 5989120,
              "external": 2283805,
              "arrayBuffers": 47110
            },
            "heap": {
              "total_heap_size": 8785920,
              "total_heap_size_executable": 524288,
              "total_physical_size": 8785920,
              "total_available_size": 137636378408,
              "used_heap_size": 5994008,
              "heap_size_limit": 137640280064,
              "malloced_memory": 426096,
              "peak_malloced_memory": 1642856,
              "does_zap_garbage": 0,
              "number_of_native_contexts": 1,
              "number_of_detached_contexts": 0,
              "total_global_handles_size": 8192,
              "used_global_handles_size": 2976,
              "external_memory": 2283845,
              "total_allocated_bytes": 24036248
            }
          },
          "children": [
            {
              "pid": 2798943,
              "startTicks": "21159713",
              "executable": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild",
              "executableSha256": "fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c",
              "pssKb": 5849,
              "anonymousKb": 5376,
              "privateDirtyKb": 5376
            }
          ]
        },
        {
          "phase": "ordinary-0",
          "at": "2026-10-02T06:18:38.815Z",
          "parent": {
            "pid": 2798775,
            "startTicks": "21159702",
            "executable": "/home/marsh-office/.local/node25/bin/node",
            "executableSha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
            "pssKb": 17963,
            "anonymousKb": 17712,
            "privateDirtyKb": 17744
          },
          "memory": {
            "pid": 2798775,
            "at": 1790921918524,
            "uptime": 0.623667036,
            "memory": {
              "rss": 51949568,
              "heapTotal": 11288576,
              "heapUsed": 8607656,
              "external": 4623452,
              "arrayBuffers": 2347800
            },
            "heap": {
              "total_heap_size": 11288576,
              "total_heap_size_executable": 524288,
              "total_physical_size": 11288576,
              "total_available_size": 137632310360,
              "used_heap_size": 8607880,
              "heap_size_limit": 137640280064,
              "malloced_memory": 426096,
              "peak_malloced_memory": 1642856,
              "does_zap_garbage": 0,
              "number_of_native_contexts": 1,
              "number_of_detached_contexts": 0,
              "total_global_handles_size": 24576,
              "used_global_handles_size": 14368,
              "external_memory": 4623452,
              "total_allocated_bytes": 33336224
            }
          },
          "children": [
            {
              "pid": 2798943,
              "startTicks": "21159713",
              "executable": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild",
              "executableSha256": "fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c",
              "pssKb": 11384,
              "anonymousKb": 10908,
              "privateDirtyKb": 10908
            }
          ]
        },
        {
          "phase": "ordinary-1",
          "at": "2026-10-02T06:18:39.141Z",
          "parent": {
            "pid": 2798775,
            "startTicks": "21159702",
            "executable": "/home/marsh-office/.local/node25/bin/node",
            "executableSha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
            "pssKb": 19936,
            "anonymousKb": 19684,
            "privateDirtyKb": 19716
          },
          "memory": {
            "pid": 2798775,
            "at": 1790921918862,
            "uptime": 0.96235991,
            "memory": {
              "rss": 52998144,
              "heapTotal": 12406784,
              "heapUsed": 9318568,
              "external": 4349332,
              "arrayBuffers": 2073680
            },
            "heap": {
              "total_heap_size": 12406784,
              "total_heap_size_executable": 524288,
              "total_physical_size": 12406784,
              "total_available_size": 137632190344,
              "used_heap_size": 9318792,
              "heap_size_limit": 137640280064,
              "malloced_memory": 426096,
              "peak_malloced_memory": 1642856,
              "does_zap_garbage": 0,
              "number_of_native_contexts": 1,
              "number_of_detached_contexts": 0,
              "total_global_handles_size": 24576,
              "used_global_handles_size": 14624,
              "external_memory": 4349332,
              "total_allocated_bytes": 39734504
            }
          },
          "children": [
            {
              "pid": 2798943,
              "startTicks": "21159713",
              "executable": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild",
              "executableSha256": "fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c",
              "pssKb": 12916,
              "anonymousKb": 12440,
              "privateDirtyKb": 12440
            }
          ]
        },
        {
          "phase": "ordinary-2",
          "at": "2026-10-02T06:18:39.478Z",
          "parent": {
            "pid": 2798775,
            "startTicks": "21159702",
            "executable": "/home/marsh-office/.local/node25/bin/node",
            "executableSha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
            "pssKb": 22180,
            "anonymousKb": 21928,
            "privateDirtyKb": 21960
          },
          "memory": {
            "pid": 2798775,
            "at": 1790921919184,
            "uptime": 1.283931319,
            "memory": {
              "rss": 54046720,
              "heapTotal": 13524992,
              "heapUsed": 10443192,
              "external": 6252487,
              "arrayBuffers": 433254
            },
            "heap": {
              "total_heap_size": 13524992,
              "total_heap_size_executable": 524288,
              "total_physical_size": 13524992,
              "total_available_size": 137635838968,
              "used_heap_size": 10443416,
              "heap_size_limit": 137640280064,
              "malloced_memory": 426096,
              "peak_malloced_memory": 1642856,
              "does_zap_garbage": 0,
              "number_of_native_contexts": 1,
              "number_of_detached_contexts": 0,
              "total_global_handles_size": 24576,
              "used_global_handles_size": 14880,
              "external_memory": 6252487,
              "total_allocated_bytes": 45900840
            }
          },
          "children": [
            {
              "pid": 2798943,
              "startTicks": "21159713",
              "executable": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild",
              "executableSha256": "fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c",
              "pssKb": 12036,
              "anonymousKb": 11560,
              "privateDirtyKb": 11560
            }
          ]
        },
        {
          "phase": "one-second-idle",
          "at": "2026-10-02T06:18:40.792Z",
          "parent": {
            "pid": 2798775,
            "startTicks": "21159702",
            "executable": "/home/marsh-office/.local/node25/bin/node",
            "executableSha256": "7fd113446e9171a28885227b3c275ff965b2fd1f45ccf1fb3a1c20308f34e627",
            "pssKb": 22200,
            "anonymousKb": 21948,
            "privateDirtyKb": 21980
          },
          "memory": {
            "pid": 2798775,
            "at": 1790921920525,
            "uptime": 2.624443571,
            "memory": {
              "rss": 54046720,
              "heapTotal": 13524992,
              "heapUsed": 10457544,
              "external": 2709963,
              "arrayBuffers": 434311
            },
            "heap": {
              "total_heap_size": 13524992,
              "total_heap_size_executable": 524288,
              "total_physical_size": 13524992,
              "total_available_size": 137635824616,
              "used_heap_size": 10457768,
              "heap_size_limit": 137640280064,
              "malloced_memory": 426096,
              "peak_malloced_memory": 1642856,
              "does_zap_garbage": 0,
              "number_of_native_contexts": 1,
              "number_of_detached_contexts": 0,
              "total_global_handles_size": 24576,
              "used_global_handles_size": 15040,
              "external_memory": 2709963,
              "total_allocated_bytes": 46268888
            }
          },
          "children": [
            {
              "pid": 2798943,
              "startTicks": "21159713",
              "executable": "/home/marsh-office/papercupai-workspace/papercusp/node_modules/@esbuild/linux-x64/bin/esbuild",
              "executableSha256": "fd49340cbb5f7ca3ce6f313db78d056de21f07338135ec8dfad63294a304fd2c",
              "pssKb": 12044,
              "anonymousKb": 11568,
              "privateDirtyKb": 11568
            }
          ]
        }
      ],
      "requests": [
        {
          "path": "warm.ts",
          "route": "/warm",
          "sourceSha256": "26bb53bfbb78bc6c5bb57738d95de095cbbd0fb4292309e0525b533e17833f4e",
          "sourceBytes": 21,
          "error": null,
          "elapsedMs": 33.866987999999765
        },
        {
          "path": "packages/operator-core/lib/content-lint/esbuild-transform.ts",
          "route": "/check",
          "sourceSha256": "f57a776a8af87c95fa614855921eb7981012f063aac5159269433805baa65796",
          "sourceBytes": 4913,
          "error": null,
          "elapsedMs": 16.59111699999994
        },
        {
          "path": "packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts",
          "route": "/check",
          "sourceSha256": "4127c8da11e326ed7fc5e354b9fe4b84abd890a52e3ea2c3f365348aad4673a4",
          "sourceBytes": 19126,
          "error": null,
          "elapsedMs": 17.96770800000013
        },
        {
          "path": "packages/operator-core/lib/harness/improvements/watchdog.ts",
          "route": "/check",
          "sourceSha256": "0c615a0a8124a63897778708070dca406a24f8653bd843cdb103668341cb940e",
          "sourceBytes": 293768,
          "error": null,
          "elapsedMs": 38.38850999999977
        },
        {
          "path": "packages/operator-core/lib/content-lint/esbuild-transform.ts",
          "route": "/check",
          "sourceSha256": "f57a776a8af87c95fa614855921eb7981012f063aac5159269433805baa65796",
          "sourceBytes": 4913,
          "error": null,
          "elapsedMs": 27.49180299999989
        },
        {
          "path": "packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts",
          "route": "/check",
          "sourceSha256": "4127c8da11e326ed7fc5e354b9fe4b84abd890a52e3ea2c3f365348aad4673a4",
          "sourceBytes": 19126,
          "error": null,
          "elapsedMs": 32.21717499999977
        },
        {
          "path": "packages/operator-core/lib/harness/improvements/watchdog.ts",
          "route": "/check",
          "sourceSha256": "0c615a0a8124a63897778708070dca406a24f8653bd843cdb103668341cb940e",
          "sourceBytes": 293768,
          "error": null,
          "elapsedMs": 42.7876069999993
        },
        {
          "path": "packages/operator-core/lib/content-lint/esbuild-transform.ts",
          "route": "/check",
          "sourceSha256": "f57a776a8af87c95fa614855921eb7981012f063aac5159269433805baa65796",
          "sourceBytes": 4913,
          "error": null,
          "elapsedMs": 22.847536999999647
        },
        {
          "path": "packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts",
          "route": "/check",
          "sourceSha256": "4127c8da11e326ed7fc5e354b9fe4b84abd890a52e3ea2c3f365348aad4673a4",
          "sourceBytes": 19126,
          "error": null,
          "elapsedMs": 26.55001699999957
        },
        {
          "path": "packages/operator-core/lib/harness/improvements/watchdog.ts",
          "route": "/check",
          "sourceSha256": "0c615a0a8124a63897778708070dca406a24f8653bd843cdb103668341cb940e",
          "sourceBytes": 293768,
          "error": null,
          "elapsedMs": 39.199876000000586
        },
        {
          "path": "invalid.ts",
          "route": "/check",
          "sourceSha256": "a4367937d40ec916dfbd64caa5d0c824d766531f353b123b77e91ea33bc97ee5",
          "sourceBytes": 23,
          "error": {
            "line": 1,
            "col": 23,
            "reason": "Unexpected \";\""
          },
          "elapsedMs": 6.496889999999439
        }
      ],
      "windows": [
        {
          "window": 0,
          "concurrency": 3,
          "completed": 3,
          "elapsedMs": 39.54655100000036
        },
        {
          "window": 1,
          "concurrency": 3,
          "completed": 3,
          "elapsedMs": 47.20679100000052
        },
        {
          "window": 2,
          "concurrency": 3,
          "completed": 3,
          "elapsedMs": 42.68144299999949
        }
      ],
      "trace": {
        "pid": 2798775,
        "startedAt": 1790921918443,
        "until": 1790921938443,
        "total": 9,
        "observerMs": 0.6794709999999213,
        "calls": {
          "transform": {
            "calls": 9,
            "stacks": [
              "Error\n    at eval (eval at transform (/home/marsh-office/papercupai-workspace/papercusp/node_modules/esbuild/lib/main.js:1:1), <anonymous>:6:32)\n    at eval (eval at transform (/home/marsh-office/papercupai-workspace/papercusp/node_modules/esbuild/lib/main.js:1:1), <anonymous>:9:70)\n    at transform (/home/marsh-office/papercupai-workspace/papercusp/node_modules/esbuild/lib/main.js:1878:62)\n    at findEsbuildTransformError (/tmp/pcv/papercusp-content-lint-cohort-dQdqG1/request-host.cjs:64:11)\n    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)\n    at async Server.<anonymous> (/tmp/pcv/papercusp-content-lint-cohort-dQdqG1/request-host.cjs:90:69)"
            ]
          }
        },
        "endedAt": 1790921919479,
        "limited": false
      },
      "reaped": true,
      "pid": 2798775,
      "traceLimits": {
        "durationMs": 20000,
        "maxCalls": 64,
        "maxStacks": 4,
        "maxStackChars": 2000
      },
      "pauses": 0,
      "unreaped": []
    }
  ]
}

