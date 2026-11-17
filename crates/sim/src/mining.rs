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
        let Some(ticks) = blocks::info(state).dig_ticks else {
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
        assert_eq!(s.entities.len(), 1);
        assert_eq!(
            s.entities.values().next().unwrap().item,
            items::for_block(state).unwrap()
        );
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
    for elapsed in 0..=70 {
        // Observer 3 is joined but streams distant chunks.
        s.tick();
        let packets = progress(&mut s);
        if elapsed % 7 == 0 {
            let stage = if elapsed == 70 {
                255
            } else {
                (elapsed / 7) as u8
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
