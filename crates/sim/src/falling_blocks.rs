use world::{blocks, MIN_Y};

use crate::Server;

const FALL_DELAY: i64 = 2;

fn is_open(state: u16) -> bool {
    state == blocks::AIR || blocks::is_water(state) || blocks::is_lava(state)
}

impl Server {
    pub(super) fn schedule_falling_blocks(&mut self, [x, y, z]: [i32; 3], state: u16) {
        if blocks::info(state).falls
            && (y == MIN_Y || self.get_block(x, y - 1, z).is_some_and(is_open))
        {
            self.schedule_tick([x, y, z], FALL_DELAY);
        }
        if is_open(state)
            && self
                .get_block(x, y + 1, z)
                .is_some_and(|above| blocks::info(above).falls)
        {
            self.schedule_tick([x, y + 1, z], FALL_DELAY);
        }
    }

    pub(super) fn tick_falling_block(&mut self, [x, y, z]: [i32; 3], state: u16) {
        if y > MIN_Y {
            if !self.get_block(x, y - 1, z).is_some_and(is_open) {
                return;
            }
            // Fill the destination before clearing the source to avoid treating
            // the departing block as another unsupported block.
            let below = [x, y - 1, z];
            self.change_block_naturally(below, state);
            self.schedule_tick(below, FALL_DELAY);
        }
        self.change_block_naturally([x, y, z], blocks::AIR);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GameMode, Stack};
    use protocol::{C2S, S2C};
    use world::{items, Chunk};
    use worldgen::Generator;

    fn connected(mode: GameMode) -> Server {
        let mut server = Server::new(2026, Generator::Flat);
        server.set_game_mode(mode);
        server.connect(1);
        let client = server.clients.get_mut(&1).unwrap();
        client.joined = true;
        client.pos = [6.5, 80.0, 8.5];
        client.sent.insert((0, 0));
        server
    }

    fn setup(mode: GameMode) -> Server {
        let mut server = connected(mode);
        let mut chunk = Chunk::empty(0, 0);
        chunk.set(8, 79, 8, blocks::STONE).unwrap();
        server.world.insert_chunk(chunk);
        server
    }

    fn advance(server: &mut Server, ticks: i64) {
        for _ in 0..ticks {
            server.game_time += 1;
            server.tick_digs();
            server.tick_scheduled_blocks();
        }
    }

    fn put(server: &mut Server, y: i32, state: u16) {
        server.world.set_block(8, y, 8, state).unwrap();
    }

    fn at(server: &Server, y: i32) -> u16 {
        server.get_block(8, y, 8).unwrap()
    }

    fn edit(server: &mut Server, y: i32, state: u16) {
        server.apply(
            1,
            C2S::SetBlock {
                x: 8,
                y,
                z: 8,
                state,
            },
        );
    }

    fn dig(server: &mut Server, y: i32) {
        let (ticks, _) = items::mining(at(server, y), None).unwrap();
        server.apply(1, C2S::DigStart { x: 8, y, z: 8 });
        advance(server, i64::from(ticks));
        assert_eq!(at(server, y), blocks::AIR);
    }

    #[test]
    fn breaking_support_moves_sand_and_gravel_every_two_ticks_in_both_modes() {
        for mode in [GameMode::Creative, GameMode::Survival] {
            for state in [blocks::SAND, blocks::GRAVEL, blocks::STONE] {
                let mut server = setup(mode);
                put(&mut server, 82, blocks::DIRT);
                put(&mut server, 83, state);
                match mode {
                    GameMode::Creative => edit(&mut server, 82, blocks::AIR),
                    GameMode::Survival => dig(&mut server, 82),
                }
                if state == blocks::STONE {
                    advance(&mut server, 8);
                    assert_eq!(at(&server, 83), state);
                    assert_eq!(at(&server, 82), blocks::AIR);
                    continue;
                }

                server.clients.get_mut(&1).unwrap().pos = [8.5, 80.0, 8.5];
                server.take_outbox();
                for y in (81..=83).rev() {
                    advance(&mut server, 1);
                    assert_eq!(at(&server, y), state);
                    assert_eq!(at(&server, y - 1), blocks::AIR);
                    advance(&mut server, 1);
                    assert_eq!(at(&server, y), blocks::AIR);
                    assert_eq!(at(&server, y - 1), state);
                    assert_eq!(
                        server.take_outbox(),
                        [
                            (
                                1,
                                S2C::BlockUpdate {
                                    x: 8,
                                    y: y - 1,
                                    z: 8,
                                    state
                                }
                                .encode()
                            ),
                            (
                                1,
                                S2C::BlockUpdate {
                                    x: 8,
                                    y,
                                    z: 8,
                                    state: blocks::AIR
                                }
                                .encode()
                            ),
                        ]
                    );
                }
                advance(&mut server, 4);
                assert_eq!(at(&server, 80), state);
                assert_eq!(at(&server, 79), blocks::STONE);
                assert!(server.scheduled_blocks.is_empty());
                assert_eq!(
                    server.entities.len(),
                    usize::from(mode == GameMode::Survival)
                );
            }
        }
    }

