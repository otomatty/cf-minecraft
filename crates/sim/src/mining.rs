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
        assert_eq!(s.entities.len(), usize::from(drops));
        if drops {
            assert_eq!(
                s.entities.values().next().unwrap().item,
                items::for_block(state).unwrap()
            );
        }
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
            assert_eq!(s.entities.len(), 1);
            assert_eq!(
                s.entities.values().next().unwrap().item,
                items::for_block(flower).unwrap()
            );
            assert_eq!(
                s.clients[&1].dig.map(|d| d.pos),
                replace.then_some([x + 1, y, z])
            );
        }
    }
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
