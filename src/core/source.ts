/** Where the app's own source shows up in Clipmunk's records.
 *
 * In development, clipmunk/vite and clipmunk/next mark every host element with the file that
 * rendered it, so a take knows which files it shows. `tagSources` does it on the compiled module,
 * after JSX became `jsxDEV("div", { ... })` calls (or `createElement`), which every JSX compiler
 * emits in the same shape; it never parses or runs the code, and it leaves components alone.
 */
export const SOURCE_ATTR = "data-clipmunk-src";

const CALL =
  /\b((?:_?jsxDEV|_?jsxs?|(?:React\.)?createElement))(\s*\(\s*)("[a-z][\w.:-]*"|'[a-z][\w.:-]*')(\s*,\s*)(\{|null\b)/g;

/** The module with each host element tagged with `file`, or undefined when it has none. */
export function tagSources(code: string, file: string): string | undefined {
  if (!/jsx|createElement/.test(code)) return undefined;
  const attribute = `${JSON.stringify(SOURCE_ATTR)}: ${JSON.stringify(file)}`;
  let tagged = false;
  const out = code.replace(CALL, (_match, fn: string, open: string, tag: string, comma: string, props: string) => {
    tagged = true;
    return `${fn}${open}${tag}${comma}${props === "{" ? `{${attribute},` : `{ ${attribute} }`}`;
  });
  return tagged ? out : undefined;
}
