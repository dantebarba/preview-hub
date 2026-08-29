---
name: preview
description: Launch (or stop) the local Tailscale-accessible preview of this app so a visual UI/UX change can be reviewed without merging or deploying. Use ONLY after making a change that alters what the frontend looks like.
---

# Local preview

Brings up a preview build of this project and exposes it privately over Tailscale, so a
change can be looked at on any device without merging or deploying. All the real work —
build, bring-up, healthcheck, tunnel — is done by the installed `preview` CLI. This skill
only decides *when* to run it and which subcommand.

What the preview builds and how it comes up is defined per project in two files at the
repo root, not here:

- `.preview/config.sh` — project name, description, which compose file and service carry
  the preview, and the local target Tailscale proxies to.
- `.preview/hooks.sh` — the `on_build` / `on_up` / `on_healthcheck` / `on_down` lifecycle
  hooks. Customize *what gets built and started* there, never in this skill.

## When to invoke (the judgment call)

Invoke on `/preview` (start), or automatically **only when the change you just made alters
what the app renders** — layout, styling, copy, a component, a new or changed screen or
state.

Do **NOT** invoke for:
- API-client wiring, types, or hooks with no visual effect
- dependency bumps, config, build/tooling, or test-only changes
- backend-only or infra changes

When unsure whether a change is visual, ask the user rather than launching.

## How to run

The `preview` CLI has four subcommands:

- Start / refresh after a visual change:  `preview start`
- Stop this branch's preview:             `preview stop`
- State of this branch + all previews:    `preview status`
- Stop every preview on the machine:      `preview killall`

**There is nothing to choose.** One preview per branch, fully deterministic: the
checked-out branch name is hashed into a block of ports and its own isolated compose
project. The same branch always gets the same URL; a different branch always gets a
different, isolated stack. So:

- Run the **bare** command from whatever checkout you are in — main checkout or worktree.
  The CLI reads its own checkout's branch. Never pass a slot or port; there is no such knob.
- `stop` needs no bookkeeping either — it recomputes the same block from the branch. Run it
  from the same checkout.
- Two branches hashing to the same block is rare and **fails loudly** on `start` (it never
  silently shares a stack). If that happens, tell the user.

`start` is **idempotent** — re-running after an edit just rebuilds and refreshes the
existing stack and tunnel in place. Print the Tailscale URL it outputs back to the user so
they can open it (e.g. on their phone).

### Optionally run the slow start in the background

The build + docker + tunnel work is model-agnostic and slow, so you do not need to spend
the main model sitting on it. You may **delegate the `start` run to a background subagent
on a small/fast model (e.g. Haiku):**

- Hand the agent the exact command (`preview start`, run from the repo root of the current
  checkout). Tell it to wait for the command to finish and return **only** the Tailscale
  URL it printed, or the error.
- Its report is not shown to the user, so relay the URL yourself once the agent completes.

Run inline (no subagent) for `status`, `stop`, and `killall` — they are instant.

## What to tell the user

Report the Tailscale URL the CLI printed so they can open the preview. If the project's
hooks configure anything reviewers should know about (a demo login, seeded data, an
auto-stop timer), surface that too.

## Guardrails

- Never run `tailscale serve reset` — it would wipe the user's other Tailscale serve
  mappings. The CLI only ever toggles ports in its own dedicated range.
- Customize build/up/health/down in `.preview/hooks.sh` and project settings in
  `.preview/config.sh`. Do not hardcode project-specific commands into this skill.
