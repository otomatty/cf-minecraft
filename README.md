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
| `/account.html` | Google ログイン、ワールド作成、メンバーの招待 |
| `/?server=ws&world=lobby` | Durable Object のワールド `lobby` に参加 |
| `/?autopilot=1` | 入力なしでカメラがスポーン上空を周回 |
| `/?view=10&seed=42` | 描画距離（2〜12）と新規ワールドのシード |

操作: `WASD` 移動、`R` または前進キー（既定 `W`）2回でダッシュ、`Space`/左 `Shift` 上下、`F` で全画面切替（Keyboard Lock 成功時の既定ダッシュは左 `Ctrl`）、左クリック破壊（長押しで250 msごと）、右クリック設置（長押しで200 msごと）、中クリックでブロック選択、`1`〜`9`/ホイールで切替、`F8` 決定論チェック、`Esc` 一時停止。一時停止中の「設定」で移動・ダッシュ・全画面のキー、マウス感度（0〜200%、既定100%）、縦の視野角（30〜110°、既定70°）を変更でき、設定はブラウザに保存されます。シングルプレイでは同じ設定パネルからワールドを `.mcworld` ファイルに書き出し、新しい名前で読み込めます。Ctrl をダッシュに指定しても Keyboard Lock が使えない間は `R` に切り替わります。

マルチプレイは切断されても自動で再接続します。別の場所で同じアカウントが接続した場合や、ワールドへの参加が取り消された場合は再接続しません。

## テスト

```sh
pnpm test                 # Rust 40件 + ホスト側 94件（10ファイル）
pnpm typecheck
pnpm dev                  # 以下は開発サーバーを起動した状態で実行
node tools/determinism.mjs --edge http://localhost:5173
node tools/tick-probe.mjs --players 8 --seconds 60 --view 8
node tools/e2e.mjs        # ディスプレイのない環境では xvfb-run -a を前に付ける
```

プルリクエストと `main` へのプッシュで、GitHub Actions（`.github/workflows/ci.yml`）がフォーマットと clippy、Rust のテスト、WASM のビルド、型チェック、ホスト側テスト、ネイティブ・Node・Durable Object の決定論チェック、本番ビルドと公開前の確認（`cf deploy --dry-run`）、ブラウザの E2E を実行します。

手元で同じ lint を走らせるには:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

JDK の乱数実値を取り直す場合は `tools/oracle/JdkVectors.java` の先頭コメントの手順を使います。

## デプロイ

最初に D1 データベースを作り、表示された ID にマイグレーションを適用します。コマンドはリポジトリのルートで実行します。

```sh
cf auth login
cf d1 create maincraft
cf d1 migrations apply <ID> --dir apps/web/migrations
```

Google Cloud で OAuth クライアント（ウェブアプリケーション）を作ります。承認済みリダイレクト URI に `https://<デプロイ先>/api/auth/callback/google` を登録します。

Cloudflare ダッシュボードで Turnstile のウィジェットを作ります。ホスト名にデプロイ先を登録します。

次の値を Worker の secret に登録します。値はリポジトリに入れません。

| secret | 意味 |
|---|---|
| `BETTER_AUTH_SECRET` | セッション認証の秘密鍵。`openssl rand -base64 32` で生成します |
| `GOOGLE_CLIENT_ID` | Google OAuth のクライアント ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth のクライアントシークレット |
| `TURNSTILE_SITE_KEY` | Turnstile のサイトキー。アカウント画面にも渡します |
| `TURNSTILE_SECRET_KEY` | Turnstile のサーバー検証用キー |
| `WORLD_CREATORS` | ワールドを作れるメールアドレス。カンマ区切りで、大小文字と前後の空白は無視します |
| `ACCESS_TOKEN` | tick-probe 用の運用者トークン。`openssl rand -base64 32` で別の値を生成します |

```sh
cf workers secrets update BETTER_AUTH_SECRET --worker maincraft --type secret_text --text '<生成した値>'
cf workers secrets update GOOGLE_CLIENT_ID --worker maincraft --type secret_text --text '<クライアント ID>'
cf workers secrets update GOOGLE_CLIENT_SECRET --worker maincraft --type secret_text --text '<クライアントシークレット>'
cf workers secrets update TURNSTILE_SITE_KEY --worker maincraft --type secret_text --text '<サイトキー>'
cf workers secrets update TURNSTILE_SECRET_KEY --worker maincraft --type secret_text --text '<検証用キー>'
cf workers secrets update WORLD_CREATORS --worker maincraft --type secret_text --text 'owner@example.com'
cf workers secrets update ACCESS_TOKEN --worker maincraft --type secret_text --text '<運用者トークン>'
pnpm run deploy
MC_ACCESS_TOKEN='<運用者トークン>' node tools/tick-probe.mjs --edge https://<デプロイ先> --players 8 --seconds 60
```

