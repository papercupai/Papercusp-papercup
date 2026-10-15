// @vitest-environment jsdom

import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ ...options }),
}));
vi.mock("../../components/admin/AdminShell", () => ({
  default: ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="admin-shell" data-title={title}>
      {children}
    </div>
  ),
}));
vi.mock("@/app/admin/admission/AdmissionRunsClient", () => ({
  default: () => <div data-testid="admission-runs-client" />,
}));
vi.mock("@/app/admin/admission/TicketSourcesHealth", () => ({
  default: () => <div data-testid="ticket-sources-health" />,
}));

import { Route } from "./admission";

const Component = (Route as unknown as { component: () => JSX.Element })
  .component;

afterEach(cleanup);

describe("/admin/admission desktop route", () => {
  // A Next page without this TanStack wrapper renders the SPA fallback in the
  // Tauri shell, leaving an otherwise working owner dashboard unreachable.
  it("renders the canonical AdmissionRunsClient inside the Vite AdminShell", () => {
    render(<Component />);

    expect(screen.getByTestId("admin-shell").getAttribute("data-title")).toBe(
      "Admission",
    );
    expect(screen.getByTestId("admission-runs-client")).toBeTruthy();
  });

  // The Next-style page.tsx is not what Tauri renders, so the ticket-source table
  // (linear-asana-task-sync D-014.7) must be mounted by this wrapper too.
  it("renders the ticket-source health table beside the admission ledger", () => {
    render(<Component />);
    expect(screen.getByTestId("ticket-sources-health")).toBeTruthy();
  });
});
