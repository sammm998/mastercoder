import { z } from "zod";

export interface DbBranch {
  branchId: string;
  name: string;
  /** Postgres connection URL for the branch. */
  connectionUrl: string;
  parentId?: string;
  createdAt: string;
}

/**
 * Copy-on-write (or full copy) database branches per project. Used for agent checkpoints: branch
 * before a risky step, restore the project's main database from the branch to roll back data.
 *
 * `projectRoot` identifies the project's main database: a Neon project id for Neon, the main
 * database name for PgClone.
 */
export interface DbBranchProvider {
  readonly name: string;
  readonly isMock: boolean;
  createBranch(projectRoot: string, name: string, fromBranch?: string): Promise<{ branchId: string; connectionUrl: string }>;
  /** Make the project's main database equal to `branchId` (the branch itself is kept). */
  restoreBranch(projectRoot: string, branchId: string): Promise<void>;
  deleteBranch(projectRoot: string, branchId: string): Promise<void>;
  listBranches(projectRoot: string): Promise<DbBranch[]>;
}

export const BranchNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/, "branch names may contain letters, digits, space, _ . -");
