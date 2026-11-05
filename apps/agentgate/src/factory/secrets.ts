import { factorySecretInputSchema, secretNameSchema } from "@agentgate/protocol";
import { getErrorMessage } from "hanzio";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { jsonInput } from "../http.ts";
import type { Store } from "../store.ts";
import { currentFolder } from "./config.ts";
import { requireFactoryProtocol, type FactoryRuntime } from "./runtime.ts";

/**
 * The factory's secrets: values the folder names as `secret:NAME`, set from the CLI and kept as synced `secret` records
 * so whichever machine runs the factory has them. A value is only ever read back by the code that uses it; lists show
 * names, and no error names a value.
 */

/** A user secret by name, or agentgate's own `~hook:<source>` key. */
export function getSecret(s: Store, name: string) {
  return s.get("secret", name)?.value;
}

/** Synced to every node, so it waits until none of them would stall on the record kind. */
export function setSecret(s: Store, name: string, value: string) {
  requireFactoryProtocol(s);
  s.put("secret", name, { id: name, value, from: s.nodeId });
}

/** A tombstone, so a machine that was offline cannot bring the value back. */
export function deleteSecret(s: Store, name: string) {
  s.del("secret", name);
}

/** User secrets only: `~hook:` keys are agentgate's own. */
export function secretNames(s: Store) {
  return s
    .list("secret")
    .map((r) => r.id)
    .filter((id) => !id.startsWith("~hook:"));
}

/** `secret:NAME` to its value; undefined for any other string or a name that is not set. */
export function resolveSecretRef(s: Store, ref: string) {
  return ref.startsWith("secret:") ? getSecret(s, ref.slice("secret:".length)) : undefined;
}

/** The names set, and the names the loaded folder declares that this machine lacks. */
export function secretList(f: FactoryRuntime) {
  const set = secretNames(f.s);
  const missing = (currentFolder(f)?.config.secrets ?? []).filter((name) => !set.includes(name));
  return { set, missing };
}

// The error never echoes the input: a value typed where the name goes would land in it.
const NAME_RULE = "a secret name is capital letters, digits and _, starting with a letter, such as LINEAR_KEY";
const parseName = (name: string | undefined) => {
  const parsed = secretNameSchema.safeParse(name);
  if (!parsed.success) throw new Error(NAME_RULE);
  return parsed.data;
};

/** A value piped on stdin, without the newline `echo` adds. */
const stdinValue = (stdin: string | undefined) => {
  const value = stdin?.replace(/\r?\n$/, "");
  if (!value) throw new Error('pipe the value on stdin: printf %s "$VALUE" | agentgate factory secret set NAME');
  const parsed = factorySecretInputSchema.shape.value.safeParse(value);
  if (!parsed.success) throw new Error("a secret value is at most 16384 characters");
  return parsed.data;
};

const USAGE = "secret set <NAME> (value on stdin) | secret list | secret delete <NAME>";

export function setup(f: FactoryRuntime): void {
  f.commands.set("secret", {
    usage: USAGE,
    local: true,
    async run(args, io) {
      const [sub, name] = args;
      const named = name !== undefined && args.length === 2;
      if (sub === "set" && named) {
        const id = parseName(name);
        setSecret(f.s, id, stdinValue(io.stdin));
        io.out(`Set ${id} for every machine.`);
        return 0;
      }
      if (sub === "delete" && named) {
        const id = parseName(name);
        if (getSecret(f.s, id) === undefined) {
          io.out(`${id} is not set.`);
          return 1;
        }
        deleteSecret(f.s, id);
        io.out(`Deleted ${id} on every machine.`);
        return 0;
      }
      if (sub === "list" && args.length === 1) {
        const { set, missing } = secretList(f);
        set.forEach((name) => io.out(name));
        missing.forEach((name) => io.out(`${name}  not set (declared in factory.yaml)`));
        if (!set.length && !missing.length) io.out("No factory secrets.");
        return 0;
      }
      io.out(`usage: agentgate factory ${USAGE}`);
      return 2;
    },
  });

  // Like the control API's other secret routes, these are loopback only: a tailnet caller never sets or sees them.
  const local = (listener: string) => {
    if (listener !== "loopback")
      throw new HTTPException(403, { message: "This operation requires a local connection" });
  };
  // What an administrator typed wrong is a 400, like the rest of the control API.
  const input = <T>(fn: () => T) => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      throw new HTTPException(400, { message: getErrorMessage(error) });
    }
  };
  f.api.get("/secrets", (c) => {
    local(c.env.listener);
    return c.json(secretList(f));
  });
  f.api.put("/secrets/:name", async (c) => {
    local(c.env.listener);
    const id = input(() => parseName(c.req.param("name")));
    const { value } = factorySecretInputSchema.parse(await jsonInput(c.req.raw));
    input(() => setSecret(f.s, id, value));
    return c.json({ ok: true });
  });
  f.api.delete("/secrets/:name", (c) => {
    local(c.env.listener);
    const id = input(() => parseName(c.req.param("name")));
    if (getSecret(f.s, id) === undefined) throw new HTTPException(404, { message: `${id} is not set` });
    deleteSecret(f.s, id);
    return c.json({ ok: true });
  });
}
