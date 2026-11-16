# M2: オリジナルの地形生成の土台

地形生成は自作する。本家と同じ地形、ブロック一覧、乱数列の再現は目標にしない。
勾配ノイズ、オクターブ、密度関数などの一般的な技法を使い、パラメータ、分類、データは独自に設計する。
逆コンパイルしたコードやゲームのデータは使用しない。

この段階では `DebugHills` と `Flat` を変更しない。バイオームとノイズはまだ地形生成に接続しない。

## レジストリ

`data/registry/blocks.toml` と `biomes.toml` が入力。
`crates/world/build.rs` が `serde` (derive) と `toml` 0.8 で読み込み、検証して
`OUT_DIR` に Rust の静的な表を生成する。入力の変更は `cargo:rerun-if-changed` で検出する。
生成物はコミットしない。依存は build-dependencies だけで、`world` の実行時依存は増えない。

### ブロックの追加

`blocks.toml` の末尾に `[[blocks]]` を追加する。例えば現在の40状態の後なら次の4行で追加できる。

```toml
[[blocks]]
name = "clay_tile"
id = 40
texture = "stone"
```

これで `CLAY_TILE`、状態 ID、`COUNT`、ブロック一覧、文字列への変換と解析が生成される。
新しいテクスチャ名を使う場合は、ファイル先頭の `textures` 配列の末尾にその名前を追加し、
`texture = "clay_tile"` のように参照する。配列順が atlas の層番号になるため、既存の宣言順は変えない。
テクスチャ名はクライアントにも渡る。絵柄が未実装の名前には既存の紫黒チェックが表示される。
独自の絵柄が必要なら、既存の `apps/web/src/client/textures.ts` に描画処理を追加する。

`name` は小文字の snake_case で、大文字にした名前が公開 Rust 定数になる。
`id` はブロックの最初の状態 ID。前のブロックの直後に連続させ、既存 ID を動かさない。
衝突・欠番はビルドエラーになり、既存 ID・atlas 順の変更は互換性テストでも検出する。
`legacy_count` は従来形式の14状態の境界であり、追加時にも変更しない。

### 面と tint の省略形

`texture` は6面共通のテクスチャ。`top`、`bottom`、`side` (水平4面)、
`north`、`south`、`west`、`east` で必要な面だけ上書きできる。
優先順位は個別の面、`side`、`texture` の順。上下には `side` を適用しない。
`top` / `bottom` は `up` / `down` とも書ける。
すべての面にテクスチャが解決できなければビルドエラーになる。

```toml
[[blocks]]
name = "grass_block"
id = 2
top = "grass_block_top"
bottom = "dirt"
side = "grass_block_side"
tint = ["top"]
```

`tint` は省略すると全6面 false。`tint = true` で全面、`tint = ["top", "north"]` のように
面名の配列で指定した面だけを着色できる。`side` は水平4面、`up` / `down` も使用可能。
草・葉・水の既存の着色方法は維持する。

### モデル、描画、光の既定値

`model` は省略時 `cube`。ほかに `bottom_slab`、`top_slab`、`cross`、`stairs`、`fence` がある。
`layer` は省略時 `opaque`。ほかに `cutout`、`translucent` がある。
花などの `cross` を cutout 描画する場合は `layer = "cutout"` を明示する。
箱の座標、草花の箱、階段の角とフェンス接続の計算は Rust に残す。

| フィールド | 省略時の値 |
| --- | --- |
| `occludes` | モデルが `cube` かつレイヤーが `opaque` の場合だけ true |
| `solid` | `cross` の場合だけ false、それ以外は true |
| `cull_same` | モデルが `cube` かつレイヤーが `translucent` の場合だけ true |
| `opacity` | 解決済みの `occludes` が true なら15、それ以外は0 |
| `emission` | 0 |

`occludes` は遮蔽、`solid` は衝突、`cull_same` は同一状態との内部面の除去を表す。
光の減衰 `opacity` と発光 `emission` は0〜15。
各値を明示すれば既定値を上書きできる。例えば空気は `occludes = false`、`solid = false`、
ガラスは `layer = "cutout"`、`cull_same = true`、水は `layer = "translucent"`、
`solid = false`、`opacity = 1` とする。

### 複数状態

`states` は省略すると性質なしの1状態。複数状態なら配列順に `id + index` を割り当てる。
各項目の `properties` は順序付きの `[キー, 値]` の配列。
`model`、`occludes`、`opacity` を状態単位で上書きできる。
明示値の優先順位は状態側、ブロック側、既定値の順。
既定値は各状態の最終的なモデルとレイヤーから計算する。
そのためハーフブロックは次のようにモデルと性質だけ指定すればよい。

```toml
[[blocks]]
name = "oak_slab"
id = 14
texture = "oak_planks"
states = [
  { properties = [["type", "bottom"]], model = "bottom_slab" },
  { properties = [["type", "top"]], model = "top_slab" },
  { properties = [["type", "double"]], model = "cube" },
]
```

文字列表現は `oak_slab[type=bottom]` の形式。キーの順序もデータどおりになる。
階段モデルは `facing` が north/south/west/east、各方向の `half` が bottom/top の順で8状態を持つ。
隣接形状の計算がこの順序を使うため、ビルド時にも検証する。

重複した名前・テクスチャ・状態・性質のキー、未知のモデル・レイヤー・テクスチャ・tint の面名、
範囲外の光の値、不明なフィールド、TOML 構文エラーもビルド時に拒否する。
既存の40状態は移行前に採取した `crates/world/tests/registry-v1.txt` と比較する。
新ブロックを追加する段階では、新しい期待値を別途追加し、既存状態の互換性を維持する。

