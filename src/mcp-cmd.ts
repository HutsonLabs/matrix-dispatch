/**
 * `matrix-dispatch mcp` — stdio MCP server.
 *
 * Exposes a REST-only Matrix toolkit so Claude Code (or any MCP client)
 * can send messages, read history, list rooms, create rooms, and invite
 * users — using the same dispatch.json bot credentials that power the
 * responder daemon. Skips the live-sync surface (typing indicators,
 * push-into-Claude channels) since the daemon already owns that for the
 * same account.
 *
 * Usage:
 *   matrix-dispatch mcp [--bot <name>] [--config <path>]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { BotConfig } from './types.js';
import {
  MatrixRest,
  parseRoomTarget,
  resolveRoomTarget,
} from './matrix-client.js';

interface McpArgs {
  bot?: string;
  configPath?: string;
}

function parseArgs(argv: string[]): McpArgs {
  const out: McpArgs = {};
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
  console.log(`matrix-dispatch mcp — stdio MCP server backed by a configured bot

Usage:
  matrix-dispatch mcp [options]

Options:
  -b, --bot <name>     Bot from dispatch.json to act as (default: first)
  -c, --config <path>  Path to dispatch.json
  -h, --help           Show this help

Tools exposed:
  matrix_send_message  Send m.text (markdown→HTML) to room/alias/DM
  matrix_send_notice   Send m.notice (non-highlighted)
  matrix_read_messages Read recent message events from a room
  matrix_list_rooms    List rooms the bot is joined to
  matrix_create_room   Create a new room
  matrix_invite_user   Invite a user to a room

Register with Claude Code:
  claude mcp add-json -s user matrix '{"command":"node","args":["DIST/index.js","mcp"]}'
`);
}

function pickBot(args: McpArgs, bots: BotConfig[]): BotConfig {
  if (args.bot) {
    const b = bots.find((x) => x.name === args.bot);
    if (!b) throw new Error(`No bot named "${args.bot}" in config`);
    return b;
  }
  if (bots.length === 0) throw new Error('Config defines no bots');
  return bots[0]!;
}

const RoomRefSchema = z
  .string()
  .min(1)
  .describe(
    'Room ID (!…:server), alias (#…:server), or user ID (@…:server) for DM via m.direct',
  );

export async function runMcp(argv: string[]): Promise<number> {
  let args: McpArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    printHelp();
    return 2;
  }

  const config = loadConfig(args.configPath);
  const bot = pickBot(args, config.bots);
  const client = new MatrixRest({
    homeserver: bot.matrixHomeserver,
    accessToken: bot.matrixAccessToken,
    userId: bot.matrixUserId,
  });

  // Probe credentials before announcing readiness; surfaces wrong-token
  // errors to the MCP client immediately instead of on first tool call.
  await client.whoami();

  const server = new McpServer({
    name: 'matrix-dispatch',
    version: '0.2.0',
  });

  const sendArgs = {
    room: RoomRefSchema,
    text: z.string().describe('Message body. Markdown is rendered to HTML formatted_body.'),
    plain: z
      .boolean()
      .optional()
      .describe('Skip markdown→HTML rendering (default: false)'),
  };

  server.registerTool(
    'matrix_send_message',
    {
      description:
        `Send an m.text message as ${bot.matrixUserId}. ` +
        'The room arg accepts a room ID, alias, or user ID (DM lookup).',
      inputSchema: sendArgs,
    },
    async ({ room, text, plain }) => {
      const target = parseRoomTarget(room);
      const roomId = await resolveRoomTarget(client, target);
      const result = await client.sendMessage(roomId, text, {
        msgtype: 'm.text',
        format: plain ? 'plain' : 'markdown',
      });
      return {
        content: [
          { type: 'text', text: `Sent ${result.event_id} to ${roomId}` },
        ],
      };
    },
  );

  server.registerTool(
    'matrix_send_notice',
    {
      description:
        `Send an m.notice (non-highlighted, conventionally used for bot/automation messages) as ${bot.matrixUserId}.`,
      inputSchema: sendArgs,
    },
    async ({ room, text, plain }) => {
      const target = parseRoomTarget(room);
      const roomId = await resolveRoomTarget(client, target);
      const result = await client.sendMessage(roomId, text, {
        msgtype: 'm.notice',
        format: plain ? 'plain' : 'markdown',
      });
      return {
        content: [
          { type: 'text', text: `Sent notice ${result.event_id} to ${roomId}` },
        ],
      };
    },
  );

  server.registerTool(
    'matrix_read_messages',
    {
      description:
        'Fetch recent message events from a room (newest first). REST-only — no live sync.',
      inputSchema: {
        room: RoomRefSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Number of events to return (default 20, max 100)'),
      },
    },
    async ({ room, limit }) => {
      const target = parseRoomTarget(room);
      const roomId = await resolveRoomTarget(client, target);
      const page = await client.getMessages(roomId, limit ?? 20);
      const lines = page.chunk
        .filter((e) => e.type === 'm.room.message')
        .map((e) => {
          const body =
            typeof (e.content as Record<string, unknown>).body === 'string'
              ? ((e.content as Record<string, unknown>).body as string)
              : JSON.stringify(e.content);
          const ts = new Date(e.origin_server_ts).toISOString();
          return `[${ts}] <${e.sender}> ${body}`;
        });
      return {
        content: [
          {
            type: 'text',
            text:
              lines.length === 0
                ? '(no messages)'
                : lines.reverse().join('\n'),
          },
        ],
      };
    },
  );

  server.registerTool(
    'matrix_list_rooms',
    {
      description: `List room IDs ${bot.matrixUserId} is currently joined to.`,
      inputSchema: {},
    },
    async () => {
      const rooms = await client.getJoinedRooms();
      return {
        content: [
          {
            type: 'text',
            text:
              rooms.length === 0
                ? '(no joined rooms)'
                : rooms.join('\n'),
          },
        ],
      };
    },
  );

  server.registerTool(
    'matrix_create_room',
    {
      description: 'Create a new room. Returns the new room ID.',
      inputSchema: {
        name: z.string().optional(),
        topic: z.string().optional(),
        invite: z
          .array(z.string())
          .optional()
          .describe('User IDs to invite on creation'),
        is_direct: z.boolean().optional(),
        preset: z
          .enum(['private_chat', 'trusted_private_chat', 'public_chat'])
          .optional(),
      },
    },
    async (input) => {
      const result = await client.createRoom(input);
      return {
        content: [{ type: 'text', text: result.room_id }],
      };
    },
  );

  server.registerTool(
    'matrix_invite_user',
    {
      description: 'Invite a user to a room.',
      inputSchema: {
        room: RoomRefSchema,
        user_id: z.string().describe('Matrix user ID to invite (@…:server)'),
      },
    },
    async ({ room, user_id }) => {
      const target = parseRoomTarget(room);
      const roomId = await resolveRoomTarget(client, target);
      await client.invite(roomId, user_id);
      return {
        content: [{ type: 'text', text: `Invited ${user_id} to ${roomId}` }],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep alive; the transport will exit the process when the client disconnects.
  return 0;
}
