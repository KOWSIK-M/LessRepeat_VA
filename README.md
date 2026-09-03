# LessRepeat Voice Automation

LessRepeat is a self-hosted AI voice automation platform for Indian businesses. It combines a multi-tenant SaaS dashboard with Dograh's realtime voice workflow engine, browser calling, telephony integration, call recordings, transcripts, lead capture, knowledge bases, and business-specific agent workflows.

The current MVP is optimized for reliable local demonstrations. Dograh's default voice pipeline is used for live calls, while experimental local and Telugu voices remain available for controlled previews.

## Repository layout

```text
Kowsik/
|-- LessRepeat_Cloud/
|   |-- dashboard/          LessRepeat web application and Node API
|   |-- prompts/            Voice-agent prompt references
|   `-- workflows/          Example workflow definitions
`-- dograh/
    `-- dograh/             Vendored Dograh voice orchestration platform
```

This is a monorepo. The application and the Dograh source are committed as normal directories so a clone contains everything required to inspect and run the project.

## Main capabilities

- Create and manage business-specific AI voice agents.
- Test agents through browser WebRTC calls.
- Configure Indian English voices and preview Telugu speech.
- Upload knowledge documents and publish approved context to agents.
- Review call history, recordings, transcripts, and captured outcomes.
- Track contacts, leads, appointment requests, and follow-up activity.
- Configure workspace-wide operating rules and AI boundaries.
- Connect telephony through Dograh and VoBiz.
- Isolate workspaces with authenticated, tenant-scoped access.
- Onboard clients through a separate Admin Console with private invitations,
  reusable presets, plan limits, team roles, suspension, and audit history.

## Prerequisites

- Windows 10/11, Linux, or macOS
- Docker Desktop with Docker Compose
- Node.js 18 or newer
- Provider credentials for the services enabled in your environment

## Configuration

Create local environment files from the committed templates. Never commit the generated `.env` files.

```powershell
Copy-Item LessRepeat_Cloud\.env.example LessRepeat_Cloud\.env
Copy-Item LessRepeat_Cloud\dashboard\.env.example LessRepeat_Cloud\dashboard\.env
```

At minimum, review the Dograh, Deepgram, Groq, Rumik, Gemini, telephony, and demo-link settings documented in `LessRepeat_Cloud/dashboard/.env.example`.

## Start the complete local stack

Start Dograh and its PostgreSQL, Redis, MinIO, UI, API, and optional Kokoro services:

```powershell
Set-Location C:\Kowsik\dograh\dograh
docker compose up -d
docker compose ps
```

Install and start the LessRepeat dashboard:

```powershell
Set-Location C:\Kowsik\LessRepeat_Cloud\dashboard
npm install
npm run build
npm test
npm start
```

Open:

- LessRepeat dashboard: `http://127.0.0.1:8787/app.html`
- LessRepeat Admin Console: `http://127.0.0.1:8787/admin`
- LessRepeat landing page: `http://127.0.0.1:8787/`
- Dograh UI: `http://127.0.0.1:3010/`
- Dograh API health: `http://127.0.0.1:8000/api/v1/health`

## Useful operations

```powershell
# Follow Dograh logs
Set-Location C:\Kowsik\dograh\dograh
docker compose logs -f api ui kokoro-tts

# Stop the Docker services without deleting stored volumes
docker compose down

# Run the LessRepeat automated tests
Set-Location C:\Kowsik\LessRepeat_Cloud\dashboard
npm test
```

Avoid `docker compose down -v` unless you intentionally want to remove local PostgreSQL, Redis, and MinIO data.

## Security and data

- API keys and passwords belong only in ignored `.env` files.
- Dashboard runtime state under `data/` is ignored.
- Recordings and uploaded objects are not committed.
- PostgreSQL stores structured Dograh application and call data.
- With `LESSREPEAT_DATABASE_URL`, dashboard state also lives in PostgreSQL,
  in a separate `lessrepeat` schema. JSON is a single-process fallback.
- MinIO stores object data such as recordings and uploaded files.
- Live credentials are never intentionally sent to browser JavaScript.

Before production use, rotate any key that has previously appeared in chat, terminal output, screenshots, or Git history. Use separate development and production credentials.

See [Admin Console setup and operations](LessRepeat_Cloud/dashboard/ADMIN-CONSOLE.md)
for client invitations, roles, plan enforcement, storage migration, and backups.

## Current MVP boundary

The repository is suitable for local development and client demonstrations. Production rollout still requires deployment hardening, backups, transactional billing verification, monitoring, provider quota planning, privacy policies, and end-to-end telephony testing with the intended carrier.

## License

LessRepeat application code is provided under the license in `LessRepeat_Cloud/LICENSE`. The vendored Dograh directory retains its upstream license and attribution.
