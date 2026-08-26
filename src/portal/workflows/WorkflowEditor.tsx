import { useState } from "react";

import type {
  WorkflowDocument,
  WorkflowSection,
  WorkflowStep,
  WorkflowTab,
  WorkflowValue,
} from "../types";
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
  const [selectedTabId, setSelectedTabId] = useState(document.tabs[0]?.id ?? "");
  const [selectedSectionId, setSelectedSectionId] = useState(document.tabs[0]?.sections[0]?.id ?? "");
  const [selectedStepId, setSelectedStepId] = useState(document.tabs[0]?.sections[0]?.steps[0]?.id ?? "");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);

  const tabIndex = resolveIndex(draft.tabs, selectedTabId);
  const tab = tabIndex >= 0 ? draft.tabs[tabIndex] : undefined;
  const sectionIndex = resolveIndex(tab?.sections ?? [], selectedSectionId);
  const section = sectionIndex >= 0 ? tab?.sections[sectionIndex] : undefined;
  const stepIndex = resolveIndex(section?.steps ?? [], selectedStepId);
  const step = stepIndex >= 0 ? section?.steps[stepIndex] : undefined;

  const selectTab = (nextTab: WorkflowTab) => {
    setSelectedTabId(nextTab.id);
    setSelectedSectionId(nextTab.sections[0]?.id ?? "");
    setSelectedStepId(nextTab.sections[0]?.steps[0]?.id ?? "");
  };

  const selectSection = (nextSection: WorkflowSection) => {
    setSelectedSectionId(nextSection.id);
    setSelectedStepId(nextSection.steps[0]?.id ?? "");
  };

  const addTab = () => {
    const nextTab = { id: nextId("tab", collectIds(draft)), title: "新 Tab", sections: [] };
    setDraft((current) => ({ ...current, tabs: [...current.tabs, nextTab] }));
    selectTab(nextTab);
  };

  const addSection = () => {
    if (tabIndex < 0) return;
    const nextSection = { id: nextId("section", collectIds(draft)), title: "新流程区域", steps: [] };
    setDraft((current) => updateTab(current, tabIndex, (currentTab) => ({
      ...currentTab,
      sections: [...currentTab.sections, nextSection],
    })));
    selectSection(nextSection);
  };

  const addStep = () => {
    if (tabIndex < 0 || sectionIndex < 0 || !section) return;
    const number = section.steps.length + 1;
    const nextStep = {
      id: nextId("step", collectIds(draft)),
      label: `步骤 ${number}`,
      title: `新步骤 ${number}`,
      description: "",
      next: [],
    };
    setDraft((current) => updateSection(current, tabIndex, sectionIndex, (currentSection) => ({
      ...currentSection,
      steps: [...currentSection.steps, nextStep],
    })));
    setSelectedStepId(nextStep.id);
  };

  const removeSelectedTab = () => {
    if (tabIndex < 0) return;
    const remaining = draft.tabs.filter((_, index) => index !== tabIndex);
    setDraft((current) => ({ ...current, tabs: current.tabs.filter((_, index) => index !== tabIndex) }));
    const replacement = remaining[Math.min(tabIndex, remaining.length - 1)];
    if (replacement) selectTab(replacement);
    else {
      setSelectedTabId("");
      setSelectedSectionId("");
      setSelectedStepId("");
    }
  };

  const removeSelectedSection = () => {
    if (tabIndex < 0 || sectionIndex < 0 || !tab) return;
    const remaining = tab.sections.filter((_, index) => index !== sectionIndex);
    setDraft((current) => updateTab(current, tabIndex, (currentTab) => ({
      ...currentTab,
      sections: currentTab.sections.filter((_, index) => index !== sectionIndex),
    })));
    const replacement = remaining[Math.min(sectionIndex, remaining.length - 1)];
    if (replacement) selectSection(replacement);
    else {
      setSelectedSectionId("");
      setSelectedStepId("");
    }
  };

  const removeSelectedStep = () => {
    if (tabIndex < 0 || sectionIndex < 0 || stepIndex < 0 || !section || !step) return;
    const remaining = section.steps.filter((_, index) => index !== stepIndex);
    setDraft((current) => updateSection(current, tabIndex, sectionIndex, (currentSection) => ({
      ...currentSection,
      steps: currentSection.steps
        .filter((_, index) => index !== stepIndex)
        .map((candidate) => ({ ...candidate, next: candidate.next.filter((id) => id !== step.id) })),
    })));
    setSelectedStepId(remaining[Math.min(stepIndex, remaining.length - 1)]?.id ?? "");
  };

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
      <div className="workflow-cascade">
        <section className="workflow-cascade-column" aria-label="Tab 配置">
          <header><h3>Tab</h3><button onClick={addTab} type="button">新增 Tab</button></header>
          <div className="workflow-cascade-list">
            {draft.tabs.map((candidate) => (
              <button
                aria-current={candidate.id === tab?.id ? "true" : undefined}
                key={candidate.id}
                onClick={() => selectTab(candidate)}
                type="button"
              >{candidate.title}</button>
            ))}
          </div>
          {tab ? <div className="workflow-cascade-editor">
            <label>Tab 标题<input aria-label="Tab 标题" data-autofocus value={tab.title} onChange={(event) => {
              const title = event.currentTarget.value;
              setDraft((current) => updateTab(current, tabIndex, (currentTab) => ({ ...currentTab, title })));
            }} /></label>
            <div className="row-actions">
              <button aria-label="Tab 上移" disabled={tabIndex === 0} onClick={() => setDraft((current) => moveAt(current, "tab", tabIndex, -1))} type="button">上移</button>
              <button aria-label="Tab 下移" disabled={tabIndex === draft.tabs.length - 1} onClick={() => setDraft((current) => moveAt(current, "tab", tabIndex, 1))} type="button">下移</button>
              <button onClick={removeSelectedTab} type="button">删除 Tab</button>
            </div>
            <button onClick={addSection} type="button">新增流程区域</button>
          </div> : <p>先新增一个 Tab。</p>}
        </section>

        <section className="workflow-cascade-column" aria-label="流程区域配置">
          <header><h3>步骤标题</h3></header>
          {tab ? <>
            <div className="workflow-cascade-list">
              {tab.sections.map((candidate) => (
                <button
                  aria-current={candidate.id === section?.id ? "true" : undefined}
                  key={candidate.id}
                  onClick={() => selectSection(candidate)}
                  type="button"
                >{candidate.title}</button>
              ))}
            </div>
            {section ? <div className="workflow-cascade-editor">
              <label>流程区域标题<input aria-label="流程区域标题" value={section.title} onChange={(event) => {
                const title = event.currentTarget.value;
                setDraft((current) => updateSection(current, tabIndex, sectionIndex, (currentSection) => ({ ...currentSection, title })));
              }} /></label>
              <div className="row-actions">
                <button aria-label="流程区域上移" disabled={sectionIndex === 0} onClick={() => setDraft((current) => moveAt(current, "section", sectionIndex, -1, tabIndex))} type="button">上移</button>
                <button aria-label="流程区域下移" disabled={sectionIndex === tab.sections.length - 1} onClick={() => setDraft((current) => moveAt(current, "section", sectionIndex, 1, tabIndex))} type="button">下移</button>
                <button onClick={removeSelectedSection} type="button">删除流程区域</button>
              </div>
              <button onClick={addStep} type="button">新增步骤</button>
            </div> : <p>先新增一个步骤标题。</p>}
          </> : <p>选择 Tab 后配置步骤标题。</p>}
        </section>

        <section className="workflow-cascade-column" aria-label="具体步骤配置">
          <header><h3>具体步骤</h3></header>
          {section ? <>
            <div className="workflow-cascade-list">
              {section.steps.map((candidate) => (
                <button
                  aria-current={candidate.id === step?.id ? "true" : undefined}
                  key={candidate.id}
                  onClick={() => setSelectedStepId(candidate.id)}
                  type="button"
                >{candidate.title}</button>
              ))}
            </div>
            {step ? <div className="workflow-cascade-editor">
              <label>步骤标题<input aria-label="步骤标题" value={step.title} onChange={(event) => {
                const title = event.currentTarget.value;
                setDraft((current) => updateStep(current, tabIndex, sectionIndex, stepIndex, (currentStep) => ({ ...currentStep, title })));
              }} /></label>
              <label>步骤角标<input aria-label="步骤角标" value={step.label} onChange={(event) => {
                const label = event.currentTarget.value;
                setDraft((current) => updateStep(current, tabIndex, sectionIndex, stepIndex, (currentStep) => ({ ...currentStep, label })));
              }} /></label>
              <label>步骤说明<textarea aria-label="步骤说明" value={step.description} onChange={(event) => {
                const description = event.currentTarget.value;
                setDraft((current) => updateStep(current, tabIndex, sectionIndex, stepIndex, (currentStep) => ({ ...currentStep, description })));
              }} /></label>
              <fieldset className="workflow-next-editor">
                <legend>后续步骤</legend>
                {section.steps.filter((candidate) => candidate.id !== step.id).map((candidate) => (
                  <label key={candidate.id}>
                    <input
                      aria-label={`${step.title} 后续：${candidate.title}`}
                      checked={step.next.includes(candidate.id)}
                      onChange={() => setDraft((current) => updateStep(current, tabIndex, sectionIndex, stepIndex, (currentStep) => ({
                        ...currentStep,
                        next: currentStep.next.includes(candidate.id)
                          ? currentStep.next.filter((id) => id !== candidate.id)
                          : [...currentStep.next, candidate.id],
                      })))}
                      type="checkbox"
                    />
                    {candidate.title}
                  </label>
                ))}
              </fieldset>
              <div className="row-actions">
                <button aria-label="步骤上移" disabled={stepIndex === 0} onClick={() => setDraft((current) => moveAt(current, "step", stepIndex, -1, tabIndex, sectionIndex))} type="button">上移</button>
                <button aria-label="步骤下移" disabled={stepIndex === section.steps.length - 1} onClick={() => setDraft((current) => moveAt(current, "step", stepIndex, 1, tabIndex, sectionIndex))} type="button">下移</button>
                <button onClick={removeSelectedStep} type="button">删除步骤</button>
              </div>
            </div> : <p>先新增一个具体步骤。</p>}
          </> : <p>选择步骤标题后配置具体步骤。</p>}
        </section>
      </div>

      <footer className="workflow-editor-actions">
        <button onClick={() => setPreview((value) => !value)} type="button">{preview ? "关闭预览" : "预览流程"}</button>
        <button onClick={save} type="button">保存流程</button>
      </footer>
      {preview ? <div className="workflow-preview"><WorkflowGraph document={{ revision: document.revision, ...draft }} /></div> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function resolveIndex(items: ReadonlyArray<{ id: string }>, selectedId: string): number {
  const index = items.findIndex((item) => item.id === selectedId);
  return index >= 0 ? index : items.length > 0 ? 0 : -1;
}

function updateTab(value: WorkflowValue, tabIndex: number, update: (tab: WorkflowTab) => WorkflowTab): WorkflowValue {
  const next = structuredClone(value);
  next.tabs[tabIndex] = update(next.tabs[tabIndex]);
  return next;
}

function updateSection(value: WorkflowValue, tabIndex: number, sectionIndex: number, update: (section: WorkflowSection) => WorkflowSection): WorkflowValue {
  return updateTab(value, tabIndex, (tab) => {
    const sections = [...tab.sections];
    sections[sectionIndex] = update(sections[sectionIndex]);
    return { ...tab, sections };
  });
}

function updateStep(value: WorkflowValue, tabIndex: number, sectionIndex: number, stepIndex: number, update: (step: WorkflowStep) => WorkflowStep): WorkflowValue {
  return updateSection(value, tabIndex, sectionIndex, (section) => {
    const steps = [...section.steps];
    steps[stepIndex] = update(steps[stepIndex]);
    return { ...section, steps };
  });
}

function collectIds(value: WorkflowValue): Set<string> {
  const ids = new Set<string>();
  value.tabs.forEach((tab) => {
    ids.add(tab.id);
    tab.sections.forEach((section) => {
      ids.add(section.id);
      section.steps.forEach((step) => ids.add(step.id));
    });
  });
  return ids;
}

function nextId(prefix: string, existing: Set<string>): string {
  let index = 1;
  while (existing.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function moveAt(
  value: WorkflowValue,
  level: "tab" | "section" | "step",
  index: number,
  offset: number,
  tabIndex = -1,
  sectionIndex = -1,
): WorkflowValue {
  const next = structuredClone(value);
  const target = index + offset;
  if (level === "tab") moveItem(next.tabs, index, target);
  else if (level === "section") moveItem(next.tabs[tabIndex].sections, index, target);
  else moveItem(next.tabs[tabIndex].sections[sectionIndex].steps, index, target);
  return next;
}

function moveItem<T>(items: T[], index: number, target: number): void {
  if (target < 0 || target >= items.length) return;
  const [item] = items.splice(index, 1);
  items.splice(target, 0, item);
}