認証に必要な5つの secret が足りないと、認証が要るルートは 503 で閉じます。`WORLD_CREATORS` が空なら誰も作成できません。`ACCESS_TOKEN` が空なら運用者トークンは無効です。運用者トークンは `Authorization: Bearer <値>` だけで有効です。任意のワールドへの接続と metrics の取得に使えます。間違ったトークンにはレート制限がかかります。

`/account.html` で Google にログインします。`WORLD_CREATORS` に登録した人は、認証ウィジェットを通してワールドを作れます（1人5個まで）。operator は各ワールドの「メンバー」欄からメールアドレスと役割を指定して招待できます。まだログインしたことがない人も招待できます。メンバーは1ワールド64人までです。オーナーは削除・降格できません。メンバーを削除すると、接続中でも切断されます。502 が出たときは、もう一度削除してください。参加する人は、招待されたメールアドレスの Google アカウントでログインし、一覧のワールド名を開きます。

ローカルの `pnpm dev` は今までどおり認証なしで動きます。`pnpm deploy` は pnpm 本体のコマンドなので、デプロイは `pnpm run deploy` です。手元から公開するときも、先にマイグレーションを適用してください。

### 自動公開

公開は、CI（`.github/workflows/ci.yml`）とは別のワークフロー（`.github/workflows/deploy.yml`）が行います。CI は変更を検査するだけで、本番には触れません。

`main` へのプッシュで CI がすべて通ると、`deploy.yml` が起動し、CI が作ったビルド出力をそのまま Cloudflare に公開します。公開の前に作り直しません。D1 のマイグレーションを先に適用してから Worker を公開します。追加のみのスキーマなので、古い Worker が動いている間も安全です。自動で公開するのは、そのときの `main` の先頭のコミットのビルドです。先頭のコミットの CI がまだ通っていなければ、何も公開しません。その CI が通ったときに、あらためて起動します。プルリクエストでは、CI が `cf deploy --dry-run` で確認するところまでです。

自動公開は、次の設定が済むまで動きません。

1. Cloudflare で API トークンを作ります。権限は Worker の公開と D1 の編集に必要なものにし、対象のアカウントを1つに絞ります（[作り方](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)）。
2. GitHub の Settings → Environments で `production` を作り、その secret に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を置きます。公開できるブランチは `main` だけにします。値はリポジトリにも issue にも書きません。
3. 上の手順で D1 と OAuth、Turnstile を用意し、Worker の secret を登録しておきます。
4. Settings → Secrets and variables → Actions → Variables で、`D1_DATABASE_ID` に D1 の ID を設定し、`DEPLOY_ENABLED` を `true` にします。

自動公開を止めるときは、`DEPLOY_ENABLED` を消すか `true` 以外にします。

### 手動での公開と出し直し

Actions の「Deploy」から「Run workflow」を選び、`run_id` に公開したい CI の実行の番号（その実行の URL の末尾の数字）を入れます。`main` へのプッシュで成功した CI の実行だけを受け付けます。前の版に戻すときも、この方法で前の実行を指定します。ビルド出力は30日間残ります。

認証導入前の版に戻すときはマイグレーションを飛ばし、既存のスキーマは消しません。

認証導入前の版は Google ログインとワールドの招待を確かめません。共有の `ACCESS_TOKEN` だけで入場を判定します。その値を知っている人は、招待されていないワールドにも入れます。戻す前に `ACCESS_TOKEN` を誰に渡すかを決めてください。

- `dry_run` にチェックを入れると、ビルド出力を取り出して `cf deploy --dry-run` で確認するだけで、公開もマイグレーションの適用もしません。設定の確認に使えます。
- 手動での公開は、`DEPLOY_ENABLED` に関係なく動きます。
- 前の版に戻すときは、先に `DEPLOY_ENABLED` を止めてください。有効なままだと、次に `main` の CI が通ったときに、最新のコミットで上書きされます。

手元からの公開（`pnpm run deploy`）も、これまでどおり使えます。

## 設計上のルール

- コアはソケット、時計、ファイル、スレッドに触れません。ホストがパケットを渡し、`tick()` を呼び、出力を取り出します。
- コア内では `HashMap` と `f64::sin` などの libm 関数を使いません。前者は反復順が、後者はホストごとの実装が異なり、決定論が壊れます。
- 保存データと受信データは信用せず、読み込み時にすべて検証します。
