# let・as・unknown・any・非 null アサーションを Lint で止める

- 日付：2026-11-06
- 状態：採用

## 背景

[20261104-lint-and-formatter.md](./20261104-lint-and-formatter.md) では、oxlint を既定の規則で使うことにしていました。このとき `src/`・`scripts/`・`test/` には、`let` が 30 か所、型アサーション（`as`）が 6 か所、自分で書いた `unknown` が 15 か所ありました。値があとから変わらないか、型を確かめてから付けているかは、読む人がそのつどコードを追って確かめるしかありませんでした。

oxlint 1.90.0 で、次の規則を使えば止められることを確かめました。

| 対象 | 止め方 |
| --- | --- |
| `let` | oxlint に規則がないので、`let` の宣言を報告する規則を自分で書き、`jsPlugins` で読み込む |
| `as` と `<型>` | `typescript/consistent-type-assertions` を `assertionStyle: "never"` にする。`as const` は通る |
| `unknown` | `typescript/no-restricted-types` に `unknown` を書く |
| `any` | `typescript/no-explicit-any`。`unknown` を止めると代わりに `any` を書きたくなるので、一緒に止める |
| 非 null アサーション（`x!`） | `typescript/no-non-null-assertion`。今のコードにはないが、型を確かめずに `undefined` と `null` を外せるので、一緒に止める |

`jsPlugins` は oxlint では試験段階の機能で、semver の対象外です。

## 決定

- `src/`・`scripts/`・`test/` で `let`・`as`・`<型>`・`unknown`・`any`・`x!` を書くと、`pnpm lint` が失敗するようにする。`as const` は使ってよい
- 設定は `.oxlintrc.json` に書き、既定の規則に上の 5 つを足す。警告も失敗として扱うのは変えない
- `let` を止める規則は `scripts/lint-plugin.mjs` に書く
- 規則が効いていることを `test/lint.test.ts` で確かめる
- `oxlint-disable` などのコメントで規則を外さない

この決定で、[20261104-lint-and-formatter.md](./20261104-lint-and-formatter.md) の「決定」にある「oxlint は既定の規則で使い」は、既定の規則に上の 5 つを足す形に代わります。ほかの決定は変わりません。

## 影響

変数は最後まで同じ値で、型は確かめてから付いている、と読む人が前提にできます。その代わり、途中で値が決まる処理は、関数に切り出したり `Promise.race` で先に来たものを取ったりする書き方になります。そのぶん、短い処理がいくつかの関数に分かれます。

`JSON.parse` の戻り値が書かずに `any` になることと、`catch` した `error` が書かずに `unknown` になることは止められません。止めるには型情報を使う Lint が要るからです。`JSON.parse` の結果はそのまま valibot の `safeParse` に渡し、`catch` した `error` は `instanceof Error` と `in` で絞ります。

oxlint を上げたときに、`jsPlugins` が動かなくなったり、`let` の規則が黙って効かなくなったりするおそれがあります。そうなったときは `test/lint.test.ts` が失敗するので気づけます。

テストで不正な設定を作るときは、`unknown` の代わりに fast-check の `JsonValue` を使います。
