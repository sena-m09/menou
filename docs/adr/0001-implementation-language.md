# 0001 実装言語と配布形態

- 日付：2026-11-02
- 状態：採用

## 背景

menou はエージェントが完了しようとするたびにフックから起動されるので、起動の速さが使い勝手に響きます。

npm パッケージとして入れた場合は `node_modules` から呼べますが、プラグインとして入れた場合は `node_modules` がありません。そのため、フックから `menou` をどう呼ぶかと、`.menou.json` の `$schema` に何を書くかが決まっていませんでした。

## 検討した選択肢

| | TypeScript / Node.js | Go | Rust |
| --- | --- | --- | --- |
| フック 1 回の起動時間（中央値） | 約 37 ms | 未計測 | 約 11〜20 ms |
| 利用者の環境に必要なもの | Node.js | なし | なし |
| JSON Schema の検証 | ajv（ビルド時にバリデータを生成すれば起動時間は増えない） | santhosh-tekuri/jsonschema | jsonschema クレート |
| スキーマからの型生成・ドキュメント生成 | 道具がそろっている | 少ない | 少ない |
| プラグインへの入れ方 | JS 1 ファイルを入れる | プラットフォームごとのバイナリを入れるか、初回にダウンロードする | 同左 |

起動時間は、Apple M3 の Mac で 3000 ファイルの git リポジトリを作り、最小のフックを 60 回ずつ実行して測りました。フックは stdin の JSON と `.menou.json` を読み、`git rev-parse` を 1 回呼んで `{}` を出力するだけのものです。

| 対象 | 中央値 (ms) |
| --- | --- |
| `git rev-parse` 単体 | 10.5 |
| Node.js | 37.2 |
| Node.js（ajv の事前生成バリデータを同梱） | 37.3 |
| Node.js（ajv で実行時にスキーマをコンパイル） | 54.8 |
| Rust（serde_json） | 11.4 |
| Rust（serde_json + jsonschema） | 20.4 |
| 一時インデックスへの `git add -A` と `git write-tree` | 37.2 |

Go は手元に処理系がなかったので測っていません。

TypeScript を Bun や Deno で単一バイナリにする案も試しました。1 つが 60〜80 MB になり、プラットフォームごとにプラグインへ入れるには大きすぎるので外しました。

## 決定

- TypeScript（Node.js）で実装する
- 依存を JS 1 ファイルにまとめ、npm パッケージとプラグインの両方に入れる
- プラグインのフックは、シェルスクリプト `bin/menou` を `"${CLAUDE_PLUGIN_ROOT}/bin/menou" hook <event>` で呼ぶ。`bin/menou` は `node` があるかを確かめてから、まとめた JS を `node` で実行する
- `.menou.json` の `$schema` には、npm に公開した `schema.json` をメジャー version で固定した URL（`https://unpkg.com/menou@1/schema.json`）を書く

## 理由

Node.js と Rust の起動時間の差は約 26 ms でした。この差は、Stop のたびにどの言語でもかかるフィンガープリントの計算（約 37 ms）より小さく、判断を左右しないと考えました。

`docs/README.md` では、JSON Schema を正としてドキュメントを生成する方針にしています。スキーマからの検証・型生成・ドキュメント生成の道具が最もそろっているのが TypeScript でした。

プラグインに入れるものが JS 1 ファイルで済みます。Go や Rust では、プラットフォームごとのバイナリで履歴が膨らむか、フックの中でネットワークにアクセスすることになります。

フックから `node` を直接呼ばず `bin/menou` を挟むのは、`node` が見つからないときに知らせるためです。`node` がないと menou 自体が起動しないので、`menou doctor` や SessionStart の案内では気づけません。

`$schema` を URL にするのは、プラグインで入れた人には `node_modules/menou/schema.json` が存在しないためです。

Node.js が必要になる点は、当面の利用者が Node.js の入った JS / TS のプロジェクトだと見込んで受け入れています。Node.js のない環境の利用者を主な対象にする場合は、Go の単一バイナリへの切り替えを検討し直します。
