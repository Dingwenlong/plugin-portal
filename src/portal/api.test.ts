import { describe, expect, it } from "vitest";

import { PortalClient } from "./api";

describe("PortalClient", () => {
  it("parses a closed plugin catalog", async () => {
    const client = new PortalClient(async () =>
      Response.json({
        revision: 2,
        items: [
          {
            pluginKey: "company-dev/project-delivery-hub",
            id: "project-delivery-hub",
            name: "研发助手插件",
            version: "3.7.17",
            summary: "公开说明",
          },
        ],
      }),
    );

    await expect(client.listPlugins()).resolves.toMatchObject({ revision: 2 });
  });

  it("rejects unknown response fields", async () => {
    const client = new PortalClient(async () =>
      Response.json({ revision: 0, items: [], sourceRoot: "private" }),
    );

    await expect(client.listPlugins()).rejects.toThrow("插件目录回应无效");
  });

  it("creates one session before a Prompt mutation", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new PortalClient(async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input) === "/api/session") return Response.json({ token: "session-token-abcdefghijklmnopqrstuvwxyz" });
      return Response.json({
        revision: 1,
        pluginKey: "company-dev/project-delivery-hub",
        items: [{ id: "one", scenario: "一", content: "内容", createdAt: "2026-08-26T00:00:00Z" }],
      });
    });

    await client.savePrompts("company-dev/project-delivery-hub", 0, [
      { id: "one", scenario: "一", content: "内容", createdAt: "2026-08-26T00:00:00Z" },
    ]);

    expect(calls).toHaveLength(2);
    expect(new Headers(calls[1].init?.headers).get("X-Portal-Session")).toBe(
      "session-token-abcdefghijklmnopqrstuvwxyz",
    );
    expect(calls[1].init?.method).toBe("POST");
  });

  it("selects a plugin directory through the session-protected local endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new PortalClient(async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input) === "/api/session") return Response.json({ token: "session-token-abcdefghijklmnopqrstuvwxyz" });
      return Response.json({ selected: true, path: "C:\\plugins\\sample" });
    });

    await expect(client.selectPluginDirectory()).resolves.toEqual({
      selected: true,
      path: "C:\\plugins\\sample",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "/api/session",
      "/api/plugins/import/select-directory",
    ]);
    expect(new Headers(calls[1].init?.headers).get("X-Portal-Session")).toBe(
      "session-token-abcdefghijklmnopqrstuvwxyz",
    );
  });

  it("rejects a directory selection response that exposes extra data", async () => {
    const client = new PortalClient(async (input) => {
      if (String(input) === "/api/session") return Response.json({ token: "session-token-abcdefghijklmnopqrstuvwxyz" });
      return Response.json({ selected: false, path: "C:\\private" });
    });

    await expect(client.selectPluginDirectory()).rejects.toThrow("插件目录选择回应无效");
  });

  it("accepts only a closed download availability response", async () => {
    const client = new PortalClient(async () => Response.json({
      available: true,
      version: "3.7.17",
      href: "http://127.0.0.1:9134/downloads/project-delivery-hub-3.7.17-company-dev.zip",
    }));

    await expect(client.getDownloadInfo("company-dev/project-delivery-hub")).resolves.toEqual({
      available: true,
      version: "3.7.17",
      href: "http://127.0.0.1:9134/downloads/project-delivery-hub-3.7.17-company-dev.zip",
    });

    const invalid = new PortalClient(async () => Response.json({
      available: false,
      version: "3.7.17",
      href: "http://127.0.0.1:9134/downloads/missing.zip",
    }));
    await expect(invalid.getDownloadInfo("company-dev/project-delivery-hub")).rejects.toThrow("下载资料回应无效");
  });
});
