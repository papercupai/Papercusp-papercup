export function runtimeFileTraceArguments(output: string, command: string[]): string[];
export function bindRuntimeModelOpens(text: string, options: {
  processId: number;
  assets: {path: string}[];
  beforeEpochMs: number;
}): {
  processId: number;
  tasks: number[];
  opens: {taskId: number; atMs: number; path: string; fd: number}[];
  modelFilesOpenedBeforeInference: true;
  modelBytesReadVerified: false;
  scope: string;
};
