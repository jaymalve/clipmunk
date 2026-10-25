import path from "node:path";
// Only the tagger, so the plugin carries none of the rest of core.
import { tagSources } from "../core/source";

/** `clipmunk/vite`: in `vite dev` only, marks every host element with the source file that
 * rendered it (`data-clipmunk-src`), so a recorded take knows which files it shows. A build is
 * untouched. Add it after the React plugin: `plugins: [react(), clipmunk()]`.
 */
type VitePlugin = {
  name: string;
  apply: "serve";
  enforce: "post";
  configResolved(config: { root: string }): void;
  transform(code: string, id: string): { code: string; map: null } | undefined;
};

export function clipmunk(): VitePlugin {
  let root = process.cwd();
  return {
    name: "clipmunk:source",
    apply: "serve",
    enforce: "post",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      const file = id.split("?")[0]!;
      if (!/\.[jt]sx$/.test(file) || file.includes("/node_modules/") || file.startsWith("\0")) return undefined;
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
      const tagged = tagSources(code, relative);
      return tagged ? { code: tagged, map: null } : undefined;
    },
  };
}
export default clipmunk;
