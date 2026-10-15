export type ControlPlaneTempKind = 'payload' | 'socket' | 'log';

export interface ControlPlaneTempOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  runtimeDir?: string | null;
  tempDir?: string;
  tmpdir?: string;
  sharedMemoryDir?: string | null;
  isUsableDirectory?: (path: string) => boolean;
  writeFileSync?: (
    path: string,
    data: string | Uint8Array,
    options?: { encoding?: 'utf8'; mode?: number; flag?: string },
  ) => void;
  rmSync?: (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
}

export function controlPlaneTempCandidates(
  kind?: ControlPlaneTempKind,
  options?: ControlPlaneTempOptions,
): string[];

export function controlPlaneTempRoot(
  kind?: ControlPlaneTempKind,
  options?: ControlPlaneTempOptions,
): string;

export function createControlPlaneTempDir(
  prefix: string,
  kind?: ControlPlaneTempKind,
  options?: ControlPlaneTempOptions,
): string;

export function createControlPlaneTempDirWithFile(
  prefix: string,
  filename: string,
  contents: string | Uint8Array,
  kind?: ControlPlaneTempKind,
  options?: ControlPlaneTempOptions,
): string;

export function createControlPlaneTempDirAsync(
  prefix: string,
  kind?: ControlPlaneTempKind,
  options?: ControlPlaneTempOptions,
): Promise<string>;

export function createControlPlaneTempFile(
  prefix: string,
  suffix: string,
  kind?: ControlPlaneTempKind,
  options?: ControlPlaneTempOptions,
): string;
