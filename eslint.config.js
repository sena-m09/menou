import js from "@eslint/js";
import n from "eslint-plugin-n";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: n.configs["flat/recommended-module"].languageOptions,
  },
  {
    files: ["src/**/*.ts"],
    plugins: { n },
    // globals を宣言しないと、structuredClone のような Node のグローバルを rule が検出できない。
    languageOptions: n.configs["flat/recommended-module"].languageOptions,
    rules: {
      "n/no-unsupported-features/node-builtins": "error",
      "n/no-unsupported-features/es-builtins": "error",
    },
  },
);
