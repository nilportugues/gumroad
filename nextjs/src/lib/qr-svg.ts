// Port of rqrcode_core 1.2.0's QRCode (error correction level :h, 8-bit byte mode) and rqrcode 2.2.0's `as_svg(use_path: true)`, which is how
// Settings::TotpController#create draws the provisioning URI. The data always starts with "otpauth://", so numeric and alphanumeric
// segments (which rqrcode picks for data made of digits or of uppercase characters only) never apply.
//
// Kept as rqrcode_core does it, quirks included: the dark-ratio demerit uses integer division (a constant 100 for every mask), a lower
// mask wins ties, and `gexp` folds an exponent by 255 instead of reducing it modulo 255.
import { MAX_BITS_H, PATTERN_POSITIONS, RS_BLOCKS_H } from "./qr-tables.ts";

const ERROR_CORRECT_LEVEL_H = 2;
const POSITION_PATTERN_LENGTH = (7 + 1) * 2 + 1;
const FORMAT_INFO_LENGTH = 15;
const MODE_8BIT_BYTE = 1 << 2;
const PAD0 = 0xec;
const PAD1 = 0x11;
const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
const DEMERIT_POINTS_1 = 3;
const DEMERIT_POINTS_2 = 3;
const DEMERIT_POINTS_3 = 40;
const DEMERIT_POINTS_4 = 10;

type Modules = (boolean | null)[][];

const EXP_TABLE = new Array<number>(256);
const LOG_TABLE = new Array<number>(256);
for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
for (let i = 8; i < 256; i++)
  EXP_TABLE[i] = EXP_TABLE[i - 4]! ^ EXP_TABLE[i - 5]! ^ EXP_TABLE[i - 6]! ^ EXP_TABLE[i - 8]!;
for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]!] = i;

const glog = (n: number): number => {
  if (n < 1) throw new Error(`glog(${n})`);
  return LOG_TABLE[n]!;
};

function gexp(n: number): number {
  let exponent = n;
  while (exponent < 0) exponent += 255;
  while (exponent >= 256) exponent -= 255;
  return EXP_TABLE[exponent]!;
}

// QRPolynomial
class Polynomial {
  private readonly num: number[];

  constructor(num: number[], shift: number) {
    if (num.length === 0) throw new Error(`${num.length}/${shift}`);
    let offset = 0;
    while (offset < num.length && num[offset] === 0) offset++;
    this.num = new Array<number>(num.length - offset + shift).fill(0);
    for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset]!;
  }

  get(index: number): number {
    return this.num[index]!;
  }

  get length(): number {
    return this.num.length;
  }

  multiply(other: Polynomial): Polynomial {
    const num = new Array<number>(this.length + other.length - 1).fill(0);
    for (let i = 0; i < this.length; i++)
      for (let j = 0; j < other.length; j++) num[i + j] = num[i + j]! ^ gexp(glog(this.get(i)) + glog(other.get(j)));
    return new Polynomial(num, 0);
  }

  mod(other: Polynomial): Polynomial {
    if (this.length - other.length < 0) return this;
    const ratio = glog(this.get(0)) - glog(other.get(0));
    const num = Array.from({ length: this.length }, (_, i) => this.get(i));
    for (let i = 0; i < other.length; i++) num[i] = num[i]! ^ gexp(glog(other.get(i)) + ratio);
    return new Polynomial(num, 0).mod(other);
  }
}

const bchDigit = (data: number): number => 32 - Math.clz32(data);

