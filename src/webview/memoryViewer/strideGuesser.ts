/**
 *  Heuristics to guess the byte-width (stride) of a 1-bit-per-pixel
 *  image embedded in an unknown-length binary buffer.
 */

/**
 * Expand each byte into an array of 8 bits (MSB-first).
 */
function bytesToBits(data: Uint8Array): number[] {
  const bits: number[] = new Array(data.length * 8);
  let k = 0;
  for (const b of data) {
    for (let i = 7; i >= 0; i--) {
      bits[k++] = (b >> i) & 1;
    }
  }
  return bits;
}

/**
 * Reshape the first `sampleRows` rows only.
 * Ignores any remainder of the buffer.
 */
function reshapeSample(
  bits: number[],
  widthBits: number,
  sampleRows: number,
): number[][] | null {
  const rowBits = widthBits * sampleRows;
  if (bits.length < rowBits) {
    return null;
  }
  const rows: number[][] = new Array(sampleRows);
  for (let r = 0; r < sampleRows; r++) {
    rows[r] = bits.slice(r * widthBits, (r + 1) * widthBits);
  }
  return rows;
}

/**
 * Similarity of each row to the next → vertical continuity
 */
function verticalCorrelation(img: number[][]): number {
  let same = 0;
  let total = 0;
  for (let r = 0; r < img.length - 1; r++) {
    const currentRow = img[r];
    const nextRow = img[r + 1];
    // Count pixels which are the same in  both rows
    for (let c = 0; c < currentRow.length; c++) {
      if (currentRow[c] === nextRow[c]) {
        same++;
      }
      total++;
    }
  }
  return total ? same / total : 0;
}

/**
 * Variance of column sums → strong vertical structure
 */
function columnVariance(img: number[][]): number {
  const h = img.length;
  const w = img[0].length;
  const sums = new Array(w).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      sums[x] += img[y][x];
    }
  }

  const mean = sums.reduce((a, b) => a + b, 0) / w;
  const varSum = sums.reduce((a, b) => a + (b - mean) ** 2, 0) / w;
  return varSum / (h * h + 1e-9); // normalise
}

/** Continuity of vertical edges */
function verticalEdgeContinuity(img: number[][]): number {
  const h = img.length;
  const w = img[0].length;
  let cont = 0;
  let total = 0;
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const currentEdge = img[y][x] !== img[y][x + 1];
      const nextEdge = img[y + 1][x] !== img[y + 1][x + 1];
      if (currentEdge && nextEdge) cont++;
      total++;
    }
  return total ? cont / total : 0;
}

/**
 * Fraction of interior pixels whose four immediate neighbours (up/down/left/
 * right) all share the same value. Real images tend to be dominated by large
 * solid blocks of black or white; misalignment chops these blocks up into
 * fragments and replaces them with diagonal noise, so this score drops
 * sharply once the guessed width is wrong.
 */
function solidBlockScore(img: number[][]): number {
  const h = img.length;
  const w = img[0].length;
  if (h < 3 || w < 3) {
    return 0;
  }

  let solid = 0;
  let total = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const v = img[y][x];
      if (
        img[y - 1][x] === v &&
        img[y + 1][x] === v &&
        img[y][x - 1] === v &&
        img[y][x + 1] === v
      ) {
        solid++;
      }
      total++;
    }
  }
  return total ? solid / total : 0;
}

/** Weighted combination of all scores */
function combinedScore(img: number[][]): number {
  const verticalCorrelationScore = verticalCorrelation(img);
  const columnVarianceScore = columnVariance(img);
  const verticalEdgeContinuityScore = verticalEdgeContinuity(img);
  const solidBlockScoreValue = solidBlockScore(img);
  // Adjust weights if desired
  return (
    verticalCorrelationScore +
    columnVarianceScore +
    verticalEdgeContinuityScore +
    solidBlockScoreValue
  );
}

export interface WidthGuess {
  widthBytes: number;
  widthBits: number;
  sampleRows: number;
  score: number;
}

/** Keep whichever guess scores higher */
function betterGuess(
  a: WidthGuess | undefined,
  b: WidthGuess,
): WidthGuess {
  return !a || b.score > a.score ? b : a;
}

/**
 * Guess the most plausible byte-width when image length is unknown.
 *
 * Amiga bitplane rows are stored as whole 16-bit words, so only even byte
 * widths (i.e. pixel widths that are multiples of 16) are considered.
 *
 * @param data           Raw buffer
 * @param minWidthBytes  Minimum width to test (≥2, rounded up to an even value)
 * @param maxWidthBytes  Maximum width to test
 * @param sampleRows     Number of rows from top of buffer to analyse
 */
export function guessWidthsUnknownLength(
  data: Uint8Array,
  minWidthBytes = 30,
  maxWidthBytes: number = Math.min(1024, data.length),
  sampleRows = 32,
): WidthGuess | undefined {
  const bits = bytesToBits(data);

  let best: WidthGuess | undefined;

  const start = minWidthBytes + (minWidthBytes % 2);
  for (let wb = start; wb <= maxWidthBytes; wb += 2) {
    const widthBits = wb * 8;
    const img = reshapeSample(bits, widthBits, sampleRows);
    if (!img) {
      continue;
    }

    const score = combinedScore(img);
    best = betterGuess(best, { widthBytes: wb, widthBits, sampleRows, score });
  }

  return best;
}

/**
 * Guess the most plausible byte-width when the total image length is known.
 *
 * Unlike the unknown-length case, a bitmap's pixel data should exactly fill
 * its declared length, so only widths that evenly divide that length (giving
 * a whole number of rows) are considered. This narrows the search space
 * dramatically and scores each candidate over the entire image rather than a
 * small sample from the top, giving far more reliable results.
 *
 * Amiga bitplane rows are stored as whole 16-bit words, so only even byte
 * widths (i.e. pixel widths that are multiples of 16) are considered.
 *
 * @param data           Raw buffer covering the full known length
 * @param minWidthBytes  Minimum width to test (≥2, rounded up to an even value)
 * @param maxWidthBytes  Maximum width to test
 */
export function guessWidthsKnownLength(
  data: Uint8Array,
  minWidthBytes = 4,
  maxWidthBytes: number = data.length,
): WidthGuess | undefined {
  const bits = bytesToBits(data);

  let best: WidthGuess | undefined;

  const start = minWidthBytes + (minWidthBytes % 2);
  for (let wb = start; wb <= maxWidthBytes; wb += 2) {
    if (data.length % wb !== 0) {
      continue;
    }
    const rows = data.length / wb;
    if (rows < 2) {
      continue;
    }
    const widthBits = wb * 8;
    const img = reshapeSample(bits, widthBits, rows);
    if (!img) {
      continue;
    }

    const score = combinedScore(img);
    best = betterGuess(best, { widthBytes: wb, widthBits, sampleRows: rows, score });
  }

  return best;
}
