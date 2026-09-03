import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedHttpsProxy {
  url: string;
  stop(): Promise<void>;
}

export async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配 HTTPS 测试端口"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function startIsolatedHttpsProxy(
  backendPort: number,
  proxyPort: number,
): Promise<IsolatedHttpsProxy> {
  const executable = process.env.PORTAL_CADDY_PATH;
  if (!executable) throw new Error("PORTAL_CADDY_PATH 未指向隔离测试使用的 Caddy");

  const root = mkdtempSync(join(tmpdir(), "plugin-portal-caddy-e2e-"));
  const storageRoot = join(root, "storage");
  const configPath = join(root, "Caddyfile");
  mkdirSync(storageRoot, { recursive: true });
  const caddyPath = (value: string) => value.replaceAll("\\", "/").replaceAll('"', '\\"');
  writeFileSync(configPath, `{
  admin off
  auto_https disable_redirects
  skip_install_trust
  storage file_system {
    root "${caddyPath(storageRoot)}"
  }
}

https://127.0.0.1:${proxyPort} {
  tls internal
  reverse_proxy 127.0.0.1:${backendPort}
}
`, "utf8");

  const child = spawn(executable, ["run", "--config", configPath, "--adapter", "caddyfile"], {
    stdio: ["ignore", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const output: string[] = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitUntilReady(child, proxyPort, output);
  } catch (error) {
    await stopChild(child);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  let stopped = false;
  return {
    url: `https://127.0.0.1:${proxyPort}`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await stopChild(child);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function waitUntilReady(
  child: ChildProcessWithoutNullStreams,
  port: number,
  output: string[],
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`隔离 Caddy 提前退出（${child.exitCode}）：${output.join("").slice(-2_000)}`);
    }
    if (await probe(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`隔离 Caddy 启动超时：${output.join("").slice(-2_000)}`);
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probeRequest = request({
      host: "127.0.0.1",
      port,
      path: "/api/access",
      method: "GET",
      rejectUnauthorized: false,
      timeout: 1_000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode === 200));
    });
    probeRequest.once("error", () => resolve(false));
    probeRequest.once("timeout", () => {
      probeRequest.destroy();
      resolve(false);
    });
    probeRequest.end();
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const signalled = child.kill();
  if (!signalled) return;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null && child.pid) {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return;
    }
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }
}
