import { useId, useRef, useState, type ReactNode } from "react";

import type { WorkflowDocument } from "../types";
import { WorkflowStepImages } from "./WorkflowStepImages";

export function WorkflowGraph({ document, selectedTabId, onTabChange, actions }: {
  document: WorkflowDocument; selectedTabId?: string; onTabChange?: (id: string) => void; actions?: ReactNode;
}) {
  const [localTabId, setLocalTabId] = useState(document.tabs[0]?.id ?? "");
  const instanceId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectTab = (id: string) => { setLocalTabId(id); onTabChange?.(id); };
  if (document.tabs.length === 0) return <div className="workflow-graph">
    {actions && <div className="portal-page-toolbar" aria-label="页面操作">{actions}</div>}
    <p className="empty-copy">尚未配置鸟瞰全景流程</p>
  </div>;

  const selected = document.tabs.find((tab) => tab.id === (selectedTabId ?? localTabId)) ?? document.tabs[0];
  const selectedIndex = document.tabs.indexOf(selected);
  const visibleSteps = selected.sections.flatMap((section) => section.steps);
  return (
    <div className="workflow-graph">
      <div className="workflow-reading-toolbar">
      <div className="workflow-tabs" role="tablist" aria-label="流程">
        {document.tabs.map((tab, index) => (
          <button
            id={`${instanceId}-tab-${index}`}
            aria-controls={`${instanceId}-panel`}
            aria-selected={tab.id === selected.id}
            tabIndex={tab.id === selected.id ? 0 : -1}
            ref={(element) => { tabRefs.current[index] = element; }}
            key={tab.id}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? (index + 1) % document.tabs.length
                : event.key === "ArrowLeft" ? (index - 1 + document.tabs.length) % document.tabs.length
                : event.key === "Home" ? 0 : event.key === "End" ? document.tabs.length - 1 : undefined;
              if (next === undefined) return;
              event.preventDefault();
              selectTab(document.tabs[next].id);
              tabRefs.current[next]?.focus();
            }}
            role="tab"
            type="button"
          >
            {tab.title}
          </button>
        ))}
      </div>
      {actions && <div className="portal-page-toolbar" aria-label="页面操作">{actions}</div>}
      </div>
      <div id={`${instanceId}-panel`} className="workflow-reading-panel" role="tabpanel" aria-labelledby={`${instanceId}-tab-${selectedIndex}`} tabIndex={0}>
      {selected.sections.map((section) => (
        <section className="workflow-section" key={section.id}>
          <div className="workflow-section-heading">
            <h2>{section.title}</h2>
            <span>{section.steps.length} 个步骤</span>
          </div>
          <ol className="workflow-steps workflow-reading-steps" role="list" aria-label={section.title}>
            {section.steps.map((step, index) => (
              <li className="workflow-step-item" key={step.id}>
              <article className="workflow-step" data-workflow-step={step.id} data-workflow-section={section.id} data-next={step.next.join(" ")} key={step.id}>
                <div className="workflow-step-heading">
                  <span className="workflow-step-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <div><span className="workflow-step-label">{step.label}</span><h3>{step.title}</h3></div>
                </div>
                {step.description ? <p>{step.description}</p> : null}
                <WorkflowStepImages pluginKey={document.pluginKey} images={step.images} title={step.title} stepId={step.id} steps={visibleSteps} />
              </article>
              </li>
            ))}
          </ol>
        </section>
      ))}
      </div>
    </div>
  );
}
