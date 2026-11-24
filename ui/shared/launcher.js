// Shared "open card" for GoldCoast dashboards (MCP Apps). In the chat (inline) the dashboard shows a compact
// card with an "Open" button that asks the host for its expanded (fullscreen) view; expanded, the full
// dashboard shows. Hosts that can't expand keep the full dashboard inline.

const CSS = `
#gc-launcher { display: none; }
body.gc-launcher { padding: 0 !important; background: transparent !important; }
body.gc-launcher > *:not(#gc-launcher) { display: none !important; }
body.gc-launcher #gc-launcher { display: flex; }
#gc-launcher { align-items: center; gap: 16px; padding: 16px 18px; margin: 2px; border-radius: 14px; background: #0d0d0f; color: #fff;
  font: 14px/1.4 "Inter", system-ui, sans-serif; position: relative; overflow: hidden; flex-wrap: wrap; }
#gc-launcher::before { content: ""; position: absolute; top: -140px; left: 40%; width: 420px; height: 260px; border-radius: 50%;
  background: rgba(201,162,77,.22); filter: blur(90px); pointer-events: none; }
#gc-launcher img { height: 44px; width: 44px; position: relative; filter: invert(1); }
#gc-launcher .t { position: relative; flex: 1; min-width: 180px; }
#gc-launcher .t b { display: block; font: 400 22px/1.15 "Instrument Serif", Georgia, serif; }
#gc-launcher .t span { font-size: 12.5px; color: rgba(255,255,255,.62); }
#gc-launcher .a { position: relative; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
#gc-launcher button { border: 1px solid rgba(255,255,255,.2); border-radius: 9px; padding: 8px 14px; background: rgba(255,255,255,.06); color: #fff;
  font: 600 13px "Inter", system-ui, sans-serif; cursor: pointer; }
#gc-launcher button:hover { background: rgba(255,255,255,.12); }
#gc-launcher button.open { background: #c9a24d; border-color: #c9a24d; color: #111; }
#gc-launcher button.open:hover { filter: brightness(1.06); }
#gc-launcher button.here { border: 0; background: none; color: rgba(255,255,255,.55); font-weight: 400; font-size: 12px; text-decoration: underline; padding: 0; }
#gc-launcher .msg { width: 100%; position: relative; font-size: 12px; color: #f3d48a; }
`;

/**
 * Adds the open card. `app` is the connected ext-apps App, `ready` its connect() promise.
 * Returns { update, setCard }: call update() from onhostcontextchanged; setCard() changes the text and
 * adds quick actions (e.g. downloads) shown next to "Open".
 */
export function installLauncher(app, ready, { title, subtitle, logo }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);

  const card = document.createElement("div");
  card.id = "gc-launcher";
  card.innerHTML = `${logo ? `<img src="${logo}" alt="GoldCoast Search Group">` : ""}
    <div class="t"><b></b><span></span></div>
    <div class="a"><span class="extra" style="display:contents"></span><button class="open" type="button">Open Resume Builder ↗</button><button class="here" type="button">Show it here</button></div>
    <div class="msg" hidden></div>`;
  document.body.prepend(card);

  const setCard = ({ title: t, subtitle: s, actions = [] }) => {
    card.querySelector(".t b").textContent = t;
    card.querySelector(".t span").textContent = s;
    const extra = card.querySelector(".extra");
    extra.replaceChildren(
      ...actions.map((a) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = a.label;
        b.addEventListener("click", a.onClick);
        return b;
      }),
    );
  };
  setCard({ title, subtitle });

  let stayInline = false;
  const ctx = () => app.getHostContext?.() ?? {};
  const update = () => {
    const c = ctx();
    const canExpand = (c.availableDisplayModes ?? []).includes("fullscreen");
    document.body.classList.toggle("gc-launcher", !stayInline && c.displayMode === "inline" && canExpand);
    const full = c.displayMode === "fullscreen";
    const inset = c.safeAreaInsets ?? {};
    const px = (v, fallback) => `${Number.isFinite(v) ? v : fallback}px`;
    const root = document.documentElement.style;
    root.setProperty("--safe-bottom", px(inset.bottom, full ? 130 : 0));
    root.setProperty("--safe-top", px(inset.top, 0));
    document.body.classList.toggle("gc-fullscreen", full);
  };

  card.querySelector(".open").addEventListener("click", async () => {
    try {
      const r = await app.requestDisplayMode({ mode: "fullscreen" });
      if (r?.mode && r.mode !== "fullscreen") throw new Error("declined");
    } catch {
      const msg = card.querySelector(".msg");
      msg.textContent = "This app couldn't open the expanded view, so the Resume Builder is shown here.";
      msg.hidden = false;
      stayInline = true;
    }
    update();
  });
  card.querySelector(".here").addEventListener("click", () => {
    stayInline = true;
    update();
  });

  ready.then(update).catch(() => {});
  return { update, setCard };
}
