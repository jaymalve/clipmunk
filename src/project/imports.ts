import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { toPosix } from "./services";

/** The project files a module depends on: its static `import`s and `export … from`s, followed
 * through the project, resolved the way the host's bundler would for relative paths and the
 * `paths` (and `baseUrl`) of tsconfig.json or jsconfig.json. Packages are not followed; styles,
 * JSON and images a module imports are included but not read further. Like `entry.ts`, it is a
 * scanner and never runs code. Type-only imports change no frame, so they are left out.
 */
const CODE = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const isCode = (file: string) => CODE.includes(path.extname(file)) && !file.endsWith(".d.ts");

/** The source without comments, keeping strings (where the specifiers are) intact. */
export function stripComments(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end - 1;
    } else if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
      out += " ";
    } else if (char === '"' || char === "'" || char === "`") {
      let j = i + 1;
      for (; j < source.length && source[j] !== char; j++) {
        if (source[j] === "\\") j++;
        // An apostrophe in JSX text, not a string: stop at the end of the line.
        else if (source[j] === "\n" && char !== "`") break;
      }
      out += source.slice(i, j + 1);
      i = j;
    } else out += char;
  }
  return out;
}

// Each at the start of a statement, so the words in JSX text or a string are not imports.
const PATTERNS = [
  /(?:^|[\n;])[ \t]*import\s+(?!type\s)(?:[\w$]+\s*,?\s*)?(?:\*\s*as\s+[\w$]+|\{[^}]*\})?\s*from\s*(["'])([^"'\n]+)\1/g,
  /(?:^|[\n;])[ \t]*import\s*(["'])([^"'\n]+)\1/g,
  /(?:^|[\n;])[ \t]*export\s+(?!type\s)(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(["'])([^"'\n]+)\1/g,
];

/** The module specifiers a source file imports, in order, without type-only ones. */
export function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const found: { at: number; specifier: string }[] = [];
  for (const pattern of PATTERNS)
    for (const match of code.matchAll(pattern)) found.push({ at: match.index, specifier: match[2]! });
  return [...new Set(found.sort((a, b) => a.at - b.at).map((item) => item.specifier))];
}

type Aliases = { baseUrl?: string; paths: [string, string[]][] };

/** tsconfig.json or jsconfig.json is JSON with comments and trailing commas. */
const parseJsonc = (text: string) => JSON.parse(stripComments(text).replace(/,(\s*[}\]])/g, "$1"));

async function readAliases(root: string): Promise<Aliases> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    let file = path.join(root, name);
    const seen = new Set<string>();
    let baseUrl: string | undefined;
    let paths: Record<string, string[]> | undefined;
    let pathsFrom = root;
    // Follow relative `extends`: the nearest file that sets a value wins.
    while (!seen.has(file)) {
      seen.add(file);
      let config: { extends?: unknown; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      try {
        config = parseJsonc(await readFile(file, "utf8"));
      } catch {
        break;
      }
      const options = config.compilerOptions ?? {};
      if (baseUrl === undefined && typeof options.baseUrl === "string")
        baseUrl = path.resolve(path.dirname(file), options.baseUrl);
      if (!paths && options.paths) {
        paths = options.paths;
        pathsFrom = path.dirname(file);
      }
      if (typeof config.extends !== "string" || !config.extends.startsWith(".")) break;
      file = path.resolve(path.dirname(file), config.extends);
      if (!file.endsWith(".json")) file += ".json";
    }
    if (seen.size && (baseUrl || paths)) {
      // Paths are relative to baseUrl when there is one, otherwise to the file that sets them.
      const base = baseUrl ?? pathsFrom;
      return {
        ...(baseUrl ? { baseUrl } : {}),
        paths: Object.entries(paths ?? {}).map(([pattern, targets]) => [
          pattern,
          targets.map((target) => path.resolve(base, target)),
        ]),
      };
    }
  }
  return { paths: [] };
}

const isFile = (file: string) =>
  stat(file).then(
    (info) => info.isFile(),
    () => false,
  );

/** The file a specifier names, trying the extensions and index files a bundler would. */
async function resolveFile(base: string): Promise<string | undefined> {
  const candidates = [base, ...CODE.map((extension) => base + extension)];
  // `./x.js` in TypeScript names ./x.ts.
  const extension = path.extname(base);
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const stem = base.slice(0, -extension.length);
    candidates.push(...[".ts", ".tsx", ".mts", ".cts"].map((other) => stem + other));
  }
  candidates.push(...CODE.map((extension) => path.join(base, `index${extension}`)));
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return undefined;
}

async function resolveSpecifier(specifier: string, from: string, aliases: Aliases): Promise<string | undefined> {
  if (specifier.startsWith(".")) return resolveFile(path.resolve(path.dirname(from), specifier));
  if (specifier.startsWith("/")) return undefined;
  for (const [pattern, targets] of aliases.paths) {
    const star = pattern.indexOf("*");
    const matched =
      star === -1
        ? specifier === pattern
          ? ""
          : undefined
        : specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1))
          ? specifier.slice(star, specifier.length - (pattern.length - star - 1))
          : undefined;
    if (matched === undefined) continue;
    for (const target of targets) {
      const file = await resolveFile(target.replace("*", matched));
      if (file) return file;
    }
  }
  if (aliases.baseUrl) return resolveFile(path.join(aliases.baseUrl, specifier));
  return undefined;
}

/** Every project file the entries depend on, the entries included, as sorted project-relative paths. */
export async function importGraph(root: string, entries: readonly string[]): Promise<string[]> {
  const aliases = await readAliases(root);
  const inside = (file: string) => {
    const relative = path.relative(root, file);
    return (
      !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.split(path.sep).includes("node_modules")
    );
  };
  const seen = new Set<string>();
  const queue = entries.map((entry) => path.resolve(root, entry));
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file) || !inside(file) || !(await isFile(file))) continue;
    seen.add(file);
    if (!isCode(file)) continue;
    const source = await readFile(file, "utf8").catch(() => "");
    for (const specifier of importSpecifiers(source)) {
      const resolved = await resolveSpecifier(specifier, file, aliases);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen].map((file) => toPosix(path.relative(root, file))).sort();
}
