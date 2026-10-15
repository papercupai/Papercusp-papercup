import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import policy from './gnome-terminal-policy.json' with { type: 'json' };

// Reuse GNOME's own profile registry. Never change the user's default profile:
// changing its scrollback setting also truncates every live window using it.
// One bundled policy also compiled into the native desktop launcher.
export const GNOME_SESSION_PROFILE_UUID = policy.profileUuid;
export const GNOME_SESSION_SCROLLBACK_LINES = policy.scrollbackLines;
export const GNOME_PROFILE_PREPARATION = policy.preparation.join('\n');


/** Prepare only new GNOME windows; explicit profile choices are honored. */
export async function prepareGnomeTerminal(terminal, env = process.env, run = null) {
  if (basename(terminal.bin) !== 'gnome-terminal') return terminal;
  let prepared = terminal;
  // Ubuntu ships this maintained Python wrapper specifically to retain native
  // process-per-window GNOME support. Use it without choosing another emulator.
  // Explicit application IDs intentionally group windows and remain untouched.
  if (!terminal.args.some((arg) => arg === '--disable-factory' || arg === '--app-id' || arg.startsWith('--app-id='))) {
    const candidates = isAbsolute(terminal.bin) ? [terminal.bin]
      : [...(env.PATH ?? process.env.PATH ?? '').split(delimiter), '/usr/bin', '/usr/local/bin'].map((dir) => join(dir, terminal.bin));
    for (const candidate of candidates) {
      let text;
      try { text = readFileSync(candidate, 'utf8'); } catch { continue; }
      if (text.startsWith('#!') && text.includes('python') && text.includes("parser.add_argument('--disable-factory'")) {
        prepared = { ...terminal, args: ['--disable-factory', ...terminal.args] };
      }
      break;
    }
  }
  if (terminal.args.some((arg) => arg === '--profile' || arg.startsWith('--profile='))) return prepared;
  const execute = run ?? promisify(execFile);
  let stdout, failure;
  for (const python of policy.pythonCandidates) {
    try {
      ({ stdout } = await execute(python, ['-c', GNOME_PROFILE_PREPARATION,
        GNOME_SESSION_PROFILE_UUID, String(GNOME_SESSION_SCROLLBACK_LINES)], {
        env, timeout: 8000, maxBuffer: 16384,
      }));
      break;
    } catch (error) {
      failure = error;
      // Missing interpreters/GI fail before settings writes. Try the system
      // interpreter when a virtualenv or package manager shadows its GI build.
      if (error.code !== 'ENOENT' && !/No module named ['"]?gi['"]?/.test(String(error.stderr))) break;
    }
  }
  if (stdout === undefined) {
    const error = failure;
    const detail = String(error.stderr || error.message || error).trim().slice(-1000);
    throw new Error('GNOME terminal safeguards require Python 3, PyGObject and GNOME Terminal settings. '
      + 'Install python3-gi and gnome-terminal (or your distribution equivalents), ensure python3 is on PATH, and retry. ' + detail,
    { cause: error });
  }
  let result;
  try { result = JSON.parse(stdout.trim()); }
  catch { throw new Error('GNOME profile preparation returned no valid receipt'); }
  if (!result || typeof result !== 'object') throw new Error('GNOME profile preparation returned no valid receipt');
  const preserved = typeof result.sourceProfileUuid === 'string' && result.sourceProfileUuid.length > 0
    && result.defaultProfileUuid === result.sourceProfileUuid;
  if (result.profileUuid === null && result.customized === true) return prepared;
  if (result.profileUuid === null && result.sourceUnlimited === false
    && Number.isInteger(result.scrollbackLines) && result.scrollbackLines >= 0
    && result.scrollbackLines <= GNOME_SESSION_SCROLLBACK_LINES
    && preserved) return prepared;
  if (result.profileUuid !== GNOME_SESSION_PROFILE_UUID || !Number.isInteger(result.scrollbackLines) || result.scrollbackLines < 1
    || !preserved) {
    throw new Error('GNOME profile preparation could not verify preserved default and bounded new profile');
  }
  return { ...prepared, args: ['--profile=' + result.profileUuid, ...prepared.args] };
}
