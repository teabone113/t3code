import { isCapacitorShell } from "./env";

const APP_SHELL_HEIGHT_VAR = "--app-shell-height";

function setAppShellHeight(height: number) {
  if (!Number.isFinite(height) || height <= 0) {
    return;
  }

  document.documentElement.style.setProperty(APP_SHELL_HEIGHT_VAR, `${Math.round(height)}px`);
}

export function installMobileViewportSizing(): () => void {
  if (!isCapacitorShell() || typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }

  const syncHeight = () => {
    setAppShellHeight(window.innerHeight);
  };

  syncHeight();

  window.addEventListener("resize", syncHeight);
  window.addEventListener("orientationchange", syncHeight);
  window.addEventListener("pageshow", syncHeight);
  window.visualViewport?.addEventListener("resize", syncHeight);

  return () => {
    window.removeEventListener("resize", syncHeight);
    window.removeEventListener("orientationchange", syncHeight);
    window.removeEventListener("pageshow", syncHeight);
    window.visualViewport?.removeEventListener("resize", syncHeight);
  };
}
