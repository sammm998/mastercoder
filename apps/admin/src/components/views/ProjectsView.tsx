"use client";
import { useState } from "react";
import { S } from "@/lib/strings";
import { trpc } from "@/lib/trpc";
import { Badge, PageHead, QueryState, Time } from "@/components/ui";

const LIMITS = [50, 100, 200] as const;

export function ProjectsView() {
  const [limit, setLimit] = useState<number>(50);
  const [filter, setFilter] = useState("");
  const projects = trpc.admin.projects.useQuery({ limit }, { placeholderData: (prev) => prev });
  const f = filter.trim().toLowerCase();
  const rows = (projects.data ?? []).filter((p) => !f || p.name.toLowerCase().includes(f) || p.workspace.toLowerCase().includes(f) || p.id.includes(f));

  return (
    <>
      <PageHead title={S.projects.title}>
        <label className="field">
          {S.projects.filter}
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ minWidth: 220 }} />
        </label>
        <label className="field">
          {S.projects.limit}
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMITS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </PageHead>
      <QueryState isLoading={projects.isLoading} error={projects.error} onRetry={() => void projects.refetch()} />
      {projects.data ? (
        <div className="table-wrap">
          <table aria-busy={projects.isFetching}>
            <caption>
              {S.projects.caption} {S.common.rows(rows.length)}
            </caption>
            <thead>
              <tr>
                <th scope="col">{S.projects.name}</th>
                <th scope="col">{S.projects.workspace}</th>
                <th scope="col">{S.projects.visibility}</th>
                <th scope="col">{S.projects.created}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    {S.common.empty}
                  </td>
                </tr>
              ) : (
                rows.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.name}
                      <div className="muted mono">{p.id}</div>
                    </td>
                    <td>{p.workspace}</td>
                    <td>{p.isPublic ? <Badge tone="neutral">{S.projects.public}</Badge> : <Badge tone="neutral">{S.projects.private}</Badge>}</td>
                    <td>
                      <Time value={p.createdAt} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
