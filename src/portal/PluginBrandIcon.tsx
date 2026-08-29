import { useEffect, useState } from "react";
import { Package } from "lucide-react";

export function PluginBrandIcon({ pluginKey }: { pluginKey: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [pluginKey]);
  if (failed) return <Package aria-hidden="true" className="portal-brand-fallback" size={22} />;
  return (
    <img
      alt=""
      className="portal-brand-image"
      onError={() => setFailed(true)}
      src={`/api/plugins/${encodeURIComponent(pluginKey)}/icon`}
    />
  );
}
