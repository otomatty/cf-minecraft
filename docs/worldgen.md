# M2: オリジナルの地形生成の土台

地形生成は自作する。本家と同じ地形、ブロック一覧、乱数列の再現は目標にしない。
勾配ノイズ、オクターブ、密度関数などの一般的な技法を使い、パラメータ、分類、データは独自に設計する。
逆コンパイルしたコードやゲームのデータは使用しない。

`DebugHills` と `Flat` の出力は維持し、新規ワールドの既定は Terrain にする。`Terrain` (id 2) は独立した新しい地形生成で、バイオームはまだ接続しない。

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
`tools/determinism.mjs` はシナリオ・ノイズ・地形の3つを比較する。
稼働済みの開発環境がある場合の `--edge URL` でも、既存の debug scenario エンドポイントに含まれる
`noise` と `terrain` を比較するため、workerd も同じ検査に参加できる。

ベンチは初期化を除いた、5オクターブの2D 256点と、単一3Dノイズの16×384×16点の所要時間を表示する。
2D は時計の分解能のため1000チャンク分繰り返して1チャンクあたりを表示する。
値はマシンやビルド条件に依存し、合否の閾値にはしない。


## Terrain: 地形の形 (issue #19)

`crates/worldgen/src/terrain.rs` にパラメータを名前つき定数としてまとめた。
`TerrainGenerator::new(seed)` が用途別の fBm 順列表を準備する。
シードは `mix_stafford13(seed as u64 ^ 用途別の *_SALT)` から派生させる。
大陸・起伏・細部・3D密度は互いに異なる塩を使う。
`TerrainGenerator` を呼び出し側で保持すれば、チャンクごとの表の再構築を避けられる。
従来の `generate(Generator::Terrain, seed, cx, cz)` と `surface_y` も利用できるが、
この簡便な関数は呼び出すたびに表を作る。Server は Terrain の場合だけ準備済みの構造体を保持し、
チャンク生成で使い回す。出現地点は起動時に一度計算して保持する。
可変グローバル状態・スレッドローカル・HashMap は使用しない。

### 基準高度と密度

以下は全て自作の式とパラメータ。S(t) は t を [0,1] に clamp した後の `t*t*(3-2*t)`。
N は用途ごとに独立した正規化 fBm、座標の単位はブロック。

```text
c = 3 * N_continent(x/1100, z/1100)
l = S((c + 0.12) / 0.45)
r = S(3 * N_relief(x/470, z/470) + 0.35) * l
d = N_detail(x/95, z/95)
raw = 64 + 85*c + 110*r*r + 8*d
base = soft_height(raw)
strength = 2 + 36*r*r
density = base - y + strength * N_density(x/38, y/19, z/38)
```

| 定数 | 意味 |
| --- | --- |
| `CONTINENT_SCALE=1100`, `RELIEF_SCALE=470`, `DETAIL_SCALE=95` | 大陸、山地、細部の基本波長。数百〜数千ブロック単位で海・海岸・平地・丘・山を切り替える |
| `CONTINENT_GAIN=3`, `RELIEF_GAIN=3` | 正規化ノイズの値を地形分類に適した幅へ拡大 |
| `LAND_OFFSET=0.12`, `LAND_WIDTH=0.45` | 海から陸へ起伏を有効にする遷移範囲 |
| `RELIEF_OFFSET=0.35` | 平地と山地の比率を調整 |
| `BASE_CENTER=64`, `CONTINENT_HEIGHT=85` | 基準高度と大陸による海底・陸地の高度差 |
| `RELIEF_HEIGHT=110`, `DETAIL_HEIGHT=8` | 山の高度と細部の凹凸の強さ |
| `BASE_MIN=20`, `BASE_MAX=180` | 基準高度が漸近する下限と上限 |
| `BASE_LOW_KNEE=50`, `BASE_HIGH_KNEE=110` | 高度の圧縮を始める接続点 |
| `DENSITY_MIN=2`, `DENSITY_RELIEF=36` | 平地で弱く、山地で強い3Dの変形 |
| `DENSITY_XZ_SCALE=38`, `DENSITY_Y_SCALE=19` | 3D変形の水平・垂直の基本波長。山地では密度が上下に反転し、崖・張り出しができる |
| `CONTINENT_OCTAVES=3`, `LOCAL_OCTAVES=2` | 大陸と、それ以外のノイズのオクターブ数 |
| `FBM_LACUNARITY=2`, `FBM_PERSISTENCE=0.5` | fBm の周波数倍率と振幅倍率 |
| `CELL_XZ=4`, `CELL_Y=8`, `Y_POINTS=49` | 補間セルの幅・高さと、-64〜320 の垂直格子点数 |
| `SEA_LEVEL=56` | この地形独自の海面 (公開定数) |
| `BEACH_HEIGHT=2` | 浜の最高高度は海面+2。下層厚さはレシピの `depth` (上限8) |
| `SPAWN_RADIUS=512`, `SPAWN_STEP=16` | スポーン探索の最大範囲と間隔 |

