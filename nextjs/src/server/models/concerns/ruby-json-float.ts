// Port of ext/json/ext/vendor/fpconv.c from the json gem 2.13.2 (Grisu2, as JSON.generate uses
// for Floats). Grisu2 is not always shortest — 1234567890123456.8 becomes 1234567890123456.7 —
// so JS number formatting cannot stand in for it. uint64 arithmetic is BigInt masked to 64 bits.

const MASK64 = (1n << 64n) - 1n;
const u64 = (n: bigint) => n & MASK64;

// 10^k for k = -348, -340, ... 340, normalised to 64-bit fractions.
const POWERS_TEN: [bigint, number][] = [
  [18054884314459144840n, -1220],
  [13451937075301367670n, -1193],
  [10022474136428063862n, -1166],
  [14934650266808366570n, -1140],
  [11127181549972568877n, -1113],
  [16580792590934885855n, -1087],
  [12353653155963782858n, -1060],
  [18408377700990114895n, -1034],
  [13715310171984221708n, -1007],
  [10218702384817765436n, -980],
  [15227053142812498563n, -954],
  [11345038669416679861n, -927],
  [16905424996341287883n, -901],
  [12595523146049147757n, -874],
  [9384396036005875287n, -847],
  [13983839803942852151n, -821],
  [10418772551374772303n, -794],
  [15525180923007089351n, -768],
  [11567161174868858868n, -741],
  [17236413322193710309n, -715],
  [12842128665889583758n, -688],
  [9568131466127621947n, -661],
  [14257626930069360058n, -635],
  [10622759856335341974n, -608],
  [15829145694278690180n, -582],
  [11793632577567316726n, -555],
  [17573882009934360870n, -529],
  [13093562431584567480n, -502],
  [9755464219737475723n, -475],
  [14536774485912137811n, -449],
  [10830740992659433045n, -422],
  [16139061738043178685n, -396],
  [12024538023802026127n, -369],
  [17917957937422433684n, -343],
  [13349918974505688015n, -316],
  [9946464728195732843n, -289],
  [14821387422376473014n, -263],
  [11042794154864902060n, -236],
  [16455045573212060422n, -210],
  [12259964326927110867n, -183],
  [18268770466636286478n, -157],
  [13611294676837538539n, -130],
  [10141204801825835212n, -103],
  [15111572745182864684n, -77],
  [11258999068426240000n, -50],
  [16777216000000000000n, -24],
  [12500000000000000000n, 3],
  [9313225746154785156n, 30],
  [13877787807814456755n, 56],
  [10339757656912845936n, 83],
  [15407439555097886824n, 109],
  [11479437019748901445n, 136],
  [17105694144590052135n, 162],
  [12744735289059618216n, 189],
  [9495567745759798747n, 216],
  [14149498560666738074n, 242],
  [10542197943230523224n, 269],
  [15709099088952724970n, 295],
  [11704190886730495818n, 322],
  [17440603504673385349n, 348],
  [12994262207056124023n, 375],
  [9681479787123295682n, 402],
  [14426529090290212157n, 428],
  [10748601772107342003n, 455],
  [16016664761464807395n, 481],
  [11933345169920330789n, 508],
  [17782069995880619868n, 534],
  [13248674568444952270n, 561],
  [9871031767461413346n, 588],
  [14708983551653345445n, 614],
  [10959046745042015199n, 641],
  [16330252207878254650n, 667],
  [12166986024289022870n, 694],
  [18130221999122236476n, 720],
  [13508068024458167312n, 747],
  [10064294952495520794n, 774],
  [14996968138956309548n, 800],
  [11173611982879273257n, 827],
  [16649979327439178909n, 853],
  [12405201291620119593n, 880],
  [9242595204427927429n, 907],
  [13772540099066387757n, 933],
  [10261342003245940623n, 960],
  [15290591125556738113n, 986],
  [11392378155556871081n, 1013],
  [16975966327722178521n, 1039],
  [12648080533535911531n, 1066],
];

const NPOWERS = 87;
const STEPPOWERS = 8;
const FIRSTPOWER = -348;
const EXPMAX = -32;
const EXPMIN = -60;
const FRACMASK = 0x000fffffffffffffn;
const EXPMASK = 0x7ff0000000000000n;
const HIDDENBIT = 0x0010000000000000n;
const SIGNMASK = 0x8000000000000000n;
const EXPBIAS = 1023 + 52;
const TENS = Array.from({ length: 20 }, (_, i) => 10n ** BigInt(19 - i));

type Fp = { frac: bigint; exp: number };

const shl = (n: bigint, s: number) => u64(n << BigInt(s));

function bitsOf(d: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, d);
  return view.getBigUint64(0);
}

function findCachedPow10(exp: number): { fp: Fp; k: number } {
  const approx = Math.trunc(-(exp + NPOWERS) * 0.30102999566398114);
  let idx = Math.trunc((approx - FIRSTPOWER) / STEPPOWERS);
  for (;;) {
    const current = exp + POWERS_TEN[idx]![1] + 64;
    if (current < EXPMIN) idx++;
    else if (current > EXPMAX) idx--;
    else return { fp: { frac: POWERS_TEN[idx]![0], exp: POWERS_TEN[idx]![1] }, k: FIRSTPOWER + idx * STEPPOWERS };
  }
}

function buildFp(d: number): Fp {
  const bits = bitsOf(d);
  const fp = { frac: bits & FRACMASK, exp: Number((bits & EXPMASK) >> 52n) };
  if (fp.exp) {
    fp.frac += HIDDENBIT;
    fp.exp -= EXPBIAS;
  } else fp.exp = -EXPBIAS + 1;
  return fp;
}

