"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useT } from "@/i18n/client";
import { formatUsd, formatDate } from "@/i18n/format";
import type { MessageKey } from "@/i18n/translate";
import { useTRPC, useTRPCClient, type RouterInputs } from "@/lib/trpc";
import type { ForgeEvent } from "@/lib/events";
import { ErrorNotice, EmptyState, LoadingBlock } from "@/components/Feedback";

type MediaKind = RouterInputs["media"]["generate"]["kind"];
const KINDS: MediaKind[] = ["image", "image-set", "logo", "video", "remotion"];
const MEDIA_ARTIFACTS = new Set(["image", "video", "audio", "screenshot"]);

export function MediaPanel({ projectId, events, canWrite }: { projectId: string; events: ForgeEvent[]; canWrite: boolean }) {
  const t = useT();
  const locale = useLocale();
  const trpc = useTRPC();
  const client = useTRPCClient();
  const qc = useQueryClient();
  const artifacts = useQuery(trpc.project.artifacts.queryOptions({ projectId }));
  const [kind, setKind] = useState<MediaKind>("image");
  const [prompt, setPrompt] = useState("");
  const [estimate, setEstimate] = useState<{ lowUsd: number; highUsd: number } | null>(null);
  const [estimateError, setEstimateError] = useState<unknown>(null);
  const generate = useMutation(trpc.media.generate.mutationOptions());
  const lastArtifact = useMemo(() => [...events].reverse().find((e) => e.type === "artifact.ready")?.id, [events]);
  useEffect(() => {
    if (lastArtifact) void qc.invalidateQueries({ queryKey: trpc.project.artifacts.queryKey({ projectId }) });
  }, [lastArtifact, qc, trpc, projectId]);

  const media = (artifacts.data ?? []).filter((a) => MEDIA_ARTIFACTS.has(a.kind));

  const getEstimate = async () => {
    setEstimateError(null);
    try {
      const e = await client.media.estimate.query({ projectId, kind, prompt });
      setEstimate(e);
    } catch (err) {
      setEstimate(null);
      setEstimateError(err);
    }
  };

  return (
    <div className="panel-pad stack-lg">
      {canWrite && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (prompt.trim()) generate.mutate({ projectId, kind, prompt: prompt.trim(), options: {} });
          }}
        >
          <h2 className="section-title-sm">{t("project.media.generateTitle")}</h2>
          <div className="seg" role="radiogroup" aria-label={t("project.media.kindLabel")}>
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                aria-pressed={kind === k}
                onClick={() => {
                  setKind(k);
                  setEstimate(null);
                }}
              >
                {t(`project.media.kind.${k}` as MessageKey)}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="media-prompt">{t("project.media.prompt")}</label>
            <textarea
              id="media-prompt"
              className="textarea"
              rows={2}
              value={prompt}
              maxLength={4000}
              onChange={(e) => {
                setPrompt(e.target.value);
                setEstimate(null);
              }}
            />
          </div>
          <div className="row-between">
            <span className="mono">{estimate ? t("project.media.estimated", { low: formatUsd(estimate.lowUsd, locale), high: formatUsd(estimate.highUsd, locale) }) : ""}</span>
            <div className="row">
              <button type="button" className="btn btn-sm" disabled={!prompt.trim()} onClick={() => void getEstimate()}>
                {t("project.media.estimate")}
              </button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!prompt.trim() || generate.isPending}>
                {t("project.media.generate")}
              </button>
            </div>
          </div>
          <ErrorNotice error={estimateError ?? generate.error} service="media" compact />
          {generate.isSuccess && (
            <p className="notice notice-ok" role="status">
              {t("project.media.queued")}
            </p>
          )}
        </form>
      )}
      <section>
        <h2 className="section-title-sm" style={{ marginBottom: 12 }}>
          {t("project.media.title")}
        </h2>
        {artifacts.isPending ? (
          <LoadingBlock rows={3} />
        ) : artifacts.isError ? (
          <ErrorNotice error={artifacts.error} />
        ) : media.length === 0 ? (
          <EmptyState title={t("project.media.title")} body={t("project.media.empty")} />
        ) : (
          <ul className="media-grid">
            {media.map((a) => (
              <li key={a.id} className="media-item">
                {a.mimeType.startsWith("image/") ? (
                  <img src={a.url} alt={String((a.meta as { prompt?: string } | null)?.prompt ?? a.kind)} loading="lazy" />
                ) : a.mimeType.startsWith("video/") ? (
                  <video src={a.url} controls preload="metadata" />
                ) : a.mimeType.startsWith("audio/") ? (
                  <audio src={a.url} controls preload="metadata" />
                ) : null}
                <div className="row-between" style={{ padding: "8px 10px" }}>
                  <span className="badge">{t(`project.media.types.${a.kind}` as MessageKey)}</span>
                  <span className="hint">{a.costUsd > 0 ? formatUsd(a.costUsd, locale) : formatDate(a.createdAt, locale, false)}</span>
                  <a href={a.url} target="_blank" rel="noreferrer noopener" download>
                    {t("common.download")}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
