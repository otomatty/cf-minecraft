//! Reference values come only from Java APIs, never game code.
use jmath::{sin_table, strict_math, JavaRandom};

const VECTORS: &str = include_str!("vectors/jdk.txt");

fn hex(s: &str) -> u64 {
    u64::from_str_radix(s, 16).unwrap()
}

// StrictMath specifies NaN, but Java does not specify its sign or payload.
// Match Double.doubleToLongBits in the oracle; every other bit is compared.
fn bits(x: f64) -> u64 {
    if x.is_nan() {
        0x7ff8000000000000
    } else {
        x.to_bits()
    }
}

#[test]
fn strict_math_matches_jdk() {
    let names = [
        "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "log", "log10", "exp", "pow",
    ];
    let mut counts = [0; 11];
    let mut failures = Vec::new();
    for line in VECTORS.lines().filter(|l| l.starts_with("M ")) {
        let p: Vec<_> = line.split_whitespace().collect();
        let x = f64::from_bits(hex(p[2]));
        let y = f64::from_bits(hex(p[3]));
        let result = match p[1] {
            "sin" => strict_math::sin(x),
            "cos" => strict_math::cos(x),
            "tan" => strict_math::tan(x),
            "asin" => strict_math::asin(x),
            "acos" => strict_math::acos(x),
            "atan" => strict_math::atan(x),
            "atan2" => strict_math::atan2(x, y),
            "log" => strict_math::log(x),
            "log10" => strict_math::log10(x),
            "exp" => strict_math::exp(x),
            "pow" => strict_math::pow(x, y),
            name => panic!("unknown function {name}"),
        };
        counts[names.iter().position(|name| *name == p[1]).unwrap()] += 1;
        let want = hex(p.last().unwrap());
        if bits(result) != want && failures.len() < 30 {
            failures.push(format!("{line}: got {:016x}", bits(result)));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    for (name, count) in names.into_iter().zip(counts) {
        assert!(count > 1000, "only {count} vectors for {name}");
    }
}

#[test]
fn gaussian_matches_jdk_and_resets_cache() {
    let mut checked = 0;
    for line in VECTORS.lines().filter(|l| l.starts_with("G ")) {
        let p: Vec<_> = line.split_whitespace().collect();
        let seed = p[1].parse().unwrap();
        let mut r = JavaRandom::new(seed);
        match p[2] {
            "sequence" => {
                assert_eq!(p.len() - 3, 64);
                for want in &p[3..] {
                    assert_eq!(r.next_gaussian().to_bits(), hex(want), "{line}");
                }
            }
            "mixed" => {
                assert_eq!(p.len(), 62);
                for chunk in p[3..54].as_chunks::<3>().0 {
                    assert_eq!(r.next_gaussian().to_bits(), hex(chunk[0]), "{line}");
                    assert_eq!(r.next_double().to_bits(), hex(chunk[1]), "{line}");
                    assert_eq!(r.next_long(), chunk[2].parse::<i64>().unwrap(), "{line}");
                }
                for reset in p[54..].as_chunks::<4>().0 {
                    r.set_seed(seed);
                    for want in reset {
                        assert_eq!(r.next_gaussian().to_bits(), hex(want), "{line}");
                    }
                }
            }
            name => panic!("unknown Gaussian vector {name}"),
        }
        checked += 1;
    }
    assert_eq!(checked, 18);
}

#[test]
fn gaussian_clone_preserves_cached_sample_and_rng_state() {
    let mut r = JavaRandom::new(42);
    r.next_gaussian();
    let mut copy = r.clone();
    for _ in 0..16 {
        assert_eq!(r.next_gaussian().to_bits(), copy.next_gaussian().to_bits());
        assert_eq!(r.next_long(), copy.next_long());
    }
    assert_eq!(r, copy);
}

#[test]
fn entire_sine_table_matches_jdk() {
    let mut checked = 0;
    for line in VECTORS.lines().filter(|l| l.starts_with("T ")) {
        let p: Vec<_> = line.split_whitespace().collect();
        let i: usize = p[1].parse().unwrap();
        assert_eq!(i, checked);
        assert_eq!(sin_table::SIN[i].to_bits() as u64, hex(p[2]), "{line}");
        checked += 1;
    }
    assert_eq!(checked, 65536);
}

#[test]
fn float_lookup_and_java_integer_conversion_match_jdk() {
    let mut checked = 0;
    for line in VECTORS.lines().filter(|l| l.starts_with("L ")) {
        let p: Vec<_> = line.split_whitespace().collect();
        let x = f32::from_bits(hex(p[1]) as u32);
        assert_eq!(x as i32, p[2].parse::<i32>().unwrap(), "{line}");
        assert_eq!(
            (x * 10430.378_f32) as i32 & 65535,
            p[3].parse::<i32>().unwrap(),
            "{line}"
        );
        assert_eq!(
            (x * 10430.378_f32 + 16384.0_f32) as i32 & 65535,
            p[4].parse::<i32>().unwrap(),
            "{line}"
        );
        assert_eq!(sin_table::sin(x).to_bits() as u64, hex(p[5]), "{line}");
        assert_eq!(sin_table::cos(x).to_bits() as u64, hex(p[6]), "{line}");
        checked += 1;
    }
    assert!(checked > 1000);
}
