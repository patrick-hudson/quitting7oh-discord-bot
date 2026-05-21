import { z } from "zod";

export const postSchema = z
  .object({
    name: z.string().min(1).max(120),
    channelIds: z
      .array(z.string().regex(/^\d{17,21}$/, "Invalid channel ID"))
      .min(1, "Pick at least one channel")
      .max(25, "Too many channels"),
    scheduleKind: z.enum(["cron", "oneoff"]),
    cron: z.string().optional().default(""),
    runAt: z.string().optional().default(""),
    timezone: z.string().min(1),
    useEmbed: z.boolean(),
    content: z.string().min(1).max(4000),
    embedTitle: z.string().max(256).optional().default(""),
    embedColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color").optional().or(z.literal("")),
    embedUrl: z.string().url().optional().or(z.literal("")),
    embedImage: z.string().url().optional().or(z.literal("")),
    mentionRoleId: z.string().regex(/^\d{17,21}$/).optional().or(z.literal("")),
    leadMinutes: z.number().int().min(0).max(1440).default(0),
    active: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.scheduleKind === "cron" && !v.cron) {
      ctx.addIssue({ code: "custom", path: ["cron"], message: "Cron expression required" });
    }
    if (v.scheduleKind === "oneoff" && !v.runAt) {
      ctx.addIssue({ code: "custom", path: ["runAt"], message: "Run-at datetime required" });
    }
  });

export type PostInput = z.infer<typeof postSchema>;
