#!/usr/bin/env node

import { loadConfig } from './config.js';
import { MatrixBot } from './matrix-bot.js';
import { SessionStore } from './session-store.js';
import { resolve } from 'path';
import { mkdirSync } from 'fs';

async function main() {
  const configPath = process.argv[2];
  const config = loadConfig(configPath);

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

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
