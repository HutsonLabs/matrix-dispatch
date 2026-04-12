import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { DispatchConfig, ProviderConfig, BotConfig } from './types.js';
import { PROVIDER_PRESETS } from './providers.js';

const DEFAULT_CONFIG_PATHS = [
  './dispatch.json',
  '~/.config/matrix-dispatch/config.json',
  '~/.matrix-dispatch.json',
];

/**
 * Load and validate configuration from file or environment.
 */
export function loadConfig(configPath?: string): DispatchConfig {
  // Try explicit path, then defaults
  const paths = configPath ? [configPath] : DEFAULT_CONFIG_PATHS;

  for (const p of paths) {
    const resolved = resolve(p.replace('~', process.env.HOME || ''));
    if (existsSync(resolved)) {
      console.log(`Loading config from ${resolved}`);
      const raw = readFileSync(resolved, 'utf-8');
      const config = JSON.parse(raw) as DispatchConfig;
      return validateConfig(config);
    }
  }

  // Fall back to environment variables for single-bot setup
  return configFromEnv();
}

function configFromEnv(): DispatchConfig {
  const homeserver = requireEnv('MATRIX_HOMESERVER');
  const accessToken = requireEnv('MATRIX_ACCESS_TOKEN');
  const userId = requireEnv('MATRIX_USER_ID');
  const provider = process.env.DISPATCH_PROVIDER || 'claude';
  const rooms = process.env.DISPATCH_ROOMS?.split(',').map((r) => r.trim()) || [];
  const prefix = process.env.DISPATCH_PREFIX || '';
  const cwd = process.env.DISPATCH_CWD || process.cwd();

  const botConfig: BotConfig = {
    name: provider,
    provider,
    matrixUserId: userId,
    matrixAccessToken: accessToken,
    matrixHomeserver: homeserver,
    rooms: rooms.length ? rooms : undefined,
    triggerPrefix: prefix || undefined,
    providerOverrides: { cwd },
  };

  return validateConfig({
    providers: { [provider]: { ...PROVIDER_PRESETS[provider]!, cwd } },
    bots: [botConfig],
  });
}

function validateConfig(config: DispatchConfig): DispatchConfig {
  if (!config.bots?.length) {
    throw new Error('Config must define at least one bot');
  }

  // Merge presets into providers
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, provider] of Object.entries(config.providers || {})) {
    const preset = PROVIDER_PRESETS[name];
    providers[name] = preset ? { ...preset, ...provider } : provider;
  }

  // Ensure all bot providers exist
  for (const bot of config.bots) {
    if (!providers[bot.provider] && !PROVIDER_PRESETS[bot.provider]) {
      throw new Error(`Bot "${bot.name}" references unknown provider "${bot.provider}"`);
    }
  }

  return { ...config, providers };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `Either set it or create a dispatch.json config file.`,
    );
  }
  return value;
}
