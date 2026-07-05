import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "@/i18n";
import { applyServerConfig } from "@/lib/server-config";

// Fetch server-side LLM/embedding/vision defaults before first render.
// Errors are swallowed inside applyServerConfig — this never blocks startup.
applyServerConfig().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
