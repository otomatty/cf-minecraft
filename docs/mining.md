# 採掘と道具

数値、ブロック定義、ひびの模様はこのプロジェクト独自の仕様。20 tick = 1 秒。`data/registry/blocks.toml` の各ブロックは `dig_ticks`（u16）か `unbreakable = true` のどちらか一方を必須とする。欠落、両方指定、負数、65535超はビルドエラー。`blocks::info(state).dig_ticks` は壊せない場合 `None`。スラブ・階段を含む同じブロックの全状態で値を共有する。現在の全ブロックは指定の材質表に含まれ、追加の値はない。

| ブロック | 基本の dig_ticks |
| --- | --- |
| air | 壊せない |
| stone | 70 |
| grass_block | 14 |
| dirt | 12 |
| cobblestone | 70 |
| oak_planks | 40 |
| bedrock | 壊せない |
| sand | 12 |
| oak_log | 40 |
| bricks | 70 |
| lamp_block | 10 |
| glass | 8 |
| oak_leaves | 6 |
| water | 壊せない |
| oak_slab | 40 |
| cobblestone_slab | 70 |
| red_flower | 0 |
| yellow_flower | 0 |
| short_grass | 0 |
| oak_stairs | 40 |
| cobblestone_stairs | 70 |
| oak_fence | 40 |
| snow_block | 8 |
| sandstone | 50 |
| gravel | 14 |
| ice | 12 |
| coarse_dirt | 12 |
| coal_ore | 90 |
| copper_ore | 90 |
| iron_ore | 90 |
| gold_ore | 90 |
| crafting_table | 40 |
| furnace | 70 |
| placed_oak_leaves | 6 |
| farmland | 12 |
| wheat | 0 |
| flowing_water | 壊せない |
| lava | 壊せない |
| flowing_lava | 壊せない |
| obsidian | 400（鉄のつるはし未満では採掘不可） |

## コアの流れ

Survival の `SetBlock { state: AIR }` は拒否し、既存の `correct_block` と同じ条件で本人へ訂正する。配置は従来のアイテム・置換条件を使う。Creative は従来どおり SetBlock で即座に破壊し、ドロップしない。Creative の DigStart / DigAbort は `packets_rejected` を増やして拒否する。

DigStart は前の採掘を中断し、参加済み、送信済みチャンク、高さ `MIN_Y..MIN_Y+HEIGHT`、既存の `MAX_REACH`（プレイヤーの足元とブロック中心の距離）、壊せるブロックの各条件を確認する。判定は既存の破壊の `can_edit` を共有する。不正な開始は拒否数を増やし、訂正可能なブロックなら本人へ実際の状態を送る。未参加、未送信チャンク、高さ範囲外、サーバーにないチャンクには訂正しない。

クライアントID順の状態に対象位置、開始時のブロック状態、開始tick、必要tick、ドロップ可否、最後の通知段階を保存する。パケット処理後に毎tick確認する。対象状態が変化した場合、届かなくなった場合、チャンクが対象外になった場合は中断する。DigAbort、新しいDigStart、切断でも中断する。

開始tickでは経過0。`経過 = 現在tick - 開始tick` が必要tick以上になるtickで破壊する。必要0なら開始を処理したtickで破壊する。ブロック変更、アイテム1個の生成、BlockUpdate、統計は従来の Survival の破壊処理を共有する。移動・拾得待ち・拾得は [entities.md](entities.md) の規則に従う。ドロップ可否は開始時の道具で決め、下記の段階条件に従う。

## プロトコル5

既存のパケット番号は変更しない。複数バイト整数はビッグエンディアン。

| 方向 | 番号 | パケットとフィールド |
| --- | --- | --- |
| C2S | 0x07 | DigStart: x / y / z i32 |
| C2S | 0x08 | DigAbort: フィールドなし |
| S2C | 0x0b | DigProgress: player u32, x / y / z i32, stage u8 |

