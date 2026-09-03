import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { reserveLoopbackPort, startIsolatedHttpsProxy, type IsolatedHttpsProxy } from "./httpsProxy";

interface PluginListItem {
  pluginKey: string;
  id: string;
  name: string;
  version: string;
  summary: string;
}

interface PreviewCandidate {
  candidateId: string;
  pluginKey: string;
  snapshot: { plugin: { id: string; name: string; version: string } };
}

export interface TestPortal {
  baseUrl: string;
  listPlugins(): Promise<{ revision: number; items: PluginListItem[] }>;
  preview(id: string, version: string, displayName: string): Promise<PreviewCandidate>;
  promote(candidate: PreviewCandidate, revision: number): Promise<void>;
  rollback(pluginKey: string, revision: number): Promise<void>;
  snapshot(pluginKey: string): Promise<{ plugin: { version: string } }>;
  preparePlugin(id: string, version: string, displayName: string): string;
  preparePickerPlugin(version: string): void;
  pluginArchivePath: string;
  downloadArchivePath: string;
  seedPublishedDownload(fileName: string): void;
  expectedCandidateSha256: string;
  hasPublishedDownload(fileName: string): boolean;
  publishedDownloadSha256(fileName: string): string | null;
  seedUserContent(): Promise<void>;
  startReadOnly(): Promise<string>;
  startRemoteManagement(): Promise<string>;
  stop(): Promise<void>;
}

