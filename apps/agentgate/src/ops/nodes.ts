import { z } from "zod";
import { controlOp, UserError } from "./registry.ts";

/** The machines family's control operations. */

// Not loopback-only: marking your server always on from the laptop you are on is the point.
controlOp({
  name: "nodes always-on",
  summary: "mark a machine always on: it takes care of token refreshes while your other machines are away",
  input: z.object({ node: z.string().min(1).max(512), on: z.boolean() }).strict(),
  needs: "store",
  run({ node, on }, { s }) {
    const n = s.get("node", node);
    if (!n) throw new UserError(`No machine named ${node}`);
    return s.put("node", n.id, { ...n, alwaysOn: on });
  },
  terminal: {
    usage: "nodes always-on <node> on|off",
    parse(args) {
      const [node, state, ...extra] = args;
      if (!node || (state !== "on" && state !== "off") || extra.length) throw new UserError();
      return { input: { node, on: state === "on" } };
    },
    print(n) {
      return [
        n.alwaysOn
          ? `${n.id} is always on: it takes care of token refreshes while your other machines are away`
          : `${n.id} is no longer always on`,
      ];
    },
  },
});
