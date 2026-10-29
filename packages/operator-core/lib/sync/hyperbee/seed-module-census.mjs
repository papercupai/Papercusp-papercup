// D-178: load FIRST, before tsx or the census/producer entry. One process-local
// module census, carried through the existing frozen execution binding.
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const preloadPath = fileURLToPath(import.meta.url);
const args = process.execArgv;
const firstImport = args.findIndex(arg => arg === '--import' || arg.startsWith('--import='));
const specifier = firstImport < 0 ? '' : args[firstImport] === '--import'
  ? args[firstImport + 1] : args[firstImport].slice('--import='.length);
const firstPath = specifier.startsWith('file:') ? fileURLToPath(specifier) : resolve(specifier);
if (firstImport < 0 || firstPath !== preloadPath) throw new Error('seed module census must be the first preload');

const paths = new Set([preloadPath]);
Object.defineProperty(globalThis, Symbol.for('papercusp.seed-module-census'), {
  value: Object.freeze({ preloadPath, paths }), configurable: false, writable: false,
});
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.startsWith('file:')) paths.add(fileURLToPath(url));
    return result;
  },
});

// Storage loads this migration lazily on the first fresh replica. Include its
// code in the tracked population before any frozen execution baseline; loading
// the module does not run a migration or open a store. Keep later growth fatal.
createRequire(import.meta.url)('hypercore-storage/migrations/0');
