import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findNeedsCycles, parseConfig } from "../src/config";

type Check = Record<string, unknown> & { id: string; needs?: string[] };
type Config = Record<string, unknown> & { checks: Check[] };

const idArb = fc.stringMatching(/^[a-z0-9_-]{1,6}$/);
const hintArb = fc
  .string({ unit: "binary", maxLength: 200, size: "max" })
  .filter((hint) => hint.length <= 200);
const tooLongHintArb = fc
  .string({ unit: "binary", minLength: 101, maxLength: 400 })
  .filter((hint) => hint.length > 200);

function checkArb(id: string, earlierIds: string[]): fc.Arbitrary<Check> {
  return fc.record(
    {
      id: fc.constant(id),
      mode: fc.constantFrom("inline", "evidence"),
      run: fc.string({ minLength: 1 }),
      paths: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 3 }),
      needs: fc.subarray(earlierIds),
      severity: fc.constantFrom("block", "warn"),
      timeout: fc.integer({ min: 1, max: 100_000 }),
      hint: hintArb,
    },
    { requiredKeys: ["id", "mode", "run", "paths"] },
  );
}

const validConfigArb: fc.Arbitrary<Config> = fc
  .uniqueArray(idArb, { maxLength: 6 })
  .chain((ids) => fc.tuple(...ids.map((id, i) => checkArb(id, ids.slice(0, i)))))
  .chain((checks) =>
    fc.record(
      {
        $schema: fc.string(),
        maxBlocks: fc.integer({ min: 1, max: 100 }),
        checks: fc.shuffledSubarray(checks, { minLength: checks.length, maxLength: checks.length }),
      },
      { requiredKeys: ["checks"] },
    ),
  );

const nonEmptyConfigArb = validConfigArb.filter((config) => config.checks.length > 0);

function withDefaults(config: Config) {
  return {
    ...config,
    maxBlocks: config.maxBlocks ?? 3,
    checks: config.checks.map((check) => ({
      ...check,
      severity: check.severity ?? "block",
      timeout: check.timeout ?? 120,
    })),
  };
}

function parse(value: unknown) {
  return parseConfig(JSON.stringify(value));
}

function onCycleNaively(checks: readonly Check[]): Set<string> {
  const needs = new Map(checks.map((check) => [check.id, check.needs ?? []]));
  const result = new Set<string>();
  for (const [start, first] of needs) {
    const seen = new Set<string>();
    const stack = [...first];
    while (stack.length > 0) {
      const id = stack.pop() ?? "";
      if (id === start) {
        result.add(start);
        break;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(needs.get(id) ?? []));
    }
  }
  return result;
}

describe("needs の循環", () => {
  const graphArb = fc
    .uniqueArray(fc.constantFrom("a", "b", "c", "d", "e"), { minLength: 1 })
    .chain((ids) =>
      fc.tuple(
        ...ids.map((id) =>
          fc.record({ id: fc.constant(id), needs: fc.subarray([...ids, "unknown"]) }),
        ),
      ),
    );

  it("循環に含まれる id は、すべての id から needs をたどって自分に戻るものと一致する", () => {
    fc.assert(
      fc.property(graphArb, (checks) => {
        const found = new Set(findNeedsCycles(checks).flat());

        expect(found).toEqual(onCycleNaively(checks));
      }),
    );
  });

  it("循環があるときだけ、設定が不正になる", () => {
    fc.assert(
      fc.property(graphArb, (graph) => {
        const checks = graph.map((check) => ({
          ...check,
          needs: check.needs.filter((need) => need !== "unknown"),
          mode: "inline",
          run: "x",
          paths: ["**"],
        }));

        expect(parse({ checks }).status).toBe(
          onCycleNaively(checks).size > 0 ? "invalid" : "loaded",
        );
      }),
    );
  });
});

