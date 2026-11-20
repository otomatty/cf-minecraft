use std::collections::{BTreeSet, VecDeque};

use jmath::{mix_stafford13, JavaRandom};
use world::{blocks, items, Fnv64, World, HEIGHT, MIN_Y};

use crate::{players_keep_chunk, GameMode, Server};

pub const RANDOM_TICKS_PER_SECTION: u32 = 3;
const LEAF_SUPPORT_DISTANCE: u8 = 6;

impl Server {
    fn random_tick_samples(&self) -> impl Iterator<Item = ([i32; 3], u64)> + '_ {
        // World stores loaded chunks in a BTreeMap keyed by (cx, cz).
        self.world
            .chunks
            .iter()
            .filter(move |&(&(cx, cz), _)| players_keep_chunk(&self.clients, cx, cz))
            .flat_map(move |(&(cx, cz), chunk)| {
                chunk
                    .sections
                    .iter()
                    .enumerate()
                    .filter(|(_, section)| !section.is_empty())
                    .flat_map(move |(section, _)| {
                        (0..RANDOM_TICKS_PER_SECTION).map(move |i| {
                            let mut hash = Fnv64::new();
                            hash.bytes(&self.seed.to_be_bytes());
                            hash.bytes(&self.game_time.to_be_bytes());
                            hash.bytes(&cx.to_be_bytes());
                            hash.bytes(&cz.to_be_bytes());
                            hash.bytes(&(section as u32).to_be_bytes());
                            hash.bytes(&i.to_be_bytes());
                            // Mix before using the low bits as spatial coordinates.
                            let h = mix_stafford13(hash.finish());
                            let x = (cx << 4) + (h & 15) as i32;
                            let y = MIN_Y + section as i32 * 16 + ((h >> 8) & 15) as i32;
                            let z = (cz << 4) + ((h >> 4) & 15) as i32;
                            ([x, y, z], h)
                        })
                    })
            })
    }

    pub(super) fn tick_random_blocks(&mut self) {
        let samples: Vec<_> = self.random_tick_samples().collect();
        for (pos, hash) in samples {
            self.random_tick_at(pos, hash);
        }
    }

    fn random_tick_at(&mut self, [x, y, z]: [i32; 3], hash: u64) {
        match self.world.get_block(x, y, z) {
            Some(blocks::GRASS_BLOCK) => self.tick_grass([x, y, z], hash),
            Some(blocks::OAK_LEAVES) if !leaf_has_support(&self.world, [x, y, z]) => {
                self.change_block_naturally([x, y, z], blocks::AIR);
                if self.game_mode == GameMode::Survival
                    && JavaRandom::new((hash >> 12) as i64).next_int_bound(10) == 0
                {
                    self.spawn_block_drop(items::by_name("apple").unwrap(), 1, [x, y, z], 0.5);
                }
            }
            Some(state) if blocks::is_farmland(state) => self.tick_farmland([x, y, z], state),
            Some(state) if blocks::is_wheat(state) => self.tick_wheat([x, y, z], state, hash),
            _ => {}
        }
    }

    fn tick_farmland(&mut self, [x, y, z]: [i32; 3], state: u16) {
        let above = self.world.get_block(x, y + 1, z);
        let next = if above.is_some_and(blocks::is_full_opaque_cube) {
            blocks::DIRT
        } else if (-4..=4).any(|dx| {
            (-4..=4).any(|dz| {
                (0..=1).any(|dy| {
                    self.world
                        .get_block(x + dx, y + dy, z + dz)
                        .is_some_and(blocks::is_water)
                })
            })
        }) {
            blocks::MOIST_FARMLAND
        } else if state == blocks::MOIST_FARMLAND {
            blocks::FARMLAND
        } else if !above.is_some_and(blocks::is_wheat) {
            blocks::DIRT
        } else {
            state
        };
        if next != state {
            self.change_block_naturally([x, y, z], next);
        }
    }

    fn tick_wheat(&mut self, [x, y, z]: [i32; 3], state: u16, hash: u64) {
        let below = self.world.get_block(x, y - 1, z).unwrap_or(blocks::AIR);
        if !blocks::is_farmland(below) {
            self.break_unsupported_wheat([x, y, z], state, false);
        } else if state < blocks::RIPE_WHEAT
            && (below == blocks::MOIST_FARMLAND
                || JavaRandom::new((hash >> 12) as i64).next_int_bound(3) == 0)
        {
            self.change_block_naturally([x, y, z], state + 1);
        }
    }

    pub(super) fn check_wheat_above(&mut self, [x, y, z]: [i32; 3], state: u16, exploded: bool) {
        if !blocks::is_farmland(state) {
            if let Some(wheat) = self
                .world
                .get_block(x, y + 1, z)
                .filter(|&s| blocks::is_wheat(s))
            {
                self.break_unsupported_wheat([x, y + 1, z], wheat, exploded);
            }
        }
    }

    fn break_unsupported_wheat(&mut self, pos: [i32; 3], state: u16, exploded: bool) {
        self.change_block_naturally_inner(pos, blocks::AIR, exploded);
        if self.game_mode == GameMode::Survival {
            self.spawn_mining_drops(pos, state, exploded);
        }
    }

    fn tick_grass(&mut self, [x, y, z]: [i32; 3], hash: u64) {
        if self
            .world
            .get_block(x, y + 1, z)
            .is_some_and(blocks::is_full_opaque_cube)
        {
            self.change_block_naturally([x, y, z], blocks::DIRT);
            return;
        }
        let mut random = JavaRandom::new((hash >> 12) as i64);
        for _ in 0..4 {
            let dx = random.next_int_bound(3) - 1;
            let dy = random.next_int_bound(5) - 3;
            let dz = random.next_int_bound(3) - 1;
            let [x, y, z] = [x + dx, y + dy, z + dz];
            if self.world.get_block(x, y, z) == Some(blocks::DIRT)
                && self.world.get_block(x, y + 1, z).is_some_and(|above| {
                    !blocks::is_water(above) && !blocks::is_full_opaque_cube(above)
                })
            {
                self.change_block_naturally([x, y, z], blocks::GRASS_BLOCK);
            }
        }
    }

    pub(super) fn change_block_naturally(&mut self, pos: [i32; 3], state: u16) {
        self.change_block_naturally_inner(pos, state, false);
    }

    fn change_block_naturally_inner(&mut self, [x, y, z]: [i32; 3], state: u16, exploded: bool) {
        if self
            .world
            .set_block(x, y, z, state)
            .is_some_and(|old| old != state)
        {
            self.abort_digs_at([x, y, z]);
            self.finish_block_change([x, y, z], state, exploded);
        }
    }
}