player は採掘している接続ID（0は拒否）。stage は0〜9または255のみ受理し、短いデータや末尾バイトも拒否する。座標i32の全域はワイヤ形式として有効で、採掘の高さ・距離・チャンク条件はサーバーで判定する。

`stage = min(9, floor(経過tick × 10 / 必要tick))`。必要0は段階を計算せず完了する。開始時の段階0と、その後の段階変化時に通知し、完了・中断時は255で消す。本人を除く、対象チャンクを送信済みの参加者だけに送る。通知は `(player, 位置)` をキーにBTreeMapへ集約し、同じtick・同じ対象では最後の段階だけを送る。置き換えでは旧対象の255と新対象の段階を送る。クライアントは255の位置も確認し、新しい対象のひびを古い対象の消去で消さない。

## クライアント

Survival の左ボタンは押している状態を毎フレーム調べ、Creative の連打用 heldButtons から分離する。壊せる狙いにDigStartを送り、狙いが変われば旧採掘を中断して新しいDigStartを送る。離す、ポインターロック解除、フォーカス喪失などでDigAbortを送る。必要 tick は状態と選択中のアイテムを WASM に渡して Rust の共通関数から取得する。経過msを50で割って整数tickにし、手元の段階を計算する。

手元の時間が満了してもブロックを予測消去せず、段階9のままBlockUpdateを待つ。対象がAIRになったことを確認した時点から250 ms（5 tick）待ち、押し続けていれば次の狙いを掘る。状態変化と送信コマンドは `apps/web/src/client/dig.ts` の関数でテストする。

自分の進行と他人のDigProgressは、ブロックより少し大きい立方体に10段階のひびを半透明で重ねる。スラブ・階段も今回は立方体。模様は `textures.ts` が生成する独自の枝分かれ線で、各段階は前の画素を維持しながら増える。専用の描画パイプラインは深度を検査し、深度を書き換えずに合成する。他人の表示は255、チャンクUnload、再接続で消す。F3 の Dig 行と `window.__mc.stats().dig` に自分の位置・段階を出す（採掘中でなければnull）。

## 決定性と今後

| seed=2026 / 600 ticks | ハッシュ |
| --- | --- |
| 現在のCreativeシナリオ | `92a0baa309d6ad75` |
| 旧値 | `2f8d55d7b5e67801` |
| 地形（現在の参照値） | `7ec6cedb74055722` |
| ノイズ（変更なし） | `d5166400c68a1c45` |

前のPRではstate_hashに各接続の採掘の有無と全フィールドを追加したため、採掘しないCreativeシナリオでもハッシュが変わった。BTreeMapのクライアントID順にハッシュ化する。採掘時間・段階は整数だけで計算する。今回の道具追加ではCreativeシナリオの現在値は変わらない。採掘中のみハッシュ化する必要tickをu32へ拡張し、ドロップ可否を加えた。過去の記録に書かれた値は変更しない。

道具の耐久値は未実装。使用しても減らない。Survival ではまだ道具を作る手段がなく、次の PR のクラフトで追加する。Creative ではブロック選択画面から道具も選べる。

## 道具とドロップ条件

すべての名前・数値・ドット絵は本プロジェクト独自の仕様。道具は `max_stack = 1`。種類は pickaxe（つるはし）、axe（斧）、shovel（シャベル）。各段階に3種類あり、計12アイテム。

| tier | 接頭辞 | 速さ |
| --- | --- | --- |
| 1 | wooden | 2倍 |
| 2 | stone | 4倍 |
| 3 | copper | 5倍 |
| 4 | iron | 6倍 |

