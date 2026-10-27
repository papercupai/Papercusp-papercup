/** Semantic results of the bounded operations, rather than import-only probes. */
export const NATIVE_EXPECTATIONS: Readonly<{
  'sqlite-transaction-reopen': { rows: Array<{ value: string }>; rolledBack: boolean };
  'sodium-secretbox-roundtrip': { plaintext: string; rejectsTampering: boolean };
  'sharp-png-roundtrip': { width: number; height: number; channels: number; pixels: number[] };
  'udx-loopback': { message: string };
  'rocksdb-reopen': { value: string };
  'pty-input-exit': { echoed: boolean; exitCode: number };
  'onnx-worker-inference-restart': { outputs: number[][]; terminated: boolean };
  'onnx-cpu-inference': { output: number[] };
  'onnx-worker-inference': { outputs: number[][]; terminated: boolean };
}>;
export const RUNTIME_EXPECTATIONS: Readonly<{
  'async-context-isolation': { contexts: string[]; outside: null };
  'worker-transfer-exit': { values: number[]; detached: boolean; exitCode: number };
  'process-ipc-exit': { reply: number; exitCode: number };
  'http-stream-roundtrip': { status: number; body: string };
  'http2-stream-roundtrip': { status: number; body: string };
  'node-sqlite-wal-checkpoint': { rows: string[]; busy: number; walBytes: number };
  'inspector-callback-profile': { profileTree: boolean; timestampsOrdered: boolean };
  'inspector-promises-profile': { profileTree: boolean; timestampsOrdered: boolean };
  'worker-terminate-restart': { replies: string[]; terminated: boolean };
  'worker-terminate-after-exit': { settled: boolean; exitCode: number };
}>;
export function performRuntimeCapability(id: string): Promise<unknown>;
export function performNativeCapability(id: string, requireFrom: string): Promise<unknown>;
export function perform(): Promise<unknown>;
