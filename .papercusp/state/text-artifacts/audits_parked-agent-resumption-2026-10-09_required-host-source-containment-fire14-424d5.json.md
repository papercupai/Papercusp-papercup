---
rel_path: "audits/parked-agent-resumption-2026-10-09/required-host-source-containment-fire14-424d5.json"
updated_at: 1791807530084
_body: "content"
---

{
  "schemaVersion": "parked-required-host-source-containment-v1",
  "workItem": "WI-6554700010008887",
  "plan": "parked-agent-census-resumption-and-root-cause-2026-10-09",
  "observedAt": "2026-10-12T12:18:48.487174+00:00",
  "scope": "Local su metadata records with existing socket, live PID and launcher/host cmdline; structural loaded-source marker containment only, not behavior proof, complete runtime containment or a 24h anchor. No host was woken/restarted.",
  "writerRefs": [
    "apps/operator/scripts/psu-pty-host.mjs:194",
    "apps/operator/scripts/psu-pty-host.mjs:10234"
  ],
  "markers": {
    "P004-detector": "export function makeAuthBlockDetector(",
    "P004-input-observer": "const authTransition = authBlockDetector.observe(stripAnsi(raw) ?? '');",
    "P004-published-recovery-capability": "'auth-recovery'",
    "P005-spawn-bound-window": "export const UNBOUND_CHILD_WINDOW_MS = 120_000;",
    "P005-idempotent-unbindable-refusal": "export function duplicateDeliveryVerdict(",
    "quota-reset-expiry-probe": "export function parseQuotaResetAtMs("
  },
  "search": {
    "since": "2026-09-20",
    "examinedFileCommits": [
      "5276be35fe8ea6162547cdb3f63523401bcc84fc",
      "e35cac84042426d62b75f0c87ce7afebce5ab308",
      "25b768f6978dcaf7808222bc64feda2d6b74d74f",
      "f253aae19f49102212b454523d94ca760efbc4c2",
      "e33dc0862eba85df86cfa77cfd88e4c3d9f15d6f",
      "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
      "d4dc3833b5883fb7930999b3ce6c5f872becd921",
      "459247f5eaa7fcf24b4d1eb82d8488fde5b1e475",
      "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
      "2c2387f46aaf0ebf1c1c91ab636e555b4df1b008",
      "a8d366186a21076aee871d56cba3c8db9752a14e",
      "ada314ca977fff4069364dba5a273b794cede4ac",
      "5345a9c0e71bd0997ecb1e502b826cbc865a1b84",
      "a0caf359a47d0a07b66e71fd3f970d833c037392",
      "ad32e4f6515b864a1dec31e8e8e2544595edaac8",
      "35e297ce5978608f904bedc64222eb88e7d3d262",
      "c8d979dce30f383cb60746998700ce09edd97017",
      "f61d2dab1f4c63ac53cd2f20f926a15f284a6f37",
      "ff985964444bd1b75c428eb8f47053bc02e598c2",
      "405947bc4cfff1ed3b721daa4af027d64d71e970",
      "d4c6d7d80d285735590741117d33cfd5db166cda",
      "7980f3e22d9e2cf296bc5dd137f8f62154fd99ab",
      "bf8c3d1927dac3d7a48e1f904f9f339aaf5c9933",
      "ebd9b6fd312a713ffb41570852676df4db5437cd",
      "42ead3e6b01cc770446f00d07623954f3b1b8e72",
      "ae859ead5eb9cff9b573e1c24f8060c70683823e",
      "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
      "1a9fbcfba1eefb90b4f4d6544144a9cd8907b9cc",
      "fdecccfff052e74658a9e0b9d4aba77233089025",
      "e447980feb3a586dbe2204fcf085a84de64f3d0c",
      "a0471a785f94a11925580372279003f3fe6e8a13",
      "8adb4e4c611ec6f7f5b090322e6482d9f12e40f3",
      "81db733043026b97e23d04db195121ce3243723d",
      "352570503a5ab253da8d9b737bb2847a4fb84458",
      "5a314fef2dc7c248427598c1cf676352d437ed8e",
      "43022a600667d6d07f6485a5dd7686310bdbe44d",
      "58c180e135e148d1bdcb5968f24599917479da76",
      "a313fada5b56a92df7363a9b986f465bf1117955",
      "ee1d5dd613aa5e56eb99b56af64da62084b3625b",
      "151b93b014b069dfbecde7b1380c5ed4a2516019",
      "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
      "cd0e2b668e450a325fe18c020d6bda06d9dda82e",
      "cb0ef99c603c9dc1b7265c89b5e688945fec8d30",
      "a0b2d4d60d8e292bd2956bd8f1ca8cd967071d6e",
      "6e5179874104e97720c7e781d80b247f53eae6e1",
      "202743ceba73f6107991c915144d47787a2e95f5",
      "316f93594019aca3c3327d39b7a5ed0a2fb81a99",
      "ae815662f1d3f23f9f55cfdbd5bac862908dc354",
      "41d46579fe3c4320bbfdf91e76164cefd3e1d536",
      "159fa07eba89af0061f71f1e97f760904a8a4c4b",
      "486fec6a8bad27d05557b885cb821ac5023ec832",
      "779299a7b38cde0bc9169ed8253a87f67aad0762",
      "1f4bb562ee267a6ecd085e0df7ae877cd1cdcee6",
      "4bdf265bd0b62651ec10c55e5f6b3c5b2d0f2ae3",
      "facd00f3ec6c4e88d0231dabece2df401e22f58c",
      "0f58462443fd03362e4ee074ca3c702b6c26f5f5",
      "70bd1116689ea84a6be97b32360f516825050e34",
      "176311f29a736628bd45faa1a4895c660a6e370b",
      "c82e6e3ce7b86bbfaf1807c1721adf89fd8b8d4a",
      "3cb5c0e0ed6fe2ed610352910dfbf4cd88695b80",
      "eaad3b178507ccd49d1d0efecbf9fcb464a6ea71",
      "0333a70a715066f29e10edac911e39aeaa95242f",
      "8e5016adc5c5e1e7e2dd8fe3a8296ca9d8575937",
      "12928a19136bdacd6a91a6c247cc086cd34ed4b1",
      "a2af012a6caf99caba596bddced06d8eb9c8671f",
      "ca645cac1f759b13155f6776ab56e0e51cc36611",
      "599bb79e5afd3e1d1f37692315a7116384c70112",
      "46b97695ee330c575c0be9b90e38627e4b937859",
      "46b970666b5cc63d0ff8f8047724eea83ccf95da",
      "41f842ced14e06446dd17ac15f16626de4d623af",
      "98f502be2781356b14b543d1fa49021e40b2338d",
      "0b42f6568446bb0177bf497b448f5c5a416db683",
      "459e42e6c46749445a0b3c64a431a6d4d87413c1",
      "ab679a25a55f0ab9c1dc8de5758a1f637d057c75",
      "771eeb8a2fd73ae8eacf5ec320739358b026cec0",
      "c81b9aa5b3361d09ef3f4b89b3b19db7617d952c",
      "e50d7a6df2c150e78f8f66b8fa66149f7845e290",
      "f4609cc588a6387004b0b24cd93031fc7c30630f",
      "51e16b928586a7df3ed8ac63d88d9cdcecb57213",
      "4a024ef29cd5b56e6301c55f7f75feb3370e227f",
      "ad184e821e67c905bc7976025833b62f2691daa1",
      "f27961b45bfb220a929d923f764c80c48708893d",
      "5c5dcc6ae8ccc434aff2a9f42c2af05136d1ca2c",
      "4cf5e4a39f34f93f89242c1c235aa5611ce291cd",
      "36e8d124e08baefee388c9a99ec01d5afeabab2e",
      "0eafb421e68f843fd5ede92804ed795229df1db4",
      "d24b79f75035955a805be46bcb70f601354feb04",
      "3331de78127c8eee839478eec650e063190e4540",
      "9f9ff571427180598d138b94c7a1fd64c4d4ad8a",
      "f6d543ffd05aae4754e5e8d6411a43d810dc358f",
      "0c41c9b1b9162ab1ea61d544c86cdea1564ab513",
      "37bc2d4c3238d7df1e6953d35f9788f3777c5371",
      "d86be6ed69d05a14b087d150864033949518a37d",
      "d7e965e41860daff87665bb98d72a61a4278ec8c",
      "c556f447fd72de5683f9aaa7a155757f340e2707",
      "10a255474124ec26ec582ed3fe4183219071de2e",
      "8ff51b6f5388702765c6cb73d590ecce3fe2b53d",
      "09a72d8390d651ddddb3a86c51482a0842779da1",
      "341a75c1025ac08db60f82e2d4febf47bc4700ef",
      "4d8c9a492cc957bf94861d29935a88321ea9bb98",
      "4d2cb4beb8a3c237c394cd742adefab6aa7ddd66",
      "d9075536acffc7edacfb9dadc12c32a3ee9c9c02",
      "4ba5fbc57c7d3491b5aca548f2425b050768735b",
      "80a5b5af98ae65c37913c058356f9ca541d19b9f",
      "fa0367160b2838d49c9c4fc08c780e26e5f6efc1",
      "c809329d3f0050f8d97d8bcf1d619a23d15849ec",
      "dae49a2ce2d9df926ce08f3c30698dcd96abb198",
      "bc4b4acd9d83c97638ea23e7fe49764c535764fa",
      "5d9b0c591a564994b89e6e6b36fc9bc3b001ebb1",
      "389a5adf1cad6834d137983b47de426bab05ae3c",
      "8d58bce7aad4ea4e64dc7fe50e52b0d2a8ab1c9a",
      "ac0cb93e81104a68d103277cef3b41185228ed55",
      "bcf4dbf22395ae70ee80b0a55408dad4e4379e44",
      "179f256b4358720e6f15a21324fb6167905db0a6",
      "93cbc071ed065f98bc08add9709265e268fc55de",
      "fd32fb385afc36130175525733aade993f4cbb87",
      "b6fc6e66898f0b61fd0b07edc65e07c9070c5bcc",
      "8a5c853910f9cd364d86f07aa74f3f5b77e0e7ff",
      "2cc99b2e34587872cb19c2a6e0095991ca77b0c0",
      "5249f04b850bb9c1596031684956da8d01ae9369",
      "bb78d46e512336fa49e95db1b181d833ef7656f2",
      "d06ec6cafb3340ecd0a0ca7eaf27098efe1ec189",
      "05975469347682445913f84d010ebb9408718e31",
      "e5710b6ec92399c56e38439c6664792866533bfb",
      "2b5d5188d8e446bce587ef99a1d83641cc8ce040",
      "5ffe830060c19274d7c76e86ebaad229f56eaa72",
      "45be72db1469472de2a1ef8980c9332b9545eebd",
      "5bea568298e2945be0841483a8c0db7c7c77c74b",
      "a6b96d527dda307701508de05d359918b1df7fcb",
      "0311d843bb63449a9f1d942d2f4134783121e05c",
      "78d8932dacf7e0cce79c8cbe473ee646c3346261",
      "b2207f3b238910886e70d863fafd910d70d82317",
      "651f9dd03b10fdf869c8b7ce607fdb7f0aaa47bd",
      "98cbf941613df4bece0c2a8c0023af62143268c0",
      "aef61ea6de6c9aedfe579def29e19f882765f843",
      "7a0349a23efd8e95cac7e789586a6d85696c9748",
      "6d9d057fe263c60e592c4aa76136c02cddc1b9a9",
      "7d4796a69ea0637c6353e8317533c36f2c32d1c1",
      "8dec7b26d87b057a4ab5ff03734a6a238ce7222e",
      "7c5d0563806fbdf95354288c4b24f8058e8e00dd",
      "d7948b3cf99851ccb30cc43e8d598d404fe3b8cf",
      "a61bf5a9dcfe8b935da9db79ac1c6c20fe5df2f5",
      "7e0698307f0213c8ae155b9a859c709ba26f722f"
    ],
    "allRequestedVersionsResolved": false
  },
  "summary": {
    "population": 344,
    "classes": {
      "contains-markers": 229,
      "missing-markers": 109,
      "unknown": 6
    },
    "excludedMetadataRecords": {},
    "loadedVersions": 31,
    "resolvedVersions": 27
  },
  "hosts": [
    {
      "ownerId": "su-respawn-f21565b5b1fc1971c959c39ffb6c543b",
      "pid": 638697,
      "advSessionId": "36826",
      "startedAt": 1791702992353,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-respawn-f21565b5b1fc1971c959c39ffb6c543b.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-d8188220-b134-4f87-96fb-a9fb072879f0",
      "pid": 4089911,
      "advSessionId": "40573",
      "startedAt": 1791746481930,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-d8188220-b134-4f87-96fb-a9fb072879f0.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-ad62b0d6-4ed9-4075-bc9d-ca28ba758113",
      "pid": 476992,
      "advSessionId": "40620",
      "startedAt": 1791747051143,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ad62b0d6-4ed9-4075-bc9d-ca28ba758113.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "pid": 2800976,
      "advSessionId": "35907",
      "startedAt": 1791388687995,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "524654f5a899660fb07333f6e5b4a5fdd678d467598a8f0515f662dfed077f44",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4.json",
      "source": {
        "sha": "ee1d5dd613aa5e56eb99b56af64da62084b3625b",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-a158802d-7e66-48eb-8ea3-a79e78ea0d2e",
      "pid": 1231016,
      "advSessionId": "38843",
      "startedAt": 1791761721636,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-a158802d-7e66-48eb-8ea3-a79e78ea0d2e.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-9601a23a-feac-4c89-9a05-6a6dbdb656d2",
      "pid": 2584811,
      "advSessionId": "41392",
      "startedAt": 1791800918002,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-9601a23a-feac-4c89-9a05-6a6dbdb656d2.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-9413c49b-4718-4a94-9493-52967c939afa",
      "pid": 2119607,
      "advSessionId": "41037",
      "startedAt": 1791776279119,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-9413c49b-4718-4a94-9493-52967c939afa.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-37ffa216-14c7-4113-9981-b9b358da4155",
      "pid": 3450022,
      "advSessionId": "37248",
      "startedAt": 1791422296463,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "48a1c5bf8398955b333feeeaf20881b81336d3b2e4482737181d2b66060d118b",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-37ffa216-14c7-4113-9981-b9b358da4155.json",
      "source": null,
      "structuralContainment": "unknown",
      "missingMarkers": null
    },
    {
      "ownerId": "su-c4dc38e8-5f3c-48fc-a4ad-3efd0ad46078",
      "pid": 2350303,
      "advSessionId": "39417",
      "startedAt": 1791704649837,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-c4dc38e8-5f3c-48fc-a4ad-3efd0ad46078.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-b05c673a-8351-4a6f-9df0-5df804d5cbbb",
      "pid": 4129000,
      "advSessionId": "39861",
      "startedAt": 1791702320218,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b05c673a-8351-4a6f-9df0-5df804d5cbbb.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-34da51e7-7680-42c8-af82-5f6c30965f52",
      "pid": 3020366,
      "advSessionId": "41115",
      "startedAt": 1791768329821,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-34da51e7-7680-42c8-af82-5f6c30965f52.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-93d354ef-cf31-47cd-8692-3d8cc7645c57",
      "pid": 2546144,
      "advSessionId": "40578",
      "startedAt": 1791753867417,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-93d354ef-cf31-47cd-8692-3d8cc7645c57.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-b3793963-b16c-45ae-9f37-9dd40956b183",
      "pid": 1745929,
      "advSessionId": "39928",
      "startedAt": 1791670888460,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b3793963-b16c-45ae-9f37-9dd40956b183.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-dc71435e-c08b-4c9b-ac9c-4451c66e2740",
      "pid": 938494,
      "advSessionId": "41423",
      "startedAt": 1791794185187,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-dc71435e-c08b-4c9b-ac9c-4451c66e2740.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-29018994-8946-41ea-bd40-a8fb40c5872a",
      "pid": 1727578,
      "advSessionId": "38414",
      "startedAt": 1791666238073,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-29018994-8946-41ea-bd40-a8fb40c5872a.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-23d26824-25a2-4979-9b57-a86ba389c2ca",
      "pid": 2152633,
      "advSessionId": "37402",
      "startedAt": 1791431665450,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "296ef73ed870b1664ddcc93fc90dbf26a958c826b5f2de8d4be9946df569b6f0",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-23d26824-25a2-4979-9b57-a86ba389c2ca.json",
      "source": {
        "sha": "8adb4e4c611ec6f7f5b090322e6482d9f12e40f3",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
      "pid": 3112961,
      "advSessionId": "34358",
      "startedAt": 1791701311471,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "b2ec35f132861d5f6b2dbb51353b78bc43f19cf6a8563e3578d1114d242527bc",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-fc5749a7-6632-4f73-9c99-8b475641e7e2.json",
      "source": {
        "sha": "e33dc0862eba85df86cfa77cfd88e4c3d9f15d6f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-bdcd315c-af8a-4bfc-9e52-d73604f24ae2",
      "pid": 3789786,
      "advSessionId": "38889",
      "startedAt": 1791686263652,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "4539e0526194d544367041278f5c96c89814619cb462fe47a865501f29f3d1a2",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-bdcd315c-af8a-4bfc-9e52-d73604f24ae2.json",
      "source": {
        "sha": "459247f5eaa7fcf24b4d1eb82d8488fde5b1e475",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-a698e96f-de73-496b-9fdd-6647e77aaa77",
      "pid": 4036134,
      "advSessionId": "40528",
      "startedAt": 1791746426598,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-a698e96f-de73-496b-9fdd-6647e77aaa77.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-bb8e4c0e-215c-4757-846e-7d92124182c6",
      "pid": 2512627,
      "advSessionId": "40902",
      "startedAt": 1791758355973,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-bb8e4c0e-215c-4757-846e-7d92124182c6.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-8c402b7a-2154-4f5a-bf3b-abf3d638e8f4",
      "pid": 2648156,
      "advSessionId": "41402",
      "startedAt": 1791790892344,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-8c402b7a-2154-4f5a-bf3b-abf3d638e8f4.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-4ba8586b-3859-4ecf-a094-ba5d9f5e7bfd",
      "pid": 3053843,
      "advSessionId": "36760",
      "startedAt": 1791421847887,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "1984a0730c29581b64f953da9dae8a3ef3edc3015c9081eee12310513053678b",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-4ba8586b-3859-4ecf-a094-ba5d9f5e7bfd.json",
      "source": {
        "sha": "352570503a5ab253da8d9b737bb2847a4fb84458",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-5e83d3a1-d532-4d91-aff2-07ee3d4e8bde",
      "pid": 2026328,
      "advSessionId": "41532",
      "startedAt": 1791805842875,
      "bridgeTty": false,
      "launchedBy": "su-f304a906-0da5-4f8f-a362-6f3d0b43f515",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5e83d3a1-d532-4d91-aff2-07ee3d4e8bde.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-16da39cf-6e87-45f1-9c6f-7fa8915f021d",
      "pid": 3516490,
      "advSessionId": "35889",
      "startedAt": 1791759330999,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-16da39cf-6e87-45f1-9c6f-7fa8915f021d.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-5e86e622-0a42-4e11-9cb5-b44e36856641",
      "pid": 3054549,
      "advSessionId": "37568",
      "startedAt": 1791447473438,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "f36b6cfd8881c2830d88b7dc6d2a56d93fe145efcde4227018529c588a8633cf",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5e86e622-0a42-4e11-9cb5-b44e36856641.json",
      "source": {
        "sha": "a0471a785f94a11925580372279003f3fe6e8a13",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-fbce18bf-ab91-435d-b28b-fe11815ad7da",
      "pid": 3895100,
      "advSessionId": "36967",
      "startedAt": 1791405310497,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "64e32653bce24d6f983a8fd578dd37d118725b5c5e8e57cab40db0b1a09b9988",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-fbce18bf-ab91-435d-b28b-fe11815ad7da.json",
      "source": {
        "sha": "58c180e135e148d1bdcb5968f24599917479da76",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-d66bcdf7-a0e2-46d9-98d0-a2d202bbff54",
      "pid": 688879,
      "advSessionId": "41421",
      "startedAt": 1791793775306,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-d66bcdf7-a0e2-46d9-98d0-a2d202bbff54.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-14d6b6ef-6549-4c3f-bf9f-0e86a0e96f00",
      "pid": 190682,
      "advSessionId": "38983",
      "startedAt": 1791573968629,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c20509434020e2e0530152f4993186b275f65cbb3c3bb2f324e9b4c6e43650dc",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-14d6b6ef-6549-4c3f-bf9f-0e86a0e96f00.json",
      "source": {
        "sha": "7980f3e22d9e2cf296bc5dd137f8f62154fd99ab",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-67c067a4-a97b-41ee-82ca-06b9be615327",
      "pid": 3408792,
      "advSessionId": "36946",
      "startedAt": 1791409956644,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "225756ed51ef1276cd37b79650eb36525e2ade30cfb93a529d63e3f9cf057174",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-67c067a4-a97b-41ee-82ca-06b9be615327.json",
      "source": {
        "sha": "5a314fef2dc7c248427598c1cf676352d437ed8e",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-5213d167-ded8-4d16-a35f-85bcef46043c",
      "pid": 870420,
      "advSessionId": "39980",
      "startedAt": 1791703210225,
      "bridgeTty": false,
      "launchedBy": "su-d70c727a-b61a-4db3-bbe1-ce888c65a9d5",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5213d167-ded8-4d16-a35f-85bcef46043c.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2db1aff6-9907-4827-9fc9-1653f97bbf59",
      "pid": 676930,
      "advSessionId": "40622",
      "startedAt": 1791747262472,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2db1aff6-9907-4827-9fc9-1653f97bbf59.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-23094032-f9f4-42ff-9a74-00ce54a6750f",
      "pid": 205529,
      "advSessionId": "40600",
      "startedAt": 1791746779905,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-23094032-f9f4-42ff-9a74-00ce54a6750f.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-55477ace-a09e-4e12-80fe-49d7b61118fb",
      "pid": 3692225,
      "advSessionId": "40990",
      "startedAt": 1791759573166,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-55477ace-a09e-4e12-80fe-49d7b61118fb.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-df819fc7-5ed1-4615-b1c6-495f5501e933",
      "pid": 3367836,
      "advSessionId": "39555",
      "startedAt": 1791693643324,
      "bridgeTty": false,
      "launchedBy": "su-98a6938f-2663-4635-bf6b-9fd7539d66ac",
      "hostCodeVersion": "51f480ce0acfde337ce12d1acd24e064d8d95ac708e2a21d37d261a5fdfe083a",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-df819fc7-5ed1-4615-b1c6-495f5501e933.json",
      "source": {
        "sha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-fb039bc3-0e88-4c5b-95bd-70f1afc385fd",
      "pid": 3969376,
      "advSessionId": "40597",
      "startedAt": 1791746388406,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-fb039bc3-0e88-4c5b-95bd-70f1afc385fd.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-1ad13eab-f9a8-407f-9aba-ccbb1713c460",
      "pid": 658971,
      "advSessionId": "40995",
      "startedAt": 1791774698953,
      "bridgeTty": false,
      "launchedBy": "su-8df00c9a-c33a-4292-a81c-7a2bc6e0d307",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-1ad13eab-f9a8-407f-9aba-ccbb1713c460.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-21ed614f-c198-4505-a828-2bf17ee03b99",
      "pid": 2631439,
      "advSessionId": "41023",
      "startedAt": 1791800977635,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-21ed614f-c198-4505-a828-2bf17ee03b99.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-56b83dff-25c8-4a9b-bacf-5c549c832931",
      "pid": 2508899,
      "advSessionId": "36026",
      "startedAt": 1791338523115,
      "bridgeTty": false,
      "launchedBy": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "hostCodeVersion": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-56b83dff-25c8-4a9b-bacf-5c549c832931.json",
      "source": {
        "sha": "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-7ca9a10b-e494-4e71-b3d5-723e257a77d1",
      "pid": 809060,
      "advSessionId": "41380",
      "startedAt": 1791789082379,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-7ca9a10b-e494-4e71-b3d5-723e257a77d1.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-b11f76ed-5823-4fe4-a597-1ebc5c3a441e",
      "pid": 3945631,
      "advSessionId": "35912",
      "startedAt": 1791345952122,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "6dcfa3540d8f1c411de4c1ba30d0af265b0a40b7ea2b82a894089822ddf7103f",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b11f76ed-5823-4fe4-a597-1ebc5c3a441e.json",
      "source": {
        "sha": "151b93b014b069dfbecde7b1380c5ed4a2516019",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-c350e979-5692-4c8f-88b1-b95c613e3774",
      "pid": 2714344,
      "advSessionId": "39987",
      "startedAt": 1791748974128,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-c350e979-5692-4c8f-88b1-b95c613e3774.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-respawn-78a1739f77e4338214bd25b427cca743",
      "pid": 141877,
      "advSessionId": "40630",
      "startedAt": 1791746723712,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-respawn-78a1739f77e4338214bd25b427cca743.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-e6e38587-6da4-4e14-9878-9550d762aa9b",
      "pid": 2413849,
      "advSessionId": "37319",
      "startedAt": 1791426284179,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "296ef73ed870b1664ddcc93fc90dbf26a958c826b5f2de8d4be9946df569b6f0",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e6e38587-6da4-4e14-9878-9550d762aa9b.json",
      "source": {
        "sha": "8adb4e4c611ec6f7f5b090322e6482d9f12e40f3",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-effcdd3a-2b7d-4780-abee-71d162ea06ed",
      "pid": 642432,
      "advSessionId": "41525",
      "startedAt": 1791804021788,
      "bridgeTty": false,
      "launchedBy": "su-f304a906-0da5-4f8f-a362-6f3d0b43f515",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-effcdd3a-2b7d-4780-abee-71d162ea06ed.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-00a3aeea-4a8d-443a-802f-6012f82cfba5",
      "pid": 577290,
      "advSessionId": "41038",
      "startedAt": 1791765570236,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-00a3aeea-4a8d-443a-802f-6012f82cfba5.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-0c6bb2a8-8655-44ea-962c-f6aa2886ae29",
      "pid": 2026179,
      "advSessionId": "41531",
      "startedAt": 1791805842875,
      "bridgeTty": false,
      "launchedBy": "su-f304a906-0da5-4f8f-a362-6f3d0b43f515",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0c6bb2a8-8655-44ea-962c-f6aa2886ae29.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-5d6e108e-cac3-4a1c-97ea-f48b6245638f",
      "pid": 3088365,
      "advSessionId": "38232",
      "startedAt": 1791492132005,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "903fb833e9459bfa7d7189a3f60fd35e61493ffedc8a3ea1e9ebe20e0bcc2586",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5d6e108e-cac3-4a1c-97ea-f48b6245638f.json",
      "source": {
        "sha": "fdecccfff052e74658a9e0b9d4aba77233089025",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-afae8d83-ba6e-4b12-b0d6-bdc2abe9da04",
      "pid": 3168440,
      "advSessionId": "41542",
      "startedAt": 1791807461896,
      "bridgeTty": false,
      "launchedBy": "attention-bulk-resolve",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-afae8d83-ba6e-4b12-b0d6-bdc2abe9da04.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-70c554c7-11e6-4f95-908e-cf37c23031de",
      "pid": 1744604,
      "advSessionId": "39927",
      "startedAt": 1791670882773,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-70c554c7-11e6-4f95-908e-cf37c23031de.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-65894147-7f89-44b7-bcf6-a2a234b19183",
      "pid": 1715040,
      "advSessionId": "41248",
      "startedAt": 1791775880550,
      "bridgeTty": false,
      "launchedBy": "su-2437f7dc-2ed4-4777-a623-a10101e8a0a1",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-65894147-7f89-44b7-bcf6-a2a234b19183.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-5d6ff64b-a9ee-4b18-8e73-02dfd939a96c",
      "pid": 3456261,
      "advSessionId": "40755",
      "startedAt": 1791754756339,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "55f6e623302f359544407143766a9a7357229c9aa64d6240d70b291222ab6418",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5d6ff64b-a9ee-4b18-8e73-02dfd939a96c.json",
      "source": null,
      "structuralContainment": "unknown",
      "missingMarkers": null
    },
    {
      "ownerId": "su-2a7e6d3d-2b60-4531-b48f-7f036b0b9394",
      "pid": 2169562,
      "advSessionId": "37923",
      "startedAt": 1791471759662,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "4c27f2ae2056236d8d44db782a9f034e39d56dd66e032aaf34607322aa253165",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2a7e6d3d-2b60-4531-b48f-7f036b0b9394.json",
      "source": {
        "sha": "e447980feb3a586dbe2204fcf085a84de64f3d0c",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-8df00c9a-c33a-4292-a81c-7a2bc6e0d307",
      "pid": 1653049,
      "advSessionId": "40742",
      "startedAt": 1791752865907,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-8df00c9a-c33a-4292-a81c-7a2bc6e0d307.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-65ef62e6-5162-4cd5-88d1-4938af5a1ff8",
      "pid": 2622888,
      "advSessionId": "40858",
      "startedAt": 1791800967266,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-65ef62e6-5162-4cd5-88d1-4938af5a1ff8.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-7e536655-4ffb-4290-a909-ea558b03a11c",
      "pid": 2871072,
      "advSessionId": "40886",
      "startedAt": 1791801317939,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-7e536655-4ffb-4290-a909-ea558b03a11c.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-3ac9b509-ef91-4398-b27e-96f8886f551e",
      "pid": 854019,
      "advSessionId": "41236",
      "startedAt": 1791774901966,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3ac9b509-ef91-4398-b27e-96f8886f551e.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-f146f0a3-5ec9-4b19-bac2-b1903f1f6cb1",
      "pid": 1862231,
      "advSessionId": "39713",
      "startedAt": 1791667343103,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-f146f0a3-5ec9-4b19-bac2-b1903f1f6cb1.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-5d7f0557-c107-43f6-8f1e-d9dcd9ed242a",
      "pid": 2105611,
      "advSessionId": "41426",
      "startedAt": 1791800258552,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5d7f0557-c107-43f6-8f1e-d9dcd9ed242a.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-7d56cc93-2252-4713-a25c-9b32eab1205d",
      "pid": 183350,
      "advSessionId": "39846",
      "startedAt": 1791702549513,
      "bridgeTty": false,
      "launchedBy": "su-98a6938f-2663-4635-bf6b-9fd7539d66ac",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-7d56cc93-2252-4713-a25c-9b32eab1205d.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-c9cbdca9-7cd0-4b58-a69c-7645de562968",
      "pid": 3164068,
      "advSessionId": "36187",
      "startedAt": 1791705511521,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-c9cbdca9-7cd0-4b58-a69c-7645de562968.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-respawn-302388a21ed7ab77379045848faa0690",
      "pid": 1411209,
      "advSessionId": "39860",
      "startedAt": 1791728076203,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-respawn-302388a21ed7ab77379045848faa0690.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
      "pid": 4054864,
      "advSessionId": "35952",
      "startedAt": 1791702250285,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-298f8b56-c687-404f-99e1-d1c1e53baf0c.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-f2506a91-f6cb-470d-ad87-f9a565f6810e",
      "pid": 466146,
      "advSessionId": "38313",
      "startedAt": 1791498181645,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "471e7e691e3cfc548d42fd3cdc6ac346ec06f7d39f24123bc15e31a57017e682",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-f2506a91-f6cb-470d-ad87-f9a565f6810e.json",
      "source": null,
      "structuralContainment": "unknown",
      "missingMarkers": null
    },
    {
      "ownerId": "su-d14d0d3e-762b-4661-a73b-473c8cfdb422",
      "pid": 2550154,
      "advSessionId": "40884",
      "startedAt": 1791758331205,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-d14d0d3e-762b-4661-a73b-473c8cfdb422.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-6e3cb6d4-4014-41ae-81ce-6305bc7d6a41",
      "pid": 1649740,
      "advSessionId": "36966",
      "startedAt": 1791703872435,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-6e3cb6d4-4014-41ae-81ce-6305bc7d6a41.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-69403999-e083-44a6-8f56-9be697581443",
      "pid": 266419,
      "advSessionId": "40721",
      "startedAt": 1791746836201,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-69403999-e083-44a6-8f56-9be697581443.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-a90e126b-38f3-48e1-b68d-96c49b44facc",
      "pid": 397863,
      "advSessionId": "40587",
      "startedAt": 1791746976135,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-a90e126b-38f3-48e1-b68d-96c49b44facc.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "pid": 3656209,
      "advSessionId": "39824",
      "startedAt": 1791701843576,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-3076fbb3-6b65-443d-9460-1c60b3df77b6",
      "pid": 2258174,
      "advSessionId": "38128",
      "startedAt": 1791708939490,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3076fbb3-6b65-443d-9460-1c60b3df77b6.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-98a6938f-2663-4635-bf6b-9fd7539d66ac",
      "pid": 1084965,
      "advSessionId": "39785",
      "startedAt": 1791703389706,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-98a6938f-2663-4635-bf6b-9fd7539d66ac.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-370a4d53-f815-47ea-b921-3e4fd79ad9eb",
      "pid": 4120256,
      "advSessionId": "36201",
      "startedAt": 1791340564685,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-370a4d53-f815-47ea-b921-3e4fd79ad9eb.json",
      "source": {
        "sha": "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-8bb692f4-7294-4741-b0f9-379ff0022b48",
      "pid": 2390797,
      "advSessionId": "40249",
      "startedAt": 1791741018653,
      "bridgeTty": false,
      "launchedBy": "su-98a6938f-2663-4635-bf6b-9fd7539d66ac",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-8bb692f4-7294-4741-b0f9-379ff0022b48.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-f703c73f-3eaf-4333-8a60-38928a6a90ec",
      "pid": 4086749,
      "advSessionId": "40247",
      "startedAt": 1791746479166,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-f703c73f-3eaf-4333-8a60-38928a6a90ec.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "pid": 108448,
      "advSessionId": "39941",
      "startedAt": 1791746697579,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-32b95ef6-169a-43ae-a8a5-e367fbc40b2b",
      "pid": 2396355,
      "advSessionId": "35839",
      "startedAt": 1791421001119,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "225756ed51ef1276cd37b79650eb36525e2ade30cfb93a529d63e3f9cf057174",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-32b95ef6-169a-43ae-a8a5-e367fbc40b2b.json",
      "source": {
        "sha": "5a314fef2dc7c248427598c1cf676352d437ed8e",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-ec5efb56-8a98-4efe-a8e2-02017ee78bb8",
      "pid": 2621424,
      "advSessionId": "38268",
      "startedAt": 1791667186924,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ec5efb56-8a98-4efe-a8e2-02017ee78bb8.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-ccb5f763-b2e2-49e1-8b7f-49d2aa450ddb",
      "pid": 73548,
      "advSessionId": "40244",
      "startedAt": 1791783243820,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ccb5f763-b2e2-49e1-8b7f-49d2aa450ddb.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-08664d7f-dbcc-4e78-b2db-f9978e6076e8",
      "pid": 2793709,
      "advSessionId": "37235",
      "startedAt": 1791421519240,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "1984a0730c29581b64f953da9dae8a3ef3edc3015c9081eee12310513053678b",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-08664d7f-dbcc-4e78-b2db-f9978e6076e8.json",
      "source": {
        "sha": "352570503a5ab253da8d9b737bb2847a4fb84458",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-e9e81a50-2c36-4231-a340-43ebca1804aa",
      "pid": 1841820,
      "advSessionId": null,
      "startedAt": 1791553866728,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e9e81a50-2c36-4231-a340-43ebca1804aa.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-dfaf53ff-72f1-4b1c-a71a-89397eb97c2d",
      "pid": 2130531,
      "advSessionId": "41481",
      "startedAt": 1791800302885,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-dfaf53ff-72f1-4b1c-a71a-89397eb97c2d.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-b36b4692-520c-4a71-ae87-d0399bd81c9e",
      "pid": 2893977,
      "advSessionId": "37243",
      "startedAt": 1791667506543,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b36b4692-520c-4a71-ae87-d0399bd81c9e.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-3a3a10c1-d7b8-46cd-80cd-c24ad2c0bcd9",
      "pid": 1845686,
      "advSessionId": "40753",
      "startedAt": 1791753016096,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3a3a10c1-d7b8-46cd-80cd-c24ad2c0bcd9.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-d47c2183-0631-49fa-b814-a95f2c94ea3d",
      "pid": 2581757,
      "advSessionId": "39823",
      "startedAt": 1791700908344,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "b2ec35f132861d5f6b2dbb51353b78bc43f19cf6a8563e3578d1114d242527bc",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-d47c2183-0631-49fa-b814-a95f2c94ea3d.json",
      "source": {
        "sha": "e33dc0862eba85df86cfa77cfd88e4c3d9f15d6f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-55769027-ea65-49d0-a287-7d16b4b38627",
      "pid": 2761537,
      "advSessionId": "36676",
      "startedAt": 1791421450422,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "1984a0730c29581b64f953da9dae8a3ef3edc3015c9081eee12310513053678b",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-55769027-ea65-49d0-a287-7d16b4b38627.json",
      "source": {
        "sha": "352570503a5ab253da8d9b737bb2847a4fb84458",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-5850ab54-7fe5-4f6d-be53-c6da7f446aae",
      "pid": 2138654,
      "advSessionId": "41274",
      "startedAt": 1791800317567,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5850ab54-7fe5-4f6d-be53-c6da7f446aae.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
      "pid": 2794517,
      "advSessionId": "37332",
      "startedAt": 1791426799385,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "296ef73ed870b1664ddcc93fc90dbf26a958c826b5f2de8d4be9946df569b6f0",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c.json",
      "source": {
        "sha": "8adb4e4c611ec6f7f5b090322e6482d9f12e40f3",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "pid": 242977,
      "advSessionId": "40242",
      "startedAt": 1791746818241,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ab8cc07f-e903-4467-ac45-a32149258170.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
      "pid": 1661020,
      "advSessionId": "40770",
      "startedAt": 1791752869374,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-424d5476-0b13-401a-a926-0aaa9f212391.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-592ef0c5-b0ed-47d6-ad26-a089169482a7",
      "pid": 3279445,
      "advSessionId": "38969",
      "startedAt": 1791572802019,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "99ca3eb4e5dbc6ab535634a76d8c3d62f42200cf5cbe22582e0c9c5b57f19b24",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-592ef0c5-b0ed-47d6-ad26-a089169482a7.json",
      "source": null,
      "structuralContainment": "unknown",
      "missingMarkers": null
    },
    {
      "ownerId": "su-357e43d6-080a-4a92-a347-c14d82a4232d",
      "pid": 1046994,
      "advSessionId": null,
      "startedAt": 1791557978880,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-357e43d6-080a-4a92-a347-c14d82a4232d.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-d8130961-3272-4a5f-8f4c-a7f8d337b333",
      "pid": 2426859,
      "advSessionId": "38890",
      "startedAt": 1791666862966,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-d8130961-3272-4a5f-8f4c-a7f8d337b333.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-980903a5-6d2a-41c9-8bb6-cb541b2e919f",
      "pid": 2875042,
      "advSessionId": "40827",
      "startedAt": 1791801322106,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-980903a5-6d2a-41c9-8bb6-cb541b2e919f.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-9e686abe-13e1-4ad0-ba6f-9c92a01e22f2",
      "pid": 2111157,
      "advSessionId": "41187",
      "startedAt": 1791800267480,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-9e686abe-13e1-4ad0-ba6f-9c92a01e22f2.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-faee16ea-3b47-454a-ae48-f949b51c6d8d",
      "pid": 2209834,
      "advSessionId": "38984",
      "startedAt": 1791666567572,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-faee16ea-3b47-454a-ae48-f949b51c6d8d.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-b9896e0c-d92d-4333-9ee6-370b6911aad4",
      "pid": 891110,
      "advSessionId": "39080",
      "startedAt": 1791658617809,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b9896e0c-d92d-4333-9ee6-370b6911aad4.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-ee96d6e7-0474-48be-9d85-70cbb9d63d32",
      "pid": 3727592,
      "advSessionId": "39665",
      "startedAt": 1791635199711,
      "bridgeTty": false,
      "launchedBy": "su-4d390264-fc3c-4875-a655-a71b0afcd6ef",
      "hostCodeVersion": "1adf3ebf979c30788f760dae4dcf374e1e3ebc43ff5a22c13bfe41df75d8c68e",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ee96d6e7-0474-48be-9d85-70cbb9d63d32.json",
      "source": {
        "sha": "35e297ce5978608f904bedc64222eb88e7d3d262",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-ef6886ef-be73-4be0-93c7-1b21aedcd73f",
      "pid": 1339610,
      "advSessionId": "40248",
      "startedAt": 1791703626232,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ef6886ef-be73-4be0-93c7-1b21aedcd73f.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-3790bff3-9f96-445b-a6f5-bddc36f217bf",
      "pid": 3500303,
      "advSessionId": "35931",
      "startedAt": 1791701676718,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3790bff3-9f96-445b-a6f5-bddc36f217bf.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2342c61e-5b1d-4f29-9016-d0692cc241ae",
      "pid": 1561486,
      "advSessionId": "36888",
      "startedAt": 1791450596643,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "f36b6cfd8881c2830d88b7dc6d2a56d93fe145efcde4227018529c588a8633cf",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2342c61e-5b1d-4f29-9016-d0692cc241ae.json",
      "source": {
        "sha": "a0471a785f94a11925580372279003f3fe6e8a13",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-5541a53f-2723-4a0c-88a6-dd9191ffbd2a",
      "pid": 2698556,
      "advSessionId": "38902",
      "startedAt": 1791566520454,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "d782deff3a86ed1acc6a813953c5d5035fb336a07d712b784702d2d8f22b49eb",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5541a53f-2723-4a0c-88a6-dd9191ffbd2a.json",
      "source": {
        "sha": "ae859ead5eb9cff9b573e1c24f8060c70683823e",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-762b9af2-3f26-4bd1-9789-779e20f1662c",
      "pid": 1427379,
      "advSessionId": "38796",
      "startedAt": 1791683620081,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "4539e0526194d544367041278f5c96c89814619cb462fe47a865501f29f3d1a2",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-762b9af2-3f26-4bd1-9789-779e20f1662c.json",
      "source": {
        "sha": "459247f5eaa7fcf24b4d1eb82d8488fde5b1e475",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-32c78573-727f-415f-a3f9-4bf96246b9d1",
      "pid": 874492,
      "advSessionId": "38239",
      "startedAt": 1791695206652,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "51f480ce0acfde337ce12d1acd24e064d8d95ac708e2a21d37d261a5fdfe083a",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-32c78573-727f-415f-a3f9-4bf96246b9d1.json",
      "source": {
        "sha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-0d52d810-afcc-4f52-8863-4a92600f9485",
      "pid": 891922,
      "advSessionId": "39377",
      "startedAt": 1791594956947,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "772a859a542b1990798cbb9e3f4bd2d069531156226fe4b0a5c51733e0f6a11c",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0d52d810-afcc-4f52-8863-4a92600f9485.json",
      "source": {
        "sha": "405947bc4cfff1ed3b721daa4af027d64d71e970",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-25cbe9c5-330e-480b-8946-340ade7e9d0e",
      "pid": 853920,
      "advSessionId": "41235",
      "startedAt": 1791774901940,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-25cbe9c5-330e-480b-8946-340ade7e9d0e.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-f034f09e-b8d6-4878-9d35-0d2b0cceabe7",
      "pid": 3049541,
      "advSessionId": "40897",
      "startedAt": 1791801602548,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-f034f09e-b8d6-4878-9d35-0d2b0cceabe7.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-70bd7b0b-bd59-4ea3-8288-fbe76edb24cb",
      "pid": 2245020,
      "advSessionId": "37225",
      "startedAt": 1791692549544,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "29add5e7cf1049c8d9022e8e59304e909427eb30ee21d5cd856464c5402d5410",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-70bd7b0b-bd59-4ea3-8288-fbe76edb24cb.json",
      "source": {
        "sha": "d4dc3833b5883fb7930999b3ce6c5f872becd921",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-51edba27-5372-4c49-8a17-af2ede9bb198",
      "pid": 3622916,
      "advSessionId": "38978",
      "startedAt": 1791592969828,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "772a859a542b1990798cbb9e3f4bd2d069531156226fe4b0a5c51733e0f6a11c",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-51edba27-5372-4c49-8a17-af2ede9bb198.json",
      "source": {
        "sha": "405947bc4cfff1ed3b721daa4af027d64d71e970",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-70531ddd-3eed-4530-8e41-1aa7d47c7791",
      "pid": 1819252,
      "advSessionId": "39926",
      "startedAt": 1791679502308,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "4539e0526194d544367041278f5c96c89814619cb462fe47a865501f29f3d1a2",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-70531ddd-3eed-4530-8e41-1aa7d47c7791.json",
      "source": {
        "sha": "459247f5eaa7fcf24b4d1eb82d8488fde5b1e475",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-26943f5d-c097-42e4-913a-f2ea7b2fca4a",
      "pid": 1482219,
      "advSessionId": "38410",
      "startedAt": 1791665763893,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-26943f5d-c097-42e4-913a-f2ea7b2fca4a.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-b83c1f62-d5f3-49a7-b59d-e38fa0ecf97d",
      "pid": 3976673,
      "advSessionId": "36973",
      "startedAt": 1791702161799,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b83c1f62-d5f3-49a7-b59d-e38fa0ecf97d.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-52e7fcab-ab2d-48c3-8e3e-9cd78738619c",
      "pid": 2705233,
      "advSessionId": "39776",
      "startedAt": 1791801065866,
      "bridgeTty": false,
      "launchedBy": "su-98a6938f-2663-4635-bf6b-9fd7539d66ac",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-52e7fcab-ab2d-48c3-8e3e-9cd78738619c.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-25bc0450-2829-42b9-a2dd-1431c99e4ba8",
      "pid": 3872762,
      "advSessionId": "40610",
      "startedAt": 1791746285571,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-25bc0450-2829-42b9-a2dd-1431c99e4ba8.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-6e85a865-632a-4ae9-acae-b7d2fa30f451",
      "pid": 1125030,
      "advSessionId": "40221",
      "startedAt": 1791695397220,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "51f480ce0acfde337ce12d1acd24e064d8d95ac708e2a21d37d261a5fdfe083a",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-6e85a865-632a-4ae9-acae-b7d2fa30f451.json",
      "source": {
        "sha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-11966f3b-89a0-4911-bc90-9d0a941435c8",
      "pid": 1058044,
      "advSessionId": "41293",
      "startedAt": 1791779711492,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-11966f3b-89a0-4911-bc90-9d0a941435c8.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-ac4f14a4-6c8b-45da-821b-73196391b494",
      "pid": 464984,
      "advSessionId": "38790",
      "startedAt": 1791551775089,
      "bridgeTty": true,
      "launchedBy": "su-c7a48b7b-f8fd-4215-aa09-5fe6bebc007c",
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ac4f14a4-6c8b-45da-821b-73196391b494.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-34e04dbe-24fc-4579-a522-1610ae9761f7",
      "pid": 2984305,
      "advSessionId": "36747",
      "startedAt": 1791421760209,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "1984a0730c29581b64f953da9dae8a3ef3edc3015c9081eee12310513053678b",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-34e04dbe-24fc-4579-a522-1610ae9761f7.json",
      "source": {
        "sha": "352570503a5ab253da8d9b737bb2847a4fb84458",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-2df29f65-8444-4804-b246-f8840cef8fd9",
      "pid": 1936485,
      "advSessionId": "40744",
      "startedAt": 1791753118843,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2df29f65-8444-4804-b246-f8840cef8fd9.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-b46a52db-f746-426b-8265-6df2b2918cd5",
      "pid": 1202501,
      "advSessionId": "41424",
      "startedAt": 1791794616432,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b46a52db-f746-426b-8265-6df2b2918cd5.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-833bc5dc-7541-4e8e-bb15-eeb4e74ee7aa",
      "pid": 600803,
      "advSessionId": "39724",
      "startedAt": 1791647870905,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "266153483ae8ad37b4bdb78398fffb6678a84444f48d7bf76dd90f15cd4530d7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-833bc5dc-7541-4e8e-bb15-eeb4e74ee7aa.json",
      "source": {
        "sha": "ad32e4f6515b864a1dec31e8e8e2544595edaac8",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-27e14668-dfa0-465d-8648-97bf8a991256",
      "pid": 61142,
      "advSessionId": "40475",
      "startedAt": 1791746653317,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-27e14668-dfa0-465d-8648-97bf8a991256.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-b53bc730-cf97-42c1-804a-906e355053c2",
      "pid": 3961434,
      "advSessionId": "38777",
      "startedAt": 1791550733594,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b53bc730-cf97-42c1-804a-906e355053c2.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-43e4b8b3-2e82-4155-bef7-e84be403fa2e",
      "pid": 2140385,
      "advSessionId": "39866",
      "startedAt": 1791704450895,
      "bridgeTty": false,
      "launchedBy": "su-98a6938f-2663-4635-bf6b-9fd7539d66ac",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-43e4b8b3-2e82-4155-bef7-e84be403fa2e.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-23056286-57d9-4557-a992-d68a3779f662",
      "pid": 3685277,
      "advSessionId": "40168",
      "startedAt": 1791701867816,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-23056286-57d9-4557-a992-d68a3779f662.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-98e61f58-9674-4d6a-88fd-b9cd6194fc9b",
      "pid": 3761528,
      "advSessionId": "38240",
      "startedAt": 1791492755543,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "903fb833e9459bfa7d7189a3f60fd35e61493ffedc8a3ea1e9ebe20e0bcc2586",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-98e61f58-9674-4d6a-88fd-b9cd6194fc9b.json",
      "source": {
        "sha": "fdecccfff052e74658a9e0b9d4aba77233089025",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-716c6232-a17a-40b1-9499-42d59b87daee",
      "pid": 1678179,
      "advSessionId": "41246",
      "startedAt": 1791775843226,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-716c6232-a17a-40b1-9499-42d59b87daee.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-cdc9a540-470a-4660-bffc-f0d3cfd0b4c4",
      "pid": 713322,
      "advSessionId": "38794",
      "startedAt": 1791552294499,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-cdc9a540-470a-4660-bffc-f0d3cfd0b4c4.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-c13b8b58-9648-40e3-bbdd-86acc762bc3c",
      "pid": 2050497,
      "advSessionId": "41534",
      "startedAt": 1791805864714,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-c13b8b58-9648-40e3-bbdd-86acc762bc3c.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-759b9f7a-31a7-49cd-b3ea-08d152a6107b",
      "pid": 2760571,
      "advSessionId": "41430",
      "startedAt": 1791801154208,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-759b9f7a-31a7-49cd-b3ea-08d152a6107b.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-be0a8f1d-a645-43e0-ac20-07eec2c68917",
      "pid": 2962449,
      "advSessionId": "40895",
      "startedAt": 1791777307143,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-be0a8f1d-a645-43e0-ac20-07eec2c68917.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-5e26d68f-60b7-4d7c-b1b7-0dbf07bcc96d",
      "pid": 2200435,
      "advSessionId": "38370",
      "startedAt": 1791666558445,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5e26d68f-60b7-4d7c-b1b7-0dbf07bcc96d.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-fa816892-8b9e-4454-833f-95f753b1ca3a",
      "pid": 3404079,
      "advSessionId": "40805",
      "startedAt": 1791759197663,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-fa816892-8b9e-4454-833f-95f753b1ca3a.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-7c708cfc-9f17-43a2-95b7-3a16339fe7a6",
      "pid": 2569527,
      "advSessionId": "41538",
      "startedAt": 1791806441864,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-7c708cfc-9f17-43a2-95b7-3a16339fe7a6.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2c2b6ea4-8d79-462b-932f-8c5a6b06a6b1",
      "pid": 1752934,
      "advSessionId": "37321",
      "startedAt": 1791666229811,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2c2b6ea4-8d79-462b-932f-8c5a6b06a6b1.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-f31eb02a-1307-4b7a-98ca-001a0574178e",
      "pid": 97822,
      "advSessionId": "36883",
      "startedAt": 1791400552577,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "66b708f3bf6b9db1e402910b8d032c50e6d78e92972c78a73cb48f140ead9924",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-f31eb02a-1307-4b7a-98ca-001a0574178e.json",
      "source": {
        "sha": "a313fada5b56a92df7363a9b986f465bf1117955",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-79b89c5f-ef57-4fee-ba14-f25bb01ccd62",
      "pid": 1959954,
      "advSessionId": "41448",
      "startedAt": 1791800048993,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-79b89c5f-ef57-4fee-ba14-f25bb01ccd62.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-97b68245-28a2-431e-a1c4-a0d018969d9a",
      "pid": 440887,
      "advSessionId": "36742",
      "startedAt": 1791391584953,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "524654f5a899660fb07333f6e5b4a5fdd678d467598a8f0515f662dfed077f44",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-97b68245-28a2-431e-a1c4-a0d018969d9a.json",
      "source": {
        "sha": "ee1d5dd613aa5e56eb99b56af64da62084b3625b",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-2245b010-6ebe-4f99-815a-7e84e66fdf8b",
      "pid": 2455500,
      "advSessionId": "38398",
      "startedAt": 1791666906265,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2245b010-6ebe-4f99-815a-7e84e66fdf8b.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-74a69e3f-67f1-439e-8b81-e19eef523fe3",
      "pid": 3023006,
      "advSessionId": "39543",
      "startedAt": 1791801564208,
      "bridgeTty": false,
      "launchedBy": "su-98a6938f-2663-4635-bf6b-9fd7539d66ac",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-74a69e3f-67f1-439e-8b81-e19eef523fe3.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-6fcd6cfc-9244-4111-8fbc-6ac11e9612e9",
      "pid": 1952070,
      "advSessionId": "41049",
      "startedAt": 1791776117054,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-6fcd6cfc-9244-4111-8fbc-6ac11e9612e9.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-455c513f-a609-4318-aa05-06a26305c57f",
      "pid": 2865698,
      "advSessionId": "40580",
      "startedAt": 1791749142300,
      "bridgeTty": false,
      "launchedBy": "su-50591fd4-cda2-459c-af03-691c4107f736",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-455c513f-a609-4318-aa05-06a26305c57f.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-23c7fc91-515d-4107-b31b-74a3d0faac72",
      "pid": 3001814,
      "advSessionId": "36728",
      "startedAt": 1791421789866,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "1984a0730c29581b64f953da9dae8a3ef3edc3015c9081eee12310513053678b",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-23c7fc91-515d-4107-b31b-74a3d0faac72.json",
      "source": {
        "sha": "352570503a5ab253da8d9b737bb2847a4fb84458",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-d97ef8cb-cd98-4096-a72f-2f0688f09628",
      "pid": 2140897,
      "advSessionId": "39237",
      "startedAt": 1791740751100,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-d97ef8cb-cd98-4096-a72f-2f0688f09628.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-0b7ff69d-5fcb-4dd5-a2c5-4fcbab4964c7",
      "pid": 1424988,
      "advSessionId": "39924",
      "startedAt": 1791670398738,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0b7ff69d-5fcb-4dd5-a2c5-4fcbab4964c7.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-4f400c63-c7de-4b6c-9991-23a4f111a2e6",
      "pid": 3481035,
      "advSessionId": "41361",
      "startedAt": 1791787141812,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-4f400c63-c7de-4b6c-9991-23a4f111a2e6.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-8029b9a0-0420-4a26-bae7-3ec6859293a7",
      "pid": 3691878,
      "advSessionId": "40988",
      "startedAt": 1791759572082,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-8029b9a0-0420-4a26-bae7-3ec6859293a7.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-46745570-2fd0-4e15-97ea-7c6cf8f336bc",
      "pid": 2741192,
      "advSessionId": "41539",
      "startedAt": 1791806690031,
      "bridgeTty": false,
      "launchedBy": "system:grading-audit-dispatch",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-46745570-2fd0-4e15-97ea-7c6cf8f336bc.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-828322e7-3f12-42b6-9d24-8df0dfd8795f",
      "pid": 1301966,
      "advSessionId": "40462",
      "startedAt": 1791747810367,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-828322e7-3f12-42b6-9d24-8df0dfd8795f.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df",
      "pid": 3805058,
      "advSessionId": "40284",
      "startedAt": 1791746200837,
      "bridgeTty": false,
      "launchedBy": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-83cc1cde-e6e2-46ec-aac5-bde1d41f63df.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-de5729a7-76d6-4498-8766-c084b2502a21",
      "pid": 60010,
      "advSessionId": "39937",
      "startedAt": 1791698312600,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "b2ec35f132861d5f6b2dbb51353b78bc43f19cf6a8563e3578d1114d242527bc",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-de5729a7-76d6-4498-8766-c084b2502a21.json",
      "source": {
        "sha": "e33dc0862eba85df86cfa77cfd88e4c3d9f15d6f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-768e011d-ed5e-4861-baf0-a6ee1be282a8",
      "pid": 91601,
      "advSessionId": "41369",
      "startedAt": 1791788068043,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-768e011d-ed5e-4861-baf0-a6ee1be282a8.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-7a64881b-130c-426e-8598-4b5743090035",
      "pid": 2098729,
      "advSessionId": "41499",
      "startedAt": 1791800246820,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-7a64881b-130c-426e-8598-4b5743090035.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2437f7dc-2ed4-4777-a623-a10101e8a0a1",
      "pid": 2501659,
      "advSessionId": "40793",
      "startedAt": 1791800825311,
      "bridgeTty": false,
      "launchedBy": "system:goal-holder-launch",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2437f7dc-2ed4-4777-a623-a10101e8a0a1.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-ec67d65a-222d-4bc0-8d52-c81e99a00bbf",
      "pid": 2036591,
      "advSessionId": "38395",
      "startedAt": 1791505480225,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "f83f02d851e4594655c4d5bfbf8fda9d5efbf51ae5491c085be4173835a6cfbc",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ec67d65a-222d-4bc0-8d52-c81e99a00bbf.json",
      "source": {
        "sha": "1a9fbcfba1eefb90b4f4d6544144a9cd8907b9cc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-cf02a746-b635-4aee-a49e-90587ce38a6f",
      "pid": 1444387,
      "advSessionId": "40924",
      "startedAt": 1791804964732,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-cf02a746-b635-4aee-a49e-90587ce38a6f.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-8198501a-f9af-4627-845f-7db8acc34113",
      "pid": 2486719,
      "advSessionId": "40750",
      "startedAt": 1791745063578,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-8198501a-f9af-4627-845f-7db8acc34113.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-38c4b8ff-c242-4dbb-9b0e-b053bcb99401",
      "pid": 2962811,
      "advSessionId": "37379",
      "startedAt": 1791667636567,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-38c4b8ff-c242-4dbb-9b0e-b053bcb99401.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-f7a0f287-7667-49d1-af74-fd6b74a348c8",
      "pid": 3948354,
      "advSessionId": "39976",
      "startedAt": 1791755381256,
      "bridgeTty": false,
      "launchedBy": "su-d70c727a-b61a-4db3-bbe1-ce888c65a9d5",
      "hostCodeVersion": "55f6e623302f359544407143766a9a7357229c9aa64d6240d70b291222ab6418",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-f7a0f287-7667-49d1-af74-fd6b74a348c8.json",
      "source": null,
      "structuralContainment": "unknown",
      "missingMarkers": null
    },
    {
      "ownerId": "su-586d69f1-1289-4cd0-824c-09a6f98ee5e7",
      "pid": 1577985,
      "advSessionId": "35913",
      "startedAt": 1791337421232,
      "bridgeTty": false,
      "launchedBy": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "hostCodeVersion": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-586d69f1-1289-4cd0-824c-09a6f98ee5e7.json",
      "source": {
        "sha": "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-fa0e5a79-95f8-4dff-949e-b4c446528c04",
      "pid": 3243180,
      "advSessionId": "40977",
      "startedAt": 1791763832481,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-fa0e5a79-95f8-4dff-949e-b4c446528c04.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2ad46958-628a-4c17-bbd6-ebe812805f73",
      "pid": 2630818,
      "advSessionId": "38412",
      "startedAt": 1791506339137,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2ad46958-628a-4c17-bbd6-ebe812805f73.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-c5661b8d-f984-4a53-9b88-78b89db8203a",
      "pid": 1961794,
      "advSessionId": "41205",
      "startedAt": 1791800051103,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-c5661b8d-f984-4a53-9b88-78b89db8203a.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-9dfd3ffc-fb7b-40bf-b625-d93dbab9f002",
      "pid": 2095086,
      "advSessionId": "35938",
      "startedAt": 1791338107547,
      "bridgeTty": false,
      "launchedBy": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "hostCodeVersion": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-9dfd3ffc-fb7b-40bf-b625-d93dbab9f002.json",
      "source": {
        "sha": "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-d79d84cf-7fb9-4cda-a53c-aabdcf078517",
      "pid": 1432882,
      "advSessionId": null,
      "startedAt": 1791553219815,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-d79d84cf-7fb9-4cda-a53c-aabdcf078517.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-5d483b80-9352-42fa-af85-22e0ee30ac50",
      "pid": 2026414,
      "advSessionId": "41533",
      "startedAt": 1791805842874,
      "bridgeTty": false,
      "launchedBy": "su-f304a906-0da5-4f8f-a362-6f3d0b43f515",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5d483b80-9352-42fa-af85-22e0ee30ac50.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-b68c3e13-77bc-42cb-b5ed-e33ee76452cc",
      "pid": 2964559,
      "advSessionId": "36748",
      "startedAt": 1791421745337,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "1984a0730c29581b64f953da9dae8a3ef3edc3015c9081eee12310513053678b",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b68c3e13-77bc-42cb-b5ed-e33ee76452cc.json",
      "source": {
        "sha": "352570503a5ab253da8d9b737bb2847a4fb84458",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-c374a10a-9a64-44e6-951f-df126de06bbd",
      "pid": 2170274,
      "advSessionId": "41326",
      "startedAt": 1791800377709,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-c374a10a-9a64-44e6-951f-df126de06bbd.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-d3049251-af5c-495b-a1c5-d4e4340ec073",
      "pid": 826873,
      "advSessionId": "38140",
      "startedAt": 1791703175591,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-d3049251-af5c-495b-a1c5-d4e4340ec073.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-3386e477-5bf3-471a-a207-bc2ded0fab67",
      "pid": 650387,
      "advSessionId": "41415",
      "startedAt": 1791793688837,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3386e477-5bf3-471a-a207-bc2ded0fab67.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-1e14c56c-d9c0-476e-a1bc-092a1c548894",
      "pid": 2629354,
      "advSessionId": "41088",
      "startedAt": 1791767777999,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-1e14c56c-d9c0-476e-a1bc-092a1c548894.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-90492b06-7126-4f76-9730-bdafb0f42a8d",
      "pid": 4054837,
      "advSessionId": "40283",
      "startedAt": 1791702250286,
      "bridgeTty": false,
      "launchedBy": "su-98a6938f-2663-4635-bf6b-9fd7539d66ac",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-90492b06-7126-4f76-9730-bdafb0f42a8d.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-62f0062b-7713-4905-b6dc-f34b9a358764",
      "pid": 1454661,
      "advSessionId": "38394",
      "startedAt": 1791665632304,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-62f0062b-7713-4905-b6dc-f34b9a358764.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-1b17f319-1964-4537-bb02-fdd9b4cd67c0",
      "pid": 4105588,
      "advSessionId": "39614",
      "startedAt": 1791803033577,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-1b17f319-1964-4537-bb02-fdd9b4cd67c0.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-e8830e4d-146e-41db-92ea-a9d97e648e5e",
      "pid": 2491211,
      "advSessionId": "40741",
      "startedAt": 1791744962512,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e8830e4d-146e-41db-92ea-a9d97e648e5e.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-b880508a-8832-4c9e-9222-3806cbed0490",
      "pid": 4162013,
      "advSessionId": "40605",
      "startedAt": 1791746576251,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b880508a-8832-4c9e-9222-3806cbed0490.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-9e66a68d-2451-4a45-88db-633a23171b79",
      "pid": 2352993,
      "advSessionId": "37318",
      "startedAt": 1791426246059,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "296ef73ed870b1664ddcc93fc90dbf26a958c826b5f2de8d4be9946df569b6f0",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-9e66a68d-2451-4a45-88db-633a23171b79.json",
      "source": {
        "sha": "8adb4e4c611ec6f7f5b090322e6482d9f12e40f3",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-0abdb075-3e8f-4a3d-856a-199f47c1c3ce",
      "pid": 3371372,
      "advSessionId": "40996",
      "startedAt": 1791760445718,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0abdb075-3e8f-4a3d-856a-199f47c1c3ce.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-7813359c-e643-4587-9b3f-4becb2397ea4",
      "pid": 1319627,
      "advSessionId": "37415",
      "startedAt": 1791674323237,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-7813359c-e643-4587-9b3f-4becb2397ea4.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "pid": 3785454,
      "advSessionId": "40302",
      "startedAt": 1791701975692,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-75676c8f-ed12-4217-b88d-57bd6f4043aa",
      "pid": 1242404,
      "advSessionId": "35940",
      "startedAt": 1791450220596,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "f36b6cfd8881c2830d88b7dc6d2a56d93fe145efcde4227018529c588a8633cf",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-75676c8f-ed12-4217-b88d-57bd6f4043aa.json",
      "source": {
        "sha": "a0471a785f94a11925580372279003f3fe6e8a13",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-df4f263d-5cb7-44bc-9d4b-8cf727fc79a3",
      "pid": 2727574,
      "advSessionId": "40860",
      "startedAt": 1791758490848,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-df4f263d-5cb7-44bc-9d4b-8cf727fc79a3.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-a422aeff-4771-47be-98e0-34fc838d2ed1",
      "pid": 1755814,
      "advSessionId": "40967",
      "startedAt": 1791757676049,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-a422aeff-4771-47be-98e0-34fc838d2ed1.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-7da2b30a-2af1-445f-89f2-77c7d3d55a70",
      "pid": 2132686,
      "advSessionId": "41112",
      "startedAt": 1791800305859,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-7da2b30a-2af1-445f-89f2-77c7d3d55a70.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-e16e0da4-f858-4e10-9665-55116edbc36b",
      "pid": 3364894,
      "advSessionId": "37370",
      "startedAt": 1791768634204,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e16e0da4-f858-4e10-9665-55116edbc36b.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-23846385-73be-455d-b5a4-7a180567d457",
      "pid": 1403735,
      "advSessionId": "41529",
      "startedAt": 1791804926640,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-23846385-73be-455d-b5a4-7a180567d457.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2c59d737-2fce-4af1-bd47-812c97d52a8d",
      "pid": 2628143,
      "advSessionId": "40984",
      "startedAt": 1791776957928,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2c59d737-2fce-4af1-bd47-812c97d52a8d.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-5e7f6672-a81c-47cb-a91c-3289429c5419",
      "pid": 1272890,
      "advSessionId": "41203",
      "startedAt": 1791775357548,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5e7f6672-a81c-47cb-a91c-3289429c5419.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-abafa5da-a403-41ab-a5c1-b383f4430a6b",
      "pid": 2788636,
      "advSessionId": "41220",
      "startedAt": 1791777116755,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-abafa5da-a403-41ab-a5c1-b383f4430a6b.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-12f9af09-c47e-4a89-af91-8a15809fdc25",
      "pid": 2688627,
      "advSessionId": "40787",
      "startedAt": 1791801037908,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-12f9af09-c47e-4a89-af91-8a15809fdc25.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "pid": 744959,
      "advSessionId": "36711",
      "startedAt": 1791401303968,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "64e32653bce24d6f983a8fd578dd37d118725b5c5e8e57cab40db0b1a09b9988",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-055e916b-4218-4d93-9e0d-4a2c57fe9026.json",
      "source": {
        "sha": "58c180e135e148d1bdcb5968f24599917479da76",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-4a65af3e-49ab-406d-90f8-a58b0ae9e84f",
      "pid": 2897699,
      "advSessionId": "40410",
      "startedAt": 1791741578125,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-4a65af3e-49ab-406d-90f8-a58b0ae9e84f.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-0d2affd0-2198-4734-b54f-186234343375",
      "pid": 2087436,
      "advSessionId": "38317",
      "startedAt": 1791666403700,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0d2affd0-2198-4734-b54f-186234343375.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-0c1f1afa-db9d-4bbc-8852-5726660a5862",
      "pid": 4084208,
      "advSessionId": "34178",
      "startedAt": 1791773875558,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "c463036f773edf56e16014a6d32887e8480061f782558df10e14a9b57f3d516e",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0c1f1afa-db9d-4bbc-8852-5726660a5862.json",
      "source": {
        "sha": "e35cac84042426d62b75f0c87ce7afebce5ab308",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-acf24bc3-d073-4f5d-9d31-9ed9fbfc489c",
      "pid": 1932518,
      "advSessionId": "39236",
      "startedAt": 1791704272412,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-acf24bc3-d073-4f5d-9d31-9ed9fbfc489c.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-1ccb709f-9d2a-4cc9-bd09-e28f899d24ad",
      "pid": 672901,
      "advSessionId": "38269",
      "startedAt": 1791494786478,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "903fb833e9459bfa7d7189a3f60fd35e61493ffedc8a3ea1e9ebe20e0bcc2586",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-1ccb709f-9d2a-4cc9-bd09-e28f899d24ad.json",
      "source": {
        "sha": "fdecccfff052e74658a9e0b9d4aba77233089025",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-0e4db6a0-49d5-400e-acf2-121effa56c27",
      "pid": 1622097,
      "advSessionId": "38893",
      "startedAt": 1791564875406,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0e4db6a0-49d5-400e-acf2-121effa56c27.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-5bc342cf-1a98-4fdb-8aaa-4efe4c561861",
      "pid": 985722,
      "advSessionId": "41036",
      "startedAt": 1791775019631,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5bc342cf-1a98-4fdb-8aaa-4efe4c561861.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-0c0af15f-481f-4556-8b8c-d74b6235ccf4",
      "pid": 2646799,
      "advSessionId": "41025",
      "startedAt": 1791800994714,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0c0af15f-481f-4556-8b8c-d74b6235ccf4.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-804cc7f6-a652-4a7e-a376-1e630d8ce269",
      "pid": 1774137,
      "advSessionId": "40797",
      "startedAt": 1791748153365,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-804cc7f6-a652-4a7e-a376-1e630d8ce269.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-dd6af82f-1cd4-4cdb-bcf8-ebe921942a3d",
      "pid": 2668615,
      "advSessionId": "38413",
      "startedAt": 1791506347018,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-dd6af82f-1cd4-4cdb-bcf8-ebe921942a3d.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-f6f7baf3-c9d2-4948-976e-bbbcd72d1892",
      "pid": 4117836,
      "advSessionId": "41520",
      "startedAt": 1791803051482,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-f6f7baf3-c9d2-4948-976e-bbbcd72d1892.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-610a2d46-e567-49a5-baac-9163d664f79f",
      "pid": 1611579,
      "advSessionId": "38708",
      "startedAt": 1791703844432,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-610a2d46-e567-49a5-baac-9163d664f79f.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-a8c663f5-cacc-44b6-9ae2-5237d6adfc93",
      "pid": 265873,
      "advSessionId": "40998",
      "startedAt": 1791760564616,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-a8c663f5-cacc-44b6-9ae2-5237d6adfc93.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-6c04ea3c-1bf2-4fcf-94b8-2d37952728a6",
      "pid": 54315,
      "advSessionId": "39801",
      "startedAt": 1791702418190,
      "bridgeTty": false,
      "launchedBy": "su-98a6938f-2663-4635-bf6b-9fd7539d66ac",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-6c04ea3c-1bf2-4fcf-94b8-2d37952728a6.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2ae770e8-b3a9-415a-b353-1a2e247772b4",
      "pid": 642273,
      "advSessionId": "41523",
      "startedAt": 1791804022534,
      "bridgeTty": false,
      "launchedBy": "su-f304a906-0da5-4f8f-a362-6f3d0b43f515",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2ae770e8-b3a9-415a-b353-1a2e247772b4.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-e6d2a824-e413-4321-9aea-6600c71cec71",
      "pid": 2789751,
      "advSessionId": "36100",
      "startedAt": 1791338893158,
      "bridgeTty": false,
      "launchedBy": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "hostCodeVersion": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e6d2a824-e413-4321-9aea-6600c71cec71.json",
      "source": {
        "sha": "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-e78cc6d7-340f-49eb-baf6-4fc6ca294d16",
      "pid": 3239156,
      "advSessionId": "37569",
      "startedAt": 1791447653295,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "f36b6cfd8881c2830d88b7dc6d2a56d93fe145efcde4227018529c588a8633cf",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e78cc6d7-340f-49eb-baf6-4fc6ca294d16.json",
      "source": {
        "sha": "a0471a785f94a11925580372279003f3fe6e8a13",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-50591fd4-cda2-459c-af03-691c4107f736",
      "pid": 3785968,
      "advSessionId": "37417",
      "startedAt": 1791730533301,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-50591fd4-cda2-459c-af03-691c4107f736.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-50f71624-3c60-4db3-b43d-06160dbc957c",
      "pid": 155561,
      "advSessionId": "36976",
      "startedAt": 1791405838419,
      "bridgeTty": true,
      "launchedBy": "su-50f71624-3c60-4db3-b43d-06160dbc957c",
      "hostCodeVersion": "225756ed51ef1276cd37b79650eb36525e2ade30cfb93a529d63e3f9cf057174",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-50f71624-3c60-4db3-b43d-06160dbc957c.json",
      "source": {
        "sha": "5a314fef2dc7c248427598c1cf676352d437ed8e",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-29b06aca-3216-41f9-b568-e8bc547a7c32",
      "pid": 1609880,
      "advSessionId": "39925",
      "startedAt": 1791670730784,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-29b06aca-3216-41f9-b568-e8bc547a7c32.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-8cec8a78-4938-450e-95bd-6508e5ebfa7f",
      "pid": 2829482,
      "advSessionId": "41117",
      "startedAt": 1791768334810,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-8cec8a78-4938-450e-95bd-6508e5ebfa7f.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-85d36834-59c5-4328-a21d-7adc5623b75a",
      "pid": 3429982,
      "advSessionId": "40627",
      "startedAt": 1791734121246,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-85d36834-59c5-4328-a21d-7adc5623b75a.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-3e584d48-38e4-43ef-ad0f-8092abf58687",
      "pid": 929590,
      "advSessionId": "40947",
      "startedAt": 1791756687992,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3e584d48-38e4-43ef-ad0f-8092abf58687.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-03b5a051-9444-44ad-977b-b87006a70341",
      "pid": 2081204,
      "advSessionId": "40992",
      "startedAt": 1791800222898,
      "bridgeTty": false,
      "launchedBy": "su-8df00c9a-c33a-4292-a81c-7a2bc6e0d307",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-03b5a051-9444-44ad-977b-b87006a70341.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-cfcd7f09-9908-4487-9535-276d15384c7c",
      "pid": 3477623,
      "advSessionId": "39886",
      "startedAt": 1791749839959,
      "bridgeTty": false,
      "launchedBy": "su-d70c727a-b61a-4db3-bbe1-ce888c65a9d5",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-cfcd7f09-9908-4487-9535-276d15384c7c.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-06aa6aeb-a07d-4a0a-9a35-938811814ef9",
      "pid": 2864961,
      "advSessionId": "41116",
      "startedAt": 1791768331190,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-06aa6aeb-a07d-4a0a-9a35-938811814ef9.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-e32b393b-2d61-428c-b1a4-6f85c2699487",
      "pid": 642662,
      "advSessionId": "41524",
      "startedAt": 1791804022521,
      "bridgeTty": false,
      "launchedBy": "su-f304a906-0da5-4f8f-a362-6f3d0b43f515",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e32b393b-2d61-428c-b1a4-6f85c2699487.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-f304a906-0da5-4f8f-a362-6f3d0b43f515",
      "pid": 3256177,
      "advSessionId": null,
      "startedAt": 1791667603249,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-f304a906-0da5-4f8f-a362-6f3d0b43f515.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-98e0d4ff-6025-49e3-aba1-c1d3e5606cd9",
      "pid": 3967449,
      "advSessionId": "36445",
      "startedAt": 1791641000544,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "1adf3ebf979c30788f760dae4dcf374e1e3ebc43ff5a22c13bfe41df75d8c68e",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-98e0d4ff-6025-49e3-aba1-c1d3e5606cd9.json",
      "source": {
        "sha": "35e297ce5978608f904bedc64222eb88e7d3d262",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-af1812f5-3582-4586-a1c1-b2127e741024",
      "pid": 2074833,
      "advSessionId": "41535",
      "startedAt": 1791805890413,
      "bridgeTty": false,
      "launchedBy": "system:grading-audit-dispatch",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-af1812f5-3582-4586-a1c1-b2127e741024.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-0dd6b9aa-3d59-4727-991e-377d05bc2459",
      "pid": 1621768,
      "advSessionId": "39735",
      "startedAt": 1791649310224,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "266153483ae8ad37b4bdb78398fffb6678a84444f48d7bf76dd90f15cd4530d7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0dd6b9aa-3d59-4727-991e-377d05bc2459.json",
      "source": {
        "sha": "ad32e4f6515b864a1dec31e8e8e2544595edaac8",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-acd7804d-5729-4946-b02a-ca953853bffe",
      "pid": 1343647,
      "advSessionId": "38980",
      "startedAt": 1791648628881,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "266153483ae8ad37b4bdb78398fffb6678a84444f48d7bf76dd90f15cd4530d7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-acd7804d-5729-4946-b02a-ca953853bffe.json",
      "source": {
        "sha": "ad32e4f6515b864a1dec31e8e8e2544595edaac8",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-0f38adbc-c692-4dfe-8ed2-4b5404762ff7",
      "pid": 2660217,
      "advSessionId": "38919",
      "startedAt": 1791667162833,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0f38adbc-c692-4dfe-8ed2-4b5404762ff7.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-9fd8057d-21b3-4c54-8c93-359441f6900e",
      "pid": 2560253,
      "advSessionId": "40885",
      "startedAt": 1791800884881,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-9fd8057d-21b3-4c54-8c93-359441f6900e.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-5e71ed64-4775-4722-81a3-f05f42f4f799",
      "pid": 851496,
      "advSessionId": "40892",
      "startedAt": 1791756647623,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5e71ed64-4775-4722-81a3-f05f42f4f799.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-166e1335-67a7-4e39-b973-5c74df3cadcb",
      "pid": 2243555,
      "advSessionId": "38801",
      "startedAt": 1791666661655,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-166e1335-67a7-4e39-b973-5c74df3cadcb.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-b9ccbf0d-131b-4a64-aca3-90987d99d842",
      "pid": 1719582,
      "advSessionId": "37741",
      "startedAt": 1791775884033,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b9ccbf0d-131b-4a64-aca3-90987d99d842.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-27b2e007-9c4f-4271-94fd-7afaccdd5735",
      "pid": 33753,
      "advSessionId": "39407",
      "startedAt": 1791702406683,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-27b2e007-9c4f-4271-94fd-7afaccdd5735.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-94c5efd3-ebd3-477d-ad5a-e522e108c3ab",
      "pid": 2722409,
      "advSessionId": "40999",
      "startedAt": 1791772404787,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "c463036f773edf56e16014a6d32887e8480061f782558df10e14a9b57f3d516e",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-94c5efd3-ebd3-477d-ad5a-e522e108c3ab.json",
      "source": {
        "sha": "e35cac84042426d62b75f0c87ce7afebce5ab308",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-c7d00eaf-c97c-44b5-b22e-3cb5e2ddb653",
      "pid": 589994,
      "advSessionId": "39554",
      "startedAt": 1791678062966,
      "bridgeTty": false,
      "launchedBy": "su-98a6938f-2663-4635-bf6b-9fd7539d66ac",
      "hostCodeVersion": "4539e0526194d544367041278f5c96c89814619cb462fe47a865501f29f3d1a2",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-c7d00eaf-c97c-44b5-b22e-3cb5e2ddb653.json",
      "source": {
        "sha": "459247f5eaa7fcf24b4d1eb82d8488fde5b1e475",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-b0f459d2-421f-4287-a914-fa1a8d324f83",
      "pid": 3317013,
      "advSessionId": "40883",
      "startedAt": 1791763909297,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b0f459d2-421f-4287-a914-fa1a8d324f83.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-16e3554c-a66e-4183-b374-2e5ae2a95e36",
      "pid": 4059004,
      "advSessionId": "39669",
      "startedAt": 1791635589377,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "1adf3ebf979c30788f760dae4dcf374e1e3ebc43ff5a22c13bfe41df75d8c68e",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-16e3554c-a66e-4183-b374-2e5ae2a95e36.json",
      "source": {
        "sha": "35e297ce5978608f904bedc64222eb88e7d3d262",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-b4028e2d-590a-4d1c-9256-b44536574813",
      "pid": 2093802,
      "advSessionId": "35928",
      "startedAt": 1791700386356,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "b2ec35f132861d5f6b2dbb51353b78bc43f19cf6a8563e3578d1114d242527bc",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b4028e2d-590a-4d1c-9256-b44536574813.json",
      "source": {
        "sha": "e33dc0862eba85df86cfa77cfd88e4c3d9f15d6f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2b0b24d0-e9f4-4467-87a1-ff83cdd39d99",
      "pid": 968533,
      "advSessionId": "35289",
      "startedAt": 1791454728006,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "f36b6cfd8881c2830d88b7dc6d2a56d93fe145efcde4227018529c588a8633cf",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2b0b24d0-e9f4-4467-87a1-ff83cdd39d99.json",
      "source": {
        "sha": "a0471a785f94a11925580372279003f3fe6e8a13",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-9b9af65b-ec38-4e45-a98b-eacd7ff3dea5",
      "pid": 1771477,
      "advSessionId": "37122",
      "startedAt": 1791666031002,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-9b9af65b-ec38-4e45-a98b-eacd7ff3dea5.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-9f2d743b-a9aa-42f4-b97b-cf621ff3ab34",
      "pid": 2658006,
      "advSessionId": "41327",
      "startedAt": 1791801005880,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-9f2d743b-a9aa-42f4-b97b-cf621ff3ab34.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-95fdebc1-0abf-47c2-a293-4011897e4654",
      "pid": 160782,
      "advSessionId": "40763",
      "startedAt": 1791746741717,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-95fdebc1-0abf-47c2-a293-4011897e4654.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-180c8f49-5585-4043-bd53-89ca5a37f946",
      "pid": 4017019,
      "advSessionId": "40607",
      "startedAt": 1791746408274,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-180c8f49-5585-4043-bd53-89ca5a37f946.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2a4e1f4a-e579-4f68-b90f-69f3b26b8641",
      "pid": 1670960,
      "advSessionId": "40745",
      "startedAt": 1791752893277,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2a4e1f4a-e579-4f68-b90f-69f3b26b8641.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-8aa83a0b-722e-4e39-bb2c-d29b85a295b3",
      "pid": 3547160,
      "advSessionId": "40023",
      "startedAt": 1791773169311,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "c463036f773edf56e16014a6d32887e8480061f782558df10e14a9b57f3d516e",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-8aa83a0b-722e-4e39-bb2c-d29b85a295b3.json",
      "source": {
        "sha": "e35cac84042426d62b75f0c87ce7afebce5ab308",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-a64b732d-df27-4103-a11e-5426bca100b8",
      "pid": 2403873,
      "advSessionId": "40796",
      "startedAt": 1791758120313,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-a64b732d-df27-4103-a11e-5426bca100b8.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-a0e4fac4-1b6d-4964-b920-2e69444b0255",
      "pid": 3795854,
      "advSessionId": "40632",
      "startedAt": 1791734369600,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-a0e4fac4-1b6d-4964-b920-2e69444b0255.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-73f621d7-bae1-4bbb-b045-a11b5c47a384",
      "pid": 1910019,
      "advSessionId": "35315",
      "startedAt": 1791314781532,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-73f621d7-bae1-4bbb-b045-a11b5c47a384.json",
      "source": {
        "sha": "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-3b59b908-213e-4cdc-ac16-2cc3d3c87d65",
      "pid": 1523852,
      "advSessionId": "41214",
      "startedAt": 1791775645440,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3b59b908-213e-4cdc-ac16-2cc3d3c87d65.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-fe90d8f4-29ad-4a9a-ad14-c750470ab52e",
      "pid": 1331760,
      "advSessionId": null,
      "startedAt": 1791553034824,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-fe90d8f4-29ad-4a9a-ad14-c750470ab52e.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-87fe0d36-7a8b-497e-ac2e-daf7272f9664",
      "pid": 4025650,
      "advSessionId": "40624",
      "startedAt": 1791746415912,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-87fe0d36-7a8b-497e-ac2e-daf7272f9664.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-36986ccc-d8dc-4139-bf7a-9363281b06c8",
      "pid": 2564106,
      "advSessionId": "39208",
      "startedAt": 1791667125897,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-36986ccc-d8dc-4139-bf7a-9363281b06c8.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "pid": 2008922,
      "advSessionId": "39935",
      "startedAt": 1791671190420,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b7ae044b-c702-4275-8857-d8c0943bc6f6.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-4a152da3-3ef7-420f-a82b-bfab10cf563a",
      "pid": 3957815,
      "advSessionId": "35942",
      "startedAt": 1791702136151,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-4a152da3-3ef7-420f-a82b-bfab10cf563a.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-81a4dc41-f10d-42b6-9d03-9e99489cfd58",
      "pid": 1806112,
      "advSessionId": "40743",
      "startedAt": 1791752944535,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-81a4dc41-f10d-42b6-9d03-9e99489cfd58.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-5a70011e-0cac-4244-8b27-9aaf1ceb0b18",
      "pid": 4179492,
      "advSessionId": "39895",
      "startedAt": 1791668493303,
      "bridgeTty": false,
      "launchedBy": "su-d70c727a-b61a-4db3-bbe1-ce888c65a9d5",
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5a70011e-0cac-4244-8b27-9aaf1ceb0b18.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-928e075d-6320-4ecf-9149-8c86187a9ed8",
      "pid": 3658231,
      "advSessionId": "35926",
      "startedAt": 1791701846575,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-928e075d-6320-4ecf-9149-8c86187a9ed8.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-5fed05e6-b05a-43c4-8753-6f8524db7519",
      "pid": 2666480,
      "advSessionId": "41050",
      "startedAt": 1791801011934,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5fed05e6-b05a-43c4-8753-6f8524db7519.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-72f78fbb-7e47-41ae-a842-35c83b8fcdd2",
      "pid": 1329159,
      "advSessionId": "41240",
      "startedAt": 1791775423868,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-72f78fbb-7e47-41ae-a842-35c83b8fcdd2.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-60df5d22-d045-4660-bdbc-ff602879d3a8",
      "pid": 334702,
      "advSessionId": "39434",
      "startedAt": 1791599928118,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "772a859a542b1990798cbb9e3f4bd2d069531156226fe4b0a5c51733e0f6a11c",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-60df5d22-d045-4660-bdbc-ff602879d3a8.json",
      "source": {
        "sha": "405947bc4cfff1ed3b721daa4af027d64d71e970",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-7a94555d-4fbb-42b8-a39d-ff28fade9e0f",
      "pid": 749368,
      "advSessionId": "34353",
      "startedAt": 1791336699788,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-7a94555d-4fbb-42b8-a39d-ff28fade9e0f.json",
      "source": {
        "sha": "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c",
      "pid": 29009,
      "advSessionId": "40925",
      "startedAt": 1791755768644,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-6f6f3aa0-77b0-4ab3-a9e5-126b5853a81c.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2faaac40-4ff0-4c8b-9c32-ce366b1f5f99",
      "pid": 3968465,
      "advSessionId": "40567",
      "startedAt": 1791746369008,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2faaac40-4ff0-4c8b-9c32-ce366b1f5f99.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-dab96471-48c6-40bf-a2b6-2ec7c5b052ca",
      "pid": 3118128,
      "advSessionId": "35943",
      "startedAt": 1791421922981,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "1984a0730c29581b64f953da9dae8a3ef3edc3015c9081eee12310513053678b",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-dab96471-48c6-40bf-a2b6-2ec7c5b052ca.json",
      "source": {
        "sha": "352570503a5ab253da8d9b737bb2847a4fb84458",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-97f378e3-56e1-452f-95ad-0e26218a898a",
      "pid": 2106402,
      "advSessionId": "40756",
      "startedAt": 1791753230645,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-97f378e3-56e1-452f-95ad-0e26218a898a.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-69e68df2-36d7-46b4-97ba-59c51ef8ffeb",
      "pid": 1953319,
      "advSessionId": "39739",
      "startedAt": 1791649469337,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "266153483ae8ad37b4bdb78398fffb6678a84444f48d7bf76dd90f15cd4530d7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-69e68df2-36d7-46b4-97ba-59c51ef8ffeb.json",
      "source": {
        "sha": "ad32e4f6515b864a1dec31e8e8e2544595edaac8",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-78bd0f9c-e6c1-4fa4-8fbf-594c8e963b8a",
      "pid": 748769,
      "advSessionId": "40993",
      "startedAt": 1791774797006,
      "bridgeTty": false,
      "launchedBy": "su-8df00c9a-c33a-4292-a81c-7a2bc6e0d307",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-78bd0f9c-e6c1-4fa4-8fbf-594c8e963b8a.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-3295dd52-d7b8-4399-91ef-ec6c1ee567b2",
      "pid": 1951468,
      "advSessionId": "41090",
      "startedAt": 1791800038699,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3295dd52-d7b8-4399-91ef-ec6c1ee567b2.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-ea145858-8dc8-4602-ae3d-675eb6c2b804",
      "pid": 2937027,
      "advSessionId": "40246",
      "startedAt": 1791807051588,
      "bridgeTty": false,
      "launchedBy": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ea145858-8dc8-4602-ae3d-675eb6c2b804.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-5ad9a888-4b4d-4b34-8821-becc109cbfdd",
      "pid": 3514462,
      "advSessionId": "41516",
      "startedAt": 1791802115905,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5ad9a888-4b4d-4b34-8821-becc109cbfdd.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-a52ff808-18e9-4ae6-84dc-3f41873d1f96",
      "pid": 168832,
      "advSessionId": "41000",
      "startedAt": 1791769658247,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-a52ff808-18e9-4ae6-84dc-3f41873d1f96.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-26d586ac-1737-40d2-9924-1da612107140",
      "pid": 2069266,
      "advSessionId": "41414",
      "startedAt": 1791800204502,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-26d586ac-1737-40d2-9924-1da612107140.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-9c77cdda-2970-4f59-b57f-012184077358",
      "pid": 3544249,
      "advSessionId": "39313",
      "startedAt": 1791681390131,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "4539e0526194d544367041278f5c96c89814619cb462fe47a865501f29f3d1a2",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-9c77cdda-2970-4f59-b57f-012184077358.json",
      "source": {
        "sha": "459247f5eaa7fcf24b4d1eb82d8488fde5b1e475",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-ce38325b-b2f5-41ab-a60b-4f8c9d1ed8f0",
      "pid": 3659221,
      "advSessionId": "40169",
      "startedAt": 1791701847365,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ce38325b-b2f5-41ab-a60b-4f8c9d1ed8f0.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-1f83c162-410c-4680-85d3-3b9dc5888e5a",
      "pid": 4038169,
      "advSessionId": "39668",
      "startedAt": 1791702236561,
      "bridgeTty": false,
      "launchedBy": "su-98a6938f-2663-4635-bf6b-9fd7539d66ac",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-1f83c162-410c-4680-85d3-3b9dc5888e5a.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-73d2221e-3024-463b-bc31-1ee9a2342f6d",
      "pid": 2339761,
      "advSessionId": "40910",
      "startedAt": 1791800617831,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-73d2221e-3024-463b-bc31-1ee9a2342f6d.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-97b230d9-72a8-44eb-96b0-5d8a65e217f1",
      "pid": 3655787,
      "advSessionId": "39856",
      "startedAt": 1791701843423,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-97b230d9-72a8-44eb-96b0-5d8a65e217f1.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-82592767-2742-45b8-b053-4b096877bacc",
      "pid": 2704382,
      "advSessionId": "40966",
      "startedAt": 1791801064818,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-82592767-2742-45b8-b053-4b096877bacc.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-fa4c1948-0cb1-4552-a7a3-dc274c5e1b0a",
      "pid": 2470617,
      "advSessionId": "36018",
      "startedAt": 1791338494577,
      "bridgeTty": false,
      "launchedBy": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "hostCodeVersion": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-fa4c1948-0cb1-4552-a7a3-dc274c5e1b0a.json",
      "source": {
        "sha": "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-e8c8eb72-eec2-44cf-9bfa-3b9e77aa6efe",
      "pid": 1673321,
      "advSessionId": "40795",
      "startedAt": 1791775838227,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e8c8eb72-eec2-44cf-9bfa-3b9e77aa6efe.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-afad66f7-05ab-403b-b3a1-fe08f3adc9bf",
      "pid": 2456844,
      "advSessionId": "41482",
      "startedAt": 1791800758622,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-afad66f7-05ab-403b-b3a1-fe08f3adc9bf.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-85cc9087-1e89-407c-9f50-8e402754722d",
      "pid": 4174358,
      "advSessionId": null,
      "startedAt": 1791556733450,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-85cc9087-1e89-407c-9f50-8e402754722d.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-c04397d1-7c42-418d-a14c-026ceca4d008",
      "pid": 3496692,
      "advSessionId": "40819",
      "startedAt": 1791754794791,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "55f6e623302f359544407143766a9a7357229c9aa64d6240d70b291222ab6418",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-c04397d1-7c42-418d-a14c-026ceca4d008.json",
      "source": null,
      "structuralContainment": "unknown",
      "missingMarkers": null
    },
    {
      "ownerId": "su-25a3d4d3-cb70-4685-a0de-d8fd1cd4f918",
      "pid": 1943943,
      "advSessionId": "39017",
      "startedAt": 1791667343275,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-25a3d4d3-cb70-4685-a0de-d8fd1cd4f918.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-5695d56b-5b46-4af0-81ab-3ba5aa4e5e0e",
      "pid": 3723181,
      "advSessionId": "40219",
      "startedAt": 1791701908022,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5695d56b-5b46-4af0-81ab-3ba5aa4e5e0e.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-b2f8d6a6-c13f-45d2-889e-b0af286f57ee",
      "pid": 2672468,
      "advSessionId": "39649",
      "startedAt": 1791709272281,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b2f8d6a6-c13f-45d2-889e-b0af286f57ee.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-e7208581-4177-450e-a2a9-65d871758d61",
      "pid": 2178109,
      "advSessionId": "37315",
      "startedAt": 1791425830377,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "296ef73ed870b1664ddcc93fc90dbf26a958c826b5f2de8d4be9946df569b6f0",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e7208581-4177-450e-a2a9-65d871758d61.json",
      "source": {
        "sha": "8adb4e4c611ec6f7f5b090322e6482d9f12e40f3",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-8a78de8b-66a6-4a24-a2bd-1d38412f8b2e",
      "pid": 3663687,
      "advSessionId": "40036",
      "startedAt": 1791701848732,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-8a78de8b-66a6-4a24-a2bd-1d38412f8b2e.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-ba86fec0-e0dc-48fc-8401-d0282cfd1067",
      "pid": 3526143,
      "advSessionId": "40712",
      "startedAt": 1791745919858,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ba86fec0-e0dc-48fc-8401-d0282cfd1067.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-cdedbf9d-733d-45be-a764-fb8ffb8d56cf",
      "pid": 1758607,
      "advSessionId": "40437",
      "startedAt": 1791716624935,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-cdedbf9d-733d-45be-a764-fb8ffb8d56cf.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-d3002b76-f468-498d-8aa6-52e2a21cfcf1",
      "pid": 2835755,
      "advSessionId": "40166",
      "startedAt": 1791705184252,
      "bridgeTty": false,
      "launchedBy": "system:goal-holder-launch",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-d3002b76-f468-498d-8aa6-52e2a21cfcf1.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-5a5372ca-c10c-49bd-99b0-84f2502f080d",
      "pid": 578492,
      "advSessionId": "40107",
      "startedAt": 1791702936028,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-5a5372ca-c10c-49bd-99b0-84f2502f080d.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-31ef81a3-16b6-4419-b0ba-02be19aa16f2",
      "pid": 828222,
      "advSessionId": "40762",
      "startedAt": 1791747383000,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-31ef81a3-16b6-4419-b0ba-02be19aa16f2.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-61a88fd2-510d-4ca6-8a71-fde8957fb3bc",
      "pid": 3242164,
      "advSessionId": "35530",
      "startedAt": 1791697362527,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "b2ec35f132861d5f6b2dbb51353b78bc43f19cf6a8563e3578d1114d242527bc",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-61a88fd2-510d-4ca6-8a71-fde8957fb3bc.json",
      "source": {
        "sha": "e33dc0862eba85df86cfa77cfd88e4c3d9f15d6f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-de92a7ab-1ddd-4075-9489-cb621799cfd4",
      "pid": 3874990,
      "advSessionId": "41215",
      "startedAt": 1791773584843,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "c463036f773edf56e16014a6d32887e8480061f782558df10e14a9b57f3d516e",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-de92a7ab-1ddd-4075-9489-cb621799cfd4.json",
      "source": {
        "sha": "e35cac84042426d62b75f0c87ce7afebce5ab308",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-3ecaf532-8655-4072-b2c0-6bc3319221b1",
      "pid": 3691192,
      "advSessionId": "36177",
      "startedAt": 1791340054161,
      "bridgeTty": false,
      "launchedBy": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "hostCodeVersion": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3ecaf532-8655-4072-b2c0-6bc3319221b1.json",
      "source": {
        "sha": "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-27805c90-3aa1-4b99-8ada-54bce3842d7f",
      "pid": 2408177,
      "advSessionId": "40740",
      "startedAt": 1791744847412,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-27805c90-3aa1-4b99-8ada-54bce3842d7f.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-552b6b78-311b-4cff-bed9-90ab9b1dc338",
      "pid": 3218999,
      "advSessionId": "39613",
      "startedAt": 1791705562805,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-552b6b78-311b-4cff-bed9-90ab9b1dc338.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-e5e15a37-5777-4593-814d-f99ffd3a2f80",
      "pid": 3537713,
      "advSessionId": "41276",
      "startedAt": 1791777848103,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e5e15a37-5777-4593-814d-f99ffd3a2f80.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-319d25f7-f3ab-48aa-a152-27b5388ce332",
      "pid": 655752,
      "advSessionId": "40623",
      "startedAt": 1791774695110,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-319d25f7-f3ab-48aa-a152-27b5388ce332.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-3f842379-1cf7-42d7-a1f8-4e6d2fd3202a",
      "pid": 1755415,
      "advSessionId": "40965",
      "startedAt": 1791757675880,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3f842379-1cf7-42d7-a1f8-4e6d2fd3202a.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-01248af5-137e-4f7c-82d7-1715d6ecf725",
      "pid": 3607009,
      "advSessionId": "38238",
      "startedAt": 1791492580088,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "903fb833e9459bfa7d7189a3f60fd35e61493ffedc8a3ea1e9ebe20e0bcc2586",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-01248af5-137e-4f7c-82d7-1715d6ecf725.json",
      "source": {
        "sha": "fdecccfff052e74658a9e0b9d4aba77233089025",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-64dc4fea-1d64-41d8-a4d2-38f156c18479",
      "pid": 2798514,
      "advSessionId": "41011",
      "startedAt": 1791801207793,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-64dc4fea-1d64-41d8-a4d2-38f156c18479.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-6e4bbb58-cb59-45d0-b30c-95b63704bcd5",
      "pid": 1380968,
      "advSessionId": "41526",
      "startedAt": 1791804909256,
      "bridgeTty": false,
      "launchedBy": "su-f304a906-0da5-4f8f-a362-6f3d0b43f515",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-6e4bbb58-cb59-45d0-b30c-95b63704bcd5.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-8aec963c-1284-4a99-85f6-64e3dd62c82f",
      "pid": 941310,
      "advSessionId": "38866",
      "startedAt": 1791557845991,
      "bridgeTty": true,
      "launchedBy": "su-d79d84cf-7fb9-4cda-a53c-aabdcf078517",
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-8aec963c-1284-4a99-85f6-64e3dd62c82f.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-6788d0ac-d425-4756-a9b3-3a451df401be",
      "pid": 2138871,
      "advSessionId": "37401",
      "startedAt": 1791431663924,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "296ef73ed870b1664ddcc93fc90dbf26a958c826b5f2de8d4be9946df569b6f0",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-6788d0ac-d425-4756-a9b3-3a451df401be.json",
      "source": {
        "sha": "8adb4e4c611ec6f7f5b090322e6482d9f12e40f3",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-83f8a781-5520-4893-aa4a-3c9d27f9201e",
      "pid": 3669038,
      "advSessionId": "40443",
      "startedAt": 1791759538744,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-83f8a781-5520-4893-aa4a-3c9d27f9201e.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-3e892ec3-60a5-40c1-8b7e-3c0b24d1039e",
      "pid": 2775783,
      "advSessionId": "36382",
      "startedAt": 1791421471112,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "1984a0730c29581b64f953da9dae8a3ef3edc3015c9081eee12310513053678b",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3e892ec3-60a5-40c1-8b7e-3c0b24d1039e.json",
      "source": {
        "sha": "352570503a5ab253da8d9b737bb2847a4fb84458",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-ea773025-3ada-4bbf-b2e4-63d7fa4067f7",
      "pid": 1380775,
      "advSessionId": "41527",
      "startedAt": 1791804909585,
      "bridgeTty": false,
      "launchedBy": "su-f304a906-0da5-4f8f-a362-6f3d0b43f515",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ea773025-3ada-4bbf-b2e4-63d7fa4067f7.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-cdc1b6ee-4254-4b72-a03d-325374263be7",
      "pid": 4054868,
      "advSessionId": "39820",
      "startedAt": 1791702250279,
      "bridgeTty": false,
      "launchedBy": "su-ce4c4481-9aa5-4fc0-bfac-6446e16bd98f",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-cdc1b6ee-4254-4b72-a03d-325374263be7.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-d7c6542c-582d-44dc-a02b-6cca3ebc2352",
      "pid": 3960741,
      "advSessionId": "35957",
      "startedAt": 1791702138821,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-d7c6542c-582d-44dc-a02b-6cca3ebc2352.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-df8a45a0-ac59-4037-8a63-9d45e9f62d55",
      "pid": 1279736,
      "advSessionId": "40596",
      "startedAt": 1791752396141,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-df8a45a0-ac59-4037-8a63-9d45e9f62d55.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-80791f26-9327-4ac8-9122-835a25d09896",
      "pid": 782494,
      "advSessionId": "40976",
      "startedAt": 1791774831051,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-80791f26-9327-4ac8-9122-835a25d09896.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-8ec23f4a-5d17-4f1c-bf4c-790edb53f5e3",
      "pid": 2806883,
      "advSessionId": "36110",
      "startedAt": 1791338906910,
      "bridgeTty": false,
      "launchedBy": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "hostCodeVersion": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-8ec23f4a-5d17-4f1c-bf4c-790edb53f5e3.json",
      "source": {
        "sha": "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-ac5fc5ce-2e2d-46db-8d88-e70ac4bd5a0e",
      "pid": 1381170,
      "advSessionId": "41528",
      "startedAt": 1791804909609,
      "bridgeTty": false,
      "launchedBy": "su-f304a906-0da5-4f8f-a362-6f3d0b43f515",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-ac5fc5ce-2e2d-46db-8d88-e70ac4bd5a0e.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-39585af5-b385-429d-813d-f65f1b561bb0",
      "pid": 1774056,
      "advSessionId": "40749",
      "startedAt": 1791753025637,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-39585af5-b385-429d-813d-f65f1b561bb0.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-1020321d-4f7c-4257-a245-c2461a585b62",
      "pid": 1594303,
      "advSessionId": "40293",
      "startedAt": 1791703831168,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-1020321d-4f7c-4257-a245-c2461a585b62.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-f835b8a8-dc40-4cfa-95fa-34ae14a18895",
      "pid": 3094796,
      "advSessionId": "41065",
      "startedAt": 1791768380855,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-f835b8a8-dc40-4cfa-95fa-34ae14a18895.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "pid": 2982186,
      "advSessionId": "39831",
      "startedAt": 1791697100240,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "b2ec35f132861d5f6b2dbb51353b78bc43f19cf6a8563e3578d1114d242527bc",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-77348e3d-80ac-42d8-b4e7-bdce9684a72a.json",
      "source": {
        "sha": "e33dc0862eba85df86cfa77cfd88e4c3d9f15d6f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-61f9729d-fef8-416a-88a8-72293cce5695",
      "pid": 1904037,
      "advSessionId": "39815",
      "startedAt": 1791704222961,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-61f9729d-fef8-416a-88a8-72293cce5695.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-26e81472-29ed-4d18-8b4b-4520850d8aef",
      "pid": 863646,
      "advSessionId": "40295",
      "startedAt": 1791703205989,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-26e81472-29ed-4d18-8b4b-4520850d8aef.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-f6b6fcca-f4f9-484f-86ca-974378824a67",
      "pid": 2809479,
      "advSessionId": "39986",
      "startedAt": 1791741465299,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-f6b6fcca-f4f9-484f-86ca-974378824a67.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-1e0a0217-875d-4186-bdfb-880f24d4f2aa",
      "pid": 3667565,
      "advSessionId": "40621",
      "startedAt": 1791759537768,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-1e0a0217-875d-4186-bdfb-880f24d4f2aa.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-4d390264-fc3c-4875-a655-a71b0afcd6ef",
      "pid": 2789651,
      "advSessionId": "36101",
      "startedAt": 1791338894312,
      "bridgeTty": false,
      "launchedBy": "su-0a2c66a2-10a7-4d9a-84c3-3c7ab8550ef4",
      "hostCodeVersion": "c1e8c8def084375cbd8b7e132722a7dee2791dffaed6ab79cf40db42c5cbba81",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-4d390264-fc3c-4875-a655-a71b0afcd6ef.json",
      "source": {
        "sha": "728748a08564a423e34cc06ba6ea8e3ea69cdcbe",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-74b1b1c5-1bd1-43b0-a432-2c61d61faf36",
      "pid": 3798135,
      "advSessionId": "40611",
      "startedAt": 1791750240973,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-74b1b1c5-1bd1-43b0-a432-2c61d61faf36.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-64244b21-7448-404d-aa24-633e4d279424",
      "pid": 142282,
      "advSessionId": "38787",
      "startedAt": 1791551347829,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-64244b21-7448-404d-aa24-633e4d279424.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-fa29568b-c401-4f26-9b9c-8c337c7b11d1",
      "pid": 2662990,
      "advSessionId": "38288",
      "startedAt": 1791496298055,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "903fb833e9459bfa7d7189a3f60fd35e61493ffedc8a3ea1e9ebe20e0bcc2586",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-fa29568b-c401-4f26-9b9c-8c337c7b11d1.json",
      "source": {
        "sha": "fdecccfff052e74658a9e0b9d4aba77233089025",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-03ddd1eb-f3fb-4e49-ad2b-f56fce3bd473",
      "pid": 2686306,
      "advSessionId": "40444",
      "startedAt": 1791717550552,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-03ddd1eb-f3fb-4e49-ad2b-f56fce3bd473.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-99162d19-010c-4c2a-a6f8-6ca9528ed7f8",
      "pid": 2124232,
      "advSessionId": "40974",
      "startedAt": 1791800292083,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-99162d19-010c-4c2a-a6f8-6ca9528ed7f8.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2a49e37e-49f7-4abf-897c-0acdfe210b2f",
      "pid": 999468,
      "advSessionId": "40911",
      "startedAt": 1791775038533,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2a49e37e-49f7-4abf-897c-0acdfe210b2f.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-b0dc22a9-95e3-42f5-8047-1ba27be48c9c",
      "pid": 3423833,
      "advSessionId": "38237",
      "startedAt": 1791492403369,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "903fb833e9459bfa7d7189a3f60fd35e61493ffedc8a3ea1e9ebe20e0bcc2586",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b0dc22a9-95e3-42f5-8047-1ba27be48c9c.json",
      "source": {
        "sha": "fdecccfff052e74658a9e0b9d4aba77233089025",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-e5f812b6-2f01-4cb8-8d23-3299e65fc494",
      "pid": 1063860,
      "advSessionId": "40336",
      "startedAt": 1791747617210,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e5f812b6-2f01-4cb8-8d23-3299e65fc494.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-e8a9793f-a39c-4031-b923-732332dd31a5",
      "pid": 2109511,
      "advSessionId": "41408",
      "startedAt": 1791800265487,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-e8a9793f-a39c-4031-b923-732332dd31a5.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-0d911894-02ba-4b3e-a4aa-81a6a0a28a5b",
      "pid": 28902,
      "advSessionId": "40923",
      "startedAt": 1791755768642,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "78a6bf5a6ddbe54e08a1ba40876d4913db4fb79f34ffa777f425098d9434a3ff",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0d911894-02ba-4b3e-a4aa-81a6a0a28a5b.json",
      "source": {
        "sha": "25b768f6978dcaf7808222bc64feda2d6b74d74f",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-44e04b45-8305-4182-813b-b5b0a931b2e0",
      "pid": 3314680,
      "advSessionId": "37454",
      "startedAt": 1791611042382,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "772a859a542b1990798cbb9e3f4bd2d069531156226fe4b0a5c51733e0f6a11c",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-44e04b45-8305-4182-813b-b5b0a931b2e0.json",
      "source": {
        "sha": "405947bc4cfff1ed3b721daa4af027d64d71e970",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-a36a84a4-cd98-4dca-a33c-c277d44bab7c",
      "pid": 2085594,
      "advSessionId": "41075",
      "startedAt": 1791800228082,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-a36a84a4-cd98-4dca-a33c-c277d44bab7c.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-0e4ff1d0-1c03-4add-8909-213370683e21",
      "pid": 2303859,
      "advSessionId": "38911",
      "startedAt": 1791666766673,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0e4ff1d0-1c03-4add-8909-213370683e21.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-3b852ecd-efe9-438d-9487-a977f54e611e",
      "pid": 3051359,
      "advSessionId": "41076",
      "startedAt": 1791801603070,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-3b852ecd-efe9-438d-9487-a977f54e611e.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-7534ff62-a124-4ac1-a913-a60b3107d8e7",
      "pid": 2115649,
      "advSessionId": "39342",
      "startedAt": 1791666507574,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-7534ff62-a124-4ac1-a913-a60b3107d8e7.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-c7a48b7b-f8fd-4215-aa09-5fe6bebc007c",
      "pid": 2075680,
      "advSessionId": "38321",
      "startedAt": 1791666403698,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "dc5ced7bb3da2fcd206a05bcd7069ae9e4b5ca8e9b35333fa5b551ea69290fb7",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-c7a48b7b-f8fd-4215-aa09-5fe6bebc007c.json",
      "source": {
        "sha": "630f2ac08b1d4959b5ce1ad17536444e9c6abf45",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-b4f1c503-698a-4197-8002-0fa7d71ff0b4",
      "pid": 1192473,
      "advSessionId": "40909",
      "startedAt": 1791775275294,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-b4f1c503-698a-4197-8002-0fa7d71ff0b4.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-2c60d7a4-bf4d-408e-b8e7-6c33272334aa",
      "pid": 2194523,
      "advSessionId": "40823",
      "startedAt": 1791753579444,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-2c60d7a4-bf4d-408e-b8e7-6c33272334aa.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-01864986-d27d-497b-b501-7082b6e0caab",
      "pid": 3966524,
      "advSessionId": "39942",
      "startedAt": 1791702144575,
      "bridgeTty": false,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-01864986-d27d-497b-b501-7082b6e0caab.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-37c2c6ca-c16b-4b74-a551-02e09d4f6e3f",
      "pid": 2089280,
      "advSessionId": "38900",
      "startedAt": 1791565488388,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "c9fa0eb92d2aaf0818471230483b5e1ff9524cfe4c2d8668ffbca662aafe8a67",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-37c2c6ca-c16b-4b74-a551-02e09d4f6e3f.json",
      "source": {
        "sha": "7cb2d80833cd59bd69584c75ee09ae0903deb1cd",
        "origin": "committed-source",
        "markers": {
          "P004-detector": false,
          "P004-input-observer": false,
          "P004-published-recovery-capability": false,
          "P005-spawn-bound-window": false,
          "P005-idempotent-unbindable-refusal": false,
          "quota-reset-expiry-probe": false
        }
      },
      "structuralContainment": "missing-markers",
      "missingMarkers": [
        "P004-detector",
        "P004-input-observer",
        "P004-published-recovery-capability",
        "P005-spawn-bound-window",
        "P005-idempotent-unbindable-refusal",
        "quota-reset-expiry-probe"
      ]
    },
    {
      "ownerId": "su-0c193750-e6cc-40b0-81a4-2b8b61d92e3f",
      "pid": 2127345,
      "advSessionId": "40752",
      "startedAt": 1791753346530,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-0c193750-e6cc-40b0-81a4-2b8b61d92e3f.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-c25ffda7-51d9-46f3-9ff7-e60eb7ea3689",
      "pid": 3953183,
      "advSessionId": "41234",
      "startedAt": 1791802776300,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-c25ffda7-51d9-46f3-9ff7-e60eb7ea3689.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-cd27877f-1029-4199-a2ed-d081604001c3",
      "pid": 2411333,
      "advSessionId": "41394",
      "startedAt": 1791800707548,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-cd27877f-1029-4199-a2ed-d081604001c3.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-a908ae5c-3eb7-4ee0-a2b2-cb5e23dbb1bf",
      "pid": 1678035,
      "advSessionId": "41245",
      "startedAt": 1791775843698,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-a908ae5c-3eb7-4ee0-a2b2-cb5e23dbb1bf.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-8554c5b1-cd5a-4fd7-afbe-82bb68a75438",
      "pid": 1984072,
      "advSessionId": "40888",
      "startedAt": 1791753145441,
      "bridgeTty": true,
      "launchedBy": null,
      "hostCodeVersion": "3001c9d8b9a3819d3a604fbac0438effba29e467a5f7e805b905c171098535a6",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-8554c5b1-cd5a-4fd7-afbe-82bb68a75438.json",
      "source": {
        "sha": "f253aae19f49102212b454523d94ca760efbc4c2",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    },
    {
      "ownerId": "su-a659c496-b8d7-45f4-a9ab-464515132d70",
      "pid": 2430437,
      "advSessionId": "41066",
      "startedAt": 1791800722697,
      "bridgeTty": false,
      "launchedBy": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
      "hostCodeVersion": "e52c46cae78decdfbc9b90306d710c273c46ab32360ac50c801b73f9e361a839",
      "metadataFile": "/home/marsh-office/.papercusp/psu-pty/su-a659c496-b8d7-45f4-a9ab-464515132d70.json",
      "source": {
        "sha": "5276be35fe8ea6162547cdb3f63523401bcc84fc",
        "origin": "committed-source",
        "markers": {
          "P004-detector": true,
          "P004-input-observer": true,
          "P004-published-recovery-capability": true,
          "P005-spawn-bound-window": true,
          "P005-idempotent-unbindable-refusal": true,
          "quota-reset-expiry-probe": true
        }
      },
      "structuralContainment": "contains-markers",
      "missingMarkers": []
    }
  ]
}
