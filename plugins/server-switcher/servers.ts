// Pure server-switcher logic shared by the settings validator (server.ts) and the
// sidebar disclosure (app.tsx).

export interface ConfiguredServer {
  name: string;
  /** Normalized origin, e.g. https://bb.artem.cool */
  url: string;
  /** URL host, including a non-default port. */
  host: string;
}

export type ParseResult =
  | { ok: true; servers: ConfiguredServer[] }
  | { ok: false; error: string };

const MAX_SERVERS = 20;

/**
 * Parses the `servers` setting: one server per line as `<name> <url>`.
 * Blank lines and lines starting with `#` are ignored.
 */
export function parseServers(text: string): ParseResult {
  const servers: ConfiguredServer[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const lineNumber = index + 1;
    const match = /^(\S+)\s+(\S+)$/.exec(line);
    if (match === null) {
      return { ok: false, error: `Line ${lineNumber}: expected "<name> <url>"` };
    }
    const [, name, rawUrl] = match;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, error: `Line ${lineNumber}: "${rawUrl}" is not a URL` };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: `Line ${lineNumber}: URL must use http or https` };
    }
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      return {
        ok: false,
        error: `Line ${lineNumber}: use the server's root URL, without a path`,
      };
    }
    if (servers.some((server) => server.host === parsed.host)) {
      return { ok: false, error: `Line ${lineNumber}: ${parsed.host} is listed twice` };
    }
    servers.push({ name, url: parsed.origin, host: parsed.host });
  }
  if (servers.length > MAX_SERVERS) {
    return { ok: false, error: `List at most ${MAX_SERVERS} servers` };
  }
  return { ok: true, servers };
}

/** One entry of the desktop app's own server list. */
export interface DesktopChoice {
  id: string;
  name: string;
  active: boolean;
}

/** The desktop shell's undocumented server bridge on `window.bbDesktop`. */
export interface DesktopBridge {
  getServerChoices(): Promise<DesktopChoice[]>;
  selectServer(id: string): void;
}

export function parseDesktopChoices(value: unknown): DesktopChoice[] | null {
  if (!Array.isArray(value)) return null;
  const choices: DesktopChoice[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { id, name, active } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || typeof active !== "boolean") {
      return null;
    }
    choices.push({ id, name, active });
  }
  return choices;
}

/**
 * The desktop app's id for a saved custom server: `custom:` and the SHA-256
 * hex digest of its URL. The desktop app stores a root URL as its origin, the
 * same form as ConfiguredServer.url. Returns null without Web Crypto (an
 * insecure context), leaving name matching only.
 */
export async function customServerId(url: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(url));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `custom:${hex.join("")}`;
}

/**
 * Pairs each configured server with the desktop app's saved choice, keyed by
 * host. A choice matches by its custom-server id, which survives a custom name
 * in the desktop app, or else by a name equal to the server's host (the
 * desktop app's default name).
 */
export function matchDesktopChoices(
  servers: readonly ConfiguredServer[],
  ids: ReadonlyMap<string, string>,
  choices: readonly DesktopChoice[],
): Map<string, DesktopChoice> {
  const matches = new Map<string, DesktopChoice>();
  for (const server of servers) {
    const id = ids.get(server.url);
    const choice =
      (id === undefined ? undefined : choices.find((candidate) => candidate.id === id)) ??
      choices.find((candidate) => candidate.name === server.host);
    if (choice !== undefined) matches.set(server.host, choice);
  }
  return matches;
}

/**
 * Picks which configured server this window is showing: the one matched to the
 * desktop app's active choice when known, otherwise the page's own host.
 */
export function currentServer(
  servers: readonly ConfiguredServer[],
  pageHost: string,
  matches: ReadonlyMap<string, DesktopChoice> | null,
): ConfiguredServer | undefined {
  const active = servers.find((server) => matches?.get(server.host)?.active === true);
  return active ?? servers.find((server) => server.host === pageHost);
}
