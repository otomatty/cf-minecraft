//! Survival health and the per-tick state that drives it.

use protocol::{DeathCause, PlayerVitals, MAX_AIR, MAX_HEALTH};
use world::{blocks, Fnv64, World, MIN_Y};

use crate::{GameMode, Server};

const FALL_DAMAGE_OFFSET: f64 = 3.0;
const SUFFOCATION_INTERVAL: u8 = 10;
const SUFFOCATION_DAMAGE: u8 = 1;
const AIR_DRAIN: u16 = 1;
const AIR_RECOVERY: u16 = 5;
const DROWNING_INTERVAL: u8 = 20;
const DROWNING_DAMAGE: u8 = 2;
pub(crate) const VOID_Y: f64 = (MIN_Y - 64) as f64;
const VOID_INTERVAL: u8 = 10;
const VOID_DAMAGE: u8 = 4;
const REGEN_INTERVAL: u8 = 80;
const REGEN_HEALTH: u8 = 1;

#[derive(Default)]
pub(crate) struct Health {
    pub vitals: PlayerVitals,
    pub last_sent: Option<PlayerVitals>,
    pub fall_start_y: Option<f64>,
    fall_damage: u8,
    suffocation_ticks: u8,
    drowning_ticks: u8,
    void_ticks: u8,
    regen_ticks: u8,
}

impl Health {
    pub fn new(vitals: PlayerVitals, y: f64) -> Self {
        Self {
            vitals,
            fall_start_y: Some(y),
            ..Self::default()
        }
    }

    /// Observe each accepted position to retain the apex and landing when
    /// several movement packets arrive before the next server tick.
    pub fn observe_fall(&mut self, world: &World, pos: [f64; 3]) {
        let Some(feet) = block_at(world, pos, 0.0) else {
            return;
        };
        if feet == blocks::WATER {
            self.fall_start_y = None;
        } else if grounded(world, pos) {
            if let Some(start) = self.fall_start_y.take() {
                let distance = start - pos[1];
                let damage = (distance.floor() - FALL_DAMAGE_OFFSET).max(0.0) as u8;
                self.fall_damage = self.fall_damage.saturating_add(damage);
            }
        } else {
            self.fall_start_y = Some(self.fall_start_y.map_or(pos[1], |start| start.max(pos[1])));
        }
    }

    fn tick(&mut self, world: &World, pos: [f64; 3]) {
        let was_injured = self.vitals.health < MAX_HEALTH;
        self.observe_fall(world, pos);
        let fall = std::mem::take(&mut self.fall_damage);
        self.damage(fall, DeathCause::Fall);
        if self.vitals.dead {
            return;
        }

        let eye = block_at(world, pos, physics::EYE_HEIGHT);
        if interval(
            &mut self.suffocation_ticks,
            eye.is_some_and(|block| {
                let info = blocks::info(block);
                info.solid && info.occludes && info.model == blocks::Model::Cube
            }),
            SUFFOCATION_INTERVAL,
        ) {
            self.damage(SUFFOCATION_DAMAGE, DeathCause::Suffocation);
            if self.vitals.dead {
                return;
            }
        }

        let submerged = eye == Some(blocks::WATER);
        let out_of_air = submerged && self.vitals.air == 0;
        if submerged {
            self.vitals.air = self.vitals.air.saturating_sub(AIR_DRAIN);
        } else {
            self.vitals.air = (self.vitals.air + AIR_RECOVERY).min(MAX_AIR);
        }
        if interval(&mut self.drowning_ticks, out_of_air, DROWNING_INTERVAL) {
            self.damage(DROWNING_DAMAGE, DeathCause::Drowning);
            if self.vitals.dead {
                return;
            }
        }

        if interval(&mut self.void_ticks, pos[1] < VOID_Y, VOID_INTERVAL) {
            self.damage(VOID_DAMAGE, DeathCause::Void);
            if self.vitals.dead {
                return;
            }
        }

        if interval(&mut self.regen_ticks, was_injured, REGEN_INTERVAL) {
            self.vitals.health += REGEN_HEALTH;
        }
    }

    fn damage(&mut self, amount: u8, cause: DeathCause) {
        self.vitals.health = self.vitals.health.saturating_sub(amount);
        if self.vitals.health == 0 {
            self.vitals.dead = true;
            self.vitals.cause = cause;
        }
    }

