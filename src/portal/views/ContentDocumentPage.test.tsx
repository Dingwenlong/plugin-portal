import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentDocumentPage, DocumentBody } from "./ContentDocumentPage";
import type { ContentDataClient, ContentDocument, ContentPreview, McpContent, ReleaseContent } from "../contentTypes";
import type { PluginSnapshot } from "../types";
import { PortalRequestError } from "../requestState";

const key = "company-dev/sample";
const snapshot: PluginSnapshot = { schemaVersion: "1.0.0", plugin: { target: "company-dev", id: "sample", name: "示例", version: "2.0.0", summary: "当前版本" },
  skills: [], mcp: [{ id: "sample-mcp" }], extensionTools: [], engineeringRules: [], provenance: { packageDigest: "test", adapterVersion: "1.0.0", importedAt: "2026-09-10" } };
const doc: McpContent = { schemaVersion: "1.0.0", documentType: "mcp", pluginKey: key, pluginVersion: "1.0.0", services: [
  { id: "sample-mcp", name: "服务", tools: [{ id: "check", name: "检查插件", purpose: "<script>不是 HTML</script>", scenarios: ["更新后核对"] }] },
] };
function fixture() {
  let saved: ContentDocument = { revision: 0, pluginKey: key, documentType: "mcp", document: null };
  const client: ContentDataClient = {
    getContent: vi.fn(async () => structuredClone(saved)),
    previewContent: vi.fn(async (_key, _kind, document) => ({ candidateId: `candidate-${saved.revision}`, revision: saved.revision, document: document as McpContent, diff: { added: 2, changed: 0, removed: 0, items: [] } })),
    confirmContent: vi.fn(async (_key, _kind, preview) => { saved = { ...saved, revision: saved.revision + 1, document: preview.document }; return structuredClone(saved); }),
  };
  return { client, setSaved(value: ContentDocument) { saved = value; } };
}
async function upload(value: unknown = doc) {
  await waitFor(() => expect(screen.getByRole("button", { name: "上传 JSON" })).toBeEnabled());
  const file = new File([JSON.stringify(value)], "mcp.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => JSON.stringify(value) });
  fireEvent.change(screen.getByLabelText("页面 JSON 文件"), { target: { files: [file] } });
  return screen.findByRole("dialog", { name: "内容变更预览" });
}

describe("uploaded documentation", () => {
  it("previews without saving, cancels, confirms, restores focus and exports", async () => {
    const { client } = fixture();
    render(<ContentDocumentPage client={client} kind="mcp" snapshot={snapshot} readOnly={false} />);
    expect(screen.getByRole("link", { name: "下载模板" })).toHaveAttribute("href", "/api/plugins/company-dev%2Fsample/content/mcp/template");
    let dialog = await upload();
    expect(within(dialog).getByText("更新后核对")).toBeVisible();
    expect(client.confirmContent).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "上传 JSON" })).toHaveFocus();
    dialog = await upload();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认替换" }));
    await screen.findByText("页面内容已更新");
    expect(client.confirmContent).toHaveBeenCalledTimes(1);
    expect(screen.getByText("说明对应 v1.0.0，当前插件 v2.0.0")).toBeVisible();
    expect(screen.getByRole("link", { name: "导出当前 JSON" })).toHaveAttribute("href", "/api/plugins/company-dev%2Fsample/content/mcp/export");
    expect(document.querySelector("script")).toBeNull();
  });

  it("retains the candidate through a conflict and requires a fresh preview", async () => {
    const { client } = fixture();
    const save = vi.spyOn(client, "confirmContent").mockRejectedValueOnce(new PortalRequestError("资料已更新", "revision_conflict", 409));
    render(<ContentDocumentPage client={client} kind="mcp" snapshot={snapshot} readOnly={false} />);
    await upload(); fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    await screen.findByText("资料已更新");
    expect(screen.getByRole("button", { name: "确认替换" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新预览" }));
    await waitFor(() => expect(client.previewContent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认替换" })).toBeEnabled());
    expect(vi.mocked(client.previewContent).mock.calls[1][2]).toEqual(doc);
    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    await screen.findByText("页面内容已更新"); expect(save).toHaveBeenCalledTimes(2);
  });

  it("does not repeat an uncertain save and reconciles the exact document by readback", async () => {
    const { client, setSaved } = fixture();
    vi.spyOn(client, "confirmContent").mockRejectedValue(new PortalRequestError("连接中断", "network_error", undefined, true));
    render(<ContentDocumentPage client={client} kind="mcp" snapshot={snapshot} readOnly={false} />);
    await upload(); fireEvent.click(screen.getByRole("button", { name: "确认替换" }));
    await screen.findByRole("button", { name: "核对保存结果" });
    expect(screen.getByRole("button", { name: "确认替换" })).toBeDisabled();
    expect(client.confirmContent).toHaveBeenCalledTimes(1);
    setSaved({ revision: 1, pluginKey: key, documentType: "mcp", document: doc });
    fireEvent.click(screen.getByRole("button", { name: "核对保存结果" }));
    await screen.findByText("页面内容已更新"); expect(client.confirmContent).toHaveBeenCalledTimes(1);
  });

  it("has public template and export downloads but no upload in readonly mode", async () => {
    const { client, setSaved } = fixture(); setSaved({ revision: 2, pluginKey: key, documentType: "mcp", document: doc });
    render(<ContentDocumentPage client={client} kind="mcp" snapshot={snapshot} readOnly />);
    await screen.findByRole("link", { name: "导出当前 JSON" });
    expect(screen.queryByRole("button", { name: "上传 JSON" })).toBeNull();
    expect(screen.queryByLabelText("页面 JSON 文件")).toBeNull();
  });

  it("warns explicitly before clearing and rejects oversized uploads", async () => {
    const { client } = fixture();
    render(<ContentDocumentPage client={client} kind="mcp" snapshot={snapshot} readOnly={false} />);
    await upload({ ...doc, services: [] });
    expect(screen.getByRole("alert")).toHaveTextContent("清空本页已上传内容");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    const file = new File(["x".repeat(1024 * 1024 + 1)], "large.json");
    fireEvent.change(screen.getByLabelText("页面 JSON 文件"), { target: { files: [file] } });
    await screen.findByText("JSON 文件不能超过 1 MiB");
    expect(client.previewContent).toHaveBeenCalledTimes(1);
  });

  it("sorts releases by version and marks unknown dates", () => {
    const releases: ReleaseContent = { schemaVersion: "1.0.0", pluginKey: key, documentType: "releases", releases:
      ["1.9.0", "1.10.0-rc.1", "1.10.0"].map(version => ({ version, releasedAt: null, summary: "说明", changes: [{ type: "fixed", text: "修复" }] })) };
    render(<DocumentBody document={releases} currentVersion="1.10.0" />);
    expect(screen.getAllByRole("heading").map(h => h.textContent)).toEqual(["v1.10.0", "v1.10.0-rc.1", "v1.9.0"]);
    expect(screen.getAllByText("发布日期未知")).toHaveLength(3);
  });
});
