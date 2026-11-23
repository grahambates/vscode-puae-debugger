import * as vscode from "vscode";
import { registerInlineExpansion } from "../inlineExpansion";

jest.mock("vscode", () => ({
  Disposable: { from: jest.fn() },
  EventEmitter: class {
    event = jest.fn();
    fire = jest.fn();
  },
  Position: class {
    constructor(readonly line: number, readonly character: number) {}
  },
  MarkdownString: class {
    value = "";
    appendCodeblock(text: string) {
      this.value = text;
      return this;
    }
  },
  InlayHint: class {
    constructor(readonly position: unknown, readonly label: string) {}
  },
  Uri: { file: (path: string) => path },
  languages: { registerInlayHintsProvider: jest.fn() },
  debug: {
    onDidChangeActiveDebugSession: jest.fn(),
    registerDebugAdapterTrackerFactory: jest.fn(),
  },
}));

it("updates substituted inlay hints together and clears them on resume", async () => {
  const path = "/project/main.asm";
  const lines = [
    "loop:   moveq #REPTN,d1  ; counter",
    'table\t dc.b "a;b",REPTN; counter',
    "    addq.w   #1,d0 ; unchanged",
    ".again:  moveq #REPTN,d2",
  ];
  const document = {
    uri: { toString: () => path },
    lineCount: 10,
    lineAt: jest.fn((line: number) => ({
      text: lines[line - 3],
      range: { end: { line, character: lines[line - 3].length } },
    })),
  } as unknown as vscode.TextDocument;
  const range = { contains: () => true } as unknown as vscode.Range;
  const expansion = (iteration: number) => ({
    source: { name: "Expansion.asm", sourceReference: 1 },
    line: 2,
    annotations: [
      { path, line: 4, instruction: ` loop:   moveq\t #${iteration},d1 ; counter` },
      { path, line: 5, instruction: `table\tdc.b   "a;b",${iteration}; counter` },
      { path, line: 6, instruction: "addq.w #1,d0 ; listing comment" },
      { path, line: 7, instruction: `._0001:  moveq   #${iteration},d2` },
    ],
  });
  const expansions = [expansion(0), expansion(1), expansion(2)];
  const customRequest = jest.fn(async (command: string) =>
    command === "source" ? { content: "; Expansion\n moveq #0,d1\n moveq #0,d2" } : expansions.shift(),
  );
  const session = { id: "puae", configuration: { macroListing: "main.lst" }, customRequest };
  Object.assign(vscode.debug, { activeDebugSession: session });
  registerInlineExpansion();
  const [, provider] = jest.mocked(vscode.languages.registerInlayHintsProvider).mock.calls[0];
  const [, factory] = jest.mocked(vscode.debug.registerDebugAdapterTrackerFactory).mock.calls[0];
  const tracker = await factory.createDebugAdapterTracker(session as unknown as vscode.DebugSession);
  const stop = () => tracker?.onDidSendMessage?.({ type: "event", event: "stopped" });
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));

  stop();
  await flush();
  const getHints = () => provider.provideInlayHints(document, range, {} as vscode.CancellationToken) as vscode.InlayHint[];
  const annotationText = () => getHints().map(hint => hint.label);
  const resolve = (hint: vscode.InlayHint) => provider.resolveInlayHint!(hint, {} as vscode.CancellationToken);
  const hints = getHints();
  expect(customRequest).toHaveBeenCalledTimes(1);
  expect((await resolve(hints[0]))?.tooltip).toMatchObject({
    value: "; Expansion\n moveq #0,d1  ; ← stopped here\n moveq #0,d2",
  });
  await resolve(hints[1]);
  expect(customRequest).toHaveBeenCalledTimes(2);
  expect(getHints().map(hint => hint.position)).toEqual([
    { line: 3, character: lines[0].indexOf("  ;") },
    { line: 4, character: lines[1].lastIndexOf(";") },
    { line: 6, character: lines[3].length },
  ]);
  expect(getHints()[1]).toMatchObject({ paddingLeft: true, paddingRight: true });

  expect(annotationText()).toEqual(['→ moveq #0,d1', '→ dc.b "a;b",0', '→ ._0001: moveq #0,d2']);
  tracker?.onWillReceiveMessage?.({ type: "request", command: "stepIn" });
  expect((await resolve(hints[0]))?.tooltip).toBeUndefined();
  expect(getHints()).toEqual([]);

  stop();
  await flush();
  expect(annotationText()).toEqual(['→ moveq #1,d1', '→ dc.b "a;b",1', '→ ._0001: moveq #1,d2']);

  stop();
  await Promise.resolve(); // The request has started, but the response has not been rendered.
  tracker?.onDidSendMessage?.({ type: "event", event: "continued" });
  await flush();
  expect(getHints()).toEqual([]);
});
