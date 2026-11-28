//! Beds: paired halves, sleeping, and a respawn point.
use protocol::{MobKind, S2C};
use world::{blocks, HEIGHT, MIN_Y};

use crate::{GameMode, Server};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct BedRest {
    pub foot: [i32; 3],
    pub origin: [f64; 3],
}

/// Quadrants match stair placement: 0 south, 90 west, 180 north, 270 east.
fn facing_from_yaw(yaw: f32) -> usize {
    let normalized = yaw.rem_euclid(360.0);
    let quadrant = ((normalized + 45.0) / 90.0).floor() as i32;
    [1usize, 2, 0, 3][quadrant.rem_euclid(4) as usize]
}

fn bed_foot_of(pos: [i32; 3], state: u16) -> Option<[i32; 3]> {
    let (_, head) = blocks::bed_facing_part(state)?;
    if head {
        blocks::bed_partner(pos, state)
    } else {
        Some(pos)
    }
}

pub(crate) fn left_bed(client: &crate::Client, pos: [f64; 3]) -> bool {
    client.sleep.is_some_and(|rest| {
        let dx = pos[0] - rest.origin[0];
        let dy = pos[1] - rest.origin[1];
        let dz = pos[2] - rest.origin[2];
        dx * dx + dy * dy + dz * dz > 0.1 * 0.1
    })
}

impl Server {
    fn reject_place(&mut self, id: u32, [x, y, z]: [i32; 3]) {
        self.stats.packets_rejected += 1;
        self.correct_block(id, x, y, z);
    }

    fn bed_site(&self, id: u32, [x, y, z]: [i32; 3]) -> bool {
        let Some(player) = self.clients.get(&id).and_then(|client| {
            (client.joined
                && (MIN_Y..MIN_Y + HEIGHT).contains(&y)
                && client.sent.contains(&(x >> 4, z >> 4)))
            .then_some(client.pos)
        }) else {
            return false;
        };
        if !self.within_reach(player, [x, y, z]) {
            return false;
        }
        let Some(old) = self.world.get_block(x, y, z) else {
            return false;
        };
        let replaceable = matches!(old, blocks::AIR | blocks::SHORT_GRASS) || blocks::is_water(old);
        replaceable && self.world.has_full_face([x, y - 1, z], 1)
    }

    pub(crate) fn place_bed(&mut self, id: u32, pos: [i32; 3], state: u16) {
        let Some(yaw) = self.clients.get(&id).map(|client| client.yaw) else {
            return;
        };
        let Some((facing, head)) = blocks::bed_facing_part(state) else {
            self.reject_place(id, pos);
            return;
        };
        if head || facing != facing_from_yaw(yaw) {
            self.reject_place(id, pos);
            return;
        }
        let [dx, _, dz] = blocks::bed_delta(facing);
        let head_pos = [pos[0] + dx, pos[1], pos[2] + dz];
        if !self.bed_site(id, pos) || !self.bed_site(id, head_pos) {
            self.reject_place(id, pos);
            return;
        }
        let foot_state = blocks::bed_state(facing, false);
        let head_state = blocks::bed_state(facing, true);
        self.edit_block(id, pos, foot_state, false, false, false);
        self.edit_block(id, head_pos, head_state, false, false, false);
        if self.game_mode == GameMode::Survival {
            let client = self.clients.get_mut(&id).unwrap();
            client.inventory.take_selected();
            client.inventory_dirty = true;
        }
    }

    pub(crate) fn on_bed_removed(&mut self, pos: [i32; 3], old: u16, exploded: bool) {
        let Some(foot) = bed_foot_of(pos, old) else {
            return;
        };
        self.wake_foot(foot);
        let Some(partner) = blocks::bed_partner(pos, old) else {
            return;
        };
        if self.world.get_block(partner[0], partner[1], partner[2]) != Some(old ^ 1) {
            return;
        }
        if self
            .world
            .set_block(partner[0], partner[1], partner[2], blocks::AIR)
            .is_some()
        {
            self.abort_digs_at(partner);
            self.finish_block_change(partner, blocks::AIR, exploded);
        }
    }

    fn wake_foot(&mut self, foot: [i32; 3]) {
        let ids: Vec<u32> = self
            .clients
            .iter()
            .filter(|(_, client)| client.sleep.is_some_and(|rest| rest.foot == foot))
            .map(|(&id, _)| id)
            .collect();
        for id in ids {
            self.wake(id);
        }
    }

