/**
 * Thin REST-only Matrix client.
 *
 * Used by `send` and `mcp` modes to operate alongside a running responder
 * daemon without racing on /sync. No client-side state, no crypto — every
 * call is a single authenticated HTTP request.
 */

import { marked } from 'marked';

export interface MatrixCreds {
  homeserver: string;
  accessToken: string;
  userId: string;
}

export interface MessagesPage {
  start: string;
  end: string;
  chunk: Array<{
    event_id: string;
    type: string;
    sender: string;
    origin_server_ts: number;
    content: Record<string, unknown>;
  }>;
}

export class MatrixRest {
  constructor(private creds: MatrixCreds) {}

  private async req<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    queryParams?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.creds.homeserver}/_matrix/client/v3${path}`);
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, v);
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.creds.accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = '';
      try {
        const j: any = await res.json();
        detail = j.errcode ? `${j.errcode} ${j.error || ''}`.trim() : (j.error ?? '');
      } catch {
        detail = await res.text().catch(() => '');
      }
      throw new Error(`Matrix ${method} ${path} → ${res.status} ${detail}`.trim());
    }
    return (await res.json()) as T;
  }

  /** Sanity check + cheap auth probe. */
  async whoami(): Promise<{ user_id: string }> {
    return this.req('GET', '/account/whoami');
  }

  /** Resolve `#alias:server` → `!roomId:server`. */
  async resolveAlias(alias: string): Promise<string> {
    const enc = encodeURIComponent(alias);
    const res = await this.req<{ room_id: string }>('GET', `/directory/room/${enc}`);
    return res.room_id;
  }

  /** Read `m.direct` account data → `{ userId: roomIds[] }`. */
  async getDirectRooms(): Promise<Record<string, string[]>> {
    const userId = encodeURIComponent(this.creds.userId);
    try {
      return await this.req('GET', `/user/${userId}/account_data/m.direct`);
    } catch (err) {
      // M_NOT_FOUND is normal when no DMs have been recorded yet.
      if (err instanceof Error && /M_NOT_FOUND|404/.test(err.message)) return {};
      throw err;
    }
  }

  /**
   * First DM room ID this account has open with `targetUserId`, or null.
   *
   * Strategy: prefer the explicit `m.direct` account-data mapping (fast,
   * one GET). If that's empty or doesn't list the target — common when
   * the room was created from a client that didn't write m.direct — fall
   * back to scanning joined rooms for a 2-member room whose other member
   * is the target. On a successful fallback, write the discovery into
   * m.direct so the next call is fast.
   */
  async findDirectRoom(targetUserId: string): Promise<string | null> {
    const direct = await this.getDirectRooms();
    const explicit = direct[targetUserId]?.[0];
    if (explicit) return explicit;

    const joined = await this.getJoinedRooms();
    for (const roomId of joined) {
      const enc = encodeURIComponent(roomId);
      try {
        const members = await this.req<{ joined: Record<string, unknown> }>(
          'GET',
          `/rooms/${enc}/joined_members`,
        );
        const userIds = Object.keys(members.joined ?? {});
        if (
          userIds.length === 2 &&
          userIds.includes(targetUserId) &&
          userIds.includes(this.creds.userId)
        ) {
          await this.recordDirectRoom(targetUserId, roomId).catch(() => {
            // Best-effort cache write; surfacing the error would mask the
            // successful resolution we're returning.
          });
          return roomId;
        }
      } catch {
        // Some rooms may forbid the bot from listing members; skip.
      }
    }
    return null;
  }

  /**
   * Append a (userId, roomId) pair to the bot's `m.direct` account data,
   * preserving any existing entries. Idempotent.
   */
  async recordDirectRoom(targetUserId: string, roomId: string): Promise<void> {
    const direct = await this.getDirectRooms();
    const existing = new Set(direct[targetUserId] ?? []);
    if (existing.has(roomId)) return;
    existing.add(roomId);
    direct[targetUserId] = Array.from(existing);
    const userId = encodeURIComponent(this.creds.userId);
    await this.req('PUT', `/user/${userId}/account_data/m.direct`, direct);
  }

  /** All rooms the bot is a member of (REST snapshot, no sync). */
  async getJoinedRooms(): Promise<string[]> {
    const res = await this.req<{ joined_rooms: string[] }>('GET', '/joined_rooms');
    return res.joined_rooms;
  }

  /** Send `m.text` (default) or `m.notice`. Markdown body → HTML formatted_body. */
  async sendMessage(
    roomId: string,
    text: string,
    opts: { msgtype?: 'm.text' | 'm.notice'; format?: 'plain' | 'markdown' } = {},
  ): Promise<{ event_id: string }> {
    const msgtype = opts.msgtype ?? 'm.text';
    const html =
      opts.format === 'plain' ? null : await marked.parse(text, { breaks: true });
    const content: Record<string, unknown> = { msgtype, body: text };
    if (html && html !== text) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = html;
    }
    const txnId = `mdispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const enc = encodeURIComponent(roomId);
    return this.req('PUT', `/rooms/${enc}/send/m.room.message/${txnId}`, content);
  }

  /** Get recent messages from a room (newest first). */
  async getMessages(
    roomId: string,
    limit = 20,
  ): Promise<MessagesPage> {
    const enc = encodeURIComponent(roomId);
    return this.req<MessagesPage>('GET', `/rooms/${enc}/messages`, undefined, {
      dir: 'b',
      limit: String(limit),
    });
  }

  async createRoom(opts: {
    name?: string;
    topic?: string;
    invite?: string[];
    is_direct?: boolean;
    preset?: 'private_chat' | 'trusted_private_chat' | 'public_chat';
  }): Promise<{ room_id: string }> {
    return this.req('POST', '/createRoom', opts);
  }

  async invite(roomId: string, userId: string): Promise<void> {
    const enc = encodeURIComponent(roomId);
    await this.req('POST', `/rooms/${enc}/invite`, { user_id: userId });
  }
}

export type RoomTarget =
  | { kind: 'roomId'; value: string }
  | { kind: 'alias'; value: string }
  | { kind: 'dm'; userId: string };

/**
 * Parse a flag value into a structured target. Accepts:
 * - `!abcd…:server` → roomId
 * - `#alias:server` → alias
 * - `@user:server`  → DM lookup via m.direct
 */
export function parseRoomTarget(value: string): RoomTarget {
  if (value.startsWith('!')) return { kind: 'roomId', value };
  if (value.startsWith('#')) return { kind: 'alias', value };
  if (value.startsWith('@')) return { kind: 'dm', userId: value };
  throw new Error(
    `Cannot parse room target "${value}" — expected room ID (!…), alias (#…), or user ID (@…)`,
  );
}

/** Resolve a target into a concrete room ID. */
export async function resolveRoomTarget(
  client: MatrixRest,
  target: RoomTarget,
): Promise<string> {
  if (target.kind === 'roomId') return target.value;
  if (target.kind === 'alias') return client.resolveAlias(target.value);
  const roomId = await client.findDirectRoom(target.userId);
  if (!roomId) {
    throw new Error(
      `No direct chat with ${target.userId} found in m.direct account data. ` +
        `Open the DM in a Matrix client first, or pass a room ID directly.`,
    );
  }
  return roomId;
}
