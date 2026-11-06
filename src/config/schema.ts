import { z } from "zod";

const ruleCommon = {
  id: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Use lowercase letters, digits, and hyphens.",
    ),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string().min(1).optional(),
};

const layerBoundaryRule = z
  .object({
    ...ruleCommon,
    type: z.literal("layer-boundary"),
    from: z.array(z.string().min(1)).min(1),
    to: z.array(z.string().min(1)).min(1),
  })
  .strict();

const forbiddenImportRule = z
  .object({
    ...ruleCommon,
    type: z.literal("forbidden-import"),
    from: z.array(z.string().min(1)).min(1),
    patterns: z.array(z.string().min(1)).min(1),
    match: z.enum(["specifier", "path", "both"]).default("both"),
  })
  .strict();

const allowedDependencyRule = z
  .object({
    ...ruleCommon,
    type: z.literal("allowed-dependency"),
    from: z.array(z.string().min(1)).min(1),
    allowed: z.array(z.string().min(1)).min(1),
    match: z.enum(["layer", "path", "both"]).default("both"),
  })
  .strict();

const cycleRule = z
  .object({
    ...ruleCommon,
    type: z.literal("no-cycles"),
  })
  .strict();

export const ruleSchema = z.discriminatedUnion("type", [
  layerBoundaryRule,
  forbiddenImportRule,
  allowedDependencyRule,
  cycleRule,
]);

export const configSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        name: z.string().min(1).optional(),
        root: z.string().min(1).default("."),
      })
      .strict()
      .default({ root: "." }),
    include: z
      .array(z.string().min(1))
      .default(["**/*.{ts,tsx,js,jsx,mjs,cjs}"]),
    exclude: z
      .array(z.string().min(1))
      .default([
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/coverage/**",
        "**/vendor/**",
      ]),
    languages: z
      .object({
        typescript: z
          .object({ enabled: z.boolean() })
          .strict()
          .default({ enabled: true }),
        javascript: z
          .object({ enabled: z.boolean() })
          .strict()
          .default({ enabled: true }),
        php: z
          .object({ enabled: z.boolean() })
          .strict()
          .default({ enabled: false }),
        python: z
          .object({ enabled: z.boolean() })
          .strict()
          .default({ enabled: false }),
      })
      .strict()
      .default({
        typescript: { enabled: true },
        javascript: { enabled: true },
        php: { enabled: false },
        python: { enabled: false },
      }),
    layers: z
      .array(
        z
          .object({
            name: z.string().min(1),
            patterns: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .default([]),
    rules: z.array(ruleSchema).default([]),
    settings: z
      .object({
        maxFileSizeKb: z.number().int().positive().max(100_000).default(1000),
        followSymlinks: z.boolean().default(false),
        unresolvedImports: z.enum(["warn", "ignore", "error"]).default("warn"),
        caseSensitivePaths: z.boolean().default(true),
        allowAmbiguousLayers: z.boolean().default(false),
      })
      .strict()
      .default({
        maxFileSizeKb: 1000,
        followSymlinks: false,
        unresolvedImports: "warn",
        caseSensitivePaths: true,
        allowAmbiguousLayers: false,
      }),
  })
  .strict()
  .superRefine((config, ctx) => {
    const ruleIds = new Set<string>();
    for (const [index, rule] of config.rules.entries()) {
      if (ruleIds.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "id"],
          message: `Duplicate rule ID "${rule.id}".`,
        });
      }
      ruleIds.add(rule.id);

      if (rule.type === "layer-boundary") {
        const names = new Set(config.layers.map((layer) => layer.name));
        for (const layer of [...rule.from, ...rule.to]) {
          if (!names.has(layer)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["rules", index],
              message: `Rule "${rule.id}" references undefined layer "${layer}".`,
            });
          }
        }
      }
    }

    const layerNames = new Set<string>();
    for (const [index, layer] of config.layers.entries()) {
      if (layerNames.has(layer.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["layers", index, "name"],
          message: `Duplicate layer name "${layer.name}".`,
        });
      }
      layerNames.add(layer.name);
    }
  });

export type ArchShieldConfig = z.infer<typeof configSchema>;
export type ArchShieldRule = z.infer<typeof ruleSchema>;
