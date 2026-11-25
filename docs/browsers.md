# ブラウザごとの確認結果

| 確認項目 | Chrome | Firefox | Safari（macOS） | Safari（iOS） | Edge |
| --- | --- | --- | --- | --- | --- |
| 起動して地形が描画される（WebGPU） | E2E で検証済み | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） |
| `F8` のハッシュが基準値と一致 | E2E で検証済み（台本ハッシュ） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） |
| ポインターロック、移動、破壊、設置 | E2E で検証済み | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） |
| 再読込後に編集が残る（OPFS） | E2E で検証済み | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） |
| `/play.html?server=ws&world=…` で Durable Object に接続できる | E2E で検証済み | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） |
| サーバーの WASM の決定論（台本・ノイズ・地形） | CI で毎回検証（Playwright の Chromium） | CI で毎回検証（Playwright） | CI で毎回検証（Playwright の WebKit、注） | CI で毎回検証（Playwright の WebKit、注） | 未実施（Chromium と同じ V8） |

Chrome の [E2E](../tools/e2e.mjs) は、`F8` と同じ台本処理を呼び出し、Node のハッシュと比較します。

`/?server=ws` から `/play.html?server=ws` への転送は単体テストで確認しています（E2E はゲームページを直接開きます）。[title.test.ts](../apps/web/src/client/title.test.ts)

注：CI は Ubuntu 上の Playwright 版 WebKit で実行します。Safari と同じ JavaScriptCore を使います。実機の Safari（macOS・iOS）は手作業での確認が必要です。

2026-11-25 の初回 CI（Ubuntu 24.04、Playwright 1.63.0）では、シード 2026・600 tick の台本 `7c46257055d8c652`、ノイズ `d5166400c68a1c45`、地形 `7ec6cedb74055722` が、Node v22.23.5、Chromium 153.0.8010.12（V8）、Firefox 155.0（SpiderMonkey）、WebKit 26.6（JavaScriptCore）の 4 ホストで一致しました。ここに記載した値は初回実行時のもので、コアの変更に伴って変わります。現在の値は `pnpm check:determinism:browsers` で確認できます。

## 自動テストの実行

```sh
pnpm install
pnpm build:wasm
pnpm exec playwright install chromium firefox webkit
pnpm check:determinism:browsers
```

Linux でブラウザのシステム依存パッケージも入れる場合は、`pnpm exec playwright install --with-deps chromium firefox webkit` を使います。ブラウザを個別に指定する場合は、例えば `node tools/determinism.mjs --browsers firefox` を実行します。

決定論チェックはサーバーの WASM を空のページで実行し、台本・ノイズ・地形のフィンガープリントを Node と比較します。実機の Safari（macOS・iOS）、WebGPU の描画、入力、OPFS、Durable Object への接続はこのチェックの対象外です。
