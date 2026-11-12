// Enumerable#sort_by for Integer keys (Ruby 3.4, enum.c). The block is `-views`, always a Fixnum, so Ruby takes its uniform introsort
// (`rb_uniform_intro_sort_2`), which is not stable: rows with equal keys leave in an order only this algorithm gives.
// Golden vectors from Ruby 3.4.12: parity/golden/ruby-sort-by-integer.json (363 arrays with heavy ties, 0 to 500 elements).
type Pair<T> = { key: number; value: T };

const INSERTION_SORT_MAX = 16;

function insertionSort<T>(pairs: Pair<T>[], begin: number, end: number): void {
  for (let index = begin + 1; index < end; index++) {
    const moved = pairs[index]!;
    let j = index;
    if (moved.key < pairs[begin]!.key) {
      while (begin < j) {
        pairs[j] = pairs[j - 1]!;
        j--;
      }
    } else {
      while (moved.key < pairs[j - 1]!.key) {
        pairs[j] = pairs[j - 1]!;
        j--;
      }
    }
    pairs[j] = moved;
  }
}

function heapDown<T>(pairs: Pair<T>[], begin: number, start: number, last: number): void {
  let offset = start;
  const moved = pairs[begin + offset]!;
  for (;;) {
    let child = offset * 2 + 1;
    if (child > last) break;
    if (child < last && pairs[begin + child]!.key < pairs[begin + child + 1]!.key) child++;
    if (!(moved.key < pairs[begin + child]!.key)) break;
    pairs[begin + offset] = pairs[begin + child]!;
    offset = child;
  }
  pairs[begin + offset] = moved;
}

function heapSort<T>(pairs: Pair<T>[], begin: number, end: number): void {
  const n = end - begin;
  if (n < 2) return;
  for (let offset = n >> 1; offset > 0; ) heapDown(pairs, begin, --offset, n - 1);
  for (let offset = n - 1; offset > 0; ) {
    [pairs[begin], pairs[begin + offset]] = [pairs[begin + offset]!, pairs[begin]!];
    heapDown(pairs, begin, 0, --offset);
  }
}

function median(a: number, b: number, c: number): number {
  if (a < b) {
    if (b < c) return b;
    return c < a ? a : c;
  }
  if (c < b) return b;
  return a < c ? a : c;
}

function quickSort<T>(pairs: Pair<T>[], begin: number, end: number, depth: number): void {
  if (end - begin <= INSERTION_SORT_MAX) return insertionSort(pairs, begin, end);
  if (depth === 0) return heapSort(pairs, begin, end);
  const pivot = median(pairs[begin]!.key, pairs[begin + ((end - begin) >> 1)]!.key, pairs[end - 1]!.key);
  let i = begin;
  let j = end - 1;
  do {
    while (pairs[i]!.key < pivot) i++;
    while (pivot < pairs[j]!.key) j--;
    if (i <= j) {
      [pairs[i], pairs[j]] = [pairs[j]!, pairs[i]!];
      i++;
      j--;
    }
  } while (i <= j);
  j++;
  if (end - j > 1) quickSort(pairs, j, end, depth - 1);
  if (i - begin > 1) quickSort(pairs, begin, i, depth - 1);
}

export function rubySortByInteger<T>(items: T[], key: (item: T) => number): T[] {
  const pairs: Pair<T>[] = items.map((value) => ({ key: key(value), value }));
  // A single pair is left as it is, as are keys already in order.
  if (pairs.length > 1 && pairs.some((pair, index) => index > 0 && pairs[index - 1]!.key > pair.key)) {
    const depth = (Math.floor(Math.log2(pairs.length)) || 0) * 2;
    quickSort(pairs, 0, pairs.length, depth);
  }
  return pairs.map((pair) => pair.value);
}
