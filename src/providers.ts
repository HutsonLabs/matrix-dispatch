import { ProviderConfig } from './types.js';

/**
 * Built-in provider presets. Users can override any field.
 */
export const PROVIDER_PRESETS: Record<string, ProviderConfig> = {
  claude: {
    name: 'claude',
    command: 'claude',
    baseArgs: ['-p', '--output-format', 'json', '--verbose'],
    messageFlag: 'positional',
    resumeFlag: '--resume',
    outputFormat: 'json',
    responsePath: 'result',
    sessionIdPath: 'session_id',
    timeout: 600_000, // 10 minutes
  },

  gemini: {
    name: 'gemini',
    command: 'gemini',
    baseArgs: [],
    messageFlag: 'positional',
    outputFormat: 'text',
    timeout: 300_000,
  },

  aider: {
    name: 'aider',
    command: 'aider',
    baseArgs: ['--no-git', '--yes'],
    messageFlag: '--message',
    outputFormat: 'text',
    timeout: 600_000,
  },

  codex: {
    name: 'codex',
    command: 'codex',
    baseArgs: [],
    messageFlag: 'positional',
    outputFormat: 'text',
    timeout: 300_000,
  },
};
