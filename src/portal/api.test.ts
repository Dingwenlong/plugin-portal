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
        items: [{ id: "one", title: "一", content: "内容" }],
      });
    });

    await client.savePrompts("company-dev/project-delivery-hub", 0, [
      { id: "one", title: "一", content: "内容" },
    ]);

    expect(calls).toHaveLength(2);
    expect(new Headers(calls[1].init?.headers).get("X-Portal-Session")).toBe(
      "session-token-abcdefghijklmnopqrstuvwxyz",
    );
    expect(calls[1].init?.method).toBe("POST");
  });
});
