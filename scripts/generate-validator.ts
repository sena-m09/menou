import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import schema from "../schema.json" with { type: "json" };

const output = fileURLToPath(new URL("../src/validate-config.generated.js", import.meta.url));

function replaceRequireWithImport(source: string): string {
  const imports: string[] = [];
  const replaced = source.replaceAll(
    /const (\w+) = require\("([^"]+)"\)\.default;/g,
    (_, name: string, specifier: string) => {
      imports.push(`import ${name}Module from "${specifier}.js";`);
      return `const ${name} = ${name}Module.default ?? ${name}Module;`;
    },
  );
  if (replaced.includes("require(")) {
    throw new Error("生成したコードに import へ書き換えられない require が残っています。");
  }
  return [...imports, replaced].join("\n");
}

const ajv = new Ajv({ allErrors: true, useDefaults: true, code: { source: true, esm: true } });
const code = `// schema.json から scripts/generate-validator.ts で生成したファイルです。手で直さないでください。\n${replaceRequireWithImport(standaloneCode(ajv, ajv.compile(schema)))}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== code) {
    process.stderr.write(
      "src/validate-config.generated.js が schema.json と合っていません。\n" +
        "pnpm generate を実行して、生成し直したファイルをコミットしてください。\n",
    );
    process.exit(1);
  }
} else {
  writeFileSync(output, code);
}
