# 設定と記録の検証に valibot を使う

- 日付：2026-11-06
- 状態：採用

## 背景

[20261102-implementation-language.md](./20261102-implementation-language.md) では、JSON Schema の道具を ajv にしました。`schema.json` を手で書き、そこから ajv で検証関数を生成してコミットし、`Config` の型は別に手で書いていました。

この形には 2 つの問題がありました。1 つめは、`Config` の型と `schema.json` がずれても気づけないことです。2 つめは、検証したあとの値に `as Config` で型を付けるので、コードに `as` と `unknown` が残ることです。

ajv の事前生成・valibot・zod・zod/mini を比べました。起動の時間は、`.menou.json` を読んで検証するだけの入口を 60 回ずつ実行した中央値で、`node -e ""` との差です。

| | 起動の増え方（Node.js 26） | まとめたファイル |
| --- | ---: | ---: |
| ajv の事前生成 | +2.1 ms | 21 KB |
| valibot | +2.5 ms | 17 KB |
| zod/mini | +4.2 ms | 48 KB |
| zod | +14.2 ms | 761 KB |

ajv と valibot の差は、測り直すたびのばらつき（0.1〜0.4 ms）と同じくらいでした。zod は、使わない部分も含めてライブラリのほぼ全体がまとめたファイルに入るので遅くなります。

valibot と zod/mini は、どちらもスキーマから型を導けます。検証の結果から、`as` を使わずに型の付いた値を受け取れます。valibot から書き出した JSON Schema は、今の `schema.json` とほぼ同じになりました。

## 決定

- `.menou.json` と記録の JSON の検証に valibot を使う
- スキーマは `src/config-schema.ts` に TypeScript で書き、`Config` と `CheckDefinition` の型をそこから導く
- `schema.json` は手で書かず、`pnpm generate` でスキーマから書き出す。書き出すのには `@valibot/to-json-schema` を使う。書き出したものとリポジトリの `schema.json` が違えば、`pnpm lint` で失敗する
- `hint` の文字数は、valibot の組み込みの `maxLength` で数える

この決定で、[20261102-implementation-language.md](./20261102-implementation-language.md) の「背景」と「決定」にある TypeScript の JSON Schema の道具は、ajv から valibot に代わります。TypeScript で実装する決定は変わりません。

zod/mini ではなく valibot を選んだのは、起動の時間とファイルの大きさが今の ajv とほぼ同じだからです。zod/mini は起動が約 2 ms 遅く、ファイルは 2 倍強になります。

置き換える前と後の `dist/menou.cjs` で、`menou status` の起動を同じやり方で測りました。Node.js 26.13.0 で 60 回ずつの計測を 3 回行い、中央値の `node -e ""` との差を範囲で載せています。

| `.menou.json` | 置き換える前 | 置き換えたあと |
| --- | ---: | ---: |
| [04-config.md](../04-config.md) の例（チェック 3 つ） | +138.3〜138.8 ms | +137.4〜138.8 ms |
| `checks` が空 | +16.4〜17.0 ms | +16.8〜17.1 ms |

`checks` が空のときの差は 0.1〜0.4 ms でした。チェックがあるときは、フィンガープリントを計算する git の処理が大半を占め、前後の差は回ごとのばらつきに埋もれました。`dist/menou.cjs` は 47.6 KB から 53.3 KB になりました。

## 影響

`Config` の型がスキーマから決まるので、型と `schema.json` がずれなくなります。設定と記録の読み込みから、`as` と自分で書く `unknown` がなくなります。

valibot の `maxLength` は UTF-16 の単位で数えます。エディタは `schema.json` の `maxLength` をコードポイントで数えるので、`hint` に絵文字などを含むと、文字数の判定がエディタと menou でずれることがあります。

書き出した `schema.json` は、`enum` に `"type": "string"` が付き、キーの順序が変わりました。決まりは変わりません。書き出したものは oxfmt の整形と合わないので、`schema.json` はフォーマットの対象から外しています。

valibot を `^` で上げたときに、Node.js 22.0.0 にない API を使い始めるかもしれません。`pnpm test:floor` で、Node.js 22.0.0 がビルドしたファイルで `.menou.json` を読めることを確かめます。
