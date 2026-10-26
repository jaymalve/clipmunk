import { ADAPTERS, EXPORT_FPS, MUSIC_STYLES } from "../core";
import * as commands from "./commands";
import { type Command, type Io, invocation, parse } from "./invocation";
import { exportClip, snapshot } from "./render-commands";

/** The command line: parse the arguments, find the command, run it.
 * Each command is one small function in commands.ts or render-commands.ts.
 */
export type { Io } from "./invocation";

const HELP = `clipmunk <command> [options]

  init [--adapter ${ADAPTERS.join("|")}]   Connect this app to Clipmunk
  dev [--port <n>]                         Start the local daemon for recording and studio exports
  guide                                    Print the scene authoring guide
  scenes                                   List scenes and validation issues
  takes                                    List recorded takes
  sync                                     Regenerate the scene catalog (Next.js, generic React)
  open [--scene <id>] [--url <origin>]     Open the studio in your browser
  snapshot --scene <id> [--time <ms>]      Save a thumbnail into the recipe
  export --scene <id> [--fps ${EXPORT_FPS.join("|")}] [--size WxH] [--output file.mp4] [--draft] [--workers n]
  export --take <id> [--fps 30|60] [--size WxH] [--output file.mp4]
  export --sequence <id> [--output file.mp4]
  sequences                                List sequences (scenes and takes joined into one video)
  music <${MUSIC_STYLES.join("|")}> [--seed n] [--seconds n] [--output file.wav]
                                           Write a sample of Clipmunk's generated music, to hear a style
  zoom <take> [--write]                    Show a take's automatic zooms, or store them for hand editing
  preset list                              List the presets in clipmunk.config.json
  preset apply <name> --take <id> | --scene <id>
  preset save <name> --take <id> --fields canvas,zoom,cursor,cam,audio,music [--title "..."] [--replace]
  doctor                                   Check Node, FFmpeg, Chromium and the project

  Every command accepts --json. --url is your dev server origin and is remembered.
`;

const COMMANDS: Record<string, Command> = {
  init: commands.init,
  dev: commands.dev,
  guide: commands.guide,
  scenes: commands.scenes,
  takes: commands.takes,
  sequences: commands.sequences,
  sync: commands.sync,
  open: commands.open,
  zoom: commands.zoom,
  preset: commands.preset,
  music: commands.music,
  doctor: commands.doctor,
  snapshot,
  export: exportClip,
};

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${HELP}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const [name, ...args] = positionals;
  if (values.version) {
    io.out(io.version);
    return 0;
  }
  if (values.help || !name) {
    io.out(HELP);
    return values.help ? 0 : 1;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    io.err(`Unknown command "${name}".\n\n${HELP}`);
    return 1;
  }
  return command(invocation(io, values, args));
}
