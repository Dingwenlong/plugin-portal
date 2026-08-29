import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "dark" | "light";
const STORAGE_KEY = "plugin-portal.theme";
const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null);
const validTheme = (value: unknown): Theme => value === "light" ? "light" : "dark";

export function PortalThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return validTheme(window.localStorage.getItem(STORAGE_KEY)); }
    catch { return "dark"; }
  });

  useLayoutEffect(() => {
    const previous = document.documentElement.getAttribute("data-portal-theme");
    return () => {
      if (previous === null) document.documentElement.removeAttribute("data-portal-theme");
      else document.documentElement.setAttribute("data-portal-theme", previous);
    };
  }, []);
  useLayoutEffect(() => { document.documentElement.dataset.portalTheme = theme; }, [theme]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) setTheme(validTheme(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); }
    catch { /* A private or full storage area must not disable the local control. */ }
  }

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle({ className = "", disabled = false }: { className?: string; disabled?: boolean }) {
  const context = useContext(ThemeContext);
  if (!context) return null;
  const label = context.theme === "dark" ? "切换为浅色" : "切换为深色";
  return <button
    aria-label={label}
    aria-pressed={context.theme === "light"}
    className={`portal-theme-toggle ${className}`}
    disabled={disabled}
    onClick={context.toggle}
    title={label}
    type="button"
  >
    {context.theme === "dark" ? <Sun aria-hidden="true" size={17} /> : <Moon aria-hidden="true" size={17} />}
    <span className="portal-theme-label">{context.theme === "dark" ? "浅色" : "深色"}</span>
  </button>;
}
