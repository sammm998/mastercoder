import { router } from "./trpc.js";
import { authRouter } from "./routers/auth.js";
import { workspaceRouter } from "./routers/workspace.js";
import { projectRouter } from "./routers/project.js";
import { taskRouter } from "./routers/task.js";
import { gdprRouter } from "./routers/gdpr.js";
import { extensionRouters } from "./routers/extensions.js";

export const appRouter = router({
  auth: authRouter,
  workspace: workspaceRouter,
  project: projectRouter,
  task: taskRouter,
  gdpr: gdprRouter,
  ...extensionRouters,
});

export type AppRouter = typeof appRouter;
