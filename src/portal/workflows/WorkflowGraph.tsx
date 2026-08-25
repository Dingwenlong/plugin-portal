import { useState } from "react";

import type { WorkflowDocument } from "../types";

export function WorkflowGraph({ document }: { document: WorkflowDocument }) {
  const [selectedTabId, setSelectedTabId] = useState(document.tabs[0]?.id ?? "");
  if (document.tabs.length === 0) return <p className="empty-copy">尚未配置鸟瞰全景流程</p>;

  const selected = document.tabs.find((tab) => tab.id === selectedTabId) ?? document.tabs[0];
  return (
    <div className="workflow-graph">
      <div className="workflow-tabs" role="tablist" aria-label="流程">
        {document.tabs.map((tab) => (
          <button
            aria-selected={tab.id === selected.id}
            key={tab.id}
            onClick={() => setSelectedTabId(tab.id)}
            role="tab"
            type="button"
          >
            {tab.title}
          </button>
        ))}
      </div>
      {selected.sections.map((section) => (
        <section className="workflow-section" key={section.id}>
          <h2>{section.title}</h2>
          <div className="workflow-steps">
            {section.steps.map((step) => (
              <article className="workflow-step" data-next={step.next.join(" ")} key={step.id}>
                <span>{step.label}</span>
                <h3>{step.title}</h3>
                {step.description ? <p>{step.description}</p> : null}
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
