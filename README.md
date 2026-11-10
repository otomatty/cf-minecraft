# maincraft

ブラウザで動くボクセルサンドボックスゲームです。Java版の仕様（バージョン26.3）を基準に、挙動と数値の再現を目指します。Cloudflare Workers と Durable Objects の上で動きます。

名称、テクスチャ、音、コードはすべてオリジナルです。既存ゲームのアセットや逆コンパイルしたコードは含みません。

現在は **M0（技術検証）** です。到達点と計測結果は [docs/m0-report.md](docs/m0-report.md) にあります。

## 構成

ゲームのロジックは I/O を持たない Rust のコアにあり、同じ WebAssembly を2つの場所で動かします。

- シングルプレイ: ブラウザの Web Worker（統合サーバー）。保存先は OPFS
- マルチプレイ: ワールドごとの Durable Object（専用サーバー）。保存先は SQLite

```
crates/
  jmath/          Java互換の乱数（JDKの実値で検証）
  world/          ブロック、パレット圧縮セクション、チャンク
  worldgen/       地形生成（M0はクラシックフラットと仮の丘陵）
  protocol/       パケット定義とコーデック
  sim/            サーバー本体。20TPSのtick、チャンク配信、保存要求
  mesher/         セクション → 頂点（面ごとのクアッド、AO）
  wasm-server/    サーバーのC ABI（ブラウザWorkerとDurable Objectで共用）
  wasm-client/    クライアント側ワールド、メッシュ、レイキャスト
  native-server/  ネイティブ版。決定論の基準値とベンチマーク
apps/web/
  src/client/     WebGPUレンダラー、入力、HUD、統合サーバーのWorker
  src/edge/       入口のWorkerと WorldDO
  src/shared/     両ホスト共通のWASMラッパーとtickペーサー
tools/            ビルド、決定論チェック、tick計測、E2E、JDKオラクル
docs/             M0レポート、ADR
```

## 必要なもの

- Rust（stable）と `wasm32-unknown-unknown` ターゲット: `rustup target add wasm32-unknown-unknown`
- Node.js 22.18 以降、pnpm 10
- WebGPU 対応ブラウザ

## 動かす

```sh
pnpm install
pnpm dev          # WASMをビルドして http://localhost:5173 で起動
```

| URL | 内容 |
|---|---|
| `/` | シングルプレイ（統合サーバー） |
| `/?server=ws&world=lobby` | Durable Object のワールド `lobby` に参加 |
| `/?autopilot=1` | 入力なしでカメラがスポーン上空を周回 |
| `/?view=10&seed=42` | 描画距離（2〜12）と新規ワールドのシード |

操作: `WASD` 移動（`W` 2回でダッシュ）、`Space`/`Shift` 上下、左クリック破壊、右クリック設置、中クリックでブロック選択、`1`〜`9`/ホイールで切替、`F8` 決定論チェック。

## テスト

```sh
pnpm test                 # Rust 29件 + ホスト側 7件
pnpm typecheck
pnpm dev                  # 以下は開発サーバーを起動した状態で実行
node tools/determinism.mjs --edge http://localhost:5173
node tools/tick-probe.mjs --players 8 --seconds 60 --view 8
node tools/e2e.mjs        # ディスプレイのない環境では xvfb-run -a を前に付ける
```

JDK の乱数実値を取り直す場合は `tools/oracle/JdkVectors.java` の先頭コメントの手順を使います。

## デプロイ

```sh
cf auth login
pnpm deploy
node tools/tick-probe.mjs --edge https://<デプロイ先> --players 8 --seconds 60
```

**公開前の注意:** M0 には認証がありません。URLを知っていれば誰でも任意の名前でワールドを作成でき、Durable Object の稼働時間とストレージが課金対象になります。認証は M4 で入れる予定なので、それまでは URL を共有しないか、Cloudflare Access などで保護してください。

## 設計上のルール

- コアはソケット、時計、ファイル、スレッドに触れません。ホストがパケットを渡し、`tick()` を呼び、出力を取り出します。
- コア内では `HashMap` と `f64::sin` などの libm 関数を使いません。前者は反復順が、後者はホストごとの実装が異なり、決定論が壊れます。
- 保存データと受信データは信用せず、読み込み時にすべて検証します。
