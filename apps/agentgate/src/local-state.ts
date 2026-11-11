import type { Topic } from "@agentgate/protocol";
import { z } from "zod";
import type { Store } from "./store.ts";

/** A typed family of node-local keys (`prefix` + id). A plain `z.string()` stores the value raw, so rows written before
 * the family was typed stay readable; any other schema stores JSON. A missing, unreadable or invalid row reads as
 * undefined, so one bad row never breaks the code that reads it. */
export function defineLocal<S extends z.ZodType>(prefix: string, schema: S, opts?: { topic?: Topic }) {
  const raw = schema instanceof z.ZodString;
  const key = (id?: string) => prefix + (id ?? "");
  return {
    key,
    get(s: Store, id?: string): z.infer<S> | undefined {
      const text = s.local(key(id));
      if (text === undefined) return undefined;
      let value: unknown = text;
      if (!raw)
        try {
          value = JSON.parse(text);
        } catch {
          return undefined;
        }
      const parsed = schema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    },
    /** Writes, and marks `opts.topic` changed, only when the stored text changes. Returns whether it did. */
    set(s: Store, id: string | undefined, value: z.infer<S> | undefined): boolean {
      const k = key(id);
      const text = value === undefined ? undefined : raw ? String(value) : JSON.stringify(value);
      if (s.local(k) === text) return false;
      s.setLocal(k, text);
      if (opts?.topic) s.bump(opts.topic);
      return true;
    },
  };
}
