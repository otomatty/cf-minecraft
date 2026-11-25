//! Mining regression tests, including the exact server tick boundary.
use super::*;
use protocol::PROTOCOL_VERSION;

fn setup() -> (Server, [i32; 3]) {
    let mut s = Server::new(2026, Generator::Flat);
    s.set_game_mode(GameMode::Survival);
    for id in 1..=3 {
        s.connect(id);
        s.handle_packet(
            id,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            }
            .encode(),
        );
    }
    s.tick();
    let pos = s.spawn().map(|v| v.floor() as i32);
    s.clients.get_mut(&3).unwrap().sent.clear();
    s.clients.get_mut(&3).unwrap().pos[0] += 1000.0;
    s.take_outbox();
    (s, pos)
}
fn start(s: &mut Server, [x, y, z]: [i32; 3]) {
    s.handle_packet(1, &C2S::DigStart { x, y, z }.encode());
}
fn progress(s: &mut Server) -> Vec<(u32, S2C)> {
    s.take_outbox()
        .into_iter()
        .filter_map(|(id, b)| {
            let p = S2C::decode(&b).unwrap();
            matches!(p, S2C::DigProgress { .. }).then_some((id, p))
        })
        .collect()
}

#[test]
fn exact_duration_zero_duration_and_drops_for_every_state() {
    for state in 0..blocks::COUNT {
        let Some((ticks, drops)) = items::mining(state, None) else {
            continue;
        };
        let (mut s, [x, y, z]) = setup();
        if blocks::is_wheat(state) {
            s.world.set_block(x, y - 1, z, blocks::FARMLAND);
        }
        let started = s.game_time;
        s.world.set_block(x, y, z, state);
        start(&mut s, [x, y, z]);
        s.tick(); // elapsed=0
        for _ in 0..ticks {
            assert_eq!(s.get_block(x, y, z), Some(state));
            s.tick();
        }
        assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
        assert!(s.clients[&1].dig.is_none());
        assert_eq!(s.stats.blocks_changed, 1);
        match state {
            blocks::SHORT_GRASS => assert_grass_drop(&s, [x, y, z], started),
            state if blocks::is_wheat(state) => assert_wheat_drops(&s, state),
            _ => {
                assert_eq!(s.entities.len(), usize::from(drops));
                if drops {
                    assert_eq!(
                        s.entities.values().next().unwrap().item,
                        items::for_block(state).unwrap()
                    );
                }
            }
        }
    }
}

#[test]
fn white_wool_breaks_by_hand_and_drops_itself() {
    let (mut s, [x, y, z]) = setup();
    let wool = blocks::WHITE_WOOL;
    assert!(blocks::is_full_opaque_cube(wool));
    assert_eq!(blocks::info(wool).dig_ticks, Some(16));
    assert_eq!(blocks::info(wool).tool, None);
    assert_eq!(items::mining(wool, None), Some((16, true)));
    s.world.set_block(x, y, z, wool);
    let ticks = 16;
    start(&mut s, [x, y, z]);
    s.tick();
    for _ in 0..ticks {
        assert_eq!(s.get_block(x, y, z), Some(wool));
        s.tick();
    }
    assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
    assert_eq!(s.entities.len(), 1);
    let drop = s.entities.values().next().unwrap();
    assert_eq!(
        (drop.item, drop.count),
        (items::by_name("white_wool").unwrap(), 1)
    );
}

#[test]
fn obsidian_requires_an_iron_pickaxe_and_drops_itself() {
    let (mut s, pos @ [x, y, z]) = setup();
    s.world.set_block(x, y, z, blocks::OBSIDIAN);
    let rejected = s.stats.packets_rejected;
    for held in [
        None,
        Some("wooden_pickaxe"),
        Some("stone_pickaxe"),
        Some("copper_pickaxe"),
        Some("iron_axe"),
    ] {
        let stack = held.map(|name| Stack {
            item: items::by_name(name).unwrap(),
            count: 1,
            damage: 0,
        });
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(0, stack)
            .unwrap();
        start(&mut s, pos);
        s.tick();
        assert!(s.clients[&1].dig.is_none(), "{held:?}");
        assert_eq!(s.get_block(x, y, z), Some(blocks::OBSIDIAN));
    }
    assert_eq!(s.stats.packets_rejected, rejected + 5);
    let pickaxe = items::by_name("iron_pickaxe").unwrap();
    s.clients
        .get_mut(&1)
        .unwrap()
        .inventory
        .set(
            0,
            Some(Stack {
                item: pickaxe,
                count: 1,
                damage: 0,
            }),
        )
        .unwrap();
    let ticks = 400u32.div_ceil(items::info(pickaxe).unwrap().tool.unwrap().speed());
    start(&mut s, pos);
    s.tick();
    for _ in 0..ticks {
        assert_eq!(s.get_block(x, y, z), Some(blocks::OBSIDIAN));
        s.tick();
    }
    assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
    assert_eq!(s.entities.len(), 1);
    assert_eq!(
        Some(s.entities.values().next().unwrap().item),
        items::by_name("obsidian")
    );
}

