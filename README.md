# GoldCoast AI Plugins

AI plugins for GoldCoast Search Group, served over one vendor-neutral **MCP server**, so the same tools work in Claude, ChatGPT and any other MCP-capable AI app. Same design as the HAR and J.L. Thomas plugin servers.

## Plugins
| Plugin | Tools | What it does |
|---|---|---|
| `ping` | `ping_whoami` | Connection check |
| `resume-builder` | `resume_open_builder`, `resume_get_branding`, `resume_list_uploads`, `resume_read_upload`, `resume_generate`, `resume_get_build`, `resume_list_builds` (+ dashboard-only `resume_dashboard_*`) | The Presentation Resume Builder from the old GoldCoast workspace: same workflow, rules, JSON schema, PDF/DOCX layout and client email. Works in chat and in the **Resume Builder dashboard** (MCP App). |
| `gmail` | `gmail_check_connection`, `gmail_create_draft`, `gmail_list_recent_emails`, `gmail_get_email`, `gmail_search_emails` | The old Gmail agent: drafts (with the presentation resume attached) in each recruiter's own Gmail, plus inbox read/search. **Drafts only — never sends.** |

The server never calls a model. The user's own Claude reads the resume and writes the structured JSON; the server renders the branded PDF/DOCX, keeps the build and saves Gmail drafts.

## Resume Builder
- **Letterhead:** the consultant email, phone and website (top-right of every page) are entered per resume — Claude asks in chat, the dashboard has fields — and the ones a recruiter used before are offered back, so they're typed once.
- **In chat:** attach a resume and say "build a presentation resume". Claude follows the original five-step intake (letterhead → position → compensation → nickname/references/notes), then returns PDF/DOCX download links, the content review and the draft client email, and offers a Gmail draft.
- **Dashboard:** "open the resume builder". Drop the resume, fill the intake, press **Build with Claude** (it posts the request into the chat), and the finished build opens with an editable page preview, client email → **Create Gmail draft**, content review, layout controls and **Ask Claude** for revisions.
- Files: `src/plugins/resume-builder/` — `prompts.ts` (playbook ported from `prompts.py`), `pdf.ts` / `docx.ts` (ports of the ReportLab and python-docx generators), `schema.ts`, `store.ts`, `files.ts` (signed download links), `dashboard.ts`; UI in `ui/resume-builder/`.

## Local development
```bash
cp .env.example .env   # AUTH_DISABLED=true for local only
npm install
npm run build          # compiles the server and the dashboard bundle
npm run dev            # http://localhost:8787/mcp
npm run sample         # renders a fictional candidate to samples/ (PDF + DOCX)
npm run smoke          # end-to-end MCP check against the running server
npm run harness        # http://localhost:5199 — the dashboard in a local MCP Apps host
npm test
```

## Sign-in
1. **Google sign-in (recommended).** The AI app signs each recruiter in with their GoldCoast Google account; only `ALLOWED_EMAIL_DOMAINS` / `ALLOWED_EMAILS` get in. The same sign-in grants Gmail compose + read, so drafts go to the recruiter's own Gmail with no extra step. Stateless: every token is sealed with `OAUTH_SECRET`; nothing is stored.
2. **Shared access key (fallback).** When Google sign-in is off (`GOOGLE_SIGN_IN=false` or no Google client), `/mcp/<MCP_ACCESS_KEY>` works, and Gmail uses a one-time "Connect Gmail" link (held in memory; reconnect after deploys).

### Google Cloud setup (once, in GoldCoast's Google Workspace)
1. console.cloud.google.com → new project "GoldCoast AI Plugins" → **APIs & Services → Library → enable Gmail API**.
2. **OAuth consent screen:** User type **Internal**; app name "GoldCoast AI Plugins"; scopes `openid`, `email`, `profile`, `gmail.compose`, `gmail.readonly`. (Internal apps need no Google verification.)
3. **Credentials → Create OAuth client ID → Web application.** Authorized redirect URIs: `https://<service>/oauth/callback` and `https://<service>/gmail/callback`. Copy the client ID and secret into Render.

## Connecting AI apps
- **Claude:** Settings → Connectors → Add custom connector → `https://<service>/mcp` → Connect → sign in with Google. (Access-key mode: `https://<service>/mcp/<key>`.)
- **ChatGPT (Business/Enterprise):** an admin adds a custom connector with the same URL.

## Deploying (Render)
`render.yaml` is a Render Blueprint: one always-on Starter web service, `/healthz` health check, and a 1 GB disk at `/var/data` for saved builds. Keep it to one instance. Secrets are set in the Render dashboard. A `Dockerfile` is included for other hosts.
