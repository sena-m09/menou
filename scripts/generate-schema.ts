import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toJsonSchema } from "@valibot/to-json-schema";
import { ConfigSchema } from "../src/config-schema.ts";

const output = fileURLToPath(new URL("../schema.json", import.meta.url));

const text = `${JSON.stringify(toJsonSchema(ConfigSchema), null, 2)}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== text) {
    process.stderr.write(
      "schema.json が src/config-schema.ts のスキーマと合っていません。\n" +
        "pnpm generate を実行して、書き出し直した schema.json をコミットしてください。\n",
    );
    process.exit(1);
  }
} else {
  writeFileSync(output, text);
}