fn assert_grass_drop(s: &Server, pos: [i32; 3], mined_at: i64) {
    let mut same_roll = Server::new(s.seed, Generator::Flat);
    same_roll.game_time = mined_at;
    let hit = same_roll.block_drop_random(pos).next_int_bound(8) == 0;
    assert_eq!(s.entities.len(), usize::from(hit));
    if hit {
        let drop = s.entities.values().next().unwrap();
        assert_eq!(Some(drop.item), items::by_name("wheat_seeds"));
        assert_eq!(drop.count, 1);
    }
}

fn assert_wheat_drops(s: &Server, state: u16) {
    let seeds = items::by_name("wheat_seeds").unwrap();
    let wheat = items::by_name("wheat").unwrap();
    let seed_drop = s.entities.values().find(|e| e.item == seeds).unwrap();
    if state == blocks::RIPE_WHEAT {
        assert!((1..=2).contains(&seed_drop.count));
        assert_eq!(
            s.entities.values().find(|e| e.item == wheat).unwrap().count,
            1
        );
        assert_eq!(s.entities.len(), 2);
    } else {
        assert_eq!(seed_drop.count, 1);
        assert_eq!(s.entities.len(), 1);
    }
}

#[test]
fn direct_break_and_creative_dig_are_rejected() {
    let (mut s, [x, y, z]) = setup();
    s.world.set_block(x, y, z, blocks::DIRT);
    s.handle_packet(
        1,
        &C2S::SetBlock {
            x,
            y,
            z,
            state: blocks::AIR,
        }
        .encode(),
    );
    s.tick();
    assert_eq!(s.stats.packets_rejected, 1);
    assert_eq!(s.stats.edits_corrected, 1);
    assert_eq!(s.get_block(x, y, z), Some(blocks::DIRT));
    s.set_game_mode(GameMode::Creative);
    start(&mut s, [x, y, z]);
    s.handle_packet(1, &C2S::DigAbort.encode());
    s.tick();
    assert_eq!(s.stats.packets_rejected, 3);
    assert!(s.clients[&1].dig.is_none());
    s.handle_packet(
        1,
        &C2S::SetBlock {
            x,
            y,
            z,
            state: blocks::AIR,
        }
        .encode(),
    );
    s.tick();
    assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
    assert!(s.entities.is_empty());
}

#[test]
fn invalid_targets_reject_and_correct_only_available_blocks() {
    for state in [blocks::AIR, blocks::BEDROCK, blocks::WATER] {
        let (mut s, [x, y, z]) = setup();
        s.world.set_block(x, y, z, state);
        start(&mut s, [x, y, z]);
        s.tick();
        assert!(s.clients[&1].dig.is_none());
        assert_eq!(s.stats.packets_rejected, 1);
        assert_eq!(s.stats.edits_corrected, 1);
    }
    for reason in 0..4 {
        let (mut s, mut pos) = setup();
        s.world.set_block(pos[0], pos[1], pos[2], blocks::STONE);
        match reason {
            0 => s.clients.get_mut(&1).unwrap().sent.clear(),
            1 => s.clients.get_mut(&1).unwrap().pos[0] += 100.0,
            2 => pos[1] = MIN_Y - 1,
            _ => s.clients.get_mut(&1).unwrap().joined = false,
        }
        start(&mut s, pos);
        s.tick();
        assert!(s.clients[&1].dig.is_none());
        assert_eq!(s.stats.packets_rejected, 1);
        assert_eq!(s.stats.edits_corrected, u64::from(reason == 1));
    }
}

