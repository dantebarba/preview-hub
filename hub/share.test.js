/**
 * Unit tests for sharing from the hub: input validation, and the ordering and
 * rollback of share / unshare / stop over a stubbed edge and Docker side.
 * Run with `bun test` from hub/.
 */

import { describe, expect, test } from "bun:test";
import {
  ShareError,
  createSharing,
  credentialMounts,
  parseAdd,
  parseHours,
  shareConfig,
  splitImage,
} from "./share.js";

const ID = "a".repeat(64);
const EDGE_LABELS = {
  "preview.url": "https://box.example:45000/",
  "com.docker.compose.project": "acme-main",
  "preview.edge.label": "acme-main",
  "preview.edge.port": "45000",
  "preview.edge.target": "127.0.0.1:45001",
};
const ADD_ANSWER = JSON.stringify({
  label: "acme-main",
  host: "acme-main.example.com",
  url: "https://acme-main.example.com/?k=secret",
  port: 45000,
  expires: 1800003600,
});

/** Build a sharing instance over recording stubs; `opts` overrides pieces of them. */
function harness(opts = {}) {
  const calls = [];
  const forwarders = new Map(Object.entries(opts.forwarders || {}));
  const edge = async (verb, ...args) => {
    calls.push(["edge", verb, ...args]);
    if (opts.edge) return opts.edge(verb, ...args);
    if (verb === "add") return ADD_ANSWER;
    if (verb === "list") return JSON.stringify([JSON.parse(ADD_ANSWER)]);
    return "";
  };
  const docker = {
    inspectPreview: async (id) => (id === ID ? { Config: { Labels: opts.labels || EDGE_LABELS } } : null),
    projectContainers: async () => opts.containers || [],
    forwarderLabels: async (name) => forwarders.get(name) || null,
    start: async (name, edgeInfo, project, share) => {
      calls.push(["start", name, share.host, share.expires]);
      forwarders.set(name, { "preview.share.label": edgeInfo.label });
    },
    remove: async (name) => {
      calls.push(["remove", name]);
      forwarders.delete(name);
    },
    stopPreview: async () => {
      calls.push(["stopPreview"]);
      return { status: "stopped", count: 1 };
    },
  };
  const config = { enabled: opts.enabled ?? true };
  return { calls, forwarders, sharing: createSharing({ config, edge, docker }) };
}

describe("input validation", () => {
  test("parseHours accepts 1 to 72 whole hours only", () => {
    expect(parseHours(4)).toBe(4);
    expect(parseHours("72")).toBe(72);
    for (const bad of [0, 73, 1.5, "x", null]) expect(() => parseHours(bad)).toThrow(ShareError);
  });

  test("credentialMounts lists bind-mounted .env files but not examples", () => {
    const files = credentialMounts([
      {
        Mounts: [
          { Type: "bind", Source: "/src/app/.env" },
          { Type: "bind", Source: "/src/app/.envrc" },
          { Type: "bind", Source: "/src/app/.env.local" },
          { Type: "bind", Source: "/src/app/.env.example" },
          { Type: "volume", Source: "/var/lib/docker/volumes/x/.env" },
          { Type: "bind", Source: "/src/app" },
        ],
      },
    ]);
    expect(files).toEqual(["/src/app/.env", "/src/app/.envrc", "/src/app/.env.local"]);
  });

  test("splitImage separates the tag, not a registry port", () => {
    expect(splitImage("alpine/socat:latest")).toEqual({ name: "alpine/socat", tag: "latest" });
    expect(splitImage("registry:5000/socat")).toEqual({ name: "registry:5000/socat", tag: "latest" });
  });

  test("parseAdd keeps host and expiry and rejects anything else", () => {
    expect(parseAdd(ADD_ANSWER)).toEqual({ host: "acme-main.example.com", expires: 1800003600 });
    expect(() => parseAdd("not json")).toThrow(ShareError);
    expect(() => parseAdd(JSON.stringify({ host: "x/y", url: "u", expires: 1 }))).toThrow(ShareError);
  });

  test("shareConfig is enabled only with every setting and both files", () => {
    const env = { PREVIEW_SHARE_SSH: "user@edge", PREVIEW_SHARE_ADDR: "10.0.0.2" };
    expect(shareConfig(env, () => true).enabled).toBe(true);
    expect(shareConfig(env, () => false).enabled).toBe(false);
    expect(shareConfig({ PREVIEW_SHARE_SSH: "user@edge" }, () => true).enabled).toBe(false);
  });
});

