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
  it("previews approved input and promotes only after confirmation", async () => {
    const previewImport = vi.fn().mockResolvedValue(candidate);
    const promote = vi.fn().mockResolvedValue({ revision: 1, pluginKey: candidate.pluginKey, snapshotId: "a".repeat(64) });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(
      <PluginManager
        catalogRevision={0}
        client={{ previewImport, promote, rollback: vi.fn() }}
        onChanged={onChanged}
      />,
    );

    fireEvent.change(screen.getByLabelText("插件目录"), { target: { value: "fixtures/project-delivery-hub" } });
    fireEvent.change(screen.getByLabelText("插件 ID"), { target: { value: "project-delivery-hub" } });
    fireEvent.change(screen.getByLabelText("公开规范相对路径"), { target: { value: "rules/public.md" } });
    fireEvent.click(screen.getByRole("button", { name: "预览插件" }));
    expect(await screen.findByText("将纳入 研发助手插件 v3.7.18")).toBeInTheDocument();
    expect(previewImport).toHaveBeenCalledWith({
      pluginRoot: "fixtures/project-delivery-hub",
      target: "company-dev",
      expectedPluginId: "project-delivery-hub",
      approvedRulePaths: ["rules/public.md"],
      extensionTools: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "确认纳入" }));
    await waitFor(() => expect(promote).toHaveBeenCalledWith(candidate.pluginKey, candidate.candidateId, 0));
    expect(onChanged).toHaveBeenCalledWith("project-delivery-hub");
  });

  it("shows a version difference and exposes explicit rollback", async () => {
    const previewImport = vi.fn().mockResolvedValue(candidate);
    const rollback = vi.fn().mockResolvedValue({ revision: 5, pluginKey: candidate.pluginKey, snapshotId: "b".repeat(64) });
    render(
      <PluginManager
        catalogRevision={4}
        client={{ previewImport, promote: vi.fn(), rollback }}
        currentSnapshot={{ ...candidate.snapshot, plugin: { ...candidate.snapshot.plugin, version: "3.7.17" } }}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.change(screen.getByLabelText("插件目录"), { target: { value: "fixtures/project-delivery-hub" } });
    fireEvent.change(screen.getByLabelText("插件 ID"), { target: { value: "project-delivery-hub" } });
    fireEvent.click(screen.getByRole("button", { name: "预览插件" }));
    expect(await screen.findByText("版本 3.7.17 → 3.7.18")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "回滚上一版" }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith(candidate.pluginKey, 4));
  });
});
