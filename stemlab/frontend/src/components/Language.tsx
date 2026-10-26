import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Language = "th" | "en";
const LANGUAGE_KEY = "stemlab.language";

function readLanguage(): Language {
  try {
    return window.localStorage.getItem(LANGUAGE_KEY) === "en" ? "en" : "th";
  } catch {
    return "th";
  }
}

interface LanguageContextValue {
  language: Language;
  t: (thai: string, english: string) => string;
  toggleLanguage: () => void;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(readLanguage);
  const toggleLanguage = useCallback(() => {
    setLanguage((current) => current === "th" ? "en" : "th");
  }, []);
  const t = useCallback((thai: string, english: string) => language === "en" ? english : thai, [language]);

  useEffect(() => {
    document.documentElement.lang = language;
    try {
      window.localStorage.setItem(LANGUAGE_KEY, language);
    } catch (error) {
      console.error("Could not save the selected language.", error);
    }
  }, [language]);

  useEffect(() => {
    const syncLanguage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_KEY) setLanguage(event.newValue === "en" ? "en" : "th");
    };
    window.addEventListener("storage", syncLanguage);
    return () => window.removeEventListener("storage", syncLanguage);
  }, []);

  return (
    <LanguageContext.Provider value={useMemo(() => ({ language, t, toggleLanguage }), [language, t, toggleLanguage])}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within LanguageProvider");
  return context;
}

export function LanguageToggle() {
  const { language, toggleLanguage, t } = useLanguage();
  return (
    <button
      type="button"
      className="language-toggle"
      aria-label={t("เปลี่ยนภาษาเป็นภาษาอังกฤษ", "Switch language to Thai")}
      onClick={toggleLanguage}
    >
      <span aria-hidden="true">文</span>
      <span>{language === "th" ? "TH" : "EN"}</span>
    </button>
  );
}
