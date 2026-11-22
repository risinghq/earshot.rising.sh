// A QR encoder for the room's join and seat links: byte mode, error
// correction level M, versions 1 to 6, which covers any link the app builds
// (up to 106 bytes). qrMatrix returns the symbol without the quiet zone;
// true is a dark module.

// The symbol as one SVG path of row runs, with the viewBox that adds a
// four-module quiet zone.
export function qrPath(text: string) {
  const matrix = qrMatrix(text);
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  const parts: string[] = [];
  matrix.forEach((row, r) => {
    for (let c = 0; c < matrix.length;) {
      if (!row[c]) {
        c += 1;
        continue;
      }
      let end = c + 1;
      while (end < matrix.length && row[end]) end += 1;
      parts.push(`M${c} ${r}h${end - c}v1H${c}z`);
      c = end;
    }
  });
  return {
    viewBox: `${-quiet} ${-quiet} ${size} ${size}`,
    d: parts.join(""),
  };
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version =
    TABLES.findIndex((table) => table.data * 8 >= 12 + bytes.length * 8 + 4) +
    1;
  if (version === 0) throw new Error("text too long for a QR code");
  const data = dataCodewords(bytes, TABLES[version - 1].data);
  const message = interleave(data, TABLES[version - 1]);
  const best = MASKS.map((mask) => place(message, version, mask)).reduce(
    (a, b) => (penalty(b) < penalty(a) ? b : a),
  );
  return best;
}

interface Table {
  data: number;
  ec: number;
  groups: [blocks: number, codewords: number][];
}

// Per-version Reed-Solomon layout at level M: data codewords, error
// codewords per block, and the block groups.
const TABLES: Table[] = [
  { data: 16, ec: 10, groups: [[1, 16]] },
  { data: 28, ec: 16, groups: [[1, 28]] },
  { data: 44, ec: 26, groups: [[1, 44]] },
  { data: 64, ec: 18, groups: [[2, 32]] },
  { data: 86, ec: 24, groups: [[2, 43]] },
  { data: 108, ec: 16, groups: [[4, 27]] },
];

const ALIGNMENT: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

const MASKS = [0, 1, 2, 3, 4, 5, 6, 7];

function dataCodewords(bytes: Uint8Array, capacity: number) {
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  const room = capacity * 8 - bits.length;
  push(0, Math.min(4, room)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8)
    out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const pad = [0xec, 0x11];
  for (let i = 0; out.length < capacity; i += 1) out.push(pad[i % 2]);
  return out;
}

const GF_EXP: number[] = [];
const GF_LOG: number[] = [];
{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value = value & 0x80 ? ((value << 1) ^ 0x11d) & 0xff : value << 1;
  }
}
const gfMul = (a: number, b: number) =>
  a === 0 || b === 0 ? 0 : GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];

function rsGenerator(degree: number) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = Array.from<number>({ length: poly.length + 1 }).fill(0);
    poly.forEach((coef, j) => {
      next[j] ^= coef;
      next[j + 1] ^= gfMul(coef, GF_EXP[i]);
    });
    poly = next;
  }
  return poly;
}

function rsEncode(data: number[], degree: number) {
  const generator = rsGenerator(degree);
  const ec = Array.from<number>({ length: degree }).fill(0);
  for (const byte of data) {
    const factor = byte ^ ec.shift()!;
    ec.push(0);
    if (factor !== 0)
      for (let i = 0; i < degree; i += 1)
        ec[i] ^= gfMul(generator[i + 1], factor);
  }
  return ec;
}

function interleave(data: number[], table: Table) {
  const blocks: number[][] = [];
  const ecs: number[][] = [];
  let offset = 0;
  for (const [count, length] of table.groups)
    for (let i = 0; i < count; i += 1) {
      const block = data.slice(offset, offset + length);
      offset += length;
      blocks.push(block);
      ecs.push(rsEncode(block, table.ec));
    }
  const out: number[] = [];
  for (let i = 0; i < Math.max(...blocks.map((b) => b.length)); i += 1)
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  for (let i = 0; i < table.ec; i += 1)
    for (const block of ecs) out.push(block[i]);
  return out;
}

