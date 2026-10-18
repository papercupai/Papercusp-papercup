import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function productionFiles(): string[] {
  return execFileSync('git', ['ls-files', '--recurse-submodules', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .filter((file) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file))
    .filter((file) => /^(?:apps\/operator|packages\/operator-core|packages\/agent-mcp|libs\/host-platform)\//.test(file))
    .filter((file) => !/(?:^|\/)(?:node_modules|dist|build|coverage|scratch|test|tests|__tests__|__fixtures__|fixtures|e2e)(?:\/|$)/.test(file))
    .filter((file) => !/\.(?:test|spec|integration\.test)\.[^.]+$/.test(file))
    .filter((file) => !/(?:generated|\.gen\.)/.test(file))
    .filter((file) => file !== 'libs/host-platform/src/home.mjs')
    .filter((file) => ![
      'apps/operator/lib/mcp-proxy/proxy.ts',
      'packages/operator-core/lib/papercusp-root.ts',
      'packages/operator-core/lib/storage/disk-space-alarm.ts',
      'packages/operator-core/lib/desktop-install/stamp-installed-cc-hooks.ts',
      'packages/operator-core/lib/voice-node/local-whisper-service.ts',
      // Installed as raw files outside the checkout; workspace-package imports
      // are unavailable there. Their existing isolation-pin suites cover them.
      'apps/operator/scripts/hooks/omp/inject-hook.ts',
      'apps/operator/scripts/hooks/inject/delivery-ledger.mjs',
    ].includes(file));
}

function uncommentedLines(source: string): string[] {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('/*') &&
      !trimmed.startsWith('*') && !trimmed.startsWith('#');
  });
}

describe('host-home path lint', () => {
  it('routes OS-home Papercusp paths through @papercusp/host-platform/home', () => {
    const violations: string[] = [];
    const directJoin = /(?:join|path\.join)\([^\n;]*(?:homedir|os\.homedir|process\.env\.HOME|\bHOME\b)[^\n;]*['"]\.papercusp(?!-workspaces)(?:['"/])/;
    const envFallback = /PAPERCUSP_HOME\s*(?:\|\||\?\?)\s*join\([^\n;]*\.papercusp(?!-workspaces)/;
    const homeTemplate = /\$\{(?:process\.env\.)?HOME\}\/\.papercusp(?!-workspaces)/;

    for (const file of productionFiles()) {
      const lines = uncommentedLines(readFileSync(resolve(repoRoot, file), 'utf8'));
      lines.forEach((line, index) => {
        if (directJoin.test(line) || envFallback.test(line) || homeTemplate.test(line)) {
          violations.push(`${file}:${index + 1}:${line.trim()}`);
        }
      });
    }

    expect(violations, `direct host-home paths found:\n${violations.join('\n')}`).toEqual([]);
  });
});