describe("share", () => {
  test("starts a pending forwarder, adds, then relabels it with host and expiry", async () => {
    const { calls, sharing } = harness();
    const result = await sharing.share(ID, 4, false);
    expect(result).toEqual({ shared: true, host: "acme-main.example.com", expires: 1800003600 });
    expect(calls).toEqual([
      ["start", "acme-main-share", "", ""],
      ["edge", "add", "acme-main", 45000, 4],
      ["start", "acme-main-share", "acme-main.example.com", 1800003600],
    ]);
  });

  test("removes the forwarder it started when add fails", async () => {
    const { calls, sharing } = harness({
      edge: async () => {
        throw new ShareError("share add failed", 502);
      },
    });
    await expect(sharing.share(ID, 4, false)).rejects.toThrow("share add failed");
    expect(calls.at(-1)).toEqual(["remove", "acme-main-share"]);
  });

  test("drops the forwarder and the share when relabelling it fails", async () => {
    const calls = [];
    let starts = 0;
    const failing = createSharing({
      config: { enabled: true },
      edge: async (verb, ...args) => {
        calls.push(["edge", verb, ...args]);
        return verb === "add" ? ADD_ANSWER : "";
      },
      docker: {
        inspectPreview: async () => ({ Config: { Labels: EDGE_LABELS } }),
        projectContainers: async () => [],
        forwarderLabels: async () => null,
        start: async () => {
          starts += 1;
          if (starts === 2) throw new ShareError("forwarder exited", 502);
        },
        remove: async (name) => calls.push(["remove", name]),
        stopPreview: async () => ({ status: "stopped", count: 1 }),
      },
    });
    await expect(failing.share(ID, 4, false)).rejects.toThrow("forwarder exited");
    expect(calls.slice(-2)).toEqual([
      ["edge", "remove", "acme-main"],
      ["remove", "acme-main-share"],
    ]);
  });

  test("keeps an existing forwarder when a re-share fails", async () => {
    const { calls, sharing } = harness({
      forwarders: { "acme-main-share": { "preview.share.label": "acme-main" } },
      edge: async () => {
        throw new ShareError("share add failed", 502);
      },
    });
    await expect(sharing.share(ID, 4, false)).rejects.toThrow();
    expect(calls.some(([kind]) => kind === "remove")).toBe(false);
  });

  test("asks for confirmation when a .env is mounted, and shares once confirmed", async () => {
    const containers = [{ Mounts: [{ Type: "bind", Source: "/src/.env" }] }];
    const first = harness({ containers });
    expect(await first.sharing.share(ID, 4, false)).toEqual({ needsConfirm: true, files: ["/src/.env"] });
    expect(first.calls).toEqual([]);
    const second = harness({ containers });
    expect((await second.sharing.share(ID, 4, true)).shared).toBe(true);
  });

  test("refuses when sharing is off, or the preview has no edge labels", async () => {
    await expect(harness({ enabled: false }).sharing.share(ID, 4, true)).rejects.toMatchObject({ status: 409 });
    const labels = { "preview.url": "u", "com.docker.compose.project": "acme-main" };
    await expect(harness({ labels }).sharing.share(ID, 4, true)).rejects.toMatchObject({ status: 409 });
    await expect(harness().sharing.share("nope", 4, true)).rejects.toMatchObject({ status: 404 });
  });
});

describe("unshare, link and stop", () => {
  const shared = { forwarders: { "acme-main-share": { "preview.share.label": "acme-main" } } };

  test("unshare removes on the edge, then the forwarder", async () => {
    const { calls, sharing } = harness(shared);
    expect(await sharing.unshare(ID)).toEqual({ unshared: true });
    expect(calls).toEqual([
      ["edge", "remove", "acme-main"],
      ["remove", "acme-main-share"],
    ]);
  });

  test("unshare still removes the forwarder when the edge fails", async () => {
    const { calls, sharing } = harness({
      ...shared,
      edge: async () => {
        throw new ShareError("share remove failed", 502);
      },
    });
    const result = await sharing.unshare(ID);
    expect(result.unshared).toBe(true);
    expect(result.warning).toContain("share remove failed");
    expect(calls.at(-1)).toEqual(["remove", "acme-main-share"]);
  });

  test("unshare of a preview that is not shared is a 404", async () => {
    await expect(harness().sharing.unshare(ID)).rejects.toMatchObject({ status: 404 });
  });

  test("link returns the edge's URL for the preview's label", async () => {
    const { sharing } = harness(shared);
    expect(await sharing.link(ID)).toEqual({
      url: "https://acme-main.example.com/?k=secret",
      expires: 1800003600,
    });
  });

  test("stop retracts the share before stopping the stack", async () => {
    const { calls, sharing } = harness(shared);
    expect(await sharing.stop(ID)).toEqual({ status: "stopped", count: 1 });
    expect(calls).toEqual([
      ["edge", "remove", "acme-main"],
      ["remove", "acme-main-share"],
      ["stopPreview"],
    ]);
  });

  test("stop without share settings still drops the forwarder, with a warning", async () => {
    const { calls, sharing } = harness({ ...shared, enabled: false });
    const result = await sharing.stop(ID);
    expect(result.warning).toContain("not configured");
    expect(calls).toEqual([["remove", "acme-main-share"], ["stopPreview"]]);
  });
});
