import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({ lstat: vi.fn(), readlink: vi.fn(), chmod: vi.fn(), mkdir: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), ...fs }));
import { NodeWorkspaceHostCredentialDeliveryFilesystem, ensureSharedWorkspaceDirectory } from "./workspace-host-credential-delivery";

const directory = (uid = 0, mode = 0o755) => ({ uid, gid: 0, mode, isDirectory: () => true, isSymbolicLink: () => false });
const link = (uid = 0) => ({ uid, gid: 0, mode: 0o777, isDirectory: () => false, isSymbolicLink: () => true });

describe("bootc system directory aliases (WI-10007079)", () => {
  beforeEach(() => { vi.resetAllMocks(); fs.lstat.mockImplementation(async (path) => path === "/srv" || path === "/home" ? link() : directory()); });

  it.each(["var/srv", "/var/srv"])("accepts root-owned /srv -> %s and preserves workspace permissions", async (target) => {
    fs.readlink.mockResolvedValue(target);
    await ensureSharedWorkspaceDirectory("/srv/papercusp/workspaces/customer");
    expect(fs.chmod).toHaveBeenCalledWith("/var/srv/papercusp/workspaces/customer", 0o770);
    expect(fs.chmod).not.toHaveBeenCalledWith("/srv", expect.anything());
  });

  it("supports /home -> var/home for private credential directories", async () => {
    fs.readlink.mockResolvedValue("var/home");
    await new NodeWorkspaceHostCredentialDeliveryFilesystem().ensureDirectory("/home/testuser/.config");
    expect(fs.chmod).toHaveBeenCalledWith("/var/home/testuser/.config", 0o700);
  });

  it.each(["wrong-target", "user-owned-link", "writable-target", "symlink-target", "nested-link"])("rejects %s without changing permissions", async (scenario) => {
    fs.readlink.mockResolvedValue(scenario === "wrong-target" ? "/tmp/attacker" : "var/srv");
    fs.lstat.mockImplementation(async (path) => {
      if (path === "/srv") return link(scenario === "user-owned-link" ? 1000 : 0);
      if (path === "/var/srv" && scenario === "writable-target") return directory(0, 0o777);
      if (path === "/var/srv" && scenario === "symlink-target") return link();
      if (path === "/var/srv/customer" && scenario === "nested-link") return link();
      return directory();
    });
    await expect(ensureSharedWorkspaceDirectory("/srv/customer" )).rejects.toThrow(/refusing/);
    expect(fs.chmod).not.toHaveBeenCalled();
  });
});