#[test]
fn changes_distance_abort_and_replacement_cancel_previous_dig() {
    for reason in 0..4 {
        let (mut s, [x, y, z]) = setup();
        s.world.set_block(x, y, z, blocks::STONE);
        start(&mut s, [x, y, z]);
        s.tick();
        match reason {
            0 => {
                s.world.set_block(x, y, z, blocks::DIRT);
            }
            1 => s.clients.get_mut(&1).unwrap().pos[0] += 100.0,
            2 => s.handle_packet(1, &C2S::DigAbort.encode()),
            _ => {
                s.world.set_block(x + 1, y, z, blocks::DIRT);
                start(&mut s, [x + 1, y, z]);
            }
        }
        s.tick();
        let digs = progress(&mut s);
        assert!(digs.contains(&(
            2,
            S2C::DigProgress {
                player: 1,
                x,
                y,
                z,
                stage: 255
            }
        )));
        if reason == 3 {
            assert_eq!(s.clients[&1].dig.unwrap().pos, [x + 1, y, z]);
        } else {
            assert!(s.clients[&1].dig.is_none());
        }
        for _ in 0..100 {
            s.tick();
        }
        assert_ne!(s.get_block(x, y, z), Some(blocks::AIR));
    }
}

#[test]
fn progress_only_changes_once_per_tick_and_filters_observers() {
    let (mut s, [x, y, z]) = setup();
    s.world.set_block(x, y, z, blocks::STONE);
    start(&mut s, [x, y, z]);
    for elapsed in 0..=140 {
        // Observer 3 is joined but streams distant chunks.
        s.tick();
        let packets = progress(&mut s);
        if elapsed % 14 == 0 {
            let stage = if elapsed == 140 {
                255
            } else {
                (elapsed / 14) as u8
            };
            assert_eq!(
                packets,
                vec![(
                    2,
                    S2C::DigProgress {
                        player: 1,
                        x,
                        y,
                        z,
                        stage
                    }
                )]
            );
        } else {
            assert!(packets.is_empty());
        }
    }
    s.tick();
    assert!(progress(&mut s).is_empty());
    s.world.set_block(x, y, z, blocks::DIRT);
    start(&mut s, [x, y, z]);
    s.handle_packet(1, &C2S::DigAbort.encode());
    start(&mut s, [x, y, z]);
    s.tick();
    assert_eq!(
        progress(&mut s),
        vec![(
            2,
            S2C::DigProgress {
                player: 1,
                x,
                y,
                z,
                stage: 0
            }
        )]
    );
    s.disconnect(1);
    s.tick();
    assert_eq!(
        progress(&mut s),
        vec![(
            2,
            S2C::DigProgress {
                player: 1,
                x,
                y,
                z,
                stage: 255
            }
        )]
    );
}

#[test]
fn identical_inputs_hash_identically_and_active_dig_changes_hash() {
    let (mut a, pos) = setup();
    let (mut b, _) = setup();
    for s in [&mut a, &mut b] {
        s.world.set_block(pos[0], pos[1], pos[2], blocks::STONE);
        start(s, pos);
    }
    for _ in 0..80 {
        a.tick();
        b.tick();
        assert_eq!(a.state_hash(), b.state_hash());
    }
    a.world.set_block(pos[0], pos[1], pos[2], blocks::STONE);
    b.world.set_block(pos[0], pos[1], pos[2], blocks::STONE);
    start(&mut a, pos);
    a.tick();
    b.tick();
    assert_ne!(a.state_hash(), b.state_hash());
}

#[test]
fn instant_digs_break_and_drop_before_same_tick_abort_or_replacement() {
    for flower in [
        blocks::SHORT_GRASS,
        blocks::RED_FLOWER,
        blocks::YELLOW_FLOWER,
    ] {
        for replace in [false, true] {
            let (mut s, [x, y, z]) = setup();
            s.world.set_block(x, y, z, flower);
            s.world.set_block(x + 1, y, z, blocks::STONE);
            let started = s.game_time;
            start(&mut s, [x, y, z]);
            if replace {
                start(&mut s, [x + 1, y, z]);
            } else {
                s.handle_packet(1, &C2S::DigAbort.encode());
            }
            s.tick();
            assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
            assert_eq!(s.get_block(x + 1, y, z), Some(blocks::STONE));
            assert_eq!(s.stats.blocks_changed, 1);
            assert_eq!(s.stats.packets_rejected, 0);
            if flower == blocks::SHORT_GRASS {
                assert_grass_drop(&s, [x, y, z], started);
            } else {
                assert_eq!(s.entities.len(), 1);
                assert_eq!(
                    s.entities.values().next().unwrap().item,
                    items::for_block(flower).unwrap()
                );
            }
            assert_eq!(
                s.clients[&1].dig.map(|d| d.pos),
                replace.then_some([x + 1, y, z])
            );
        }
    }
}

