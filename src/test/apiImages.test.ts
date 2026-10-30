import { compareImages } from "../api/images";

const image = (bytes: number[]) => ({
  width: bytes.length / 4,
  height: 1,
  rgba: new Uint8Array(bytes),
});
it("compares RGBA with channel tolerance, ratio allowances and ignored regions", () => {
  const before = image([0, 0, 0, 255, 0, 0, 0, 255]);
  const after = image([1, 0, 0, 255, 255, 0, 0, 255]);
  expect(compareImages(after, before)).toMatchObject({
    matches: false,
    differentPixels: 2,
    diffRatio: 1,
  });
  expect(
    compareImages(after, before, { tolerance: 1, maxDiffRatio: 0.5 }),
  ).toMatchObject({ matches: true, differentPixels: 1 });
  const diff = compareImages(after, before, {
    tolerance: 1,
    ignore: [{ x: 1, y: 0, width: 1, height: 1 }],
  });
  expect(diff).toMatchObject({
    matches: true,
    comparedPixels: 1,
    differentPixels: 0,
  });
  expect(diff.png.subarray(1, 4).toString()).toBe("PNG");
});
it("validates dimensions, thresholds and masks", () => {
  const pixel = image([0, 0, 0, 255]);
  expect(() =>
    compareImages(pixel, image([0, 0, 0, 255, 0, 0, 0, 255])),
  ).toThrow("dimensions differ");
  expect(() => compareImages(pixel, pixel, { tolerance: NaN })).toThrow(
    "tolerance",
  );
  expect(() => compareImages(pixel, pixel, { maxDiffRatio: 2 })).toThrow(
    "maxDiffRatio",
  );
  expect(() =>
    compareImages(pixel, pixel, {
      ignore: [{ x: -1, y: 0, width: 1, height: 1 }],
    }),
  ).toThrow("rectangles");
});
