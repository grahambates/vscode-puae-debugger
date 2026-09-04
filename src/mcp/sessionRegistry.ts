// Keeps launched emulator sessions alive between tool calls, so a caller can stop at a
// breakpoint, look around, run on, and look again — the loop that makes this a debugger rather
// than a batch job.
//
// Two limits, both there because a session owns a wasm instance with its own multi-megabyte heap
// and Emscripten offers no way to hand that memory back on demand: a cap on how many can be open
// at once, and eviction of ones nobody has touched in a while. Both report themselves clearly
// when they fire — a caller told "session s1 was closed after 15 minutes idle" can relaunch,
// whereas one handed a bare "unknown session" is stuck.
//
// Sweeping happens on access rather than on a timer: a timer would have to be unref'd to avoid
// holding the process open, and there is nothing a sweep needs to do that can't wait until the
// next call.

import { HeadlessSession } from "./emulatorSession";

/** How long a session may sit untouched before the next tool call evicts it. */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** How many may be open at once. Each holds a full emulated machine. */
const MAX_SESSIONS = 4;

interface Entry {
  session: HeadlessSession;
  program: string;
  lastUsed: number;
}

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private closedReasons = new Map<string, string>();
  private nextId = 1;

  /** Registers a session and returns the id tools address it by. */
  public add(session: HeadlessSession, program: string): string {
    this.sweep();
    if (this.entries.size >= MAX_SESSIONS) {
      const open = [...this.entries.keys()].join(", ");
      session.dispose();
      throw new Error(
        `Too many open emulator sessions (${MAX_SESSIONS}). Close one with emulator_close first — open: ${open}.`,
      );
    }
    const id = `s${this.nextId++}`;
    this.entries.set(id, { session, program, lastUsed: Date.now() });
    return id;
  }

  public get(id: string): HeadlessSession {
    this.sweep();
    const entry = this.entries.get(id);
    if (!entry) {
      const closed = this.closedReasons.get(id);
      if (closed) throw new Error(`Session ${id} is gone: ${closed}. Launch a new one with emulator_launch.`);
      const open = this.entries.size ? [...this.entries.keys()].join(", ") : "none";
      throw new Error(`Unknown session "${id}". Open sessions: ${open}.`);
    }
    entry.lastUsed = Date.now();
    return entry.session;
  }

  public close(id: string, reason = "closed"): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.session.dispose();
    this.entries.delete(id);
    this.closedReasons.set(id, reason);
  }

  public list(): { id: string; program: string; idleMs: number }[] {
    this.sweep();
    const now = Date.now();
    return [...this.entries.entries()].map(([id, e]) => ({ id, program: e.program, idleMs: now - e.lastUsed }));
  }

  /** Drops sessions nobody has used in IDLE_TIMEOUT_MS, recording why so `get` can explain. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of [...this.entries]) {
      if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
        this.close(id, `closed automatically after ${Math.round(IDLE_TIMEOUT_MS / 60000)} minutes idle`);
      }
    }
  }
}
