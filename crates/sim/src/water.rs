//! Scheduled water updates and bucket interactions.

use world::{blocks, items, HEIGHT, MIN_Y};

use crate::{inventory, players_keep_chunk, GameMode, Server, Stack};

pub(super) const WATER_FLOW_DELAY: i64 = 5;
const HORIZONTAL: [[i32; 3]; 4] = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const ABOVE: [i32; 3] = [0, 1, 0];
const BELOW: [i32; 3] = [0, -1, 0];

fn offset(pos: [i32; 3], delta: [i32; 3]) -> [i32; 3] {
    std::array::from_fn(|axis| pos[axis].wrapping_add(delta[axis]))
}

fn neighbors(pos: [i32; 3]) -> impl Iterator<Item = [i32; 3]> {
    [ABOVE, BELOW]
        .into_iter()
        .chain(HORIZONTAL)
        .map(move |delta| offset(pos, delta))
}

impl Server {
    pub(super) fn queue_scheduled_tick(&mut self, pos: [i32; 3], time: i64) -> bool {
        if let Some(&previous) = self.scheduled_block_times.get(&pos) {
            if previous <= time {
                return false;
            }
            self.scheduled_blocks.remove(&(previous, pos));
        }
        self.scheduled_block_times.insert(pos, time);
        self.scheduled_blocks.insert((time, pos));
        true
    }

    fn cancel_scheduled_tick(&mut self, pos: [i32; 3]) {
        if let Some(time) = self.scheduled_block_times.remove(&pos) {
            self.scheduled_blocks.remove(&(time, pos));
        }
    }

    pub fn schedule_tick(&mut self, pos: [i32; 3], delay: i64) {
        let [x, y, z] = pos;
        let chunk_pos = (x >> 4, z >> 4);
        if !(MIN_Y..MIN_Y + HEIGHT).contains(&y) || !self.world.chunks.contains_key(&chunk_pos) {
            return;
        }
        let time = self.game_time.saturating_add(delay.max(1));
        if self.queue_scheduled_tick(pos, time) {
            self.world.chunks.get_mut(&chunk_pos).unwrap().dirty = true;
        }
    }

    pub(super) fn schedule_water_neighbors(&mut self, pos: [i32; 3]) {
        self.cancel_scheduled_tick(pos);
        for p in std::iter::once(pos).chain(neighbors(pos)) {
            if self
                .get_block(p[0], p[1], p[2])
                .is_some_and(blocks::is_water)
            {
                self.schedule_tick(p, WATER_FLOW_DELAY);
            }
        }
    }

    pub(super) fn tick_scheduled_blocks(&mut self) {
        let loaded = |[x, _, z]: [i32; 3]| self.world.chunks.contains_key(&(x >> 4, z >> 4));
        let due: Vec<_> = self
            .scheduled_blocks
            .iter()
            .copied()
            .take_while(|(time, _)| *time <= self.game_time)
            .filter(|&(_, pos @ [x, _, z])| {
                players_keep_chunk(&self.clients, x >> 4, z >> 4)
                    && loaded(pos)
                    && neighbors(pos)
                        .filter(|[_, y, _]| (MIN_Y..MIN_Y + HEIGHT).contains(y))
                        .all(loaded)
            })
            .collect();
        for (time, pos @ [x, y, z]) in due {
            // A change earlier in this batch may have replaced a due tick.
            if self.scheduled_block_times.get(&pos) != Some(&time) {
                continue;
            }
            self.cancel_scheduled_tick(pos);
            if let Some(state) = self.get_block(x, y, z).filter(|&s| blocks::is_water(s)) {
                self.tick_water(pos, state);
            }
        }
    }

