/**
 * JSON-valued tauri-agent-tools commands use their explicit JSON output mode.
 * Decode stdout once: eval's result field is the value, including empty strings.
 * Raw text commands such as screenshot use their own caller path.
 */
export function decodeNativeBridgeJson(stdout: string, command?: string) {
  const value = JSON.parse(stdout);
  if (command !== 'eval') return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !Object.prototype.hasOwnProperty.call(value, 'result')) {
    throw new Error('Native eval JSON response requires a result field');
  }
  return value.result;
}