#[test]
fn short_grass_seed_rolls_change_after_misses_and_repeat_from_the_same_state() {
    let run = || {
        let (mut s, pos @ [x, y, z]) = setup();
        (0..128)
            .map(|_| {
                s.world.set_block(x, y, z, blocks::SHORT_GRASS);
                let mined_at = s.game_time;
                let next_id = s.next_entity_id;
                start(&mut s, pos);
                s.tick();
                assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
                assert_grass_drop(&s, pos, mined_at);
                let hit = !s.entities.is_empty();
                if !hit {
                    assert_eq!(s.next_entity_id, next_id);
                }
                s.entities.clear();
                hit
            })
            .collect::<Vec<_>>()
    };
    let results = run();
    assert_eq!(results, run());
    assert!(results.windows(2).any(|pair| pair == [false, true]));
}

#[test]
fn digging_farmland_breaks_its_crop_and_drops_dirt_wheat_and_seeds() {
    let (mut s, pos @ [x, y, z]) = setup();
    s.world.set_block(x, y, z, blocks::FARMLAND);
    s.world.set_block(x, y + 1, z, blocks::RIPE_WHEAT);
    start(&mut s, pos);
    for _ in 0..=12 {
        s.tick();
    }
    assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
    assert_eq!(s.get_block(x, y + 1, z), Some(blocks::AIR));
    assert_eq!(s.stats.blocks_changed, 2);
    let dirt = s.entities.remove(&1).unwrap();
    assert_eq!(Some(dirt.item), items::by_name("dirt"));
    assert_eq!(dirt.count, 1);
    assert_wheat_drops(&s, blocks::RIPE_WHEAT);
}

#[test]
fn seeds_place_at_age_zero_only_in_air_above_farmland_in_both_modes() {
    for mode in [GameMode::Survival, GameMode::Creative] {
        for (below, old, state, succeeds) in [
            (blocks::FARMLAND, blocks::AIR, blocks::WHEAT, true),
            (blocks::MOIST_FARMLAND, blocks::AIR, blocks::WHEAT, true),
            (blocks::DIRT, blocks::AIR, blocks::WHEAT, false),
            (blocks::FARMLAND, blocks::WATER, blocks::WHEAT, false),
            (blocks::FARMLAND, blocks::SHORT_GRASS, blocks::WHEAT, false),
            (blocks::FARMLAND, blocks::WHEAT + 1, blocks::WHEAT, false),
            (blocks::FARMLAND, blocks::AIR, blocks::RIPE_WHEAT, false),
        ] {
            let (mut s, [x, y, z]) = setup();
            s.set_game_mode(mode);
            let seeds = Stack {
                item: items::by_name("wheat_seeds").unwrap(),
                count: 2,
                damage: 0,
            };
            s.clients
                .get_mut(&1)
                .unwrap()
                .inventory
                .set(0, Some(seeds))
                .unwrap();
            s.world.set_block(x, y - 1, z, below);
            s.world.set_block(x, y, z, old);
            s.apply(1, C2S::SetBlock { x, y, z, state });
            assert_eq!(s.stats.packets_rejected, u64::from(!succeeds));
            assert_eq!(
                s.get_block(x, y, z),
                Some(if succeeds { state } else { old })
            );
            assert_eq!(
                s.clients[&1].inventory.selected_stack().unwrap().count,
                if succeeds && mode == GameMode::Survival {
                    1
                } else {
                    2
                },
            );
        }
    }
}

