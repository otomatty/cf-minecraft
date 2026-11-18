//! Survival health and the per-tick state that drives it.

use protocol::{DeathCause, PlayerVitals, MAX_AIR, MAX_FOOD, MAX_HEALTH};
use world::{blocks, items, Fnv64, World, MIN_Y};

use crate::{inventory::Screen, Client, GameMode, Server};

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
const LAVA_INTERVAL: u8 = 10;
const LAVA_DAMAGE: u8 = 4;
const REGEN_INTERVAL: u8 = 80;
const REGEN_HEALTH: u8 = 1;
const REGEN_FOOD: u8 = 18;
const STARVE_INTERVAL: u8 = 80;
const EXHAUSTION_PER_FOOD: u16 = 1200;
const EAT_TICKS: u8 = 32;

#[derive(Clone, Copy)]
struct EatState {
    slot: u8,
    ticks: u8,
}

#[derive(Default)]
pub(crate) struct Health {
    pub vitals: PlayerVitals,
    pub last_sent: Option<PlayerVitals>,
    pub fall_start_y: Option<f64>,
    fall_damage: u8,
    suffocation_ticks: u8,
    drowning_ticks: u8,
    void_ticks: u8,
    lava_ticks: u8,
    regen_ticks: u8,
    exhaustion: u16,
    walked: f64,
    starve_ticks: u8,
    eating: Option<EatState>,
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
    /// `prev` is the last accepted position. With no fall in progress, leaving
    /// ground starts from that height, and leaving a fluid starts from `pos`.
    pub fn observe_fall(&mut self, world: &World, prev: [f64; 3], pos: [f64; 3]) {
        let Some(feet) = block_at(world, pos, 0.0) else {
            return;
        };
        if blocks::is_fluid(feet) {
            self.fall_start_y = None;
        } else if grounded(world, pos) {
            if let Some(start) = self.fall_start_y.take() {
                let distance = start - pos[1];
                let damage = (distance.floor() - FALL_DAMAGE_OFFSET).max(0.0) as u8;
                self.fall_damage = self.fall_damage.saturating_add(damage);
            }
        } else if let Some(start) = self.fall_start_y {
            self.fall_start_y = Some(start.max(pos[1]));
        } else if block_at(world, prev, 0.0).is_some_and(blocks::is_fluid) {
            self.fall_start_y = Some(pos[1]);
        } else {
            self.fall_start_y = Some(prev[1].max(pos[1]));
        }
    }

    pub fn add_exhaustion(&mut self, amount: u16) {
        self.exhaustion = self.exhaustion.saturating_add(amount);
    }

    pub fn walk(&mut self, distance: f64) {
        self.walked += distance;
        while self.walked >= 1.0 {
            self.walked -= 1.0;
            self.add_exhaustion(4);
        }
    }

    fn tick(&mut self, world: &World, pos: [f64; 3]) {
        let was_injured = self.vitals.health < MAX_HEALTH;
        self.observe_fall(world, pos, pos);
        let fall = std::mem::take(&mut self.fall_damage);
        self.damage(fall, DeathCause::Fall);
        if self.vitals.dead {
            return;
        }

        let eye = block_at(world, pos, physics::EYE_HEIGHT);
        if interval(
            &mut self.suffocation_ticks,
            eye.is_some_and(blocks::is_full_opaque_cube),
            SUFFOCATION_INTERVAL,
        ) {
            self.damage(SUFFOCATION_DAMAGE, DeathCause::Suffocation);
            if self.vitals.dead {
                return;
            }
        }

        let submerged = eye.is_some_and(blocks::is_water);
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

        let in_lava = eye.is_some_and(blocks::is_lava)
            || block_at(world, pos, 0.4).is_some_and(blocks::is_lava);
        if interval(&mut self.lava_ticks, in_lava, LAVA_INTERVAL) {
            self.damage(LAVA_DAMAGE, DeathCause::Lava);
            if self.vitals.dead {
                return;
            }
        }

        self.add_exhaustion(1);
        while self.exhaustion >= EXHAUSTION_PER_FOOD {
            self.exhaustion -= EXHAUSTION_PER_FOOD;
            self.vitals.food = self.vitals.food.saturating_sub(1);
        }

        if interval(
            &mut self.regen_ticks,
            was_injured && self.vitals.food >= REGEN_FOOD,
            REGEN_INTERVAL,
        ) {
            self.vitals.health += REGEN_HEALTH;
            self.add_exhaustion(600);
        }
        if interval(
            &mut self.starve_ticks,
            self.vitals.food == 0 && self.vitals.health >= 2,
            STARVE_INTERVAL,
        ) {
            self.vitals.health -= 1;
        }
    }

