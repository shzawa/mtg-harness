# MTG Harness

Google Meet の対象ページを誤って閉じてしまい、会議から離脱することを防ぐ Chrome／Edge 向けブラウザ拡張です。ページ内を一度操作した後、タブを閉じる前にブラウザ標準の確認を表示します。キャンセルするとタブに残れます。

[WXT](https://wxt.dev/) を使い、拡張本体・CI 用スクリプト・テストを TypeScript で実装しています。

## インストール（ビルド不要）

1. [最新の Release](https://github.com/shzawa/mtg-harness/releases/latest) から `mtg-harness-<version>-chrome.zip` をダウンロードし、解凍します。
2. 解凍したフォルダを保管したい場所へ移動します。インストール後も削除しないでください。
3. `chrome://extensions`（Edge は `edge://extensions`）で「デベロッパー モード」をオンにし、「パッケージ化されていない拡張機能を読み込む」から `manifest.json` が入っているフォルダを選びます。
4. すでに開いている対象の Meet タブは、会議参加前に再読み込みします。

自動更新はありません。更新時は保管したフォルダの中身を新しい ZIP の中身で置き換え、拡張管理画面で拡張を再読み込みしてください。

## セットアップとビルド

Node.js 24 以上と npm が必要です。CI 用スクリプトは Node.js 標準の TypeScript 実行機能で、テストは Vitest で実行します。

```sh
gh repo clone shzawa/mtg-harness
cd mtg-harness
npm ci
npm run build
```

Chrome で `chrome://extensions`（Edge は `edge://extensions`）を開き、「デベロッパー モード」をオンにします。「パッケージ化されていない拡張機能を読み込む」から `.output/chrome-mv3` フォルダを選択してください。リポジトリ直下ではなく、ビルド済みのフォルダを選びます。このフォルダはインストール後も保管してください。

すでに開いている対象の Meet タブは、会議参加前に再読み込みしてください。

## 使い方

対象ページ内を一度クリックするか、キー入力してから使ってください。タブの × や `⌘W`／`Ctrl+W` などで閉じようとすると確認が表示されます。キャンセルするとタブに残り、閉じることを許可するとタブが閉じます。メッセージやボタン名はブラウザの種類・言語により異なります。

## 対象 URL

**`https://meet.google.com/meet/` で始まる URL だけ**が対象です。参加状態は判定せず、この URL にいる間に確認します。

| URL の例 | この拡張の確認 |
| --- | --- |
| `https://meet.google.com/meet/` | あり |
| `https://meet.google.com/meet/example` | あり |
| `https://meet.google.com/meet/example?authuser=1#section` | あり |
| `https://meet.google.com/` | なし |
| `https://meet.google.com/abc-defg-hij` | なし |
| `https://meet.google.com/meet`（末尾の `/` なし） | なし |
| Google Meet 以外のサイト | なし |

リダイレクト後や、ページの再読み込みなしで URL が変わった場合は、その時点の URL で判定します。

## 制約

- 離脱処理中は `window.confirm()` が抑止されるため、`beforeunload` によるブラウザ標準の確認を使います。確認文言は変更できません。
- ページ内で一度も操作していないと、ブラウザは確認を表示しません。タブを選択するだけでは十分でないことがあります。
- 再読み込み・別ページへの移動でも確認が出ます。閉じる操作だけを区別することはできません。同じページ内で URL だけが変わる場合には確認は出ません。
- Meet 内の「通話から退出」ボタンを押す操作は止めません。
- ブラウザの強制終了・クラッシュなどでは確認を保証できません。
- `/abc-defg-hij` など、指定の範囲外へ移動した後は確認しません。

## 開発

```sh
npm run dev        # 開発ビルドとブラウザ起動
npm run typecheck  # 拡張・スクリプト・テストの型検査
npm run build      # Chrome/Edge 向け Manifest V3 ビルド
npm run zip        # 配布用 ZIP を .output/ に作成
npm run test:release # Release 処理のテスト
```

開発用フォルダは `.output/chrome-mv3-dev` です。拡張の動作確認には、本番ビルドの `.output/chrome-mv3` を使ってください。

## テスト

```sh
npx playwright install chromium
npm run typecheck
npm test
```

テストランナーは Vitest です。`release` プロジェクトで Release 処理を、`e2e` プロジェクトで Playwright を使ったブラウザ動作を検証します。

ブラウザテストは、ビルド済み拡張を Chromium に読み込み、閉じる前の確認、キャンセル後の再確認、更新・遷移、対象 URL の境界、再読み込みなしの URL 変更を検証します。テスト用ページは通信を差し替えて配信するため、Google アカウントや実際の会議は不要です。実際の Google Meet 会議での確認は別途行ってください。

`npm run test:release` で Release テストだけを、ビルド後の `npm run test:e2e` でブラウザテストだけを実行できます。

GitHub Actions でも型検査・ビルド・ブラウザテスト・ZIP 作成を実行します。成功した実行の `chrome-extension` アーティファクトから、ビルド済み拡張をダウンロードできます。

実際の URL で参加前のページを確認する場合は、CI を手動実行して `live_url` を指定します。これは通信を差し替えずにページを開き、URL、操作後の確認、キャンセル後のタブ維持を検証します。会議への参加や、マイク・カメラへのアクセス許可は行いません。会議参加中の接続維持は別途確認が必要です。

```sh
gh workflow run ci.yml -f live_url='https://meet.google.com/meet/your-meeting-code'
```

結果の JSON とスクリーンショットは、その実行の `live-meet-verification` アーティファクトに保存されます。

## バージョン更新と自動 Release

`package.json` のバージョンを増やして `main` に push すると、型検査・Release 処理のテスト・Chromium のブラウザテストを通過した後に、`v<version>` タグと GitHub Release を自動作成します。Release には、その CI でテストしたビルドの ZIP が添付されます。

バージョンとロックファイルを同時に更新するには、次のコマンドを使います。

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: bump extension version"
git push origin main
```

マイナー更新は `patch` を `minor` に、メジャー更新は `major` に変更します。対応するバージョン形式は `1.0.0` のような3つの数値です。タグはテスト成功後に CI が作成するため、ローカルでタグを作る必要はありません。

同じバージョンの公開済み Release は上書きしません。バージョンを変えない通常のコミットでは Release は増えず、バージョンを下げて未発行の Release を作る操作は失敗します。

CI が失敗した場合は Release を公開しません。ZIP が未添付の下書きが残った場合は、同じコミットの CI を再実行すると、添付と公開を再開できます。不完全な同名ファイルが残っている場合は、上書きせず停止します。公開には GitHub Actions 標準の `GITHUB_TOKEN` を使用し、追加のシークレット設定は不要です。

## サイトへのアクセス

スクリプトは `https://meet.google.com/*` のトップレベルのページで実行します。再読み込みせずに `/meet/` 以下へ移動した場合にも対応するためです。確認は閉じる時点の URL が `/meet/` で始まる場合だけに限定します。

会議内容・音声・カメラ・ページ本文を読み取る処理、データの保存、外部への送信はありません。`tabs` や `<all_urls>` などの追加権限も使いません。開発モードでは WXT の開発用通信が加わるため、配布には本番ビルドを使ってください。

## 参考資料

- [MDN: beforeunload](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event)
- [WXT: Content Scripts](https://wxt.dev/guide/essentials/content-scripts.html)
- [Chrome: Load an unpacked extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)
