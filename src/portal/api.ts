import type {
  DownloadCandidateSelection,
  DownloadPublicationPreview,
  DownloadPublicationReceipt,
  PluginCatalog,
  PluginDirectorySelection,
  PluginDownloadInfo,
  PluginImportCandidate,
  PluginImportConfig,
  PluginMutationReceipt,
  PluginSnapshot,
  PluginUploadReceipt,
  PortalAccess,
  PromptDocument,
  PromptItem,
  WorkflowDocument,
  WorkflowValue,
} from "./types";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
import { PortalRequestError } from "./requestState";
export { PortalRequestError } from "./requestState";

export class PortalClient {
  private sessionToken: string | undefined;
  private sessionRequest: Promise<string> | undefined;

  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  async getAccessMode(signal?: AbortSignal): Promise<PortalAccess> {
    const value = await this.request("/api/access", { signal });
    if (
      !isClosedRecord(value, ["readOnly", "fileSelectionMode"])
      || typeof value.readOnly !== "boolean"
      || !["server-picker", "browser-upload", "none"].includes(String(value.fileSelectionMode))
      || (value.readOnly ? value.fileSelectionMode !== "none" : value.fileSelectionMode === "none")
    ) {
      throw new Error("无法确认访问模式");
    }
    return value as unknown as PortalAccess;
  }

  async listPlugins(signal?: AbortSignal): Promise<PluginCatalog> {
    const value = await this.request("/api/plugins", { signal });
    if (!isPluginCatalog(value)) throw new Error("插件目录回应无效");
    return value;
  }

  async getSnapshot(pluginKey: string, signal?: AbortSignal): Promise<PluginSnapshot> {
    const value = await this.request(this.pluginUrl(pluginKey, "snapshot"), { signal });
    if (!isPluginSnapshot(value)) throw new Error("插件公开资料回应无效");
    return value;
  }

  async getDownloadInfo(pluginKey: string, signal?: AbortSignal): Promise<PluginDownloadInfo> {
    const value = await this.request(this.pluginUrl(pluginKey, "download-info"), { signal });
    if (
      !isClosedRecord(value, ["available", "version", "href"]) ||
      typeof value.available !== "boolean" ||
      !isText(value.version) ||
      (value.available
        ? !isLocalZipUrl(value.href) && value.href !== this.pluginUrl(pluginKey, "download")
        : value.href !== null)
    ) {
      throw new Error("下载资料回应无效");
    }
    return value as unknown as PluginDownloadInfo;
  }

  async previewImport(config: PluginImportConfig): Promise<PluginImportCandidate> {
    const value = await this.mutate("/api/plugins/import/preview", config, 300_000);
    if (
      !isClosedRecord(value, ["candidateId", "pluginKey", "snapshot"]) ||
      !isText(value.candidateId) ||
      !isText(value.pluginKey) ||
      !isPluginSnapshot(value.snapshot)
    ) {
      throw new Error("插件预览回应无效");
    }
    return value as unknown as PluginImportCandidate;
  }

  async selectPluginDirectory(): Promise<PluginDirectorySelection> {
    const value = await this.mutate("/api/plugins/import/select-directory", {}, 0);
    if (isClosedRecord(value, ["selected"]) && value.selected === false) {
      return { selected: false };
    }
    if (
      isClosedRecord(value, ["selected", "path"]) &&
      value.selected === true &&
      isText(value.path)
    ) {
      return { selected: true, path: value.path };
    }
    throw new Error("插件目录选择回应无效");
  }

  async uploadPluginArchive(file: File): Promise<PluginUploadReceipt> {
    const value = await this.mutateBinary("/api/uploads/plugin-import", file);
    if (
      !isClosedRecord(value, ["uploadId", "fileName", "archiveBytes"])
      || !isText(value.uploadId)
      || !isText(value.fileName)
      || !isPositiveInteger(value.archiveBytes)
    ) {
      throw new Error("插件上传回应无效");
    }
    return value as unknown as PluginUploadReceipt;
  }

  async selectDownloadCandidate(pluginKey: string): Promise<DownloadCandidateSelection> {
    const value = await this.mutate(this.pluginUrl(pluginKey, "download-publication/select"), {}, 0);
    if (isDownloadCandidateSelection(value, pluginKey)) return value;
    throw new Error("下载发布选择回应无效");
  }