describe("チェックどうしの関係を 1 か所だけ壊した設定", () => {
  it("id を別のチェックと同じにすると、あとに書いたほうの id を指摘する", () => {
    const arb = validConfigArb
      .filter((config) => config.checks.length >= 2)
      .chain((config) =>
        fc
          .uniqueArray(fc.nat({ max: config.checks.length - 1 }), { minLength: 2, maxLength: 2 })
          .map(([from = 0, to = 0]) => ({ config, from, to })),
      );

    fc.assert(
      fc.property(arb, ({ config, from, to }) => {
        const checks = config.checks.map((check) => ({ ...check }));
        const copied = checks[from];
        const target = checks[to];
        if (copied === undefined || target === undefined) throw new Error("範囲外");
        target.id = copied.id;

        const result = parse({ ...config, checks });

        expect(result).toMatchObject({
          status: "invalid",
          kind: "rules",
          problems: expect.arrayContaining([
            expect.objectContaining({ path: `checks[${Math.max(from, to)}].id` }),
          ]),
        });
      }),
    );
  });

  it("needs に存在しない id を足すと、その場所を指摘する", () => {
    const arb = nonEmptyConfigArb.chain((config) =>
      fc.record({
        config: fc.constant(config),
        index: fc.nat({ max: config.checks.length - 1 }),
        missing: idArb.filter((id) => !config.checks.some((check) => check.id === id)),
      }),
    );

    fc.assert(
      fc.property(arb, ({ config, index, missing }) => {
        const checks = config.checks.map((check) => ({ ...check }));
        const target = checks[index];
        if (target === undefined) throw new Error("範囲外");
        target.needs = [...(target.needs ?? []), missing];

        const result = parse({ ...config, checks });

        expect(result).toMatchObject({
          status: "invalid",
          kind: "rules",
          problems: expect.arrayContaining([
            expect.objectContaining({ path: `checks[${index}].needs[${target.needs.length - 1}]` }),
          ]),
        });
      }),
    );
  });
});

describe("スキーマに合う設定", () => {
  it("必ず読み込めて、省いた値は既定値で補われる", () => {
    fc.assert(
      fc.property(validConfigArb, (config) => {
        expect(parse(config)).toEqual({ status: "loaded", config: withDefaults(config) });
      }),
    );
  });

  it("既定値を補ったあとの値をもう一度読み込んでも、同じ値になる", () => {
    fc.assert(
      fc.property(validConfigArb, (config) => {
        const first = parse(config);
        if (first.status !== "loaded") throw new Error("読み込めませんでした");

        expect(parse(first.config)).toEqual(first);
      }),
    );
  });
});

interface Broken {
  value: unknown;
  path: string;
}

function breakTopLevel(key: string, valueArb: fc.Arbitrary<unknown>): fc.Arbitrary<Broken> {
  return fc
    .tuple(validConfigArb, valueArb)
    .map(([config, value]) => ({ value: { ...config, [key]: value }, path: key }));
}

function breakCheck(
  key: (check: Check) => fc.Arbitrary<string>,
  valueArb: fc.Arbitrary<unknown>,
): fc.Arbitrary<Broken> {
  return nonEmptyConfigArb.chain((config) =>
    fc.nat({ max: config.checks.length - 1 }).chain((index) => {
      const check = config.checks[index] ?? { id: "" };
      return fc.tuple(key(check), valueArb).map(([name, value]) => {
        const checks = [...config.checks];
        checks[index] = { ...check, [name]: value };
        return { value: { ...config, checks }, path: `checks[${index}].${name}` };
      });
    }),
  );
}

function removeFromCheck(key: string): fc.Arbitrary<Broken> {
  return nonEmptyConfigArb.chain((config) =>
    fc.nat({ max: config.checks.length - 1 }).map((index) => {
      const checks = [...config.checks];
      const { [key]: _removed, ...rest } = checks[index] ?? { id: "" };
      checks[index] = rest as Check;
      return { value: { ...config, checks }, path: `checks[${index}].${key}` };
    }),
  );
}

function addEmptyPath(): fc.Arbitrary<Broken> {
  return nonEmptyConfigArb.chain((config) =>
    fc.nat({ max: config.checks.length - 1 }).chain((index) => {
      const check = config.checks[index] ?? { id: "" };
      const paths = check.paths as string[];
      return fc.nat({ max: paths.length }).map((at) => {
        const checks = [...config.checks];
        checks[index] = { ...check, paths: paths.toSpliced(at, 0, "") };
        return { value: { ...config, checks }, path: `checks[${index}].paths[${at}]` };
      });
    }),
  );
}

