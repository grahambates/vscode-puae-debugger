import {
  HeadlessSession,
  LaunchOptions,
  DEFAULT_EXCEPTION_STOPS,
} from "../mcp/emulatorSession";

export type AutomationSession = Pick<HeadlessSession, keyof HeadlessSession> & {
  terminate?: (reason?: string) => Promise<void>;
};
export interface SessionOptions extends LaunchOptions {
  breakpoints?: string[];
  exceptions?: number[];
}
export async function createSession(
  options: SessionOptions,
): Promise<HeadlessSession> {
  const session = await HeadlessSession.launch(options);
  try {
    await session.setExceptionStops(
      options.exceptions ?? DEFAULT_EXCEPTION_STOPS,
    );
    await session.setBreakpoints(options.breakpoints ?? []);
    await session.saveSnapshot("start");
    return session;
  } catch (error) {
    session.dispose();
    throw error;
  }
}
