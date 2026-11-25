# ブラウザごとの確認結果

| 確認項目 | Chrome | Firefox | Safari（macOS） | Safari（iOS） | Edge |
| --- | --- | --- | --- | --- | --- |
| 起動して地形が描画される（WebGPU） | E2E で検証済み | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） |
| `F8` のハッシュが基準値と一致 | E2E で検証済み（台本ハッシュ） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） |
| ポインターロック、移動、破壊、設置 | E2E で検証済み | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） |
| 再読込後に編集が残る（OPFS） | E2E で検証済み | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） |
| `/?server=ws` で Durable Object に接続できる | E2E で検証済み | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） | 未確認（実機での手作業が必要） |
| サーバーの WASM の決定論（台本・ノイズ・地形） | CI で毎回検証（Playwright の Chromium） | CI で毎回検証（Playwright） | CI で毎回検証（Playwright の WebKit、注） | CI で毎回検証（Playwright の WebKit、注） | 未実施（Chromium と同じ V8） |

Chrome の [E2E](../tools/e2e.mjs) は、`F8` と同じ台本処理を呼び出し、Node のハッシュと比較します。

注：CI は Ubuntu 上の Playwright 版 WebKit で実行します。Safari と同じ JavaScriptCore を使います。実機の Safari（macOS・iOS）は手作業での確認が必要です。

## 自動テストの実行

```sh
pnpm install
pnpm build:wasm
pnpm exec playwright install chromium firefox webkit
pnpm check:determinism:browsers
```

Linux でブラウザのシステム依存パッケージも入れる場合は、`pnpm exec playwright install --with-deps chromium firefox webkit` を使います。ブラウザを個別に指定する場合は、例えば `node tools/determinism.mjs --browsers firefox` を実行します。

決定論チェックはサーバーの WASM を空のページで実行し、台本・ノイズ・地形のフィンガープリントを Node と比較します。実機の Safari（macOS・iOS）、WebGPU の描画、入力、OPFS、Durable Object への接続はこのチェックの対象外です。
