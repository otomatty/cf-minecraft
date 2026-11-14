use physics::{Aabb, Input, Player, HEIGHT, WIDTH};

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
