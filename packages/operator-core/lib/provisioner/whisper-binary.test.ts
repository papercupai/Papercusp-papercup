import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile as fsWriteFile, readFile as fsReadFile, symlink, readlink, readFile as fsReadThrough } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DetectedHardware } from './hardware-detect';
import type { GhRelease, ExecFn, PlatformSpec } from './llama-binary';
import {
  whisperPlatformSpec,
  whisperAssetNameRules,
  pickWhisperPrebuiltAsset,
  whisperBuildCommands,
  renderWhisperServerArgs,
  whisperInferenceThreadsForCpuCount,
  whisperModelUrl,
  whisperModelCacheDir,
  resolveWhisperModel,
  downloadWhisperModel,
  resolveWhisperBinary,
  WHISPER_SERVER_DEFAULT_PORT,
  WHISPER_MAX_SERVER_TASKS,
  DEFAULT_WHISPER_MODEL,
  type WhisperModelManifest,
} from './whisper-binary';

// The REAL ggml-org/whisper.cpp v1.9.1 release asset list (fetched live 2026-07-12) — the
// fixture the rules are validated against, so a naming-convention change upstream is a test
// update here, not a silent mismatch in production.
const REAL_V191_ASSETS = [
  'whisper-bin-ubuntu-arm64.tar.gz',
  'whisper-bin-ubuntu-x64.tar.gz',
  'whisper-bin-Win32.zip',
  'whisper-bin-x64.zip',
  'whisper-blas-bin-Win32.zip',
  'whisper-blas-bin-x64.zip',
  'whisper-cublas-11.8.0-bin-x64.zip',
  'whisper-cublas-12.4.0-bin-x64.zip',
  'whisper-v1.9.1-xcframework.zip',
];

function release(assets: string[] = REAL_V191_ASSETS, tag = 'v1.9.1'): GhRelease {
  return { tag_name: tag, assets: assets.map((name) => ({ name, browser_download_url: `https://example.com/${name}` })) };
}

// ---------------------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------------------

describe('whisperPlatformSpec', () => {
  const base: DetectedHardware = { platform: 'linux', arch: 'x64', ramGB: 64, gpu: null, notes: [] };

  it("Linux + NVIDIA normalizes to CPU — whisper ships CPU-first on Linux (this box's proven --no-gpu config)", () => {
    const hw: DetectedHardware = { ...base, gpu: { vendor: 'nvidia', model: 'NVIDIA GeForce RTX 3090', vramGB: 24, computeCap: '8.6' } };
    expect(whisperPlatformSpec(hw, '12.0')).toEqual({ os: 'linux', arch: 'x64', gpuVendor: 'none', cudaVersion: undefined });
  });

  it('darwin keeps apple (Metal source build); win32+nvidia keeps the cuda version (cuBLAS asset pick)', () => {
    const mac: DetectedHardware = { ...base, platform: 'darwin', arch: 'arm64', gpu: { vendor: 'apple', vramGB: 36, unifiedMemory: true } };
    expect(whisperPlatformSpec(mac)).toEqual({ os: 'darwin', arch: 'arm64', gpuVendor: 'apple', cudaVersion: undefined });
    const win: DetectedHardware = { ...base, platform: 'win32', gpu: { vendor: 'nvidia', model: 'RTX 4080', vramGB: 16 } };
    expect(whisperPlatformSpec(win, '12.4')).toEqual({ os: 'win32', arch: 'x64', gpuVendor: 'nvidia', cudaVersion: '12.4' });
  });
});

