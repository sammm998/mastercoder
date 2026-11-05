"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "./trpc";
import { wsUrl } from "./env";
import { isForgeEvent, mergeEvents, type ForgeEvent } from "./events";

export type SocketState = "connecting" | "open" | "closed" | "denied";

export interface PresenceEntry {
  userId: string;
  name: string;
  seenAt: number;
}

/**
 * Project event stream: persisted history from `project.events`, then live events from
 * /ws/events/:projectId with exponential-backoff reconnects. Also broadcasts our presence.
 */
export function useProjectEvents(projectId: string, me: { name: string } | null) {
  const trpc = useTRPC();
  const history = useQuery({ ...trpc.project.events.queryOptions({ projectId, limit: 500 }), staleTime: Infinity });
  const [events, setEvents] = useState<ForgeEvent[]>([]);
  const [state, setState] = useState<SocketState>("connecting");
  const [presence, setPresence] = useState<Record<string, PresenceEntry>>({});
  const socket = useRef<WebSocket | null>(null);
  const meName = me?.name;

  useEffect(() => {
    if (!history.data) return;
    const past = history.data.map((r) => r.payload).filter(isForgeEvent);
    setEvents((cur) => mergeEvents(past, cur));
  }, [history.data]);

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer = 0;
    let heartbeat = 0;
    const connect = () => {
      setState("connecting");
      const ws = new WebSocket(wsUrl(`/ws/events/${encodeURIComponent(projectId)}`));
      socket.current = ws;
      const buffer: ForgeEvent[] = [];
      let flush = 0;
      ws.onopen = () => {
        attempt = 0;
        setState("open");
        const announce = () => meName !== undefined && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "presence", name: meName }));
        announce();
        heartbeat = window.setInterval(announce, 20_000);
      };
      ws.onmessage = (m) => {
        let data: unknown;
        try {
          data = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (!isForgeEvent(data)) return;
        if (data.type === "presence") {
          const p = data;
          setPresence((cur) => ({ ...cur, [p.userId]: { userId: p.userId, name: p.name, seenAt: Date.now() } }));
          return;
        }
        // Batch bursts (token deltas) into one render per frame.
        buffer.push(data);
        if (!flush)
          flush = requestAnimationFrame(() => {
            flush = 0;
            const batch = buffer.splice(0);
            setEvents((cur) => mergeEvents(cur, batch));
          });
      };
      ws.onclose = (e) => {
        window.clearInterval(heartbeat);
        socket.current = null;
        if (closed) return;
        if (e.code === 4403) {
          setState("denied");
          return;
        }
        setState("closed");
        attempt++;
        timer = window.setTimeout(connect, Math.min(15_000, 500 * 2 ** attempt));
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      window.clearInterval(heartbeat);
      socket.current?.close(1000, "unmount");
    };
  }, [projectId, meName]);

  // Forget collaborators we haven't heard from in a while.
  useEffect(() => {
    const id = window.setInterval(() => {
      setPresence((cur) => {
        const now = Date.now();
        const next = Object.fromEntries(Object.entries(cur).filter(([, p]) => now - p.seenAt < 50_000));
        return Object.keys(next).length === Object.keys(cur).length ? cur : next;
      });
    }, 10_000);
    return () => window.clearInterval(id);
  }, []);

  return { events, state, presence: Object.values(presence), historyLoading: history.isPending, historyError: history.error };
}
