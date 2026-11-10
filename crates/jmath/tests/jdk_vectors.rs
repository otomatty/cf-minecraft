//! Compares this crate against values printed by a real JDK
//! (`tools/oracle/JdkVectors.java`).

use jmath::{JavaRandom, Xoroshiro128PlusPlus};

const VECTORS: &str = include_str!("vectors/jdk.txt");

fn nums(parts: &[&str]) -> Vec<i64> {
    parts
        .iter()
        .map(|p| p.parse::<i64>().expect("number"))
        .collect()
}

#[test]
fn java_util_random_matches_jdk() {
    let mut checked = 0;
    for line in VECTORS.lines().filter(|l| l.starts_with("R ")) {
        let parts: Vec<&str> = line.split(' ').collect();
        let seed: i64 = parts[1].parse().unwrap();
        let mut r = JavaRandom::new(seed);
        match parts[2] {
            "nextInt" => {
                for want in nums(&parts[3..]) {
                    assert_eq!(r.next_int() as i64, want, "{line}");
                }
            }
            "nextIntBound" => {
                let bound: i32 = parts[3].parse().unwrap();
                for want in nums(&parts[4..]) {
                    assert_eq!(r.next_int_bound(bound) as i64, want, "{line}");
                }
            }
            "nextLong" => {
                for want in nums(&parts[3..]) {
                    assert_eq!(r.next_long(), want, "{line}");
                }
            }
            "nextFloatBits" => {
                for want in nums(&parts[3..]) {
                    assert_eq!(r.next_float().to_bits() as i32 as i64, want, "{line}");
                }
            }
            "nextDoubleBits" => {
                for want in nums(&parts[3..]) {
                    assert_eq!(r.next_double().to_bits() as i64, want, "{line}");
                }
            }
            "nextBoolean" => {
                for want in nums(&parts[3..]) {
                    assert_eq!(r.next_boolean() as i64, want, "{line}");
                }
            }
            "mixed" => {
                let want = nums(&parts[3..]);
                for chunk in want.chunks(6) {
                    assert_eq!(r.next_int() as i64, chunk[0], "{line}");
                    assert_eq!(r.next_int_bound(100) as i64, chunk[1], "{line}");
                    assert_eq!(r.next_long(), chunk[2], "{line}");
                    assert_eq!(r.next_double().to_bits() as i64, chunk[3], "{line}");
                    assert_eq!(r.next_float().to_bits() as i32 as i64, chunk[4], "{line}");
                    assert_eq!(r.next_boolean() as i64, chunk[5], "{line}");
                }
            }
            other => panic!("unknown vector kind {other}"),
        }
        checked += 1;
    }
    assert!(checked > 100, "only {checked} vector lines were checked");
}

#[test]
fn xoroshiro_transition_matches_jdk() {
    let mut checked = 0;
    for line in VECTORS.lines().filter(|l| l.starts_with("X ")) {
        let parts: Vec<&str> = line.split(' ').collect();
        let lo: i64 = parts[1].parse().unwrap();
        let hi: i64 = parts[2].parse().unwrap();
        let mut x = Xoroshiro128PlusPlus::from_state(lo, hi);
        for want in nums(&parts[4..]) {
            assert_eq!(x.next_long(), want, "{line}");
        }
        checked += 1;
    }
    assert_eq!(checked, 5);
}
