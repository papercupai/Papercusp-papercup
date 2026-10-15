import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChecksConfig, validateChecksConfig } from "./checks-config.js";

const TEMPLATES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../templates",
);

const valid = {
  app: { name: "quartermaster", root: "." },
  confinement: {
    blueprints: ["blueprints/quartermaster-ops/blueprint.yaml"],
    dangerousCapabilities: ["cart:*", "checkout:*", "approvals:write"],
    dangerousTools: ["checkout:*"],
  },
  seam: {
    workItemKind: "purchase-research",
    contractModule: "packages/contracts/src/index.ts",
    parseInputExport: "parsePurchaseResearchInput",
    parseOutputExport: "parseCandidateSet",
    joinKey: "itemId",
    validInput: { itemId: 42, item: "Cash Drawer", qty: 2 },
    validOutput: {
      itemId: 42,
      candidates: [],
      searchNotes: "none qualified",
      ts: "2026-07-04T00:00:00Z",
    },
    invalidOutput: { itemId: 42, candidates: [] },
    agentBlueprint: "blueprints/purchase-agent/blueprint.yaml",
    operation: {
      id: "research-purchase",
      version: "1",
      planTemplate: {
        ref: "purchase-research",
        revision: "7",
        contentHash: "a".repeat(64),
      },
    },
  },
  boot: {
    mode: "attach",
    discoveryFile: "~/.quartermaster/operator.json",
    discoveryHomeEnv: "QUARTERMASTER_HOME",
  },
  nativeDesktop: {
    cargoManifest: "apps/desktop/src-tauri/Cargo.toml",
    cargoLock: "apps/desktop/src-tauri/Cargo.lock",
    tauriConfig: "apps/desktop/src-tauri/tauri.conf.json",
    icons: ["apps/desktop/src-tauri/icons/icon.png"],
  },
  gym: {
    blueprint: "blueprints/quartermaster-ops/blueprint.yaml",
    requiredSignals: ["no-checkout-reach"],
  },
  mobileBase: {
    rustMsrv: "1.88",
    rootCargo: "Cargo.toml",
    cargoLock: "Cargo.lock",
    crateManifests: [
      "crates/store_core/Cargo.toml",
      "crates/store_bindings/Cargo.toml",
      "crates/store_cli/Cargo.toml",
    ],
    udl: "crates/store_bindings/src/store.udl",
    uniffiConfig: "crates/store_bindings/uniffi.toml",
    bindgen: "crates/store_bindings/src/bin/uniffi-bindgen.rs",
    tokenSource: "design/mobile-tokens.json",
    generatedTokenFiles: [
      "android/app/src/main/java/dev/store/DesignTokens.kt",
      "ios/Store/DesignTokens.swift",
    ],
    requiredPaths: ["Makefile"],
    scanRoots: ["crates", "android", "ios", "design"],
    forbiddenTokens: ["com.example", "example.invalid", "MobileApp"],
    allowlistedFiles: ["docs/template-provenance.md"],
    secretPathPatterns: ["(^|/)release\\.jks$"],
    portableCommands: [
      { id: "rust-test", command: ["cargo", "test", "--workspace"] },
      {
        id: "token-drift",
        command: ["node", "tools/generate-mobile-tokens.mjs", "--check"],
      },
    ],
  },
};

