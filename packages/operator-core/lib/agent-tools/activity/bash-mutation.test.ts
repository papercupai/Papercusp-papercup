import { describe, expect, it } from 'vitest';
import { classifyCapabilityBashEffect } from '../capability/bash-effect';
import { bashCanMutate, capabilityBashCommand } from './bash-mutation';

/**
 * EI-23749240882032210 — attribution-purpose mutation detector. The read shapes below are copied
 * from the measured ledger (holder su-6aab097a, harness_shared.tool_invocations); every other
 * case is a mutation vector the detector must NEVER call a read.
 */
describe('bashCanMutate (activity attribution)', () => {
  describe('provably non-writing shell is NOT a mutation', () => {
    it.each([
      "grep -rn 'unknown filter op' --include=*.ts libs packages apps 2>/dev/null | head -5",
      "cd /work/repo && grep -rln 'goal_kickoff_incomplete' --include=*.ts --exclude-dir=node_modules --exclude-dir=dist . | head -20",
      "cd /work/repo && echo '=== kickoff-evidence.ts 200-235 ==='; sed -n '200,235p' packages/operator-core/lib/goals/kickoff-evidence.ts",
      "sed -n '200,235p' packages/operator-core/lib/goals/kickoff-evidence.ts",
      'ls -la packages',
      'cat a.ts | head -20',
      'git log --oneline -5 2>&1',
      'git status --porcelain 2>/dev/null',
      "find . -name '*.ts' -not -path './node_modules/*' | wc -l",
      "sed -n '/needle/p' a.ts",
      "sed -n -e '1,5p' a.ts",
      "sed 's/a/b/' a.ts",
      "jq '.a' package.json",
      'diff -u a.ts b.ts',
      // the three shapes that still scored `implement` after the redirect/grep/cd layer, copied from
      // the same ledger (home path replaced): `\|` inside double quotes, a read-only $(…) assigned to
      // a variable then used as data, and xargs over a data-only command.
      'cd packages/x/lib && grep -n "not-goal-scoped\\|goal-scoped\\|function classifyScope\\|scope =\\|Scope(" w.ts | head -40',
      'cd /work/repo && f=$(ls a.ts b/index.ts 2>/dev/null | head -1); echo "FILE=$f"; grep -n \'export function\\|REQUIRED\' "$f" | head -50',
      "grep -rln 'unknown filter op' --include=*.ts libs packages apps 2>/dev/null | head -3 | xargs -r grep -n 'allOf\\|not:\\|\"not\"\\|clauses' | head -20",
      'echo "$(ls packages)"',
      // an expansion handed to a data-only command is data: grep has no write or exec option
      'grep -n x $(cat files.txt)',
      'grep -n $PATTERN a.ts',
      'echo "a\\|b"',
      'xargs -n1 -P4 grep -c x',
    ])('%s', (cmd) => {
      expect(bashCanMutate(cmd), cmd).toBe(false);
    });
  });

  describe('every mutation vector stays a mutation (the narrowing may never hide a write)', () => {
    it.each([
      // redirects to a real target — only /dev/null and fd-merging are benign
      "grep -rn 'x' packages > out.txt",
      "grep -rn 'x' packages 2>/dev/null > out.txt",
      'echo hi >> notes.md',
      'echo hi > src/a.ts',
      'cat a.ts >out.txt',
      'cat < a.ts',
      'cat <<EOF\nhello\nEOF',
      'ls 2>/dev/null.bak',
      'ls > /dev/nullx',
      // in-place / script-file / in-script writes for sed
      "sed -i 's/a/b/' a.ts",
      "sed -i.bak 's/a/b/' a.ts",
      "sed -ni '1,5p' a.ts",
      "sed --in-place 's/a/b/' a.ts",
      "sed --in-place=.bak 's/a/b/' a.ts",
      "sed -f script.sed a.ts",
      "sed -n 'w out.txt' a.ts",
      "sed -n '1,5w out.txt' a.ts",
      "sed 's/a/b/w out.txt' a.ts",
      "sed 's/a/b/e' a.ts",
      "sed -n '1e touch x' a.ts",
      // a script ATTACHED to -e (getopt takes the rest of the cluster; the next token is a file)
      'sed -ew/tmp/x p a.ts',
      'sed -nes/a/b/w/tmp/x p a.ts',
      // GNU getopt_long accepts any unique abbreviation of a long option
      "sed --in-p 's/a/b/' a.ts",
      "sed --in 's/a/b/' a.ts",
      'sed --fi=x.sed a.ts',
      "sed --no-such-option 's/a/b/' a.ts",
      // plainly mutating commands, alone or after a harmless prefix
      'rm -rf dist',
      "cd /work/repo && rm -rf dist",
      "cd /work/repo && grep -rln 'x' . | xargs rm",
      "grep -rln 'x' . | tee found.txt",
      'git commit -am x',
      'git add -A',
      'git checkout -- .',
      'npm install left-pad',
      'mkdir -p out',
      'touch a.ts',
      'chmod +x a.sh',
      'mv a b',
      'cp a b',
      'dd if=a of=b',
      "find . -name '*.tmp' -delete",
      "find . -name '*.tmp' -exec rm {} \\;",
      // unparseable / opaque shell fails CLOSED
      'grep -n x $(rm files.txt)',
      'grep -n x `cat files.txt`',
      'eval "rm -rf dist"',
      'grep -n x a.ts &',
      '(cd a && rm -rf b)',
      'bash -c "rm -rf dist"',
      './scripts/do-thing.sh',
      'node -e "require(\'fs\').writeFileSync(\'a\',\'b\')"',
      'FOO=1 rm -rf dist',
      '',
      '   ',
      // substitution / variable expansion must never launder a write
      'f=$(rm x); echo $f',
      'echo $(touch x)',
      'echo "$(rm x)"',
      'echo "\\$(rm x)"',
      'f=$(cat a.ts); $f x',
      'f=$(ls); sed -i s/a/b/ $f',
      'f=-delete; find . $F',
      'f=$(ls); sed -n "$f" a.ts',
      'f=$(ls); git commit -m $f',
      'PATH=$(pwd) ls',
      'PATH=/tmp; ls',
      'echo $((1+2))',
      'echo ${f:-x}',
      'echo $(ls $(rm x))',
      'f=$(ls > out.txt)',
      // xargs hands stdin to the inner command, so only data-only commands are accepted
      'ls | xargs rm',
      "ls | xargs sed -n '5p'",
      'ls | xargs find',
      'ls | xargs -p grep x',
      'ls | xargs',
      'ls | xargs -r',
    ])('%j', (cmd) => {
      expect(bashCanMutate(cmd), cmd).toBe(true);
    });

    it('a non-string command is a mutation (only fully understood input is a read)', () => {
      for (const value of [undefined, null, 42, {}, ['ls']]) {
        expect(bashCanMutate(value)).toBe(true);
      }
    });
  });

  describe('quoting does not smuggle a redirect past the stripper', () => {
    it('a quoted ">" is data, not a redirect', () => {
      expect(bashCanMutate("grep -n '>' a.ts")).toBe(false);
      expect(bashCanMutate('grep -n ">" a.ts')).toBe(false);
    });

    it('a /dev/null INSIDE quotes is not stripped, so a real redirect beside it still mutates', () => {
      expect(bashCanMutate("echo '2>/dev/null' > real.txt")).toBe(true);
    });
  });

  describe('subset property against the dispatcher classifier', () => {
    // Anything the dispatcher's replay-safety classifier calls a read must stay a non-mutation
    // here, otherwise this layer would be STRICTER than the thing it narrows (a regression of the
    // 17 pre-existing mix tests rather than a refinement).
    it.each([
      'ls -la packages',
      'cat a.ts | head -20',
      "sed -n '200,235p' a.ts",
      'pwd',
      'wc -l a.ts',
      'git log --oneline -5',
      'ps --ppid 123 | awk \'{print $2}\'',
    ])('dispatcher read => attribution non-mutation: %s', (cmd) => {
      expect(classifyCapabilityBashEffect({ command: cmd }), cmd).toBe('read');
      expect(bashCanMutate(cmd), cmd).toBe(false);
    });
  });

  describe('the dispatcher agrees on every sed write vector (WI-10005084)', () => {
    // The two layers share ONE sed parser (capability/bash-effect.ts `sedIsObservational`). Before
    // that, the dispatcher refused only the exact tokens `-i` / `--in-place`, so each of these was a
    // `read` there — and the MCP proxy replays a `read` after a refused upstream.
    it.each([
      "sed -i.bak 's/a/b/' a.ts",
      "sed -ni '1,5p' a.ts",
      "sed -n 'w out.txt' a.ts",
      "sed 's/a/b/e' a.ts",
      'sed -f script.sed a.ts',
      'sed -ew/tmp/x p a.ts',
      'sed -nes/a/b/w/tmp/x p a.ts',
      "sed --in-p 's/a/b/' a.ts",
      'sed --fi=x.sed a.ts',
    ])('sed write vector is a write for BOTH layers: %s', (cmd) => {
      expect(classifyCapabilityBashEffect({ command: cmd }), cmd).toBe('write');
      expect(bashCanMutate(cmd), cmd).toBe(true);
    });
  });
});

describe('capabilityBashCommand', () => {
  it('prefers `command` over `cmd`, as the dispatcher does', () => {
    expect(capabilityBashCommand({ command: 'a', cmd: 'b' })).toBe('a');
    expect(capabilityBashCommand({ cmd: 'b' })).toBe('b');
  });

  it('returns undefined for non-object args (an opaque code:run script string)', () => {
    expect(capabilityBashCommand("await tools.capability.bash({ cmd: 'ls' });")).toBeUndefined();
    expect(capabilityBashCommand(null)).toBeUndefined();
  });
});
