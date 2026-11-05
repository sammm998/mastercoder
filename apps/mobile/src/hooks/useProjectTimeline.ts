import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { trpc, useSession } from "../api";
import { API_URL } from "../config";
import { emptyTimeline, eventsFromHistory, parseServerMessage, reduceEvent, reduceEvents, type Timeline } from "../lib/events";
import { ReconnectingSocket, eventsUrl, type ConnectionState, type SocketLike } from "../lib/ws";

/**
 * Project timeline = persisted history (project.events) + the live WebSocket stream, deduplicated by event id.
 * On every (re)connect the history is refetched so nothing published while offline is missed.
 */
export function useProjectTimeline(projectId: string) {
  const session = useSession();
  const [timeline, setTimeline] = useState<Timeline>(emptyTimeline);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const history = trpc.project.events.useQuery({ projectId, limit: 300 }, { enabled: !!projectId, staleTime: 0 });
  const refetchRef = useRef(history.refetch);
  refetchRef.current = history.refetch;

  useEffect(() => {
    if (history.data) setTimeline((t) => reduceEvents(t, eventsFromHistory(history.data)));
  }, [history.data]);

  useEffect(() => {
    if (!projectId || session.status !== "signedIn") return;
    const rs = new ReconnectingSocket({
      url: () => eventsUrl(API_URL, projectId, session.getToken()),
      factory: (url) => new WebSocket(url) as unknown as SocketLike,
      onMessage: (raw) => {
        const m = parseServerMessage(raw);
        if (m?.kind === "event") setTimeline((t) => reduceEvent(t, m.event));
      },
      onState: (s) => setConnection(s),
      onOpen: () => void refetchRef.current(),
    });
    rs.start();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") rs.kick();
    });
    return () => {
      sub.remove();
      rs.close();
    };
  }, [projectId, session.status, session]);

  const update = useCallback((fn: (t: Timeline) => Timeline) => setTimeline(fn), []);
  return { timeline, update, connection, historyLoading: history.isLoading, historyError: history.error };
}
