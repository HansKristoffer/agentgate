import { isRecord } from "hanzio";

/** Claude Code's session id inside `metadata.user_id`, which is either JSON or `user_…_account_<uuid>_session_<id>`. */
function claudeMetadataSession(body: unknown) {
  const metadata = isRecord(body) ? body.metadata : undefined;
  const userId = isRecord(metadata) ? metadata.user_id : undefined;
  if (typeof userId !== "string") return undefined;
  try {
    const parsed = JSON.parse(userId);
    if (typeof parsed?.session_id === "string") return parsed.session_id as string;
  } catch {
    // Not JSON: the older underscore form below.
  }
  return userId.match(/_session_([\w-]{1,128})$/)?.[1];
}

/** Claude Code names its session in a header; older versions only inside `metadata.user_id`. */
export function claudeSession(headers: Headers, body: unknown) {
  return headers.get("x-claude-code-session-id") ?? claudeMetadataSession(body);
}

export function codexSession(headers: Headers) {
  const id = headers.get("session_id") ?? headers.get("x-codex-session-id");
  return id && id.length <= 128 ? id : undefined;
}