#[test]
fn hoe_uses_grass_and_dirt_in_both_modes_and_interrupts_mining() {
    for mode in [GameMode::Survival, GameMode::Creative] {
        for ground in [blocks::GRASS_BLOCK, blocks::DIRT] {
            let (mut s, pos @ [x, y, z]) = setup();
            s.set_game_mode(mode);
            s.world.set_block(x, y, z, ground);
            let hoe = Stack {
                item: items::by_name("wooden_hoe").unwrap(),
                count: 1,
                damage: 0,
            };
            s.clients
                .get_mut(&1)
                .unwrap()
                .inventory
                .set(0, Some(hoe))
                .unwrap();
            s.clients.get_mut(&2).unwrap().dig = Some(Dig {
                pos,
                state: ground,
                start: s.game_time,
                ticks: 12,
                drops: true,
                stage: None,
            });
            s.apply(1, C2S::UseBlock { x, y, z });
            assert_eq!(s.get_block(x, y, z), Some(blocks::FARMLAND));
            assert_eq!(
                s.clients[&1].inventory.selected_stack(),
                Some(Stack {
                    damage: u16::from(mode == GameMode::Survival),
                    ..hoe
                })
            );
            assert_eq!(s.clients[&1].inventory.screen, inventory::Screen::None);
            assert_eq!(s.stats.packets_rejected, 0);
            assert_eq!(s.stats.blocks_changed, 1);
            assert!(s.clients[&2].dig.is_none());
            assert!(s.take_outbox().contains(&(
                2,
                S2C::BlockUpdate {
                    x,
                    y,
                    z,
                    state: blocks::FARMLAND,
                }
                .encode()
            )));
        }
    }
}

#[test]
fn hoe_use_rejections_resend_inventory_and_workstations_still_open() {
    use inventory::Screen;
    for (ground, above, item, offset, screen) in [
        (blocks::DIRT, blocks::GLASS, "wooden_hoe", 0, Screen::None),
        (blocks::DIRT, blocks::AIR, "iron_shovel", 0, Screen::None),
        (blocks::DIRT, blocks::AIR, "stone_hoe", 10, Screen::None),
        (blocks::STONE, blocks::AIR, "copper_hoe", 0, Screen::None),
        (
            blocks::DIRT,
            blocks::AIR,
            "iron_hoe",
            0,
            Screen::CraftingTable { pos: [0; 3] },
        ),
        (
            blocks::CRAFTING_TABLE,
            blocks::AIR,
            "wooden_hoe",
            0,
            Screen::None,
        ),
        (blocks::FURNACE, blocks::AIR, "wooden_hoe", 0, Screen::None),
    ] {
        let (mut s, [x, y, z]) = setup();
        let x = x + offset;
        let pos = [x, y, z];
        s.world.set_block(x, y, z, ground).unwrap();
        s.world.set_block(x, y + 1, z, above);
        let client = s.clients.get_mut(&1).unwrap();
        let stack = Stack {
            item: items::by_name(item).unwrap(),
            count: 1,
            damage: 0,
        };
        client.inventory.set(0, Some(stack)).unwrap();
        client.inventory.screen = screen;
        client.inventory_dirty = false;
        s.apply(1, C2S::UseBlock { x, y, z });
        let (expected_screen, rejected) = match ground {
            blocks::CRAFTING_TABLE => (Screen::CraftingTable { pos }, 0),
            blocks::FURNACE => (Screen::Furnace { pos }, 0),
            _ => (screen, 1),
        };
        assert_eq!(s.stats.packets_rejected, rejected);
        assert_eq!(s.get_block(x, y, z), Some(ground));
        assert_eq!(s.clients[&1].inventory.selected_stack(), Some(stack));
        assert_eq!(s.clients[&1].inventory.screen, expected_screen);
        assert!(s.clients[&1].inventory_dirty);
    }
}

#[test]
fn creative_edits_break_unsupported_wheat_and_short_grass_without_drops() {
    let (mut s, [x, y, z]) = setup();
    s.set_game_mode(GameMode::Creative);
    s.world.set_block(x, y, z, blocks::FARMLAND);
    s.world.set_block(x, y + 1, z, blocks::RIPE_WHEAT);
    s.apply(
        1,
        C2S::SetBlock {
            x,
            y,
            z,
            state: blocks::STONE,
        },
    );
    assert_eq!(s.get_block(x, y + 1, z), Some(blocks::AIR));
    s.world.set_block(x, y, z, blocks::SHORT_GRASS);
    s.apply(
        1,
        C2S::SetBlock {
            x,
            y,
            z,
            state: blocks::AIR,
        },
    );
    assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
    assert_eq!(s.stats.packets_rejected, 0);
    assert!(s.entities.is_empty());
}

