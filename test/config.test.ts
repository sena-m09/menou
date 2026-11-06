import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseConfig } from "../src/config";

const lint = { id: "lint", mode: "inline", run: "pnpm lint", paths: ["src/**"] };

function parse(value: unknown) {
  return parseConfig(JSON.stringify(value));
}

function problemsOf(value: unknown) {
  const result = parse(value);
  if (result.status !== "invalid") {
    throw new Error(`不正になるはずが読み込めました: ${JSON.stringify(value)}`);
  }
  return result;
}

function problemAt(value: unknown, path: string) {
  const problem = problemsOf(value).problems.find((p) => p.path === path);
  expect(problem, `${path} の指摘がありません`).toBeDefined();
  return problem?.message ?? "";
}

describe(".menou.json のありか", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "menou-config-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("リポジトリのルートに .menou.json がなければ、設定なしとして扱う", () => {
    expect(loadConfig(root)).toEqual({ status: "missing" });
  });

  it("渡されたリポジトリのルートにある .menou.json を読む", () => {
    writeFileSync(join(root, ".menou.json"), JSON.stringify({ checks: [lint] }));

    expect(loadConfig(root)).toMatchObject({
      status: "loaded",
      config: { checks: [{ id: "lint" }] },
    });
  });

  it("先頭に BOM が付いた .menou.json も読める", () => {
    writeFileSync(join(root, ".menou.json"), `\uFEFF${JSON.stringify({ checks: [lint] })}`);

    expect(loadConfig(root).status).toBe("loaded");
  });

  it(".menou.json がディレクトリになっていると不正になり、ファイルにするよう伝える", () => {
    mkdirSync(join(root, ".menou.json"));

    const result = loadConfig(root);

    expect(result).toMatchObject({ status: "invalid", kind: "read" });
    expect(result.status === "invalid" && result.problems[0]?.message).toContain("ファイルにして");
  });

  it.skipIf(process.getuid?.() === 0)(
    ".menou.json を読む権限がないと不正になり、権限を確かめるよう伝える",
    () => {
      const file = join(root, ".menou.json");
      writeFileSync(file, JSON.stringify({ checks: [lint] }));
      chmodSync(file, 0o000);

      const result = loadConfig(root);

      expect(result).toMatchObject({ status: "invalid", kind: "read" });
      expect(result.status === "invalid" && result.problems[0]?.message).toContain("権限");
    },
  );
});

describe("正しい設定の読み込み", () => {
  it("04-config.md の例は、そのまま読み込める", () => {
    const doc = readFileSync(new URL("../docs/04-config.md", import.meta.url), "utf8");
    const example = /```json\n([\s\S]*?)\n```/.exec(doc)?.[1];
    expect(example).toBeDefined();

    expect(parseConfig(example ?? "").status).toBe("loaded");
  });

  it("maxBlocks・severity・timeout を省くと、3・block・120 を補う", () => {
    expect(parse({ checks: [lint] })).toEqual({
      status: "loaded",
      config: { maxBlocks: 3, checks: [{ ...lint, severity: "block", timeout: 120 }] },
    });
  });

  it("maxBlocks・severity・timeout を書けば、その値を使う", () => {
    const check = { ...lint, severity: "warn", timeout: 1 };

    expect(parse({ maxBlocks: 1, checks: [check] })).toEqual({
      status: "loaded",
      config: { maxBlocks: 1, checks: [check] },
    });
  });

  it("チェックが 1 つもない設定も読み込める", () => {
    expect(parse({ checks: [] }).status).toBe("loaded");
  });

  it("paths と needs に同じ値を重ねて書いても読み込める", () => {
    const e2e = { ...lint, id: "e2e", paths: ["src/**", "src/**"], needs: ["lint", "lint"] };

    expect(parse({ checks: [lint, e2e] }).status).toBe("loaded");
  });
});

describe("JSON として読めない設定", () => {
  it("不正になり、JSON として読めないことを伝える", () => {
    const result = parseConfig('{ "checks": [ }');

    expect(result).toMatchObject({ status: "invalid", kind: "json" });
    expect(result.status === "invalid" && result.problems[0]?.message).toContain("JSON");
  });
});