function normalize(fp: Fp) {
  while ((fp.frac & HIDDENBIT) === 0n) {
    fp.frac = shl(fp.frac, 1);
    fp.exp--;
  }
  const shift = 64 - 52 - 1;
  fp.frac = shl(fp.frac, shift);
  fp.exp -= shift;
}

function normalizedBoundaries(fp: Fp): { lower: Fp; upper: Fp } {
  const upper = { frac: u64((fp.frac << 1n) + 1n), exp: fp.exp - 1 };
  while ((upper.frac & (HIDDENBIT << 1n)) === 0n) {
    upper.frac = shl(upper.frac, 1);
    upper.exp--;
  }
  const uShift = 64 - 52 - 2;
  upper.frac = shl(upper.frac, uShift);
  upper.exp -= uShift;
  const lShift = fp.frac === HIDDENBIT ? 2 : 1;
  const lower = { frac: u64(shl(fp.frac, lShift) - 1n), exp: fp.exp - lShift };
  lower.frac = shl(lower.frac, lower.exp - upper.exp);
  lower.exp = upper.exp;
  return { lower, upper };
}

function multiply(a: Fp, b: Fp): Fp {
  const lomask = 0xffffffffn;
  const ahBl = (a.frac >> 32n) * (b.frac & lomask);
  const alBh = (a.frac & lomask) * (b.frac >> 32n);
  const alBl = (a.frac & lomask) * (b.frac & lomask);
  const ahBh = (a.frac >> 32n) * (b.frac >> 32n);
  let tmp = (ahBl & lomask) + (alBh & lomask) + (alBl >> 32n);
  tmp += 1n << 31n;
  return { frac: u64(ahBh + (ahBl >> 32n) + (alBh >> 32n) + (tmp >> 32n)), exp: a.exp + b.exp + 64 };
}

function roundDigit(digits: number[], delta: bigint, rem: bigint, kappa: bigint, frac: bigint) {
  while (rem < frac && delta - rem >= kappa && (rem + kappa < frac || frac - rem > rem + kappa - frac)) {
    digits[digits.length - 1]!--;
    rem += kappa;
  }
}

function generateDigits(fp: Fp, upper: Fp, lower: Fp, digits: number[]): number {
  let K = 0;
  const wfrac = u64(upper.frac - fp.frac);
  let delta = u64(upper.frac - lower.frac);
  const oneExp = upper.exp;
  const oneFrac = 1n << BigInt(-oneExp);
  let part1 = upper.frac >> BigInt(-oneExp);
  let part2 = upper.frac & (oneFrac - 1n);
  let kappa = 10;
  for (let p = 10; kappa > 0; p++) {
    const div = TENS[p]!;
    const digit = part1 / div;
    if (digit || digits.length) digits.push(Number(digit));
    part1 -= digit * div;
    kappa--;
    const tmp = u64((part1 << BigInt(-oneExp)) + part2);
    if (tmp <= delta) {
      K += kappa;
      roundDigit(digits, delta, tmp, u64(div << BigInt(-oneExp)), wfrac);
      return K;
    }
  }
  let unit = 18;
  for (;;) {
    part2 = u64(part2 * 10n);
    delta = u64(delta * 10n);
    kappa--;
    const digit = part2 >> BigInt(-oneExp);
    if (digit || digits.length) digits.push(Number(digit));
    part2 &= oneFrac - 1n;
    if (part2 < delta) {
      K += kappa;
      roundDigit(digits, delta, part2, oneFrac, u64(wfrac * TENS[unit]!));
      return K;
    }
    unit--;
  }
}

function grisu2(d: number): { digits: string; K: number } {
  let w = buildFp(d);
  let { lower, upper } = normalizedBoundaries(w);
  normalize(w);
  const { fp: cp, k } = findCachedPow10(upper.exp);
  w = multiply(w, cp);
  upper = multiply(upper, cp);
  lower = multiply(lower, cp);
  lower.frac = u64(lower.frac + 1n);
  upper.frac = u64(upper.frac - 1n);
  const digits: number[] = [];
  const K = -k + generateDigits(w, upper, lower, digits);
  return { digits: digits.join(""), K };
}

function emitDigits(digits: string, K: number, neg: boolean): string {
  let ndigits = digits.length;
  let exp = Math.abs(K + ndigits - 1);
  const maxTrailingZeros = neg ? 6 : 7;
  if (K >= 0 && exp < ndigits + maxTrailingZeros) return `${digits}${"0".repeat(K)}.0`;
  if (K < 0 && (K > -7 || exp < 10)) {
    const offset = ndigits - Math.abs(K);
    if (offset <= 0) return `0.${"0".repeat(-offset)}${digits}`;
    return `${digits.slice(0, offset)}.${digits.slice(offset)}`;
  }
  ndigits = Math.min(ndigits, 18 - (neg ? 1 : 0));
  let out = digits[0]!;
  if (ndigits > 1) out += `.${digits.slice(1, ndigits)}`;
  out += `e${K + ndigits - 1 < 0 ? "-" : "+"}`;
  let cent = 0;
  if (exp > 99) {
    cent = Math.trunc(exp / 100);
    out += String(cent);
    exp -= cent * 100;
  }
  if (exp > 9) {
    const dec = Math.trunc(exp / 10);
    out += String(dec);
    exp -= dec * 10;
  } else if (cent) out += "0";
  return out + String(exp % 10);
}

// fpconv_dtoa for finite values; JSON.generate prints NaN/Infinity via Float#to_s instead.
export function jsonFloatToS(d: number): string {
  const neg = (bitsOf(d) & SIGNMASK) !== 0n;
  if (d === 0) return neg ? "-0.0" : "0.0";
  const { digits, K } = grisu2(Math.abs(d));
  return (neg ? "-" : "") + emitDigits(digits, K, neg);
}
