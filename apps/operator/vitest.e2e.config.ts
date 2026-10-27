import { defineVitestConfig } from '@papercusp/test-config/vitest-config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function prepareDesktopNativeRuntimeReader(
  loadNativeRuntime = () => tsImport('../../packages/operator-core/lib/testing-native-runtime.ts', import.meta.url),
) {
  if (!process.env.VERIFY_TAURI_PID && !process.env.VERIFY_TAURI_PORT) return undefined;
  const { prepareNativeRuntimeReader } = await loadNativeRuntime();
  const read = prepareNativeRuntimeReader(repo, process.env.VERIFY_TAURI_SOURCE_REF ?? null);
  if (!read) throw new Error('desktop-native-runtime-unavailable');
  return async () => read();
}

// Keep Phone journeys and the verifier-owned portal assertion in the recorded
// e2e lane. Native custody is measured independently before and after execution.
export default async () => {
  const readRuntimeEnvironment = await prepareDesktopNativeRuntimeReader();
  return defineVitestConfig({
    layer: 'e2e',
    include: ['**/*.e2e.test.ts', 'bin/desktop-portal-native.test.ts'],
    ...(readRuntimeEnvironment ? { readRuntimeEnvironment } : {}),
  });
};
