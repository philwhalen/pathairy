//! Map codes and solution strings (port of `src/engine/mapcode.ts`).

/// One tile: `kind` is the letter (`o r s f c t u p x z`), `value` its number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tile {
    pub kind: u8,
    pub value: u32,
}

impl Tile {
    pub const OPEN: Tile = Tile { kind: b'o', value: 1 };
}

#[derive(Clone, Debug)]
pub struct Map {
    pub width: usize,
    pub height: usize,
    /// Wall budget (999 = "unlimited").
    pub walls: usize,
    pub name: String,
    /// Row-major tiles: `tiles[row * width + col]`.
    pub tiles: Vec<Tile>,
}

impl Map {
    pub fn tile(&self, row: usize, col: usize) -> Tile {
        self.tiles[row * self.width + col]
    }
}

const TILE_KINDS: &[u8] = b"orsfctupxz";

/// A map from ASCII rows, for tests and tools (same symbols as tools/show-map.ts where they
/// overlap): `.` open, `#` rock, `S` s1, `T` s2, `F` finish, `A`-`O` checkpoints, `1`-`9`
/// teleport in, `a`-`i` teleport out, `~` ice, `x` x1, `y` x2, `_` unbuildable.
pub fn map_from_ascii(rows: &[&str], walls: usize) -> Map {
    let height = rows.len();
    let width = rows[0].len();
    let tiles = rows
        .iter()
        .flat_map(|r| {
            assert_eq!(r.len(), width, "ragged rows");
            r.bytes().map(|b| match b {
                b'.' => Tile::OPEN,
                b'#' => Tile { kind: b'r', value: 1 },
                b'S' => Tile { kind: b's', value: 1 },
                b'T' => Tile { kind: b's', value: 2 },
                b'F' => Tile { kind: b'f', value: 1 },
                b'A'..=b'O' => Tile {
                    kind: b'c',
                    value: (b - b'A' + 1) as u32,
                },
                b'1'..=b'9' => Tile {
                    kind: b't',
                    value: (b - b'0') as u32,
                },
                b'a'..=b'i' => Tile {
                    kind: b'u',
                    value: (b - b'a' + 1) as u32,
                },
                b'~' => Tile { kind: b'z', value: 5 },
                b'x' => Tile { kind: b'x', value: 1 },
                b'y' => Tile { kind: b'x', value: 2 },
                b'_' => Tile { kind: b'p', value: 1 },
                _ => panic!("unknown map symbol {:?}", b as char),
            })
        })
        .collect();
    Map {
        width,
        height,
        walls,
        name: "Ascii".into(),
        tiles,
    }
}

/// Parses `width.height.walls.name.e1.e2.e3:` + body (see mapcode.ts for the format).
pub fn parse_map_code(code: &str) -> Result<Map, String> {
    let colon = code.find(':').ok_or("Map code missing \":\"")?;
    let head: Vec<&str> = code[..colon].split('.').collect();
    if head.len() < 7 {
        return Err("Map code header too short".into());
    }
    let num = |s: &str| s.parse::<usize>().map_err(|_| "Bad map code header".to_string());
    let width = num(head[0])?;
    let height = num(head[1])?;
    let walls = num(head[2])?;
    if width < 1 || height < 1 {
        return Err("Bad map code header".into());
    }
    let name = head[3..head.len() - 3].join(".");
    let mut tiles = vec![Tile::OPEN; width * height];
    let mut entries: Vec<&str> = code[colon + 1..].split('.').collect();
    // Canonical codes end in '.', so the last segment is ''. A bare trailing gap like '3,' is
    // ignored, as the server does.
    let last = entries.pop().unwrap_or("");
    let bare_gap = last.ends_with(',') && last[..last.len() - 1].bytes().all(|b| b.is_ascii_digit());
    if !last.is_empty() && !bare_gap {
        return Err("Bad map code ending".into());
    }
    let mut idx: i64 = -1;
    for entry in entries {
        let bad = || format!("Bad map code entry \"{entry}\"");
        let comma = entry.find(',').ok_or_else(bad)?;
        let gap = &entry[..comma];
        let tile = entry[comma + 1..].as_bytes();
        if tile.len() < 2
            || !TILE_KINDS.contains(&tile[0])
            || !tile[1..].iter().all(|b| b.is_ascii_digit())
            || !gap.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(bad());
        }
        let value: u32 = std::str::from_utf8(&tile[1..])
            .unwrap()
            .parse()
            .map_err(|_| bad())?;
        idx += 1 + if gap.is_empty() {
            0
        } else {
            gap.parse::<i64>().map_err(|_| bad())?
        };
        // The server silently ignores entries past the end of the grid.
        if idx as usize >= width * height {
            continue;
        }
        tiles[idx as usize] = Tile { kind: tile[0], value };
    }
    Ok(Map {
        width,
        height,
        walls,
        name,
        tiles,
    })
}

/// Solution string `.r,c.r,c.:` -> (row, col) pairs.
pub fn parse_solution(s: &str) -> Result<Vec<(i64, i64)>, String> {
    let body = s.strip_suffix(':').unwrap_or(s);
    let mut out = Vec::new();
    for part in body.split('.') {
        if part.is_empty() {
            continue;
        }
        let mut it = part.split(',');
        let (Some(r), Some(c), None) = (it.next(), it.next(), it.next()) else {
            return Err(format!("Bad solution entry \"{part}\""));
        };
        let r = r.parse().map_err(|_| format!("Bad solution entry \"{part}\""))?;
        let c = c.parse().map_err(|_| format!("Bad solution entry \"{part}\""))?;
        out.push((r, c));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_code() {
        let m = parse_map_code("13.6.8.Simple...:,s1.11,r3.").unwrap();
        assert_eq!((m.width, m.height, m.walls), (13, 6, 8));
        assert_eq!(m.name, "Simple");
        assert_eq!(m.tile(0, 0), Tile { kind: b's', value: 1 });
        assert_eq!(m.tile(0, 12), Tile { kind: b'r', value: 3 });
        assert_eq!(m.tile(1, 0), Tile::OPEN);
    }

    #[test]
    fn tolerates_bare_trailing_gap_and_rejects_junk() {
        assert!(parse_map_code("3.1.0.T...:,s1.,f1.3,").is_ok());
        assert!(parse_map_code("3.1.0.T...:,s1.,q1.").is_err());
        assert!(parse_map_code("3.1.0.T...").is_err());
    }

    #[test]
    fn parses_solutions() {
        assert_eq!(parse_solution(".1,2.3,4.:").unwrap(), vec![(1, 2), (3, 4)]);
        assert_eq!(parse_solution("..:").unwrap(), vec![]);
        assert!(parse_solution(".1.:").is_err());
    }
}
