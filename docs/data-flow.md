# Data flow — GoldCoast AI Plugins

| Item | Where it lives |
|---|---|
| Conversations | Inside the AI app (Claude / ChatGPT), under GoldCoast's agreement with that vendor. |
| Resumes uploaded in the dashboard | Text extracted in memory and held for 2 hours so Claude can read it, then dropped. The original file is never written to disk. |
| Resumes attached in chat | Read by Claude in the chat; never sent to this server. |
| Presentation-resume builds | The structured resume, letterhead email, intake answers (compensation, references, candidate contact for the client email), client email draft and content review. Saved as one JSON file per build on the Render disk (`RESUME_DATA_DIR`), visible only to the recruiter who made it, deleted after `RESUME_RETENTION_DAYS` (default 180). PDF/DOCX files are rendered on request, not stored. |
| Download links | Sealed, expiring (30-day) links naming one build; anyone holding a link can download that file. Deleting the build kills its links. |
| Gmail | Drafts saved in the recruiter's own Gmail through Google's API with their own sign-in. Nothing is sent. Google tokens travel sealed inside the AI app's tokens; only short-lived access tokens are cached in memory. |
| Server logs | Metadata only: user email, tool name, status, timing. No resume content, arguments or results. |

## Subprocessors
- **Render**: hosting
- **Google**: sign-in and Gmail (GoldCoast's own Workspace)
