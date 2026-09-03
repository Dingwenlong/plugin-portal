import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DownloadPublisherDialog } from "./DownloadPublisher";

const plugin = {
  pluginKey: "company-dev/sample-plugin",
  id: "sample-plugin",
  name: "示例插件",
  version: "1.2.3",
  summary: "",
};

describe("DownloadPublisherDialog", () => {
  it("shows the audited preview and publishes only after explicit confirmation", async () => {
    const onPublished = vi.fn();
    const client = {
      selectDownloadCandidate: vi.fn().mockResolvedValue({
        selected: true as const,
        publicationId: "publication-token",
        preview: {
          pluginKey: plugin.pluginKey,
          version: plugin.version,
          fileName: "sample-plugin.zip",
          destinationFileName: "sample-plugin-1.2.3-company-dev.zip",
          candidateSha256: "a".repeat(64),
          fileSetSha256: "b".repeat(64),
          fileCount: 3,
          archiveBytes: 25,
          auditToolVersion: "1.0.1",
          warnings: ["市场源码与候选不一致"],
        },
      }),
      confirmDownloadPublication: vi.fn().mockResolvedValue({
        pluginKey: plugin.pluginKey,
        version: plugin.version,
        fileName: "sample-plugin-1.2.3-company-dev.zip",
        candidateSha256: "a".repeat(64),
        archiveBytes: 25,
        publishedAtUtc: "2026-08-30T00:00:00Z",
      }),
    };
    render(<DownloadPublisherDialog client={client} onClose={vi.fn()} onPublished={onPublished} plugin={plugin} />);

    fireEvent.click(screen.getByRole("button", { name: "选择候选 ZIP" }));
    expect(await screen.findByText("sample-plugin-1.2.3-company-dev.zip")).toBeVisible();
    expect(screen.getByText("市场源码与候选不一致")).toBeVisible();
    expect(client.confirmDownloadPublication).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认发布" }));
    expect(await screen.findByRole("status")).toHaveTextContent("发布成功");
    expect(client.confirmDownloadPublication).toHaveBeenCalledWith(plugin.pluginKey, "publication-token");
    expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ pluginKey: plugin.pluginKey }));
  });

  it("closes with Escape and exposes a safe selection error", async () => {
    const onClose = vi.fn();
    const client = {
      selectDownloadCandidate: vi.fn().mockRejectedValue(new Error("Plugin Release 拒绝候选 ZIP")),
      confirmDownloadPublication: vi.fn(),
    };
    render(<DownloadPublisherDialog client={client} onClose={onClose} plugin={plugin} />);

    fireEvent.click(screen.getByRole("button", { name: "选择候选 ZIP" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Plugin Release 拒绝候选 ZIP");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("uploads and audits a browser ZIP in remote mode without calling the host picker", async () => {
    const file = new File(["candidate"], "sample-plugin.zip", { type: "application/zip" });
    let resolveUpload!: (value: any) => void;
    const uploadDownloadCandidate = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveUpload = resolve;
    }));
    const selectDownloadCandidate = vi.fn();
    const client = {
      selectDownloadCandidate,
      uploadDownloadCandidate,
      confirmDownloadPublication: vi.fn(),
    };
    render(<DownloadPublisherDialog
      client={client}
      fileSelectionMode="browser-upload"
      onClose={vi.fn()}
      plugin={plugin}
    />);

    expect(screen.queryByRole("button", { name: "选择候选 ZIP" })).not.toBeInTheDocument();
    const input = screen.getByLabelText("下载候选 ZIP");
    fireEvent.change(input, { target: { files: [file] } });
    expect(uploadDownloadCandidate).toHaveBeenCalledWith(plugin.pluginKey, file);
    expect(input).toBeDisabled();
    resolveUpload({
      selected: true,
      publicationId: "publication-token",
      preview: {
        pluginKey: plugin.pluginKey,
        version: plugin.version,
        fileName: file.name,
        destinationFileName: "sample-plugin-1.2.3-company-dev.zip",
        candidateSha256: "a".repeat(64),
        fileSetSha256: "b".repeat(64),
        fileCount: 3,
        archiveBytes: file.size,
        auditToolVersion: "1.0.2",
        warnings: [],
      },
    });
    expect(await screen.findByText("sample-plugin-1.2.3-company-dev.zip")).toBeVisible();
    expect(selectDownloadCandidate).not.toHaveBeenCalled();
  });
});