密度はワールド座標に揃えた水平4×垂直8×奥行4の格子点だけで評価する。
地形本体は5×49×5点。斜面判定用の外周セルを含め7×49×7=2401点 (各点で2オクターブの3Dノイズ) を持ち、
x、z、y の順に三重線形補間する。2D の基準高度と強さは外周を含む水平格子点ごとに49回求める。
負座標にも Euclidean division を使い、隣のチャンクと同一の格子面を共有する。
密度>0を固体とする。密度の最大値は `180-y+38` 以下なので、y=218以上は空気。
山の上にはワールド上端319まで100ブロック以上の余裕がある。
海域では l が小さく強い3D変形が無効になるため、海底を高めに維持する。
格子点の下限評価から確実に固体となるセクションのみ石で一括充填し、レシピの実際の最大下層厚さ (現在3層) を残す。外周セルは斜面の高さ判定だけに使い、石の一括充填の下限評価には地形本体の5×5格子を使う。
演算は f64 の加減乗除・floor・比較・clamp に限り、libm や融合積和は使わない。

### 水・地表・スポーン

海面以下の非固体は、張り出しの下も含め WATER。MIN_Y=-64 は BEDROCK。
バイオームごとの地表レシピは下記「気候とバイオーム」を参照。
固体でない部分を地表材で埋めることはなく、レシピの深さより下は STONE。
洞窟、鉱石、木は追加していない。
`surface_y` は従来の密度から上から最初の固体の高さを返す。氷を除いた地形本体の高さであり、
寒い海では固体の氷が海底より上に存在するが、この API の値は変えない。

`spawn_point(gen, seed)` は足元の座標を返す。
Terrain では原点、次いで16ブロック刻みの正方形の外周を、半径512まで順に調べる
(各外周は z、x の昇順)。海面より高い最上部の固体の1ブロック上を選ぶため、
頭上2ブロックは必ず空気となる。見つからない場合は原点の地表と海面の高い方+1。
Flat と DebugHills は従来どおり原点の地表+1。Server は `worldgen::spawn_point` で起動時に
一度計算し、プレイヤーの x/z を列の中心 (+0.5) に置く。

### 検証・指紋・性能

Rust テストは生成の再現性・シード差、負座標を含む隣接チャンクの格子面の完全一致、
境界と内部の高度差の比較、全列の surface_y 一致、水・岩盤・地表材・セクションのカウンタ、
張り出しと石の天井、スポーンを確認する。
分布は seeds=0,2026,-71 について x/z=-2048..2048 を64ブロック刻みで調査し、
海の割合を15〜65%、y>140の山が存在すること、海底y>=1、最高高度y<=218を固定する。
修正後の計測値はそれぞれ海37.6%/31.0%/40.0%、高さ29〜162/27〜162/26〜157だった。

`terrain_fingerprint(seed)` は原点付近の cz、cx=-2..=2 の25チャンクと、
同じ5×5格子の座標を32倍した広域の24チャンク (重複する原点を除く) について、
y=-64..319、z、x の順でブロックID (u16 little-endian) を FNV-1a に投入する。
各チャンクのブロックIDより先に、z、x 順で256列の BiomeId (u16 LE) も投入する。
先に原点付近、次に広域の順で走査する。パレットの内部表現・ライティングは含めない。
原点付近の25チャンクだけでは今回の高度圧縮の変更を検出できなかったため、広域も追加した。
seed=2026 の native 固定値は
**`d3a977090d68e9eb`**。`native-server terrain [seed]` と WASM の
`server_terrain_fingerprint`、TypeScript の `terrainFingerprint` を用意した。
`pnpm check:determinism` で native と Node のシナリオ・ノイズ・地形の一致を確認した。
workerd の debug scenario も `terrain` を返すため、既存環境への `--edge URL` で同じ比較を行える。

