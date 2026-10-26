import { useLayoutEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { usePortalModalPresence } from "../PortalPresence";
import type { WorkflowDocument, WorkflowValue } from "../types";
import type { UploadWorkflowImage } from "./useWorkflowImageUploads";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowGraph } from "./WorkflowGraph";
import { captureWorkflowAnchor, resolveWorkflowLocation, restoreWorkflowAnchor, type WorkflowAnchor } from "./workflowLocation";

export function WorkflowOverview({ document, readOnly, onSave, onCheckSaved, onReadLatest, onUploadImage }: {
  document: WorkflowDocument; readOnly: boolean;
  onSave: (revision: number, workflow: WorkflowValue) => Promise<unknown>;
  onCheckSaved?: (workflow: WorkflowValue) => Promise<boolean>;
  onReadLatest?: () => Promise<WorkflowDocument>;
  onUploadImage?: UploadWorkflowImage;
}) {
  const [editing, setEditing] = useState(false);
  const [location, setLocation] = useState(() => resolveWorkflowLocation(document));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<WorkflowAnchor | undefined>(undefined);
  const restoreFocus = useRef(false);
  const start = () => {
    const anchor = captureWorkflowAnchor(rootRef.current);
    anchorRef.current = anchor;
    setLocation((current) => resolveWorkflowLocation(document, anchor.stepId
      ? { ...current, sectionId: anchor.sectionId, stepId: anchor.stepId } : current));
    setEditing(true);
  };
  const finish = () => {
    const anchor = captureWorkflowAnchor(rootRef.current);
    anchorRef.current = anchor.stepId ? anchor : { ...anchor, sectionId: location.sectionId, stepId: location.stepId, top: 128 };
    restoreFocus.current = true;
    setEditing(false);
  };
  useLayoutEffect(() => {
    if (anchorRef.current) restoreWorkflowAnchor(rootRef.current, anchorRef.current);
    anchorRef.current = undefined;
    if (editing) {
      const selected = rootRef.current?.querySelector<HTMLElement>('[aria-current="true"]')
        ?? rootRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?? rootRef.current?.querySelector<HTMLElement>('.workflow-editor-canvas button:not([disabled])');
      selected?.focus({ preventScroll: true });
    }
    if (restoreFocus.current) { triggerRef.current?.focus({ preventScroll: true }); restoreFocus.current = false; }
  }, [editing]);

  const editAction = !readOnly ? <button aria-label="编辑流程" aria-pressed={editing}
      className="portal-page-action" disabled={editing} onClick={start} ref={triggerRef} type="button">
      <Pencil aria-hidden="true" size={17} /><span className="portal-action-label">{editing ? "正在编辑" : "编辑流程"}</span>
    </button> : null;

  return <div className="workflow-overview" ref={rootRef}>
    {editing && !readOnly ? <>
      <div className="portal-page-toolbar" aria-label="页面操作">{editAction}</div>
      <EditingPresence />
      <WorkflowEditor document={document} initialLocation={location} onLocationChange={setLocation}
        onExit={finish} onSave={onSave} onCheckSaved={onCheckSaved} onReadLatest={onReadLatest} onUploadImage={onUploadImage} />
    </> : <WorkflowGraph document={document} selectedTabId={location.tabId} actions={editAction}
      onTabChange={(tabId) => setLocation(resolveWorkflowLocation(document, { tabId }))} />}
  </div>;
}

function EditingPresence() { usePortalModalPresence(); return null; }
