import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { WebSocket } from "ws";
import { eq, collabDocs, projectFiles, type Db } from "@forge/db";
import type { Logger } from "@forge/shared";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

/** Optional cross-replica relay (Redis pub/sub) for Yjs updates. */
export interface CollabRelay {
  publish(room: string, update: Uint8Array): void;
  subscribe(room: string, fn: (update: Uint8Array) => void): () => void;
}

interface Room {
  name: string;
  projectId: string;
  path: string | null;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Set<number>>;
  saveTimer: NodeJS.Timeout | null;
  unsubscribeRelay: (() => void) | null;
}

const RELAY_ORIGIN = Symbol("relay");

/**
 * Yjs collaboration server speaking the standard y-websocket protocol (sync + awareness), so the web app
 * can use `y-websocket`'s WebsocketProvider + y-monaco. Rooms are `${projectId}:${filePath}`; doc text
 * lives in Y.Text "content" and is persisted to collab_docs and mirrored to project_files.
 */
export class CollabServer {
  private rooms = new Map<string, Promise<Room>>();
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly relay: CollabRelay | null = null,
    private readonly saveDebounceMs = 800,
  ) {}

  private async load(name: string, projectId: string): Promise<Room> {
    const doc = new Y.Doc();
    const path = name.slice(projectId.length + 1) || null;
    const [saved] = await this.db.select().from(collabDocs).where(eq(collabDocs.room, name));
    if (saved) {
      Y.applyUpdate(doc, Buffer.from(saved.state, "base64"));
    } else if (path) {
      const [file] = await this.db.select().from(projectFiles).where(eq(projectFiles.projectId, projectId)).then((rows) => rows.filter((r) => r.path === path));
      if (file) doc.getText("content").insert(0, file.content);
    }
    const room: Room = { name, projectId, path, doc, awareness: new awarenessProtocol.Awareness(doc), conns: new Map(), saveTimer: null, unsubscribeRelay: null };
    room.awareness.setLocalState(null);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      const msg = encoding.toUint8Array(enc);
      for (const c of room.conns.keys()) if (c !== origin) send(c, msg);
      if (origin !== RELAY_ORIGIN) this.relay?.publish(name, update);
      this.scheduleSave(room);
    });
    room.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = added.concat(updated, removed);
      if (origin && room.conns.has(origin as WebSocket)) {
        const ids = room.conns.get(origin as WebSocket)!;
        added.forEach((id) => ids.add(id));
        removed.forEach((id) => ids.delete(id));
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed));
      const msg = encoding.toUint8Array(enc);
      for (const c of room.conns.keys()) send(c, msg);
    });
    if (this.relay) room.unsubscribeRelay = this.relay.subscribe(name, (u) => Y.applyUpdate(doc, u, RELAY_ORIGIN));
    return room;
  }

  private scheduleSave(room: Room) {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => void this.save(room), this.saveDebounceMs);
  }

  async save(room: Room): Promise<void> {
    room.saveTimer = null;
    const state = Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString("base64");
    await this.db
      .insert(collabDocs)
      .values({ room: room.name, projectId: room.projectId, state })
      .onConflictDoUpdate({ target: collabDocs.room, set: { state, updatedAt: new Date() } });
    if (room.path) {
      const content = room.doc.getText("content").toString();
      await this.db
        .insert(projectFiles)
        .values({ projectId: room.projectId, path: room.path, content })
        .onConflictDoUpdate({ target: [projectFiles.projectId, projectFiles.path], set: { content, updatedAt: new Date() } });
    }
  }

  async flushAll(): Promise<void> {
    for (const p of this.rooms.values()) {
      const r = await p;
      if (r.saveTimer) {
        clearTimeout(r.saveTimer);
        await this.save(r);
      }
    }
  }

  async handle(ws: WebSocket, roomName: string, projectId: string): Promise<void> {
    let p = this.rooms.get(roomName);
    if (!p) {
      p = this.load(roomName, projectId);
      this.rooms.set(roomName, p);
    }
    const room = await p;
    room.conns.set(ws, new Set());
    ws.binaryType = "arraybuffer";
    ws.on("message", (data: ArrayBuffer | Buffer) => {
      try {
        const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const dec = decoding.createDecoder(buf);
        const type = decoding.readVarUint(dec);
        if (type === MSG_SYNC) {
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MSG_SYNC);
          syncProtocol.readSyncMessage(dec, enc, room.doc, ws);
          if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
        } else if (type === MSG_AWARENESS) {
          awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(dec), ws);
        }
      } catch (e) {
        this.log.warn("collab message error", { room: roomName, error: (e as Error).message });
      }
    });
    ws.on("close", () => {
      const ids = room.conns.get(ws);
      room.conns.delete(ws);
      if (ids) awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null);
      if (room.conns.size === 0) {
        void (async () => {
          if (room.saveTimer) clearTimeout(room.saveTimer);
          await this.save(room);
          if (room.conns.size === 0) {
            room.unsubscribeRelay?.();
            room.doc.destroy();
            this.rooms.delete(roomName);
          }
        })();
      }
    });
    // Initial sync step 1 + current awareness.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, room.doc);
    send(ws, encoding.toUint8Array(enc));
    const states = [...room.awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(room.awareness, states));
      send(ws, encoding.toUint8Array(a));
    }
  }
}

function send(ws: WebSocket, msg: Uint8Array) {
  if (ws.readyState === 1) ws.send(msg);
}
