use std::collections::BTreeMap;

use crate::blocks;
use crate::io::{DecodeError, Reader, Writer};
use crate::palette::{PalettedContainer, SIZE};
use crate::{section_index, BlockState, MIN_Y, SECTIONS};

/// One 16x16x16 cube of block states.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Section {
    pub states: PalettedContainer,
    /// Number of non-air blocks, kept in sync by `set`.
    pub non_air: u16,
}

impl Section {
    pub fn uniform(state: BlockState) -> Self {
        Self {
            states: PalettedContainer::single(state),
            non_air: if state == blocks::AIR { 0 } else { SIZE as u16 },
        }
    }

    /// Index inside a section, Java order: `(y << 8) | (z << 4) | x`.
    #[inline]
    pub fn index(x: usize, y: usize, z: usize) -> usize {
        (y << 8) | (z << 4) | x
    }

    #[inline]
    pub fn get(&self, x: usize, y: usize, z: usize) -> BlockState {
        self.states.get(Self::index(x, y, z))
    }

    pub fn set(&mut self, x: usize, y: usize, z: usize, state: BlockState) -> BlockState {
        let old = self.states.set(Self::index(x, y, z), state);
        if old != state {
            if old == blocks::AIR {
                self.non_air += 1;
            } else if state == blocks::AIR {
                self.non_air -= 1;
            }
        }
        old
    }

    pub fn is_empty(&self) -> bool {
        self.non_air == 0
    }
}

/// A full-height chunk column.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chunk {
    pub cx: i32,
    pub cz: i32,
    pub sections: Vec<Section>,
    /// Changed since it was last handed to storage.
    pub dirty: bool,
}

impl Chunk {
    pub fn empty(cx: i32, cz: i32) -> Self {
        Self {
            cx,
            cz,
            sections: vec![Section::uniform(blocks::AIR); SECTIONS],
            dirty: false,
        }
    }

    /// Block at chunk-local x/z and world y. Outside the build height is air.
    #[inline]
    pub fn get(&self, x: usize, y: i32, z: usize) -> BlockState {
        match section_index(y) {
            Some(s) => self.sections[s].get(x, ((y - MIN_Y) & 15) as usize, z),
            None => blocks::AIR,
        }
    }

    /// Returns the previous state, or `None` outside the build height.
    pub fn set(&mut self, x: usize, y: i32, z: usize, state: BlockState) -> Option<BlockState> {
        let s = section_index(y)?;
        Some(self.sections[s].set(x, ((y - MIN_Y) & 15) as usize, z, state))
    }

    pub fn write(&self, w: &mut Writer) {
        for section in &self.sections {
            w.u16(section.non_air);
            section.states.write(w);
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut w = Writer::with_capacity(4096);
        self.write(&mut w);
        w.finish()
    }

    pub fn read(cx: i32, cz: i32, r: &mut Reader) -> Result<Self, DecodeError> {
        let mut sections = Vec::with_capacity(SECTIONS);
        for _ in 0..SECTIONS {
            let claimed = r.u16()?;
            let states = PalettedContainer::read(r, blocks::COUNT)?;
            // Recount instead of trusting the stored counter.
            let non_air = states.count(|s| s != blocks::AIR) as u16;
            if claimed != non_air {
                return Err(DecodeError);
            }
            sections.push(Section { states, non_air });
        }
        if r.remaining() != 0 {
            return Err(DecodeError);
        }
        Ok(Self {
            cx,
            cz,
            sections,
            dirty: false,
        })
    }

    pub fn hash_into(&self, h: &mut Fnv64) {
        h.i32(self.cx);
        h.i32(self.cz);
        for section in &self.sections {
            match section.states.uniform() {
                Some(v) => {
                    h.u8(0xFF);
                    h.u16(v);
                }
                None => {
                    h.u8(0x01);
                    for i in 0..SIZE {
                        h.u16(section.states.get(i));
                    }
                }
            }
        }
    }
}

/// Loaded chunks, ordered by coordinate so iteration is deterministic.
#[derive(Default)]
pub struct World {
    pub chunks: BTreeMap<(i32, i32), Chunk>,
}

impl World {
    pub fn new() -> Self {
        Self::default()
    }

    #[inline]
    pub fn get_block(&self, x: i32, y: i32, z: i32) -> Option<BlockState> {
        self.chunks
            .get(&(x >> 4, z >> 4))
            .map(|c| c.get((x & 15) as usize, y, (z & 15) as usize))
    }

    /// Returns the previous state; `None` when the chunk is not loaded or y is out of range.
    pub fn set_block(&mut self, x: i32, y: i32, z: i32, state: BlockState) -> Option<BlockState> {
        let chunk = self.chunks.get_mut(&(x >> 4, z >> 4))?;
        let old = chunk.set((x & 15) as usize, y, (z & 15) as usize, state)?;
        if old != state {
            chunk.dirty = true;
        }
        Some(old)
    }

    pub fn hash_into(&self, h: &mut Fnv64) {
        for chunk in self.chunks.values() {
            chunk.hash_into(h);
        }
    }
}

/// FNV-1a, 64 bit. Used for state fingerprints only, never for security.
pub struct Fnv64(pub u64);

impl Default for Fnv64 {
    fn default() -> Self {
        Self::new()
    }
}

impl Fnv64 {
    pub fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }

    #[inline]
    pub fn u8(&mut self, b: u8) {
        self.0 = (self.0 ^ b as u64).wrapping_mul(0x0000_0100_0000_01B3);
    }

    pub fn bytes(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.u8(b);
        }
    }

    pub fn u16(&mut self, v: u16) {
        self.bytes(&v.to_le_bytes());
    }

    pub fn i32(&mut self, v: i32) {
        self.bytes(&v.to_le_bytes());
    }

    pub fn i64(&mut self, v: i64) {
        self.bytes(&v.to_le_bytes());
    }

    pub fn finish(&self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negative_coordinates_map_to_the_right_chunk_and_section() {
        let mut w = World::new();
        w.chunks.insert((-1, -1), Chunk::empty(-1, -1));
        assert_eq!(w.set_block(-1, -64, -1, blocks::STONE), Some(blocks::AIR));
        let c = &w.chunks[&(-1, -1)];
        assert_eq!(c.get(15, -64, 15), blocks::STONE);
        assert_eq!(c.sections[0].non_air, 1);
        assert!(c.dirty);
        // Outside the build height or in an unloaded chunk nothing happens.
        assert_eq!(w.set_block(-1, 320, -1, blocks::STONE), None);
        assert_eq!(w.set_block(-1, -65, -1, blocks::STONE), None);
        assert_eq!(w.set_block(0, 0, 0, blocks::STONE), None);
        assert_eq!(w.get_block(-1, 319, -1), Some(blocks::AIR));
    }

    #[test]
    fn chunk_round_trip_and_tamper_detection() {
        let mut c = Chunk::empty(3, -7);
        for i in 0..2000 {
            c.set(
                i % 16,
                (i as i32 % 384) - 64,
                (i / 16) % 16,
                (i % 10) as u16,
            );
        }
        let bytes = c.to_bytes();
        let mut back = Chunk::read(3, -7, &mut Reader::new(&bytes)).unwrap();
        back.dirty = c.dirty;
        assert_eq!(back, c);

        // Wrong non-air counter is rejected.
        let mut bad = bytes.clone();
        bad[1] ^= 1;
        assert!(Chunk::read(3, -7, &mut Reader::new(&bad)).is_err());
        // Trailing garbage is rejected.
        let mut long = bytes.clone();
        long.push(0);
        assert!(Chunk::read(3, -7, &mut Reader::new(&long)).is_err());
    }
}
