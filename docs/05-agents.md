# エージェント対応

Claude Code と Codex はどちらも Stop フックを持ち、`{"decision":"block","reason":"..."}` で作業を継続させられるため、判定ロジックは共通化できます。差はアダプタ層で吸収します。仕様は変わりやすいので、実装前に [Claude Code のフック](https://code.claude.com/docs/en/hooks.md) と [Codex のフック](https://developers.openai.com/codex/hooks) の最新版を必ず確認してください。

## 共通化できる部分

| 項目 | Claude Code | Codex |
| --- | --- | --- |
| 完了時のフック | `Stop` | `Stop` |
| 継続させる出力 | `{"decision":"block","reason":"..."}` | 同じ（理由文が新しいユーザープロンプトになる） |
| 終了コード 2 + stderr | 継続 | 継続 |
| ループ判定用の入力 | `stop_hook_active` | 同じ |
| 編集前のフック | `PreToolUse`（Edit / Write / MultiEdit） | `PreToolUse`（apply_patch。`Edit` / `Write` でもマッチ） |
| 編集の拒否 | `hookSpecificOutput.permissionDecision: "deny"` | 同じ |
| プラグインのフック定義 | `hooks/hooks.json` | 同じ場所を既定で読む。`CLAUDE_PLUGIN_ROOT` も設定される |

## 違いと吸収方法

| 違い | 吸収方法 |
| --- | --- |
| Codex は prompt / agent 型のフックを実行しない | 判定はすべてコマンドで行う。LLM による判定はレビューのプリセットとして evidence 方式で扱う |
| Codex の Stop は、終了コード 0 なら stdout に JSON が必須（プレーンテキストは不正） | 通すときも `{}` を出力する |
| Codex は未信頼のフックを実行しない（定義のハッシュで信頼を記録） | 導入手順に「Codex の `/hooks` で信頼する」を明記し、`menou doctor` で未信頼を検知する |
| SessionStart の stdout は両方ともコンテキストに入る | 意図した案内文だけを出力し、余計な出力をしない |
| フックのタイムアウトの既定値が異なる | 重い処理はフック内で実行しない。evidence 方式に寄せる |

## `stop_hook_active` の扱い

よくある実装例の「`stop_hook_active` が true なら通す」は採用しません。1 回ブロックしただけで、条件を満たさないまま完了できてしまうからです。代わりにセッションごとのブロック回数を数え、`maxBlocks` で打ち切ります。

## 配布方法

| | プラグインとして配布 | リポジトリに直接置く |
| --- | --- | --- |
| フックの置き場所 | プラグイン内の `hooks/hooks.json` | `.claude/settings.json` と `.codex/hooks.json` |
| 向いている用途 | 自分が関わる全プロジェクトで使う | 案件のチーム全員に強制したい |
| 有効化 | `.menou.json` を置いたリポジトリだけ | 同じ |
| Codex での条件 | `/hooks` でフックを信頼 | プロジェクトの `.codex/` の信頼 + フックの信頼 |
| コマンドのパス | `"$CLAUDE_PLUGIN_ROOT/..."` をダブルクォートで囲む | `"$(git rev-parse --show-toplevel)/..."` で git ルートから解決 |

どちらの方式でも、フックが呼ぶのは同じ `menou hook <event>` です。プラグインとして作る場合、マニフェストは `.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` の両方を用意します。
