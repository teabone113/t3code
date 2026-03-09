import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isCapacitorShell, isElectronShell } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { shouldBootToConnectionSettings } from "./backendConnection";
import { installMobileViewportSizing } from "./mobileViewport";

const history = isElectronShell() || isCapacitorShell() ? createHashHistory() : createBrowserHistory();

if ((isElectronShell() || isCapacitorShell()) && shouldBootToConnectionSettings()) {
  const targetHash = "#/settings";
  if (window.location.hash !== targetHash) {
    window.location.hash = targetHash;
  }
}

const router = getRouter(history);

document.title = APP_DISPLAY_NAME;
const disposeMobileViewportSizing = installMobileViewportSizing();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeMobileViewportSizing();
  });
}