#[test]
fn slab_changed_and_restored_in_one_tick_cancels_all_miners() {
    let (mut s, [x, y, z]) = setup();
    let pos = s.clients[&1].pos;
    let sent = s.clients[&1].sent.clone();
    s.clients.get_mut(&3).unwrap().pos = pos;
    s.clients.get_mut(&3).unwrap().sent = sent;
    s.world.set_block(x, y, z, blocks::OAK_SLAB);
    start(&mut s, [x, y, z]);
    s.handle_packet(3, &C2S::DigStart { x, y, z }.encode());
    for _ in 0..5 {
        s.tick();
    }
    s.take_outbox();
    s.clients
        .get_mut(&2)
        .unwrap()
        .inventory
        .add(items::for_block(blocks::OAK_SLAB).unwrap(), 2);
    for state in [blocks::OAK_SLAB + 1, blocks::OAK_SLAB] {
        s.handle_packet(2, &C2S::SetBlock { x, y, z, state }.encode());
    }
    s.tick();
    assert_eq!(s.stats.packets_rejected, 0);
    assert_eq!(s.stats.blocks_changed, 2);
    assert_eq!(s.get_block(x, y, z), Some(blocks::OAK_SLAB));
    assert!(s.clients[&1].dig.is_none());
    assert!(s.clients[&3].dig.is_none());
    let packets = progress(&mut s);
    assert_eq!(packets.len(), 4);
    for player in [1, 3] {
        for observer in 1..=3 {
            if observer != player {
                assert!(packets.contains(&(
                    observer,
                    S2C::DigProgress {
                        player,
                        x,
                        y,
                        z,
                        stage: 255
                    }
                )));
            }
        }
    }
    for _ in 0..40 {
        s.tick();
    }
    assert_eq!(s.get_block(x, y, z), Some(blocks::OAK_SLAB));
    assert!(s.entities.is_empty());
}

#[test]
fn survival_tools_use_exact_duration_and_gate_drops() {
    for (block, held, ticks, drops) in [
        (blocks::STONE, Some("wooden_pickaxe"), 35, true),
        (blocks::STONE, None, 140, false),
        (blocks::GOLD_ORE, Some("stone_pickaxe"), 46, false),
        (blocks::GOLD_ORE, Some("copper_pickaxe"), 18, true),
    ] {
        let (mut s, [x, y, z]) = setup();
        if let Some(name) = held {
            s.clients
                .get_mut(&1)
                .unwrap()
                .inventory
                .add(items::by_name(name).unwrap(), 1);
        }
        s.world.set_block(x, y, z, block);
        start(&mut s, [x, y, z]);
        s.tick();
        for _ in 0..ticks {
            assert_eq!(s.get_block(x, y, z), Some(block));
            s.tick();
        }
        assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
        assert_eq!(s.entities.len(), usize::from(drops));
    }
}

#[test]
fn changing_slots_or_held_contents_aborts_even_between_ticks() {
    for reason in 0..4 {
        let (mut s, [x, y, z]) = setup();
        let tool = items::by_name("wooden_pickaxe").unwrap();
        if reason != 3 {
            s.clients.get_mut(&1).unwrap().inventory.add(tool, 1);
        }
        s.world.set_block(x, y, z, blocks::STONE);
        start(&mut s, [x, y, z]);
        s.tick();
        match reason {
            0 | 1 => {
                s.handle_packet(1, &C2S::SelectSlot { slot: 1 }.encode());
                if reason == 1 {
                    s.handle_packet(1, &C2S::SelectSlot { slot: 0 }.encode());
                }
            }
            2 => s.handle_packet(1, &C2S::DropItem { dir: [0.0; 3] }.encode()),
            _ => s.spawn_item(tool, 1, s.clients[&1].pos, [0.0; 3], 0),
        }
        s.tick();
        assert!(s.clients[&1].dig.is_none());
        assert!(progress(&mut s)
            .iter()
            .any(|(_, p)| matches!(p, S2C::DigProgress { stage: 255, .. })));
        for _ in 0..150 {
            s.tick();
        }
        assert_eq!(s.get_block(x, y, z), Some(blocks::STONE));
    }
}

