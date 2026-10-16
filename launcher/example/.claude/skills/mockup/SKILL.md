---
name: mockup
description: Mock up the frontend change under discussion as live, hot-reloading pages built from the project's real components, served as a preview of its own (Tailscale URL, Preview Hub card) so variants and states can be played with on a phone. Invoke only when the user types /mockup; never on your own.
---

# /mockup: a mockup is a preview of its own

A mockup is a set of **sample pages** that render the project's own components, served by a
pinned runtime container (Vite, with React, Vue and Svelte hot reload) through the same
`preview` engine as app previews: Tailscale URL, hub card "<project> mockup", 6h watchdog.
You write pages and a manifest; there is no build step and nothing to configure.

Everything lives in `<frontend>/.mockup/`, which ignores itself. Requirements: `docker`,
`tailscale`, the `preview` engine, `git`, and the project's `node_modules` when pages import
its packages; say so when one is missing. Run every command from the frontend root (the
directory with `package.json`, or the web root); `<skill>` is this directory. Arguments: `/mockup` (build and put live), `/mockup stop`, `/mockup status`.

## 1. Subject

Read the conversation backwards: the screen, the variants under debate, the states that
matter (loading, empty, error, open/closed); 2–4 variants of one screen beat one of many.
With nothing to draw from, ask what to mock up; never guess.

## 2. Init

`<skill>/scripts/mockup.sh init` creates `.mockup/` (`pages/`, `shots/`, `manifest.json`).

## 3. Write pages

One screen per page: `.mockup/pages/<slug>.html`, served at `/<slug>`.

- **Plain page**: HTML linking the app's styles by project path, which `/app/` maps to:
  `<link rel="stylesheet" href="/app/web/styles.css">`. Scripts: `<script type="module">`.
- **Component page**: the HTML holds a mount node and
  `<script type="module" src="./<slug>.tsx"></script>`; `pages/<slug>.{js,jsx,ts,tsx}`
  imports the real components through the project's own aliases (`@/components/...`) or
  `/app/src/...`, and the global stylesheet (`import "/app/src/index.css"`). Bare imports
  resolve from the project's `node_modules`; `.vue`, `.svelte`, CSS modules, assets and
  `import.meta.env.*` from its `.env*` work as in any Vite app; Tailwind sees classes used
  only in the pages.
- **Wrap the app's providers** the real entry uses (query client, theme, i18n, store) with
  inline mock data, minus the router and anything that calls a backend.
- **State in the URL**: read `?v=` for the variant and more params for states
  (`?v=b&sheet=1&theme=light`), so every state is a link and survives a reload. Wire
  interactions for real, with a `setTimeout` standing in for the network. Keep the real
  screen's chrome around the change; add a link back to `/`.

Register every page and variant in `.mockup/manifest.json`; the menu at `/` is built from it
and is the only URL the reviewer gets:

```json
{ "title": "Checkout button",
  "pages": [{ "title": "Checkout", "path": "/checkout",
              "variants": [{ "label": "A: current", "query": "?v=a" },
                           { "label": "B: sheet", "query": "?v=b" },
                           { "label": "B, sheet open", "query": "?v=b&sheet=1" }] }] }
```

## 4. Live

`<skill>/scripts/mockup.sh start "Mockup: <what is being compared>"` checks the manifest
(every page file must exist), starts the runtime and prints the URL; the description is the
hub card's subtext. **Start once, then just save**: components keep their state across edits
(Fast Refresh), CSS swaps in place, an HTML or plain `.js` edit reloads the page, a manifest
edit reloads the menu. `curl -fs` the root and one page. A bad import or syntax error shows
in the page's error overlay and in `docker logs mk-mockup-<branch>-web-1`.

## 5. Stills

`<skill>/scripts/mockup.sh shot "/checkout?v=b&sheet=1" b-sheet [390x844]` saves the live page
to `.mockup/shots/b-sheet.png`, listed on the menu. Read one to check nothing is clipped.

## 6. Stop and report

Report the root URL only, one line per variant on what to try, that it is on the hub under
"<project> mockup", and that it stops in 6h or on `/mockup stop`. Never ask the reviewer to
type a path. Then ask which option to build, if that was the question.

`<skill>/scripts/mockup.sh stop` (on `/mockup stop`) runs `preview stop` and deletes
`.mockup/` (`KEEP=1` keeps it); `git status` then shows nothing from the mockup. Do not stop
while the reviewer may still be looking.

## 7. What the runtime cannot compile

**Angular** (its compiler owns the template format); **route-level features** of SvelteKit,
Nuxt and Next (`$app/*`, `next/router`, server components), though their plain Svelte, Vue
and React components work; **project Vite plugins** (SVG components, auto-imports).

For those screens, write a plain page with the component's markup against the app's compiled
CSS under `/app/`, and say in the report that it is a static copy.
