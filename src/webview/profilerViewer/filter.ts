// Filter compiler ported from the old vscode-amiga-debug `filter.tsx`. Compiles a
// query into a string predicate; the flame chart dims boxes whose function name /
// source path don't match. Supports a /regex/ form, otherwise case-insensitive
// substring.

export interface IRichFilter {
  text: string;
  caseSensitive?: boolean;
  regex?: boolean;
}

export const compileFilter = (fn: IRichFilter): ((input: string) => boolean) => {
  if (fn.regex) {
    try {
      const re = new RegExp(fn.text, fn.caseSensitive ? "" : "i");
      return (input) => re.test(input);
    } catch {
      return () => true; // invalid regex → match everything (don't dim)
    }
  }
  if (!fn.caseSensitive) {
    const test = fn.text.toLowerCase();
    return (input) => input.toLowerCase().includes(test);
  }
  return (input) => input.includes(fn.text);
};
