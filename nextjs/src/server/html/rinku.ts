// Rinku 2.0.6's auto_link (ext/rinku: rinku.c, autolink.c, utf8.c), byte for byte over the UTF-8
// text. Reads past the end see the NUL terminator Ruby keeps after every string, as the C does.
// Names in comments are the C functions.

const CTYPE_SPACE = 1;
const CTYPE_PUNCT = 2;
const CTYPE_DIGIT = 3;
const CTYPE_ALPHA = 4;
// ctype_class
function ctype(c: number): number {
  if (c === 0x20 || (c >= 0x09 && c <= 0x0d)) return CTYPE_SPACE;
  if (c >= 0x30 && c <= 0x39) return CTYPE_DIGIT;
  if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) return CTYPE_ALPHA;
  if (c > 0x20 && c < 0x7f) return CTYPE_PUNCT;
  return 0;
}
const isSpace = (c: number) => ctype(c) === CTYPE_SPACE;
const isAlpha = (c: number) => ctype(c) === CTYPE_ALPHA;
const isAlnum = (c: number) => ctype(c) === CTYPE_DIGIT || ctype(c) === CTYPE_ALPHA;

// utf8proc_utf8class: 0 for continuation bytes and 0xf8..0xff.
const utf8Class = (b: number) => (b < 0x80 ? 1 : b < 0xc0 ? 0 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : b < 0xf8 ? 4 : 0);

const REPLACEMENT_CHARACTER = 0xfffd;

class Text {
  readonly bytes: Uint8Array;
  readonly size: number;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.size = bytes.length;
  }

  at(i: number): number {
    return i < this.size ? this.bytes[i]! : 0;
  }

  // read_cp
  readCp(p: number, length: number): number {
    switch (length) {
      case 1:
        return this.at(p);
      case 2:
        return ((this.at(p) & 0x1f) << 6) + (this.at(p + 1) & 0x3f);
      case 3:
        return ((this.at(p) & 0x0f) << 12) + ((this.at(p + 1) & 0x3f) << 6) + (this.at(p + 2) & 0x3f);
      case 4:
        return (
          ((this.at(p) & 0x07) << 18) +
          ((this.at(p + 1) & 0x3f) << 12) +
          ((this.at(p + 2) & 0x3f) << 6) +
          (this.at(p + 3) & 0x3f)
        );
      default:
        return REPLACEMENT_CHARACTER;
    }
  }

  // utf8proc_next: [code point, new position]
  next(p: number): [number, number] {
    const length = utf8Class(this.at(p));
    return [this.readCp(p, length), p + length];
  }

  // The length utf8proc_back and utf8proc_rewind step back over (0 when no lead byte is found).
  private backLength(p: number): number {
    if ((this.at(p - 1) & 0x80) === 0) return 1;
    if (p > 1 && utf8Class(this.at(p - 2)) === 2) return 2;
    if (p > 2 && utf8Class(this.at(p - 3)) === 3) return 3;
    if (p > 3 && utf8Class(this.at(p - 4)) === 4) return 4;
    return 0;
  }

  // utf8proc_rewind: the code point ending at p.
  rewind(p: number): number {
    if (p === 0) return 0;
    const length = this.backLength(p);
    return length === 1 ? this.at(p - 1) : this.readCp(p - length, length);
  }

  // utf8proc_back: the position before the code point ending at p.
  back(p: number): number {
    return p === 0 ? p : p - this.backLength(p);
  }

  // utf8proc_find_space
  findSpace(p: number): number {
    while (p < this.size) {
      const last = p;
      const [uc, after] = this.next(p);
      p = after;
      if (uc === REPLACEMENT_CHARACTER) return this.size;
      if (isUnicodeSpace(uc)) return last;
    }
    return this.size;
  }
}

// utf8proc_is_space
const isUnicodeSpace = (uc: number) =>
  uc === 9 ||
  uc === 10 ||
  uc === 12 ||
  uc === 13 ||
  uc === 32 ||
  uc === 160 ||
  uc === 5760 ||
  (uc >= 8192 && uc <= 8202) ||
  uc === 8239 ||
  uc === 8287 ||
  uc === 12288;