describe("スキーマに合わない設定", () => {
  it("トップレベルが配列だと不正になり、オブジェクトで書くよう伝える", () => {
    const result = parseConfig("[]");

    expect(result).toMatchObject({ status: "invalid", kind: "schema" });
    expect(result.status === "invalid" && result.problems).toEqual([
      { path: "", message: expect.stringContaining("オブジェクト") },
    ]);
  });

  it("表にないキーは、トップレベルに書くと不正になり、キーの場所を伝える", () => {
    expect(problemsOf({ checks: [lint], maxblocks: 3 }).kind).toBe("schema");
    expect(problemAt({ checks: [lint], maxblocks: 3 }, "maxblocks")).toContain("知らないキー");
  });

  it("表にないキーは、チェック定義の中に書いても不正になる", () => {
    expect(problemAt({ checks: [{ ...lint, timout: 60 }] }, "checks[0].timout")).toContain(
      "知らないキー",
    );
  });

  it("$schema はトップレベルに書ける", () => {
    expect(parse({ $schema: "./schema.json", checks: [lint] }).status).toBe("loaded");
  });

  it("$schema をチェック定義の中に書くと不正になる", () => {
    problemAt({ checks: [{ ...lint, $schema: "./schema.json" }] }, "checks[0].$schema");
  });

  it("checks がなければ、書き足すよう伝える", () => {
    expect(problemAt({}, "checks")).toContain("必須");
  });

  it.each(["id", "mode", "run", "paths"])("チェック定義の %s がなければ不正になる", (key) => {
    const check: Record<string, unknown> = { ...lint };
    delete check[key];

    expect(problemAt({ checks: [check] }, `checks[0].${key}`)).toContain("必須");
  });

  it('paths が空の配列なら不正になり、全ファイルを対象にする ["**"] の書き方を案内する', () => {
    expect(problemAt({ checks: [{ ...lint, paths: [] }] }, "checks[0].paths")).toContain('["**"]');
  });

  it('paths が ["**"] なら読み込める', () => {
    expect(parse({ checks: [{ ...lint, paths: ["**"] }] }).status).toBe("loaded");
  });

  it('paths に空の文字列があると不正になり、全ファイルを対象にする "**" の書き方を案内する', () => {
    const config = { checks: [{ ...lint, paths: ["src/**", ""] }] };

    expect(problemAt(config, "checks[0].paths[1]")).toContain('"**"');
  });

  it("run が空の文字列なら不正になり、実行するコマンドを書くよう伝える", () => {
    expect(problemAt({ checks: [{ ...lint, run: "" }] }, "checks[0].run")).toContain("コマンド");
  });

  it("run は 1 文字でも読み込める", () => {
    expect(parse({ checks: [{ ...lint, run: "x" }] }).status).toBe("loaded");
  });

  it("hint が 200 文字を超えると不正になり、長い案内は別のファイルに書くよう伝える", () => {
    const message = problemAt({ checks: [{ ...lint, hint: "あ".repeat(201) }] }, "checks[0].hint");

    expect(message).toContain("200 文字");
    expect(message).toContain("別のファイル");
  });

  it("hint は 200 文字まで書ける", () => {
    expect(parse({ checks: [{ ...lint, hint: "あ".repeat(200) }] }).status).toBe("loaded");
  });

  it("hint の絵文字は 1 つで 1 文字と数える", () => {
    expect(parse({ checks: [{ ...lint, hint: "🙂".repeat(200) }] }).status).toBe("loaded");
  });

  it("hint の絵文字が 201 個あると、200 文字を超えるので不正になる", () => {
    expect(
      problemAt({ checks: [{ ...lint, hint: "🙂".repeat(201) }] }, "checks[0].hint"),
    ).toContain("200 文字");
  });

  it.each(["Lint", "type check", "lint:fix", "検証"])(
    "id に英小文字・数字・-・_ のほかの文字（%s）を使うと不正になる",
    (id) => {
      expect(problemAt({ checks: [{ ...lint, id }] }, "checks[0].id")).toContain("英小文字");
    },
  );

  it("id に英小文字・数字・-・_ を使える", () => {
    expect(parse({ checks: [{ ...lint, id: "e2e_chrome-2" }] }).status).toBe("loaded");
  });

  it("id が空の文字列なら不正になる", () => {
    problemAt({ checks: [{ ...lint, id: "" }] }, "checks[0].id");
  });

  it.each([0, -1])("maxBlocks が %s なら不正になり、1 以上にするよう伝える", (maxBlocks) => {
    expect(problemAt({ maxBlocks, checks: [lint] }, "maxBlocks")).toContain("1 以上");
  });

  it.each([1.5, "3"])("maxBlocks が整数でない %j なら不正になる", (maxBlocks) => {
    expect(problemAt({ maxBlocks, checks: [lint] }, "maxBlocks")).toContain("整数");
  });

  it.each([0, 0.5, "60"])("timeout が 1 以上の整数でない %j なら不正になる", (timeout) => {
    problemAt({ checks: [{ ...lint, timeout }] }, "checks[0].timeout");
  });

  it("maxBlocks と timeout は 1 なら読み込める", () => {
    expect(parse({ maxBlocks: 1, checks: [{ ...lint, timeout: 1 }] }).status).toBe("loaded");
  });

  it.each([
    ["mode", "manual", '"inline"'],
    ["severity", "error", '"warn"'],
  ])("%s に決まった値のほか（%s）を書くと不正になり、書ける値を伝える", (key, value, allowed) => {
    expect(problemAt({ checks: [{ ...lint, [key]: value }] }, `checks[0].${key}`)).toContain(
      allowed,
    );
  });

  it("不正な箇所が複数あれば、すべて伝える", () => {
    const { problems } = problemsOf({ maxBlocks: 0, checks: [{ ...lint, paths: [] }] });

    expect(problems.map((p) => p.path)).toEqual(["maxBlocks", "checks[0].paths"]);
  });
});

