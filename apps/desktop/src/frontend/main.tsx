import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

// HeroUI switches on the `dark` class, never the media query; follow the system before the first paint.
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const theme = () => document.documentElement.classList.toggle("dark", dark.matches);
theme();
dark.addEventListener("change", theme);
if (typeof tiny !== "undefined") void tiny.win.setMinSize(760, 560);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
