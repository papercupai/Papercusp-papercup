// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sync = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, unknown>>,
  invalidate: vi.fn(),
  useSyncQuery: vi.fn(),
}));

const desktop = vi.hoisted(() => ({
  enabled: false,
  invoke: vi.fn(),
}));

const notifications = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (options: Record<string, unknown>) => {
    sync.useSyncQuery(options);
    return {
      data: sync.jobs,
      loading: false,
      fetching: false,
      error: null,
      failureCount: 0,
      failureReason: null,
      transport: "polling",
      invalidate: sync.invalidate,
    };
  },
}));

vi.mock("@/lib/ipc-status-tauri", () => ({
  isDesktop: () => desktop.enabled,
  canUseContentOriginDesktopActions: async () => desktop.enabled,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => desktop.invoke(...args),
}));

import PersonalVaultSettingsPage, {
  facebookPersonalVaultConnectHref,
  googleWorkspaceConnectHref,
} from "./page";

vi.mock("sonner", () => ({ toast: notifications }));

const googleCapabilities = [
  {
    id: "gmail",
    sourceKind: "gmail",
    enabled: true,
    connected: true,
    status: "connected",
    missingScopes: [],
  },
  {
    id: "calendar",
    sourceKind: "gcal",
    enabled: true,
    connected: true,
    status: "connected",
    missingScopes: [],
  },
  {
    id: "contacts",
    sourceKind: "contacts",
    enabled: true,
    connected: true,
    status: "connected",
    missingScopes: [],
  },
];

const status = {
  ok: true,
  enabled: true,
  workspaceId: "papercusp-workspace",
  user: { id: "user-1", displayName: "Owner" },
  stats: {
    sources: [
      {
        source: "mail",
        source_id: "00000000-0000-4000-8000-000000000101",
        provider_account_id: "owner@example.com",
        documents: 12,
        newest_at: "2026-08-20T12:00:00Z",
      },
      {
        source: "mail",
        source_id: "00000000-0000-4000-8000-000000000102",
        provider_account_id: "backup@example.com",
        documents: 4,
        newest_at: "2026-08-19T12:00:00Z",
      },
    ],
    unembedded: 2,
  },
  importStorage: {
    owner: {
      retainedBytes: 512 * 1024 * 1024,
      reservedBytes: 512 * 1024 * 1024,
      usedBytes: 1024 * 1024 * 1024,
      remainingBytes: 31 * 1024 * 1024 * 1024,
      maxBytes: 32 * 1024 * 1024 * 1024,
      retainedJobs: 1,
      reservedJobs: 1,
      jobs: 2,
      remainingJobs: 6,
      maxJobs: 8,
    },
    workspace: {
      retainedBytes: 512 * 1024 * 1024,
      reservedBytes: 512 * 1024 * 1024,
      usedBytes: 1024 * 1024 * 1024,
      remainingBytes: 255 * 1024 * 1024 * 1024,
      maxBytes: 256 * 1024 * 1024 * 1024,
      retainedJobs: 1,
      reservedJobs: 1,
      jobs: 2,
      remainingJobs: 62,
      maxJobs: 64,
    },
  },
  grants: [],
  supportedSources: [
    "mail",
    "calendar",
    "contacts",
    "facebook",
    "instagram",
    "x",
  ],
  embedding: { mode: "gemma", localOnly: true },
  integrations: {
    google: {
      provider: "google",
      configured: true,
      connected: true,
      status: "connected",
      sources: [
        {
          kind: "gmail",
          status: "connected",
          lastConnectedAt: "2026-08-23T00:00:00.000Z",
          lastSyncAt: "2026-08-23T00:00:00.000Z",
        },
      ],
      capabilities: googleCapabilities,
      accounts: [
        {
          providerAccountId: "owner@example.com",
          displayName: "owner@example.com",
          connected: true,
          status: "connected",
          grantedScopes: [],
          sources: [
            {
              kind: "gmail",
              status: "connected",
              lastConnectedAt: "2026-08-23T00:00:00.000Z",
              lastSyncAt: "2026-08-23T00:00:00.000Z",
            },
          ],
          capabilities: googleCapabilities,
        },
      ],
    },
    facebook: {
      provider: "facebook",
      configured: true,
      connected: true,
      status: "degraded",
      sources: [
        {
          kind: "facebook",
          providerAccountId: "facebook-user-1",
          status: "degraded",
          lastConnectedAt: "2026-08-23T00:05:00.000Z",
          lastSyncAt: "2026-08-23T00:10:00.000Z",
        },
        {
          kind: "facebook",
          providerAccountId: "facebook-user-2",
          status: "connected",
          lastConnectedAt: "2026-08-23T00:06:00.000Z",
          lastSyncAt: "2026-08-23T00:11:00.000Z",
        },
      ],
      accounts: [
        {
          providerAccountId: "facebook-user-1",
          displayName: "Owner One",
          connected: true,
          status: "degraded",
          sources: [
            {
              kind: "facebook",
              providerAccountId: "facebook-user-1",
              status: "degraded",
              lastConnectedAt: "2026-08-23T00:05:00.000Z",
              lastSyncAt: "2026-08-23T00:10:00.000Z",
            },
          ],
        },
        {
          providerAccountId: "facebook-user-2",
          displayName: "Owner Two",
          connected: true,
          status: "connected",
          sources: [
            {
              kind: "facebook",
              providerAccountId: "facebook-user-2",
              status: "connected",
              lastConnectedAt: "2026-08-23T00:06:00.000Z",
              lastSyncAt: "2026-08-23T00:11:00.000Z",
            },
          ],
        },
      ],
    },
  },
};

