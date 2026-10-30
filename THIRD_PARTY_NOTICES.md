# Third-party notices

## Repository tooling

`bin/mise`、`bin/mise.cmd` と `bin/` 内のタスク起動スクリプトは、mise 2026.10.23 が生成したコードを含みます。

- Upstream: [jdx/mise v2026.10.23](https://github.com/jdx/mise/tree/v2026.10.23)
- License: MIT
- Copyright (c) 2025 Jeff Dickey
- ライセンス全文: [licenses/mise-MIT.txt](licenses/mise-MIT.txt)
- 正本: [upstream LICENSE](https://github.com/jdx/mise/blob/v2026.10.23/LICENSE)

## Bundled extension

拡張に含まれる第三者コードの表記は、ビルド時に Vite が収集したバンドルの依存情報から生成する `THIRD_PARTY_NOTICES.txt` と `THIRD_PARTY_LICENSES.json` に記録します。これらはビルド済み拡張と配布 ZIP に同梱します。

npm パッケージにライセンス本文が含まれない WXT ランタイム用の正本は、[licenses/wxt-MIT.txt](licenses/wxt-MIT.txt) です。次の upstream ソースで同じ MIT ライセンス本文を確認しています。

- [wxt 0.21.5 の LICENSE](https://github.com/wxt-dev/wxt/blob/e690f91730aa679a58fba905f30f8ca80ea4f490/LICENSE)
- [@wxt-dev/browser 0.3.7 のソースに対応する LICENSE](https://github.com/wxt-dev/wxt/blob/8fb1f6d84eb0bb9a6391eb6affb4182e033bdde2/LICENSE)

Copyright (c) 2023 Aaron
