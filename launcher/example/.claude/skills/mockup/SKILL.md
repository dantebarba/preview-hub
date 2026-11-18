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

`<skill>/scripts/mockup.sh init` creates `.mockup/` (`pages/`, `shots/`, `stills/`, `review/`,
`manifest.json`).

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

`<skill>/scripts/mockup.sh shot "/checkout?v=b&sheet=1" b-sheet --viewport mobile --viewport
desktop --title "B, sheet open"` adds the live page as a still, one **variant** per
`--viewport`; the same name and variant again makes its next revision. Viewports are the
presets `mobile` (390×844, the default), `mobile-s` (375×812, iPhone mini), `tablet`,
`desktop`, or `WxH[@dpr][+touch]`; each shot is a real device (pixel ratio, touch, mobile UA).
Shoot the smallest matrix that covers the change: the viewports it affects; a `--tag dark`
call and a separate `--tag light` call (never both in one) only when it touches both themes;
free tags (`--tag empty`) for other states; `--full-page` for screens that scroll, never a
guessed height (it grows the viewport to fit an app shell's inner scroller, and shoots the
viewport while a dialog is open). Read the PNGs it names to check nothing is clipped. The
viewer is `/stills`; never write a stills page.

**More than a couple of stills, or any still that needs an interaction**, go in
`.mockup/shots.mjs` and are shot with `preview stills shoot` (`--only '<regex>'` for some):

```js
export default {
  defaults: { viewports: ["desktop", "mobile"], fullPage: true },
  ignore: [/Google Maps/],
  shots: [
    { name: "03-users", title: "Settings › Users", path: "/users" },
    { name: "05-invite-user", title: "Invite user", path: "/users", viewports: ["desktop"],
      steps: async (page) => {
        await page.click("Invite user");
        await page.type("[role=dialog] input[type=email]", "luis@example.com");
        await page.waitFor("[role=dialog] button", { text: "Send invitation" });
      } },
  ],
};
```

Steps: `click(textOrSelector, { within })`, `hover`, `type(selector, text)`, `press(key)`,
`waitFor(textOrSelector, { text, gone, timeout })`, `evaluate(fnOrString)` (a string sees
`$$` and `byText`); each action waits for the page to settle, so `sleep(ms)` is a last resort.
`tags: [["dark"], ["light"]]` shoots both themes. Read its JSON lines: a failed shot names why
(a missing target), `exceptions` and `consoleErrors` flag a broken page, `added` is `rev <n>`
or `unchanged`, `file` the PNG to check. Use presets with `fullPage`, never guessed heights,
and no shooter scripts outside the project.

## 6. Report, listen, answer

Report the root URL, one line per variant on what to try, the stills at `<url>/stills` (the
card's **Review**), that it is on the hub under "<project> mockup" and stops in 6h or on
`/mockup stop`. Never ask the reviewer to type a path. Then ask which option to build, if
that was the question.

With stills out, start `preview review watch` under Monitor before reporting, so no remark is
missed. Answer its `thread`, `reply` and `reopen` lines (`#13 thread 3f9a0c1e 05-invite
[mobile+dark] r1 box ... Ana (guest): "..."`); skip the rest. Resolving is the human's.

For each: `preview review working <id> --note "<what>"` first, so the reviewer sees you on it;
`preview review show <id>` and Read its `marked` PNG (else `image`); fix the page; re-shoot
that still, same name, same variant (`mobile+dark` is `--viewport mobile --tag dark`,
`custom-390x700` is `--viewport 390x700`; `source.path`, `viewport.fullPage` and `tags` are in
`preview stills ls --json`), so the viewer flags it "changed since reviewed"; then `preview
review reply <id> "Ana, <what changed>"` by the reviewer's name, which ends working
(`preview review idle` if you stop without replying). After a restart, `watch --since <seq>`.

**Keep the stills** when the work should outlive the mockup (a mockup branch, an epic's
stills): before stopping, `preview stills export docs/mockups/<topic> --readme`, then commit
the folder, `.review/` included so the remarks and revisions travel with it, and `shots.mjs`,
which the export copies beside the stills. The folder reads
back as the same stills, revisions and remarks, and `preview stills serve <dir>` reviews it
later with no mockup running. A folder that holds a `.review/` already is refused: export into
a new folder, or fix its stills in place as below. When unsure whether they should outlive it,
ask.

**Remarks on a folder** (an exported one, or any folder of images served with `preview stills
serve <dir>`): listen with `preview review watch --dir <dir>` under Monitor and answer as
above, every `preview review` and `preview stills ls` command taking `--dir <dir>`. To fix a
still, rewrite its image in place under the same file name (`<name>@<variant>.png`, or
`<name>.png` for a still whose one variant is `desktop`); the viewer shows it as the next
revision. With the mockup still up, `mockup.sh shot` (or `preview stills shoot --only`) and
copy the PNG it names over that file.
A read-only folder refuses every write: say so instead of retrying.

`<skill>/scripts/mockup.sh stop` (on `/mockup stop`) runs `preview stop` and deletes
`.mockup/`, remarks included (`KEEP=1` keeps it); `git status` then shows nothing from the
mockup. Do not stop while the reviewer may still be looking.

## 7. What the runtime cannot compile

**Angular** (its compiler owns the template format); **Svelte before 5**; **route-level
features** of SvelteKit, Nuxt and Next (`$app/*`, `next/router`, server components), though
their plain Svelte, Vue and React components work; **project Vite plugins** (SVG components).

For those screens, write a plain page with the component's markup against the app's compiled
CSS under `/app/`, and say in the report that it is a static copy.