const fetchMock = vi.fn();
const oauth = {
  authorizationUrl:
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=desktop-client&state=signed-state",
};

function importJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000901",
    sourceId: null,
    providerAccountId: "owner@example.com",
    filename: "takeout.mbox",
    contentType: "application/mbox",
    sizeBytes: 1024,
    status: "running",
    bytesProcessed: 512,
    entriesProcessed: 5,
    documentsSeen: 4,
    documentsImported: 3,
    warnings: [],
    cancelRequested: false,
    attemptCount: 1,
    maxAttempts: 5,
    nextAttemptAt: "2026-08-26T20:00:00.000Z",
    retainedUntil: "2026-09-02T20:00:00.000Z",
    lastError: null,
    startedAt: "2026-08-26T20:00:00.000Z",
    completedAt: null,
    createdAt: "2026-08-26T19:59:00.000Z",
    updatedAt: "2026-08-26T20:01:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  sync.jobs = [];
  sync.invalidate.mockReset();
  sync.useSyncQuery.mockReset();
  desktop.enabled = false;
  desktop.invoke.mockReset();
  desktop.invoke.mockResolvedValue(undefined);
  notifications.success.mockReset();
  notifications.error.mockReset();
  notifications.warning.mockReset();
  oauth.authorizationUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=desktop-client&state=signed-state";
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url === "/api/user/personal-vault" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json(status);
      }
      if (url.startsWith("/api/oauth/start?")) {
        return Response.json({
          ok: true,
          authorizationUrl: oauth.authorizationUrl,
        });
      }
      if (url === "/api/user/personal-vault" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { enabled: boolean };
        return Response.json({ ok: true, enabled: body.enabled });
      }
      if (url === "/api/user/personal-vault" && init?.method === "DELETE") {
        return Response.json({
          ok: true,
          removed: {
            documents: 12,
            cursors: 0,
            aliases: 0,
            identities: 0,
            importJobs: 1,
            importArchives: 1,
            importArchiveCleanupFailures: 0,
          },
        });
      }
      if (
        url === "/api/user/personal-vault/grants" &&
        init?.method === "POST"
      ) {
        return Response.json({ ok: true });
      }
      if (url === "/api/user/personal-vault/grants/preview") {
        return Response.json({
          ok: true,
          planSlug: "meeting-prep-brief",
          harnessSlug: "papercusp",
          principalType: "plan-template",
          principalId: "meeting-prep-brief",
          declaredScopes: ["personal:mail", "personal:calendar"],
        });
      }
      if (
        url === "/api/user/personal-vault/integrations/google" &&
        init?.method === "DELETE"
      ) {
        return Response.json({ ok: true, disconnectedSources: 3 });
      }
      if (
        url === "/api/user/personal-vault/integrations/google/capabilities" &&
        init?.method === "PATCH"
      ) {
        const body = JSON.parse(String(init.body)) as {
          capability: string;
          enabled: boolean;
        };
        return Response.json({ ok: true, ...body });
      }
      if (
        url.startsWith("/api/user/personal-vault/integrations/facebook?") &&
        init?.method === "DELETE"
      ) {
        return Response.json({ ok: true, disconnectedSources: 1 });
      }
      if (
        url.startsWith("/api/user/personal-vault/import?") &&
        init?.method === "POST"
      ) {
        return Response.json(
          { ok: true, duplicate: false, job: importJob() },
          { status: 202 },
        );
      }
      if (
        url.startsWith("/api/user/personal-vault/imports?") &&
        init?.method === "DELETE"
      ) {
        return Response.json({
          ok: true,
          job: importJob({ status: "cancelled", cancelRequested: true }),
        });
      }
      if (
        url === "/api/user/personal-vault/imports/retry" &&
        init?.method === "POST"
      ) {
        return Response.json({
          ok: true,
          job: importJob({ status: "queued", attemptCount: 0 }),
        });
      }
      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => cleanup());

