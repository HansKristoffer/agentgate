import React from "react";
import { createRoot } from "react-dom/client";
import { followSystemTheme } from "@hanskristoffer/taurio/runtime";
import { App } from "./App.tsx";
import "./styles.css";

followSystemTheme(); // HeroUI switches on the `dark` class; this follows macOS

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
