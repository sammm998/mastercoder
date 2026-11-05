# 0004 — Platform authentication

**Decision:** The Forge platform (apps/api) uses its own small auth module: scrypt password hashes,
opaque session tokens (SHA-256 hashed at rest, httpOnly cookie or Bearer), magic links, and OIDC
authorization-code + PKCE for Google and Microsoft. Generated apps use Better Auth via `@forge/app-kit`.

**Why:** Platform auth must integrate with workspaces/RBAC, the WebSocket gateway, audit log and GDPR deletion,
and be SSO-ready (`workspaces.sso_domain`; SAML/OIDC per-tenant providers plug into `OAuthService`). Keeping
it to ~300 lines of audited code avoids coupling the platform to a framework's schema. Rate limits: 10/min per IP
on credential endpoints, configurable per-user/per-IP limits on everything else (Redis fixed window).
