import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PortalShell } from "./portal/PortalShell";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PortalShell />
  </StrictMode>,
);