    pub fn hash_into(&self, h: &mut Fnv64) {
        h.u8(self.vitals.health);
        h.bytes(&self.vitals.air.to_be_bytes());
        h.u8(u8::from(self.vitals.dead));
        h.u8(self.vitals.cause as u8);
        hash_height(h, self.fall_start_y);
        h.u8(self.fall_damage);
        h.u8(self.suffocation_ticks);
        h.u8(self.drowning_ticks);
        h.u8(self.void_ticks);
        h.u8(self.regen_ticks);
    }
}

fn interval(ticks: &mut u8, active: bool, period: u8) -> bool {
    if !active {
        *ticks = 0;
        return false;
    }
    *ticks += 1;
    if *ticks == period {
        *ticks = 0;
        return true;
    }
    false
}

fn block_at(world: &World, [x, y, z]: [f64; 3], offset: f64) -> Option<u16> {
    world.get_block(
        x.floor() as i32,
        (y + offset).floor() as i32,
        z.floor() as i32,
    )
}

pub(crate) fn grounded(world: &World, pos: [f64; 3]) -> bool {
    physics::Player::new(pos).is_grounded(&physics::BlockWorld(|x, y, z| world.get_block(x, y, z)))
}

pub(crate) fn hash_height(h: &mut Fnv64, height: Option<f64>) {
    h.u8(u8::from(height.is_some()));
    if let Some(y) = height {
        h.bytes(&y.to_bits().to_be_bytes());
    }
}

