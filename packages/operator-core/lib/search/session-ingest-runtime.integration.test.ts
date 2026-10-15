import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect } from 'vitest';
import { captureIsolatedWorker, isolatedIntegrationCases, isolatedWorkerFailureDetail,
  isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../../test/isolated-integration-proof';

const root = resolve(__dirname, '../../../..');
const source = resolve(root, 'packages/operator-core/lib/search/session-ingest.ts');

describe('current-build ingestion on a private background runtime', () => {
  const options = isolatedWorkerOptions(180_000);
  isolatedIntegrationCases('attributes a fixed incremental workload with CPU sampling=%s and removes its database and home', { timeout: options.testTimeoutMs }, async (sampleCpu, context) => {
    const sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex');
    // An optional frozen local tail exercises real mixed record sizes without
    // checking private transcripts into the repository. Only hashes and counts
    // enter the receipt; the canonical synthetic fixture remains self-contained.
    const corpusPath = process.env.TEST_INGEST_CORPUS_PATH;
    const corpusHash = corpusPath
      ? createHash('sha256').update(readFileSync(corpusPath)).digest('hex')
      : '';
    // Exercise the maintained runtime route in a fresh process: no mocked clock,
    // database, adapters, filesystem, flag read, or phase instrumentation.
    const probe = String.raw`
      import assert from 'node:assert/strict';
      import fs, { readFileSync } from 'node:fs';
      import fsPromises from 'node:fs/promises';
      import { mkdir, rm, utimes, writeFile } from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      import { performance } from 'node:perf_hooks';
      import { Session } from 'node:inspector/promises';
      import { createHash } from 'node:crypto';
      import { execFileSync } from 'node:child_process';
      import { join } from 'node:path';
      import { getOrgPg } from '@papercusp/db-org';
      import { FILE_ADAPTERS, codexTranscriptMeta, codexAdvSessionMetadata, jsonlAtDepth, ingestFileNow, runSessionIngestOnce } from './packages/operator-core/lib/search/session-ingest.ts';

      const e = process.env;
      assert.equal(e.PAPERCUSP_HOME, join(e.HOME, '.papercusp'));
      assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '1');
      assert.equal(e.PAPERCUSP_DBOS_ROUTINES, '0');
      assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
      assert.ok(e.PAPERCUSP_WORKSPACE_ID.startsWith('test-runtime-'));
      assert.ok(!e.PAPERCUSP_SID && !e.CODEX_HOME && !e.VITEST && !e.SSH_AUTH_SOCK);
      assert.ok(!e.PAPERCUSP_SUBSTRATE_IPC_SOCKET && !e.PAPERCUSP_DHT_BOOTSTRAP);
      assert.notEqual(e.HOME, e.TEST_LIVE_HOME);
      const dbUrl = new URL(e.HARNESS_ADMIN_DATABASE_URL);
      assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname));
      assert.equal(dbUrl.port, e.PAPERCUSP_PG_PORT);
      assert.notEqual(dbUrl.port, '5432');
      const sourceHash = createHash('sha256').update(readFileSync('packages/operator-core/lib/search/session-ingest.ts')).digest('hex');
      assert.equal(sourceHash, e.TEST_INGEST_SOURCE_HASH);
      for (const adapter of FILE_ADAPTERS) {
        for (const spec of adapter.roots()) assert.ok(spec.root.startsWith(e.HOME + '/'));
      }
      console.log('INGEST_RUNTIME_ENV ' + JSON.stringify({ home: e.HOME, dbPort: dbUrl.port, sourceHash }));

      // Match the observed candidate/tail scale, not the changing live corpus:
      // 320 managed homes, 15 rollouts/home, 80 changed tails, 64 useful turns,
      // 640 faithful parts. Metadata-only unchanged files isolate discovery,
      // state loading and metadata; this is not a production p95 workload.
      const workload = { id: 'synthetic-offset-tail-v1', homes: 320, filesPerHome: 15,
        changedFiles: 80, usefulTurns: 64, parts: 640, repeats: 4 };
      // A/B/B/A compares the same workload with and without the observer.
      // These are awaited-operation spans, including queueing and scheduling;
      // neither their wall time nor eventLoopUtilization measures kernel IO time.
      const observerOrder = [false, true, true, false];
      const sampleCpu = e.TEST_INGEST_SAMPLE_CPU === '1';
      // Keep filesystem observation fixed for the profiler comparison. Its
      // off/on/on/off series must not confound two observers changing together.
      if (sampleCpu) observerOrder.fill(true);
      const profilerOrder = sampleCpu ? [false, true, true, false] : observerOrder.map(() => false);
      const profiler = sampleCpu ? new Session() : null;
      if (profiler) {
        profiler.connect();
        await profiler.post('Profiler.enable');
        await profiler.post('Profiler.setSamplingInterval', { interval: 10_000 });
      }
      function summarizeProfile(profile) {
        const nodes = new Map(profile.nodes.map(node => [node.id, node]));
        const parents = new Map();
        for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
        assert.equal(profile.samples.length, profile.timeDeltas.length);
        const sampled = new Map();
        let sourceSamples = 0;
        for (let i = 0; i < profile.samples.length; i++) {
          const leaf = profile.samples[i];
          let bucket = sampled.get(leaf);
          if (!bucket) {
            const stack = [];
            for (let id = leaf; id != null; id = parents.get(id)) {
              assert.ok(nodes.has(id), 'every sampled stack node must exist');
              const frame = nodes.get(id).callFrame;
              stack.push({ function: frame.functionName, url: frame.url, line: frame.lineNumber });
            }
            bucket = { samples: 0, precedingIntervalUs: 0, stack };
            sampled.set(leaf, bucket);
          }
          bucket.samples++;
          // timeDeltas describe intervals preceding samples; neither their sum
          // nor ancestry allocation is exact per-function or per-phase CPU.
          bucket.precedingIntervalUs += profile.timeDeltas[i];
          if (bucket.stack.some(frame => frame.url.endsWith('/search/session-ingest.ts'))) sourceSamples++;
        }
        assert.ok(profile.samples.length > 0 && sourceSamples > 0, 'require actual sampled ingestion stacks');
        return { profileHash: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
          intervalUs: 10_000, startTimeUs: profile.startTime, endTimeUs: profile.endTime,
          totalSamples: profile.samples.length, sourceSamples, sampledStacks: [...sampled.values()] };
      }
      const managedRoot = join(e.PAPERCUSP_HOME, 'su-codex-homes');
      const originals = { readdir: fsPromises.readdir, stat: fsPromises.stat };
      const originalRead = fs.readFileSync;
      let metadataReads = null;
      function observeMetadata(enabled) {
        metadataReads = enabled ? {
          diagnostics: { calls: 0, completed: 0, errors: 0, bytes: 0, wallMs: 0 },
          config: { calls: 0, completed: 0, errors: 0, bytes: 0, wallMs: 0 },
        } : null;
        fs.readFileSync = enabled ? function(path, ...args) {
          const category = typeof path === 'string' && path.startsWith(managedRoot + '/')
            ? path.endsWith('/papercusp-diagnostics.json') ? 'diagnostics'
              : path.endsWith('/config.toml') ? 'config' : null
            : null;
          if (!category) return originalRead(path, ...args);
          const bucket = metadataReads[category];
          bucket.calls++;
          const began = performance.now();
          try {
            const value = originalRead(path, ...args);
            bucket.completed++;
            bucket.bytes += Buffer.byteLength(value);
            return value;
          } catch (err) { bucket.errors++; throw err; }
          finally { bucket.wallMs += performance.now() - began; }
        } : originalRead;
        syncBuiltinESMExports();
      }
      let fsObservation = null;
      function observeDiscovery(enabled) {
        fsObservation = enabled ? { pending: 0, maxPending: 0,
          readdir: { calls: 0, awaitMs: 0, activeMs: 0, idleMs: 0 },
          stat: { calls: 0, awaitMs: 0, activeMs: 0, idleMs: 0 } } : null;
        for (const name of ['readdir', 'stat']) {
          fsPromises[name] = enabled ? async function(...args) {
            if (typeof args[0] !== 'string' || !args[0].startsWith(managedRoot)) {
              return originals[name](...args);
            }
            const bucket = fsObservation[name];
            bucket.calls++;
            fsObservation.maxPending = Math.max(fsObservation.maxPending, ++fsObservation.pending);
            const began = performance.now();
            const loopBegan = performance.eventLoopUtilization();
            try { return await originals[name](...args); }
            finally {
              const loop = performance.eventLoopUtilization(loopBegan);
              bucket.awaitMs += performance.now() - began;
              bucket.activeMs += loop.active;
              bucket.idleMs += loop.idle;
              fsObservation.pending--;
            }
          } : originals[name];
        }
        syncBuiltinESMExports();
      }
      async function measuredSweep(observe, profileCpu) {
        observeDiscovery(observe);
        // Fixed across useful/unchanged and profiler off/on controls. Reads
        // still reach the real filesystem; no cached or synthetic return value.
        observeMetadata(true);
        let profilerActive = false;
        const startBegan = performance.now();
        if (profileCpu) {
          await profiler.post('Profiler.start');
          profilerActive = true;
        }
        const profilerStartMs = profileCpu ? performance.now() - startBegan : 0;
        const cpuStarted = process.cpuUsage();
        const loopStarted = performance.eventLoopUtilization();
        try {
          const stats = await runSessionIngestOnce();
          const loop = performance.eventLoopUtilization(loopStarted);
          const cpu = process.cpuUsage(cpuStarted);
          let cpuProfile = null;
          let profilerStopMs = 0;
          if (profileCpu) {
            const stopBegan = performance.now();
            const { profile } = await profiler.post('Profiler.stop');
            profilerActive = false;
            profilerStopMs = performance.now() - stopBegan;
            cpuProfile = summarizeProfile(profile);
          }
          const observation = fsObservation;
          if (observation) {
            assert.equal(observation.pending, 0);
            assert.equal(observation.maxPending, 1, 'production discovery is sequential');
            // Root + home/sessions/year/month/day for every managed home.
            assert.equal(observation.readdir.calls, workload.homes * 5 + 1);
            assert.equal(observation.stat.calls, workload.homes * workload.filesPerHome);
            for (const bucket of [observation.readdir, observation.stat]) {
              assert.ok(bucket.awaitMs > 0 && bucket.activeMs >= 0 && bucket.idleMs >= 0);
            }
            assert.ok(observation.readdir.awaitMs + observation.stat.awaitMs <= stats.phaseMs.discovery + 1,
              'non-overlapping discovery spans must fit their production phase');
          }
          assert.equal(metadataReads.diagnostics.calls, files.length,
            'reuse the resolved transcript identity instead of rereading diagnostics');
          assert.equal(metadataReads.config.calls, workload.homes,
            'read only the config selected for each managed adv-session row');
          for (const bucket of Object.values(metadataReads)) {
            assert.equal(bucket.completed, bucket.calls);
            assert.equal(bucket.errors, 0);
          }
          assert.equal(metadataReads.diagnostics.bytes, files.length * diagnosticsBytes);
          assert.equal(metadataReads.config.bytes, workload.homes * configBytes);
          return { ...stats, discoveryFs: observation, metadataReads,
            cpuProfile, profilerStartMs, profilerStopMs,
            mainLoopMs: { active: loop.active, idle: loop.idle },
            // Includes all process threads; never label this per-phase JS CPU.
            processCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 } };
        } finally {
          observeDiscovery(false);
          observeMetadata(false);
          // Also stop sampling on an assertion/error path; the private runtime
          // exits after this unit and the inspector is disconnected below.
          if (profilerActive) await profiler.post('Profiler.stop');
        }
      }
      let frozenTail = null;
      let corpusHash = null;
      if (e.TEST_INGEST_CORPUS_PATH) {
        frozenTail = readFileSync(e.TEST_INGEST_CORPUS_PATH);
        corpusHash = createHash('sha256').update(frozenTail).digest('hex');
        assert.equal(corpusHash, e.TEST_INGEST_CORPUS_HASH);
        assert.ok(frozenTail.length > 0 && frozenTail.length < 5 * 1024 * 1024 - 1024);
        assert.equal(frozenTail.at(-1), 10, 'frozen tail must end on a complete record');
        const adapter = FILE_ADAPTERS.find(a => a.sourceKind === 'codex');
        const lines = frozenTail.toString('utf8').trimEnd().split('\n');
        for (const line of lines) JSON.parse(line);
        // Existing parser guards establish parsing correctness. This preflight
        // determines the frozen input's expected output before any private write.
        workload.id = 'frozen-local-codex-tail-v1';
        workload.usefulTurns = lines.filter(line => adapter.parseLine(line)).length * workload.changedFiles;
        workload.parts = lines.reduce((n, line) => n + adapter.parseParts(line).length, 0) * workload.changedFiles;
        assert.ok(workload.usefulTurns > 0 && workload.usefulTurns < 4000);
        assert.ok(workload.parts > 0);
        workload.tailBytesPerFile = frozenTail.length;
        workload.tailLinesPerFile = lines.length;
        workload.corpusHash = corpusHash;
      }
      const workloadHash = createHash('sha256').update(JSON.stringify(workload)).digest('hex');
      const files = [];
      const ids = [];
      const configText = 'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n';
      const configBytes = Buffer.byteLength(configText);
      const diagnosticsText = (h) => JSON.stringify({ lockOwnerSid: 'synthetic-owner-' + h.toString().padStart(3, '0') });
      const diagnosticsBytes = Buffer.byteLength(diagnosticsText(0));
      const prefix = JSON.stringify({ type: 'session_meta', payload: {} }) + '\n';
      const prefixBytes = Buffer.byteLength(prefix);
      const fixtureMtime = Date.now() - 60_000;
      assert.ok(prefixBytes > 0); // the production candidate filter excludes empty files
      for (let h = 0; h < workload.homes; h++) {
        const home = join(e.PAPERCUSP_HOME, 'su-codex-homes', 'session-' + (10000 + h));
        const day = join(home, 'sessions', '2026', '10', '01');
        await mkdir(day, { recursive: true });
        await writeFile(join(home, 'config.toml'), configText);
        await writeFile(join(home, 'papercusp-diagnostics.json'), diagnosticsText(h));
        for (let f = 0; f < workload.filesPerHome; f++) {
          const index = h * workload.filesPerHome + f;
          const id = '019f4fa9-4a09-78c0-8a35-' + index.toString(16).padStart(12, '0');
          const path = join(day, 'rollout-2026-10-01T00-00-00-' + id + '.jsonl');
          await writeFile(path, prefix);
          // Distinct native ids in one home: selection must follow the actual
          // candidate mtime order, not creation order or a shared cached id.
          await utimes(path, (fixtureMtime + index) / 1000, (fixtureMtime + index) / 1000);
          files.push(path);
          ids.push(id);
        }
      }
      const codex = FILE_ADAPTERS.find(adapter => adapter.sourceKind === 'codex');
      const discovered = await Promise.all(codex.roots().map(spec => jsonlAtDepth(spec.root, spec.dirDepth, spec.descend)));
      assert.equal(discovered.flat().length, files.length, 'fixture must use the production discovery layout');
      // Isolate the already-resolved-id seam before changing sweep behavior.
      // Both modes produce the same owner/native-id/model/effort bytes. Keep
      // sampling off and alternate order; CPU includes all child threads.
      const metadataControls = [];
      for (const reuseIdentity of [false, true, true, false]) {
        observeMetadata(true);
        const output = createHash('sha256');
        const cpuBegan = process.cpuUsage();
        const began = performance.now();
        try {
          for (let i = 0; i < files.length; i++) {
            const meta = codexTranscriptMeta(files[i]);
            const adv = codexAdvSessionMetadata(files[i], reuseIdentity ? meta.sessionId : undefined);
            assert.equal(meta.owner, 'synthetic-owner-' + Math.floor(i / workload.filesPerHome).toString().padStart(3, '0'));
            assert.equal(adv.sessionId, ids[i]);
            assert.equal(adv.model, 'gpt-6.1-sol');
            assert.equal(adv.effort, 'xhigh');
            output.update(JSON.stringify({ meta, adv }));
          }
          const cpu = process.cpuUsage(cpuBegan);
          assert.equal(metadataReads.diagnostics.calls, files.length * (reuseIdentity ? 1 : 2));
          assert.equal(metadataReads.config.calls, files.length);
          assert.equal(metadataReads.diagnostics.bytes, diagnosticsBytes * metadataReads.diagnostics.calls);
          assert.equal(metadataReads.config.bytes, configBytes * files.length);
          for (const bucket of Object.values(metadataReads)) {
            assert.equal(bucket.completed, bucket.calls);
            assert.equal(bucket.errors, 0);
          }
          metadataControls.push({ reuseIdentity, profiler: false, wallMs: performance.now() - began,
            processCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
            reads: metadataReads, outputHash: output.digest('hex') });
        } finally { observeMetadata(false); }
      }
      assert.equal(new Set(metadataControls.map(row => row.outputHash)).size, 1);
      console.log('INGEST_METADATA_CONTROLS ' + JSON.stringify({ metadataControls, diagnosticsBytes, configBytes }));
      const { sql } = getOrgPg();
      // Capture the query actually emitted by the production repair. Replaying
      // its bound SQL avoids substituting a SELECT mirror for an UPDATE plan.
      // Only synthetic private fixture values enter this process-local map.
      const ownerQueries = new Map();
      const originalDebug = sql.options.debug;
      sql.options.debug = (connection, query, parameters, types, queryId) => {
        if (typeof originalDebug === 'function') originalDebug(connection, query, parameters, types, queryId);
        if (/^\s*UPDATE harness_shared\.session_turns AS turns/.test(query)) {
          ownerQueries.set(parameters[2], { query, parameters: [...parameters] });
        }
      };
      try {
        const migrated = await sql.unsafe('SELECT count(*)::int AS n FROM harness_shared.schema_migrations');
        assert.ok(migrated[0].n > 0);
        await sql.unsafe([
          'INSERT INTO harness_shared.adv_sessions (id, workspace_id, mode)',
          "SELECT 10000 + h, $1, 'console' FROM generate_series(0, $2::int - 1) AS h",
        ].join(' '), [e.PAPERCUSP_WORKSPACE_ID, workload.homes]);
        await sql.unsafe([
          'INSERT INTO harness_shared.session_ingest_state',
          '(source_kind, file_path, session_id, byte_offset, turn_count, part_count,',
          'counts_backfill_offset, counts_backfilled_at, parts_backfill_offset, parts_backfilled_at)',
          "SELECT 'codex', path, id, $2::bigint, 0, 0, $2::bigint, now(), $2::bigint, now()",
          'FROM jsonb_to_recordset($1::jsonb) AS f(path text, id text)',
        ].join(' '), [JSON.stringify(files.map((path, i) => ({ path, id: ids[i] }))), prefixBytes]);
        const baseline = await runSessionIngestOnce();
        assert.equal(baseline.errors, 0);
        assert.equal(baseline.filesScanned, 4800, JSON.stringify(baseline));
        assert.equal(baseline.filesIngested, 0);
        assert.equal(baseline.turnsInserted, 0);
        const selected = await sql.unsafe([
          "SELECT id, session_id, launch_spec->>'model' AS model, launch_spec->>'effort' AS effort",
          'FROM harness_shared.adv_sessions WHERE workspace_id = $1 ORDER BY id',
        ].join(' '), [e.PAPERCUSP_WORKSPACE_ID]);
        assert.equal(selected.length, workload.homes);
        for (let h = 0; h < workload.homes; h++) {
          assert.equal(Number(selected[h].id), 10000 + h);
          assert.equal(selected[h].session_id, ids[(h + 1) * workload.filesPerHome - 1]);
          assert.equal(selected[h].model, 'gpt-6.1-sol');
          assert.equal(selected[h].effort, 'xhigh');
        }
        const passes = [];
        const matchedUnchanged = [];
        for (let repeat = 0; repeat < workload.repeats; repeat++) {
          const sizes = [];
          for (let i = 0; i < workload.changedFiles; i++) {
            const lines = [];
            for (let part = 0; part < 8; part++) {
              const payload = part === 0 && i < workload.usefulTurns
                ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fixed useful ingestion turn ' + repeat + ':' + i }] }
                : { type: 'function_call_output', call_id: 'fixed-' + i + '-' + part,
                    output: 'fixed tool result ' + 'x'.repeat(1024) };
              lines.push(JSON.stringify({ type: 'response_item', timestamp: '2026-10-01T00:00:00Z', payload }));
            }
            const content = frozenTail
              ? Buffer.concat([Buffer.from(prefix), frozenTail])
              : prefix + lines.join('\n') + '\n';
            // Reset exactly these private offsets for a repeatable new-tail pass.
            await writeFile(files[i], content);
            sizes.push(Buffer.byteLength(content));
          }
          const changedPaths = JSON.stringify(files.slice(0, workload.changedFiles));
          await sql.unsafe([
            'UPDATE harness_shared.session_ingest_state SET byte_offset = $2::bigint,',
            'counts_backfill_offset = $2::bigint, parts_backfill_offset = $2::bigint',
            'WHERE file_path IN (SELECT jsonb_array_elements_text($1::jsonb))',
          ].join(' '), [changedPaths, prefixBytes]);
          const stats = await measuredSweep(observerOrder[repeat], profilerOrder[repeat]);
          assert.equal(stats.errors, 0, JSON.stringify(stats));
          assert.equal(stats.filesScanned, 4800);
          assert.equal(stats.filesIngested, workload.changedFiles);
          assert.equal(stats.turnsInserted, workload.usefulTurns);
          assert.equal(stats.partsInserted, workload.parts);
          assert.equal(stats.countBackfillFiles, 0);
          assert.equal(stats.partsBackfillFiles, 0);
          assert.ok(stats.phaseMs && Object.values(stats.phaseMs).every(n => Number.isFinite(n) && n >= 0));
          const total = Object.values(stats.phaseMs).reduce((sum, ms) => sum + ms, 0);
          assert.ok(Math.abs(total - stats.durationMs) < 1, JSON.stringify(stats));
          assert.ok(stats.phaseMs.discovery > 0 && stats.phaseMs.state > 0 && stats.phaseMs.metadata > 0);
          assert.ok(stats.phaseMs.decode > 0 && stats.phaseMs.writes > 0);
          assert.equal(stats.metadataBackfills.length, 2);
          const owners = stats.metadataBackfills.find(row => row.operation === 'sessionOwners');
          assert.equal(owners.sourceKind, 'codex');
          assert.equal(owners.requested, files.length);
          assert.equal(owners.updated, 0, 'already-correct owners must be a measured no-op');
          assert.equal(owners.status, 'completed');
          const ownerInputs = ownerQueries.get('codex');
          assert.ok(ownerInputs, 'capture the actual driver-bound owner arrays');
          assert.equal(owners.inputSha256,
            createHash('sha256').update(JSON.stringify(ownerInputs.parameters.slice(0, 2))).digest('hex'));
          for (const receipt of stats.metadataBackfills) {
            assert.ok(Number.isFinite(receipt.startedAtMs) && receipt.startedAtMs > 0);
            assert.ok(Number.isFinite(receipt.durationMs) && receipt.durationMs >= 0);
            assert.deepEqual(Object.keys(receipt).sort(),
              ['sourceKind', 'operation', 'requested', 'updated', 'startedAtMs', 'durationMs', 'status',
                ...(receipt.operation === 'sessionOwners' ? ['inputSha256'] : [])].sort());
          }
          const offsets = await sql.unsafe([
            'SELECT file_path, byte_offset::text FROM harness_shared.session_ingest_state',
            'WHERE file_path IN (SELECT jsonb_array_elements_text($1::jsonb))',
          ].join(' '), [changedPaths]);
          const byPath = new Map(offsets.map(r => [r.file_path, Number(r.byte_offset)]));
          for (let i = 0; i < workload.changedFiles; i++) assert.equal(byPath.get(files[i]), sizes[i]);
          passes.push(stats);
          // Repair must still run for unchanged bytes, and its reported count
          // must be the real UPDATE count, not candidates or parameter count.
          const damaged = await sql.unsafe([
            "UPDATE harness_shared.session_turns SET owner = 'stale-owner'",
            "WHERE source_kind = 'codex' AND session_id = $1",
            'AND turn_idx = (SELECT min(turn_idx) FROM harness_shared.session_turns',
            "WHERE source_kind = 'codex' AND session_id = $1)",
          ].join(' '), [ids[0]]);
          assert.equal(damaged.count, 1);
          const noTail = await measuredSweep(observerOrder[repeat], profilerOrder[repeat]);
          assert.equal(noTail.errors, 0);
          assert.equal(noTail.filesScanned, files.length);
          assert.equal(noTail.filesIngested, 0);
          assert.equal(noTail.turnsInserted, 0);
          assert.equal(noTail.partsInserted ?? 0, 0);
          assert.equal(noTail.phaseMs.decode, 0);
          assert.equal(noTail.phaseMs.writes, 0);
          assert.equal(noTail.metadataBackfills.find(row => row.operation === 'sessionOwners').updated, 1);
          assert.equal(noTail.metadataBackfills.find(row => row.operation === 'sessionOwners').inputSha256,
            owners.inputSha256, 'unchanged adapter inputs retain their fingerprint after a turn-owner repair');
          const repaired = await sql.unsafe(
            "SELECT owner FROM harness_shared.session_turns WHERE source_kind = 'codex' AND session_id = $1 AND turn_idx = (SELECT min(turn_idx) FROM harness_shared.session_turns WHERE source_kind = 'codex' AND session_id = $1)",
            [ids[0]]);
          assert.equal(repaired[0].owner, 'synthetic-owner-000');
          matchedUnchanged.push(noTail);
        }
        const rows = await sql.unsafe("SELECT count(*)::int AS n FROM harness_shared.session_turns WHERE source_kind = 'codex'");
        const parts = await sql.unsafe("SELECT count(*)::int AS n FROM harness_shared.session_turn_parts WHERE source_kind = 'codex'");
        assert.equal(rows[0].n, workload.usefulTurns * workload.repeats);
        assert.equal(parts[0].n, workload.parts * workload.repeats);
        const unchanged = await runSessionIngestOnce();
        assert.equal(unchanged.errors, 0);
        assert.equal(unchanged.filesScanned, 4800);
        assert.equal(unchanged.filesIngested, 0);
        assert.equal(unchanged.turnsInserted, 0);
        assert.equal(unchanged.partsInserted ?? 0, 0);
        assert.equal(unchanged.phaseMs.decode, 0);
        assert.equal(unchanged.phaseMs.writes, 0);
        const singleFileRepairs = [];
        for (const opts of [{}, { sessionId: ids[0] }]) {
          observeMetadata(true);
          try {
            const repair = await ingestFileNow(files[0], opts);
            assert.equal(repair.inserted, 0, 'metadata-only repair must not duplicate turns');
            assert.equal(metadataReads.diagnostics.calls, 1);
            assert.equal(metadataReads.config.calls, 1);
            assert.equal(metadataReads.diagnostics.bytes, diagnosticsBytes);
            assert.equal(metadataReads.config.bytes, configBytes);
            for (const bucket of Object.values(metadataReads)) {
              assert.equal(bucket.completed, 1);
              assert.equal(bucket.errors, 0);
            }
            singleFileRepairs.push({ explicitIdentity: !!opts.sessionId, repair, reads: metadataReads });
          } finally { observeMetadata(false); }
        }
        // A sweep-local selection is not a process cache. A malformed newer
        // rollout must not occupy the home; the first valid native id wins,
        // missing config stays fail-soft, and the next sweep sees fresh config.
        const firstHome = join(managedRoot, 'session-10000');
        const configPath = join(firstHome, 'config.toml');
        const invalidPath = join(firstHome, 'sessions', '2026', '10', '01', 'rollout-not-a-native-id.jsonl');
        await writeFile(invalidPath, prefix);
        const latestMtime = (Date.now() + 1000) / 1000;
        await utimes(files[0], latestMtime, latestMtime);
        await utimes(invalidPath, latestMtime + 1, latestMtime + 1);
        async function resetLaunchMetadata(spec) {
          await sql.unsafe('UPDATE harness_shared.adv_sessions SET session_id = NULL, launch_spec = $1::jsonb WHERE id = 10000',
            [spec == null ? null : JSON.stringify(spec)]);
        }
        async function metadataRepairSweep() {
          observeMetadata(true);
          try {
            const stats = await runSessionIngestOnce();
            assert.equal(stats.errors, 0, JSON.stringify(stats));
            assert.equal(stats.turnsInserted, 0);
            assert.equal(stats.partsInserted ?? 0, 0);
            assert.equal(metadataReads.config.calls, workload.homes);
            const [row] = await sql.unsafe([
              "SELECT session_id, launch_spec->>'model' AS model, launch_spec->>'effort' AS effort",
              'FROM harness_shared.adv_sessions WHERE id = 10000',
            ].join(' '));
            assert.equal(row.session_id, ids[0], 'invalid newer rollout cannot prevent the first valid native-id repair');
            return { row, reads: metadataReads };
          } finally { observeMetadata(false); }
        }
        await resetLaunchMetadata(null);
        await rm(configPath);
        const missingConfig = await metadataRepairSweep();
        assert.equal(missingConfig.row.model, null);
        assert.equal(missingConfig.row.effort, null);
        assert.equal(missingConfig.reads.config.errors, 1, 'one failed read per selected home, not one per rollout');
        await writeFile(configPath, 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n');
        await resetLaunchMetadata(null);
        const freshConfig = await metadataRepairSweep();
        assert.equal(freshConfig.row.model, 'gpt-5.6-sol');
        assert.equal(freshConfig.row.effort, 'high');
        assert.equal(freshConfig.reads.config.errors, 0);
        await resetLaunchMetadata({ model: 'explicit-launch-model', effort: 'low' });
        const explicitLaunch = await metadataRepairSweep();
        assert.equal(explicitLaunch.row.model, 'explicit-launch-model');
        assert.equal(explicitLaunch.row.effort, 'low');
        await rm(invalidPath);
        const configSelection = { selectedRows: selected.length,
          selectedNativeIdsHash: createHash('sha256').update(JSON.stringify(selected)).digest('hex'),
          missingConfig, freshConfig, explicitLaunch };

        // The naturally slow statement was the Claude owner repair. Exercise
        // that adapter's real managed-home layout, including an EOF-only repair,
        // rather than inferring its behavior from Codex launch metadata.
        const claudeCount = 179;
        // Synthetic density matches the measured ordered sample's aggregate
        // shape (179 sessions / 4099 turns / min 1 / median 13 / max 156).
        // This is not the original per-session distribution or heap/cache state.
        const claudeTurnCounts = [1, ...Array(90).fill(13), ...Array(12).fill(31), ...Array(75).fill(32), 156];
        const claudeTurns = claudeTurnCounts.reduce((sum, n) => sum + n, 0);
        assert.equal(claudeTurnCounts.length, claudeCount);
        assert.equal(claudeTurns, 4099);
        assert.equal(claudeTurnCounts[89], 13);
        const claudeDay = join(e.PAPERCUSP_HOME, 'session-claude', 'private-claude-owner', 'projects', 'private-cwd');
        await mkdir(claudeDay, { recursive: true });
        for (let i = 0; i < claudeCount; i++) {
          const id = 'private-claude-owner-' + i;
          await writeFile(join(claudeDay, id + '.jsonl'), Array.from({ length: claudeTurnCounts[i] }, (_, turn) => JSON.stringify({
            type: 'user', uuid: id + '-turn-' + turn, timestamp: '2026-10-01T00:00:00Z',
            message: { role: 'user', content: 'Synthetic private Claude owner repair turn ' + i + '/' + turn },
          })).join('\n') + '\n');
        }
        const claudeUseful = await runSessionIngestOnce();
        assert.equal(claudeUseful.errors, 0, JSON.stringify(claudeUseful));
        // The production 4000-turn sweep budget deliberately splits this
        // 4099-turn fixture. Drain one continuation, rather than raising that
        // budget or mistaking a valid partial sweep for missing indexed turns.
        assert.ok(claudeUseful.turnsInserted > 0 && claudeUseful.turnsInserted < claudeTurns);
        assert.equal(claudeUseful.metadataBackfills.find(r => r.sourceKind === 'claude' && r.operation === 'sessionOwners').requested,
          claudeCount, 'a partial transcript budget must not truncate the Claude owner repair map');
        const claudeContinuation = await runSessionIngestOnce();
        assert.equal(claudeContinuation.errors, 0, JSON.stringify(claudeContinuation));
        assert.ok(claudeContinuation.turnsInserted > 0);
        assert.equal(claudeUseful.turnsInserted + claudeContinuation.turnsInserted, claudeTurns);
        assert.equal(claudeContinuation.metadataBackfills.find(r => r.sourceKind === 'claude').requested, claudeCount);
        assert.equal(claudeUseful.metadataBackfills.find(r => r.sourceKind === 'claude' && r.operation === 'sessionOwners').inputSha256,
          claudeContinuation.metadataBackfills.find(r => r.sourceKind === 'claude' && r.operation === 'sessionOwners').inputSha256,
          'partial and full sweeps must bind the same complete Claude owner map');
        const damagedClaude = await sql.unsafe(
          "UPDATE harness_shared.session_turns SET owner = 'stale-private-owner' WHERE source_kind = 'claude'");
        assert.equal(damagedClaude.count, claudeTurns);
        const claudeNoTail = await runSessionIngestOnce();
        assert.equal(claudeNoTail.errors, 0, JSON.stringify(claudeNoTail));
        assert.equal(claudeNoTail.filesIngested, 0);
        assert.equal(claudeNoTail.turnsInserted, 0);
        assert.equal(claudeNoTail.partsInserted ?? 0, 0);
        const claudeRepair = claudeNoTail.metadataBackfills.find(r => r.sourceKind === 'claude');
        assert.equal(claudeRepair.operation, 'sessionOwners');
        assert.equal(claudeRepair.updated, claudeTurns);
        assert.equal(claudeRepair.status, 'completed');
        const captured = ownerQueries.get('claude');
        assert.ok(captured, 'capture the real source UPDATE and bound Claude parameters');
        assert.ok(captured.query.includes('UNNEST('));
        assert.equal(claudeRepair.inputSha256,
          createHash('sha256').update(JSON.stringify(captured.parameters.slice(0, 2))).digest('hex'),
          'Claude receipt fingerprints the exact bound arrays, including the current candidate order');
        const beforeReplay = await sql.unsafe(
          "SELECT session_id, turn_idx, owner, xmin::text FROM harness_shared.session_turns WHERE source_kind = 'claude' ORDER BY session_id, turn_idx");
        assert.equal(beforeReplay.length, claudeTurns);
        assert.ok(beforeReplay.every(row => row.owner === 'private-claude-owner'));
        const ownerUpdatePlans = await sql.begin(async tx => {
          await tx.unsafe("SET LOCAL statement_timeout = '10s'");
          const cardinality = await tx.unsafe('SELECT cardinality($1::text[]) AS sessions, cardinality($2::text[]) AS owners',
            captured.parameters.slice(0, 2));
          assert.equal(cardinality[0].sessions, claudeCount);
          assert.equal(cardinality[0].owners, claudeCount);
          await tx.unsafe("UPDATE harness_shared.session_turns SET owner = 'stale-private-owner' WHERE source_kind = 'claude'");
          const plans = [];
          for (const expectedUpdates of [claudeTurns, 0]) {
            const result = await tx.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + captured.query, captured.parameters);
            const explained = result[0]['QUERY PLAN'][0];
            const plan = explained.Plan;
            assert.equal(plan['Node Type'], 'ModifyTable');
            assert.equal(plan.Operation, 'Update');
            assert.equal(plan['Relation Name'], 'session_turns');
            // PostgreSQL UPDATE without RETURNING emits no root rows; count
            // changed owners in private state instead of misreading that field.
            const changed = await tx.unsafe(
              "SELECT count(*)::int AS n FROM harness_shared.session_turns WHERE source_kind = 'claude' AND owner = 'private-claude-owner'");
            assert.equal(changed[0].n, claudeTurns);
            const flatten = node => [{
              nodeType: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'],
              rows: node['Actual Rows'], loops: node['Actual Loops'], removedByFilter: node['Rows Removed by Filter'] ?? 0,
              sharedHitBlocks: node['Shared Hit Blocks'] ?? 0, sharedReadBlocks: node['Shared Read Blocks'] ?? 0,
              sharedDirtiedBlocks: node['Shared Dirtied Blocks'] ?? 0, sharedWrittenBlocks: node['Shared Written Blocks'] ?? 0,
            }, ...(node.Plans ?? []).flatMap(flatten)];
            plans.push({ expectedUpdates, executionMs: explained['Execution Time'],
              planningMs: explained['Planning Time'], nodes: flatten(plan) });
            assert.equal(plan.Plans[0]['Actual Rows'] * plan.Plans[0]['Actual Loops'], expectedUpdates);
          }
          await tx.unsafe('ROLLBACK');
          return plans;
        });
        const afterReplay = await sql.unsafe(
          "SELECT session_id, turn_idx, owner, xmin::text FROM harness_shared.session_turns WHERE source_kind = 'claude' ORDER BY session_id, turn_idx");
        assert.deepEqual(afterReplay, beforeReplay, 'EXPLAIN ANALYZE repair and no-op leave no committed mutation');
        const ownerRepairControl = { sourceKind: 'claude', requested: claudeCount,
          turns: claudeTurns, turnDensity: { min: claudeTurnCounts[0], median: claudeTurnCounts[89], max: claudeTurnCounts.at(-1) },
          sqlHash: createHash('sha256').update(captured.query).digest('hex'),
          parameterHash: createHash('sha256').update(JSON.stringify(captured.parameters)).digest('hex'),
          useful: claudeUseful, continuation: claudeContinuation, noTail: claudeNoTail,
          plans: ownerUpdatePlans, rollbackPreserved: true };
        // A fork seeds a copy of its source transcript under a different owner
        // without changing the native id. Make the born file newer so the old
        // newest-first/Map-overwrite path incorrectly selected the fork seed.
        const bornId = '019f4fa9-4a09-78c0-8a35-ffff00000001';
        const bornOwner = 'private-claude-born';
        const forkOwner = 'private-claude-fork';
        const bornDir = join(e.PAPERCUSP_HOME, 'session-claude', bornOwner, 'projects', 'private-cwd');
        const forkDir = join(e.PAPERCUSP_HOME, 'session-claude', forkOwner, 'projects', 'private-cwd');
        const ownerIndex = join(e.PAPERCUSP_HOME, 'psu-session-owners');
        await Promise.all([mkdir(bornDir, { recursive: true }), mkdir(forkDir, { recursive: true }),
          mkdir(ownerIndex, { recursive: true })]);
        const forkLine = JSON.stringify({ type: 'user', uuid: bornId + '-turn-0',
          timestamp: '2026-10-01T00:00:00Z', message: { role: 'user', content: 'Synthetic born-owner fork seed transcript turn' } }) + '\n';
        const bornPath = join(bornDir, bornId + '.jsonl');
        const forkPath = join(forkDir, bornId + '.jsonl');
        await Promise.all([writeFile(bornPath, forkLine), writeFile(forkPath, forkLine),
          writeFile(join(ownerIndex, bornId), JSON.stringify({ v: 1, ownerId: bornOwner }) + '\n')]);
        const now = Date.now();
        await utimes(forkPath, (now - 60_000) / 1000, (now - 60_000) / 1000);
        await utimes(bornPath, now / 1000, now / 1000);
        const seeded = await runSessionIngestOnce();
        assert.equal(seeded.errors, 0, JSON.stringify(seeded));
        const seededRows = await sql.unsafe(
          'SELECT owner FROM harness_shared.session_turns WHERE source_kind = $1 AND session_id = $2',
          ['claude', bornId]);
        assert.equal(seededRows.length, 1);
        assert.equal(seededRows[0].owner, bornOwner, 'fork seed must not replace the born transcript owner');
        await sql.unsafe('UPDATE harness_shared.session_turns SET owner = $1 WHERE source_kind = $2 AND session_id = $3',
          [forkOwner, 'claude', bornId]);
        const repairedSeed = await runSessionIngestOnce();
        assert.equal(repairedSeed.errors, 0, JSON.stringify(repairedSeed));
        const repairedRows = await sql.unsafe(
          'SELECT owner FROM harness_shared.session_turns WHERE source_kind = $1 AND session_id = $2',
          ['claude', bornId]);
        assert.deepEqual(repairedRows.map(row => row.owner), [bornOwner],
          'EOF-only owner backfill must keep the birth identity');
        await writeFile(forkPath, forkLine + JSON.stringify({ type: 'user', uuid: bornId + '-turn-1',
          timestamp: '2026-10-01T00:00:01Z', message: { role: 'user', content: 'Synthetic fork seed appended turn' } }) + '\n');
        const singleFile = await ingestFileNow(forkPath);
        assert.equal(singleFile.inserted, 1);
        const singleFileRows = await sql.unsafe(
          'SELECT owner FROM harness_shared.session_turns WHERE source_kind = $1 AND session_id = $2 ORDER BY turn_idx',
          ['claude', bornId]);
        assert.deepEqual(singleFileRows.map(row => row.owner), [bornOwner, bornOwner],
          'read-time single-file ingest must use the same birth identity');
        await rm(bornPath);
        await sql.unsafe('UPDATE harness_shared.session_turns SET owner = $1 WHERE source_kind = $2 AND session_id = $3',
          [forkOwner, 'claude', bornId]);
        const damagedParts = await sql.unsafe(
          'UPDATE harness_shared.session_turn_parts SET owner = $1 WHERE source_kind = $2 AND session_id = $3',
          [forkOwner, 'claude', bornId]);
        assert.ok(damagedParts.count > 0, 'the companion parts index must exercise its repair');
        const archivedBorn = await runSessionIngestOnce();
        assert.equal(archivedBorn.errors, 0, JSON.stringify(archivedBorn));
        assert.equal(archivedBorn.metadataBackfills.find(r => r.sourceKind === 'claude' && r.operation === 'partOwners').updated,
          damagedParts.count);
        const archiveRows = await sql.unsafe(
          'SELECT owner FROM harness_shared.session_turns WHERE source_kind = $1 AND session_id = $2 ORDER BY turn_idx',
          ['claude', bornId]);
        assert.deepEqual(archiveRows.map(row => row.owner), [bornOwner, bornOwner],
          'fork seed alone must retain birth identity after the original file is archived');
        const archiveParts = await sql.unsafe(
          'SELECT owner FROM harness_shared.session_turn_parts WHERE source_kind = $1 AND session_id = $2',
          ['claude', bornId]);
        assert.ok(archiveParts.length > 0 && archiveParts.every(row => row.owner === bornOwner),
          'faithful parts must retain birth identity after the original file is archived');
        if (corpusHash) assert.equal(corpusHash,
          createHash('sha256').update(readFileSync(e.TEST_INGEST_CORPUS_PATH)).digest('hex'));
        assert.equal(sourceHash, createHash('sha256').update(readFileSync('packages/operator-core/lib/search/session-ingest.ts')).digest('hex'));
        console.log('INGEST_RUNTIME_PROBE ' + JSON.stringify({
          sourceHash, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
          workload, workloadHash, observerOrder, profilerOrder, metadataControls, configSelection, ownerRepairControl,
          metadataFixtureHash: createHash('sha256').update(configText + diagnosticsText(0)).digest('hex'),
          baseline, passes, matchedUnchanged, unchanged, singleFileRepairs,
          child: { pid: process.pid, node: process.version, backgroundWorkers: e.PAPERCUSP_BACKGROUND_WORKERS },
          privateRows: rows[0].n, privateParts: parts[0].n, home: e.HOME, dbPort: dbUrl.port,
        }));
      } finally { sql.options.debug = originalDebug; profiler?.disconnect(); await sql.end(); }
    `;
    // Reject malformed probe JavaScript before the costly migrated runtime boot.
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: probe, encoding: 'utf8', timeout: 10_000,
    });
    expect(syntax.status, syntax.stderr).toBe(0);
    const runId = await recordIsolatedIntegrationProof({
      root,
      filePath: 'packages/operator-core/lib/search/session-ingest-runtime.integration.test.ts',
      sourcePaths: ['scripts/with-test-pg.mjs', 'packages/operator-core/lib/search/session-ingest.ts',
        'packages/operator-core/test/isolated-integration-proof.ts'],
      retainedArtifacts: ['phases/execute/worker.log', 'phases/execute/worker-result.json',
        'phases/execute/runtime-events.ndjson', 'phases/execute/ingest-runtime-receipt.json'],
      prepare: evidenceDir => {
        // These are named byte anchors; they do not certify a complete import graph.
        if (!process.env.NODE_OPTIONS?.includes('committed-source-loader.mjs')) return;
        const original = JSON.parse(readFileSync(join(evidenceDir, 'source.json'), 'utf8')) as {
          files: Array<{ path: string; sha256: string; gitSha256: string | null }>;
        };
        const runtimePaths = ['scripts/with-test-pg.mjs', 'scripts/lib/with-test-pg-cleanup.mjs',
          'scripts/lib/isolated-runtime-start.mjs', 'packages/operator-core/lib/search/session-ingest.ts',
          'packages/operator-core/test/isolated-integration-proof.ts'];
        expect(runtimePaths.filter(path => {
          const file = original.files.find(entry => entry.path === path);
          return !file || file.sha256 !== file.gitSha256;
        }), 'Named runtime sources must be committed before the inherited loader can execute their current bytes')
          .toEqual([]);
      },
      execute: async (observe, evidenceDir) => {
        const child = fork(resolve(root, 'scripts/with-test-pg.mjs'), ['--isolated-runtime', '--',
          process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe], {
          cwd: root, detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1',
            TEST_INGEST_SOURCE_HASH: sourceHash, TEST_LIVE_HOME: process.env.HOME ?? '',
            TEST_INGEST_CORPUS_HASH: corpusHash, TEST_INGEST_SAMPLE_CPU: sampleCpu ? '1' : '0' },
        });
        observe(child);
        const result = await captureIsolatedWorker(child, evidenceDir, options);
        expect(result, isolatedWorkerFailureDetail(result.output)).toMatchObject({
          code: 0, signal: null, timedOut: false, exitWaitTimedOut: false, stdioDrainTimedOut: false,
        });
        const dataDir = result.output.match(/datadir ([^)]+)\)/)?.[1];
        expect(dataDir).toBeTruthy();
        expect(existsSync(dataDir!)).toBe(false);
        const environment = result.output.match(/^INGEST_RUNTIME_ENV (.+)$/m)?.[1];
        expect(environment, 'Original worker environment receipt is required').toBeTruthy();
        expect(existsSync(JSON.parse(environment!).home)).toBe(false);
        const receipt = result.output.match(/^INGEST_RUNTIME_PROBE (.+)$/m)?.[1];
        expect(receipt, isolatedWorkerFailureDetail(result.output)).toBeTruthy();
        const evidence = JSON.parse(receipt!) as { sourceHash: string; home: string; dbPort: string };
        expect(evidence.sourceHash).toBe(sourceHash);
        expect(existsSync(evidence.home)).toBe(false);
        const stopped = spawnSync(process.execPath, ['-e',
          "const net=require('node:net');const s=net.createConnection({host:'localhost',port:Number(process.argv[1])});" +
          "s.on('connect',()=>{s.destroy();process.exitCode=1;});" +
          "s.on('error',e=>{if(e.code!=='ECONNREFUSED'){console.error(e.code);process.exitCode=1;}});",
          evidence.dbPort,
        ], { encoding: 'utf8', timeout: 10_000 });
        expect(stopped.status, stopped.stderr).toBe(0);
        const cleanup = { ...evidence, homeRemoved: true, dataDirRemoved: true, dbPortClosed: true };
        writeFileSync(join(evidenceDir, 'ingest-runtime-receipt.json'), JSON.stringify(cleanup), { flag: 'wx' });
        expect(JSON.parse(readFileSync(join(evidenceDir, 'ingest-runtime-receipt.json'), 'utf8'))).toEqual(cleanup);
        console.log('INGEST_RUNTIME_RECEIPT', JSON.stringify(cleanup));
      },
    });
    Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  });
});