    pub(crate) fn wake(&mut self, id: u32) {
        let notify = {
            let Some(client) = self.clients.get_mut(&id) else {
                return;
            };
            let notify = client.sleep.take().is_some() || client.pending_wake;
            client.pending_wake = false;
            notify
        };
        if notify {
            self.outbox
                .push((id, S2C::Sleeping { sleeping: false }.encode()));
        }
    }

    pub(crate) fn flush_pending_wakes(&mut self) {
        let ids: Vec<u32> = self
            .clients
            .iter()
            .filter(|(_, client)| client.pending_wake)
            .map(|(&id, _)| id)
            .collect();
        for id in ids {
            self.wake(id);
        }
    }

    pub(crate) fn stop_sleeping(&mut self, id: u32) {
        if !self.clients.get(&id).is_some_and(|client| client.joined) {
            self.stats.packets_rejected += 1;
            return;
        }
        self.wake(id);
    }

    fn complete_foot(&self, pos: [i32; 3], state: u16) -> Option<[i32; 3]> {
        let _ = blocks::bed_facing_part(state)?;
        let foot = bed_foot_of(pos, state)?;
        let foot_state = self.world.get_block(foot[0], foot[1], foot[2])?;
        let (facing, head) = blocks::bed_facing_part(foot_state)?;
        if head {
            return None;
        }
        let head_pos = blocks::bed_partner(foot, foot_state)?;
        (self.world.get_block(head_pos[0], head_pos[1], head_pos[2])
            == Some(blocks::bed_state(facing, true)))
        .then_some(foot)
    }

    fn night(&self) -> bool {
        (13000..23000).contains(&self.day_time.rem_euclid(24000))
    }

    fn hostile_near(&self, foot: [i32; 3]) -> bool {
        let center_x = foot[0] as f64 + 0.5;
        let center_z = foot[2] as f64 + 0.5;
        let floor_y = foot[1] as f64;
        self.mobs.values().any(|mob| {
            matches!(
                mob.kind,
                MobKind::Zombie | MobKind::Skeleton | MobKind::Creeper
            ) && mob.health > 0
                && (mob.pos()[0] - center_x).abs() <= 8.0
                && (mob.pos()[2] - center_z).abs() <= 8.0
                && (mob.pos()[1] - floor_y).abs() <= 5.0
        })
    }

    fn bed_occupied(&self, id: u32, foot: [i32; 3]) -> bool {
        self.clients.iter().any(|(&other, client)| {
            other != id && client.sleep.is_some_and(|rest| rest.foot == foot)
        })
    }

    pub(crate) fn use_bed(&mut self, id: u32, pos: [i32; 3]) {
        let Some((allowed, sleeping, respawn, player)) = self.clients.get(&id).map(|client| {
            (
                client.joined
                    && !client.health.vitals.dead
                    && client.inventory.screen == crate::inventory::Screen::None,
                client.sleep.is_some(),
                client.respawn,
                client.pos,
            )
        }) else {
            return;
        };
        if !allowed || !self.within_reach(player, pos) {
            self.stats.packets_rejected += 1;
            return;
        }
        if sleeping {
            return;
        }
        let Some(state) = self.world.get_block(pos[0], pos[1], pos[2]) else {
            self.stats.packets_rejected += 1;
            return;
        };
        let Some(foot) = self.complete_foot(pos, state) else {
            self.stats.packets_rejected += 1;
            return;
        };
        if respawn != Some(foot) {
            self.clients.get_mut(&id).unwrap().respawn = Some(foot);
            self.reply(id, "リスポーン地点を設定しました");
        }
        if !self.night() {
            self.reply(id, "夜にならないと眠れません");
            return;
        }
        if self.hostile_near(foot) {
            self.reply(id, "近くに敵がいるので眠れません");
            return;
        }
        if self.bed_occupied(id, foot) {
            self.reply(id, "このベッドは使われています");
            return;
        }
        let origin = self.clients[&id].pos;
        self.clients.get_mut(&id).unwrap().sleep = Some(BedRest { foot, origin });
        self.outbox
            .push((id, S2C::Sleeping { sleeping: true }.encode()));
    }

    pub(crate) fn tick_sleep(&mut self) {
        self.wake_hurt();
        let living: Vec<u32> = self
            .clients
            .iter()
            .filter(|(_, client)| client.joined && !client.health.vitals.dead)
            .map(|(&id, _)| id)
            .collect();
        let all_asleep =
            !living.is_empty() && living.iter().all(|id| self.clients[id].sleep.is_some());
        if !all_asleep {
            self.sleep_ticks = 0;
            return;
        }
        self.sleep_ticks += 1;
        if self.sleep_ticks < 100 {
            return;
        }
        self.sleep_ticks = 0;
        self.day_time = (self.day_time.div_euclid(24000) + 1) * 24000;
        for id in living {
            self.wake(id);
        }
        let bytes = S2C::TimeUpdate {
            game_time: self.game_time,
            day_time: self.day_time,
        }
        .encode();
        let ids: Vec<u32> = self
            .clients
            .iter()
            .filter(|(_, client)| client.joined)
            .map(|(&id, _)| id)
            .collect();
        for id in ids {
            self.outbox.push((id, bytes.clone()));
        }
    }

