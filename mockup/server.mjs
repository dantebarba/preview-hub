/**
 * The /mockup runtime: one Vite dev server, the same for every project.
 *
 * The frontend root is a read-only source tree at APP_DIR (default `/app`); the mockup is its
 * `.mockup/` directory. Vite runs from this image as a library with its own pinned plugins and
 * never reads the project's Vite config. From the project it only reads sources,
 * `node_modules` (bare imports resolve by walking up from the importer), `.env*`,
 * `tsconfig.json`/`jsconfig.json` paths and `postcss.config.*`. Vite's cache goes to /tmp.
 *
 *   node server.mjs            serve on PORT (default 80) with hot module replacement
 *   node server.mjs --check    validate manifest.json and its pages, then exit
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLogger, createServer } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import loadPostcssConfig from "postcss-load-config";
import { checkManifest, menuPlugin, scratchDir } from "./menu.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP_DIR || "/app";
const POSTCSS_CONFIGS = [
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  "postcss.config.ts",
  "postcss.config.cts",
  "postcss.config.mts",
  ".postcssrc",
  ".postcssrc.json",
  ".postcssrc.js",
  ".postcssrc.cjs",
  ".postcssrc.mjs",
];
const TAILWIND_CONFIGS = ["tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs", "tailwind.config.ts"];
const TAILWIND_V4_IMPORT = /@import\s+(?:url\()?["']tailwindcss(?:\/[^"']*)?["']/;
const PAGE_GLOB = "**/*.{html,js,jsx,ts,tsx,vue,svelte}";
const ENV_PREFIXES = ["VITE_", "REACT_APP_", "PUBLIC_"];
const EXTRA_ASSETS = ["**/*.xlsx", "**/*.xls", "**/*.docx", "**/*.pptx", "**/*.zip"];

/** The comma-separated PREVIEW_ALLOWED_HOSTS as Vite's `allowedHosts` list. */
export function allowedHosts(value) {
  return String(value || "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
}

/** The project's PostCSS config file, or null when it has none. */
export function findPostcssConfig(app) {
  const name = POSTCSS_CONFIGS.find((f) => existsSync(path.join(app, f)));
  if (name) return path.join(app, name);
  const pkg = path.join(app, "package.json");
  if (!existsSync(pkg)) return null;
  try {
    return createRequire(pkg)("./package.json").postcss ? pkg : null;
  } catch {
    return null;
  }
}

/** True when the project has the package installed, resolved the way its own code would. */
function projectHas(app, pkg) {
  try {
    createRequire(path.join(app, "package.json")).resolve(`${pkg}/package.json`);
    return true;
  } catch {
    return existsSync(path.join(app, "node_modules", pkg, "package.json"));
  }
}

/** The major version of the project's own Svelte, which must match the image's compiler. */
function projectSvelteMajor(app) {
  try {
    return Number(createRequire(path.join(app, "package.json"))("svelte/package.json").version.split(".")[0]);
  } catch {
    return null;
  }
}

/** A Tailwind v3 `content` setting with the mockup pages added, in either of its two shapes. */
export function withPages(content, pagesDir) {
  const glob = path.join(pagesDir, PAGE_GLOB);
  if (Array.isArray(content)) return [...content, glob];
  if (content && typeof content === "object") return { ...content, files: [...(content.files || []), glob] };
  return [glob];
}

/**
 * The project's PostCSS plugins, loaded from its config with its own `node_modules`, or null
 * when it has no config. A Tailwind v3 plugin is rebuilt from the project's Tailwind config with
 * the mockup pages added to `content`, so classes used only in a sample are generated.
 */
async function projectPostcss(app) {
  if (!findPostcssConfig(app)) return null;
  const { plugins } = await loadPostcssConfig({ cwd: app, env: "development" }, app);
  const tailwind = tailwindV3(app);
  if (!tailwind) return plugins;
  return plugins.map((p) => (p === tailwind.module || p?.postcssPlugin === "tailwindcss" ? tailwind.plugin : p));
}

/**
 * The project's Tailwind v3 module and a PostCSS plugin built from its config with the mockup
 * pages added to `content`, or null when the project has no Tailwind v3 config.
 */
function tailwindV3(app) {
  const name = TAILWIND_CONFIGS.find((f) => existsSync(path.join(app, f)));
  if (!name) return null;
  const require = createRequire(path.join(app, "package.json"));
  try {
    const module = require("tailwindcss");
    const config = require("tailwindcss/loadConfig")(path.join(app, name));
    const content = withPages(config.content, path.join(scratchDir(app), "pages"));
    return { module, plugin: module({ ...config, content }) };
  } catch (e) {
    console.warn(`[mockup] Tailwind content not extended with the pages: ${e.message}`);
    return null;
  }
}

/**
 * Tailwind v4 skips gitignored files, and `.mockup/` ignores itself, so a stylesheet that
 * imports `tailwindcss` gets an `@source` for the pages, and for the project root in case its
 * scanner starts from the Vite root.
 */
export function tailwindV4Sources({ app }) {
  const sources = `\n@source "${path.join(scratchDir(app), "pages")}";\n@source "${app}";\n`;
  return {
    name: "mockup-tailwind-sources",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!/\.css$/.test(file) || file.includes("/node_modules/") || !TAILWIND_V4_IMPORT.test(code)) return null;
      return { code: code + sources, map: null };
    },
  };
}