    fn damage(&mut self, amount: u8, cause: DeathCause) {
        self.vitals.health = self.vitals.health.saturating_sub(amount);
        if self.vitals.health == 0 {
            self.eating = None;
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
        h.u8(self.lava_ticks);
        h.u8(self.regen_ticks);
        h.u8(self.vitals.food);
        h.bytes(&self.exhaustion.to_be_bytes());
        h.bytes(&self.walked.to_bits().to_be_bytes());
        h.u8(self.starve_ticks);
        h.u8(u8::from(self.eating.is_some()));
        if let Some(eating) = self.eating {
            h.u8(eating.slot);
            h.u8(eating.ticks);
        }
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

impl Client {
    fn selected_food(&self) -> Option<u8> {
        if self.health.vitals.food == MAX_FOOD || self.inventory.screen != Screen::None {
            return None;
        }
        self.inventory
            .selected_stack()
            .and_then(|stack| items::food(stack.item))
    }

    fn tick_eating(&mut self) {
        let Some(mut eating) = self.health.eating.take() else {
            return;
        };
        if eating.slot != self.inventory.selected() {
            return;
        }
        let Some(food) = self.selected_food() else {
            return;
        };
        eating.ticks += 1;
        if eating.ticks == EAT_TICKS {
            self.inventory.take_selected();
            self.inventory_dirty = true;
            self.health.vitals.food = (self.health.vitals.food + food).min(MAX_FOOD);
            eating.ticks = 0;
        }
        self.health.eating = Some(eating);
    }
}

impl Server {
    pub(crate) fn use_item(&mut self, id: u32) {
        let client = self.clients.get_mut(&id).unwrap();
        if client.health.eating.is_some() {
            return;
        }
        if self.game_mode != GameMode::Survival
            || !client.joined
            || client.selected_food().is_none()
        {
            self.stats.packets_rejected += 1;
            return;
        }
        client.health.eating = Some(EatState {
            slot: client.inventory.selected(),
            ticks: 0,
        });
    }

    pub(crate) fn stop_using_item(&mut self, id: u32) {
        self.clients.get_mut(&id).unwrap().health.eating = None;
    }

    pub(crate) fn tick_health(&mut self) {
        let mut deaths = Vec::new();
        for (&id, client) in self.clients.iter_mut().filter(|(_, c)| c.joined) {
            if self.game_mode == GameMode::Survival && !client.health.vitals.dead {
                client.health.tick(&self.world, client.pos);
                if client.health.vitals.dead {
                    deaths.push(id);
                } else {
                    client.tick_eating();
                }
            }
            let health = &mut client.health;
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
    fn walking_off_a_ledge_or_removing_support_uses_the_last_grounded_height() {
        for (distance, dig, damage) in [(4.0, false, 1), (10.0, false, 7), (4.0, true, 1)] {
            let mut s = joined(GameMode::Survival);
            let surface = FEET[1] - distance;
            let floor_y = surface as i32 - 1;
            for x in 0..16 {
                for z in 0..16 {
                    s.world.set_block(x, floor_y, z, blocks::STONE);
                }
            }
            let mut player = physics::Player::new(FEET);
            for _ in 0..2 {
                player.tick(
                    physics::Input::default(),
                    &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                );
            }
            assert!(player.on_ground);
            assert_eq!(player.position, FEET);
            assert_eq!(s.client_position(1), Some(FEET));
            if dig {
                s.world.set_block(2, 79, 2, blocks::AIR);
            }
            let mut left_ground = false;
            let mut landed = false;
            for tick in 0..400 {
                let input = if dig || left_ground {
                    physics::Input::default()
                } else {
                    physics::Input {
                        forward: 1.0,
                        ..Default::default()
                    }
                };
                player.tick(
                    input,
                    &physics::BlockWorld(|x, y, z| s.world.get_block(x, y, z)),
                );
                if dig && tick == 0 {
                    assert_eq!(player.position[1], FEET[1] - 0.08 * f64::from(0.98_f32));
                }
                if !player.on_ground {
                    left_ground = true;
                }
                send(&mut s, movement(player.position));
                s.tick();
                assert_eq!(s.stats.packets_rejected, 0);
                assert_eq!(s.client_position(1), Some(player.position));
                if left_ground && player.on_ground {
                    assert_eq!(player.position[1], surface);
                    assert_eq!(vitals(&s).health, MAX_HEALTH - damage);
                    landed = true;
                    break;
                }
                assert_eq!(vitals(&s).health, MAX_HEALTH);
            }
            assert!(landed);
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
    fn flowing_water_resets_fall_origin_and_consumes_air() {
        let mut s = joined(GameMode::Survival);
        s.world.set_block(2, 80, 2, blocks::FLOWING_WATER + 3);
        s.world.set_block(2, 81, 2, blocks::FALLING_WATER);
        let [x, y, z] = FEET;
        teleport(&mut s, [x, y + 10.0, z]);
        send(&mut s, movement(FEET));
        s.tick();
        assert_eq!(s.client_position(1), Some(FEET));
        assert_eq!(vitals(&s).health, MAX_HEALTH);
        assert_eq!(vitals(&s).air, MAX_AIR - 1);
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
    fn standing_still_drains_food_every_1200_ticks_only_in_survival() {
        for (mode, expected) in [(GameMode::Survival, 19), (GameMode::Creative, 20)] {
            let mut s = joined(mode);
            // Joining already processed the first tick.
            advance(&mut s, 1198);
            assert_eq!(vitals(&s).food, 20);
            assert!(statuses(packets(&mut s)).is_empty());
            s.tick();
            assert_eq!(vitals(&s).food, expected);
            let updates = statuses(packets(&mut s));
            if mode == GameMode::Survival {
                assert_eq!(updates, [vitals(&s).packet()]);
                advance(&mut s, 1199);
                assert_eq!(vitals(&s).food, 19);
                s.tick();
                assert_eq!(vitals(&s).food, 18);
            } else {
                assert!(updates.is_empty());
                assert_eq!(s.clients[&1].health.exhaustion, 0);
            }
        }
    }

    #[test]
    fn accepted_horizontal_movement_adds_fatigue_but_teleport_does_not() {
        let mut s = joined(GameMode::Survival);
        let [x, y, z] = FEET;
        for floor_x in 2..=7 {
            s.world.set_block(floor_x, 79, 2, blocks::STONE);
        }
        for step in 0..600 {
            if step > 0 && step % 20 == 0 {
                teleport(&mut s, FEET);
            }
            send(
                &mut s,
                movement([x + f64::from(step % 20 + 1) * 0.25, y, z]),
            );
            s.tick();
            match step {
                399 => {
                    assert_eq!(s.clients[&1].health.exhaustion, 801);
                    assert_eq!(vitals(&s).food, 20);
                }
                598 => {
                    assert_eq!(s.clients[&1].health.exhaustion, 1196);
                    assert_eq!(s.clients[&1].health.walked, 0.75);
                    assert_eq!(vitals(&s).food, 20);
                }
                _ => {}
            }
        }
        assert_eq!(s.stats.packets_rejected, 0);
        assert_eq!(vitals(&s).food, 19);
        assert_eq!(s.clients[&1].health.exhaustion, 1);
        assert_eq!(s.clients[&1].health.walked, 0.0);
    }

    #[test]
    fn completed_dig_adds_twenty_exhaustion() {
        let mut s = joined(GameMode::Survival);
        s.world.set_block(3, 80, 2, blocks::DIRT);
        send(&mut s, C2S::DigStart { x: 3, y: 80, z: 2 });
        advance(&mut s, 12);
        assert_eq!(s.get_block(3, 80, 2), Some(blocks::DIRT));
        assert_eq!(s.clients[&1].health.exhaustion, 13);
        s.tick();
        assert_eq!(s.get_block(3, 80, 2), Some(blocks::AIR));
        assert_eq!(s.clients[&1].health.exhaustion, 34);
    }

    #[test]
    fn instant_dig_adds_twenty_exhaustion() {
        let mut s = joined(GameMode::Survival);
        s.world.set_block(3, 79, 2, blocks::DIRT);
        s.world.set_block(3, 80, 2, blocks::RED_FLOWER);
        assert_eq!(s.clients[&1].health.exhaustion, 1);
        send(&mut s, C2S::DigStart { x: 3, y: 80, z: 2 });
        s.tick();
        assert_eq!(s.get_block(3, 80, 2), Some(blocks::AIR));
        assert_eq!(s.clients[&1].health.exhaustion, 22);
    }

    #[test]
    fn regeneration_requires_enough_food_and_uses_exhaustion_on_the_next_tick() {
        let mut s = joined(GameMode::Survival);
        s.clients.get_mut(&1).unwrap().health.vitals.health = 13;
        advance(&mut s, 79);
        assert_eq!(vitals(&s).health, 13);
        s.tick();
        assert_eq!(vitals(&s).health, 14);
        advance(&mut s, 79);
        assert_eq!(vitals(&s).health, 14);
        s.tick();
        assert_eq!(vitals(&s).health, 15);
        assert_eq!(vitals(&s).food, 20);
        s.tick();
        assert_eq!(vitals(&s).food, 19);

        s.clients.get_mut(&1).unwrap().health.vitals.food = 17;
        advance(&mut s, 80);
        assert_eq!(vitals(&s).health, 15);
        s.clients.get_mut(&1).unwrap().health.vitals.food = 18;
        advance(&mut s, 79);
        assert_eq!(vitals(&s).health, 15);
        s.tick();
        assert_eq!(vitals(&s).health, 16);
    }

    #[test]
    fn starvation_damages_every_eighty_ticks_and_stops_at_one_health() {
        let mut s = joined(GameMode::Survival);
        let status = &mut s.clients.get_mut(&1).unwrap().health.vitals;
        status.food = 0;
        status.health = 3;
        advance(&mut s, 79);
        assert_eq!(vitals(&s).health, 3);
        s.tick();
        assert_eq!(vitals(&s).health, 2);
        advance(&mut s, 80);
        assert_eq!(vitals(&s).health, 1);
        advance(&mut s, 1200);
        assert_eq!(vitals(&s).health, 1);
        assert_eq!(vitals(&s).food, 0);
        assert!(!vitals(&s).dead);
        assert_eq!(s.clients[&1].health.exhaustion, 161);
    }

    fn with_food(mode: GameMode, food: u8, item: u16) -> Server {
        let mut s = joined(mode);
        let client = s.clients.get_mut(&1).unwrap();
        client.health.vitals.food = food;
        client
            .inventory
            .set(0, Some(Stack { item, count: 2 }))
            .unwrap();
        s
    }

    #[test]
    fn eating_bread_consumes_one_and_restores_five_food() {
        let bread = items::by_name("bread").unwrap();
        let mut s = with_food(GameMode::Survival, 12, bread);
        send(&mut s, C2S::UseItem);
        advance(&mut s, 32);
        assert_eq!(vitals(&s).food, 17);
        assert_eq!(
            s.clients[&1].inventory.selected_stack(),
            Some(Stack {
                item: bread,
                count: 1
            })
        );
    }

    #[test]
    fn eating_repeats_every_32_ticks_and_clamps_food() {
        let mut s = with_food(GameMode::Survival, 15, 49);
        send(&mut s, C2S::UseItem);
        advance(&mut s, 31);
        assert_eq!(vitals(&s).food, 15);
        assert_eq!(s.clients[&1].inventory.selected_stack().unwrap().count, 2);
        packets(&mut s);
        send(&mut s, C2S::UseItem);
        s.tick();
        assert_eq!(vitals(&s).food, 19);
        assert_eq!(s.clients[&1].inventory.selected_stack().unwrap().count, 1);
        let updates = packets(&mut s);
        assert_eq!(statuses(updates.clone()), [vitals(&s).packet()]);
        assert_eq!(
            updates
                .iter()
                .filter(|p| matches!(p, S2C::Inventory { .. }))
                .count(),
            1
        );
        advance(&mut s, 31);
        assert_eq!(vitals(&s).food, 19);
        s.tick();
        assert_eq!(vitals(&s).food, 20);
        assert!(s.clients[&1].inventory.selected_stack().is_none());
        s.tick();
        assert!(s.clients[&1].health.eating.is_none());
        assert_eq!(s.stats.packets_rejected, 0);
    }

    #[test]
    fn eating_cancels_on_release_slot_change_screen_or_death() {
        for cancel in [
            C2S::StopUsingItem,
            C2S::SelectSlot { slot: 1 },
            C2S::UseBlock { x: 3, y: 80, z: 2 },
        ] {
            let mut s = with_food(GameMode::Survival, 15, 49);
            s.world.set_block(3, 80, 2, blocks::CRAFTING_TABLE);
            send(&mut s, C2S::UseItem);
            advance(&mut s, 31);
            send(&mut s, cancel);
            advance(&mut s, 33);
            assert_eq!(vitals(&s).food, 15);
            assert!(s.clients[&1].health.eating.is_none());
            assert_eq!(s.clients[&1].inventory.slots()[0].unwrap().count, 2);
            assert_eq!(s.stats.packets_rejected, 0);
        }
        let mut s = with_food(GameMode::Survival, 15, 49);
        send(&mut s, C2S::UseItem);
        advance(&mut s, 31);
        teleport(&mut s, [FEET[0], FEET[1] + 23.0, FEET[2]]);
        send(&mut s, movement(FEET));
        s.tick();
        assert!(vitals(&s).dead);
        assert_eq!(vitals(&s).food, 15);
        assert!(s.clients[&1].health.eating.is_none());
        assert_eq!(s.entities.values().next().unwrap().count, 2);
        send(&mut s, C2S::Respawn);
        s.tick();
        assert_eq!(vitals(&s).food, 20);
        assert_eq!(s.clients[&1].health.exhaustion, 1);
    }

    #[test]
    fn cannot_start_eating_when_full_in_creative_with_non_food_or_with_a_screen_open() {
        for (mode, food, item) in [
            (GameMode::Survival, 20, 49),
            (GameMode::Creative, 15, 49),
            (GameMode::Survival, 15, 1),
        ] {
            let mut s = with_food(mode, food, item);
            send(&mut s, C2S::UseItem);
            send(&mut s, C2S::StopUsingItem);
            s.tick();
            assert!(s.clients[&1].health.eating.is_none());
            assert_eq!(s.stats.packets_rejected, 1);
        }
        let mut s = with_food(GameMode::Survival, 15, 49);
        s.world.set_block(3, 80, 2, blocks::FURNACE);
        send(&mut s, C2S::UseBlock { x: 3, y: 80, z: 2 });
        send(&mut s, C2S::UseItem);
        s.tick();
        assert!(s.clients[&1].health.eating.is_none());
        assert_eq!(s.stats.packets_rejected, 1);
    }

    #[test]
    fn oak_leaf_mining_drops_either_one_leaf_or_one_apple_deterministically() {
        let harvest = || {
            let mut s = joined(GameMode::Survival);
            let mut results = Vec::new();
            for _ in 0..60 {
                s.world.set_block(3, 80, 2, blocks::OAK_LEAVES);
                send(&mut s, C2S::DigStart { x: 3, y: 80, z: 2 });
                advance(&mut s, 7);
                assert_eq!(s.get_block(3, 80, 2), Some(blocks::AIR));
                assert_eq!(s.entities.len(), 1);
                let drop = s.entities.pop_first().unwrap().1;
                assert_eq!(drop.count, 1);
                results.push(drop.item);
            }
            results
        };
        let results = harvest();
        let leaves = items::for_block(blocks::OAK_LEAVES).unwrap();
        assert!(results.contains(&49));
        assert!(results.contains(&leaves));
        assert!(results.iter().all(|&item| item == 49 || item == leaves));
        assert_eq!(results, harvest());

        let mut s = joined(GameMode::Creative);
        s.world.set_block(3, 80, 2, blocks::OAK_LEAVES);
        send(
            &mut s,
            C2S::SetBlock {
                x: 3,
                y: 80,
                z: 2,
                state: blocks::AIR,
            },
        );
        s.tick();
        assert_eq!(s.get_block(3, 80, 2), Some(blocks::AIR));
        assert!(s.entities.is_empty());
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
        let health = &mut s.clients.get_mut(&1).unwrap().health;
        health.vitals.health = 1;
        health.vitals.food = 6;
        health.walk(0.75);
        release_and_reconnect(&mut s);
        assert_eq!(vitals(&s).health, 1);
        assert_eq!(vitals(&s).air, 290);
        assert_eq!(vitals(&s).food, 6);
        assert_eq!(s.clients[&1].health.exhaustion, 0);
        assert_eq!(s.clients[&1].health.walked, 0.0);
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
            C2S::UseItem,
            C2S::StopUsingItem,
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

    #[test]
    fn lava_hurts_survival_at_feet_or_eyes_without_drowning_and_persists_the_death_cause() {
        for (y, state) in [(80, blocks::LAVA), (81, blocks::FLOWING_LAVA)] {
            let mut s = joined(GameMode::Survival);
            s.world.set_block(2, y, 2, state);
            for health in [20, 16, 12, 8, 4] {
                advance(&mut s, 9);
                assert_eq!(vitals(&s).health, health);
                s.tick();
                assert_eq!(vitals(&s).health, health - 4);
                assert_eq!(vitals(&s).air, MAX_AIR);
            }
            let dead = vitals(&s);
            assert_eq!(dead.cause, DeathCause::Lava);
            assert!(statuses(packets(&mut s)).contains(&dead.packet()));

            let mut bytes = s.inventory_data(1).unwrap();
            assert_eq!(bytes[0], 5);
            assert_eq!(bytes[bytes.len() - 2], 5);
            assert_eq!(crate::Inventory::from_bytes(&bytes).unwrap().1, dead);
            let cause = bytes.len() - 2;
            bytes[cause] = 6;
            assert!(crate::Inventory::from_bytes(&bytes).is_err());
            release_and_reconnect(&mut s);
            assert_eq!(vitals(&s), dead);
        }
    }

    #[test]
    fn leaving_lava_resets_the_interval_and_creative_takes_no_damage() {
        let mut s = joined(GameMode::Survival);
        s.world.set_block(2, 80, 2, blocks::LAVA);
        s.clients.get_mut(&1).unwrap().health.fall_start_y = Some(90.0);
        advance(&mut s, 9);
        assert_eq!(s.clients[&1].health.fall_start_y, None);
        s.world.set_block(2, 80, 2, blocks::AIR);
        s.tick();
        s.world.set_block(2, 80, 2, blocks::LAVA);
        advance(&mut s, 9);
        assert_eq!(vitals(&s).health, MAX_HEALTH);
        s.tick();
        assert_eq!(vitals(&s).health, MAX_HEALTH - LAVA_DAMAGE);

        let mut s = joined(GameMode::Creative);
        s.world.set_block(2, 80, 2, blocks::LAVA);
        s.world.set_block(2, 81, 2, blocks::FALLING_LAVA);
        advance(&mut s, 50);
        assert_eq!(vitals(&s), PlayerVitals::default());
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
        let mutations: [fn(&mut Health); 16] = [
            |h| h.vitals.health -= 1,
            |h| h.vitals.air -= 1,
            |h| h.vitals.dead = true,
            |h| h.vitals.cause = DeathCause::Fall,
            |h| h.fall_start_y = Some(FEET[1]),
            |h| h.fall_damage = 1,
            |h| h.suffocation_ticks = 1,
            |h| h.drowning_ticks = 1,
            |h| h.void_ticks = 1,
            |h| h.lava_ticks = 1,
            |h| h.regen_ticks = 1,
            |h| h.vitals.food -= 1,
            |h| h.exhaustion = 2,
            |h| h.walked = 0.5,
            |h| h.starve_ticks = 1,
            |h| h.eating = Some(EatState { slot: 0, ticks: 0 }),
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
