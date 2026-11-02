import { readFileSync } from "node:fs";
import { build } from "esbuild";

const { engines } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const minimum = /^>=(\d+\.\d+\.\d+)$/.exec(engines.node)?.[1];
if (minimum === undefined) {
  throw new Error(
    `engines.node は ">=x.y.z" の形で書いてください: ${engines.node}`,
  );
}

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/menou.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: `node${minimum}`,
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