    fn wake_hurt(&mut self) {
        let ids: Vec<u32> = self
            .clients
            .iter()
            .filter(|(_, client)| client.health.hurt)
            .map(|(&id, _)| id)
            .collect();
        for id in ids {
            self.clients.get_mut(&id).unwrap().health.hurt = false;
            self.wake(id);
        }
    }

    /// Spawn on the bed, or at the world spawn after clearing a missing point.
    /// A chunk still in storage or waiting on external generation cannot be
    /// inspected here, so that bed is treated as missing.
    pub(crate) fn resolve_respawn(&mut self, id: u32) -> [f64; 3] {
        let Some(foot) = self.clients[&id].respawn else {
            return self.spawn();
        };
        if self.bed_stand_pos(foot).is_none() {
            self.clients.get_mut(&id).unwrap().respawn = None;
            self.reply(id, "ベッドが無いか、ふさがれていました");
            return self.spawn();
        }
        self.bed_stand_pos(foot).unwrap()
    }

    fn bed_stand_pos(&mut self, foot: [i32; 3]) -> Option<[f64; 3]> {
        if !self.ensure_chunk((foot[0] >> 4, foot[2] >> 4)) {
            return None;
        }
        let state = self.world.get_block(foot[0], foot[1], foot[2])?;
        let (facing, head) = blocks::bed_facing_part(state)?;
        if head {
            return None;
        }
        let partner = blocks::bed_partner(foot, state)?;
        if !self.ensure_chunk((partner[0] >> 4, partner[2] >> 4)) {
            return None;
        }
        if self.world.get_block(partner[0], partner[1], partner[2])
            != Some(blocks::bed_state(facing, true))
        {
            return None;
        }
        let pos = [
            foot[0] as f64 + 0.5,
            foot[1] as f64 + 9.0 / 16.0,
            foot[2] as f64 + 0.5,
        ];
        let player = physics::Player::new(pos);
        let blocks = physics::BlockWorld(|x, y, z| self.world.get_block(x, y, z));
        player.is_clear(&blocks).then_some(pos)
    }
}

