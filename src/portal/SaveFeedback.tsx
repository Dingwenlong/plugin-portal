import { useState } from "react";
import { errorMessage } from "./requestState";

export function SaveFeedback<T>({ recovery, draft, readLatest, applyLatest }: {
  recovery: { busy: boolean; error: string; pending: boolean; conflict: boolean; check: () => Promise<void> };
  draft: unknown;
  readLatest?: () => Promise<T>;
  applyLatest?: (value: T) => void;
}) {
  const [latest, setLatest] = useState<T>();
  const [notice, setNotice] = useState("");
  const [reading, setReading] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  return <>
    {recovery.busy && <p role="status">{recovery.pending ? "正在核对保存结果…" : "正在保存…"}</p>}
    {recovery.error && <p role="alert">{recovery.error}</p>}
    {recovery.pending && <button disabled={recovery.busy} onClick={() => void recovery.check()} type="button">核对保存结果</button>}
    {(recovery.conflict || recovery.pending) && <div className="portal-resource-notice">
      <p>{recovery.conflict ? "其他人已更新内容。本地草稿仍保留，不会自动覆盖。" : "本次提交内容已保留。核对完成前不会重新提交。"}</p>
      <button disabled={recovery.busy} onClick={async () => {
        try { await navigator.clipboard.writeText(JSON.stringify(draft, null, 2)); setNotice("草稿已复制"); }
        catch { setNotice("无法复制，请先手动保存草稿。"); }
      }} type="button">复制草稿</button>
      {readLatest && <button disabled={reading || recovery.busy} onClick={async () => {
        setReading(true);
        try { setLatest(await readLatest()); } catch (error) { setNotice(errorMessage(error)); }
        finally { setReading(false); }
      }} type="button">查看最新内容</button>}
      {latest !== undefined && <><pre className="portal-latest-content">{JSON.stringify(latest, null, 2)}</pre>{applyLatest && !recovery.pending && <button disabled={recovery.busy} onClick={() => setConfirmReplace(true)} type="button">载入最新版本</button>}
        {confirmReplace && <div role="alert"><p>载入会更新保存基准；流程草稿会被替换。请先复制需要保留的草稿。</p>
          <button disabled={recovery.busy} onClick={() => setConfirmReplace(false)} type="button">保留草稿</button>
          <button disabled={recovery.busy} onClick={() => {
            try { applyLatest?.(latest); setLatest(undefined); setNotice("已载入最新版本，请重新检查后保存。"); }
            catch (error) { setNotice(errorMessage(error)); }
            setConfirmReplace(false);
          }} type="button">确认载入</button>
        </div>}
      </>}
    </div>}
    {notice && <p role="status">{notice}</p>}
  </>;
}
