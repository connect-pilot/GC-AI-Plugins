/**
 * Public pages Google's OAuth consent screen links to (home page, privacy policy, terms).
 * Plain, factual descriptions of what this server does with data — see docs/data-flow.md.
 * Have them reviewed before relying on them as legal documents.
 */
import type { Express } from "express";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · GoldCoast AI Plugins</title>
<body style="font:16px/1.6 -apple-system,Segoe UI,Inter,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#17171a">
<p style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#8a6a1f;margin:0">GoldCoast Search Group</p>
<h1 style="font-weight:600;margin:6px 0 20px">${esc(title)}</h1>
${body}
<hr style="border:0;border-top:1px solid #e3e0d8;margin:40px 0 16px">
<p style="font-size:13px;color:#6b6a70"><a href="/">Home</a> · <a href="/privacy">Privacy policy</a> · <a href="/terms">Terms of service</a></p>
</body></html>`;
}

const HOME = page(
  "GoldCoast AI Plugins",
  `<p>GoldCoast AI Plugins are internal tools for GoldCoast Search Group recruiters, used inside AI assistants such as Claude through the Model Context Protocol (MCP).</p>
<ul>
<li><b>Resume Builder</b> — turns a candidate's resume into a GoldCoast-branded presentation resume (PDF and Word) with a draft client email.</li>
<li><b>Gmail</b> — saves that email as a draft in the recruiter's own Gmail, with the resume attached, and lets the recruiter read and search their inbox. It never sends email.</li>
</ul>
<p>Access is limited to GoldCoast Search Group and Connect Pilot Google accounts.</p>`,
);

const PRIVACY = page(
  "Privacy policy",
  `<p>This policy covers the GoldCoast AI Plugins service (this website and its MCP endpoint), operated for GoldCoast Search Group.</p>
<h2>Who can use it</h2>
<p>Only people signed in with a Google account from an allowed organization (gcsearchgroup.com, connectpilot.ai). Everyone else is refused at sign-in.</p>
<h2>Google account data we access</h2>
<ul>
<li><b>Basic profile</b> (name, email address) — to identify who is signed in and check they are allowed.</li>
<li><b>Gmail, compose</b> (<code>gmail.compose</code>) — to create drafts in your own mailbox when you ask, for example a client email with a presentation resume attached. The service never sends email.</li>
<li><b>Gmail, read</b> (<code>gmail.readonly</code>) — to list, read and search your messages when you ask the assistant to.</li>
</ul>
<p>Gmail content is fetched only when you ask, passed to your AI assistant for that request, and not stored by this service. Google access is used only to provide these features. The use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Google data is not sold, used for advertising, or used to train AI models.</p>
<h2>What we store</h2>
<ul>
<li><b>Sign-in tokens</b> are encrypted and held by your AI app, not stored on our server.</li>
<li><b>Uploaded resumes</b> are read in memory and dropped after at most 2 hours; original files are never written to disk.</li>
<li><b>Presentation resumes you build</b> (the structured resume, letterhead details, intake answers and client email draft) are saved so you can reopen, edit and download them. Only the recruiter who built one can see it. They are deleted automatically after 180 days, or when you delete them.</li>
<li><b>Server logs</b> record metadata only (who, which tool, when, success or failure) — never resume content, email content or tool inputs and outputs.</li>
</ul>
<h2>Service providers</h2>
<p>Render (hosting) and Google (sign-in and Gmail). Your conversations stay with your AI assistant provider under its own terms.</p>
<h2>Your choices</h2>
<p>You can delete presentation resumes in the Resume Builder at any time, and revoke this app's Google access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. For questions or deletion requests, contact your GoldCoast Search Group administrator.</p>`,
);

const TERMS = page(
  "Terms of service",
  `<p>GoldCoast AI Plugins are provided for internal business use by GoldCoast Search Group staff and its technology partner Connect Pilot. By signing in you agree to these terms.</p>
<ul>
<li>Use the service only for GoldCoast Search Group recruiting work, and only with candidate information you are permitted to handle.</li>
<li>Review every presentation resume and email draft before sharing it. The service creates drafts only; you are responsible for what you send.</li>
<li>Don't attempt to access other users' data, bypass sign-in, or overload the service.</li>
<li>The service is provided as is. Access may be changed or withdrawn at any time, for example when you leave the organization.</li>
</ul>
<p>See the <a href="/privacy">privacy policy</a> for how data is handled. Questions: contact your GoldCoast Search Group administrator.</p>`,
);

export function publicPages(app: Express) {
  const send = (html: string) => (_req: unknown, res: { type(t: string): { send(b: string): void } }) => res.type("html").send(html);
  app.get("/", send(HOME));
  app.get("/privacy", send(PRIVACY));
  app.get("/terms", send(TERMS));
}