```sh
cargo run --release -p worldgen --example terrain_bench
```

2026-11-16、native x86-64、この作業環境の release (opt-level=3, LTO) で、
seed=2026、cx/cz=-12..=12 の625チャンクを生成した。
TerrainGenerator の初期化を除き、生成とチャンク破棄を含む1チャンクごとの時間を測定する。
バイオーム追加前の Terrain は平均 **0.291 ms**、最大 **4.305 ms**、
比較用 DebugHills は平均 **0.118 ms**、最大 **0.372 ms**。
平均1.5 ms/チャンクの目標を満たした。値は実行環境・負荷に依存する。


### 山頂と海底の圧縮

硬い clamp は大きな領域を同じ高度に切りそろえるため、両側を次の有理式に置き換えた。
接続点の値と傾き (1) は中央の直線と連続する。加減乗除と比較だけを使う。

```text
raw < 50:  base = 20 + 30*30 / (50 - raw + 30)
raw > 110: base = 180 - 70*70 / (raw - 110 + 70)
otherwise: base = raw
```

seed=2026、x/z=-2048..2040 を8ブロック刻みで512×512点サンプルした10ブロック幅の分布:

| 高度帯 | 点数 |
| --- | ---: |
| 20〜29 | 4,100 |
| 30〜39 | 36,216 |
| 40〜49 | 25,104 |
| 50〜59 | 27,022 |
| 60〜69 | 28,170 |
| 70〜79 | 26,541 |
| 80〜89 | 23,577 |
| 90〜99 | 20,914 |
| 100〜109 | 17,609 |
| 110〜119 | 14,440 |
| 120〜129 | 11,996 |
| 130〜139 | 9,878 |
| 140〜149 | 10,695 |
| 150〜159 | 5,748 |
| 160〜169 | 134 |
| 170以上 | 0 |

最上位帯は1つ下の帯の2倍以下、170/180帯もその下の2倍以下、海底20帯も30帯の2倍以下をテストする。
上下の圧縮が一定値にならないことと接続点の傾きも確認する。
上記の性能測定は他のビルド・テストと同時実行したため、最大値にはスケジューリングの影響も含む。
平均は目標の1.5 ms/チャンク以下。`native-server bench [players] [view] [ticks] [hills|terrain|flat]`
でも Terrain を選べる。native bench と tick-probe の Terrain 計測は山より上の y=240 を飛行する。

### ジェネレーターの永続化と既存ワールド

| id | 名前 | 用途 |
| --- | --- | --- |
| 0 | Flat | クラシックフラット |
| 1 | DebugHills | 従来の仮の丘陵、決定論の台本、旧ワールド |
| 2 | Terrain | 新規ワールドの既定 |

未知の数値 id は Rust 側で従来どおり DebugHills に解決する。
ローカルでは `?gen=flat|hills|terrain` で新規ワールドの生成方式を選択する。
指定なし・不明な名前は Terrain。保存済みの seed と generator は URL より優先される。
OPFS の meta.json に数値の generator を起動前に保存する。既存 meta に generator がない場合は1を補う。
初期化の読み取り・判定・書き込みは、インポートと共通のワールド単位の Web Lock
(`mcworld-import-${world}`) の中で行う。ロック取得後に読み直し、既存値があればそれを返す。
初期化処理自体は書き込みキューに積まず、ロック内から既存のキュー経由で書き込む。
インポートは取得済みのロック内から直接書き込み、初期化を再入させない。
Web Locks がない環境ではタブ間の排他を保証できないため、OPFS を開かず保存なし
(`persistence: off`) で遊ぶ。初期化・インポートもロックなしでは実行しない。
このアプリに必須の WebGPU に対応するブラウザーには Web Locks もあるため、
排他を保証できない保存経路は設けない。初期化後の再読み取りは、ロック内での保存確認として行う。
新しい meta にはクライアントの選択値を保存する。`.mcworld` は引き続き版1のまま、meta.json の
追加フィールドとして generator を保持する。generator のない旧アーカイブは1として読み込み、
読み込み先に補完した meta を保存する。world-import の保存完了・移動の手順はそのまま使う。