  async uploadDownloadCandidate(pluginKey: string, file: File): Promise<DownloadCandidateSelection> {
    const value = await this.mutateBinary(
      this.pluginUrl(pluginKey, "download-publication/upload"),
      file,
    );
    if (isDownloadCandidateSelection(value, pluginKey) && value.selected) return value;
    throw new Error("下载发布选择回应无效");
  }

  async confirmDownloadPublication(
    pluginKey: string,
    publicationId: string,
  ): Promise<DownloadPublicationReceipt> {
    const value = await this.mutate(this.pluginUrl(pluginKey, "download-publication/confirm"), {
      publicationId,
    }, 300_000);
    if (
      !isClosedRecord(value, [
        "pluginKey",
        "version",
        "fileName",
        "candidateSha256",
        "archiveBytes",
        "publishedAtUtc",
      ]) ||
      value.pluginKey !== pluginKey ||
      ![value.version, value.fileName, value.publishedAtUtc].every(isText) ||
      !isSha256(value.candidateSha256) ||
      !isPositiveInteger(value.archiveBytes)
    ) {
      throw new PortalRequestError("下载发布确认回应无效，结果待确认", "invalid_response", 200, true);
    }
    return value as unknown as DownloadPublicationReceipt;
  }

  async promote(pluginKey: string, candidateId: string, revision: number): Promise<PluginMutationReceipt> {
    return this.mutationReceipt(await this.mutate(this.pluginUrl(pluginKey, "promote"), {
      expectedRevision: revision,
      candidateId,
    }, 300_000), pluginKey);
  }

  async rollback(pluginKey: string, revision: number): Promise<PluginMutationReceipt> {
    return this.mutationReceipt(await this.mutate(this.pluginUrl(pluginKey, "rollback"), {
      expectedRevision: revision,
    }), pluginKey);
  }

  async getPrompts(pluginKey: string, signal?: AbortSignal): Promise<PromptDocument> {
    const value = await this.request(this.pluginUrl(pluginKey, "prompts"), { signal });
    if (!isPromptDocument(value, pluginKey)) throw new Error("Prompts 回应无效");
    return value;
  }

  async savePrompts(
    pluginKey: string,
    revision: number,
    items: PromptItem[],
  ): Promise<PromptDocument> {
    const value = await this.mutate(this.pluginUrl(pluginKey, "prompts"), {
      expectedRevision: revision,
      items,
    }, 30_000, true);
    if (!isPromptDocument(value, pluginKey)) throw new PortalRequestError("Prompts 回应无效，结果待确认", "invalid_response", 200, true);
    return value;
  }

  async getWorkflows(pluginKey: string, signal?: AbortSignal): Promise<WorkflowDocument> {
    const value = await this.request(this.pluginUrl(pluginKey, "workflows"), { signal });
    if (!isWorkflowDocument(value, pluginKey)) throw new Error("流程回应无效");
    return value;
  }

  async saveWorkflows(
    pluginKey: string,
    revision: number,
    workflow: WorkflowValue,
  ): Promise<WorkflowDocument> {
    const value = await this.mutate(this.pluginUrl(pluginKey, "workflows"), {
      expectedRevision: revision,
      workflow,
    }, 30_000, true);
    if (!isWorkflowDocument(value, pluginKey)) throw new PortalRequestError("流程回应无效，结果待确认", "invalid_response", 200, true);
    return value;
  }

  private pluginUrl(pluginKey: string, resource: string): string {
    return `/api/plugins/${encodeURIComponent(pluginKey)}/${resource}`;
  }

  private async mutate(path: string, body: unknown, timeout = 30_000, renewSession = false): Promise<unknown> {
    const frozen = JSON.stringify(body);
    return this.sendMutation(path, frozen, timeout, renewSession);
  }

