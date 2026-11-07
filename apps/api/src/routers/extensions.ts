import { mediaRouter, slidesRouter } from "./studio.js";
import { agentsRouter } from "./agents.js";
import { meetingsRouter } from "./meetings.js";
import { integrationsRouter } from "./integrations.js";
import { knowledgeRouter } from "./knowledge.js";
import { deployRouter } from "./deploy.js";
import { billingRouter } from "./billing.js";
import { adminRouter } from "./admin.js";

/** Routers backed by domain packages through the ports in services.ts. */
export const extensionRouters = {
  media: mediaRouter,
  slides: slidesRouter,
  agents: agentsRouter,
  meetings: meetingsRouter,
  integrations: integrationsRouter,
  knowledge: knowledgeRouter,
  deploy: deployRouter,
  billing: billingRouter,
  admin: adminRouter,
};
