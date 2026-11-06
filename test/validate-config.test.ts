import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const generated = new URL("../src/validate-config.generated.js", import.meta.url).href;

describe("生成した検証関数", () => {
  it("Node.js から直接 import しても、hint の文字数を数えて検証できる", () => {
    const script = `
      const { default: validate } = await import(${JSON.stringify(generated)});
      const check = (hint) => ({ checks: [{ id: "a", mode: "inline", run: "x", paths: ["**"], hint }] });
      console.log(JSON.stringify([validate(check("🙂".repeat(200))), validate(check("🙂".repeat(201)))]));
    `;

    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });

    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("[true,false]");
  });
});
