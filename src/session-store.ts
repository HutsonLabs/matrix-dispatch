import { Session } from './types.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';

/**
 * Simple file-backed session store.
 * Key: `${botName}:${roomId}` → Session
 */
export class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private key(botName: string, roomId: string): string {
    return `${botName}:${roomId}`;
  }

  get(botName: string, roomId: string): Session | undefined {
    return this.sessions.get(this.key(botName, roomId));
  }

  set(botName: string, roomId: string, sessionId: string): void {
    this.sessions.set(this.key(botName, roomId), {
      botName,
      roomId,
      sessionId,
      lastActivity: Date.now(),
    });
    this.save();
  }

  touch(botName: string, roomId: string): void {
    const session = this.get(botName, roomId);
    if (session) {
      session.lastActivity = Date.now();
      this.save();
    }
  }

  clear(botName: string, roomId: string): void {
    this.sessions.delete(this.key(botName, roomId));
    this.save();
  }

  /** Expire sessions older than maxAge ms */
  prune(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, session] of this.sessions) {
      if (session.lastActivity < cutoff) {
        this.sessions.delete(key);
      }
    }
    this.save();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      for (const [key, session] of Object.entries(data)) {
        this.sessions.set(key, session as Session);
      }
    } catch {
      // corrupted file, start fresh
    }
  }

  private save(): void {
    const obj = Object.fromEntries(this.sessions);
    writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
  }
}
