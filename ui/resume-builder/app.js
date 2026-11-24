// GoldCoast Resume Builder dashboard. Three views:
//   new      — the intake (the original agent's five steps) → "Build with Claude" posts the request to the chat
//   library  — every presentation resume this recruiter has built
//   build    — an editable page preview + side panel (client email → Gmail draft, content review, layout, ask Claude)
// Claude does the reading and writing in the chat; this page never calls a model.
import { call, download, LOGO, onToolResult, openLink, sendToChat, setLauncherCard } from "./bridge.js";

const SECTION_LABELS = { summary: "Professional summary", skills: "Skills", certifications: "Certifications", work: "Work history", projects: "Projects completed", education: "Education" };
const ALL_SECTIONS = ["summary", "skills", "certifications", "work", "projects", "education"];
const POLL_MS = 4000;
const POLL_LIMIT_MS = 10 * 60_000;

const S = {
  view: "new",
  data: null,
  intake: blankIntake(),
  pending: null, // { upload_id, sentAt, message, sent }
  build: null,
  draft: null, // editable copy of build.resume
  dirty: false,
  tab: "email",
  email: null, // { to, cc, subject, body, pdf, docx }
  emailResult: null,
  revision: null, // { fromVersion, sentAt, message, sent }
  search: "",
  busy: {},
};

function blankIntake() {
  return { upload: null, uploading: false, error: null, consultant: "", phone: "", website: "", position: "", comp_recent: "", comp_requested: "", nickname: "", references: "", notes: "" };
}

// ---------------------------------------------------------------------------
// Tiny DOM helpers
// ---------------------------------------------------------------------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = Boolean(v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);

function toast(text, bad = false) {
  const t = h("div", { class: `t${bad ? " bad" : ""}` }, text);
  $("#toast").append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3200);
}

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadData() {
  const r = await call("resume_dashboard_data");
  if (r.status !== "success") {
    toast(r.message, true);
    return;
  }
  S.data = r;
  // Prefill the letterhead with what this recruiter used last (or their own email).
  const lh = r.letterhead ?? { emails: [], phones: [], websites: [], last: null };
  if (!S.intake.consultant) S.intake.consultant = lh.last?.email ?? lh.emails[0] ?? "";
  if (!S.intake.phone) S.intake.phone = lh.last?.phone ?? "";
  if (!S.intake.website) S.intake.website = lh.last?.website ?? "";
  renderHeader();
}

async function openBuild(id, { quiet = false } = {}) {
  if (S.dirty && S.build && S.build.id !== id && !quiet) {
    toast("Save or discard your edits first.", true);
    return;
  }
  if (!quiet) {
    S.view = "build";
    renderMain(h("div", { class: "loading" }, h("span", { class: "spinner" }), "Opening the presentation resume…"));
  }
  const r = await call("resume_dashboard_build", { id });
  if (r.status !== "success") {
    toast(r.message, true);
    if (!quiet) go("library");
    return;
  }
  setBuild(r.build);
  S.view = "build";
  render();
}

function setBuild(b) {
  S.build = b;
  S.draft = clone(b.resume);
  S.lh = { ...b.summary.letterhead };
  S.dirty = false;
  S.email = emailFrom(b);
  S.emailResult = null;
  const name = b.resume.candidate_name;
  setLauncherCard({
    title: "Presentation resume ready",
    subtitle: `${name}${b.resume.position_applied ? ` — ${b.resume.position_applied}` : ""}`,
    actions: [
      { label: "PDF", onClick: () => downloadFile("pdf") },
      { label: "DOCX", onClick: () => downloadFile("docx") },
    ],
  });
}

/** The client email: Claude's draft, or the original template filled from the intake. */
function emailFrom(b) {
  const r = b.resume;
  const i = b.intake ?? {};
  const company = S.data?.branding.company_name ?? "GoldCoast Search Group";
  if (b.client_email) return { to: "", cc: "", subject: b.client_email.subject, body: b.client_email.body, pdf: true, docx: false };
  const lines = [];
  lines.push(`Location: ${i.candidate_location ?? ""}`, "", `Email: ${i.candidate_email ?? ""}`, `Phone: ${i.candidate_phone ?? ""}`, "");
  lines.push(`Compensation (recent): ${i.compensation_recent ?? ""}`, "", `Compensation (requested): ${i.compensation_requested ?? ""}`, "");
  if (i.internal_references?.length) lines.push("Internal References Provided:", "", ...i.internal_references, "");
  lines.push("Notes:", "", i.notes ? `- ${i.notes}` : "- ");
  return { to: "", cc: "", subject: [company, r.position_applied, r.candidate_name].filter(Boolean).join(" | "), body: lines.join("\n"), pdf: true, docx: false };
}

// ---------------------------------------------------------------------------
// Header + routing
// ---------------------------------------------------------------------------
function go(view) {
  if (S.view === "build" && view !== "build" && S.dirty) {
    toast("Save or discard your edits first.", true);
    return;
  }
  S.view = view;
  if (view === "library") loadData().then(render);
  render();
}

function renderHeader() {
  $("#logo").src = LOGO;
  const d = S.data;
  if (!d) return;
  $("#company").textContent = `Presentation resumes · ${d.branding.company_name}`;
  $("#count").textContent = d.builds.length ? String(d.builds.length) : "";
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.view === S.view);
  const g = d.gmail;
  const chip = !g.configured
    ? h("span", { class: "chip", title: "Gmail isn't set up on the server" }, h("span", { class: "dot" }), "Gmail off")
    : g.connected
      ? h("span", { class: "chip on", title: `Drafts go to ${g.email}` }, h("span", { class: "dot" }), `Gmail · ${g.email}`)
      : h("button", { class: "chip off", type: "button", onclick: () => connectGmail() }, h("span", { class: "dot" }), "Connect Gmail");
  $("#who").replaceChildren(h("span", {}, d.user.email), chip);
}

