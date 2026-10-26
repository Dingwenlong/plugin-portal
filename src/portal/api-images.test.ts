import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalClient } from "./api";

const key = "company-dev/sample-plugin";
const receipt = { assetId: "a".repeat(64), width: 640, height: 400 };
const file = new File(["png"], "image.png", { type: "image/png" });
const images = [{ assetId: receipt.assetId, alt: "说明" }, { assetId: "b".repeat(64), alt: "第二张" }];
const workflow = { pluginKey: key, tabs: [{ id: "tab", title: "Install", sections: [{ id: "section", title: "First", steps: [
  { id: "step", label: "1", title: "Prepare", description: "", next: [], images },
] }] }] };
afterEach(() => vi.useRealTimers());

describe("workflow image client contracts", () => {
  it("sends binary content to the plugin-isolated endpoint with its session and no file paths", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input) === "/api/session" ? { token: "session" } : receipt));
    const client = new PortalClient(fetcher);
    await expect(client.uploadWorkflowImage(key, file)).resolves.toEqual(receipt);
    expect(fetcher).toHaveBeenLastCalledWith(`/api/plugins/${encodeURIComponent(key)}/workflows/images`, expect.objectContaining({
      method: "POST", body: file, headers: { "Content-Type": "image/png", "X-Portal-Session": "session" },
    }));
  });

  it("validates optional image references and round-trips their order in the frozen save", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => Response.json(String(input) === "/api/session" ? { token: "session" } : { ...workflow, revision: 4 }));
    const client = new PortalClient(fetcher);
    await expect(client.getWorkflows(key)).resolves.toEqual({ ...workflow, revision: 4 });
    await client.saveWorkflows(key, 3, workflow);
    expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ expectedRevision: 3, workflow });
  });

  it.each([null, [{ assetId: "../invalid", alt: "" }], [images[0], images[0]],
    [{ ...images[0], alt: "a".repeat(201) }], [{ ...images[0], href: "/secret" }], Array(7).fill(images[0])])("rejects invalid returned images %j", async (value) => {
    const doc = structuredClone(workflow);
    Object.assign(doc.tabs[0].sections[0].steps[0], { images: value });
    const client = new PortalClient(async () => Response.json({ ...doc, revision: 4 }));
    await expect(client.getWorkflows(key)).rejects.toThrow("流程回应无效");
  });

  it.each([{}, { ...receipt, width: 20_000_001 }, { ...receipt, filePath: "private" }])("treats invalid upload receipts as uncertain %j", async (value) => {
    const client = new PortalClient(async (input) => Response.json(String(input) === "/api/session" ? { token: "session" } : value));
    await expect(client.uploadWorkflowImage(key, file)).rejects.toMatchObject({ code: "invalid_response", uncertain: true });
  });

  it("preserves backend code/status and renews invalid sessions only on a manual retry", async () => {
    let sessions = 0; let uploads = 0;
    const client = new PortalClient(async (input) => {
      if (String(input) === "/api/session") return Response.json({ token: `session-${++sessions}` });
      uploads++;
      return uploads === 1 ? Response.json({ error: { code: "invalid_session", message: "会话已失效" } }, { status: 401 }) : Response.json(receipt);
    });
    await expect(client.uploadWorkflowImage(key, file)).rejects.toMatchObject({ code: "invalid_session", status: 401 });
    expect(uploads).toBe(1); expect(sessions).toBe(1);
    await expect(client.uploadWorkflowImage(key, file)).resolves.toEqual(receipt);
    expect(uploads).toBe(2); expect(sessions).toBe(2);
  });

  it.each(["timeout", "cancel"])("aborts an image upload on %s without replaying it", async (reason) => {
    vi.useFakeTimers();
    let writes = 0; let inner: AbortSignal | null | undefined;
    const client = new PortalClient(async (input, init) => {
      if (String(input) === "/api/session") return Response.json({ token: "session" });
      writes++; inner = init?.signal; return new Promise(() => {});
    });
    const controller = new AbortController();
    const result = client.uploadWorkflowImage(key, file, controller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    if (reason === "cancel") controller.abort();
    else {
      await vi.advanceTimersByTimeAsync(299_999); expect(inner?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(await result).toMatchObject({ code: reason === "cancel" ? "request_aborted" : "request_timeout" });
    expect(inner?.aborted).toBe(true); expect(writes).toBe(1);
  });
});
