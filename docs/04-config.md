# 設定仕様

ゲートの有効化とチェックの定義は、リポジトリのルートに置く `.menou.json` 1 つで行います。このファイルがないリポジトリでは、ゲートは何もしません（オプトイン）。JSON Schema を同梱し、`$schema` でエディタの補完と検証を効かせます。

## 例

```json
{
  "$schema": "https://unpkg.com/@sena-m09/menou@1/schema.json",
  "maxBlocks": 3,
  "checks": [
    {
      "id": "lint",
      "mode": "inline",
      "run": "pnpm lint",
      "paths": ["src/**", "eslint.config.*"],
      "timeout": 60
    },
    {
      "id": "e2e",
      "mode": "evidence",
      "run": "pnpm e2e",
      "paths": ["src/**", "tests/e2e/**"]
    },
    {
      "id": "review",
      "mode": "evidence",
      "run": "menou preset agent-review --reviewer codex --rubric .menou/review.md",
      "paths": ["src/**"],
      "needs": ["lint", "e2e"],
      "severity": "block"
    }
  ]
}
```

## トップレベル

| フィールド | 型 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- | --- |
| `$schema` | string | いいえ | なし | エディタ補完用の JSON Schema の URL |
| `maxBlocks` | number | いいえ | 3 | 1 セッションで連続ブロックできる上限。超えたら許可して人に通知する |
| `checks` | array | はい | なし | チェック定義の配列 |

## チェック定義

| フィールド | 型 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- | --- |
| `id` | string | はい | なし | 一意な識別子。`menou run <id>` で使う |
| `mode` | `"inline"` \| `"evidence"` | はい | なし | 実行方式 |
| `run` | string | はい | なし | 実行するシェルコマンド。終了コード 0 / 1 / その他で合格 / 不合格 / エラー |
| `paths` | string[] | はい | なし | 対象範囲（git の pathspec）。範囲内が変わったときだけ要求する。1 件以上書く。全ファイルなら `["**"]` |
| `needs` | string[] | いいえ | なし | 前提となるチェックの `id`。前提が通るまで実行も判定もしない |
| `severity` | `"block"` \| `"warn"` | いいえ | `"block"` | `warn` は警告を出すだけで完了を許可する |
| `timeout` | number（秒） | いいえ | 未定 | inline 方式でのタイムアウト。エージェント側のフックのタイムアウトより短くする |
| `hint` | string | いいえ | なし | 不足時の理由文に添える補足（例：「失敗時は `pnpm e2e --ui` で確認」） |

### paths の書き方

`paths` には git の pathspec を書きます。`*` はディレクトリの区切り（`/`）をまたがず、`**` だけがまたぎます。

| 書き方 | 一致するファイル |
| --- | --- |
| `src` または `src/` | `src/` の下のすべて |
| `src/*` | `src/` の直下のファイルだけ |
| `src/**` | `src/` の下のすべて |
| `*.md` | リポジトリの直下の `.md` だけ |
| `**/*.md` | すべての階層の `.md` |
| `["**", ":(exclude)docs/**"]` | `docs/` の下を除くすべて |

`.gitignore` の対象のファイルは、paths に一致しても含まれません。

## バリデーションのルール

- `id` の重複、存在しない `id` を指す `needs`、`needs` の循環はエラーにする
- 設定ファイル自体が不正な場合は、完了を許可しつつ警告を出すか、ブロックするかを決める必要がある（[06 の未決事項](./06-roadmap.md#未決事項)を参照）

## 環境変数

| 変数 | 設定する側 | 意味 |
| --- | --- | --- |
| `MENOU_DISABLED` | 呼び出し側 | `1` ならフックは即座に通す。レビュアー起動時の再帰防止に使う |
| `MENOU_OUT` | 基盤 | チェックが詳細を書き出すディレクトリ |
| `MENOU_CHECK_ID` | 基盤 | 実行中のチェックの `id` |
| `MENOU_BASELINE` | 基盤 | ベースラインの tree ハッシュ。レビューで差分を作るときに使う |
