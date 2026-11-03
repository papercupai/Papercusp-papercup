// Reuse generation custody at the producing build, never stamp existing dist.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { buildWorkspace } from '../apps/operator/bin/release/dependency-generation-verifier.mjs';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
buildWorkspace(root, relative(root, realpathSync(process.cwd())), process.argv.slice(2));
