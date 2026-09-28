/**
 * Unit tests for the share state the hub reads off the launcher's forwarder
 * containers. Run with `bun test` from hub/.
 */

import { describe, expect, test } from "bun:test";
import { edgeOf, sharesByProject, withShares } from "./docker.js";

const NOW = 1_800_000_000_000;

function forwarder(labels) {
  return { Labels: labels };
}

describe("sharesByProject", () => {
  test("maps a forwarder's compose project to its host and expiry", () => {
    const shares = sharesByProject(
      [
        forwarder({
          "preview.share.project": "acme-main",
          "preview.share.label": "acme-main",
          "preview.share.host": "acme-main.example.com",
          "preview.share.expires": "1800003600",
        }),
      ],
      NOW
    );
    expect(shares.get("acme-main")).toEqual({ host: "acme-main.example.com", expires: 1800003600 });
  });

  test("leaves out forwarders still waiting for the edge", () => {
    const shares = sharesByProject(
      [forwarder({ "preview.share.project": "acme-main", "preview.share.host": "", "preview.share.expires": "" })],
      NOW
    );
    expect(shares.size).toBe(0);
  });

  test("leaves out expired shares", () => {
    const shares = sharesByProject(
      [
        forwarder({
          "preview.share.project": "acme-main",
          "preview.share.host": "acme-main.example.com",
          "preview.share.expires": String(NOW / 1000),
        }),
      ],
      NOW
    );
    expect(shares.size).toBe(0);
  });

  test("leaves out a host that is not a plain hostname", () => {
    const shares = sharesByProject(
      [
        forwarder({
          "preview.share.project": "acme-main",
          "preview.share.host": "acme-main.example.com/?k=secret",
          "preview.share.expires": "1800003600",
        }),
      ],
      NOW
    );
    expect(shares.size).toBe(0);
  });

  test("tolerates a non-array input", () => {
    expect(sharesByProject(null, NOW).size).toBe(0);
  });
});

describe("withShares", () => {
  test("attaches a share only to the preview of its compose project", () => {
    const shares = new Map([["acme-main", { host: "acme-main.example.com", expires: 1800003600 }]]);
    const [shared, plain, orphan] = withShares(
      [
        { branch: "main", composeProject: "acme-main" },
        { branch: "dev", composeProject: "acme-dev" },
        { branch: "x", composeProject: "" },
      ],
      shares
    );
    expect(shared.share).toEqual({ host: "acme-main.example.com", expires: 1800003600 });
    expect(plain.share).toBeUndefined();
    expect(orphan.share).toBeUndefined();
  });
});

describe("edgeOf", () => {
  const labels = {
    "preview.edge.label": "acme-main",
    "preview.edge.port": "45000",
    "preview.edge.target": "127.0.0.1:45001",
  };

  test("reads label, port and target", () => {
    expect(edgeOf(labels)).toEqual({ label: "acme-main", port: 45000, target: "127.0.0.1:45001" });
  });

  test("rejects a missing or malformed piece", () => {
    expect(edgeOf({})).toBeNull();
    expect(edgeOf({ ...labels, "preview.edge.label": "Acme_Main" })).toBeNull();
    expect(edgeOf({ ...labels, "preview.edge.port": "8080" })).toBeNull();
    expect(edgeOf({ ...labels, "preview.edge.target": "127.0.0.1:45001; id" })).toBeNull();
  });
});
