/**
 * Unit tests for what the hub reads off container labels: the share state on
 * the launcher's forwarder containers and a preview's review page. Run with
 * `bun test` (or `npm test`) from hub/.
 */

import { describe, expect, test } from "bun:test";
import { edgeOf, reviewOf, sharesByProject, toPreview, withShares } from "./docker.js";

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

describe("reviewOf", () => {
  const URL_LABEL = "https://box.tailnet.ts.net:40123/";

  function review(path, url = URL_LABEL) {
    return reviewOf({ "preview.url": url, "preview.review": path });
  }

  test("joins the path onto preview.url", () => {
    expect(review("/stills")).toBe("https://box.tailnet.ts.net:40123/stills");
  });

  test("keeps a subpath of preview.url, with or without its trailing slash", () => {
    expect(review("/stills", "https://box.tailnet.ts.net/app/")).toBe("https://box.tailnet.ts.net/app/stills");
    expect(review("/stills", "https://box.tailnet.ts.net/app")).toBe("https://box.tailnet.ts.net/app/stills");
  });

  test("keeps a query and a fragment", () => {
    expect(review("/stills?open=1#05-invite-user")).toBe(
      "https://box.tailnet.ts.net:40123/stills?open=1#05-invite-user"
    );
  });

  test("is null without the label", () => {
    expect(reviewOf({ "preview.url": URL_LABEL })).toBeNull();
    expect(review("")).toBeNull();
    expect(reviewOf(null)).toBeNull();
  });

  test("refuses anything but a plain absolute path", () => {
    for (const path of [
      "stills",
      "//evil.example/stills",
      "/\\evil.example",
      "https://evil.example/stills",
      "javascript:alert(1)",
      "/sti lls",
      "/stills\n",
    ]) {
      expect(review(path)).toBeNull();
    }
  });

  test("refuses a preview.url that is not http(s)", () => {
    expect(review("/stills", "javascript:alert(1)")).toBeNull();
    expect(review("/stills", "not a url")).toBeNull();
  });
});

describe("toPreview", () => {
  const labels = {
    "preview.url": "https://box.tailnet.ts.net:40123/",
    "preview.project": "Acme mockup",
    "preview.branch": "main",
  };

  test("carries the review URL of a preview that names a review page", () => {
    const preview = toPreview({ Id: "abc", Labels: { ...labels, "preview.review": "/stills" } });
    expect(preview.review).toBe("https://box.tailnet.ts.net:40123/stills");
  });

  test("has no review key without the label, or with a malformed one", () => {
    expect("review" in toPreview({ Id: "abc", Labels: labels })).toBe(false);
    expect("review" in toPreview({ Id: "abc", Labels: { ...labels, "preview.review": "//evil.example" } })).toBe(false);
  });
});
