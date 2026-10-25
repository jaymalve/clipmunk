import { DAEMON_HASH, type Issue, type Result } from "../core";

/** Browser-side client for the local daemon.
 * `clipmunk dev` prints a link whose fragment carries the daemon's port and session token.
 * Opening it once stores them for this origin, so every page of the app can reach the daemon.
 */
export type DaemonLink = { port: number; token: string };
const STORAGE_KEY = "clipmunk:daemon";

/** Take the link out of the URL fragment (if present), remember it, and clean the address bar. */
export function adoptDaemonLink(): DaemonLink | undefined {
  const match = new RegExp(`(?:^#|&)${DAEMON_HASH}=(\\d{1,5})\\.([A-Za-z0-9_-]{16,})`).exec(location.hash);
  if (match) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ port: Number(match[1]), token: match[2] }));
    const rest = location.hash
      .slice(1)
      .split("&")
      .filter((part) => part && !part.startsWith(`${DAEMON_HASH}=`))
      .join("&");
    history.replaceState(history.state, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
  }
  return storedLink();
}
export function storedLink(): DaemonLink | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as DaemonLink | null;
    return value && Number.isInteger(value.port) && typeof value.token === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export type DaemonClient = ReturnType<typeof createDaemonClient>;
export function createDaemonClient(link: DaemonLink) {
  const origin = `http://127.0.0.1:${link.port}`;
  const unreachable: Issue = {
    code: "daemon-unreachable",
    message:
      "The Clipmunk daemon is not answering. Run `npx clipmunk dev` in your project and open the link it prints.",
  };
  async function request<T>(method: string, route: string, body?: unknown, raw?: Blob): Promise<Result<T>> {
    try {
      const response = await fetch(`${origin}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${link.token}`,
          ...(raw ? {} : body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      return (await response.json()) as Result<T>;
    } catch {
      return { ok: false, issues: [unreachable] };
    }
  }
  return {
    origin,
    get: <T>(route: string) => request<T>("GET", route),
    post: <T>(route: string, body?: unknown) => request<T>("POST", route, body ?? {}),
    patch: <T>(route: string, body: unknown) => request<T>("PATCH", route, body),
    remove: <T>(route: string) => request<T>("DELETE", route),
    put: <T>(route: string, data: Blob) => request<T>("PUT", route, undefined, data),
    /** Fire-and-forget text that still goes out while the page is unloading. */
    note: (route: string, text: string) =>
      void fetch(`${origin}${route}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${link.token}` },
        body: text,
        keepalive: true,
      }).catch(() => {}),
    /** The link this client uses, for handing on to a page the Studio frames. */
    link,
    /** URLs for media elements and EventSource, which cannot send an Authorization header. */
    url: (route: string) =>
      `${origin}${route}${route.includes("?") ? "&" : "?"}token=${encodeURIComponent(link.token)}`,
  };
}

export type DaemonStatus = {
  version: string;
  project: string;
  ffmpeg: boolean;
  /** The host app's dev server and studio path, once the project is connected. */
  devUrl?: string;
  studioPath?: string;
};
export type DaemonProblem = { reason: "no-link" | "unreachable" | "rejected"; message: string };
/** A client for the remembered daemon, or the specific reason there is none. */
export async function connectDaemon(): Promise<
  { client: DaemonClient; status: DaemonStatus; problem?: undefined } | { problem: DaemonProblem }
> {
  const link = adoptDaemonLink();
  // The link is remembered per address and per browser profile, which is the usual reason it is missing.
  if (!link)
    return {
      problem: {
        reason: "no-link",
        message: `This browser profile has no daemon link for ${location.origin}. Run \`npx clipmunk dev\` in your project and open the full link it prints, here, on this same address.`,
      },
    };
  const client = createDaemonClient(link);
  const status = await client.get<DaemonStatus>("/v1/status");
  if (status.ok) return { client, status: status.data };
  if (status.issues[0]?.code === "daemon-unreachable")
    return {
      problem: {
        reason: "unreachable",
        message: `Nothing answers at 127.0.0.1:${link.port}. Start \`npx clipmunk dev\`; if your project runs on another machine, forward port ${link.port} as well as the dev server's.`,
      },
    };
  return {
    problem: {
      reason: "rejected",
      message:
        "This browser holds a link from an earlier daemon session. Open the link the running `npx clipmunk dev` printed.",
    },
  };
}
