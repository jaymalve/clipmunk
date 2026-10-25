import { z } from "zod";

/** An object schema whose fields are all optional and carry no defaults, so a partial value holds
 * only what it sets. Used for presets and for the camera of a ratio variant.
 */
export function partialOf<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, field]) => [
      key,
      ((field instanceof z.ZodDefault ? field.unwrap() : field) as z.ZodType).optional(),
    ]),
  );
  return z.strictObject(shape) as unknown as z.ZodType<Partial<z.output<z.ZodObject<Shape>>>>;
}
