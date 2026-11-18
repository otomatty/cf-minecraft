use physics::{Aabb, BlockWorld, Input, Player, HEIGHT, WIDTH};
use world::blocks;

fn flat(x: i32, y: i32, z: i32) -> Option<Aabb> {
    (y < 0).then(|| Aabb::block(x, y, z))
}
fn grounded() -> Player {
    let mut p = Player::new([0.5, 0.0, 0.5]);
    p.tick(Input::default(), &flat);
    p.tick(Input::default(), &flat);
    assert!(p.on_ground);
    p
}

#[test]
fn swimming_sinks_to_the_bottom_and_bobs_at_the_surface() {
    let mut source_swimmer = Player::default();
    for water in [blocks::WATER, blocks::FLOWING_WATER] {
        let pool = BlockWorld(|_, y, _| {
            Some(match y {
                ..0 => blocks::STONE,
                0..=2 => water,
                _ => blocks::AIR,
            })
        });
        let mut p = Player::new([0.5, 2.0, 0.5]);
        p.tick(Input::default(), &pool);
        assert!(p.in_water);
        assert_eq!(p.position[1], 2.0);
        p.tick(Input::default(), &pool);
        assert_eq!(p.position[1], 1.98);
        for _ in 0..40 {
            p.tick(Input::default(), &pool);
            assert!(p.position[1] >= 0.0);
        }
        assert_eq!(p.position[1], 0.0);
        assert!(p.on_ground);

        let jump = Input {
            jump: true,
            ..Input::default()
        };
        p.tick(jump, &pool);
        assert_eq!(p.position[1], 0.02);
        for _ in 0..60 {
            p.tick(jump, &pool);
        }
        let mut low = p.position[1];
        let mut high = low;
        for _ in 0..80 {
            let was_in_water = p.position[1] < 2.6;
            p.tick(jump, &pool);
            assert_eq!(p.in_water, was_in_water);
            low = low.min(p.position[1]);
            high = high.max(p.position[1]);
        }
        assert!(low > 2.1 && low < 2.6, "{low}");
        assert!(high > 2.6 && high < 2.9, "{high}");
        if water == blocks::WATER {
            source_swimmer = p;
        } else {
            assert_eq!(p, source_swimmer);
        }
    }
}

#[test]
fn swimming_is_slower_than_walking_and_flight_takes_precedence() {
    let pool = BlockWorld(|_, y, _| Some(if y < 0 { blocks::STONE } else { blocks::WATER }));
    let mut swimmer = Player::new([0.5, 0.0, 0.5]);
    let mut walker = swimmer;
    let forward = Input {
        forward: 1.0,
        ..Input::default()
    };
    for _ in 0..60 {
        swimmer.tick(forward, &pool);
        walker.tick(forward, &flat);
    }
    assert!(swimmer.on_ground && swimmer.in_water);
    assert!(swimmer.position[2] > 0.5 && swimmer.position[2] < walker.position[2]);

    let mut dry = Player::new([0.5, 1.0, 0.5]);
    let mut wet = dry;
    let flying = Input {
        forward: 1.0,
        jump: true,
        flying: true,
        ..Input::default()
    };
    wet.tick(flying, &pool);
    dry.tick(flying, &flat);
    assert!(wet.in_water);
    assert_eq!(wet.position, dry.position);
    assert_eq!(wet.velocity, dry.velocity);
}

