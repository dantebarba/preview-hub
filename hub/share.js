/**
 * Sharing a preview on the internet from the hub.
 *
 * The hub speaks the same contract as the launcher's `preview share`: it asks
 * an edge host over SSH (`add <label> <port> <hours>`, `remove <label>`,
 * `list`) with a key the edge binds to its share command, and while a preview
 * is shared it runs the same forwarder container the launcher does,
 * `<compose project>-share`: socat on the host network, listening on
 * PREVIEW_SHARE_ADDR at the preview's `preview.edge.port` only, forwarding to
 * its `preview.edge.target`. The forwarder's `preview.share.*` labels are the
 * shared state both sides read, so a share made by either is seen and can be
 * retracted by the other.
 *
 * The key is never stored by the hub: a share link is fetched from the edge's
 * `list` each time it is asked for.
 *
 * Sharing is opt-in. It is enabled only when the SSH destination, the bind
 * address, the key and the known_hosts file are all configured; `preview hub
 * up` hands them over from the launcher's share settings.
 */

import { existsSync } from "node:fs";
import {
  dockerFetch,
  fetchContainers,
  inspectContainer,
  inspectPreview,
  edgeOf,
  stopPreview,
  SHARE_HOST,
} from "./docker.js";

const DEFAULT_KEY = "/run/preview-share/key";
const DEFAULT_KNOWN_HOSTS = "/run/preview-share/known_hosts";
const DEFAULT_IMAGE = "alpine/socat:latest";
const MIN_HOURS = 1;
const MAX_HOURS = 72;
const FORWARDER_SETTLE_MS = 1000;
const CREDENTIAL_FILE = /^\.env(rc)?$|^\.env\.(?!example$|sample$|template$|dist$)[^/]+$/;

const EDGE_STATUS = {
  2: "invalid argument",
  3: "label reserved or in use by another record",
  4: "the DNS provider refused or was unreachable",
  5: "edge error",
  255: "ssh could not reach the edge or the key was refused",
};

/** An error with the HTTP status the API should answer it with. */
export class ShareError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Read the share settings from the environment; `enabled` when all are present. */
export function shareConfig(env = process.env, exists = existsSync) {
  const ssh = (env.PREVIEW_SHARE_SSH || "").trim();
  const addr = (env.PREVIEW_SHARE_ADDR || "").trim();
  const key = env.PREVIEW_SHARE_KEY || DEFAULT_KEY;
  const knownHosts = env.PREVIEW_SHARE_KNOWN_HOSTS || DEFAULT_KNOWN_HOSTS;
  const image = env.PREVIEW_SHARE_IMAGE || DEFAULT_IMAGE;
  const enabled = Boolean(ssh && addr && exists(key) && exists(knownHosts));
  return { enabled, ssh, addr, key, knownHosts, image };
}

/** Validate a share duration: a whole number of hours from 1 to 72. */
export function parseHours(value) {
  const hours = Number(value);
  if (!Number.isInteger(hours) || hours < MIN_HOURS || hours > MAX_HOURS) {
    throw new ShareError(`hours must be a whole number from ${MIN_HOURS} to ${MAX_HOURS}`, 400);
  }
  return hours;
}

/** List the bind-mounted `.env` / `.envrc` files among the given containers' mounts. */
export function credentialMounts(containers) {
  const found = [];
  for (const container of Array.isArray(containers) ? containers : []) {
    for (const mount of (container && container.Mounts) || []) {
      const source = (mount && mount.Source) || "";
      const name = source.replace(/\/+$/, "").split("/").pop();
      if (mount.Type === "bind" && CREDENTIAL_FILE.test(name) && !found.includes(source)) {
        found.push(source);
      }
    }
  }
  return found;
}

/** Split an image reference into the name and tag the pull API takes. */
export function splitImage(image) {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash) return { name: image.slice(0, colon), tag: image.slice(colon + 1) };
  return { name: image, tag: "latest" };
}

/** Parse the edge's answer to `add`, or throw when it is not the expected object. */
export function parseAdd(stdout) {
  let answer;
  try {
    answer = JSON.parse(stdout);
  } catch {
    answer = null;
  }
  const host = answer && answer.host;
  const expires = Number(answer && answer.expires);
  if (!SHARE_HOST.test(host || "") || !answer.url || !Number.isInteger(expires)) {
    throw new ShareError("the edge answered 'add' with something unexpected", 502);
  }
  return { host, expires };
}

