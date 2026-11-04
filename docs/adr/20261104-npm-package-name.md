# npm のパッケージ名

- 日付：2026-11-04
- 状態：採用

## 背景

[20261102-implementation-language.md](./20261102-implementation-language.md) では、menou を npm パッケージとプラグインの両方で配ることにしました。`.menou.json` の `$schema` にも、npm に公開した `schema.json` の URL を書きます。

2026-11-04 に `menou` という名前で公開しようとしたところ、npm に拒否されました。名前はまだ使われていませんでしたが、既存の `meow` と似すぎていると判定されたためです。npm からは、`@sena-m09/menou` のようにスコープを付けて公開するよう案内されました。

次の 3 つを比べました。

| | `@sena-m09/menou` | 組織を作って `@menou/cli` | スコープなしの別の名前（`menou-cli` など） |
| --- | --- | --- | --- |
| 確実に取れるか | 取れる | 組織名 `menou` が空いているか分からない | 同じ理由でまた拒否されるかもしれない |
| GitHub のリポジトリとの対応 | `sena-m09/menou` と揃う | 揃わない | 揃わない |
| 準備 | なし | npm で組織を作る | なし |

## 決定

- npm のパッケージ名は `@sena-m09/menou` にする。コマンド名は `menou` のまま変えない
- `package.json` の `publishConfig` で、公開の範囲を public にする
- `.menou.json` の `$schema` には `https://unpkg.com/@sena-m09/menou@1/schema.json` を書く

この決定で、[20261102-implementation-language.md](./20261102-implementation-language.md) の「決定」にある `$schema` の URL（`https://unpkg.com/menou@1/schema.json`）は、上の URL に代わります。URL を npm の公開物に向けることと、メジャー version で固定することは変わりません。

menou は今のところ個人のプロジェクトで、当面はプラグインで入れてもらうので、npm の名前が目に入る場面は多くありません。そのため、準備なしで確実に取れて、GitHub とも揃う個人のスコープにしました。

## 影響

npm から入れるときのコマンドは `npm i -D @sena-m09/menou` と長くなります。

パッケージの名前が個人のアカウントに結びつきます。ほかの人と一緒に育てることになって組織のスコープに移すときは、新しい名前で公開し直し、`$schema` の URL も変えます。古い名前の公開物は残るので、古い URL を書いた `.menou.json` も補完と検証が効き続けます。
