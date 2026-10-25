import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importGraph, importSpecifiers } from "./imports";

let root: string;
async function project(files: Record<string, string>) {
  root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-imports-"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("importSpecifiers", () => {
  it("reads static imports and re-exports, not type-only ones, comments or strings in JSX text", () => {
    const source = `import React from "react";
import { a, b } from './a';
import * as c from "../c";
import d, { e } from "./d";
import "./side.css";
import type { T } from "./types";
export { f } from "./f";
export * from "./g";
export * as h from "./h";
export type { U } from "./u";
// import { old } from "./old";
/* import x from "./x"; */
const text = <p>Don't import "./nope" from here</p>;
const lazy = import("./lazy");
`;
    expect(importSpecifiers(source)).toEqual(["react", "./a", "../c", "./d", "./side.css", "./f", "./g", "./h"]);
  });
});

describe("importGraph", () => {
  it("follows relative imports, index files, tsconfig paths and re-exports, through cycles", async () => {
    await project({
      "tsconfig.json": `{
        // comments and trailing commas are allowed
        "extends": "./tsconfig.base.json",
        "compilerOptions": { "jsx": "react-jsx", },
      }`,
      "tsconfig.base.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], "~ui": ["src/ui/index.ts"] } } }`,
      "src/clipmunk/scenes/card.tsx": `import { Card } from "@/components/card";\nimport { Button } from "~ui";\nimport "../../styles.css";\nimport { z } from "zod";\nexport default () => <Card />;`,
      "src/components/card.tsx": `export { Title } from "./title.js";\nimport { theme } from "../theme";\nexport const Card = () => null;`,
      "src/components/title.tsx": `import { Card } from "./card";\nexport const Title = () => null;`,
      "src/theme/index.ts": `export const theme = {};`,
      "src/ui/index.ts": `export * from "./button";`,
      "src/ui/button.tsx": `import type { Props } from "./props";\nexport const Button = () => null;`,
      "src/ui/props.ts": `export type Props = {};`,
      "src/styles.css": `body {}`,
      "src/unused.ts": `export {};`,
    });
    expect(await importGraph(root, ["src/clipmunk/scenes/card.tsx"])).toEqual([
      "src/clipmunk/scenes/card.tsx",
      "src/components/card.tsx",
      "src/components/title.tsx",
      "src/styles.css",
      "src/theme/index.ts",
      "src/ui/button.tsx",
      "src/ui/index.ts",
    ]);
  });

  it("stays inside the project and ignores what it cannot resolve", async () => {
    await project({
      "a.tsx": `import "./missing";\nimport "../outside";\nimport "./node_modules/pkg/index.js";\nimport "/abs";\nexport {};`,
    });
    expect(await importGraph(root, ["a.tsx", "gone.tsx"])).toEqual(["a.tsx"]);
  });
});
