/** Extract a maintained SDK worklet template without executing its wrapper. */
export function extractWorklet(source: string, name: string): string;

/** Mirror the installed audio worklets into the app's generated public assets. */
export function setupElevenLabsRuntime(appRoot?: string): Promise<string[]>;