function maskBit(mask: number, r: number, c: number) {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

// The 15-bit format field is a BCH(15,5) code: the 5 data bits — the level
// and the mask — shifted up by the generator's degree 10, the remainder
// appended, then the fixed 0x5412 mask applied.
function bch(value: number, poly: number) {
  const degree = 31 - Math.clz32(poly);
  let rest = value << degree;
  while (rest !== 0 && 31 - Math.clz32(rest) >= degree)
    rest ^= poly << (31 - Math.clz32(rest) - degree);
  return (value << degree) | rest;
}

// Level M is 00 in the two high data bits, so the data value is the mask.
const formatBits = (mask: number) => bch(mask, 0x537) ^ 0x5412;

function place(message: number[], version: number, mask: number) {
  const size = 17 + 4 * version;
  const cells: (boolean | null)[][] = Array.from({ length: size }, () =>
    Array.from<boolean | null>({ length: size }).fill(null),
  );
  const set = (r: number, c: number, dark: boolean) => {
    cells[r][c] = dark;
  };
  const finder = (r: number, c: number) => {
    for (let dr = -1; dr <= 7; dr += 1)
      for (let dc = -1; dc <= 7; dc += 1) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const edge = dr === -1 || dr === 7 || dc === -1 || dc === 7;
        const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        set(rr, cc, !edge && (ring || core));
      }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  const centers = ALIGNMENT[version - 1];
  for (const r of centers)
    for (const c of centers) {
      if (cells[r][c] !== null) continue;
      for (let dr = -2; dr <= 2; dr += 1)
        for (let dc = -2; dc <= 2; dc += 1)
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  set(size - 8, 8, true); // dark module
  // Reserve the format-information cells before the data pass.
  for (let i = 0; i <= 8; i += 1) {
    if (cells[8][i] === null) set(8, i, false);
    if (cells[i][8] === null) set(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    set(8, size - 1 - i, false);
    set(size - 1 - i, 8, false);
  }
  // Data placement: up/down in column pairs from the right, skipping the
  // vertical timing column.
  let bit = 0;
  let upward = true;
  for (let c = size - 1; c > 0; c -= 2) {
    if (c === 6) c -= 1;
    for (let i = 0; i < size; i += 1) {
      const r = upward ? size - 1 - i : i;
      for (const cc of [c, c - 1]) {
        if (cells[r][cc] !== null) continue;
        const dark =
          bit < message.length * 8
            ? ((message[bit >> 3] >> (7 - (bit & 7))) & 1) === 1
            : false;
        bit += 1;
        set(r, cc, dark !== maskBit(mask, r, cc));
      }
    }
    upward = !upward;
  }
  // Format information, level M + the chosen mask, in both copies: bit i of
  // the BCH word walks the cells beside each finder, skipping (6,8)/(8,6).
  const format = formatBits(mask);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((format >> i) & 1) === 1;
    if (i < 6) set(i, 8, dark);
    else if (i < 8) set(i + 1, 8, dark);
    else set(size - 15 + i, 8, dark);
    if (i < 8) set(8, size - 1 - i, dark);
    else if (i === 8) set(8, 7, dark);
    else set(8, 14 - i, dark);
  }
  set(size - 8, 8, true); // the always-dark module sits inside the copy
  return cells as boolean[][];
}

function penalty(m: boolean[][]) {
  const size = m.length;
  let score = 0;
  // Runs of five or more same-colour modules in a row or column.
  for (const dir of [0, 1])
    for (let i = 0; i < size; i += 1) {
      let run = 1;
      for (let j = 1; j <= size; j += 1) {
        const same =
          j < size &&
          (dir === 0 ? m[i][j] === m[i][j - 1] : m[j][i] === m[j - 1][i]);
        if (same) run += 1;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
    }
  // 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r += 1)
    for (let c = 0; c < size - 1; c += 1)
      if (
        m[r][c] === m[r][c + 1] &&
        m[r][c] === m[r + 1][c] &&
        m[r][c] === m[r + 1][c + 1]
      )
        score += 3;
  // The 1:1:3:1:1 finder-like pattern with a quiet side.
  const pattern = [true, false, true, true, true, false, true];
  for (const dir of [0, 1])
    for (let i = 0; i < size; i += 1)
      for (let j = 0; j + 11 <= size; j += 1) {
        const at = (k: number) => (dir === 0 ? m[i][j + k] : m[j + k][i]);
        const match =
          pattern.every((v, k) => at(k) === v) &&
          at(7) === false &&
          at(8) === false &&
          at(9) === false &&
          at(10) === false;
        const mirrored =
          pattern.every((v, k) => at(10 - k) === v) &&
          at(0) === false &&
          at(1) === false &&
          at(2) === false &&
          at(3) === false;
        if (match || mirrored) score += 40;
      }
  // Dark-module balance.
  let dark = 0;
  for (const row of m) for (const cell of row) if (cell) dark += 1;
  const ratio = Math.abs((dark * 100) / (size * size) - 50);
  score += Math.floor(ratio / 5) * 10;
  return score;
}
