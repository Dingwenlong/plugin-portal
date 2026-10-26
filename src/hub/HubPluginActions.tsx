import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { PortalModal } from "../portal/PortalModal";
import type { PluginManagementClient } from "../portal/PluginManager";
import type { PluginCatalog, PluginListItem } from "../portal/types";
import { errorMessage, sameContent } from "../portal/requestState";
import { useSaveRecovery } from "../portal/useSaveRecovery";
import { groupCatalogPlugins } from "../portal/catalogIdentity";
import "./hubPluginActions.css";

type OpenMenu = (plugin: PluginListItem, anchor: HTMLElement, position?: { x: number; y: number }) => void;
const PluginMenuContext = createContext<OpenMenu | undefined>(undefined);
export const usePluginMenu = () => useContext(PluginMenuContext);
interface Ordering {
  enabled: boolean;
  busy: boolean;
  dragged?: string;
  start: (id: string) => void;
  end: () => void;
  drop: (target: string, after: boolean) => void;
}
const PluginOrderingContext = createContext<Ordering | undefined>(undefined);
export const usePluginOrdering = () => useContext(PluginOrderingContext);

interface Selection {
  plugin: PluginListItem;
  revision: number;
  position: { x: number; y: number };
}

function PluginContextMenu({ selection, onDelete, onDismiss, onMove, canMoveUp, canMoveDown }: {
  selection: Selection;
  onDelete: () => void;
  onDismiss: (restoreFocus: boolean) => void;
  onMove?: (offset: number) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const [position, setPosition] = useState(selection.position);

  useLayoutEffect(() => {
    const rect = menuRef.current!.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8)),
    });
    buttonRef.current?.focus();
  }, [selection]);

  useEffect(() => {
    const outside = (event: Event) => {
      if (!event.defaultPrevented && !menuRef.current?.contains(event.target as Node)) dismissRef.current(false);
    };
    const moved = () => dismissRef.current(true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("contextmenu", outside);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("contextmenu", outside);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, []);

  return <div ref={menuRef} className="hub-plugin-context-menu" role="menu" aria-label={`${selection.plugin.name}操作`}
    style={{ left: position.x, top: position.y }} onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (["Escape", "Tab"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); onDismiss(true);
      } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
    {onMove && <>
      <button type="button" role="menuitem" disabled={!canMoveUp} onClick={() => onMove(-1)}><ArrowUp size={16} aria-hidden="true" />上移</button>
      <button type="button" role="menuitem" disabled={!canMoveDown} onClick={() => onMove(1)}><ArrowDown size={16} aria-hidden="true" />下移</button>
    </>}
    <button ref={buttonRef} className="hub-plugin-delete-action" type="button" role="menuitem" onClick={onDelete}>
      <Trash2 size={16} aria-hidden="true" />删除
    </button>
  </div>;
}

function PluginRemovalDialog({ selection, client, onCatalogChanged, onClose, returnFocusRef }: {
  selection: Selection;
  client: PluginManagementClient;
  onCatalogChanged: () => Promise<void>;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [removed, setRemoved] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const alive = useRef(true);
  const refreshLock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const save = useSaveRecovery<{ pluginKey: string; revision: number }>(async (attempt) => {
    const latest = await client.listPlugins!();
    return latest.revision > attempt.revision && !latest.items.some((item) => item.pluginKey === attempt.pluginKey);
  }, () => setRemoved(true));

  const refreshAndClose = async () => {
    if (refreshLock.current) return;
    refreshLock.current = true;
    setRefreshing(true); setRefreshError("");
    try {
      await onCatalogChanged();
      // Let the refreshed entries mount before choosing a focus target.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (alive.current) onClose();
    } catch (error) {
      if (alive.current) setRefreshError(`列表刷新失败：${errorMessage(error)}`);
    } finally {
      refreshLock.current = false;
      if (alive.current) setRefreshing(false);
    }
  };
  useEffect(() => { if (removed) void refreshAndClose(); }, [removed]);
  const busy = save.busy || refreshing;

  return <PortalModal title="删除插件" onClose={onClose} busy={busy} returnFocusRef={returnFocusRef}>
    <div className="hub-plugin-removal">
      <p>将从 Portal 删除以下插件条目：</p>
      <div className="hub-plugin-removal-identity">
        <strong>{selection.plugin.name}</strong><span>v{selection.plugin.version}</span>
        <span>{selection.plugin.pluginKey}</span>
      </div>
      <p>仅删除选中的来源。插件包、流程、图片及已上传内容会保留，重新纳入后可继续使用。</p>
      {removed && <p role="status">已删除插件条目。</p>}
      {save.pending ? <p role="alert">删除结果待确认。请核对列表，暂时不要重复删除。</p>
        : save.error && <p role="alert">{save.conflict ? "插件列表已更新，请刷新列表后重新选择要删除的插件。" : save.error}</p>}
      {refreshError && <p role="alert">{refreshError}</p>}
      <div className="hub-plugin-removal-actions">
        <button type="button" data-autofocus disabled={busy} onClick={onClose}>{removed || save.pending ? "关闭" : "取消"}</button>
        {removed || save.conflict ? <button type="button" disabled={busy} onClick={() => void refreshAndClose()}>
          {refreshing ? "正在刷新…" : "刷新列表并关闭"}
        </button> : save.pending ? <button type="button" disabled={busy} onClick={() => void save.check()}>
          {busy ? "正在核对…" : "核对删除结果"}
        </button> : <button type="button" className="hub-plugin-delete-confirm" disabled={busy}
          onClick={() => void save.run({ pluginKey: selection.plugin.pluginKey, revision: selection.revision },
            (attempt) => client.removePlugin!(attempt.pluginKey, attempt.revision))}>
          {busy ? "正在删除…" : "确认删除"}
        </button>}
      </div>
    </div>
  </PortalModal>;
}

export function HubPluginActions({ catalog, client, enabled, onCatalogChanged, children }: {
  catalog: PluginCatalog;
  client: PluginManagementClient;
  enabled: boolean;
  onCatalogChanged: () => Promise<void>;
  children: ReactNode;
}) {
  const [selection, setSelection] = useState<Selection>();
  const [confirming, setConfirming] = useState(false);
  const [dragged, setDragged] = useState<string>();
  const dragAttempt = useRef<{ id: string; revision: number; ids: string[] } | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const refreshLock = useRef(false);
  const origin = useRef<HTMLElement | null>(null);
  const allowed = enabled && Boolean(client.removePlugin && client.listPlugins);
  const ids = groupCatalogPlugins(catalog.items).map(([item]) => item.id);
  const save = useSaveRecovery<{ ids: string[]; revision: number }>(async (attempt) => {
    const latest = await client.listPlugins!();
    return latest.revision > attempt.revision && sameContent(groupCatalogPlugins(latest.items).map(([item]) => item.id), attempt.ids);
  }, () => setSaved(true));
  const orderBusy = save.busy || save.pending || refreshing || saved || save.conflict || Boolean(refreshError);
  const orderEnabled = enabled && !confirming && Boolean(client.reorderPlugins && client.listPlugins);
  const refreshOrder = async () => {
    if (refreshLock.current) return;
    refreshLock.current = true; setRefreshing(true); setRefreshError("");
    try { await onCatalogChanged(); setSaved(false); save.resetError(); }
    catch (reason) { setRefreshError(`列表刷新失败：${errorMessage(reason)}`); }
    finally { refreshLock.current = false; setRefreshing(false); }
  };
  useEffect(() => { if (saved) void refreshOrder(); }, [saved]);
  const persistOrder = (next: string[], revision: number) => {
    if (!orderEnabled || orderBusy || sameContent(ids, next)) return;
    setRefreshError("");
    void save.run({ ids: next, revision }, (attempt) => client.reorderPlugins!(attempt.ids, attempt.revision));
  };
  const endDrag = () => { dragAttempt.current = undefined; setDragged(undefined); };
  useEffect(() => { if (!orderEnabled || orderBusy) endDrag(); }, [orderEnabled, orderBusy]);
  const ordering: Ordering = {
    enabled: orderEnabled, busy: orderBusy, dragged,
    start: (id) => {
      if (!orderEnabled || orderBusy) return;
      setSelection(undefined); dragAttempt.current = { id, ids: [...ids], revision: catalog.revision }; setDragged(id);
    },
    end: endDrag,
    drop: (target, after) => {
      const attempt = dragAttempt.current;
      endDrag();
      if (!attempt || attempt.id === target || !attempt.ids.includes(target)) return;
      const next = attempt.ids.filter((id) => id !== attempt.id);
      next.splice(next.indexOf(target) + (after ? 1 : 0), 0, attempt.id);
      persistOrder(next, attempt.revision);
    },
  };
  const restoreTarget = () => {
    if (!origin.current?.isConnected) origin.current = document.querySelector<HTMLElement>(".company-dev-hub-entry")
      ?? document.querySelector<HTMLElement>('button[aria-label="纳入插件"]');
  };
  const close = () => { restoreTarget(); setSelection(undefined); setConfirming(false); };
  const open: OpenMenu = (plugin, anchor, position) => {
    if (!allowed || confirming || orderBusy) return;
    const rect = anchor.getBoundingClientRect();
    origin.current = anchor;
    setSelection({ plugin: { ...plugin }, revision: catalog.revision, position: position ?? { x: rect.left + 12, y: rect.bottom - 4 } });
  };
  useEffect(() => { if (!allowed) close(); }, [allowed]);

  return <PluginOrderingContext.Provider value={ordering}><PluginMenuContext.Provider value={allowed && !orderBusy ? open : undefined}>
    {children}
    {(save.busy || save.pending || save.error || refreshing || refreshError) && <div className="hub-plugin-order-feedback" role="status">
      {save.pending ? <><p>排序结果待确认，请先核对，避免重复提交。</p><button type="button" disabled={save.busy} onClick={() => void save.check()}>核对排序结果</button></>
        : save.conflict ? <><p>列表已变化，请刷新后重新调整顺序。</p><button type="button" disabled={refreshing} onClick={() => void refreshOrder()}>刷新列表</button></>
        : <p>{refreshError || save.error || (refreshing ? "正在刷新插件顺序…" : "正在保存插件顺序…")}</p>}
      {refreshError && !save.conflict && <button type="button" disabled={refreshing} onClick={() => void refreshOrder()}>刷新列表</button>}
    </div>}
    {allowed && selection && (confirming
      ? <PluginRemovalDialog selection={selection} client={client} onCatalogChanged={onCatalogChanged} onClose={close} returnFocusRef={origin} />
      : <PluginContextMenu selection={selection} onDelete={() => setConfirming(true)}
        canMoveUp={ids.indexOf(selection.plugin.id) > 0} canMoveDown={ids.indexOf(selection.plugin.id) < ids.length - 1}
        onMove={orderEnabled && !orderBusy ? (offset) => {
          const index = ids.indexOf(selection.plugin.id);
          const next = [...ids];
          if (index < 0 || index + offset < 0 || index + offset >= next.length) return;
          [next[index], next[index + offset]] = [next[index + offset], next[index]];
          close(); origin.current?.focus(); persistOrder(next, selection.revision);
        } : undefined} onDismiss={(restoreFocus) => {
          close();
          if (restoreFocus) origin.current?.focus();
        }} />)}
  </PluginMenuContext.Provider></PluginOrderingContext.Provider>;
}