DO では seed が既にあれば保存値を使い、generator だけなければ1を補って保存する。
seed がなければ新規ワールドとして2を保存する (古い generator だけが残っていても2を優先)。
seed と generator は同じ SQLite トランザクションで確定する。evict は両方を残して再起動する。
seed を削除するワールドリセット処理は現在ない。
F3 と debug stats は保存済みの実際のジェネレーター名を表示する。
ローカルは worker の ready、DO は接続時の worldInfo テキストフレームでホストから通知し、
ゲームのバイナリパケットや既存のシナリオ指紋は変更しない。

E2E は Terrain を既定のまま使い、出現地点の陸・頭上の空気、描画、移動、設置、保存・再読み込みを検査する。
地表と下層のブロック名を実際のレジストリから読み、設置先は地形の凹凸に依存しない出現地点の列の頭上に置く。
旧来の固定原点への依存を避け、tick-probe も出現地点の列にマーカーを置く。
今回の環境では E2E を実行せず、`node --check tools/e2e.mjs` と tick-probe の構文検査まで行った。
edge の型生成 (`cf workers types`) は環境のローカル待受け制限 (`listen EPERM 127.0.0.1`) により失敗し、
生成型がないため edge の tsc は完了できなかった。client の tsc は成功した。


## 気候とバイオーム (issue #19)

分類・名前・数値・地表・テクスチャは自作。他のゲームの一覧・配置表・データや逆コンパイルは使用しない。
要求に挙がった種類を全て区別するため、海3・浜2・陸6・山2の計13種類とした。
`data/registry/biomes.toml` が気候の範囲・地形の種類・地表レシピの定義元。
範囲は矩形の内外判定ではなく、**中点を気候の代表点**として使う。
同じ地形の種類の中で、温度と湿度の二乗距離の和が最小のものを選ぶ。同距離なら TOML の定義順。
従って範囲の間にも必ず1種類が決まり、範囲の重複も曖昧にならない。
ビルド時に全地形種の定義の存在、範囲の有限性・順序・0〜1、下層厚さ0〜8、
全ブロック名を検証し、不正な名前はビルドエラーにする。省略した `slope` は石。

### 気候

温度は2オクターブ・基本波長3000ブロック、湿度は3オクターブ・900ブロックの独立した2D fBm
(lacunarity=2, persistence=0.5)。温度帯の中を湿度が分ける構成。
別の2オクターブの47ブロック波長のノイズで、参照座標の x/z に最大18ブロックの揺らぎを加える。
z の揺らぎは (x+791,z-313) を参照して x と分離する。
気候を参照する座標だけを変え、高さ・密度には影響させない。
用途別の salt は温度 `a197854b32cd601e`、湿度 `732eb1904ac5d86f`、揺らぎ `c931467af2085bed`。

生の fBm を以下の区分線形写像で [0,1] に広げる。負側は正側と対称で `F(-v)=1-F(v)`。
温度は中央付近の傾きを従来の3.2から2に下げ、中間の温度帯を広く残す。
湿度は従来のほぼ一様な分布を維持する。

| 生の値 | 0 | 0.05 | 0.10 | 0.15 | 0.20 | 0.30 | 1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 湿度 | 0.50 | 0.66 | 0.80 | 0.90 | 0.96 | 0.995 | 1 |

温度の節点は `(0,0.5), (0.15,0.8), (0.30,0.96), (1,1)` とその負側の対称点。

3シードの広域49,152点の10区間ヒストグラムをテストする。湿度は各区間3,500〜6,500点、
温度は一様性を求めず全区間500〜11,000点に収まることを確認し、中間帯と両端の気候の存在を保証する。
温度のみ `max(surface_y-80,0)*0.002` を引き、[0,1] に clamp。山が少し寒くなる。

地形種は高さから決める。海底 <56 のうち高さ49以上かつ温度>=0.38を浅瀬、残りを海。
56〜58 は陸の浜、59〜121 は陸、122以上は山。寒い浅い海は海に残して凍結を岸まで連続させる。