#[test]
fn held_item_count_changes_preserve_the_original_completion_tick() {
    for pickup in [true, false] {
        let (mut s, [x, y, z]) = setup();
        let dirt = items::for_block(blocks::DIRT).unwrap();
        s.clients.get_mut(&1).unwrap().inventory.add(dirt, 2);
        s.world.set_block(x, y, z, blocks::DIRT);
        start(&mut s, [x, y, z]);
        s.tick();
        let dig = s.clients[&1].dig.unwrap();
        assert_eq!(dig.ticks, 12);
        for elapsed in 1..=12 {
            if elapsed == 4 {
                if pickup {
                    s.spawn_item(dirt, 1, s.clients[&1].pos, [0.0; 3], 0);
                } else {
                    s.handle_packet(1, &C2S::DropItem { dir: [0.0; 3] }.encode());
                }
            }
            s.tick();
            if elapsed == 4 {
                assert_eq!(
                    s.clients[&1].inventory.selected_stack(),
                    Some(Stack {
                        item: dirt,
                        count: if pickup { 3 } else { 1 },
                        damage: 0,
                    })
                );
            }
            if elapsed < 12 {
                assert_eq!(s.get_block(x, y, z), Some(blocks::DIRT));
                assert_eq!(s.clients[&1].dig.unwrap().start, dig.start);
                assert!(!progress(&mut s)
                    .iter()
                    .any(|(_, p)| matches!(p, S2C::DigProgress { stage: 255, .. })));
            }
        }
        assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
        assert!(s.clients[&1].dig.is_none());
        assert_eq!(s.stats.blocks_changed, 1);
    }
}

#[test]
fn mining_wears_any_durable_item_except_on_instant_breaks() {
    for mode in [GameMode::Survival, GameMode::Creative] {
        let (mut s, [x, y, z]) = setup();
        s.set_game_mode(mode);
        let bow = Stack {
            item: items::by_name("bow").unwrap(),
            count: 1,
            damage: 0,
        };
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(0, Some(bow))
            .unwrap();

        for (block, nonzero_ticks) in [(blocks::SHORT_GRASS, false), (blocks::WHITE_WOOL, true)] {
            s.world.set_block(x, y, z, block);
            let (ticks, _) = items::mining(block, Some(bow.item)).unwrap();
            assert_eq!(ticks > 0, nonzero_ticks);
            match mode {
                GameMode::Survival => {
                    s.apply(1, C2S::DigStart { x, y, z });
                    s.game_time += i64::from(ticks);
                    s.tick_digs();
                }
                GameMode::Creative => s.apply(
                    1,
                    C2S::SetBlock {
                        x,
                        y,
                        z,
                        state: blocks::AIR,
                    },
                ),
            }
            assert_eq!(s.get_block(x, y, z), Some(blocks::AIR));
            assert_eq!(
                s.clients[&1].inventory.selected_stack(),
                Some(Stack {
                    damage: u16::from(nonzero_ticks && mode == GameMode::Survival),
                    ..bow
                })
            );
        }
    }
}

#[test]
fn last_use_finishes_mining_or_tilling_and_sends_break_and_empty_slot() {
    for (name, block, expected) in [
        ("wooden_pickaxe", blocks::STONE, blocks::AIR),
        ("wooden_hoe", blocks::DIRT, blocks::FARMLAND),
    ] {
        let (mut s, [x, y, z]) = setup();
        let item = items::by_name(name).unwrap();
        let damage = items::info(item).unwrap().durability.unwrap() - 1;
        s.clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(
                0,
                Some(Stack {
                    item,
                    count: 1,
                    damage,
                }),
            )
            .unwrap();
        s.world.set_block(x, y, z, block);
        if expected == blocks::AIR {
            s.apply(1, C2S::DigStart { x, y, z });
            s.game_time += i64::from(s.clients[&1].dig.unwrap().ticks);
            s.tick_digs();
            assert_eq!(
                s.entities.values().next().unwrap().item,
                items::by_name("cobblestone").unwrap()
            );
        } else {
            s.apply(1, C2S::UseBlock { x, y, z });
        }
        assert_eq!(s.get_block(x, y, z), Some(expected));
        assert!(s.clients[&1].inventory.selected_stack().is_none());
        assert!(s.clients[&1].inventory_dirty);
        s.send_inventory(1);
        let packets = s.take_outbox();
        assert_eq!(
            packets
                .iter()
                .filter(|(_, p)| S2C::decode(p) == Ok(S2C::ToolBreak))
                .collect::<Vec<_>>(),
            [&(1, S2C::ToolBreak.encode())]
        );
        assert!(packets.iter().any(|(id, p)| {
            *id == 1
                && matches!(S2C::decode(p), Ok(S2C::Inventory { slots, .. }) if slots[0].is_none())
        }));
    }
}