### バイオーム

`biomes.toml` に `[[biomes]]` を追加する。出力は `world::biomes::BIOMES`。

```toml
[[biomes]]
name = "mild_meadow"
surface = "grass_block"
subsurface = "dirt"
grass_color = [113, 169, 82]
leaves_color = [85, 145, 76]
temperature = [0.25, 0.8]
humidity = [0.3, 0.85]
```

地表 `surface` とその下 `subsurface` のブロック名は先頭状態に解決する。
草・葉の色は RGB、温度・湿度は0〜1の目安の範囲。
名前の重複、不明なブロック、逆転した範囲や範囲外の値を拒否する。
`mild_meadow` と `dry_sands` の値は自作の初期値。現時点では生成や着色に使用しない。

## ノイズ

`noise::GradientNoise::new(seed)` は `jmath::Xoroshiro128PlusPlus::from_seed` を使い、
0〜255 の表を Fisher–Yates でシャッフルする。交換先は64ビット乱数の棄却法で一様に選ぶ。
座標を floor で格子点と相対位置に分け、軸ごとに256で折り返す。
ハッシュは `p[(p[(p[x] + y) mod 256] + z) mod 256]`。2D は z=0 とする。
軸方向の周期は256格子。

2D の勾配は `(±1, 0)`、`(0, ±1)` と `(±0.5, ±0.5)` の8方向。
3D はゼロ成分を1つ持つ `(±0.5, ±0.5, 0)` の成分の並べ替えによる12方向。
表から勾配を選び、各角からの相対位置との内積を計算する。
補間係数は `fade(t) = t³(t(6t - 15) + 10)`、補間は `lerp(t,a,b) = a + t(b-a)`。
x、y、z の順に補間する。端点で1階・2階の微分がゼロになり、格子境界で滑らかにつながる。
勾配の L1 長を1に抑え、値は [-1, 1] 内。格子点ではゼロになる。

`noise::Fbm::new(seed, octaves, lacunarity, persistence)` は各オクターブに独立した順列と
各軸の非整数オフセットを持つ。`Xoroshiro128PlusPlus::from_seed(seed)` から、各オクターブについて
`next_long()` を1回取り `GradientNoise` の派生シードにし、続く3回を x/y/z のオフセットに使う。
オクターブ数を増やしても既存のオクターブのシードとオフセットは変わらない。
各オフセットは乱数を `u64` とした `r` から
`4096 + (r & 65535) + 1/8 + ((r >> 16) & 65535)/131072` で作る。
整数部分は格子周期の16倍以上、端数は [1/8, 5/8) の正確な二進分数となる。
評価座標は `座標 × 周波数 + オフセット` の順で計算する。
別の順列でオクターブ間の模様を分離し、非整数のずらしで原点や整数座標が全オクターブの
格子点に揃ってゼロになる問題を防ぐ。1オクターブの fBm も、ずらしていない `GradientNoise` とは異なる。
周波数と振幅は1から始め、各オクターブでそれぞれ lacunarity と persistence を掛ける。
結果は振幅の合計で割って正規化する。オクターブ数は1〜32、周波数倍率は有限かつ1以上、振幅倍率は0〜1。
基本周波数は呼び出し側で座標に掛ける。全オクターブで周波数とオフセットを適用した後の座標が有限で、絶対値が 2^52 未満になる入力を使う。
大きすぎる座標では浮動小数点の精度により格子内の位置を失う。

浮動小数点の演算は f64 の加減乗除と floor のみ。三角関数、sqrt、powf、融合積和は使わない。
式の評価順を保ち、native と WASM の双方で同じ丸め結果を得る。
固定シード・座標の `to_bits`、範囲、格子点、連続性、シードによる変化をテストする。
fBm では lacunarity=2 の原点・正負の整数座標で値がゼロに固定されないこと、
各オクターブを同じ周波数で評価しても値が異なることを検証する。
`GradientNoise` 単体のビット固定値は維持する。

## 決定論と測定

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm build:wasm
pnpm test:host
pnpm --filter web exec cf workers types
pnpm --filter web exec tsc -p tsconfig.client.json
pnpm --filter web exec tsc -p tsconfig.edge.json
cargo build --release -p native-server
pnpm check:determinism
cargo run --release -p noise --example bench
```

既存の台本の既定値 (seed=2026、600 ticks) は `88d6e0e1abd58ec4` のまま。
ノイズの `fingerprint(seed)` は別の FNV-1a 値で、既定シードでは `d5166400c68a1c45`。
2つのシード、正負と格子境界をまたぐ座標、2D/3D と fBm の f64 ビット列を little-endian で取り込む。
`native-server noise [seed]` と WASM の `server_noise_fingerprint` が同じプローブを使う。
`tools/determinism.mjs` はシナリオとノイズの両方を比較する。
稼働済みの開発環境がある場合の `--edge URL` でも、既存の debug scenario エンドポイントに含まれる
`noise` を比較するため、workerd も同じ検査に参加できる。

ベンチは初期化を除いた、5オクターブの2D 256点と、単一3Dノイズの16×384×16点の所要時間を表示する。
2D は時計の分解能のため1000チャンク分繰り返して1チャンクあたりを表示する。
値はマシンやビルド条件に依存し、合否の閾値にはしない。
