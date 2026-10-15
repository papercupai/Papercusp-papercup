// Load the shared test-layer injection type explicitly. The worker compiler
// excludes host integration files, so their transitive imports must not be the
// only path that makes this Vitest augmentation visible.
import type {} from '@papercusp/test-config/vitest-config';
