//! Paletted storage for the 4096 block states of one section, following the
//! Java Edition layout: a per-section palette plus a packed array of 64-bit
//! words in which entries never span two words.
//!
//! Bits per entry: 0 (one value for the whole section), 4..=8 (indirect, via
//! the palette), or `DIRECT_BITS` (state ids stored directly).

use crate::io::{DecodeError, Reader, Writer};
use crate::BlockState;

pub const SIZE: usize = 4096;
pub const DIRECT_BITS: u8 = 15;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PalettedContainer {
    bits: u8,
    palette: Vec<BlockState>,
    data: Vec<u64>,
}

fn words_for(bits: u8) -> usize {
    let per = 64 / bits as usize;
    SIZE.div_ceil(per)
}

impl PalettedContainer {
    pub fn single(value: BlockState) -> Self {
        Self {
            bits: 0,
            palette: vec![value],
            data: Vec::new(),
        }
    }

    pub fn bits(&self) -> u8 {
        self.bits
    }

    /// The value shared by every entry, when the section is uniform.
    pub fn uniform(&self) -> Option<BlockState> {
        (self.bits == 0).then(|| self.palette[0])
    }

    #[inline]
    fn raw_get(&self, i: usize) -> u32 {
        let b = self.bits as usize;
        let per = 64 / b;
        ((self.data[i / per] >> ((i % per) * b)) & ((1u64 << b) - 1)) as u32
    }

    #[inline]
    fn raw_set(&mut self, i: usize, v: u32) {
        let b = self.bits as usize;
        let per = 64 / b;
        let shift = (i % per) * b;
        let mask = ((1u64 << b) - 1) << shift;
        let word = &mut self.data[i / per];
        *word = (*word & !mask) | ((v as u64) << shift);
    }

    #[inline]
    pub fn get(&self, i: usize) -> BlockState {
        match self.bits {
            0 => self.palette[0],
            DIRECT_BITS => self.raw_get(i) as BlockState,
            _ => self.palette[self.raw_get(i) as usize],
        }
    }

    /// Sets entry `i` and returns the previous value.
    pub fn set(&mut self, i: usize, value: BlockState) -> BlockState {
        let old = self.get(i);
        if old == value {
            return old;
        }
        let raw = self.index_for(value);
        self.raw_set(i, raw);
        old
    }

    fn index_for(&mut self, value: BlockState) -> u32 {
        if self.bits == DIRECT_BITS {
            return value as u32;
        }
        // With bits == 0 the only palette entry is the current value, which
        // `set` has already ruled out, so a hit implies bits >= 4.
        if let Some(p) = self.palette.iter().position(|&v| v == value) {
            return p as u32;
        }
        let capacity = if self.bits == 0 {
            1
        } else {
            1usize << self.bits
        };
        if self.palette.len() >= capacity {
            self.grow();
            if self.bits == DIRECT_BITS {
                return value as u32;
            }
        }
        self.palette.push(value);
        (self.palette.len() - 1) as u32
    }

    fn grow(&mut self) {
        let bits = match self.bits {
            0 => 4,
            b if b < 8 => b + 1,
            _ => DIRECT_BITS,
        };
        let direct = bits == DIRECT_BITS;
        let mut next = Self {
            bits,
            palette: if direct {
                Vec::new()
            } else {
                self.palette.clone()
            },
            data: vec![0; words_for(bits)],
        };
        for i in 0..SIZE {
            let raw = if direct {
                self.get(i) as u32
            } else if self.bits == 0 {
                0
            } else {
                self.raw_get(i)
            };
            if raw != 0 {
                next.raw_set(i, raw);
            }
        }
        *self = next;
    }

    pub fn count(&self, pred: impl Fn(BlockState) -> bool) -> usize {
        match self.uniform() {
            Some(v) => {
                if pred(v) {
                    SIZE
                } else {
                    0
                }
            }
            None => (0..SIZE).filter(|&i| pred(self.get(i))).count(),
        }
    }

