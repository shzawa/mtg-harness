# MTG Harness

[![CI](https://github.com/shzawa/mtg-harness/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/shzawa/mtg-harness/actions/workflows/ci.yml)
[![Dependency audit](https://github.com/shzawa/mtg-harness/actions/workflows/dependency-audit.yml/badge.svg?branch=main)](https://github.com/shzawa/mtg-harness/actions/workflows/dependency-audit.yml)
[![Release](https://img.shields.io/github/v/release/shzawa/mtg-harness?logo=github)](https://github.com/shzawa/mtg-harness/releases/latest)
[![License](https://img.shields.io/github/license/shzawa/mtg-harness?color=blue)](https://github.com/shzawa/mtg-harness/blob/main/LICENSE)

[![WXT](https://img.shields.io/badge/WXT-67D55E?logo=wxt&logoColor=white)](https://wxt.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Oxc](https://img.shields.io/badge/Oxc-FF9159?logo=oxc&logoColor=white)](https://oxc.rs/)
[![Vitest](https://img.shields.io/badge/Vitest-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev/)
[![Renovate](https://img.shields.io/badge/Renovate-1A1F6C?logo=renovate&logoColor=white)](https://github.com/shzawa/mtg-harness/blob/main/renovate.json)

Google Meet の対象ページを誤って閉じてしまい、会議から離脱することを防ぐ Chrome／Edge 向けブラウザ拡張です。ページ内を一度操作した後、タブを閉じる前にブラウザ標準の確認を表示します。キャンセルするとタブに残れます。

[WXT](https://wxt.dev/) を使い、拡張本体・CI 用スクリプト・テストを TypeScript で実装しています。

## インストール（ビルド不要）

1. [最新の Release](https://github.com/shzawa/mtg-harness/releases/latest) から `mtg-harness-<version>-chrome.zip` をダウンロードし、解凍します。
2. 解凍したフォルダを保管したい場所へ移動します。インストール後も削除しないでください。
3. `chrome://extensions`（Edge は `edge://extensions`）で「デベロッパー モード」をオンにし、「パッケージ化されていない拡張機能を読み込む」から `manifest.json` が入っているフォルダを選びます。
4. すでに開いている対象の Meet タブは、会議参加前に再読み込みします。

自動更新はありません。更新時は保管したフォルダの中身を新しい ZIP の中身で置き換え、拡張管理画面で拡張を再読み込みしてください。

## セットアップとビルド

Node.js・pnpm・GitHub CLI は [mise](https://mise.jdx.dev/) で管理します。[公式 Tips](https://mise.jdx.dev/tips-and-tricks.html#let-contributors-run-tasks-without-installing-mise) に沿った `bin/mise` が、固定バージョンの mise をチェックサム検証して取得します。mise や Node.js を事前にインストールする必要はありません。macOS／Linux では Git、Bash、curl または wget、tar、shasum または sha256sum が必要です。

以下は zsh での初回セットアップです。

```sh
git clone https://github.com/shzawa/mtg-harness.git
cd mtg-harness
./bin/mise install --locked
eval "$(./bin/mise env -s zsh)"
pnpm install --frozen-lockfile
pnpm build
```

Node.js・pnpm・GitHub CLI は `mise.toml` に固定し、pnpm は `package.json` の `packageManager` にも同じバージョンを指定します。取得 URL とチェックサムは `mise.lock` に記録しています。ツール・キャッシュ・状態はプロジェクトの `.mise/` に保存します。以下のコマンドはリポジトリ直下で実行してください。

新しいターミナルを開いたら、リポジトリ直下で `eval "$(./bin/mise env -s zsh)"` を一度実行してください。Bash では `eval "$(./bin/mise env -s bash)"` を使います。同じセッションで `node`・`pnpm`・`gh` を直接使えるようになります。すでに mise をシェルに組み込んでいる場合は、このリポジトリの固定ツールが有効になっていれば env の実行は不要です。

Windows の PowerShell では、初回セットアップを次のように実行します。新しいターミナルでは、リポジトリ直下で2行目の env コマンドを実行してください。

```powershell
.\bin\mise.cmd install --locked
.\bin\mise.cmd env -s pwsh | Out-String | Invoke-Expression
pnpm install --frozen-lockfile
pnpm build
```

開発コマンドは `package.json` の scripts にまとめています。CI 用スクリプトは Node.js 標準の TypeScript 実行機能で、テストは Vitest で実行します。

Chrome で `chrome://extensions`（Edge は `edge://extensions`）を開き、「デベロッパー モード」をオンにします。「パッケージ化されていない拡張機能を読み込む」から `.output/chrome-mv3` フォルダを選択してください。リポジトリ直下ではなく、ビルド済みのフォルダを選びます。このフォルダはインストール後も保管してください。

すでに開いている対象の Meet タブは、会議参加前に再読み込みしてください。

## 使い方

対象ページ内を一度クリックするか、キー入力してから使ってください。タブの × や `⌘W`／`Ctrl+W` などで閉じようとすると確認が表示されます。キャンセルするとタブに残り、閉じることを許可するとタブが閉じます。メッセージやボタン名はブラウザの種類・言語により異なります。

退出後の画面で、表示中の `h1` が「ミーティングから退出しました」と一致する場合は、この拡張の確認を省略します（前後の空白は無視）。同じ URL のまま再参加してこの見出しが消えたり変わったりすると、確認が再び有効になります。

## 対象 URL

**`https://meet.google.com/meet/` で始まる URL だけ**が対象です。日本語の退出後画面を見出しから検知した場合を除き、この URL にいる間に確認します。

| URL の例                                                  | この拡張の確認 |
| --------------------------------------------------------- | -------------- |
| `https://meet.google.com/meet/`                           | あり           |
| `https://meet.google.com/meet/example`                    | あり           |
| `https://meet.google.com/meet/example?authuser=1#section` | あり           |
| `https://meet.google.com/`                                | なし           |
| `https://meet.google.com/abc-defg-hij`                    | なし           |
| `https://meet.google.com/meet`（末尾の `/` なし）         | なし           |
| Google Meet 以外のサイト                                  | なし           |

リダイレクト後や、ページの再読み込みなしで URL が変わった場合は、その時点の URL で判定します。

## 制約

- 離脱処理中は `window.confirm()` が抑止されるため、`beforeunload` によるブラウザ標準の確認を使います。確認文言は変更できません。
- ページ内で一度も操作していないと、ブラウザは確認を表示しません。タブを選択するだけでは十分でないことがあります。
- 再読み込み・別ページへの移動でも確認が出ます。閉じる操作だけを区別することはできません。同じページ内で URL だけが変わる場合には確認は出ません。
- Meet 内の「通話から退出」ボタンを押す操作は止めません。
- 退出後の判定は日本語の `h1`「ミーティングから退出しました」だけに対応します。非表示の見出しや本文中の同じ文字列では確認を省略しません。他の言語や Meet 側の見出し変更時は確認を続けます。
- ブラウザの強制終了・クラッシュなどでは確認を保証できません。
- `/abc-defg-hij` など、指定の範囲外へ移動した後は確認しません。

## 開発

```sh
pnpm dev       # 開発ビルドとブラウザ起動
pnpm check     # 監査・整形チェック・lint・型検査・Release 処理のテスト
pnpm build     # Chrome/Edge 向け Manifest V3 ビルド
pnpm zip       # 配布用 ZIP を .output/ に作成
pnpm lint:fix  # Oxlint の自動修正
pnpm format    # Oxfmt で整形
pnpm typecheck # 型検査
pnpm actions:check # Actions の SHA・完全バージョン指定を検査
```

lint は [Oxlint](https://oxc.rs/docs/guide/usage/linter.html)、format は [Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html) を使用します。型検査は WXT 用と Node.js 用の TypeScript 設定で行います。

開発用フォルダは `.output/chrome-mv3-dev` です。拡張の動作確認には、本番ビルドの `.output/chrome-mv3` を使ってください。

ツールの更新は `mise.toml`、pnpm の更新は併せて `package.json` の `packageManager` を変更し、次の順で反映・検証します。ツールのインストール後に env を再実行して、更新したツールをシェルへ反映してください。

```sh
./bin/mise lock
./bin/mise install --locked
eval "$(./bin/mise env -s zsh)"
pnpm install --frozen-lockfile
pnpm check
```

Bash／PowerShell ではセットアップ時と同じ env コマンドを使います。設定と `mise.lock` を一緒にコミットしてください。`mise.lock` は macOS（arm64／x64）・Linux（arm64／x64）・Windows（x64）用です。mise 本体の更新は、新しい mise で `generate install-script --version <version> --localize --write bin/mise --windows` を再実行します。

## 依存パッケージの安全性

`pnpm-workspace.yaml` に次のポリシーを設定しています。

- 直接・間接依存とも公開から48時間未満のバージョンを拒否します。公開日時を確認できない場合も停止し、既存の lockfile も検査します。
- 過去の公開に比べて provenance や trusted publishing などの信頼性が下がったバージョンを拒否します。間接依存の Git／任意 URL からの取得も制限します。
- 未承認の依存パッケージの install スクリプトがあると停止します。`fsevents` のビルドは明示的に禁止し、実行を許可した依存パッケージはありません。プロジェクト自身の `postinstall`（`wxt prepare`）は実行します。
- ストアの整合性を確認し、インストールの省略を無効にしています。依存状態が古いままの `pnpm run`／`pnpm exec` は停止するため、先に `pnpm install --frozen-lockfile` を実行してください。

新しい依存に install スクリプトが必要な場合は、対象バージョンとスクリプトを確認してから `allowBuilds` に個別の許可を追加してください。更新が48時間の待機期間に該当した場合は、待機後に再実行します。これらはリスクを下げる仕組みであり、パッケージの安全性を保証するものではありません。設定の詳細は [pnpm のサプライチェーン対策](https://pnpm.io/supply-chain-security)を参照してください。

CI は `pnpm audit --audit-level high` で High／Critical の既知の脆弱性が見つかると停止します。低い重大度も含めて確認するには `pnpm audit` を実行します。監査の通信エラーや修正版のない問題を一括で無視する設定は使っていません。

2026-10-30 の監査では、開発依存の `deepmerge` に修正版未公開の Low が1件あります（[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)）。除外リストには登録していません。

## リポジトリの保護と依存更新

`main` への変更には PR と `check` の成功を必須とし、force push とブランチ削除を禁止しています。GitHub の secret scanning・push protection・Dependabot alerts も有効にしています。依存関係の登録状況に左右されず検知できるよう、毎日07:23（日本時間）に lockfile を `pnpm audit --audit-level high` で監査します。この監査ではアプリの依存パッケージをインストールしません。

[Renovate GitHub App](https://github.com/apps/renovate) をこのリポジトリに接続すると、`renovate.json` の方針で更新 PR を作成します。

- npm の直接依存・pnpm・mise のツール・GitHub Actions を対象とし、完全バージョンと Actions の SHA 固定を維持します。pnpm の2つの指定は同じ PR にまとめます。
- 通常の更新と lockfile の保守は毎週月曜03:00〜09:00（日本時間）に行います。公開から48時間に加えて30分待ち、公開日時が分からない更新は保留します。
- 通常の PR は同時3件・1時間に2件までです。メジャー更新は分離し、Dependency Dashboard で承認してから PR を作成します。自動マージは行いません。
- 脆弱性の修正 PR は通常の曜日制限を受けませんが、48時間の待機と既存の pnpm ポリシーは維持します。Renovate にパッケージの install スクリプトや任意の更新スクリプトは実行させません。

mise の lockfile 更新は safe mode に対応した実行環境が必要です。更新 PR で `mise.lock` の生成に失敗した場合は、上記の手順で再生成して同じ PR に追加し、CI の成功を確認してください。`bin/mise`・`bin/mise.cmd` は生成物のため、mise 本体の更新は上記の生成コマンドで行います。WXT やバンドル依存の更新では、ライセンスの承認情報も確認してください。

## テスト

```sh
pnpm test:e2e:install
pnpm test
```

テストは `channel: 'chromium'` の Chromium を使うため、導入時は未使用の headless shell を取得しません。Linux の OS 依存ライブラリを導入するコマンドは `pnpm test:e2e:deps` です。

テストランナーは Vitest です。`release` プロジェクトで Release 処理を、`e2e` プロジェクトで Playwright を使ったブラウザ動作を検証します。

ブラウザテストは、ビルド済み拡張を Chromium に読み込み、閉じる前の確認、キャンセル後の再確認、更新・遷移、対象 URL の境界、再読み込みなしの URL 変更、日本語の退出後画面での省略と再参加時の保護復帰を検証します。テスト用ページは通信を差し替えて配信するため、Google アカウントや実際の会議は不要です。実際の Google Meet 会議での確認は別途行ってください。

`pnpm test:release` で Release テストだけを、ビルド後の `pnpm test:e2e` でブラウザテストだけを実行できます。

GitHub Actions でも同じ `bin/mise` と `mise.lock` でツールを取得し、依存パッケージの監査・format・lint・型検査・ビルド・ブラウザテスト・ZIP 作成を実行します。成功した実行の `chrome-extension` アーティファクトから、ビルド済み拡張をダウンロードできます。

CI では静的検査・単体テスト、OS 依存の更新・導入、Chromium の取得を並列に実行し、すべての成功を待ってからビルドとブラウザテストへ進みます。インストール済みツール・依存・ブラウザのキャッシュは使わず、固定バージョンの検証と OS 依存の更新を毎回行います。

GitHub Actions の外部参照は、40桁のコミット SHA と、同じ行の完全な安定版バージョン表記（`# v6.1.0` など）を必須にしています。`@v6`・`@v6.1`・タグだけの参照・SHA とバージョンの不一致は許可しません。

```yaml
- uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
```

`pnpm actions:check`（`pnpm check` にも含む）で全ワークフローとローカルの `action.yml`／`action.yaml` を検査します。CI は `pnpm actions:check --verify-upstream` で公式タグが指すコミットとの一致も確認し、取得エラーでも停止します。更新時は SHA と完全バージョン表記を一緒に変更して検証してください。

再利用ワークフローとローカル composite action 内の外部参照も対象です。ローカルの `./` 参照は同一リポジトリのコードとして検査します。実行定義での YAML の別名・merge キーと Docker action は、現在のポリシーでは許可しません。リポジトリ設定でも `Require actions to be pinned to a full-length commit SHA` を有効にしています。

実際の URL で参加前のページを確認する場合は、CI を手動実行して `live_url` を指定します。これは通信を差し替えずにページを開き、URL、操作後の確認、キャンセル後のタブ維持を検証します。会議への参加や、マイク・カメラへのアクセス許可は行いません。会議参加中の接続維持は別途確認が必要です。

```sh
gh workflow run ci.yml -f live_url='https://meet.google.com/meet/your-meeting-code'
```

結果の JSON とスクリーンショットは、その実行の `live-meet-verification` アーティファクトに保存されます。

## バージョン更新と自動 Release

`package.json` のバージョンを増やす PR を `main` にマージすると、依存パッケージの監査・format・lint・型検査・Release 処理のテスト・Chromium のブラウザテストを通過した後に、`v<version>` タグと GitHub Release を自動作成します。Release には、その CI でテストしたビルドの ZIP が添付されます。

バージョンの更新には、次のコマンドを使います。

```sh
git switch -c chore/bump-extension-version
pnpm version patch --no-git-tag-version
git add package.json pnpm-lock.yaml
git commit -m "chore: bump extension version"
git push --set-upstream origin HEAD
gh pr create --base main
```

マイナー更新は `patch` を `minor` に、メジャー更新は `major` に変更します。対応するバージョン形式は `1.0.0` のような3つの数値です。タグはテスト成功後に CI が作成するため、ローカルでタグを作る必要はありません。

同じバージョンの公開済み Release は上書きしません。GitHub の immutable releases 設定も有効にしており、設定有効後に発行する Release は公開後のタグ・添付 ZIP の変更を防ぎます。バージョンを変えない通常のコミットでは Release は増えず、バージョンを下げて未発行の Release を作る操作は失敗します。

公開が必要かどうかは読み取り権限のジョブで判定します。現在のバージョンが正常に公開済みなら、書き込み権限の Release ジョブは起動しません。新バージョンや下書きの公開時は、すべての検査を通過した後に従来のバージョン・タグ・ZIP の検証を実行します。

CI が失敗した場合は Release を公開しません。ZIP が未添付の下書きが残った場合は、同じコミットの CI を再実行すると、添付と公開を再開できます。不完全な同名ファイルが残っている場合は、上書きせず停止します。公開には GitHub Actions 標準の `GITHUB_TOKEN` を使用し、追加のシークレット設定は不要です。

## サイトへのアクセス

スクリプトは `https://meet.google.com/*` のトップレベルのページで実行します。再読み込みせずに `/meet/` 以下へ移動した場合にも対応するためです。確認は閉じる時点の URL が `/meet/` で始まる場合だけに限定します。

退出後の画面かを判定するため、対象ページの `h1` の表示テキストを読み取ります。音声・カメラの取得、データの保存、外部への送信はありません。`tabs` や `<all_urls>` などの追加権限も使いません。開発モードでは WXT の開発用通信が加わるため、配布には本番ビルドを使ってください。

## ライセンス

このプロジェクトは [MIT License](LICENSE) です。リポジトリに含まれる mise 生成スクリプトのライセンスは、[第三者コードの表記](THIRD_PARTY_NOTICES.md)に記載しています。

ビルド済み拡張と配布 ZIP には、プロジェクトの `LICENSE` と、実際にバンドルされた依存情報から Vite が生成する `THIRD_PARTY_NOTICES.txt`・`THIRD_PARTY_LICENSES.json` を同梱します。

CI は `pnpm license:check` で ZIP 内の全文表記を確認します。バンドルされる依存の追加・バージョン・ライセンス・本文が変わった場合はビルドを止めるため、上流のライセンスを確認し、`scripts/licenses.ts` の承認情報と `licenses/` の正本を更新してください。

開発依存を含むインストール済みパッケージ全体のライセンス情報は、次のコマンドで確認できます。この一覧は配布バンドルに含まれるパッケージの一覧とは異なります。

```sh
pnpm licenses list --json
```

## 参考資料

- [MDN: beforeunload](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)
- [WXT: Content Scripts](https://wxt.dev/guide/essentials/content-scripts.html)
- [Chrome: Load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