function bchFormatInfo(data: number): number {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

function bchVersion(data: number): number {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

function errorCorrectPolynomial(length: number): Polynomial {
  let a = new Polynomial([1], 0);
  for (let i = 0; i < length; i++) a = a.multiply(new Polynomial([1, gexp(i)], 0));
  return a;
}

// QRUtil.get_length_in_bits for the 8-bit byte mode.
const lengthInBits = (version: number): number => (version <= 9 ? 8 : 16);

const MASKS: ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

// QRUtil.get_lost_points
function lostPoints(modules: Modules): number {
  const count = modules.length;
  let points = 0;
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      let same = 0;
      const dark = modules[row]![col];
      for (let r = -1; r <= 1; r++) {
        if (row + r < 0 || count <= row + r) continue;
        for (let c = -1; c <= 1; c++) {
          if (col + c < 0 || count <= col + c) continue;
          if (r === 0 && c === 0) continue;
          if (dark === modules[row + r]![col + c]) same++;
        }
      }
      if (same > 5) points += DEMERIT_POINTS_1 + same - 5;
    }
  }
  for (let row = 0; row < count - 1; row++) {
    for (let col = 0; col < count - 1; col++) {
      const dark = [
        modules[row]![col],
        modules[row + 1]![col],
        modules[row]![col + 1],
        modules[row + 1]![col + 1],
      ].filter(Boolean).length;
      if (dark === 0 || dark === 4) points += DEMERIT_POINTS_2;
    }
  }
  const pattern = (at: (k: number) => boolean | null | undefined) =>
    at(0) && !at(1) && at(2) && at(3) && at(4) && !at(5) && at(6);
  for (const row of modules)
    for (let col = 0; col < count - 6; col++) if (pattern((k) => row[col + k])) points += DEMERIT_POINTS_3;
  for (let col = 0; col < count; col++)
    for (let row = 0; row < count - 6; row++) if (pattern((k) => modules[row + k]![col])) points += DEMERIT_POINTS_3;
  const darkCount = modules.reduce((sum, row) => sum + row.filter((cell) => cell === true).length, 0);
  // `dark_count / (modules.size * modules.size)` is an Integer division in Ruby.
  const ratio = Math.floor(darkCount / (count * count));
  points += (Math.abs(100 * ratio - 50) / 5) * DEMERIT_POINTS_4;
  return points;
}

// QRBitBuffer
class BitBuffer {
  readonly buffer: number[] = [];
  length = 0;

  put(num: number, length: number): void {
    for (let i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) === 1);
  }

  private putBit(bit: boolean): void {
    const index = Math.floor(this.length / 8);
    if (this.buffer.length <= index) this.buffer.push(0);
    if (bit) this.buffer[index]! |= 0x80 >>> this.length % 8;
    this.length++;
  }

  padUntil(preferred: number): void {
    while (this.length % 8 !== 0) this.putBit(false);
    while (this.length < preferred) {
      this.put(PAD0, 8);
      if (this.length < preferred) this.put(PAD1, 8);
    }
  }

  endOfMessage(maxDataBits: number): void {
    if (!(this.length + 4 > maxDataBits)) this.put(0, 4);
  }
}

type RsBlock = { total: number; data: number };

// QRRSBlock.get_rs_blocks
function rsBlocks(version: number): RsBlock[] {
  const row = RS_BLOCKS_H[version - 1]!;
  const blocks: RsBlock[] = [];
  for (let i = 0; i < row.length / 3; i++)
    for (let j = 0; j < row[i * 3]!; j++) blocks.push({ total: row[i * 3 + 1]!, data: row[i * 3 + 2]! });
  return blocks;
}

// QRCode.create_data and create_bytes
function createData(version: number, bytes: Uint8Array): number[] {
  const blocks = rsBlocks(version);
  const maxDataBits = blocks.reduce((sum, block) => sum + block.data, 0) * 8;
  const buffer = new BitBuffer();
  buffer.put(MODE_8BIT_BYTE, 4);
  buffer.put(bytes.length, lengthInBits(version));
  for (const byte of bytes) buffer.put(byte, 8);
  buffer.endOfMessage(maxDataBits);
  if (buffer.length > maxDataBits) throw new Error(`code length overflow. (${buffer.length}>${maxDataBits})`);
  buffer.padUntil(maxDataBits);

  let offset = 0;
  let maxDc = 0;
  let maxEc = 0;
  const dcdata: number[][] = [];
  const ecdata: number[][] = [];
  blocks.forEach((block, r) => {
    const dcCount = block.data;
    const ecCount = block.total - dcCount;
    maxDc = Math.max(maxDc, dcCount);
    maxEc = Math.max(maxEc, ecCount);
    dcdata[r] = Array.from({ length: dcCount }, (_, i) => 0xff & buffer.buffer[i + offset]!);
    offset += dcCount;
    const rsPoly = errorCorrectPolynomial(ecCount);
    const modPoly = new Polynomial(dcdata[r]!, rsPoly.length - 1).mod(rsPoly);
    ecdata[r] = Array.from({ length: rsPoly.length - 1 }, (_, i) => {
      const modIndex = i + modPoly.length - (rsPoly.length - 1);
      return modIndex >= 0 ? modPoly.get(modIndex) : 0;
    });
  });
  const data: number[] = [];
  for (let i = 0; i < maxDc; i++)
    for (let r = 0; r < blocks.length; r++) if (i < dcdata[r]!.length) data.push(dcdata[r]![i]!);
  for (let i = 0; i < maxEc; i++)
    for (let r = 0; r < blocks.length; r++) if (i < ecdata[r]!.length) data.push(ecdata[r]![i]!);
  return data;
}

