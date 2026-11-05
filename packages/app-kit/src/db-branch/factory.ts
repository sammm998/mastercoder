import { selectAdapter } from "@forge/shared";
import { NeonBranchProvider } from "../adapters/neon.js";
import { PgCloneBranchProvider } from "../adapters/pg-clone.js";
import { MockDbBranchProvider } from "./mock.js";
import type { DbBranchProvider } from "./types.js";

/** DB_BRANCH_PROVIDER=neon|pgclone|mock (default mock). */
export function createDbBranchProvider(): DbBranchProvider {
  return selectAdapter<DbBranchProvider>(
    "DB_BRANCH_PROVIDER",
    {
      neon: () => new NeonBranchProvider(),
      pgclone: () => new PgCloneBranchProvider(),
      mock: () => new MockDbBranchProvider(),
    },
    "mock",
  ).instance;
}