  private async sendMutation(path: string, body: string, timeout: number, renewSession: boolean): Promise<unknown> {
    const token = await this.getSessionToken();
    try {
      return await this.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Portal-Session": token },
        body,
      }, timeout);
    } catch (error) {
      if (error instanceof PortalRequestError && error.status === 401 && error.code === "invalid_session") {
        if (this.sessionToken === token) this.sessionToken = undefined;
        if (renewSession) return this.sendMutation(path, body, timeout, false);
      }
      throw error;
    }
  }

  private async mutateBinary(path: string, file: File): Promise<unknown> {
    const token = await this.getSessionToken();
    try { return await this.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "X-Portal-Session": token,
      },
      body: file,
    }, 300_000); } catch (error) {
      if (error instanceof PortalRequestError && error.status === 401 && error.code === "invalid_session" && this.sessionToken === token) this.sessionToken = undefined;
      throw error;
    }
  }

  private async getSessionToken(): Promise<string> {
    if (this.sessionToken) return this.sessionToken;
    if (this.sessionRequest) return this.sessionRequest;
    this.sessionRequest = this.createSession();
    try { return await this.sessionRequest; } finally { this.sessionRequest = undefined; }
  }

  private async createSession(): Promise<string> {
    const value = await this.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!isClosedRecord(value, ["token"]) || !isText(value.token)) {
      throw new Error("Portal 会话回应无效");
    }
    this.sessionToken = value.token;
    return value.token;
  }

  private async request(path: string, init?: RequestInit, timeout = 15_000): Promise<unknown> {
    const controller = new AbortController();
    const write = init?.method === "POST" && path !== "/api/session";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectAbort: (reason: unknown) => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const cancel = () => {
      controller.abort();
      rejectAbort(new PortalRequestError("请求已取消", "request_aborted", undefined, write));
    };
    init?.signal?.addEventListener("abort", cancel, { once: true });
    if (init?.signal?.aborted) cancel();
    if (timeout > 0) timer = setTimeout(() => {
      rejectAbort(new PortalRequestError(write ? "请求超时，结果待确认" : "读取超时，请重试", "request_timeout", undefined, write));
      controller.abort();
    }, timeout);
    try {
      const operation = async () => {
        if (controller.signal.aborted) return aborted;
        const response = await this.fetcher(path, { ...init, signal: controller.signal });
        let value: unknown;
        try { value = await response.json(); } catch {
          throw new PortalRequestError("Portal 回应不是有效 JSON", "invalid_response", response.status, write);
        }
        if (!response.ok) {
          const detail = readApiError(value);
          throw new PortalRequestError(detail?.message ?? `Portal 请求失败（${response.status}）`, detail?.code ?? "http_error", response.status, write && !detail);
        }
        return value;
      };
      return await Promise.race([operation(), aborted]);
    } catch (error) {
      if (error instanceof PortalRequestError) throw error;
      throw new PortalRequestError(write ? "连接中断，结果待确认" : "无法连接 Portal，请重试", "network_error", undefined, write);
    } finally {
      clearTimeout(timer);
      init?.signal?.removeEventListener("abort", cancel);
    }
  }

  private mutationReceipt(value: unknown, pluginKey: string): PluginMutationReceipt {
    if (
      !isClosedRecord(value, ["revision", "pluginKey", "snapshotId"]) ||
      !isRevision(value.revision) ||
      value.pluginKey !== pluginKey ||
      !isText(value.snapshotId)
    ) {
      throw new PortalRequestError("插件变更回应无效，结果待确认", "invalid_response", 200, true);
    }
    return value as unknown as PluginMutationReceipt;
  }
}

function readApiError(value: unknown): { code: string; message: string } | undefined {
  if (!isClosedRecord(value, ["error"]) || !isClosedRecord(value.error, ["code", "message"])) {
    return undefined;
  }
  return isText(value.error.message) && isText(value.error.code) ? { code: value.error.code, message: value.error.message } : undefined;
}

function isPluginCatalog(value: unknown): value is PluginCatalog {
  return (
    isClosedRecord(value, ["revision", "items"]) &&
    isRevision(value.revision) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        isClosedRecord(item, ["pluginKey", "id", "name", "version", "summary"]) &&
        [item.pluginKey, item.id, item.name, item.version, item.summary].every(isText),
    )
  );
}

function isDownloadPublicationPreview(
  value: unknown,
  pluginKey: string,
): value is DownloadPublicationPreview {
  return (
    isClosedRecord(value, [
      "pluginKey",
      "version",
      "fileName",
      "destinationFileName",
      "candidateSha256",
      "fileSetSha256",
      "fileCount",
      "archiveBytes",
      "auditToolVersion",
      "warnings",
    ]) &&
    value.pluginKey === pluginKey &&
    [value.version, value.fileName, value.destinationFileName, value.auditToolVersion].every(isText) &&
    String(value.fileName).toLowerCase().endsWith(".zip") &&
    String(value.destinationFileName).toLowerCase().endsWith(".zip") &&
    isSha256(value.candidateSha256) &&
    isSha256(value.fileSetSha256) &&
    isNonNegativeInteger(value.fileCount) &&
    isPositiveInteger(value.archiveBytes) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isText)
  );
}