describe("PersonalVaultSettingsPage", () => {
  it("keeps account controls usable when an older status response omits import storage", async () => {
    const { importStorage: _importStorage, ...olderStatus } = status;
    fetchMock.mockImplementationOnce(async () => Response.json(olderStatus));

    render(<PersonalVaultSettingsPage />);

    expect(
      await screen.findByRole("heading", { name: "Live integrations" }),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Archive storage forecast").textContent,
    ).toContain(
      "Storage forecast unavailable until the operator sidecar finishes updating.",
    );
    expect(
      screen.getByRole("button", { name: "Add Google account" }),
    ).toBeTruthy();
  });

  it("subscribes to owner import jobs and renders account-scoped progress actions", async () => {
    sync.jobs = [
      importJob(),
      importJob({
        id: "00000000-0000-4000-8000-000000000902",
        providerAccountId: "facebook-user-1",
        filename: "facebook.zip",
        status: "failed",
        bytesProcessed: 1024,
        lastError: "malformed archive member",
      }),
    ];
    render(<PersonalVaultSettingsPage />);

    expect(
      (await screen.findByLabelText("Archive storage forecast")).textContent,
    ).toContain("1.0 GB of 32.0 GB owner capacity");

    const activity = (
      await screen.findByRole("heading", { name: "Archive activity" })
    ).parentElement;
    expect(activity).toBeTruthy();
    expect(sync.useSyncQuery).toHaveBeenCalledWith({
      queryName: "personalVault.importJobs",
      args: { userId: "user-1", limit: 50 },
      enabled: true,
    });
    expect(within(activity!).getByText("owner@example.com")).toBeTruthy();
    expect(within(activity!).getByText("facebook-user-1")).toBeTruthy();
    expect(
      within(activity!).getByText(/50% · 512 B of 1.0 KB · 3 imported/i),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel import takeout.mbox" }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/personal-vault/imports?id=00000000-0000-4000-8000-000000000901",
        { method: "DELETE" },
      ),
    );
    await waitFor(() => expect(sync.invalidate).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: "Retry import facebook.zip" }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/personal-vault/imports/retry",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            id: "00000000-0000-4000-8000-000000000902",
          }),
        }),
      ),
    );
    await waitFor(() => expect(sync.invalidate).toHaveBeenCalledTimes(2));
  });

  it("streams an archive body to the 202 job endpoint with the selected account", async () => {
    const { container } = render(<PersonalVaultSettingsPage />);
    await screen.findByRole("heading", { name: "Import archives" });
    fireEvent.click(screen.getByLabelText("Archive account"));
    fireEvent.click(
      await screen.findByRole("option", { name: "Google · owner@example.com" }),
    );
    const file = new File(["mail"], "takeout.mbox", {
      type: "application/mbox",
    });
    const input = container.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    fireEvent.change(input!, { target: { files: [file] } });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) ===
            "/api/user/personal-vault/import?providerAccountId=owner%40example.com" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeTruthy();
      expect((call?.[1] as RequestInit).body).toBe(file);
      expect((call?.[1] as RequestInit).headers).toEqual({
        "content-type": "application/mbox",
        "x-papercusp-filename": "takeout.mbox",
      });
    });
    await waitFor(() => expect(sync.invalidate).toHaveBeenCalledTimes(1));
  });

  it("renders the local-only posture and imported source status", async () => {
    render(<PersonalVaultSettingsPage />);
    expect(
      await screen.findByRole("heading", { name: "Personal Vault" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /vectors are produced only by the local EmbeddingGemma model/i,
      ),
    ).toBeTruthy();
    expect(screen.getAllByText("personal:mail").length).toBeGreaterThanOrEqual(
      1,
    );
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("leads with a guided setup summary and one recommended next action", async () => {
    render(<PersonalVaultSettingsPage />);

    expect(
      await screen.findByRole("heading", { name: "Your setup" }),
    ).toBeTruthy();
    const progress = screen.getByRole("list", {
      name: "Personal Vault setup progress",
    });
    expect(within(progress).getByText("Connect accounts")).toBeTruthy();
    expect(within(progress).getByText("Bring in history")).toBeTruthy();
    expect(within(progress).getByText("Confirm progress")).toBeTruthy();
    expect(within(progress).getByText("3 accounts connected")).toBeTruthy();
    expect(within(progress).getByText("16 records stored")).toBeTruthy();

    const summary = screen.getByLabelText("Personal Vault summary");
    expect(within(summary).getByText("Connected accounts")).toBeTruthy();
    expect(within(summary).getByText("3")).toBeTruthy();
    expect(within(summary).getByText("Records stored")).toBeTruthy();
    expect(within(summary).getByText("16")).toBeTruthy();
    expect(
      screen.getByText(/Your vault is healthy. Add another account/i),
    ).toBeTruthy();
    expect(screen.getAllByText("Manage synced services").length).toBe(1);
  });

  it("uses the owner kill-switch endpoint without deleting data", async () => {
    render(<PersonalVaultSettingsPage />);
    const toggle = await screen.findByRole("checkbox", {
      name: /Enable Personal Vault imports/i,
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/personal-vault",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ enabled: false }),
        }),
      );
    });
    expect(screen.getByText(/It does not delete anything/i)).toBeTruthy();
  });

  it("renders duplicate source labels as account rows and purges only the selected account", async () => {
    render(<PersonalVaultSettingsPage />);
    fireEvent.click(
      await screen.findByText("Advanced privacy and access controls"),
    );
    const sourceSection = (
      await screen.findByRole("heading", { name: "Imported sources" })
    ).closest("section");
    expect(sourceSection).toBeTruthy();
    expect(within(sourceSection!).getByText("owner@example.com")).toBeTruthy();
    expect(within(sourceSection!).getByText("backup@example.com")).toBeTruthy();

    fireEvent.click(
      within(sourceSection!).getByRole("button", {
        name: "Purge personal:mail for owner@example.com",
      }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Purge personal:mail for owner@example.com?",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Permanently purge" }));

    await waitFor(() => {
      const purgeCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/user/personal-vault" &&
          (init as RequestInit | undefined)?.method === "DELETE",
      );
      expect(purgeCall).toBeTruthy();
      expect(JSON.parse(String((purgeCall?.[1] as RequestInit).body))).toEqual({
        source: "mail",
        sourceId: "00000000-0000-4000-8000-000000000101",
        providerAccountId: "owner@example.com",
        confirm: true,
      });
    });
  });

  it("renders Google live status and disconnects without invoking purge", async () => {
    render(<PersonalVaultSettingsPage />);
    expect(
      await screen.findByRole("heading", { name: "Live integrations" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add Google account" }),
    ).toBeTruthy();
    expect(googleWorkspaceConnectHref()).toBe(
      "/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events",
    );
    expect(googleWorkspaceConnectHref(false)).toBe(
      "/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner",
    );
    expect(googleWorkspaceConnectHref(true, "owner@example.com")).toBe(
      "/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner&account=owner%40example.com&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events",
    );
    const googleCard = screen
      .getByRole("heading", { name: "Google Workspace" })
      .closest("article");
    expect(googleCard).toBeTruthy();
    const accountCard = within(googleCard!)
      .getByRole("heading", { name: "owner@example.com" })
      .closest("section");
    expect(accountCard).toBeTruthy();
    expect(
      within(accountCard!).getByRole("checkbox", {
        name: "Enable Gmail live sync for owner@example.com",
      }),
    ).toBeTruthy();
    expect(
      within(accountCard!).getByRole("checkbox", {
        name: "Enable Calendar live sync for owner@example.com",
      }),
    ).toBeTruthy();
    expect(
      within(accountCard!).getByText(
        /Turning off one capability affects only this account/i,
      ),
    ).toBeTruthy();
    const contactsToggle = within(accountCard!).getByRole("checkbox", {
      name: "Enable Contacts live sync for owner@example.com",
    });
    fireEvent.click(contactsToggle);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/personal-vault/integrations/google/capabilities",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            providerAccountId: "owner@example.com",
            capability: "contacts",
            enabled: false,
          }),
        }),
      );
    });
    fireEvent.click(
      within(accountCard!).getByRole("button", {
        name: "Disconnect owner@example.com",
      }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/personal-vault/integrations/google?account=owner%40example.com",
        { method: "DELETE" },
      );
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/user/personal-vault",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("opens Google OAuth in the system browser and refreshes when desktop focus returns", async () => {
    desktop.enabled = true;
    render(<PersonalVaultSettingsPage />);
    await screen.findByRole("heading", { name: "Google Workspace" });

    fireEvent.click(screen.getByRole("button", { name: "Add Google account" }));

    const startUrl =
      "/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events&response=json";
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(startUrl, { cache: "no-store" });
      expect(desktop.invoke).toHaveBeenCalledWith("plugin:shell|open", {
        path: oauth.authorizationUrl,
      });
    });
    expect(
      screen.getByText(/Google sign-in is open in your browser/i),
    ).toBeTruthy();

    const statusReadsBeforeFocus = fetchMock.mock.calls.filter(
      ([url]) => String(url) === "/api/user/personal-vault",
    ).length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => String(url) === "/api/user/personal-vault",
        ),
      ).toHaveLength(statusReadsBeforeFocus + 1);
      expect(
        screen.queryByText(/Google sign-in is open in your browser/i),
      ).toBeNull();
    });
  });

  it("keeps reconnect account-scoped when opening Google in the system browser", async () => {
    desktop.enabled = true;
    render(<PersonalVaultSettingsPage />);
    const accountCard = within(
      (await screen.findByRole("heading", { name: "Google Workspace" })).closest(
        "article",
      )!,
    )
      .getByRole("heading", { name: "owner@example.com" })
      .closest("section");
    expect(accountCard).toBeTruthy();

    fireEvent.click(
      within(accountCard!).getByRole("button", {
        name: "Reconnect owner@example.com",
      }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/oauth/start?provider=google&plugin=google-workspace&harness=papercusp&field=owner&account=owner%40example.com&scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar.events&response=json",
        { cache: "no-store" },
      );
      expect(desktop.invoke).toHaveBeenCalledWith("plugin:shell|open", {
        path: oauth.authorizationUrl,
      });
    });
  });

  it("rejects an unsafe OAuth authorization URL without opening the browser", async () => {
    desktop.enabled = true;
    oauth.authorizationUrl = "https://example.test/not-google";
    render(<PersonalVaultSettingsPage />);
    await screen.findByRole("heading", { name: "Google Workspace" });

    fireEvent.click(screen.getByRole("button", { name: "Add Google account" }));

    await waitFor(() =>
      expect(notifications.error).toHaveBeenCalledWith(
        "Couldn’t open Google sign-in: OAuth server returned an unsafe authorization URL",
      ),
    );
    expect(desktop.invoke).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/Google sign-in is open in your browser/i),
    ).toBeNull();
  });

  it("shows an explicit consent upgrade for Calendar write access on the same connection", async () => {
    fetchMock.mockImplementationOnce(async () =>
      Response.json({
        ...status,
        integrations: {
          ...status.integrations,
          google: {
            ...status.integrations.google,
            accounts: status.integrations.google.accounts.map((account) => ({
              ...account,
              capabilities: account.capabilities.map((capability) =>
                capability.id === "calendar"
                  ? {
                      ...capability,
                      connected: false,
                      status: "needs-consent",
                      missingScopes: [
                        "https://www.googleapis.com/auth/calendar.events",
                      ],
                    }
                  : capability,
              ),
            })),
          },
        },
      }),
    );
    render(<PersonalVaultSettingsPage />);
    const card = (
      await screen.findByRole("heading", { name: "Google Workspace" })
    ).closest("article");
    expect(card).toBeTruthy();
    expect(
      within(card!).getByLabelText(
        "Calendar capability status for owner@example.com: needs-consent",
      ).textContent,
    ).toBe("Consent update required");
    expect(
      within(card!).getByRole("status", {
        name: "Calendar consent upgrade required for owner@example.com",
      }).textContent,
    ).toContain("never creates a second source");
    expect(
      within(card!).getByRole("button", {
        name: "Reconnect owner@example.com",
      }),
    ).toBeTruthy();
  });

  it("renders capability-accurate Facebook states and disconnects without purging settled data", async () => {
    render(<PersonalVaultSettingsPage />);
    const heading = await screen.findByRole("heading", { name: "Facebook" });
    const card = heading.closest("article");
    expect(card).toBeTruthy();
    expect(
      within(card!).getByLabelText("Facebook status: degraded").textContent,
    ).toBe("Degraded");
    expect(
      within(card!).getByText(
        /does not include Messenger, friends, private groups/i,
      ),
    ).toBeTruthy();
    expect(
      within(card!).getByText(/For fuller Facebook history/i),
    ).toBeTruthy();
    const accountCard = within(card!)
      .getByRole("heading", { name: "Owner Two" })
      .closest("section");
    expect(accountCard).toBeTruthy();
    expect(
      within(accountCard!).getByRole("button", { name: "Reconnect Owner Two" }),
    ).toBeTruthy();
    expect(
      within(card!).getByRole("button", { name: "Add Facebook Account" }),
    ).toBeTruthy();
    expect(facebookPersonalVaultConnectHref()).toBe(
      "/api/oauth/start?provider=provider%3Afacebook&plugin=provider%3Afacebook&harness=papercusp&field=owner",
    );
    expect(facebookPersonalVaultConnectHref("facebook-user-2")).toBe(
      "/api/oauth/start?provider=provider%3Afacebook&plugin=provider%3Afacebook&harness=papercusp&field=owner&account=facebook-user-2",
    );
    expect(
      screen.getByRole("note", { name: "Live integration privacy" })
        .textContent,
    ).toContain("Purge remains a separate, explicit action");

    fireEvent.click(
      within(accountCard!).getByRole("button", {
        name: "Disconnect Owner Two",
      }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/personal-vault/integrations/facebook?account=facebook-user-2",
        { method: "DELETE" },
      );
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/user/personal-vault",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it.each([
    ["needs-app-config", "Needs app setup", false],
    ["available", "Available", true],
    ["error", "Error", true],
  ] as const)(
    "renders the Facebook %s readiness state with the correct recovery affordance",
    async (integrationState, label, connectEnabled) => {
      fetchMock.mockImplementationOnce(async () =>
        Response.json({
          ...status,
          integrations: {
            ...status.integrations,
            facebook: {
              provider: "facebook",
              configured: integrationState !== "needs-app-config",
              connected: false,
              status: integrationState,
              sources: [],
            },
          },
        }),
      );
      render(<PersonalVaultSettingsPage />);
      const card = (
        await screen.findByRole("heading", { name: "Facebook" })
      ).closest("article");
      expect(card).toBeTruthy();
      expect(
        within(card!).getByLabelText("Facebook status: " + integrationState)
          .textContent,
      ).toBe(label);
      expect(
        (
          within(card!).getByRole("button", {
            name: "Connect Facebook",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(!connectEnabled);
      if (integrationState === "needs-app-config") {
        expect(within(card!).getByText(/clientSecretFile/)).toBeTruthy();
      }
    },
  );

  it("explains how to acquire supported provider archives with official links and formats", async () => {
    render(<PersonalVaultSettingsPage />);
    const instructions = (
      await screen.findByRole("heading", { name: "How to get an archive" })
    ).parentElement;
    expect(instructions?.textContent).toContain(
      "choose only Mail, Calendar, and Contacts",
    );
    expect(instructions?.textContent).toContain(
      "Choose Messages, all time, and JSON",
    );
    expect(instructions?.textContent).toContain(
      "Settings and privacy → Your account",
    );

    const links = screen.getAllByRole("link");
    expect(
      links
        .find((link) => link.textContent === "Google Takeout")
        ?.getAttribute("href"),
    ).toBe("https://takeout.google.com/settings/takeout");
    expect(
      links
        .find((link) => link.textContent === "Export your information guide")
        ?.getAttribute("href"),
    ).toBe("https://www.facebook.com/help/212802592074644");
    expect(
      links
        .find((link) => link.textContent === "official X archive guide")
        ?.getAttribute("href"),
    ).toBe("https://help.x.com/en/managing-your-account/accessing-your-x-data");
    expect(
      links.every((link) => link.getAttribute("target") === "_blank"),
    ).toBe(true);
    expect(
      links.every((link) => link.getAttribute("rel")?.includes("noopener")),
    ).toBe(true);
  });

  it("previews the plan declaration before the owner can approve it", async () => {
    render(<PersonalVaultSettingsPage />);
    fireEvent.click(
      await screen.findByText("Advanced privacy and access controls"),
    );
    fireEvent.change(await screen.findByLabelText("Plan slug"), {
      target: { value: "meeting-prep-brief" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review access" }));
    expect(
      await screen.findByRole("heading", {
        name: "Approve access for meeting-prep-brief",
      }),
    ).toBeTruthy();
    /* Scoped to the approval dialog on purpose: the direct-grant section below
       also renders a `personal:*` code chip per scope, so a page-wide count
       matches those too and says nothing about what the owner is approving.
       `getByText` throws on 0 or 2+, so this pins each declared scope to
       exactly one row of the dialog's list. */
    const approval = within(screen.getByRole("dialog"));
    expect(approval.getByText("personal:mail")).toBeTruthy();
    expect(approval.getByText("personal:calendar")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Approve declared scopes",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  /* The direct-grant mint path (WI-10001809). Before it existed the only route
     to an agent-role or work-item grant was a hand-typed curl, which carries no
     scope picker, no expiry and no statement of who it authorizes — so these
     assert the three things the curl could silently omit: which principal shape
     is sent, exactly which scopes the owner ticked, and that an expiry rides
     along unless the owner deliberately chose an open-ended grant. */
  async function openAdvanced() {
    fireEvent.click(
      await screen.findByText("Advanced privacy and access controls"),
    );
  }

  function directGrantPost() {
    return fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/user/personal-vault/grants" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
  }

  it("mints an agent-role grant with the ticked scopes and a finite expiry", async () => {
    render(<PersonalVaultSettingsPage />);
    await openAdvanced();
    fireEvent.change(await screen.findByLabelText("Agent role identifier"), {
      target: { value: "  operator  " },
    });
    fireEvent.click(screen.getByLabelText("Authorize Gmail"));
    fireEvent.click(screen.getByRole("button", { name: "Review grant" }));

    expect(
      await screen.findByRole("heading", { name: "Grant access to operator" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));

    await waitFor(() => {
      const call = directGrantPost();
      expect(call).toBeTruthy();
      const body = JSON.parse(String((call![1] as RequestInit).body)) as {
        principalType: string;
        principalId: string;
        scopes: string[];
        expiresAt?: string;
      };
      expect(body.principalType).toBe("agent-role");
      expect(body.principalId).toBe("operator");
      expect(body.scopes).toEqual(["personal:mail"]);
      expect(new Date(String(body.expiresAt)).getTime()).toBeGreaterThan(
        Date.now(),
      );
    });
  });

  it("sends the work-item principal type and no expiry for an open-ended grant", async () => {
    render(<PersonalVaultSettingsPage />);
    await openAdvanced();
    fireEvent.click(screen.getByLabelText("Principal type"));
    fireEvent.click(await screen.findByRole("option", { name: "Work item" }));
    fireEvent.change(await screen.findByLabelText("Work item identifier"), {
      target: { value: "WI-10001783" },
    });
    fireEvent.click(screen.getByLabelText("Authorize Calendar"));
    fireEvent.click(screen.getByLabelText("Grant expiry"));
    fireEvent.click(
      await screen.findByRole("option", { name: "Until I revoke it" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review grant" }));

    expect(
      await screen.findByText(/It stays active until you revoke it\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));

    await waitFor(() => {
      const call = directGrantPost();
      expect(call).toBeTruthy();
      const body = JSON.parse(String((call![1] as RequestInit).body)) as Record<
        string,
        unknown
      >;
      expect(body.principalType).toBe("binding");
      expect(body.principalId).toBe("WI-10001783");
      expect(body.scopes).toEqual(["personal:calendar"]);
      expect("expiresAt" in body).toBe(false);
    });
  });

  it("warns that a coding role would get a grant authorizing nothing", async () => {
    const { container } = render(<PersonalVaultSettingsPage />);
    await openAdvanced();
    const identifier = await screen.findByLabelText("Agent role identifier");
    const section = container.querySelector(
      '[aria-labelledby="vault-direct-grant-heading"]',
    );
    expect(section).toBeTruthy();

    fireEvent.change(identifier, { target: { value: "engineer" } });
    await waitFor(() =>
      expect(
        within(section as HTMLElement).getByRole("alert").textContent,
      ).toContain("would be created but would authorize nothing"),
    );

    fireEvent.change(identifier, { target: { value: "operator" } });
    await waitFor(() =>
      expect(within(section as HTMLElement).queryByRole("alert")).toBeNull(),
    );
  });
});