// utf8proc_is_punctuation: [code point] and [first, last] ranges above ASCII.
const PUNCTUATION: readonly (number | readonly [number, number])[] = [
  161,
  167,
  171,
  182,
  183,
  187,
  191,
  894,
  903,
  [1370, 1375],
  1417,
  1418,
  1470,
  1472,
  1475,
  1478,
  1523,
  1524,
  1545,
  1546,
  1548,
  1549,
  1563,
  1566,
  1567,
  [1642, 1645],
  1748,
  [1792, 1805],
  [2039, 2041],
  [2096, 2110],
  2142,
  2404,
  2405,
  2416,
  2800,
  3572,
  3663,
  3674,
  3675,
  [3844, 3858],
  3860,
  [3898, 3901],
  3973,
  [4048, 4052],
  4057,
  4058,
  [4170, 4175],
  4347,
  [4960, 4968],
  5120,
  5741,
  5742,
  5787,
  5788,
  [5867, 5869],
  5941,
  5942,
  [6100, 6102],
  [6104, 6106],
  [6144, 6154],
  6468,
  6469,
  6686,
  6687,
  [6816, 6822],
  [6824, 6829],
  [7002, 7008],
  [7164, 7167],
  [7227, 7231],
  7294,
  7295,
  [7360, 7367],
  7379,
  [8208, 8231],
  [8240, 8259],
  [8261, 8273],
  [8275, 8286],
  8317,
  8318,
  8333,
  8334,
  [8968, 8971],
  9001,
  9002,
  [10088, 10101],
  10181,
  10182,
  [10214, 10223],
  [10627, 10648],
  [10712, 10715],
  10748,
  10749,
  [11513, 11516],
  11518,
  11519,
  11632,
  [11776, 11822],
  [11824, 11842],
  [12289, 12291],
  [12296, 12305],
  [12308, 12319],
  12336,
  12349,
  12448,
  12539,
  42238,
  42239,
  [42509, 42511],
  42611,
  42622,
  [42738, 42743],
  [43124, 43127],
  43214,
  43215,
  [43256, 43258],
  43310,
  43311,
  43359,
  [43457, 43469],
  43486,
  43487,
  [43612, 43615],
  43742,
  43743,
  43760,
  43761,
  44011,
  64830,
  64831,
  [65040, 65049],
  [65072, 65106],
  [65108, 65121],
  65123,
  65128,
  65130,
  65131,
  [65281, 65283],
  [65285, 65290],
  [65292, 65295],
  65306,
  65307,
  65311,
  65312,
  [65339, 65341],
  65343,
  65371,
  65373,
  [65375, 65381],
  [65792, 65794],
  66463,
  66512,
  66927,
  67671,
  67871,
  67903,
  [68176, 68184],
  68223,
  [68336, 68342],
  [68409, 68415],
  [68505, 68508],
  [69703, 69709],
  69819,
  69820,
  [69822, 69825],
  [69952, 69955],
  70004,
  70005,
  [70085, 70088],
  70093,
  [70200, 70205],
  70854,
  [71105, 71113],
  [71233, 71235],
  [74864, 74868],
  92782,
  92783,
  92917,
  [92983, 92987],
  92996,
  113823,
];
function isUnicodePunctuation(uc: number): boolean {
  if (uc < 128) return ctype(uc) === CTYPE_PUNCT;
  return PUNCTUATION.some((p) => (typeof p === "number" ? p === uc : uc >= p[0] && uc <= p[1]));
}

// utf8proc_open_paren_character
const OPEN_PAREN: Record<number, number> = {
  0x22: 0x22,
  0x27: 0x27,
  0x29: 0x28,
  0x5d: 0x5b,
  0x7d: 0x7b,
  65289: 65288,
  12305: 12304,
  12303: 12302,
  12301: 12300,
  12299: 12298,
  12297: 12296,
};

type Link = { start: number; end: number };

// is_valid_hostchar
function isValidHostchar(text: Text, i: number): boolean {
  const [ch] = text.next(i);
  return !isUnicodeSpace(ch) && !isUnicodePunctuation(ch);
}

const SAFE_PREFIXES = ["/", "http://", "https://", "ftp://", "mailto:"];

// autolink_issafe
function isSafe(text: Text, start: number): boolean {
  const linkLength = text.size - start;
  return SAFE_PREFIXES.some((prefix) => {
    if (linkLength <= prefix.length) return false;
    for (let k = 0; k < prefix.length; k++) {
      const c = text.at(start + k);
      const lower = c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
      if (lower !== prefix.charCodeAt(k)) return false;
    }
    return isAlnum(text.at(start + prefix.length));
  });
}