| 名前 | 地形種 | 温度/湿度の代表点 | 地表 / 下層 | 水中の底 | 急斜面 | 凍結 |
| --- | --- | --- | --- | --- | --- | --- |
| `mild_meadow` | Land | 0.525 / 0.480 | grass_block / dirt | sand | stone | 無 |
| `dry_sands` | Land | 0.880 / 0.120 | sand / sandstone | sand | stone | 無 |
| `rain_grove` | Land | 0.620 / 0.850 | grass_block / dirt | sand | stone | 無 |
| `sun_steppe` | Land | 0.740 / 0.350 | coarse_dirt / dirt | sand | stone | 無 |
| `quiet_snow` | Land | 0.120 / 0.400 | snow_block / dirt | gravel | stone | 無 |
| `reed_mire` | Land | 0.280 / 0.900 | grass_block / dirt | sand | stone | 無 |
| `open_tide` | Sea | 0.650 / 0.500 | sand / sand | sand | stone | 無 |
| `silent_floe` | Sea | 0.120 / 0.500 | gravel / gravel | gravel | stone | 有 |
| `clear_shoal` | Shallows | 0.600 / 0.500 | sand / sand | sand | stone | 無 |
| `pale_strand` | Beach | 0.700 / 0.500 | sand / sand | sand | gravel | 無 |
| `shingle_edge` | Beach | 0.150 / 0.500 | gravel / gravel | gravel | gravel | 無 |
| `bare_ridge` | Mountain | 0.750 / 0.500 | stone / gravel | gravel | gravel | 無 |
| `white_crest` | Mountain | 0.150 / 0.500 | snow_block / stone | gravel | gravel | 無 |

### 地表と新ブロック

各列の最上部の固体1層を `surface`、下の `depth` 層を `subsurface` に置換する (現在は全て3層)。
海底は表層から下層まで `underwater` を使う。
陸では東西南北いずれかの列と高さが3以上違えば、表層と下層を `slope` にする。
その下は石。密度が負の空洞はこの処理で埋めない。
砂漠は砂+砂岩、雪原は雪+土、雪峰は雪+石。森と湿地は別バイオームだが今回は草+土。
寒い海は海面 y=56 の水1層を氷に置換する。雪は既存の地表固体を置換し、上に積まない。
斜面の隣接高さはチャンク外周も含め同じワールド座標で計算し、生成順序・チャンク境界に依存しない。

状態ID 40〜44に `snow_block` / `sandstone` / `gravel` / `ice` / `coarse_dirt` を末尾追加。
既存のID 0〜39とテクスチャレイヤー0〜17は維持した。新テクスチャは同じ16×16の手続き生成。
氷は半透明アルファ150〜173、solid、cull_same、opacity=1。既存の当たり判定・光・メッシュの経路を使う。
選択画面はレジストリから自動で追加される。バイオーム別の頂点カラーは今回変更しない。

### API・表示・検証

`TerrainGenerator::biome_at(x,z)` と `worldgen::biome_at(gen,seed,x,z)` は列の BiomeId を返す。
Flat/DebugHills は既存の `mild_meadow` (ID 0)。
Server が受理したプレイヤー位置からバイオーム名を求め、WASM の `server_client_biome` で UTF-8 を取得する。
ホストとのABIは追加exportを認識するため3から4へ更新。ゲームのバイナリパケットは変更しない。
ローカル worker と DO の両方が `ServerStats.biome` を送り、F3と `window.__mc.stats().server.biome` に表示する。
DO は毎20 tickにプレイヤー別の stats テキストフレームを送る。
E2E は stats に名前があることを待ち、足元のブロック名を取得するので雪・砂・礫のいずれでも同じ検査を行う。
この作業では E2E・dev サーバーは起動せず構文検査のみ。

Rust では気候101×101格子の全地形種被覆・同距離時の順序、同じシードの再現性、
3シード×512×512列 (32ブロック間隔、約16 km四方) の全バイオーム出現と陸の単独70%未満、
全バイオームの非急斜面の実チャンク地表、砂岩・雪・氷、負座標とチャンク境界、岩盤・水・下層を検証する。
変更前の `surface_y` を3シード×65×65点で採った指紋 `f3c5543374b0b4b8` も維持する。
ブロックの互換性テストは旧40状態のスナップショットをそのまま照合し、新5状態は別途検証する。

