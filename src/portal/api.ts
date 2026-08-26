import type {
  PluginCatalog,
  PluginDirectorySelection,
  PluginDownloadInfo,
  PluginImportCandidate,
  PluginImportConfig,
  PluginMutationReceipt,
  PluginSnapshot,
  PromptDocument,
  PromptItem,
  WorkflowDocument,
  WorkflowValue,
} from "./types";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class PortalClient {
  private sessionToken: string | undefined;

  constructor(private readonly fetcher: Fetcher = (input, init) => fetch(input, init)) {}

  async listPlugins(): Promise<PluginCatalog> {
    const value = await this.request("/api/plugins");
    if (!isPluginCatalog(value)) throw new Error("插件目录回应无效");
    return value;
  }

  async getSnapshot(pluginKey: string): Promise<PluginSnapshot> {
    const value = await this.request(this.pluginUrl(pluginKey, "snapshot"));
    if (!isPluginSnapshot(value)) throw new Error("插件公开资料回应无效");
    return value;
  }

  async getDownloadInfo(pluginKey: string): Promise<PluginDownloadInfo> {
    const value = await this.request(this.pluginUrl(pluginKey, "download-info"));
    if (
      !isClosedRecord(value, ["available", "version", "href"]) ||
      typeof value.available !== "boolean" ||
      !isText(value.version) ||
      (value.available
        ? !isLocalZipUrl(value.href)
        : value.href !== null)
    ) {
      throw new Error("下载资料回应无效");
    }
    return value as unknown as PluginDownloadInfo;
  }

  async previewImport(config: PluginImportConfig): Promise<PluginImportCandidate> {
    const value = await this.mutate("/api/plugins/import/preview", config);
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
    const value = await this.mutate("/api/plugins/import/select-directory", {});
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

  async promote(pluginKey: string, candidateId: string, revision: number): Promise<PluginMutationReceipt> {
    return this.mutationReceipt(await this.mutate(this.pluginUrl(pluginKey, "promote"), {
      expectedRevision: revision,
      candidateId,
    }), pluginKey);
  }

  async rollback(pluginKey: string, revision: number): Promise<PluginMutationReceipt> {
    return this.mutationReceipt(await this.mutate(this.pluginUrl(pluginKey, "rollback"), {
      expectedRevision: revision,
    }), pluginKey);
  }

  async getPrompts(pluginKey: string): Promise<PromptDocument> {
    const value = await this.request(this.pluginUrl(pluginKey, "prompts"));
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
    });
    if (!isPromptDocument(value, pluginKey)) throw new Error("Prompts 回应无效");
    return value;
  }

  async getWorkflows(pluginKey: string): Promise<WorkflowDocument> {
    const value = await this.request(this.pluginUrl(pluginKey, "workflows"));
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
    });
    if (!isWorkflowDocument(value, pluginKey)) throw new Error("流程回应无效");
    return value;
  }

  private pluginUrl(pluginKey: string, resource: string): string {
    return `/api/plugins/${encodeURIComponent(pluginKey)}/${resource}`;
  }

  private async mutate(path: string, body: unknown): Promise<unknown> {
    const token = await this.getSessionToken();
    return this.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Portal-Session": token },
      body: JSON.stringify(body),
    });
  }

  private async getSessionToken(): Promise<string> {
    if (this.sessionToken) return this.sessionToken;
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

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetcher(path, init);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Error("Portal 回应不是有效 JSON");
    }
    if (!response.ok) {
      const message = readApiError(value);
      throw new Error(message ?? `Portal 请求失败（${response.status}）`);
    }
    return value;
  }

  private mutationReceipt(value: unknown, pluginKey: string): PluginMutationReceipt {
    if (
      !isClosedRecord(value, ["revision", "pluginKey", "snapshotId"]) ||
      !isRevision(value.revision) ||
      value.pluginKey !== pluginKey ||
      !isText(value.snapshotId)
    ) {
      throw new Error("插件变更回应无效");
    }
    return value as unknown as PluginMutationReceipt;
  }
}

function readApiError(value: unknown): string | undefined {
  if (!isClosedRecord(value, ["error"]) || !isClosedRecord(value.error, ["code", "message"])) {
    return undefined;
  }
  return isText(value.error.message) ? value.error.message : undefined;
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
    isClosedArray(value.skills, ["id", "name", "description"]) &&
    isClosedArray(value.mcp, ["id"]) &&
    isClosedArray(value.extensionTools, ["id", "name", "purpose", "url"]) &&
    isClosedArray(value.engineeringRules, ["path", "bodyMarkdown"])
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
