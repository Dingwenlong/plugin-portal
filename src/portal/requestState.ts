export class PortalRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number, readonly uncertain = false) {
    super(message);
    this.name = "PortalRequestError";
  }
}

export function isUncertain(error: unknown): boolean {
  return error instanceof PortalRequestError && error.uncertain;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成，请重试";
}

export function sameContent(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
  return canonical(left) === canonical(right);
}

export interface ResourceState<T> {
  value?: T;
  status: "loading" | "ready" | "error";
  error?: string;
}