| ブロック | 適した tool | min_tier |
| --- | --- | --- |
| stone, cobblestone, cobblestone_slab, cobblestone_stairs, bricks, sandstone, coal_ore, furnace | pickaxe | 1 |
| copper_ore, iron_ore | pickaxe | 2 |
| gold_ore | pickaxe | 3 |
| obsidian | pickaxe | 4 |
| ice | pickaxe | 0 |
| oak_log, oak_planks, oak_slab, oak_stairs, oak_fence, crafting_table | axe | 0 |
| dirt, coarse_dirt, grass_block, sand, gravel, snow_block, farmland | shovel | 0 |
| air, bedrock, water, lamp_block, glass, oak_leaves, red_flower, yellow_flower, short_grass, placed_oak_leaves, wheat, flowing_water, lava, flowing_lava | なし | 0 |

表外の材質への追加割り当てはない。`min_tier` の省略値は0。1以上には `tool` が必須。種類・段階の範囲はビルド時に検証する。

`world::items::mining(state, held)` が必要 tick（u32）とドロップ可否を返す唯一の計算箇所。壊せない状態は `None`。適した種類の道具なら `ceil(dig_ticks / speed)`、それ以外なら `dig_ticks`。`min_tier >= 1` で種類が合わない、または段階不足なら、その tick をさらに2倍にし、ブロックは壊れるがアイテムを生成しない。黒曜石（`obsidian`）だけはこの 2 倍の規則の例外。段階 4 のつるはしの条件を満たさないと `None` を返し、採掘を開始できない。切り上げ・倍加は整数だけで行い、`dig_ticks = 0` は常に0。例: 素手の石は140 tick・ドロップなし、木のつるはしの石は35 tick・ドロップあり、石のつるはしの金鉱石は46 tick・ドロップなし。

`blocks.toml` の省略可能な `drop = "アイテム名"` で採掘時のドロップを指定できる。未知のアイテム名はビルドエラー。省略時は従来どおり同名のアイテムになり、`world::items::mining_drop(state)` が対応を返す。stone は `drop = "cobblestone"` を指定し、木のつるはしで石を掘ると丸石が落ちる。素手では段階条件を満たさず何も落ちない。配置時の対応は変わらず、stone アイテムを置くと stone ブロックになる。

DigStart 処理時に選択中のアイテムで時間とドロップ可否を確定する。SelectSlot による選択枠の番号の変更、または捨てる・拾得・配置による選択中のアイテム ID の変更（空の枠への変化・空の枠からの変化を含む）は DigAbort と同じ中断。同じアイテムの個数だけの変化では中断しない。1 tick 内で持ち替えて元に戻しても中断する。クライアントも持ち替えで中断し、左ボタンを押し続けていれば新しい道具でやり直す。Creative の即時破壊とドロップなしの挙動は変わらない。

アイコンは16×16の透明背景に柄と種類別の頭をコード生成し、段階で頭の色を変える。ブロック以外のドロップは両面の平たい板で描き、透明画素を破棄し、縦軸まわりに回転する。

## かまど追加時のドロップ更新

`coal_ore` の `drop` は `coal`。木のつるはし（tier 1）以上で採掘すると石炭1個を落とす。鉱石ブロックのアイテム自体は引き続き別IDとして存在する。かまどはpickaxe、min_tier=1、dig_ticks=70。中身の3枠は採掘道具とゲームモードに関わらず、かまどブロックが壊れた位置へ落とす。

プロトコル 24 では、発言・参加・退出をチャットパケットで同期する。詳細は [チャット](chat.md) を参照。

プロトコル 25 では、ゾンビの近接攻撃による押し返しと Mob の燃焼状態を同期する。詳細は [押し返しと燃えている見た目](mobs.md#プロトコル-25) を参照。

プロトコル 26 では、爆心を `Explosion` で同期する。詳細は [爆発の仕上げ](mobs.md#プロトコル-26) を参照。

プロトコル 27 では、ほかのプレイヤーの名前と姿勢を `PlayerSpawn`、`PlayerMove`、`PlayerRemove` で同期する。詳細は [ほかのプレイヤー](entities.md#ほかのプレイヤープロトコル-27) を参照。

プロトコル 28 では、チャットに通知・動作・ささやきの種類を足し、コマンドを処理する。詳細は [コマンド](chat.md#コマンドプロトコル-28) を参照。