describe('whisperAssetNameRules + pickWhisperPrebuiltAsset (against the real v1.9.1 asset list)', () => {
  it('Linux x64 → the ubuntu-x64 tarball (CPU prebuilt exists — unlike llama.cpp)', () => {
    const spec: PlatformSpec = { os: 'linux', arch: 'x64', gpuVendor: 'none' };
    expect(pickWhisperPrebuiltAsset(release(), spec)?.name).toBe('whisper-bin-ubuntu-x64.tar.gz');
  });

  it('Linux arm64 → the ubuntu-arm64 tarball', () => {
    const spec: PlatformSpec = { os: 'linux', arch: 'arm64', gpuVendor: 'none' };
    expect(pickWhisperPrebuiltAsset(release(), spec)?.name).toBe('whisper-bin-ubuntu-arm64.tar.gz');
  });

  it('a Linux NVIDIA box still resolves the CPU asset (via whisperPlatformSpec normalization)', () => {
    const hw: DetectedHardware = {
      platform: 'linux',
      arch: 'x64',
      ramGB: 64,
      gpu: { vendor: 'nvidia', model: 'RTX 3090', vramGB: 24, computeCap: '8.6' },
      notes: [],
    };
    expect(pickWhisperPrebuiltAsset(release(), whisperPlatformSpec(hw, '12.0'))?.name).toBe('whisper-bin-ubuntu-x64.tar.gz');
  });

  it('Windows + NVIDIA: exact cuda-version cuBLAS asset first', () => {
    const spec: PlatformSpec = { os: 'win32', arch: 'x64', gpuVendor: 'nvidia', cudaVersion: '12.4' };
    expect(pickWhisperPrebuiltAsset(release(), spec)?.name).toBe('whisper-cublas-12.4.0-bin-x64.zip');
    const spec118: PlatformSpec = { ...spec, cudaVersion: '11.8' };
    expect(pickWhisperPrebuiltAsset(release(), spec118)?.name).toBe('whisper-cublas-11.8.0-bin-x64.zip');
  });

  it('Windows + NVIDIA with an unmatched toolkit version falls back to ANY cublas asset', () => {
    const spec: PlatformSpec = { os: 'win32', arch: 'x64', gpuVendor: 'nvidia', cudaVersion: '13.0' };
    expect(pickWhisperPrebuiltAsset(release(), spec)?.name).toMatch(/cublas/);
  });

  it('Windows without NVIDIA: the BLAS build beats plain, and NEVER matches a cublas asset by substring', () => {
    const spec: PlatformSpec = { os: 'win32', arch: 'x64', gpuVendor: 'none' };
    expect(pickWhisperPrebuiltAsset(release(), spec)?.name).toBe('whisper-blas-bin-x64.zip');
    // Remove the blas asset: the plain x64 zip is the fallback — not Win32, not cublas.
    const noBlast = REAL_V191_ASSETS.filter((n) => n !== 'whisper-blas-bin-x64.zip');
    expect(pickWhisperPrebuiltAsset(release(noBlast), spec)?.name).toBe('whisper-bin-x64.zip');
  });

  it('darwin has NO rule (the xcframework is a library, not whisper-server) → source build', () => {
    const spec: PlatformSpec = { os: 'darwin', arch: 'arm64', gpuVendor: 'apple' };
    expect(whisperAssetNameRules(spec)).toEqual([]);
    expect(pickWhisperPrebuiltAsset(release(), spec)).toBeNull();
  });

  it('win32 arm64 has no published asset → source build', () => {
    const spec: PlatformSpec = { os: 'win32', arch: 'arm64', gpuVendor: 'none' };
    expect(pickWhisperPrebuiltAsset(release(), spec)).toBeNull();
  });
});

