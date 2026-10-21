// Bundles src/extension.ts -> dist/extension.js (CommonJS, Node 20 = VS Code 1.100's Electron 34).
//   node esbuild.mjs               development build with a source map
//   node esbuild.mjs --production  minified, no source map (vscode:prepublish)
//   node esbuild.mjs --watch       rebuild on change; prints the [watch] lines .vscode/tasks.json matches
import { rmSync } from "node:fs";
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

if (production) {
  rmSync("dist/extension.js.map", { force: true }); // a stale dev map must not sit next to a minified bundle
}

/** Prints esbuild errors and the watch start/finish lines in the format of the tasks.json problem matcher. */
const problemMatcherPlugin = {
  name: "contexo-problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column + 1}:`); // esbuild columns are 0-based; problem matchers are 1-based
        }
      }
      console.log("[watch] build finished");
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  sourcemap: !production,
  sourcesContent: false,
  minify: production,
  logLevel: "silent",
  plugins: [problemMatcherPlugin],
});

if (watch) {
  await ctx.watch();
} else {
  try {
    await ctx.rebuild();
  } catch {
    process.exitCode = 1;
  } finally {
    await ctx.dispose();
  }
}
