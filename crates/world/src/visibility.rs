//! Conservative section connectivity and camera-outward visibility traversal.
use crate::{blocks, Section, SECTIONS};

pub type Key = (i32, i32, i32);
pub const ALL: u16 = (1 << 15) - 1;
// Down, up, north, south, west, east. Opposites differ in the low bit.
const DIRECTIONS: [Key; 6] = [
    (0, -1, 0),
    (0, 1, 0),
    (0, 0, -1),
    (0, 0, 1),
    (-1, 0, 0),
    (1, 0, 0),
];

/// The single numbering convention for unordered face pairs.
pub fn pair(a: usize, b: usize) -> u16 {
    if a == b {
        return 0;
    }
    let (a, b) = if a < b { (a, b) } else { (b, a) };
    1 << (a * (11 - a) / 2 + b - a - 1)
}

pub struct Connectivity {
    cells: [bool; 4096],
    queue: [usize; 4096],
}
impl Default for Connectivity {
    fn default() -> Self {
        Self {
            cells: [false; 4096],
            queue: [0; 4096],
        }
    }
}
impl Connectivity {
    pub fn compute(&mut self, section: &Section) -> u16 {
        if let Some(state) = section.states.uniform() {
            return if blocks::occludes(state) { 0 } else { ALL };
        }
        for (i, cell) in self.cells.iter_mut().enumerate() {
            *cell = !blocks::occludes(section.states.get(i));
        }
        let mut result = 0;
        for start in 0..4096 {
            if !self.cells[start] {
                continue;
            }
            self.cells[start] = false;
            self.queue[0] = start;
            let (mut head, mut tail, mut faces) = (0, 1, 0u8);
            while head < tail {
                let i = self.queue[head];
                head += 1;
                let (x, y, z) = (i & 15, i >> 8, (i >> 4) & 15);
                for (f, boundary) in [y == 0, y == 15, z == 0, z == 15, x == 0, x == 15]
                    .into_iter()
                    .enumerate()
                {
                    if boundary {
                        faces |= 1 << f;
                        continue;
                    }
                    let n = (i as isize + [-256, 256, -16, 16, -1, 1][f]) as usize;
                    if self.cells[n] {
                        self.cells[n] = false;
                        self.queue[tail] = n;
                        tail += 1;
                    }
                }
            }
            for a in 0..6 {
                for b in a + 1..6 {
                    if faces & (1 << a) != 0 && faces & (1 << b) != 0 {
                        result |= pair(a, b);
                    }
                }
            }
            if result == ALL {
                break;
            }
        }
        result
    }
}