/**
 * TypeScript configs apply `paths` only to the files they `include`, and no project includes
 * `.mockup/pages/`. For each `tsconfig*.json`/`jsconfig*.json` at the project root, write a
 * wrapper under `dir` that extends it and includes its own directory; returns the wrappers.
 */
function pageTsconfigs(app, dir) {
  const configs = readdirSync(app).filter((f) => /^[tj]sconfig(\..+)?\.json$/.test(f));
  return configs.map((name, i) => {
    const wrapper = path.join(dir, String(i), name.startsWith("j") ? "jsconfig.json" : "tsconfig.json");
    mkdirSync(path.dirname(wrapper), { recursive: true });
    writeFileSync(wrapper, JSON.stringify({ extends: path.join(app, name), include: ["**/*"], exclude: [] }));
    return wrapper;
  });
}

/**
 * Resolve a bare import from a page as if a file beside one of the wrappers had made it, so the
 * wrapped config's `paths` and `baseUrl` apply; anything they do not map resolves as usual.
 */
function pageAliases({ app, wrappers }) {
  const pagesDir = path.join(scratchDir(app), "pages") + path.sep;
  const anchors = wrappers.map((w) => path.join(path.dirname(w), "page.tsx"));
  return {
    name: "mockup-page-aliases",
    enforce: "pre",
    async resolveId(id, importer, options) {
      if (!importer?.startsWith(pagesDir) || /^[./\0]/.test(id) || id.includes(":")) return null;
      for (const anchor of anchors) {
        const resolved = await this.resolve(id, anchor, { ...options, skipSelf: true });
        if (resolved && !resolved.external && path.isAbsolute(resolved.id)) return resolved;
      }
      return null;
    },
  };
}

/** Import a package from the project's own `node_modules`. */
async function importFromProject(app, pkg) {
  const require = createRequire(path.join(app, "package.json"));
  return import(pathToFileURL(require.resolve(pkg)).href);
}

/**
 * The plugin list: the menu and tsconfig paths always, for the project's sources and for the
 * pages; React (Fast Refresh), Vue and Svelte when the project has them; the project's own
 * `@tailwindcss/vite` when it styles with that instead of PostCSS.
 */
async function plugins(app, postcss, cacheDir) {
  const list = [menuPlugin({ app }), tailwindV4Sources({ app }), tsconfigPaths({ root: app, loose: true })];
  const wrappers = pageTsconfigs(app, path.join(cacheDir, "tsconfig"));
  if (wrappers.length) list.push(pageAliases({ app, wrappers }), tsconfigPaths({ root: app, projects: wrappers, loose: true }));
  if (projectHas(app, "react")) list.push(react());
  if (projectHas(app, "vue")) list.push((await import("@vitejs/plugin-vue")).default());
  if (projectHas(app, "svelte")) {
    if (projectSvelteMajor(app) === 5) list.push((await import("@sveltejs/vite-plugin-svelte")).svelte());
    else console.warn("[mockup] .svelte files need Svelte 5; this project's Svelte is not compiled");
  }
  const postcssTailwind = postcss?.some((p) => /tailwind/.test(p?.postcssPlugin || ""));
  if (!postcssTailwind && projectHas(app, "@tailwindcss/vite")) {
    list.push((await importFromProject(app, "@tailwindcss/vite")).default());
  }
  return list;
}

/** Vite's logger, minus its advice to drop vite-tsconfig-paths, which the pages need. */
function logger() {
  const log = createLogger();
  const warnOnce = log.warnOnce.bind(log);
  log.warnOnce = (msg, opts) => (msg.includes("vite-tsconfig-paths") ? undefined : warnOnce(msg, opts));
  return log;
}

/** The whole Vite config for a project at `app`. */
async function viteConfig({ app, port, hosts, cacheDir }) {
  const postcss = await projectPostcss(app);
  return {
    configFile: false,
    root: scratchDir(app),
    appType: "mpa",
    publicDir: false,
    cacheDir,
    envDir: app,
    envPrefix: ENV_PREFIXES,
    clearScreen: false,
    customLogger: logger(),
    assetsInclude: EXTRA_ASSETS,
    css: { postcss: { plugins: postcss || [] } },
    server: {
      host: "0.0.0.0",
      port,
      strictPort: true,
      allowedHosts: hosts,
      fs: { allow: [app, cacheDir, HERE] },
    },
    plugins: await plugins(app, postcss, cacheDir),
  };
}

/** Start the server; resolves to the Vite dev server once it listens. */
export async function start({
  app = APP,
  port = Number(process.env.PORT || 80),
  hosts = allowedHosts(process.env.PREVIEW_ALLOWED_HOSTS),
  cacheDir = process.env.MOCKUP_CACHE_DIR || "/tmp/vite",
} = {}) {
  process.chdir(app);
  const server = await createServer(await viteConfig({ app, port, hosts, cacheDir }));
  await server.listen();
  return server;
}

/** `--check`: print what is wrong with the manifest and exit non-zero, or exit 0. */
function check(app) {
  const problems = checkManifest(scratchDir(app));
  for (const p of problems) console.error(`mockup: ${p}`);
  if (!problems.length) console.log("mockup: manifest ok");
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes("--check")) {
    check(APP);
  } else {
    const server = await start();
    server.printUrls();
  }
}