#[test]
fn swimming_jumps_up_a_one_block_bank() {
    let bank = BlockWorld(|x, y, _| {
        Some(match (x, y) {
            (_, ..2) | (1.., 2) => blocks::STONE,
            (_, 2) => blocks::WATER,
            _ => blocks::AIR,
        })
    });
    let mut p = Player::new([0.5, 2.0, 0.5]);
    let input = Input {
        strafe: -1.0,
        jump: true,
        ..Input::default()
    };
    let mut kicked = false;
    for _ in 0..20 {
        p.tick(input, &bank);
        kicked |= p.in_water && p.velocity[1] == 0.3;
        if p.position[0] > 1.3 {
            assert!(kicked);
            assert!(p.position[1] >= 3.0);
            return;
        }
    }
    panic!("swimmer failed to reach the bank: {p:?}");
}
#[test]
fn jump_apex_and_landing() {
    let mut p = grounded();
    let mut apex = 0.0_f64;
    for tick in 0..30 {
        p.tick(
            Input {
                jump: tick == 0,
                ..Input::default()
            },
            &flat,
        );
        apex = apex.max(p.position[1]);
        assert!(p.is_clear(&flat));
    }
    assert!((apex - 1.2522).abs() < 0.0001, "{apex}");
    assert_eq!(p.position[1], 0.0);
    assert!(p.on_ground);
}
#[test]
fn terminal_walking_sprinting_sneaking_and_diagonal() {
    for (sprint, sneak, expected) in [
        (false, false, 4.317),
        (true, false, 5.612),
        (false, true, 1.295),
    ] {
        let mut p = grounded();
        for _ in 0..100 {
            p.tick(
                Input {
                    forward: 1.0,
                    sprint,
                    sneak,
                    ..Input::default()
                },
                &flat,
            );
        }
        let before = p.position[2];
        p.tick(
            Input {
                forward: 1.0,
                sprint,
                sneak,
                ..Input::default()
            },
            &flat,
        );
        let speed = (p.position[2] - before) * 20.0;
        assert!((speed - expected).abs() < 0.001, "{speed} != {expected}");
    }
    let mut p = grounded();
    for _ in 0..100 {
        p.tick(
            Input {
                forward: 1.0,
                strafe: 1.0,
                ..Input::default()
            },
            &flat,
        );
    }
    let before = p.position;
    p.tick(
        Input {
            forward: 1.0,
            strafe: 1.0,
            ..Input::default()
        },
        &flat,
    );
    let speed =
        ((p.position[0] - before[0]).powi(2) + (p.position[2] - before[2]).powi(2)).sqrt() * 20.0;
    assert!(speed < 4.407 && speed > 4.316, "{speed}");
    // Java applies 0.98 before normalization, so diagonal input is up to 1/0.98 faster.
    assert!((p.position[0] - 0.5 + p.position[2] - 0.5).abs() < 1e-10);
}
#[test]
fn wall_stops_fast_motion_and_slides() {
    let wall = |x, y, z| {
        if x == 2 {
            Some(Aabb::block(x, y, z))
        } else {
            flat(x, y, z)
        }
    };
    let mut p = grounded();
    p.velocity = [10.0, -0.08, 0.25];
    p.tick(Input::default(), &wall);
    assert_eq!(p.position[0], 2.0 - WIDTH / 2.0);
    assert_eq!(p.velocity[0], 0.0);
    assert!(p.position[2] > 0.5);
    assert!(p.is_clear(&wall));
}
#[test]
fn steps_half_block_but_not_full_block_or_under_low_ceiling() {
    for (height, ceiling, climbs) in [
        (0.5, false, true),
        (0.6, false, true),
        (1.0, false, false),
        (0.5, true, false),
    ] {
        let world = |x, y, z| {
            if ceiling && y == 2 {
                return Some(Aabb::block(x, y, z));
            }
            if x == 1 && y == 0 {
                let mut b = Aabb::block(x, y, z);
                b.max[1] = height;
                return Some(b);
            }
            flat(x, y, z)
        };
        let mut p = grounded();
        for _ in 0..12 {
            p.tick(
                Input {
                    strafe: -1.0,
                    ..Input::default()
                },
                &world,
            );
            assert!(p.is_clear(&world), "{p:?}");
        }
        assert_eq!(
            p.position[0] > 1.0,
            climbs,
            "height={height} ceiling={ceiling}: {p:?}"
        );
    }
}
#[test]
fn sneak_prevents_falling_at_edges_and_corners() {
    let island = |x, y, z| (x == 0 && z == 0 && y == -1).then(|| Aabb::block(x, y, z));
    for strafe in [0.0, -1.0] {
        let mut p = grounded();
        for _ in 0..200 {
            p.tick(
                Input {
                    forward: 1.0,
                    strafe,
                    sneak: true,
                    ..Input::default()
                },
                &island,
            );
            assert_eq!(p.position[1], 0.0);
            assert!(p.on_ground);
        }
        assert!(p.position[2] < 1.0 + WIDTH / 2.0);
    }
    let mut p = grounded();
    for _ in 0..30 {
        p.tick(
            Input {
                forward: 1.0,
                ..Input::default()
            },
            &island,
        );
    }
    assert!(p.position[1] < -1.0);
}
#[test]
fn ceiling_cancels_vertical_velocity() {
    let world = |x, y, z| {
        if y == 2 {
            Some(Aabb::block(x, y, z))
        } else {
            flat(x, y, z)
        }
    };
    let mut p = grounded();
    p.tick(
        Input {
            jump: true,
            ..Input::default()
        },
        &world,
    );
    assert_eq!(p.position[1], 2.0 - HEIGHT);
    assert!(p.velocity[1] < 0.0);
    assert!(p.is_clear(&world));
}
#[test]
fn flight_inertia_gravity_and_collisions() {
    let mut p = Player::new([0.5, 5.0, 0.5]);
    for _ in 0..20 {
        p.tick(
            Input {
                flying: true,
                ..Input::default()
            },
            &flat,
        );
    }
    assert_eq!(p.position, [0.5, 5.0, 0.5]);
    for _ in 0..150 {
        p.tick(
            Input {
                forward: 1.0,
                jump: true,
                flying: true,
                ..Input::default()
            },
            &flat,
        );
    }
    let before = p.position;
    p.tick(
        Input {
            forward: 1.0,
            jump: true,
            flying: true,
            ..Input::default()
        },
        &flat,
    );
    assert!(((p.position[2] - before[2]) * 20.0 - 10.889).abs() < 0.001);
    assert!(((p.position[1] - before[1]) * 20.0 - 7.5).abs() < 0.001);
    let velocity = p.velocity;
    p.tick(
        Input {
            flying: true,
            ..Input::default()
        },
        &flat,
    );
    assert!(p.velocity[2] > 0.0 && p.velocity[2] < velocity[2]);
    p = Player::new([0.5, 0.1, 0.5]);
    for _ in 0..20 {
        p.tick(
            Input {
                flying: true,
                sneak: true,
                ..Input::default()
            },
            &flat,
        );
    }
    assert_eq!(p.position[1], 0.0);
    assert!(p.is_clear(&flat));
}
#[test]
fn yaw_and_sprint_jump_follow_camera() {
    for (yaw, axis, sign) in [
        (0.0, 2, 1.0),
        (90.0, 0, -1.0),
        (180.0, 2, -1.0),
        (270.0, 0, 1.0),
    ] {
        let mut p = grounded();
        let before = p.position;
        p.tick(
            Input {
                forward: 1.0,
                jump: true,
                sprint: true,
                yaw,
                ..Input::default()
            },
            &flat,
        );
        assert!((p.position[axis] - before[axis]) * sign > 0.32);
    }
}
#[test]
fn fixed_tick_trajectory() {
    let mut p = grounded();
    for line in include_str!("trajectory.csv")
        .lines()
        .filter(|l| !l.starts_with('#'))
    {
        let fields: Vec<&str> = line.split(',').collect();
        let tick: usize = fields[0].parse().unwrap();
        let flags: u8 = fields[1].parse().unwrap();
        p.tick(
            Input {
                forward: 1.0,
                jump: flags & 1 != 0,
                sprint: flags & 2 != 0,
                ..Input::default()
            },
            &flat,
        );
        for (a, value) in p.position.into_iter().chain(p.velocity).enumerate() {
            let expected: f64 = fields[a + 2].parse().unwrap();
            assert!(
                (value - expected).abs() < 1e-14,
                "tick {tick}, component {a}: {value} != {expected}"
            );
        }
        assert_eq!(p.on_ground, fields[8] == "1", "tick {tick}");
    }
}

