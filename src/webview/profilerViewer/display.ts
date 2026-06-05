// Display units for the profiler, ported from the old vscode-amiga-debug
// `display.ts`. The full DisplayUnit enum is kept (incl. the Size units used by the
// future DMA/memory views) so the formulas match the reference 1:1.
//
// All clocks come from the per-capture `Timing` (they are properties of the running
// machine, not constants). PAL only for now — NTSC deferred, so these are just
// populated with the PAL values upstream rather than branched here.

import { ILocation } from "../../shared/profilerTypes";

export enum DisplayUnitType {
  Time,
  Size,
}

export enum DisplayUnit {
  Microseconds,
  Cycles,
  Lines,
  PercentFrame,
  Bytes,
  BytesHex,
  Percent,
}

export interface Timing {
  cyclesPerMicroSecond: number; // CPU clock /1e6 (PAL 7.09379 = 28_375_160 / 4 / 1e6)
  duration: number; // total captured cycles (for the Size-group "% of total" unit)
}

const decimalFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const integerFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

// Time units shown in the profiler dropdown. Bytes/BytesHex are Size units reserved
// for the future DMA/memory views and are intentionally not offered here.
export const unitOptions: { unit: DisplayUnit; label: string }[] = [
  { unit: DisplayUnit.Cycles, label: "Cycles" },
  { unit: DisplayUnit.Microseconds, label: "Microseconds" },
  { unit: DisplayUnit.Lines, label: "Rasterlines" },
  { unit: DisplayUnit.PercentFrame, label: "% of frame" },
];

export const dataName = (unit: DisplayUnit): "Time" | "Size" | "???" => {
  switch (unit) {
    case DisplayUnit.Microseconds:
    case DisplayUnit.Cycles:
    case DisplayUnit.Lines:
    case DisplayUnit.PercentFrame:
      return "Time";
    case DisplayUnit.Bytes:
    case DisplayUnit.BytesHex:
    case DisplayUnit.Percent:
      return "Size";
    default:
      return "???";
  }
};

export const scaleValue = (value: number, unit: DisplayUnit, t: Timing): number => {
  switch (unit) {
    case DisplayUnit.Microseconds:
      return value / t.cyclesPerMicroSecond;
    case DisplayUnit.Cycles:
      return value;
    // PAL defaults to 313 lines, if VPOSW LOF-bit is not set, it's 312 lines;
    // 7.09MHz/50=312.5 lines.
    case DisplayUnit.Lines:
      return (value / t.cyclesPerMicroSecond / 200) * 312.5 / 100;
    // % of a PAL frame (20 ms): µs / 200 (a PAL frame is 20000 µs, so 200 µs = 1%).
    case DisplayUnit.PercentFrame:
      return value / t.cyclesPerMicroSecond / 200;
    case DisplayUnit.Bytes:
      return Math.round(value);
    case DisplayUnit.BytesHex:
      return Math.round(value);
    // % of the captured program time.
    case DisplayUnit.Percent:
      return (value / (t.duration || 1)) * 100;
  }
};

export const formatValue = (value: number, unit: DisplayUnit, t: Timing): string => {
  const v = scaleValue(value, unit, t);
  switch (unit) {
    case DisplayUnit.Microseconds:
      return integerFormat.format(v) + "µs";
    case DisplayUnit.Cycles:
      return integerFormat.format(v) + "cy";
    case DisplayUnit.Lines:
      return decimalFormat.format(v) + "li";
    case DisplayUnit.PercentFrame:
      return decimalFormat.format(v) + "%";
    case DisplayUnit.Bytes:
      return integerFormat.format(v) + "b";
    case DisplayUnit.BytesHex:
      return "$" + v.toString(16);
    case DisplayUnit.Percent:
      return decimalFormat.format(v) + "%";
  }
};

// Human-readable source label for a location (adapted to our CallFrame shape).
export const getLocationText = (loc: ILocation): string | undefined => {
  if (!loc.callFrame.url) return undefined; // 'virtual' frames like (all)
  return `${loc.callFrame.url}${loc.callFrame.lineNumber >= 0 ? `:${loc.callFrame.lineNumber}` : ""}`;
};
