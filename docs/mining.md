# 素手の採掘

数値、ブロック定義、ひびの模様はこのプロジェクト独自の仕様。20 tick = 1 秒。`data/registry/blocks.toml` の各ブロックは `dig_ticks`（u16）か `unbreakable = true` のどちらか一方を必須とする。欠落、両方指定、負数、65535超はビルドエラー。`blocks::info(state).dig_ticks` は壊せない場合 `None`。スラブ・階段を含む同じブロックの全状態で値を共有する。現在の全ブロックは指定の材質表に含まれ、追加の値はない。

| ブロック | 素手の dig_ticks |
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

## コアの流れ

Survival の `SetBlock { state: AIR }` は拒否し、既存の `correct_block` と同じ条件で本人へ訂正する。配置は従来のアイテム・置換条件を使う。Creative は従来どおり SetBlock で即座に破壊し、ドロップしない。Creative の DigStart / DigAbort は `packets_rejected` を増やして拒否する。

DigStart は前の採掘を中断し、参加済み、送信済みチャンク、高さ `MIN_Y..MIN_Y+HEIGHT`、既存の `MAX_REACH`（プレイヤーの足元とブロック中心の距離）、壊せるブロックの各条件を確認する。判定は既存の破壊の `can_edit` を共有する。不正な開始は拒否数を増やし、訂正可能なブロックなら本人へ実際の状態を送る。未参加、未送信チャンク、高さ範囲外、サーバーにないチャンクには訂正しない。

クライアントID順の状態に対象位置、開始時のブロック状態、開始tick、必要tick、最後の通知段階を保存する。パケット処理後に毎tick確認する。対象状態が変化した場合、届かなくなった場合、チャンクが対象外になった場合は中断する。DigAbort、新しいDigStart、切断でも中断する。

開始tickでは経過0。`経過 = 現在tick - 開始tick` が必要tick以上になるtickで破壊する。必要0なら開始を処理したtickで破壊する。ブロック変更、アイテム1個の生成、BlockUpdate、統計は従来の Survival の破壊処理を共有する。移動・拾得待ち・拾得は [entities.md](entities.md) の規則に従う。今回、すべての壊せるブロックは素手でアイテムを落とす。

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

Survival の左ボタンは押している状態を毎フレーム調べ、Creative の連打用 heldButtons から分離する。壊せる狙いにDigStartを送り、狙いが変われば旧採掘を中断して新しいDigStartを送る。離す、ポインターロック解除、フォーカス喪失などでDigAbortを送る。経過msを50で割って整数tickにし、サーバーと同じ式で手元の段階を計算する。

手元の時間が満了してもブロックを予測消去せず、段階9のままBlockUpdateを待つ。対象がAIRになったことを確認した時点から250 ms（5 tick）待ち、押し続けていれば次の狙いを掘る。状態変化と送信コマンドは `apps/web/src/client/dig.ts` の関数でテストする。

自分の進行と他人のDigProgressは、ブロックより少し大きい立方体に10段階のひびを半透明で重ねる。スラブ・階段も今回は立方体。模様は `textures.ts` が生成する独自の枝分かれ線で、各段階は前の画素を維持しながら増える。専用の描画パイプラインは深度を検査し、深度を書き換えずに合成する。他人の表示は255、チャンクUnload、再接続で消す。F3 の Dig 行と `window.__mc.stats().dig` に自分の位置・段階を出す（採掘中でなければnull）。

## 決定性と次のPR

| seed=2026 / 600 ticks | ハッシュ |
| --- | --- |
| 現在のCreativeシナリオ | `92a0baa309d6ad75` |
| 旧値 | `2f8d55d7b5e67801` |
| 地形（変更なし） | `6aa960f51ded69b6` |
| ノイズ（変更なし） | `d5166400c68a1c45` |

state_hashに各接続の採掘の有無と全フィールドを追加したため、採掘しないCreativeシナリオでもハッシュが変わる。BTreeMapのクライアントID順にハッシュ化する。採掘時間・段階は整数だけで計算する。過去の記録に書かれた値は変更しない。

次のPRで道具ごとの採掘速度と、道具がないとアイテムを落とさない規則を追加する。今回は道具、適正道具判定、道具によるドロップ制限を実装しない。
