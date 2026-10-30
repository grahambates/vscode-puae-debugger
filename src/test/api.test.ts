import { Emulator, launch } from "../api";
import { HeadlessSession } from "../mcp/emulatorSession";

function fixture() {
  const session = {
    continueUntilStop: jest
      .fn()
      .mockResolvedValue({ stopped: false, framesRun: 3 }),
    inspect: jest
      .fn()
      .mockResolvedValue({
        cpu: { pc: "1234" },
        memory: [{ data: Buffer.from([1, 2]) }],
      }),
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
    expect(session.inspect).toHaveBeenCalledWith([
      { address: "0x1234", bytes: 2 },
    ]);
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
});
