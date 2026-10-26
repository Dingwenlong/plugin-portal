export type ContentKind = "mcp" | "releases";
export interface McpTool { id: string; name: string; purpose: string; scenarios: string[] }
export interface McpContent {
  schemaVersion: "1.0.0"; documentType: "mcp"; pluginKey: string; pluginVersion: string;
  services: { id: string; name: string; tools: McpTool[] }[];
}
export interface ReleaseContent {
  schemaVersion: "1.0.0"; documentType: "releases"; pluginKey: string;
  releases: { version: string; releasedAt: string | null; summary: string;
    changes: { type: "added" | "changed" | "fixed" | "removed"; text: string }[] }[];
}
export type ContentValue = McpContent | ReleaseContent;
export interface ContentDocument { revision: number; pluginKey: string; documentType: ContentKind; document: ContentValue | null }
export interface ContentPreview {
  candidateId: string; revision: number; document: ContentValue;
  diff: { added: number; changed: number; removed: number; items: { type: "added" | "changed" | "removed"; label: string }[] };
}
export interface ContentDataClient {
  getContent(pluginKey: string, kind: ContentKind, signal?: AbortSignal): Promise<ContentDocument>;
  previewContent(pluginKey: string, kind: ContentKind, document: unknown): Promise<ContentPreview>;
  confirmContent(pluginKey: string, kind: ContentKind, preview: ContentPreview): Promise<ContentDocument>;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
export function isContentValue(value: unknown, key: string, kind: ContentKind): value is ContentValue {
  if (!record(value) || value.schemaVersion !== "1.0.0" || value.pluginKey !== key || value.documentType !== kind) return false;
  if (kind === "mcp") return text(value.pluginVersion) && Array.isArray(value.services) && value.services.every(s =>
    record(s) && text(s.id) && text(s.name) && Array.isArray(s.tools) && s.tools.every(t => record(t)
      && text(t.id) && text(t.name) && text(t.purpose) && Array.isArray(t.scenarios) && t.scenarios.every(text)));
  return Array.isArray(value.releases) && value.releases.every(r => record(r) && text(r.version)
    && (r.releasedAt === null || text(r.releasedAt)) && text(r.summary) && Array.isArray(r.changes)
    && r.changes.every(c => record(c) && typeof c.type === "string" && ["added", "changed", "fixed", "removed"].includes(c.type) && text(c.text)));
}
export function isContentDocument(value: unknown, key: string, kind: ContentKind): value is ContentDocument {
  return record(value) && Number.isInteger(value.revision) && Number(value.revision) >= 0 && value.pluginKey === key
    && value.documentType === kind && (value.document === null || isContentValue(value.document, key, kind));
}
export function isContentPreview(value: unknown, key: string, kind: ContentKind): value is ContentPreview {
  return record(value) && text(value.candidateId) && Number.isInteger(value.revision) && Number(value.revision) >= 0
    && isContentValue(value.document, key, kind) && record(value.diff)
    && [value.diff.added, value.diff.changed, value.diff.removed].every(n => Number.isInteger(n) && Number(n) >= 0)
    && Array.isArray(value.diff.items) && value.diff.items.every(i => record(i) && text(i.label)
      && typeof i.type === "string" && ["added", "changed", "removed"].includes(i.type));
}
