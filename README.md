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

- Rust は rustup で入れます。版、rustfmt、clippy、`wasm32-unknown-unknown` ターゲットは `rust-toolchain.toml` に書いてあり、このリポジトリで最初に `cargo` を実行したときに rustup が入れます（先に入れておくなら `rustup toolchain install`）。
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

プルリクエストと `main` へのプッシュで、GitHub Actions（`.github/workflows/ci.yml`）がフォーマットと clippy、Rust のテスト、WASM のビルド、型チェック、ホスト側テスト、ネイティブ・Node・Durable Object の決定論チェック、本番ビルドを実行します。ブラウザの E2E も走りますが、tick レートの検査が不安定なので、落ちても全体は失敗にしません。

手元で同じ lint を走らせるには:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

JDK の乱数実値を取り直す場合は `tools/oracle/JdkVectors.java` の先頭コメントの手順を使います。

## デプロイ

```sh
cf auth login
openssl rand -base64 32
cf workers secrets update ACCESS_TOKEN --worker maincraft --type secret_text --text '<上で出した値>'
pnpm run deploy
MC_ACCESS_TOKEN=<同じ値> node tools/tick-probe.mjs --edge https://<デプロイ先> --players 8 --seconds 60
```

本番は `ACCESS_TOKEN` が一致しないとワールドを作れません。試行回数の制限はないので、上の `openssl rand -base64 32` の長さを使ってください。短い値は当たることがあります。値はリポジトリに入れません。ローカルの `pnpm dev` はトークン不要です。`pnpm deploy` は pnpm 本体のコマンドなので、デプロイは `pnpm run deploy` です。

## 設計上のルール

- コアはソケット、時計、ファイル、スレッドに触れません。ホストがパケットを渡し、`tick()` を呼び、出力を取り出します。
- コア内では `HashMap` と `f64::sin` などの libm 関数を使いません。前者は反復順が、後者はホストごとの実装が異なり、決定論が壊れます。
- 保存データと受信データは信用せず、読み込み時にすべて検証します。
