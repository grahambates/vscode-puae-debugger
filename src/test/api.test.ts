import { Emulator, launch } from "../api";
import { HeadlessSession } from "../mcp/emulatorSession";

function fixture() {
  const session = {
    continueUntilStop: jest
      .fn()
      .mockResolvedValue({ stopped: false, framesRun: 3 }),
    inspect: jest.fn().mockResolvedValue({
      cpu: { pc: "1234" },
      memory: [{ data: Buffer.from([1, 2]) }],
    }),
    readBytes: jest.fn().mockResolvedValue(Buffer.from([1, 2])),
    takeSerial: jest.fn().mockReturnValue({ text: "", dropped: 0 }),
    resolveAddress: jest.fn().mockReturnValue(0x2000),
    hasBreakpoint: jest.fn().mockReturnValue(false),
    setBreakpoints: jest.fn().mockResolvedValue([]),
    removeBreakpoints: jest.fn().mockResolvedValue([]),
    releaseAll: jest.fn(),
    input: jest.fn().mockResolvedValue({ played: [], held: [] }),
    write: jest.fn().mockResolvedValue([]),
    dispose: jest.fn(),
  };
  return {
    session,
    emulator: new Emulator(session as unknown as HeadlessSession),
  };
}

describe("JavaScript automation API", () => {
  it("returns structured stops and binary memory with numeric addresses", async () => {
    const { session, emulator } = fixture();
    expect(await emulator.run({ frames: 3 })).toEqual({
      stopped: false,
      framesRun: 3,
    });
    expect(await emulator.memory.read(0x1234, 2)).toEqual(Buffer.from([1, 2]));
    expect(session.readBytes).toHaveBeenCalledWith("0x1234", 2);
  });
  it("rejects unbounded or fractional frame budgets before driving the core", async () => {
    const { session, emulator } = fixture();
    for (const frames of [0, -1, NaN, Infinity, 1.5, 5001]) {
      await expect(emulator.run({ frames })).rejects.toThrow(
        "frames must be an integer",
      );
    }
    expect(session.continueUntilStop).not.toHaveBeenCalled();
  });
  it("maps readable inputs and binary writes to the shared session", async () => {
    const { session, emulator } = fixture();
    await emulator.keyboard.press("Space");
    expect(session.input.mock.calls[0][0][0]).toMatchObject({
      kind: "key",
      name: "Space",
      code: 32,
    });
    await emulator.mouse.click("right");
    expect(session.input.mock.calls[1][0][0]).toMatchObject({
      kind: "click",
      button: 2,
    });
    await emulator.joystick.down("fire");
    expect(session.input.mock.calls[2][0][0]).toMatchObject({
      kind: "joyPress",
      bit: 0,
    });
    await expect(emulator.keyboard.press("nonsense")).rejects.toThrow(
      "Unknown keyboard code",
    );
    await emulator.memory.write(0x200, new Uint8Array([4, 5]));
    expect(session.write).toHaveBeenCalledWith({
      memory: [{ address: "0x200", bytes: Buffer.from([4, 5]) }],
      registers: [],
      custom: [],
    });
  });
  it("guards overlapping operations, and closes exactly once", async () => {
    const { session, emulator } = fixture();
    let finish!: () => void;
    session.continueUntilStop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const running = emulator.run();
    await expect(emulator.inspect()).rejects.toThrow("already running");
    await expect(emulator.close()).rejects.toThrow("active emulator operation");
    finish();
    await running;
    await emulator.close();
    await emulator.close();
    expect(session.dispose).toHaveBeenCalledTimes(1);
    await expect(emulator.run()).rejects.toThrow("closed");
    await expect(emulator.screenshot()).rejects.toThrow("closed");
  });
  it("disposes a launch that fails while arming breakpoints", async () => {
    const session = {
      setExceptionStops: jest.fn().mockResolvedValue(undefined),
      setBreakpoints: jest.fn().mockRejectedValue(new Error("Unknown symbol")),
      dispose: jest.fn(),
    };
    const spy = jest
      .spyOn(HeadlessSession, "launch")
      .mockResolvedValue(session as unknown as HeadlessSession);
    try {
      await expect(
        launch({
          isolate: false,
          program: "demo",
          kickstartRom: "rom",
          breakpoints: ["missing"],
        }),
      ).rejects.toThrow("Unknown symbol");
      expect(session.dispose).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("decodes big-endian scalars and bounded null-terminated strings", async () => {
    const { session, emulator } = fixture();
    session.readBytes.mockResolvedValueOnce(Buffer.from([0xab]));
    expect(await emulator.memory.readByte(0)).toBe(0xab);
    session.readBytes.mockResolvedValueOnce(Buffer.from([0x12, 0x34]));
    expect(await emulator.memory.readWord(0)).toBe(0x1234);
    session.readBytes.mockResolvedValueOnce(
      Buffer.from([0x89, 0xab, 0xcd, 0xef]),
    );
    expect(await emulator.memory.readLong(0)).toBe(0x89abcdef);
    session.readBytes.mockResolvedValueOnce(Buffer.from("ok\0rest"));
    expect(await emulator.memory.readString(0)).toBe("ok");
    session.readBytes.mockResolvedValueOnce(Buffer.from("no null"));
    await expect(emulator.memory.readString(0)).rejects.toThrow("Unterminated");
  });

  it("checks memory before running and reports timeout values or debugger interruptions", async () => {
    const { session, emulator } = fixture();
    session.readBytes.mockResolvedValueOnce(Buffer.from([0, 7]));
    expect(await emulator.waitForMemory("ready", { equals: 7 })).toMatchObject({
      value: 7,
      framesRun: 0,
    });
    expect(session.continueUntilStop).not.toHaveBeenCalled();
    session.readBytes.mockResolvedValue(Buffer.from([0, 1]));
    await expect(
      emulator.waitForMemory("ready", { equals: 7, frames: 2 }),
    ).rejects.toMatchObject({ name: "WaitError", actual: 1 });
    expect(session.continueUntilStop).toHaveBeenCalledTimes(2);
    session.continueUntilStop.mockResolvedValueOnce({
      stopped: true,
      reason: "CATCHPOINT_REACHED",
      framesRun: 1,
    });
    await expect(
      emulator.waitForMemory("ready", { equals: 7 }),
    ).rejects.toThrow("CATCHPOINT_REACHED");
  });

  it("matches serial output split across frames and leaves caller regex state alone", async () => {
    const { session, emulator } = fixture();
    session.takeSerial
      .mockReturnValueOnce({ text: "PA", dropped: 0 })
      .mockReturnValueOnce({ text: "SS\n", dropped: 0 });
    const pattern = /PASS/g;
    pattern.lastIndex = 2;
    expect(await emulator.waitForSerial(pattern)).toMatchObject({
      text: "PASS\n",
      framesRun: 1,
    });
    expect(pattern.lastIndex).toBe(2);
    session.takeSerial.mockReturnValue({ text: "", dropped: 1 });
    await expect(emulator.waitForSerial("PASS")).rejects.toThrow("overflowed");
  });

  it("removes temporary run-until breakpoints on timeout but preserves existing ones", async () => {
    const { session, emulator } = fixture();
    session.continueUntilStop.mockResolvedValue({
      stopped: false,
      framesRun: 2,
      pc: 0x1234,
      location: "main",
    });
    await expect(emulator.runUntil("target", { frames: 2 })).rejects.toThrow(
      "timed out",
    );
    expect(session.setBreakpoints).toHaveBeenCalledWith(["0x2000"]);
    expect(session.removeBreakpoints).toHaveBeenCalledWith(["0x2000"]);
    session.setBreakpoints.mockClear();
    session.removeBreakpoints.mockClear();
    session.hasBreakpoint.mockReturnValue(true);
    session.continueUntilStop.mockResolvedValue({
      stopped: true,
      framesRun: 1,
      pc: 0x2000,
      reason: "BREAKPOINT_REACHED",
    });
    expect(await emulator.runUntil("target")).toMatchObject({ pc: 0x2000 });
    expect(session.setBreakpoints).not.toHaveBeenCalled();
    expect(session.removeBreakpoints).not.toHaveBeenCalled();
  });

  it("releases input without advancing a frame", async () => {
    const { session, emulator } = fixture();
    await emulator.releaseAll();
    expect(session.releaseAll).toHaveBeenCalled();
    expect(session.continueUntilStop).not.toHaveBeenCalled();
  });
});
