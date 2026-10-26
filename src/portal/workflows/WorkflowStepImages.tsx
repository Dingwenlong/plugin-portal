import { useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Eye, EyeOff } from "lucide-react";
import { PortalModal } from "../PortalModal";
import type { WorkflowImage, WorkflowStep } from "../types";
import { workflowImageUrl } from "./useWorkflowImageUploads";

export function WorkflowStepImages({ pluginKey, images: initialImages = [], title: initialTitle, steps = [], stepId }: { pluginKey: string; images?: WorkflowImage[]; title: string; steps?: WorkflowStep[]; stepId?: string }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [viewedId, setViewedId] = useState(stepId);
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsId = useId();
  const stepIndex = steps.findIndex((step) => step.id === viewedId);
  const step = steps[stepIndex];
  const images = step?.images ?? (step ? [] : initialImages);
  const title = step?.title ?? initialTitle;
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (selected === null || !images.length) return;
    const arrow = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -1 : 1;
      setSelected((index) => index === null ? null : (index + delta + images.length) % images.length);
    };
    document.addEventListener("keydown", arrow);
    return () => document.removeEventListener("keydown", arrow);
  }, [selected, images.length]);
  if (!initialImages.length) return null;
  const active = selected === null ? null : Math.max(0, Math.min(selected, images.length - 1));
  const alt = (index: number) => images[index].alt || `${title}，图片 ${index + 1}`;
  const move = (delta: number) => setSelected((index) => index === null ? null : (index + delta + images.length) % images.length);
  return <>
    <div className="workflow-step-images">
      {initialImages.map((image, index) => <button className="workflow-image-thumbnail" aria-label={`查看图片：${image.alt || `${initialTitle}，图片 ${index + 1}`}`}
        key={image.assetId} type="button" onClick={(event) => { returnFocusRef.current = event.currentTarget; setViewedId(stepId); setSelected(index); setControlsVisible(true); }}>
        <img src={workflowImageUrl(pluginKey, image.assetId)} alt={image.alt || `${initialTitle}，图片 ${index + 1}`} loading="lazy" decoding="async" />
        <span className="workflow-substep-caption">{index + 1}. {image.title?.trim() || `子步骤 ${index + 1}`}</span>
      </button>)}
    </div>
    {active !== null && <PortalModal title="步骤图片" onClose={() => setSelected(null)} returnFocusRef={returnFocusRef} wide imageViewer>
      <div className="workflow-image-viewer workflow-step-viewer workflow-immersive-viewer">
        {images.length > 0 ? <img key={images[active].assetId} src={workflowImageUrl(pluginKey, images[active].assetId, "full")} alt={alt(active)} /> : <p className="workflow-viewer-no-image">该步骤暂无图片</p>}
        <div className="workflow-viewer-overlays">
        <div className="workflow-viewer-dock" data-collapsed={!controlsVisible || undefined}>
        <section id={controlsId} hidden={!controlsVisible} className="workflow-viewer-description" aria-label="步骤说明" aria-live="polite" tabIndex={0}>
          <h3>{images[active]?.title?.trim() || title}</h3>
          <p>{images[active]?.alt || step?.description || "该子步骤暂无说明。"}</p>
        </section>
        <div className="workflow-viewer-navigation workflow-viewer-icon-navigation" data-collapsed={!controlsVisible || undefined} aria-label="图片与步骤导航">
        <div id={`${controlsId}-images`} hidden={!controlsVisible} className="workflow-image-viewer-actions">
          <button aria-label="上一子步骤" title="上一子步骤" disabled={images.length < 2} type="button" onClick={() => move(-1)}><ChevronLeft aria-hidden="true" size={18} /></button>
          <span aria-live="polite" title={images.length > 0 ? alt(active) : undefined}>{images.length > 0 ? `${active + 1} / ${images.length}` : "无图片"}</span>
          <button aria-label="下一子步骤" title="下一子步骤" disabled={images.length < 2} type="button" onClick={() => move(1)}><ChevronRight aria-hidden="true" size={18} /></button>
        </div>
        <button className="workflow-viewer-visibility" type="button" aria-label={controlsVisible ? "隐藏控件" : "显示控件"} title={controlsVisible ? "隐藏控件" : "显示控件"}
          aria-expanded={controlsVisible} aria-controls={`${controlsId} ${controlsId}-images${step ? ` ${controlsId}-steps` : ""}`} onClick={() => setControlsVisible((visible) => !visible)}>
          {controlsVisible ? <EyeOff aria-hidden="true" size={18} /> : <Eye aria-hidden="true" size={18} />}
        </button>
        {step && <div id={`${controlsId}-steps`} hidden={!controlsVisible} className="workflow-viewer-step-actions">
          <button aria-label="上一步骤" title="上一步骤" type="button" disabled={stepIndex <= 0} onClick={() => { setViewedId(steps[stepIndex - 1].id); setSelected(0); }}><ChevronsLeft aria-hidden="true" size={18} /></button>
          <span aria-live="polite" aria-label={`步骤 ${stepIndex + 1} / ${steps.length}`}><span className="workflow-viewer-progress-label">步骤 </span>{stepIndex + 1} / {steps.length}</span>
          <button aria-label={stepIndex >= steps.length - 1 ? "已是最后一步" : "下一步骤"} title={stepIndex >= steps.length - 1 ? "已是最后一步" : "下一步骤"} type="button" disabled={stepIndex >= steps.length - 1} onClick={() => { setViewedId(steps[stepIndex + 1].id); setSelected(0); }}>
            <ChevronsRight aria-hidden="true" size={18} />
          </button>
        </div>}
        </div>
        </div>
        </div>
      </div>
    </PortalModal>}
  </>;
}
