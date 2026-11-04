# Lint とフォーマッタ

- 日付：2026-11-04
- 状態：採用

## 背景

M0 の雛形では、Lint に ESLint（typescript-eslint と eslint-plugin-n）を、フォーマッタに Prettier を使っていました。これを oxlint と oxfmt に置き換えるにあたって、決めることが 2 つありました。

1 つめは、Node.js 16 にない API をどう使わせないかです。[20261102-implementation-language.md](./20261102-implementation-language.md) では、実行時の下限を Node.js 16.0.0 にしています。ESLint では、eslint-plugin-n の `no-unsupported-features/node-builtins` がこの役目を担っていました。oxlint 1.90.0 の規則を一覧で確かめたところ、Node.js の version に合わせて API を止める規則はありませんでした。

代わりの守り方として、次の 2 つを比べました。

| | `@types/node` を 16 系に固定する | oxlint の `no-restricted-globals` などに API を並べる |
| --- | --- | --- |
| 止められる範囲 | Node.js 17 以降で増えた API をまとめて止められる | 並べた API だけ |
| 手間 | 下限を変えるときに `@types/node` のメジャー version を合わせる | 使いそうな API を自分で調べて書き足し続ける |
| 16.x の途中で増えた API | 止められない | 並べれば止められる |

2 つめは、TypeScript の version です。typescript-eslint が TypeScript 6.1 未満にしか対応していないので、TypeScript を 6.0 系に固定していました。

## 決定

- Lint は oxlint、フォーマッタは oxfmt にする。`pnpm lint` で、型チェック・oxlint・oxfmt の確認を順に実行する
- oxlint は既定の規則で使い、警告も失敗として扱う
- Markdown と `pnpm-lock.yaml` は、フォーマットの対象から外す
- Node.js 16 にない API は、`@types/node` を 16 系に固定して型エラーにする。ECMAScript の組み込みメソッドは、これまでどおり `tsconfig.json` の `lib` で止める
- `pnpm test:floor` で、Node.js 16.0.0 で起動できることを確かめ続ける

この決定で、[20261102-implementation-language.md](./20261102-implementation-language.md) の「影響」にある「eslint-plugin-n で使えないようにし」は、`@types/node` を固定する方法に代わります。実装言語の決定は変わりません。

## 影響

TypeScript の version が、Lint の道具に縛られなくなります。TypeScript 7 でも型チェックが通り、Node.js 16 にない API が型エラーになることを確かめています。上げるかどうかは別に決めます。

16.x の途中で増えた API は止められません。`@types/node` 16 系の型は 16 系の最新に合わせてあるので、`Array.prototype.at`（16.6）や `fs.cpSync`（16.7）を使っても型エラーになりません。eslint-plugin-n はマイナー version まで見ていたので、守りは粗くなります。`pnpm test:floor` で見つけられるのも、`--version` で起動したときに通る範囲だけです。

テストも Node.js 16 の型で書くことになります。テストは開発用の Node.js で動きますが、`import.meta.dirname` のような新しい API は型エラーになるので使えません。

Vitest と Vite は `@types/node` 20 以上を求めているので、install のたびに警告が出ます。型チェックとテストは通ります。

実行時の下限を変えるときは、`engines.node`・`tsconfig.json` の `lib`・`pnpm test:floor` のイメージ・`bin/menou` のメッセージに加えて、`@types/node` のメジャー version も合わせます。