// autolink_delim
function delim(text: Text, link: Link): boolean {
  for (let i = link.start; i < link.end; i++) {
    if (text.at(i) === 0x3c) {
      link.end = i;
      break;
    }
  }
  while (link.end > link.start) {
    const last = text.at(link.end - 1);
    // strchr("?!.,:", c) also matches the terminating NUL.
    if (last === 0 || "?!.,:".includes(String.fromCharCode(last))) {
      link.end--;
    } else if (last === 0x3b) {
      let newEnd = link.end - 2;
      while (newEnd > 0 && isAlnum(text.at(newEnd))) newEnd--;
      if (newEnd < link.end - 2) {
        if (newEnd > 0 && text.at(newEnd) === 0x23) newEnd--;
        if (text.at(newEnd) === 0x26) {
          link.end = newEnd;
          continue;
        }
      }
      link.end--;
    } else break;
  }
  if (link.end === link.start) return false;

  const cclose = text.rewind(link.end);
  const copen = OPEN_PAREN[cclose] ?? 0;
  if (copen !== 0) {
    let closing = 0;
    let opening = 0;
    let i = link.start;
    while (i < link.end) {
      const [c, after] = text.next(i);
      // A continuation byte reads as length 0; the C loop would spin, but a link never starts
      // or continues mid-character here, so stepping one byte is the same walk.
      i = after === i ? i + 1 : after;
      if (c === copen) opening++;
      else if (c === cclose) closing++;
    }
    if (copen === cclose) {
      if (opening > 0) link.end = text.back(link.end);
    } else if (closing > opening) {
      link.end = text.back(link.end);
    }
  }
  return true;
}

// autolink_delim_iter
function delimIter(text: Text, link: Link): boolean {
  let iterations = 0;
  while (link.end !== 0) {
    const previousEnd = link.end;
    if (!delim(text, link)) return false;
    if (previousEnd === link.end || iterations > 5) break;
    iterations++;
  }
  return true;
}

// check_domain
function checkDomain(text: Text, link: Link, allowShort: boolean): boolean {
  let np = 0;
  let uscore1 = 0;
  let uscore2 = 0;
  if (!isAlnum(text.at(link.start))) return false;
  let i: number;
  for (i = link.start + 1; i < text.size - 1; i++) {
    const c = text.at(i);
    if (c === 0x5f) {
      uscore2++;
    } else if (c === 0x2e) {
      uscore1 = uscore2;
      uscore2 = 0;
      np++;
    } else if (!isValidHostchar(text, i) && c !== 0x2d) break;
  }
  if (uscore1 > 0 || uscore2 > 0) return false;
  link.end = i;
  return allowShort || np > 0;
}

// autolink__www
function www(text: Text, pos: number): Link | null {
  const at = (k: number) => text.at(pos + k);
  if (text.size - pos < 4 || (at(1) !== 0x77 && at(1) !== 0x57) || (at(2) !== 0x77 && at(2) !== 0x57) || at(3) !== 0x2e)
    return null;
  const boundary = text.rewind(pos);
  if (boundary !== 0 && !isUnicodeSpace(boundary) && !isUnicodePunctuation(boundary)) return null;
  const link = { start: pos, end: 0 };
  if (!checkDomain(text, link, false)) return null;
  link.end = text.findSpace(link.end);
  return delimIter(text, link) ? link : null;
}

// autolink__email
function email(text: Text, pos: number): Link | null {
  let nb = 0;
  let np = 0;
  const link = { start: pos, end: pos };
  for (; link.start > 0; link.start--) {
    const c = text.at(link.start - 1);
    // strchr also matches the terminating NUL.
    if (isAlnum(c) || c === 0 || ".+-_%".includes(String.fromCharCode(c))) continue;
    break;
  }
  if (link.start === pos) return null;
  for (; link.end < text.size; link.end++) {
    const c = text.at(link.end);
    if (isAlnum(c)) continue;
    if (c === 0x40) nb++;
    else if (c === 0x2e && link.end < text.size - 1) np++;
    else if (c !== 0x2d && c !== 0x5f) break;
  }
  if (link.end - pos < 2 || nb !== 1 || np === 0 || (np === 1 && text.at(link.end - 1) === 0x2e)) return null;
  return delim(text, link) ? link : null;
}

