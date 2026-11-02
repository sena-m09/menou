# 0001 実装言語と配布形態

- 日付：2026-11-02
- 状態：採用

## 背景

menou はエージェントが完了しようとするたびにフックから起動されるので、起動の速さが使い勝手に響きます。

npm パッケージとして入れた場合は `node_modules` から呼べますが、プラグインとして入れた場合は `node_modules` がありません。そのため、フックから `menou` をどう呼ぶかと、`.menou.json` の `$schema` に何を書くかが決まっていませんでした。

## 検討した選択肢

TypeScript（Node.js）と Rust を比べました。

| | TypeScript / Node.js | Rust |
| --- | --- | --- |
| フック 1 回の起動時間（中央値） | 約 37 ms | 約 11〜20 ms |
| JSON Schema の道具 | ajv | jsonschema クレートで検証、schemars でスキーマを生成 |
| 利用者の環境に必要なもの | Node.js | なし |
| プラグインへの入れ方 | JS 1 ファイルを入れる | プラットフォームごとのバイナリを入れるか、初回にダウンロードする |

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

Go も候補にしましたが、手元に処理系がなく計測していません。配布の課題は Rust と同じです。

TypeScript を Bun や Deno で単一バイナリにする案も試しました。1 つが 60〜80 MB になり、プラットフォームごとにプラグインへ入れるには大きすぎるので外しました。

## 決定

- TypeScript（Node.js）で実装する
- 依存を JS 1 ファイルにまとめ、npm パッケージとプラグインの両方に入れる
- バンドル時に文法を古い Node.js 向けに落とし、使う API を絞る。下限の version は #6 で決める
- プラグインのフックは `"${CLAUDE_PLUGIN_ROOT}/bin/menou" hook <event>` で呼ぶ。`bin/menou` はシェルスクリプトのラッパーで、`node` がなければその旨を出して止まる
- `.menou.json` の `$schema` には、npm に公開した `schema.json` をメジャー version で固定した URL（`https://unpkg.com/menou@1/schema.json`）を書く

## 理由

起動時間の差は、git の処理に埋もれます。Node.js と Rust の差は約 26 ms で、Stop のたびにどちらでもかかるフィンガープリントの計算（約 37 ms）より小さくなりました。

JSON Schema の道具は、どちらにもあります。TypeScript では ajv、Rust では jsonschema クレートと schemars が使えるので、ここでは差がつきませんでした。

決め手は配布と実行環境です。当面は個人単位で試してもらうので、利用者のリポジトリの `package.json` に menou を追加してもらうことはできません。そのため、プラグイン 1 つで始められることが要ります。TypeScript なら、プラグインに JS 1 ファイルを入れれば済みます。Rust では、プラットフォームごとのバイナリで履歴が膨らむか、フックの中でネットワークにアクセスすることになります。

Node.js が必要になる点は受け入れます。使うのはフロントエンドのプロジェクトが中心なので、Node.js がある前提に立てます。

フックから `node` を直接呼ばずに `bin/menou` を挟むのは、`node` が見つからないときに気づけるようにするためです。`node` がないと menou 自体が起動しないので、`menou doctor` や SessionStart の案内では知らせられません。

`$schema` を URL にするのは、プラグインで入れた人には `node_modules/menou/schema.json` が存在しないためです。

Node.js のない環境での利用が増えたら、言語を見直します。