fn leaf_has_support(world: &World, start: [i32; 3]) -> bool {
    let mut queue = VecDeque::from([(start, 0)]);
    let mut seen = BTreeSet::from([start]);
    while let Some(([x, y, z], distance)) = queue.pop_front() {
        for pos @ [x, y, z] in [
            [x - 1, y, z],
            [x + 1, y, z],
            [x, y - 1, z],
            [x, y + 1, z],
            [x, y, z - 1],
            [x, y, z + 1],
        ] {
            if !(MIN_Y..MIN_Y + HEIGHT).contains(&y) || !seen.insert(pos) {
                continue;
            }
            let Some(state) = world.get_block(x, y, z) else {
                return true;
            };
            if blocks::info(state).name == "oak_log" {
                return true;
            }
            if distance + 1 < LEAF_SUPPORT_DISTANCE && blocks::is_oak_leaves(state) {
                queue.push_back((pos, distance + 1));
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Dig;
    use protocol::S2C;
    use world::Chunk;
    use worldgen::Generator;

    fn empty_world(seed: i64) -> Server {
        let mut server = Server::new(seed, Generator::Flat);
        server.world.insert_chunk(Chunk::empty(0, 0));
        server
    }

    fn put(server: &mut Server, [x, y, z]: [i32; 3], state: u16) {
        server.world.set_block(x, y, z, state).unwrap();
    }

    #[test]
    fn farmland_hydrates_from_both_heights_within_four_blocks_on_both_axes() {
        let pos = [8, 70, 8];
        for dy in [0, 1] {
            let mut server = empty_world(1);
            put(&mut server, pos, blocks::FARMLAND);
            put(&mut server, [12, 70 + dy, 4], blocks::WATER);
            server.random_tick_at(pos, 0);
            assert_eq!(server.get_block(8, 70, 8), Some(blocks::MOIST_FARMLAND));
            server.random_tick_at(pos, 0);
            assert_eq!(server.stats.blocks_changed, 1);
        }
    }

    #[test]
    fn flowing_water_and_falling_water_hydrate_farmland() {
        for water in [blocks::FLOWING_WATER + 6, blocks::FALLING_WATER] {
            let mut server = empty_world(1);
            let pos = [8, 70, 8];
            put(&mut server, pos, blocks::FARMLAND);
            put(&mut server, [12, 71, 4], water);
            server.random_tick_at(pos, 0);
            assert_eq!(server.get_block(8, 70, 8), Some(blocks::MOIST_FARMLAND));
        }
    }

    #[test]
    fn farmland_drains_then_reverts_unless_planted_and_opaque_cover_has_priority() {
        let pos = [15, 70, 8];
        let mut server = empty_world(1);
        assert_eq!(server.get_block(16, 70, 8), None);
        put(&mut server, pos, blocks::MOIST_FARMLAND);
        for water in [[10, 70, 8], [15, 69, 8], [15, 72, 8], [15, 70, 13]] {
            put(&mut server, water, blocks::WATER);
        }
        server.random_tick_at(pos, 0);
        assert_eq!(server.get_block(15, 70, 8), Some(blocks::FARMLAND));
        put(&mut server, [15, 71, 8], blocks::WHEAT);
        server.random_tick_at(pos, 0);
        assert_eq!(server.get_block(15, 70, 8), Some(blocks::FARMLAND));
        put(&mut server, [15, 71, 8], blocks::GLASS);
        server.random_tick_at(pos, 0);
        assert_eq!(server.get_block(15, 70, 8), Some(blocks::DIRT));

        put(&mut server, pos, blocks::MOIST_FARMLAND);
        put(&mut server, [15, 71, 8], blocks::STONE);
        put(&mut server, [14, 70, 8], blocks::WATER);
        server.random_tick_at(pos, 0);
        assert_eq!(server.get_block(15, 70, 8), Some(blocks::DIRT));
    }

    #[test]
    fn wheat_grows_each_moist_tick_and_stops_when_ripe() {
        let pos = [8, 71, 8];
        let mut server = empty_world(1);
        put(&mut server, [8, 70, 8], blocks::MOIST_FARMLAND);
        put(&mut server, pos, blocks::WHEAT);
        for next in blocks::WHEAT + 1..=blocks::RIPE_WHEAT {
            server.random_tick_at(pos, 0);
            assert_eq!(server.get_block(8, 71, 8), Some(next));
        }
        server.random_tick_at(pos, 0);
        assert_eq!(server.get_block(8, 71, 8), Some(blocks::RIPE_WHEAT));
        assert_eq!(server.stats.blocks_changed, 7);
    }

    #[test]
    fn dry_wheat_grows_only_on_reproducible_winning_rolls() {
        let pos = [8, 71, 8];
        let run = || {
            let mut server = empty_world(1);
            put(&mut server, [8, 70, 8], blocks::FARMLAND);
            (0..64)
                .map(|sample| {
                    put(&mut server, pos, blocks::WHEAT);
                    let hash = mix_stafford13(sample);
                    server.random_tick_at(pos, hash);
                    let grew = server.get_block(8, 71, 8) == Some(blocks::WHEAT + 1);
                    assert_eq!(
                        grew,
                        JavaRandom::new((hash >> 12) as i64).next_int_bound(3) == 0
                    );
                    grew
                })
                .collect::<Vec<_>>()
        };
        let rolls = run();
        assert_eq!(rolls, run());
        assert!(rolls.windows(2).any(|pair| pair == [false, true]));
    }

    #[test]
    fn wheat_without_farmland_breaks_on_random_tick_or_natural_support_change() {
        for mode in [GameMode::Survival, GameMode::Creative] {
            for support_changed in [false, true] {
                let mut server = empty_world(1);
                server.set_game_mode(mode);
                put(&mut server, [8, 71, 8], blocks::WHEAT);
                if support_changed {
                    put(&mut server, [8, 70, 8], blocks::FARMLAND);
                    server.change_block_naturally([8, 70, 8], blocks::MOIST_FARMLAND);
                    assert_eq!(server.get_block(8, 71, 8), Some(blocks::WHEAT));
                    server.change_block_naturally([8, 70, 8], blocks::DIRT);
                } else {
                    put(&mut server, [8, 70, 8], blocks::DIRT);
                    server.random_tick_at([8, 71, 8], 0);
                }
                assert_eq!(server.get_block(8, 71, 8), Some(blocks::AIR));
                assert_eq!(
                    server.entities.len(),
                    usize::from(mode == GameMode::Survival)
                );
                if let Some(entity) = server.entities.values().next() {
                    assert_eq!(Some(entity.item), items::by_name("wheat_seeds"));
                    assert_eq!(entity.count, 1);
                }
            }
        }
    }

    #[test]
    fn samples_are_ordered_and_repeat_after_loading_the_same_sections() {
        let build = |reverse| {
            let mut server = Server::new(-42, Generator::Flat);
            server.game_time = 137;
            server.connect(1);
            let client = server.clients.get_mut(&1).unwrap();
            client.view = 1;
            client.pos = [0.5, 0.0, 0.5];
            let mut coords = [(-1, 1), (0, 0), (0, 3), (1, -1), (4, 0)];
            if reverse {
                coords.reverse();
            }
            for (cx, cz) in coords {
                let mut chunk = Chunk::empty(cx, cz);
                if (cx, cz) != (1, -1) {
                    chunk.set(0, MIN_Y, 0, blocks::STONE);
                    chunk.set(0, MIN_Y + 32, 0, blocks::STONE);
                }
                assert!(server.load_chunk(cx, cz, &chunk.to_bytes()));
            }
            server
        };
        let server = build(false);
        let samples: Vec<_> = server.random_tick_samples().collect();
        assert_eq!(
            samples,
            build(true).random_tick_samples().collect::<Vec<_>>()
        );
        let sections: Vec<_> = samples
            .chunks(RANDOM_TICKS_PER_SECTION as usize)
            .map(|group| {
                let section = |[x, y, z]: [i32; 3]| (x >> 4, z >> 4, (y - MIN_Y) >> 4);
                let first = section(group[0].0);
                assert_eq!(group.len(), 3);
                assert!(group.iter().all(|(pos, _)| section(*pos) == first));
                first
            })
            .collect();
        assert_eq!(
            sections,
            [
                (-1, 1, 0),
                (-1, 1, 2),
                (0, 0, 0),
                (0, 0, 2),
                (0, 3, 0),
                (0, 3, 2)
            ]
        );
        let mut next = build(false);
        next.game_time += 1;
        assert_ne!(samples, next.random_tick_samples().collect::<Vec<_>>());
    }

    #[test]
    fn server_tick_applies_a_random_tick_to_the_selected_block() {
        let mut server = empty_world(1);
        server.connect(1);
        server.clients.get_mut(&1).unwrap().pos = [0.5, 0.0, 0.5];
        put(&mut server, [0, 64, 0], blocks::STONE);
        server.game_time = 1;
        let ([x, y, z], _) = server.random_tick_samples().next().unwrap();
        put(&mut server, [x, y, z], blocks::GRASS_BLOCK);
        put(&mut server, [x, y + 1, z], blocks::STONE);

        server.game_time = 0;
        server.tick();
        assert_eq!(server.game_time, 1);
        assert_eq!(server.get_block(x, y, z), Some(blocks::DIRT));
        assert_eq!(server.stats.blocks_changed, 1);
    }

    #[test]
    fn grass_under_a_full_opaque_cube_dies_and_interrupts_mining() {
        let mut server = empty_world(1);
        let pos = [8, 70, 8];
        server.connect(1);
        let client = server.clients.get_mut(&1).unwrap();
        client.sent.insert((0, 0));
        client.dig = Some(Dig {
            pos,
            state: blocks::GRASS_BLOCK,
            start: 0,
            ticks: 12,
            drops: true,
            stage: None,
        });
        let inventory = client.inventory.clone();
        put(&mut server, pos, blocks::GRASS_BLOCK);
        put(&mut server, [8, 71, 8], blocks::STONE);
        server.random_tick_at(pos, 0);
        assert_eq!(server.get_block(8, 70, 8), Some(blocks::DIRT));
        assert_eq!(server.stats.blocks_changed, 1);
        assert!(server.clients[&1].dig.is_none());
        assert_eq!(server.dig_updates[&(1, pos)], 255);
        assert_eq!(server.clients[&1].inventory, inventory);
        assert_eq!(
            server.take_outbox(),
            vec![(
                1,
                S2C::BlockUpdate {
                    x: 8,
                    y: 70,
                    z: 8,
                    state: blocks::DIRT
                }
                .encode()
            )]
        );
        assert!(server.world.chunks[&(0, 0)].dirty);
    }

    #[test]
    fn grass_spreads_only_to_dirt_with_a_clear_enough_cover() {
        let pos = [8, 70, 8];
        for cover in [
            blocks::AIR,
            blocks::GLASS,
            blocks::OAK_LEAVES,
            blocks::WATER,
        ] {
            let mut server = empty_world(1);
            put(&mut server, pos, blocks::GRASS_BLOCK);
            put(&mut server, [8, 71, 8], cover);
            for (target, state, above) in [
                ([9, 70, 8], blocks::DIRT, blocks::AIR),
                ([7, 70, 8], blocks::DIRT, blocks::GLASS),
                ([8, 70, 9], blocks::DIRT, blocks::STONE),
                ([8, 70, 7], blocks::DIRT, blocks::WATER),
                ([7, 70, 7], blocks::DIRT, blocks::FLOWING_WATER + 2),
                ([7, 70, 9], blocks::DIRT, blocks::FALLING_WATER),
                ([9, 70, 9], blocks::COARSE_DIRT, blocks::AIR),
            ] {
                put(&mut server, target, state);
                put(&mut server, [target[0], target[1] + 1, target[2]], above);
            }
            for i in 0..64 {
                server.random_tick_at(pos, mix_stafford13(i));
            }
            assert_eq!(server.get_block(8, 70, 8), Some(blocks::GRASS_BLOCK));
            assert_eq!(server.get_block(9, 70, 8), Some(blocks::GRASS_BLOCK));
            assert_eq!(server.get_block(7, 70, 8), Some(blocks::GRASS_BLOCK));
            assert_eq!(server.get_block(8, 70, 9), Some(blocks::DIRT));
            assert_eq!(server.get_block(8, 70, 7), Some(blocks::DIRT));
            assert_eq!(server.get_block(7, 70, 7), Some(blocks::DIRT));
            assert_eq!(server.get_block(7, 70, 9), Some(blocks::DIRT));
            assert_eq!(server.get_block(9, 70, 9), Some(blocks::COARSE_DIRT));
        }
    }

    #[test]
    fn leaves_count_the_log_step_and_can_use_placed_leaves_as_support() {
        let mut server = empty_world(1);
        let log_states = blocks::block(blocks::OAK_LOG).unwrap();
        for log in log_states.first..log_states.first + log_states.count {
            put(&mut server, [3, 70, 8], log);
            for x in 4..=10 {
                put(&mut server, [x, 70, 8], blocks::OAK_LEAVES);
            }
            put(&mut server, [5, 70, 8], blocks::PLACED_OAK_LEAVES);
            server.random_tick_at([9, 70, 8], 0);
            server.random_tick_at([10, 70, 8], 0);
            assert_eq!(server.get_block(9, 70, 8), Some(blocks::OAK_LEAVES));
            assert_eq!(server.get_block(10, 70, 8), Some(blocks::AIR));

            put(&mut server, [3, 70, 8], blocks::AIR);
            server.random_tick_at([9, 70, 8], 0);
            server.random_tick_at([5, 70, 8], 0);
            assert_eq!(server.get_block(9, 70, 8), Some(blocks::AIR));
            assert_eq!(server.get_block(5, 70, 8), Some(blocks::PLACED_OAK_LEAVES));
        }
    }

    #[test]
    fn unloaded_neighbor_protects_leaves_until_the_chunk_arrives() {
        let mut server = empty_world(1);
        put(&mut server, [14, 70, 8], blocks::OAK_LEAVES);
        put(&mut server, [15, 70, 8], blocks::PLACED_OAK_LEAVES);
        server.random_tick_at([14, 70, 8], 0);
        assert_eq!(server.get_block(14, 70, 8), Some(blocks::OAK_LEAVES));
        server.world.insert_chunk(Chunk::empty(1, 0));
        server.random_tick_at([14, 70, 8], 0);
        assert_eq!(server.get_block(14, 70, 8), Some(blocks::AIR));
    }

    #[test]
    fn decay_drops_only_apples_and_only_on_a_winning_survival_roll() {
        const WINNING_HASH: u64 = 0;
        const LOSING_HASH: u64 = 1 << 12;
        for (hash, mode, expected) in [
            (WINNING_HASH, GameMode::Survival, 1),
            (LOSING_HASH, GameMode::Survival, 0),
            (WINNING_HASH, GameMode::Creative, 0),
        ] {
            let mut server = empty_world(1);
            server.set_game_mode(mode);
            put(&mut server, [8, 70, 8], blocks::OAK_LEAVES);
            server.random_tick_at([8, 70, 8], hash);
            assert_eq!(server.get_block(8, 70, 8), Some(blocks::AIR));
            assert_eq!(server.entities.len(), expected);
            if let Some(drop) = server.entities.values().next() {
                assert_eq!(Some(drop.item), items::by_name("apple"));
                assert_eq!(drop.count, 1);
                assert_eq!(drop.pos, [8.5, 70.5, 8.5]);
                assert_eq!(drop.pickup_delay, 10);
            }
        }
    }

    #[test]
    fn decay_can_drop_apples_after_a_miss_without_other_item_spawns() {
        let run = || {
            let mut server = empty_world(1);
            server.set_game_mode(GameMode::Survival);
            let positions: Vec<_> = (0..40).map(|i| [8, 70 + 2 * i, 8]).collect();
            for &pos in &positions {
                put(&mut server, pos, blocks::OAK_LEAVES);
            }

            let mut rolls = Vec::new();
            for (i, &pos) in positions.iter().enumerate() {
                let before = server.entities.len();
                server.random_tick_at(pos, mix_stafford13(i as u64));
                let dropped = server.entities.len() - before;
                assert!(dropped <= 1);
                rolls.push(dropped == 1);
            }

            for [x, y, z] in positions {
                assert_eq!(server.get_block(x, y, z), Some(blocks::AIR));
            }
            assert!((1..40).contains(&server.entities.len()));
            assert!(rolls.windows(2).any(|pair| pair == [false, true]));
            let apple = items::by_name("apple").unwrap();
            assert!(server
                .entities
                .values()
                .all(|drop| drop.item == apple && drop.count == 1));
            rolls
        };
        assert_eq!(run(), run());
    }
}