// Silence unused imports if a later edit drops them. ChatKind is used by tests.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Server, Stack};
    use protocol::{DeathCause, C2S, PROTOCOL_VERSION};
    use world::items;
    use worldgen::Generator;

    fn joined(mode: GameMode) -> (Server, [i32; 3]) {
        let mut server = Server::new(1, Generator::Flat);
        server.set_game_mode(mode);
        server.connect(1);
        server.handle_packet(
            1,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            }
            .encode(),
        );
        server.tick();
        let [x, y, z] = server.spawn();
        server.take_outbox();
        (
            server,
            [x.floor() as i32, y.floor() as i32, z.floor() as i32],
        )
    }

    fn hold_bed(server: &mut Server, count: u8) {
        let item = items::by_name("bed").unwrap();
        server
            .clients
            .get_mut(&1)
            .unwrap()
            .inventory
            .set(
                0,
                Some(Stack {
                    item,
                    count,
                    damage: 0,
                }),
            )
            .unwrap();
    }

    fn support(server: &mut Server, cells: [[i32; 3]; 2]) {
        for [x, y, z] in cells {
            server.world.set_block(x, y, z, blocks::AIR);
            server.world.set_block(x, y - 1, z, blocks::STONE);
        }
    }

    fn place(server: &mut Server, pos: [i32; 3], state: u16) {
        server.handle_packet(
            1,
            &C2S::SetBlock {
                x: pos[0],
                y: pos[1],
                z: pos[2],
                state,
            }
            .encode(),
        );
        server.tick();
    }

    fn use_at(server: &mut Server, id: u32, pos: [i32; 3]) {
        server.handle_packet(
            id,
            &C2S::UseBlock {
                x: pos[0],
                y: pos[1],
                z: pos[2],
            }
            .encode(),
        );
        server.tick();
    }

    fn texts(server: &mut Server) -> Vec<String> {
        server
            .take_outbox()
            .into_iter()
            .filter_map(|(_, bytes)| match S2C::decode(&bytes).ok()? {
                S2C::Chat { text, .. } => Some(text),
                _ => None,
            })
            .collect()
    }

    fn sleeping_flags(server: &mut Server) -> Vec<(u32, bool)> {
        server
            .take_outbox()
            .into_iter()
            .filter_map(|(id, bytes)| match S2C::decode(&bytes).ok()? {
                S2C::Sleeping { sleeping } => Some((id, sleeping)),
                _ => None,
            })
            .collect()
    }

    fn bed_count(server: &Server) -> u32 {
        let item = items::by_name("bed").unwrap();
        server
            .entities
            .values()
            .filter(|entity| entity.item == item)
            .map(|entity| u32::from(entity.count))
            .sum()
    }

    #[test]
    fn beds_face_the_player_and_reject_a_blocked_unsupported_or_unloaded_head() {
        let (mut server, [x, y, z]) = joined(GameMode::Survival);
        let foot = [x + 2, y, z];
        for (yaw, facing, dx, dz) in [
            (0.0, 1usize, 0, 1),
            (90.0, 2, -1, 0),
            (180.0, 0, 0, -1),
            (270.0, 3, 1, 0),
        ] {
            let head = [foot[0] + dx, foot[1], foot[2] + dz];
            support(&mut server, [foot, head]);
            hold_bed(&mut server, 1);
            server.clients.get_mut(&1).unwrap().yaw = yaw;
            place(&mut server, foot, blocks::bed_state(facing, false));
            assert_eq!(
                server.get_block(foot[0], foot[1], foot[2]),
                Some(blocks::bed_state(facing, false))
            );
            assert_eq!(
                server.get_block(head[0], head[1], head[2]),
                Some(blocks::bed_state(facing, true))
            );
            assert!(server.clients[&1].inventory.selected_stack().is_none());
            server.apply(
                1,
                C2S::DigStart {
                    x: foot[0],
                    y: foot[1],
                    z: foot[2],
                },
            );
            server.game_time += 10;
            server.tick_digs();
            assert_eq!(
                server.get_block(foot[0], foot[1], foot[2]),
                Some(blocks::AIR)
            );
            assert_eq!(
                server.get_block(head[0], head[1], head[2]),
                Some(blocks::AIR)
            );
        }

        let head = [foot[0], foot[1], foot[2] + 1];
        hold_bed(&mut server, 1);
        support(&mut server, [foot, head]);
        server
            .world
            .set_block(head[0], head[1], head[2], blocks::STONE);
        server.clients.get_mut(&1).unwrap().yaw = 0.0;
        let rejected = server.stats.packets_rejected;
        let count = server.clients[&1].inventory.selected_stack().unwrap().count;
        place(&mut server, foot, blocks::bed_state(1, false));
        assert!(server.stats.packets_rejected > rejected);
        assert_eq!(
            server.get_block(foot[0], foot[1], foot[2]),
            Some(blocks::AIR)
        );
        assert_eq!(
            server.clients[&1].inventory.selected_stack().unwrap().count,
            count
        );

        support(&mut server, [foot, head]);
        server
            .world
            .set_block(head[0], head[1] - 1, head[2], blocks::AIR);
        place(&mut server, foot, blocks::bed_state(1, false));
        assert_eq!(
            server.get_block(foot[0], foot[1], foot[2]),
            Some(blocks::AIR)
        );
        assert_eq!(
            server.get_block(head[0], head[1], head[2]),
            Some(blocks::AIR)
        );

        let border = (x >> 4 << 4) + 15;
        let edge = [border, y, z];
        let next = [border + 1, y, z];
        support(&mut server, [edge, next]);
        server.clients.get_mut(&1).unwrap().pos = [border as f64 - 0.5, y as f64, z as f64 + 0.5];
        server.clients.get_mut(&1).unwrap().yaw = 270.0;
        let chunk = (next[0] >> 4, next[2] >> 4);
        server.world.chunks.remove(&chunk);
        server.clients.get_mut(&1).unwrap().sent.remove(&chunk);
        place(&mut server, edge, blocks::bed_state(3, false));
        assert_eq!(
            server.get_block(edge[0], edge[1], edge[2]),
            Some(blocks::AIR)
        );

        support(&mut server, [foot, head]);
        server.clients.get_mut(&1).unwrap().pos = [x as f64 + 0.5, y as f64, z as f64 + 0.5];
        server.clients.get_mut(&1).unwrap().yaw = 0.0;
        place(&mut server, foot, blocks::bed_state(0, false));
        assert_eq!(
            server.get_block(foot[0], foot[1], foot[2]),
            Some(blocks::AIR)
        );
        place(&mut server, foot, blocks::bed_state(1, true));
        assert_eq!(
            server.get_block(foot[0], foot[1], foot[2]),
            Some(blocks::AIR)
        );
    }

    #[test]
    fn placement_rejects_a_head_overlapping_an_existing_bed() {
        let (mut server, [x, y, z]) = joined(GameMode::Survival);
        let x = x + 2;
        let new_foot = [x, y, z];
        let foot = [x, y, z + 1];
        let head = [x + 1, y, z + 1];
        let foot_state = blocks::bed_state(3, false);
        let head_state = blocks::bed_state(3, true);
        support(&mut server, [foot, head]);
        support(&mut server, [new_foot, foot]);
        hold_bed(&mut server, 1);
        server.clients.get_mut(&1).unwrap().yaw = 270.0;
        place(&mut server, foot, foot_state);
        assert!(server.clients[&1].inventory.selected_stack().is_none());
        server.take_outbox();

        hold_bed(&mut server, 1);
        server.clients.get_mut(&1).unwrap().yaw = 0.0;
        let rejected = server.stats.packets_rejected;
        place(&mut server, new_foot, blocks::bed_state(1, false));

        assert_eq!(server.stats.packets_rejected, rejected + 1);
        assert_eq!(server.get_block(x, y, z), Some(blocks::AIR));
        assert_eq!(server.get_block(x, y, z + 1), Some(foot_state));
        assert_eq!(server.get_block(x + 1, y, z + 1), Some(head_state));
        assert!(server.entities.is_empty());
        assert_eq!(
            server.clients[&1].inventory.selected_stack().unwrap().count,
            1
        );
        assert!(server.take_outbox().into_iter().any(|(id, bytes)| {
            id == 1
                && matches!(
                    S2C::decode(&bytes),
                    Ok(S2C::BlockUpdate { x, y, z, state: blocks::AIR })
                        if [x, y, z] == new_foot
                )
        }));
    }

    #[test]
    fn breaking_either_half_drops_one_bed_and_explosions_drop_at_most_one() {
        for part_head in [false, true] {
            let (mut server, [x, y, z]) = joined(GameMode::Survival);
            hold_bed(&mut server, 1);
            let foot = [x + 2, y, z];
            let head = [foot[0], foot[1], foot[2] + 1];
            support(&mut server, [foot, head]);
            place(&mut server, foot, blocks::bed_state(1, false));
            let target = if part_head { head } else { foot };
            server.apply(
                1,
                C2S::DigStart {
                    x: target[0],
                    y: target[1],
                    z: target[2],
                },
            );
            server.game_time += 10;
            server.tick_digs();
            assert_eq!(
                server.get_block(foot[0], foot[1], foot[2]),
                Some(blocks::AIR)
            );
            assert_eq!(
                server.get_block(head[0], head[1], head[2]),
                Some(blocks::AIR)
            );
            assert_eq!(bed_count(&server), 1);
        }

        let (mut server, [x, y, z]) = joined(GameMode::Creative);
        let foot = [x + 2, y, z];
        let head = [foot[0] + 1, foot[1], foot[2]];
        support(&mut server, [foot, head]);
        server.clients.get_mut(&1).unwrap().yaw = 270.0;
        place(&mut server, foot, blocks::bed_state(3, false));
        assert_eq!(
            server.get_block(head[0], head[1], head[2]),
            Some(blocks::bed_state(3, true))
        );
        server.apply(
            1,
            C2S::SetBlock {
                x: head[0],
                y: head[1],
                z: head[2],
                state: blocks::AIR,
            },
        );
        assert_eq!(
            server.get_block(foot[0], foot[1], foot[2]),
            Some(blocks::AIR)
        );
        assert_eq!(
            server.get_block(head[0], head[1], head[2]),
            Some(blocks::AIR)
        );
        assert_eq!(bed_count(&server), 0);

        let (mut server, [x, y, z]) = joined(GameMode::Creative);
        let mut drop_at = None;
        let mut keep_at = None;
        for dx in 0..48 {
            let pos = [x + dx, y, z + 3];
            server.ensure_chunk((pos[0] >> 4, pos[2] >> 4));
            server.ensure_chunk(((pos[0] + 1) >> 4, pos[2] >> 4));
            if crate::mob::explosion_drops(server.seed, server.game_time, pos) {
                drop_at = Some(pos);
            } else if keep_at.is_none() {
                keep_at = Some(pos);
            }
        }
        for (pos, expect) in [(drop_at.unwrap(), 1), (keep_at.unwrap(), 0)] {
            let head = [pos[0] + 1, pos[1], pos[2]];
            server
                .world
                .set_block(pos[0], pos[1], pos[2], blocks::bed_state(3, false));
            server
                .world
                .set_block(head[0], head[1], head[2], blocks::bed_state(3, true));
            server.entities.clear();
            server.apply_explosion([
                pos[0] as f64 + 0.5,
                pos[1] as f64 + 0.5,
                pos[2] as f64 + 0.5,
            ]);
            assert_eq!(
                server.get_block(pos[0], pos[1], pos[2]),
                Some(blocks::AIR),
                "{pos:?}"
            );
            assert_eq!(
                server.get_block(head[0], head[1], head[2]),
                Some(blocks::AIR),
                "{pos:?}"
            );
            assert_eq!(bed_count(&server), expect, "{pos:?}");
        }
    }

    #[test]
    fn using_a_bed_sets_respawn_once_and_sleeps_only_when_the_night_is_clear() {
        let (mut server, [x, y, z]) = joined(GameMode::Survival);
        let foot = [x + 2, y, z];
        let head = [foot[0], foot[1], foot[2] + 1];
        support(&mut server, [foot, head]);
        server
            .world
            .set_block(foot[0], foot[1], foot[2], blocks::bed_state(1, false));
        server
            .world
            .set_block(head[0], head[1], head[2], blocks::bed_state(1, true));
        use_at(&mut server, 1, head);
        assert_eq!(server.clients[&1].respawn, Some(foot));
        assert!(server.clients[&1].sleep.is_none());
        assert_eq!(
            texts(&mut server),
            ["リスポーン地点を設定しました", "夜にならないと眠れません"]
        );

        use_at(&mut server, 1, foot);
        assert!(texts(&mut server)
            .iter()
            .all(|text| text != "リスポーン地点を設定しました"));
        assert!(server.clients[&1].sleep.is_none());

        server.set_time(0, 13000);
        server.spawn_mob(
            MobKind::Cow,
            [foot[0] as f64 + 0.5, y as f64, foot[2] as f64 + 0.5],
        );
        use_at(&mut server, 1, foot);
        assert!(server.clients[&1].sleep.is_some());
        assert_eq!(sleeping_flags(&mut server), [(1, true)]);
        server.wake(1);

        server.spawn_mob(
            MobKind::Zombie,
            [foot[0] as f64 + 0.5 + 8.0, y as f64, foot[2] as f64 + 0.5],
        );
        use_at(&mut server, 1, foot);
        assert!(server.clients[&1].sleep.is_none());
        assert_eq!(texts(&mut server), ["近くに敵がいるので眠れません"]);
        server.mobs.clear();
        server.spawn_mob(
            MobKind::Skeleton,
            [foot[0] as f64 + 0.5 + 8.1, y as f64, foot[2] as f64 + 0.5],
        );
        server.spawn_mob(
            MobKind::Creeper,
            [foot[0] as f64 + 0.5, y as f64 + 5.1, foot[2] as f64 + 0.5],
        );
        use_at(&mut server, 1, foot);
        assert!(server.clients[&1].sleep.is_some());
        server.wake(1);
        server.mobs.clear();

        server.spawn_mob(
            MobKind::Zombie,
            [foot[0] as f64 + 0.5, y as f64, foot[2] as f64 + 0.5],
        );
        server.mobs.values_mut().next().unwrap().health = 0;
        use_at(&mut server, 1, foot);
        assert!(server.clients[&1].sleep.is_some());

        server.connect(2);
        server.handle_packet(
            2,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            }
            .encode(),
        );
        server.tick();
        server.take_outbox();
        use_at(&mut server, 2, foot);
        assert_eq!(server.clients[&2].respawn, Some(foot));
        assert!(server.clients[&2].sleep.is_none());
        assert!(server.clients[&1].sleep.is_some());
        let lines = texts(&mut server);
        assert!(lines.contains(&"リスポーン地点を設定しました".to_owned()));
        assert!(lines.contains(&"このベッドは使われています".to_owned()));

        server
            .world
            .set_block(head[0], head[1], head[2], blocks::AIR);
        let rejected = server.stats.packets_rejected;
        let point = server.clients[&2].respawn;
        server.handle_packet(
            2,
            &C2S::UseBlock {
                x: foot[0],
                y: foot[1],
                z: foot[2],
            }
            .encode(),
        );
        server.tick();
        assert!(server.stats.packets_rejected > rejected);
        assert_eq!(server.clients[&2].respawn, point);
        assert!(texts(&mut server).is_empty());
    }

    #[test]
    fn sleep_ends_on_stop_movement_damage_and_breaking_the_bed() {
        let (mut server, [x, y, z]) = joined(GameMode::Creative);
        let foot = [x + 2, y, z];
        let head = [foot[0], y, z + 1];
        support(&mut server, [foot, head]);
        server.clients.get_mut(&1).unwrap().yaw = 0.0;
        place(&mut server, foot, blocks::bed_state(1, false));
        server.set_time(0, 13000);
        use_at(&mut server, 1, foot);
        assert!(server.clients[&1].sleep.is_some());
        let origin = server.clients[&1].pos;
        server.handle_packet(
            1,
            &C2S::PlayerPos {
                x: origin[0] + 0.1,
                y: origin[1],
                z: origin[2],
                yaw: 0.0,
                pitch: 0.0,
            }
            .encode(),
        );
        server.tick();
        assert!(server.clients[&1].sleep.is_some());
        server.handle_packet(
            1,
            &C2S::PlayerPos {
                x: origin[0] + 0.2,
                y: origin[1],
                z: origin[2],
                yaw: 0.0,
                pitch: 0.0,
            }
            .encode(),
        );
        server.tick();
        assert!(server.clients[&1].sleep.is_none());
        assert_eq!(server.clients[&1].pos[0], origin[0] + 0.2);

        use_at(&mut server, 1, foot);
        server.handle_packet(1, &C2S::StopSleeping.encode());
        server.tick();
        assert!(server.clients[&1].sleep.is_none());
        assert!(sleeping_flags(&mut server).contains(&(1, false)));

        use_at(&mut server, 1, foot);
        server
            .clients
            .get_mut(&1)
            .unwrap()
            .health
            .damage(1, DeathCause::Fall);
        server.tick();
        assert!(server.clients[&1].sleep.is_none());
        assert!(!server.clients[&1].health.hurt);

        use_at(&mut server, 1, foot);
        server.apply(
            1,
            C2S::SetBlock {
                x: head[0],
                y: head[1],
                z: head[2],
                state: blocks::AIR,
            },
        );
        assert!(server.clients[&1].sleep.is_none());
        assert_eq!(
            server.get_block(foot[0], foot[1], foot[2]),
            Some(blocks::AIR)
        );
    }

    #[test]
    fn everyone_sleeping_for_one_hundred_ticks_reaches_the_next_dawn() {
        let (mut server, [x, y, z]) = joined(GameMode::Creative);
        let foot = [x + 2, y, z];
        let head = [foot[0], y, z + 1];
        support(&mut server, [foot, head]);
        place(&mut server, foot, blocks::bed_state(1, false));
        server.set_time(0, 13000);
        server.handle_packet(
            1,
            &C2S::UseBlock {
                x: foot[0],
                y: foot[1],
                z: foot[2],
            }
            .encode(),
        );
        for _ in 0..99 {
            server.tick();
        }
        assert_eq!(server.sleep_ticks, 99);
        assert_eq!(server.day_time(), 13099);
        assert_eq!(server.game_time(), 99);
        server.tick();
        assert_eq!(server.day_time(), 24000);
        assert_eq!(server.game_time(), 100);
        assert_eq!(server.sleep_ticks, 0);
        assert!(server.clients[&1].sleep.is_none());

        server.set_time(0, -11000);
        server.handle_packet(
            1,
            &C2S::UseBlock {
                x: foot[0],
                y: foot[1],
                z: foot[2],
            }
            .encode(),
        );
        for _ in 0..100 {
            server.tick();
        }
        assert_eq!(server.day_time(), 0);
        assert_eq!(server.game_time(), 100);

        server.connect(2);
        server.handle_packet(
            2,
            &C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            }
            .encode(),
        );
        server.tick();
        server.set_time(0, 13000);
        server.handle_packet(
            1,
            &C2S::UseBlock {
                x: foot[0],
                y: foot[1],
                z: foot[2],
            }
            .encode(),
        );
        for _ in 0..100 {
            server.tick();
        }
        assert_eq!(server.day_time(), 13100);
        assert_eq!(server.sleep_ticks, 0);
        assert!(server.clients[&1].sleep.is_some());

        server.disconnect(2);
        server.handle_packet(1, &C2S::StopSleeping.encode());
        server.tick();
        assert_eq!(server.sleep_ticks, 0);
        server.handle_packet(
            1,
            &C2S::UseBlock {
                x: foot[0],
                y: foot[1],
                z: foot[2],
            }
            .encode(),
        );
        for _ in 0..40 {
            server.tick();
        }
        assert_eq!(server.sleep_ticks, 40);
        server.handle_packet(1, &C2S::StopSleeping.encode());
        server.tick();
        assert_eq!(server.sleep_ticks, 0);
        server.handle_packet(
            1,
            &C2S::UseBlock {
                x: foot[0],
                y: foot[1],
                z: foot[2],
            }
            .encode(),
        );
        for _ in 0..99 {
            server.tick();
        }
        assert_eq!(server.sleep_ticks, 99);
        assert_ne!(server.day_time(), 24000);
        server.tick();
        assert_eq!(server.day_time(), 24000);
        assert!(server.clients[&1].sleep.is_none());
    }

    #[test]
    fn respawn_uses_a_clear_bed_and_forgets_a_missing_or_blocked_one() {
        let (mut server, [x, y, z]) = joined(GameMode::Survival);
        let foot = [x + 2, y, z];
        let head = [foot[0], y, z + 1];
        support(&mut server, [foot, head]);
        server
            .world
            .set_block(foot[0], foot[1], foot[2], blocks::bed_state(1, false));
        server
            .world
            .set_block(head[0], head[1], head[2], blocks::bed_state(1, true));
        server.clients.get_mut(&1).unwrap().respawn = Some(foot);
        server
            .clients
            .get_mut(&1)
            .unwrap()
            .health
            .damage(20, DeathCause::Fall);
        server.handle_packet(1, &C2S::Respawn.encode());
        server.tick();
        let stand = [
            foot[0] as f64 + 0.5,
            foot[1] as f64 + 9.0 / 16.0,
            foot[2] as f64 + 0.5,
        ];
        assert_eq!(server.clients[&1].pos, stand);
        assert_eq!(server.clients[&1].respawn, Some(foot));
        assert!(texts(&mut server).is_empty());

        server
            .world
            .set_block(foot[0], foot[1] + 1, foot[2], blocks::STONE);
        server
            .clients
            .get_mut(&1)
            .unwrap()
            .health
            .damage(20, DeathCause::Fall);
        server.handle_packet(1, &C2S::Respawn.encode());
        server.tick();
        assert_eq!(server.clients[&1].pos, server.spawn());
        assert_eq!(server.clients[&1].respawn, None);
        assert_eq!(texts(&mut server), ["ベッドが無いか、ふさがれていました"]);

        server.clients.get_mut(&1).unwrap().respawn = Some(foot);
        server
            .world
            .set_block(foot[0], foot[1] + 1, foot[2], blocks::AIR);
        server
            .world
            .set_block(head[0], head[1], head[2], blocks::AIR);
        server
            .clients
            .get_mut(&1)
            .unwrap()
            .health
            .damage(20, DeathCause::Fall);
        server.handle_packet(1, &C2S::Respawn.encode());
        server.tick();
        assert_eq!(server.clients[&1].pos, server.spawn());
        assert_eq!(server.clients[&1].respawn, None);

        server
            .world
            .set_block(head[0], head[1], head[2], blocks::bed_state(1, true));
        server.clients.get_mut(&1).unwrap().respawn = Some(foot);
        let chunk = (head[0] >> 4, head[2] >> 4);
        server.world.chunks.remove(&chunk);
        server.stored.insert(chunk);
        server
            .clients
            .get_mut(&1)
            .unwrap()
            .health
            .damage(20, DeathCause::Fall);
        server.handle_packet(1, &C2S::Respawn.encode());
        server.tick();
        assert_eq!(server.clients[&1].pos, server.spawn());
        assert_eq!(server.clients[&1].respawn, None);
    }

    #[test]
    fn respawn_point_round_trips_in_version_7_and_version_6_has_none() {
        let (mut server, [x, y, z]) = joined(GameMode::Survival);
        let foot = [x + 2, y, z];
        let mut legacy = server.inventory_data(1).unwrap();
        assert_eq!((legacy[0], legacy.len()), (7, 259));
        legacy[0] = 6;
        legacy.pop();
        server.disconnect(1);
        server.connect_at(1, false, None, Some(&legacy));
        assert_eq!(server.clients[&1].respawn, None);
        assert!(server.clients[&1].sleep.is_none());

        server.clients.get_mut(&1).unwrap().respawn = Some(foot);
        server.clients.get_mut(&1).unwrap().sleep = Some(BedRest {
            foot,
            origin: [0.0; 3],
        });
        let saved = server.inventory_data(1).unwrap();
        assert_eq!(saved.len(), 271);
        assert_eq!(saved[258], 1);
        let asleep = server.state_hash();
        server.clients.get_mut(&1).unwrap().sleep = None;
        assert_ne!(server.state_hash(), asleep);
        server.disconnect(1);
        server.connect_at(1, false, None, Some(&saved));
        assert_eq!(server.clients[&1].respawn, Some(foot));
        assert!(server.clients[&1].sleep.is_none());
    }
}