    #[test]
    fn placing_sand_in_air_starts_a_fall_but_placing_it_on_stone_does_not() {
        for mode in [GameMode::Creative, GameMode::Survival] {
            let mut server = setup(mode);
            let sand = items::by_name("sand").unwrap();
            if mode == GameMode::Survival {
                server
                    .clients
                    .get_mut(&1)
                    .unwrap()
                    .inventory
                    .set(
                        0,
                        Some(Stack {
                            item: sand,
                            count: 2,
                            damage: 0,
                        }),
                    )
                    .unwrap();
            }

            edit(&mut server, 80, blocks::SAND);
            assert_eq!(at(&server, 80), blocks::SAND);
            assert!(server.scheduled_blocks.is_empty());
            edit(&mut server, 82, blocks::SAND);
            assert_eq!(at(&server, 82), blocks::SAND);
            advance(&mut server, 4);
            assert_eq!(at(&server, 80), blocks::SAND);
            assert_eq!(at(&server, 81), blocks::SAND);
            assert_eq!(at(&server, 82), blocks::AIR);
            assert!(server.entities.is_empty());

            if mode == GameMode::Survival {
                dig(&mut server, 81);
                assert_eq!(server.entities.len(), 1);
                assert_eq!(server.entities.values().next().unwrap().item, sand);
            }
        }
    }

    #[test]
    fn unsupported_stack_lands_in_order_and_is_repeatable() {
        let run = |stack: [u16; 3]| {
            let mut server = setup(GameMode::Creative);
            put(&mut server, 83, blocks::STONE);
            for (y, state) in (84..).zip(stack) {
                edit(&mut server, y, state);
            }
            edit(&mut server, 83, blocks::AIR);
            advance(&mut server, 2);
            assert_eq!(at(&server, 83), stack[0]);
            assert_eq!(at(&server, 84), blocks::AIR);
            assert_eq!(at(&server, 85), stack[1]);
            assert_eq!(at(&server, 86), stack[2]);
            advance(&mut server, 16);
            assert_eq!((80..=82).map(|y| at(&server, y)).collect::<Vec<_>>(), stack);
            assert!((83..=86).all(|y| at(&server, y) == blocks::AIR));
            assert!(server.scheduled_blocks.is_empty());
            server.state_hash()
        };
        let sand = [blocks::SAND; 3];
        assert_eq!(run(sand), run(sand));
        run([blocks::GRAVEL, blocks::SAND, blocks::SAND]);
    }

    #[test]
    fn sand_displaces_fluid_sources_and_flow_but_rests_on_other_blocks() {
        for fluid in [
            blocks::WATER,
            blocks::FLOWING_WATER,
            blocks::FALLING_WATER,
            blocks::LAVA,
            blocks::FLOWING_LAVA,
            blocks::FALLING_LAVA,
        ] {
            let mut server = setup(GameMode::Creative);
            server.change_block_naturally([8, 81, 8], fluid);
            edit(&mut server, 82, blocks::SAND);
            advance(&mut server, 2);
            assert_eq!(at(&server, 81), blocks::SAND);
            assert_eq!(at(&server, 82), blocks::AIR);
            assert_eq!(
                server.scheduled_blocks,
                [(4, [8, 81, 8])].into_iter().collect()
            );
            advance(&mut server, 40);
            assert_eq!(at(&server, 80), blocks::SAND);
            assert_eq!(at(&server, 81), blocks::AIR);
        }

        for support in [blocks::RED_FLOWER, blocks::TORCH, blocks::OAK_SLAB] {
            let mut server = setup(GameMode::Creative);
            put(&mut server, 80, support);
            edit(&mut server, 81, blocks::SAND);
            advance(&mut server, 8);
            assert_eq!(at(&server, 80), support);
            assert_eq!(at(&server, 81), blocks::SAND);
            assert!(server.scheduled_blocks.is_empty());
        }
    }

