import { useEffect, useState } from "react";
import { useLanguage } from "./Language";

type Theme = "dark" | "light";
const THEME_KEY = "stemlab.theme";

function readTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function initializeTheme(): void {
  document.documentElement.dataset.theme = readTheme();
}

export default function ThemeToggle() {
  const { t } = useLanguage();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const isNight = theme === "dark";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch (error) {
      console.error("Could not save the selected theme.", error);
    }
  }, [theme]);

  useEffect(() => {
    const syncTheme = (event: StorageEvent) => {
      if (event.key === THEME_KEY) setTheme(event.newValue === "light" ? "light" : "dark");
    };
    window.addEventListener("storage", syncTheme);
    return () => window.removeEventListener("storage", syncTheme);
  }, []);

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={isNight ? t("ปิดโหมดกลางคืน", "Turn off dark mode") : t("เปิดโหมดกลางคืน", "Turn on dark mode")}
      aria-pressed={isNight}
      onClick={() => setTheme(isNight ? "light" : "dark")}
    >
      <span className="theme-toggle-icon" aria-hidden="true">{isNight ? "☾" : "☼"}</span>
      <span>{isNight ? t("โหมดกลางคืน", "Dark mode") : t("โหมดกลางวัน", "Light mode")}</span>
      <span className={`theme-switch ${isNight ? "is-on" : ""}`} aria-hidden="true">
        <span />
      </span>
    </button>
  );
}
