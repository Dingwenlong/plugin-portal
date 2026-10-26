import { useState, type RefObject, type MouseEvent, type KeyboardEvent } from "react";
import { GripVertical } from "lucide-react";
import { PluginBrandIcon } from "../portal/PluginBrandIcon";
import { groupCatalogPlugins } from "../portal/catalogIdentity";
import { portalHref } from "../portal/routes";
import type { PluginCatalog, PluginListItem } from "../portal/types";
import { usePluginMenu, usePluginOrdering } from "./HubPluginActions";
import "./hubVersions.css";

export function HubPluginEntries({ catalog, interactive, firstEntryRef }: {
  catalog: PluginCatalog;
  interactive: boolean;
  firstEntryRef?: RefObject<HTMLAnchorElement | null>;
}) {
  const openMenu = usePluginMenu();
  const ordering = usePluginOrdering();
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean }>();
  const sortable = interactive && ordering?.enabled && !ordering.busy;
  const actions = (item: PluginListItem) => ({
    onContextMenu: (event: MouseEvent<HTMLAnchorElement>) => {
      if (!interactive || !openMenu) return;
      event.preventDefault(); event.stopPropagation();
      openMenu(item, event.currentTarget, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
    },
    onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => {
      if (!interactive || !openMenu || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
      event.preventDefault(); event.stopPropagation();
      openMenu(item, event.currentTarget);
    },
  });
  return groupCatalogPlugins(catalog.items).map(([item, ...alternatives], index) =>
    <div className="company-dev-hub-entry-row" key={item.id} data-family-id={item.id}
      data-dragging={ordering?.dragged === item.id || undefined}
      data-drop-position={ordering?.dragged && dropTarget?.id === item.id ? dropTarget.after ? "after" : "before" : undefined}
      onDragOver={(event) => {
        if (!sortable || !ordering.dragged || ordering.dragged === item.id) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        setDropTarget({ id: item.id, after: event.clientY > rect.top + rect.height / 2 });
      }} onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(undefined);
      }} onDrop={(event) => {
        if (!sortable || !ordering.dragged) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        ordering.drop(item.id, event.clientY > rect.top + rect.height / 2); setDropTarget(undefined);
      }}>
      <div className="hub-plugin-entry-main">
      <a className="company-dev-hub-entry" aria-label={item.name}
        href={portalHref(item.pluginKey, "overview")} ref={index === 0 ? firstEntryRef : undefined}
        tabIndex={interactive ? 0 : -1} data-hub-entry={item.id} {...actions(item)}>
        <span className="company-dev-hub-entry-identity">
          <PluginBrandIcon pluginKey={item.pluginKey} revision={catalog.revision} />
          <span>{item.name}</span>
        </span>
        <span className="hub-plugin-version">v{item.version}</span>
      </a>
      {interactive && ordering?.enabled && <button type="button" className="hub-plugin-sort-handle" aria-label={`调整 ${item.name} 顺序`}
        title="拖动排序，或点击选择上移／下移" draggable={sortable} disabled={ordering.busy}
        onClick={(event) => openMenu?.(item, event.currentTarget)}
        onDragStart={(event) => {
          if (!sortable) { event.preventDefault(); return; }
          event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id);
          event.dataTransfer.setDragImage(event.currentTarget.closest(".company-dev-hub-entry-row")!, 24, 24);
          ordering.start(item.id);
        }} onDragEnd={() => { ordering.end(); setDropTarget(undefined); }}><GripVertical size={16} aria-hidden="true" /></button>}
      </div>
      {alternatives.length > 0 && <details className="hub-plugin-alternatives">
        <summary tabIndex={interactive ? 0 : -1}>其他来源与版本</summary>
        {alternatives.map((other) => <a key={other.pluginKey}
          aria-label={`${other.name} v${other.version} · ${other.pluginKey.split("/")[0]}`}
          href={portalHref(other.pluginKey, "overview")} tabIndex={interactive ? 0 : -1} {...actions(other)}>
          v{other.version} · {other.pluginKey.split("/")[0]}
        </a>)}
      </details>}
    </div>);
}