    fn tick_water(&mut self, pos: [i32; 3], state: u16) {
        let neighbor = |delta| {
            let [x, y, z] = offset(pos, delta);
            self.get_block(x, y, z)
        };
        let (Some(above), Some(below), [Some(north), Some(south), Some(west), Some(east)]) =
            (neighbor(ABOVE), neighbor(BELOW), HORIZONTAL.map(neighbor))
        else {
            return;
        };
        let horizontal = [north, south, west, east];
        if blocks::is_flowing_water(state) {
            let target = if blocks::is_water(above) {
                blocks::FALLING_WATER
            } else if horizontal.iter().filter(|&&s| s == blocks::WATER).count() >= 2
                && (below == blocks::WATER || blocks::info(below).solid)
            {
                blocks::WATER
            } else {
                horizontal
                    .into_iter()
                    .filter_map(next_flow_level)
                    .min()
                    .unwrap_or(blocks::AIR)
            };
            if target != state {
                self.change_block_naturally(pos, target);
                return;
            }
        }
        if pos[1] > MIN_Y
            && (below == blocks::AIR
                || (blocks::FLOWING_WATER..blocks::FALLING_WATER).contains(&below))
        {
            self.change_block_naturally(offset(pos, BELOW), blocks::FALLING_WATER);
            return;
        }
        if let Some(next) = next_flow_level(state) {
            for (delta, target) in HORIZONTAL.into_iter().zip(horizontal) {
                if target == blocks::AIR || (next + 1..blocks::FALLING_WATER).contains(&target) {
                    self.change_block_naturally(offset(pos, delta), next);
                }
            }
        }
    }

    pub(super) fn use_bucket(&mut self, id: u32, pos @ [x, y, z]: [i32; 3]) {
        let client = &self.clients[&id];
        let held = client.inventory.selected_stack();
        let bucket = items::by_name("bucket").expect("bucket item");
        let water_bucket = items::by_name("water_bucket").expect("water bucket item");
        let target = self.get_block(x, y, z);
        let allowed = client.joined
            && !client.health.vitals.dead
            && client.inventory.screen == inventory::Screen::None
            && (MIN_Y..MIN_Y + HEIGHT).contains(&y)
            && self.within_reach(client.pos, pos);
        let edit = match (held, target) {
            (Some(stack), Some(blocks::WATER)) if stack.item == bucket => {
                Some((blocks::AIR, water_bucket, stack.count))
            }
            (Some(stack), Some(state))
                if stack.item == water_bucket
                    && (state == blocks::AIR || blocks::is_flowing_water(state)) =>
            {
                Some((blocks::WATER, bucket, stack.count))
            }
            _ => None,
        };
        let Some((state, item, count)) = edit.filter(|_| allowed) else {
            self.stats.packets_rejected += 1;
            self.correct_block(id, x, y, z);
            return;
        };

        self.change_block_naturally(pos, state);
        if self.game_mode == GameMode::Survival {
            let client = self.clients.get_mut(&id).unwrap();
            client.inventory_dirty = true;
            if count == 1 {
                client
                    .inventory
                    .set(client.inventory.selected(), Some(Stack { item, count: 1 }))
                    .expect("bucket fits in the selected slot");
            } else {
                client.inventory.take_selected();
                if client.inventory.add(item, 1) != 0 {
                    let feet = client.pos;
                    self.spawn_item(item, 1, feet, [0.0, 0.1, 0.0], 10);
                }
            }
        }
    }
}

