---
rel_path: "audits/parked-agent-resumption-2026-10-09/p008-native13-census-selector-qualification-20261024T175333Z-424d5.json"
updated_at: 1792864430438
_body: "content"
---

{
  "schemaVersion": "independent-native13-qualification-v1",
  "status": "qualified",
  "fixed": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
  "input": "dc748d9c2da4460f980fe5af7c84c4e32774b828cb3012f3f68ca76a7dcba6af",
  "helper": "b6b5f84e26b612c84180c195e57e07f1e5851c55e53520302c6c0ea87dc62b19",
  "identity": "v1-5776329dc45b968ef05f1e8bf782437acc93fab65788cc34ad668871dbc303bf",
  "token": "v3:35edd3142a0c70fe4fa5b3c6d7855673a72fb6f45da6ffd879359ca14d18ad40",
  "generationPath": "/mnt/data/papercusp-dependency-generations/v1-5776329dc45b968ef05f1e8bf782437acc93fab65788cc34ad668871dbc303bf",
  "startedAt": "2026-10-24T17:53:31.097Z",
  "qualifiedAt": "2026-10-24T17:53:33.229Z",
  "durationMs": 2132,
  "selectorStartedAt": "2026-10-24T17:53:31.434Z",
  "selectorFinishedAt": "2026-10-24T17:53:33.219Z",
  "preflightPath": "/mnt/data/offload/code-intel-reuse-signals/p008-native-13-20261024/preflight.json",
  "preflightSHA256": "39878344ea52ef093f8142ecc4665f3a5dc4eaf3ed70b238788aa5607d89235a",
  "controllerPath": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/p008-native-13-controller.mjs",
  "controllerSHA256": "0fbb70f834711cddc81edf02ce5dc65c8fd4bbb3a5985ff1e1721928939bf2ae",
  "preflightStable": true,
  "controllerStable": true,
  "originalSourcePath": "/mnt/data/offload/verification-harness/isolated-integration/20261024T093209Z-319319/phases/prepare/source.json",
  "originalSourceSHA256": "4ab6c8482c3294e81de7cd89336fbec7b6c2550c4cb214c765b355e450bc97c7",
  "census": {
    "population": [
      "apps/operator/bin/release/dependency-generation.sh",
      "libs/generic/verification-harness/src/runner.ts",
      "libs/papercusp/libs/db/src/connection.ts",
      "libs/test-config/src/admin-test-runs-reporter.ts",
      "libs/test-config/src/verifier-source.ts",
      "packages/agent-mcp/src/auth.ts",
      "packages/operator-core/lib/code-intelligence/clone-index.ts",
      "packages/operator-core/lib/code-intelligence/clone-sweep.native.integration.test.ts",
      "packages/operator-core/lib/code-intelligence/clone-sweep.ts",
      "packages/operator-core/lib/dbos/orchestrator-loop.ts",
      "packages/operator-core/lib/dbos/routines-workflow.ts",
      "packages/operator-core/lib/degradation/fallback-observations.ts",
      "packages/operator-core/lib/harness-registry.ts",
      "packages/operator-core/lib/harness/routines/arm-plan-schedule.ts",
      "packages/operator-core/lib/harness/routines/claim.ts",
      "packages/operator-core/lib/harness/routines/clone-family-sweep-action.ts",
      "packages/operator-core/lib/harness/routines/materialize-plan-schedule.ts",
      "packages/operator-core/lib/harness/routines/register-system-actions.ts",
      "packages/operator-core/lib/harness/routines/schedule-next.ts",
      "packages/operator-core/lib/harness/routines/system-actions.ts",
      "packages/operator-core/lib/pg-listen-hub.ts",
      "packages/operator-core/lib/process-identity.ts",
      "packages/operator-core/lib/task-manager/control.ts",
      "packages/operator-core/lib/task-manager/managed-spawn.ts",
      "packages/operator-core/lib/task-manager/store.ts",
      "packages/operator-core/test/isolated-integration-proof.ts",
      "papercusp-desktop/bin/lib/pinned-deps.sh",
      "scripts/clone-family-sweep.mts",
      "scripts/lib/isolated-runtime-start.mjs",
      "scripts/lib/pg-url.mjs",
      "scripts/lib/task-deadline.mjs",
      "scripts/lib/tracked-files.mjs",
      "scripts/lib/with-test-pg-cleanup.mjs",
      "scripts/lib/with-test-pg-migrations.mjs",
      "scripts/lint-as-committed.mjs",
      "scripts/source-preview.mjs",
      "scripts/test-files.mjs",
      "scripts/with-test-pg.mjs"
    ],
    "checked": [
      "apps/operator/bin/release/dependency-generation.sh",
      "libs/generic/verification-harness/src/runner.ts",
      "libs/papercusp/libs/db/src/connection.ts",
      "libs/test-config/src/admin-test-runs-reporter.ts",
      "libs/test-config/src/verifier-source.ts",
      "packages/agent-mcp/src/auth.ts",
      "packages/operator-core/lib/code-intelligence/clone-index.ts",
      "packages/operator-core/lib/code-intelligence/clone-sweep.native.integration.test.ts",
      "packages/operator-core/lib/code-intelligence/clone-sweep.ts",
      "packages/operator-core/lib/dbos/orchestrator-loop.ts",
      "packages/operator-core/lib/dbos/routines-workflow.ts",
      "packages/operator-core/lib/degradation/fallback-observations.ts",
      "packages/operator-core/lib/harness-registry.ts",
      "packages/operator-core/lib/harness/routines/arm-plan-schedule.ts",
      "packages/operator-core/lib/harness/routines/claim.ts",
      "packages/operator-core/lib/harness/routines/clone-family-sweep-action.ts",
      "packages/operator-core/lib/harness/routines/materialize-plan-schedule.ts",
      "packages/operator-core/lib/harness/routines/register-system-actions.ts",
      "packages/operator-core/lib/harness/routines/schedule-next.ts",
      "packages/operator-core/lib/harness/routines/system-actions.ts",
      "packages/operator-core/lib/pg-listen-hub.ts",
      "packages/operator-core/lib/process-identity.ts",
      "packages/operator-core/lib/task-manager/control.ts",
      "packages/operator-core/lib/task-manager/managed-spawn.ts",
      "packages/operator-core/lib/task-manager/store.ts",
      "packages/operator-core/test/isolated-integration-proof.ts",
      "papercusp-desktop/bin/lib/pinned-deps.sh",
      "scripts/clone-family-sweep.mts",
      "scripts/lib/isolated-runtime-start.mjs",
      "scripts/lib/pg-url.mjs",
      "scripts/lib/task-deadline.mjs",
      "scripts/lib/tracked-files.mjs",
      "scripts/lib/with-test-pg-cleanup.mjs",
      "scripts/lib/with-test-pg-migrations.mjs",
      "scripts/lint-as-committed.mjs",
      "scripts/source-preview.mjs",
      "scripts/test-files.mjs",
      "scripts/with-test-pg.mjs"
    ],
    "notChecked": [],
    "notApplicable": [],
    "residue": [],
    "count": 38,
    "uniqueCount": 38,
    "completeControllerCohort": true,
    "mismatchPaths": [],
    "rows": [
      {
        "path": "apps/operator/bin/release/dependency-generation.sh",
        "expected": "b6b5f84e26b612c84180c195e57e07f1e5851c55e53520302c6c0ea87dc62b19",
        "fixed": "b6b5f84e26b612c84180c195e57e07f1e5851c55e53520302c6c0ea87dc62b19",
        "currentBefore": "b6b5f84e26b612c84180c195e57e07f1e5851c55e53520302c6c0ea87dc62b19",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "b6b5f84e26b612c84180c195e57e07f1e5851c55e53520302c6c0ea87dc62b19"
      },
      {
        "path": "libs/generic/verification-harness/src/runner.ts",
        "expected": "87a7f689a1d23ea23534105b5f59882b7479a570a5e61229a2a54f091f2d3a36",
        "fixed": "87a7f689a1d23ea23534105b5f59882b7479a570a5e61229a2a54f091f2d3a36",
        "currentBefore": "87a7f689a1d23ea23534105b5f59882b7479a570a5e61229a2a54f091f2d3a36",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "87a7f689a1d23ea23534105b5f59882b7479a570a5e61229a2a54f091f2d3a36"
      },
      {
        "path": "libs/papercusp/libs/db/src/connection.ts",
        "expected": "4f39f38a20e1040d62f1a4fa45f65d5dde2d18b72caaad872db45986c534d52c",
        "fixed": "4f39f38a20e1040d62f1a4fa45f65d5dde2d18b72caaad872db45986c534d52c",
        "currentBefore": "4f39f38a20e1040d62f1a4fa45f65d5dde2d18b72caaad872db45986c534d52c",
        "repository": "libs/papercusp",
        "ref": "88c25f1f96a22f3befedf4ba4cdc165fc88970db",
        "currentAfter": "4f39f38a20e1040d62f1a4fa45f65d5dde2d18b72caaad872db45986c534d52c"
      },
      {
        "path": "libs/test-config/src/admin-test-runs-reporter.ts",
        "expected": "9ae26254b667c145c1aaf0a038d18052989ef147313ea1f9d6f22937d4d570c6",
        "fixed": "9ae26254b667c145c1aaf0a038d18052989ef147313ea1f9d6f22937d4d570c6",
        "currentBefore": "9ae26254b667c145c1aaf0a038d18052989ef147313ea1f9d6f22937d4d570c6",
        "repository": "libs/test-config",
        "ref": "86edab2e7c88558f41e3934b37230b7dfe9984ea",
        "currentAfter": "9ae26254b667c145c1aaf0a038d18052989ef147313ea1f9d6f22937d4d570c6"
      },
      {
        "path": "libs/test-config/src/verifier-source.ts",
        "expected": "dbf212c0cb7bb84fec5fcfcd1197e17f2b1649cc80f7db0cfcf9b936ac7b4ee4",
        "fixed": "dbf212c0cb7bb84fec5fcfcd1197e17f2b1649cc80f7db0cfcf9b936ac7b4ee4",
        "currentBefore": "dbf212c0cb7bb84fec5fcfcd1197e17f2b1649cc80f7db0cfcf9b936ac7b4ee4",
        "repository": "libs/test-config",
        "ref": "86edab2e7c88558f41e3934b37230b7dfe9984ea",
        "currentAfter": "dbf212c0cb7bb84fec5fcfcd1197e17f2b1649cc80f7db0cfcf9b936ac7b4ee4"
      },
      {
        "path": "packages/agent-mcp/src/auth.ts",
        "expected": "c0179829ab12d36347dba6400ea2c2ae7a04f9406ff7175a908c7d9b46301504",
        "fixed": "c0179829ab12d36347dba6400ea2c2ae7a04f9406ff7175a908c7d9b46301504",
        "currentBefore": "c0179829ab12d36347dba6400ea2c2ae7a04f9406ff7175a908c7d9b46301504",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "c0179829ab12d36347dba6400ea2c2ae7a04f9406ff7175a908c7d9b46301504"
      },
      {
        "path": "packages/operator-core/lib/code-intelligence/clone-index.ts",
        "expected": "f94fda4dfec8c6bd641abb1bd13f825232a254b2894eadf650c7b257de3bc0fb",
        "fixed": "f94fda4dfec8c6bd641abb1bd13f825232a254b2894eadf650c7b257de3bc0fb",
        "currentBefore": "f94fda4dfec8c6bd641abb1bd13f825232a254b2894eadf650c7b257de3bc0fb",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "f94fda4dfec8c6bd641abb1bd13f825232a254b2894eadf650c7b257de3bc0fb"
      },
      {
        "path": "packages/operator-core/lib/code-intelligence/clone-sweep.native.integration.test.ts",
        "expected": "de2fa8f17567b12eaa134171ab695c9989173162412bebed1c05fa62d9b0437b",
        "fixed": "de2fa8f17567b12eaa134171ab695c9989173162412bebed1c05fa62d9b0437b",
        "currentBefore": "de2fa8f17567b12eaa134171ab695c9989173162412bebed1c05fa62d9b0437b",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "de2fa8f17567b12eaa134171ab695c9989173162412bebed1c05fa62d9b0437b"
      },
      {
        "path": "packages/operator-core/lib/code-intelligence/clone-sweep.ts",
        "expected": "54dc3e621aca7610a72acce27417431eb4565735935c00f7efd37985c6e34482",
        "fixed": "54dc3e621aca7610a72acce27417431eb4565735935c00f7efd37985c6e34482",
        "currentBefore": "54dc3e621aca7610a72acce27417431eb4565735935c00f7efd37985c6e34482",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "54dc3e621aca7610a72acce27417431eb4565735935c00f7efd37985c6e34482"
      },
      {
        "path": "packages/operator-core/lib/dbos/orchestrator-loop.ts",
        "expected": "000282bdd9eb849ff698bb4271a571e8115f7db3d0dbc60ff10d3fc793fb14f6",
        "fixed": "000282bdd9eb849ff698bb4271a571e8115f7db3d0dbc60ff10d3fc793fb14f6",
        "currentBefore": "000282bdd9eb849ff698bb4271a571e8115f7db3d0dbc60ff10d3fc793fb14f6",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "000282bdd9eb849ff698bb4271a571e8115f7db3d0dbc60ff10d3fc793fb14f6"
      },
      {
        "path": "packages/operator-core/lib/dbos/routines-workflow.ts",
        "expected": "2959316721171c028fef5d8ca83201f849c6f583c3a079178de51ddf843b9348",
        "fixed": "2959316721171c028fef5d8ca83201f849c6f583c3a079178de51ddf843b9348",
        "currentBefore": "2959316721171c028fef5d8ca83201f849c6f583c3a079178de51ddf843b9348",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "2959316721171c028fef5d8ca83201f849c6f583c3a079178de51ddf843b9348"
      },
      {
        "path": "packages/operator-core/lib/degradation/fallback-observations.ts",
        "expected": "fbd8ffde80f427b999147a8e3107e2770e42b443aeacd7b4ae9edbaa8cb1110a",
        "fixed": "fbd8ffde80f427b999147a8e3107e2770e42b443aeacd7b4ae9edbaa8cb1110a",
        "currentBefore": "fbd8ffde80f427b999147a8e3107e2770e42b443aeacd7b4ae9edbaa8cb1110a",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "fbd8ffde80f427b999147a8e3107e2770e42b443aeacd7b4ae9edbaa8cb1110a"
      },
      {
        "path": "packages/operator-core/lib/harness-registry.ts",
        "expected": "0ff8a72bbd47eb4664f39276cfb08578d7db7750a7df030e64c29c2b39135b3b",
        "fixed": "0ff8a72bbd47eb4664f39276cfb08578d7db7750a7df030e64c29c2b39135b3b",
        "currentBefore": "0ff8a72bbd47eb4664f39276cfb08578d7db7750a7df030e64c29c2b39135b3b",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "0ff8a72bbd47eb4664f39276cfb08578d7db7750a7df030e64c29c2b39135b3b"
      },
      {
        "path": "packages/operator-core/lib/harness/routines/arm-plan-schedule.ts",
        "expected": "6812e75e41c5ebaa17f45bca97ace32b8cd8c343fcd6bbda38a2c760b9b62ed5",
        "fixed": "6812e75e41c5ebaa17f45bca97ace32b8cd8c343fcd6bbda38a2c760b9b62ed5",
        "currentBefore": "6812e75e41c5ebaa17f45bca97ace32b8cd8c343fcd6bbda38a2c760b9b62ed5",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "6812e75e41c5ebaa17f45bca97ace32b8cd8c343fcd6bbda38a2c760b9b62ed5"
      },
      {
        "path": "packages/operator-core/lib/harness/routines/claim.ts",
        "expected": "53b22d90a836656d239b8f9779596c548fdc9b1501b067d3b4d472bc54840f7a",
        "fixed": "53b22d90a836656d239b8f9779596c548fdc9b1501b067d3b4d472bc54840f7a",
        "currentBefore": "53b22d90a836656d239b8f9779596c548fdc9b1501b067d3b4d472bc54840f7a",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "53b22d90a836656d239b8f9779596c548fdc9b1501b067d3b4d472bc54840f7a"
      },
      {
        "path": "packages/operator-core/lib/harness/routines/clone-family-sweep-action.ts",
        "expected": "f3f36259056e179edf93696fe054a44c3bb0d022c94dc9c8cf01db41c3661774",
        "fixed": "f3f36259056e179edf93696fe054a44c3bb0d022c94dc9c8cf01db41c3661774",
        "currentBefore": "f3f36259056e179edf93696fe054a44c3bb0d022c94dc9c8cf01db41c3661774",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "f3f36259056e179edf93696fe054a44c3bb0d022c94dc9c8cf01db41c3661774"
      },
      {
        "path": "packages/operator-core/lib/harness/routines/materialize-plan-schedule.ts",
        "expected": "e576d1501e7c22a2f587c4016824b141d53d92dfc31b7bc9a467baa00b77e86f",
        "fixed": "e576d1501e7c22a2f587c4016824b141d53d92dfc31b7bc9a467baa00b77e86f",
        "currentBefore": "e576d1501e7c22a2f587c4016824b141d53d92dfc31b7bc9a467baa00b77e86f",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "e576d1501e7c22a2f587c4016824b141d53d92dfc31b7bc9a467baa00b77e86f"
      },
      {
        "path": "packages/operator-core/lib/harness/routines/register-system-actions.ts",
        "expected": "3e85d2921dea223650910d9090fddb2953516e166589b554063886b04dde90f8",
        "fixed": "3e85d2921dea223650910d9090fddb2953516e166589b554063886b04dde90f8",
        "currentBefore": "3e85d2921dea223650910d9090fddb2953516e166589b554063886b04dde90f8",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "3e85d2921dea223650910d9090fddb2953516e166589b554063886b04dde90f8"
      },
      {
        "path": "packages/operator-core/lib/harness/routines/schedule-next.ts",
        "expected": "16c5a7354bb3357806dac02b814192a618510fdb1f2d8b07812375a70042e18e",
        "fixed": "16c5a7354bb3357806dac02b814192a618510fdb1f2d8b07812375a70042e18e",
        "currentBefore": "16c5a7354bb3357806dac02b814192a618510fdb1f2d8b07812375a70042e18e",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "16c5a7354bb3357806dac02b814192a618510fdb1f2d8b07812375a70042e18e"
      },
      {
        "path": "packages/operator-core/lib/harness/routines/system-actions.ts",
        "expected": "b4b9714200a8fa5c38d3914d7d4849908d2c9678e8b9a21fdeacd35125b60dd7",
        "fixed": "b4b9714200a8fa5c38d3914d7d4849908d2c9678e8b9a21fdeacd35125b60dd7",
        "currentBefore": "b4b9714200a8fa5c38d3914d7d4849908d2c9678e8b9a21fdeacd35125b60dd7",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "b4b9714200a8fa5c38d3914d7d4849908d2c9678e8b9a21fdeacd35125b60dd7"
      },
      {
        "path": "packages/operator-core/lib/pg-listen-hub.ts",
        "expected": "f85518011d274c3f2ea09a392730c15c723c74f9a5fb79cb78ba43465f8c8b50",
        "fixed": "f85518011d274c3f2ea09a392730c15c723c74f9a5fb79cb78ba43465f8c8b50",
        "currentBefore": "f85518011d274c3f2ea09a392730c15c723c74f9a5fb79cb78ba43465f8c8b50",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "f85518011d274c3f2ea09a392730c15c723c74f9a5fb79cb78ba43465f8c8b50"
      },
      {
        "path": "packages/operator-core/lib/process-identity.ts",
        "expected": "f6b69be467b347a2185cc91637bbee096be04302e193f41e30005c7eb66daefb",
        "fixed": "f6b69be467b347a2185cc91637bbee096be04302e193f41e30005c7eb66daefb",
        "currentBefore": "f6b69be467b347a2185cc91637bbee096be04302e193f41e30005c7eb66daefb",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "f6b69be467b347a2185cc91637bbee096be04302e193f41e30005c7eb66daefb"
      },
      {
        "path": "packages/operator-core/lib/task-manager/control.ts",
        "expected": "9530c300043cf3b4d4cd3dfa0b2a1f08aa313e17621337dcacd2ef3976764e27",
        "fixed": "9530c300043cf3b4d4cd3dfa0b2a1f08aa313e17621337dcacd2ef3976764e27",
        "currentBefore": "9530c300043cf3b4d4cd3dfa0b2a1f08aa313e17621337dcacd2ef3976764e27",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "9530c300043cf3b4d4cd3dfa0b2a1f08aa313e17621337dcacd2ef3976764e27"
      },
      {
        "path": "packages/operator-core/lib/task-manager/managed-spawn.ts",
        "expected": "102efb8008382e632e399e163788eb665a17094f87d4af7afc45a483f7f8940c",
        "fixed": "102efb8008382e632e399e163788eb665a17094f87d4af7afc45a483f7f8940c",
        "currentBefore": "102efb8008382e632e399e163788eb665a17094f87d4af7afc45a483f7f8940c",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "102efb8008382e632e399e163788eb665a17094f87d4af7afc45a483f7f8940c"
      },
      {
        "path": "packages/operator-core/lib/task-manager/store.ts",
        "expected": "219928ab29e6ce4708ef03572c056cd5cac880dd74240d2fa6c16802a6dd688e",
        "fixed": "219928ab29e6ce4708ef03572c056cd5cac880dd74240d2fa6c16802a6dd688e",
        "currentBefore": "219928ab29e6ce4708ef03572c056cd5cac880dd74240d2fa6c16802a6dd688e",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "219928ab29e6ce4708ef03572c056cd5cac880dd74240d2fa6c16802a6dd688e"
      },
      {
        "path": "packages/operator-core/test/isolated-integration-proof.ts",
        "expected": "b1527e9882c81cefdb9694749444cc08aad6df98a4e7ee6efbf9fdcb226b0945",
        "fixed": "b1527e9882c81cefdb9694749444cc08aad6df98a4e7ee6efbf9fdcb226b0945",
        "currentBefore": "b1527e9882c81cefdb9694749444cc08aad6df98a4e7ee6efbf9fdcb226b0945",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "b1527e9882c81cefdb9694749444cc08aad6df98a4e7ee6efbf9fdcb226b0945"
      },
      {
        "path": "papercusp-desktop/bin/lib/pinned-deps.sh",
        "expected": "30f0a21faf9cfcad228e3ef74217b52844e2b32cc6fb5a2c6f4e63199824fcb5",
        "fixed": "30f0a21faf9cfcad228e3ef74217b52844e2b32cc6fb5a2c6f4e63199824fcb5",
        "currentBefore": "30f0a21faf9cfcad228e3ef74217b52844e2b32cc6fb5a2c6f4e63199824fcb5",
        "repository": "papercusp-desktop",
        "ref": "fe0e6b5aec323acce3fe99e392cabaf440bedf10",
        "currentAfter": "30f0a21faf9cfcad228e3ef74217b52844e2b32cc6fb5a2c6f4e63199824fcb5"
      },
      {
        "path": "scripts/clone-family-sweep.mts",
        "expected": "06449a6151d810b5c36debb358d2c08a4ec6d0d618c4a25fe4d624d582d45694",
        "fixed": "06449a6151d810b5c36debb358d2c08a4ec6d0d618c4a25fe4d624d582d45694",
        "currentBefore": "06449a6151d810b5c36debb358d2c08a4ec6d0d618c4a25fe4d624d582d45694",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "06449a6151d810b5c36debb358d2c08a4ec6d0d618c4a25fe4d624d582d45694"
      },
      {
        "path": "scripts/lib/isolated-runtime-start.mjs",
        "expected": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
        "fixed": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
        "currentBefore": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d"
      },
      {
        "path": "scripts/lib/pg-url.mjs",
        "expected": "1eecac50ddbf421ab3d1b39fe75451671c2a1f14f08293518a176c243bb6f7f1",
        "fixed": "1eecac50ddbf421ab3d1b39fe75451671c2a1f14f08293518a176c243bb6f7f1",
        "currentBefore": "1eecac50ddbf421ab3d1b39fe75451671c2a1f14f08293518a176c243bb6f7f1",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "1eecac50ddbf421ab3d1b39fe75451671c2a1f14f08293518a176c243bb6f7f1"
      },
      {
        "path": "scripts/lib/task-deadline.mjs",
        "expected": "613c6521326991a90fe7ffc571664dd6b303d514e4b2e6a558498637b60b6292",
        "fixed": "613c6521326991a90fe7ffc571664dd6b303d514e4b2e6a558498637b60b6292",
        "currentBefore": "613c6521326991a90fe7ffc571664dd6b303d514e4b2e6a558498637b60b6292",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "613c6521326991a90fe7ffc571664dd6b303d514e4b2e6a558498637b60b6292"
      },
      {
        "path": "scripts/lib/tracked-files.mjs",
        "expected": "561796125e4d20652fedebaf17602a8c8401a9b4203ef8ccd68f2a985579b024",
        "fixed": "561796125e4d20652fedebaf17602a8c8401a9b4203ef8ccd68f2a985579b024",
        "currentBefore": "561796125e4d20652fedebaf17602a8c8401a9b4203ef8ccd68f2a985579b024",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "561796125e4d20652fedebaf17602a8c8401a9b4203ef8ccd68f2a985579b024"
      },
      {
        "path": "scripts/lib/with-test-pg-cleanup.mjs",
        "expected": "92e9bc6ce77ddc75fe84c3788001214e7687a10c96b5469564a4862f019c2eae",
        "fixed": "92e9bc6ce77ddc75fe84c3788001214e7687a10c96b5469564a4862f019c2eae",
        "currentBefore": "92e9bc6ce77ddc75fe84c3788001214e7687a10c96b5469564a4862f019c2eae",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "92e9bc6ce77ddc75fe84c3788001214e7687a10c96b5469564a4862f019c2eae"
      },
      {
        "path": "scripts/lib/with-test-pg-migrations.mjs",
        "expected": "c601ddbe4b16d5d088853dd775fa561b9534d6ae886d466588e29cdfe6e11a5b",
        "fixed": "c601ddbe4b16d5d088853dd775fa561b9534d6ae886d466588e29cdfe6e11a5b",
        "currentBefore": "c601ddbe4b16d5d088853dd775fa561b9534d6ae886d466588e29cdfe6e11a5b",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "c601ddbe4b16d5d088853dd775fa561b9534d6ae886d466588e29cdfe6e11a5b"
      },
      {
        "path": "scripts/lint-as-committed.mjs",
        "expected": "e19f8e7f6726cfcedaeaa201139d9ed2ed3eb3fa3f6beff46752b18192dca507",
        "fixed": "e19f8e7f6726cfcedaeaa201139d9ed2ed3eb3fa3f6beff46752b18192dca507",
        "currentBefore": "e19f8e7f6726cfcedaeaa201139d9ed2ed3eb3fa3f6beff46752b18192dca507",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "e19f8e7f6726cfcedaeaa201139d9ed2ed3eb3fa3f6beff46752b18192dca507"
      },
      {
        "path": "scripts/source-preview.mjs",
        "expected": "ee2911efe09f2f4b20c622c4bc1918a66a6acf097f08a228282e4401423df818",
        "fixed": "ee2911efe09f2f4b20c622c4bc1918a66a6acf097f08a228282e4401423df818",
        "currentBefore": "ee2911efe09f2f4b20c622c4bc1918a66a6acf097f08a228282e4401423df818",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "ee2911efe09f2f4b20c622c4bc1918a66a6acf097f08a228282e4401423df818"
      },
      {
        "path": "scripts/test-files.mjs",
        "expected": "0ee5f2874fe54ef384947f173e5e88c20a3757f9e3bc8ffb6f93afdd7d830d79",
        "fixed": "0ee5f2874fe54ef384947f173e5e88c20a3757f9e3bc8ffb6f93afdd7d830d79",
        "currentBefore": "0ee5f2874fe54ef384947f173e5e88c20a3757f9e3bc8ffb6f93afdd7d830d79",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "0ee5f2874fe54ef384947f173e5e88c20a3757f9e3bc8ffb6f93afdd7d830d79"
      },
      {
        "path": "scripts/with-test-pg.mjs",
        "expected": "ff1ef65a67dde6b0fce3a4c36841ecfcfe03996b1845968afe6ed21e01bd085b",
        "fixed": "ff1ef65a67dde6b0fce3a4c36841ecfcfe03996b1845968afe6ed21e01bd085b",
        "currentBefore": "ff1ef65a67dde6b0fce3a4c36841ecfcfe03996b1845968afe6ed21e01bd085b",
        "repository": ".",
        "ref": "fa30ac2b2f1bb69c5ea6d5e05a2c18f9bc334995",
        "currentAfter": "ff1ef65a67dde6b0fce3a4c36841ecfcfe03996b1845968afe6ed21e01bd085b"
      }
    ]
  },
  "desktopRef": "fe0e6b5aec323acce3fe99e392cabaf440bedf10",
  "helperFromExactFixedBlob": true,
  "selectorLog": "SELECTOR_BEFORE_BEGIN\nschema=1\ninput=dc748d9c2da4460f980fe5af7c84c4e32774b828cb3012f3f68ca76a7dcba6af\nidentity=v1-5776329dc45b968ef05f1e8bf782437acc93fab65788cc34ad668871dbc303bf\ntoken=v3:35edd3142a0c70fe4fa5b3c6d7855673a72fb6f45da6ffd879359ca14d18ad40\ncreated=1792856905\nSELECTOR_BEFORE_END\nCURRENT_TOKEN_BEFORE=v3:35edd3142a0c70fe4fa5b3c6d7855673a72fb6f45da6ffd879359ca14d18ad40\nSELECTOR_AFTER_BEGIN\nschema=1\ninput=dc748d9c2da4460f980fe5af7c84c4e32774b828cb3012f3f68ca76a7dcba6af\nidentity=v1-5776329dc45b968ef05f1e8bf782437acc93fab65788cc34ad668871dbc303bf\ntoken=v3:35edd3142a0c70fe4fa5b3c6d7855673a72fb6f45da6ffd879359ca14d18ad40\ncreated=1792856905\nSELECTOR_AFTER_END\nCURRENT_TOKEN_AFTER=v3:35edd3142a0c70fe4fa5b3c6d7855673a72fb6f45da6ffd879359ca14d18ad40\nSTAT_BEFORE=66307:3260131712:250:1792856905:1792856905\nSTAT_AFTER=66307:3260131712:250:1792856905:1792856905\nQUALIFIED_INPUT=dc748d9c2da4460f980fe5af7c84c4e32774b828cb3012f3f68ca76a7dcba6af\nIDENTITY=v1-5776329dc45b968ef05f1e8bf782437acc93fab65788cc34ad668871dbc303bf\nTOKEN=v3:35edd3142a0c70fe4fa5b3c6d7855673a72fb6f45da6ffd879359ca14d18ad40\nGENERATION_PATH=/mnt/data/papercusp-dependency-generations/v1-5776329dc45b968ef05f1e8bf782437acc93fab65788cc34ad668871dbc303bf\nSELECTOR_STABLE=true\n",
  "selectorStable": true,
  "readOnlyGitGuard": true,
  "launchReceiptExists": false,
  "scope": "Independent cohort and selector qualification only; no native launch, guard replay, install, repair, publication, lease, gate or monitor",
  "previousAttempt": {
    "startedAt": "2026-10-24T17:51:45.090Z",
    "status": "unqualified",
    "durationMs": 390,
    "mismatchPaths": [],
    "selectorError": {
      "status": 1,
      "signal": null,
      "message": "spawnSync bash EPIPE"
    },
    "selectorLog": "native13-independent-qualifier: line 2: /dev/stdin: No such device or address\n",
    "interpretation": "Invocation failed before selector execution; /dev/stdin was not openable. Final probe sources an immutable Git-blob pipe and independently remeasures complete census."
  }
}
