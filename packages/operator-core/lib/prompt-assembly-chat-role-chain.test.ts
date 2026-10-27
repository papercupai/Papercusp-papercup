/**
 * identities-v1-2026-08-30 P-023 — CHAT-SURFACE ROLES ONTO THE CHAIN.
 *
 * Before P-023, `loadRolePersona` / `loadRoleConverse` / `loadRoleToolsMd` read
 * `apps/operator/prompts/<role>.<kind>.md` by direct file read, while the spawn tier
 * resolved `blueprints/<id>/prompts/<role>.md` through `resolvePromptFile` (the
 * blueprint extends-chain leaf-first, `base` last; within one id the tiers local →
 * installed → built-in) and the su's identity documents resolved through `identityRoots`.
 * After P-023 the chat-surface documents resolve through THAT resolver — the chain form
 * is `blueprints/<id>/prompts/<role>.<kind>.md` — with the prompts dir retained as the
 * LOWEST-precedence file tier.
 *
 * ACCEPTANCE (the item's words): "every PROMPT_ROLE renders byte-equivalent before and
 * after the migration, asserted per role". `it.each(PROMPT_ROLES)` below asserts, per
 * role and per document kind, that the chain loader returns the prompts-dir bytes
 * VERBATIM when no chain copy is installed (the built-in tree ships none — pinned), and
 * that the assembled prompt opens with those bytes. The precedence tests then prove the
 * chain is real: a `base` copy wins over the file tier, a leaf blueprint wins over
 * `base`, and a local tier wins over the built-in within one id.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAT_ROLE_DOCUMENT_KINDS,
  PROMPT_ROLES,
  assembleRolePrompt,
  chatRoleDocumentCandidates,
  chatRoleDocumentFilePath,
  loadChatRoleDocument,
  loadRoleConverse,
  loadRolePersona,
  loadRoleToolsMd,
  promptsDir,
  resolveChatRoleDocument,
  RolePromptUnavailableError,
  rolePromptUnavailableDetails,
  verifyRolePromptAssets,
  type ChatRoleDocumentKind,
  type Role,
} from './prompt-assembly';

/** Env that would REDIRECT the built-in tier away from the roots a test builds. */
const REDIRECT_ENV = ['PAPERCUSP_PROMPT_ROOT', 'PAPERCUSP_INTEGRATION_ROOT', 'PAPERCUSP_PROMPTS_DIR', 'PAPERCUSP_RELOAD_PROMPTS'] as const;

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of REDIRECT_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Bypass the memo so every call below re-resolves against the roots it names.
  process.env.PAPERCUSP_RELOAD_PROMPTS = '1';
});
afterAll(() => {
  for (const k of REDIRECT_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function fileTierText(role: Role, kind: ChatRoleDocumentKind): string | null {
  const p = join(promptsDir(), `${role}.${kind}.md`);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// ─── ACCEPTANCE: byte-equivalence per role ──────────────────────────────────────

describe('P-023 acceptance — every PROMPT_ROLE renders byte-equivalent before and after (per role)', () => {
  const rolesWithPersona = PROMPT_ROLES.filter((r) => fileTierText(r, 'persona') !== null);

  it('the population is not vacuous: the five chat-surface roles ship a persona in the prompts dir', () => {
    expect(rolesWithPersona).toEqual(expect.arrayContaining(['operator', 'oracle', 'auditor', 'papercup', 'papercup-deep']));
  });

  it('the built-in harness ships NO chain copy of any chat-surface document — the file tier is the live source (pinned)', () => {
    // If this ever flips, the byte-equivalence below is no longer "file == render" by
    // construction and the moved document must be asserted byte-equal to its file.
    for (const role of PROMPT_ROLES) {
      for (const kind of CHAT_ROLE_DOCUMENT_KINDS) {
        const hit = resolveChatRoleDocument(role, kind);
        if (hit) expect(hit.tier, `${role}.${kind}`).toBe('file');
      }
    }
  });

  it.each(PROMPT_ROLES)('%s — persona / converse / tools resolve to the prompts-dir bytes VERBATIM (or the same absence as before)', (role) => {
    for (const kind of CHAT_ROLE_DOCUMENT_KINDS) {
      const before = fileTierText(role, kind); // the pre-P-023 direct file read
      const after = loadChatRoleDocument(role, kind);
      if (before === null) {
        expect(after, `${role}.${kind} absent before ⇒ absent after`).toBeNull();
      } else {
        expect(after).toEqual({ tier: 'file', path: chatRoleDocumentFilePath(role, kind), text: before });
        expect(after!.text).toBe(before); // byte-equal, not just deep-equal
      }
    }
    // The public loaders keep their pre-P-023 contract per role.
    const persona = fileTierText(role, 'persona');
    if (persona === null) expect(() => loadRolePersona(role)).toThrow(/ROLE_PROMPT_UNAVAILABLE/);
    else expect(loadRolePersona(role)).toBe(persona);
    const converse = fileTierText(role, 'converse');
    if (converse === null) expect(() => loadRoleConverse(role)).toThrow(/ROLE_PROMPT_UNAVAILABLE/);
    else expect(loadRoleConverse(role)).toBe(converse);
    expect(loadRoleToolsMd(role)).toBe(fileTierText(role, 'tools'));
  });

  it.each(rolesWithPersona)('%s — the ASSEMBLED prompt opens with the persona bytes and carries the tools playbook verbatim', (role) => {
    const persona = fileTierText(role, 'persona')!;
    const tools = fileTierText(role, 'tools');
    const out = assembleRolePrompt({ role, toolNames: [] });
    expect(out.text.startsWith(persona)).toBe(true);
    expect(out.sections[0]).toEqual({ name: 'persona', chars: persona.length });
    if (tools !== null) {
      expect(out.text).toContain(tools);
      expect(out.sections.find((s) => s.name === 'tools-playbook')?.chars).toBe(tools.length);
    } else {
      expect(out.sections.find((s) => s.name === 'tools-playbook')).toBeUndefined();
    }
  });
});

// ─── The chain is real: precedence over the file tier ───────────────────────────

describe('P-023 — chat-surface documents resolve through the blueprint extends-chain, file tier last', () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A harness-shaped root: `blueprints/<id>/{blueprint.yaml,prompts/…}`. */
  function mkRoot(label: string): string {
    const root = mkdtempSync(join(tmpdir(), `papercusp-p023-${label}-`));
    tmps.push(root);
    return root;
  }
  function blueprint(root: string, id: string, yaml: string, docs: Record<string, string> = {}): void {
    const dir = join(root, 'blueprints', id);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'blueprint.yaml'), yaml);
    for (const [name, text] of Object.entries(docs)) writeFileSync(join(dir, 'prompts', name), text);
  }

  it('a `base` chain copy WINS over the prompts-dir file; kinds with no chain copy still fall back to the file tier', () => {
    const builtin = mkRoot('builtin');
    blueprint(builtin, 'base', 'id: base\n', { 'operator.persona.md': 'BASE PERSONA\n' });
    const ctx = { harnessDir: builtin };

    const persona = loadChatRoleDocument('operator', 'persona', ctx);
    expect(persona).toEqual({ tier: 'chain', path: join(builtin, 'blueprints/base/prompts/operator.persona.md'), text: 'BASE PERSONA\n' });
    expect(loadRolePersona('operator', ctx)).toBe('BASE PERSONA\n');

    // No chain copy of converse / tools ⇒ the file tier, byte-equal to the direct read.
    expect(loadChatRoleDocument('operator', 'converse', ctx)).toEqual({
      tier: 'file',
      path: chatRoleDocumentFilePath('operator', 'converse'),
      text: fileTierText('operator', 'converse'),
    });
    expect(loadRoleToolsMd('operator', ctx)).toBe(fileTierText('operator', 'tools'));

    // Neither tier ⇒ null / the same refusal as before.
    expect(loadChatRoleDocument('worker', 'persona', ctx)).toBeNull();
    expect(() => loadRolePersona('worker', ctx)).toThrow(RolePromptUnavailableError);
  });

  it('a LEAF blueprint wins over `base` (leaf-first across the extends-chain, read from blueprint.yaml like the spawn tier)', () => {
    const builtin = mkRoot('builtin');
    blueprint(builtin, 'base', 'id: base\n', { 'operator.persona.md': 'BASE PERSONA\n' });
    blueprint(builtin, 'mid', 'id: mid\nextends: base\n', { 'operator.persona.md': 'MID PERSONA\n' });
    blueprint(builtin, 'leaf', 'id: leaf\nextends: mid\n', { 'operator.tools.md': 'LEAF TOOLS\n' });

    // leaf has no persona ⇒ its ancestor `mid` supplies it before `base`.
    expect(loadRolePersona('operator', { harnessDir: builtin, blueprintId: 'leaf' })).toBe('MID PERSONA\n');
    // leaf's own tools document beats the file tier.
    expect(loadRoleToolsMd('operator', { harnessDir: builtin, blueprintId: 'leaf' })).toBe('LEAF TOOLS\n');
    // A pre-resolved chain is honored as given.
    expect(loadRolePersona('operator', { harnessDir: builtin, extendsChain: ['leaf', 'base'] })).toBe('BASE PERSONA\n');
    // The chain is the whole story for assembly too.
    const out = assembleRolePrompt({ role: 'operator', toolNames: [], resolve: { harnessDir: builtin, blueprintId: 'leaf' } });
    expect(out.text.startsWith('MID PERSONA\n')).toBe(true);
    expect(out.text).toContain('LEAF TOOLS\n');
  });

  it('within one id a LOCAL tier (blueprintRoots) wins over the built-in — but a leaf in ANY tier still beats an ancestor in the local tier (specificity first)', () => {
    const builtin = mkRoot('builtin');
    const local = mkRoot('local');
    blueprint(builtin, 'base', 'id: base\n', { 'operator.persona.md': 'BUILTIN BASE\n' });
    blueprint(builtin, 'leaf', 'id: leaf\nextends: base\n', { 'operator.persona.md': 'BUILTIN LEAF\n' });
    blueprint(local, 'base', 'id: base\n', { 'operator.persona.md': 'LOCAL BASE\n' });

    expect(loadRolePersona('operator', { harnessDir: builtin, blueprintRoots: [local] })).toBe('LOCAL BASE\n');
    expect(loadRolePersona('operator', { harnessDir: builtin, blueprintRoots: [local], blueprintId: 'leaf' })).toBe('BUILTIN LEAF\n');
  });

  it('the candidate listing is the spawn tier\'s order with the file tier appended LAST', () => {
    const builtin = mkRoot('builtin');
    const local = mkRoot('local');
    const candidates = chatRoleDocumentCandidates('operator', 'persona', {
      harnessDir: builtin,
      blueprintRoots: [local],
      extendsChain: ['leaf', 'base'],
    });
    expect(candidates).toEqual([
      join(local, 'blueprints/leaf/prompts/operator.persona.md'),
      join(builtin, 'blueprints/leaf/prompts/operator.persona.md'),
      join(local, 'blueprints/base/prompts/operator.persona.md'),
      join(builtin, 'blueprints/base/prompts/operator.persona.md'),
      chatRoleDocumentFilePath('operator', 'persona'),
    ]);
    // Default context: the `base` chain over the built-in harness, then the file.
    const dflt = chatRoleDocumentCandidates('oracle', 'tools');
    expect(dflt.at(-1)).toBe(chatRoleDocumentFilePath('oracle', 'tools'));
    expect(dflt.slice(0, -1).every((p) => p.endsWith('/blueprints/base/prompts/oracle.tools.md'))).toBe(true);
  });

  describe('memoization is keyed by the resolve context (two chains never share a cache row)', () => {
    beforeEach(() => {
      process.env.PAPERCUSP_RELOAD_PROMPTS = '0';
    });
    afterEach(() => {
      process.env.PAPERCUSP_RELOAD_PROMPTS = '1';
    });
    it('returns each context its own document', () => {
      const a = mkRoot('a');
      const b = mkRoot('b');
      blueprint(a, 'base', 'id: base\n', { 'oracle.persona.md': 'A ORACLE\n' });
      blueprint(b, 'base', 'id: base\n', { 'oracle.persona.md': 'B ORACLE\n' });
      expect(loadRolePersona('oracle', { harnessDir: a })).toBe('A ORACLE\n');
      expect(loadRolePersona('oracle', { harnessDir: b })).toBe('B ORACLE\n');
      expect(loadRolePersona('oracle', { harnessDir: a })).toBe('A ORACLE\n');
      // The default context still serves the file tier.
      expect(loadRolePersona('oracle')).toBe(fileTierText('oracle', 'persona'));
    });
  });
});

describe('runtime-only required-document refusal and content install recovery', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'prompt-runtime-only-'));
    process.env.PAPERCUSP_PROMPTS_DIR = join(root, 'prompts');
    process.env.PAPERCUSP_RELOAD_PROMPTS = '0';
    mkdirSync(join(root, 'prompts'));
  });
  afterEach(() => {
    delete process.env.PAPERCUSP_PROMPTS_DIR;
    process.env.PAPERCUSP_RELOAD_PROMPTS = '1';
    rmSync(root, { recursive: true, force: true });
  });
  it('refuses only required documents with stable public identifiers and no paths', () => {
    const ctx = { harnessDir: join(root, 'harness') };
    for (const document of ['persona', 'converse'] as const) {
      let error: unknown;
      try { document === 'persona' ? loadRolePersona('operator', ctx) : loadRoleConverse('operator', ctx); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(RolePromptUnavailableError);
      expect(error).toMatchObject({ code: 'ROLE_PROMPT_UNAVAILABLE', role: 'operator', document });
      expect((error as Error).message).toContain('Cupboard');
      expect((error as Error).message).not.toContain(root);
    }
    expect(loadRoleToolsMd('operator', ctx)).toBeNull();
  });
  it('recovers after install with production caching, then refuses a deleted input', () => {
    const ctx = { harnessDir: join(root, 'harness') };
    expect(() => loadRolePersona('oracle', ctx)).toThrow(RolePromptUnavailableError);
    const file = join(root, 'prompts/oracle.persona.md');
    writeFileSync(file, 'SYNTHETIC ORACLE');
    expect(loadRolePersona('oracle', ctx)).toBe('SYNTHETIC ORACLE');
    rmSync(file);
    expect(() => loadRolePersona('oracle', ctx)).toThrow(RolePromptUnavailableError);
  });
  it('records metadata and refusal evidence without prompt text or directory-only availability', () => {
    const ctx = { harnessDir: join(root, 'harness') };
    const missing = verifyRolePromptAssets(ctx);
    expect(missing.roles).toEqual(PROMPT_ROLES);
    expect(missing.documents).toHaveLength(PROMPT_ROLES.length * CHAT_ROLE_DOCUMENT_KINDS.length);
    expect(missing.documents.filter(d => d.required).every(d => d.disposition === 'unavailable' && d.refusalVerified)).toBe(true);
    writeFileSync(join(root, 'prompts/oracle.persona.md'), 'SYNTHETIC PRIVATE BYTES');
    const installed = verifyRolePromptAssets(ctx);
    expect(installed.documents.filter(d => d.disposition === 'available')).toEqual([
      expect.objectContaining({ role: 'oracle', document: 'persona', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
    expect(JSON.stringify(installed)).not.toContain('SYNTHETIC PRIVATE BYTES');
    expect(JSON.stringify(installed)).not.toContain(root);
    expect(installed.installedUseVerified).toBe(false);
    expect(installed.candidateAccepted).toBe(false);
  });
  it('refuses blank required documents and recognizes only canonical transported errors', () => {
    const ctx = { harnessDir: join(root, 'harness') };
    writeFileSync(join(root, 'prompts/oracle.persona.md'), ' \n ');
    expect(() => loadRolePersona('oracle', ctx)).toThrow(RolePromptUnavailableError);
    expect(verifyRolePromptAssets(ctx).documents.find(d => d.role === 'oracle' && d.document === 'persona'))
      .toMatchObject({ disposition: 'unavailable', sha256: null, refusalVerified: true });
    writeFileSync(join(root, 'prompts/oracle.persona.md'), 'SYNTHETIC INSTALLED ORACLE');
    expect(loadRolePersona('oracle', ctx)).toBe('SYNTHETIC INSTALLED ORACLE');
    const known = new RolePromptUnavailableError('oracle', 'persona');
    expect(rolePromptUnavailableDetails({ code: 'handler_error', message: known.message }))
      .toEqual(rolePromptUnavailableDetails(known));
    expect(rolePromptUnavailableDetails(new Error('/private/resolver/oracle.persona.md missing'))).toBeNull();
    expect(rolePromptUnavailableDetails({ message: known.message + ' /private/path' })).toBeNull();
    expect(rolePromptUnavailableDetails({ code: 'ROLE_PROMPT_UNAVAILABLE', message: 'unrelated' })).toBeNull();
  });
});
