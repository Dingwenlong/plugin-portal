import type { PluginListItem } from "./types";

// SemVer precedence; build metadata does not change version precedence.
export function compareVersion(left: string, right: string): number {
  const valid = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (!valid.test(left) || !valid.test(right)) return valid.test(left) ? 1 : valid.test(right) ? -1 : left.localeCompare(right);
  const parts = (value: string) => value.split("+", 1)[0].split(/-(.*)/s);
  const [leftCore, leftPre] = parts(left);
  const [rightCore, rightPre] = parts(right);
  const compareNumber = (a: string, b: string) => BigInt(a) > BigInt(b) ? 1 : BigInt(a) < BigInt(b) ? -1 : 0;
  const a = leftCore.split(".");
  const b = rightCore.split(".");
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumber(a[index], b[index]);
    if (order) return order;
  }
  if (leftPre === undefined || rightPre === undefined) return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1;
  const leftParts = leftPre.split(".");
  const rightParts = rightPre.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const x = leftParts[index];
    const y = rightParts[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    return xn && yn ? compareNumber(x, y) : xn !== yn ? xn ? -1 : 1 : x > y ? 1 : -1;
  }
  return 0;
}

// Group only for navigation. Each source retains its complete identity and data.
export function groupCatalogPlugins(items: readonly PluginListItem[]): PluginListItem[][] {
  const groups = new Map<string, PluginListItem[]>();
  for (const item of items) {
    const group = groups.get(item.id) ?? [];
    group.push(item);
    groups.set(item.id, group);
  }
  return [...groups.values()].map((group) => group.sort((a, b) =>
    compareVersion(b.version, a.version) || a.pluginKey.localeCompare(b.pluginKey)));
}