async function connectGmail() {
  const url = S.data?.gmail?.connect_url;
  if (!url) return;
  const opened = await openLink(url);
  if (!opened) {
    toast("Your chat app blocked the link. Ask Claude to “connect Gmail” instead.", true);
    return;
  }
  toast("Finish connecting in the browser tab, then come back here.");
  setTimeout(() => loadData(), 15000);
}

function renderMain(node) {
  $("#main").replaceChildren(node);
}

function render() {
  renderHeader();
  if (S.view === "library") renderMain(libraryView());
  else if (S.view === "build" && S.build) renderMain(buildView());
  else renderMain(newView());
}

// ---------------------------------------------------------------------------
// New resume (intake)
// ---------------------------------------------------------------------------
function newView() {
  if (S.pending) return h("div", { class: "new-grid" }, pendingCard(), sideCards());
  const I = S.intake;
  const lhs = S.data?.letterhead ?? { emails: [], phones: [], websites: [] };
  const emails = lhs.emails;
  const set = (k) => (e) => {
    I[k] = e.target.value;
    refreshSteps();
  };

  const fileInput = h("input", { type: "file", accept: ".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain", hidden: true, onchange: (e) => e.target.files[0] && upload(e.target.files[0]) });
  const drop = I.upload
    ? h(
        "div",
        { class: "file" },
        h("div", { class: "ic" }, I.upload.kind.toUpperCase()),
        h(
          "div",
          { class: "meta" },
          h("b", {}, I.upload.file_name),
          h("span", { class: "small muted" }, `${I.upload.pages} page${I.upload.pages === 1 ? "" : "s"} · ${I.upload.words.toLocaleString()} words${I.upload.candidate_guess ? ` · looks like ${I.upload.candidate_guess}` : ""}`),
          I.upload.scanned ? h("div", { class: "small", style: "color:var(--warn)" }, "Scanned PDF — Claude will read the page images.") : null,
        ),
        h("button", { class: "btn sm", type: "button", onclick: () => fileInput.click() }, "Replace"),
      )
    : h(
        "div",
        {
          class: "drop",
          role: "button",
          tabindex: 0,
          onclick: () => fileInput.click(),
          onkeydown: (e) => (e.key === "Enter" || e.key === " ") && fileInput.click(),
          ondragover: (e) => {
            e.preventDefault();
            e.currentTarget.classList.add("over");
          },
          ondragleave: (e) => e.currentTarget.classList.remove("over"),
          ondrop: (e) => {
            e.preventDefault();
            e.currentTarget.classList.remove("over");
            const f = e.dataTransfer.files[0];
            if (f) upload(f);
          },
        },
        I.uploading ? h("b", {}, h("span", { class: "spinner" }), " Reading the resume…") : [h("b", {}, "Drop the candidate's resume here"), h("span", { class: "small muted" }, `or click to choose · PDF, Word (.docx) or text · up to ${S.data?.max_upload_mb ?? 10} MB`)],
      );

  const emailInput = h("input", {
    class: "in",
    type: "email",
    id: "lh-email",
    placeholder: "consultant@goldcoastsearch.com",
    value: I.consultant,
    oninput: (e) => {
      I.consultant = e.target.value.trim();
      for (const p of document.querySelectorAll(".pill")) p.classList.toggle("on", p.dataset.email === I.consultant);
      refreshSteps();
    },
  });
  const letterhead = [
    emails.length
      ? h(
          "div",
          { class: "pills" },
          emails.map((e, i) =>
            h(
              "button",
              {
                type: "button",
                class: `pill${I.consultant === e ? " on" : ""}`,
                "data-email": e,
                onclick: () => {
                  I.consultant = e;
                  emailInput.value = e;
                  for (const p of document.querySelectorAll(".pill")) p.classList.toggle("on", p.dataset.email === e);
                  refreshSteps();
                },
              },
              h("span", { class: "num" }, `${i + 1}.`),
              e,
            ),
          ),
        )
      : null,
    h("label", { class: "field" }, h("span", {}, "Consultant email"), emailInput),
    h(
      "div",
      { class: "row2" },
      h("label", { class: "field" }, h("span", {}, "Phone"), h("input", { class: "in", type: "tel", list: "lh-phones", placeholder: "(555) 555-5555", value: I.phone, oninput: set("phone") }), h("datalist", { id: "lh-phones" }, lhs.phones.map((v) => h("option", { value: v })))),
      h("label", { class: "field" }, h("span", {}, "Website"), h("input", { class: "in", list: "lh-sites", placeholder: "www.goldcoastsearch.com", value: I.website, oninput: set("website") }), h("datalist", { id: "lh-sites" }, lhs.websites.map((v) => h("option", { value: v })))),
    ),
  ];

  const step = (n, key, title, hint, body) => h("div", { class: "step", "data-step": key }, h("div", { class: "n" }, n), h("div", { class: "body" }, h("h3", {}, title, hint ? h("small", {}, hint) : null), body));

  const card = h(
    "div",
    { class: "card intake" },
    h("div", { class: "intake-head" }, h("h2", {}, "New presentation resume"), h("p", {}, "Fill this in and Claude turns the resume into a branded GoldCoast presentation resume, a content review and a draft client email.")),
    step(1, "upload", "Candidate's resume", null, [drop, fileInput, I.error ? h("div", { class: "notice bad" }, I.error) : null]),
    step(2, "consultant", "Letterhead", "shown top-right on every page", letterhead),
    step(3, "position", "Position applied", "optional", h("input", { class: "in", placeholder: "Leave blank and Claude picks the best fit from the resume", value: I.position, oninput: set("position") })),
    step(
      4,
      "comp",
      "Compensation",
      null,
      h(
        "div",
        { class: "row2" },
        h("label", { class: "field" }, h("span", {}, "Recent / current"), h("input", { class: "in", placeholder: "e.g. $180k/yr salary + PD", value: I.comp_recent, oninput: set("comp_recent") })),
        h("label", { class: "field" }, h("span", {}, "Requested / target"), h("input", { class: "in", placeholder: "e.g. $130–140k/yr + PD and incentives", value: I.comp_requested, oninput: set("comp_requested") })),
      ),
    ),
    step(
      5,
      "details",
      "Final details",
      "all optional",
      [
        h(
          "div",
          { class: "row2" },
          h("label", { class: "field" }, h("span", {}, "Preferred nickname"), h("input", { class: "in", placeholder: "e.g. Jay", value: I.nickname, oninput: set("nickname") })),
          h("label", { class: "field" }, h("span", {}, "Internal references"), h("input", { class: "in", placeholder: "Names, comma-separated", value: I.references, oninput: set("references") })),
        ),
        h("label", { class: "field" }, h("span", {}, "Notes about the candidate"), h("textarea", { class: "in", rows: 3, placeholder: "Why they're looking, key highlights, travel/relocation… Leave blank and Claude writes the notes from the resume.", oninput: set("notes") }, I.notes)),
      ],
    ),
    h(
      "div",
      { class: "intake-foot" },
      h("div", { class: "hint", id: "build-hint" }),
      h("button", { class: "btn ghost", type: "button", onclick: () => ((S.intake = keepLetterhead()), render()) }, "Clear"),
      h("button", { class: "btn gold lg", type: "button", id: "build-btn", onclick: buildWithClaude }, "Build with Claude →"),
    ),
  );
  queueMicrotask(refreshSteps);
  return h("div", { class: "new-grid" }, card, sideCards());
}

