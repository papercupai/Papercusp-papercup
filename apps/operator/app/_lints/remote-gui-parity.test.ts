/**
 * P-017 remote-GUI parity guard.
 *
 * The thin GUI and a plain browser consume the same operator SPA. These checks
 * pin the cross-surface seams that can otherwise regress independently: all
 * remote data stays same-origin HTTP/SSE, while local OS effects require the
 * shell's structured content-origin ownership proof. A mere Tauri global is
 * never authority when the GUI is displaying a forwarded/hosted Server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("remote GUI parity", () => {
  it("uses one SPA and same-origin HTTP/SSE for the core remote surfaces", () => {
    expect(
      read("apps/operator-vite/src/routes/cloud-workspaces.tsx"),
    ).toContain("import Page from '@/app/cloud-workspaces/page'");

    const workspaces = read("packages/operator-core/lib/workspaces-tauri.ts");
    expect(workspaces).toMatch(
      /return http<WorkspaceRegistry>\(['"]\/api\/workspaces['"]\s*[,)]/,
    );
    expect(workspaces).toContain(
      "await http<unknown>('/api/workspaces/switch'",
    );

    const sessions = read(
      "apps/operator/app/adv/sessions/AdvSessionsClient.tsx",
    );
    expect(sessions).toContain("fetch(`/api/adv/sessions/search?");
    expect(sessions).toContain("fetch(`/api/adv/sessions/state?");

    const transcripts = read(
      "apps/operator/app/harness/AgentThinkingStream.tsx",
    );
    expect(transcripts).toContain("createResilientEventSource({");
    expect(transcripts).toContain(
      "`/api/harness/${slug}/agents/${runId}/stream?phase=${phase}`",
    );

    const root = read("apps/operator-vite/src/routes/__root.tsx");
    expect(root).toContain("<ChatRefPopupHost />");
    expect(root).toContain("<OfflineIndicator />");

    const sync = read("apps/operator/providers/HarnessSyncProvider.tsx");
    expect(sync).toContain('syncType="SSE"');
    expect(sync).toContain("const DEFAULT_REST_ENDPOINT = '/api/zero-harness'");
  });

  it("guards local desktop effects with structured content-origin ownership", () => {
    const guarded = [
      "apps/operator/app/_components/DesktopAttentionNotifier.tsx",
      "apps/operator/app/_components/DesktopConsoleLaunchBridge.tsx",
      "apps/operator/app/_components/DesktopSupervisorBanner.tsx",
      "apps/operator/app/_components/ExternalLinkProvider.tsx",
      "apps/operator/app/_components/NativeTerminalGate.tsx",
      "apps/operator/app/_components/TerminalDivider.tsx",
      "apps/operator/app/_components/UpdateChip.tsx",
      "apps/operator/app/adv/sessions/AdvSessionsClient.tsx",
      "apps/operator/app/harness/AgentInspectorModal.tsx",
    ];
    for (const path of guarded) {
      expect(read(path), path).toContain("canUseContentOriginDesktopActions");
    }

    const bridge = read(
      "apps/operator/app/_components/DesktopConsoleLaunchBridge.tsx",
    );
    expect(
      bridge.indexOf("await canUseContentOriginDesktopActions()"),
    ).toBeLessThan(bridge.indexOf("/api/agent-mcp/console/launch-claim"));
    expect(bridge).toContain("getOrCreateClientId");
    expect(bridge).toContain("args.targetClientId !== clientId");
    expect(bridge.indexOf("args.targetClientId !== clientId")).toBeLessThan(
      bridge.indexOf("/api/agent-mcp/console/launch-claim"),
    );
    expect(bridge).not.toContain("args.envelope");

    const route = read(
      "packages/operator-core/lib/endpoint-route/routes/agent-mcp/console-launch-bridge.ts",
    );
    expect(route).toContain("claimConsoleLaunch(body.ticket, body.clientId)");

    const operatorBridge = read(
      "packages/operator-core/lib/console-launch-bridge.ts",
    );
    expect(operatorBridge).toContain("requestRemoteWorkspaceConsoleLaunch");
    expect(operatorBridge).not.toContain("envelope: opts.envelope as unknown");

    for (const path of [
      "apps/operator/app/adv/sessions/AdvSessionsClient.tsx",
      "apps/operator/app/harness/AgentInspectorModal.tsx",
    ]) {
      const source = read(path);
      const proof = source.indexOf("await canUseContentOriginDesktopActions()");
      expect(proof, path).toBeGreaterThan(-1);
      expect(
        source.slice(proof).search(/fetch\(["']\/api\/adv\/sessions\/focus["']/),
        path,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps the remote Server chooser HTTPS-only and credential-free", () => {
    const gate = read(
      "apps/operator-vite/src/components/ServerConnectionGate.tsx",
    );
    expect(gate).toContain("url.protocol !== 'https:'");
    expect(gate).toContain("url.username || url.password");
    expect(gate).toContain("window.location.assign(normalized)");
  });
});