describe("チェックどうしの関係", () => {
  const e2e = { id: "e2e", mode: "evidence", run: "pnpm e2e", paths: ["src/**"] };

  it("id が重複していると不正になり、先に使っている場所を伝える", () => {
    const config = { checks: [lint, { ...e2e, id: "lint" }] };

    expect(problemsOf(config).kind).toBe("rules");
    expect(problemAt(config, "checks[1].id")).toContain("checks[0]");
  });

  it("needs に存在しない id を書くと不正になり、その id を伝える", () => {
    const config = { checks: [lint, { ...e2e, needs: ["lint", "unit"] }] };

    expect(problemAt(config, "checks[1].needs[1]")).toContain('"unit"');
  });

  it("needs は、あとに書いたチェックの id も指せる", () => {
    expect(parse({ checks: [{ ...lint, needs: ["e2e"] }, e2e] }).status).toBe("loaded");
  });

  it("needs に自分の id を書くと、循環として不正になる", () => {
    expect(problemAt({ checks: [{ ...lint, needs: ["lint"] }] }, "checks[0].needs")).toContain(
      "循環",
    );
  });

  it("needs が循環していると不正になり、循環している順に id を伝える", () => {
    const config = {
      checks: [
        { ...lint, id: "a", needs: ["b"] },
        { ...lint, id: "b", needs: ["c"] },
        { ...lint, id: "c", needs: ["a"] },
      ],
    };

    expect(problemAt(config, "checks[0].needs")).toContain("a → b → c → a");
  });

  it("循環していなければ、同じチェックを複数のチェックが needs に書いてもよい", () => {
    const config = {
      checks: [
        { ...lint, id: "review", needs: ["unit", "e2e"] },
        { ...lint, id: "unit", needs: ["lint"] },
        { ...lint, id: "e2e", needs: ["lint"] },
        lint,
      ],
    };

    expect(parse(config).status).toBe("loaded");
  });
});
