import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PluginManager } from "./PluginManager";

const candidate = {
  candidateId: "candidate-one",
  pluginKey: "company-dev/project-delivery-hub",
  snapshot: {
    schemaVersion: "1.0.0" as const,
    plugin: {
      target: "company-dev",
      id: "project-delivery-hub",
      name: "研发助手插件",
      version: "3.7.18",
      summary: "公开说明",
    },
    skills: [], mcp: [], extensionTools: [], engineeringRules: [],
    provenance: {
      packageDigest: `sha256:${"a".repeat(64)}`,
      adapterVersion: "1.0.0",
      importedAt: "2026-08-25T00:00:00Z",
    },
  },
};

describe("PluginManager", () => {
  it("selects a plugin directory, detects identity, and promotes only after confirmation", async () => {
    const previewImport = vi.fn().mockResolvedValue(candidate);
    const selectPluginDirectory = vi.fn().mockResolvedValue({
      selected: true as const,
      path: "fixtures/project-delivery-hub",
    });
    const promote = vi.fn().mockResolvedValue({ revision: 1, pluginKey: candidate.pluginKey, snapshotId: "a".repeat(64) });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const client = { selectPluginDirectory, previewImport, promote, rollback: vi.fn() };
    render(
      <PluginManager
        catalogRevision={0}
        client={client}
        onChanged={onChanged}
      />,
    );

    expect(screen.getByLabelText("插件目录")).toHaveAttribute("readonly");
    expect(screen.queryByLabelText("插件 ID")).not.toBeInTheDocument();
    expect(screen.getByText("高级公开内容（可选）")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择插件目录" }));
    expect(await screen.findByText("将纳入 研发助手插件 v3.7.18")).toBeInTheDocument();
    expect(screen.getByText("project-delivery-hub · v3.7.18")).toBeInTheDocument();
    expect(selectPluginDirectory).toHaveBeenCalledTimes(1);
    expect(previewImport).toHaveBeenCalledWith({
      source: { kind: "server-directory", path: "fixtures/project-delivery-hub" },
      target: "company-dev",
      expectedPluginId: "",
      approvedRulePaths: [],
      extensionTools: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "确认纳入" }));
    await waitFor(() => expect(promote).toHaveBeenCalledWith(candidate.pluginKey, candidate.candidateId, 0));
    expect(onChanged).toHaveBeenCalledWith("project-delivery-hub");
  });

  it("shows a version difference and exposes explicit rollback", async () => {
    const previewImport = vi.fn().mockResolvedValue(candidate);
    const selectPluginDirectory = vi.fn().mockResolvedValue({
      selected: true as const,
      path: "fixtures/project-delivery-hub",
    });
    const rollback = vi.fn().mockResolvedValue({ revision: 5, pluginKey: candidate.pluginKey, snapshotId: "b".repeat(64) });
    const client = { selectPluginDirectory, previewImport, promote: vi.fn(), rollback };
    render(
      <PluginManager
        catalogRevision={4}
        client={client}
        currentSnapshot={{ ...candidate.snapshot, plugin: { ...candidate.snapshot.plugin, version: "3.7.17" } }}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "选择插件目录" }));
    expect(await screen.findByText("版本 3.7.17 → 3.7.18")).toBeInTheDocument();
    expect(previewImport).toHaveBeenCalledWith(expect.objectContaining({
      expectedPluginId: "project-delivery-hub",
    }));
    fireEvent.click(screen.getByRole("button", { name: "回滚上一版" }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith(candidate.pluginKey, 4));
  });

  it("keeps the current selection unchanged when the folder dialog is cancelled", async () => {
    const selectPluginDirectory = vi.fn().mockResolvedValue({ selected: false as const });
    const previewImport = vi.fn();
    const client = { selectPluginDirectory, previewImport, promote: vi.fn(), rollback: vi.fn() };
    render(<PluginManager catalogRevision={0} client={client} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "选择插件目录" }));

    await waitFor(() => expect(selectPluginDirectory).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("插件目录")).toHaveValue("");
    expect(previewImport).not.toHaveBeenCalled();
  });

  it("uploads a browser ZIP in remote mode and refreshes after confirmation", async () => {
    const file = new File(["zip"], "project-delivery-hub.zip", { type: "application/zip" });
    const uploadPluginArchive = vi.fn().mockResolvedValue({
      uploadId: "upload-one", fileName: file.name, archiveBytes: file.size,
    });
    const previewImport = vi.fn().mockResolvedValue(candidate);
    const promote = vi.fn().mockResolvedValue({
      revision: 3, pluginKey: candidate.pluginKey, snapshotId: "c".repeat(64),
    });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const selectPluginDirectory = vi.fn();
    render(<PluginManager
      catalogRevision={2}
      client={{ selectPluginDirectory, uploadPluginArchive, previewImport, promote, rollback: vi.fn() }}
      fileSelectionMode="browser-upload"
      onChanged={onChanged}
    />);

    expect(screen.queryByRole("button", { name: "选择插件目录" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("插件 ZIP"), { target: { files: [file] } });

    await waitFor(() => expect(uploadPluginArchive).toHaveBeenCalledWith(file));
    expect(previewImport).toHaveBeenCalledWith({
      source: { kind: "upload", uploadId: "upload-one" },
      target: "company-dev",
      expectedPluginId: "",
      approvedRulePaths: [],
      extensionTools: [],
    });
    expect(selectPluginDirectory).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "确认纳入" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("project-delivery-hub"));
  });

  it("renders no file source control when management selection is unavailable", () => {
    render(<PluginManager
      catalogRevision={0}
      client={{
        selectPluginDirectory: vi.fn(), uploadPluginArchive: vi.fn(), previewImport: vi.fn(),
        promote: vi.fn(), rollback: vi.fn(),
      }}
      fileSelectionMode="none"
      onChanged={vi.fn()}
    />);
    expect(screen.queryByLabelText("插件目录")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("插件 ZIP")).not.toBeInTheDocument();
  });
});
