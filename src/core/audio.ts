import { z } from "zod";

export const AUDIO_DIR = ".clipmunk/audio";

/** A sound file under .clipmunk/audio, placed on a clip's timeline. */
export const AudioClipSchema = z.strictObject({
  file: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9._-]*\.(wav|mp3|m4a|webm|ogg)$/i,
      "Use a file name inside .clipmunk/audio, such as intro.wav.",
    ),
  offsetMs: z.number().finite().default(0),
  gain: z.number().finite().min(0).max(4).default(1),
});
export type AudioClip = z.output<typeof AudioClipSchema>;
