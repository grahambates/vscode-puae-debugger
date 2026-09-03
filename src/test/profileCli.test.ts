import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as path from "path";
import { runProfileCli } from "../standalone/profileCli";

const FIXTURE = path.join(__dirname, "fixtures/profiles/template.puaeprofile");

// runProfileCli talks to the world through console.log/console.error and its return value
// (never throws for an ordinary bad-input case — see its own header on why: this is meant to
// be scriptable/gateable, so a malformed file is a reported failure with exit 1, not an
// uncaught exception). Capture both streams as an array of lines per call.
function run(argv: string[]): { code: number; out: string; err: string } {
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = runProfileCli(argv);
    const out = log.mock.calls.map((c) => c.join(" ")).join("\n");
    const err = error.mock.calls.map((c) => c.join(" ")).join("\n");
    return { code, out, err };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe("runProfileCli", () => {
  it("prints usage and exits 1 with no subcommand", () => {
    const { code, out } = run([]);
    expect(code).toBe(1);
    expect(out).toContain("Usage:");
  });

  it("prints usage and exits 0 for --help", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
  });

  it("rejects an unknown subcommand", () => {
    const { code, err } = run(["bogus"]);
    expect(code).toBe(1);
    expect(err).toContain("Unknown profile subcommand: bogus");
  });

  it("rejects dump with no file", () => {
    const { code, err } = run(["dump"]);
    expect(code).toBe(1);
    expect(err).toContain("No file given.");
  });

  it("rejects an unknown option", () => {
    const { code, err } = run(["dump", FIXTURE, "--bogus"]);
    expect(code).toBe(1);
    expect(err).toContain("Unknown option: --bogus");
  });

  it("reports a missing file without throwing", () => {
    const { code, err } = run(["dump", "/no/such/file.puaeprofile"]);
    expect(code).toBe(1);
    expect(err).toContain("Could not read");
  });

  it("reports a corrupt file without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "puae-profile-cli-test-"));
    const bad = join(dir, "junk.puaeprofile");
    writeFileSync(bad, "not a profile");
    const { code, err } = run(["dump", bad]);
    expect(code).toBe(1);
    expect(err).toContain("Could not read");
  });

  describe("dump", () => {
    it("prints a manifest summary and per-frame function tables", () => {
      const { code, out } = run(["dump", FIXTURE]);
      expect(code).toBe(0);
      expect(out).toContain("Frame 0:");
      expect(out).toMatch(/function\s+self\s+self%\s+width%\s+samples/);
    });

    it("--frame restricts text output to one frame", () => {
      const { code, out } = run(["dump", FIXTURE, "--frame", "0"]);
      expect(code).toBe(0);
      expect(out).toContain("Frame 0:");
    });

    it("reports a clear message for a frame index the capture doesn't have", () => {
      const { code, out } = run(["dump", FIXTURE, "--frame", "99"]);
      expect(code).toBe(0); // dump is informational; a bad --frame isn't a hard failure
      expect(out).toContain("No such frame 99");
    });

    it("--json emits parseable JSON with the analysis shape", () => {
      const { code, out } = run(["dump", FIXTURE, "--json"]);
      expect(code).toBe(0);
      const parsed = JSON.parse(out);
      expect(parsed).toHaveProperty("manifest");
      expect(parsed).toHaveProperty("frames");
      expect(parsed).toHaveProperty("findings");
      expect(Array.isArray(parsed.frames)).toBe(true);
    });

    it("--json omits the manifest's disassembly (available via dump text instead)", () => {
      const { out } = run(["dump", FIXTURE, "--json"]);
      const parsed = JSON.parse(out);
      expect(parsed.manifest).not.toHaveProperty("disassembly");
    });

    it("--frame scopes the JSON payload to just that frame, not the whole capture", () => {
      const { out } = run(["dump", FIXTURE, "--frame", "0", "--json"]);
      const parsed = JSON.parse(out);
      expect(parsed.frames).toHaveLength(1);
      expect(parsed.frames[0].index).toBe(0);
      // Findings scoped along with it: none belonging to a different (nonexistent here) frame.
      for (const f of parsed.findings) expect([undefined, 0]).toContain(f.frame);
    });

    it("--functions caps the function list in both text and JSON, --functions 0 means unlimited", () => {
      const capped = JSON.parse(run(["dump", FIXTURE, "--json", "--functions", "2"]).out);
      const uncapped = JSON.parse(run(["dump", FIXTURE, "--json", "--functions", "0"]).out);
      expect(capped.frames[0].functions.length).toBeLessThanOrEqual(2);
      expect(uncapped.frames[0].functions.length).toBeGreaterThan(capped.frames[0].functions.length);
    });
  });

  describe("check", () => {
    it("exits 1 when an error-level finding is present", () => {
      // template.puaeprofile carries a known pre-existing frame-over-budget anomaly (see
      // profileAnalysis.test.ts) — a real, useful case for pinning check's gating behavior.
      const { code, out } = run(["check", FIXTURE]);
      expect(code).toBe(1);
      expect(out).toContain("ERROR");
      expect(out).toMatch(/\d+ error\(s\)/);
    });

    it("--json includes the same findings as the text report, unfiltered by any --frame", () => {
      const text = run(["check", FIXTURE]);
      const json = JSON.parse(run(["check", FIXTURE, "--json"]).out);
      expect(json.findings.length).toBeGreaterThan(0);
      expect(json.frames.length).toBe(text.out.split("\n").filter((l: string) => /^frame \d+:/.test(l)).length);
    });

    it("does not accept --frame/--functions filtering (dump-only options)", () => {
      // check has no --frame in its own usage; passing one is simply ignored by argument
      // parsing (still a valid --frame N pair) and must not affect check's own output shape.
      const withFrame = JSON.parse(run(["check", FIXTURE, "--frame", "0", "--json"]).out);
      const without = JSON.parse(run(["check", FIXTURE, "--json"]).out);
      expect(withFrame.frames.length).toBe(without.frames.length);
    });
  });

  it("dump and check agree on the underlying per-frame cycle counts", () => {
    const dumpJson = JSON.parse(run(["dump", FIXTURE, "--json"]).out);
    const checkJson = JSON.parse(run(["check", FIXTURE, "--json"]).out);
    expect(dumpJson.frames.map((f: { cycles: number }) => f.cycles))
      .toEqual(checkJson.frames.map((f: { cycles: number }) => f.cycles));
  });
});
