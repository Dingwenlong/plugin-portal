import { useState } from "react";
import { Package } from "lucide-react";

export function PluginBrandIcon({ pluginKey, revision }: { pluginKey: string; revision: number }) {
  const requestKey = `${pluginKey}:${revision}`;
  const [failedRequest, setFailedRequest] = useState("");
  if (failedRequest === requestKey) {
    return <Package aria-hidden="true" className="portal-brand-fallback" size={22} />;
  }
  return (
    <img
      alt=""
      className="portal-brand-image"
      onError={() => setFailedRequest(requestKey)}
      src={`/api/plugins/${encodeURIComponent(pluginKey)}/icon?revision=${revision}`}
    />
  );
}
