# LessRepeat Admin Console

## Entry points

- `/admin`: platform administrators manage clients, templates, plans and audit history.
- `/app`: each business manages its own workspace. Platform users go to Admin Console by default; **Open my workspace** switches to their own business tools.
- `/invite#...`: one-time account activation. The token is removed from the address bar after opening.
- `/`: public marketing website. Public signup is disabled unless `ALLOW_PUBLIC_SIGNUP=true` is explicitly configured.

These are separate interfaces within the same Node service, not separate physical deployments. Server-side authorization enforces separation; changing the URL cannot grant admin access.

## Add a client

1. Sign in at `/admin` with your existing platform administrator account.
2. Choose **Clients > Add client**. Required: business name, owner name, owner email, plan.
3. Optionally add a phone, industry, and recommended starting preset.
4. Copy the private invitation and share it directly. **No email is sent.**
5. The owner opens the link, chooses a password of 12–256 characters, and signs in at `/app`.
6. From the client's **Manage** panel, optionally create their first agent from a preset. This publishes a real Dograh workflow but does not start a call.

Invitations expire after seven days. Generating a new invitation revokes the previous pending link for that user. Only a hash is stored; consumed invitations cannot be reused, including concurrent submissions. Do not put invitations in public screenshots, tickets or logs. Localhost invitations work only on this computer; share links from your deployed HTTPS domain for remote clients.

## Roles and client lifecycle

| Role | Access |
| --- | --- |
| Platform admin / super admin | Admin Console and platform-wide client, template, plan and audit operations |
| Client owner | Own business configuration, agents, knowledge, automation, demo links, usage, and team visibility |
| Client staff (`member`) | Own business call review, contacts/leads, support and browser testing; cannot edit agents, business configuration or place paid outbound calls |

Admin-created team invitations can grant owner or staff access only, not platform administration. Impersonated sessions cannot access the Admin Console.

Suspending or archiving a workspace revokes its dashboard sessions and blocks new LessRepeat voice sessions and public demo access. Records are preserved. It does not hang up ongoing calls or revoke access someone independently has to Dograh/carrier infrastructure. Reactivation restores access subject to the assigned plan. An administrator cannot suspend their own workspace.

## Preset library

Create or edit business instructions, industry, greeting, primary language, voice defaults, guardrails, and up to 20 typed information fields. Presets can be active, draft, or archived. Active public presets are available to all clients; private presets are available only to selected workspaces. Draft/archived presets cannot create new agents.

Each agent receives an independent copy. Updating a preset does not silently overwrite existing agents. Version checks reject stale preset and plan edits. The optional starter preset is a recommendation; it does not automatically provision a workflow during client signup.

## Plans and usage

The initial **Trial** and **Studio** plans are editable starting allocations, not published pricing promises. Their prices are marked unconfigured until saved. Plans define monthly price in INR, included minutes, maximum agents, concurrent calls and trial duration.

- Plan assignments are snapshots. Catalog edits apply only when explicitly assigned to a client.
- Assigning a trial starts a new trial period. Trial expiry blocks new calls.
- Agent provisioning and voice-session admission reserve capacity transactionally, including parallel requests.
- Calls are synchronized from Dograh run history. Usage periods follow UTC calendar months and aggregate recorded seconds, not carrier billing increments.
- Monthly minute limits block **new** calls once recorded usage reaches the allowance; ongoing calls may exceed it. This is not a prepaid hard-stop billing system.
- Public demos and dashboard call starts share a workspace's concurrency allowance.
- Completed run synchronization releases call slots. Browser call end, navigation and connection failure also release their own slot using a secret per-call token. A call that never connects expires after two minutes; the UI stops a stalled connection after 45 seconds. Connected demos are bounded by their duration plus 30 seconds; Talk to it has a one-hour recovery limit. Phone reservations retain their existing upstream-run tracking. Legacy demo reservations are capped at their demo duration plus two minutes of connection grace.
- Carrier dial responses without a run ID cannot provide a durable tracked call slot. Direct Dograh/carrier inbound calls bypass dashboard admission. Configure corresponding upstream limits before selling guaranteed concurrency.
- Plan prices do not create invoices, charge cards or renew subscriptions automatically. Existing PayU/wallet flows remain separate.
- Provider configuration status is not a live audio-quality guarantee.

## PostgreSQL and migration

Set `LESSREPEAT_DATABASE_URL` in the ignored `.env` file. Start PostgreSQL before starting the dashboard. For the local stack:

```powershell
Set-Location C:\Kowsik\dograh\dograh
docker compose up -d
Set-Location C:\Kowsik\LessRepeat_Cloud\dashboard
npm install
npm start
```

The server creates `lessrepeat.collections`, separate from Dograh's tables. Each top-level dashboard collection is a JSONB row. Updates use transactions and an advisory lock, preserving IDs, hashed passwords, session hashes, encrypted demo links and existing business data. This migration does not normalize every collection into relational tables. MinIO continues to hold recordings; recordings are not moved into these JSONB rows.

The first start imports `data/db.json` only if the PostgreSQL collection table is empty. Later restarts use PostgreSQL, not the old JSON file. Unreadable existing JSON fails closed instead of silently wiping data. A configured but unavailable database also fails closed; the server does not silently switch to stale JSON.

Before migration, stop the dashboard and make an ignored backup of `data/db.json`. Keep `.env`, the stable demo-link encryption key, PostgreSQL backups, and MinIO backups private. Back up the `lessrepeat` schema with PostgreSQL's `pg_dump`, alongside your existing Dograh/MinIO backup policy. A database restore should be tested in an isolated environment first.

Do not disable `LESSREPEAT_DATABASE_URL` as a recovery shortcut: that would reopen the old pre-migration JSON snapshot and lose visibility of subsequent changes. Export current collections or restore a database backup deliberately. Full database backup scheduling and automatic recovery are not included.

## Verification

```powershell
npm test
npm run build
# Optional real PostgreSQL storage test (Node with --env-file support):
$env:TEST_POSTGRES='1'
node --env-file=.env --test test/postgres-store.test.js
Remove-Item Env:TEST_POSTGRES
```

API tests cover onboarding, duplicate emails, invitation replacement/reuse, client/private-preset isolation, copied templates, plan version conflicts, concurrent agent/call starts, multi-page call metering, demo start refunds, team restrictions and suspension. The real PostgreSQL test uses a uniquely named test schema, verifies concurrent writers and rollback, then drops only that test schema. Voice-provider calls are mocked in automated tests; no paid carrier calls are placed.

For production, add tested backups, HTTPS, monitoring, a dedicated least-privilege PostgreSQL role, distributed rate limiting, upstream admission controls, and verified email/payment/telephony delivery before representing those as live capabilities.
