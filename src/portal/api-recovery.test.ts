import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalClient } from "./api";
import type { PluginImportConfig } from "./types";

const key = "company-dev/sample";
const items = [{ id: "prompt-1", scenario: "场景", content: "冻结内容", createdAt: "2026-09-07T00:00:00Z" }];
const workflow = { pluginKey: key, tabs: [] };
const config: PluginImportConfig = {
  source: { kind: "server-directory", path: "fixtures/sample" }, target: "company-dev",
  expectedPluginId: "", approvedRulePaths: [], extensionTools: [],
};
const invalidSession = () => Response.json({ error: { code: "invalid_session", message: "会话失效" } }, { status: 401 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); });

describe("PortalClient recovery contracts", () => {
  it("aborts a stalled GET at 15 seconds even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    const response = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    const client = new PortalClient((_input, init) => { signal = init?.signal; return response.promise; });
    let settled = false;
    const result = client.listPlugins().catch((error: unknown) => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: "request_timeout", uncertain: false });
    expect(signal?.aborted).toBe(true);
    response.resolve(Response.json({ revision: 0, items: [] }));
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: "request_timeout" });
  });

  it("propagates explicit GET cancellation without waiting for timeout", async () => {
    const controller = new AbortController();
    let inner: AbortSignal | null | undefined;
    const client = new PortalClient((_input, init) => { inner = init?.signal; return new Promise(() => undefined); });
    const result = client.getPrompts(key, controller.signal).catch((error: unknown) => error);
    controller.abort();
    expect(await result).toMatchObject({ code: "request_aborted", uncertain: false });
    expect(inner?.aborted).toBe(true);
  });

  it.each(["prompts", "workflows", "promote", "rollback", "publication"] as const)("classifies malformed successful %s receipts as uncertain", async (operation) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => Response.json(String(input) === "/api/session" ? { token: "session" } : {}));
    const client = new PortalClient(fetcher);
    const invoke = {
      prompts: () => client.savePrompts(key, 7, items), workflows: () => client.saveWorkflows(key, 7, workflow),
      promote: () => client.promote(key, "candidate", 7), rollback: () => client.rollback(key, 7),
      publication: () => client.confirmDownloadPublication(key, "publication"),
    }[operation];
    await expect(invoke()).rejects.toMatchObject({ code: "invalid_response", uncertain: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["prompts", "workflows"] as const)("renews invalid_session once for %s without changing body or revision", async (operation) => {
    let sessions = 0;
    const requests: RequestInit[] = [];
    const first = deferred<Response>();
    const client = new PortalClient(async (input, init) => {
      if (String(input) === "/api/session") return Response.json({ token: `session-${++sessions}` });
      requests.push(init!);
      if (requests.length === 1) return first.promise;
      return Response.json(operation === "prompts" ? { pluginKey: key, revision: 8, items } : { pluginKey: key, revision: 8, tabs: [] });
    });
    const submittedItems = structuredClone(items);
    const submittedWorkflow = structuredClone(workflow);
    const result = operation === "prompts" ? client.savePrompts(key, 7, submittedItems) : client.saveWorkflows(key, 7, submittedWorkflow);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    submittedItems[0].content = "请求期间已修改";
    submittedWorkflow.pluginKey = "company-dev/other";
    first.resolve(invalidSession());
    await result;
    expect(sessions).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[1].body).toBe(requests[0].body);
    expect(JSON.parse(String(requests[1].body))).toEqual(operation === "prompts"
      ? { expectedRevision: 7, items } : { expectedRevision: 7, workflow });
    expect(new Headers(requests[0].headers).get("X-Portal-Session")).toBe("session-1");
    expect(new Headers(requests[1].headers).get("X-Portal-Session")).toBe("session-2");
  });

  it("stops after the second invalid_session response", async () => {
    let sessions = 0;
    let writes = 0;
    const client = new PortalClient(async (input) => {
      if (String(input) === "/api/session") return Response.json({ token: `session-${++sessions}` });
      writes += 1; return invalidSession();
    });
    await expect(client.savePrompts(key, 7, items)).rejects.toMatchObject({ code: "invalid_session", status: 401 });
    expect(sessions).toBe(2);
    expect(writes).toBe(2);
  });

  it.each(["network", "revision_conflict", "unauthorized"])("does not replay an ordinary save for %s errors", async (failure) => {
    let writes = 0;
    let sessions = 0;
    const client = new PortalClient(async (input) => {
      if (String(input) === "/api/session") return Response.json({ token: `session-${++sessions}` });
      writes += 1;
      if (failure === "network") throw new TypeError("connection lost");
      return Response.json({ error: { code: failure, message: "未完成" } }, { status: failure === "revision_conflict" ? 409 : 401 });
    });
    await expect(client.savePrompts(key, 7, items)).rejects.toMatchObject({ code: failure === "network" ? "network_error" : failure });
    expect(writes).toBe(1);
    expect(sessions).toBe(1);
  });

  it.each(["session", "network"])("never automatically replays promote after a %s failure", async (failure) => {
    let writes = 0;
    let sessions = 0;
    const client = new PortalClient(async (input) => {
      if (String(input) === "/api/session") return Response.json({ token: `session-${++sessions}` });
      writes += 1;
      if (failure === "session") return invalidSession();
      throw new TypeError("connection lost");
    });
    await expect(client.promote(key, "candidate", 7)).rejects.toMatchObject({ code: failure === "session" ? "invalid_session" : "network_error" });
    expect(writes).toBe(1);
    expect(sessions).toBe(1);
  });

  it.each([
    ["prompts", 30_000], ["workflows", 30_000], ["upload", 300_000],
    ["preview", 300_000], ["promote", 300_000], ["publication", 300_000],
  ] as const)("uses the %s deadline of %i ms and aborts the request", async (operation, deadline) => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    const client = new PortalClient(async (input, init) => {
      if (String(input) === "/api/session") return Response.json({ token: "session" });
      signal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    const invoke = {
      prompts: () => client.savePrompts(key, 7, items), workflows: () => client.saveWorkflows(key, 7, workflow),
      upload: () => client.uploadPluginArchive(new File(["zip"], "sample.zip")), preview: () => client.previewImport(config),
      promote: () => client.promote(key, "candidate", 7), publication: () => client.confirmDownloadPublication(key, "publication"),
    }[operation];
    let settled = false;
    const result = invoke().catch((error: unknown) => error).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal).toBeDefined();
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: "request_timeout", uncertain: true });
    expect(signal?.aborted).toBe(true);
  });

  it.each(["directory", "download"])("keeps the %s picker open beyond mutation deadlines", async (operation) => {
    vi.useFakeTimers();
    const selected = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    const client = new PortalClient(async (input, init) => {
      if (String(input) === "/api/session") return Response.json({ token: "session" });
      signal = init?.signal; return selected.promise;
    });
    let settled = false;
    const result = (operation === "directory" ? client.selectPluginDirectory() : client.selectDownloadCandidate(key)).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    selected.resolve(Response.json({ selected: false }));
    await expect(result).resolves.toEqual({ selected: false });
  });
});
