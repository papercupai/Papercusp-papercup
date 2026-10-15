import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { satisfies } from '../../../scripts/check-peer-dep-conflicts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
type Manifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

function installedManifest(require: NodeJS.Require, name: string): Manifest {
  try {
    return JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8'));
  } catch {
    // Package exports may hide package.json; resolve the real entry point and
    // walk to its owning manifest, as the existing Glide contract guard does.
    let dir = dirname(require.resolve(name));
    while (dirname(dir) !== dir) {
      const file = join(dir, 'package.json');
      if (existsSync(file)) {
        const manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
        if (manifest.name === name) return manifest;
      }
      dir = dirname(dir);
    }
    throw new Error(`No installed manifest for ${name}`);
  }
}

// install:safe intentionally supports legacy-peer-deps while older upstream
// React peers remain. That mode does not auto-install required peers: each
// consumer must supply them explicitly, including type-only peers.
const cases = [
  ['packages/operator-core', '@openrouter/ai-sdk-provider', 'ai', 'dependencies'],
  ['libs/test-config', '@nestjs/testing', '@nestjs/core', 'devDependencies'],
  ['apps/operator', 'markmap-view', 'markmap-common', 'dependencies'],
  ['apps/operator-docs', '@readme/openapi-parser', 'openapi-types', 'devDependencies'],
  ['apps/operator', 'livekit-client', '@types/dom-mediacapture-record', 'devDependencies'],
] as const;

describe('required transitive peer dependency contracts', () => {
  describe.each(cases)('%s supplies %s peer %s', (workspace, parent, peer, section) => {
    const file = resolve(root, workspace, 'package.json');
    const require = createRequire(file);

    it('declares the peer at its consumer so a legacy-peer install retains it', () => {
      const consumer = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      const range = consumer[section]?.[peer];
      expect(range, `${workspace} must declare ${parent}'s required peer ${peer}`).toBeTruthy();
    });

    it('resolves a compatible peer from the actual requiring package', () => {
      const parentManifest = installedManifest(require, parent);
      const range = parentManifest.peerDependencies?.[peer];
      expect(range).toBeTruthy();
      expect(parentManifest.peerDependenciesMeta?.[peer]?.optional).not.toBe(true);
      const parentRequire = createRequire(require.resolve(parent));
      const peerManifest = installedManifest(parentRequire, peer);
      expect(satisfies(peerManifest.version, range!)).toBe(true);
    });
  });

  it('compiles and closes a real Nest testing module with its supplied core', async () => {
    const require = createRequire(resolve(root, 'libs/test-config/package.json'));
    const { Test } = require('@nestjs/testing') as typeof import('@nestjs/testing');
    const token = Symbol('required-peer-positive-control');
    const module = await Test.createTestingModule({
      providers: [{ provide: token, useValue: 42 }],
    }).compile();
    try {
      expect(module.get(token)).toBe(42);
    } finally {
      await module.close();
    }
  });

  describe('Stagehand browser and model dependencies', () => {
    const consumerRequire = createRequire(resolve(root, 'apps/operator/package.json'));

    it('resolves its selected Puppeteer client within the Stagehand peer range', () => {
      const stagehand = installedManifest(consumerRequire, '@browserbasehq/stagehand');
      const range = stagehand.peerDependencies?.['puppeteer-core'];
      expect(range).toBeTruthy();
      const stagehandRequire = createRequire(consumerRequire.resolve('@browserbasehq/stagehand'));
      const browser = installedManifest(stagehandRequire, 'puppeteer-core');
      expect(satisfies(browser.version, range!), `Puppeteer ${browser.version} must satisfy ${range}`).toBe(true);
    });

    it('keeps any transitive LangChain adapter compatible with its actual core', () => {
      const stagehand = installedManifest(consumerRequire, '@browserbasehq/stagehand');
      // Current Stagehand uses the AI SDK directly. Older releases brought a
      // LangChain adapter; if one returns, verify the peer where it resolves.
      expect(stagehand.dependencies?.ai).toBeTruthy();
      if (!stagehand.dependencies?.['@langchain/openai']) return;
      const stagehandRequire = createRequire(consumerRequire.resolve('@browserbasehq/stagehand'));
      const adapter = installedManifest(stagehandRequire, '@langchain/openai');
      const range = adapter.peerDependencies?.['@langchain/core'];
      expect(range).toBeTruthy();
      const adapterRequire = createRequire(stagehandRequire.resolve('@langchain/openai'));
      const core = installedManifest(adapterRequire, '@langchain/core');
      expect(satisfies(core.version, range!), `LangChain core ${core.version} must satisfy ${range}`).toBe(true);
    });

    it('loads the real Stagehand and Puppeteer entrypoints used by browser exploration', () => {
      const { Stagehand } = consumerRequire('@browserbasehq/stagehand');
      const stagehandRequire = createRequire(consumerRequire.resolve('@browserbasehq/stagehand'));
      const browser = stagehandRequire('puppeteer-core');
      expect(typeof Stagehand).toBe('function');
      expect(typeof Stagehand.prototype.init).toBe('function');
      expect(typeof Stagehand.prototype.agent).toBe('function');
      expect(typeof Stagehand.prototype.close).toBe('function');
      expect(typeof browser.launch).toBe('function');
    });
  });
});
