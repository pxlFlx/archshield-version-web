import { describe, expect, it } from "vitest";
import { configSchema } from "../src/config/schema.js";

const baseConfig = {
  version: 1,
  layers: [
    { name: "ui", patterns: ["src/ui/**"] },
    { name: "data", patterns: ["src/data/**"] },
  ],
};

describe("configuration schema", () => {
  it("applies documented defaults", () => {
    const parsed = configSchema.parse({ version: 1 });
    expect(parsed.project.root).toBe(".");
    expect(parsed.languages.typescript.enabled).toBe(true);
    expect(parsed.settings.maxFileSizeKb).toBe(1000);
  });

  it("rejects duplicate rule IDs", () => {
    const result = configSchema.safeParse({
      ...baseConfig,
      rules: [
        { id: "same", type: "no-cycles", severity: "error" },
        { id: "same", type: "no-cycles", severity: "warning" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects rules that reference undefined layers", () => {
    const result = configSchema.safeParse({
      ...baseConfig,
      rules: [
        {
          id: "bad-layer",
          type: "layer-boundary",
          severity: "error",
          from: ["ui"],
          to: ["missing"],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown rule types and extra fields", () => {
    expect(
      configSchema.safeParse({
        version: 1,
        rules: [{ id: "bad", type: "magic", severity: "error" }],
      }).success,
    ).toBe(false);
    expect(configSchema.safeParse({ version: 1, invented: true }).success).toBe(
      false,
    );
  });
});
