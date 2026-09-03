import { describe, expect, it } from "vitest";

import { PortalClient } from "./api";

describe("PortalClient", () => {
  it("validates the server-owned access mode", async () => {
    for (const access of [
      { readOnly: false, fileSelectionMode: "server-picker" },
      { readOnly: false, fileSelectionMode: "browser-upload" },
      { readOnly: true, fileSelectionMode: "none" },
    ] as const) {
      await expect(new PortalClient(async () => Response.json(access)).getAccessMode())
        .resolves.toEqual(access);
    }
    for (const invalid of [
      { readOnly: true },
      { readOnly: "false", fileSelectionMode: "none" },
      { readOnly: true, fileSelectionMode: "server-picker" },
      { readOnly: false, fileSelectionMode: "browser-upload", host: "private" },
    ]) {
      await expect(new PortalClient(async () => Response.json(invalid)).getAccessMode()).rejects.toThrow();
    }
  });

  it("uploads raw ZIP files with one shared management session", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const pluginFile = new File([new Uint8Array([0x50, 0x4b])], "示例 plugin.zip", { type: "application/zip" });
    const downloadFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "release.zip", {
      type: "application/octet-stream",
    });
    const pluginKey = "company-dev/sample-plugin";
    const client = new PortalClient(async (input, init) => {
      const path = String(input);
      calls.push({ input: path, init });
      if (path === "/api/session") {
        return Response.json({ token: "session-token-abcdefghijklmnopqrstuvwxyz" });
      }
      if (path === "/api/uploads/plugin-import") {
        return Response.json({ uploadId: "plugin-upload", fileName: pluginFile.name, archiveBytes: pluginFile.size });
      }
      return Response.json({
        selected: true,
        publicationId: "publication-token",
        preview: {
          pluginKey,
          version: "1.2.3",
          fileName: downloadFile.name,
          destinationFileName: "sample-plugin-1.2.3-company-dev.zip",
          candidateSha256: "a".repeat(64),
          fileSetSha256: "b".repeat(64),
          fileCount: 3,
          archiveBytes: downloadFile.size,
          auditToolVersion: "1.0.2",
          warnings: [],
        },
      });
    });

    await expect(client.uploadPluginArchive(pluginFile)).resolves.toEqual({
      uploadId: "plugin-upload", fileName: pluginFile.name, archiveBytes: pluginFile.size,
    });
    await expect(client.uploadDownloadCandidate(pluginKey, downloadFile)).resolves.toMatchObject({
      selected: true, publicationId: "publication-token",
    });

    expect(calls.map((call) => call.input)).toEqual([
      "/api/session",
      "/api/uploads/plugin-import",
      `/api/plugins/${encodeURIComponent(pluginKey)}/download-publication/upload`,
    ]);
    for (const [call, file] of [[calls[1], pluginFile], [calls[2], downloadFile]] as const) {
      expect(call.init?.method).toBe("POST");
      expect(call.init?.body).toBe(file);
      const headers = new Headers(call.init?.headers);
      expect(headers.get("Content-Type")).toBe("application/zip");
      expect(headers.get("Content-Disposition")).toBe(
        `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      );
      expect(headers.get("X-Portal-Session")).toBe("session-token-abcdefghijklmnopqrstuvwxyz");
      expect(headers.has("Content-Length")).toBe(false);
    }
  });

  it("rejects malformed upload receipts and surfaces structured upload errors", async () => {
    const file = new File(["zip"], "sample.zip", { type: "application/zip" });
    const malformed = new PortalClient(async (input) => {
      if (String(input) === "/api/session") return Response.json({ token: "session-token-abcdefghijklmnopqrstuvwxyz" });
      return Response.json({ uploadId: "upload", fileName: "sample.zip", archiveBytes: 3, sourcePath: "private" });
    });
    await expect(malformed.uploadPluginArchive(file)).rejects.toThrow("插件上传回应无效");

    const rejected = new PortalClient(async (input) => {
      if (String(input) === "/api/session") return Response.json({ token: "session-token-abcdefghijklmnopqrstuvwxyz" });
      return Response.json(
        { error: { code: "candidate_rejected", message: "候选未通过 Plugin Release 审计" } },
        { status: 400 },
      );
    });
    await expect(rejected.uploadDownloadCandidate("company-dev/sample-plugin", file))
      .rejects.toThrow("候选未通过 Plugin Release 审计");
  });

  it("accepts only the requested plugin's same-origin LAN download", async () => {
    const key = "company-dev/sample-plugin";
    const href = `/api/plugins/${encodeURIComponent(key)}/download`;
    await expect(new PortalClient(async () => Response.json({ available: true, version: "1.2.3", href }))
      .getDownloadInfo(key)).resolves.toMatchObject({ href });
    for (const invalid of ["/api/plugins/company-dev%2Fother/download", "//example.test/download", href + "?url=private"]) {
      await expect(new PortalClient(async () => Response.json({ available: true, version: "1.2.3", href: invalid }))
        .getDownloadInfo(key)).rejects.toThrow();
    }
  });

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

  it("accepts both ID-only and enriched MCP public summaries", async () => {
    const client = new PortalClient(async () => Response.json({
      schemaVersion: "1.0.0",
      plugin: {
        target: "company-dev",
        id: "sample-plugin",
        name: "示例插件",
        version: "1.2.3",
        summary: "公开说明",
      },
      skills: [],
      mcp: [
        { id: "legacy-service" },
        {
          id: "sample-service",
          name: "示例服务",
          purpose: "查询经过筛选的公开资料。",
          capabilities: ["查询公开资料", "读取处理状态"],
          writeEnabled: false,
        },
      ],
      extensionTools: [],
      engineeringRules: [],
      provenance: {
        packageDigest: `sha256:${"a".repeat(64)}`,
        adapterVersion: "1.0.0",
        importedAt: "2026-08-25T00:00:00Z",
      },
    }));

    await expect(client.getSnapshot("company-dev/sample-plugin")).resolves.toMatchObject({
      mcp: [
        { id: "legacy-service" },
        {
          id: "sample-service",
          name: "示例服务",
          purpose: "查询经过筛选的公开资料。",
          capabilities: ["查询公开资料", "读取处理状态"],
          writeEnabled: false,
        },
      ],
    });
  });

  it("rejects partial MCP public summaries", async () => {
    const client = new PortalClient(async () => Response.json({
      schemaVersion: "1.0.0",
      plugin: {
        target: "company-dev",
        id: "sample-plugin",
        name: "示例插件",
        version: "1.2.3",
        summary: "公开说明",
      },
      skills: [],
      mcp: [{ id: "sample-service", name: "示例服务" }],
      extensionTools: [],
      engineeringRules: [],
      provenance: {
        packageDigest: `sha256:${"a".repeat(64)}`,
        adapterVersion: "1.0.0",
        importedAt: "2026-08-25T00:00:00Z",
      },
    }));

    await expect(client.getSnapshot("company-dev/sample-plugin")).rejects.toThrow("插件公开资料回应无效");
  });

  it("accepts categorized Skills while preserving legacy snapshots", async () => {
    const client = new PortalClient(async () => Response.json({
      schemaVersion: "1.0.0",
      plugin: {
        target: "company-dev",
        id: "sample-plugin",
        name: "示例插件",
        version: "1.2.3",
        summary: "公开说明",
      },
      skills: [
        { id: "legacy-skill", name: "旧技能", description: "旧快照仍可读取。" },
        {
          id: "code-development",
          name: "业务代码开发",
          description: "处理业务代码。",
          category: "implementation",
        },
      ],
      mcp: [],
      extensionTools: [],
      engineeringRules: [],
      provenance: {
        packageDigest: `sha256:${"a".repeat(64)}`,
        adapterVersion: "1.0.0",
        importedAt: "2026-08-25T00:00:00Z",
      },
    }));

    await expect(client.getSnapshot("company-dev/sample-plugin")).resolves.toMatchObject({
      skills: [
        { id: "legacy-skill" },
        { id: "code-development", category: "implementation" },
      ],
    });
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

  it("selects and confirms only closed download publication responses", async () => {
    const key = "company-dev/sample-plugin";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new PortalClient(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/session") return Response.json({ token: "session-token-abcdefghijklmnopqrstuvwxyz" });
      if (url.endsWith("/select")) return Response.json({
        selected: true,
        publicationId: "publication-token",
        preview: {
          pluginKey: key,
          version: "1.2.3",
          fileName: "sample-plugin.zip",
          destinationFileName: "sample-plugin-1.2.3-company-dev.zip",
          candidateSha256: "a".repeat(64),
          fileSetSha256: "b".repeat(64),
          fileCount: 3,
          archiveBytes: 25,
          auditToolVersion: "1.0.1",
          warnings: ["市场源码与候选不一致"],
        },
      });
      return Response.json({
        pluginKey: key,
        version: "1.2.3",
        fileName: "sample-plugin-1.2.3-company-dev.zip",
        candidateSha256: "a".repeat(64),
        archiveBytes: 25,
        publishedAtUtc: "2026-08-30T00:00:00Z",
      });
    });

    const selection = await client.selectDownloadCandidate(key);
    expect(selection).toMatchObject({ selected: true, publicationId: "publication-token" });
    if (!selection.selected) throw new Error("expected selection");
    await expect(client.confirmDownloadPublication(key, selection.publicationId)).resolves.toMatchObject({
      fileName: "sample-plugin-1.2.3-company-dev.zip",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "/api/session",
      `/api/plugins/${encodeURIComponent(key)}/download-publication/select`,
      `/api/plugins/${encodeURIComponent(key)}/download-publication/confirm`,
    ]);
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({ publicationId: "publication-token" });
  });

  it("rejects a download publication preview that exposes an unknown field", async () => {
    const client = new PortalClient(async (input) => {
      if (String(input) === "/api/session") return Response.json({ token: "session-token-abcdefghijklmnopqrstuvwxyz" });
      return Response.json({
        selected: true,
        publicationId: "publication-token",
        preview: {
          pluginKey: "company-dev/sample-plugin",
          version: "1.2.3",
          fileName: "sample-plugin.zip",
          destinationFileName: "sample-plugin-1.2.3-company-dev.zip",
          candidateSha256: "a".repeat(64),
          fileSetSha256: "b".repeat(64),
          fileCount: 3,
          archiveBytes: 25,
          auditToolVersion: "1.0.1",
          warnings: [],
          sourcePath: "C:\\private\\sample-plugin.zip",
        },
      });
    });

    await expect(client.selectDownloadCandidate("company-dev/sample-plugin"))
      .rejects.toThrow("下载发布选择回应无效");
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
