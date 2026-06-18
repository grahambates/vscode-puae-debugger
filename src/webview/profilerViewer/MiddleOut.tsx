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
  const startWidth = 0.5 * startChars;
  const endWidth = 0.5 * endChars;
  return (
    <span className="middle-out" aria-label={text}>
      <span style={{ maxWidth: `calc(100% - ${endWidth}em)`, minWidth: `${startWidth}em` }}>
        {text.slice(0, -endChars)}
      </span>
      <span aria-hidden="true" style={{ maxWidth: `calc(100% - ${startWidth}em)` }}>
        {text.slice(-endChars)}
      </span>
    </span>
  );
}
