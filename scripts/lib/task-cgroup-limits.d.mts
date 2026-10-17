export interface TaskCgroupReadOptions {
  readFile?: (path: string, encoding: string) => string | Buffer;
  procCgroupPath?: string;
  cgroupRoot?: string;
}
export function readTaskCgroupLimit(fileName: string, input?: TaskCgroupReadOptions): string | null;
export function readTaskCgroupMemoryMaxMb(input?: TaskCgroupReadOptions): number | null;
