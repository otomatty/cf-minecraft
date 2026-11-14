//! Deterministic region storage. No I/O: hosts execute each write then flush.
use miniz_oxide::{deflate::compress_to_vec_zlib, inflate::decompress_to_vec_zlib_with_limit};

pub const SECTOR: usize = 4096;
pub const ENTRIES: usize = 1024;
pub const HEADER: usize = ENTRIES * 48;
const MAX_CHUNK: usize = 16 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct Error;
type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug)]
struct Entry {
    generation: u64,
    sector: u32,
    count: u32,
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn crc(bytes: &[u8]) -> u32 {
    let mut value = !0u32;
    for &byte in bytes {
        value ^= u32::from(byte);
        for _ in 0..8 {
            value = (value >> 1) ^ (0xedb88320 & 0u32.wrapping_sub(value & 1));
        }
    }
    !value
}
fn entry(bytes: &[u8], size: usize) -> Option<Entry> {
    let generation = u64::from_le_bytes(bytes[..8].try_into().unwrap());
    let sector = u32_at(bytes, 8);
    let count = u32_at(bytes, 12);
    let checksum = u32_at(bytes, 16);
    if generation == 0
        || count == 0
        || (sector as usize) < HEADER / SECTOR
        || (sector as u64 + count as u64) * SECTOR as u64 > size as u64
        || checksum != crc(&bytes[..16])
        || u32_at(bytes, 20) != !checksum
    {
        return None;
    }
    Some(Entry {
        generation,
        sector,
        count,
    })
}

pub struct Region {
    slots: Vec<[Option<Entry>; 2]>,
}
impl Region {
    pub fn open(header: &[u8], size: usize) -> Result<Self> {
        if header.len() != HEADER {
            return Err(Error);
        }
        let slots = header
            .as_chunks::<48>()
            .0
            .iter()
            .map(|b| [entry(&b[..24], size), entry(&b[24..], size)])
            .collect();
        Ok(Self { slots })
    }
    fn current(&self, index: usize) -> Option<(usize, Entry)> {
        self.slots
            .get(index)?
            .iter()
            .enumerate()
            .filter_map(|(i, e)| e.map(|e| (i, e)))
            .max_by_key(|(_, e)| e.generation)
    }
    pub fn list(&self) -> Vec<u32> {
        (0..ENTRIES)
            .filter(|&i| self.current(i).is_some())
            .map(|i| i as u32)
            .collect()
    }
    pub fn range(&self, index: usize) -> Option<(usize, usize)> {
        self.current(index)
            .map(|(_, e)| (e.sector as usize * SECTOR, e.count as usize * SECTOR))
    }
    pub fn plan(&self, index: usize, data: &[u8]) -> Result<Vec<Write>> {
        if index >= ENTRIES || data.len() > MAX_CHUNK {
            return Err(Error);
        }
        let compressed = compress_to_vec_zlib(data, 6);
        let count = (compressed.len() + 9).div_ceil(SECTOR);
        // Reserve both copies, including the one we are about to replace.
        let mut occupied: Vec<(usize, usize)> = self
            .slots
            .iter()
            .flatten()
            .flatten()
            .map(|e| (e.sector as usize, e.sector as usize + e.count as usize))
            .collect();
        occupied.sort_unstable();
        let mut sector = HEADER / SECTOR;
        for (start, end) in occupied {
            if sector + count <= start {
                break;
            }
            sector = sector.max(end);
        }
        let (target, generation) = match self.current(index) {
            Some((slot, e)) => (1 - slot, e.generation.checked_add(1).ok_or(Error)?),
            None => (0, 1),
        };
        if (sector as u64 + count as u64) * SECTOR as u64 > u32::MAX as u64 {
            return Err(Error);
        }
        let mut payload = Vec::with_capacity(count * SECTOR);
        payload.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
        payload.push(1); // zlib
        payload.extend_from_slice(&crc(data).to_le_bytes());
        payload.extend_from_slice(&compressed);
        payload.resize(count * SECTOR, 0);
        let mut location = Vec::with_capacity(24);
        location.extend_from_slice(&generation.to_le_bytes());
        location.extend_from_slice(&u32::try_from(sector).map_err(|_| Error)?.to_le_bytes());
        location.extend_from_slice(&(count as u32).to_le_bytes());
        let checksum = crc(&location);
        location.extend_from_slice(&checksum.to_le_bytes());
        location.extend_from_slice(&(!checksum).to_le_bytes());
        Ok(vec![
            Write {
                at: sector * SECTOR,
                bytes: payload,
            },
            Write {
                at: index * 48 + target * 24,
                bytes: location,
            },
        ])
    }
}

/// Every operation must be fully written and flushed before the next operation.
#[derive(Clone, Debug)]
pub struct Write {
    pub at: usize,
    pub bytes: Vec<u8>,
}

pub fn decode(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.len() < 9 || bytes[4] != 1 {
        return Err(Error);
    }
    let len = u32_at(bytes, 0) as usize;
    let compressed = bytes
        .get(9..9usize.checked_add(len).ok_or(Error)?)
        .ok_or(Error)?;
    let data = decompress_to_vec_zlib_with_limit(compressed, MAX_CHUNK).map_err(|_| Error)?;
    if crc(&data) != u32_at(bytes, 5) {
        return Err(Error);
    }
    Ok(data)
}

/// C ABI wire adapter. Input for 0..=2: size u32, index u32, header, optional chunk.
/// Output: 0=list of u32 indices, 1=offset/length u32 pair (or empty),
/// 2=repeated offset/length u32 pairs followed by write bytes; 3=decoded chunk.
pub fn call(op: u32, bytes: &[u8]) -> Result<Vec<u8>> {
    if op == 3 {
        return decode(bytes);
    }
    if bytes.len() < 8 + HEADER {
        return Err(Error);
    }
    let region = Region::open(&bytes[8..8 + HEADER], u32_at(bytes, 0) as usize)?;
    let index = u32_at(bytes, 4) as usize;
    let mut out = Vec::new();
    match op {
        0 => {
            for i in region.list() {
                out.extend_from_slice(&i.to_le_bytes());
            }
        }
        1 => {
            if let Some((at, len)) = region.range(index) {
                out.extend_from_slice(&(at as u32).to_le_bytes());
                out.extend_from_slice(&(len as u32).to_le_bytes());
            }
        }
        2 => {
            for write in region.plan(index, &bytes[8 + HEADER..])? {
                out.extend_from_slice(&u32::try_from(write.at).map_err(|_| Error)?.to_le_bytes());
                out.extend_from_slice(&(write.bytes.len() as u32).to_le_bytes());
                out.extend_from_slice(&write.bytes);
            }
        }
        _ => return Err(Error),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn open(file: &[u8]) -> Region {
        let mut header = vec![0; HEADER];
        let len = file.len().min(HEADER);
        header[..len].copy_from_slice(&file[..len]);
        Region::open(&header, file.len()).unwrap()
    }
    fn apply(file: &mut Vec<u8>, write: &Write) {
        file.resize(file.len().max(write.at + write.bytes.len()), 0);
        file[write.at..write.at + write.bytes.len()].copy_from_slice(&write.bytes);
    }
    fn save(file: &mut Vec<u8>, index: usize, data: &[u8]) -> Vec<Write> {
        let plan = open(file).plan(index, data).unwrap();
        for write in &plan {
            apply(file, write);
        }
        plan
    }
    fn read(file: &[u8], index: usize) -> Option<Vec<u8>> {
        let (at, len) = open(file).range(index)?;
        Some(decode(&file[at..at + len]).unwrap())
    }
    #[test]
    fn roundtrip_overwrite_reuse() {
        let mut file = Vec::new();
        let first = save(&mut file, 1023, b"old");
        assert_eq!(read(&file, 1023).unwrap(), b"old");
        let second = save(&mut file, 1023, b"new");
        let third = save(&mut file, 1023, b"third");
        assert_ne!(first[0].at, second[0].at);
        assert_ne!(first[0].at, third[0].at);
        let fourth = save(&mut file, 1023, b"fourth");
        assert_eq!(first[0].at, fourth[0].at);
        assert_eq!(read(&file, 1023).unwrap(), b"fourth");
    }
    #[test]
    fn compression_roundtrip() {
        let cases = [
            vec![],
            vec![7; 100_000],
            (0..100_000u32).flat_map(u32::to_le_bytes).collect(),
        ];
        for data in cases {
            let plan = open(&[]).plan(0, &data).unwrap();
            assert_eq!(decode(&plan[0].bytes).unwrap(), data);
            if data.len() == 100_000 {
                assert!(plan[0].bytes.len() < data.len() / 10);
            }
            let mut corrupt = plan[0].bytes.clone();
            corrupt[5] ^= 1;
            assert!(decode(&corrupt).is_err());
        }
    }
    #[test]
    fn all_entries() {
        let mut file = Vec::new();
        for i in 0..ENTRIES {
            save(&mut file, i, &(i as u32).to_le_bytes());
        }
        assert_eq!(open(&file).list(), (0..ENTRIES as u32).collect::<Vec<_>>());
        for i in 0..ENTRIES {
            assert_eq!(read(&file, i).unwrap(), (i as u32).to_le_bytes());
        }
    }
    #[test]
    fn corrupt_location_falls_back() {
        let mut file = Vec::new();
        save(&mut file, 0, b"old");
        let plan = save(&mut file, 0, b"new");
        for byte in 0..24 {
            let mut damaged = file.clone();
            damaged[plan[1].at + byte] ^= 0x80;
            assert_eq!(read(&damaged, 0).unwrap(), b"old");
        }
    }
    #[test]
    fn crashes_at_every_write_flush_boundary_and_torn_write() {
        let mut initial = Vec::new();
        save(&mut initial, 1, b"unrelated");
        save(&mut initial, 0, b"old");
        // Exercise replacements of both slots, including reuse of old data.
        for attempt in 0..5 {
            let plan = open(&initial).plan(0, b"new").unwrap();
            let old = read(&initial, 0).unwrap();
            let check = |file: &[u8]| {
                let got = read(file, 0).unwrap();
                assert!(got == old || got == b"new");
                assert_eq!(read(file, 1).unwrap(), b"unrelated");
            };
            let mut durable = initial.clone();
            let mut volatile = durable.clone();
            for write in &plan {
                check(&durable); // before write
                                 // A crash may persist any prefix of an unflushed write.
                for cut in 0..=write.bytes.len() {
                    let mut torn = durable.clone();
                    apply(
                        &mut torn,
                        &Write {
                            at: write.at,
                            bytes: write.bytes[..cut].to_vec(),
                        },
                    );
                    check(&torn);
                }
                apply(&mut volatile, write);
                check(&durable); // after write, before flush (no persistence)
                check(&volatile); // before flush (complete persistence)
                durable = volatile.clone();
                check(&durable); // after flush
            }
            if attempt % 2 == 0 {
                save(&mut initial, 0, b"different");
            } else {
                save(&mut initial, 0, b"old");
            }
        }
    }
    #[test]
    fn interrupted_first_insert_can_resume() {
        let plan = open(&[]).plan(0, b"first").unwrap();
        let mut file = Vec::new();
        apply(&mut file, &plan[0]);
        for cut in 0..24 {
            let mut torn = file.clone();
            apply(
                &mut torn,
                &Write {
                    at: 0,
                    bytes: plan[1].bytes[..cut].to_vec(),
                },
            );
            assert!(read(&torn, 0).is_none());
            save(&mut torn, 0, b"first");
            assert_eq!(read(&torn, 0).unwrap(), b"first");
        }
    }
    #[test]
    fn startup_ten_thousand_chunks() {
        // Real saved headers. Startup reads only these bytes, never payload sectors.
        let mut headers = Vec::new();
        let mut remaining = 10_000;
        while remaining > 0 {
            let count = remaining.min(ENTRIES);
            let mut file = Vec::new();
            for i in 0..count {
                save(&mut file, i, b"benchmark chunk");
            }
            headers.push(file);
            remaining -= count;
        }
        use std::io::Read;
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "../../target/storage-startup-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        for (i, file) in headers.iter().enumerate() {
            let path = directory.join(format!("r.{i}.0"));
            std::fs::write(&path, file).unwrap();
        }
        let start = Instant::now();
        let listed: usize = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| {
                let mut file = std::fs::File::open(entry.unwrap().path()).unwrap();
                let size = file.metadata().unwrap().len() as usize;
                let mut header = vec![0; HEADER];
                file.read_exact(&mut header).unwrap();
                Region::open(&header, size).unwrap().list().len()
            })
            .sum();
        let elapsed = start.elapsed();
        std::fs::remove_dir_all(directory).unwrap();
        println!(
            "startup: {listed} chunks, {} regions, {elapsed:?}",
            headers.len()
        );
        assert_eq!(listed, 10_000);
        assert!(elapsed.as_secs_f64() < 1.0);
    }
}
