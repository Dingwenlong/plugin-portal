import { useEffect, useRef, useState } from "react";
import { useModalGuard } from "../PortalModal";
import { useSaveRecovery } from "../useSaveRecovery";
import { SaveFeedback } from "../SaveFeedback";
import { sameContent } from "../requestState";
import { useWorkflowImageUploads, type UploadWorkflowImage } from "./useWorkflowImageUploads";
import { resolveWorkflowLocation, type WorkflowLocation } from "./workflowLocation";
import { useWorkflowExitGuard } from "./useWorkflowExitGuard";
import { useWorkflowInspector } from "./useWorkflowInspector";

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
  onCheckSaved,
  onReadLatest,
  onUploadImage,
  initialLocation,
  onLocationChange,
  onExit,
}: {
  document: WorkflowDocument;
  onSave: (revision: number, workflow: WorkflowValue) => Promise<unknown>;
  onCheckSaved?: (workflow: WorkflowValue) => Promise<boolean>;
  onReadLatest?: () => Promise<WorkflowDocument>;
  onUploadImage?: UploadWorkflowImage;
  initialLocation?: WorkflowLocation;
  onLocationChange?: (location: WorkflowLocation) => void;
  onExit?: () => void;
}) {
  const [draft, setDraft] = useState<WorkflowValue>(() => ({
    pluginKey: document.pluginKey,
    tabs: structuredClone(document.tabs),
  }));
  const [initial] = useState(() => resolveWorkflowLocation(document, initialLocation));
  const [selectedTabId, setSelectedTabId] = useState(initial.tabId);
  const [selectedSectionId, setSelectedSectionId] = useState(initial.sectionId ?? "");
  const [selectedStepId, setSelectedStepId] = useState(initial.stepId ?? "");
  const [selectionKind, setSelectionKind] = useState<SelectionKind>(() => initial.stepId ? "step" : initial.sectionId ? "section" : "tab");
  const [focusRequest, setFocusRequest] = useState(0);
  const [revision, setRevision] = useState(document.revision);
  const [baseline, setBaseline] = useState(() => ({ pluginKey: document.pluginKey, tabs: structuredClone(document.tabs) }));
  const recovery = useSaveRecovery(onCheckSaved, onExit);
  const uploads = useWorkflowImageUploads(draft, setDraft, onUploadImage);
  const dirty = !sameContent(draft, baseline);
  useModalGuard(dirty || recovery.pending, recovery.busy);
  const exitGuard = useWorkflowExitGuard({ onExit, dirty, busy: recovery.busy, pending: recovery.pending });
  const inspector = useWorkflowInspector(Boolean(onExit));
  const titleInputRef = useRef<HTMLInputElement>(null);

  const tabIndex = resolveIndex(draft.tabs, selectedTabId);
  const tab = tabIndex >= 0 ? draft.tabs[tabIndex] : undefined;
  const sectionIndex = resolveIndex(tab?.sections ?? [], selectedSectionId);
  const section = sectionIndex >= 0 ? tab?.sections[sectionIndex] : undefined;
  const stepIndex = resolveIndex(section?.steps ?? [], selectedStepId);
  const step = stepIndex >= 0 ? section?.steps[stepIndex] : undefined;

  useEffect(() => {
    onLocationChange?.({ tabId: tab?.id ?? "", sectionId: section?.id, stepId: step?.id });
  }, [onLocationChange, tab?.id, section?.id, step?.id]);

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
    inspector.show();
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
    inspector.show();
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
    inspector.show();
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
    if (uploads.blocked) return;
    await recovery.run(draft, (frozen) => onSave(revision, frozen));
  };

  return (
    <section aria-label="流程编辑" className={`workflow-editor${onExit ? " workflow-editor-inline" : ""}`}
      data-inspector-open={inspector.open}>
      <fieldset disabled={recovery.busy || recovery.pending}>
      <div className="workflow-editor-layout">
        <section aria-label="流程画布" className="workflow-editor-canvas" ref={inspector.canvasRef}>
          <div className="workflow-editor-canvas-toolbar">
            <div aria-label="流程" className="workflow-tabs" role="tablist">
              {draft.tabs.map((candidate) => (
                <button
                  aria-selected={candidate.id === tab?.id}
                  key={candidate.id}
                  onClick={() => { selectTab(candidate); }}
                  role="tab"
                  type="button"
                >{candidate.title}</button>
              ))}
            </div>
            {tab && <button type="button" onClick={() => { setSelectionKind("tab"); inspector.show(); }}>编辑当前 Tab</button>}
            <button onClick={addTab} type="button">新增 Tab</button>
          </div>

          {tab ? <div className="workflow-editor-tab-canvas">
            {tab.sections.map((candidateSection) => (
              <section className="workflow-section workflow-editor-section" key={candidateSection.id}>
                <button
                  aria-current={candidateSection.id === section?.id && selectionKind === "section" ? "true" : undefined}
                  aria-label={candidateSection.title}
                  className="workflow-editor-section-title"
                  onClick={() => { selectSection(candidateSection); inspector.show(); }}
                  type="button"
                >{candidateSection.title}</button>
                <div className="workflow-steps">
                  {candidateSection.steps.map((candidateStep) => (
                    <button
                      aria-current={candidateStep.id === step?.id && selectionKind === "step" ? "true" : undefined}
                      aria-label={candidateStep.title}
                      className="workflow-step workflow-editor-step"
                      data-workflow-step={candidateStep.id}
                      data-workflow-section={candidateSection.id}
                      key={candidateStep.id}
                      onClick={() => {
                        if (candidateSection.id !== section?.id) selectSection(candidateSection, "step");
                        selectStep(candidateStep);
                        inspector.show();
                      }}
                      type="button"
                    >
                      <span>{candidateStep.label}</span>
                      <strong>{candidateStep.title}</strong>
                      {candidateStep.description ? <p>{candidateStep.description}</p> : null}
                      {candidateStep.images?.length ? <span className="workflow-step-images" aria-hidden="true">
                        {candidateStep.images.map((image) => <img key={image.assetId} src={uploads.source(image.assetId)} alt="" />)}
                      </span> : null}
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

        <aside aria-label="属性栏" className="workflow-inspector" ref={inspector.panelRef}>
          {onExit && <p className="workflow-inspector-context">{tab?.title}{selectionKind === "step" && section ? ` / ${section.title}` : ""}</p>}
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
            <section className="workflow-image-inspector" aria-label="步骤图片"
              onDragOver={(event) => { if (!recovery.busy && !recovery.pending && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
              onDrop={(event) => {
                event.preventDefault();
                if (!recovery.busy && !recovery.pending) uploads.add(step.id, Array.from(event.dataTransfer.files));
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
                if (files.length) { event.preventDefault(); if (!recovery.busy && !recovery.pending) uploads.add(step.id, files); }
              }}>
              <label>添加子步骤图片<input aria-label="添加步骤图片" type="file" multiple accept="image/png,image/jpeg,image/webp"
                disabled={(step.images?.length ?? 0) >= 6} onChange={(event) => {
                  uploads.add(step.id, Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = "";
                }} /></label>
              <small>最多 6 张 · 单张 10 MiB / 2000 万像素 · 保存流程后公开</small>
              <small>每张图片对应一个子步骤，可分别填写标题和说明；前移／后移同步调整子步骤顺序。</small>
              {onExit && <small>可拖入图片，或在此区域粘贴截图</small>}
              {uploads.notice && <p role="alert">{uploads.notice}</p>}
              {(step.images ?? []).map((image, index) => <div className="workflow-image-edit" key={image.assetId}>
                <img src={uploads.source(image.assetId)} alt={image.alt || `步骤图片 ${index + 1}`} />
                <strong>子步骤 {index + 1}</strong>
                <label>子步骤标题<input aria-label={`子步骤 ${index + 1} 标题`} placeholder={`子步骤 ${index + 1}`} maxLength={200} value={image.title ?? ""}
                  onChange={(event) => {
                    const title = event.currentTarget.value;
                    setDraft((current) => updateStep(current, tabIndex, sectionIndex, stepIndex, (item) => ({
                      ...item, images: item.images?.map((candidate) => candidate.assetId === image.assetId ? { ...candidate, title } : candidate),
                    })));
                  }} /></label>
                <label>子步骤说明<textarea aria-label={`子步骤 ${index + 1} 说明`} maxLength={200} value={image.alt}
                  onChange={(event) => {
                    const alt = event.currentTarget.value;
                    setDraft((current) => updateStep(current, tabIndex, sectionIndex, stepIndex, (item) => ({
                      ...item, images: item.images?.map((candidate) => candidate.assetId === image.assetId ? { ...candidate, alt } : candidate),
                    })));
                  }} /></label>
                {uploads.status(image.assetId) === "queued" || uploads.status(image.assetId) === "uploading" ? <small role="status">正在上传图片…</small> : null}
                {uploads.error(image.assetId) && <p role="alert">{uploads.error(image.assetId)}</p>}
                <div className="row-actions">
                  {uploads.status(image.assetId) === "error" && <button type="button" aria-label={`重试图片 ${index + 1}`} onClick={() => uploads.retry(image.assetId)}>重试</button>}
                  {recovery.error && !recovery.conflict && uploads.status(image.assetId) === "ready" && <button type="button" aria-label={`重新上传图片 ${index + 1}`} onClick={() => uploads.retry(image.assetId)}>重新上传</button>}
                  {[-1, 1].map((offset) => <button type="button" key={offset}
                    aria-label={`图片 ${index + 1} ${offset < 0 ? "前移" : "后移"}`}
                    disabled={offset < 0 ? index === 0 : index === (step.images?.length ?? 0) - 1}
                    onClick={() => setDraft((current) => updateStep(current, tabIndex, sectionIndex, stepIndex, (item) => {
                      const images = [...(item.images ?? [])]; moveItem(images, index, index + offset); return { ...item, images };
                    }))}>{offset < 0 ? "前移" : "后移"}</button>)}
                  <button type="button" aria-label={`删除图片 ${index + 1}`} onClick={() => setDraft((current) => updateStep(current, tabIndex, sectionIndex, stepIndex, (item) => ({
                    ...item, images: item.images?.filter((candidate) => candidate.assetId !== image.assetId),
                  })))}>删除</button>
                </div>
              </div>)}
            </section>
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

      </fieldset>
      <footer className="workflow-editor-actions">
        <div className="workflow-editor-save-controls">
        {onExit && <p role="status">{recovery.busy ? recovery.pending ? "正在核对保存结果…" : "正在保存…" : recovery.pending ? "保存结果待确认" : uploads.blocked ? "图片待处理，完成后可保存" : dirty ? "有未保存的修改" : "编辑模式 · 修改后保存生效"}</p>}
        <div className="row-actions">
          {inspector.compact && inspector.open && <button disabled={recovery.busy} onClick={inspector.back} type="button">返回流程</button>}
          {onExit && <button disabled={recovery.busy} onClick={exitGuard.requestExit} type="button">退出编辑</button>}
          <button disabled={uploads.blocked || recovery.busy || recovery.pending} onClick={save} type="button">保存流程</button>
        </div>
        </div>
        <div className="workflow-editor-recovery">
      <SaveFeedback recovery={recovery} showBusy={!onExit} draft={draft} readLatest={onReadLatest} applyLatest={(latest) => {
        const value = { pluginKey: latest.pluginKey, tabs: structuredClone(latest.tabs) };
        setDraft(value); setBaseline(structuredClone(value)); setRevision(latest.revision);
      }} />
        </div>
      </footer>
      {exitGuard.confirmation}
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
