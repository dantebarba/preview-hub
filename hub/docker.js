/**
 * Preview discovery via the Docker Engine API.
 *
 * listPreviews() queries running containers carrying the required `preview.url`
 * label, then maps each to a preview record, dedups so every distinct compose
 * project contributes at most one record, groups the records by `preview.project`
 * and sorts them into the exact shape the hub serves at GET /api/previews.
 *
 * A preview the launcher has shared on the internet also has a forwarder
 * container carrying `preview.share.*` labels; its public host and expiry are
 * attached to the preview as `share`. The key is never in a label, so the hub
 * cannot show it.
 *
 * Docker access is best-effort: an unreachable engine or a non-OK response yields
 * an empty list (logged to stderr) rather than a thrown error, so the PWA can
 * still render an empty state.
 *
 * stopPreview() stops every running container of one preview's compose project
 * and its share forwarder, refusing any container that does not carry `preview.url`, so the hub can only
 * ever stop preview stacks.
 */

const DEFAULT_SOCKET = "/var/run/docker.sock";
const DEFAULT_WORKTREE = "Root Worktree";

/**
 * Resolve where the Docker Engine API lives from DOCKER_HOST.
 *
 * A tcp:// (or http(s)://) value is reached with a normal fetch; anything else
 * (including a unix:// prefixed path or a bare path) is treated as a Unix socket
 * path that Bun's fetch reaches via its `unix` option.
 */
function dockerEndpoint() {
  const host = (process.env.DOCKER_HOST || "").trim();
  if (host.startsWith("tcp://")) {
    return { url: "http://" + host.slice("tcp://".length), unix: null };
  }
  if (host.startsWith("http://") || host.startsWith("https://")) {
    return { url: host, unix: null };
  }
  const socket = host.startsWith("unix://") ? host.slice("unix://".length) : host;
  return { url: "http://localhost", unix: socket || DEFAULT_SOCKET };
}

const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const SHARE_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function dockerFetch(path, init = {}) {
  const { url, unix } = dockerEndpoint();
  const target = `${url.replace(/\/$/, "")}${path}`;
  return fetch(target, unix ? { ...init, unix } : init);
}

async function fetchContainers(labels) {
  const filters = encodeURIComponent(JSON.stringify({ label: labels }));
  const res = await dockerFetch(`/containers/json?filters=${filters}`);
  if (!res.ok) {
    throw new Error(`docker engine responded ${res.status}`);
  }
  return res.json();
}

/**
 * Turn one raw Docker container object into a preview record, or null when it
 * lacks the required `preview.url` label.
 */
function toPreview(container) {
  const labels = (container && container.Labels) || {};
  const url = labels["preview.url"];
  if (!url) return null;
  return {
    project: labels["preview.project"] || "",
    branch: labels["preview.branch"] || "",
    worktree: labels["preview.worktree"] || DEFAULT_WORKTREE,
    desc: labels["preview.desc"] || "",
    url,
    id: container.Id || "",
    composeProject: labels["com.docker.compose.project"] || "",
  };
}

/**
 * Dedup preview records by compose project, group by project name and sort:
 * projects case-insensitively by name, previews within a project by branch then
 * worktree. A record whose compose project is empty is never collapsed with
 * another.
 */
function groupPreviews(previews) {
  const seenCompose = new Set();
  const byProject = new Map();

  for (const preview of previews) {
    if (preview.composeProject) {
      if (seenCompose.has(preview.composeProject)) continue;
      seenCompose.add(preview.composeProject);
    }
    if (!byProject.has(preview.project)) byProject.set(preview.project, []);
    byProject.get(preview.project).push(preview);
  }

  return [...byProject.keys()]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((project) => ({
      project,
      previews: byProject
        .get(project)
        .map(({ project: _project, ...rest }) => rest)
        .sort(
          (a, b) =>
            a.branch.localeCompare(b.branch) ||
            a.worktree.localeCompare(b.worktree)
        ),
    }));
}

/**
 * Map each compose project to the share its forwarder container describes,
 * { host, expires } with expires in epoch seconds. Forwarders still waiting
 * for the edge (no host or expiry yet), with a malformed host, or whose share
 * has expired by `now` are left out.
 */
export function sharesByProject(forwarders, now = Date.now()) {
  const shares = new Map();
  for (const container of Array.isArray(forwarders) ? forwarders : []) {
    const labels = (container && container.Labels) || {};
    const project = labels["preview.share.project"];
    const host = labels["preview.share.host"] || "";
    const expires = Number(labels["preview.share.expires"]);
    if (!project || !SHARE_HOST.test(host)) continue;
    if (!Number.isInteger(expires) || expires * 1000 <= now) continue;
    shares.set(project, { host, expires });
  }
  return shares;
}

/**
 * Attach its share to every preview record whose compose project has one.
 */
export function withShares(previews, shares) {
  return previews.map((preview) => {
    const share = preview.composeProject && shares.get(preview.composeProject);
    return share ? { ...preview, share } : preview;
  });
}

async function fetchShares() {
  try {
    return sharesByProject(await fetchContainers(["preview.share.project"]));
  } catch (err) {
    console.error("[preview-hub] docker share query failed:", err?.message ?? err);
    return new Map();
  }
}

/**
 * List active previews grouped and sorted per the hub backend contract.
 * Returns [] on any Docker error.
 */
export async function listPreviews() {
  let containers;
  let shares;
  try {
    [containers, shares] = await Promise.all([fetchContainers(["preview.url"]), fetchShares()]);
  } catch (err) {
    console.error("[preview-hub] docker query failed:", err?.message ?? err);
    return [];
  }
  if (!Array.isArray(containers)) return [];
  const previews = containers.map(toPreview).filter(Boolean);
  return groupPreviews(withShares(previews, shares));
}

async function inspectContainer(id) {
  const res = await dockerFetch(`/containers/${id}/json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`docker engine responded ${res.status}`);
  return res.json();
}

async function stopContainer(id) {
  const res = await dockerFetch(`/containers/${id}/stop`, { method: "POST" });
  if (!res.ok && res.status !== 304 && res.status !== 404) {
    throw new Error(`docker engine responded ${res.status} stopping ${id.slice(0, 12)}`);
  }
}

/**
 * Stop the preview whose labeled container has the given id: every running
 * container of its compose project, and its share forwarder so nothing of it
 * stays reachable from the internet, or just that container when it belongs to
 * no compose project. The share itself is left for the launcher to retract. Containers are stopped, not removed, so the launcher's own teardown
 * (`preview stop` or its watchdog) still finds and cleans up the stack.
 *
 * Resolves to { status: "stopped", count }, or { status: "not-found" } when the
 * id is malformed, unknown, or not a preview container. Throws on Docker errors.
 */
export async function stopPreview(id) {
  if (typeof id !== "string" || !CONTAINER_ID.test(id)) return { status: "not-found" };
  const container = await inspectContainer(id);
  const labels = (container && container.Config && container.Config.Labels) || {};
  if (!labels["preview.url"]) return { status: "not-found" };

  const composeProject = labels["com.docker.compose.project"];
  const ids = composeProject
    ? (
        await Promise.all([
          fetchContainers([`com.docker.compose.project=${composeProject}`]),
          fetchContainers([`preview.share.project=${composeProject}`]),
        ])
      )
        .flat()
        .map((c) => c.Id)
    : [container.Id];

  await Promise.all(ids.map(stopContainer));
  return { status: "stopped", count: ids.length };
}