describe('whisperBuildCommands', () => {
  it('renders a static (self-contained) release build — BUILD_SHARED_LIBS=OFF is load-bearing', () => {
    expect(whisperBuildCommands({ sourceDir: '/src/whisper.cpp', buildDir: '/src/whisper.cpp/build-darwin-arm64-metal', jobs: 8 })).toEqual([
      ['cmake', '-S', '/src/whisper.cpp', '-B', '/src/whisper.cpp/build-darwin-arm64-metal', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF'],
      ['cmake', '--build', '/src/whisper.cpp/build-darwin-arm64-metal', '--config', 'Release', '-j', '8'],
    ]);
  });
});

describe('renderWhisperServerArgs', () => {
  it('preserves explicit serve options on a small host', () => {
    const args = renderWhisperServerArgs({ modelPath: '/m/ggml-base.bin', host: '0.0.0.0', port: 2022, threads: 4, noGpu: true }, 8);
    expect(args).toEqual([
      '--host', '0.0.0.0',
      '--port', '2022',
      '--model', '/m/ggml-base.bin',
      '--inference-path', '/v1/audio/transcriptions',
      '--threads', '4',
      '--convert',
      '--no-gpu',
    ]);
  });

  it('defaults: loopback host, the VOICEMODE seam port, convert ON, no --no-gpu', () => {
    const args = renderWhisperServerArgs({ modelPath: '/m/ggml-base.bin', threads: 4 });
    expect(args).toContain('--convert');
    expect(args).not.toContain('--no-gpu');
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(args[args.indexOf('--port') + 1]).toBe(String(WHISPER_SERVER_DEFAULT_PORT));
  });

  it('bounds HTTP-worker × inference-thread fan-out on high-core hosts', () => {
    const args = renderWhisperServerArgs({ modelPath: '/m/ggml-base.bin', threads: 16 }, 128);
    const threads = Number(args[args.indexOf('--threads') + 1]);
    expect(threads).toBe(2);
    expect(127 * threads + 2).toBeLessThanOrEqual(WHISPER_MAX_SERVER_TASKS);
  });

  it('keeps projected server tasks within budget across representative CPU counts', () => {
    for (const cpuCount of [1, 8, 16, 32, 128, 255]) {
      const httpWorkers = Math.max(8, cpuCount - 1);
      const threads = whisperInferenceThreadsForCpuCount(cpuCount, 16);
      expect(threads).toBeGreaterThanOrEqual(1);
      expect(httpWorkers * threads + 2).toBeLessThanOrEqual(WHISPER_MAX_SERVER_TASKS);
    }
    expect(whisperInferenceThreadsForCpuCount(16, 16)).toBe(15);
    expect(whisperInferenceThreadsForCpuCount(32, 16)).toBe(8);
  });
});

// ---------------------------------------------------------------------------------------
// Model weights — read-side plan + write-side download (temp dirs, injected download)
// ---------------------------------------------------------------------------------------

describe('resolveWhisperModel / downloadWhisperModel', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'whisper-model-test-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('defaults to the dev-box-proven base model and points at the canonical HF mirror', () => {
    expect(DEFAULT_WHISPER_MODEL).toBe('base');
    expect(whisperModelUrl('base')).toBe('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin');
  });

  it('finds an existing external install (voicemode-shaped root) without a manifest', async () => {
    const vmRoot = join(home, '.voicemode/services/whisper/models');
    await mkdir(vmRoot, { recursive: true });
    await fsWriteFile(join(vmRoot, 'ggml-base.bin'), 'fake-weights');
    const plan = await resolveWhisperModel('base', { home });
    expect(plan.needsDownload).toBe(false);
    expect(plan.weightsPath).toBe(join(vmRoot, 'ggml-base.bin'));
  });

  it('plans a download (with size messaging + the HF pull hint) when nothing exists locally', async () => {
    const plan = await resolveWhisperModel('base', { home });
    expect(plan.needsDownload).toBe(true);
    expect(plan.pullHint).toContain('huggingface.co');
    expect(plan.pullHint).toContain('ggml-base.bin');
    expect(plan.detail).toContain('148');
  });

  it('download writes the weights + sha256 sidecar; a later resolve is a verified cache hit', async () => {
    const dl = await downloadWhisperModel('base', {
      home,
      download: async (_url, destPath) => {
        await fsWriteFile(destPath, 'fake-weights-bytes');
        return { bytesWritten: 17, sha256: 'ignored-recorded-verbatim' };
      },
      now: () => '2026-07-12T00:00:00.000Z',
    });
    expect(dl.ok).toBe(true);
    expect(dl.weightsPath).toBe(join(whisperModelCacheDir(home), 'ggml-base.bin'));
    const manifest = JSON.parse(await fsReadFile(`${dl.weightsPath}.manifest.json`, 'utf8')) as WhisperModelManifest;
    expect(manifest.model).toBe('base');
    expect(manifest.sha256).toBe('ignored-recorded-verbatim');

    // Resolve verifies against the sidecar — inject a hashFile that agrees.
    const plan = await resolveWhisperModel('base', { home, hashFile: async () => 'ignored-recorded-verbatim' });
    expect(plan.needsDownload).toBe(false);
    expect(plan.weightsPath).toBe(dl.weightsPath);
  });

  it('a tampered cached model (hash mismatch vs its own sidecar) is re-download, never silently served', async () => {
    await downloadWhisperModel('base', {
      home,
      download: async (_url, destPath) => {
        await fsWriteFile(destPath, 'original');
        return { bytesWritten: 8, sha256: 'recorded-sha' };
      },
    });
    const plan = await resolveWhisperModel('base', { home, hashFile: async () => 'DIFFERENT-sha' });
    expect(plan.needsDownload).toBe(true);
    expect(plan.detail).toMatch(/no longer matches/);
  });

  it('download failure is blocked (not thrown)', async () => {
    const dl = await downloadWhisperModel('base', {
      home,
      download: async () => {
        throw new Error('getaddrinfo ENOTFOUND huggingface.co');
      },
    });
    expect(dl.ok).toBe(false);
    expect(dl.blocked).toMatch(/download failed/);
  });
});