### 地図

```sh
node tools/terrain-map.mjs 2026 32 target/biomes-2026.ppm
# または
cargo run --release -p worldgen --example terrain_map -- 2026 32 target/biomes-2026.ppm
```

1024×512のバイナリPPM。左半分はバイオーム色に高さの陰影を加え、右半分は同じ範囲の高さ。
原点を中心に512×512点、指定ブロック間隔で描く。32なら約16 km四方で気候帯全体、
8なら約4 km四方で局所の境界を確認できる。凡例は標準エラーに出力する。

### 保存済みワールドへの注意

`Terrain` は M2 の間は変わり続ける。`Terrain` で作ったワールドは、保存済みの(編集した)チャンクと、
新しく作るチャンクの境目で、地形や地表が食い違うことがある。M2 が終わった時点で安定版として固定する。

### 今回の性能・実行結果

2026-11-16、この作業環境の native x86-64 release (opt-level=3, LTO)、seed=2026、
cx/cz=-12..=12の625チャンク、初期化を除く `terrain_bench` の結果:

| ジェネレーター | 平均 ms/チャンク | 最大 ms/チャンク |
| --- | ---: | ---: |
| Terrain (気候平滑化後) | 0.554 | 1.081 |
| DebugHills (比較用) | 0.127 | 0.278 |

平均1.5 ms以下の受け入れ条件を満たした。前回の0.494 msに対し今回0.554 ms (約12%増)。
測定値は負荷に依存する。
変更前の0.291 msから増えた主因は斜面用の外周密度サンプルと気候サンプル。

native / Node v22.23.4 (WASM) は台本 `88d6e0e1abd58ec4`、ノイズ `d5166400c68a1c45`、
バイオームID込みの地形 `d3a977090d68e9eb` が一致。
fmt / clippy / workspace test、WASMビルド後の host test、client tsc、E2Eと地図ツールの構文検査を実施。
edgeは `cf workers types` が `listen EPERM 127.0.0.1` で停止し、続く edge tsc は生成型不足で完了できなかった。


### 気候帯の平滑化レビュー

温度の基本波長を640から3000ブロック、オクターブを3から2にし、中央の写像の傾きを弱めた。
湿度は570から900ブロックにし、warp振幅は34から18に縮小した。
`sun_steppe` の旧代表点 (0.52,0.12) は寒く乾いた場所でも雪原と直接競合していたため、
暑い乾燥草地として (0.74,0.35) に移した。近さによる選択方式は維持し、中間に草原が入りやすくする。
高度による冷却・地形の高さ・地表レシピは維持する。数値はすべて自作。

隣接検査は seeds=2026,1,777、原点中心の256×256点、16ブロック間隔で東・南の組を一度ずつ数える。
山を除き、少なくとも一方が陸または浜の組を分母とする。海岸も含めて `silent_floe` との接触を検出する。
暑い側は `dry_sands` / `sun_steppe`、寒い側は `quiet_snow` / `silent_floe` として、
各シードで0.5%以下を要求する。

| seed | 暑い・寒い組 / 対象の隣接組 | 比率 |
| --- | ---: | ---: |
| 2026 | 11 / 72,511 | 0.0152% |
| 1 | 0 / 61,108 | 0% |
| 777 | 0 / 60,446 | 0% |

このほか約16 km四方で、標高80に揃えた環境温度の16ブロック間の変化を0.05未満に制限するテストを追加した。
標高130で温度が0.1低下することも確認する。


環境温度の最大16ブロック差は seed=2026で0.02293、1で0.02160、777で0.02204。
上記3シードの4 km / 16 kmの地図も書き出して確認した。山の雪峰は気候帯とは別に現れる。
平滑化後も全13バイオームが分布テストに現れ、陸の最大単独比率は約26.2%だった。
fmt / clippy / workspace test と WASMビルド後の host test は成功。
台本・ノイズは既定値を維持し、地形は `d3a977090d68e9eb` で native / Node が一致した。
`pnpm dev` と E2E は実行していない。
