"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatDate } from "@/i18n/format";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { API_URL } from "@/lib/env";
import { httpTransport, uploadChunks } from "@/lib/upload";
import { listPending, removePending, savePending, type PendingUpload } from "@/lib/pending-uploads";
import { ErrorNotice } from "@/components/Feedback";
import { Icon } from "@/components/Icon";

const CHUNK = 1024 * 1024;

function pickMime(): string {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * In-person recording: MediaRecorder → Blob → meetings.startRecording → resumable PUT chunks
 * (SHA-256 per chunk) → meetings.completeRecording. The blob is parked in IndexedDB until the
 * upload completes, so a reload can resume via meetings.uploadStatus.
 */
export function Recorder({ workspaceId, projectId, language }: { workspaceId: string; projectId?: string; language: "sv" | "en" }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const router = useRouter();
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<"idle" | "recording" | "uploading" | "done">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [micError, setMicError] = useState<"micDenied" | "unsupported" | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const rec = useRef<MediaRecorder | null>(null);
  const parts = useRef<Blob[]>([]);
  const started = useRef(0);
  const title = useRef("");

  useEffect(() => {
    void listPending().then((p) => setPending(p.filter((x) => Date.now() - x.createdAt < 7 * 86400_000)));
  }, []);

  useEffect(() => {
    if (state !== "recording") return;
    const id = window.setInterval(() => setElapsed(Date.now() - started.current), 500);
    return () => window.clearInterval(id);
  }, [state]);

  const upload = async (p: PendingUpload) => {
    setState("uploading");
    setError(null);
    try {
      await uploadChunks(p.blob, httpTransport({ apiUrl: API_URL, uploadId: p.uploadId, status: () => client.meetings.uploadStatus.query({ uploadId: p.uploadId }) }), {
        chunkSize: p.chunkSize,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      await client.meetings.completeRecording.mutate({ uploadId: p.uploadId });
      await removePending(p.uploadId);
      setPending((cur) => cur.filter((x) => x.uploadId !== p.uploadId));
      setState("done");
      await qc.invalidateQueries({ queryKey: trpc.meetings.list.queryKey({ workspaceId }) });
      router.push(`/app/meetings/${p.meetingId}`);
    } catch (e) {
      setError(e);
      setState("idle");
      setPending(await listPending());
    }
  };

  const start = async () => {
    setMicError(null);
    setError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) return setMicError("unsupported");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return setMicError("micDenied");
    }
    const mimeType = pickMime();
    const r = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64_000 } : undefined);
    parts.current = [];
    r.ondataavailable = (e) => e.data.size && parts.current.push(e.data);
    r.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const blob = new Blob(parts.current, { type: r.mimeType || "audio/webm" });
      parts.current = [];
      try {
        const s = await client.meetings.startRecording.mutate({ workspaceId, projectId, language, title: title.current || undefined, totalSize: Math.max(1, blob.size), mimeType: blob.type.slice(0, 100), chunkSize: CHUNK });
        const p: PendingUpload = { uploadId: s.uploadId, meetingId: s.meetingId, chunkSize: s.chunkSize, title: title.current, mimeType: blob.type, blob, createdAt: Date.now() };
        await savePending(p);
        await upload(p);
      } catch (e) {
        setError(e);
        setState("idle");
      }
    };
    r.start(1000);
    rec.current = r;
    started.current = Date.now();
    title.current = `${t("meetings.record")} · ${formatDate(new Date(), locale)}`;
    setElapsed(0);
    setState("recording");
  };

  const stop = () => {
    rec.current?.stop();
    rec.current = null;
    setState("uploading");
  };

  return (
    <div className="stack">
      {pending.length > 0 && state === "idle" && (
        <div className="notice notice-warn" role="status">
          <div className="grow stack" style={{ gap: 8 }}>
            <strong>{t("meetings.resumeTitle")}</strong>
            {pending.map((p) => (
              <div key={p.uploadId} className="row-between">
                <span>
                  {p.title || p.meetingId} · {formatDate(new Date(p.createdAt), locale)}
                </span>
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className="btn btn-sm" onClick={() => void upload(p)}>
                    {t("meetings.resume")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() =>
                      void removePending(p.uploadId).then(() => setPending((cur) => cur.filter((x) => x.uploadId !== p.uploadId)))
                    }
                  >
                    {t("meetings.discard")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={state !== "idle"} />
        {t("meetings.consentCheck")}
      </label>
      <div className="row">
        {state === "recording" ? (
          <button type="button" className="btn btn-lg mic" data-active="true" onClick={stop}>
            <Icon name="stop" /> {t("meetings.stop")}
          </button>
        ) : (
          <button type="button" className="btn btn-lg btn-primary" onClick={() => void start()} disabled={!consent || state !== "idle"}>
            <Icon name="record" /> {t("meetings.start")}
          </button>
        )}
        {state === "recording" && (
          <span className="row" style={{ gap: 8 }} role="timer" aria-live="off">
            <span className="dot" style={{ color: "var(--danger)" }} /> {t("meetings.recording")} <span className="mono">{clock(elapsed)}</span>
          </span>
        )}
      </div>
      {state === "uploading" && progress && (
        <div className="stack" style={{ gap: 6 }} role="status">
          <span className="hint">{t("meetings.uploading", { done: progress.done, total: progress.total })}</span>
          <div className="bar" aria-hidden="true">
            <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        </div>
      )}
      {state === "done" && <p className="notice notice-ok">{t("meetings.processing")}</p>}
      {micError && <p className="notice notice-warn">{t(`meetings.${micError}`)}</p>}
      <ErrorNotice error={error} service="uploads" />
    </div>
  );
}