    pub fn write(&self, w: &mut Writer) {
        w.u8(self.bits);
        w.varint(self.palette.len() as u32);
        for &v in &self.palette {
            w.varint(v as u32);
        }
        w.varint(self.data.len() as u32);
        for &word in &self.data {
            w.i64(word as i64);
        }
    }

    /// Decodes and fully validates a container; stored or received bytes are
    /// never trusted.
    pub fn read(r: &mut Reader, max_state: BlockState) -> Result<Self, DecodeError> {
        let bits = r.u8()?;
        if !(bits == 0 || (4..=8).contains(&bits) || bits == DIRECT_BITS) {
            return Err(DecodeError);
        }
        let palette_len = r.varint()? as usize;
        let palette_ok = match bits {
            0 => palette_len == 1,
            DIRECT_BITS => palette_len == 0,
            b => (1..=(1usize << b)).contains(&palette_len),
        };
        if !palette_ok {
            return Err(DecodeError);
        }
        let mut palette = Vec::with_capacity(palette_len);
        for _ in 0..palette_len {
            let v = r.varint()?;
            if v >= max_state as u32 {
                return Err(DecodeError);
            }
            palette.push(v as BlockState);
        }
        let words = r.varint()? as usize;
        let expected = if bits == 0 { 0 } else { words_for(bits) };
        if words != expected {
            return Err(DecodeError);
        }
        let mut data = Vec::with_capacity(words);
        for _ in 0..words {
            data.push(r.i64()? as u64);
        }
        let c = Self {
            bits,
            palette,
            data,
        };
        if bits != 0 {
            let limit = if bits == DIRECT_BITS {
                max_state as u32
            } else {
                c.palette.len() as u32
            };
            if (0..SIZE).any(|i| c.raw_get(i) >= limit) {
                return Err(DecodeError);
            }
        }
        Ok(c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grows_through_every_width_and_keeps_values() {
        let mut c = PalettedContainer::single(0);
        let mut model = vec![0u16; SIZE];
        // 600 distinct values force 0 -> 4 -> 5 -> 6 -> 7 -> 8 -> direct.
        let mut seen_bits = vec![c.bits()];
        for i in 0..SIZE {
            let v = ((i * 7) % 600) as u16;
            assert_eq!(c.set(i, v), model[i]);
            model[i] = v;
            if *seen_bits.last().unwrap() != c.bits() {
                seen_bits.push(c.bits());
            }
            if i % 257 == 0 {
                for (j, &m) in model.iter().enumerate() {
                    assert_eq!(c.get(j), m, "entry {j} after writing {i}");
                }
            }
        }
        assert_eq!(seen_bits, vec![0, 4, 5, 6, 7, 8, DIRECT_BITS]);
        for (j, &m) in model.iter().enumerate() {
            assert_eq!(c.get(j), m);
        }
    }

    #[test]
    fn word_counts_match_the_non_spanning_layout() {
        // 4 bits: 16 per word -> 256 words. 5 bits: 12 per word -> 342 words.
        assert_eq!(words_for(4), 256);
        assert_eq!(words_for(5), 342);
        assert_eq!(words_for(8), 512);
        assert_eq!(words_for(15), 1024);
    }

    #[test]
    fn round_trips_and_rejects_corrupt_input() {
        let mut c = PalettedContainer::single(1);
        for i in 0..SIZE {
            c.set(i, (i % 9) as u16);
        }
        let mut w = Writer::new();
        c.write(&mut w);
        let bytes = w.finish();
        let back = PalettedContainer::read(&mut Reader::new(&bytes), 10).unwrap();
        assert_eq!(back, c);

        // A state id beyond the registry must be refused.
        assert!(PalettedContainer::read(&mut Reader::new(&bytes), 5).is_err());
        // Truncation must be refused.
        assert!(PalettedContainer::read(&mut Reader::new(&bytes[..bytes.len() - 3]), 10).is_err());
        // An index pointing outside the palette must be refused.
        let mut bad = bytes.clone();
        let last = bad.len() - 1;
        bad[last] = 0xFF;
        assert!(PalettedContainer::read(&mut Reader::new(&bad), 10).is_err());
    }
}
