import { useEffect, useRef } from "react";
import type { Connection } from "@agentgate/protocol";

/** A generation also distinguishes A → B → A connections and unmounted screens. */
export function useGeneration(connection: Connection) {
  const key = JSON.stringify([connection.url, connection.token]);
  const ref = useRef({ key, generation: 0, mounted: true });
  if (ref.current.key !== key) {
    ref.current.key = key;
    ref.current.generation++;
  }
  useEffect(() => {
    ref.current.mounted = true;
    return () => {
      ref.current.mounted = false;
      ref.current.generation++;
    };
  }, []);
  return () => {
    const generation = ref.current.generation;
    return () => ref.current.mounted && ref.current.generation === generation;
  };
}
