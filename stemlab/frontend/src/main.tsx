import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ThemeToggle, { initializeTheme } from "./components/ThemeToggle";
import { LanguageProvider, LanguageToggle } from "./components/Language";
import "./index.css";

initializeTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LanguageProvider>
      <App />
      <div className="preference-controls">
        <LanguageToggle />
        <ThemeToggle />
      </div>
    </LanguageProvider>
  </StrictMode>,
);
