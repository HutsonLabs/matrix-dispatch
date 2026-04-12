/**
 * Configuration for a CLI provider (claude, gemini, aider, codex, etc.)
 */
export interface ProviderConfig {
  /** Unique name for this provider */
  name: string;
  /** The CLI command to execute */
  command: string;
  /** Base arguments applied to every invocation */
  baseArgs: string[];
  /** How to pass the user's message to the CLI */
  messageFlag: 'positional' | 'stdin' | string;
  /** How to resume a session (flag name, e.g. "--resume") */
  resumeFlag?: string;
  /** How the CLI outputs its response */
  outputFormat?: 'text' | 'json' | 'stream-json';
  /** JSON path to extract the response text (for json/stream-json) */
  responsePath?: string;
  /** JSON path to extract the session ID for threading */
  sessionIdPath?: string;
  /** Environment variables to set for the CLI process */
  env?: Record<string, string>;
  /** Working directory for the CLI process */
  cwd?: string;
  /** Max execution time in ms before killing the process */
  timeout?: number;
}

/**
 * Configuration for a bot — a named persona attached to a provider.
 * Multiple bots can use the same provider with different configs.
 */
export interface BotConfig {
  /** Bot's display name (used for Matrix presence) */
  name: string;
  /** Which provider this bot uses */
  provider: string;
  /** Matrix user ID for this bot (e.g. @claude:chat.example.com) */
  matrixUserId: string;
  /** Matrix access token */
  matrixAccessToken: string;
  /** Matrix homeserver URL */
  matrixHomeserver: string;
  /** Room IDs this bot should listen in (empty = all joined rooms) */
  rooms?: string[];
  /** Prefix to trigger this bot (e.g. "!claude"). Omit for always-on. */
  triggerPrefix?: string;
  /** Sender IDs to ignore (other bots, service accounts). */
  ignoreSenders?: string[];
  /** Extra CLI args specific to this bot */
  extraArgs?: string[];
  /** Provider-specific overrides */
  providerOverrides?: Partial<ProviderConfig>;
}

/**
 * Top-level dispatch configuration.
 */
export interface DispatchConfig {
  providers: Record<string, ProviderConfig>;
  bots: BotConfig[];
}

/**
 * Tracks an active session between a bot and a Matrix room.
 */
export interface Session {
  botName: string;
  roomId: string;
  sessionId?: string;
  lastActivity: number;
}

/**
 * Result from a CLI invocation.
 */
export interface CliResult {
  response: string;
  sessionId?: string;
  exitCode: number;
  durationMs: number;
}
