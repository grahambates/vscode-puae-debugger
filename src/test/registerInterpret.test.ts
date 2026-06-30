import { interpretDataReg, interpretAddressReg } from "../webview/profilerViewer/registerInterpret";

describe("interpretDataReg", () => {
  it("interprets a small positive value the same across all widths", () => {
    expect(interpretDataReg(5)).toEqual([
      { label: "i8", value: 5 },
      { label: "u8", value: 5 },
      { label: "i16", value: 5 },
      { label: "u16", value: 5 },
      { label: "i32", value: 5 },
      { label: "u32", value: 5 },
    ]);
  });

  it("sign-extends/truncates 0xffffffff (-1) per width", () => {
    expect(interpretDataReg(0xffffffff)).toEqual([
      { label: "i8", value: -1 },
      { label: "u8", value: 0xff },
      { label: "i16", value: -1 },
      { label: "u16", value: 0xffff },
      { label: "i32", value: -1 },
      { label: "u32", value: 0xffffffff },
    ]);
  });

  it("only the low byte feeds i8/u8 (0x1234 truncates to 0x34)", () => {
    const result = interpretDataReg(0x1234);
    expect(result.find((r) => r.label === "u8")).toEqual({ label: "u8", value: 0x34 });
    expect(result.find((r) => r.label === "i8")).toEqual({ label: "i8", value: 0x34 });
  });
});

describe("interpretAddressReg", () => {
  it("has no i8/u8 entries (address registers don't support byte ops)", () => {
    const result = interpretAddressReg(0x1234);
    expect(result.map((r) => r.label)).toEqual(["i16", "u16", "i32", "u32"]);
  });

  it("sign-extends/truncates 0xffffffff (-1) per width", () => {
    expect(interpretAddressReg(0xffffffff)).toEqual([
      { label: "i16", value: -1 },
      { label: "u16", value: 0xffff },
      { label: "i32", value: -1 },
      { label: "u32", value: 0xffffffff },
    ]);
  });
});