// ---------------------------------------------------------------------------------------
// resolveWhisperBinary orchestration — real temp dirs, injected network/extract/exec
// ---------------------------------------------------------------------------------------

describe('resolveWhisperBinary', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'whisper-binary-test-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const linuxHw: DetectedHardware = { platform: 'linux', arch: 'x64', ramGB: 64, gpu: null, notes: [] };
  const macArmHw: DetectedHardware = { platform: 'darwin', arch: 'arm64', ramGB: 36, gpu: { vendor: 'apple', vramGB: 36, unifiedMemory: true }, notes: [] };
  const oneRelease: GhRelease[] = [release()];

  function noExecCallsExpected(): ExecFn {
    return async (cmd, args) => {
      throw new Error(`unexpected exec call: ${cmd} ${args.join(' ')}`);
    };
  }

  /** Fake extract that reproduces the real tarball shape: a top-level dir holding the server
   *  binary NEXT TO its bundled shared libs, including a same-dir RELATIVE symlink
   *  (libwhisper.so.1 -> libwhisper.so.1.9.1) exactly like the real asset — the shape that
   *  exposed the fs.cp symlink-absolutization bug in the live smoke. */
  async function fakeExtract(_archivePath: string, destDir: string): Promise<void> {
    const inner = join(destDir, 'whisper-bin-ubuntu-x64');
    await mkdir(inner, { recursive: true });
    await fsWriteFile(join(inner, 'whisper-server'), 'fake-server-binary');
    await fsWriteFile(join(inner, 'libwhisper.so.1.9.1'), 'fake-lib');
    await symlink('libwhisper.so.1.9.1', join(inner, 'libwhisper.so.1'));
    await fsWriteFile(join(inner, 'libggml.so.0'), 'fake-lib-2');
  }

  it('prebuilt path (Linux): caches the WHOLE asset dir — the bundled libs travel with the binary', async () => {
    const result = await resolveWhisperBinary(linuxHw, {
      home,
      fetchReleases: async () => oneRelease,
      download: async (url, destPath) => {
        expect(url).toContain('whisper-bin-ubuntu-x64.tar.gz');
        await mkdir(destPath.split('/').slice(0, -1).join('/'), { recursive: true });
        await fsWriteFile(destPath, 'fake-archive');
        return { bytesWritten: 12, sha256: 'x' };
      },
      extract: fakeExtract,
      exec: noExecCallsExpected(), // linux never probes nvcc and never builds
    });

    expect(result.ok).toBe(true);
    expect(result.manifest?.source).toBe('prebuilt');
    expect(result.manifest?.version).toBe('v1.9.1');
    expect(result.manifest?.platformKey).toBe('linux-x64-cpu');
    const cacheDir = `${home}/.papercusp/backends/whisper-server/v1.9.1/linux-x64-cpu`;
    expect(result.binPath).toBe(`${cacheDir}/whisper-server`);
    // The load-bearing invariant: the .so siblings landed in the cache dir too.
    expect(existsSync(`${cacheDir}/libwhisper.so.1.9.1`)).toBe(true);
    expect(existsSync(`${cacheDir}/libggml.so.0`)).toBe(true);
    // The tarball's relative lib symlink must be copied VERBATIM (still relative, still
    // resolving inside the cache dir) — fs.cp's default absolutizes it into the _extract temp
    // dir, which is deleted below, leaving the server unable to load libwhisper.so.1.
    expect(await readlink(`${cacheDir}/libwhisper.so.1`)).toBe('libwhisper.so.1.9.1');
    expect(await fsReadThrough(`${cacheDir}/libwhisper.so.1`, 'utf8')).toBe('fake-lib');
    // And the temp download/extract artifacts were cleaned up.
    expect(existsSync(`${cacheDir}/_extract`)).toBe(false);
  });

  it('a second call is a pure cache hit — no download/extract', async () => {
    const deps = {
      home,
      fetchReleases: async () => oneRelease,
      extract: fakeExtract,
      exec: noExecCallsExpected(),
    };
    await resolveWhisperBinary(linuxHw, {
      ...deps,
      download: async (_u: string, destPath: string) => {
        await mkdir(destPath.split('/').slice(0, -1).join('/'), { recursive: true });
        await fsWriteFile(destPath, 'fake-archive');
        return { bytesWritten: 12, sha256: 'x' };
      },
    });
    const second = await resolveWhisperBinary(linuxHw, {
      ...deps,
      download: async () => {
        throw new Error('should not download on a cache hit');
      },
      extract: async () => {
        throw new Error('should not extract on a cache hit');
      },
    });
    expect(second.ok).toBe(true);
    expect(second.fromCache).toBe(true);
  });

  it('re-provisions when the cached binary no longer matches its own manifest hash', async () => {
    const download = async (_u: string, destPath: string) => {
      await mkdir(destPath.split('/').slice(0, -1).join('/'), { recursive: true });
      await fsWriteFile(destPath, 'fake-archive');
      return { bytesWritten: 12, sha256: 'x' };
    };
    const first = await resolveWhisperBinary(linuxHw, { home, fetchReleases: async () => oneRelease, download, extract: fakeExtract, exec: noExecCallsExpected() });
    await fsWriteFile(first.binPath!, 'tampered');

    let redownloaded = false;
    const second = await resolveWhisperBinary(linuxHw, {
      home,
      fetchReleases: async () => oneRelease,
      download: async (u, d) => {
        redownloaded = true;
        return download(u, d);
      },
      extract: fakeExtract,
      exec: noExecCallsExpected(),
    });
    expect(redownloaded).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.fromCache).toBeFalsy();
  });

  it('darwin (no prebuilt): builds from source statically and caches the lone self-contained binary', async () => {
    const execLog: string[] = [];
    const result = await resolveWhisperBinary(macArmHw, {
      home,
      fetchReleases: async () => oneRelease,
      download: async () => {
        throw new Error('must not download — darwin has no prebuilt server asset');
      },
      exec: (async (cmd, args) => {
        execLog.push([cmd, ...args].join(' '));
        if (cmd === 'git' && args[0] === 'clone') {
          await mkdir(args[2], { recursive: true });
          return { stdout: '', stderr: '' };
        }
        if (cmd === 'cmake' && args.includes('--build')) {
          const buildDir = args[args.indexOf('--build') + 1];
          const binDir = join(buildDir, 'bin');
          await mkdir(binDir, { recursive: true });
          await fsWriteFile(join(binDir, 'whisper-server'), 'fake-built-binary');
          return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }) as ExecFn,
    });

    expect(result.ok).toBe(true);
    expect(result.manifest?.source).toBe('source-build');
    expect(result.manifest?.platformKey).toBe('darwin-arm64-metal');
    expect(execLog.some((l) => l.startsWith('git clone'))).toBe(true);
    expect(execLog.some((l) => l.includes('checkout v1.9.1'))).toBe(true);
    expect(execLog.find((l) => l.startsWith('cmake -S'))).toContain('-DBUILD_SHARED_LIBS=OFF');
  });

  it('is blocked (not thrown) when GitHub releases are unreachable', async () => {
    const result = await resolveWhisperBinary(linuxHw, {
      home,
      fetchReleases: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/could not reach GitHub/);
  });

  it('is blocked when a pinned version does not exist / no usable release exists', async () => {
    const pinned = await resolveWhisperBinary(linuxHw, { home, version: 'v9.9.9', fetchReleases: async () => oneRelease });
    expect(pinned.ok).toBe(false);
    expect(pinned.blocked).toMatch(/no release tagged 'v9\.9\.9'/);
    const empty = await resolveWhisperBinary(linuxHw, { home, fetchReleases: async () => [] });
    expect(empty.ok).toBe(false);
    expect(empty.blocked).toMatch(/no usable/);
  });

  it('is blocked (not thrown) when the from-source build fails', async () => {
    const result = await resolveWhisperBinary(macArmHw, {
      home,
      fetchReleases: async () => oneRelease,
      exec: (async (cmd, args) => {
        if (cmd === 'git' && args[0] === 'clone') {
          await mkdir(args[2], { recursive: true });
          return { stdout: '', stderr: '' };
        }
        if (cmd === 'cmake' && args.includes('--build')) throw new Error('clang: error: no such target');
        return { stdout: '', stderr: '' };
      }) as ExecFn,
    });
    expect(result.ok).toBe(false);
    expect(result.blocked).toMatch(/build-from-source failed/);
  });
});
