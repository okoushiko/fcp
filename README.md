# FCP: Phase 1 interest site

A one-page site where Bay Area students sign up to show interest in free compute.
Signups go to the **FCP Interest Signups** Google Sheet through a Google Apps Script backend.

## Setup (about 15 minutes, one time)

### 1. Get Turnstile keys (the bot check)
1. Go to dash.cloudflare.com, then Turnstile, then Add widget.
2. Hostname: `okoushiko.github.io` (add your custom domain later if you get one).
3. Widget mode: Managed.
4. Copy the **site key** and the **secret key**.

### 2. Add the script to the sheet
1. Open the FCP Interest Signups sheet, then Extensions, then Apps Script.
2. Delete what's there and paste in `apps-script/Code.gs`.
3. Project Settings (gear icon), then Script properties, add:
   - `TURNSTILE_SECRET` = your Turnstile secret key
   - `ALLOWED_HOSTNAME` = `okoushiko.github.io`
   - `FORM_OPEN` = `true`
4. Back in the editor, pick `setup` in the function dropdown and click Run. Approve the permissions.

### 3. Deploy it
1. Deploy, then New deployment, type Web app.
2. Execute as: **Me**. Who has access: **Anyone**.
3. Copy the web app URL (ends in `/exec`).

### 4. Connect the site
In `index.html`, replace:
- `APPS_SCRIPT_URL` with the web app URL
- `TURNSTILE_SITE_KEY` with the Turnstile site key (the public one, never the secret)

Commit and push. GitHub Pages updates in a minute or two.

## How it's protected
| Attack | Defense |
|---|---|
| Bot scripts hitting the endpoint directly | Cloudflare Turnstile token checked server-side; tokens are single-use, so a copied request can't be replayed |
| Token farmed on another site | Turnstile hostname must match `ALLOWED_HOSTNAME` |
| Dumb form-filling bots | Hidden honeypot field and a minimum fill time; bots get a fake success and nothing is written |
| Flooding the sheet | Max 30 signups per 10 minutes and 300 per day across the whole site |
| Same person signing up repeatedly | One signup per email |
| Huge payloads | 5 KB request cap and per-field length limits; dropdown values must match exactly |
| Formula injection (`=IMPORTXML(...)` in a field) | Any cell starting with `= + - @` is stored as plain text |
| Reading your data | The endpoint has no read access through the web; the sheet stays private |
| Something goes wrong | Set `FORM_OPEN` to `false` in Script properties to stop all writes instantly |

Every secret lives in Script properties. Nothing secret is in this repo.

## Updating the script later
After editing `Code.gs`: Deploy, then Manage deployments, edit the existing deployment, Version: New version.
This keeps the same `/exec` URL so the site doesn't need changing.
