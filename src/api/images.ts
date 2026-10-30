import { encodePng } from "../mcp/png";
export interface Image {
  rgba: Uint8Array;
  width: number;
  height: number;
}
export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CompareOptions {
  /** Maximum absolute difference per RGBA channel, 0–255. Default 0 (exact). */
  tolerance?: number;
  /** Allowed fraction of differing, unmasked pixels, 0–1. Default 0. */
  maxDiffRatio?: number;
  ignore?: Rectangle[];
}
function validate(image: Image) {
  if (
    !Number.isSafeInteger(image.width) ||
    !Number.isSafeInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    image.rgba.length !== image.width * image.height * 4
  ) {
    throw new RangeError("Image dimensions must match its RGBA data");
  }
}
/** Compare raw screenshots; returns a red difference image for failure artifacts. */
export function compareImages(
  actual: Image,
  expected: Image,
  options: CompareOptions = {},
) {
  validate(actual);
  validate(expected);
  if (actual.width !== expected.width || actual.height !== expected.height)
    throw new Error("Image dimensions differ");
  const tolerance = options.tolerance ?? 0;
  const allowed = options.maxDiffRatio ?? 0;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255)
    throw new RangeError("tolerance must be an integer from 0 to 255");
  if (!Number.isFinite(allowed) || allowed < 0 || allowed > 1)
    throw new RangeError("maxDiffRatio must be from 0 to 1");
  for (const rect of options.ignore ?? []) {
    if (
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) ||
      rect.x < 0 ||
      rect.y < 0 ||
      rect.width < 0 ||
      rect.height < 0 ||
      rect.x + rect.width > actual.width ||
      rect.y + rect.height > actual.height
    )
      throw new RangeError("Ignored rectangles must fit within the image");
  }
  let comparedPixels = 0;
  let differentPixels = 0;
  const rgba = new Uint8Array(actual.rgba.length);
  for (let y = 0; y < actual.height; y++)
    for (let x = 0; x < actual.width; x++) {
      const i = (y * actual.width + x) * 4;
      const ignored = options.ignore?.some(
        (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
      );
      const changed =
        !ignored &&
        [0, 1, 2, 3].some(
          (c) =>
            Math.abs(actual.rgba[i + c] - expected.rgba[i + c]) > tolerance,
        );
      if (!ignored) comparedPixels++;
      if (changed) differentPixels++;
      const gray = Math.round(
        (actual.rgba[i] + actual.rgba[i + 1] + actual.rgba[i + 2]) / 6,
      );
      rgba.set(changed ? [255, 0, 0, 255] : [gray, gray, gray, 255], i);
    }
  const diffRatio = comparedPixels ? differentPixels / comparedPixels : 0;
  return {
    matches: diffRatio <= allowed,
    differentPixels,
    comparedPixels,
    diffRatio,
    png: encodePng(rgba, actual.width, actual.height),
    rgba,
    width: actual.width,
    height: actual.height,
  };
}
export const images = { compare: compareImages };