/** A blank intake that keeps the letterhead (it rarely changes between resumes). */
function keepLetterhead() {
  const { consultant, phone, website } = S.intake;
  return { ...blankIntake(), consultant, phone, website };
}

function refreshSteps() {
  const I = S.intake;
  const done = { upload: Boolean(I.upload), consultant: Boolean(I.consultant), position: Boolean(I.position), comp: Boolean(I.comp_recent || I.comp_requested), details: Boolean(I.nickname || I.references || I.notes) };
  for (const el of document.querySelectorAll(".step")) el.classList.toggle("done", Boolean(done[el.dataset.step]));
  const btn = $("#build-btn");
  const hint = $("#build-hint");
  if (!btn) return;
  btn.disabled = !I.upload || !I.consultant || I.uploading;
  hint.textContent = !I.upload ? "Add the resume to start." : !I.consultant ? "Add the letterhead's consultant email." : "Claude reads the resume in your chat and builds it — about a minute.";
}

async function upload(file) {
  const I = S.intake;
  const maxMb = S.data?.max_upload_mb ?? 10;
  if (file.size > maxMb * 1024 * 1024) {
    I.error = `That file is larger than ${maxMb} MB.`;
    render();
    return;
  }
  I.uploading = true;
  I.error = null;
  render();
  try {
    const b64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const r = await call("resume_dashboard_upload", { file_name: file.name, data_base64: b64 });
    if (r.status !== "success") I.error = r.message;
    else I.upload = r;
  } catch {
    I.error = "The file couldn't be read. Try again, or attach it in the chat instead.";
  }
  I.uploading = false;
  render();
}

function intakeMessage() {
  const I = S.intake;
  const u = I.upload;
  const refs = I.references.split(",").map((s) => s.trim()).filter(Boolean);
  return [
    `[Resume Builder] Build a presentation resume from the uploaded resume “${u.file_name}” (upload_id ${u.upload_id}).`,
    `Letterhead — consultant email: ${I.consultant}`,
    `Letterhead — phone: ${I.phone.trim() || "(none)"}`,
    `Letterhead — website: ${I.website.trim() || "(none)"}`,
    `Position applied: ${I.position.trim() || "(blank — use the best fit from the candidate's most recent/senior titles)"}`,
    `Compensation (recent): ${I.comp_recent.trim() || "(not provided)"}`,
    `Compensation (requested): ${I.comp_requested.trim() || "(not provided)"}`,
    `Nickname: ${I.nickname.trim() || "none"}`,
    `Internal references: ${refs.length ? refs.join(", ") : "none"}`,
    `Notes: ${I.notes.trim() || "(blank — auto-generate from the resume)"}`,
    "",
    "Every intake answer is above, so skip the questions: call resume_get_branding, read the upload with resume_read_upload, then call resume_generate with the upload_id, consultant_email, letterhead_phone, letterhead_website, intake, client_email and content_review.",
  ].join("\n");
}

async function buildWithClaude() {
  const message = intakeMessage();
  const btn = $("#build-btn");
  if (btn) btn.disabled = true;
  const sent = await sendToChat(message);
  S.pending = { upload_id: S.intake.upload.upload_id, sentAt: Date.now(), message, sent };
  render();
  pollForBuild();
}

