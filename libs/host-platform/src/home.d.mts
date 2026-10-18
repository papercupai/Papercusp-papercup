export type PapercuspHomeEnvironment = Readonly<Record<string, string | undefined>>;

export function papercuspHome(env?: PapercuspHomeEnvironment, fallbackHome?: string): string;
export function papercuspPath(...parts: string[]): string;
export function papercuspPtyPath(env?: PapercuspHomeEnvironment, fallbackHome?: string): string;
