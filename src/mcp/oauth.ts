import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpInstance, Store } from "../store.ts";

/**
 * MCP OAuth for one instance (discovery, dynamic client registration, PKCE, refresh), stored on the
 * instance record so the login syncs to every node. The verifier and state stay local to this node.
 * ponytail: two nodes refreshing the same rotating token at once can log one out; add holder rules (PLAN §5) if that bites.
 */
export class InstanceAuth implements OAuthClientProvider {
  /** Set when the SDK wants the user sent to the login page. */
  authUrl?: URL;

  constructor(
    private s: Store,
    private id: string,
    /** Only an interactive flow (started from the UI) may start a login; background connects must not clobber its verifier. */
    private interactive = false,
  ) {}

  private inst(): McpInstance {
    const inst = this.s.get("mcp", this.id);
    if (!inst) throw new Error(`no MCP instance ${this.id}`);
    return inst;
  }

  private update(patch: Partial<NonNullable<McpInstance["oauth"]>>) {
    const inst = this.inst();
    this.s.put("mcp", this.id, { ...inst, oauth: { ...inst.oauth, ...patch } });
  }

  get redirectUrl() {
    return this.inst().oauth?.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "agentgate",
      redirect_uris: [this.redirectUrl ?? ""],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state() {
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
    if (this.interactive) this.s.setLocal(`oauth-state:${state}`, this.id);
    return state;
  }

  clientInformation() {
    return this.inst().oauth?.client as OAuthClientInformationMixed | undefined;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.update({ client });
  }

  tokens() {
    return this.inst().oauth?.tokens as OAuthTokens | undefined;
  }
  saveTokens(tokens: OAuthTokens) {
    this.update({ tokens });
  }

  redirectToAuthorization(url: URL) {
    this.authUrl = url;
    if (!this.interactive) this.s.log("mcp", this.id, "", 401, 0, "needs login");
  }

  saveCodeVerifier(verifier: string) {
    if (this.interactive) this.s.setLocal(`oauth-verifier:${this.id}`, verifier);
  }
  codeVerifier() {
    const v = this.s.local(`oauth-verifier:${this.id}`);
    if (!v) throw new Error("login expired; start it again");
    return v;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "verifier" || scope === "all") this.s.setLocal(`oauth-verifier:${this.id}`, undefined);
    if (scope === "all") this.update({ client: undefined, tokens: undefined });
    if (scope === "client") this.update({ client: undefined });
    if (scope === "tokens") this.update({ tokens: undefined });
  }
}

/** Start a login from the UI. Returns the login page URL, or undefined when no login is needed. */
export async function startLogin(s: Store, id: string, callbackUrl: string): Promise<URL | undefined> {
  const inst = s.get("mcp", id);
  if (!inst?.url) throw new Error(`${id} is not an HTTP server`);
  // A new redirect URI needs a new client registration; old tokens are dropped since the user asked to log in.
  const client = inst.oauth?.redirectUri === callbackUrl ? inst.oauth.client : undefined;
  s.put("mcp", id, { ...inst, oauth: { redirectUri: callbackUrl, client } });
  const provider = new InstanceAuth(s, id, true);
  const result = await auth(provider, { serverUrl: inst.url });
  return result === "REDIRECT" ? provider.authUrl : undefined;
}

/** The login page redirected back with `code` and `state`. Returns the instance id. */
export async function finishLogin(s: Store, state: string, code: string): Promise<string> {
  const id = s.local(`oauth-state:${state}`);
  if (!id) throw new Error("unknown or expired login; start it again");
  s.setLocal(`oauth-state:${state}`, undefined);
  const inst = s.get("mcp", id);
  if (!inst?.url) throw new Error(`no MCP instance ${id}`);
  await auth(new InstanceAuth(s, id, true), { serverUrl: inst.url, authorizationCode: code });
  s.setLocal(`oauth-verifier:${id}`, undefined);
  return id;
}