async function pollForBuild() {
  const p = S.pending;
  if (!p) return;
  if (Date.now() - p.sentAt > POLL_LIMIT_MS) {
    p.timedOut = true;
    if (S.view === "new") render();
    return;
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
  if (S.pending !== p) return;
  const r = await call("resume_dashboard_data");
  if (r.status === "success") {
    S.data = r;
    renderHeader();
    const b = r.builds.find((x) => x.upload_id === p.upload_id && Date.parse(x.created_at) >= p.sentAt - 60_000);
    if (b) {
      S.pending = null;
      S.intake = keepLetterhead();
      toast("Presentation resume ready");
      openBuild(b.id);
      return;
    }
  }
  pollForBuild();
}

function pendingCard() {
  const p = S.pending;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(p.message);
      toast("Copied — paste it into the chat");
    } catch {
      toast("Select the text and copy it", true);
    }
  };
  return h(
    "div",
    { class: "card building" },
    p.sent
      ? h("div", { class: "big" }, p.timedOut ? "Still waiting for Claude" : [h("span", { class: "spinner" }), "Claude is building the presentation resume…"])
      : h("div", { class: "big" }, "Paste this into the chat"),
    p.sent
      ? h("p", { class: "muted", style: "margin:0" }, p.timedOut ? "No build has come back yet. Check the chat — Claude may have a question — or send the request again." : "The request is in your chat. Claude reads the resume, writes the presentation version and the client email, and it opens here automatically.")
      : h("p", { class: "muted", style: "margin:0" }, "Your chat app didn't let the Resume Builder post the request, so copy it into the chat yourself. The result opens here when Claude is done."),
    h("pre", { class: "msg" }, p.message),
    h(
      "div",
      { style: "display:flex;gap:8px;flex-wrap:wrap" },
      h("button", { class: "btn", type: "button", onclick: copy }, "Copy request"),
      p.sent ? h("button", { class: "btn", type: "button", onclick: async () => ((p.sent = await sendToChat(p.message)), (p.sentAt = Date.now()), (p.timedOut = false), render(), pollForBuild()) }, "Send again") : null,
      h("button", { class: "btn ghost", type: "button", onclick: () => ((S.pending = null), render()) }, "Back to the form"),
    ),
  );
}