export class QrCode {
  readonly modules: Modules;
  readonly moduleCount: number;
  readonly version: number;
  private common: Modules = [];
  private readonly data: number[];

  // `RQRCode::QRCode.new(text)`: the smallest version whose capacity (level :h) holds the segment.
  constructor(text: string) {
    const bytes = new TextEncoder().encode(text);
    let version = 1;
    for (; ; version++) {
      if (version > MAX_BITS_H.length)
        throw new Error(`Data length exceed maximum capacity of version ${MAX_BITS_H.length}`);
      if (4 + lengthInBits(version) + bytes.length * 8 < MAX_BITS_H[version - 1]!) break;
    }
    this.version = version;
    this.moduleCount = version * 4 + POSITION_PATTERN_LENGTH;
    this.modules = [];
    this.data = createData(version, bytes);
    this.prepareCommonPatterns();
    this.modules = this.makeImpl(false, this.bestMaskPattern());
  }

  private prepareCommonPatterns(): void {
    const count = this.moduleCount;
    const modules: Modules = Array.from({ length: count }, () => new Array<boolean | null>(count).fill(null));
    const probe = (row: number, col: number) => {
      for (let r = -1; r <= 7; r++) {
        if (row + r < 0 || row + r > count - 1) continue;
        for (let c = -1; c <= 7; c++) {
          if (col + c < 0 || col + c > count - 1) continue;
          const vertical = r >= 0 && r <= 6 && (c === 0 || c === 6);
          const horizontal = c >= 0 && c <= 6 && (r === 0 || r === 6);
          const square = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          modules[row + r]![col + c] = vertical || horizontal || square;
        }
      }
    };
    probe(0, 0);
    probe(count - 7, 0);
    probe(0, count - 7);
    const positions = PATTERN_POSITIONS[this.version - 1]!;
    for (const row of positions)
      for (const col of positions) {
        if (modules[row]![col] !== null) continue;
        for (let r = -2; r <= 2; r++)
          for (let c = -2; c <= 2; c++)
            modules[row + r]![col + c] = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
      }
    for (let i = 8; i < count - 8; i++) {
      modules[i]![6] = i % 2 === 0;
      modules[6]![i] = i % 2 === 0;
    }
    this.common = modules;
  }

  private bestMaskPattern(): number {
    let minLost = 0;
    let pattern = 0;
    for (let i = 0; i < 8; i++) {
      const lost = lostPoints(this.makeImpl(true, i));
      if (i === 0 || minLost > lost) {
        minLost = lost;
        pattern = i;
      }
    }
    return pattern;
  }

  private makeImpl(test: boolean, maskPattern: number): Modules {
    const count = this.moduleCount;
    const modules = this.common.map((row) => [...row]);
    const bits = bchFormatInfo((ERROR_CORRECT_LEVEL_H << 3) | maskPattern);
    for (let i = 0; i < FORMAT_INFO_LENGTH; i++) {
      const mod = !test && ((bits >> i) & 1) === 1;
      const row = i < 6 ? i : i < 8 ? i + 1 : count - 15 + i;
      modules[row]![8] = mod;
      const col = i < 8 ? count - i - 1 : i < 9 ? 15 - i - 1 + 1 : 15 - i - 1;
      modules[8]![col] = mod;
    }
    modules[count - 8]![8] = !test;
    if (this.version >= 7) {
      const versionBits = bchVersion(this.version);
      for (let i = 0; i < 18; i++) {
        const mod = !test && ((versionBits >> i) & 1) === 1;
        modules[Math.floor(i / 3)]![(i % 3) + count - 8 - 3] = mod;
        modules[(i % 3) + count - 8 - 3]![Math.floor(i / 3)] = mod;
      }
    }
    this.mapData(modules, maskPattern);
    return modules;
  }

