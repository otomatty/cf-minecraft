# 実装前に用意した Bedrock テクスチャ

Mojang の Bedrock Samples v1.26.60.5 から、今後の機能に使うカラー画像205枚を収録した。`textures/` 以下の相対パス、ファイル名、PNG・TGAの内容は配布元と同じ。ここに保存しただけではゲームに読み込まれない。画像には同梱の利用条件が適用される。[配布元のリリース](https://github.com/Mojang/bedrock-samples/releases/tag/v1.26.60.5)・[元のテクスチャディレクトリ](https://github.com/Mojang/bedrock-samples/tree/v1.26.60.5/resource_pack/textures)・[利用条件](LICENSE.md)

| 用途 | 枚数 | 収録内容 |
| --- | ---: | --- |
| [チェスト](textures/entity/chest/) | 13 | 通常・ラージ、トラップ、エンダー、銅の酸化4段階とそれぞれのラージ |
| ドア | 54 | 18種類に各3枚。設置時の上半分と下半分は [blocks](textures/blocks/)、所持品アイコンは [items](textures/items/) |
| 剣 | 7 | 木、石、銅、鉄、金、ダイヤモンド、ネザライトの所持品アイコン |
| 防具 | 44 | 7素材の4部位のアイコンと各素材2枚の[着用モデル用の展開図](textures/models/armor/)。カメの甲羅のアイコンと着用用の絵も収録 |
| [村人](textures/entity/villager2/) | 36 | 本体2、地域衣装14（7地域の成体・子ども）、職業などの衣装15、取引レベル5 |
| クモ・エンダーマン | 2 | 通常個体のスキン各1枚。TGAに入っている目の画素とアルファ値を保持 |
| ウシ・ブタ・ニワトリ・ヒツジ | 17 | 最初の3種は各5枚（温暖・寒冷の成体、温帯・温暖・寒冷の子ども）。ヒツジは成体と子どもの元TGA |
| プレイヤー | 1 | アレックスのスキン |
| [HUD・所持品](textures/ui/) | 15 | 被弾時のハート、酸素の泡が割れるコマ、防御力、空の防具枠、経験値、所持品の枠 |
| ワールド、空、エフェクト | 10 | 燃焼中のかまど正面、飛ぶ矢の展開図、草と葉のカラーマップ、太陽、月の8相、雲、炎2種、パーティクルシート |
| タイトル | 6 | パノラマの6面（`ui/panorama_0.png` ～ `ui/panorama_5.png`） |

## 原画一覧

- [チェストとドア](../../docs/images/prepared-storage.png)
- [剣と防具](../../docs/images/prepared-equipment.png)
- [村人の本体・衣装、クモ、エンダーマン](../../docs/images/prepared-villagers.png)
- [動物とプレイヤーの現在のゲーム表示・先行素材](../../docs/images/prepared-variants.png)
- [HUD・ワールド・タイトル](../../docs/images/prepared-world-hud.png)

## 実装時に参照する定義

村人の服は本体に重ねて使う。成体と子ども、地域、職業、取引レベルの対応は配布元のエンティティ定義で確認できる。ヒツジの毛色や発光する目など、一部のTGAではアルファがマスクを兼ねる。一覧画像は模様を読み取れるように表示した。実装には `textures/` の原本を使う。[村人の定義](https://github.com/Mojang/bedrock-samples/blob/v1.26.60.5/resource_pack/entity/villager_v2.entity.json)・[ヒツジの定義](https://github.com/Mojang/bedrock-samples/blob/v1.26.60.5/resource_pack/entity/sheep.entity.json)

飛ぶ矢と着用中の防具はモデルのUVに合わせる。炎は画像を縦に分割した各32コマ、パーティクルは効果ごとに指定された範囲を切り出して使う。[矢のモデル](https://github.com/Mojang/bedrock-samples/blob/v1.26.60.5/resource_pack/models/entity/arrow.geo.json)・[防具の着用定義の例](https://github.com/Mojang/bedrock-samples/blob/v1.26.60.5/resource_pack/attachables/iron_chestplate.json)・[炎のコマ定義](https://github.com/Mojang/bedrock-samples/blob/v1.26.60.5/resource_pack/textures/flipbook_textures.json)・[大型爆発の切り出し位置](https://github.com/Mojang/bedrock-samples/blob/v1.26.60.5/resource_pack/particles/large_explosion_level.json)

## 原本の確認

このディレクトリで `sha256sum -c SHA256SUMS` を実行すると全画像を検証できる。公式リリースを展開した `resource_pack/` で同じコマンドを実行し、チェックサムファイルのパスをこのディレクトリのものに指定すると、配布元とも照合できる。[全205枚のパスとSHA-256](SHA256SUMS)
