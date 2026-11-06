import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { type CheckDefinition, type Config, ConfigSchema } from "./config-schema";

export type { CheckDefinition, Config } from "./config-schema";

export interface Problem {
  path: string;
  message: string;
}

export type ParsedConfig =
  | { status: "loaded"; config: Config }
  | { status: "invalid"; kind: "json" | "schema" | "rules"; problems: Problem[] };

export type ConfigResult =
  | { status: "missing" }
  | { status: "invalid"; kind: "read"; problems: Problem[] }
  | ParsedConfig;

export const configFileName = ".menou.json";

export function loadConfig(root: string): ConfigResult {
  let text: string;
  try {
    text = readFileSync(join(root, configFileName), "utf8");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = "code" in error && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") {
      return { status: "missing" };
    }
    return {
      status: "invalid",
      kind: "read",
      problems: [{ path: "", message: unreadable(code, error.message) }],
    };
  }
  return parseConfig(text.replace(/^\uFEFF/, ""));
}

function unreadable(code: string, detail: string): string {
  switch (code) {
    case "EISDIR":
      return `${configFileName} がディレクトリになっています。ファイルにしてください。`;
    case "EACCES":
    case "EPERM":
      return `${configFileName} を読む権限がありません。ファイルの権限を確かめてください。`;
    default:
      return `${configFileName} を読めません（${detail}）。`;
  }
}

const ConfigFileSchema = v.pipe(v.string(), v.parseJson(), ConfigSchema);

type ConfigIssue = v.InferIssue<typeof ConfigFileSchema>;

export function parseConfig(text: string): ParsedConfig {
  const result = v.safeParse(ConfigFileSchema, text);
  if (!result.success) {
    const [first] = result.issues;
    if (first.type === "parse_json") {
      return {
        status: "invalid",
        kind: "json",
        problems: [
          {
            path: "",
            message: `JSON として読めません（${first.received.slice(1, -1)}）。カンマや引用符が抜けていないか確かめてください。`,
          },
        ],
      };
    }
    return { status: "invalid", kind: "schema", problems: toProblems(result.issues) };
  }

  const problems = checkRelations(result.output.checks);
  if (problems.length > 0) {
    return { status: "invalid", kind: "rules", problems };
  }
  return { status: "loaded", config: result.output };
}

function toProblems(issues: readonly ConfigIssue[]): Problem[] {
  const seen = new Set<string>();
  return issues.map(describe).filter((problem) => {
    const key = `${problem.path}\n${problem.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const typeNames: Record<"string" | "number" | "integer" | "array", string> = {
  string: "文字列",
  number: "整数",
  integer: "整数",
  array: "配列",
};

function describe(issue: ConfigIssue): Problem {
  const items = issue.path ?? [];
  const path = toPath(items);
  switch (issue.type) {
    case "strict_object":
      if (issue.expected === "Object") {
        return { path, message: "オブジェクトで書いてください。" };
      }
      if (Array.isArray(items.at(-1)?.input)) {
        return { path: toPath(items.slice(0, -1)), message: "オブジェクトで書いてください。" };
      }
      if (issue.expected === "never") {
        return { path, message: "知らないキーです。綴りを確かめるか、消してください。" };
      }
      return { path, message: "必須のキーがありません。書き足してください。" };
    case "string":
    case "number":
    case "integer":
    case "array":
      return { path, message: `${typeNames[issue.type]}で書いてください。` };
    case "min_value":
      return { path, message: `${issue.requirement} 以上の整数を書いてください。` };
    case "min_length":
      if (Array.isArray(issue.input)) {
        return {
          path,
          message: '1 件以上書いてください。全ファイルを対象にするときは ["**"] と書きます。',
        };
      }
      return {
        path,
        message: path.endsWith(".run")
          ? "空にはできません。実行するコマンドを書いてください。"
          : '空にはできません。全ファイルを対象にするときは "**" と書きます。',
      };
    case "regex":
      return { path, message: "英小文字・数字・-・_ だけで書いてください。" };
    case "picklist":
    case "check":
    case "parse_json":
      return { path, message: issue.message };
  }
}

function toPath(items: readonly v.IssuePathItem[]): string {
  return items.reduce((path, item) => {
    if (item.type === "array") return `${path}[${item.key}]`;
    if (item.type !== "object") return path;
    return path === "" ? item.key : `${path}.${item.key}`;
  }, "");
}

function checkRelations(checks: readonly CheckDefinition[]): Problem[] {
  const problems: Problem[] = [];
  const firstIndex = new Map<string, number>();

  checks.forEach((check, i) => {
    const first = firstIndex.get(check.id);
    if (first === undefined) {
      firstIndex.set(check.id, i);
      return;
    }
    problems.push({
      path: `checks[${i}].id`,
      message: `id "${check.id}" は checks[${first}] でも使われています。別の id にしてください。`,
    });
  });

  checks.forEach((check, i) => {
    check.needs?.forEach((need, j) => {
      if (!firstIndex.has(need)) {
        problems.push({
          path: `checks[${i}].needs[${j}]`,
          message: `id が "${need}" のチェックはありません。id の綴りを確かめるか、needs から外してください。`,
        });
      }
    });
  });

  const graph = needsGraph(checks);
  for (const members of findNeedsCycles(checks)) {
    const [start = ""] = members;
    problems.push({
      path: `checks[${firstIndex.get(start)}].needs`,
      message: `needs が循環しています（${loopFrom(start, graph, new Set(members)).join(" → ")}）。どれかの needs を外してください。`,
    });
  }

  return problems;
}

interface NeedsNode {
  id: string;
  needs?: readonly string[];
}

function needsGraph(checks: readonly NeedsNode[]): Map<string, string[]> {
  const graph = new Map<string, string[]>(checks.map((check) => [check.id, []]));
  for (const check of checks) {
    for (const need of check.needs ?? []) {
      if (graph.has(need)) {
        graph.get(check.id)?.push(need);
      }
    }
  }
  return graph;
}

export function findNeedsCycles(checks: readonly NeedsNode[]): string[][] {
  const graph = needsGraph(checks);
  const order = [...graph.keys()];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (id: string) => {
    index.set(id, index.size);
    low.set(id, index.size - 1);
    stack.push(id);
    onStack.add(id);
    const needs = graph.get(id) ?? [];
    for (const need of needs) {
      if (!index.has(need)) {
        visit(need);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(need) ?? 0));
      } else if (onStack.has(need)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(need) ?? 0));
      }
    }
    if (low.get(id) !== index.get(id)) return;

    const members: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      members.push(member);
    } while (member !== id);
    if (members.length > 1 || needs.includes(id)) {
      cycles.push(members.sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    }
  };

  for (const id of order) {
    if (!index.has(id)) visit(id);
  }
  return cycles.sort((a, b) => order.indexOf(a[0] ?? "") - order.indexOf(b[0] ?? ""));
}

function loopFrom(start: string, graph: Map<string, string[]>, members: Set<string>): string[] {
  const previous = new Map<string, string>();
  const queue = [start];
  for (const id of queue) {
    for (const need of graph.get(id) ?? []) {
      if (need === start) {
        const loop = [start];
        for (let at = id; at !== start; at = previous.get(at) ?? start) {
          loop.splice(1, 0, at);
        }
        return [...loop, start];
      }
      if (members.has(need) && !previous.has(need)) {
        previous.set(need, id);
        queue.push(need);
      }
    }
  }
  return [start, start];
}
