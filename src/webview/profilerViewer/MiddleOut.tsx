// Middle-ellipsis text: keeps the start AND the end (e.g. the filename + line)
// visible, putting the ellipsis in the middle. Ported from the old
// vscode-amiga-debug `MiddleOut` (CSS in App.css under .middle-out).
export function MiddleOut({
  text,
  startChars = 5,
  endChars = 8,
}: {
  text: string;
  startChars?: number;
  endChars?: number;
}) {
  const startText = text.slice(0, -endChars);
  const startWidth = 0.5 * startChars;
  const endWidth = 0.5 * endChars;
  return (
    <span className="middle-out" aria-label={text}>
      {/* No start portion (e.g. a file with no directory prefix) — skip the minWidth reservation,
          or it renders as a blank box before the text (left "padding"), and let the end span use
          the full width instead of leaving room for a start that isn't there. */}
      <span style={{ maxWidth: `calc(100% - ${endWidth}em)`, minWidth: startText ? `${startWidth}em` : undefined }}>
        {startText}
      </span>
      <span aria-hidden="true" style={{ maxWidth: startText ? `calc(100% - ${startWidth}em)` : "100%" }}>
        {text.slice(-endChars)}
      </span>
    </span>
  );
}