/// Dense reusable traversal storage; each outgoing face is expanded at most once.
#[derive(Default)]
pub struct Search {
    pub visible: Vec<bool>,
    exits: Vec<u8>,
    queue: Vec<(Key, usize)>,
    bounds: [i32; 4],
}
impl Search {
    fn index(&self, (x, y, z): Key) -> Option<usize> {
        let [min_x, max_x, min_z, max_z] = self.bounds;
        if x < min_x || x > max_x || z < min_z || z > max_z || !(0..SECTIONS as i32).contains(&y) {
            return None;
        }
        Some((((z - min_z) * (max_x - min_x + 1) + x - min_x) as usize) * SECTIONS + y as usize)
    }
    pub fn contains(&self, key: Key) -> bool {
        self.index(key).is_some_and(|i| self.visible[i])
    }
    pub fn run(&mut self, camera: Key, bounds: [i32; 4], mut connectivity: impl FnMut(Key) -> u16) {
        self.bounds = bounds;
        let n = ((bounds[1] - bounds[0] + 1) * (bounds[3] - bounds[2] + 1)) as usize * SECTIONS;
        self.visible.clear();
        self.visible.resize(n, false);
        self.exits.clear();
        self.exits.resize(n, 0);
        self.queue.clear();
        if self.index(camera).is_none() {
            self.visible.fill(true);
            return;
        }
        self.queue.push((camera, 6));
        let mut head = 0;
        while head < self.queue.len() {
            let (key, entry) = self.queue[head];
            head += 1;
            let i = self.index(key).unwrap();
            self.visible[i] = true;
            let connections = if entry == 6 { ALL } else { connectivity(key) };
            for (f, &(dx, dy, dz)) in DIRECTIONS.iter().enumerate() {
                if self.exits[i] & (1 << f) != 0
                    || (entry != 6 && connections & pair(entry, f) == 0)
                {
                    continue;
                }
                let next = (key.0 + dx, key.1 + dy, key.2 + dz);
                // Each step must increase distance along its own axis.
                if (dx != 0 && (next.0 - camera.0).abs() <= (key.0 - camera.0).abs())
                    || (dy != 0 && (next.1 - camera.1).abs() <= (key.1 - camera.1).abs())
                    || (dz != 0 && (next.2 - camera.2).abs() <= (key.2 - camera.2).abs())
                {
                    continue;
                }
                self.exits[i] |= 1 << f;
                if self.index(next).is_some() {
                    self.queue.push((next, f ^ 1));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connectivity_components_and_materials() {
        let mut work = Connectivity::default();
        assert_eq!(work.compute(&Section::uniform(blocks::AIR)), ALL);
        assert_eq!(work.compute(&Section::uniform(blocks::STONE)), 0);
        for material in [
            blocks::GLASS,
            blocks::OAK_LEAVES,
            blocks::WATER,
            blocks::OAK_SLAB,
            blocks::OAK_STAIRS,
            blocks::OAK_FENCE,
            blocks::SHORT_GRASS,
        ] {
            assert_eq!(work.compute(&Section::uniform(material)), ALL);
        }
        let mut section = Section::uniform(blocks::STONE);
        for x in 0..16 {
            section.set(x, 8, 8, blocks::AIR);
        }
        assert_eq!(work.compute(&section), pair(4, 5));
        section = Section::uniform(blocks::STONE);
        section.set(8, 8, 8, blocks::AIR);
        assert_eq!(work.compute(&section), 0);
        // L-shaped down-to-north passage.
        for y in 0..=8 {
            section.set(8, y, 8, blocks::AIR);
        }
        for z in 0..=8 {
            section.set(8, 8, z, blocks::AIR);
        }
        assert_eq!(work.compute(&section), pair(0, 2));
        // A disjoint west-to-east passage must not connect to the L.
        for x in 0..16 {
            section.set(x, 12, 12, blocks::AIR);
        }
        assert_eq!(work.compute(&section), pair(0, 2) | pair(4, 5));
        let mut bits = 0;
        for a in 0..6 {
            for b in a + 1..6 {
                assert_eq!(pair(a, b), pair(b, a));
                assert_eq!(bits & pair(a, b), 0);
                bits |= pair(a, b);
            }
        }
        assert_eq!(bits, ALL);
    }

    #[test]
    fn underground_shaft_inside_glass_missing_and_outside() {
        let mut search = Search::default();
        let mut work = Connectivity::default();
        let mut roof = Section::uniform(blocks::STONE);
        let bounds = [-2, 2, -2, 2];
        let camera = (0, 3, 0);
        search.run(camera, bounds, |(_, y, _)| if y == 2 { 0 } else { ALL });
        assert!(!search.contains((0, 1, 0)));
        assert!(search.contains((0, 2, 0))); // The blocking surface itself is visible.
        for y in 0..16 {
            roof.set(8, y, 8, blocks::AIR);
        }
        let shaft = work.compute(&roof);
        search.run(camera, bounds, |k| {
            if k.1 == 2 {
                if k.0 == 0 && k.2 == 0 {
                    shaft
                } else {
                    0
                }
            } else {
                ALL
            }
        });
        assert!(search.contains((0, 1, 0)));
        search.run((0, 1, 0), bounds, |(_, y, _)| if y == 2 { 0 } else { ALL });
        assert!(search.contains((1, 1, 0)));
        let glass = work.compute(&Section::uniform(blocks::GLASS));
        search.run(camera, bounds, |_| glass);
        assert!(search.contains((0, 1, 0)));
        // Unknown column x=1 is fully connected; traversal reaches loaded x=2.
        search.run(camera, bounds, |k| if k.0 == 1 { ALL } else { pair(4, 5) });
        assert!(search.contains((2, 3, 0)));
        for y in [-1, SECTIONS as i32] {
            search.run((0, y, 0), bounds, |_| 0);
            assert!(search.visible.iter().all(|&v| v));
        }
    }

    #[test]
    fn multiple_entry_faces_and_no_backtracking() {
        let mut search = Search::default();
        search.run((0, 3, 0), [-2, 2, -2, 2], |k| match k {
            (1, 3, 1) => pair(2, 5), // Need the north entry, not the west entry.
            (2, 3, 0) => 0,
            _ => ALL,
        });
        assert!(search.contains((2, 3, 1)));
        search.run((0, 3, 0), [-2, 2, -2, 2], |k| match k {
            (1, 3, 0) => pair(4, 5),
            (2, 3, 0) => pair(4, 3),
            (2, 3, 1) => pair(2, 4),
            (1, 3, 1) => pair(5, 3),
            _ => 0,
        });
        assert!(search.contains((2, 3, 1)));
        assert!(!search.contains((1, 3, 2))); // Would require moving back west.
    }

    /// Run with cargo test -p world --release visibility::tests::timing -- --nocapture.
    #[test]
    fn timing() {
        let mut search = Search::default();
        let bounds = [-12, 12, -12, 12];
        search.run((0, 10, 0), bounds, |_| ALL);
        let start = std::time::Instant::now();
        for _ in 0..100 {
            search.run((0, 10, 0), bounds, |_| ALL);
        }
        eprintln!(
            "visibility BFS: 15000 sections, {:?}/run (100 runs)",
            start.elapsed() / 100
        );
        assert!(search.visible.iter().all(|&v| v));
    }
}
