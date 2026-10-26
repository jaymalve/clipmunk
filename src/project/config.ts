import { CONFIG_FILE, type Config, EMPTY_CONFIG, fail, type Issue, ok, type Result, validateConfig } from "../core";
import { exists, readText, toIssues } from "./services";

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