  private mapData(modules: Modules, maskPattern: number): void {
    const count = this.moduleCount;
    let inc = -1;
    let row = count - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    for (let start = count - 1; start >= 1; start -= 2) {
      const col = start <= 6 ? start - 1 : start;
      for (;;) {
        for (let c = 0; c < 2; c++) {
          if (modules[row]![col - c] !== null) continue;
          let dark = false;
          if (byteIndex < this.data.length) dark = ((this.data[byteIndex]! >>> bitIndex) & 1) === 1;
          if (MASKS[maskPattern]!(row, col - c)) dark = !dark;
          modules[row]![col - c] = dark;
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
        row += inc;
        if (row < 0 || count <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  }

  // `as_svg(module_size:, offset:, fill:, use_path: true, viewbox: true)` with the default colour and shape rendering.
  asSvg({ moduleSize, offset, fill }: { moduleSize: number; offset: number; fill: string }): string {
    const dimension = this.moduleCount * moduleSize + 2 * offset;
    const attributes = [
      'version="1.1"',
      'xmlns="http://www.w3.org/2000/svg"',
      'xmlns:xlink="http://www.w3.org/1999/xlink"',
      'xmlns:ev="http://www.w3.org/2001/xml-events"',
      `viewBox="0 0 ${dimension} ${dimension}"`,
      'shape-rendering="crispEdges"',
    ].join(" ");
    return [
      '<?xml version="1.0" standalone="yes"?>',
      `<svg ${attributes}>`,
      `<rect width="${dimension}" height="${dimension}" x="0" y="0" fill="#${fill}"/>`,
      `<path d="${this.path()}" fill="#000" transform="translate(${offset},${offset}) scale(${moduleSize})"/>`,
      "</svg>",
    ].join("");
  }

  // RQRCode::Export::SVG::Path: the outline of the dark modules as closed loops of unit edges, merged into runs.
  private path(): string {
    type Direction = "up" | "down" | "left" | "right";
    type Edge = { x: number; y: number; direction: Direction };
    const modules = this.modules as boolean[][];
    const width = modules.length + 1;
    const empty = [new Array<boolean>(width - 1).fill(false)];
    const matrix: (Edge[] | null)[][] = Array.from({ length: width }, () => new Array<Edge[] | null>(width).fill(null));
    const add = (edge: Edge) => (matrix[edge.y]![edge.x] ??= []).push(edge);
    const rows = [...empty, ...modules, ...empty];
    rows.slice(0, -1).forEach((first, rowIndex) => {
      const second = rows[rowIndex + 1]!;
      first.forEach((above, column) => {
        const below = second[column]!;
        if (above && !below) add({ x: column + 1, y: rowIndex, direction: "left" });
        else if (!above && below) add({ x: column, y: rowIndex, direction: "right" });
      });
      const padded = [false, ...second, false];
      for (let column = 0; column < padded.length - 1; column++) {
        const left = padded[column]!;
        const right = padded[column + 1]!;
        if (left && !right) add({ x: column, y: rowIndex, direction: "down" });
        else if (!left && right) add({ x: column, y: rowIndex + 1, direction: "up" });
      }
    });
    const endX = (e: Edge) => (e.direction === "right" ? e.x + 1 : e.direction === "left" ? e.x - 1 : e.x);
    const endY = (e: Edge) => (e.direction === "down" ? e.y + 1 : e.direction === "up" ? e.y - 1 : e.y);
    const commands: Record<Direction, string> = { up: "v-", down: "v", left: "h-", right: "h" };
    let edgeCount = matrix.flat().reduce((sum, cell) => sum + (cell?.length ?? 0), 0);
    let path = "";
    while (edgeCount > 0) {
      const loop: Edge[] = [];
      const row = matrix.find((cells) => cells.some((cell) => cell !== null && cell.length > 0))!;
      let edge: Edge | undefined = row.find((cell) => cell !== null && cell.length > 0)![0];
      while (edge) {
        loop.push(edge);
        const cell: Edge[] = matrix[edge.y]![edge.x]!;
        cell.splice(cell.indexOf(edge), 1);
        if (cell.length === 0) matrix[edge.y]![edge.x] = null;
        edgeCount--;
        edge = matrix[endY(edge)]?.[endX(edge)]?.[0];
      }
      path += `M${loop[0]!.x} ${loop[0]!.y}`;
      const runs: { direction: Direction; length: number }[] = [];
      for (const e of loop) {
        const last = runs.at(-1);
        if (last && last.direction === e.direction) last.length++;
        else runs.push({ direction: e.direction, length: 1 });
      }
      for (const run of runs.slice(0, -1)) path += `${commands[run.direction]}${run.length}`;
      path += "z";
    }
    return path;
  }
}
