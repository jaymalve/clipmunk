import {
  CONFIG_FILE,
  type Config,
  EMPTY_CONFIG,
  fail,
  type Issue,
  ok,
  type Result,
  redactionOf,
  SelectorSchema,
  validateConfig,
  zodIssues,
} from "../core";
import { indentOf } from "./presets";
import { exists, readText, toIssues, writeText } from "./services";

/** Read `clipmunk.config.json`. A project without one has the empty config; a broken one
 * returns issues whose paths point into the file.
 */
export async function readConfig(root: string): Promise<Result<{ config: Config; exists: boolean }>> {
  try {
    const text = await readText(root, CONFIG_FILE);
    if (text === undefined) return ok({ config: EMPTY_CONFIG, exists: false });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fail([{ code: "invalid-config", path: CONFIG_FILE, message: `${CONFIG_FILE} is not valid JSON.` }]);
    }
    const config = validateConfig(json);
    return config.ok ? ok({ config: config.data, exists: true }) : config;
  } catch (error) {
    return fail(toIssues(error, "invalid-config"));
  }
}

/** Problems a valid config can still have: files it names that are not there. Reported by
 * clipmunk doctor; they never stop the config from being used.
 */
export async function configWarnings(root: string, config: Config): Promise<Issue[]> {
  const logo = config.brand?.logo;
  if (!logo || (await exists(root, logo).catch(() => false))) return [];
  return [{ code: "missing-file", path: `${CONFIG_FILE}: brand.logo`, message: `${logo} does not exist.` }];
}

/** Add a redaction selector to clipmunk.config.json (picked in the Studio), in whichever form the
 * file writes `redact`. Everything else keeps its content, order and indentation.
 */
export async function addRedactSelector(root: string, selector: string): Promise<Result<{ selectors: string[] }>> {
  try {
    const parsed = SelectorSchema.safeParse(selector);
    if (!parsed.success) return fail(zodIssues(parsed.error, "invalid-config"));
    const text = await readText(root, CONFIG_FILE);
    let json: Record<string, unknown>;
    try {
      json = text === undefined ? { version: 1 } : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      return fail([{ code: "invalid-config", path: CONFIG_FILE, message: `${CONFIG_FILE} is not valid JSON.` }]);
    }
    const current = validateConfig(json);
    if (!current.ok) return current;
    const { selectors } = redactionOf(current.data);
    if (selectors.includes(parsed.data)) return ok({ selectors });
    const redact = json.redact;
    const next = {
      ...json,
      redact:
        redact && !Array.isArray(redact)
          ? { ...(redact as Record<string, unknown>), selectors: [...selectors, parsed.data] }
          : [...selectors, parsed.data],
    };
    const checked = validateConfig(next);
    if (!checked.ok) return checked;
    await writeText(root, CONFIG_FILE, `${JSON.stringify(next, null, indentOf(text))}\n`);
    return ok({ selectors: redactionOf(checked.data).selectors });
  } catch (error) {
    return fail(toIssues(error, "config-failed"));
  }
}
