export const GNOME_SESSION_PROFILE_UUID: string;
export const GNOME_SESSION_SCROLLBACK_LINES: number;
export const GNOME_PROFILE_PREPARATION: string;
export function prepareGnomeTerminal<T extends { bin: string; args: string[] }>(terminal: T,
  env?: NodeJS.ProcessEnv,
  run?: ((file: string, args: string[], options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>) | null): Promise<T>;
