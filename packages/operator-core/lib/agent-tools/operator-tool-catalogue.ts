import { pinModuleState } from '@papercusp/module-singleton';

// tsx can resolve the HTTP route's static catalogue and a native transport's
// dynamic import through different CJS/ESM module records. Share completion,
// not a tool-count heuristic: only the end of the full barrel marks it ready.
const catalogue = pinModuleState('@papercusp/operator-core.operator-tool-catalogue', () => ({
  loaded: false,
  loading: null as Promise<void> | null,
}));

/** Called after every catalogue import and synchronous registration succeeds. */
export function markOperatorToolCatalogueLoaded(): void {
  catalogue.loaded = true;
}

/** Reuse static registration, or share a lazy load across HTTP/native hosts. */
export function loadOperatorToolCatalogue(load: () => Promise<unknown>): Promise<void> {
  if (catalogue.loaded) return Promise.resolve();
  if (!catalogue.loading) {
    catalogue.loading = Promise.resolve()
      .then(load)
      .then(() => { catalogue.loaded = true; })
      .catch((error) => {
        catalogue.loading = null;
        throw error;
      });
  }
  return catalogue.loading;
}