describe("validateChecksConfig", () => {
  it("accepts a fully-populated config", () => {
    expect(validateChecksConfig(valid)).toEqual([]);
  });

  it("accepts a minimal config (app only — every check skips)", () => {
    expect(validateChecksConfig({ app: { name: "x" } })).toEqual([]);
  });

  it("collects every error, not just the first", () => {
    const errors = validateChecksConfig({
      app: {},
      confinement: { blueprints: [], dangerousCapabilities: "cart" },
      boot: { mode: "spawn", discoveryFile: "" },
      nativeDesktop: { cargoManifest: "", icons: [] },
      gym: { requiredSignals: [] },
    });
    expect(errors).toContain("app.name: required non-empty string");
    expect(errors).toContain("confinement.blueprints: must be non-empty");
    expect(errors).toContain(
      "confinement.dangerousCapabilities: must be a list of non-empty strings",
    );
    expect(errors).toContain(
      "boot.command: required (list of strings) in spawn mode",
    );
    expect(errors).toContain("boot.discoveryFile: required non-empty string");
    expect(errors).toContain("nativeDesktop.cargoManifest: required non-empty string");
    expect(errors).toContain("nativeDesktop.cargoLock: required non-empty string");
    expect(errors).toContain("nativeDesktop.tauriConfig: required non-empty string");
    expect(errors).toContain("nativeDesktop.icons: must be non-empty");
    expect(errors).toContain("gym.blueprint: required non-empty string");
    expect(errors).toContain("gym.requiredSignals: must be non-empty");
  });

  it("accepts boot.pgDataDir as an optional non-empty string", () => {
    expect(
      validateChecksConfig({
        app: { name: "x" },
        boot: {
          mode: "spawn",
          discoveryFile: "~/.x/operator.json",
          command: ["node", "server.js"],
          pgDataDir: "~/.x/postgres",
        },
      }),
    ).toEqual([]);
  });

  it("rejects boot.pgDataDir when present but empty", () => {
    const errors = validateChecksConfig({
      app: { name: "x" },
      boot: {
        mode: "attach",
        discoveryFile: "~/.x/operator.json",
        pgDataDir: "",
      },
    });
    expect(errors).toContain(
      "boot.pgDataDir: must be a non-empty string when present",
    );
  });

  it("rejects boot.discoveryHomeEnv when present but empty", () => {
    const errors = validateChecksConfig({
      app: { name: "x" },
      boot: {
        mode: "attach",
        discoveryFile: "~/.x/operator.json",
        discoveryHomeEnv: "",
      },
    });
    expect(errors).toContain(
      "boot.discoveryHomeEnv: must be a non-empty string when present",
    );
  });

  it("rejects a seam section missing its gates and fixtures", () => {
    const errors = validateChecksConfig({
      app: { name: "x" },
      seam: { workItemKind: "k" },
    });
    expect(errors).toContain("seam.contractModule: required non-empty string");
    expect(errors).toContain(
      "seam.parseInputExport: required non-empty string",
    );
    expect(errors).toContain(
      "seam.parseOutputExport: required non-empty string",
    );
    expect(errors).toContain("seam.agentBlueprint: required non-empty string");
    expect(errors).toContain("seam.operation: required object");
    expect(errors).toContain("seam.validInput: required object fixture");
    expect(errors).toContain("seam.invalidOutput: required object fixture");
  });

  it("accepts an optional seam.rootBlueprint and rejects an empty one", () => {
    expect(
      validateChecksConfig({
        ...valid,
        seam: { ...valid.seam, rootBlueprint: ".papercusp/blueprint.yaml" },
      }),
    ).toEqual([]);
    expect(
      validateChecksConfig({ ...valid, seam: { ...valid.seam, rootBlueprint: "" } }),
    ).toContain("seam.rootBlueprint: must be a non-empty string when present");
  });

  it("rejects an unpinned seam operation declaration", () => {
    const errors = validateChecksConfig({
      ...valid,
      seam: {
        ...valid.seam,
        operation: {
          id: "research-purchase",
          version: "1",
          planTemplate: { ref: "purchase-research", revision: "7", contentHash: "not-a-hash" },
        },
      },
    });
    expect(errors).toContain("seam.operation.planTemplate.contentHash: must be sha256 hex");
  });

  it("validates tagged composition decision answers when present", () => {
    expect(
      validateChecksConfig({
        app: { name: "x" },
        composition: {
          templateYamls: ["template.yaml"],
          decisionPointAnswers: { "root:purpose": "A complete answer" },
        },
      }),
    ).toEqual([]);
    expect(
      validateChecksConfig({
        app: { name: "x" },
        composition: {
          templateYamls: ["template.yaml"],
          decisionPointAnswers: { "root:purpose": "" },
        },
      }),
    ).toContain(
      "composition.decisionPointAnswers.root:purpose: must be a non-empty string",
    );
  });

  it("rejects an incomplete mobile base and duplicate command ids", () => {
    const errors = validateChecksConfig({
      app: { name: "x" },
      mobileBase: {
        crateManifests: ["one/Cargo.toml"],
        generatedTokenFiles: ["Tokens.kt"],
        requiredPaths: [],
        scanRoots: [],
        forbiddenTokens: [],
        portableCommands: [
          { id: "test", command: [] },
          { id: "test", command: ["cargo", "test"], timeoutMs: 0 },
        ],
      },
    });
    expect(errors).toContain("mobileBase.rootCargo: required non-empty string");
    expect(errors).toContain(
      "mobileBase.crateManifests: must contain exactly core, bindings, and CLI manifests",
    );
    expect(errors).toContain(
      "mobileBase.generatedTokenFiles: must contain at least Kotlin and Swift outputs",
    );
    expect(errors).toContain("mobileBase.requiredPaths: must be non-empty");
    expect(errors).toContain(
      "mobileBase.portableCommands[1].id: duplicate 'test'",
    );
    expect(errors).toContain(
      "mobileBase.portableCommands[1].timeoutMs: must be a positive number when present",
    );
  });

  it("rejects an incomplete Android shell and duplicate assertion legs", () => {
    const errors = validateChecksConfig({
      app: { name: "x" },
      androidShell: {
        minSdk: 0,
        compileSdk: 36,
        targetSdk: 36,
        javaVersion: 17,
        abis: [],
        signingInputNames: [],
        selectedCapabilities: [],
        allowedPermissions: [],
        debugCleartext: "false",
        paths: {
          unitTestRoots: [],
          instrumentationTestRoots: [],
        },
        assertions: [
          {
            assertionId: "MOB-AND-001",
            leg: "toolchain-build",
            command: [],
          },
          {
            assertionId: "MOB-AND-001",
            leg: "toolchain-build",
            command: ["bash", "tools/check.sh"],
            timeoutMs: 0,
            expectedExit: "sometimes",
          },
        ],
      },
    });

    expect(errors).toContain(
      "androidShell.namespace: required non-empty string",
    );
    expect(errors).toContain("androidShell.minSdk: required positive integer");
    expect(errors).toContain("androidShell.abis: must be non-empty");
    expect(errors).toContain("androidShell.debugCleartext: required boolean");
    expect(errors).toContain(
      "androidShell.paths.appGradle: required non-empty string",
    );
    expect(errors).toContain(
      "androidShell.paths.proguardRules: required non-empty string",
    );
    expect(errors).toContain(
      "androidShell.paths.unitTestRoots: must be non-empty",
    );
    expect(errors).toContain(
      "androidShell.assertions[0].command: must be non-empty",
    );
    expect(errors).toContain(
      "androidShell.assertions[1]: duplicate assertion leg 'MOB-AND-001/toolchain-build'",
    );
    expect(errors).toContain(
      "androidShell.assertions[1].timeoutMs: must be a positive number when present",
    );
    expect(errors).toContain(
      "androidShell.assertions[1].expectedExit: must be 'zero' or 'nonzero' when present",
    );
  });

  it("rejects an incomplete iPhone shell and duplicate assertion legs", () => {
    const errors = validateChecksConfig({
      app: { name: "x" },
      iphoneShell: {
        hostStrategy: "remote-host",
        simulatorTargets: [],
        signingInputNames: [],
        selectedCapabilities: [],
        entitlementKeys: [],
        privacyUsageDescriptionKeys: [],
        backgroundModes: [],
        paths: { unitTestRoots: [], uiTestRoots: [] },
        assertions: [
          {
            assertionId: "MOB-IOS-001",
            leg: "project-generation",
            command: [],
          },
          {
            assertionId: "MOB-IOS-001",
            leg: "project-generation",
            command: ["xcodegen", "generate"],
            timeoutMs: 0,
            expectedExit: "sometimes",
          },
        ],
      },
    });

    expect(errors).toContain("iphoneShell.bundleId: required non-empty string");
    expect(errors).toContain(
      "iphoneShell.remoteHost: required non-empty string for remote-host strategy",
    );
    expect(errors).toContain("iphoneShell.simulatorTargets: must be non-empty");
    expect(errors).toContain(
      "iphoneShell.paths.projectSpec: required non-empty string",
    );
    expect(errors).toContain(
      "iphoneShell.paths.unitTestRoots: must be non-empty",
    );
    expect(errors).toContain(
      "iphoneShell.assertions[0].command: must be non-empty",
    );
    expect(errors).toContain(
      "iphoneShell.assertions[1]: duplicate assertion leg 'MOB-IOS-001/project-generation'",
    );
    expect(errors).toContain(
      "iphoneShell.assertions[1].timeoutMs: must be a positive number when present",
    );
    expect(errors).toContain(
      "iphoneShell.assertions[1].expectedExit: must be 'zero' or 'nonzero' when present",
    );
  });

  it("parseChecksConfig throws on invalid, returns typed on valid", () => {
    expect(() => parseChecksConfig({})).toThrow(/invalid checks config/);
    expect(parseChecksConfig(valid).app.name).toBe("quartermaster");
    expect(parseChecksConfig(valid).seam?.agentBlueprint).toBe(
      "blueprints/purchase-agent/blueprint.yaml",
    );
    expect(parseChecksConfig(valid).seam?.operation.id).toBe("research-purchase");
  });

  it("the committed worked-example reference config validates", () => {
    const raw = JSON.parse(
      readFileSync(
        join(
          TEMPLATES_DIR,
          "papercusp-app/reference/worked-example.checks-config.json",
        ),
        "utf8",
      ),
    );
    expect(validateChecksConfig(raw)).toEqual([]);
  });

  it("the committed mobile-base reference config validates", () => {
    const raw = JSON.parse(
      readFileSync(
        join(
          TEMPLATES_DIR,
          "papercusp-mobile-base/reference/mobile-base.checks-config.example.json",
        ),
        "utf8",
      ),
    );
    expect(validateChecksConfig(raw)).toEqual([]);
  });

  it("the committed Android-shell reference config validates", () => {
    const raw = JSON.parse(
      readFileSync(
        join(
          TEMPLATES_DIR,
          "papercusp-android-shell/reference/android-shell.checks-config.example.json",
        ),
        "utf8",
      ),
    );
    expect(validateChecksConfig(raw)).toEqual([]);
  });

  it("the committed iPhone-shell reference config validates", () => {
    const raw = JSON.parse(
      readFileSync(
        join(
          TEMPLATES_DIR,
          "papercusp-iphone-shell/reference/iphone-shell.checks-config.example.json",
        ),
        "utf8",
      ),
    );
    expect(validateChecksConfig(raw)).toEqual([]);
  });

  it("the committed Android-app answer record validates structurally", () => {
    const raw = JSON.parse(
      readFileSync(
        join(
          TEMPLATES_DIR,
          "papercusp-android-app/reference/android-app.checks-config.example.json",
        ),
        "utf8",
      ),
    );
    expect(validateChecksConfig(raw)).toEqual([]);
  });

  it("the committed iPhone-app answer record validates structurally", () => {
    const raw = JSON.parse(
      readFileSync(
        join(
          TEMPLATES_DIR,
          "papercusp-iphone-app/reference/iphone-app.checks-config.example.json",
        ),
        "utf8",
      ),
    );
    expect(validateChecksConfig(raw)).toEqual([]);
  });
});