export async function startTestPortal(): Promise<TestPortal> {
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "plugin-portal-e2e-"));
  const dataRoot = join(temporaryRoot, "data");
  const pluginRoot = join(temporaryRoot, "plugins");
  const downloadRoot = join(temporaryRoot, "downloads");
  const pluginArchivePath = join(temporaryRoot, "project-delivery-hub-plugin.zip");
  const downloadArchivePath = join(temporaryRoot, "project-delivery-hub-download.zip");
  const archiveBytes = Buffer.concat([Buffer.from("PK\x05\x06", "binary"), Buffer.alloc(18), Buffer.from("portal candidate")]);
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(pluginRoot, { recursive: true });
  mkdirSync(downloadRoot, { recursive: true });
  writeFileSync(downloadArchivePath, archiveBytes);
  writeFileSync(join(downloadRoot, "project-delivery-hub-3.7.17-company-dev.zip"), archiveBytes);
  const expectedCandidateSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const pickerPluginRoot = join(pluginRoot, "picker-project-delivery-hub");
  cpSync(join(repositoryRoot, "tests", "fixtures", "plugins", "minimal"), pickerPluginRoot, { recursive: true });
  const pickerManifestPath = join(pickerPluginRoot, ".codex-plugin", "plugin.json");
  const pickerSkillContractPath = join(pickerPluginRoot, "skills", "sample-skill", "skill.contract.json");
  const preparePickerPlugin = (version: string) => {
    const pickerManifest = JSON.parse(readFileSync(pickerManifestPath, "utf8")) as Record<string, unknown>;
    pickerManifest.name = "project-delivery-hub";
    pickerManifest.version = version;
    pickerManifest.description = "研发助手插件的公开说明。";
    pickerManifest.interface = { displayName: "研发助手插件", shortDescription: "研发助手插件的公开说明。" };
    writeFileSync(pickerManifestPath, `${JSON.stringify(pickerManifest, null, 2)}\n`, "utf8");
    writeFileSync(pickerSkillContractPath, `${JSON.stringify({
      identity: { id: "sample-skill", name: "sample-skill" },
      portal: { displayName: "示例技能", category: "implementation" },
    }, null, 2)}\n`, "utf8");
    writePluginArchive(pickerPluginRoot, pluginArchivePath);
  };
  preparePickerPlugin("3.7.19");

  const server = spawn(
    process.env.PYTHON ?? "python",
    [
      "-m",
      "e2e.run_test_server",
      "--data-root",
      dataRoot,
      "--web-root",
      process.env.PORTAL_TEST_WEB_ROOT ?? join(repositoryRoot, "dist"),
      "--picker-root",
      pickerPluginRoot,
      "--archive-path",
      downloadArchivePath,
      "--download-root",
      downloadRoot,
      "--candidate-version",
      "3.7.19",
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  const lineReader = createInterface({ input: server.stdout });
  const readers: ReturnType<typeof spawn>[] = [];
  const proxies: IsolatedHttpsProxy[] = [];
  const firstLine = await Promise.race([
    new Promise<string>((resolveLine, rejectLine) => {
      lineReader.once("line", resolveLine);
      server.once("exit", (code) => rejectLine(new Error(`测试服务提前退出（${code ?? "unknown"}）`)));
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("测试服务启动超时")), 10_000)),
  ]);
  lineReader.close();
  const ready = JSON.parse(firstLine) as { port: number };
  const baseUrl = `http://127.0.0.1:${ready.port}`;
  const session = await request<{ token: string }>(baseUrl, "/api/session", { method: "POST", body: {} });

  const pluginRoots = new Map<string, string>();
  const rootFor = (id: string, version: string, displayName: string) => {
    let root = pluginRoots.get(id);
    if (!root) {
      root = join(pluginRoot, id);
      cpSync(join(repositoryRoot, "tests", "fixtures", "plugins", "minimal"), root, { recursive: true });
      pluginRoots.set(id, root);
    }
    const manifestPath = join(root, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.name = id;
    manifest.version = version;
    manifest.description = `${displayName} 的公开说明。`;
    manifest.interface = { displayName, shortDescription: `${displayName} 的公开说明。` };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return root;
  };

  const api = <T>(path: string, options?: { method?: string; body?: unknown; session?: boolean }) =>
    request<T>(baseUrl, path, {
      method: options?.method,
      body: options?.body,
      token: options?.session ? session.token : undefined,
    });

  return {
    baseUrl,
    listPlugins: () => api("/api/plugins"),
    preview: (id, version, displayName) => api("/api/plugins/import/preview", {
      method: "POST",
      session: true,
      body: {
        source: { kind: "server-directory", path: rootFor(id, version, displayName) },
        target: "company-dev",
        expectedPluginId: id,
        approvedRulePaths: ["rules/public.md"],
        extensionTools: [],
      },
    }),
    promote: async (candidate, revision) => {
      await api(`/api/plugins/${encodeURIComponent(candidate.pluginKey)}/promote`, {
        method: "POST", session: true, body: { expectedRevision: revision, candidateId: candidate.candidateId },
      });
    },
    rollback: async (pluginKey, revision) => {
      await api(`/api/plugins/${encodeURIComponent(pluginKey)}/rollback`, {
        method: "POST", session: true, body: { expectedRevision: revision },
      });
    },
    snapshot: (pluginKey) => api(`/api/plugins/${encodeURIComponent(pluginKey)}/snapshot`),
    preparePlugin: rootFor,
    preparePickerPlugin,
    pluginArchivePath,
    downloadArchivePath,
    seedPublishedDownload: (fileName) => writeFileSync(join(downloadRoot, fileName), archiveBytes),
    expectedCandidateSha256,
    hasPublishedDownload: (fileName) => existsSync(join(downloadRoot, fileName)),
    publishedDownloadSha256: (fileName) => {
      const path = join(downloadRoot, fileName);
      return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
    },
    seedUserContent: async () => {
      await api(`/api/plugins/${encodeURIComponent("company-dev/project-delivery-hub")}/prompts`, {
        method: "POST", session: true,
        body: { expectedRevision: 0, items: [{ id: "pdh", scenario: "研发 Prompt", content: "研发内容", createdAt: "2026-08-26T00:00:00Z" }] },
      });
      await api(`/api/plugins/${encodeURIComponent("company-dev/yusheng-inc")}/prompts`, {
        method: "POST", session: true,
        body: { expectedRevision: 1, items: [{ id: "ys", scenario: "昱勝 Prompt", content: "昱勝内容", createdAt: "2026-08-26T00:00:00Z" }] },
      });
      await api(`/api/plugins/${encodeURIComponent("company-dev/project-delivery-hub")}/workflows`, {
        method: "POST", session: true,
        body: {
          expectedRevision: 0,
          workflow: {
            pluginKey: "company-dev/project-delivery-hub",
            tabs: [{
              id: "installation", title: "插件安装", sections: [{
                id: "first", title: "首次安装", steps: [{
                  id: "prepare", label: "准备", title: "取得插件包", description: "", next: [],
                }],
              }],
            }],
          },
        },
      });
    },
    startReadOnly: async () => {
      const reader = spawn(process.env.PYTHON ?? "python", [
        "-m", "e2e.run_test_server", "--data-root", dataRoot,
        "--web-root", process.env.PORTAL_TEST_WEB_ROOT ?? join(repositoryRoot, "dist"),
        "--picker-root", pickerPluginRoot,
        "--archive-path", downloadArchivePath,
        "--download-root", downloadRoot,
        "--candidate-version", "3.7.19",
        "--read-only",
      ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
      readers.push(reader);
      const lines = createInterface({ input: reader.stdout });
      const readyLine = await new Promise<string>((resolveLine, rejectLine) => {
        const timeout = setTimeout(() => rejectLine(new Error("只读测试服务启动超时")), 10_000);
        lines.once("line", (line) => { clearTimeout(timeout); resolveLine(line); });
        reader.once("exit", () => { clearTimeout(timeout); rejectLine(new Error("只读测试服务提前退出")); });
      });
      lines.close();
      return `http://127.0.0.1:${(JSON.parse(readyLine) as { port: number }).port}`;
    },
    startRemoteManagement: async () => {
      const proxyPort = await reserveLoopbackPort();
      const origin = `https://127.0.0.1:${proxyPort}`;
      const reader = spawn(process.env.PYTHON ?? "python", [
        "-m", "e2e.run_test_server", "--data-root", dataRoot,
        "--web-root", process.env.PORTAL_TEST_WEB_ROOT ?? join(repositoryRoot, "dist"),
        "--picker-root", pickerPluginRoot,
        "--archive-path", downloadArchivePath,
        "--download-root", downloadRoot,
        "--candidate-version", "3.7.19",
        "--remote-management",
        "--https-origin", origin,
      ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
      readers.push(reader);
      const lines = createInterface({ input: reader.stdout });
      const readyLine = await new Promise<string>((resolveLine, rejectLine) => {
        const timeout = setTimeout(() => rejectLine(new Error("远程管理测试服务启动超时")), 10_000);
        lines.once("line", (line) => { clearTimeout(timeout); resolveLine(line); });
        reader.once("exit", (code) => {
          clearTimeout(timeout);
          rejectLine(new Error(`远程管理测试服务提前退出（${code ?? "unknown"}）`));
        });
      });
      lines.close();
      const backendPort = (JSON.parse(readyLine) as { port: number }).port;
      const proxy = await startIsolatedHttpsProxy(backendPort, proxyPort);
      proxies.push(proxy);
      return proxy.url;
    },
    stop: async () => {
      for (const proxy of proxies) await proxy.stop();
      for (const reader of readers) {
        if (reader.exitCode === null) {
          const exited = new Promise<void>((resolveExit) => reader.once("exit", () => resolveExit()));
          reader.kill();
          await exited;
        }
      }
      if (!server.killed) server.kill();
      await Promise.race([
        new Promise<void>((resolveExit) => server.once("exit", () => resolveExit())),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
      ]);
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

function writePluginArchive(pluginRoot: string, archivePath: string): void {
  const result = spawnSync(process.env.PYTHON ?? "python", [
    "-c",
    [
      "import sys, zipfile",
      "from pathlib import Path, PurePosixPath",
      "root, output = Path(sys.argv[1]), Path(sys.argv[2])",
      "with zipfile.ZipFile(output, 'w', zipfile.ZIP_STORED) as archive:",
      "    for path in sorted(root.rglob('*')):",
      "        if path.is_file():",
      "            archive.write(path, (PurePosixPath(root.name) / path.relative_to(root).as_posix()).as_posix())",
    ].join("\n"),
    pluginRoot,
    archivePath,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`无法建立测试插件 ZIP：${result.stderr || result.stdout}`);
  }
}

async function request<T>(
  baseUrl: string,
  path: string,
  options?: { method?: string; body?: unknown; token?: string },
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options?.method ?? "GET",
    headers: {
      ...(options?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options?.token ? { "X-Portal-Session": options.token } : {}),
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const value = await response.json() as T | { error?: { message?: string } };
  if (!response.ok) {
    const message = "error" in (value as object) ? (value as { error?: { message?: string } }).error?.message : undefined;
    throw new Error(message ?? `Portal 测试请求失败（${response.status}）`);
  }
  return value as T;
}
