---
name: mockup
description: Mock up the frontend change under discussion as a live, tappable page built from the project's real components, run as a preview of its own (ephemeral Docker container, Tailscale URL, Preview Hub card), so variants, states and transitions (a button entering its loading state, a sheet sliding up) can be played with on a phone. Works on any Vite frontend without touching tracked files; optionally captures stills and GIFs into the same preview. Invoked only by the user with /mockup; never auto-triggered.
disable-model-invocation: true
---

# /mockup — a mockup is a preview of its own

Design questions are cheaper to settle by playing than by describing. A mockup here is a
**sample page rendered by the project's own components**, built into a static site by
the project's own toolchain, served by an ephemeral nginx container and opened on the
reviewer's phone through the same `preview` engine and Preview Hub the app previews use. It is live: they tap the
button, watch the sheet slide, see the spinner. Stills and GIFs are the optional second
step, for a side-by-side that outlives the conversation.

Everything lives in `<frontend>/.mockup/`, a scratch directory that ignores itself and
carries its own `.preview/`, so no tracked file is ever edited and the engine treats it
as one more preview: own port block and compose project (`mk-mockup-<branch>`), hub
card, 6h watchdog, `preview status`/`killall` visibility. `stop` removes the container,
its image and the directory.

Requirements: `docker`, `tailscale`, the `preview` engine, `python3`, and the project's
own toolchain installed (`node_modules`); `@playwright/test` with Chromium and Pillow
only for images. Say so
when one is missing instead of improvising. All commands run from the frontend project
root; `<skill>` is this directory.

## 1. Subject

Read the conversation backwards. If a frontend change, layout question or UI option is
being discussed, that is the subject: the screen, the variants under debate, the states
and interactions that matter (loading, empty, error, pressed, open/closed). Prefer 2–4
variants of one screen over one variant of many. With no frontend discussion to draw
from, ask with AskUserQuestion what to mock up — never guess.

Arguments: `/mockup` builds and puts it live; `/mockup images` also captures a gallery;
`/mockup stop` tears everything down (`stop keep` leaves the directory); `/mockup status`.

## 2. Scaffold, write the build recipe, write the sample page

`<skill>/scripts/mockup.sh init` creates `.mockup/` with the preview project, the
capture helpers and a stub `build.sh`. The runtime's only contract is that
`.mockup/build.sh` leaves a static site in `.mockup/dist/`; nothing about the
project's framework is shipped with the skill, on purpose. Infer the recipe from the
project once per `init`, and write it:

1. **Find the toolchain.** `package.json` scripts and the config at the project root
   say which it is (vite, astro, next, svelte-kit, ng, webpack…). The scratch root
   must be built by the *same* tool with the *same* config, or the samples will not
   look like the app.
2. **Make a scratch root inside `.mockup/`** that the tool can build on its own: an
   entry that mounts one page per `*Samples.<ext>` file so the file name is the URL
   (`CheckoutButtonSamples.tsx` → `/checkout-button`), plus an index at `/`
   listing them and linking `/gallery/`. Reuse the project's config by importing it,
   then override the root and the output dir (`./dist`) and drop build-only or
   service-worker plugins (PWA, Sentry, compression), which have nothing to do here and
   some of which refuse to run outside the project root.
3. **Bring the app's look with it.** Import the app's global stylesheet and any
   side-effect setup (i18n, theme), and mirror the provider tree the real entry wraps
   the app in — minus the app router and anything that needs a backend; add the router
   provider if the app's components use `Link`. Utility-CSS scanners are the usual
   trap: Tailwind v4 scans the build root and skips gitignored files, so from
   `.mockup/` it sees neither `../src` nor the samples — a scratch stylesheet that
   imports the app's and adds `@source '../src'; @source './';` fixes it. A sample
   rendered without theme or translations is judged unfairly.
4. **Write `build.sh`** to run that build into `./dist`, using the project's binary
   from `../node_modules/.bin/`. When a standalone page is not cheap to build with the
   framework, hand-write `dist/index.html` and friends against the app's compiled CSS
   and say so in the report; a slightly less faithful mockup beats none.

Then write `.mockup/<Slug>Samples.<ext>` with a default export. Import the project's
real components from `../src/...`; read `?v=` and other query params for variants and
states so every state is a shareable URL; **wire interactions for real** with a
`setTimeout` standing in for the network, because the reviewer wants the motion; inline
mock data, no API; keep the real screen's surrounding chrome so the variant is judged in
context; a back link to `/` for hopping between pages. Reuse locale strings so wording
matches.

**Register every page, variant and state in `.mockup/manifest.json`.** The runtime
generates the menu served at `/` from it — the only URL the reviewer ever receives, and
what the hub card opens — so nothing is reachable only by typing a path:

```json
{ "title": "Checkout button",
  "pages": [{ "title": "Checkout button", "path": "/checkout-button",
              "variants": [{ "label": "A — current", "query": "?v=a" },
                           { "label": "B — sheet", "query": "?v=b" },
                           { "label": "B, light theme", "query": "?v=b&theme=light" }] }],
  "gallery": [] }
```

## 3. Live

`<skill>/scripts/mockup.sh start "Mockup: <what is being compared>"` — the description
becomes the hub card's subtext. It runs `build.sh`, regenerates the menu from the
manifest, brings up nginx on loopback, maps it over Tailscale and prints the URL.
Idempotent: after editing a page or the manifest run it again; only the build repeats
and the container keeps serving. Pages are static once built, so interactions still run
— only the edit loop needs a restart. `curl -fs` the root and one page to be sure they
render (a bad import fails the build loudly). The reviewer gets **one URL, the root**:
the menu lists every page, variant and state, and the gallery once there is one.

## 4. Images (`/mockup images`)

Write `.mockup/capture.spec.ts` with the bundled helpers:

```ts
import { test } from '@playwright/test'
import { shot, record } from './helpers'
test('c', async ({ page }) => {
  await shot(page, 'b-sheet-open', '/checkout-button?v=c&sheet=1')
  await record(page, 'b-pay-opens-sheet', '/checkout-button?v=c',
    p => p.getByRole('button', { name: 'Pay' }).click())
})
```

`shot` is a 375×1180 still; `record` is a frame burst around the trigger, with CSS
animations slowed to 0.2× through Chromium's devtools protocol — a screenshot costs
~100ms, longer than most transitions, so without that a sheet just "jumps". Add the
images to the manifest's `gallery` list (`[{"title","caption","files":[...]}]` in reading
order; files are names under `public/gallery/`), then `<skill>/scripts/mockup.sh capture`:
it runs the spec against the running preview, turns bursts into `<name>.gif` +
`<name>-strip.png`, and regenerates the gallery and the menu, both mounted live into the
container — no rebuild, and the gallery appears as an "Images" entry on the menu. Read a
PNG or two to check nothing is clipped before sharing.

## 5. Stop and report

`<skill>/scripts/mockup.sh stop` runs `preview stop` (container down, image removed
when nothing else uses it, mapping off, hub card gone) and deletes `.mockup/`. Do not
stop on your own while the reviewer may still be looking; the watchdog stops it after
6h. After stopping, `git status` shows nothing from the mockup.

Report the root URL only — everything else is a tap away on the menu — with one line
per variant on what to try there, that it is on the hub under "<project> mockup", and
that it auto-stops in 6h or on `/mockup stop`. Never ask the reviewer to append a path.
Then ask which option to build, if that was the question.
