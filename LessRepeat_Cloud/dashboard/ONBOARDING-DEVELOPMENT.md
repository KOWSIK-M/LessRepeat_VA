# Business signup and onboarding

The onboarding feature is integrated into `main` at `C:\Kowsik`. The main service runs on port 8787 with its existing database, session cookies and Dograh configuration. Existing businesses retain their dashboard and are not sent through setup again. Preview accounts in the separate worktree are not imported.

## Main service

Keep the existing database and provider configuration in the ignored `.env` and enable:

```dotenv
ALLOW_PUBLIC_SIGNUP=true
ENABLE_SELF_SERVE_ONBOARDING=true
ONBOARDING_SANDBOX=false
PORT=8787
```

Start with `npm start` from `C:\Kowsik\LessRepeat_Cloud\dashboard`. Open [business signup](http://localhost:8787/start.html) or [sign in](http://localhost:8787/app). New agents use the configured Dograh service; no call starts just by creating an agent. This remains a local/MVP rollout, not a public production launch: see the release requirements below.

## Optional isolated development preview

The separate `codex/business-onboarding` worktree remains available at `C:\Kowsik-onboarding`. Its 8788 service is stopped after the main rollout; start it only if isolated development is needed.

```powershell
Set-Location C:\Kowsik-onboarding\LessRepeat_Cloud\dashboard
npm ci
npm run dev:onboarding
```

Open [business signup](http://127.0.0.1:8788/start.html). Sign in at [the feature dashboard](http://127.0.0.1:8788/app).

`http://localhost:8788` also works in the local sandbox. Use the same hostname throughout signup and login: browsers keep localhost and 127.0.0.1 cookies separately. Only same-origin requests on this preview's port are accepted; other origins, forwarded-host overrides and the main app's port are not added to the allowlist. Production origin checks remain unchanged.

The launcher binds to loopback only, uses `data/onboarding-dev.json`, sets a separate `lessrepeat_onboarding_session` cookie and clears live service credentials in its own process. It does not copy the main `.env`, PostgreSQL data or existing clients. Closing this process does not stop the service on 8787. Do not run `npm start` with the main app's configuration inside this worktree.

## Implemented flow

1. Account: owner name, email, password. New accounts are business owners, never platform administrators. No paid credit is granted.
2. Business: name, industry and opening language. The selected trial plan is copied as a fixed snapshot.
3. Brief: describe the job or adapt one of six generic examples. No private client preset or knowledge is used.
4. Review: edit the generated name, greeting and instructions. Suggested capture fields can be customized in the agent editor afterwards.
5. Create: save the agent and open the dashboard or template library.

The draft builder is deterministic: it combines the user's brief with a business template and safety rules. It does not pretend to use a generative model and incurs no extra generation API cost. Saved steps and review drafts resume after login or a server restart. Unsaved edits on a form are not autosaved.

Creation is tenant-scoped, plan-limited and idempotent once completed. A short transactional reservation blocks concurrent submissions. Provisioned workflow IDs are checkpointed so ordinary publish/embed-token failures can reuse the workflow on retry. A provider timeout before a workflow ID is returned remains an uncertain external outcome requiring operator review; it cannot be made exactly-once without upstream idempotency support.

## Sandbox versus integrated staging

The local launcher deliberately creates **local draft agents**, with no Dograh connection. It does not make live calls or send emails. The UI marks this clearly. Normal authenticated business features remain available for reviewing/editing these drafts; voice testing is not connected.

For a separate integrated staging deployment, set `ENABLE_SELF_SERVE_ONBOARDING=true`, `ALLOW_PUBLIC_SIGNUP=true`, and `ONBOARDING_SANDBOX=false`, with staging-only storage, a different session cookie name and a separate Dograh organization/API key. Do not reuse the main runtime's DB, keys or workflows. The provider workflow/publish/embed path is covered by mocked integration tests; no staging credentials have been provisioned by this change.

## Before public release

Feature flags default off. Startup rejects self-serve mode under `NODE_ENV=production` while this feature is under development. Email verification, password recovery/email delivery, distributed abuse protection, verified-business/trial eligibility, operational monitoring and approved legal/privacy copy still need implementation and review. The preview is not an internet-facing production signup service. Existing administrator invitations and established workspaces keep their original flow.

## Verification

`npm test` includes signup races, duplicate emails, owner-only roles, separate cookies, tenant isolation, generic examples, resume after restart, provider-failure retry, repeated creation, sandbox no-network creation, and the existing suite. Tests use temporary data and mock voice endpoints, not customer records.

Before an internet-facing production release, complete the requirements above and verify the integrated signup flow with staging-only credentials.
