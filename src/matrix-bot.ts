import * as sdk from 'matrix-js-sdk';
import { marked } from 'marked';
import { BotConfig, ProviderConfig, CliResult } from './types.js';
import { runCli } from './cli-runner.js';
import { SessionStore } from './session-store.js';
import { PROVIDER_PRESETS } from './providers.js';

/**
 * A single Matrix bot instance. Listens for messages and dispatches to a CLI provider.
 */
export class MatrixBot {
  private client: sdk.MatrixClient;
  private config: BotConfig;
  private provider: ProviderConfig;
  private sessions: SessionStore;
  private processing: Set<string> = new Set(); // room IDs currently being processed
  private messageQueue: Map<string, string[]> = new Map(); // buffered messages per room

  constructor(
    config: BotConfig,
    providers: Record<string, ProviderConfig>,
    sessions: SessionStore,
  ) {
    this.config = config;
    this.sessions = sessions;

    // Resolve provider: preset + overrides
    const baseProvider = providers[config.provider] || PROVIDER_PRESETS[config.provider];
    if (!baseProvider) {
      throw new Error(`Unknown provider "${config.provider}" for bot "${config.name}"`);
    }
    this.provider = { ...baseProvider, ...config.providerOverrides };

    this.client = sdk.createClient({
      baseUrl: config.matrixHomeserver,
      accessToken: config.matrixAccessToken,
      userId: config.matrixUserId,
    });
  }

  async start(): Promise<void> {
    // Auto-accept invites (needed for DMs)
    this.client.on(sdk.RoomMemberEvent.Membership, (event, member) => {
      if (member.membership === 'invite' && member.userId === this.config.matrixUserId) {
        this.client.joinRoom(event.getRoomId()!).catch((err) => {
          console.error(`[${this.config.name}] Failed to auto-join ${event.getRoomId()}:`, err.message);
        });
      }
    });

    // Register event listener before starting
    this.client.on(sdk.RoomEvent.Timeline, (event, room) => {
      this.handleTimelineEvent(event, room ?? undefined);
    });

    await this.client.startClient({ initialSyncLimit: 0 });
    console.log(`[${this.config.name}] Connected as ${this.config.matrixUserId}`);
  }

  async stop(): Promise<void> {
    this.client.stopClient();
    console.log(`[${this.config.name}] Disconnected`);
  }

  private async handleTimelineEvent(
    event: sdk.MatrixEvent,
    room: sdk.Room | undefined,
  ): Promise<void> {
    // Only handle text messages
    if (event.getType() !== 'm.room.message') return;
    const content = event.getContent();
    if (content.msgtype !== 'm.text') return;

    // Ignore our own messages
    if (event.getSender() === this.config.matrixUserId) return;

    // Ignore other bots / service accounts
    if (this.config.ignoreSenders?.includes(event.getSender()!)) return;

    // Ignore old messages (before bot started)
    const eventTs = event.getTs();
    if (eventTs < Date.now() - 30_000) return;

    const roomId = event.getRoomId();
    if (!roomId) return;

    // Filter rooms if configured
    if (this.config.rooms?.length && !this.config.rooms.includes(roomId)) return;

    const body = content.body as string;

    // Check trigger prefix if configured
    if (this.config.triggerPrefix) {
      if (!body.startsWith(this.config.triggerPrefix)) return;
    }

    const message = this.config.triggerPrefix
      ? body.slice(this.config.triggerPrefix.length).trim()
      : body;

    if (!message) return;

    // Handle special commands
    if (message === '/reset' || message === '/new') {
      this.sessions.clear(this.config.name, roomId);
      await this.sendMessage(roomId, 'Session cleared. Starting fresh.');
      return;
    }

    // If already processing in this room, queue the message
    if (this.processing.has(roomId)) {
      const queue = this.messageQueue.get(roomId) || [];
      queue.push(message);
      this.messageQueue.set(roomId, queue);
      await this.sendReaction(roomId, event.getId()!, '\u{1F4E5}'); // inbox tray emoji
      return;
    }

    await this.dispatch(roomId, message, event.getId()!);
  }

  private async dispatch(roomId: string, message: string, eventId: string): Promise<void> {
    this.processing.add(roomId);

    try {
      // Send read receipt
      await this.sendReadReceipt(roomId, eventId);

      // Show typing indicator
      await this.setTyping(roomId, true);

      // Get or create session
      const session = this.sessions.get(this.config.name, roomId);

      // Run the CLI
      const result = await runCli(
        this.provider,
        message,
        session?.sessionId,
        this.config.extraArgs || [],
      );

      // Stop typing
      await this.setTyping(roomId, false);

      // Store session ID for threading
      if (result.sessionId) {
        this.sessions.set(this.config.name, roomId, result.sessionId);
      } else {
        this.sessions.touch(this.config.name, roomId);
      }

      // Send response (trim leading/trailing whitespace)
      const responseText = result.response?.trim();
      if (responseText) {
        await this.sendMessage(roomId, responseText);
      }

      // React with checkmark on success, warning on non-zero exit
      const emoji = result.exitCode === 0 ? '\u2705' : '\u26A0\uFE0F';
      await this.sendReaction(roomId, eventId, emoji);

    } catch (err) {
      await this.setTyping(roomId, false);
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(roomId, `Error: ${errorMsg}`);
      await this.sendReaction(roomId, eventId, '\u274C'); // red X
    } finally {
      this.processing.delete(roomId);

      // Process queued messages
      const queue = this.messageQueue.get(roomId);
      if (queue?.length) {
        const next = queue.shift()!;
        if (!queue.length) this.messageQueue.delete(roomId);
        // Use a synthetic event ID for queued messages
        await this.dispatch(roomId, next, '');
      }
    }
  }

  // ── Matrix helpers ─────────────────────────────────────────────────────

  private async sendMessage(roomId: string, text: string): Promise<void> {
    // Split long messages (Matrix has a ~65KB limit per event)
    const MAX_LEN = 30_000;
    if (text.length > MAX_LEN) {
      const chunks = splitMessage(text, MAX_LEN);
      for (const chunk of chunks) {
        await this.sendMessage(roomId, chunk);
      }
      return;
    }

    // body = plain text (fallback), formatted_body = HTML from markdown
    const html = await marked.parse(text, { breaks: true });
    await this.client.sendEvent(roomId, 'm.room.message' as any, {
      msgtype: 'm.text',
      body: text,
      format: 'org.matrix.custom.html',
      formatted_body: html,
    });
  }

  private async setTyping(roomId: string, typing: boolean): Promise<void> {
    try {
      await this.client.sendTyping(roomId, typing, typing ? 30_000 : 0);
    } catch {
      // typing indicators are best-effort
    }
  }

  private async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    try {
      await this.client.sendReadReceipt(
        new sdk.MatrixEvent({ event_id: eventId, room_id: roomId }),
      );
    } catch {
      // receipts are best-effort
    }
  }

  private async sendReaction(roomId: string, eventId: string, emoji: string): Promise<void> {
    if (!eventId) return;
    try {
      await this.client.sendEvent(roomId, 'm.reaction' as any, {
        'm.relates_to': {
          rel_type: 'm.annotation',
          event_id: eventId,
          key: emoji,
        },
      });
    } catch {
      // reactions are best-effort
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

