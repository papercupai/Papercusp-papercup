// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CLOUD_TUTORIAL_ID, CLOUD_TUTORIAL_VERSION } from "@papercusp/operator-core/lib/onboarding/cloud-tutorial-lesson";
import { hostedBrowserApiMarker } from "../hosted-browser-api";
import { useCloudTutorialProgress } from "./use-cloud-tutorial-progress";

const scope = { tenantId: "tenant-1", userId: "user-1", workspaceId: "customer-1" };
function record(revision = 0, disposition = "active", boundScope = scope) {
  return { revision, mutationId: null, progress: { scope: boundScope, lessonId: CLOUD_TUTORIAL_ID, version: CLOUD_TUTORIAL_VERSION, disposition } };
}
function response(value = record(), status = 200) { return new Response(JSON.stringify({ record: value }), { status }); }
function Fixture({ selection = "one" }) {
  const { state, dispatch, notice, retry } = useCloudTutorialProgress(selection);
  return <>{state ? <><p>{state.scope.workspaceId}:{state.disposition}</p>
    <button onClick={() => dispatch({ type: "action", action: "pause" })}>Pause</button>
    <button onClick={() => dispatch({ type: "action", action: "resume" })}>Resume</button>
    <button onClick={() => dispatch({ type: "observe", observation: { scope: state.scope, access: "allowed", revision: 1, connection: { id: "gcp", provider: "gcp", validated: true } } })}>Observe</button></> : <p>No scope</p>}
    {notice && <p role="status">{notice}</p>}<button onClick={retry}>Retry</button></>;
}
beforeEach(() => {
  window.__PAPERCUSP_HOSTED_BROWSER__ = hostedBrowserApiMarker("control");
  delete window.__PAPERCUSP_HOSTED_BROWSER_API__;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete window.__PAPERCUSP_HOSTED_BROWSER__; });
describe("Authenticated tutorial progress client", () => {
  it("restores the server scope and saves only UI progress with CAS, never observed domain completion", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(record(3, "paused"))).mockResolvedValueOnce(response(record(4)));
    vi.stubGlobal("fetch", fetcher);
    render(<Fixture />);
    await screen.findByText("customer-1:paused");
    fireEvent.click(screen.getByText("Observe"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Resume"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const [url, init] = fetcher.mock.calls[1];
    expect(url).toBe("/api/hosted/browser/onboarding/tutorial-progress");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers["x-papercusp-workspace"]).toBe("control");
    expect(JSON.parse(init.body)).toEqual({ expectedScope: scope, expectedRevision: 3, mutationId: expect.any(String), disposition: "active" });
  });
  it("serializes a rapid pause/resume even when resume equals the previously saved state", async () => {
    let settle!: (value: Response) => void;
    const delayed = new Promise<Response>(resolve => { settle = resolve; });
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockReturnValueOnce(delayed).mockResolvedValueOnce(response(record(2)));
    vi.stubGlobal("fetch", fetcher); render(<Fixture />);
    await screen.findByText("customer-1:active");
    fireEvent.click(screen.getByText("Pause"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText("Resume"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => settle(response(record(1, "paused"))));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({ expectedRevision: 1, disposition: "active" });
    expect(screen.getByText("customer-1:active")).toBeTruthy();
  });
  it("retries an uncertain save with the identical idempotency key", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("network lost")).mockResolvedValueOnce(response(record(1, "paused")));
    vi.stubGlobal("fetch", fetcher); render(<Fixture />);
    await screen.findByText("customer-1:active"); fireEvent.click(screen.getByText("Pause"));
    await screen.findByRole("status"); fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls[2][1].body).toBe(fetcher.mock.calls[1][1].body);
  });
  it("adopts another tab's authoritative conflict without writing a guessed revision", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response(record(5, "skipped"), 409));
    vi.stubGlobal("fetch", fetcher); render(<Fixture />);
    await screen.findByText("customer-1:active"); fireEvent.click(screen.getByText("Pause"));
    await screen.findByText("customer-1:skipped");
    expect(screen.getByRole("status").textContent).toMatch(/another tab/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("discards late scope responses and aborts the old mount under StrictMode", async () => {
    const late: Array<(value: Response) => void> = [];
    const fetcher = vi.fn((_url, init) => init.method === "GET" ? new Promise<Response>(resolve => late.push(resolve)) : Promise.reject(new Error("unexpected write")));
    vi.stubGlobal("fetch", fetcher);
    const view = render(<StrictMode><Fixture /></StrictMode>);
    await waitFor(() => expect(late).toHaveLength(2));
    view.rerender(<StrictMode><Fixture selection="two" /></StrictMode>);
    await waitFor(() => expect(late).toHaveLength(3));
    await act(async () => { late[2](response(record(0, "active", { ...scope, workspaceId: "customer-2" }))); });
    await screen.findByText("customer-2:active");
    await act(async () => { late[0](response()); late[1](response()); });
    expect(screen.queryByText("customer-1:active")).toBeNull();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    view.unmount(); expect(fetcher.mock.calls[2][1].signal.aborted).toBe(true);
  });
  it("invalidates session changes and refuses to retain progress after a scope denial", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response("{}", { status: 403 })).mockResolvedValueOnce(response(record(0, "active", { ...scope, userId: "user-2", workspaceId: "customer-2" })));
    vi.stubGlobal("fetch", fetcher); render(<Fixture />);
    await screen.findByText("customer-1:active"); fireEvent.click(screen.getByText("Pause"));
    await screen.findByText("No scope"); expect(screen.getByRole("status").textContent).toMatch(/session or workspace changed/);
    act(() => window.dispatchEvent(new Event("papercusp:session-changed")));
    await screen.findByText("customer-2:active");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