function isDownloadCandidateSelection(
  value: unknown,
  pluginKey: string,
): value is DownloadCandidateSelection {
  if (isClosedRecord(value, ["selected"]) && value.selected === false) return true;
  return (
    isClosedRecord(value, ["selected", "publicationId", "preview"])
    && value.selected === true
    && isText(value.publicationId)
    && isDownloadPublicationPreview(value.preview, pluginKey)
  );
}

function isPluginSnapshot(value: unknown): value is PluginSnapshot {
  if (
    !isClosedRecord(value, [
      "schemaVersion",
      "plugin",
      "skills",
      "mcp",
      "extensionTools",
      "engineeringRules",
      "provenance",
    ]) ||
    value.schemaVersion !== "1.0.0" ||
    !isClosedRecord(value.plugin, ["target", "id", "name", "version", "summary"]) ||
    ![value.plugin.target, value.plugin.id, value.plugin.name, value.plugin.version, value.plugin.summary].every(isText) ||
    !isClosedRecord(value.provenance, ["packageDigest", "adapterVersion", "importedAt"]) ||
    ![value.provenance.packageDigest, value.provenance.adapterVersion, value.provenance.importedAt].every(isText)
  ) {
    return false;
  }
  return (
    Array.isArray(value.skills) &&
    value.skills.every(isSkillSummary) &&
    Array.isArray(value.mcp) &&
    value.mcp.every(isMcpSummary) &&
    isClosedArray(value.extensionTools, ["id", "name", "purpose", "url"]) &&
    isClosedArray(value.engineeringRules, ["path", "bodyMarkdown"])
  );
}

function isSkillSummary(value: unknown): boolean {
  if (isClosedRecord(value, ["id", "name", "description"])) {
    return [value.id, value.name, value.description].every(isText);
  }
  return (
    isClosedRecord(value, ["id", "name", "description", "category"]) &&
    [value.id, value.name, value.description, value.category].every(isText)
  );
}

function isMcpSummary(value: unknown): boolean {
  if (isClosedRecord(value, ["id"])) return isText(value.id);
  return (
    isClosedRecord(value, ["id", "name", "purpose", "capabilities", "writeEnabled"]) &&
    [value.id, value.name, value.purpose].every(isText) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.length > 0 &&
    value.capabilities.every(isText) &&
    new Set(value.capabilities).size === value.capabilities.length &&
    typeof value.writeEnabled === "boolean"
  );
}

function isPromptDocument(value: unknown, pluginKey: string): value is PromptDocument {
  return (
    isClosedRecord(value, ["revision", "pluginKey", "items"]) &&
    isRevision(value.revision) &&
    value.pluginKey === pluginKey &&
    isClosedArray(value.items, ["id", "scenario", "content", "createdAt"])
  );
}

function isWorkflowDocument(value: unknown, pluginKey: string): value is WorkflowDocument {
  if (
    !isClosedRecord(value, ["revision", "pluginKey", "tabs"]) ||
    !isRevision(value.revision) ||
    value.pluginKey !== pluginKey ||
    !Array.isArray(value.tabs)
  ) {
    return false;
  }
  return value.tabs.every(
    (tab) =>
      isClosedRecord(tab, ["id", "title", "sections"]) &&
      isText(tab.id) &&
      isText(tab.title) &&
      Array.isArray(tab.sections) &&
      tab.sections.every(
        (section) =>
          isClosedRecord(section, ["id", "title", "steps"]) &&
          isText(section.id) &&
          isText(section.title) &&
          Array.isArray(section.steps) &&
          section.steps.every(
            (step) =>
              isClosedRecord(step, ["id", "label", "title", "description", "next"]) &&
              [step.id, step.label, step.title, step.description].every((item) => typeof item === "string") &&
              Array.isArray(step.next) &&
              step.next.every(isText),
          ),
      ),
  );
}

function isClosedArray(value: unknown, fields: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isClosedRecord(item, fields) &&
        fields.every((field) => isText(item[field])),
    )
  );
}

function isClosedRecord(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
}

function isRevision(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isLocalZipUrl(value: unknown): value is string {
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port === "9134" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.startsWith("/downloads/") &&
      url.pathname.endsWith(".zip")
    );
  } catch {
    return false;
  }
}
