import { link, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { EXPORTS_DIR, type Issue } from "../core";
import { exists, Fault, resolveInside } from "../project";

/** The steps every export shares: claim an output path that will not overwrite anything,
 * work in a temporary directory beside it, publish only on success, and stop cleanly when
 * cancelled. Scene, take and sequence exports all go through these.
 */
export const CANCELLED: Issue = { code: "export-cancelled", message: "Export cancelled. No file was written." };
export const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export type Claim = { output: string; target: string };

/** The requested output if it is free, otherwise `.flick/exports/<stem>.mp4`, then `-2`, `-3`, … */
export async function claimOutput(root: string, requested: string | undefined, stem: string): Promise<Claim> {
  if (requested && (await exists(root, requested)))
    throw new Fault(
      "output-exists",
      `${requested} already exists. Choose another --output; Flick never overwrites a file.`,
      requested,
    );
  let output = requested;
  for (let n = 1; !output; n++) {
    const candidate = `${EXPORTS_DIR}/${stem}${n === 1 ? "" : `-${n}`}.mp4`;
    if (!(await exists(root, candidate))) output = candidate;
  }
  const target = await resolveInside(root, output);
  await mkdir(path.dirname(target), { recursive: true });
  return { output, target };
}

/** A scratch directory next to the output, so publishing is a link on the same disk. */
export const workDirectory = (claim: Claim) => mkdtemp(path.join(path.dirname(claim.target), ".flick-export-"));
export const removeDirectory = (directory: string | undefined) =>
  directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve();

/** Put the finished file in place. Fails, instead of overwriting, if the name was taken meanwhile. */
export async function publish(file: string, claim: Claim): Promise<void> {
  try {
    await link(file, claim.target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Fault(
        "output-exists",
        `${claim.output} appeared during the export. Choose another --output.`,
        claim.output,
      );
    throw error;
  }
}

/** Cancellation for one export: `check()` throws once the signal fires, and `onCancel` registers
 * what to stop immediately (encoders, the browser). `release()` detaches from the signal.
 */
export function cancellation(signal: AbortSignal | undefined) {
  const stoppers: (() => void)[] = [];
  const abort = () => {
    for (const stop of stoppers) stop();
  };
  signal?.addEventListener("abort", abort, { once: true });
  return {
    cancelled: () => !!signal?.aborted,
    check() {
      if (signal?.aborted) throw new Fault(CANCELLED.code, CANCELLED.message);
    },
    onCancel: (stop: () => void) => void stoppers.push(stop),
    release: () => signal?.removeEventListener("abort", abort),
  };
}
export type Cancellation = ReturnType<typeof cancellation>;
