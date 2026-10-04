//! Flat view of a map for the engine (port of `src/engine/grid.ts` and the tile rules of
//! `src/engine/rules.ts`). Cells are row-major; directions use the server's numbering
//! 1 = up, 2 = right, 3 = down, 4 = left, which is also the tie-break order.

use crate::mapcode::{Map, Tile};

pub const UP: u8 = 1;
pub const RIGHT: u8 = 2;
pub const DOWN: u8 = 3;
pub const LEFT: u8 = 4;

/// The direction pointing the other way (1<->3, 2<->4).
#[inline]
pub fn opposite(d: u8) -> u8 {
    ((d + 1) & 3) + 1
}

/// rules.ts `blocksPath`: rocks block; xN blocks path N; z1 blocks.
pub fn blocks_path(t: Tile, path_no: u32) -> bool {
    match t.kind {
        b'r' => true,
        b'x' => t.value == path_no,
        b'z' => t.value == 1,
        _ => false,
    }
}

/// rules.ts `isIce`: z5 only.
pub fn is_ice(t: Tile) -> bool {
    t.kind == b'z' && t.value == 5
}

/// rules.ts `isWallable`: only `o`.
pub fn is_wallable(t: Tile) -> bool {
    t.kind == b'o'
}

pub struct Grid {
    pub width: usize,
    pub height: usize,
    pub size: usize,
    pub tiles: Vec<Tile>,
    /// `nbr[cell * 4 + dir - 1]` = neighbouring cell, or -1 off the grid.
    pub nbr: Vec<i32>,
    pub wallable: Vec<u8>,
    /// Per path (0 = path 1, 1 = path 2): 1 where the tile lets that path pass.
    pub passable: [Vec<u8>; 2],
    /// States `0..size` are plain cells; each ice cell has 4 more ("moving in direction d").
    pub state_count: usize,
    /// First of the 4 states of an ice cell, or -1.
    pub ice_state: Vec<i32>,
    pub state_cell: Vec<u32>,
    pub state_dir: Vec<u8>,
}

impl Grid {
    pub fn new(map: &Map) -> Grid {
        let (width, height) = (map.width, map.height);
        let size = width * height;
        let mut nbr = vec![-1i32; size * 4];
        for cell in 0..size {
            let (r, c) = (cell / width, cell % width);
            if r > 0 {
                nbr[cell * 4] = (cell - width) as i32;
            }
            if c + 1 < width {
                nbr[cell * 4 + 1] = (cell + 1) as i32;
            }
            if r + 1 < height {
                nbr[cell * 4 + 2] = (cell + width) as i32;
            }
            if c > 0 {
                nbr[cell * 4 + 3] = (cell - 1) as i32;
            }
        }
        let mut wallable = vec![0u8; size];
        let mut pass1 = vec![0u8; size];
        let mut pass2 = vec![0u8; size];
        let mut ice_state = vec![-1i32; size];
        let mut ice_count = 0;
        for cell in 0..size {
            let t = map.tiles[cell];
            wallable[cell] = is_wallable(t) as u8;
            pass1[cell] = !blocks_path(t, 1) as u8;
            pass2[cell] = !blocks_path(t, 2) as u8;
            if is_ice(t) {
                ice_state[cell] = (size + 4 * ice_count) as i32;
                ice_count += 1;
            }
        }
        let state_count = size + 4 * ice_count;
        let mut state_cell = vec![0u32; state_count];
        let mut state_dir = vec![0u8; state_count];
        for cell in 0..size {
            state_cell[cell] = cell as u32;
            let s = ice_state[cell];
            if s >= 0 {
                for d in 1..=4u8 {
                    state_cell[s as usize + d as usize - 1] = cell as u32;
                    state_dir[s as usize + d as usize - 1] = d;
                }
            }
        }
        Grid {
            width,
            height,
            size,
            tiles: map.tiles.clone(),
            nbr,
            wallable,
            passable: [pass1, pass2],
            state_count,
            ice_state,
            state_cell,
            state_dir,
        }
    }

    /// Server "x,y" (= "col,row") string for a cell.
    pub fn xy(&self, cell: usize) -> String {
        format!("{},{}", cell % self.width, cell / self.width)
    }

    /// Cell index of (row, col), or None off the grid.
    pub fn cell(&self, row: i64, col: i64) -> Option<usize> {
        if row < 0 || col < 0 || row >= self.height as i64 || col >= self.width as i64 {
            None
        } else {
            Some(row as usize * self.width + col as usize)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opposite_dirs() {
        assert_eq!(opposite(UP), DOWN);
        assert_eq!(opposite(RIGHT), LEFT);
        assert_eq!(opposite(DOWN), UP);
        assert_eq!(opposite(LEFT), RIGHT);
    }
}
