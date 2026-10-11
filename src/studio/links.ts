import { SCENE_PARAM, SEQUENCE_PARAM, STUDIO_PARAM, TAKE_PARAM } from "../core";

/** The studio's address for a clip, or for the library when no clip is given.
 * Any other query parameters the host page has are kept.
 */
export function studioHref(clip?: { scene?: string; take?: string; sequence?: string }): string {
  const params = new URLSearchParams(location.search);
  params.set(STUDIO_PARAM, "1");
  params.delete(SCENE_PARAM);
  params.delete(TAKE_PARAM);
  params.delete(SEQUENCE_PARAM);
  if (clip?.sequence) params.set(SEQUENCE_PARAM, clip.sequence);
  if (clip?.scene) params.set(SCENE_PARAM, clip.scene);
  if (clip?.take) params.set(TAKE_PARAM, clip.take);
  return `?${params}`;
}
