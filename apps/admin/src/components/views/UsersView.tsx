"use client";
import { useDeferredValue, useState } from "react";
import { S } from "@/lib/strings";
import { trpc } from "@/lib/trpc";
import { Badge, PageHead, QueryState, Time } from "@/components/ui";

export function UsersView() {
  const [q, setQ] = useState("");
  const deferred = useDeferredValue(q.trim());
  const users = trpc.admin.users.useQuery({ q: deferred, limit: 200 }, { placeholderData: (prev) => prev });

  return (
    <>
      <PageHead title={S.users.title}>
        <label className="field">
          {S.users.search}
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="name@example.com"
            aria-describedby="users-hint"
            maxLength={200}
            style={{ minWidth: 260 }}
          />
        </label>
      </PageHead>
      <p id="users-hint" className="muted">
        {S.users.searchHint}
      </p>
      <QueryState isLoading={users.isLoading} error={users.error} onRetry={() => void users.refetch()} />
      {users.data ? (
        <div className="table-wrap">
          <table aria-busy={users.isFetching}>
            <caption>
              {S.users.caption} {S.common.rows(users.data.length)}
            </caption>
            <thead>
              <tr>
                <th scope="col">{S.users.email}</th>
                <th scope="col">{S.users.name}</th>
                <th scope="col">{S.users.admin}</th>
                <th scope="col">{S.users.status}</th>
                <th scope="col">{S.users.created}</th>
              </tr>
            </thead>
            <tbody>
              {users.data.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    {S.common.empty}
                  </td>
                </tr>
              ) : (
                users.data.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.email}
                      <div className="muted mono">{u.id}</div>
                    </td>
                    <td>{u.name || <span className="muted">–</span>}</td>
                    <td>{u.isAdmin ? <Badge tone="neutral">{S.users.admin}</Badge> : <span className="muted">{S.common.no}</span>}</td>
                    <td>{u.deletedAt ? <Badge tone="critical">{S.users.deleted}</Badge> : <Badge tone="good">{S.users.active}</Badge>}</td>
                    <td>
                      <Time value={u.createdAt} />
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