const fixed = (key: string) => () => fc.constant(key);

const notPositiveIntegerArb = fc.oneof(
  fc.integer({ max: 0 }),
  fc.double({ noNaN: true }).filter((n) => !Number.isInteger(n)),
  fc.string(),
  fc.boolean(),
  fc.constant(null),
);
const notStringArb = fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.array(fc.string()));
const notArrayArb = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.constant(null),
  fc.dictionary(fc.string(), fc.string()),
);
const topLevelKeys = new Set(["$schema", "maxBlocks", "checks"]);
const checkKeys = new Set(["id", "mode", "run", "paths", "needs", "severity", "timeout", "hint"]);

const brokenConfigs: [string, fc.Arbitrary<Broken>][] = [
  [
    "トップレベルに知らないキーがある",
    fc
      .string()
      .filter((key) => !topLevelKeys.has(key))
      .chain((key) => breakTopLevel(key, fc.jsonValue())),
  ],
  [
    "チェック定義に知らないキーがある",
    breakCheck(() => fc.string().filter((key) => !checkKeys.has(key)), fc.jsonValue()),
  ],
  ["maxBlocks が 1 以上の整数でない", breakTopLevel("maxBlocks", notPositiveIntegerArb)],
  ["timeout が 1 以上の整数でない", breakCheck(fixed("timeout"), notPositiveIntegerArb)],
  [
    "id に使えない文字がある",
    breakCheck(
      fixed("id"),
      fc.string().filter((id) => !/^[a-z0-9_-]+$/.test(id)),
    ),
  ],
  ["id が文字列でない", breakCheck(fixed("id"), notStringArb)],
  ["paths が空の配列", breakCheck(fixed("paths"), fc.constant([]))],
  ["paths が配列でない", breakCheck(fixed("paths"), notArrayArb)],
  ["paths に空の文字列を入れる", addEmptyPath()],
  ["run を空の文字列にする", breakCheck(fixed("run"), fc.constant(""))],
  ["needs が配列でない", breakCheck(fixed("needs"), notArrayArb)],
  ["run が文字列でない", breakCheck(fixed("run"), notStringArb)],
  ["hint が文字列でない", breakCheck(fixed("hint"), notStringArb)],
  ["hint が 200 文字を超える", breakCheck(fixed("hint"), tooLongHintArb)],
  ["$schema が文字列でない", breakTopLevel("$schema", notStringArb)],
  [
    "mode が inline でも evidence でもない",
    breakCheck(
      fixed("mode"),
      fc.jsonValue().filter((v) => v !== "inline" && v !== "evidence"),
    ),
  ],
  [
    "severity が block でも warn でもない",
    breakCheck(
      fixed("severity"),
      fc.jsonValue().filter((v) => v !== "block" && v !== "warn"),
    ),
  ],
  ["checks が配列でない", breakTopLevel("checks", notArrayArb)],
  ...["id", "mode", "run", "paths"].map((key): [string, fc.Arbitrary<Broken>] => [
    `チェック定義に ${key} がない`,
    removeFromCheck(key),
  ]),
];

describe("スキーマの決まりを 1 か所だけ破った設定", () => {
  it.each(brokenConfigs)("%sと、不正になってその場所を指摘する", (_, arb) => {
    fc.assert(
      fc.property(arb, ({ value, path }) => {
        expect(parse(value)).toMatchObject({
          status: "invalid",
          kind: "schema",
          problems: expect.arrayContaining([expect.objectContaining({ path })]),
        });
      }),
    );
  });

  it("checks がないと、不正になって checks を指摘する", () => {
    fc.assert(
      fc.property(validConfigArb, ({ checks: _removed, ...rest }) => {
        expect(parse(rest)).toMatchObject({
          status: "invalid",
          kind: "schema",
          problems: [{ path: "checks" }],
        });
      }),
    );
  });
});
