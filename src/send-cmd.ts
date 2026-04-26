/**
 * `matrix-dispatch send` — one-shot Matrix message from a configured bot.
 *
 * Usage:
 *   matrix-dispatch send --bot <name> --room <id|alias> --message <text>
 *   matrix-dispatch send --bot <name> --to <user-id> --message <text>
 *   matrix-dispatch send --message <text>           # uses first bot, --to required
 *   echo "hi" | matrix-dispatch send --to @user:server  # message from stdin
 *
 * Either --room (room ID or alias) OR --to (user ID, looked up via
 * m.direct as a DM) is required. --bot picks which bot in dispatch.json
 * sends; defaults to the first bot.
 */

import { loadConfig } from './config.js';
import { BotConfig } from './types.js';
import {
  MatrixRest,
  parseRoomTarget,
  resolveRoomTarget,
  RoomTarget,
} from './matrix-client.js';
import { readFileSync } from 'fs';

interface SendArgs {
  bot?: string;
  room?: string;
  to?: string;
  message?: string;
  notice?: boolean;
  plain?: boolean;
  configPath?: string;
}

function parseArgs(argv: string[]): SendArgs {
  const out: SendArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Flag ${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--bot':
      case '-b':
        out.bot = next();
        break;
      case '--room':
      case '-r':
        out.room = next();
        break;
      case '--to':
      case '-t':
        out.to = next();
        break;
      case '--message':
      case '-m':
        out.message = next();
        break;
      case '--notice':
        out.notice = true;
        break;
      case '--plain':
        out.plain = true;
        break;
      case '--config':
      case '-c':
        out.configPath = next();
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown flag: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`matrix-dispatch send — one-shot Matrix notification

Usage:
  matrix-dispatch send [options]

Options:
  -b, --bot <name>       Bot from dispatch.json to send as (default: first)
  -r, --room <id|alias>  Room ID (!…) or alias (#…) to send to
  -t, --to <user-id>     User ID (@…) — resolved to DM via m.direct
  -m, --message <text>   Message body (markdown). Reads stdin if omitted.
      --notice           Send as m.notice instead of m.text
      --plain            Skip markdown→HTML formatting
  -c, --config <path>    Path to dispatch.json (default: ./dispatch.json or env)
  -h, --help             Show this help

Examples:
  matrix-dispatch send --to @user:matrix.example.com --message "deploy ok"
  matrix-dispatch send -r '#ops:matrix.example.com' -m "build green" --notice
  echo "$summary" | matrix-dispatch send -t @user:matrix.example.com
`);
}

function pickBot(args: SendArgs, bots: BotConfig[]): BotConfig {
  if (args.bot) {
    const b = bots.find((x) => x.name === args.bot);
    if (!b) throw new Error(`No bot named "${args.bot}" in config`);
    return b;
  }
  if (bots.length === 0) throw new Error('Config defines no bots');
  return bots[0]!;
}

function readMessage(args: SendArgs): string {
  if (args.message !== undefined) return args.message;
  // stdin fallback — buffer all data
  const data = readFileSync(0, 'utf-8');
  if (!data.trim()) {
    throw new Error('No message — provide --message or pipe text on stdin');
  }
  return data;
}

function buildTarget(args: SendArgs): RoomTarget {
  if (args.room && args.to) {
    throw new Error('Specify only one of --room or --to');
  }
  if (args.room) return parseRoomTarget(args.room);
  if (args.to) return parseRoomTarget(args.to);
  throw new Error('Either --room or --to is required');
}

export async function runSend(argv: string[]): Promise<number> {
  let args: SendArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    printHelp();
    return 2;
  }

  const config = loadConfig(args.configPath);
  const bot = pickBot(args, config.bots);
  const target = buildTarget(args);
  const message = readMessage(args);

  const client = new MatrixRest({
    homeserver: bot.matrixHomeserver,
    accessToken: bot.matrixAccessToken,
    userId: bot.matrixUserId,
  });

  const roomId = await resolveRoomTarget(client, target);
  const result = await client.sendMessage(roomId, message, {
    msgtype: args.notice ? 'm.notice' : 'm.text',
    format: args.plain ? 'plain' : 'markdown',
  });

  console.log(JSON.stringify({ room_id: roomId, event_id: result.event_id }));
  return 0;
}
