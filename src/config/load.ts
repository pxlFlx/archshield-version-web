import { readFile } from "node:fs/promises";
import path from "node:path";
import { configSchema, type ArchShieldConfig } from "./schema.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadedConfig {
  config: ArchShieldConfig;
  configPath: string;
  projectRoot: string;
}

export async function loadConfig(configPath: string): Promise<LoadedConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  let contents: string;
  try {
    contents = await readFile(absoluteConfigPath, "utf8");
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "unknown file error";
    throw new ConfigError(`Cannot read config "${configPath}": ${reason}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw new ConfigError(`Invalid JSON in "${configPath}": ${reason}`);
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`Invalid ArchShield config:\n${details}`);
  }

  const config = parsed.data;
  if (config.languages.php.enabled || config.languages.python.enabled) {
    const languages = [
      config.languages.php.enabled ? "PHP" : "",
      config.languages.python.enabled ? "Python" : "",
    ]
      .filter(Boolean)
      .join(" and ");
    throw new ConfigError(
      `${languages} analysis is not implemented in this release. Disable those language adapters; TypeScript and JavaScript are supported.`,
    );
  }

  const projectRoot = path.resolve(
    path.dirname(absoluteConfigPath),
    config.project.root,
  );
  return { config, configPath: absoluteConfigPath, projectRoot };
}