#[test]
fn fixed_flight_trajectory_with_rotations() {
    let mut p = Player::new([0.5, 5.0, 0.5]);
    for line in include_str!("flight.csv")
        .lines()
        .filter(|l| !l.starts_with('#'))
    {
        let values: Vec<f64> = line.split(',').map(|v| v.parse().unwrap()).collect();
        let flags = values[4] as u8;
        p.tick(
            Input {
                forward: values[1] as f32,
                strafe: values[2] as f32,
                yaw: values[3] as f32,
                jump: flags & 1 != 0,
                sprint: flags & 2 != 0,
                sneak: flags & 4 != 0,
                flying: true,
            },
            &flat,
        );
        for (a, value) in p.position.into_iter().chain(p.velocity).enumerate() {
            assert!(
                (value - values[a + 5]).abs() < 1e-14,
                "tick {}, component {a}: {value} != {}",
                values[0],
                values[a + 5]
            );
        }
        assert!(!p.on_ground);
    }
}

#[test]
fn registry_shapes_step_under_top_slabs_and_pass_through_plants() {
    use world::blocks;
    for (obstacle, roof, climbs, passes) in [
        (blocks::OAK_SLAB, false, true, true),
        (blocks::OAK_SLAB + 2, false, false, false),
        (blocks::OAK_SLAB + 1, true, false, true),
        (blocks::OAK_SLAB, true, false, false),
        (blocks::RED_FLOWER, false, false, true),
        (blocks::YELLOW_FLOWER, false, false, true),
        (blocks::SHORT_GRASS, false, false, true),
    ] {
        let world = physics::BlockWorld(|x, y, _z| {
            Some(if roof && y == 0 {
                blocks::OAK_SLAB
            } else if y < 0 {
                blocks::STONE
            } else if x == 1 && y == if roof { 2 } else { 0 } {
                obstacle
            } else {
                blocks::AIR
            })
        });
        let floor = if roof { 0.5 } else { 0.0 };
        let mut player = Player::new([0.5, floor, 0.5]);
        let mut highest = floor;
        for _ in 0..18 {
            player.tick(
                Input {
                    strafe: -1.0,
                    ..Input::default()
                },
                &world,
            );
            highest = highest.max(player.position[1]);
            assert!(player.is_clear(&world), "{obstacle} {player:?}");
        }
        assert_eq!(
            player.position[0] > 1.0,
            passes,
            "{obstacle} roof={roof}: {player:?}"
        );
        assert_eq!(highest > floor + 0.49, climbs, "{obstacle} roof={roof}");
    }
}