// autolink__url (no AUTOLINK_SHORT_DOMAINS flag)
function url(text: Text, pos: number): Link | null {
  if (text.size - pos < 4 || text.at(pos + 1) !== 0x2f || text.at(pos + 2) !== 0x2f) return null;
  const link = { start: pos + 3, end: 0 };
  if (!checkDomain(text, link, false)) return null;
  link.start = pos;
  link.end = text.findSpace(link.end);
  while (link.start && isAlpha(text.at(link.start - 1))) link.start--;
  if (!isSafe(text, link.start)) return null;
  return delimIter(text, link) ? link : null;
}

const SKIP_TAGS = ["a", "pre", "code", "kbd", "script"];
const TAG_NONE = 0;
const TAG_OPEN = 1;
const TAG_CLOSE = 2;

// html_is_tag, for the tag starting at `start`
function htmlIsTag(text: Text, start: number, tagName: string): number {
  const tagSize = text.size - start;
  if (tagSize < 3 || text.at(start) !== 0x3c) return TAG_NONE;
  let i = 1;
  let closed = false;
  if (text.at(start + i) === 0x2f) {
    closed = true;
    i++;
  }
  for (let k = 0; i < tagSize && k < tagName.length; i++, k++) {
    if (text.at(start + i) !== tagName.charCodeAt(k)) return TAG_NONE;
  }
  if (i === tagSize) return TAG_NONE;
  const c = text.at(start + i);
  if (isSpace(c) || c === 0x3e) return closed ? TAG_CLOSE : TAG_OPEN;
  return TAG_NONE;
}

// autolink__skip_tag: the offset from `start` to resume scanning at.
function skipTag(text: Text, start: number): number {
  const size = text.size - start;
  let i = 0;
  while (i < size && text.at(start + i) !== 0x3e) i++;
  const tag = SKIP_TAGS.find((name) => htmlIsTag(text, start, name) === TAG_OPEN);
  if (tag !== undefined) {
    for (;;) {
      while (i < size && text.at(start + i) !== 0x3c) i++;
      if (i === size) break;
      if (htmlIsTag(text, start + i, tag) === TAG_CLOSE) break;
      i++;
    }
    while (i < size && text.at(start + i) !== 0x3e) i++;
  }
  return i;
}

const encoder = new TextEncoder();

// Rinku.auto_link(text, :all, link_attr): the default skip tags and no flags or block.
export function autoLink(input: string, linkAttr: string | null = null): string {
  const text = new Text(encoder.encode(input));
  const attr = linkAttr === null ? null : linkAttr.replace(/^[\t\n\v\f\r ]+/u, "");
  const out: Uint8Array[] = [];
  const put = (from: number, to: number) => out.push(text.bytes.subarray(from, to));
  const puts = (s: string) => out.push(encoder.encode(s));
  let linkCount = 0;
  let i = 0;
  let end = 0;
  while (i < text.size) {
    let action = 0;
    while (end < text.size && (action = activeChar(text.at(end))) === 0) end++;
    if (end === text.size) {
      if (linkCount > 0) put(i, end);
      break;
    }
    if (action === ACTION_SKIP_TAG) {
      end += skipTag(text, end);
      continue;
    }
    const link = action === ACTION_WWW ? www(text, end) : action === ACTION_EMAIL ? email(text, end) : url(text, end);
    if (link !== null && link.start >= i) {
      put(i, link.start);
      puts(action === ACTION_WWW ? '<a href="http://' : action === ACTION_EMAIL ? '<a href="mailto:' : '<a href="');
      // print_link: only double quotes are escaped in the href.
      for (let k = link.start; k < link.end; k++) {
        if (text.at(k) === 0x22) puts("&quot;");
        else out.push(text.bytes.subarray(k, k + 1));
      }
      puts(attr === null ? '">' : `" ${attr}>`);
      put(link.start, link.end);
      puts("</a>");
      linkCount++;
      end = i = link.end;
    } else {
      end++;
    }
  }
  if (linkCount === 0) return input;
  return Buffer.concat(out).toString("utf8");
}

const ACTION_WWW = 1;
const ACTION_EMAIL = 2;
const ACTION_URL = 3;
const ACTION_SKIP_TAG = 4;
const activeChar = (c: number) =>
  c === 0x3c
    ? ACTION_SKIP_TAG
    : c === 0x40
      ? ACTION_EMAIL
      : c === 0x77 || c === 0x57
        ? ACTION_WWW
        : c === 0x3a
          ? ACTION_URL
          : 0;
