import { useState } from "react";

import type { WorkflowDocument, WorkflowValue } from "../types";
import { WorkflowGraph } from "./WorkflowGraph";

export function WorkflowEditor({
  document,
  onSave,
}: {
  document: WorkflowDocument;
  onSave: (revision: number, workflow: WorkflowValue) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<WorkflowValue>(() => ({
    pluginKey: document.pluginKey,
    tabs: structuredClone(document.tabs),
  }));
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);

  const addTab = () => setDraft((current) => ({
    ...current,
    tabs: [...current.tabs, { id: nextId("tab", collectIds(current)), title: "新 Tab", sections: [] }],
  }));

  const addSection = (tabIndex: number) => setDraft((current) => {
    const next = structuredClone(current);
    next.tabs[tabIndex].sections.push({ id: nextId("section", collectIds(current)), title: "新流程区域", steps: [] });
    return next;
  });

  const addStep = (tabIndex: number, sectionIndex: number) => setDraft((current) => {
    const next = structuredClone(current);
    const number = next.tabs[tabIndex].sections[sectionIndex].steps.length + 1;
    next.tabs[tabIndex].sections[sectionIndex].steps.push({
      id: nextId("step", collectIds(current)), label: `步骤 ${number}`, title: `新步骤 ${number}`, description: "", next: [],
    });
    return next;
  });

  const save = async () => {
    try {
      setError("");
      await onSave(document.revision, draft);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法保存流程");
    }
  };

  return (
    <section className="workflow-editor">
      <button onClick={addTab} type="button">新增 Tab</button>
      {draft.tabs.map((tab, tabIndex) => (
        <fieldset key={tab.id}>
          <label>Tab 标题<input aria-label="Tab 标题" value={tab.title} onChange={(event) => {
            const title = event.currentTarget.value;
            setDraft((current) => updateTabTitle(current, tabIndex, title));
          }} /></label>
          <div className="row-actions">
            <button aria-label="Tab 上移" disabled={tabIndex === 0} onClick={() => setDraft((current) => moveTab(current, tabIndex, -1))} type="button">上移</button>
            <button aria-label="Tab 下移" disabled={tabIndex === draft.tabs.length - 1} onClick={() => setDraft((current) => moveTab(current, tabIndex, 1))} type="button">下移</button>
            <button onClick={() => setDraft((current) => removeTab(current, tabIndex))} type="button">删除 Tab</button>
          </div>
          <button onClick={() => addSection(tabIndex)} type="button">新增流程区域</button>
          {tab.sections.map((section, sectionIndex) => (
            <fieldset key={section.id}>
              <label>流程区域标题<input aria-label="流程区域标题" value={section.title} onChange={(event) => {
                const title = event.currentTarget.value;
                setDraft((current) => updateSectionTitle(current, tabIndex, sectionIndex, title));
              }} /></label>
              <div className="row-actions">
                <button aria-label="流程区域上移" disabled={sectionIndex === 0} onClick={() => setDraft((current) => moveSection(current, tabIndex, sectionIndex, -1))} type="button">上移</button>
                <button aria-label="流程区域下移" disabled={sectionIndex === tab.sections.length - 1} onClick={() => setDraft((current) => moveSection(current, tabIndex, sectionIndex, 1))} type="button">下移</button>
                <button onClick={() => setDraft((current) => removeSection(current, tabIndex, sectionIndex))} type="button">删除流程区域</button>
              </div>
              <button onClick={() => addStep(tabIndex, sectionIndex)} type="button">新增步骤</button>
              {section.steps.map((step, stepIndex) => (
                <div className="workflow-step-editor" key={step.id}>
                  <label>步骤标题<input aria-label="步骤标题" value={step.title} onChange={(event) => {
                    const title = event.currentTarget.value;
                    setDraft((current) => updateStepTitle(current, tabIndex, sectionIndex, stepIndex, title));
                  }} /></label>
                  <label>步骤角标<input aria-label="步骤角标" value={step.label} onChange={(event) => {
                    const label = event.currentTarget.value;
                    setDraft((current) => updateStepField(current, tabIndex, sectionIndex, stepIndex, "label", label));
                  }} /></label>
                  <label>步骤说明<textarea aria-label="步骤说明" value={step.description} onChange={(event) => {
                    const description = event.currentTarget.value;
                    setDraft((current) => updateStepField(current, tabIndex, sectionIndex, stepIndex, "description", description));
                  }} /></label>
                  {section.steps.filter((candidate) => candidate.id !== step.id).map((candidate) => (
                    <label key={candidate.id}>
                      <input
                        aria-label={`${step.title} 后续：${candidate.title}`}
                        checked={step.next.includes(candidate.id)}
                        onChange={() => setDraft((current) => toggleNext(current, tabIndex, sectionIndex, stepIndex, candidate.id))}
                        type="checkbox"
                      />
                      {candidate.title}
                    </label>
                  ))}
                  <div className="row-actions">
                    <button aria-label="步骤上移" disabled={stepIndex === 0} onClick={() => setDraft((current) => moveStep(current, tabIndex, sectionIndex, stepIndex, -1))} type="button">上移</button>
                    <button aria-label="步骤下移" disabled={stepIndex === section.steps.length - 1} onClick={() => setDraft((current) => moveStep(current, tabIndex, sectionIndex, stepIndex, 1))} type="button">下移</button>
                    <button onClick={() => setDraft((current) => removeStep(current, tabIndex, sectionIndex, stepIndex))} type="button">删除步骤</button>
                  </div>
                </div>
              ))}
            </fieldset>
          ))}
        </fieldset>
      ))}
      <button onClick={() => setPreview((value) => !value)} type="button">{preview ? "关闭预览" : "预览流程"}</button>
      {preview ? <div className="workflow-preview"><WorkflowGraph document={{ revision: document.revision, ...draft }} /></div> : null}
      <button onClick={save} type="button">保存流程</button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function updateTabTitle(value: WorkflowValue, tabIndex: number, title: string): WorkflowValue {
  const next = structuredClone(value); next.tabs[tabIndex].title = title; return next;
}
function updateSectionTitle(value: WorkflowValue, tabIndex: number, sectionIndex: number, title: string): WorkflowValue {
  const next = structuredClone(value); next.tabs[tabIndex].sections[sectionIndex].title = title; return next;
}
function updateStepTitle(value: WorkflowValue, tabIndex: number, sectionIndex: number, stepIndex: number, title: string): WorkflowValue {
  const next = structuredClone(value); next.tabs[tabIndex].sections[sectionIndex].steps[stepIndex].title = title; return next;
}
function updateStepField(value: WorkflowValue, tabIndex: number, sectionIndex: number, stepIndex: number, field: "label" | "description", content: string): WorkflowValue {
  const next = structuredClone(value); next.tabs[tabIndex].sections[sectionIndex].steps[stepIndex][field] = content; return next;
}
function toggleNext(value: WorkflowValue, tabIndex: number, sectionIndex: number, stepIndex: number, targetId: string): WorkflowValue {
  const next = structuredClone(value);
  const targets = next.tabs[tabIndex].sections[sectionIndex].steps[stepIndex].next;
  next.tabs[tabIndex].sections[sectionIndex].steps[stepIndex].next = targets.includes(targetId) ? targets.filter((id) => id !== targetId) : [...targets, targetId];
  return next;
}
function collectIds(value: WorkflowValue): Set<string> {
  const ids = new Set<string>();
  value.tabs.forEach((tab) => { ids.add(tab.id); tab.sections.forEach((section) => { ids.add(section.id); section.steps.forEach((step) => ids.add(step.id)); }); });
  return ids;
}
function nextId(prefix: string, existing: Set<string>): string {
  let index = 1; while (existing.has(`${prefix}-${index}`)) index += 1; return `${prefix}-${index}`;
}

function moveTab(value: WorkflowValue, index: number, offset: number): WorkflowValue {
  const next = structuredClone(value); moveItem(next.tabs, index, offset); return next;
}
function removeTab(value: WorkflowValue, index: number): WorkflowValue {
  const next = structuredClone(value); next.tabs.splice(index, 1); return next;
}
function moveSection(value: WorkflowValue, tabIndex: number, index: number, offset: number): WorkflowValue {
  const next = structuredClone(value); moveItem(next.tabs[tabIndex].sections, index, offset); return next;
}
function removeSection(value: WorkflowValue, tabIndex: number, index: number): WorkflowValue {
  const next = structuredClone(value); next.tabs[tabIndex].sections.splice(index, 1); return next;
}
function moveStep(value: WorkflowValue, tabIndex: number, sectionIndex: number, index: number, offset: number): WorkflowValue {
  const next = structuredClone(value); moveItem(next.tabs[tabIndex].sections[sectionIndex].steps, index, offset); return next;
}
function removeStep(value: WorkflowValue, tabIndex: number, sectionIndex: number, index: number): WorkflowValue {
  const next = structuredClone(value);
  const steps = next.tabs[tabIndex].sections[sectionIndex].steps;
  const [removed] = steps.splice(index, 1);
  steps.forEach((step) => { step.next = step.next.filter((id) => id !== removed.id); });
  return next;
}
function moveItem<T>(items: T[], index: number, offset: number): void {
  const target = index + offset;
  if (target < 0 || target >= items.length) return;
  const [item] = items.splice(index, 1);
  items.splice(target, 0, item);
}
