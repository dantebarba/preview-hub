/**
 * Preview discovery via the Docker Engine API.
 *
 * listPreviews() queries running containers carrying the required `preview.url`
 * label, then maps each to a preview record, dedups so every distinct compose
 * project contributes at most one record, groups the records by `preview.project`
 * and sorts them into the exact shape the hub serves at GET /api/previews.
 *
 * Docker access is best-effort: an unreachable engine or a non-OK response yields
 * an empty list (logged to stderr) rather than a thrown error, so the PWA can
 * still render an empty state.
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

async function fetchContainers() {
  const { url, unix } = dockerEndpoint();
  const filters = encodeURIComponent(JSON.stringify({ label: ["preview.url"] }));
  const target = `${url.replace(/\/$/, "")}/containers/json?filters=${filters}`;
  const res = await fetch(target, unix ? { unix } : {});
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
 * List active previews grouped and sorted per the hub backend contract.
 * Returns [] on any Docker error.
 */
export async function listPreviews() {
  let containers;
  try {
    containers = await fetchContainers();
  } catch (err) {
    console.error("[preview-hub] docker query failed:", err?.message ?? err);
    return [];
  }
  if (!Array.isArray(containers)) return [];
  return groupPreviews(containers.map(toPreview).filter(Boolean));
}
