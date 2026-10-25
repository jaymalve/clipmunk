import path from "node:path";
// Only the tagger, so the plugin carries none of the rest of core.
import { tagSources } from "../core/source";

/** The webpack loader behind `withClipmunk`, built as CommonJS: tags host elements in a module
 * Next has already compiled. */
type LoaderContext = {
  resourcePath: string;
  getOptions(): { root: string };
  callback(error: null, code: string, map?: unknown): void;
};

export default function clipmunkSourceLoader(this: LoaderContext, code: string, map?: unknown) {
  const relative = path.relative(this.getOptions().root, this.resourcePath).split(path.sep).join("/");
  const tagged = relative.startsWith("..") ? undefined : tagSources(code, relative);
  this.callback(null, tagged ?? code, map);
}
