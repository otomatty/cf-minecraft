# アイテム、インベントリ、ゲームモード

`data/registry/items.toml` はこのプロジェクト独自のアイテム定義。`world/build.rs` が読み、`world::items` の表を生成する。ID は保存用の安定した `u16` で、1 から割り当て、既存 ID を変更しない。0 は空の枠を表す。ブロックの状態 ID とは別の名前空間。

`oak_leaves` アイテム（ID 12）は `placed_oak_leaves`（状態 ID 51）を置く。どちらの葉も中クリックで同じアイテムを選べる。サバイバルで設置した葉を掘ると葉アイテムを 1 個落とし、地形の葉ではリンゴの抽選がある。[葉の消滅とドロップ](random-ticks.md#葉)

各エントリーは `name`（snake_case）、`id`、`max_stack`（省略時64、1〜64）、任意の `block`、`texture`、`tool = { kind, tier }` を持つ。`block` と `texture` の両方が無い定義はビルドエラー。道具は `max_stack = 1` が必須。重複した名前・ID、ID 0、不明なブロック、不正なスタック上限はビルドエラー。水源のブロックアイテムはクリエイティブ用で、流れる水には対応するアイテムがない。ブロック以外のアイテムも `block` の省略で表現できる。

`items::ITEMS` / `COUNT`、`info(id)`、`by_name(name)`、`for_block(state)` を公開する。置く状態はそのブロックの最初の状態。スラブや階段などのどの状態も同じアイテムに戻る。

## インベントリ

プレイヤーごとに36枠。0〜8がホットバー、9〜35が所持品。選択枠は0〜8。各枠は空、または `{ item: u16, count: u8 }` で、数は1〜そのアイテムの `max_stack`。

`add(item, count)` は同じアイテムの既存スタックを小さい枠番号順に埋め、その後で空き枠を0〜35の順に埋める。戻り値は余り。選択枠から1個取り出す操作と、検証付きの枠設定を持つ。不明なアイテムを追加した場合は全数を余りとして返す。

現行のプレイヤーデータはバージョン4で、所持品・一時枠・体力の状態を書き出す。以下は旧バージョン2の配置。結果枠は毎回計算するため保存しない。現行形式は [health.md](health.md#プレイヤーのデータ) を参照。

| 順序 | 内容 |
| --- | --- |
| 1 | バージョン u8（2） |
| 2 | 選択枠 u8（0〜8） |
| 3 | 所持品36枠 |
| 4 | クラフト4枠（左上から行順） |
| 5 | カーソル1枠 |

各枠は `[item u16 BE, count u8]`、空は `[0, 0, 0]`。バージョン2は計125バイト。旧バージョン1（110バイト、選択枠と所持品36枠のみ）も読み込み、一時枠を空にする。どちらも未知のID、数や選択枠の範囲外、短いデータ、余分なバイト、未知の版はエラー。`connect_at` のホスト提供バイト列が不正ならモードに応じた初期インベントリへ戻す。

接続時は復元したクラフト枠とカーソルを所持品へ戻し、入りきらない分をプレイヤー位置に落とす。閉じた画面から再開し、保存時に満杯でも物の個数を保つ。返却順や初速・拾得待ちは [crafting.md](crafting.md#閉じる切断保存) を参照。

## ゲームモードと編集

`Server::set_game_mode` で接続前にワールドのモードを設定する。既定は `Creative`。

- Creative: 初期ホットバーは stone、dirt、oak_planks、oak_slab、oak_log、glass、oak_leaves、water、lamp_block を各1個。既存と同じ有効な状態を置け、数は減らない。ブロック選択と中クリックはサーバーへ枠設定を送る。
- Survival: 初期インベントリは空。置く状態のアイテムと選択枠のアイテムが一致し、置き換える先が 空気・水（水源と流れる水）・短い草、または置く状態と同じブロック名の場合のみ配置できる。同じブロック名なら状態の変更（下半分のスラブから両方のスラブなど）を許す。変更に成功すると1個消費する。破壊は道具に対応した時間制採掘を使い、段階条件を満たす場合に対応アイテムをドロップする。硬さ、受付・中断条件、クライアントの動きは [mining.md](mining.md) を参照。近づくとインベントリに入る。入りきらない分は地面に残る。両モードで選択枠から Q（キー設定で変更可能）で捨てられる。移動、待ち時間、拾得範囲、寿命、プロトコルの数値は [entities.md](entities.md) を参照。

両モードで従来の距離、チャンク送信済み、状態、植物の支持面などの判定を維持する。拒否された編集は送信者へ実際のブロックを訂正送信する。

サバイバルではブロック選択画面を開けず、中クリックは対応アイテムがあるホットバー枠の選択のみ。空・非ブロックアイテムからの配置、壊せないブロックの採掘は送信しない。採掘ではクライアント予測でブロックを消さず、サーバーの更新を待つ。配置の向きなどは既存の `placementState` を使う。ホットバーの表示・数はサーバーが送る内容を使い、localStorage の旧ホットバー設定は使用しない。F3表示にモードを含める。

## プロトコルとABI

所持品導入時のプロトコルは4。既存のパケット番号は変更しない。Welcome末尾に `game_mode u8`（0=Creative、1=Survival）を追加する。

| 方向 | 番号 | 内容 |
| --- | --- | --- |
| C2S | 0x04 | SelectSlot: slot u8 |
| C2S | 0x05 | CreativeSetSlot: slot u8, item u16 BE, count u8。item 0 は空 |
| S2C | 0x06 | Inventory: selected u8, 枠数 u8（必ず36）、36個の item u16 BE / count u8。空は0 / 0 |

InventoryはWelcome直後、および選択枠を含む変更があったtickに1回送る。同一tickの複数操作は集約する。CreativeSetSlotの権限・内容が不正なら拒否数を増やし、正しいInventoryを再送する。SelectSlotの範囲外も拒否する。受信デコード時に選択枠、枠数、ID、個数、末尾バイトを検証する。

サーバーABIは6。モード設定、接続時の任意インベントリ、`inventory_data` をWASMとTypeScriptへ公開する。クライアントWASMはモード、選択枠、全36枠、アイテム表を公開し、新しい操作をエンコードする。クライアントABIには既存のバージョン番号がない。

決定性ハッシュにはモードと全接続クライアントのID・インベントリをID順に含める。前のインベントリPRでCreativeのseed=2026 / 600 ticksのシナリオのハッシュが `88d6e0e1abd58ec4` から `39573e99c270f551` に変わった。理由はWelcomeへの `game_mode` の追加、Inventoryパケットの送信、状態ハッシュへのゲームモードとインベントリの追加。地形 `6aa960f51ded69b6` とノイズ `d5166400c68a1c45` のフィンガープリントは変わらない。

## ホストの保存

シングルプレイは `meta.json` の `gameMode`（`creative` / `survival`）を保存する。項目がない旧ワールドはcreative、不正な値はメタデータ検証エラー。URLの `mode=survival` は新規作成時だけ適用する。プレイヤーのデータはOPFSの `player.dat` に自動保存・明示保存で書き、起動時に復元する。アーカイブでは `player.dat` は任意のファイルとして入出力する。中身の意味はRustコアが検証する。

マルチプレイはSQLiteの `meta.gamemode` にモードを保存し、欠落時はcreative。変更UIは今回提供しない。ユーザーごとのプレイヤーデータは位置と一緒にメモリ上で記録して再接続へ渡す。Durable Object再起動を越える永続化はM4。

エンティティ追加後の現在のシナリオ値と旧値からの変更理由は [entities.md](entities.md#決定性の現在値) を参照。

## 道具アイテム

| ID | 名前（texture も同名） | 種類 | tier |
| --- | --- | --- | --- |
| 31 | wooden_pickaxe | pickaxe | 1 |
| 32 | wooden_axe | axe | 1 |
| 33 | wooden_shovel | shovel | 1 |
| 34 | stone_pickaxe | pickaxe | 2 |
| 35 | stone_axe | axe | 2 |
| 36 | stone_shovel | shovel | 2 |
| 37 | copper_pickaxe | pickaxe | 3 |
| 38 | copper_axe | axe | 3 |
| 39 | copper_shovel | shovel | 3 |
| 40 | iron_pickaxe | pickaxe | 4 |
| 41 | iron_axe | axe | 4 |
| 42 | iron_shovel | shovel | 4 |
| 50 | wooden_hoe | hoe | 1 |
| 51 | stone_hoe | hoe | 2 |
| 52 | copper_hoe | hoe | 3 |
| 53 | iron_hoe | hoe | 4 |

道具はすべて `block = None`、`max_stack = 1`。`items::info` から `tool.kind`、`tool.tier`、`tool.speed()` と `texture` を取得できる。Creative の選択画面で選んでホットバーへ入れ、Qで捨てられる。採掘速度とドロップ条件は [mining.md](mining.md#道具とドロップ条件) を参照。耐久値は未実装。鍬の使い方とレシピは [farming.md](farming.md) を参照。


## 2×2 クラフトで追加したアイテム

| アイテムID | 名前 | ブロック状態ID | texture | max_stack |
| --- | --- | --- | --- | --- |
| 43 | stick | なし | stick | 64 |
| 44 | crafting_table | 49 | 上・横・下の専用テクスチャ | 64 |

棒と作業台の絵は `textures.ts` の独自のコード生成。作業台は `dig_ticks = 40`、`tool = "axe"`、`min_tier = 0` で、今回は配置のみ。サバイバルの E はインベントリ画面を開く。2×2導入時のプロトコル6でクラフト枠・結果・カーソルを追加した。操作、追加レシピ、保存形式と接続時の返却、現在の決定性ハッシュは [crafting.md](crafting.md) を参照。

## 作物

| アイテムID | 名前 | ブロック状態 ID | texture | max_stack |
| --- | --- | --- | --- | --- |
| 54 | wheat_seeds（小麦の種） | 54（小麦の段階 0） | wheat_seeds | 64 |
| 55 | wheat（小麦） | なし | wheat | 64 |

## 食べ物

| アイテムID | 名前 | texture | max_stack | food |
| --- | --- | --- | --- | --- |
| 49 | apple（リンゴ） | apple | 64 | 4 |
| 56 | bread（パン） | bread | 64 | 5 |
| 62 | raw_beef（生の牛肉） | raw_beef | 64 | 3 |
| 63 | cooked_beef（焼いた牛肉） | cooked_beef | 64 | 8 |
| 64 | raw_porkchop（生の豚肉） | raw_porkchop | 64 | 3 |
| 65 | cooked_porkchop（焼いた豚肉） | cooked_porkchop | 64 | 8 |
| 67 | raw_chicken（生の鶏肉） | raw_chicken | 64 | 2 |
| 68 | cooked_chicken（焼いた鶏肉） | cooked_chicken | 64 | 6 |
| 71 | raw_mutton（生の羊肉） | raw_mutton | 64 | 2 |
| 72 | cooked_mutton（焼いた羊肉） | cooked_mutton | 64 | 6 |

`items.toml` の任意キー `food` は、1個を食べたときに回復する満腹度を1〜20の整数で指定する。`items::food(id)` で取得できる。リンゴに対応するブロックはなく、採掘したオークの葉の代わりに落ちることがある。入手と食事の規則は [health.md](health.md#空腹と食べ物) を参照。

生の鶏肉はかまどで焼いた鶏肉に精錬できる。

生の羊肉はかまどで焼いた羊肉に精錬できる。

## 卵と羽根

| アイテム ID | 名前 | texture | max_stack |
| --- | --- | --- | --- |
| 66 | egg（卵） | egg | 16 |
| 69 | feather（羽根） | feather | 64 |

卵と羽根は食べられない。卵は鶏が産み、羽根は鶏が死んだときに落とすことがある。[鶏の仕様](mobs.md#種類)

## バケツ

| アイテム ID | 名前 | texture | max_stack |
| --- | --- | --- | --- |
| 57 | bucket（空のバケツ） | bucket | 16 |
| 58 | water_bucket（水入りバケツ） | water_bucket | 1 |

どちらも対応するブロックを持たず、絵は `textures.ts` で生成する。空のバケツは鉄インゴット 3 個から作る。[バケツの操作とレシピ](water.md#バケツ)

## 溶岩と黒曜石

| アイテム ID | 名前 | ブロック状態 ID | texture | max_stack |
| --- | --- | --- | --- | --- |
| 59 | lava（溶岩源） | 70 | lava | 64 |
| 60 | lava_bucket（溶岩入りバケツ） | なし | lava_bucket | 1 |
| 61 | obsidian（黒曜石） | 75 | obsidian | 64 |

⑥-4 の決定性シナリオの指紋は `7c46257055d8c652`。状態ハッシュに加えた溶岩ダメージの間隔カウンターを比較実行で除くと、従来の `ff3103752025dd92` に戻る。[比較結果](health.md#決定性シナリオ)

⑦-1a のプロトコル13では、落ちているアイテムと牛が ID 空間と削除パケットを共有する。[Mob の仕様と決定性の確認](mobs.md)

## 羊毛

| アイテム ID | 名前 | ブロック状態 ID | texture | max_stack |
| --- | --- | --- | --- | --- |
| 70 | white_wool（白い羊毛） | 76 | ブロックの絵 | 64 |

`white_wool` は 1 マス全体の不透明なブロックで、道具がなくても掘れる。`dig_ticks` は 16 で、板（40）より短い。掘ると羊毛を 1 個落とす。羊が死んだときにも 1 個落ちる。精錬レシピはないので、溶岩で死んでも羊毛のまま残る。アイテムの絵はブロックのアイコンを使う。
