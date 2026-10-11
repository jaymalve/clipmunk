// Enforces the import rules in ARCHITECTURE.md, section 3. Run: node scripts/check-boundaries.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const NODE = ["daemon", "export", "project"];
// module -> { internal modules it may import, external packages it may import, whether node: built-ins are allowed }
const RULES = {
  core: { modules: [], packages: ["zod"], node: false },
  bridge: { modules: ["core"], packages: [], node: false },
  react: { modules: ["core", "bridge"], packages: ["react", "react-dom"], node: false },
  compositor: { modules: ["core", "bridge"], packages: ["mediabunny"], node: false },
  recorder: { modules: ["core"], packages: [], node: false },
  studio: {
    modules: ["core", "bridge", "react", "compositor", "recorder"],
    packages: ["react", "react-dom"],
    node: false,
  },
  daemon: { modules: ["core", ...NODE], packages: [], node: true },
  export: { modules: ["core", ...NODE], packages: ["playwright"], node: true },
  project: { modules: ["core", ...NODE], packages: ["typescript"], node: true },
  cli: { modules: ["core", ...NODE], packages: [], node: true },
};

const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
/** Blank out comments and template-literal text so generated source inside templates is not read as imports. */
function codeOnly(source) {
  let out = "";
  const stack = []; // "template" or a brace depth for a ${ } expression
  for (let i = 0; i < source.length; i++) {
    const char = source[i],
      next = source[i + 1];
    if (stack.at(-1) === "template") {
      if (char === "\\") i++;
      else if (char === "`") stack.pop();
      else if (char === "$" && next === "{") {
        stack.push(0);
        i++;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i = source.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = i + 1;
      while (end < source.length && source[end] !== char && source[end] !== "\n") end += source[end] === "\\" ? 2 : 1;
      out += source.slice(i, end + 1);
      i = end;
      continue;
    }
    if (char === "`") {
      stack.push("template");
      continue;
    }
    if (typeof stack.at(-1) === "number") {
      if (char === "{") stack[stack.length - 1]++;
      else if (char === "}") {
        if (stack.at(-1) === 0) {
          stack.pop();
          continue;
        }
        stack[stack.length - 1]--;
      }
    }
    out += char;
  }
  return out;
}
const STATIC_IMPORT = /^[ \t]*(?:import|export)\b[^'"`;]*?\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const packageOf = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");
const violations = [];

for (const file of files(root)) {
  const [module, ...rest] = relative(root, file).split(sep);
  if (!rest.length) continue; // src/index.ts only re-exports
  const rule = RULES[module];
  if (!rule) {
    violations.push(`${relative(root, file)}: unknown module "${module}". Add it to ARCHITECTURE.md and this script.`);
    continue;
  }
  const isTest = /\.test\.tsx?$/.test(file);
  const source = codeOnly(readFileSync(file, "utf8"));
  for (const match of [...source.matchAll(STATIC_IMPORT), ...source.matchAll(DYNAMIC_IMPORT)]) {
    const specifier = match[1] ?? match[2];
    let problem;
    if (specifier.startsWith(".")) {
      const target = relative(root, resolve(dirname(file), specifier)).split(sep)[0];
      if (target !== module && !rule.modules.includes(target)) problem = `may not import from "${target}"`;
    } else if (specifier.startsWith("node:")) {
      if (!rule.node && !isTest) problem = "may not import Node built-ins";
    } else if (!rule.packages.includes(packageOf(specifier)) && !(isTest && packageOf(specifier) === "vitest")) {
      problem = `may not import the package "${packageOf(specifier)}"`;
    }
    if (problem) violations.push(`${relative(root, file)}: ${module} ${problem} (${specifier})`);
  }
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log(`Import boundaries hold across ${files(root).length} files.`);
