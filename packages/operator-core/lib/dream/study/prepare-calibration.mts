import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrgPg } from "@papercusp/db-org";
import { mapDreamRun } from "../../dream/dream-run-store.ts";
import { STUDY_BLOCKS } from "./accounting.mts";
import { buildCalibrationBundle, calibrationStudyScope, calibrationKeyPublication } from "./calibration.mts";
import { freezeImmutableArtifacts } from "./freeze-artifacts.mts";
import { writeStdoutSync } from "../../../../../scripts/lib/write-stdout-sync.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workspaceId = "papercusp-workspace";
process.env.PAPERCUSP_WORKSPACE_ID = workspaceId;
const blocks = await Promise.all(
  Object.values(STUDY_BLOCKS).map(async (b) =>
    JSON.parse(await readFile(resolve(here, b.file), "utf8")),
  ),
);
const comparisonFile = process.argv.find(arg => arg.startsWith('--comparison='))?.slice('--comparison='.length);
const comparison = comparisonFile ? JSON.parse(await readFile(resolve(here, comparisonFile), 'utf8')) : undefined;
const { pins, prefix } = calibrationStudyScope(blocks, comparison);
const custodyFile = process.argv.find(arg => arg.startsWith('--publish-key-from='))?.slice('--publish-key-from='.length);
if (custodyFile) {
  const raw = await readFile(resolve(here, prefix + 'calibration-key-v2.json'), 'utf8');
  const receipt = JSON.parse(await readFile(resolve(custodyFile), 'utf8'));
  const reports = receipt.results?.filter((entry: { ok: boolean }) => entry.ok) ?? [];
  if (reports.length !== 1 || !reports[0].report)
    throw new Error('Calibration publication requires one complete reports:get receipt');
  const bytes = calibrationKeyPublication(raw, reports[0].report);
  const file = prefix + 'calibration-key-public-v2.json';
  const frozen = await freezeImmutableArtifacts([{ path: resolve(here, file), bytes, label: file }]);
  // Synchronous write: process.exit(0) below would truncate an async pipe write
  // (lint:no-undrained-stdout-exit); ESM top level has no `return` to end naturally.
  writeStdoutSync(JSON.stringify({ ...frozen, file, publication: JSON.parse(bytes).publication,
    providerCalls: 0, ledgerWrites: 0, originalKeyChanged: false }));
  process.exit(0);
}
const { sql } = getOrgPg();
try {
  // An uncapped census over exactly the frozen study identities; no live/global backlog.
  const rows = await sql`
    SELECT * FROM harness_shared.dream_runs
    WHERE workspace_id = ${workspaceId} AND pot_slug = 'papercusp'
      AND outcome->'capabilityRun'->'evaluation'->>'protocolPin' = ANY(${pins}::text[])
    ORDER BY started_at, run_id`;
  const { blind, key } = buildCalibrationBundle(rows.map(mapDreamRun));
  // Validate the whole set before creating anything; re-running may verify,
  // never silently replace or partially extend a frozen batch.
  await freezeImmutableArtifacts(
    [
      [prefix + "calibration-blind-v2.json", blind],
      [prefix + "calibration-key-v2.json", key],
    ].map(([file, value]) => ({
      path: resolve(here, file as string),
      bytes: JSON.stringify(value, null, 2) + "\n",
      label: file as string,
    })),
  );
  console.log(
    JSON.stringify({
      blindHash: key.blindHash,
      population: key.population,
      eligibleCandidates: key.eligibleCandidates,
      selected: blind.cases.length,
      excluded: key.excluded.length,
      strata: [...new Set(key.selected.map((c) => c.stratum))].length,
      independentLabels: key.independentLabels,
      providerCalls: 0,
      ledgerWrites: 0,
      source: "existing frozen dream_runs; original review unchanged",
    }),
  );
} finally {
  await sql.end({ timeout: 5 });
}
