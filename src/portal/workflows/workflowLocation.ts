import type { WorkflowValue } from "../types";

export interface WorkflowLocation { tabId: string; sectionId?: string; stepId?: string }
export interface WorkflowAnchor { stepId?: string; sectionId?: string; top: number; scrollY: number }

export function resolveWorkflowLocation(document: WorkflowValue, location?: WorkflowLocation): WorkflowLocation {
  const tab = document.tabs.find((item) => item.id === location?.tabId) ?? document.tabs[0];
  const section = tab?.sections.find((item) => item.id === location?.sectionId) ?? tab?.sections[0];
  const step = section?.steps.find((item) => item.id === location?.stepId) ?? section?.steps[0];
  return { tabId: tab?.id ?? "", sectionId: section?.id, stepId: step?.id };
}

export function captureWorkflowAnchor(root: HTMLElement | null): WorkflowAnchor {
  const steps = Array.from(root?.querySelectorAll<HTMLElement>("[data-workflow-step]") ?? []);
  const visible = steps.find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 110 && rect.top < window.innerHeight;
  });
  return { stepId: visible?.dataset.workflowStep, sectionId: visible?.dataset.workflowSection,
    top: visible?.getBoundingClientRect().top ?? 0, scrollY: window.scrollY };
}

export function restoreWorkflowAnchor(root: HTMLElement | null, anchor: WorkflowAnchor) {
  const element = Array.from(root?.querySelectorAll<HTMLElement>("[data-workflow-step]") ?? [])
    .find((candidate) => candidate.dataset.workflowStep === anchor.stepId);
  const top = element ? window.scrollY + element.getBoundingClientRect().top - anchor.top : anchor.scrollY;
  if (Math.abs(window.scrollY - top) > 1) window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
}
