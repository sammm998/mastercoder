import { describe, it, expect } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as s from "../src/schema.js";

describe("schema", () => {
  it("every tenant table carries a scoping column", () => {
    const tenantScoped = [s.projects, s.userAgents, s.meetings, s.connections, s.secrets];
    for (const t of tenantScoped) {
      const cols = getTableConfig(t).columns.map((c) => c.name);
      expect(cols).toContain("workspace_id");
    }
  });
});
