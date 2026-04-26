#!/usr/bin/env node

import { loadConfig } from './config.js';
import { MatrixBot } from './matrix-bot.js';
import { SessionStore } from './session-store.js';
import { runSend } from './send-cmd.js';
import { runMcp } from './mcp-cmd.js';
import { resolve } from 'path';
import { mkdirSync } from 'fs';

function printRootHelp(): void {
  console.log(`matrix-dispatch — bridge Matrix to CLI tools

Modes:
  matrix-dispatch                Run the responder daemon (default)
  matrix-dispatch <config.json>  Run the daemon with an explicit config path
  matrix-dispatch send …         One-shot Matrix message — see \`send --help\`
  matrix-dispatch mcp …          stdio MCP server — see \`mcp --help\`
  matrix-dispatch --help         Show this help
`);
}

async function runDaemon(configPathArg: string | undefined): Promise<void> {
  const config = loadConfig(configPathArg);

  // Session store in ~/.local/state/matrix-dispatch/
  const stateDir = resolve(
    process.env.HOME || '.',
    '.local',
    'state',
    'matrix-dispatch',
  );
  mkdirSync(stateDir, { recursive: true });
  const sessions = new SessionStore(resolve(stateDir, 'sessions.json'));

  // Prune old sessions on startup
  sessions.prune();

  // Collect all bot user IDs so each bot auto-ignores the others
  const allBotUserIds = config.bots.map((b) => b.matrixUserId);

  // Start all bots
  const bots: MatrixBot[] = [];

  for (const botConfig of config.bots) {
    // Auto-populate ignoreSenders with all other bot user IDs
    const otherBotIds = allBotUserIds.filter((id) => id !== botConfig.matrixUserId);
    const mergedIgnore = [
      ...new Set([...(botConfig.ignoreSenders || []), ...otherBotIds]),
    ];
    const enrichedConfig = { ...botConfig, ignoreSenders: mergedIgnore };

    const bot = new MatrixBot(enrichedConfig, config.providers, sessions);
    bots.push(bot);
    await bot.start();
  }

  console.log(`\nmatrix-dispatch running with ${bots.length} bot(s)`);
  console.log('Press Ctrl+C to stop\n');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    for (const bot of bots) {
      await bot.stop();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === '--help' || first === '-h') {
    printRootHelp();
    return 0;
  }

  if (first === 'send') {
    return runSend(argv.slice(1));
  }

  if (first === 'mcp') {
    return runMcp(argv.slice(1));
  }

  // Default mode: daemon. argv[0], if present, is treated as a config path
  // (matches the prior CLI contract).
  await runDaemon(first);
  return 0;
}

main()
  .then((code) => {
    if (typeof code === 'number' && code !== 0) process.exit(code);
  })
  .catch((err) => {
    console.error('Fatal:', err.message || err);
    process.exit(1);
  });