fn next_flow_level(state: u16) -> Option<u16> {
    match state {
        blocks::WATER | blocks::FALLING_WATER => Some(blocks::FLOWING_WATER),
        s if (blocks::FLOWING_WATER..blocks::FALLING_WATER - 1).contains(&s) => Some(s + 1),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::{C2S, S2C};
    use world::Chunk;
    use worldgen::Generator;

    const SOURCE: [i32; 3] = [8, 80, 8];
    const EAST_EDGE: [i32; 3] = [15, 80, 8];

    fn setup(mode: GameMode) -> Server {
        let mut server = Server::new(2026, Generator::Flat);
        server.set_game_mode(mode);
        server.connect(1);
        let client = server.clients.get_mut(&1).unwrap();
        client.joined = true;
        client.pos = [8.5, 80.0, 8.5];
        client.sent.insert((0, 0));
        let mut chunk = Chunk::empty(0, 0);
        for x in 0..16 {
            for z in 0..16 {
                chunk.set(x, 79, z, blocks::STONE);
            }
        }
        server.world.insert_chunk(chunk);
        server
    }

    fn advance(server: &mut Server, ticks: i64) {
        for _ in 0..ticks {
            server.game_time += 1;
            server.tick_scheduled_blocks();
        }
    }

    fn at(server: &Server, [x, y, z]: [i32; 3]) -> u16 {
        server.get_block(x, y, z).unwrap()
    }

    fn put(server: &mut Server, [x, y, z]: [i32; 3], state: u16) {
        server.world.set_block(x, y, z, state).unwrap();
    }

    #[test]
    fn scheduled_ticks_run_by_time_then_position_and_deduplicate() {
        let mut server = setup(GameMode::Creative);
        for (x, delay) in [(10, 2), (12, 1), (4, 2), (10, 2)] {
            let pos = [x, 82, 8];
            put(&mut server, pos, blocks::WATER);
            server.schedule_tick(pos, delay);
        }
        assert_eq!(server.scheduled_blocks.len(), 3);
        server.game_time = 2;
        server.tick_scheduled_blocks();
        let updates: Vec<_> = server
            .take_outbox()
            .iter()
            .filter_map(|(_, bytes)| match S2C::decode(bytes).unwrap() {
                S2C::BlockUpdate {
                    x,
                    y: 81,
                    z: 8,
                    state: blocks::FALLING_WATER,
                } => Some(x),
                _ => None,
            })
            .collect();
        assert_eq!(updates, [12, 4, 10]);
        assert!(server.scheduled_blocks.iter().all(|(time, _)| *time == 7));
    }

    #[test]
    fn out_of_range_ticks_remain_pending_and_execute_when_a_player_returns() {
        let mut server = setup(GameMode::Creative);
        let source = [8, 81, 8];
        put(&mut server, source, blocks::WATER);
        server.schedule_tick(source, 2);
        server.clients.get_mut(&1).unwrap().pos[0] = 4096.0;
        advance(&mut server, 10);
        assert_eq!(server.scheduled_blocks.first(), Some(&(2, source)));
        assert_eq!(at(&server, SOURCE), blocks::AIR);
        server.clients.get_mut(&1).unwrap().pos[0] = 8.5;
        advance(&mut server, 1);
        assert_eq!(at(&server, SOURCE), blocks::FALLING_WATER);
        assert!(!server.scheduled_blocks.contains(&(2, source)));
    }

    fn flow_fed_from_the_east() -> Server {
        let mut server = setup(GameMode::Creative);
        server.world.insert_chunk(Chunk::empty(1, 0));
        put(&mut server, [16, 80, 8], blocks::WATER);
        for delta in [[0, 0, -1], [0, 0, 1], [-1, 0, 0]] {
            put(&mut server, offset(EAST_EDGE, delta), blocks::STONE);
        }
        put(&mut server, EAST_EDGE, blocks::FLOWING_WATER);
        server.schedule_tick(EAST_EDGE, WATER_FLOW_DELAY);
        server
    }

    #[test]
    fn boundary_flow_keeps_its_tick_until_the_only_source_is_loaded() {
        let mut server = flow_fed_from_the_east();
        let east = server.world.remove_chunk(1, 0).unwrap();

        advance(&mut server, 2 * WATER_FLOW_DELAY);
        assert_eq!(at(&server, EAST_EDGE), blocks::FLOWING_WATER);
        assert_eq!(
            server.scheduled_blocks.first(),
            Some(&(WATER_FLOW_DELAY, EAST_EDGE))
        );
        assert_eq!(server.scheduled_blocks.len(), 1);

        server.world.insert_chunk(east);
        advance(&mut server, 1);
        assert_eq!(at(&server, EAST_EDGE), blocks::FLOWING_WATER);
        assert!(server.scheduled_blocks.is_empty());
        assert!(server.scheduled_block_times.is_empty());
    }

    #[test]
    fn boundary_source_keeps_its_tick_until_it_can_spread_into_the_next_chunk() {
        let mut server = setup(GameMode::Creative);
        put(&mut server, EAST_EDGE, blocks::WATER);
        server.schedule_tick(EAST_EDGE, WATER_FLOW_DELAY);
        advance(&mut server, 2 * WATER_FLOW_DELAY);
        assert_eq!(
            server.scheduled_blocks,
            [(WATER_FLOW_DELAY, EAST_EDGE)].into_iter().collect()
        );
        assert_eq!(at(&server, [14, 80, 8]), blocks::AIR);

        server.world.insert_chunk(Chunk::empty(1, 0));
        advance(&mut server, 1);
        assert_eq!(at(&server, [16, 80, 8]), blocks::FLOWING_WATER);
        assert_eq!(at(&server, [14, 80, 8]), blocks::FLOWING_WATER);
        assert!(!server
            .scheduled_blocks
            .contains(&(WATER_FLOW_DELAY, EAST_EDGE)));
    }

    #[test]
    fn saved_boundary_flow_waits_when_its_chunk_is_loaded_before_its_source() {
        let mut server = flow_fed_from_the_east();
        let (cx, cz, flow_bytes) = server.take_dirty().unwrap();
        let (east_cx, east_cz, source_bytes) = server.take_dirty().unwrap();
        assert_eq!((cx, cz), (0, 0));
        assert_eq!((east_cx, east_cz), (1, 0));

        server.clients.clear();
        server.unload_far_chunks();
        assert!(server.scheduled_blocks.is_empty());
        assert!(server.scheduled_block_times.is_empty());
        server.connect(1);
        server.clients.get_mut(&1).unwrap().pos = [8.5, 80.0, 8.5];
        assert!(server.load_chunk(cx, cz, &flow_bytes));
        advance(&mut server, 2 * WATER_FLOW_DELAY);
        assert_eq!(at(&server, EAST_EDGE), blocks::FLOWING_WATER);
        assert_eq!(
            server.scheduled_blocks.first(),
            Some(&(WATER_FLOW_DELAY, EAST_EDGE))
        );
        assert!(server.take_dirty().is_none());

        assert!(server.load_chunk(east_cx, east_cz, &source_bytes));
        advance(&mut server, 1);
        assert_eq!(at(&server, EAST_EDGE), blocks::FLOWING_WATER);
        assert!(server.scheduled_blocks.is_empty());
        assert!(server.scheduled_block_times.is_empty());
        assert!(server.take_dirty().is_none());
    }

    #[test]
    fn repeated_neighbor_edits_keep_the_first_deadline() {
        let mut server = setup(GameMode::Creative);
        put(&mut server, SOURCE, blocks::WATER);
        let neighbor = offset(SOURCE, HORIZONTAL[0]);
        server.change_block_naturally(neighbor, blocks::STONE);
        advance(&mut server, 1);
        server.change_block_naturally(neighbor, blocks::AIR);

        assert_eq!(
            server.scheduled_blocks,
            [(WATER_FLOW_DELAY, SOURCE)].into_iter().collect()
        );
        assert_eq!(
            server.scheduled_block_times.get(&SOURCE),
            Some(&WATER_FLOW_DELAY)
        );
        advance(&mut server, WATER_FLOW_DELAY - 2);
        assert_eq!(at(&server, neighbor), blocks::AIR);
        advance(&mut server, 1);
        assert_eq!(at(&server, neighbor), blocks::FLOWING_WATER);
    }

    #[test]
    fn a_water_state_change_supersedes_an_old_tick_and_waits_five_more_ticks() {
        let mut server = setup(GameMode::Creative);
        put(&mut server, offset(SOURCE, ABOVE), blocks::WATER);
        put(&mut server, SOURCE, blocks::FLOWING_WATER);
        server.schedule_tick(SOURCE, WATER_FLOW_DELAY + 1);
        server.schedule_tick(SOURCE, WATER_FLOW_DELAY);
        assert_eq!(
            server.scheduled_blocks,
            [(WATER_FLOW_DELAY, SOURCE)].into_iter().collect()
        );

        let neighbor = offset(SOURCE, HORIZONTAL[0]);
        advance(&mut server, WATER_FLOW_DELAY);
        assert_eq!(at(&server, SOURCE), blocks::FALLING_WATER);
        assert_eq!(
            server.scheduled_block_times.get(&SOURCE),
            Some(&(2 * WATER_FLOW_DELAY))
        );
        advance(&mut server, WATER_FLOW_DELAY - 1);
        assert_eq!(at(&server, neighbor), blocks::AIR);
        advance(&mut server, 1);
        assert_eq!(at(&server, neighbor), blocks::FLOWING_WATER);
    }

    #[test]
    fn a_tick_replaced_during_the_same_batch_waits_for_its_new_deadline() {
        let mut server = setup(GameMode::Creative);
        let source = [8, 80, 7];
        put(&mut server, source, blocks::WATER);
        put(&mut server, SOURCE, blocks::FLOWING_WATER + 1);
        server.schedule_tick(source, WATER_FLOW_DELAY);
        server.schedule_tick(SOURCE, WATER_FLOW_DELAY);

        advance(&mut server, WATER_FLOW_DELAY);
        assert_eq!(at(&server, SOURCE), blocks::FLOWING_WATER);
        let neighbor = [8, 80, 9];
        assert_eq!(at(&server, neighbor), blocks::AIR);
        assert_eq!(
            server.scheduled_block_times.get(&SOURCE),
            Some(&(2 * WATER_FLOW_DELAY))
        );
        advance(&mut server, WATER_FLOW_DELAY - 1);
        assert_eq!(at(&server, neighbor), blocks::AIR);
        advance(&mut server, 1);
        assert_eq!(at(&server, neighbor), blocks::FLOWING_WATER + 1);
    }

    #[test]
    fn loading_legacy_duplicate_positions_keeps_the_earliest_tick() {
        let mut server = setup(GameMode::Creative);
        let mut saved = world::io::Writer::new();
        saved.raw(&server.world.remove_chunk(0, 0).unwrap().to_bytes());
        saved.varint(0); // Furnaces.
        saved.varint(3);
        for delay in [9, 2, 7] {
            saved.u8(SOURCE[0] as u8);
            saved.i32(SOURCE[1]);
            saved.u8(SOURCE[2] as u8);
            saved.u16(delay);
        }
        server.game_time = 10;
        assert!(server.load_chunk(0, 0, &saved.finish()));
        assert_eq!(
            server.scheduled_blocks,
            [(12, SOURCE)].into_iter().collect()
        );
        assert_eq!(server.scheduled_block_times.get(&SOURCE), Some(&12));
        assert!(server.take_dirty().is_none());
    }

    #[test]
    fn scheduled_ticks_save_delays_change_the_hash_and_leave_with_the_chunk() {
        let mut server = setup(GameMode::Creative);
        let old = server.state_hash();
        server.schedule_tick(SOURCE, 9);
        server.schedule_tick([0, 80, 15], i64::MAX);
        server.schedule_tick([14, 80, 1], 0);
        assert_ne!(server.state_hash(), old);
        server.game_time = 2;
        let (cx, cz, bytes) = server.take_dirty().unwrap();
        server.clients.clear();
        server.unload_far_chunks();
        assert!(server.scheduled_blocks.is_empty());
        server.game_time = 100;
        assert!(server.load_chunk(cx, cz, &bytes));
        assert_eq!(
            server.scheduled_blocks,
            [(100, [14, 80, 1]), (107, SOURCE), (65_635, [0, 80, 15]),]
                .into_iter()
                .collect()
        );
        assert_eq!(server.dirty_chunks(), 0);
        server.connect(1);
        server.clients.get_mut(&1).unwrap().pos = [8.5, 80.0, 8.5];
        advance(&mut server, 1);
        assert!(!server.scheduled_blocks.contains(&(100, [14, 80, 1])));
        assert_eq!(server.dirty_chunks(), 0);
    }

    #[test]
    fn saved_tick_tail_checks_coordinates_count_and_exact_length() {
        let mut server = setup(GameMode::Creative);
        let prefix = server.world.chunks[&(0, 0)].to_bytes();
        assert!(Server::read_saved_chunk(0, 0, &prefix)
            .unwrap()
            .scheduled_blocks
            .is_empty());
        server.schedule_tick(SOURCE, 5);
        let (_, _, bytes) = server.take_dirty().unwrap();
        let new_tail = prefix.len() + 1;
        for end in new_tail + 1..bytes.len() {
            assert!(Server::read_saved_chunk(0, 0, &bytes[..end]).is_err());
        }
        for (offset, value) in [(0, 2), (1, 16), (2, 0xff), (6, 16)] {
            let mut bad = bytes.clone();
            bad[new_tail + offset] = value;
            assert!(Server::read_saved_chunk(0, 0, &bad).is_err());
        }
        let mut bad = bytes;
        bad.push(0);
        assert!(Server::read_saved_chunk(0, 0, &bad).is_err());
    }

    #[test]
    fn dry_stone_placement_and_break_at_a_chunk_boundary_dirty_only_the_edited_chunk() {
        let mut server = setup(GameMode::Creative);
        server.world.insert_chunk(Chunk::empty(1, 0));
        let [x, y, z] = [15, 80, 8];
        assert_eq!(server.dirty_chunks(), 0);
        for state in [blocks::STONE, blocks::AIR] {
            server.apply(1, C2S::SetBlock { x, y, z, state });
            assert_eq!(server.get_block(x, y, z), Some(state));
            assert!(server.scheduled_blocks.is_empty());
            let (cx, cz, _) = server.take_dirty().unwrap();
            assert_eq!((cx, cz), (0, 0));
            assert!(server.take_dirty().is_none());
        }
    }

    #[test]
    fn breaking_stone_next_to_water_schedules_only_the_source_and_opens_a_flow() {
        let mut server = setup(GameMode::Creative);
        put(&mut server, SOURCE, blocks::WATER);
        let [x, y, z] = offset(SOURCE, BELOW);
        server.apply(
            1,
            C2S::SetBlock {
                x,
                y,
                z,
                state: blocks::AIR,
            },
        );
        assert_eq!(
            server.scheduled_blocks,
            [(WATER_FLOW_DELAY, SOURCE)].into_iter().collect()
        );
        advance(&mut server, WATER_FLOW_DELAY - 1);
        assert_eq!(server.get_block(x, y, z), Some(blocks::AIR));
        advance(&mut server, 1);
        assert_eq!(server.get_block(x, y, z), Some(blocks::FALLING_WATER));
    }

    #[test]
    fn consuming_a_saved_tick_for_still_water_keeps_the_chunk_clean() {
        let mut server = setup(GameMode::Creative);
        for delta in HORIZONTAL {
            put(&mut server, offset(SOURCE, delta), blocks::STONE);
        }
        server.change_block_naturally(SOURCE, blocks::WATER);
        let (cx, cz, bytes) = server.take_dirty().unwrap();
        advance(&mut server, WATER_FLOW_DELAY);
        assert!(server.scheduled_blocks.is_empty());
        assert_eq!(server.dirty_chunks(), 0);

        server.clients.clear();
        server.unload_far_chunks();
        assert!(server.load_chunk(cx, cz, &bytes));
        assert_eq!(server.scheduled_blocks.len(), 1);
        server.connect(1);
        server.clients.get_mut(&1).unwrap().pos = [8.5, 80.0, 8.5];
        advance(&mut server, WATER_FLOW_DELAY);
        assert!(server.scheduled_blocks.is_empty());
        assert_eq!(server.dirty_chunks(), 0);
        assert_eq!(at(&server, SOURCE), blocks::WATER);
        assert_eq!(server.stats.blocks_changed, 1);
    }

    #[test]
    fn water_spreads_one_level_every_five_ticks_then_drains_without_a_source() {
        let mut server = setup(GameMode::Creative);
        // The last level reaches the east and south edges of the fixture.
        for (cx, cz) in [(1, 0), (0, 1)] {
            server.world.insert_chunk(Chunk::empty(cx, cz));
        }
        server.change_block_naturally(SOURCE, blocks::WATER);
        for level in 1..=7 {
            let pos = [8 - level, 80, 8];
            advance(&mut server, 4);
            assert_eq!(at(&server, pos), blocks::AIR);
            advance(&mut server, 1);
            assert_eq!(at(&server, pos), blocks::FLOWING_WATER + level as u16 - 1);
        }
        advance(&mut server, 5);
        assert_eq!(at(&server, [0, 80, 8]), blocks::AIR);
        assert!(server.scheduled_blocks.is_empty());
        hold(&mut server, "bucket", 1);
        server.use_bucket(1, SOURCE);
        assert_eq!(at(&server, SOURCE), blocks::AIR);
        assert_eq!(
            server.scheduled_blocks,
            HORIZONTAL
                .map(|delta| (server.game_time + WATER_FLOW_DELAY, offset(SOURCE, delta)))
                .into_iter()
                .collect()
        );
        advance(&mut server, 5);
        assert_ne!(at(&server, [7, 80, 8]), blocks::FLOWING_WATER);
        assert!(blocks::is_water(at(&server, [7, 80, 8])));
        advance(&mut server, 60);
        for x in 0..16 {
            for z in 0..16 {
                assert_eq!(at(&server, [x, 80, z]), blocks::AIR, "{x}, {z}");
            }
        }
    }

    #[test]
    fn water_falls_before_spreading_and_respects_plants_slabs_and_glass() {
        let mut server = setup(GameMode::Creative);
        for (pos, state) in [
            ([8, 80, 7], blocks::RED_FLOWER),
            ([8, 80, 9], blocks::OAK_SLAB),
            ([7, 80, 8], blocks::GLASS),
        ] {
            put(&mut server, pos, state);
        }
        server.change_block_naturally([8, 82, 8], blocks::WATER);
        advance(&mut server, 5);
        assert_eq!(at(&server, [8, 81, 8]), blocks::FALLING_WATER);
        assert_eq!(at(&server, [9, 82, 8]), blocks::AIR);
        advance(&mut server, 5);
        assert_eq!(at(&server, SOURCE), blocks::FALLING_WATER);
        assert_eq!(at(&server, [9, 81, 8]), blocks::AIR);
        advance(&mut server, 5);
        assert_eq!(at(&server, [9, 80, 8]), blocks::FLOWING_WATER);
        assert_eq!(at(&server, [8, 80, 7]), blocks::RED_FLOWER);
        assert_eq!(at(&server, [8, 80, 9]), blocks::OAK_SLAB);
        assert_eq!(at(&server, [7, 80, 8]), blocks::GLASS);
    }

    #[test]
    fn two_sources_replenish_flow_on_solid_support_or_another_source() {
        for (support, expected) in [
            (blocks::STONE, blocks::WATER),
            (blocks::WATER, blocks::WATER),
            (blocks::SHORT_GRASS, blocks::FLOWING_WATER),
        ] {
            let mut server = setup(GameMode::Creative);
            put(&mut server, [8, 79, 8], support);
            server.change_block_naturally([7, 80, 8], blocks::WATER);
            server.change_block_naturally([9, 80, 8], blocks::WATER);
            advance(&mut server, 5);
            assert_eq!(at(&server, SOURCE), blocks::FLOWING_WATER);
            advance(&mut server, 5);
            assert_eq!(at(&server, SOURCE), expected);
        }
    }

    #[test]
    fn generated_water_is_idle_until_a_block_changes_next_to_it() {
        let mut server = Server::new(2026, Generator::Terrain);
        server.connect(1);
        let terrain = server.terrain.as_ref().unwrap();
        let (x, z) = (-512..=512)
            .step_by(16)
            .flat_map(|x| (-512..=512).step_by(16).map(move |z| (x, z)))
            .find(|&(x, z)| {
                terrain.surface_y(x, z) < worldgen::SEA_LEVEL
                    && !world::biomes::BIOMES[terrain.biome_at(x, z) as usize].freeze
            })
            .expect("expected a generated sea column");
        let source = [x, worldgen::SEA_LEVEL, z];
        let below = offset(source, BELOW);
        for p in std::iter::once(source).chain(neighbors(source)) {
            server.generate_now(p[0] >> 4, p[2] >> 4);
        }
        assert_eq!(at(&server, source), blocks::WATER);
        assert!(server.scheduled_blocks.is_empty());
        server.clients.get_mut(&1).unwrap().pos = source.map(|v| f64::from(v) + 0.5);
        advance(&mut server, 20);
        assert_eq!(server.stats.blocks_changed, 0);
        assert!(server.scheduled_blocks.is_empty());
        server.change_block_naturally(below, blocks::AIR);
        assert!(server.scheduled_blocks.contains(&(25, source)));
        advance(&mut server, WATER_FLOW_DELAY);
        assert_eq!(at(&server, below), blocks::FALLING_WATER);
    }

    fn stack(name: &str, count: u8) -> Stack {
        Stack {
            item: items::by_name(name).unwrap(),
            count,
        }
    }

    fn hold(server: &mut Server, name: &str, count: u8) {
        server
            .clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(0, Some(stack(name, count)))
            .unwrap();
    }

    fn use_at(server: &mut Server, [x, y, z]: [i32; 3]) {
        server.handle_packet(1, &C2S::UseBucket { x, y, z }.encode());
        server.tick();
    }

    #[test]
    fn survival_buckets_replace_single_stacks_or_add_or_drop_the_filled_bucket() {
        for (count, full) in [(1, false), (2, false), (2, true)] {
            let mut server = setup(GameMode::Survival);
            if full {
                for slot in 1..inventory::SLOT_COUNT as u8 {
                    server
                        .clients
                        .get_mut(&1)
                        .unwrap()
                        .inventory
                        .set(slot, Some(stack("stone", 64)))
                        .unwrap();
                }
            }
            hold(&mut server, "bucket", count);
            put(&mut server, SOURCE, blocks::WATER);
            use_at(&mut server, SOURCE);
            assert_eq!(at(&server, SOURCE), blocks::AIR);
            assert!(server.scheduled_blocks.is_empty());
            let inv = &server.clients[&1].inventory;
            let filled = stack("water_bucket", 1);
            if count == 1 {
                assert_eq!(inv.selected_stack(), Some(filled));
                use_at(&mut server, SOURCE);
                assert_eq!(at(&server, SOURCE), blocks::WATER);
                assert_eq!(
                    server.clients[&1].inventory.selected_stack(),
                    Some(stack("bucket", 1))
                );
            } else {
                assert_eq!(inv.selected_stack(), Some(stack("bucket", count - 1)));
                assert_eq!(inv.slots().contains(&Some(filled)), !full);
                assert_eq!(
                    server
                        .entities
                        .values()
                        .any(|e| e.item == filled.item && e.count == 1),
                    full
                );
            }
        }
    }

    #[test]
    fn bucket_rejections_correct_visible_targets() {
        for reason in ["flow", "source", "distance", "screen", "dead", "wrong_item"] {
            let mut server = setup(GameMode::Survival);
            let [x, y, z] = SOURCE;
            let state = if reason == "flow" {
                blocks::FLOWING_WATER
            } else {
                blocks::WATER
            };
            put(&mut server, SOURCE, state);
            let item = match reason {
                "wrong_item" => "stone",
                "source" => "water_bucket",
                _ => "bucket",
            };
            hold(&mut server, item, 1);
            let client = server.clients.get_mut(&1).unwrap();
            match reason {
                "distance" => client.pos[0] = 0.0,
                "screen" => {
                    client.inventory.screen = inventory::Screen::CraftingTable { pos: SOURCE }
                }
                "dead" => {
                    client.health.vitals.dead = true;
                    client.health.vitals.health = 0;
                }
                _ => {}
            }
            use_at(&mut server, SOURCE);
            assert_eq!(server.stats.packets_rejected, 1, "{reason}");
            assert_eq!(at(&server, SOURCE), state);
            assert_eq!(
                server.clients[&1].inventory.selected_stack(),
                Some(stack(item, 1))
            );
            assert!(
                server.take_outbox().iter().any(|(_, packet)| {
                    S2C::decode(packet) == Ok(S2C::BlockUpdate { x, y, z, state })
                }),
                "{reason}"
            );
        }
    }

    #[test]
    fn creative_bucket_can_replace_flow_and_keeps_its_contents_on_both_actions() {
        let mut server = setup(GameMode::Creative);
        put(&mut server, SOURCE, blocks::FALLING_WATER);
        for (item, expected) in [("water_bucket", blocks::WATER), ("bucket", blocks::AIR)] {
            hold(&mut server, item, 1);
            use_at(&mut server, SOURCE);
            assert_eq!(at(&server, SOURCE), expected);
            assert_eq!(
                server.clients[&1].inventory.selected_stack(),
                Some(stack(item, 1))
            );
        }
    }

    #[test]
    fn three_iron_ingots_in_a_v_craft_one_bucket() {
        let iron = Some(stack("iron_ingot", 1));
        let grid = [iron, None, iron, None, iron, None, None, None, None];
        let recipe = inventory::matching_recipe(&grid, 3, 3, world::recipes::RECIPES).unwrap();
        assert_eq!(recipe.item, stack("bucket", 1).item);
        assert_eq!(recipe.count, 1);
    }
}
