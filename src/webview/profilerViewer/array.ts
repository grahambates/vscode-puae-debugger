// Binary search (ported from the old vscode-amiga-debug `array.ts`). Returns the
// index of an exact match, or the negative of the insertion index (-(idx+1)) that
// keeps the array sorted. Used for column hit-testing under the cursor.
export function binarySearch<T>(array: readonly T[], comparator: (value: T) => number): number {
  let low = 0;
  let high = array.length - 1;
  while (low <= high) {
    const mid = ((low + high) / 2) | 0;
    const comp = comparator(array[mid]);
    if (comp < 0) low = mid + 1;
    else if (comp > 0) high = mid - 1;
    else return mid;
  }
  return -(low + 1);
}
