import { build } from "esbuild";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

try { rmSync("dist", { recursive: true, force: true }); } catch {}
mkdirSync("dist", { recursive: true });

// Plugin: resolve "./foo.js" imports to "./foo.ts" (TypeScript ESM convention)
const tsResolvePlugin = {
  name: "ts-resolve",
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (!args.path.startsWith(".") && !path.isAbsolute(args.path)) return null;
      const abs = path.resolve(args.resolveDir, args.path);
      const tsPath = abs.replace(/\.js$/, ".ts");
      if (existsSync(tsPath)) return { path: tsPath };
      return null;
    });
  },
};

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  minify: false,
  external: ["ssh2"],
  logLevel: "info",
  plugins: [tsResolvePlugin],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
};

await build({ ...common, entryPoints: ["src/index.ts"], outfile: "dubridge.mjs" });

console.log("[build] done: dubridge.mjs");
