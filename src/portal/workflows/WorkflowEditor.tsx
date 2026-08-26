import { useEffect, useRef, useState } from "react";

import type {
  WorkflowDocument,
  WorkflowSection,
  WorkflowStep,
  WorkflowTab,
  WorkflowValue,
} from "../types";

type SelectionKind = "tab" | "section" | "step";

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
  const [selectionKind, setSelectionKind] = useState<SelectionKind>(() => initialSelectionKind(document));
  const [focusRequest, setFocusRequest] = useState(0);
  const [error, setError] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  const tabIndex = resolveIndex(draft.tabs, selectedTabId);
  const tab = tabIndex >= 0 ? draft.tabs[tabIndex] : undefined;
  const sectionIndex = resolveIndex(tab?.sections ?? [], selectedSectionId);
  const section = sectionIndex >= 0 ? tab?.sections[sectionIndex] : undefined;
  const stepIndex = resolveIndex(section?.steps ?? [], selectedStepId);
  const step = stepIndex >= 0 ? section?.steps[stepIndex] : undefined;

  useEffect(() => {
    if (focusRequest > 0) titleInputRef.current?.focus();
  }, [focusRequest]);

  const requestTitleFocus = () => setFocusRequest((value) => value + 1);

  const selectTab = (nextTab: WorkflowTab, kind: SelectionKind = "tab") => {
    setSelectedTabId(nextTab.id);
    setSelectedSectionId(nextTab.sections[0]?.id ?? "");
    setSelectedStepId(nextTab.sections[0]?.steps[0]?.id ?? "");
    setSelectionKind(kind);
  };

  const selectSection = (nextSection: WorkflowSection, kind: SelectionKind = "section") => {
    setSelectedSectionId(nextSection.id);
    setSelectedStepId(nextSection.steps[0]?.id ?? "");
    setSelectionKind(kind);
  };

  const selectStep = (nextStep: WorkflowStep) => {
    setSelectedStepId(nextStep.id);
    setSelectionKind("step");
  };

  const addTab = () => {
    const nextTab = { id: nextId("tab", collectIds(draft)), title: "新 Tab", sections: [] };
    setDraft((current) => ({ ...current, tabs: [...current.tabs, nextTab] }));
    selectTab(nextTab);
    requestTitleFocus();
  };

  const addSection = () => {
    if (tabIndex < 0) return;
    const nextSection = { id: nextId("section", collectIds(draft)), title: "新流程区域", steps: [] };
    setDraft((current) => updateTab(current, tabIndex, (currentTab) => ({
      ...currentTab,
      sections: [...currentTab.sections, nextSection],
    })));
    selectSection(nextSection);
    requestTitleFocus();
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
    selectStep(nextStep);
    requestTitleFocus();
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
      setSelectionKind("tab");
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
      setSelectionKind("tab");
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
    const replacement = remaining[Math.min(stepIndex, remaining.length - 1)];
    if (replacement) selectStep(replacement);
    else {
      setSelectedStepId("");
      setSelectionKind("section");
    }
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
      <div className="workflow-editor-layout">
        <section aria-label="流程画布" className="workflow-editor-canvas">
          <div className="workflow-editor-canvas-toolbar">
            <div aria-label="流程" className="workflow-tabs" role="tablist">
              {draft.tabs.map((candidate) => (
                <button
                  aria-selected={candidate.id === tab?.id}
                  key={candidate.id}
                  onClick={() => selectTab(candidate)}
                  role="tab"
                  type="button"
                >{candidate.title}</button>
              ))}
            </div>
            <button onClick={addTab} type="button">新增 Tab</button>
          </div>

          {tab ? <div className="workflow-editor-tab-canvas">
            {tab.sections.map((candidateSection) => (
              <section className="workflow-section workflow-editor-section" key={candidateSection.id}>
                <button
                  aria-current={candidateSection.id === section?.id && selectionKind === "section" ? "true" : undefined}
                  aria-label={candidateSection.title}
                  className="workflow-editor-section-title"
                  onClick={() => selectSection(candidateSection)}
                  type="button"
                >{candidateSection.title}</button>
                <div className="workflow-steps">
                  {candidateSection.steps.map((candidateStep) => (
                    <button
                      aria-current={candidateStep.id === step?.id && selectionKind === "step" ? "true" : undefined}
                      aria-label={candidateStep.title}
                      className="workflow-step workflow-editor-step"
                      key={candidateStep.id}
                      onClick={() => {
                        if (candidateSection.id !== section?.id) selectSection(candidateSection, "step");
                        selectStep(candidateStep);
                      }}
                      type="button"
                    >
                      <span>{candidateStep.label}</span>
                      <strong>{candidateStep.title}</strong>
                      {candidateStep.description ? <p>{candidateStep.description}</p> : null}
                    </button>
                  ))}
                  {candidateSection.id === section?.id ? (
                    <button className="workflow-editor-add workflow-editor-add-step" onClick={addStep} type="button">新增步骤</button>
                  ) : null}
                </div>
              </section>
            ))}
            <button className="workflow-editor-add workflow-editor-add-section" onClick={addSection} type="button">新增流程区域</button>
          </div> : <p className="workflow-editor-empty">先新增一个 Tab。</p>}
        </section>

        <aside aria-label="属性栏" className="workflow-inspector">
          {selectionKind === "step" && step ? <>
            <h3>编辑具体步骤</h3>
            <label>步骤标题<input aria-label="步骤标题" data-autofocus ref={titleInputRef} value={step.title} onChange={(event) => {
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
              {section?.steps.filter((candidate) => candidate.id !== step.id).map((candidate) => (
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
              <button aria-label="步骤下移" disabled={stepIndex === (section?.steps.length ?? 0) - 1} onClick={() => setDraft((current) => moveAt(current, "step", stepIndex, 1, tabIndex, sectionIndex))} type="button">下移</button>
              <button onClick={removeSelectedStep} type="button">删除步骤</button>
            </div>
          </> : selectionKind === "section" && section ? <>
            <h3>编辑流程区域</h3>
            <label>流程区域标题<input aria-label="流程区域标题" data-autofocus ref={titleInputRef} value={section.title} onChange={(event) => {
              const title = event.currentTarget.value;
              setDraft((current) => updateSection(current, tabIndex, sectionIndex, (currentSection) => ({ ...currentSection, title })));
            }} /></label>
            <div className="row-actions">
              <button aria-label="流程区域上移" disabled={sectionIndex === 0} onClick={() => setDraft((current) => moveAt(current, "section", sectionIndex, -1, tabIndex))} type="button">上移</button>
              <button aria-label="流程区域下移" disabled={sectionIndex === (tab?.sections.length ?? 0) - 1} onClick={() => setDraft((current) => moveAt(current, "section", sectionIndex, 1, tabIndex))} type="button">下移</button>
              <button onClick={removeSelectedSection} type="button">删除流程区域</button>
            </div>
          </> : tab ? <>
            <h3>编辑 Tab</h3>
            <label>Tab 标题<input aria-label="Tab 标题" data-autofocus ref={titleInputRef} value={tab.title} onChange={(event) => {
              const title = event.currentTarget.value;
              setDraft((current) => updateTab(current, tabIndex, (currentTab) => ({ ...currentTab, title })));
            }} /></label>
            <div className="row-actions">
              <button aria-label="Tab 上移" disabled={tabIndex === 0} onClick={() => setDraft((current) => moveAt(current, "tab", tabIndex, -1))} type="button">上移</button>
              <button aria-label="Tab 下移" disabled={tabIndex === draft.tabs.length - 1} onClick={() => setDraft((current) => moveAt(current, "tab", tabIndex, 1))} type="button">下移</button>
              <button onClick={removeSelectedTab} type="button">删除 Tab</button>
            </div>
          </> : <p className="workflow-editor-empty">新增 Tab 后即可配置流程。</p>}
        </aside>
      </div>

      <footer className="workflow-editor-actions">
        <button onClick={save} type="button">保存流程</button>
      </footer>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function initialSelectionKind(document: WorkflowDocument): SelectionKind {
  if (document.tabs[0]?.sections[0]?.steps[0]) return "step";
  if (document.tabs[0]?.sections[0]) return "section";
  return "tab";
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
