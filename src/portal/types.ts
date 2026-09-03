export interface PluginListItem {
  pluginKey: string;
  id: string;
  name: string;
  version: string;
  summary: string;
}

export interface PluginCatalog {
  revision: number;
  items: PluginListItem[];
}

export type FileSelectionMode = "server-picker" | "browser-upload" | "none";

export interface PortalAccess {
  readOnly: boolean;
  fileSelectionMode: FileSelectionMode;
}

export interface PluginDownloadInfo {
  available: boolean;
  version: string;
  href: string | null;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category?: string;
}

export type McpSummary =
  | { id: string }
  | {
      id: string;
      name: string;
      purpose: string;
      capabilities: string[];
      writeEnabled: boolean;
    };

export interface ExtensionTool {
  id: string;
  name: string;
  purpose: string;
  url: string;
}

export interface EngineeringRule {
  path: string;
  bodyMarkdown: string;
}

export interface PluginSnapshot {
  schemaVersion: "1.0.0";
  plugin: {
    target: string;
    id: string;
    name: string;
    version: string;
    summary: string;
  };
  skills: SkillSummary[];
  mcp: McpSummary[];
  extensionTools: ExtensionTool[];
  engineeringRules: EngineeringRule[];
  provenance: {
    packageDigest: string;
    adapterVersion: string;
    importedAt: string;
  };
}

export interface PromptItem {
  id: string;
  scenario: string;
  content: string;
  createdAt: string;
}

export interface PromptDocument {
  revision: number;
  pluginKey: string;
  items: PromptItem[];
}

export interface WorkflowStep {
  id: string;
  label: string;
  title: string;
  description: string;
  next: string[];
}

export interface WorkflowSection {
  id: string;
  title: string;
  steps: WorkflowStep[];
}

export interface WorkflowTab {
  id: string;
  title: string;
  sections: WorkflowSection[];
}

export interface WorkflowValue {
  pluginKey: string;
  tabs: WorkflowTab[];
}

export interface WorkflowDocument extends WorkflowValue {
  revision: number;
}

export type PluginImportSource =
  | { kind: "server-directory"; path: string }
  | { kind: "upload"; uploadId: string };

export interface PluginImportConfig {
  source: PluginImportSource;
  target: string;
  expectedPluginId: string;
  approvedRulePaths: string[];
  extensionTools: ExtensionTool[];
}

export interface PluginUploadReceipt {
  uploadId: string;
  fileName: string;
  archiveBytes: number;
}

export type PluginDirectorySelection =
  | { selected: false }
  | { selected: true; path: string };

export interface PluginImportCandidate {
  candidateId: string;
  pluginKey: string;
  snapshot: PluginSnapshot;
}

export interface PluginMutationReceipt {
  revision: number;
  pluginKey: string;
  snapshotId: string;
}

export interface DownloadPublicationPreview {
  pluginKey: string;
  version: string;
  fileName: string;
  destinationFileName: string;
  candidateSha256: string;
  fileSetSha256: string;
  fileCount: number;
  archiveBytes: number;
  auditToolVersion: string;
  warnings: string[];
}

export type DownloadCandidateSelection =
  | { selected: false }
  | {
      selected: true;
      publicationId: string;
      preview: DownloadPublicationPreview;
    };

export interface DownloadPublicationReceipt {
  pluginKey: string;
  version: string;
  fileName: string;
  candidateSha256: string;
  archiveBytes: number;
  publishedAtUtc: string;
}
