/**
 * EI-25639879260344521 — a directory under libs/generic is not necessarily a
 * submodule. Keep the client rule and its root-detection recipe from regressing.
 *
 * This is a documentation guard: the original blanket statement made `git -C`
 * look like proof of a submodule root and allowed an extraction failure to read
 * as a clean zero. The test requires both a qualified statement and the command
 * that distinguishes a superproject directory from an independent Git root.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOCS = ['CLAUDE.md', 'AGENTS.md'].map((path) => ({
  path,
  text: readFileSync(join(ROOT, path), 'utf8'),
}));
const CORPUS = {
  path: 'packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md',
  text: readFileSync(join(ROOT, 'packages/operator-core/lib/doc-projection/claude-md-corpus.generated.md'), 'utf8'),
};

const OLD_BLANKET_CLAIM = 'Domain-free libs live as standalone submodules under `libs/generic/*`';
const QUALIFIED_CLAIM =
  'Domain-free libs under `libs/generic/*` may be standalone Git submodules or ordinary superproject directories.';
const ROOT_CHECK = 'git -C <path> rev-parse --show-toplevel';

type Doc = { path: string; text: string };
const judge = (docs: readonly Doc[]) => ({
  blanketClaims: docs.filter((doc) => doc.text.includes(OLD_BLANKET_CLAIM)).map((doc) => doc.path),
  missingQualifiedClaim: docs.filter((doc) => !doc.text.includes(QUALIFIED_CLAIM)).map((doc) => doc.path),
  missingRootCheck: docs.filter((doc) => !doc.text.includes(ROOT_CHECK)).map((doc) => doc.path),
});

describe('libs/generic Git-root guidance', () => {
  describe('fixture controls — the detector must fail on the old false claim', () => {
    it('rejects the blanket submodule claim', () => {
      const verdict = judge([{ path: 'CLAUDE.md', text: OLD_BLANKET_CLAIM }]);
      expect(verdict.blanketClaims).toEqual(['CLAUDE.md']);
    });

    it('catches the root-check prescription disappearing', () => {
      const verdict = judge([{ path: 'CLAUDE.md', text: QUALIFIED_CLAIM }]);
      expect(verdict.missingRootCheck).toEqual(['CLAUDE.md']);
    });

    it('catches one projection reverting while the other stays corrected', () => {
      const verdict = judge([
        { path: 'CLAUDE.md', text: `${QUALIFIED_CLAIM} ${ROOT_CHECK}` },
        { path: 'AGENTS.md', text: OLD_BLANKET_CLAIM },
      ]);
      expect(verdict.blanketClaims).toEqual(['AGENTS.md']);
    });
  });

  it('keeps both client projections and the full source corpus qualified', () => {
    const verdict = judge([...DOCS, CORPUS]);
    expect(verdict.blanketClaims).toEqual([]);
    expect(verdict.missingQualifiedClaim).toEqual([]);
    expect(verdict.missingRootCheck).toEqual([]);
  });
});
