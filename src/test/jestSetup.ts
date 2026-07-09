/* eslint-disable @typescript-eslint/no-explicit-any */

// Mock the vscode module for Jest tests
jest.mock(
  "vscode",
  () => ({
    window: {
      showErrorMessage: jest.fn(),
      showInformationMessage: jest.fn(),
      setStatusBarMessage: jest.fn(),
      createWebviewPanel: jest.fn(),
      createTextEditorDecorationType: jest.fn(() => ({ dispose: jest.fn() })),
      visibleTextEditors: [] as unknown[],
    },
    workspace: {
      getConfiguration: jest.fn(() => ({
        get: jest.fn(),
      })),
      workspaceFolders: [],
    },
    Uri: {
      file: jest.fn((path: string) => ({ fsPath: path, toString: () => path })),
      joinPath: jest.fn((uri: any, ...segments: string[]) => ({
        fsPath: [uri.fsPath, ...segments].join("/"),
        toString: () => [uri.fsPath, ...segments].join("/"),
      })),
    },
    ViewColumn: {
      One: 1,
      Two: 2,
      Three: 3,
      Beside: -1,
      Active: -2,
    },
    OutputEvent: class MockOutputEvent {
      constructor(
        public data: string,
        public category?: string,
      ) {}
    },
    TerminatedEvent: class MockTerminatedEvent {},
    Range: class MockRange {
      constructor(
        public startLine: number,
        public startChar: number,
        public endLine?: number,
        public endChar?: number,
      ) {}
    },
    CodeLens: class MockCodeLens {
      constructor(
        public range: unknown,
        public command?: unknown,
      ) {}
    },
    EventEmitter: class MockEventEmitter {
      private listeners: ((e: unknown) => void)[] = [];
      public event = (listener: (e: unknown) => void) => {
        this.listeners.push(listener);
        return { dispose: () => undefined };
      };
      public fire(e?: unknown): void {
        for (const l of this.listeners) l(e);
      }
    },
    ThemeColor: class MockThemeColor {
      constructor(public id: string) {}
    },
    MarkdownString: class MockMarkdownString {
      public value = "";
      public appendMarkdown(s: string): this {
        this.value += s;
        return this;
      }
    },
    Hover: class MockHover {
      constructor(public contents: unknown) {}
    },
    languages: {
      registerCodeLensProvider: jest.fn(),
      registerHoverProvider: jest.fn(),
    },
  }),
  { virtual: true },
);

// Suppress expected DAP protocol violation warnings in tests
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
  const message = args[0];
  if (
    typeof message === "string" &&
    message.includes("attempt to send more than one response")
  ) {
    return; // Suppress this specific error in tests
  }
  originalConsoleError.apply(console, args);
};

// Export empty object to make this a module
export {};