#[test]
fn ray_box_faces_parallel_misses_and_inside_exits() {
    let bounds = physics::shape_box(
        world::blocks::Box16 {
            min: [0, 0, 0],
            max: [16, 8, 16],
        },
        -3,
        -2,
        4,
    );
    for (origin, dir, expected) in [
        ([-4.0, -1.75, 4.5], [1.0, 0.0, 0.0], Some((1.0, 4))),
        ([-2.5, 0.0, 4.5], [0.0, -1.0, 0.0], Some((1.5, 1))),
        ([-2.5, -3.0, 4.5], [0.0, 1.0, 0.0], Some((1.0, 0))),
        ([-2.5, -1.75, 4.5], [1.0, 0.0, 0.0], Some((0.5, 5))),
        ([-4.0, -1.25, 4.5], [1.0, 0.0, 0.0], None),
        ([-4.0, -1.75, 4.5], [-1.0, 0.0, 0.0], None),
    ] {
        assert_eq!(physics::ray_box(origin, dir, bounds), expected);
    }
}

#[test]
fn registry_staircase_walks_up_two_blocks_without_jumping() {
    use world::blocks;
    for stairs in [blocks::OAK_STAIRS, blocks::COBBLESTONE_STAIRS] {
        let world = physics::BlockWorld(|x, y, _| {
            Some(if y < 0 || (x >= 2 && y == 0) || (x >= 3 && y == 1) {
                blocks::STONE
            } else if (x == 1 && y == 0) || (x == 2 && y == 1) {
                stairs + 6
            } else {
                blocks::AIR
            })
        });
        let mut p = grounded();
        let mut heights = Vec::new();
        for _ in 0..24 {
            p.tick(
                Input {
                    strafe: -1.0,
                    ..Input::default()
                },
                &world,
            );
            heights.push(p.position[1]);
            assert!(p.is_clear(&world));
        }
        for height in [0.5, 1.0, 1.5, 2.0] {
            assert!(heights.contains(&height), "{heights:?}");
        }
        assert!(p.position[0] > 3.0);
        assert_eq!(p.position[1], 2.0);
    }
}

