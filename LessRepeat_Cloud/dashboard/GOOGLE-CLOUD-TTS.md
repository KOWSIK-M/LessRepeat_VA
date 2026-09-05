# Google Cloud Hindi TTS setup

LessRepeat supports all four Google Cloud Hindi Neural2 voices in Voice Studio, agent creation and editing, and browser previews:

- `hi-IN-Neural2-A`, female
- `hi-IN-Neural2-B`, male
- `hi-IN-Neural2-C`, male
- `hi-IN-Neural2-D`, female

Google does not support Neural2 on its bidirectional streaming synthesis API. Dograh live agents and public demos therefore use a matched Hindi Chirp 3 HD voice automatically:

- Neural2 A uses `hi-IN-Chirp3-HD-Aoede`
- Neural2 B uses `hi-IN-Chirp3-HD-Charon`
- Neural2 C uses `hi-IN-Chirp3-HD-Fenrir`
- Neural2 D uses `hi-IN-Chirp3-HD-Kore`

This keeps the selected gender and gives live calls Google-supported low-latency streaming audio instead of a silent Neural2 failure.

The recommended configuration is keyless Application Default Credentials (ADC). A Gemini API key is not a Cloud TTS credential, and the organization policy `iam.disableServiceAccountKeyCreation` should remain enabled.

## Local Windows setup, no service-account key

### 1. Install and authenticate gcloud

Install Google Cloud CLI, open a new PowerShell window, and run:

```powershell
gcloud init
gcloud config set project YOUR_PROJECT_ID
gcloud services enable texttospeech.googleapis.com
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

Billing must be enabled for the project. Your Google user needs permission to consume services in that project. If the quota-project command reports `serviceusage.services.use`, ask the administrator to grant your user `roles/serviceusage.serviceUsageConsumer`.

On Windows, gcloud normally creates this ADC file:

```text
%APPDATA%\gcloud\application_default_credentials.json
```

This is an OAuth refresh credential. Treat it as a secret, never commit it, and never paste it into the browser UI.

### 2. Enable ADC in LessRepeat

Add this setting to `LessRepeat_Cloud/dashboard/.env`:

```dotenv
GOOGLE_CLOUD_TTS_USE_ADC=true
```

The Node dashboard automatically discovers your local gcloud ADC file.

### 3. Mount ADC into the Dograh API container

In the PowerShell window used to start Dograh:

```powershell
$env:GOOGLE_ADC_HOST_PATH = Join-Path $env:APPDATA 'gcloud\application_default_credentials.json'
docker compose -f docker-compose.yaml -f docker-compose.google-adc.yaml --profile tunnel up -d
```

Use the same extra `-f docker-compose.google-adc.yaml` argument with your normal Dograh Compose command. The overlay mounts the credential read-only into the API container and sets `GOOGLE_APPLICATION_CREDENTIALS` inside that container.

The repository's `scripts/start_docker.ps1` also detects the standard Windows ADC file automatically and applies this overlay.

Restart the LessRepeat Node server after changing `.env`.

## Use the voice

1. Open Voice Studio and select **Google Hindi Neural2**.
2. Keep **Aditi, natural Hindi woman** selected.
3. Synthesize a short Hindi sentence.
4. Create a new agent, or edit an agent that belongs to the Dograh organization selected by the current `DOGRAH_API_KEY`.
5. Select **Google Hindi Neural2** and save. Saving republishes that agent's Dograh workflow.
6. Test Talk to it, then create or reopen its Demo link.

Existing agents are not changed automatically. If a Dograh API key was replaced with a key from another Dograh organization, old workflows remain owned by the previous organization and cannot be updated using the new key. Create the agent again under the new organization or perform an explicit workflow migration.

## Production authentication

- On Google Cloud, attach a least-privilege service account to the compute resource and let ADC obtain short-lived credentials automatically.
- Outside Google Cloud, use Workload Identity Federation and mount its external-account credential configuration through `GOOGLE_ADC_HOST_PATH`.
- Do not disable the organization policy merely to download a long-lived service-account private key.

Neural2 uses file-style synthesis rather than bidirectional streaming. LessRepeat uses it for previews and switches to matched Chirp 3 HD for real-time calls.
