# Forge benchmark — 20 prompts

Run: `pnpm bench` (all) or `pnpm bench --only 03`. Results → `evals/results/<timestamp>/report.md`.
Success = the task finishes with every required quality gate passing and every acceptance check below
true, with **no manual fixes**. Target: >= 16/20.

| # | Id | Prompt | Expected intents | Acceptance checks |
|---|----|--------|------------------|-------------------|
| 01 | saas-auth | Build a SaaS app for tracking team OKRs with email/password signup, login, and a dashboard where each user only sees their own objectives. | app | auth routes protected; RLS on every table; signup→create objective→logout→login E2E passes |
| 02 | booking | Build a booking system for a hair salon: customers pick a service, a stylist and a free time slot; staff see the day's bookings. | app | double-booking prevented; booking E2E passes |
| 03 | crm | Build a small CRM with companies, contacts, deals in a kanban pipeline and notes on each deal. | app | CRUD for 3 entities; pipeline stage change persists |
| 04 | blog-cms | Make a blog with a simple CMS so non-developers can write and publish posts, with SEO metadata and a sitemap. | website | sitemap.xml + OG tags; CMS edit→publish E2E |
| 05 | csv-dashboard | Create a dashboard where I upload a CSV of sales and see revenue per month and top products as charts. | app | CSV parse + 2 charts render with fixture CSV |
| 06 | landing-3d | Design an award-style landing page for "Nordlys", an electric bike brand, with a 3D hero and smooth scroll animations. | website | 3D hero pattern; visual QA >= 8; Lighthouse perf >= 85, a11y >= 90 |
| 07 | portfolio-scroll | Build a portfolio site for a Stockholm architect with scroll storytelling through five projects. | website | sticky scroll storytelling pattern; visual QA >= 8; Lighthouse thresholds |
| 08 | expo-habits | Build an Expo mobile app for tracking daily habits with streaks and local notifications. | mobile | Expo project typechecks; unit tests pass; QR preview URL produced |
| 09 | fastapi-service | Create a FastAPI service with CRUD endpoints for inventory items, input validation and OpenAPI docs. | backend | pytest passes; validation rejects bad input |
| 10 | image-set | Generate a set of 4 product images for a minimalist Scandinavian coffee brand in a consistent style. | image | 4 images stored; consistent style tokens; moderation passed |
| 11 | gen-video | Generate a 10-second cinematic video of fog rolling over a Swedish lake at dawn. | video | 10s video artifact; cost estimate shown first |
| 12 | remotion-video | Make a 20-second product video for my booking app using its screenshots and our brand colors. | video | Remotion render produces mp4 with brand tokens |
| 13 | deck-10 | Create a 10-slide pitch deck for a startup that sells AI bookkeeping to small businesses. | slides | 10 slides; PPTX + PDF export; speaker notes |
| 14 | report-doc | Write a market analysis report on the Nordic e-bike market as a document I can download. | document | DOCX + PDF export with headings and tables (charts only from supplied data — Forge never invents figures) |
| 15 | agent-weekly-email | Every Monday at 8, summarize new HubSpot leads from the past week and email the sales team. | agent, integration | cron trigger; approval before send; run log + cost |
| 16 | agent-slack | Create a Slack agent that answers questions about our company handbook in #help. | agent | Slack channel deploy; answers from handbook fixture |
| 17 | openapi-app | Build an app that shows current weather for a city using this API: evals/fixtures/weather-openapi.json | app, integration | OpenAPI import → typed client; app calls it |
| 18 | connector-app | Build an internal tool that lists our HubSpot contacts and lets us add notes, using the HubSpot integration. | app, integration | connector action executes via provider; scopes shown |
| 19 | meeting-build | (Recorded Swedish meeting: evals/fixtures/meetings/salong-mote.sv.txt) Build what we discussed in the meeting. | app | transcript→requirements→spec approved→build passes |
| 20 | voice-build | (Voice prompt: evals/fixtures/voice/todo-sv.wav) "Bygg en att-göra-app där jag kan lägga till och bocka av uppgifter." | app | STT transcript → build passes |