function sideCards() {
  const builds = S.data?.builds ?? [];
  return h(
    "div",
    { class: "side" },
    h(
      "div",
      { class: "card" },
      h("h4", {}, "How it works"),
      h(
        "ol",
        { class: "how" },
        h("li", {}, h("span", {}, h("b", {}, "Drop the resume"), " and answer the intake — the same five steps as before.")),
        h("li", {}, h("span", {}, h("b", {}, "Claude builds it"), " in your chat: contact info stripped, skills consolidated, bullets tightened, every job kept.")),
        h("li", {}, h("span", {}, h("b", {}, "Review and edit"), " right on the page preview, then download the PDF or DOCX.")),
        h("li", {}, h("span", {}, h("b", {}, "Create the Gmail draft"), " with the PDF attached — it lands in your Drafts for you to send.")),
      ),
      h("p", { class: "small muted", style: "margin:12px 0 0" }, "Prefer chat? Attach a resume in Claude and say “build a presentation resume”."),
    ),
    h(
      "div",
      { class: "card" },
      h("h4", {}, "Recent"),
      builds.length
        ? h(
            "div",
            { class: "list mini" },
            builds.slice(0, 6).map((b) =>
              h(
                "div",
                { class: "item", onclick: () => openBuild(b.id) },
                h("div", {}, h("div", { class: "name" }, b.candidate), h("div", { class: "pos" }, b.position ?? "—")),
                h("div", { class: "when" }, ago(b.updated_at)),
              ),
            ),
          )
        : h("p", { class: "small muted", style: "margin:0" }, "Your presentation resumes will appear here."),
      S.data && !S.data.persistent ? h("p", { class: "small faint", style: "margin:10px 0 0" }, "Resumes are kept until the server restarts (no storage disk configured).") : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
function libraryView() {
  const builds = (S.data?.builds ?? []).filter((b) => !S.search || `${b.candidate} ${b.position ?? ""} ${b.consultant_email}`.toLowerCase().includes(S.search.toLowerCase()));
  const confirmDelete = new Set();
  const list = h(
    "div",
    { class: "card list" },
    builds.length
      ? builds.map((b) =>
          h(
            "div",
            { class: "item", onclick: () => openBuild(b.id) },
            h("div", {}, h("div", { class: "name" }, b.candidate), h("div", { class: "pos" }, b.source_file ?? "")),
            h("div", { class: "pos" }, b.position ?? "—"),
            h("div", { class: "when" }, `${ago(b.updated_at)} · ${b.consultant_email}`),
            h(
              "div",
              { class: "acts", onclick: (e) => e.stopPropagation() },
              b.gmail_drafts ? h("span", { class: "badge", title: "Gmail drafts created" }, `✉ ${b.gmail_drafts}`) : null,
              h("button", { class: "btn sm", type: "button", onclick: () => downloadFile("pdf", b.id) }, "PDF"),
              h(
                "button",
                {
                  class: "btn sm ghost danger",
                  type: "button",
                  title: "Delete",
                  onclick: async (e) => {
                    if (!confirmDelete.has(b.id)) {
                      confirmDelete.add(b.id);
                      e.currentTarget.textContent = "Delete?";
                      return;
                    }
                    const r = await call("resume_dashboard_delete", { id: b.id });
                    if (r.status !== "success") return toast(r.message, true);
                    toast("Deleted");
                    await loadData();
                    render();
                  },
                },
                "✕",
              ),
            ),
          ),
        )
      : h("div", { class: "empty" }, S.search ? "No resumes match that search." : "No presentation resumes yet. Start one under New resume."),
  );
  return h(
    "div",
    {},
    h(
      "div",
      { class: "lib-head" },
      h("h2", {}, "Presentation resumes"),
      h("input", {
        class: "in",
        type: "search",
        placeholder: "Search candidate or position",
        value: S.search,
        oninput: (e) => {
          S.search = e.target.value;
          const pos = e.target.selectionStart;
          render();
          const el = document.querySelector(".lib-head input");
          el.focus();
          el.setSelectionRange(pos, pos);
        },
      }),
    ),
    list,
  );
}

// ---------------------------------------------------------------------------
// Build view
// ---------------------------------------------------------------------------
function markDirty() {
  if (!S.dirty) {
    S.dirty = true;
    renderSavebar();
  }
}

function renderSavebar() {
  document.querySelector(".savebar")?.remove();
  if (!S.dirty || S.view !== "build") return;
  document.body.append(
    h(
      "div",
      { class: "savebar" },
      h("span", {}, "Unsaved edits"),
      h("button", { class: "btn sm", type: "button", onclick: () => ((S.draft = clone(S.build.resume)), (S.lh = { ...S.build.summary.letterhead }), (S.dirty = false), render(), renderSavebar()) }, "Discard"),
      h("button", { class: "btn sm gold", type: "button", onclick: () => save() }, "Save changes"),
    ),
  );
}

async function save(extra = {}) {
  const r = await call("resume_dashboard_save", {
    id: S.build.id,
    version: S.build.version,
    resume_data: S.draft,
    consultant_email: S.lh.email,
    letterhead_phone: S.lh.phone,
    letterhead_website: S.lh.website,
    ...extra,
  });
  if (r.status !== "success") {
    toast(r.message, true);
    return false;
  }
  const email = S.email;
  setBuild(r.build);
  S.email = { ...S.email, ...email, subject: email.subject, body: email.body };
  render();
  renderSavebar();
  toast("Saved — the PDF and DOCX are updated");
  return true;
}

async function downloadFile(format, id = S.build?.id) {
  if (!id) return;
  if (S.dirty && id === S.build?.id && !(await save())) return;
  toast(`Preparing the ${format.toUpperCase()}…`);
  const r = await call("resume_dashboard_file", { id, format });
  if (r.status !== "success") return toast(r.message, true);
  const ok = await download(r);
  if (!ok) toast("Your chat app blocked the download. Ask Claude for the download link.", true);
}

function buildView() {
  const b = S.build;
  const r = S.draft;
  queueMicrotask(renderSavebar);
  return h(
    "div",
    {},
    h(
      "div",
      { class: "bar" },
      h("button", { class: "btn ghost", type: "button", onclick: () => go("library") }, "← All resumes"),
      h("div", { class: "title" }, h("h2", {}, r.candidate_name), h("p", {}, [r.position_applied, `Letterhead: ${b.consultant_email}`, `v${b.version} · updated ${ago(b.updated_at)}`].filter(Boolean).join("  ·  "))),
      h(
        "div",
        { class: "acts" },
        h("button", { class: "btn", type: "button", onclick: () => downloadFile("pdf") }, "↓ PDF"),
        h("button", { class: "btn", type: "button", onclick: () => downloadFile("docx") }, "↓ DOCX"),
        h("button", { class: "btn gold", type: "button", onclick: () => ((S.tab = "email"), render()) }, "✉ Gmail draft"),
      ),
    ),
    h(
      "div",
      { class: "build-grid" },
      h("div", {}, h("p", { class: "paper-hint" }, "Click any text on the page to edit it. Hover a list to add or remove items. Page breaks are set in the PDF."), h("div", { class: "paper-wrap" }, paper())),
      panel(),
    ),
  );
}

/** A contenteditable bound to one value. Enter ends single-line edits; paste is plain text. */
function editable(tag, value, set, { cls, ph, multiline = false } = {}) {
  return h(tag, {
    class: cls,
    contenteditable: "true",
    spellcheck: "true",
    "data-ph": ph ?? "",
    oninput: (e) => {
      set(e.currentTarget.innerText.replace(/ /g, " ").replace(multiline ? /\s+$/ : /\s+/g, multiline ? "" : " ").trim());
      markDirty();
    },
    onkeydown: (e) => {
      if (e.key === "Enter" && !multiline) {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
    onpaste: (e) => {
      e.preventDefault();
      document.execCommand("insertText", false, (e.clipboardData?.getData("text/plain") ?? "").replace(multiline ? /\r/g : /\s+/g, multiline ? "" : " "));
    },
  }, value ?? "");
}

function rerenderPaper() {
  const old = document.querySelector(".paper");
  if (old) old.replaceWith(paper());
}

/** A bullet list item with a remove button. */
function bulletItem(list, i, extraCls = "") {
  return h(
    "div",
    { class: `bl ${extraCls}` },
    editable("span", list[i], (v) => (list[i] = v), { ph: "New item" }),
    h("button", { class: "x", type: "button", title: "Remove", onclick: () => (list.splice(i, 1), markDirty(), rerenderPaper()) }, "✕"),
  );
}
const addBtn = (label, onclick) => h("button", { class: "add", type: "button", onclick: () => (onclick(), markDirty(), rerenderPaper(), focusLastEmpty()) }, `+ ${label}`);
function focusLastEmpty() {
  const els = [...document.querySelectorAll(".paper [contenteditable]")].filter((e) => !e.innerText.trim());
  els.at(-1)?.focus();
}

const certToText = (c) => (c.dates ? `${c.name} | ${c.dates}` : c.name);
const textToCert = (t) => {
  const i = t.indexOf(" | ");
  return i < 0 ? { name: t, dates: null } : { name: t.slice(0, i), dates: t.slice(i + 3) || null };
};

function paper() {
  const r = S.draft;
  const br = S.data?.branding ?? {};
  const sec = (title, ...kids) => h("div", { class: "sec" }, h("div", { class: "sh" }, title), ...kids);
  const combined = !r.separate_certifications && r.certifications.length > 0;

  const builders = {
    summary: () => sec(r.summary_header || "PROFESSIONAL SUMMARY", h("p", {}, editable("span", r.professional_summary, (v) => (r.professional_summary = v), { ph: "Professional summary", multiline: true }))),
    skills: () => {
      const certLine = combined
        ? h(
            "p",
            {},
            "Certifications: ",
            r.certifications.map((c, i) => [i ? " | " : "", editable("span", certToText(c), (v) => (r.certifications[i] = textToCert(v)), { ph: "Certification | dates" })]),
          )
        : null;
      return sec(
        combined ? "SKILLS & CERTIFICATIONS" : "SKILLS",
        h("div", { class: "grid2" }, r.skills.map((_, i) => bulletItem(r.skills, i))),
        addBtn("Add skill", () => r.skills.push("")),
        certLine,
      );
    },
    certifications: () => {
      if (!r.separate_certifications || !r.certifications.length) return null;
      const items = r.certifications.map((c, i) =>
        h(
          "div",
          { class: "bl" },
          editable("span", certToText(c), (v) => (r.certifications[i] = textToCert(v)), { ph: "Certification | dates" }),
          h("button", { class: "x", type: "button", title: "Remove", onclick: () => (r.certifications.splice(i, 1), markDirty(), rerenderPaper()) }, "✕"),
        ),
      );
      return sec("CERTIFICATIONS", r.certifications.length > 4 ? h("div", { class: "grid2" }, items) : h("div", { style: "padding-left:calc(6 * var(--pt))" }, items), addBtn("Add certification", () => r.certifications.push({ name: "", dates: null })));
    },
    work: () =>
      sec(
        r.work_header || "PROFESSIONAL EXPERIENCE",
        r.professional_history.map((co) =>
          h(
            "div",
            { class: "co" },
            co.roles.map((role, i) => {
              const date = h(
                "span",
                {},
                editable("span", role.start_date, (v) => (role.start_date = v), { ph: "Start" }),
                " to ",
                editable("span", role.end_date, (v) => (role.end_date = v), { ph: "End" }),
              );
              const title = h(
                "span",
                {},
                editable("span", role.title, (v) => (role.title = v), { ph: "Job title" }),
                role.title_suffix ? h("span", { class: "sfx" }, " | ", editable("span", role.title_suffix, (v) => (role.title_suffix = v || null))) : null,
              );
              return [
                i === 0 ? h("div", { class: "rowlr" }, editable("span", co.company, (v) => (co.company = v), { ph: "Company" }), date) : null,
                i === 0 ? h("div", { class: "ttl" }, title) : h("div", { class: "rowlr ttl" }, title, date),
                role.bullets.map((_, j) => bulletItem(role.bullets, j, "ind")),
                addBtn("Add bullet", () => role.bullets.push("")),
              ];
            }),
          ),
        ),
      ),
    projects: () =>
      r.project_experience.length
        ? sec(
            "PROJECTS COMPLETED",
            r.project_experience.length > 6 ? h("div", { class: "grid2" }, r.project_experience.map((_, i) => bulletItem(r.project_experience, i))) : r.project_experience.map((_, i) => bulletItem(r.project_experience, i, "ind")),
            addBtn("Add project", () => r.project_experience.push("")),
          )
        : null,
    education: () =>
      r.education.length
        ? sec(
            "EDUCATION",
            r.education.map((e) =>
              h(
                "p",
                { class: "edu" },
                editable("span", e.institution, (v) => (e.institution = v), { ph: "Institution" }),
                " | ",
                editable("span", e.degree_type, (v) => (e.degree_type = v), { ph: "Degree" }),
                e.field || e.degree_type ? [" in ", editable("span", e.field, (v) => (e.field = v), { ph: "Field" })] : null,
                e.gpa ? [" | (GPA: ", editable("span", e.gpa, (v) => (e.gpa = v)), ")"] : null,
                " | ",
                editable("span", e.year, (v) => (e.year = v), { ph: "Year" }),
                e.description ? h("div", { class: "muted-line" }, editable("span", e.description, (v) => (e.description = v), { multiline: true })) : null,
              ),
            ),
          )
        : null,
  };

  return h(
    "div",
    { class: "paper" },
    h("img", { class: "lh-logo", src: LOGO, alt: "" }),
    h("div", { class: "lh-contact" }, h("div", {}, S.lh.phone), h("div", {}, S.lh.email), h("div", {}, S.lh.website)),
    h("div", { class: "lh-rule" }),
    h(
      "div",
      { class: "nm" },
      r.nickname
        ? [
            editable("span", r.candidate_name.split(" ")[0], (v) => (r.candidate_name = [v, ...r.candidate_name.split(" ").slice(1)].join(" "))),
            " “",
            editable("span", r.nickname, (v) => (r.nickname = v || null)),
            "” ",
            editable("span", r.candidate_name.split(" ").slice(1).join(" "), (v) => (r.candidate_name = [r.candidate_name.split(" ")[0], v].join(" ").trim())),
          ]
        : editable("span", r.candidate_name, (v) => (r.candidate_name = v), { ph: "Candidate name" }),
    ),
    h("div", { class: "pa" }, editable("span", r.position_applied ?? "", (v) => (r.position_applied = v || null), { ph: "Position applied" })),
    r.section_order.map((s) => builders[s]?.()),
    h("div", { class: "foot" }, `Proprietary and Confidential © ${br.company_name ?? ""}`),
  );
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
function panel() {
  const tabs = [
    ["email", "Client email"],
    ["review", "Review"],
    ["layout", "Layout"],
    ["claude", "Ask Claude"],
  ];
  const body = { email: emailTab, review: reviewTab, layout: layoutTab, claude: claudeTab }[S.tab]();
  return h(
    "div",
    { class: "card panel" },
    h("div", { class: "ptabs" }, tabs.map(([k, label]) => h("button", { type: "button", class: S.tab === k ? "on" : "", onclick: () => ((S.tab = k), render()) }, label))),
    h("div", { class: "pbody" }, body),
  );
}

function emailTab() {
  const E = S.email;
  const g = S.data?.gmail ?? { configured: false };
  const set = (k) => (e) => (E[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value);
  const parse = (s) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${E.subject}\n\n${E.body}`);
      toast("Email copied");
    } catch {
      toast("Select the text and copy it", true);
    }
  };
  const create = async (e) => {
    const btn = e.currentTarget;
    const attach = [E.pdf && "pdf", E.docx && "docx"].filter(Boolean);
    const bad = [...parse(E.to), ...parse(E.cc)].filter((x) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
    if (bad.length) return toast(`Check these addresses: ${bad.join(", ")}`, true);
    if (S.dirty && !(await save())) return;
    btn.disabled = true;
    btn.textContent = "Creating draft…";
    const r = await call("resume_dashboard_gmail_draft", { id: S.build.id, to: parse(E.to), cc: parse(E.cc), subject: E.subject, body: E.body, attach });
    btn.disabled = false;
    btn.textContent = "Create Gmail draft";
    if (r.status === "gmail_not_connected") {
      if (S.data) S.data.gmail = { configured: Boolean(r.connect_url), connected: false, connect_url: r.connect_url };
      renderHeader();
      S.emailResult = { error: r.message, connect: r.connect_url };
      return render();
    }
    if (r.status !== "success") {
      S.emailResult = { error: r.message };
      return render();
    }
    const email = { ...E };
    setBuild(r.build);
    S.email = email;
    S.emailResult = { url: r.gmail_url, account: r.account };
    render();
    toast("Draft saved in Gmail");
  };

  const result = S.emailResult;
  return [
    h("div", { class: "row2" }, h("label", { class: "field" }, h("span", {}, "To"), h("input", { class: "in", placeholder: "client@company.com", value: E.to, oninput: set("to") })), h("label", { class: "field" }, h("span", {}, "Cc"), h("input", { class: "in", value: E.cc, oninput: set("cc") }))),
    h("label", { class: "field" }, h("span", {}, "Subject"), h("input", { class: "in", value: E.subject, oninput: set("subject") })),
    h("label", { class: "field" }, h("span", {}, "Body"), h("textarea", { class: "in", rows: 16, oninput: set("body") }, E.body)),
    h(
      "div",
      { class: "attach" },
      h("span", { class: "lbl" }, "Attach"),
      h("label", {}, h("input", { type: "checkbox", checked: E.pdf, onchange: set("pdf") }), S.build.file_names.pdf),
      h("label", {}, h("input", { type: "checkbox", checked: E.docx, onchange: set("docx") }), "DOCX"),
    ),
    result?.url
      ? h("div", { class: "notice good" }, "Draft saved in ", result.account || "Gmail", ". ", h("a", { href: "#", onclick: (e) => (e.preventDefault(), openLink(result.url)) }, "Open draft in Gmail ↗"))
      : null,
    result?.error
      ? h("div", { class: "notice bad" }, result.error, result.connect ? [" ", h("a", { href: "#", onclick: (e) => (e.preventDefault(), connectGmail()) }, "Connect Gmail ↗")] : null)
      : null,
    !g.configured ? h("div", { class: "notice warn" }, "Gmail isn't set up on the server yet — copy the email instead.") : null,
    h(
      "div",
      { style: "display:flex;gap:8px;flex-wrap:wrap" },
      h("button", { class: "btn gold", type: "button", disabled: !g.configured, onclick: create }, "Create Gmail draft"),
      h("button", { class: "btn", type: "button", onclick: copy }, "Copy email"),
    ),
    h("p", { class: "small muted", style: "margin:0" }, "Drafts are saved in your own Gmail and never sent — review and send from Gmail."),
    S.build.gmail_drafts?.length
      ? h("div", { class: "drafts" }, h("span", { class: "lbl" }, "Drafts created"), S.build.gmail_drafts.map((d) => h("a", { href: "#", onclick: (e) => (e.preventDefault(), openLink(d.url)) }, `${ago(d.at)}${d.to?.length ? ` · to ${d.to.join(", ")}` : ""} ↗`)))
      : null,
  ];
}

function reviewTab() {
  const cr = S.build.content_review;
  if (!cr) return h("p", { class: "muted", style: "margin:0" }, "Claude didn't attach a content review to this build. Ask Claude in the chat for one, or check the chat where it was built.");
  const block = (title, items, cls = "") => (items?.length ? h("div", { class: cls }, h("h5", {}, title), h("ul", {}, items.map((x) => h("li", {}, x)))) : null);
  return h(
    "div",
    { class: "review" },
    cr.flags?.length ? h("div", { class: "notice warn" }, h("b", {}, "Check before sending: "), cr.flags.join(" · ")) : null,
    block("Included", cr.included),
    block("Omitted (by design)", cr.omitted),
    block("Enhanced", cr.enhanced),
    h("p", { class: "small muted" }, "Want anything back? Use Ask Claude, or edit the page directly."),
  );
}

function layoutTab() {
  const r = S.draft;
  const lhs = S.data?.letterhead ?? { emails: [], phones: [], websites: [] };
  const change = (fn) => (e) => {
    fn(e.target.type === "checkbox" ? e.target.checked : e.target.value);
    markDirty();
    rerenderPaper();
  };
  const order = [...r.section_order, ...ALL_SECTIONS.filter((s) => !r.section_order.includes(s))];
  const move = (s, d) => {
    const list = r.section_order;
    const i = list.indexOf(s);
    const j = i + d;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    markDirty();
    render();
  };
  const toggle = (s) => {
    r.section_order = r.section_order.includes(s) ? r.section_order.filter((x) => x !== s) : [...r.section_order, s];
    markDirty();
    render();
  };
  const workIdx = r.section_order.indexOf("work");
  const misordered = workIdx >= 0 && ["skills", "certifications"].some((s) => r.section_order.includes(s) && r.section_order.indexOf(s) > workIdx);
  const lhField = (label, key, list, attrs = {}) =>
    h(
      "label",
      { class: "field" },
      h("span", {}, label),
      h("input", { class: "in", list: `lt-${key}`, value: S.lh[key], oninput: change((v) => (S.lh[key] = v.trim())), ...attrs }),
      h("datalist", { id: `lt-${key}` }, list.map((v) => h("option", { value: v }))),
    );

  return [
    h("h5", {}, "Letterhead"),
    lhField("Consultant email", "email", lhs.emails, { type: "email" }),
    h("div", { class: "row2" }, lhField("Phone", "phone", lhs.phones, { type: "tel" }), lhField("Website", "website", lhs.websites)),
    h("h5", {}, "Details"),
    h("div", { class: "row2" }, h("label", { class: "field" }, h("span", {}, "Nickname"), h("input", { class: "in", value: r.nickname ?? "", oninput: change((v) => (r.nickname = v.trim() || null)) })), h("label", { class: "field" }, h("span", {}, "Position applied"), h("input", { class: "in", value: r.position_applied ?? "", oninput: change((v) => (r.position_applied = v.trim() || null)) }))),
    h(
      "div",
      { class: "row2" },
      h("label", { class: "field" }, h("span", {}, "Summary header"), h("select", { class: "in", onchange: change((v) => (r.summary_header = v)) }, ["PROFESSIONAL SUMMARY", "PROFESSIONAL OVERVIEW"].map((v) => h("option", { value: v, selected: r.summary_header === v ? "" : undefined }, v)))),
      h("label", { class: "field" }, h("span", {}, "Work header"), h("select", { class: "in", onchange: change((v) => (r.work_header = v)) }, ["PROFESSIONAL EXPERIENCE", "PROFESSIONAL HISTORY"].map((v) => h("option", { value: v, selected: r.work_header === v ? "" : undefined }, v)))),
    ),
    h("label", { class: "attach" }, h("input", { type: "checkbox", checked: r.separate_certifications, onchange: change((v) => (r.separate_certifications = v)) }), "Certifications in their own section (recommended for 4+)"),
    h("h5", {}, "Sections"),
    misordered ? h("div", { class: "notice warn" }, "Skills and certifications should come before work history.") : null,
    h(
      "div",
      { class: "order" },
      order.map((s) => {
        const on = r.section_order.includes(s);
        return h(
          "div",
          { class: `o${on ? "" : " off"}` },
          h("input", { type: "checkbox", checked: on, onchange: () => toggle(s), title: on ? "Hide" : "Show" }),
          h("span", {}, SECTION_LABELS[s]),
          h("button", { class: "btn sm ghost", type: "button", disabled: !on, onclick: () => move(s, -1), title: "Move up" }, "↑"),
          h("button", { class: "btn sm ghost", type: "button", disabled: !on, onclick: () => move(s, 1), title: "Move down" }, "↓"),
        );
      }),
    ),
  ];
}

function claudeTab() {
  const rev = S.revision;
  const quick = ["Tighten it to fit on two pages", "Add back anything you omitted that a client would value", "Make the summary punchier and tailored to the position", "Rewrite the client email notes with stronger highlights", "Use PROFESSIONAL OVERVIEW and PROFESSIONAL HISTORY"];
  let text = "";
  const ta = h("textarea", { class: "in", rows: 5, placeholder: "e.g. Broaden the 2019 title to Construction Manager and add the PMP back", oninput: (e) => (text = e.target.value) });
  const send = async (what) => {
    const ask = (what ?? text).trim();
    if (!ask) return;
    if (S.dirty && !(await save())) return;
    const b = S.build;
    const message = `[Resume Builder] Revise the presentation resume for ${b.resume.candidate_name} (build_id ${b.id}): ${ask}\nCall resume_get_build, apply the change following the playbook, and call resume_generate with the same build_id (update client_email and content_review too if they change).`;
    const sent = await sendToChat(message);
    S.revision = { fromVersion: b.version, sentAt: Date.now(), message, sent };
    render();
    pollForRevision();
  };
  return [
    h("p", { class: "muted", style: "margin:0" }, "Ask Claude for bigger changes. The request goes to your chat; the revised resume reloads here."),
    ta,
    h("button", { class: "btn primary", type: "button", onclick: () => send() }, "Send to Claude"),
    h("div", { class: "chips" }, quick.map((q) => h("button", { type: "button", onclick: () => send(q) }, q))),
    rev
      ? rev.sent
        ? h("div", { class: "notice gold", style: "display:flex;gap:10px;align-items:center" }, h("span", { class: "spinner" }), "Waiting for Claude's revision…")
        : h("div", { class: "notice warn" }, "Your chat app didn't accept the message. Copy it into the chat:", h("pre", { class: "msg", style: "margin-top:8px" }, rev.message))
      : null,
  ];
}

async function pollForRevision() {
  const rev = S.revision;
  if (!rev || !rev.sent || !S.build) return;
  if (Date.now() - rev.sentAt > POLL_LIMIT_MS) {
    S.revision = null;
    return;
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
  if (S.revision !== rev || !S.build) return;
  const r = await call("resume_dashboard_build", { id: S.build.id });
  if (r.status === "success" && r.build.version > rev.fromVersion) {
    S.revision = null;
    if (S.dirty) {
      toast("Claude revised the resume — save or discard your edits to see it.", true);
      return;
    }
    setBuild(r.build);
    render();
    toast("Claude revised the resume");
    return;
  }
  pollForRevision();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
for (const b of document.querySelectorAll("#tabs button")) b.addEventListener("click", () => go(b.dataset.view));
renderHeader();

let opened = false;
onToolResult((sc) => {
  const id = sc?.build_id;
  if (typeof id === "string" && /^rb_[a-f0-9]{16}$/.test(id) && S.build?.id !== id) {
    opened = true;
    loadData().then(() => openBuild(id));
  }
});

loadData().then(() => {
  if (!opened) render();
});
