import * as v from "valibot";

function oneOf<const T extends readonly [string, ...string[]]>(options: T) {
  return v.picklist(
    options,
    `${options.map((option) => JSON.stringify(option)).join(" か ")} のどちらかを書いてください。`,
  );
}

const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

export const CheckDefinitionSchema = v.strictObject({
  id: v.pipe(
    v.string(),
    v.regex(/^[a-z0-9_-]+$/),
    v.description("一意な識別子。menou run <id> で使う。英小文字・数字・-・_ で書く"),
  ),
  mode: v.pipe(oneOf(["inline", "evidence"]), v.description("実行方式")),
  run: v.pipe(
    v.string(),
    v.minLength(1),
    v.description("実行するシェルコマンド。終了コード 0 / 1 / その他で合格 / 不合格 / エラー"),
  ),
  paths: v.pipe(
    v.array(v.pipe(v.string(), v.minLength(1))),
    v.minLength(1),
    v.description(
      '対象範囲（git の pathspec）。範囲内が変わったときだけ要求する。全ファイルなら ["**"]',
    ),
  ),
  needs: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description("前提となるチェックの id。前提が通るまで実行も判定もしない"),
    ),
  ),
  severity: v.optional(
    v.pipe(oneOf(["block", "warn"]), v.description("warn は警告を出すだけで完了を許可する")),
    "block",
  ),
  timeout: v.optional(
    v.pipe(
      positiveInteger,
      v.description("inline 方式でのタイムアウト（秒）。時間切れはエラーとして扱う"),
    ),
    120,
  ),
  hint: v.optional(
    v.pipe(
      v.string(),
      v.maxLength(200),
      v.description(
        "不足時の理由文に添える補足。200 文字まで。長い案内は別のファイルに書き、その場所を書く",
      ),
    ),
  ),
});

export const ConfigSchema = v.pipe(
  v.strictObject({
    $schema: v.optional(v.pipe(v.string(), v.description("エディタ補完用の JSON Schema の URL"))),
    maxBlocks: v.optional(
      v.pipe(
        positiveInteger,
        v.description("1 セッションで連続ブロックできる上限。超えたら許可して人に通知する"),
      ),
      3,
    ),
    checks: v.pipe(v.array(CheckDefinitionSchema), v.description("チェック定義の配列")),
  }),
  v.title("menou の設定（.menou.json）"),
);

export type CheckDefinition = v.InferOutput<typeof CheckDefinitionSchema>;
export type Config = v.InferOutput<typeof ConfigSchema>;
