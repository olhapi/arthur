import { z } from "zod";

export const AbsoluteDestinationSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"), {
    message: "Destination must be an absolute path",
  });

export const ArthurSettingsSchema = z
  .object({
    destination: AbsoluteDestinationSchema,
  })
  .strict();

export type ArthurSettings = z.infer<typeof ArthurSettingsSchema>;
