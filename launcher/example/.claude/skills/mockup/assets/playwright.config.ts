import { defineConfig, devices } from '@playwright/test'

/**
 * Capture config for /mockup: runs ./capture.spec.ts against the already-running
 * scratch server on MOCKUP_PORT. Chromium, with motion left on — most e2e configs
 * emulate `reducedMotion: reduce`, which strips exactly the transitions a mockup
 * wants to show — so the helper can slow CSS transitions down through CDP.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /capture\.spec\.ts/,
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir: './.pw-output',
  use: {
    baseURL: `http://127.0.0.1:${process.env.MOCKUP_PORT ?? '5173'}`,
    headless: true,
    contextOptions: { reducedMotion: 'no-preference' },
  },
  projects: [{ name: 'mockup', use: { ...devices['Desktop Chrome'], serviceWorkers: 'block' } }],
})