/** Run one verb of the edge's share command over SSH; resolves to its stdout. */
async function sshEdge(config, verb, ...args) {
  const proc = Bun.spawn(
    [
      "ssh",
      "-n",
      "-i",
      config.key,
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      `UserKnownHostsFile=${config.knownHosts}`,
      config.ssh,
      [verb, ...args].join(" "),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status !== 0) {
    const reason = stderr.trim().split("\n").pop() || "";
    const meaning = EDGE_STATUS[status] || `exit status ${status}`;
    throw new ShareError(`share ${verb} failed (${meaning}): ${reason}`, 502);
  }
  return stdout;
}

async function ensureImage(image) {
  const present = await dockerFetch(`/images/${encodeURIComponent(image)}/json`);
  if (present.ok) return;
  const { name, tag } = splitImage(image);
  const pull = await dockerFetch(
    `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`,
    { method: "POST" }
  );
  await pull.text();
  if (!pull.ok) throw new ShareError(`could not pull the forwarder image ${image}`, 502);
}

async function removeContainer(name) {
  const res = await dockerFetch(`/containers/${encodeURIComponent(name)}?force=true`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new ShareError(`docker engine responded ${res.status} removing ${name}`, 502);
  }
}

async function startContainer(config, name, edge, project, share) {
  await ensureImage(config.image);
  await removeContainer(name);
  const create = await dockerFetch(`/containers/create?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Image: config.image,
      Cmd: [`TCP-LISTEN:${edge.port},bind=${config.addr},fork,reuseaddr`, `TCP:${edge.target}`],
      Labels: {
        "preview.share.project": project,
        "preview.share.label": edge.label,
        "preview.share.host": share.host,
        "preview.share.expires": share.expires === "" ? "" : String(share.expires),
      },
      HostConfig: { NetworkMode: "host", RestartPolicy: { Name: "no" } },
    }),
  });
  if (!create.ok) throw new ShareError(`docker engine responded ${create.status} creating ${name}`, 502);
  const start = await dockerFetch(`/containers/${encodeURIComponent(name)}/start`, { method: "POST" });
  if (!start.ok && start.status !== 304) {
    await removeContainer(name);
    throw new ShareError(`docker engine responded ${start.status} starting ${name}`, 502);
  }
  await Bun.sleep(FORWARDER_SETTLE_MS);
  const state = await inspectContainer(name);
  if (!state || !state.State || !state.State.Running) {
    await removeContainer(name);
    throw new ShareError(
      `the forwarder exited: is ${config.addr} an address of this machine and port ${edge.port} free on it?`,
      502
    );
  }
}

/**
 * The Docker side the sharing logic needs, backed by the real Engine API.
 * `start` replaces any forwarder of the same name, as the launcher's does.
 */
export function dockerForwarders(config) {
  return {
    inspectPreview,
    projectContainers: (project) => fetchContainers([`com.docker.compose.project=${project}`]),
    forwarderLabels: async (name) => {
      const container = await inspectContainer(name);
      return container ? (container.Config && container.Config.Labels) || {} : null;
    },
    start: (name, edge, project, share) => startContainer(config, name, edge, project, share),
    remove: removeContainer,
    stopPreview,
  };
}

/**
 * Build the share actions over an edge caller and a Docker side, both
 * injectable so the ordering and rollback can be tested without either.
 */
export function createSharing({ config, edge, docker }) {
  const forwarderName = (project) => `${project}-share`;

  function requireEnabled() {
    if (!config.enabled) throw new ShareError("sharing is not configured on this hub", 409);
  }

  async function resolve(id) {
    const container = await docker.inspectPreview(id);
    if (!container) throw new ShareError("no such preview", 404);
    const labels = container.Config.Labels;
    const project = labels["com.docker.compose.project"] || "";
    if (!project) throw new ShareError("this preview has no compose project to share", 409);
    return { labels, project };
  }

  async function sharedLabel(project) {
    const labels = await docker.forwarderLabels(forwarderName(project));
    return labels ? labels["preview.share.label"] || "" : null;
  }

  /**
   * Share a preview for `hours`. Without `confirm`, a preview whose containers
   * bind-mount a `.env` / `.envrc` is not shared and { needsConfirm, files } is
   * returned instead. Mirrors the launcher: start the forwarder, `add`, drop
   * the forwarder when `add` fails, then recreate it with the host and expiry,
   * removing the share again when the answer is unexpected or that fails.
   */
  async function share(id, hours, confirm) {
    requireEnabled();
    const duration = parseHours(hours);
    const { labels, project } = await resolve(id);
    const edgeInfo = edgeOf(labels);
    if (!edgeInfo) {
      throw new ShareError("restart this preview with a current launcher to share it", 409);
    }
    if (!confirm) {
      const files = credentialMounts(await docker.projectContainers(project));
      if (files.length) return { needsConfirm: true, files };
    }

    const name = forwarderName(project);
    const existed = (await sharedLabel(project)) !== null;
    if (!existed) await docker.start(name, edgeInfo, project, { host: "", expires: "" });

    let added;
    try {
      added = await edge("add", edgeInfo.label, edgeInfo.port, duration);
    } catch (err) {
      if (!existed) await docker.remove(name);
      throw err;
    }
    let answer;
    try {
      answer = parseAdd(added);
      await docker.start(name, edgeInfo, project, answer);
    } catch (err) {
      await edge("remove", edgeInfo.label).catch(() => {});
      await docker.remove(name).catch(() => {});
      throw err;
    }
    return { shared: true, host: answer.host, expires: answer.expires };
  }

  /**
   * Retract a preview's share: `remove` on the edge (when this hub can reach
   * it), then remove the forwarder whatever the edge answered, so nothing
   * stays reachable. Resolves to { unshared, warning? }.
   */
  async function retract(project) {
    const label = await sharedLabel(project);
    if (label === null) return { unshared: false };
    let warning;
    if (!config.enabled) {
      warning = "sharing is not configured on this hub; the edge keeps the share until it expires";
    } else if (label) {
      try {
        await edge("remove", label);
      } catch (err) {
        warning = `${err.message}; the edge keeps the share until it expires`;
      }
    }
    await docker.remove(forwarderName(project));
    return warning ? { unshared: true, warning } : { unshared: true };
  }

  async function unshare(id) {
    const { project } = await resolve(id);
    const result = await retract(project);
    if (!result.unshared) throw new ShareError("this preview is not shared", 404);
    return result;
  }

  /** Fetch a shared preview's link, key included, from the edge's `list`. */
  async function link(id) {
    requireEnabled();
    const { project } = await resolve(id);
    const label = await sharedLabel(project);
    if (!label) throw new ShareError("this preview is not shared", 404);
    let shares;
    try {
      shares = JSON.parse(await edge("list"));
    } catch (err) {
      if (err instanceof ShareError) throw err;
      throw new ShareError("the edge answered 'list' with something unexpected", 502);
    }
    const match = (Array.isArray(shares) ? shares : []).find((s) => s && s.label === label);
    if (!match || !match.url) throw new ShareError("the edge no longer lists this share", 404);
    return { url: match.url, expires: Number(match.expires) };
  }

  /**
   * Stop a preview, retracting its share first so none outlives it. A failed
   * retraction does not keep the preview running: it is reported as a warning.
   */
  async function stop(id) {
    const container = await docker.inspectPreview(id);
    if (!container) return { status: "not-found" };
    const project = container.Config.Labels["com.docker.compose.project"] || "";
    let retracted = { unshared: false };
    if (project) {
      try {
        retracted = await retract(project);
      } catch (err) {
        retracted = { unshared: false, warning: `could not retract the share: ${err.message}` };
      }
    }
    const stopped = await docker.stopPreview(id);
    return retracted.warning ? { ...stopped, warning: retracted.warning } : stopped;
  }

  return { share, unshare, link, stop };
}

const CONFIG = shareConfig();

/** The hub's sharing, wired to the real edge and Docker. */
export const sharing = createSharing({
  config: CONFIG,
  edge: (verb, ...args) => sshEdge(CONFIG, verb, ...args),
  docker: dockerForwarders(CONFIG),
});

/** Whether this hub can share previews. */
export const shareEnabled = CONFIG.enabled;
