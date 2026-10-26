import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { WorkflowImageReceipt, WorkflowValue } from "../types";
import { errorMessage } from "../requestState";

export type UploadWorkflowImage = (file: File, signal?: AbortSignal) => Promise<WorkflowImageReceipt>;
type Job = { assetId: string; file: File; url: string; status: "queued" | "uploading" | "ready" | "error"; error: string; controller: AbortController };

export const workflowImageUrl = (pluginKey: string, assetId: string, variant: "full" | "thumb" = "thumb") =>
  `/api/plugins/${encodeURIComponent(pluginKey)}/workflows/images/${assetId}/${variant}`;

export function useWorkflowImageUploads(draft: WorkflowValue, setDraft: Dispatch<SetStateAction<WorkflowValue>>, upload?: UploadWorkflowImage) {
  const jobs = useRef(new Map<string, Job>());
  const alive = useRef(true);
  const [version, refresh] = useState(0);
  const [notice, setNotice] = useState("");
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  const referenced = new Set(draft.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.steps.flatMap((step) => (step.images ?? []).map((image) => image.assetId)))));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const job of jobs.current.values()) { job.controller.abort(); URL.revokeObjectURL(job.url); }
      jobs.current.clear();
    };
  }, []);

  useEffect(() => {
    const ids = new Set(draft.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.steps.flatMap((step) => (step.images ?? []).map((image) => image.assetId)))));
    for (const [id, job] of jobs.current) {
      if (!ids.has(job.assetId)) { job.controller.abort(); URL.revokeObjectURL(job.url); jobs.current.delete(id); }
    }
    const readyIds = new Set<string>();
    for (const [id, job] of jobs.current) {
      if (job.status !== "ready") continue;
      if (readyIds.has(job.assetId)) { URL.revokeObjectURL(job.url); jobs.current.delete(id); }
      else readyIds.add(job.assetId);
    }
    let active = [...jobs.current.values()].filter((job) => job.status === "uploading").length;
    for (const [id, job] of jobs.current) {
      if (job.status !== "queued" || active >= 2) continue;
      active += 1;
      job.status = "uploading";
      const pendingId = job.assetId;
      void (async () => {
        try {
          if (!uploadRef.current) throw new Error("图片上传不可用");
          const receipt = await uploadRef.current(job.file, job.controller.signal);
          if (!alive.current || job.controller.signal.aborted || jobs.current.get(id) !== job) return;
          job.assetId = receipt.assetId;
          job.status = "ready";
          setDraft((current) => ({ ...current, tabs: current.tabs.map((tab) => ({ ...tab, sections: tab.sections.map((section) => ({
            ...section, steps: section.steps.map((step) => !step.images?.some((image) => image.assetId === pendingId) ? step : ({
              ...step, images: step.images.flatMap((image) => image.assetId !== pendingId ? [image]
                : step.images!.some((existing) => existing.assetId === receipt.assetId) ? [] : [{ ...image, assetId: receipt.assetId }]),
            })),
          })) })) }));
        } catch (error) {
          if (!alive.current || job.controller.signal.aborted || jobs.current.get(id) !== job) return;
          job.status = "error";
          job.error = errorMessage(error);
        } finally {
          if (alive.current) refresh((value) => value + 1);
        }
      })();
    }
  }, [draft, setDraft, version]);

  const add = (stepId: string, files: File[]) => {
    setNotice("");
    const step = draft.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.steps)).find((item) => item.id === stepId);
    if (!step) return;
    const remaining = 6 - (step.images?.length ?? 0);
    const accepted: Array<{ assetId: string; alt: string }> = [];
    for (const file of files.slice(0, remaining)) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size === 0 || file.size > 10 * 1024 * 1024) {
        setNotice("请选择不超过 10 MiB 的 PNG、JPEG 或 WebP 图片。");
        continue;
      }
      const assetId = `pending-${crypto.randomUUID()}`;
      jobs.current.set(assetId, { assetId, file, url: URL.createObjectURL(file), status: "queued", error: "", controller: new AbortController() });
      accepted.push({ assetId, alt: "" });
    }
    if (files.length > remaining) setNotice("每个步骤最多 6 张图片。");
    setDraft((current) => ({ ...current, tabs: current.tabs.map((tab) => ({ ...tab, sections: tab.sections.map((section) => ({
      ...section, steps: section.steps.map((step) => step.id !== stepId ? step : ({ ...step, images: [...(step.images ?? []), ...accepted].slice(0, 6) })),
    })) })) }));
  };
  const find = (assetId: string) => [...jobs.current.values()].find((job) => job.assetId === assetId);
  return {
    add, notice,
    blocked: [...referenced].some((id) => id.startsWith("pending-")),
    source: (assetId: string) => find(assetId)?.url ?? workflowImageUrl(draft.pluginKey, assetId),
    status: (assetId: string) => find(assetId)?.status,
    error: (assetId: string) => find(assetId)?.error,
    retry: (assetId: string) => {
      const job = find(assetId);
      if (!job || !["error", "ready"].includes(job.status)) return;
      if (job.status === "ready") {
        const pendingId = `pending-${crypto.randomUUID()}`;
        job.assetId = pendingId;
        setDraft((current) => ({ ...current, tabs: current.tabs.map((tab) => ({ ...tab, sections: tab.sections.map((section) => ({
          ...section, steps: section.steps.map((step) => ({ ...step, ...(step.images ? {
            images: step.images.map((image) => image.assetId === assetId ? { ...image, assetId: pendingId } : image),
          } : {}) })),
        })) })) }));
      }
      job.controller = new AbortController(); job.error = ""; job.status = "queued";
      refresh((value) => value + 1);
    },
  };
}