impl Server {
    pub(crate) fn tick_health(&mut self) {
        let mut deaths = Vec::new();
        for (&id, client) in self.clients.iter_mut().filter(|(_, c)| c.joined) {
            let health = &mut client.health;
            if self.game_mode == GameMode::Survival && !health.vitals.dead {
                health.tick(&self.world, client.pos);
                if health.vitals.dead {
                    deaths.push(id);
                }
            }
            if health.last_sent != Some(health.vitals) {
                health.last_sent = Some(health.vitals);
                self.outbox.push((id, health.vitals.packet().encode()));
            }
        }
        for id in deaths {
            self.abort_dig(id);
            let client = self.clients.get_mut(&id).unwrap();
            client.inventory_dirty = true;
            let pos = client.pos;
            let stacks: Vec<_> = client.inventory.take_all().collect();
            self.drop_carried_stacks(stacks, pos);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{inventory::Screen, Dig, Stack};
    use protocol::{C2S, PROTOCOL_VERSION, S2C};
    use world::Chunk;
    use worldgen::Generator;

    const FEET: [f64; 3] = [2.5, 80.0, 2.5];

    fn hello(server: &mut Server) {
        send(
            server,
            C2S::Hello {
                protocol: PROTOCOL_VERSION,
                view_distance: 2,
            },
        );
    }

    fn joined(mode: GameMode) -> Server {
        let mut s = Server::new(1, Generator::Flat);
        s.set_game_mode(mode);
        s.world.insert_chunk_unlit(Chunk::empty(0, 0));
        s.world.set_block(2, 79, 2, blocks::STONE);
        s.connect_at(1, true, Some(FEET), None);
        hello(&mut s);
        s.tick();
        let packets = packets(&mut s);
        assert!(matches!(packets[0], S2C::Welcome { .. }));
        assert_eq!(statuses(packets), [PlayerVitals::default().packet()]);
        s
    }

    fn send(s: &mut Server, packet: C2S) {
        s.handle_packet(1, &packet.encode());
    }

    fn teleport(s: &mut Server, [x, y, z]: [f64; 3]) {
        send(s, C2S::Teleport { x, y, z });
    }

    fn movement([x, y, z]: [f64; 3]) -> C2S {
        C2S::PlayerPos {
            x,
            y,
            z,
            yaw: 0.0,
            pitch: 0.0,
        }
    }

    fn advance(s: &mut Server, ticks: u32) {
        for _ in 0..ticks {
            s.tick();
        }
    }

    fn vitals(s: &Server) -> PlayerVitals {
        s.clients[&1].health.vitals
    }

    fn packets(s: &mut Server) -> Vec<S2C> {
        s.take_outbox()
            .iter()
            .map(|(_, bytes)| S2C::decode(bytes).unwrap())
            .collect()
    }

    fn statuses(packets: Vec<S2C>) -> Vec<S2C> {
        packets
            .into_iter()
            .filter(|p| matches!(p, S2C::PlayerStatus { .. }))
            .collect()
    }

    #[test]
    fn fall_uses_accepted_feet_and_teleport_origin_with_safe_falls_water_and_creative() {
        for (mode, distance, water, expected_damage) in [
            (GameMode::Survival, 10.0, false, 7),
            (GameMode::Survival, 4.0, false, 1),
            (GameMode::Survival, 3.0, false, 0),
            (GameMode::Survival, 4.5, false, 1),
            (GameMode::Survival, 10.0, true, 0),
            (GameMode::Creative, 10.0, false, 0),
        ] {
            let mut s = joined(mode);
            if water {
                s.world.set_block(2, 80, 2, blocks::WATER);
            }
            let [x, y, z] = FEET;
            // Both reports arrive in one tick. No server tick sampled the apex.
            teleport(&mut s, [x, y + distance, z]);
            send(&mut s, movement(FEET));
            s.tick();
            assert_eq!(s.client_position(1), Some(FEET));
            assert_eq!(s.stats.packets_rejected, 0);
            assert_eq!(vitals(&s).health, MAX_HEALTH - expected_damage);
            let updates = statuses(packets(&mut s));
            if expected_damage == 0 {
                assert!(updates.is_empty());
            } else {
                assert_eq!(updates, [vitals(&s).packet()]);
            }
            s.tick();
            assert!(statuses(packets(&mut s)).is_empty());
            assert_eq!(vitals(&s).health, MAX_HEALTH - expected_damage);
        }
    }

    #[test]
    fn survival_accepts_predicted_jumps_and_rejects_flight_ascent_and_hover() {
        let mut s = joined(GameMode::Survival);
        let mut player = physics::Player::new(FEET);
        for tick in 0..20 {
            player.tick(
                physics::Input {
                    jump: tick == 2,
                    ..Default::default()
                },
                &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
            );
            send(&mut s, movement(player.position));
            s.tick();
            assert_eq!(s.client_position(1), Some(player.position));
        }
        let [x, y, z] = FEET;
        assert_eq!(s.client_position(1), Some(FEET));
        for rise in [0.5, 1.0, 1.5, 2.0] {
            send(&mut s, movement([x, y + rise, z]));
        }
        s.tick();
        assert_eq!(s.stats.positions_rejected, 1);
        assert_eq!(s.client_position(1), Some([x, y + 1.5, z]));
        advance(&mut s, crate::AIRBORNE_GRACE_TICKS as u32);
        send(&mut s, movement([x + 0.25, y + 1.5, z]));
        s.tick();
        assert_eq!(s.stats.positions_rejected, 2);
        send(&mut s, movement([x, y + 1.0, z]));
        send(&mut s, movement(FEET));
        s.tick();
        assert_eq!(s.stats.positions_rejected, 2);
        assert_eq!(s.client_position(1), Some(FEET));
    }

    #[test]
    fn suffocation_only_checks_full_opaque_cubes_at_eye_level() {
        for block in [
            blocks::STONE,
            blocks::GLASS,
            blocks::OAK_LEAVES,
            blocks::OAK_SLAB,
            blocks::OAK_STAIRS,
        ] {
            let mut s = joined(GameMode::Survival);
            s.world.set_block(2, 81, 2, block);
            advance(&mut s, 9);
            assert_eq!(vitals(&s).health, MAX_HEALTH);
            s.tick();
            let damage = u8::from(block == blocks::STONE);
            assert_eq!(vitals(&s).health, MAX_HEALTH - damage);
            advance(&mut s, 10);
            assert_eq!(vitals(&s).health, MAX_HEALTH - 2 * damage);
        }
    }

    #[test]
    fn drowning_waits_twenty_more_ticks_at_zero_air_and_air_recovers() {
        let mut s = joined(GameMode::Survival);
        s.world.set_block(2, 81, 2, blocks::WATER);
        advance(&mut s, u32::from(MAX_AIR) - 1);
        assert_eq!(vitals(&s).air, 1);
        s.tick();
        assert_eq!(vitals(&s).air, 0);
        advance(&mut s, 19);
        assert_eq!(vitals(&s).health, MAX_HEALTH);
        s.tick();
        assert_eq!(vitals(&s).health, MAX_HEALTH - 2);
        advance(&mut s, 20);
        assert_eq!(vitals(&s).health, MAX_HEALTH - 4);
        let [x, y, z] = FEET;
        send(&mut s, movement([x + 1.0, y, z]));
        s.tick();
        assert_eq!(vitals(&s).air, 5);
        advance(&mut s, 59);
        assert_eq!(vitals(&s).air, MAX_AIR);
        s.tick();
        assert_eq!(vitals(&s).air, MAX_AIR);
    }

    #[test]
    fn void_uses_strict_boundary_and_damages_every_ten_ticks() {
        let mut s = joined(GameMode::Survival);
        teleport(&mut s, [FEET[0], VOID_Y, FEET[2]]);
        advance(&mut s, 20);
        assert_eq!(vitals(&s).health, MAX_HEALTH);
        send(&mut s, movement([FEET[0], VOID_Y - 1.0, FEET[2]]));
        advance(&mut s, 9);
        assert_eq!(vitals(&s).health, MAX_HEALTH);
        s.tick();
        assert_eq!(vitals(&s).health, MAX_HEALTH - 4);
        advance(&mut s, 10);
        assert_eq!(vitals(&s).health, MAX_HEALTH - 8);
        advance(&mut s, 30);
        assert_eq!(vitals(&s).cause, DeathCause::Void);
    }

    #[test]
    fn natural_regeneration_heals_after_eighty_injured_ticks() {
        let mut s = joined(GameMode::Survival);
        teleport(&mut s, [FEET[0], FEET[1] + 5.0, FEET[2]]);
        send(&mut s, movement(FEET));
        s.tick();
        assert_eq!(vitals(&s).health, 18);
        advance(&mut s, 79);
        assert_eq!(vitals(&s).health, 18);
        s.tick();
        assert_eq!(vitals(&s).health, 19);
        advance(&mut s, 80);
        assert_eq!(vitals(&s).health, 20);
    }

    #[test]
    fn death_drops_all_carried_stacks_in_order_and_keeps_furnace_contents() {
        for screen in [
            Screen::CraftingTable { pos: [3, 80, 2] },
            Screen::Furnace { pos: [3, 80, 2] },
        ] {
            let mut s = joined(GameMode::Survival);
            let pos = [3, 80, 2];
            let block = if matches!(screen, Screen::Furnace { .. }) {
                blocks::FURNACE
            } else {
                blocks::CRAFTING_TABLE
            };
            s.world.set_block(pos[0], pos[1], pos[2], block);
            let furnace_stack = Some(Stack { item: 1, count: 7 });
            s.furnaces.entry(pos).or_default().slots[0] = furnace_stack;
            let client = s.clients.get_mut(&1).unwrap();
            client
                .inventory
                .set(35, Some(Stack { item: 1, count: 2 }))
                .unwrap();
            client.inventory.crafting[0] = Some(Stack { item: 5, count: 3 });
            client.inventory.table[8] = Some(Stack { item: 8, count: 4 });
            client.inventory.cursor = Some(Stack { item: 43, count: 5 });
            client.inventory.screen = screen;
            client.dig = Some(Dig {
                pos: [2, 79, 2],
                state: blocks::STONE,
                start: s.game_time,
                ticks: 40,
                drops: true,
                stage: None,
            });
            teleport(&mut s, [FEET[0], FEET[1] + 23.0, FEET[2]]);
            send(&mut s, movement(FEET));
            s.tick();
            assert_eq!(vitals(&s).cause, DeathCause::Fall);
            assert!(vitals(&s).dead);
            assert_eq!(vitals(&s).health, 0);
            assert_eq!(statuses(packets(&mut s)), [vitals(&s).packet()]);
            let client = &s.clients[&1];
            assert!(client.dig.is_none());
            assert_eq!(client.inventory, crate::Inventory::default());
            assert_eq!(s.furnaces[&pos].slots[0], furnace_stack);
            assert_eq!(
                s.entities
                    .values()
                    .map(|e| {
                        assert_eq!(e.pos, FEET);
                        assert_eq!(e.velocity, [0.0, 0.1, 0.0]);
                        assert_eq!(e.pickup_delay, 40);
                        (e.item, e.count)
                    })
                    .collect::<Vec<_>>(),
                [(1, 2), (5, 3), (8, 4), (43, 5)]
            );
            // The dead player cannot pick up the drops after the cooldown.
            advance(&mut s, 80);
            assert_eq!(s.clients[&1].inventory, crate::Inventory::default());
            assert_eq!(
                s.entities.values().map(|e| u32::from(e.count)).sum::<u32>(),
                14
            );
        }
    }

    #[test]
    fn reconnect_restores_vitals_and_only_a_joined_dead_client_can_respawn() {
        let mut s = joined(GameMode::Survival);
        let respawn = C2S::Respawn;
        send(&mut s, respawn.clone());
        s.tick();
        assert_eq!(s.stats.packets_rejected, 1);

        s.world.set_block(2, 81, 2, blocks::WATER);
        advance(&mut s, 10);
        s.clients.get_mut(&1).unwrap().health.vitals.health = 1;
        release_and_reconnect(&mut s);
        assert_eq!(vitals(&s).health, 1);
        assert_eq!(vitals(&s).air, 290);
        assert!(!vitals(&s).dead);
        s.world.set_block(2, 81, 2, blocks::STONE);
        hello(&mut s);
        advance(&mut s, 10);
        let dead = vitals(&s);
        assert_eq!(dead.cause, DeathCause::Suffocation);

        release_and_reconnect(&mut s);
        assert_eq!(vitals(&s), dead);
        hello(&mut s);
        s.tick();
        assert_eq!(statuses(packets(&mut s)), [dead.packet()]);
        let denied = [
            movement([FEET[0], FEET[1] + 1.0, FEET[2]]),
            C2S::Teleport {
                x: 0.5,
                y: 100.0,
                z: 0.5,
            },
            C2S::DigStart { x: 2, y: 81, z: 2 },
            C2S::DigAbort,
            C2S::SetBlock {
                x: 2,
                y: 81,
                z: 2,
                state: blocks::AIR,
            },
            C2S::ClickSlot {
                slot: 0,
                button: 0,
                shift: false,
            },
            C2S::DropItem {
                dir: [1.0, 0.0, 0.0],
            },
            C2S::UseBlock { x: 2, y: 81, z: 2 },
            C2S::SelectSlot { slot: 1 },
        ];
        let rejected = s.stats.packets_rejected;
        for packet in denied.iter().cloned() {
            send(&mut s, packet);
        }
        advance(&mut s, 90);
        assert_eq!(s.stats.packets_rejected, rejected + denied.len() as u64);
        assert_eq!(vitals(&s), dead);
        assert_eq!(s.client_position(1), Some(FEET));
        assert!(statuses(packets(&mut s)).is_empty());

        // Use an airborne spawn to verify that the respawn origin is retained.
        s.spawn = [FEET[0], FEET[1] + 10.0, FEET[2]];
        let [x, y, z] = s.spawn();
        send(&mut s, respawn);
        s.tick();
        assert_eq!(s.client_position(1), Some([x, y, z]));
        assert_eq!(s.clients[&1].health.fall_start_y, Some(y));
        assert_eq!(vitals(&s), PlayerVitals::default());
        let updates = packets(&mut s);
        assert!(updates.contains(&S2C::PlayerCorrect { x, y, z }));
        assert_eq!(statuses(updates), [vitals(&s).packet()]);
    }

    fn release_and_reconnect(s: &mut Server) {
        s.return_crafting(1);
        let position = s.client_position(1);
        let bytes = s.inventory_data(1).unwrap();
        s.disconnect(1);
        s.connect_at(1, true, position, Some(&bytes));
    }

    #[test]
    fn state_hash_includes_vitals_fall_and_interval_counters_independently() {
        let mut s = joined(GameMode::Survival);
        let baseline = s.state_hash();
        let mutations: [fn(&mut Health); 10] = [
            |h| h.vitals.health -= 1,
            |h| h.vitals.air -= 1,
            |h| h.vitals.dead = true,
            |h| h.vitals.cause = DeathCause::Fall,
            |h| h.fall_start_y = Some(FEET[1]),
            |h| h.fall_damage = 1,
            |h| h.suffocation_ticks = 1,
            |h| h.drowning_ticks = 1,
            |h| h.void_ticks = 1,
            |h| h.regen_ticks = 1,
        ];
        for mutate in mutations {
            let record = &mut s.clients.get_mut(&1).unwrap().health;
            let before = std::mem::take(record);
            mutate(record);
            assert_ne!(s.state_hash(), baseline);
            s.clients.get_mut(&1).unwrap().health = before;
            assert_eq!(s.state_hash(), baseline);
        }
    }
}