    #[test]
    fn falling_past_the_bottom_removes_the_block() {
        let mut server = setup(GameMode::Creative);
        server.change_block_naturally([8, MIN_Y + 1, 8], blocks::GRAVEL);
        advance(&mut server, 2);
        assert_eq!(at(&server, MIN_Y + 1), blocks::AIR);
        assert_eq!(at(&server, MIN_Y), blocks::GRAVEL);
        advance(&mut server, 2);
        assert_eq!(at(&server, MIN_Y), blocks::AIR);
        assert!(server.entities.is_empty());
        assert!(server.scheduled_blocks.is_empty());
    }

    #[test]
    fn generated_and_loaded_floating_sand_waits_for_an_edit_below() {
        let mut chunk = Chunk::empty(0, 0);
        chunk.set(8, 79, 8, blocks::STONE).unwrap();
        chunk.set(8, 82, 8, blocks::SAND).unwrap();
        let bytes = chunk.to_bytes();

        let mut generated = connected(GameMode::Creative);
        generated.set_external_generation(1);
        assert!(!generated.ensure_chunk((0, 0)));
        assert!(generated.deliver_generated(0, 0, &bytes));
        let mut loaded = connected(GameMode::Creative);
        assert!(loaded.load_chunk(0, 0, &bytes));

        for mut server in [generated, loaded] {
            advance(&mut server, 20);
            assert_eq!(at(&server, 82), blocks::SAND);
            assert_eq!(at(&server, 81), blocks::AIR);
            assert!(server.scheduled_blocks.is_empty());

            edit(&mut server, 81, blocks::STONE);
            edit(&mut server, 81, blocks::AIR);
            advance(&mut server, 2);
            assert_eq!(at(&server, 82), blocks::AIR);
            assert_eq!(at(&server, 81), blocks::SAND);
        }
    }

    #[test]
    fn saved_fall_resumes_at_the_same_tick() {
        let mut original = setup(GameMode::Creative);
        edit(&mut original, 84, blocks::GRAVEL);
        advance(&mut original, 3);
        assert_eq!(at(&original, 83), blocks::GRAVEL);
        let (cx, cz, bytes) = original.take_dirty().unwrap();

        let mut restored = connected(GameMode::Creative);
        restored.game_time = original.game_time;
        assert!(restored.load_chunk(cx, cz, &bytes));
        assert_eq!(restored.scheduled_blocks, original.scheduled_blocks);
        for y in (80..=82).rev() {
            advance(&mut original, 1);
            advance(&mut restored, 1);
            assert_eq!(at(&restored, y), blocks::GRAVEL);
            assert_eq!(restored.state_hash(), original.state_hash());
            advance(&mut original, 1);
            advance(&mut restored, 1);
        }
        advance(&mut original, 1);
        advance(&mut restored, 1);
        assert!(restored.scheduled_blocks.is_empty());
        assert_eq!(restored.state_hash(), original.state_hash());
    }

    #[test]
    fn falling_at_a_chunk_edge_waits_for_the_neighbor() {
        let mut server = setup(GameMode::Creative);
        server.change_block_naturally([15, 82, 8], blocks::SAND);
        advance(&mut server, 6);
        assert_eq!(server.get_block(15, 82, 8), Some(blocks::SAND));
        assert_eq!(server.scheduled_blocks.first(), Some(&(2, [15, 82, 8])));

        server.world.insert_chunk(Chunk::empty(1, 0));
        advance(&mut server, 1);
        assert_eq!(server.get_block(15, 82, 8), Some(blocks::AIR));
        assert_eq!(server.get_block(15, 81, 8), Some(blocks::SAND));
    }
}
