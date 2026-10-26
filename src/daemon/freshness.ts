import { stat } from "node:fs/promises";
import { type ClipFreshness, MANIFEST_FILE } from "../core";
import { clipFreshness, readManifest, resolveInside } from "../project";

/** Which exported clips are out of date, kept current while the daemon runs. Once a second it
 * looks at the size and time of the manifest and of every file it lists (a few dozen stats, far
 * cheaper and more reliable across editors than watching them), recomputes when one moved, and
 * calls `onChange` when a clip's staleness changed.
 */
export function createFreshness(root: string, onChange: () => void, intervalMs = 1000) {
  let clips: ClipFreshness[] = [];
  let signature = "";
  let shown = "";
  let running: Promise<void> | undefined;

  const signatureNow = async () => {
    const manifest = await readManifest(root);
    const files = [
      MANIFEST_FILE,
      ...new Set(Object.values(manifest.clips).flatMap((entry) => Object.keys(entry.files))),
    ];
    const parts: string[] = [];
    for (const file of files) {
      const info = await resolveInside(root, file)
        .then((full) => stat(full))
        .catch(() => undefined);
      parts.push(info ? `${file}:${info.size}:${info.mtimeMs}` : `${file}:-`);
    }
    return parts.join("|");
  };
  const refresh = () =>
    (running ??= (async () => {
      try {
        const next = await signatureNow();
        if (next === signature) return;
        signature = next;
        clips = await clipFreshness(root);
        const summary = JSON.stringify(clips.map((clip) => [clip.clip, clip.changes]));
        if (summary !== shown) {
          const first = !shown;
          shown = summary;
          if (!first) onChange();
        }
      } catch {
        // A half-written file is read again on the next look.
      } finally {
        running = undefined;
      }
    })());

  const timer = setInterval(() => void refresh(), intervalMs);
  timer.unref();
  return {
    /** The latest staleness, looked at again first so a caller never sees an old answer. */
    async clips(): Promise<ClipFreshness[]> {
      await refresh();
      return clips;
    },
    async of(kind: string, id: string): Promise<ClipFreshness | undefined> {
      return (await this.clips()).find((clip) => clip.clip.kind === kind && clip.clip.id === id);
    },
    close() {
      clearInterval(timer);
    },
  };
}
export type Freshness = ReturnType<typeof createFreshness>;