#[test]
fn fence_stops_walking_jumping_and_airborne_sweeps() {
    use world::blocks;
    let world = physics::BlockWorld(|x, y, _| {
        Some(if y < 0 {
            blocks::STONE
        } else if x == 1 && y == 0 {
            blocks::OAK_FENCE
        } else {
            blocks::AIR
        })
    });
    for jump in [false, true] {
        let mut p = grounded();
        let mut apex = 0.0_f64;
        for _ in 0..60 {
            p.tick(
                Input {
                    strafe: -1.0,
                    jump,
                    ..Input::default()
                },
                &world,
            );
            apex = apex.max(p.position[1]);
            assert!(p.is_clear(&world));
            assert!(p.position[0] <= 1.375 - WIDTH / 2.0);
        }
        if jump {
            assert!(apex > 1.25 && apex < 1.26);
        }
    }
    // The entire player is above the fence's owner cell. Its protruding box
    // still blocks both overlap checks and a horizontal server/prediction sweep.
    let p = Player::new([0.5, 1.1, 0.5]);
    let delta = physics::resolve(&world, p.bounds(), [3.0, 0.0, 0.0]);
    assert_eq!(delta[0], 1.375 - WIDTH / 2.0 - 0.5);
    assert!(!Player::new([1.5, 1.1, 0.5]).is_clear(&world));
    assert_eq!(
        physics::resolve(
            &world,
            Player::new([0.5, 1.5, 0.5]).bounds(),
            [3.0, 0.0, 0.0]
        ),
        [3.0, 0.0, 0.0]
    );
}

#[test]
fn custom_body_lands_steps_and_stops_at_its_wider_wall_contact() {
    let terrain = |x, y, z| {
        if y < 0 || (z == 5 && (0..3).contains(&y)) {
            Some(Aabb::block(x, y, z))
        } else if z >= 2 && y == 0 {
            let mut slab = Aabb::block(x, y, z);
            slab.max[1] = 0.5;
            Some(slab)
        } else {
            None
        }
    };
    let mut body = Player::with_size([0.5, 2.0, 0.5], 0.9, 1.3);
    for _ in 0..20 {
        body.tick(Input::default(), &terrain);
    }
    assert!(body.on_ground);
    assert_eq!(body.position[1], 0.0);
    assert_eq!(body.bounds().max[1], 1.3);
    let walk = Input {
        forward: 0.5,
        ..Input::default()
    };
    for _ in 0..100 {
        body.tick(walk, &terrain);
    }
    assert!(body.on_ground);
    assert_eq!(body.position[1], 0.5);
    assert_eq!(body.position[2], 5.0 - 0.45);
    assert_eq!(body.velocity[2], 0.0);
}
