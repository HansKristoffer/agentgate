import { useEffect, useRef, type ReactNode } from "react";

/**
 * Frosted sidebar beside one inset card. The window drags from the sidebar and the card's top
 * strip; tinyjs leaves buttons and inputs inside a drag region clickable.
 */
export function AppShell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="shell-app" data-tiny-drag>
      <aside className="shell-sidebar" data-tiny-drag>
        {sidebar}
      </aside>
      <main className="shell-main">
        <div className="shell-drag-strip" data-tiny-drag />
        {children}
      </main>
    </div>
  );
}

const apple = /Mac/.test(navigator.userAgent);

/** Cmd+key on macOS, Ctrl+key elsewhere: `useAppShortcuts({ ",": openSettings })`. */
export function useAppShortcuts(shortcuts: Record<string, () => void>) {
  const current = useRef(shortcuts);
  current.current = shortcuts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const run = (apple ? e.metaKey : e.ctrlKey) && current.current[e.key.toLowerCase()];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
