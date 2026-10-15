/**
 * Type shim for the PDF.js in-process worker entrypoint. pdfjs-dist ships
 * `pdf.d.mts` for `legacy/build/pdf.mjs` but no declaration for the worker
 * module, so the side-effect import in content-intake.ts is implicit-`any`
 * (TS7016). content-intake imports it only so PDF.js registers its handler on
 * globalThis; the one export it carries is declared opaque on purpose.
 */
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown;
}
