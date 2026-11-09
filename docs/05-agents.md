# エージェント対応

Claude Code と Codex はどちらも Stop フックを持ち、`{"decision":"block","reason":"..."}` で作業を継続させられるため、判定ロジックは共通化できます。差はアダプタ層で吸収します。仕様は変わりやすいので、実装前に [Claude Code のフック](https://code.claude.com/docs/en/hooks.md) と [Codex のフック](https://developers.openai.com/codex/hooks) の最新版を必ず確認してください。

## 共通化できる部分

| 項目 | Claude Code | Codex |
| --- | --- | --- |
| 完了時のフック | `Stop` | `Stop` |
| 継続させる出力 | `{"decision":"block","reason":"..."}` | 同じ（理由文が新しいユーザープロンプトになる） |
| 終了コード 2 + stderr | 継続 | 継続 |
| ループ判定用の入力 | `stop_hook_active` | 同じ |
| 編集前のフック | `PreToolUse`（Edit / Write / NotebookEdit） | `PreToolUse`（apply_patch。`Edit` / `Write` でもマッチ） |
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

## Claude Code のフックの仕様

2026-11-06 に、Claude Code 2.1.319 で公式ドキュメントと実際の動きを確かめた内容です。対話モードでの表示は、2026-11-09 に確かめました。

| 項目 | 仕様 |
| --- | --- |
| Stop が呼ばれるとき | メインのエージェントが応答を終えるたびに呼ばれる。作業の完了時に限らない |
| Stop が呼ばれないとき | ユーザーが中断したとき。API のエラーで終わったときは、代わりに `StopFailure` が呼ばれる。`StopFailure` の出力と終了コードは無視され、ブロックできない |
| サブエージェントとの関係 | サブエージェントの終了では `SubagentStop` が呼ばれ、`Stop` は呼ばれない。コンパクションのような Claude Code 内部のエージェントの終了でも `SubagentStop` が呼ばれる |
| Stop の入力 | `session_id`・`transcript_path`・`cwd`・`permission_mode`・`hook_event_name`・`prompt_id`・`effort`・`stop_hook_active`・`last_assistant_message`・`background_tasks`・`session_crons` |
| `prompt_id` | ユーザーのプロンプトごとの UUID。ブロックして継続させている間は同じ値で、次のプロンプトで変わる |
| 終了コードと JSON | 終了コード 0 なら、stdout の JSON の `decision` で決まる。2 ならブロックし、stderr が理由文になる。0・2 以外でも、stdout が正しい JSON ならその内容で決まる。0・2 以外で JSON がなければエラーとして扱われ、完了する |
| ブロックしたときの表示 | 対話モードでは、理由文が「Stop hook error: <理由文>」と表示される。フックが終了コード 0 で正しい JSON を返していても、表示は error になる。stream-json では `"key":"stop-hook-error"` の `notification` が出る |
| `systemMessage` の表示 | 対話モードでは、応答の下に「Stop says: <文>」と表示される |
| `onFailure` | `Stop` には効かない。フックが起動できない、タイムアウトした、のような失敗では完了する |
| 連続ブロックの上限 | 8 回続けてブロックすると、9 回目のブロックは無視されて完了する。Claude がツールを呼ぶと数え直す。環境変数 `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` で変えられ、0 で上限をなくせる |
| タイムアウト | コマンドのフックの既定値は 600 秒。フックの定義の `timeout`（秒）で変えられ、上限は書かれていない。タイムアウトしたフックの出力は捨てられるので、`Stop` では完了する |
| ほかのイベントのタイムアウト | `UserPromptSubmit` の既定値は 30 秒。`SessionEnd` はすべてのフックで 1.5 秒を分け合う |
| SessionStart の `source` | `startup`・`resume`・`clear`・`compact`・`fork` |
| `source` ごとの `session_id` | `resume`（`--resume`・`--continue`）と `compact` は前と同じ。`clear` と `fork` は新しくなる。`clear` では、前の `session_id` で `SessionEnd`（`reason` は `clear`）が呼ばれてから、新しい `session_id` で `SessionStart` が呼ばれる |
| UserPromptSubmit | プロンプトを送ったときに呼ばれる。入力に `prompt` と `prompt_id` が入る。スケジュールしたタスクや、バックグラウンドのサブエージェントの報告、別のセッションからのメッセージでも呼ばれる |
| 環境変数 | フックにも、Bash ツールで実行したコマンドにも `CLAUDE_CODE_SESSION_ID` が渡る。値は入力の `session_id` と同じで、`/clear` で新しくなる。`CLAUDE_PROJECT_DIR` はフックにだけ渡り、Bash ツールには渡らない |
| stdout がコンテキストに入るイベント | `SessionStart`・`UserPromptSubmit`・`UserPromptExpansion`・`PostModelSwitch` のプレーンテキストの stdout。`PreCompact` の stdout はコンパクションの要約への指示になる。ほかのイベントの stdout はデバッグログにだけ残る |
| 編集のツール | `Edit`・`Write`・`NotebookEdit`。`MultiEdit` はない。Bash からの書き込みは `PreToolUse` の編集のツールには当たらない |

## `stop_hook_active` の扱い

よくある実装例の「`stop_hook_active` が true なら通す」は採用しません。1 回ブロックしただけで、条件を満たさないまま完了できてしまうからです。代わりに、1 つの依頼の中で続けたブロックの回数を数え、`maxBlocks` で打ち切ります。依頼が変わったことは、Stop の入力の `prompt_id` で見分けます。

Claude Code にも、上の表のとおり連続 8 回のブロックで完了させる上限があります。`maxBlocks` とは別に働きます。

## 配布方法

| | プラグインとして配布 | リポジトリに直接置く |
| --- | --- | --- |
| フックの置き場所 | プラグイン内の `hooks/hooks.json` | `.claude/settings.json` と `.codex/hooks.json` |
| 向いている用途 | 自分が関わる全プロジェクトで使う | 案件のチーム全員に強制したい |
| 有効化 | `.menou.json` を置いたリポジトリだけ | 同じ |
| Codex での条件 | `/hooks` でフックを信頼 | プロジェクトの `.codex/` の信頼 + フックの信頼 |
| コマンドのパス | `"$CLAUDE_PLUGIN_ROOT/..."` をダブルクォートで囲む | `"$(git rev-parse --show-toplevel)/..."` で git ルートから解決 |

どちらの方式でも、フックが呼ぶのは同じ `menou hook <event>` です。プラグインとして作る場合、マニフェストは `.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` の両方を用意します。

## サンプルリポジトリでの確かめ方

フックの処理を変えたときや、エージェントの version を上げたときは、本物のエージェントで menou が働くかを次の手順で確かめます。

### サンプルを作る

リポジトリのルートで次を実行します。

```sh
pnpm build
node scripts/sample-repo.ts
```

スクリプトは一時ディレクトリに git リポジトリを作り、最初のコミットまで済ませて、そのパスを出力します。中身は次のとおりです。

| ファイル | 役割 |
| --- | --- |
| `.menou.json` | `src/` に `console.log` が残っていると不合格になる inline の `lint` チェック。`paths` は `src/**` と Lint のスクリプト |
| `scripts/no-console.mjs` | Lint のスクリプト。合格なら 0、不合格なら 1、`src/` を読めなければ 2 で終わる |
| `src/app.js` | `paths` の範囲内のファイル |
| `docs/README.md` | `paths` の範囲外のファイル |
| エージェントごとのフックの設定 | この worktree の `bin/menou` を絶対パスで呼ぶ。下の「Claude Code で確かめる」を参照 |

フックはサンプルの中のプロジェクト単位の設定にだけ書くので、`~/.claude/` や `~/.codex/` は変わりません。確かめることごとにサンプルを作り直すと、前の確認の変更や記録が混ざりません。

### 確かめること

プロンプトは、エージェントが menou を知らない前提で、普通の作業依頼として書きます。

| 確かめること | プロンプトの例 | 期待する結果 |
| --- | --- | --- |
| 1. Lint エラーを残したまま完了しようとすると、ブロックされる | `src/app.js に、引数を console.log で出力する関数 greet を足して。終わったら完了して` | 理由文がエージェントに届く。エージェントが直すか、`maxBlocks`（既定は 3）回ブロックしたところで完了が許可される |
| 2. Lint エラーを直すと、完了できる | 1 と同じセッションを再開して、`console.log` を使わないよう頼む | ブロックされずに完了する |
| 3. `paths` の範囲外だけを変えたときは、ブロックされない | `docs/README.md に、使い方のセクションを足して、add(1, 2) の例を書いて。終わったら完了して` | ブロックされない。Lint も実行されない |
| 4. 何も変えない応答では、ブロックされない | `src/app.js の add 関数は何をする関数？ ファイルは変えずに答えて` | ブロックされない。Lint も実行されない |

結果は、サンプルの `.git/menou/` の下で確かめます。

| ファイル | 見ること |
| --- | --- |
| `sessions/<セッション ID>/baseline.json` | SessionStart のフックが動いて、ベースラインが記録されたか |
| `sessions/<セッション ID>/blocks.json` | `count` が続けてブロックした回数。1 では 1 以上、2 で通したあとは 0 になる。一度もブロックしていなければ、ファイルはない |
| `results/lint/<フィンガープリント>.json` | `result` が Lint の合否。1 では `fail`、2 では `pass` の記録ができる。3 と 4 では Lint を実行しないので、ファイルはできない |

### Claude Code で確かめる

スクリプトは `.claude/settings.json` に、SessionStart のフックとして `menou hook session-start` を、Stop のフックとして `menou hook stop` を登録します。

サンプルのディレクトリで、次のように起動します。

```sh
claude -p "<プロンプト>" --model sonnet \
  --setting-sources project \
  --permission-mode acceptEdits \
  --allowedTools "Bash(menou:*)" "Bash(node:*)" "Bash(git status:*)" "Bash(git diff:*)" \
  --output-format stream-json --verbose --include-hook-events > run.jsonl
```

- `--setting-sources project` を付けると、`~/.claude/settings.json` のフックが混ざらず、サンプルのフックだけが動きます
- `--permission-mode acceptEdits` と `--allowedTools` で、ファイルの編集と、理由文にある `menou run` や Lint のスクリプトの実行を許可します
- 2 では、1 の出力の最初にある `"subtype":"init"` の行から `session_id` を取り、`--resume <session_id>` を付けて起動します

`run.jsonl` では、次の行を見ます。

| 行 | 見ること |
| --- | --- |
| `"subtype":"hook_response"` で `"hook_event":"Stop"` | `stdout` が `menou hook stop` の出力。ブロックしたときは `{"decision":"block",...}`、通したときは `{}` |
| `Stop hook feedback:` で始まるユーザーのメッセージ | エージェントに届いた理由文 |
| `"subtype":"informational"` で `Stop says:` を含む行 | `maxBlocks` に達して完了を許可したときの `systemMessage` |
