import { mkdirSync } from 'node:fs'
import type { Page } from '@playwright/test'

/** Phone width most mobile-first UIs target, with a tall viewport so a whole screen
 *  fits one still without scrolling. Override per call when a design is desktop-first. */
export const PHONE = { width: 375, height: 1180 }

const OUT = 'public/gallery'

/** One still of `path` into public/gallery/<name>.png. */
export async function shot(
  page: Page,
  name: string,
  path: string,
  opts: { settleMs?: number; viewport?: { width: number; height: number } } = {},
) {
  await page.setViewportSize(opts.viewport ?? PHONE)
  await page.goto(path)
  await page.waitForTimeout(opts.settleMs ?? 800)
  await page.screenshot({ path: `${OUT}/${name}.png` })
}

/**
 * Record an interaction as a burst of frames into public/gallery/frames/<name>/NNN.png.
 * `trigger` performs the action (a click, a keypress); frames are taken before it,
 * during, and after, so the GIF shows the whole transition — a button entering its
 * loading state, a sheet sliding up, a row fading in. `mockup.sh capture` converts
 * bursts to GIF + filmstrip.
 *
 * A screenshot costs ~100ms, longer than most transitions last, so at real speed a
 * sheet would "jump" between two frames. `playbackRate` (default 0.2) slows CSS
 * animations and transitions through CDP so the burst catches them mid-flight.
 * Chromium only; elsewhere it is skipped silently and the burst runs at real speed.
 */
export async function record(
  page: Page,
  name: string,
  path: string,
  trigger: (page: Page) => Promise<void>,
  opts: {
    frames?: number
    intervalMs?: number
    leadFrames?: number
    settleMs?: number
    playbackRate?: number
    viewport?: { width: number; height: number }
  } = {},
) {
  const { frames = 16, intervalMs = 100, leadFrames = 2, settleMs = 800, playbackRate = 0.2 } = opts
  const dir = `${OUT}/frames/${name}`
  mkdirSync(dir, { recursive: true })
  await page.setViewportSize(opts.viewport ?? PHONE)
  await page.goto(path)
  await page.waitForTimeout(settleMs)
  try {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Animation.enable')
    await cdp.send('Animation.setPlaybackRate', { playbackRate })
  } catch {}
  let i = 0
  const snap = async () => {
    await page.screenshot({ path: `${dir}/${String(i++).padStart(3, '0')}.png` })
  }
  for (let k = 0; k < leadFrames; k++) await snap()
  const action = trigger(page)
  for (let k = 0; k < frames; k++) {
    await snap()
    await page.waitForTimeout(intervalMs)
  }
  await action.catch(() => undefined)
  await snap()
}
