/** Connects a host entry file by wrapping the argument of its single `.render(...)` call.
 * A small scanner, not a parser: it handles the standard `createRoot(el).render(<App />)`
 * forms and declines anything it is not sure about, so the caller can fall back to
 * printing the instruction. It never guesses.
 */
export type EntryEdit =
  | { status: "wrapped"; source: string }
  | { status: "already" }
  | { status: "manual"; reason: string };

const COMPONENT = "FlickStudioHost";

/** Index just past the parenthesis that closes the one opened at `open`, or -1. */
function matchParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i]!;
    if (char === "/" && source[i + 1] === "/")
      i = source.indexOf("\n", i) === -1 ? source.length : source.indexOf("\n", i);
    else if (char === "/" && source[i + 1] === "*")
      i = source.indexOf("*/", i + 2) === -1 ? source.length : source.indexOf("*/", i + 2) + 1;
    else if (char === '"' || char === "'" || char === "`") {
      const end = closeQuote(source, i);
      if (end === -1) return -1;
      i = end;
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i + 1;
  }
  return -1;
}
function closeQuote(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === quote) return i;
    else if (source[i] === "\n" && quote !== "`") return -1; // an apostrophe in JSX text, not a string
  }
  return -1;
}

export function wrapRootRender(source: string, importPath: string): EntryEdit {
  if (source.includes(COMPONENT)) return { status: "already" };
  const calls = [...source.matchAll(/\.render\s*\(/g)];
  if (calls.length !== 1)
    return {
      status: "manual",
      reason: calls.length
        ? "the entry file has more than one render call"
        : "no root render call was found in the entry file",
    };
  const open = calls[0]!.index + calls[0]![0].length - 1;
  const close = matchParen(source, open);
  if (close === -1) return { status: "manual", reason: "the root render call could not be read safely" };
  const inner = source.slice(open + 1, close - 1);
  const argument = inner.trim().replace(/,$/, "").trim();
  if (!argument.startsWith("<") || !argument.endsWith(">"))
    return { status: "manual", reason: "the root render argument is not a JSX element" };

  const lineStart = source.lastIndexOf("\n", calls[0]!.index) + 1;
  const indent = /^\s*/.exec(source.slice(lineStart))![0];
  const pad = `${indent}  `;
  const body = argument.includes("\n")
    ? argument
        .split("\n")
        .map((line, index) => (index === 0 ? `${pad}  ${line}` : `  ${line}`))
        .join("\n")
    : `${pad}  ${argument}`;
  const wrapped = `\n${pad}<${COMPONENT}>\n${body}\n${pad}</${COMPONENT}>,\n${indent}`;
  let next = source.slice(0, open + 1) + wrapped + source.slice(close - 1);

  const statement = `import { ${COMPONENT} } from "${importPath}";\n`;
  const imports = [...next.matchAll(/^import\b[^;]*?;?[ \t]*$/gm)];
  const multiline = [...next.matchAll(/^import\b[\s\S]*?from\s*["'][^"']+["'];?[ \t]*$/gm)];
  const last = [...imports, ...multiline].reduce((end, match) => Math.max(end, match.index + match[0].length), 0);
  next = last ? `${next.slice(0, last)}\n${statement.trimEnd()}${next.slice(last)}` : statement + next;
  return { status: "wrapped", source: next };
}
