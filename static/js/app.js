/**
 * Správa faktur – hlavní JavaScript (SPA)
 * Žádný framework, čistý vanilla JS
 */

// ═══════════════════════════════════════════════════════════════
//  Globální stav
// ═══════════════════════════════════════════════════════════════
const App = {
  config: { firmy: [], app_nazev: "Správa faktur" },
  currentPage: "dashboard",
  chartInstances: {},
  polozkyData: [],          // cache pro sortování
  polozkySort: { col: "celkem_utraceno", asc: false },
  role: null,               // přihlášená role: "admin" | "verunka" | "ucetni"
  jmeno: null,              // zobrazované jméno
  prava: {},                // matice oprávnění
  history: [],              // navigační historie
};

// ═══════════════════════════════════════════════════════════════
//  Inicializace
// ═══════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
  loadTheme();
  showDate();
  setupThemeSwitch();
  setupMobileMenu();
  // Zkontroluj zda je uživatel přihlášen
  await zkontrolujPrihlaseni();
});

async function loadConfig() {
  const cfg = await api("/api/config");
  App.config = cfg;
  document.getElementById("appNazev").textContent = cfg.app_nazev;
  document.title = cfg.app_nazev;
  fillFirmaSelects();
}

// ═══════════════════════════════════════════════════════════════
//  Přihlašování
// ═══════════════════════════════════════════════════════════════
async function zkontrolujPrihlaseni() {
  try {
    const me = await fetch("/api/me").then(r => r.json());
    if (me.prihlasen) {
      App.role  = me.role;
      App.jmeno = me.jmeno;
      App.prava = me.prava === "vse" ? null : (me.prava || {});
      await spustAplikaci();
    } else {
      zobrazLogin();
    }
  } catch(e) {
    zobrazLogin();
  }
}

function zobrazLogin() {
  document.getElementById("loginOverlay").style.display = "flex";
  document.getElementById("appShell").style.display = "none";
  document.getElementById("loginHeslo").focus();
}

function skryjLogin() {
  document.getElementById("loginOverlay").style.display = "none";
  document.getElementById("appShell").style.display = "flex";
}

async function prihlasit() {
  const heslo = document.getElementById("loginHeslo").value;
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  if (!heslo) { errEl.textContent = "Zadej heslo"; return; }

  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({heslo})
    });
    const data = await r.json();
    if (!data.ok) {
      errEl.textContent = "❌ Špatné heslo";
      document.getElementById("loginHeslo").value = "";
      return;
    }
    App.role  = data.role;
    App.jmeno = data.jmeno;
    App.prava = data.prava === "vse" ? null : (data.prava || {});
    document.getElementById("loginHeslo").value = "";
    skryjLogin();
    await spustAplikaci();
  } catch(e) {
    errEl.textContent = "❌ Chyba připojení";
  }
}

async function odhlasit() {
  await fetch("/api/logout", {method: "POST"});
  App.role = null; App.jmeno = null; App.prava = {};
  zobrazLogin();
}

function maPravo(sekce) {
  if (App.role === "admin" || App.prava === null) return true;
  return App.prava[sekce] === true;
}

async function spustAplikaci() {
  // Zobraz jméno přihlášeného uživatele
  const userEl = document.getElementById("prihlasenyUzivatel");
  if (userEl) userEl.textContent = App.jmeno;

  await loadConfig();
  setupNav();
  skryjNepovoleneMenu();
  navigateTo("dashboard");
}

function skryjNepovoleneMenu() {
  // Mapování data-page → právo které se kontroluje
  const menuPrava = {
    "faktury":    "faktury_zobrazit",
    "nahrat":     "faktury_upravit",
    "rucni":      "faktury_upravit",
    "polozky":    "faktury_zobrazit",
    "vyplaty":    "vyplaty_zobrazit",
    "reporty":    "reporty_zobrazit",
    "penezenka":  "reporty_zobrazit",
    "statistiky": "statistiky",
    "nastaveni":  "nastaveni",
    "banky":      "bankovni_vypisy",
    "kalkulace":  "kalkulace",
    "vydaje":          "vydaje_zobrazit",
    "soukrome_vydaje": "soukrome_vydaje_zobrazit",
    "vystavene":       "vystavene_zobrazit",
  };
  document.querySelectorAll(".nav-item[data-page]").forEach(el => {
    const page = el.dataset.page;
    if (page === "dashboard") return; // dashboard vidí vždy
    const pravo = menuPrava[page];
    if (pravo && !maPravo(pravo)) {
      el.style.display = "none";
    } else {
      el.style.display = "";
    }
  });
}

function fillFirmaSelects() {
  const selects = document.querySelectorAll(".firma-select, #globalFirmaFilter");
  selects.forEach(sel => {
    const val = sel.value;
    sel.innerHTML = `<option value="">Všechny firmy</option>` +
      App.config.firmy.map(f => `<option value="${f}">${f}</option>`).join("");
    if (val) sel.value = val;
  });
}

// ═══════════════════════════════════════════════════════════════
//  Navigace
// ═══════════════════════════════════════════════════════════════
function setupNav() {
  document.querySelectorAll(".nav-item").forEach(a => {
    a.addEventListener("click", e => {
      e.preventDefault();
      navigateTo(a.dataset.page);
      document.getElementById("sidebar").classList.remove("open");
    });
  });
}

function navigateTo(page) {
  if (App.currentPage && App.currentPage !== page) {
    App.history.push(App.currentPage);
    if (App.history.length > 20) App.history.shift();
  }
  App.currentPage = page;
  // Zobraz/skryj tlačítko zpět
  const btn = document.getElementById("backBtnWrap");
  if (btn) btn.style.display = App.history.length > 0 ? "block" : "none";
  document.querySelectorAll(".nav-item").forEach(a => {
    a.classList.toggle("active", a.dataset.page === page);
  });
  const pages = {
    dashboard:  renderDashboard,
    faktury:    renderFaktury,
    nahrat:     renderNahrat,
    rucni:      () => { navigateTo('nahrat'); setTimeout(()=>switchTab('rucni'),100); },
    polozky:    renderPolozky,
    vyplaty:    renderVyplaty,
    reporty:    renderReporty,
    penezenka:  renderPenezenka,
    statistiky: renderStatistiky,
    kalkulace:  renderKalkulace,
    "ai-asistent": renderAiAsistent,
    nastaveni:  renderNastaveni,
    banky:      renderBanky,
    vydaje:          renderVydaje,
    soukrome_vydaje: () => renderVydaje("soukrome"),
    vystavene:       renderVystavene,
    radek:           renderRadek,
    dokumenty:       renderDokumenty,
  };
  if (pages[page]) pages[page]();
}

// ═══════════════════════════════════════════════════════════════
//  Téma
// ═══════════════════════════════════════════════════════════════
function goBack() {
  if (App.history.length === 0) return;
  const prev = App.history.pop();
  App.currentPage = prev;
  document.querySelectorAll(".nav-item").forEach(a => {
    a.classList.toggle("active", a.dataset.page === prev);
  });
  const btn = document.getElementById("backBtnWrap");
  if (btn) btn.style.display = App.history.length > 0 ? "block" : "none";
  const pages = {
    dashboard:  renderDashboard,
    faktury:    renderFaktury,
    nahrat:     renderNahrat,
    polozky:    renderPolozky,
    vyplaty:    renderVyplaty,
    reporty:    renderReporty,
    penezenka:  renderPenezenka,
    statistiky: renderStatistiky,
    kalkulace:  renderKalkulace,
    "ai-asistent": renderAiAsistent,
    nastaveni:  renderNastaveni,
    banky:      renderBanky,
    vydaje:          renderVydaje,
    soukrome_vydaje: () => renderVydaje("soukrome"),
    vystavene:       renderVystavene,
    radek:           renderRadek,
    dokumenty:       renderDokumenty,
  };
  if (pages[prev]) pages[prev]();
}

function loadTheme() {
  const t = localStorage.getItem("theme") || "light";
  document.documentElement.setAttribute("data-theme", t);
}
function setupThemeSwitch() {
  const sw = document.getElementById("themeSwitch");
  sw.checked = (document.documentElement.getAttribute("data-theme") === "dark");
  sw.addEventListener("change", () => {
    const t = sw.checked ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("theme", t);
    Object.values(App.chartInstances).forEach(c => { if (c) c.destroy(); });
    App.chartInstances = {};
    navigateTo(App.currentPage);
  });
}
function setupMobileMenu() {
  document.getElementById("menuBtn").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });
}
function showDate() {
  const d = new Date();
  const datum = d.toLocaleDateString("cs-CZ", { day:"numeric", month:"long", year:"numeric" });
  const den = d.toLocaleDateString("cs-CZ", { weekday:"long" });
  const el = document.getElementById("todayDate");
  if (el) el.innerHTML = `<span style="font-size:1.05rem;font-weight:600;color:var(--txt,#111)">${datum}</span> <span style="font-size:.8rem;color:var(--txt2,#666);margin-left:.3rem">${den}</span>`;
}

// ═══════════════════════════════════════════════════════════════
//  API helper
// ═══════════════════════════════════════════════════════════════
async function api(url, opts = {}) {
  try {
    const r = await fetch(url, opts);
    if (r.status === 401) {
      // Session vypršela - zobraz přihlášení
      zobrazLogin();
      throw new Error("Nejsi přihlášen");
    }
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
    return r.json();
  } catch (e) {
    if (e.message !== "Nejsi přihlášen") toast("Chyba: " + e.message, true);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════
//  Toast notifikace
// ═══════════════════════════════════════════════════════════════
function toast(msg, error = false) {
  const el = document.createElement("div");
  el.className = "toast" + (error ? " error" : "");
  el.textContent = msg;
  document.getElementById("toastContainer").appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ═══════════════════════════════════════════════════════════════
//  Modal
// ═══════════════════════════════════════════════════════════════
function openModal(title, bodyHtml) {
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalBody").innerHTML = bodyHtml;
  document.getElementById("modalOverlay").style.display = "flex";
}
function closeModal() {
  document.getElementById("modalOverlay").style.display = "none";
}
document.getElementById("modalClose").addEventListener("click", closeModal);
document.getElementById("modalOverlay").addEventListener("click", e => {
  if (e.target === document.getElementById("modalOverlay")) closeModal();
});

// ═══════════════════════════════════════════════════════════════
//  Formátování
// ═══════════════════════════════════════════════════════════════
function czMoney(v) {
  return Number(v).toLocaleString("cs-CZ", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function czMoneyFull(v) {
  return Number(v).toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " Kč";
}

function czMoneyFA(v) {
  return Number(v).toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " Kč";
}

// Helper: dropdown výběr roku (Vše + roky od 2023 do aktuálního)
function rokOptions(selectedRok = "") {
  const aktualni = new Date().getFullYear();
  let opts = `<option value="">Vše</option>`;
  for (let r = aktualni; r >= 2023; r--) {
    const sel = String(r) === String(selectedRok) ? " selected" : "";
    opts += `<option value="${r}"${sel}>${r}</option>`;
  }
  return opts;
}

// Helper: nastav Od/Do podle vybraného roku
function aplikujRokFiltr(rokId, odId, doId, loadFn) {
  const rok = document.getElementById(rokId)?.value;
  const odEl = document.getElementById(odId);
  const doEl = document.getElementById(doId);
  if (rok) {
    if (odEl) odEl.value = `${rok}-01-01`;
    if (doEl) doEl.value = `${rok}-12-31`;
  } else {
    if (odEl) odEl.value = "";
    if (doEl) doEl.value = "";
  }
  if (loadFn) loadFn();
}
// Celé číslo bez desetinné čárky a bez "Kč" – pro tabulku reportů
function czInt(v) {
  return Math.round(Number(v)).toLocaleString("cs-CZ");
}
function czDate(s) {
  if (!s) return "—";
  // Přidat čas aby se předešlo posunu při UTC→lokální konverzi
  const d = new Date(s.length === 10 ? s + "T12:00:00" : s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString("cs-CZ");
}
// Kompaktní datum – den.měsíc. (bez roku) pro tabulku reportů
function czDateShort(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d)) return s;
  const rok = String(d.getFullYear()).slice(-2);
  return d.toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" }) + rok;
}
function stavBadge(s) {
  const m = { zaplaceno: "Zaplaceno", ceka: "Čeká", po_splatnosti: "Po splatnosti", ke_zpracovani: "📱 Ke zpracování" };
  return `<span class="badge badge-${s}">${m[s] || s}</span>`;
}

// ═══════════════════════════════════════════════════════════════
//  Grafy
// ═══════════════════════════════════════════════════════════════
function drawBarChart(canvasId, labels, values, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width  = canvas.offsetWidth;
  const H = canvas.height = canvas.offsetHeight || 260;
  ctx.clearRect(0, 0, W, H);

  if (!values.length) {
    ctx.fillStyle = "#aaa";
    ctx.font = "14px DM Sans";
    ctx.textAlign = "center";
    ctx.fillText("Žádná data", W/2, H/2);
    return;
  }

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const txtColor = isDark ? "#A8C4A2" : "#6B6255";
  const gridColor = isDark ? "#2F3D34" : "#E0D8CC";

  const pad = { top: 20, right: 20, bottom: 50, left: 70 };
  const maxVal = Math.max(...values, 1);
  const bw = (W - pad.left - pad.right) / values.length;

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const y = pad.top + (H - pad.top - pad.bottom) * (1 - i/steps);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle = txtColor;
    ctx.font = "11px DM Sans";
    ctx.textAlign = "right";
    const v = (maxVal * i / steps);
    ctx.fillText(v >= 1000 ? Math.round(v/1000)+"k" : Math.round(v), pad.left - 6, y + 4);
  }

  values.forEach((v, i) => {
    const barH = ((v / maxVal) * (H - pad.top - pad.bottom));
    const x = pad.left + i * bw + bw * .1;
    const y = pad.top + (H - pad.top - pad.bottom) - barH;
    const grad = ctx.createLinearGradient(0, y, 0, y + barH);
    grad.addColorStop(0, color || "#52B788");
    grad.addColorStop(1, color ? color + "99" : "#2D6A4F");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y, bw * .8, barH, [4, 4, 0, 0]);
    ctx.fill();

    ctx.fillStyle = txtColor;
    ctx.font = "10px DM Sans";
    ctx.textAlign = "center";
    const lbl = labels[i] || "";
    ctx.fillText(lbl.length > 7 ? lbl.slice(5) : lbl, pad.left + i * bw + bw/2, H - pad.bottom + 16);
  });
}

function drawLineChart(canvasId, labels, datasets) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width  = canvas.offsetWidth;
  const H = canvas.height = canvas.offsetHeight || 220;
  ctx.clearRect(0, 0, W, H);

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const txtColor = isDark ? "#A8C4A2" : "#6B6255";
  const gridColor = isDark ? "#2F3D34" : "#E0D8CC";

  const pad = { top: 20, right: 20, bottom: 50, left: 70 };
  const allVals = datasets.flatMap(d => d.values);
  const maxVal  = Math.max(...allVals, 1);
  const minVal  = Math.min(...allVals.filter(v=>v>0), 0);
  const range   = maxVal - minVal || 1;
  const n       = labels.length;

  const getX = i => pad.left + (i / (n-1 || 1)) * (W - pad.left - pad.right);
  const getY = v => pad.top + (1 - (v - minVal) / range) * (H - pad.top - pad.bottom);

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + i/4 * (H - pad.top - pad.bottom);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle = txtColor; ctx.font = "11px DM Sans"; ctx.textAlign = "right";
    const v = maxVal - (maxVal - minVal)*i/4;
    ctx.fillText(v.toFixed(1), pad.left - 6, y + 4);
  }

  const colors = ["#2D6A4F", "#E9C46A", "#C44D58", "#52B788"];
  datasets.forEach((ds, di) => {
    if (!ds.values.length) return;
    ctx.strokeStyle = colors[di % colors.length];
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ds.values.forEach((v, i) => {
      const x = getX(i), y = getY(v);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = colors[di % colors.length];
    ds.values.forEach((v, i) => {
      ctx.beginPath();
      ctx.arc(getX(i), getY(v), 4, 0, 2*Math.PI);
      ctx.fill();
    });
  });

  ctx.fillStyle = txtColor; ctx.font = "10px DM Sans"; ctx.textAlign = "center";
  labels.forEach((lbl, i) => {
    ctx.fillText(lbl, getX(i), H - pad.bottom + 16);
  });
}

// ═══════════════════════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════════════════════
async function renderDashboard() {
  document.getElementById("mainContent").innerHTML = `<div class="loading-center"><span class="spinner"></span></div>`;

  let check, karty_stats = {};
  try { check = await api("/api/nastenka-check"); } catch { return; }
  try { karty_stats = await api("/api/reporty/karty-stats"); } catch {}

  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Nástěnka</h1>
      <button class="btn btn-secondary btn-sm" onclick="renderDashboard()">🔄 Zkontrolovat</button>
    </div>
    <div id="nastenkaBoxiky" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem;margin-bottom:1.5rem"></div>
    <div style="border-top:2px solid var(--border);margin:1.2rem 0 .8rem;opacity:.4"></div>
    <div id="nastenkaSpodek" style="display:grid;grid-template-columns:repeat(3,1fr);gap:1rem;margin-bottom:1rem"></div>`;

  _renderNastenkaBoxiky(check);
  _renderNastenkaSpodek(check, karty_stats);
}

function _renderNastenkaSpodek(c, karty_stats) {
  const el = document.getElementById("nastenkaSpodek");
  if (!el) return;
  const rok = new Date().getFullYear();

  // BOX 1: Terminál / karty per firma
  const tf = c.terminal_firmy || {};
  const limit = c.terminal_limit || 100000;
  const firmy = Object.keys(tf);
  const terminalRows = firmy.map(f => {
    const d = tf[f];
    const barW = Math.min(d.procent, 100);
    const barColor = d.stav === "error" ? "#ef4444" : d.stav === "warning" ? "#f59e0b" : "#22c55e";
    return `
      <div style="margin-bottom:.6rem">
        <div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:.2rem">
          <span style="font-weight:600">${f}</span>
          <span style="color:var(--txt2)">${czMoney(d.castka)} / ${czMoney(limit)}</span>
        </div>
        <div style="background:#e5e7eb;border-radius:4px;height:6px">
          <div style="background:${barColor};width:${barW}%;height:6px;border-radius:4px;transition:width .3s"></div>
        </div>
        <div style="font-size:.75rem;color:var(--txt2);margin-top:.15rem">${d.procent} %${d.aktivni ? ' · <strong>aktivní</strong>' : ''}</div>
      </div>`;
  }).join("");

  // BOX 2: P&L
  const pl = c.pl || {};
  const plColor = (pl.pl_rok || 0) >= 0 ? "#166534" : "#991b1b";
  const plBg = (pl.pl_rok || 0) >= 0 ? "#f0fdf4" : "#fee2e2";

  // BOX 3: Náklady po měsících
  const nm = c.naklady_mesice || [];
  const mesNames = ["","Led","Úno","Bře","Dub","Kvě","Čvn","Čvc","Srp","Zář","Říj","Lis","Pro"];
  const nmRows = nm.map(m => {
    const mi = parseInt(m.mesic.split("-")[1]);
    return `
      <tr style="border-top:0.5px solid var(--border)">
        <td style="padding:3px 6px;font-size:.8rem">${mesNames[mi] || m.mesic}</td>
        <td style="padding:3px 6px;font-size:.8rem;text-align:right">${czMoney(m.faktury)}</td>
        <td style="padding:3px 6px;font-size:.8rem;text-align:right">${czMoney(m.vydaje)}</td>
        <td style="padding:3px 6px;font-size:.8rem;text-align:right;font-weight:600">${czMoney(m.celkem)}</td>
      </tr>`;
  }).join("");
  const nmCelkem = nm.reduce((s,m) => s + m.celkem, 0);

  el.innerHTML = `
    ${renderKartaStatNastenka(karty_stats)}

    <div class="card" style="background:#fff;cursor:pointer" onclick="navigateTo('statistiky')">
      <div class="card-title">P&L — ${rok}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;margin-top:.5rem">
        <div>
          <div style="font-size:.72rem;color:var(--txt2)">Tržba vč. PK</div>
          <div style="font-size:1rem;font-weight:600;color:#166534">${czMoney(pl.trzba_rok)}</div>
        </div>
        <div>
          <div style="font-size:.72rem;color:var(--txt2)">Náklady celkem</div>
          <div style="font-size:1rem;font-weight:600;color:#991b1b">${czMoney(pl.naklady_celkem)}</div>
        </div>
        <div>
          <div style="font-size:.72rem;color:var(--txt2)">Faktury</div>
          <div style="font-size:.88rem">${czMoney(pl.naklady_faktury)}</div>
        </div>
        <div>
          <div style="font-size:.72rem;color:var(--txt2)">Výdaje</div>
          <div style="font-size:.88rem">${czMoney(pl.naklady_vydaje)}</div>
        </div>
        <div>
          <div style="font-size:.72rem;color:var(--txt2)">Výplaty</div>
          <div style="font-size:.88rem">${czMoney(pl.naklady_vyplaty)}</div>
        </div>
        <div>
          <div style="font-size:.72rem;color:var(--txt2)">Odvody</div>
          <div style="font-size:.88rem">${czMoney(pl.naklady_odvody)}</div>
        </div>
      </div>
      <div style="border-top:1.5px solid ${plColor};margin-top:.75rem;padding-top:.5rem;display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:600;font-size:.85rem;color:${plColor}">Výsledek</span>
        <span style="font-size:1.2rem;font-weight:700;color:${plColor}">${czMoney(pl.pl_rok)}</span>
      </div>
      <div style="font-size:.75rem;color:var(--txt2);margin-top:.3rem">Statistiky →</div>
    </div>

    <div class="card" style="background:#fff;cursor:pointer" onclick="navigateTo('faktury')">
      <div class="card-title">Náklady — ${rok}</div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--bg2)">
          <th style="padding:3px 6px;font-size:.78rem;text-align:left">Měsíc</th>
          <th style="padding:3px 6px;font-size:.78rem;text-align:right">Faktury</th>
          <th style="padding:3px 6px;font-size:.78rem;text-align:right">Výdaje</th>
          <th style="padding:3px 6px;font-size:.78rem;text-align:right">Celkem</th>
        </tr></thead>
        <tbody>${nmRows || "<tr><td colspan='4' style='padding:.5rem;color:var(--txt2);font-size:.85rem'>Žádná data</td></tr>"}</tbody>
        <tfoot><tr style="background:var(--bg2)">
          <td colspan="3" style="padding:3px 6px;font-size:.82rem;font-weight:600">Celkem ${rok}</td>
          <td style="padding:3px 6px;font-size:.88rem;font-weight:700;text-align:right">${czMoney(nmCelkem)}</td>
        </tr></tfoot>
      </table>
      <div style="font-size:.75rem;color:var(--txt2);margin-top:.3rem">Faktury →</div>
    </div>`;
}

function _stavBoxiku(stav) {
  if (stav === "error")   return { bg: "#fee2e2", border: "#ef4444", ikona: "🔴", txt: "#991b1b" };
  if (stav === "warning") return { bg: "#fef3c7", border: "#f59e0b", ikona: "🟡", txt: "#92400e" };
  return                         { bg: "#f0fdf4", border: "#86efac", ikona: "✅", txt: "#166534" };
}

function _nastenkaBoxik(nazev, stav, hlavni, sub, akce) {
  const s = _stavBoxiku(stav);
  return `
    <div style="background:${s.bg};border:1.5px solid ${s.border};border-radius:10px;padding:.9rem 1rem;cursor:${akce?'pointer':'default'}"
         onclick="${akce||''}">
      <div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem">
        <span style="font-size:.9rem">${s.ikona}</span>
        <span style="font-weight:600;font-size:.82rem;color:var(--txt2)">${nazev}</span>
      </div>
      <div style="font-size:1.1rem;font-weight:700;color:var(--txt)">${hlavni}</div>
      ${sub ? `<div style="font-size:.78rem;color:var(--txt2);margin-top:.15rem">${sub}</div>` : ""}
    </div>`;
}

function _renderNastenkaBoxiky(c) {
  const el = document.getElementById("nastenkaBoxiky");
  if (!el) return;

  const boxiky = [];

  // 1. Terminál limit
  const tl = c.terminal_box;
  boxiky.push(_nastenkaBoxik(
    "Terminál / měsíc",
    tl.stav,
    `${tl.procent} %`,
    `${czMoney(tl.castka)} z ${czMoney(tl.limit)}`,
    "navigateTo('reporty')"
  ));

  // 2. DPH limit
  const dl = c.dph_limit;
  boxiky.push(_nastenkaBoxik(
    "DPH limit / rok",
    dl.stav,
    `${dl.procent} %`,
    `${czMoney(dl.castka)} z ${czMoney(dl.limit)}`,
    "navigateTo('reporty')"
  ));

  // 3. Přijaté faktury po splatnosti
  const fps = c.faktury_po_splatnosti;
  boxiky.push(_nastenkaBoxik(
    "Faktury po splatnosti",
    fps.stav,
    fps.pocet === 0 ? "Vše OK" : `${fps.pocet} faktur`,
    fps.pocet === 0 ? "Nic nezaplatit" : czMoney(fps.castka),
    fps.pocet > 0 ? "navigateTo('faktury')" : null
  ));

  // 3b. Faktury blížící se splatnosti (do 7 dní)
  const fb = c.faktury_blizi_splatnost || {pocet:0, castka:0, stav:"ok"};
  const fbSub = fb.pocet === 0 ? "Žádné" : fb.items && fb.items.length
    ? fb.items.map(f => `${f.dodavatel} – ${f.datum_splatnosti}`).join(", ")
    : czMoney(fb.castka);
  boxiky.push(_nastenkaBoxik(
    "Splatnost do 7 dní",
    fb.stav,
    fb.pocet === 0 ? "Vše OK" : `${fb.pocet} faktur`,
    fbSub,
    fb.pocet > 0 ? "navigateTo('faktury')" : null
  ));

  // 4. Vystavené po splatnosti (nám nezaplatili)
  const fv = c.vystavene_po_splatnosti;
  boxiky.push(_nastenkaBoxik(
    "Nezaplaceno nám",
    fv.stav,
    fv.pocet === 0 ? "Vše zaplaceno" : `${fv.pocet} faktur`,
    fv.pocet === 0 ? "Odběratelé platí" : `${czMoney(fv.castka)} po splatnosti`,
    fv.pocet > 0 ? "navigateTo('vystavene')" : null
  ));

  // 5. Firemní čekající na úhradu (faktury + provozní výdaje)
  const cf = c.cekajici_firemni;
  const cfSub = cf.pocet === 0 ? "Vše zaplaceno"
    : [cf.pocet_faktur > 0 ? `${cf.pocet_faktur} FA (${czMoney(cf.castka_faktur)})` : "",
       cf.pocet_vydaju > 0 ? `${cf.pocet_vydaju} výdajů (${czMoney(cf.castka_vydaju)})` : ""]
      .filter(Boolean).join(" · ");
  boxiky.push(_nastenkaBoxik(
    "Čeká na úhradu — firemní",
    cf.stav,
    cf.pocet === 0 ? "Vše zaplaceno" : `${cf.pocet} položek`,
    cfSub,
    cf.pocet_faktur > 0 ? "navigateTo('faktury')" : (cf.pocet_vydaju > 0 ? "navigateTo('vydaje')" : null)
  ));

  // 6. Soukromé čekající na úhradu
  const cs = c.cekajici_soukrome;
  boxiky.push(_nastenkaBoxik(
    "Čeká na úhradu — soukromé",
    cs.stav,
    cs.pocet === 0 ? "Vše zaplaceno" : `${cs.pocet} výdajů`,
    cs.pocet === 0 ? "Žádné nezaplacené" : czMoney(cs.castka),
    cs.pocet > 0 ? "navigateTo('soukrome_vydaje')" : null
  ));

  // 7. Duplicitní faktury
  const fd = c.duplicitni_faktury;
  boxiky.push(_nastenkaBoxik(
    "Duplicitní faktury",
    fd.stav,
    fd.pocet === 0 ? "Žádné" : `${fd.pocet} duplikátů`,
    fd.pocet === 0 ? "Vše v pořádku" : czMoney(fd.castka),
    fd.pocet > 0 ? "navigujNaDuplicity()" : null
  ));

  // 8. Duplicitní reporty
  const dr = c.duplicitni_reporty;
  boxiky.push(_nastenkaBoxik(
    "Duplicitní reporty",
    dr.stav,
    dr.pocet === 0 ? "Žádné" : `${dr.pocet} duplicit`,
    dr.pocet === 0 ? "Vše v pořádku" : "Zkontroluj reporty",
    dr.pocet > 0 ? "navigateTo('reporty')" : null
  ));

  // 9. Záloha
  const zl = c.zaloha;
  const zalohaHlavni = zl.dni_stari < 0 ? "GCS nedostupné" : zl.dni_stari === 0 ? "Dnes" : `Před ${zl.dni_stari} dny`;
  const zalohaDatum = zl.soubor ? zl.soubor.replace(/zaloha_(\d{4})(\d{2})(\d{2})_.*/, "$3.$2.$1") : "";
  const zalohaSub = zalohaDatum && zalohaDatum !== zl.soubor
    ? `${zalohaDatum} (${zl.dni_stari >= 0 ? zl.dni_stari + " dní zpět" : ""})`
    : (zl.soubor || "Žádná záloha");
  boxiky.push(_nastenkaBoxik(
    "Poslední záloha",
    zl.stav,
    zalohaHlavni,
    zalohaSub,
    "navigateTo('nastaveni')"
  ));

  el.innerHTML = boxiky.join("");
}

function navigujNaDuplicity() {
  // Přejde na faktury a nastaví filtr na duplikát
  navigateTo("faktury");
  setTimeout(() => {
    const stavSel = document.getElementById("fStav");
    if (stavSel) { stavSel.value = "duplikat"; loadFaktury(); }
  }, 300);
}

async function _loadNastenkaFA() {
  const firma = document.getElementById("globalFirmaFilter")?.value || "";
  const qs = firma ? `?firma=${firma}` : "";
  let data;
  try { data = await api(`/api/dashboard${qs}`); } catch { return; }

  const el = document.getElementById("posledniFA");
  if (!el) return;
  el.innerHTML = `
    <table>
      <thead><tr><th>Dodavatel</th><th>Datum</th><th>Částka</th><th>Stav</th></tr></thead>
      <tbody>
        ${data.posledni_faktury.map(f => `
          <tr data-id="${f.id}" class="faktura-row" style="cursor:pointer">
            <td>${escHtml(f.dodavatel)}</td>
            <td>${czDate(f.datum_vystaveni)}</td>
            <td><strong>${czMoneyFull(f.celkem_s_dph)}</strong></td>
            <td>${stavBadge(f.stav)}</td>
          </tr>`).join("") || "<tr><td colspan='4' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné faktury</td></tr>"}
      </tbody>
    </table>`;
  document.querySelectorAll(".faktura-row").forEach(r => {
    r.addEventListener("click", () => openFakturaDetail(r.dataset.id));
  });

  const labels = data.graf.map(g => g.mesic);
  const values = data.graf.map(g => g.castka);
  requestAnimationFrame(() => drawBarChart("barChart", labels, values, "#2D6A4F"));
}

document.getElementById("globalFirmaFilter").addEventListener("change", () => {
  fillFirmaSelects();
  if (App.currentPage === "dashboard") renderDashboard();
});

// ═══════════════════════════════════════════════════════════════
//  FAKTURY
// ═══════════════════════════════════════════════════════════════
async function renderFaktury() {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Faktury</h1>
      <div class="btn-group">
        <button class="btn btn-secondary btn-sm" onclick="exportFaktury('xlsx')">⬇ Excel</button>
        <button class="btn btn-secondary btn-sm" onclick="exportFaktury('csv')">⬇ CSV</button>
      </div>
    </div>
    <div class="filters">
      <label>Firma:</label>
      <select id="fFirma" class="firma-select">
        <option value="">Všechny</option>
        ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
      </select>
      <label>Stav:</label>
      <select id="fStav">
        <option value="">Vše</option>
        <option value="ceka">Čeká</option>
        <option value="zaplaceno">Zaplaceno</option>
        <option value="po_splatnosti">Po splatnosti</option>
        <option value="duplikat">Duplikát</option>
        <option value="ke_zpracovani">📱 Ke zpracování</option>
      </select>
      <label>Rok:</label>
      <select id="fRok" onchange="aplikujRokFiltr('fRok','fOd','fDo',loadFaktury)">
        ${rokOptions(new Date().getFullYear())}
      </select>
      <label>Od:</label><input type="date" id="fOd">
      <label>Do:</label><input type="date" id="fDo">
      <input type="text" id="fQ" placeholder="Hledat dodavatele/č. faktury..." style="min-width:200px">
    </div>
    <div class="card">
      <div class="table-wrap" id="fakturyTable"><div class="loading-center"><span class="spinner"></span></div></div>
    </div>`;

  aplikujRokFiltr('fRok','fOd','fDo', null);
  loadFaktury();

  ["fFirma","fStav","fRok","fOd","fDo"].forEach(id => {
    document.getElementById(id)?.addEventListener("change", loadFaktury);
  });
  let qdeb;
  document.getElementById("fQ")?.addEventListener("input", () => {
    clearTimeout(qdeb); qdeb = setTimeout(loadFaktury, 350);
  });
}

// Stav řazení faktur
let _faktSort = { col: "datum_vystaveni", dir: "desc" };

function fakturySort(col) {
  if (_faktSort.col === col) {
    _faktSort.dir = _faktSort.dir === "asc" ? "desc" : "asc";
  } else {
    _faktSort.col = col;
    _faktSort.dir = "asc";
  }
  loadFaktury();
}

async function loadFaktury() {
  const params = new URLSearchParams({
    firma: document.getElementById("fFirma")?.value || "",
    stav:  document.getElementById("fStav")?.value  || "",
    od:    document.getElementById("fOd")?.value    || "",
    do:    document.getElementById("fDo")?.value    || "",
    q:     document.getElementById("fQ")?.value     || "",
  });

  let data;
  try { data = await api(`/api/faktury?${params}`); } catch { return; }

  const tbl = document.getElementById("fakturyTable");
  if (!tbl) return;

  const sortFns = {
    cislo_faktury:   (a,b) => (a.cislo_faktury||"").localeCompare(b.cislo_faktury||""),
    datum_vystaveni: (a,b) => (a.datum_vystaveni||"").localeCompare(b.datum_vystaveni||""),
    celkem_s_dph:    (a,b) => (a.celkem_s_dph||0) - (b.celkem_s_dph||0),
    dodavatel:       (a,b) => (a.dodavatel||"").localeCompare(b.dodavatel||""),
    firma_zkratka:   (a,b) => (a.firma_zkratka||"").localeCompare(b.firma_zkratka||""),
  };
  if (sortFns[_faktSort.col]) {
    data.faktury.sort((a,b) => {
      const r = sortFns[_faktSort.col](a,b);
      return _faktSort.dir === "asc" ? r : -r;
    });
  }

  const arrow = (col) => _faktSort.col === col ? (_faktSort.dir === "asc" ? " ▲" : " ▼") : " ⇅";
  const thSort = (col, label) =>
    `<th style="cursor:pointer;user-select:none" onclick="fakturySort('${col}')">${label}${arrow(col)}</th>`;

  tbl.innerHTML = `
    <table>
      <thead><tr>
        ${thSort("firma_zkratka","Firma")}
        ${thSort("dodavatel","Dodavatel")}
        ${thSort("cislo_faktury","Č. faktury")}
        ${thSort("datum_vystaveni","Vystavení")}
        ${thSort("celkem_s_dph","Celkem s DPH")}
        <th>Stav</th>
        ${maPravo("faktury_smazat") ? "<th></th>" : ""}
      </tr></thead>
      <tbody>
       ${data.faktury.map(f => `
            <tr class="faktura-row" data-id="${f.id}" style="${f.duplicita_id ? 'background:#fff7ed;border-left:3px solid #f59e0b' : f.stav==='ke_zpracovani' ? 'background:#fffbeb' : ''}">
              <td><span class="badge badge-zaplaceno" style="background:var(--green-pale)">${f.firma_zkratka}</span></td>
              <td>${escHtml(f.dodavatel)}</td>
              <td>${escHtml(f.cislo_faktury||"–")}${f.duplicita_id ? " <small style='color:orange'>⚠️ dup #" + f.duplicita_id + "</small>" : ""}</td>
              <td>${czDate(f.datum_vystaveni)}</td>
              <td><strong>${czMoneyFull(f.celkem_s_dph)}</strong></td>
              <td>${f.duplicita_id ? '<span class="badge" style="background:#0d6efd;color:#fff;cursor:pointer" onclick="event.stopPropagation();openFakturaDetail(' + f.duplicita_id + ')">🔗 Duplikát</span>' : stavBadge(f.stav)}</td>
              <td onclick="event.stopPropagation()" style="white-space:nowrap">
                ${f.soubor_url ? `<a href="${f.soubor_url}" target="_blank" class="btn btn-secondary btn-sm" title="Zobrazit originál" style="padding:.2rem .4rem">📎</a>` : ""}
                ${f.stav === 'ke_zpracovani' ? `
                  <button class="btn btn-xs btn-success" onclick="potvrdFakturu(${f.id})" title="Potvrdit — zůstane v Faktury">✅</button>
                  <button class="btn btn-xs btn-outline" onclick="premistFakturu(${f.id})" title="Přemístit jinam">↪</button>
                ` : maPravo("faktury_smazat") ? `<button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border:none;padding:.2rem .5rem;border-radius:4px;cursor:pointer" onclick="smazatFakturu(${f.id})">🗑</button>` : ""}
              </td>
              </tr>`).join("") ||
          "<tr><td colspan='7' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné faktury</td></tr>"}
      </tbody>
      ${data.faktury.length ?`
      <tfoot>
        <tr class="table-footer">
          <td colspan="4">Celkem (${data.faktury.length} faktur)</td>
          <td colspan="${maPravo('faktury_smazat') ? 3 : 2}"><strong>${czMoney(data.celkem)}</strong></td>
        </tr>
      </tfoot>` : ""}
    </table>`;

  document.querySelectorAll(".faktura-row").forEach(r => {
    r.addEventListener("click", () => openFakturaDetail(r.dataset.id));
  });
}

async function navigujNaFakturu(id) {
  // Přejde na sekci Faktury a otevře detail dané faktury
  const navItem = document.querySelector("[data-page='faktury']");
  if (navItem) navItem.click();
  // Počkáme na načtení sekce, pak otevřeme detail
  setTimeout(() => openFakturaDetail(id), 600);
}

async function openFakturaDetail(id) {
  let data;
  try { data = await api(`/api/faktury/${id}`); } catch { return; }
  const f = data.faktura;
  const polozky = data.polozky;

  const body = `
    <div class="grid-2" style="gap:1rem; margin-bottom:1rem;">
      <div>
        <div class="form-group">
          <label class="form-label">Dodavatel</label>
          <input id="editDodavatel" class="form-control" value="${escHtml(f.dodavatel)}">
        </div>
        <div class="form-group">
          <label class="form-label">Číslo faktury</label>
          <input id="editCislo" class="form-control" value="${escHtml(f.cislo_faktury||String())}">
        </div>
        <div class="form-group">
          <label class="form-label">Firma</label>
          <select id="editFirma" class="form-control">
            ${(App.config.firmy||[]).map(f2 => '<option value="' + escHtml(f2) + '" ' + (f.firma_zkratka===f2?'selected':'') + '>' + escHtml(f2) + '</option>').join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Způsob úhrady</label>
          <input id="editUhrada" class="form-control" value="${escHtml(f.zpusob_uhrady||String())}">
        </div>
      </div>
      <div>
        <div class="form-group">
          <label class="form-label">Datum vystavení</label>
          <input id="editDatumVyst" class="form-control" type="date" value="${f.datum_vystaveni||''}">
        </div>
        <div class="form-group">
          <label class="form-label">Datum splatnosti</label>
          <input id="editDatumSplat" class="form-control" type="date" value="${f.datum_splatnosti||''}">
        </div>
        <div class="form-group">
          <label class="form-label">Stav</label>
          <select id="detailStav" class="form-control">
            <option value="ceka" ${f.stav==="ceka"?"selected":""}>Čeká na zaplacení</option>
            <option value="zaplaceno" ${f.stav==="zaplaceno"?"selected":""}>Zaplaceno</option>
            <option value="po_splatnosti" ${f.stav==="po_splatnosti"?"selected":""}>Po splatnosti</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Celkem s DPH (Kč)</label>
          <input id="editCelkem" class="form-control" type="number" step="0.01" value="${f.celkem_s_dph||0}">
        </div>
      </div>
    </div>
    ${(f.soubor_url || f.soubor_cesta) ? `<div style="margin-bottom:1rem"><a href="${f.soubor_url || '/uploads/' + f.soubor_cesta}" target="_blank" class="btn btn-secondary btn-sm">📎 Zobrazit originál</a></div>` : ""}
    <h4 style="font-family:var(--font-head);margin-bottom:.7rem">Položky</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Název</th><th>Množství</th><th>Jednotka</th><th>Cena/jedn.</th><th>Celkem s DPH</th><th></th></tr></thead>
        <tbody id="editPolozkyBody">
          ${polozky.map((p,i) => `
            <tr data-pid="${p.id}">
              <td><input class="form-control ep-nazev" value="${escHtml(p.nazev)}" style="min-width:140px"></td>
              <td><input class="form-control ep-mnozstvi" type="number" step="0.001" value="${p.mnozstvi}" style="width:80px"></td>
              <td><input class="form-control ep-jednotka" value="${escHtml(p.jednotka||'')}" style="width:60px"></td>
              <td><input class="form-control ep-cena" type="number" step="0.0001" value="${p.cena_za_jednotku_s_dph}" style="width:90px"></td>
              <td><input class="form-control ep-celkem" type="number" step="0.01" value="${p.celkem_s_dph}" style="width:90px"></td>
              <td><button class="btn btn-danger btn-sm" onclick="editPolozkaRemove(this)">✕</button></td>
            </tr>`).join("") || "<tr><td colspan='6' style='text-align:center;color:var(--txt2)'>Žádné položky</td></tr>"}
        </tbody>
      </table>
    </div>
    <button class="btn btn-secondary btn-sm" style="margin-top:.5rem" onclick="editPolozkaAdd()">+ Přidat položku</button>
    <div class="btn-group" style="margin-top:1rem">
      <button class="btn btn-primary" onclick="saveFakturaEdit(${f.id})">💾 Uložit změny</button>
      <button class="btn btn-secondary btn-sm" onclick="presunDoSoukromych(${f.id})">📦 → Soukromé výdaje</button>
      ${f.duplicita_id ? `<button class="btn btn-secondary btn-sm" onclick="neniDuplicita(${f.id})" style="background:#f59e0b;color:#fff;border:none">✅ Není duplicita</button>` : ''}
      <button class="btn btn-danger btn-sm" onclick="deleteFaktura(${f.id},'${f.zdroj}')">${f.zdroj === 'drive_auto' ? '🗑 Smazat + Reset Drive' : '🗑 Smazat'}</button>
    </div>`;

  openModal(`Faktura – ${escHtml(f.dodavatel)} ${czDate(f.datum_vystaveni)}`, body);
}

function editPolozkaRemove(btn) {
  btn.closest("tr").remove();
}

function editPolozkaAdd() {
  const tbody = document.getElementById("editPolozkyBody");
  const tr = document.createElement("tr");
  tr.dataset.pid = "new";
  tr.innerHTML = `
    <td><input class="form-control ep-nazev" value="" style="min-width:140px"></td>
    <td><input class="form-control ep-mnozstvi" type="number" step="0.001" value="1" style="width:80px"></td>
    <td><input class="form-control ep-jednotka" value="PC" style="width:60px"></td>
    <td><input class="form-control ep-cena" type="number" step="0.0001" value="0" style="width:90px"></td>
    <td><input class="form-control ep-celkem" type="number" step="0.01" value="0" style="width:90px"></td>
    <td><button class="btn btn-danger btn-sm" onclick="editPolozkaRemove(this)">✕</button></td>`;
  tbody.appendChild(tr);
}

async function saveFakturaEdit(id) {
  const hlavicka = {
    firma_zkratka:    document.getElementById("editFirma").value,
    dodavatel:        document.getElementById("editDodavatel").value.trim(),
    cislo_faktury:    document.getElementById("editCislo").value.trim(),
    datum_vystaveni:  document.getElementById("editDatumVyst").value,
    datum_splatnosti: document.getElementById("editDatumSplat").value,
    zpusob_uhrady:    document.getElementById("editUhrada").value.trim(),
    stav:             document.getElementById("detailStav").value,
    celkem_s_dph:     parseFloat(document.getElementById("editCelkem").value) || 0,
  };

  const polozky = [];
  document.querySelectorAll("#editPolozkyBody tr").forEach(tr => {
    const nazev = tr.querySelector(".ep-nazev")?.value.trim();
    if (!nazev) return;
    polozky.push({
      id:                        tr.dataset.pid !== "new" ? parseInt(tr.dataset.pid) : null,
      nazev,
      mnozstvi:                  parseFloat(tr.querySelector(".ep-mnozstvi")?.value) || 1,
      jednotka:                  tr.querySelector(".ep-jednotka")?.value.trim() || "",
      cena_za_jednotku_s_dph:    parseFloat(tr.querySelector(".ep-cena")?.value) || 0,
      celkem_s_dph:              parseFloat(tr.querySelector(".ep-celkem")?.value) || 0,
    });
  });

  await api(`/api/faktury/${id}`, {
    method: "PUT",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({...hlavicka, polozky})
  });
  toast("Faktura uložena ✓");
  closeModal();
  loadFaktury();
}

async function saveStav(id) {
  const stav = document.getElementById("detailStav").value;
  await api(`/api/faktury/${id}/stav`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ stav })
  });
  toast("Stav uložen");
  closeModal();
  loadFaktury();
}

async function neniDuplicita(id) {
  await api(`/api/faktury/${id}`, {
    method: "PUT",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ duplicita_id: null })
  });
  toast("Označení duplicity odstraněno ✓");
  closeModal();
  loadFaktury();
}

async function presunDoSoukromych(id) {
  if (!confirm("Přesunout tuto fakturu do Soukromých výdajů?\nFaktura bude smazána ze seznamu faktur.")) return;
  let data;
  try { data = await api(`/api/faktury/${id}`); } catch { return; }
  const f = data.faktura;
  const polozky = (data.polozky || []).map(p => ({
    nazev: p.zbozi_nazev || p.nazev,
    castka: p.celkem_s_dph
  }));
  const payload = {
    firma_zkratka: f.firma_zkratka || "FP",
    dodavatel: f.dodavatel,
    datum: f.datum_vystaveni,
    datum_splatnosti: f.datum_splatnosti,
    castka: f.celkem_s_dph,
    zpusob_uhrady: f.zpusob_uhrady || "hotovost",
    stav: "zaplaceno",
    popis: `Přesunuto z faktur: ${f.cislo_faktury || f.dodavatel}`,
    zdroj: "faktura",
    typ: "soukrome",
    polozky
  };
  try {
    await api("/api/vydaje", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload) });
    await api(`/api/faktury/${id}`, { method: "DELETE" });
    toast("✅ Přesunuto do Soukromých výdajů");
    closeModal();
    loadFaktury();
  } catch(e) {
    toast("Chyba: " + e.message, true);
  }
}

async function deleteFaktura(id, zdroj) {
  const jeDrive = zdroj === "drive_auto";
  const msg = jeDrive
    ? "Smazat fakturu A resetovat Drive?\n\nPříště se znovu stáhne a zpracuje ze složky Drive."
    : "Opravdu smazat tuto fakturu?";
  if (!confirm(msg)) return;
  const url = jeDrive ? `/api/faktury/${id}?reset_drive=1` : `/api/faktury/${id}`;
  await api(url, { method: "DELETE" });
  toast("Faktura smazána" + (jeDrive ? " + Drive reset ✓" : ""));
  closeModal();
  loadFaktury();
}

async function potvrdFakturu(id) {
  await api(`/api/faktury/${id}/stav`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({stav:"ceka"})});
  toast("Faktura potvrzena ✓");
  loadFaktury();
}

async function premistFakturu(id) {
  openModal("Přemístit doklad", `
    <p style="color:var(--txt2);margin-bottom:1rem">Kam chceš přemístit tento doklad?</p>
    <div style="display:flex;flex-direction:column;gap:.5rem">
      <button class="btn btn-outline" onclick="_premistDo(${id},'vydaje','provozni')">💸 Výdaje (provozní)</button>
      <button class="btn btn-outline" onclick="_premistDo(${id},'vydaje','soukrome')">🏠 Soukromé výdaje</button>
    </div>
    <div style="text-align:right;margin-top:1rem">
      <button class="btn btn-secondary" onclick="closeModal()">Zrušit</button>
    </div>`);
}

async function _premistDo(id, sekce, typ) {
  try {
    // Načíst data faktury
    const data = await api(`/api/faktury/${id}`);
    // Uložit jako výdaj
    await api("/api/vydaje", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        firma_zkratka: data.firma_zkratka || "",
        dodavatel:     data.dodavatel || "",
        datum:         data.datum_vystaveni || "",
        castka:        data.celkem_s_dph || 0,
        zpusob_uhrady: "převodem",
        stav:          "nezaplaceno",
        popis:         data.cislo_faktury ? `FA ${data.cislo_faktury}` : "",
        soubor_url:    data.soubor_url || "",
        zdroj:         "drive_auto",
        typ:           typ,
        polozky:       [],
      })
    });
    // Smazat z faktur
    await api(`/api/faktury/${id}`, {method:"DELETE"});
    closeModal();
    toast(`Přemístěno do ${typ === 'soukrome' ? 'Soukromých výdajů' : 'Výdajů'} ✓`);
    loadFaktury();
  } catch(e) {
    toast("Chyba: " + e.message, true);
  }
}

async function smazatFakturu(id) {
  if (!confirm("Opravdu smazat tuto fakturu?")) return;
  await api(`/api/faktury/${id}`, { method: "DELETE" });
  toast("Faktura smazána ✓");
  loadFaktury();
}

function exportFaktury(fmt) {
  const params = new URLSearchParams({
    format: fmt,
    firma: document.getElementById("fFirma")?.value || "",
    stav:  document.getElementById("fStav")?.value  || "",
    od:    document.getElementById("fOd")?.value    || "",
    do:    document.getElementById("fDo")?.value    || "",
  });
  window.location.href = `/api/export/faktury?${params}`;
}

// ═══════════════════════════════════════════════════════════════
//  NAHRÁT FAKTURU (MAKRO)
// ═══════════════════════════════════════════════════════════════
let uploadedFilePath = null;

function renderNahrat() {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Nahrát fakturu (MAKRO)</h1>
      <button class="btn btn-secondary btn-sm" onclick="zkontrolovatDriveNyni()">☁️ Zkontrolovat Drive nyní</button>
    </div>
    <div id="driveCheckStatus" style="margin-bottom:.5rem;font-size:.9rem;color:var(--txt2)"></div>
    <div class="card" style="max-width:900px">
      <div class="form-group">
        <label class="form-label">Firma</label>
        <select id="nahratFirma" class="form-control" style="max-width:200px">
          ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
        </select>
      </div>

      <div style="display:flex;gap:.5rem;margin-bottom:1rem;border-bottom:2px solid var(--border);padding-bottom:0">
        <button id="tabPdf" class="tab-btn tab-active" onclick="switchTab('pdf')">📄 PDF soubor</button>
        <button id="tabText" class="tab-btn" onclick="switchTab('text');zkontrolovatDriveMobil()">📱 Z mobilu</button>
        <button id="tabHromadne" class="tab-btn" onclick="switchTab('hromadne')">📦 Hromadné nahrání</button>
        <button id="tabRucni" class="tab-btn" onclick="switchTab('rucni')">✏️ Ruční zadání</button>
      </div>

      <div id="tabPanelPdf">
        <div class="dropzone" id="dropzone">
          <div class="dropzone-icon">📂</div>
          <div class="dropzone-text">
            <strong>Přetáhněte sem soubor</strong> nebo klikněte pro výběr<br>
            <small>PDF (digitální faktura) nebo obrázek (fotka/sken) – max 50 MB</small>
          </div>
          <input type="file" id="fileInput" accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp">
        </div>
        <div id="uploadStatus" style="margin-top:1rem;color:var(--txt2);font-size:.9rem"></div>
      </div>

      <div id="tabPanelText" style="display:none">
        <div id="mobilDriveStatus" style="padding:1rem;font-size:.95rem;color:var(--txt2)">
          <span class="spinner"></span> Kontroluji Drive složku...
        </div>
      </div>

      <div id="tabPanelHromadne" style="display:none">
        <div class="dropzone" id="dropzoneHromadne">
          <div class="dropzone-icon">📦</div>
          <div class="dropzone-text">
            <strong>Přetáhněte více souborů najednou</strong> nebo klikněte pro výběr<br>
            <small>Každý soubor bude zpracován samostatně a uložen automaticky</small>
          </div>
          <input type="file" id="fileInputHromadne" accept=".pdf,.png,.jpg,.jpeg" multiple>
        </div>
        <div id="hromadneStatus" style="margin-top:1rem"></div>
      </div>

      <div id="parsedForm" style="display:none; margin-top:1.5rem;">
        <h3 style="font-family:var(--font-head);margin-bottom:1rem">Zkontrolujte a případně opravte</h3>
        <div class="grid-2" style="gap:1rem">
          <div class="form-group"><label class="form-label">Dodavatel</label><input id="pDodavatel" class="form-control" value="MAKRO Cash &amp; Carry ČR s.r.o."></div>
          <div class="form-group"><label class="form-label">Číslo faktury</label><input id="pCislo" class="form-control"></div>
          <div class="form-group"><label class="form-label">Datum vystavení</label><input type="date" id="pDatVys" class="form-control"></div>
          <div class="form-group"><label class="form-label">Datum splatnosti</label><input type="date" id="pDatSpl" class="form-control"></div>
        </div>
        <h4 style="font-family:var(--font-head);margin:1rem 0 .7rem">Položky</h4>
        <div class="table-wrap" style="overflow-x:auto">
          <table class="items-table" id="polozkyTable">
            <thead><tr><th>Název</th><th>Množství</th><th>Jednotka</th><th>Cena/jedn. s DPH</th><th>Celkem s DPH</th><th></th></tr></thead>
            <tbody id="polozkyBody"></tbody>
          </table>
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:.5rem" onclick="addPolozkaRow()">+ Přidat položku</button>
        <div style="margin-top:1rem;font-weight:600;font-size:1.05rem" id="totalSum"></div>
        <div class="btn-group" style="margin-top:1.2rem">
          <button class="btn btn-primary" onclick="ulozitFakturuMakro()">💾 Uložit fakturu</button>
        </div>
      </div>

      <div id="tabPanelRucni" style="display:none">
        <div class="grid-2" style="gap:1rem;margin-top:1rem">
          <div class="form-group"><label class="form-label">Dodavatel *</label><input id="rDodavatel" class="form-control" placeholder="Název firmy dodavatele"></div>
          <div class="form-group"><label class="form-label">Číslo faktury</label><input id="rCislo" class="form-control"></div>
          <div class="form-group"><label class="form-label">Způsob úhrady</label><input id="rUhrada" class="form-control" placeholder="převodem / hotově"></div>
          <div class="form-group"><label class="form-label">Datum vystavení</label><input type="date" id="rDatVys" class="form-control"></div>
          <div class="form-group"><label class="form-label">Datum splatnosti</label><input type="date" id="rDatSpl" class="form-control"></div>
          <div class="form-group"><label class="form-label">Stav</label>
            <select id="rStav" class="form-control">
              <option value="ceka">Čeká na zaplacení</option>
              <option value="zaplaceno">Zaplaceno</option>
            </select>
          </div>
          <div class="form-group"><label class="form-label">Příloha (volitelné)</label>
            <input type="file" id="rSoubor" class="form-control" accept=".pdf,.png,.jpg,.jpeg">
          </div>
        </div>
        <h4 style="font-family:var(--font-head);margin:1rem 0 .7rem">Položky</h4>
        <div class="table-wrap">
          <table class="items-table">
            <thead><tr><th>Název</th><th>Množství</th><th>Jednotka</th><th>Cena/jedn. s DPH</th><th>Celkem s DPH</th><th></th></tr></thead>
            <tbody id="rPolozkyBody">
              <tr>
                <td><input class="p-nazev" placeholder="Název položky"></td>
                <td><input class="p-mnozstvi" type="number" step="0.001" value="1" style="width:80px" oninput="rUpdateTotal();rCalcCelkem(this)"></td>
                <td><input class="p-jednotka" value="ks" style="width:55px"></td>
                <td><input class="p-cena-j" type="number" step="0.01" value="0" style="width:100px" oninput="rUpdateTotal();rCalcCelkem(this)"></td>
                <td><input class="p-celkem" type="number" step="0.01" value="0" style="width:110px" oninput="rUpdateTotal()"></td>
                <td><button class="remove-row" onclick="this.closest('tr').remove();rUpdateTotal()">✕</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <button class="btn btn-secondary btn-sm" style="margin-top:.5rem" onclick="rAddRow()">+ Přidat položku</button>
        <div style="margin-top:1rem;font-weight:600" id="rTotal"></div>
        <div class="btn-group" style="margin-top:1.2rem">
          <button class="btn btn-primary" onclick="ulozitRucni()">💾 Uložit fakturu</button>
        </div>
      </div>

    </div>`;

  setupDropzone();
  setupDropzoneHromadne();
  rUpdateTotal();
}

function renderSoukromeNahrat() {
  window._vydajTyp = "soukrome";
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Nahrát soukromý doklad</h1>
      <button class="btn btn-secondary btn-sm" onclick="renderVydaje('soukrome')">← Zpět</button>
    </div>
    <div class="card" style="max-width:900px">
      <div class="form-group">
        <label class="form-label">Lokace</label>
        <select id="soukrNahratLokace" class="form-control" style="max-width:200px">
          <option>Praha</option>
          <option>Třebovle</option>
          <option>UNI</option>
        </select>
      </div>

      <div style="display:flex;gap:.5rem;margin-bottom:1rem;border-bottom:2px solid var(--border);padding-bottom:0">
        <button id="soukrTabPdf" class="tab-btn tab-active" onclick="soukrSwitchTab('pdf')">📄 PDF / foto</button>
        <button id="soukrTabRucni" class="tab-btn" onclick="soukrSwitchTab('rucni')">✏️ Ruční zadání</button>
      </div>

      <div id="soukrTabPanelPdf">
        <div class="dropzone" id="soukrDropzone">
          <div class="dropzone-icon">🧾</div>
          <div class="dropzone-text">
            <strong>Přetáhněte foto nebo PDF dokladu</strong> nebo klikněte<br>
            <small>Doklad bude rozpoznán automaticky</small>
          </div>
          <input type="file" id="soukrFileInput" accept="image/*,.pdf">
        </div>
        <div id="soukrUploadStatus" style="margin-top:1rem;font-size:.9rem"></div>
      </div>

      <div id="soukrTabPanelRucni" style="display:none">
        <div class="grid-2" style="gap:1rem;margin-top:1rem">
          <div class="form-group"><label class="form-label">Dodavatel</label><input id="srDodavatel" class="form-control" placeholder="Název obchodu"></div>
          <div class="form-group"><label class="form-label">Datum</label><input type="date" id="srDatum" class="form-control" value="${new Date().toISOString().split('T')[0]}"></div>
          <div class="form-group"><label class="form-label">Částka (Kč) *</label><input type="number" step="0.01" id="srCastka" class="form-control"></div>
          <div class="form-group"><label class="form-label">Způsob úhrady</label>
            <select id="srUhrada" class="form-control">
              <option>hotovost</option><option>karta</option><option>převodem</option>
            </select>
          </div>
          <div class="form-group" style="grid-column:1/-1"><label class="form-label">Popis / účel</label><input id="srPopis" class="form-control" placeholder="Co to bylo?"></div>
          <div class="form-group" style="grid-column:1/-1"><label class="form-label">Poznámka</label><input id="srPoznamka" class="form-control"></div>
        </div>
        <div class="btn-group" style="margin-top:1.2rem">
          <button class="btn btn-primary" onclick="ulozitSoukromeRucni()">💾 Uložit doklad</button>
        </div>
      </div>

      <div id="soukrNahratForm" style="display:none;margin-top:1.5rem"></div>
    </div>`;

  // Dropzone setup
  const dz  = document.getElementById("soukrDropzone");
  const inp = document.getElementById("soukrFileInput");
  inp.style.display = "none";
  dz.addEventListener("click", () => inp.click());
  inp.addEventListener("change", () => { if (inp.files[0]) doSoukromeNahrat(inp.files[0]); });
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", e => {
    e.preventDefault(); dz.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) doSoukromeNahrat(e.dataTransfer.files[0]);
  });
}

function soukrSwitchTab(tab) {
  document.getElementById("soukrTabPanelPdf").style.display   = tab === "pdf"   ? "" : "none";
  document.getElementById("soukrTabPanelRucni").style.display = tab === "rucni" ? "" : "none";
  document.getElementById("soukrTabPdf").classList.toggle("tab-active",   tab === "pdf");
  document.getElementById("soukrTabRucni").classList.toggle("tab-active", tab === "rucni");
}

async function doSoukromeNahrat(file) {
  const statusEl = document.getElementById("soukrUploadStatus");
  statusEl.innerHTML = `<span class="spinner"></span> Zpracovávám doklad...`;
  const fd = new FormData();
  fd.append("soubor", file);
  fd.append("firma_zkratka", document.getElementById("soukrNahratLokace")?.value || "Praha");
  fd.append("typ", "soukrome");
  try {
    const data = await api("/api/vydaje/nahrat", { method:"POST", body:fd });
    statusEl.innerHTML = `✅ Doklad rozpoznán`;
    const formEl = document.getElementById("soukrNahratForm");
    if (formEl) { formEl.style.display = "block"; _renderVydajForm(formEl, data); }
  } catch(e) {
    statusEl.innerHTML = `❌ Chyba: ${e.message}`;
  }
}

async function ulozitSoukromeRucni() {
  const lokace = document.getElementById("soukrNahratLokace")?.value || "Praha";
  const castka = parseFloat(document.getElementById("srCastka")?.value || 0);
  if (!castka) { toast("Vyplň částku"); return; }
  const payload = {
    firma_zkratka: lokace,
    dodavatel:     document.getElementById("srDodavatel")?.value || "",
    datum:         document.getElementById("srDatum")?.value || "",
    castka,
    zpusob_uhrady: document.getElementById("srUhrada")?.value || "hotovost",
    popis:         document.getElementById("srPopis")?.value || "",
    poznamka:      document.getElementById("srPoznamka")?.value || "",
    stav:          "zaplaceno",
    zdroj:         "rucni",
    typ:           "soukrome",
    polozky:       []
  };
  await api("/api/vydaje", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
  toast("Doklad uložen ✓");
  renderVydaje("soukrome");
}

async function zkontrolovatDriveMobil() {
  const statusEl = document.getElementById("mobilDriveStatus");
  if (statusEl) statusEl.innerHTML = `<span class="spinner"></span> Kontroluji Drive složku...`;
  try {
    const res = await api("/api/drive-zkontrolovat", { method: "POST" });
    if (res.error) {
      if (statusEl) statusEl.innerHTML = `❌ Chyba: ${res.error}`;
      return;
    }
    const stazeno = res.stazeno || 0;
    const preskoceno = res.preskoceno || 0;
    const chyby = res.chyby || 0;
    let msg = stazeno > 0
      ? `✅ Staženo <strong>${stazeno}</strong> nových faktur`
      : `ℹ️ Žádné nové faktury`;
    if (preskoceno > 0) msg += ` &nbsp;|&nbsp; ⏭ ${preskoceno} přeskočeno (již zpracováno)`;
    if (chyby > 0) msg += ` &nbsp;|&nbsp; ⚠️ ${chyby} chyb`;
    if (statusEl) statusEl.innerHTML = msg;
    if (stazeno > 0) loadFaktury();
  } catch(e) {
    if (statusEl) statusEl.innerHTML = `❌ ${e.message}`;
  }
}

async function zkontrolovatDriveNyni() {
  const statusEl = document.getElementById("driveCheckStatus");
  if (statusEl) statusEl.innerHTML = `<span class="spinner"></span> Kontroluji Drive...`;
  try {
    const res = await api("/api/drive-zkontrolovat", { method: "POST" });
    if (res.error) { if (statusEl) statusEl.textContent = "✗ " + res.error; return; }
    if (statusEl) statusEl.textContent = `✅ Hotovo – staženo ${res.stazeno} souborů`;
  } catch(e) {
    if (statusEl) statusEl.textContent = "✗ " + e.message;
  }
}

function switchTab(tab) {
  ['pdf','text','hromadne','rucni'].forEach(t => {
    document.getElementById('tabPanel' + t.charAt(0).toUpperCase() + t.slice(1)).style.display = t === tab ? '' : 'none';
    document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle('tab-active', t === tab);
  });
  if (tab === 'rucni') rUpdateTotal();
}

async function zpracovatText() {
  const text = document.getElementById('textInput').value.trim();
  if (!text) { document.getElementById('textStatus').textContent = 'Vložte text faktury.'; return; }
  document.getElementById('textStatus').innerHTML = '<span class="spinner"></span> Zpracovávám...';
  try {
    const r = await fetch('/api/nahrat-text', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({text})
    });
    const data = await r.json();
    document.getElementById('textStatus').textContent = '✅ Zpracováno';
    naplnFormular(data);
  } catch(e) {
    document.getElementById('textStatus').textContent = '❌ Chyba: ' + e.message;
  }
}

function setupDropzoneHromadne() {
  const dz  = document.getElementById('dropzoneHromadne');
  const inp = document.getElementById('fileInputHromadne');
  if (!dz) return;
  dz.addEventListener('click', (e) => { if (e.target !== inp) inp.click(); });
  inp.addEventListener('change', () => { if (inp.files.length) hromadneNahrat(inp.files); });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('drag-over');
    if (e.dataTransfer.files.length) hromadneNahrat(e.dataTransfer.files);
  });
}

async function hromadneNahrat(files) {
  const firma = document.getElementById('nahratFirma').value;
  const statusEl = document.getElementById('hromadneStatus');
  statusEl.innerHTML = `<div>Zpracovávám ${files.length} soubor(ů)...</div>`;
  let ok = 0, err = 0;

  for (const file of Array.from(files)) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:.3rem 0;border-bottom:1px solid var(--border);font-size:.9rem';
    row.innerHTML = `<span class="spinner"></span> ${file.name}`;
    statusEl.appendChild(row);

    try {
      const fd = new FormData();
      fd.append('soubor', file);
      const r = await fetch('/api/nahrat', {method:'POST', body:fd});
      const data = await r.json();

      if (data.error && !data.soubor_cesta) {
        if (data.error.includes("Súpis tovaru")) {
          row.innerHTML = `<span style="color:var(--txt2)">⏭ ${file.name} – přeskočeno (Súpis tovaru)</span>`;
        } else {
          row.innerHTML = `❌ ${file.name} – ${data.error}`; err++;
        }
        continue;
      }

       if (data.duplicita) {
          // Uložit jako duplikát s odkazem na původní fakturu
          const dupPayload = {
            firma_zkratka: firma,
            dodavatel:     data.dodavatel || 'MAKRO Cash & Carry ČR s.r.o.',
            cislo_faktury: data.cislo_faktury || '',
            datum_vystaveni: data.datum_vystaveni || '',
            datum_splatnosti: data.datum_splatnosti || '',
            zpusob_uhrady: 'Hotovost',
            stav:          'duplikat',
            celkem_s_dph:  data.celkem_s_dph || 0,
            soubor_cesta:  data.soubor_cesta || '',
            soubor_url:    data.soubor_gcs_url || '',
            zdroj:         'makro',
            duplicita_id:  data.duplicita.id,
            polozky:       data.polozky || []
          };
          await api("/api/faktury", {
            method: "POST",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify(dupPayload)
          });
          row.innerHTML = `⚠️ ${file.name} – <span style="color:orange">duplikát faktury #${data.duplicita.id} (${data.duplicita.firma}, ${czDate(data.duplicita.datum)}, ${czMoneyFull(data.duplicita.celkem)}) — uloženo jako duplikát</span>`;
          ok++;
          continue;
        }

      const payload = {
        firma_zkratka: firma,
        dodavatel:     data.dodavatel || 'MAKRO Cash & Carry ČR s.r.o.',
        cislo_faktury: data.cislo_faktury || '',
        datum_vystaveni: data.datum_vystaveni || '',
        datum_splatnosti: data.datum_splatnosti || '',
        zpusob_uhrady: 'Hotovost',
        stav:          'zaplaceno',
        celkem_s_dph:  data.celkem_s_dph || 0,
        soubor_cesta:  data.soubor_cesta || '',
        soubor_url:    data.soubor_gcs_url || '',
        zdroj:         'makro',
        polozky:       data.polozky || []
      };
      await api('/api/faktury', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
      row.innerHTML = `✅ ${file.name} – uloženo (${(data.polozky||[]).length} položek, ${czMoneyFull(data.celkem_s_dph)})`;
      ok++;
    } catch(e) {
      row.innerHTML = `❌ ${file.name} – ${e.message}`; err++;
    }
  }
  statusEl.insertAdjacentHTML('afterbegin', `<div style="font-weight:600;margin-bottom:.5rem">Hotovo: ${ok} uloženo, ${err} chyb</div>`);
}

function setupDropzone() {
  const dz   = document.getElementById("dropzone");
  const inp  = document.getElementById("fileInput");

  dz.addEventListener("click", (e) => { if (e.target !== inp) inp.click(); });
  inp.addEventListener("change", () => { if (inp.files[0]) uploadFile(inp.files[0]); });

  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", e => {
    e.preventDefault(); dz.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
  });

  document.addEventListener("paste", handlePaste);
}

function handlePaste(e) {
  const panel = document.getElementById("tabPanelPdf");
  if (!panel || panel.style.display === "none") return;

  const items = (e.clipboardData || e.originalEvent.clipboardData).items;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        document.getElementById("uploadStatus").innerHTML =
          `<span class="spinner"></span> Zpracovávám obrázek ze schránky…`;
        uploadFile(file);
      }
      break;
    }
  }
}

async function uploadFile(file) {
  document.getElementById("uploadStatus").innerHTML = `<span class="spinner"></span> Nahrávám a zpracovávám…`;
  const fd = new FormData();
  fd.append("soubor", file);
  fd.append("typ_dokladu", "doklad");

  let data;
  try {
    const r = await fetch("/api/nahrat", { method: "POST", body: fd });
    data = await r.json();
  } catch (e) {
    document.getElementById("uploadStatus").textContent = "Chyba při nahrávání: " + e.message;
    return;
  }

  if (data.error && !data.soubor_cesta) {
    document.getElementById("uploadStatus").textContent = "❌ Chyba: " + data.error;
    return;
  }

  document.getElementById("uploadStatus").innerHTML = data.error ?
    `⚠ Soubor nahrán, ale parsování se nepodařilo (${data.error}). Vyplňte ručně.` :
    `✅ Soubor úspěšně zpracován`;

  uploadedFilePath = data.soubor_cesta || "";
  const formVisible = document.getElementById("parsedForm") &&
    document.getElementById("parsedForm").style.display !== "none";
  naplnFormular(data, formVisible);
}

async function naplnFormular(data, appendMode = false) {
  const formVisible = document.getElementById("parsedForm").style.display !== "none";

  if (appendMode && formVisible) {
    const newItems = data.polozky || [];
    if (newItems.length === 0) {
      toast("Na druhé stránce nebyly nalezeny žádné položky.", true);
      return;
    }
    newItems.forEach(p => appendPolozkaRow(p));
    updateTotal();

    const info = document.createElement("div");
    info.style.cssText = "background:#d1fae5;border:1px solid #6ee7b7;border-radius:6px;padding:.5rem 1rem;margin-bottom:.5rem;font-size:.9rem;color:#065f46";
    info.textContent = `✅ Přidáno ${newItems.length} položek z druhé strany faktury`;
    document.getElementById("parsedForm").insertAdjacentElement("afterbegin", info);
    setTimeout(() => info.remove(), 4000);
    return;
  }

  document.getElementById("parsedForm").style.display = "block";
  document.getElementById("pDodavatel").value = data.dodavatel || "MAKRO Cash & Carry ČR s.r.o.";
  document.getElementById("pCislo").value     = data.cislo_faktury || "";
  document.getElementById("pDatVys").value    = data.datum_vystaveni || "";
  document.getElementById("pDatSpl").value    = data.datum_splatnosti || "";

  if (data.firma_zkratka) {
    const sel = document.getElementById("nahratFirma");
    for (const opt of sel.options) {
      if (opt.value === data.firma_zkratka) { sel.value = data.firma_zkratka; break; }
    }
  }

  const dupEl = document.getElementById("duplicitaWarning");
  if (dupEl) dupEl.remove();
  if (data.duplicita) {
    // Automaticky uložit jako duplikát bez zobrazení formuláře
    const firma = document.getElementById("nahratFirma")?.value || data.firma_zkratka || "";
    const dupPayload = {
      firma_zkratka:   firma,
      dodavatel:       data.dodavatel || "MAKRO Cash & Carry ČR s.r.o.",
      cislo_faktury:   data.cislo_faktury || "",
      datum_vystaveni: data.datum_vystaveni || "",
      datum_splatnosti:data.datum_splatnosti || "",
      zpusob_uhrady:   "Hotovost",
      stav:            "duplikat",
      celkem_s_dph:    data.celkem_s_dph || 0,
      soubor_cesta:    data.soubor_cesta || "",
      soubor_url:      data.soubor_gcs_url || "",
      zdroj:           "makro",
      duplicita_id:    data.duplicita.id,
      polozky:         data.polozky || []
    };
    await api("/api/faktury", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(dupPayload) });
    document.getElementById("parsedForm").style.display = "none";
    const statusDiv = document.getElementById("nahratStatus") || document.createElement("div");
    statusDiv.id = "nahratStatus";
    statusDiv.style.cssText = "background:#fee2e2;border:2px solid #ef4444;border-radius:6px;padding:.7rem 1rem;margin-top:1rem;color:#991b1b;font-size:.9rem";
    statusDiv.innerHTML = `🚨 <strong>DUPLIKÁT uložen!</strong> Faktura č. <strong>${data.cislo_faktury}</strong> je duplikát faktury #${data.duplicita.id} (${data.duplicita.firma}, ${czDate(data.duplicita.datum)}, ${czMoneyFull(data.duplicita.celkem)}). Uložena s označením duplikátu.`;
    document.querySelector(".dropzone")?.insertAdjacentElement("afterend", statusDiv);
    uploadedFilePath = null;
    return;
  }

  const tbody = document.getElementById("polozkyBody");
  tbody.innerHTML = "";
  (data.polozky || []).forEach(p => appendPolozkaRow(p, data.ocr_kontrola));
  updateTotal();

  const kontrolaEl = document.getElementById("ocrKontrola");
  if (kontrolaEl) kontrolaEl.remove();
  if (data.ocr_kontrola) {
    zobrazOcrKontrolu(data.ocr_kontrola);
  }
}

function zobrazOcrKontrolu(k) {
  const suma = k.suma_polozek;
  const ocr_bez = k.ocr_bez_dph || 0;
  const maCelkem = k.ma_celkem;
  const pocetPodezrelych = (k.podezrele_indexy || []).length;

  const div = document.createElement("div");
  div.id = "ocrKontrola";
  div.dataset.ocrBezDph = ocr_bez;
  div.style.cssText = "border-radius:8px;padding:.8rem 1rem;margin-bottom:1rem;font-size:.9rem;";

  if (maCelkem) {
    const ocekavano = ocr_bez * 1.20;
    const rozdil = Math.abs(suma - ocekavano);
    const ok = rozdil < ocekavano * 0.05;
    if (ok && pocetPodezrelych === 0) {
      div.style.cssText += "background:#d1fae5;border:1px solid #6ee7b7;color:#065f46";
      div.innerHTML = `✅ <strong>Vše sedí!</strong> Součet ${czMoneyFull(suma)} odpovídá faktuře (bez DPH: ${czMoneyFull(ocr_bez)})`;
    } else {
      div.style.cssText += "background:#fef3c7;border:1px solid #fbbf24;color:#92400e";
      div.innerHTML = `⚠️ <strong>Zkontroluj!</strong> Součet položek: <strong>${czMoneyFull(suma)}</strong> &nbsp;|&nbsp; Faktura bez DPH: <strong>${czMoneyFull(ocr_bez)}</strong>
        ${pocetPodezrelych > 0 ? `<br><small>🔴 ${pocetPodezrelych} položka/položky označeny červeně – zkontroluj je</small>` : ""}`;
    }
  } else if (pocetPodezrelych > 0) {
    div.style.cssText += "background:#fef3c7;border:1px solid #fbbf24;color:#92400e";
    div.innerHTML = `⚠️ <strong>${pocetPodezrelych} podezřelá položka</strong> označena červeně – zkontroluj ji před uložením`;
  } else {
    div.style.cssText += "background:#f0fdf4;border:1px solid #86efac;color:#166534";
    div.innerHTML = `✅ <strong>Načteno bez zjevných chyb</strong> – zkontroluj a ulož`;
  }

  document.getElementById("parsedForm").insertAdjacentElement("afterbegin", div);
}

function appendPolozkaRow(p = {}, kontrola = null) {
  const tr = document.createElement("tr");
  const podezrela = (p.celkem_s_dph === 0 || p.celkem_s_dph == null ||
                     p.mnozstvi > 500 || p.mnozstvi <= 0);
  if (podezrela) {
    tr.style.background = "rgba(239,68,68,0.08)";
    tr.title = "⚠️ Tato položka vypadá podezřele – zkontroluj ji";
  }
  tr.innerHTML = `
    <td><input class="p-nazev" value="${escHtml(p.nazev||"")}" style="${podezrela ? "border-color:#ef4444;color:#b91c1c" : ""}"></td>
    <td><input class="p-mnozstvi" type="number" step="0.001" value="${p.mnozstvi||1}" style="width:80px${podezrela ? ";border-color:#ef4444" : ""}" oninput="updateTotal()"></td>
    <td><input class="p-jednotka" value="${p.jednotka||"ks"}" style="width:55px"></td>
    <td><input class="p-cena-j" type="number" step="0.01" value="${p.cena_za_jednotku_s_dph||0}" style="width:100px${podezrela ? ";border-color:#ef4444" : ""}" oninput="updateTotal()"></td>
    <td><input class="p-celkem" type="number" step="0.01" value="${p.celkem_s_dph||0}" style="width:110px${podezrela ? ";border-color:#ef4444" : ""}" oninput="updateTotal()"></td>
    <td><button class="remove-row" onclick="this.closest('tr').remove();updateTotal()">✕</button></td>`;
  document.getElementById("polozkyBody").appendChild(tr);
}

function addPolozkaRow() { appendPolozkaRow(); }

function updateTotal() {
  let t = 0;
  document.querySelectorAll("#polozkyBody tr").forEach(tr => {
    t += parseFloat(tr.querySelector(".p-celkem")?.value || 0);
  });
  const el = document.getElementById("totalSum");
  if (el) el.textContent = "Celkem s DPH: " + czMoney(t);

  const k = document.getElementById("ocrKontrola");
  if (k && k.dataset.ocrBezDph) {
    const ocr_bez = parseFloat(k.dataset.ocrBezDph);
    const ocekavano = ocr_bez * 1.20;
    const rozdil = Math.abs(t - ocekavano);
    const ok = rozdil < ocekavano * 0.05;
    if (ok) {
      k.style.background = "#d1fae5"; k.style.border = "1px solid #6ee7b7"; k.style.color = "#065f46";
      k.innerHTML = `✅ <strong>Částka sedí</strong> – součet ${czMoney(t)} odpovídá faktuře`;
    } else {
      k.style.background = "#fef3c7"; k.style.border = "1px solid #fbbf24"; k.style.color = "#92400e";
      k.innerHTML = `⚠️ <strong>Zkontroluj!</strong> Součet: <strong>${czMoneyFull(t)}</strong> &nbsp;|&nbsp; Faktura bez DPH: <strong>${czMoneyFull(ocr_bez)}</strong>`;
    }
  }
}

async function ulozitFakturuMakro() {
  const polozky = [];
  document.querySelectorAll("#polozkyBody tr").forEach(tr => {
    const nazev = tr.querySelector(".p-nazev")?.value.trim();
    if (!nazev) return;
    polozky.push({
      nazev,
      mnozstvi: parseFloat(tr.querySelector(".p-mnozstvi")?.value || 1),
      jednotka: tr.querySelector(".p-jednotka")?.value || "ks",
      cena_za_jednotku_s_dph: parseFloat(tr.querySelector(".p-cena-j")?.value || 0),
      celkem_s_dph: parseFloat(tr.querySelector(".p-celkem")?.value || 0),
    });
  });

  const payload = {
    firma_zkratka: document.getElementById("nahratFirma").value,
    dodavatel:     document.getElementById("pDodavatel").value,
    cislo_faktury: document.getElementById("pCislo").value,
    datum_vystaveni: document.getElementById("pDatVys").value,
    datum_splatnosti: document.getElementById("pDatSpl").value,
    zpusob_uhrady: "Hotovost",
    stav:          "zaplaceno",
    soubor_cesta:  uploadedFilePath || "",
    zdroj:         "makro",
    polozky,
  };

  // Pokud je duplikát, přidej odkaz na originál
  const dupWarn = document.getElementById("duplicitaWarning");
  if (dupWarn?.dataset.duplicitaId) {
    payload.duplicita_id = parseInt(dupWarn.dataset.duplicitaId);
    payload.stav = "duplikat";
  }

  const res = await api("/api/faktury", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  toast("Faktura uložena ✓");
  uploadedFilePath = null;
  navigateTo("faktury");
}

// ═══════════════════════════════════════════════════════════════
//  RUČNÍ ZADÁNÍ
// ═══════════════════════════════════════════════════════════════
function renderRucni() {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header"><h1 class="page-title">Ruční zadání faktury</h1></div>
    <div class="card" style="max-width:860px">
      <div class="grid-2" style="gap:1rem">
        <div class="form-group"><label class="form-label">Firma *</label>
          <select id="rFirma" class="form-control">
            ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
          </select>
        </div>
        <div class="form-group"><label class="form-label">Dodavatel *</label><input id="rDodavatel" class="form-control" placeholder="Název firmy dodavatele"></div>
        <div class="form-group"><label class="form-label">Číslo faktury</label><input id="rCislo" class="form-control"></div>
        <div class="form-group"><label class="form-label">Způsob úhrady</label><input id="rUhrada" class="form-control" placeholder="převodem / hotově"></div>
        <div class="form-group"><label class="form-label">Datum vystavení</label><input type="date" id="rDatVys" class="form-control"></div>
        <div class="form-group"><label class="form-label">Datum splatnosti</label><input type="date" id="rDatSpl" class="form-control"></div>
        <div class="form-group"><label class="form-label">Stav</label>
          <select id="rStav" class="form-control">
            <option value="ceka">Čeká na zaplacení</option>
            <option value="zaplaceno">Zaplaceno</option>
          </select>
        </div>
        <div class="form-group"><label class="form-label">Příloha (volitelné)</label>
          <input type="file" id="rSoubor" class="form-control" accept=".pdf,.png,.jpg,.jpeg">
        </div>
      </div>
      <h4 style="font-family:var(--font-head);margin:1rem 0 .7rem">Položky</h4>
      <div class="table-wrap">
        <table class="items-table">
          <thead><tr><th>Název</th><th>Množství</th><th>Jednotka</th><th>Cena/jedn. s DPH</th><th>Celkem s DPH</th><th></th></tr></thead>
          <tbody id="rPolozkyBody">
            <tr>
              <td><input class="p-nazev" placeholder="Název položky"></td>
              <td><input class="p-mnozstvi" type="number" step="0.001" value="1" style="width:80px" oninput="rUpdateTotal();rCalcCena(this)"></td>
              <td><input class="p-jednotka" value="ks" style="width:55px"></td>
              <td><input class="p-cena-j" type="number" step="0.01" value="0" style="width:100px" oninput="rUpdateTotal();rCalcCelkem(this)"></td>
              <td><input class="p-celkem" type="number" step="0.01" value="0" style="width:110px" oninput="rUpdateTotal()"></td>
              <td><button class="remove-row" onclick="this.closest('tr').remove();rUpdateTotal()">✕</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <button class="btn btn-secondary btn-sm" style="margin-top:.5rem" onclick="rAddRow()">+ Přidat položku</button>
      <div style="margin-top:1rem;font-weight:600" id="rTotal"></div>
      <div class="btn-group" style="margin-top:1.2rem">
        <button class="btn btn-primary" onclick="ulozitRucni()">💾 Uložit fakturu</button>
        <button class="btn btn-secondary" onclick="navigateTo('faktury')">Zrušit</button>
      </div>
    </div>`;
  rUpdateTotal();
}

function rAddRow() {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="p-nazev" placeholder="Název položky"></td>
    <td><input class="p-mnozstvi" type="number" step="0.001" value="1" style="width:80px" oninput="rUpdateTotal();rCalcCelkem(this)"></td>
    <td><input class="p-jednotka" value="ks" style="width:55px"></td>
    <td><input class="p-cena-j" type="number" step="0.01" value="0" style="width:100px" oninput="rUpdateTotal();rCalcCelkem(this)"></td>
    <td><input class="p-celkem" type="number" step="0.01" value="0" style="width:110px" oninput="rUpdateTotal()"></td>
    <td><button class="remove-row" onclick="this.closest('tr').remove();rUpdateTotal()">✕</button></td>`;
  document.getElementById("rPolozkyBody").appendChild(tr);
}

function rCalcCelkem(inp) {
  const tr = inp.closest("tr");
  const mn = parseFloat(tr.querySelector(".p-mnozstvi").value||1);
  const cj = parseFloat(tr.querySelector(".p-cena-j").value||0);
  tr.querySelector(".p-celkem").value = (mn*cj).toFixed(2);
  rUpdateTotal();
}
function rCalcCena(inp) {
  const tr = inp.closest("tr");
  const mn = parseFloat(tr.querySelector(".p-mnozstvi").value||1);
  const ce = parseFloat(tr.querySelector(".p-celkem").value||0);
  if (mn) tr.querySelector(".p-cena-j").value = (ce/mn).toFixed(4);
  rUpdateTotal();
}

function rUpdateTotal() {
  let t = 0;
  document.querySelectorAll("#rPolozkyBody tr").forEach(tr => {
    t += parseFloat(tr.querySelector(".p-celkem")?.value || 0);
  });
  const el = document.getElementById("rTotal");
  if (el) el.textContent = "Celkem s DPH: " + czMoney(t);
}

async function ulozitRucni() {
  const dodavatel = document.getElementById("rDodavatel").value.trim();
  if (!dodavatel) { toast("Vyplňte dodavatele", true); return; }

  let soubor_cesta = "";
  const soubFile = document.getElementById("rSoubor").files[0];
  if (soubFile) {
    const fd = new FormData(); fd.append("soubor", soubFile);
    try {
      const r = await fetch("/api/nahrat", { method:"POST", body:fd });
      const d = await r.json();
      soubor_cesta = d.soubor_cesta || "";
    } catch(e) { toast("Chyba nahrávání přílohy: " + e.message, true); }
  }

  const polozky = [];
  document.querySelectorAll("#rPolozkyBody tr").forEach(tr => {
    const nazev = tr.querySelector(".p-nazev")?.value.trim();
    if (!nazev) return;
    polozky.push({
      nazev,
      mnozstvi: parseFloat(tr.querySelector(".p-mnozstvi")?.value||1),
      jednotka: tr.querySelector(".p-jednotka")?.value||"ks",
      cena_za_jednotku_s_dph: parseFloat(tr.querySelector(".p-cena-j")?.value||0),
      celkem_s_dph: parseFloat(tr.querySelector(".p-celkem")?.value||0),
    });
  });

  const payload = {
    firma_zkratka: document.getElementById("rFirma").value,
    dodavatel,
    cislo_faktury: document.getElementById("rCislo").value,
    datum_vystaveni: document.getElementById("rDatVys").value,
    datum_splatnosti: document.getElementById("rDatSpl").value,
    zpusob_uhrady: document.getElementById("rUhrada").value,
    stav: document.getElementById("rStav").value,
    soubor_cesta,
    zdroj: "rucni",
    polozky,
  };

  await api("/api/faktury", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  toast("Faktura uložena ✓");
  navigateTo("faktury");
}

// ═══════════════════════════════════════════════════════════════
//  ZBOŽÍ / POLOŽKY
// ═══════════════════════════════════════════════════════════════
async function renderPolozky() {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Přehled zboží</h1>
      <div class="btn-group">
        <button class="btn btn-secondary btn-sm" onclick="exportPolozky('xlsx')">⬇ Excel</button>
        <button class="btn btn-secondary btn-sm" onclick="exportPolozky('csv')">⬇ CSV</button>
      </div>
    </div>
    <div class="filters">
      <label>Firma:</label>
      <select id="pFirma" class="firma-select">
        <option value="">Všechny</option>
        ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
      </select>
      <label>Od:</label><input type="date" id="pOd">
      <label>Do:</label><input type="date" id="pDo">
      <label>Rok:</label>
      <select id="pRok" onchange="aplikujRokFiltr('pRok','pOd','pDo',loadPolozky)">
        ${rokOptions(new Date().getFullYear())}
      </select>
    </div>
    <div class="card">
      <div class="table-wrap" id="polozkyList"><div class="loading-center"><span class="spinner"></span></div></div>
    </div>`;

  aplikujRokFiltr('pRok','pOd','pDo', null);
  loadPolozky();
  ["pFirma","pRok","pOd","pDo"].forEach(id => {
    document.getElementById(id)?.addEventListener("change", loadPolozky);
  });
}

async function loadPolozky() {
  const params = new URLSearchParams({
    firma: document.getElementById("pFirma")?.value||"",
    od:    document.getElementById("pOd")?.value||"",
    do:    document.getElementById("pDo")?.value||"",
  });
  let rows;
  try { rows = await api(`/api/polozky?${params}`); } catch { return; }
  App.polozkyData = rows;
  renderPolozkyTable();
}

function sortPolozky(col) {
  if (App.polozkySort.col === col) {
    App.polozkySort.asc = !App.polozkySort.asc;
  } else {
    App.polozkySort.col = col;
    App.polozkySort.asc = false;
  }
  renderPolozkyTable();
}

function renderPolozkyTable() {
  const el = document.getElementById("polozkyList");
  if (!el) return;

  const { col, asc } = App.polozkySort;
  const numCols = ["celkove_mnozstvi","celkem_utraceno","prumerna_cena","pocet_nakupu"];

  // Seskupit položky podle skupiny (alias)
  const skupiny = {};
  const bezSkupiny = [];
  App.polozkyData.forEach(r => {
    if (r.skupina) {
      if (!skupiny[r.skupina]) skupiny[r.skupina] = [];
      skupiny[r.skupina].push(r);
    } else {
      bezSkupiny.push(r);
    }
  });

  // Vytvořit agregované řádky pro skupiny
  const skupinyRows = Object.entries(skupiny).map(([nazev, items]) => ({
    _skupina: true,
    _items: items,
    zbozi_nazev: nazev,
    zbozi_id: null,
    jednotka: items[0]?.jednotka || "",
    celkove_mnozstvi: items.reduce((s,i) => s + parseFloat(i.celkove_mnozstvi||0), 0),
    celkem_utraceno:  items.reduce((s,i) => s + parseFloat(i.celkem_utraceno||0), 0),
    prumerna_cena:    items.reduce((s,i) => s + parseFloat(i.prumerna_cena||0), 0) / items.length,
    pocet_nakupu:     items.reduce((s,i) => s + parseInt(i.pocet_nakupu||0), 0),
    dodavatele:       [...new Set(items.flatMap(i => (i.dodavatele||"").split(", ")))].filter(Boolean).join(", "),
    _pocet_polozek:   items.length,
  }));

  // Seřadit skupiny a položky bez skupiny zvlášť, skupiny vždy nahoře
  const sortFn = (a, b) => {
    let va = a[col], vb = b[col];
    if (numCols.includes(col)) {
      va = parseFloat(va) || 0;
      vb = parseFloat(vb) || 0;
    } else {
      if (typeof va === "string") va = va.toLowerCase();
      if (typeof vb === "string") vb = vb.toLowerCase();
    }
    if (va < vb) return asc ? -1 : 1;
    if (va > vb) return asc ? 1 : -1;
    return 0;
  };
  skupinyRows.sort(sortFn);
  bezSkupiny.sort(sortFn);
  // Skupiny a položky dohromady, seřazené stejně
  const allRows = [...skupinyRows, ...bezSkupiny];
  allRows.sort(sortFn);

  const renderRow = (r, indent) => {
      if (r._skupina) {
        const firstItem = r._items[0];
        return `
          <tr class="zbozi-skupina" style="cursor:pointer" onclick="openSkupinaDetail('${escHtml(r.zbozi_nazev)}')">
            <td><strong>${escHtml(r.zbozi_nazev)}</strong></td>
            <td style="text-align:center">${r.pocet_nakupu}</td>
            <td>${Number(r.celkove_mnozstvi).toLocaleString("cs-CZ")}</td>
            <td>${r.jednotka}</td>
            <td>${czMoney(r.prumerna_cena)}</td>
            <td><strong>${czMoney(r.celkem_utraceno)}</strong></td>
            <td style="font-size:.82rem;color:var(--txt2)">${escHtml(r.dodavatele||"")}</td>
          </tr>`;
      }
    return `
      <tr class="zbozi-row" data-id="${r.zbozi_id||""}" data-nazev="${escHtml(r.zbozi_nazev)}">
        <td><strong>${escHtml(r.zbozi_nazev)}</strong></td>
        <td style="text-align:center">${r.pocet_nakupu}</td>
        <td>${Number(r.celkove_mnozstvi).toLocaleString("cs-CZ")}</td>
        <td>${r.jednotka}</td>
        <td>${czMoney(r.prumerna_cena)}</td>
        <td><strong>${czMoney(r.celkem_utraceno)}</strong></td>
        <td style="font-size:.82rem;color:var(--txt2)">${escHtml(r.dodavatele||"")}</td>
      </tr>`;
  };

  el.innerHTML = `
    <table>
      <thead><tr>
        ${th("zbozi_nazev","Název")}
        ${th("pocet_nakupu","Počet nákupů")}
        ${th("celkove_mnozstvi","Celkem ks/kg")}
        ${th("jednotka","Jednotka")}
        ${th("prumerna_cena","Průměrná cena/jedn.")}
        ${th("celkem_utraceno","Celkem s DPH")}
        ${th("dodavatele","Dodavatelé")}
      </tr></thead>
      <tbody>
        ${allRows.map(r => renderRow(r)).join("") ||
          "<tr><td colspan='7' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné položky</td></tr>"}
      </tbody>
    </table>`;

  document.querySelectorAll(".zbozi-row").forEach(r => {
    r.addEventListener("click", () => {
      if (r.dataset.id) openZboziDetail(r.dataset.id, r.dataset.nazev);
    });
  });
}

function toggleSkupina(nazev) {
  const cls = "zbozi-child-" + nazev.replace(/\s+/g, "_");
  document.querySelectorAll("." + CSS.escape(cls)).forEach(tr => {
    tr.style.display = tr.style.display === "none" ? "" : "none";
  });
}
async function openSkupinaDetail(alias) {
  let data;
  try { data = await api(`/api/zbozi/alias-detail/${encodeURIComponent(alias)}`); } catch { return; }

  const body = `
    <h4 style="margin-bottom:.5rem">${escHtml(alias)}</h4>
    <div style="margin-bottom:1rem;font-size:.82rem;color:var(--txt2)">Všechny nákupy pod tímto aliasem</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Datum</th><th>Položka</th><th>Dodavatel</th><th>Firma</th><th>Množství</th><th>Cena/jedn.</th><th>Celkem</th></tr></thead>
        <tbody>
          ${data.nakupy.map(n => `
            <tr>
              <td>${czDate(n.datum_vystaveni)}</td>
              <td style="font-size:.85rem;color:var(--txt2)">${escHtml(n.nazev_canonical||n.nazev||"")}</td>
              <td>${escHtml(n.dodavatel)}</td>
              <td>${n.firma_zkratka}</td>
              <td>${Number(n.mnozstvi).toLocaleString("cs-CZ")} ${n.jednotka}</td>
              <td>${czMoney(n.cena_za_jednotku_s_dph)}</td>
              <td><strong>${czMoney(n.celkem_s_dph)}</strong></td>
            </tr>`).join("") || "<tr><td colspan='7' style='text-align:center;color:var(--txt2)'>Žádné nákupy</td></tr>"}
        </tbody>
      </table>
    </div>`;

  openModal(`Skupina: ${escHtml(alias)}`, body);
}
async function openZboziDetail(zbozi_id, nazev) {
  let data;
  try { data = await api(`/api/polozky/detail/${zbozi_id}`); } catch { return; }

  const body = `
    <h4 style="margin-bottom:.5rem">${escHtml(data.zbozi.nazev_canonical)}</h4>
    <div class="alias-list" id="aliasContainer">
      ${data.aliasy.map(a => `<span class="alias-tag">${escHtml(a)} <span style="cursor:pointer;margin-left:.3rem;color:#999" onclick="smazatAlias(${zbozi_id},'${escHtml(a)}',this)">✕</span></span>`).join("")}
    </div>
    <div style="margin-top:1rem; display:flex; gap:.5rem; flex-wrap:wrap;">
      <div style="position:relative;max-width:250px">
        <input id="newAlias" class="form-control" placeholder="Nový alias (alternativní název)"
          oninput="naseptavacAlias(this)" autocomplete="off">
        <div id="naseptavacAliasBox" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--card-bg,#fff);border:1px solid var(--border);border-radius:6px;z-index:200;max-height:160px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1)"></div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="addAlias(${zbozi_id})">+ Přidat alias</button>
    </div>
    <hr style="margin:1rem 0; border-color:var(--border)">
    <h4 style="font-family:var(--font-head);margin-bottom:.7rem">Historie nákupů</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Datum</th><th>Dodavatel</th><th>Firma</th><th>Množství</th><th>Cena/jedn.</th><th>Celkem</th><th></th></tr></thead>
        <tbody>
          ${data.nakupy.map(n => `
            <tr>
              <td>${czDate(n.datum_vystaveni)}</td>
              <td>${escHtml(n.dodavatel)}</td>
              <td>${n.firma_zkratka}</td>
              <td>${Number(n.mnozstvi).toLocaleString("cs-CZ")} ${n.jednotka}</td>
              <td>${czMoney(n.cena_za_jednotku_s_dph)}</td>
              <td><strong>${czMoney(n.celkem_s_dph)}</strong></td>
              <td style="white-space:nowrap">
                ${n.soubor_url ? `<a href="${n.soubor_url}" target="_blank" class="btn btn-secondary btn-sm" title="Zobrazit originál">📎</a>` : ""}
                <button class="btn btn-secondary btn-sm" onclick="closeModal();navigujNaFakturu(${n.faktura_id})" title="Přejít na fakturu">🧾</button>
              </td>
            </tr>`).join("") || "<tr><td colspan='7' style='text-align:center;color:var(--txt2)'>Žádné nákupy</td></tr>"}
        </tbody>
      </table>
    </div>`;

  openModal(`Detail zboží: ${escHtml(nazev)}`, body);
}

let _aliasNasTimer = null;
async function naseptavacAlias(input) {
  clearTimeout(_aliasNasTimer);
  const box = document.getElementById("naseptavacAliasBox");
  const q = input.value.trim();
  if (!box) return;
  if (q.length < 1) { box.style.display = "none"; return; }
  _aliasNasTimer = setTimeout(async () => {
    try {
      const data = await api("/api/zbozi/aliasy-seznam?q=" + encodeURIComponent(q));
      if (!data.length) { box.style.display = "none"; return; }
      box.innerHTML = data.map(a =>
        `<div style="padding:.4rem .7rem;cursor:pointer;font-size:.85rem;border-bottom:0.5px solid var(--border)"
          onmousedown="document.getElementById('newAlias').value='${escHtml(a)}';document.getElementById('naseptavacAliasBox').style.display='none'"
          >${escHtml(a)}</div>`
      ).join("");
      box.style.display = "";
    } catch { box.style.display = "none"; }
  }, 200);
}

async function smazatAlias(zbozi_id, alias, el) {
  try {
    await api(`/api/zbozi/alias/${zbozi_id}/${encodeURIComponent(alias)}`, {method:"DELETE"});
    const tag = el.closest(".alias-tag");
    if (tag) tag.remove();
    const container = document.getElementById("aliasContainer");
    if (container && !container.querySelector(".alias-tag")) {
      container.innerHTML = '<span style="color:var(--txt2);font-size:.85rem">Žádné aliasy</span>';
    }
    toast("Alias smazán ✓");
    loadPolozky();
  } catch(e) {
    toast("Chyba při mazání aliasu", true);
  }
}


async function addAlias(zbozi_id) {
  const alias = document.getElementById("newAlias").value.trim();
  if (!alias) { toast("Vyplňte alias", true); return; }
  await api("/api/zbozi/alias", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ zbozi_id, alias })
  });
  toast("Alias přidán ✓");
  const container = document.getElementById("aliasContainer");
  const prazdny = container.querySelector("span:not(.alias-tag)");
  if (prazdny) prazdny.remove();
  const span = document.createElement("span");
  span.className = "alias-tag";
  span.style.cssText = "display:inline-flex;align-items:center;gap:.3rem;background:var(--green-pale);border-radius:99px;padding:.2rem .6rem .2rem .8rem;margin:.2rem;font-size:.85rem";
  span.innerHTML = `${escHtml(alias)} <button onclick="smazatAlias(${zbozi_id}, '${escHtml(alias)}', this)" style="background:none;border:none;cursor:pointer;color:#999;font-size:.8rem;line-height:1;padding:0 .1rem" title="Smazat alias">✕</button>`;
  container.appendChild(span);
  document.getElementById("newAlias").value = "";
  loadPolozky();
}

function exportPolozky(fmt) {
  const params = new URLSearchParams({
    format: fmt,
    firma: document.getElementById("pFirma")?.value||"",
    od:    document.getElementById("pOd")?.value||"",
    do:    document.getElementById("pDo")?.value||"",
  });
  window.location.href = `/api/export/polozky?${params}`;
}


// ═══════════════════════════════════════════════════════════════
//  VÝPLATY
// ═══════════════════════════════════════════════════════════════

async function renderVyplaty() {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Výplaty</h1>
      <button class="btn btn-primary btn-sm" onclick="openNovVyplata()">+ Nová výplata</button>
      <button class="btn btn-secondary btn-sm" onclick="openOdvodyModal()">⚙️ Odvody</button>
    </div>
    <div id="vyplatyPrehled"><div class="loading-center"><span class="spinner"></span></div></div>`;
  loadVyplatyPrehled();
}

async function openOdvodyModal() {
  const zam = await api("/api/vyplaty/zamestnanci");
  const jmena = (zam && zam.jmena) ? zam.jmena : (Array.isArray(zam) ? zam : []);
  openModal("Paušální odvody", `
    <div class="form-group">
      <label class="form-label">Zaměstnanec</label>
      <select id="odvJmeno" class="form-control" onchange="loadOdvodyZam()">
        <option value="">— vyberte —</option>
        ${jmena.map(j => `<option value="${escHtml(j)}">${escHtml(j)}</option>`).join("")}
      </select>
    </div>
    <div id="odvodyList" style="margin-top:1rem"></div>
    <div id="odvodyPridatWrap" style="display:none;margin-top:1rem;border-top:1px solid var(--border);padding-top:1rem">
      <div style="font-size:.85rem;font-weight:600;margin-bottom:.5rem">Přidat odvod</div>
      <div class="grid-2" style="gap:.75rem">
        <div class="form-group">
          <label class="form-label">Název</label>
          <input id="odvNazev" class="form-control" placeholder="např. Soc. pojištění">
        </div>
        <div class="form-group">
          <label class="form-label">Částka (Kč/měsíc)</label>
          <input type="number" id="odvCastka" class="form-control" placeholder="0">
        </div>
        <div class="form-group">
          <label class="form-label">Platí od</label>
          <input type="month" id="odvPlatnostOd" class="form-control" value="${new Date().toISOString().slice(0,7)}">
        </div>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:.5rem" onclick="pridatOdvod()">+ Přidat</button>
    </div>
  `);
}

async function loadOdvodyZam() {
  const jmeno = document.getElementById("odvJmeno")?.value;
  const listEl = document.getElementById("odvodyList");
  const pridatWrap = document.getElementById("odvodyPridatWrap");
  if (!listEl) return;
  if (!jmeno) { listEl.innerHTML = ""; if (pridatWrap) pridatWrap.style.display = "none"; return; }
  if (pridatWrap) pridatWrap.style.display = "block";
  let data;
  try { data = await api(`/api/pausalni-odvody/${encodeURIComponent(jmeno)}`); } catch { return; }
  if (!data.length) {
    listEl.innerHTML = `<div style="color:var(--txt2);font-size:.85rem;padding:.5rem 0">Žádné odvody — přidej první níže.</div>`;
    return;
  }
  listEl.innerHTML = `
    <table style="width:100%;font-size:.88rem">
      <thead><tr><th>Název</th><th>Částka</th><th>Platí od</th><th></th></tr></thead>
      <tbody>
        ${data.map(o => `
          <tr>
            <td>${escHtml(o.nazev)}</td>
            <td><strong>${czMoney(o.castka)}</strong></td>
            <td style="color:var(--txt2)">${o.platnost_od ? o.platnost_od.slice(0,7) : "—"}</td>
            <td><button class="btn btn-danger btn-sm" onclick="smazatOdvod(${o.id})">🗑</button></td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

async function pridatOdvod() {
  const jmeno = document.getElementById("odvJmeno")?.value;
  const nazev = document.getElementById("odvNazev")?.value.trim();
  const castka = parseFloat(document.getElementById("odvCastka")?.value);
  const mesic = document.getElementById("odvPlatnostOd")?.value;
  if (!jmeno || !nazev || isNaN(castka) || castka <= 0) { toast("Vyplňte všechna pole"); return; }
  const platnost_od = mesic ? mesic + "-01" : new Date().toISOString().slice(0,8) + "01";
  await api("/api/nastaveni/odvody", {method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({jmeno, nazev, castka, platnost_od})});
  toast("Odvod přidán ✓");
  document.getElementById("odvNazev").value = "";
  document.getElementById("odvCastka").value = "";
  loadOdvodyZam();
  loadVyplatyPrehled();
}

async function smazatOdvod(id) {
  if (!confirm("Opravdu smazat tento odvod?")) return;
  await api(`/api/nastaveni/odvody/${id}`, {method:"DELETE"});
  toast("Odvod smazán ✓");
  loadOdvodyZam();
  loadVyplatyPrehled();
}

async function loadVyplatyPrehled() {
  const el = document.getElementById("vyplatyPrehled");
  if (!el) return;
  let data;
  try { data = await api("/api/vyplaty/prehled"); } catch { return; }

  const s = data.souhrn;
  const mesicNames = ["","Leden","Únor","Březen","Duben","Květen","Červen",
    "Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];
  const dnes = new Date();
  const mesicLabel = mesicNames[dnes.getMonth()+1] + " " + dnes.getFullYear();

  el.innerHTML = `
    <div class="card" style="margin-bottom:1rem;cursor:pointer" onclick="renderVyplatyMesice()">
      <div class="card-title">Celkem — ${mesicLabel} / ${dnes.getFullYear()}</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.6rem;margin-top:.5rem">
        <div style="border-radius:6px;padding:.4rem .75rem;background:#f0fdf4;border:1px solid #86efac">
          <div style="font-size:.68rem;color:#166534;font-weight:600">Měsíc bez odvodů</div>
          <div style="font-size:.95rem;font-weight:700;color:#166534">${czMoney(s.mesic_bez_odvodu)}</div>
        </div>
        <div style="border-radius:6px;padding:.4rem .75rem;background:#fef3c7;border:1px solid #fcd34d">
          <div style="font-size:.68rem;color:#92400e;font-weight:600">Měsíc s odvody</div>
          <div style="font-size:.95rem;font-weight:700;color:#92400e">${czMoney(s.mesic_s_odvody)}</div>
        </div>
        <div style="border-radius:6px;padding:.4rem .75rem;background:#fff7ed;border:1px solid #fdba74">
          <div style="font-size:.68rem;color:#9a3412;font-weight:600">Odvody / měsíc</div>
          <div style="font-size:.95rem;font-weight:700;color:#9a3412">${czMoney(s.odvody_mesic)}</div>
        </div>
        <div style="border-radius:6px;padding:.4rem .75rem;background:#f0fdf4;border:1px solid #86efac">
          <div style="font-size:.68rem;color:#166534;font-weight:600">Rok bez odvodů</div>
          <div style="font-size:.95rem;font-weight:700;color:#166534">${czMoney(s.rok_bez_odvodu)}</div>
        </div>
        <div style="border-radius:6px;padding:.4rem .75rem;background:#fef3c7;border:1px solid #fcd34d">
          <div style="font-size:.68rem;color:#92400e;font-weight:600">Rok s odvody</div>
          <div style="font-size:.95rem;font-weight:700;color:#92400e">${czMoney(s.rok_s_odvody)}</div>
        </div>
        <div style="border-radius:6px;padding:.4rem .75rem;background:#fff7ed;border:1px solid #fdba74">
          <div style="font-size:.68rem;color:#9a3412;font-weight:600">Odvody / rok</div>
          <div style="font-size:.95rem;font-weight:700;color:#9a3412">${czMoney(s.rok_s_odvody - s.rok_bez_odvodu)}</div>
        </div>
      </div>
      <div style="font-size:.78rem;color:var(--txt2);margin-top:.5rem">Kliknutím zobrazíš přehled po měsících →</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:.6rem">
      ${data.zamestnanci.map(z => {
        const posl = z.posledni.map(p =>
          `<strong>${czMoney(p.castka)}</strong> <span style="font-size:.75rem;color:var(--txt2)">${czDate(p.datum)}</span>`
        ).join(" &nbsp;·&nbsp; ");
        const odvodyBoxy = z.ma_odvody ? `
          <div style="background:var(--color-background-secondary,#f5f5f5);border:0.5px solid var(--color-border-tertiary);border-radius:6px;padding:.3rem .6rem;text-align:center">
            <div style="font-size:.63rem;color:var(--txt2)">Měsíc odvod</div>
            <div style="font-size:.88rem;font-weight:500;color:#92400e">${czMoney(z.odvody_mesic)}</div>
          </div>
          <div style="background:var(--color-background-secondary,#f5f5f5);border:0.5px solid var(--color-border-tertiary);border-radius:6px;padding:.3rem .6rem;text-align:center">
            <div style="font-size:.63rem;color:var(--txt2)">Rok s odvodem</div>
            <div style="font-size:.88rem;font-weight:500">${czMoney(z.castka_rok_s_odvody)}</div>
          </div>` : "";
        return `
        <div class="card" style="cursor:pointer;padding:.7rem 1rem;max-width:640px" onclick="renderVyplatyDetail('${escHtml(z.jmeno)}')">
          <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
            <div style="font-size:1rem;font-weight:500;min-width:70px">${escHtml(z.jmeno)}</div>
            <div style="flex:1;font-size:.85rem;min-width:160px">
              ${posl ? `<span style="color:var(--txt2);font-size:.72rem">Posl.: </span>${posl}` : '<span style="color:var(--txt2);font-style:italic">Žádné výplaty</span>'}
            </div>
            <div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
              <div style="background:var(--color-background-secondary,#f5f5f5);border:0.5px solid var(--color-border-tertiary);border-radius:6px;padding:.3rem .6rem;text-align:center">
                <div style="font-size:.63rem;color:var(--txt2)">Měsíc výplata</div>
                <div style="font-size:.88rem;font-weight:500;color:#166534">${czMoney(z.castka_mesic)}</div>
              </div>
              ${odvodyBoxy}
              <div style="background:var(--color-background-secondary,#f5f5f5);border:0.5px solid var(--color-border-tertiary);border-radius:6px;padding:.3rem .6rem;text-align:center">
                <div style="font-size:.63rem;color:var(--txt2)">Rok bez odvodu</div>
                <div style="font-size:.88rem;font-weight:500">${czMoney(z.castka_rok)}</div>
              </div>
              <span style="color:var(--txt2)">→</span>
            </div>
          </div>
        </div>`;
      }).join("")}
    </div>`;
}

async function renderVyplatyDetail(jmeno) {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">
        <span style="cursor:pointer;color:var(--txt2);font-weight:400" onclick="renderVyplaty()">Výplaty</span>
        <span style="margin:0 .4rem">›</span>${escHtml(jmeno)}
      </h1>
      <button class="btn btn-primary btn-sm" onclick="openNovVyplataJmeno('${escHtml(jmeno)}')">+ Nová výplata</button>
    </div>
    <div id="vyplatyDetailObs"><div class="loading-center"><span class="spinner"></span></div></div>`;
  let data;
  try { data = await api(`/api/vyplaty/mesice/${encodeURIComponent(jmeno)}`); } catch { return; }
  const dnes = new Date();
  const mesicStr = `${dnes.getFullYear()}-${String(dnes.getMonth()+1).padStart(2,"0")}`;
  const rokStr = String(dnes.getFullYear());
  const castka_mesic = data.vyplaty.filter(v => v.datum && v.datum.startsWith(mesicStr)).reduce((s,v) => s + v.castka, 0);
  const castka_rok   = data.vyplaty.filter(v => v.datum && v.datum.startsWith(rokStr)).reduce((s,v) => s + v.castka, 0);
  const el = document.getElementById("vyplatyDetailObs");
  if (!el) return;
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-bottom:1rem">
      <div class="card" style="padding:.75rem;background:#f0fdf4;border:1px solid #86efac">
        <div style="font-size:.78rem;color:#166534;font-weight:600">Aktuální měsíc</div>
        <div style="font-size:1.4rem;font-weight:700;color:#166534">${czMoney(castka_mesic)}</div>
      </div>
      <div class="card" style="padding:.75rem">
        <div style="font-size:.78rem;color:var(--txt2);font-weight:600">Rok ${rokStr}</div>
        <div style="font-size:1.4rem;font-weight:700">${czMoney(castka_rok)}</div>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Datum</th><th>Firma</th><th>Částka</th><th>Poznámka</th><th></th></tr></thead>
          <tbody>
            ${data.vyplaty.map(v => `
              <tr>
                <td>${czDate(v.datum)}</td>
                <td><span class="badge" style="background:var(--green-pale)">${escHtml(v.firma_zkratka||"—")}</span></td>
                <td><strong>${czMoney(v.castka)}</strong></td>
                <td style="color:var(--txt2);font-size:.88rem">${escHtml(v.poznamka||"")}</td>
                <td>
                  <button class="btn btn-secondary btn-sm" onclick="editVyplataDetail(${v.id},'${escHtml(v.jmeno)}','${v.datum}',${v.castka},'${escHtml(v.poznamka||"")}','${escHtml(v.firma_zkratka||"")}','${escHtml(jmeno)}')">✏️</button>
                  <button class="btn btn-danger btn-sm" onclick="deleteVyplataDetail(${v.id},'${escHtml(jmeno)}')">🗑</button>
                </td>
              </tr>`).join("") || "<tr><td colspan='5' style='text-align:center;padding:2rem;color:var(--txt2)'>Žádné výplaty</td></tr>"}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function renderVyplatyMesice() {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">
        <span style="cursor:pointer;color:var(--txt2);font-weight:400" onclick="renderVyplaty()">Výplaty</span>
        <span style="margin:0 .4rem">›</span>Přehled po měsících
      </h1>
    </div>
    <div id="vyplatyMesiceObs"><div class="loading-center"><span class="spinner"></span></div></div>`;
  let data;
  try { data = await api("/api/vyplaty?od=2020-01-01"); } catch { return; }
  // Seskup po měsících
  const mesice = {};
  for (const v of data.vyplaty) {
    const m = (v.datum || "").substring(0, 7);
    if (!m) continue;
    if (!mesice[m]) mesice[m] = { castka: 0, pocet: 0 };
    mesice[m].castka += v.castka;
    mesice[m].pocet++;
  }
  const klice = Object.keys(mesice).sort().reverse();
  const el = document.getElementById("vyplatyMesiceObs");
  if (!el) return;
  el.innerHTML = `
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Měsíc</th><th>Počet výplat</th><th>Celkem</th></tr></thead>
          <tbody>
            ${klice.map(m => `
              <tr>
                <td><strong>${m}</strong></td>
                <td>${mesice[m].pocet}</td>
                <td><strong>${czMoney(mesice[m].castka)}</strong></td>
              </tr>`).join("") || "<tr><td colspan='3' style='text-align:center;padding:2rem;color:var(--txt2)'>Žádné výplaty</td></tr>"}
          </tbody>
        </table>
      </div>
    </div>`;
}

function openNovVyplataJmeno(jmeno) {
  openModal("Nová výplata", vyplataFormHtml({jmeno}) + `
    <div class="btn-group" style="margin-top:1rem">
      <button class="btn btn-primary" onclick="App._vyplataOnSave&&App._vyplataOnSave()">💾 Uložit</button>
    </div>`);
  App._vyplataOnSave = async () => {
    const jmeno2  = document.getElementById("vJmenoF").value.trim();
    const datum   = document.getElementById("vDatumF").value;
    const castka  = parseFloat(document.getElementById("vCastkaF").value);
    if (!jmeno2 || !datum || isNaN(castka)) { toast("Vyplňte jméno, datum a částku"); return; }
    await api("/api/vyplaty", {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({jmeno:jmeno2,datum,castka,poznamka:document.getElementById("vPoznamkaF").value,firma_zkratka:document.getElementById("vFirmaF").value})});
    toast("Výplata uložena ✓"); closeModal(); renderVyplatyDetail(jmeno);
  };
}

function editVyplataDetail(id, jmeno, datum, castka, poznamka, firma_zkratka, zpetJmeno) {
  openModal("Upravit výplatu", vyplataFormHtml({jmeno,datum,castka,poznamka,firma_zkratka}) + `
    <div class="btn-group" style="margin-top:1rem">
      <button class="btn btn-primary" onclick="App._vyplataOnSave&&App._vyplataOnSave()">💾 Uložit změny</button>
    </div>`);
  App._vyplataOnSave = async () => {
    const jmeno2  = document.getElementById("vJmenoF").value.trim();
    const datum2  = document.getElementById("vDatumF").value;
    const castka2 = parseFloat(document.getElementById("vCastkaF").value);
    if (!jmeno2 || !datum2 || isNaN(castka2)) { toast("Vyplňte jméno, datum a částku"); return; }
    await api(`/api/vyplaty/${id}`, {method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({jmeno:jmeno2,datum:datum2,castka:castka2,poznamka:document.getElementById("vPoznamkaF").value,firma_zkratka:document.getElementById("vFirmaF").value})});
    toast("Výplata upravena ✓"); closeModal(); renderVyplatyDetail(zpetJmeno);
  };
}

async function deleteVyplataDetail(id, jmeno) {
  if (!confirm("Opravdu smazat tuto výplatu?")) return;
  await api(`/api/vyplaty/${id}`, {method:"DELETE"});
  toast("Výplata smazána ✓"); renderVyplatyDetail(jmeno);
}

async function nacistZamestnance() {
  try {
    const data = await api("/api/vyplaty/zamestnanci");
    const sel = document.getElementById("vJmeno");
    if (!sel) return;
    data.forEach(j => {
      const o = document.createElement("option");
      o.value = j; o.textContent = j;
      sel.appendChild(o);
    });
  } catch {}
}

async function loadVyplaty() {
  const params = new URLSearchParams({
    firma: document.getElementById("vFirma")?.value||"",
    jmeno: document.getElementById("vJmeno")?.value||"",
    od:    document.getElementById("vOd")?.value||"",
    do:    document.getElementById("vDo")?.value||"",
  });
  let data;
  try { data = await api(`/api/vyplaty?${params}`); } catch { return; }
  const el = document.getElementById("vyplatyList");
  if (!el) return;
  el.innerHTML = `
    <table>
      <thead><tr><th>Firma</th><th>Jméno</th><th>Datum</th><th>Částka</th><th>Poznámka</th><th></th></tr></thead>
      <tbody>
        ${data.vyplaty.map(v => `
          <tr>
            <td><span class="badge" style="background:var(--green-pale)">${escHtml(v.firma_zkratka||"—")}</span></td>
            <td><strong>${escHtml(v.jmeno)}</strong></td>
            <td>${czDate(v.datum)}</td>
            <td><strong>${czMoney(v.castka)}</strong></td>
            <td style="color:var(--txt2);font-size:.88rem">${escHtml(v.poznamka||"")}</td>
            <td>
              <button class="btn btn-secondary btn-sm" onclick="editVyplata(${v.id},'${escHtml(v.jmeno)}','${v.datum}',${v.castka},'${escHtml(v.poznamka||"")}','${escHtml(v.firma_zkratka||"")}')">✏️</button>
              <button class="btn btn-danger btn-sm" onclick="deleteVyplata(${v.id})">🗑</button>
            </td>
          </tr>`).join("") || "<tr><td colspan='6' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné výplaty</td></tr>"}
      </tbody>
      ${data.vyplaty.length ? `<tfoot><tr class="table-footer"><td colspan="3">Celkem (${data.vyplaty.length})</td><td colspan="3"><strong>${czMoney(data.celkem)}</strong></td></tr></tfoot>` : ""}
    </table>`;
}

function vyplataFormHtml(v = {}) {
  return `
    <div class="grid-2" style="gap:1rem">
      <div class="form-group"><label class="form-label">Firma</label>
        <select id="vFirmaF" class="form-control">
          <option value="">—</option>
          ${App.config.firmy.map(f=>`<option value="${f}" ${v.firma_zkratka===f?"selected":""}>${f}</option>`).join("")}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Jméno *</label>
        <input id="vJmenoF" class="form-control" value="${escHtml(v.jmeno||"")}" placeholder="Jméno zaměstnance">
      </div>
      <div class="form-group"><label class="form-label">Datum *</label>
        <input type="date" id="vDatumF" class="form-control" value="${v.datum||(()=>{const _x=new Date();return `${_x.getFullYear()}-${String(_x.getMonth()+1).padStart(2,"0")}-${String(_x.getDate()).padStart(2,"0")}`;})() }">
      </div>
      <div class="form-group"><label class="form-label">Částka (Kč) *</label>
        <input type="number" step="0.01" id="vCastkaF" class="form-control" value="${v.castka||""}">
      </div>
    </div>
    <div class="form-group"><label class="form-label">Poznámka</label>
      <input id="vPoznamkaF" class="form-control" value="${escHtml(v.poznamka||"")}">
    </div>`;
}

function openNovVyplata() {
  openModal("Nová výplata", vyplataFormHtml() + `
    <div class="btn-group" style="margin-top:1rem">
      <button class="btn btn-primary" onclick="App._vyplataOnSave&&App._vyplataOnSave()">💾 Uložit</button>
    </div>`);
  App._vyplataOnSave = async () => {
    const jmeno  = document.getElementById("vJmenoF").value.trim();
    const datum  = document.getElementById("vDatumF").value;
    const castka = parseFloat(document.getElementById("vCastkaF").value);
    if (!jmeno || !datum || isNaN(castka)) { toast("Vyplňte jméno, datum a částku"); return; }
    await api("/api/vyplaty", {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({jmeno,datum,castka,poznamka:document.getElementById("vPoznamkaF").value,firma_zkratka:document.getElementById("vFirmaF").value})});
    toast("Výplata uložena ✓"); closeModal(); loadVyplaty();
  };
}

function editVyplata(id, jmeno, datum, castka, poznamka, firma_zkratka) {
  openModal("Upravit výplatu", vyplataFormHtml({jmeno,datum,castka,poznamka,firma_zkratka}) + `
    <div class="btn-group" style="margin-top:1rem">
      <button class="btn btn-primary" onclick="App._vyplataOnSave&&App._vyplataOnSave()">💾 Uložit změny</button>
    </div>`);
  App._vyplataOnSave = async () => {
    const jmeno2  = document.getElementById("vJmenoF").value.trim();
    const datum2  = document.getElementById("vDatumF").value;
    const castka2 = parseFloat(document.getElementById("vCastkaF").value);
    if (!jmeno2 || !datum2 || isNaN(castka2)) { toast("Vyplňte jméno, datum a částku"); return; }
    await api(`/api/vyplaty/${id}`, {method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({jmeno:jmeno2,datum:datum2,castka:castka2,poznamka:document.getElementById("vPoznamkaF").value,firma_zkratka:document.getElementById("vFirmaF").value})});
    toast("Výplata upravena ✓"); closeModal(); loadVyplaty();
  };
}

async function deleteVyplata(id) {
  if (!confirm("Opravdu smazat tuto výplatu?")) return;
  await api(`/api/vyplaty/${id}`, {method:"DELETE"});
  toast("Výplata smazána ✓"); loadVyplaty();
}

// ═══════════════════════════════════════════════════════════════
//  KALKULACE
// ═══════════════════════════════════════════════════════════════

async function renderKalkulace() {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">🧮 Kalkulace</h1>
      <button class="btn btn-primary btn-sm" onclick="openNovaKalkulace()">+ Nová kalkulace</button>
    </div>
    <div id="kalkulaceList"><div class="loading-center"><span class="spinner"></span></div></div>`;
  loadKalkulace();
}

async function loadKalkulace() {
  const el = document.getElementById("kalkulaceList");
  if (!el) return;
  let data;
  try { data = await api("/api/kalkulace"); } catch { return; }
  if (!data.length) {
    el.innerHTML = `<div style="text-align:center;color:var(--txt2);padding:3rem">Žádné kalkulace. <button class="btn btn-primary btn-sm" onclick="openNovaKalkulace()">+ Přidat první</button></div>`;
    return;
  }
  // Jednoduchá tabulka - jen řádek s klíčovými daty
  let rows = data.map(k => {
    const naklady   = _kalcSumaNakladu(k.polozky, k.pausalni);
    const skutMarze = k.prodejni_cena > 0 && naklady > 0 ? Math.round((k.prodejni_cena - naklady)/naklady*100) : null;
    const mc = skutMarze !== null ? (skutMarze>=100?"#16a34a":skutMarze>=50?"#d97706":"#dc2626") : "var(--txt2)";
    return `<tr style="cursor:pointer" onclick="zobrazitKalkulaci(${k.id})" class="tm-month">
      <td style="padding:8px 10px;font-weight:600">${escHtml(k.nazev)}${k.popis?` <small style="color:var(--txt2);font-weight:400">${escHtml(k.popis)}</small>`:""}</td>
      <td style="padding:8px 10px;text-align:right;color:#dc2626;font-weight:600">${czMoney(naklady)}</td>
      <td style="padding:8px 10px;text-align:right">${k.prodejni_cena?czMoney(k.prodejni_cena):"—"}</td>
      <td style="padding:8px 10px;text-align:right;font-weight:600;color:${mc}">${skutMarze!==null?skutMarze+"%":"—"}</td>
      <td style="padding:8px 10px;text-align:right;white-space:nowrap">
        <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();openEditKalkulace(${k.id})">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();smazatKalkulaci(${k.id})">🗑</button>
      </td>
    </tr>`;
  }).join("");
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.92rem">
    <thead><tr style="font-size:.78rem;color:var(--txt2);border-bottom:1px solid var(--border)">
      <th style="padding:6px 10px;text-align:left">Produkt</th>
      <th style="padding:6px 10px;text-align:right">Náklady/ks</th>
      <th style="padding:6px 10px;text-align:right">Prodejní cena</th>
      <th style="padding:6px 10px;text-align:right">Marže</th>
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function zobrazitKalkulaci(id) {
  let k;
  try { k = await api(`/api/kalkulace/${id}`); } catch { return; }
  const naklady   = _kalcSumaNakladu(k.polozky, k.pausalni);
  const dopCena   = naklady * (1 + (k.cil_marze_pct||200)/100);
  const skutMarze = k.prodejni_cena > 0 && naklady > 0 ? Math.round((k.prodejni_cena - naklady)/naklady*100) : null;
  const mc = skutMarze !== null ? (skutMarze>=100?"#16a34a":skutMarze>=50?"#d97706":"#dc2626") : "var(--txt2)";

  const radky = [
    ...k.polozky.map(p => {
      const cks = p.je_baleni ? p.cena_za_jednotku/(p.baleni_ks||1) : p.cena_za_jednotku;
      return `<tr style="border-top:0.5px solid var(--border)">
        <td style="padding:5px 8px">${escHtml(p.nazev)}</td>
        <td style="padding:5px 8px;color:var(--txt2);font-size:.82rem">${p.mnozstvi} ${escHtml(p.jednotka||"ks")} ${p.je_baleni?`<small>(z bal. ${p.baleni_ks}ks)</small>`:""}</td>
        <td style="text-align:right;padding:5px 8px">${czMoney(cks*p.mnozstvi)}</td>
        <td style="padding:5px 8px;color:var(--txt2);font-size:.75rem">${p.zdroj_ceny==="faktura"?"📄 FA":"✏️"}</td>
      </tr>`;
    }),
    ...(k.pausalni||[]).map(p => `<tr style="border-top:0.5px solid var(--border);background:var(--bg)">
      <td style="padding:5px 8px;color:#6366f1">${escHtml(p.nazev)}</td>
      <td style="padding:5px 8px;color:var(--txt2);font-size:.82rem">paušál</td>
      <td style="text-align:right;padding:5px 8px">${czMoney(p.castka)}</td>
      <td></td>
    </tr>`)
  ].join("");

  openModal(`${escHtml(k.nazev)}`, `
    <table style="width:100%;border-collapse:collapse;font-size:.88rem;margin-bottom:1rem">
      <thead><tr style="font-size:.75rem;color:var(--txt2);border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:5px 8px">Položka</th>
        <th style="padding:5px 8px;color:var(--txt2)">Množství</th>
        <th style="text-align:right;padding:5px 8px">Celkem</th>
        <th></th>
      </tr></thead>
      <tbody>${radky}</tbody>
      <tfoot>
        <tr style="border-top:1.5px solid var(--border);font-weight:600">
          <td colspan="2" style="padding:6px 8px">Náklady celkem / ks</td>
          <td style="text-align:right;padding:6px 8px;color:#dc2626">${czMoney(naklady)}</td><td></td>
        </tr>
        <tr style="color:var(--txt2)">
          <td colspan="2" style="padding:4px 8px">Doporučená cena (+${k.cil_marze_pct||200}%)</td>
          <td style="text-align:right;padding:4px 8px;color:#2563eb;font-weight:600">${czMoney(dopCena)}</td><td></td>
        </tr>
        <tr>
          <td colspan="2" style="padding:4px 8px">Prodejní cena</td>
          <td style="text-align:right;padding:4px 8px;font-weight:600">${k.prodejni_cena?czMoney(k.prodejni_cena):"—"}</td><td></td>
        </tr>
        <tr>
          <td colspan="2" style="padding:4px 8px">Skutečná marže</td>
          <td style="text-align:right;padding:4px 8px;font-weight:600;color:${mc}">${skutMarze!==null?skutMarze+"%":"—"}</td><td></td>
        </tr>
      </tfoot>
    </table>
    <div style="display:flex;gap:.5rem;justify-content:flex-end">
      <button class="btn btn-secondary btn-sm" onclick="closeModal();openEditKalkulace(${k.id})">✏️ Upravit</button>
      <button class="btn btn-danger btn-sm" onclick="closeModal();smazatKalkulaci(${k.id})">🗑 Smazat</button>
    </div>`);
}

function _kalcSumaNakladu(polozky, pausalni) {
  const s1 = (polozky||[]).reduce((s,p) => {
    const cks = p.je_baleni ? p.cena_za_jednotku/(p.baleni_ks||1) : p.cena_za_jednotku;
    return s + cks*(p.mnozstvi||1);
  }, 0);
  const s2 = (pausalni||[]).reduce((s,p) => s + (p.castka||0), 0);
  return s1 + s2;
}

function openNovaKalkulace() {
  App._kalcEditId = null;
  _renderKalcPage({});
}

async function openEditKalkulace(id) {
  let k;
  try { k = await api(`/api/kalkulace/${id}`); } catch { return; }
  App._kalcEditId = id;
  _renderKalcPage(k);
}

function _renderKalcPage(k) {
  const polozky = k.polozky || [];
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${App._kalcEditId ? "Upravit kalkulaci" : "Nová kalkulace"}</h1>
      <button class="btn btn-secondary btn-sm" onclick="renderKalkulace()">← Zpět</button>
    </div>
    <div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:1.5rem;align-items:start">
      <div>
        <div class="card" style="margin-bottom:1rem">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
            <div class="form-group"><label class="form-label">Název produktu *</label>
              <input id="klNazev" class="form-control" value="${escHtml(k.nazev||"")}" placeholder="Párek v rohlíku"></div>
            <div class="form-group"><label class="form-label">Popis</label>
              <input id="klPopis" class="form-control" value="${escHtml(k.popis||"")}" placeholder="Volitelný popis"></div>
          </div>
        </div>
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem">
            <strong>Suroviny</strong>
            <button class="btn btn-secondary btn-sm" onclick="klPridatPolozku()">+ Přidat surovinu</button>
          </div>
          <div id="klPolozkyWrap">${polozky.map((p,i)=>_kalcPolozkaHtml(i,p)).join("")}</div>
          ${polozky.length===0?`<div style="color:var(--txt2);font-size:.85rem;padding:.5rem 0">Zatím žádné suroviny</div>`:""}
        </div>
        <div class="card" style="margin-top:1rem">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem">
            <strong>Paušální položky</strong>
            <button class="btn btn-secondary btn-sm" onclick="klPridatPausal()">+ Přidat</button>
          </div>
          <div id="klPausalWrap">${(k.pausalni||[]).map((p,i)=>_kalcPausalHtml(i,p)).join("")}</div>
          ${!(k.pausalni||[]).length?`<div style="color:var(--txt2);font-size:.85rem;padding:.5rem 0">Např. ubrousek, tácek, olej...</div>`:""}
        </div>
      </div>
      <div>
        <div class="card" style="margin-bottom:1rem">
          <div class="card-title" style="margin-bottom:.75rem">Výsledek</div>
          <div id="klVysledek"></div>
        </div>
        <div class="card">
          <div class="form-group" style="margin-bottom:.75rem">
            <label class="form-label">Cílová marže (%)</label>
            <input type="number" id="klCilMarze" class="form-control" value="${k.cil_marze_pct||200}" oninput="klRecalc()">
          </div>
          <div class="form-group" style="margin-bottom:.75rem">
            <label class="form-label">Skutečná prodejní cena (Kč)</label>
            <input type="number" step="0.01" id="klProdejniCena" class="form-control" value="${k.prodejni_cena||""}" placeholder="179" oninput="klRecalc()">
          </div>
          <button class="btn btn-primary" style="width:100%" onclick="ulozitKalkulaci()">💾 Uložit</button>
        </div>
      </div>
    </div>`;
  klRecalc();
}

function _kalcPolozkaHtml(i, p = {}) {
  const uid = `klp_${i}_${Date.now()}`;
  const jeBaleni = p.je_baleni ? "checked" : "";
  return `<div class="kl-polozka" id="${uid}" style="border:0.5px solid var(--border);border-radius:8px;padding:.75rem;margin-bottom:.5rem;position:relative">
    <button onclick="this.closest('.kl-polozka').remove();klRecalc()" style="position:absolute;top:.4rem;right:.4rem;background:none;border:none;cursor:pointer;color:var(--txt2)">✕</button>
    <div style="display:grid;grid-template-columns:2fr 80px 60px;gap:.5rem;margin-bottom:.5rem">
      <div>
        <label style="font-size:.75rem;color:var(--txt2)">Surovina</label>
        <div style="position:relative">
          <input class="form-control kl-nazev" style="font-size:.85rem" value="${escHtml(p.nazev||"")}" placeholder="Začni psát název..." oninput="klNaseptavac(this,'${uid}')" autocomplete="off">
          <div id="nas_${uid}" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--card-bg,#fff);border:1px solid var(--border);border-radius:6px;z-index:200;max-height:180px;overflow-y:auto"></div>
        </div>
        <div id="cenaInfo_${uid}" style="font-size:.72rem;color:var(--txt2);margin-top:.2rem">${p.zdroj_ceny==="faktura"?"📄 cena z FA":"✏️ ruční zadání"}</div>
      </div>
      <div>
        <label style="font-size:.75rem;color:var(--txt2)">Množství</label>
        <input type="number" step="0.001" class="form-control kl-mnozstvi" style="font-size:.85rem" value="${p.mnozstvi||1}" oninput="klRecalc()">
      </div>
      <div>
        <label style="font-size:.75rem;color:var(--txt2)">Jedn.</label>
        <input class="form-control kl-jednotka" style="font-size:.85rem" value="${escHtml(p.jednotka||"ks")}">
      </div>
    </div>
    <div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:.5rem;align-items:end">
      <label style="font-size:.78rem;display:flex;align-items:center;gap:.3rem;cursor:pointer;white-space:nowrap;padding-bottom:.4rem">
        <input type="checkbox" class="kl-jebaleni" ${jeBaleni} onchange="klToggleBaleni('${uid}')"> Balení
      </label>
      <div id="baleniWrap_${uid}" style="display:${p.je_baleni?"":"none"}">
        <label style="font-size:.75rem;color:var(--txt2)">Ks v balení</label>
        <input type="number" step="1" min="1" class="form-control kl-baleni-ks" style="font-size:.85rem" value="${p.baleni_ks||1}" oninput="klRecalc()">
      </div>
      <div>
        <label style="font-size:.75rem;color:var(--txt2)" id="cenaLabel_${uid}">Cena za ${p.je_baleni?"balení":"ks"} (Kč)</label>
        <input type="number" step="0.01" class="form-control kl-cena" style="font-size:.85rem" value="${p.cena_za_jednotku||""}" data-zdroj="${p.zdroj_ceny||"rucni"}" placeholder="z FA..." oninput="this.dataset.zdroj='rucni';klRecalc()">
      </div>
    </div>
  </div>`;
}

let _klIdx = 0;
function klPridatPolozku() {
  const wrap = document.getElementById("klPolozkyWrap");
  if (!wrap) return;
  const i = ++_klIdx;
  const div = document.createElement("div");
  div.innerHTML = _kalcPolozkaHtml(i);
  wrap.appendChild(div.firstElementChild);
  klRecalc();
}

function _kalcPausalHtml(i, p = {}) {
  return `<div class="kl-pausal" style="display:grid;grid-template-columns:1fr 120px auto;gap:.5rem;align-items:center;margin-bottom:.4rem">
    <input class="form-control kl-pausal-nazev" style="font-size:.85rem" value="${escHtml(p.nazev||"")}" placeholder="Ubrousek, tácek..." oninput="klRecalc()">
    <input type="number" step="0.01" class="form-control kl-pausal-castka" style="font-size:.85rem" value="${p.castka||""}" placeholder="Kč" oninput="klRecalc()">
    <button onclick="this.closest('.kl-pausal').remove();klRecalc()" style="background:none;border:none;cursor:pointer;color:var(--txt2);font-size:1rem">✕</button>
  </div>`;
}

function klPridatPausal() {
  const wrap = document.getElementById("klPausalWrap");
  if (!wrap) return;
  const div = document.createElement("div");
  div.innerHTML = _kalcPausalHtml(++_klIdx);
  wrap.appendChild(div.firstElementChild);
  klRecalc();
}

function klToggleBaleni(uid) {
  const el = document.getElementById(uid);
  if (!el) return;
  const chk = el.querySelector(".kl-jebaleni");
  const wrap = document.getElementById(`baleniWrap_${uid}`);
  const lbl = document.getElementById(`cenaLabel_${uid}`);
  if (wrap) wrap.style.display = chk?.checked ? "" : "none";
  if (lbl) lbl.textContent = `Cena za ${chk?.checked?"balení":"ks"} (Kč)`;
  klRecalc();
}

let _nasTimer = {};
async function klNaseptavac(input, uid) {
  clearTimeout(_nasTimer[uid]);
  const q = input.value.trim();
  const box = document.getElementById(`nas_${uid}`);
  if (!box) return;
  if (q.length < 2) { box.style.display = "none"; return; }
  _nasTimer[uid] = setTimeout(async () => {
    try {
      const data = await api(`/api/zbozi-search?q=${encodeURIComponent(q)}&unaccent=1`);
      if (!data.length) { box.style.display = "none"; return; }
      box.innerHTML = data.map(z =>
        `<div style="padding:.4rem .6rem;cursor:pointer;font-size:.85rem;border-bottom:0.5px solid var(--border)" onmousedown="klVybratZbozi('${uid}','${escHtml(z.nazev_canonical)}')">${escHtml(z.nazev_canonical)}</div>`
      ).join("");
      box.style.display = "";
    } catch { box.style.display = "none"; }
  }, 250);
}

async function klVybratZbozi(uid, nazev) {
  const el = document.getElementById(uid);
  const box = document.getElementById(`nas_${uid}`);
  const info = document.getElementById(`cenaInfo_${uid}`);
  if (!el) return;
  el.querySelector(".kl-nazev").value = nazev;
  if (box) box.style.display = "none";
  try {
    const r = await api(`/api/kalkulace/cena-polozky?nazev=${encodeURIComponent(nazev)}`);
    const cenaInput = el.querySelector(".kl-cena");
    if (r.cena !== null) {
      if (cenaInput && !cenaInput.value) {
        cenaInput.value = r.cena.toFixed(2);
        cenaInput.dataset.zdroj = "faktura";
      }
      if (info) info.innerHTML = `📄 z FA: ${czMoney(r.cena)}/${r.jednotka||"ks"} · ${escHtml(r.dodavatel||"")} (${czDateShort(r.datum)})`;
    } else {
      if (info) info.textContent = "✏️ nenalezeno v FA – zadej ručně";
    }
  } catch {}
  klRecalc();
}

function klRecalc() {
  const polozky = document.querySelectorAll(".kl-polozka");
  const radky = [];
  let naklady = 0;
  polozky.forEach(p => {
    const nazev = p.querySelector(".kl-nazev")?.value?.trim() || "—";
    const cena  = parseFloat(p.querySelector(".kl-cena")?.value || 0);
    const mnoz  = parseFloat(p.querySelector(".kl-mnozstvi")?.value || 1);
    const jedn  = p.querySelector(".kl-jednotka")?.value || "ks";
    const jeB   = p.querySelector(".kl-jebaleni")?.checked;
    const balKs = parseFloat(p.querySelector(".kl-baleni-ks")?.value || 1);
    const cks   = jeB ? cena/(balKs||1) : cena;
    const celkem = cks * mnoz;
    naklady += celkem;
    if (nazev && cks > 0) radky.push({nazev, mnoz, jedn, cks, celkem});
  });
  // Paušální položky
  document.querySelectorAll(".kl-pausal").forEach(p => {
    const nazev  = p.querySelector(".kl-pausal-nazev")?.value?.trim() || "—";
    const castka = parseFloat(p.querySelector(".kl-pausal-castka")?.value || 0);
    naklady += castka;
    if (nazev && castka > 0) radky.push({nazev, mnoz:1, jedn:"ks", cks:castka, celkem:castka, pausal:true});
  });
  const cilMarze  = parseFloat(document.getElementById("klCilMarze")?.value || 200);
  const prodejni  = parseFloat(document.getElementById("klProdejniCena")?.value || 0);
  const dopCena   = naklady * (1 + cilMarze/100);
  const skutMarze = prodejni > 0 && naklady > 0 ? ((prodejni-naklady)/naklady*100) : null;
  const el = document.getElementById("klVysledek");
  if (!el) return;

  const sep = `<div style="border-top:1.5px solid var(--border);margin:.4rem 0"></div>`;
  const rowItem = (nazev, mnoz, jedn, cena, celkem, pausal) =>
    `<div style="display:flex;justify-content:space-between;padding:.25rem 0;font-size:.85rem">
      <span style="color:var(--txt2)">${escHtml(nazev)}${!pausal&&mnoz!==1?` <small>(${mnoz} ${jedn})</small>`:""}${pausal?' <small style="color:#6366f1">(paušál)</small>':""}</span>
      <span>${czMoney(celkem)}</span>
    </div>`;
  const rowSum = (label, val, color, bold) =>
    `<div style="display:flex;justify-content:space-between;padding:.35rem 0;border-bottom:0.5px solid var(--border)">
      <span style="color:var(--txt2);${bold?"font-weight:600":""};">${label}</span>
      <strong style="color:${color||"inherit"}">${val}</strong>
    </div>`;

  let html = "";
  if (radky.length) {
    html += radky.map(r => rowItem(r.nazev, r.mnoz, r.jedn, r.cks, r.celkem, r.pausal)).join("");
    html += sep;
  }
  html += rowSum("Náklady celkem / ks", czMoney(naklady), "#dc2626", true);
  html += rowSum(`Doporučená cena (+${Math.round(cilMarze)}%)`, czMoney(dopCena), "#2563eb", false);
  html += rowSum("Prodejní cena", prodejni ? czMoney(prodejni) : "—", "inherit", false);
  html += rowSum("Skutečná marže",
    skutMarze !== null ? `${Math.round(skutMarze)}%` : "—",
    skutMarze !== null ? (skutMarze>=100?"#16a34a":skutMarze>=50?"#d97706":"#dc2626") : "var(--txt2)", false);
  el.innerHTML = html;
}

function _kalcGetPayload() {
  const polozky = [];
  document.querySelectorAll(".kl-polozka").forEach(p => {
    const nazev = p.querySelector(".kl-nazev")?.value?.trim();
    if (!nazev) return;
    const jeB = p.querySelector(".kl-jebaleni")?.checked||false;
    polozky.push({
      nazev,
      mnozstvi:         parseFloat(p.querySelector(".kl-mnozstvi")?.value||1),
      jednotka:         p.querySelector(".kl-jednotka")?.value||"ks",
      cena_za_jednotku: parseFloat(p.querySelector(".kl-cena")?.value||0),
      je_baleni:        jeB,
      baleni_ks:        parseFloat(p.querySelector(".kl-baleni-ks")?.value||1),
      zdroj_ceny:       p.querySelector(".kl-cena")?.dataset?.zdroj||"rucni",
    });
  });
  const pausalni = [];
  document.querySelectorAll(".kl-pausal").forEach(p => {
    const nazev  = p.querySelector(".kl-pausal-nazev")?.value?.trim();
    const castka = parseFloat(p.querySelector(".kl-pausal-castka")?.value||0);
    if (nazev && castka > 0) pausalni.push({nazev, castka});
  });
  return {
    nazev:         document.getElementById("klNazev")?.value?.trim(),
    popis:         document.getElementById("klPopis")?.value||"",
    cil_marze_pct: parseFloat(document.getElementById("klCilMarze")?.value||200),
    prodejni_cena: parseFloat(document.getElementById("klProdejniCena")?.value||0),
    polozky,
    pausalni,
  };
}

async function ulozitKalkulaci() {
  const payload = _kalcGetPayload();
  if (!payload.nazev) { toast("Vyplň název produktu"); return; }
  const id = App._kalcEditId;
  if (id) {
    await api(`/api/kalkulace/${id}`, {method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  } else {
    await api("/api/kalkulace", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  }
  toast("Kalkulace uložena ✓");
  App._kalcEditId = null;
  renderKalkulace();
}

async function smazatKalkulaci(id) {
  if (!confirm("Smazat tuto kalkulaci?")) return;
  await api(`/api/kalkulace/${id}`, {method:"DELETE"});
  toast("Smazáno ✓");
  loadKalkulace();
}


const MCZ_NAZVY = ["","Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];

async function loadTrzbyMesice() {
  const el = document.getElementById("tmTabulka");
  if (!el) return;
  el.innerHTML = `<div class="loading-center"><span class="spinner"></span></div>`;
  const firma = document.getElementById("tmFirma")?.value || "";
  const rok   = document.getElementById("tmRok")?.value || "";
  let data;
  try { data = await api(`/api/statistiky/trzby-mesice?firma=${encodeURIComponent(firma)}&rok=${rok}`); }
  catch { el.innerHTML = "Chyba načítání"; return; }
  if (!data.length) { el.innerHTML = `<div style="color:var(--txt2);padding:1rem;text-align:center">Žádná data</div>`; return; }

  const _n = v => (v||0).toLocaleString("cs-CZ");
  const _f = v => v ? (v/1).toFixed(1) : "—";

  const tot = {trzba:0,trzba_vcpk:0,karty:0,hotovost:0,pk50:0,pk100:0,pizza:0,pizza_ctvrt:0,burger:0,bgulas:0,dni:0};
  data.forEach(d => { Object.keys(tot).forEach(k => tot[k] += d[k]||0); });

  const roky = [...new Set(data.map(d=>d.rok))];
  let rows = "";
  data.forEach(d => {
    const mi = parseInt(d.mesic);
    const id = `tm_${d.rok}_${d.mesic}`;
    const dn = d.dni || 1;
    rows += `
    <tr class="tm-month" onclick="toggleTmDetail('${id}')" style="cursor:pointer">
      <td><span id="arr_${id}" style="display:inline-block;margin-right:4px;font-size:10px;transition:transform .15s">&#9654;</span>
        <strong>${roky.length>1?d.rok+" – ":""}${MCZ_NAZVY[mi]||d.mesic}</strong>
      </td>
      <td style="text-align:right">${_n(d.trzba)}</td>
      <td style="text-align:right">${_n(d.trzba_vcpk)}</td>
      <td style="text-align:right">${_n(d.karty)}</td>
      <td style="text-align:right">${_n(d.hotovost)}</td>
      <td style="text-align:right">${_n(d.pk50)}</td>
      <td style="text-align:right">${_n(d.pk100)}</td>
      <td style="text-align:right">${_n(d.pizza)}</td>
      <td style="text-align:right">${_n(d.pizza_ctvrt)}</td>
      <td style="text-align:right">${_n(d.burger)}</td>
      <td style="text-align:right">${_n(d.bgulas)}</td>
    </tr>
    <tr style="background:var(--bg);color:var(--txt2)">
      <td style="padding-left:1.5rem;font-size:.8rem">ø/den (${d.dni} dní)</td>
      <td style="text-align:right">${_n(Math.round(d.trzba/dn))}</td>
      <td style="text-align:right">${_n(Math.round(d.trzba_vcpk/dn))}</td>
      <td style="text-align:right">${_n(Math.round(d.karty/dn))}</td>
      <td style="text-align:right">${_n(Math.round(d.hotovost/dn))}</td>
      <td style="text-align:right">${_f(d.pk50/dn)}</td>
      <td style="text-align:right">${_f(d.pk100/dn)}</td>
      <td style="text-align:right">${_f(d.pizza/dn)}</td>
      <td style="text-align:right">${_f(d.pizza_ctvrt/dn)}</td>
      <td style="text-align:right">${_f(d.burger/dn)}</td>
      <td style="text-align:right">${_f(d.bgulas/dn)}</td>
    </tr>
    <tr id="${id}" style="display:none">
      <td colspan="11" style="padding:0">
        <div id="${id}_content" style="padding:.5rem 1rem;background:var(--bg)">
          <div class="loading-center"><span class="spinner"></span></div>
        </div>
      </td>
    </tr>`;
  });

  const totDni = tot.dni || 1;
  el.innerHTML = `<div style="overflow-x:auto"><table style="width:100%;min-width:800px;border-collapse:collapse;font-size:.92rem">
    <thead><tr style="font-size:.78rem;color:var(--txt2);border-bottom:1px solid var(--border)">
      <th style="text-align:left;padding:6px 8px;min-width:130px">Měsíc</th>
      <th style="text-align:right;padding:6px 8px">Tržba</th>
      <th style="text-align:right;padding:6px 8px">Tržba vč.PK</th>
      <th style="text-align:right;padding:6px 8px">Karty</th>
      <th style="text-align:right;padding:6px 8px">Hotovost</th>
      <th style="text-align:right;padding:6px 8px">PK 50</th>
      <th style="text-align:right;padding:6px 8px">PK 100</th>
      <th style="text-align:right;padding:6px 8px">Pizza</th>
      <th style="text-align:right;padding:6px 8px">¼ Pizza</th>
      <th style="text-align:right;padding:6px 8px">Burger</th>
      <th style="text-align:right;padding:6px 8px">B-guláš</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr style="font-weight:600;border-top:1.5px solid var(--border)">
        <td style="padding:6px 8px">Celkem</td>
        <td style="text-align:right;padding:6px 8px">${_n(tot.trzba)}</td>
        <td style="text-align:right;padding:6px 8px">${_n(tot.trzba_vcpk)}</td>
        <td style="text-align:right;padding:6px 8px">${_n(tot.karty)}</td>
        <td style="text-align:right;padding:6px 8px">${_n(tot.hotovost)}</td>
        <td style="text-align:right;padding:6px 8px">${_n(tot.pk50)}</td>
        <td style="text-align:right;padding:6px 8px">${_n(tot.pk100)}</td>
        <td style="text-align:right;padding:6px 8px">${_n(tot.pizza)}</td>
        <td style="text-align:right;padding:6px 8px">${_n(tot.pizza_ctvrt)}</td>
        <td style="text-align:right;padding:6px 8px">${_n(tot.burger)}</td>
        <td style="text-align:right;padding:6px 8px">${_n(tot.bgulas)}</td>
      </tr>
      <tr style="color:var(--txt2);background:var(--bg)">
        <td style="padding:6px 8px;font-size:.82rem">ø/den celkem</td>
        <td style="text-align:right;padding:6px 8px">${_n(Math.round(tot.trzba/totDni))}</td>
        <td style="text-align:right;padding:6px 8px">${_n(Math.round(tot.trzba_vcpk/totDni))}</td>
        <td style="text-align:right;padding:6px 8px">${_n(Math.round(tot.karty/totDni))}</td>
        <td style="text-align:right;padding:6px 8px">${_n(Math.round(tot.hotovost/totDni))}</td>
        <td style="text-align:right;padding:6px 8px">${_f(tot.pk50/totDni)}</td>
        <td style="text-align:right;padding:6px 8px">${_f(tot.pk100/totDni)}</td>
        <td style="text-align:right;padding:6px 8px">${_f(tot.pizza/totDni)}</td>
        <td style="text-align:right;padding:6px 8px">${_f(tot.pizza_ctvrt/totDni)}</td>
        <td style="text-align:right;padding:6px 8px">${_f(tot.burger/totDni)}</td>
        <td style="text-align:right;padding:6px 8px">${_f(tot.bgulas/totDni)}</td>
      </tr>
    </tfoot>
  </table></div>`;
}

async function toggleTmDetail(id) {
  const row = document.getElementById(id);
  const arr = document.getElementById(`arr_${id}`);
  if (!row) return;
  const open = row.style.display !== "none";
  row.style.display = open ? "none" : "";
  if (arr) arr.style.transform = open ? "" : "rotate(90deg)";
  if (!open) {
    const parts = id.split("_");
    const rok = parts[1]; const mesic = parts[2];
    const firma = document.getElementById("tmFirma")?.value || "";
    const content = document.getElementById(`${id}_content`);
    if (!content) return;
    let dny;
    try { dny = await api(`/api/statistiky/mesic-detail?rok=${rok}&mesic=${mesic}&firma=${encodeURIComponent(firma)}`); }
    catch { content.innerHTML = "Chyba"; return; }
    if (!dny.length) { content.innerHTML = `<div style="color:var(--txt2);padding:.5rem">Žádná data</div>`; return; }
    const _n = v => (v||0).toLocaleString("cs-CZ");
    content.innerHTML = `<table style="width:100%;font-size:.82rem;border-collapse:collapse">
      <thead><tr style="color:var(--txt2);font-size:.75rem">
        <th style="text-align:left;padding:4px 8px">Datum</th>
        <th style="text-align:right;padding:4px 8px">Tržba</th>
        <th style="text-align:right;padding:4px 8px">Tržba vč.PK</th>
        <th style="text-align:right;padding:4px 8px">Karty</th>
        <th style="text-align:right;padding:4px 8px">Hotovost</th>
        <th style="text-align:right;padding:4px 8px">PK 50</th>
        <th style="text-align:right;padding:4px 8px">PK 100</th>
        <th style="text-align:right;padding:4px 8px">Pizza</th>
        <th style="text-align:right;padding:4px 8px">¼</th>
        <th style="text-align:right;padding:4px 8px">Burger</th>
        <th style="text-align:right;padding:4px 8px">B-guláš</th>
      </tr></thead>
      <tbody>${dny.map(d=>`<tr style="border-top:0.5px solid var(--border)">
        <td style="padding:4px 8px;white-space:nowrap">${czDateShort(d.datum)}</td>
        <td style="text-align:right;padding:4px 8px">${_n(Math.round((d.karty||0)+(d.hotovost||0)+(d.vydaje||0)))}</td>
        <td style="text-align:right;padding:4px 8px"><strong>${_n(d.trzba_vcpk||d.trzba)}</strong></td>
        <td style="text-align:right;padding:4px 8px">${_n(d.karty)}</td>
        <td style="text-align:right;padding:4px 8px">${_n(d.hotovost)}</td>
        <td style="text-align:right;padding:4px 8px">${d.pk50_ks||"—"}</td>
        <td style="text-align:right;padding:4px 8px">${d.pk100_ks||"—"}</td>
        <td style="text-align:right;padding:4px 8px">${d.pizza_cela||"—"}</td>
        <td style="text-align:right;padding:4px 8px">${d.pizza_ctvrt||"—"}</td>
        <td style="text-align:right;padding:4px 8px">${d.burger||"—"}</td>
        <td style="text-align:right;padding:4px 8px">${d.burtgulas||"—"}</td>
      </tr>`).join("")}</tbody>
    </table>`;
  }
}


async function loadPL() {
  const firma    = document.getElementById("tmFirma")?.value || "";
  const rok      = document.getElementById("plRok")?.value || "";
  const rokMarze = document.getElementById("plRokMarze")?.value || rok;
  const rokPL    = document.getElementById("plRokPL")?.value || rok;
  let data, dataNakl, dataMarze, dataPL;
  try {
    [data, dataNakl, dataMarze, dataPL] = await Promise.all([
      api(`/api/statistiky/prehled-pl?firma=${encodeURIComponent(firma)}`),
      api(`/api/statistiky/prehled-pl?firma=${encodeURIComponent(firma)}&rok=${rok}`),
      api(`/api/statistiky/prehled-pl?firma=${encodeURIComponent(firma)}&rok=${rokMarze}`),
      api(`/api/statistiky/prehled-pl?firma=${encodeURIComponent(firma)}&rok=${rokPL}`)
    ]);
  } catch { return; }

  const mesice = data.mesice || [];
  const roky   = data.roky   || [];
  const mesiceNakl  = dataNakl.mesice  || [];
  const rokyNakl    = dataNakl.roky    || [];
  const mesiceMarze = dataMarze.mesice || [];
  const rokyMarze   = dataMarze.roky   || [];
  const mesicePL    = dataPL.mesice    || [];
  const rokyPL      = dataPL.roky      || [];

  const _n = v => v ? Math.round(v).toLocaleString("cs-CZ") : "—";
  const _pct = v => v !== null && v !== undefined ? Math.round(v)+"%" : "—";
  const _zisk = v => {
    if (!v && v !== 0) return "—";
    const c = v >= 0 ? "#16a34a" : "#dc2626";
    return `<span style="color:${c};font-weight:600">${Math.round(v).toLocaleString("cs-CZ")}</span>`;
  };

  // Ruční data pro průměry
  let rucniData = {};
  try {
    const rd = await api("/api/statistiky/rucni-data");
    rd.forEach(r => { rucniData[`${r.rok}_${r.mesic}`] = r.hodnota; });
  } catch {}

  const MCZ = ["","Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];

  // ── Průměry po letech ──
  const elPrum = document.getElementById("plPrumery");
  if (elPrum) {
    const rucniRoky = [...new Set(Object.keys(rucniData).map(k=>k.split("_")[0]))];
    const editRoky = ["2023","2024"].filter(r => !roky.includes(r));
    const vsRoky = [...new Set([...roky, ...rucniRoky, ...editRoky])].filter(r =>
      mesice.some(m => m[r]?.dni > 0) || Object.keys(rucniData).some(k=>k.startsWith(r+"_")) || editRoky.includes(r)
    ).sort();

    let thead = `<tr style="font-size:.78rem;color:var(--txt2)"><th style="text-align:left;padding:5px 8px">Měsíc</th>`;
    vsRoky.forEach(r => { const je = !roky.includes(r); thead += `<th style="text-align:right;padding:5px 8px">${r}${je?' <span style="font-size:10px" title="Ruční">✎</span>':""}</th>`; });
    thead += `</tr>`;
    let tbody = ""; let soucty = {}; let aktivni = {};
    vsRoky.forEach(r => { soucty[r]=0; aktivni[r]=0; });
    for (let mi = 1; mi <= 12; mi++) {
      const m = mesice.find(x => parseInt(x.mesic) === mi) || {mesic: String(mi).padStart(2,"0")};
      let radek = `<tr><td style="padding:5px 8px">${MCZ[mi]}</td>`;
      vsRoky.forEach(r => {
        const d = m[r]; const klic = `${r}_${String(mi).padStart(2,"0")}`; const rucni = rucniData[klic];
        if (d?.dni > 0) {
          const prumer = Math.round(d.trzba_vcpk / d.dni); soucty[r] += prumer; aktivni[r]++;
          radek += `<td style="text-align:right;padding:5px 8px">${prumer.toLocaleString("cs-CZ")}</td>`;
        } else if (rucni) {
          soucty[r] += rucni; aktivni[r]++;
          radek += `<td style="text-align:right;padding:5px 8px;cursor:pointer" onclick="editStatPrumer('${r}','${String(mi).padStart(2,"0")}',${rucni})"><span style="color:var(--txt2)">${Math.round(rucni).toLocaleString("cs-CZ")}</span></td>`;
        } else {
          radek += `<td style="text-align:right;padding:5px 8px;cursor:pointer;color:var(--color-border-secondary)" onclick="editStatPrumer('${r}','${String(mi).padStart(2,"0")}',0)">+</td>`;
        }
      });
      tbody += radek + `</tr>`;
    }
    let tfoot = `<tr style="font-weight:600;border-top:1.5px solid var(--border)"><td style="padding:5px 8px">Σ ø/den za rok</td>`;
    vsRoky.forEach(r => tfoot += `<td style="text-align:right;padding:5px 8px">${_n(soucty[r])}</td>`);
    tfoot += `</tr><tr style="font-size:.78rem;color:var(--txt2)"><td style="padding:4px 8px">Aktivních měs.</td>`;
    vsRoky.forEach(r => tfoot += `<td style="text-align:right;padding:4px 8px">${aktivni[r]}</td>`);
    tfoot += `</tr><tr style="font-size:.78rem;color:var(--txt2)"><td style="padding:4px 8px">Průměr měs./ø/den</td>`;
    vsRoky.forEach(r => tfoot += `<td style="text-align:right;padding:4px 8px">${aktivni[r]>0?_n(Math.round(soucty[r]/aktivni[r])):"—"}</td>`);
    tfoot += `</tr>`;
    elPrum.innerHTML = `<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:.85rem">${thead}<tbody>${tbody}</tbody><tfoot>${tfoot}</tfoot></table></div><div style="font-size:.75rem;color:var(--txt2);margin-top:.4rem">✎ = ruční data · klikni na + pro zadání</div>`;
  }

  // ── Náklady ──
  const elNakl = document.getElementById("plNaklady");
  if (elNakl) {
    const aktRoky = rokyNakl.filter(r => mesiceNakl.some(m => m[r]?.naklady > 0));
    if (!aktRoky.length) { elNakl.innerHTML = `<div style="color:var(--txt2);padding:.5rem">Žádná data</div>`; }
    else {
      let thead = `<tr style="font-size:.78rem;color:var(--txt2)"><th style="text-align:left;padding:5px 8px">Měsíc</th>`;
      aktRoky.forEach(r => thead += `<th style="text-align:right;padding:5px 8px" colspan="4">${r}</th>`);
      thead += `</tr><tr style="font-size:.75rem;color:var(--txt2)"><th></th>`;
      aktRoky.forEach(() => thead += `<th style="text-align:right;padding:4px 6px">Faktury za suroviny</th><th style="text-align:right;padding:4px 6px">Výdaje</th><th style="text-align:right;padding:4px 6px">Výpl.+Odv.</th><th style="text-align:right;padding:4px 6px;font-weight:600">Celkem</th>`);
      thead += `</tr>`;
      let tbody = ""; let tots = {};
      aktRoky.forEach(r => tots[r]={f:0,v:0,p:0,n:0});
      for (let mi = 1; mi <= 12; mi++) {
        const m = mesiceNakl.find(x => parseInt(x.mesic) === mi) || {mesic: String(mi).padStart(2,"0")};
        let radek = `<tr><td style="padding:5px 8px">${MCZ[mi]}</td>`;
        aktRoky.forEach(r => {
          const d = m[r] || {};
          tots[r].f += d.faktury||0; tots[r].v += d.vydaje||0; tots[r].p += (d.vyplaty||0)+(d.odvody||0); tots[r].n += d.naklady||0;
          radek += `<td style="text-align:right;padding:5px 6px;font-size:.82rem">${_n(d.faktury)}</td>`;
          radek += `<td style="text-align:right;padding:5px 6px;font-size:.82rem">${_n(d.vydaje)}</td>`;
          radek += `<td style="text-align:right;padding:5px 6px;font-size:.82rem">${_n((d.vyplaty||0)+(d.odvody||0))}</td>`;
          radek += `<td style="text-align:right;padding:5px 6px;font-weight:600;color:#dc2626">${_n(d.naklady)}</td>`;
        });
        tbody += radek + `</tr>`;
      }
      let tfoot = `<tr style="font-weight:600;border-top:1.5px solid var(--border)"><td style="padding:5px 8px">Celkem</td>`;
      aktRoky.forEach(r => { tfoot += `<td style="text-align:right;padding:5px 6px">${_n(tots[r].f)}</td><td style="text-align:right;padding:5px 6px">${_n(tots[r].v)}</td><td style="text-align:right;padding:5px 6px">${_n(tots[r].p)}</td><td style="text-align:right;padding:5px 6px;color:#dc2626">${_n(tots[r].n)}</td>`; });
      tfoot += `</tr>`;
      elNakl.innerHTML = `<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:.85rem;width:100%">${thead}<tbody>${tbody}</tbody><tfoot>${tfoot}</tfoot></table></div>`;
    }
  }

  // ── Marže ──
  const elMarze = document.getElementById("plMarze");
  if (elMarze) {
    const aktRoky = rokyMarze.filter(r => mesiceMarze.some(m => m[r]?.trzba_vcpk > 0));
    if (!aktRoky.length) { elMarze.innerHTML = `<div style="color:var(--txt2);padding:.5rem">Žádná data</div>`; }
    else {
      let thead = `<tr style="font-size:.78rem;color:var(--txt2)"><th style="text-align:left;padding:5px 8px">Měsíc</th>`;
      aktRoky.forEach(r => thead += `<th style="text-align:right;padding:5px 8px" colspan="3">${r}</th>`);
      thead += `</tr><tr style="font-size:.75rem;color:var(--txt2)"><th></th>`;
      aktRoky.forEach(() => thead += `<th style="text-align:right;padding:4px 6px">Tržba vč.PK</th><th style="text-align:right;padding:4px 6px">Faktury za suroviny</th><th style="text-align:right;padding:4px 6px">Marže %</th>`);
      thead += `</tr>`;
      let tbody = ""; let tots = {};
      aktRoky.forEach(r => tots[r]={t:0,f:0});
      for (let mi = 1; mi <= 12; mi++) {
        const m = mesiceMarze.find(x => parseInt(x.mesic) === mi) || {mesic: String(mi).padStart(2,"0")};
        let radek = `<tr><td style="padding:5px 8px">${MCZ[mi]}</td>`;
        aktRoky.forEach(r => {
          const d = m[r] || {}; tots[r].t += d.trzba_vcpk||0; tots[r].f += d.faktury||0;
          const pct = d.faktury > 0 ? ((d.trzba_vcpk - d.faktury)/d.faktury*100) : null;
          const pc = pct !== null ? (pct >= 100 ? "#16a34a" : pct >= 50 ? "#d97706" : "#dc2626") : "";
          radek += `<td style="text-align:right;padding:5px 6px;font-size:.82rem">${_n(d.trzba_vcpk)}</td>`;
          radek += `<td style="text-align:right;padding:5px 6px;font-size:.82rem;color:#dc2626">${_n(d.faktury)}</td>`;
          radek += `<td style="text-align:right;padding:5px 6px;font-weight:600;color:${pc}">${pct!==null?Math.round(pct)+"%":"—"}</td>`;
        });
        tbody += radek + `</tr>`;
      }
      let tfoot = `<tr style="font-weight:600;border-top:1.5px solid var(--border)"><td style="padding:5px 8px">Celkem</td>`;
      aktRoky.forEach(r => {
        const pct = tots[r].f > 0 ? ((tots[r].t - tots[r].f)/tots[r].f*100) : null;
        const pc = pct !== null ? (pct >= 100 ? "#16a34a" : pct >= 50 ? "#d97706" : "#dc2626") : "";
        tfoot += `<td style="text-align:right;padding:5px 6px">${_n(tots[r].t)}</td><td style="text-align:right;padding:5px 6px;color:#dc2626">${_n(tots[r].f)}</td><td style="text-align:right;padding:5px 6px;color:${pc}">${pct!==null?Math.round(pct)+"%":"—"}</td>`;
      });
      tfoot += `</tr>`;
      elMarze.innerHTML = `<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:.85rem;width:100%">${thead}<tbody>${tbody}</tbody><tfoot>${tfoot}</tfoot></table></div>`;
    }
  }

  // ── P&L ──
  const elPL = document.getElementById("plTotal");
  if (elPL) {
    const aktRoky = rokyPL.filter(r => mesicePL.some(m => m[r]?.trzba_vcpk > 0 || m[r]?.naklady > 0));
    if (!aktRoky.length) { elPL.innerHTML = `<div style="color:var(--txt2);padding:.5rem">Žádná data</div>`; }
    else {
      let thead = `<tr style="font-size:.78rem;color:var(--txt2)"><th style="text-align:left;padding:5px 8px">Měsíc</th>`;
      aktRoky.forEach(r => thead += `<th style="text-align:right;padding:5px 8px" colspan="3">${r}</th>`);
      thead += `</tr><tr style="font-size:.75rem;color:var(--txt2)"><th></th>`;
      aktRoky.forEach(() => thead += `<th style="text-align:right;padding:4px 6px">Příjmy vč.PK</th><th style="text-align:right;padding:4px 6px">Všechny výdaje</th><th style="text-align:right;padding:4px 6px">Zůstatek</th>`);
      thead += `</tr>`;
      let tbody = ""; let tots = {};
      aktRoky.forEach(r => tots[r]={t:0,n:0,p:0});
      for (let mi = 1; mi <= 12; mi++) {
        const m = mesicePL.find(x => parseInt(x.mesic) === mi) || {mesic: String(mi).padStart(2,"0")};
        const mame = aktRoky.some(r => m[r]?.trzba_vcpk > 0);
        if (!mame) { let radek = `<tr><td style="padding:5px 8px">${MCZ[mi]}</td>`; aktRoky.forEach(() => { radek += `<td style="text-align:right;padding:5px 6px;color:var(--txt2)">—</td><td style="text-align:right;padding:5px 6px;color:var(--txt2)">—</td><td style="text-align:right;padding:5px 6px;color:var(--txt2)">—</td>`; }); tbody += radek + `</tr>`; continue; }
        let radek = `<tr><td style="padding:5px 8px">${MCZ[mi]}</td>`;
        aktRoky.forEach(r => {
          const d = m[r] || {}; tots[r].t += d.trzba_vcpk||0; tots[r].n += d.naklady||0; tots[r].p += d.pl||0;
          radek += `<td style="text-align:right;padding:5px 6px;font-size:.82rem">${_n(d.trzba_vcpk)}</td>`;
          radek += `<td style="text-align:right;padding:5px 6px;font-size:.82rem;color:#dc2626">${_n(d.naklady)}</td>`;
          radek += `<td style="text-align:right;padding:5px 6px">${_zisk(d.pl)}</td>`;
        });
        tbody += radek + `</tr>`;
      }
      let tfoot = `<tr style="font-weight:600;border-top:1.5px solid var(--border)"><td style="padding:5px 8px">Celkem</td>`;
      aktRoky.forEach(r => { tfoot += `<td style="text-align:right;padding:5px 6px">${_n(tots[r].t)}</td><td style="text-align:right;padding:5px 6px;color:#dc2626">${_n(tots[r].n)}</td><td style="text-align:right;padding:5px 6px">${_zisk(tots[r].p)}</td>`; });
      tfoot += `</tr>`;
      elPL.innerHTML = `<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:.85rem;width:100%">${thead}<tbody>${tbody}</tbody><tfoot>${tfoot}</tfoot></table></div>`;
    }
  }
}

async function editStatPrumer(rok, mesic, aktHodnota) {
  const MCZ2 = ["","Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];
  const nova = prompt(`Průměrná denní tržba vč.PK — ${MCZ2[parseInt(mesic)]} ${rok}:
(0 = smazat)`, aktHodnota || "");
  if (nova === null) return;
  const val = parseFloat(nova.replace(/\s/g,"").replace(",","."));
  if (isNaN(val)) { toast("Neplatná hodnota"); return; }
  if (val === 0) {
    await api("/api/statistiky/rucni-data", {method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({rok,mesic,typ:"trzba_vcpk_prumer"})});
    toast("Smazáno ✓");
  } else {
    await api("/api/statistiky/rucni-data", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rok,mesic,hodnota:val,typ:"trzba_vcpk_prumer"})});
    toast(`Uloženo ✓`);
  }
  loadPL();
}

// ═══════════════════════════════════════════════════════════════
//  STATISTIKY
// ═══════════════════════════════════════════════════════════════

async function renderStatistiky() {
  const rokAkt = new Date().getFullYear();
  const od = new Date(); od.setFullYear(od.getFullYear()-1);
  const odStr = od.toISOString().split("T")[0];
  const doStr = (()=>{const _x=new Date();return `${_x.getFullYear()}-${String(_x.getMonth()+1).padStart(2,"0")}-${String(_x.getDate()).padStart(2,"0")}`;})() ;

  document.getElementById("mainContent").innerHTML = `
    <div class="page-header"><h1 class="page-title">Statistiky</h1></div>

    <div class="card" style="margin-bottom:1.5rem">
      <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:1rem;flex-wrap:wrap">
        <label style="font-size:.85rem;color:var(--txt2)">Rok:</label>
        <select id="tmRok" onchange="loadTrzbyMesice()" style="font-size:.85rem">
          <option value="">Vše</option>
          ${[rokAkt,rokAkt-1,rokAkt-2,rokAkt-3,rokAkt-4].map(r=>`<option value="${r}">${r}</option>`).join("")}
        </select>
        <label style="font-size:.85rem;color:var(--txt2)">Firma:</label>
        <select id="tmFirma" class="firma-select" onchange="loadTrzbyMesice();loadPL()" style="font-size:.85rem">
          <option value="">Všechny</option>
          ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
        </select>
      </div>
      <div id="tmTabulka"><div class="loading-center"><span class="spinner"></span></div></div>
    </div>

    <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem;margin-bottom:1rem">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
          <span class="card-title" style="margin:0">Marže — tržba vč.PK / nákupy za suroviny</span>
          <select id="plRokMarze" onchange="loadPL()" style="font-size:.82rem">
            <option value="">Vše</option>
            ${[rokAkt,rokAkt-1,rokAkt-2,rokAkt-3,rokAkt-4].map(r=>`<option value="${r}" ${r==rokAkt?"selected":""}>${r}</option>`).join("")}
          </select>
        </div>
        <div id="plMarze"><div class="loading-center"><span class="spinner"></span></div></div>
      </div>
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
          <span class="card-title" style="margin:0">Náklady po měsících</span>
          <select id="plRok" onchange="loadPL()" style="font-size:.82rem">
            <option value="">Vše</option>
            ${[rokAkt,rokAkt-1,rokAkt-2,rokAkt-3,rokAkt-4].map(r=>`<option value="${r}" ${r==rokAkt?"selected":""}>${r}</option>`).join("")}
          </select>
        </div>
        <div id="plNaklady"><div class="loading-center"><span class="spinner"></span></div></div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1rem;margin-bottom:1.5rem">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
          <span class="card-title" style="margin:0">P&amp;L — příjmy vč. PK vs. všechny výdaje</span>
          <select id="plRokPL" onchange="loadPL()" style="font-size:.82rem">
            <option value="">Vše</option>
            ${[rokAkt,rokAkt-1,rokAkt-2,rokAkt-3,rokAkt-4].map(r=>`<option value="${r}" ${r==rokAkt?"selected":""}>${r}</option>`).join("")}
          </select>
        </div>
        <div id="plTotal"><div class="loading-center"><span class="spinner"></span></div></div>
      </div>
      <div class="card">
        <div class="card-title" style="margin-bottom:.75rem">Průměrná denní tržba vč. PK — po letech</div>
        <div id="plPrumery"><div class="loading-center"><span class="spinner"></span></div></div>
      </div>
    </div>

    <div class="card" style="margin-bottom:1.5rem">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.5rem">
        <span class="card-title" style="margin:0">Grafy</span>
        <select id="grafTyp" style="font-size:.82rem"><option value="">— vybrat graf —</option></select>
      </div>
      <div id="grafContainer" style="min-height:80px;display:flex;align-items:center;justify-content:center;color:var(--txt2);font-size:.85rem">Vyberte graf</div>
    </div>`;

  loadTrzbyMesice();
  loadPL();
}

// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  NASTAVENÍ
// ═══════════════════════════════════════════════════════════════
async function renderNastaveni() {
  const cfg = await api("/api/config").catch(()=>App.config);
  const icoMap = cfg.ico_map || {};
  const firmy  = cfg.firmy || [];

  const icoRows = firmy.map(f => `
    <tr>
      <td style="padding:.4rem .5rem;font-weight:600">${escHtml(f)}</td>
      <td style="padding:.4rem .5rem">
        <input class="form-control ico-input" data-firma="${escHtml(f)}"
          value="${escHtml(icoMap[Object.keys(icoMap).find(k=>icoMap[k]===f)||'']||'')}"
          placeholder="IČO firmy (8 číslic)" style="max-width:180px">
      </td>
    </tr>`).join("");

  // Načti aktuální oprávnění
  let prava = {};
  try { prava = await api("/api/prava"); } catch(e) {}

  const SEKCE = [
    { klic: "faktury_zobrazit",  label: "Faktury — zobrazit" },
    { klic: "faktury_upravit",   label: "Faktury — přidat / upravit" },
    { klic: "faktury_smazat",    label: "Faktury — mazat" },
    { klic: "faktury_export",    label: "Faktury — export" },
    { klic: "reporty_zobrazit",  label: "Reporty — zobrazit" },
    { klic: "reporty_upravit",   label: "Reporty — přidat / upravit" },
    { klic: "vyplaty_zobrazit",  label: "Výplaty — zobrazit" },
    { klic: "vyplaty_upravit",   label: "Výplaty — upravit" },
    { klic: "zbozi_zobrazit",    label: "Zboží — zobrazit" },
    { klic: "vydaje_zobrazit",          label: "Výdaje — zobrazit" },
    { klic: "vydaje_upravit",           label: "Výdaje — přidat/upravit" },
    { klic: "vydaje_smazat",            label: "Výdaje — mazat" },
    { klic: "soukrome_vydaje_zobrazit", label: "Soukromé výdaje — zobrazit" },
    { klic: "soukrome_vydaje_upravit",  label: "Soukromé výdaje — přidat/upravit" },
    { klic: "soukrome_vydaje_smazat",   label: "Soukromé výdaje — mazat" },
    { klic: "naklady_zobrazit",  label: "Náklady — zobrazit" },
    { klic: "bankovni_vypisy",   label: "Bankovní výpisy" },
    { klic: "banky_soukrome",    label: "Banky — Radek osobní" },
    { klic: "statistiky",        label: "Statistiky" },
    { klic: "nastaveni",         label: "Nastavení" },
    { klic: "kalkulace",         label: "Kalkulace" },
    { klic: "upozorneni",        label: "Upozornění (Nástěnka)" },
  ];

  const pravaNastaveniRows = SEKCE.map(s => {
    const chkV = (prava.verunka?.[s.klic]) ? "checked" : "";
    const chkU = (prava.ucetni?.[s.klic])  ? "checked" : "";
    return `<tr>
      <td style="padding:.5rem .5rem">${s.label}</td>
      <td style="padding:.5rem .5rem;text-align:center">
        <input type="checkbox" class="prava-check" data-role="verunka" data-sekce="${s.klic}" ${chkV}
          style="width:18px;height:18px;cursor:pointer">
      </td>
      <td style="padding:.5rem .5rem;text-align:center">
        <input type="checkbox" class="prava-check" data-role="ucetni" data-sekce="${s.klic}" ${chkU}
          style="width:18px;height:18px;cursor:pointer">
      </td>
    </tr>`;
  }).join("");

  document.getElementById("mainContent").innerHTML = `
    <div class="page-header"><h1 class="page-title">Nastavení</h1></div>
    <div class="card" style="max-width:560px">
      <div class="form-group">
        <label class="form-label">Název aplikace</label>
        <input id="cfgNazev" class="form-control" value="${escHtml(cfg.app_nazev)}">
      </div>
      <div class="form-group">
        <label class="form-label">Zkratky firem (oddělte čárkou)</label>
        <input id="cfgFirmy" class="form-control" value="${escHtml(firmy.join(", "))}">
        <small style="color:var(--txt2)">Příklad: FP, MR, CFF</small>
      </div>
      <div class="form-group">
        <label class="form-label">IČO firem <small style="color:var(--txt2)">(pro automatické rozpoznání při nahrání faktury)</small></label>
        <table style="width:100%">
          <thead><tr>
            <th style="padding:.4rem .5rem;text-align:left">Firma</th>
            <th style="padding:.4rem .5rem;text-align:left">IČO</th>
          </tr></thead>
          <tbody>${icoRows}</tbody>
        </table>
      </div>
      <div class="grid-2" style="gap:.8rem;margin-top:1rem;max-width:500px">
        <div class="form-group">
          <label class="form-label">💳 Limit terminálu / měsíc (Kč)</label>
          <input type="number" id="cfgTerminalLimit" class="form-control"
            value="${App.config.terminal_limit||100000}">
        </div>
        <div class="form-group">
          <label class="form-label">📊 Roční DPH limit (Kč)</label>
          <input type="number" id="cfgDphLimit" class="form-control"
            value="${App.config.dph_limit||2000000}">
        </div>
      </div>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-top:.5rem">
        <button class="btn btn-primary" onclick="saveConfig()">💾 Uložit nastavení</button>
        <button class="btn" style="background:var(--accent);color:#1a1a1a" onclick="opravDuplicity()">🔍 Najít duplicity</button>
        <button class="btn" style="background:#6c757d;color:#fff" onclick="normalizujNazvy()">🧹 Odstranit ARO/MC/FL prefixy</button>
        <button class="btn" style="background:#2563eb;color:#fff" onclick="stahnoutZalohu()">📦 Záloha do GCS</button>
        <button class="btn btn-secondary btn-sm" onclick="stahnoutSqlDump()" id="btnSqlZaloha">💾 SQL záloha → GCS</button>
        <span id="zalohaStatus" style="margin-left:.75rem;font-size:.9rem;color:var(--txt2)"></span>
      </div>

      <div style="margin-top:1rem">
        <div style="font-size:.85rem;font-weight:600;margin-bottom:.5rem">📋 Uložené zálohy v Google Cloud</div>
        <div id="zalohySeznam"><div class="loading-center"><span class="spinner"></span></div></div>
      </div>

      <hr style="margin:1.5rem 0">

      <!-- MATICE OPRÁVNĚNÍ -->
      <div>
        <h3 style="margin:0 0 .75rem;font-size:1rem">👥 Oprávnění uživatelů</h3>
        <p style="color:var(--txt2);font-size:.85rem;margin-bottom:1rem">
          Admin má vždy vše. Kliknutím na čtvereček povoluješ nebo zakazuješ přístup.
        </p>
        <table style="max-width:500px;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:2px solid var(--border)">
              <th style="padding:.5rem;text-align:left">Sekce</th>
              <th style="padding:.5rem;text-align:center;width:90px">VERUNKA</th>
              <th style="padding:.5rem;text-align:center;width:90px">UCETNI</th>
            </tr>
          </thead>
          <tbody id="pravaTbody">${pravaNastaveniRows}</tbody>
        </table>
        <button class="btn btn-primary" style="margin-top:1rem" onclick="ulozitPrava()">
          💾 Uložit oprávnění
        </button>
        <span id="pravaSaveStatus" style="margin-left:.75rem;font-size:.9rem;color:var(--txt2)"></span>
      </div>

      <hr style="margin:1.5rem 0">
      <div style="border:1px solid var(--border);border-radius:8px;padding:1rem">
        <div style="font-weight:600;margin-bottom:.5rem">📱 Automatické nahrávání z mobilu</div>
        <div style="color:var(--txt2);font-size:.9rem;margin-bottom:.75rem">
          Sleduje složku <strong>faktury-nahrat</strong> v Google Drive. Nové PDF se automaticky zpracují OCR a objeví se v sekci Faktury se stavem <em>Ke zpracování</em>.
        </div>
        <button class="btn btn-primary" onclick="registrovatDriveWebhook()">🔗 Aktivovat sledování Drive složky</button>
        <span id="driveWebhookStatus" style="margin-left:.75rem;font-size:.9rem;color:var(--txt2)"></span>
        <button class="btn btn-secondary" onclick="zkontrolovatDriveNyni()" style="margin-top:.5rem">🔄 Zkontrolovat Drive nyní</button>
        <span id="driveCheckStatus" style="margin-left:.75rem;font-size:.9rem;color:var(--txt2)"></span>
      </div>



      <hr style="margin:1.5rem 0">
      <div style="border:1px solid #e55;border-radius:8px;padding:1rem;background:#fff5f5">
        <div style="font-weight:600;color:#c00;margin-bottom:.5rem">⚠️ Nebezpečná zóna</div>
        <div style="color:var(--txt2);font-size:.9rem;margin-bottom:.75rem">Smaže všechny faktury a položky. Akce je nevratná!</div>
        <button class="btn" style="background:#c00;color:#fff" onclick="smazatVseFaktury()">🗑️ Smazat všechny faktury</button>
      </div>
    </div>`;
  loadZalohy();
}

async function ulozitPrava() {
  const statusEl = document.getElementById("pravaSaveStatus");
  statusEl.textContent = "Ukládám...";
  const prava = { verunka: {}, ucetni: {} };
  document.querySelectorAll(".prava-check").forEach(chk => {
    const role  = chk.dataset.role;
    const sekce = chk.dataset.sekce;
    prava[role][sekce] = chk.checked;
  });
  try {
    await api("/api/prava", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(prava)
    });
    statusEl.textContent = "✅ Uloženo";
    setTimeout(() => statusEl.textContent = "", 2000);
    // Aktualizuj oprávnění v App (pokud jsme sami verunka/ucetni — nepravděpodobné ale pro jistotu)
    if (App.role !== "admin") {
      App.prava = prava[App.role] || {};
      skryjNepovoleneMenu();
    }
  } catch(e) {
    statusEl.textContent = "❌ Chyba při ukládání";
  }
}

// ===== GOOGLE DRIVE PICKER =====
let _driveClientId = null;
let _driveAccessToken = null;
let _drivePickerCallback = null;

async function getDriveClientId() {
  if (_driveClientId) return _driveClientId;
  const cfg = await api("/api/drive-config");
  _driveClientId = cfg.client_id;
  return _driveClientId;
}

function loadGapiIfNeeded() {
  return new Promise((resolve) => {
    if (window.gapi && window.gapi.load) { resolve(); return; }
    const check = setInterval(() => {
      if (window.gapi && window.gapi.load) { clearInterval(check); resolve(); }
    }, 100);
  });
}

async function openDrivePicker(callback) {
  _drivePickerCallback = callback;
  const clientId = await getDriveClientId();
  if (!clientId) { toast("Google Drive není nakonfigurováno", true); return; }

  // Pokud již máme token, rovnou otevřít picker
  if (_driveAccessToken) { _openPickerWithToken(_driveAccessToken); return; }

  // Přihlásit přes Google OAuth
  try {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      callback: (resp) => {
        if (resp.error) { toast("Přihlášení Google selhalo: " + resp.error, true); return; }
        _driveAccessToken = resp.access_token;
        _openPickerWithToken(_driveAccessToken);
      }
    });
    client.requestAccessToken();
  } catch(e) {
    toast("Chyba Google přihlášení: " + e.message, true);
  }
}

async function _openPickerWithToken(token) {
  await loadGapiIfNeeded();
  gapi.load("picker", () => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes("application/pdf")
      .setMode(google.picker.DocsViewMode.LIST);
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setTitle("Vyberte PDF fakturu z Google Drive")
      .setCallback(async (data) => {
        if (data.action !== google.picker.Action.PICKED) return;
        const file = data.docs[0];
        toast("⏳ Stahuji z Google Drive...");
        try {
          const res = await api("/api/drive-download", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({ file_id: file.id, access_token: token, filename: file.name })
          });
          if (res.error) { toast("Chyba: " + res.error, true); return; }
          if (_drivePickerCallback) _drivePickerCallback(res);
        } catch(e) { toast("Chyba stahování: " + e.message, true); }
      })
      .build();
    picker.setVisible(true);
  });
}

async function registrovatDriveWebhook() {
  const statusEl = document.getElementById("driveWebhookStatus");
  if (statusEl) statusEl.textContent = "⏳ Aktivuji...";
  try {
    const res = await api("/api/drive-registruj", { method: "POST" });
    if (res.error) { if (statusEl) statusEl.textContent = "❌ " + res.error; return; }
    const exp = res.expiration ? new Date(parseInt(res.expiration)).toLocaleDateString("cs-CZ") : "7 dní";
    if (statusEl) statusEl.textContent = `✅ Aktivováno (platí do ${exp})`;
  } catch(e) {
    if (statusEl) statusEl.textContent = "❌ " + e.message;
  }
}
async function zkontrolovatDriveMobil() {
  const statusEl = document.getElementById("mobilDriveStatus");
  if (statusEl) statusEl.innerHTML = `<span class="spinner"></span> Kontroluji Drive složku...`;
  try {
    const res = await api("/api/drive-zkontrolovat", { method: "POST" });
    if (res.error) {
      if (statusEl) statusEl.innerHTML = `❌ Chyba: ${res.error}`;
      return;
    }
    const stazeno = res.stazeno || 0;
    const preskoceno = res.preskoceno || 0;
    const chyby = res.chyby || 0;
    let msg = stazeno > 0
      ? `✅ Staženo <strong>${stazeno}</strong> nových faktur`
      : `ℹ️ Žádné nové faktury`;
    if (preskoceno > 0) msg += ` &nbsp;|&nbsp; ⏭ ${preskoceno} přeskočeno (již zpracováno)`;
    if (chyby > 0) msg += ` &nbsp;|&nbsp; ⚠️ ${chyby} chyb`;
    if (statusEl) statusEl.innerHTML = msg;
    if (stazeno > 0) loadFaktury();
  } catch(e) {
    if (statusEl) statusEl.innerHTML = `❌ ${e.message}`;
  }
}

async function zkontrolovatDriveNyni() {
  const statusEl = document.getElementById("driveCheckStatus");
  if (statusEl) statusEl.textContent = "⏳ Kontroluji...";
  try {
    const res = await api("/api/drive-zkontrolovat", { method: "POST" });
    if (res.error) { if (statusEl) statusEl.textContent = "❌ " + res.error; return; }
    if (statusEl) statusEl.textContent = `✅ Hotovo – staženo ${res.stazeno} souborů`;
  } catch(e) {
    if (statusEl) statusEl.textContent = "❌ " + e.message;
  }
}

async function stahnoutSqlDump() {
  const statusEl = document.getElementById("zalohaStatus");
  if (statusEl) statusEl.textContent = "⏳ Připravuji zálohu...";
  try {
    const resp = await fetch("/api/zaloha-db", { credentials: "same-origin" });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || resp.statusText);
    }
    const blob = await resp.blob();
    const cd = resp.headers.get("Content-Disposition") || "";
    const gcsUrl = resp.headers.get("X-GCS-URL");
    const fnMatch = cd.match(/filename=([^\s;]+)/);
    const filename = fnMatch ? fnMatch[1] : "zaloha.sql";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const gcsInfo = gcsUrl ? " + uloženo do GCS" : "";
    if (statusEl) { statusEl.textContent = `✅ Staženo${gcsInfo}`; setTimeout(() => statusEl.textContent = "", 4000); }
    if (gcsUrl) loadZalohy();
  } catch(e) {
    if (statusEl) statusEl.textContent = "❌ " + e.message;
    toast("Záloha selhala: " + e.message, true);
  }
}

async function stahnoutZalohu() {
  const btn = document.querySelector('[onclick="stahnoutZalohu()"]');
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Zálohuje se..."; }
  toast("Vytvářím zálohu...");
  try {
    const r = await api("/api/admin/zaloha-export", {method:"POST"});
    if (r.ok) {
      toast(`Záloha uložena do GCS: ${r.soubor} ✓`);
      loadZalohy();
      if (btn) { btn.disabled = false; btn.textContent = '📦 Záloha do GCS'; }
    }
  } catch { toast("Chyba při záloze", true); }
}

async function loadZalohy() {
  const el = document.getElementById("zalohySeznam");
  if (!el) return;
  try {
    const r = await api("/api/admin/zalohy");
    if (!r.zalohy?.length) { el.innerHTML = `<div style="color:var(--txt2);font-size:.85rem">Žádné zálohy</div>`; return; }
    el.innerHTML = r.zalohy.map(z => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:.4rem 0;border-bottom:0.5px solid var(--border)">
        <div>
          <span style="font-size:.85rem">${escHtml(z.nazev)}</span>
          <small style="color:var(--txt2);margin-left:.5rem">${z.velikost ? Math.round(z.velikost/1024)+' KB' : ''}</small>
        </div>
        <a href="/api/admin/zaloha-stahnout/${encodeURIComponent(z.nazev)}" class="btn btn-secondary btn-sm">⬇ Stáhnout</a>
      </div>`).join("");
  } catch { el.innerHTML = `<div style="color:var(--txt2);font-size:.85rem">Nepodařilo se načíst</div>`; }
}

async function opravDuplicity() {
  try {
    const res = await api("/api/oprav-duplicity", { method: "POST" });
    if (res.ok) {
      toast(`Hotovo – označeno ${res.opraveno} duplikát${res.opraveno === 1 ? "" : res.opraveno < 5 ? "y" : "ů"} ✓`);
    } else {
      toast("Chyba: " + (res.chyba || "neznámá"), true);
    }
  } catch (e) {
    toast("Chyba při kontrole duplicit", true);
  }
}

async function smazatVseFaktury() {
  if (!confirm("Opravdu smazat VŠECHNY faktury? Tato akce je nevratná!")) return;
  if (!confirm("Jste si 100% jistý? Smažou se všechny faktury a položky.")) return;
  try {
    const res = await api("/api/smazat-vse-faktury", { method: "POST" });
    if (res.ok) {
      toast(`Smazáno ${res.smazano} faktur ✓`);
      navigate("faktury");
    } else {
      toast("Chyba při mazání", true);
    }
  } catch (e) {
    toast("Chyba při mazání", true);
  }
}

async function normalizujNazvy() {
  if (!confirm("Odstranit prefixy ARO, MC, FL z názvů všech položek? Akce je nevratná.")) return;
  try {
    const res = await api("/api/normalizuj-nazvy", { method: "POST" });
    if (res.ok) {
      toast(`Hotovo – upraveno ${res.opraveno} názvů ✓`);
    } else {
      toast("Chyba", true);
    }
  } catch (e) {
    toast("Chyba při normalizaci", true);
  }
}

async function saveConfig() {
  const nazev = document.getElementById("cfgNazev").value.trim();
  const firmy = document.getElementById("cfgFirmy").value.split(",").map(s=>s.trim()).filter(Boolean);
  if (!firmy.length) { toast("Zadejte alespoň jednu firmu", true); return; }

  const ico_map = {};
  document.querySelectorAll(".ico-input").forEach(inp => {
    const ico = inp.value.trim().replace(/\s/g,"");
    const firma = inp.dataset.firma;
    if (ico && firma) ico_map[ico] = firma;
  });

  await api("/api/config", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      app_nazev: nazev, firmy, ico_map,
      terminal_limit: parseInt(document.getElementById("cfgTerminalLimit")?.value)||100000,
      dph_limit: parseInt(document.getElementById("cfgDphLimit")?.value)||2000000
    })
  });
  await loadConfig();
  toast("Nastavení uloženo ✓");
}

// ═══════════════════════════════════════════════════════════════
//  Util
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
function renderAiAsistent() {
  const rok = new Date().getFullYear();
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header"><h1 class="page-title">🤖 AI asistent</h1></div>
    <div class="filters" style="margin-bottom:1rem">
      <label>Firma:</label>
      <select id="sFirma" class="firma-select">
        <option value="">Všechny</option>
        ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
      </select>
      <label>Rok:</label>
      <select id="sRok">
        ${rokOptions(rok)}
      </select>
    </div>
    <div id="statAiChat"></div>`;
  initAiChat();
}

function initAiChat() {
  const el = document.getElementById("statAiChat");
  if (!el) return;
  el._historie = [];
  el.innerHTML = `
    <div class="card">
      <div class="card-title" style="display:flex;align-items:center;gap:.5rem">
        🤖 AI asistent
        <span style="font-size:.75rem;color:var(--txt2);font-weight:400">— zeptej se na data, požádej o export CSV...</span>
      </div>
      <div id="aiHistorie" style="max-height:320px;overflow-y:auto;margin-bottom:.75rem;display:flex;flex-direction:column;gap:.5rem"></div>
      <div style="display:flex;gap:.5rem">
        <input id="aiDotazInput" class="form-control" placeholder="Kolik burgerů bylo v únoru? Nebo: udělej CSV výpis karet za březen..."
          style="flex:1" onkeydown="if(event.key==='Enter')odeslitAiDotaz()">
        <button class="btn btn-primary btn-sm" onclick="odeslitAiDotaz()" id="aiOdeslatBtn">→ Odeslat</button>
      </div>
    </div>`;
}

async function odeslitAiDotaz() {
  const input = document.getElementById("aiDotazInput");
  const btn   = document.getElementById("aiOdeslatBtn");
  const hist  = document.getElementById("aiHistorie");
  const dotaz = input?.value?.trim();
  if (!dotaz) return;
  const rok   = document.getElementById("sRok")?.value || new Date().getFullYear();
  const firma = document.getElementById("sFirma")?.value || "";

  // Přidat dotaz do historie
  hist.innerHTML += `<div style="align-self:flex-start;background:var(--primary-bg,#e8f4fd);border-radius:2px 10px 10px 10px;padding:.4rem .75rem;max-width:80%;font-size:.88rem;font-weight:500">${escHtml(dotaz)}</div>`;
  hist.innerHTML += `<div id="aiCekani" style="align-self:flex-start;color:var(--txt2);font-size:.85rem">⏳ Přemýšlím...</div>`;
  hist.scrollTop = hist.scrollHeight;
  input.value = "";
  btn.disabled = true;

  try {
    const resp = await api("/api/ai-dotaz", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({dotaz, rok, firma})
    });
    document.getElementById("aiCekani")?.remove();

    if (resp.chyba) {
      hist.innerHTML += `<div style="align-self:flex-start;color:#ef4444;font-size:.88rem;padding:.4rem .75rem;border:1px solid #fca5a5;border-radius:6px;background:#fef2f2">❌ ${escHtml(resp.chyba)}</div>`;
    } else {
      // Export CSV?
      let exportBtn = "";
      if (resp.export) {
        const blob = new Blob([resp.export.data], {type:"text/csv;charset=utf-8;"});
        const url  = URL.createObjectURL(blob);
        exportBtn  = `<br><a href="${url}" download="${resp.export.nazev}" class="btn btn-secondary btn-sm" style="margin-top:.4rem;font-size:.78rem">⬇ Stáhnout ${escHtml(resp.export.nazev)}</a>`;
      }
      const text = resp.odpoved.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g,'<br>');
      hist.innerHTML += `<div style="align-self:flex-start;background:var(--card-bg);border:1px solid var(--border);border-radius:2px 10px 10px 10px;padding:.4rem .75rem;max-width:90%;font-size:.88rem;line-height:1.5">${text}${exportBtn}</div>`;
      hist.scrollTop = hist.scrollHeight;
    }
  } catch(e) {
    document.getElementById("aiCekani")?.remove();
    hist.innerHTML += `<div style="color:#ef4444;font-size:.85rem">❌ Chyba: ${escHtml(e.message||String(e))}</div>`;
  }
  btn.disabled = false;
  input.focus();
}

async function loadPrehledStatistik() {
  const rok   = document.getElementById("sRok")?.value || new Date().getFullYear();
  const firma = document.getElementById("sFirma")?.value || "";
  const el = document.getElementById("statPrehled");
  if (!el) return;
  el.innerHTML = `<div class="loading-center"><span class="spinner"></span></div>`;
  let data;
  try { data = await api(`/api/statistiky/prehled?rok=${rok}&firma=${encodeURIComponent(firma)}`); } catch { return; }

  const MCZ = ["","Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];
  const sum = {karty:0, hotovost:0, trzba:0, naklady:0, poukazky:0};

  const rows = data.map(d => {
    const mInt = parseInt(d.mesic);
    const mame = d.trzba > 0 || d.karty > 0 || d.hotovost > 0;
    sum.karty    += d.karty    || 0;
    sum.hotovost += d.hotovost || 0;
    sum.trzba    += d.trzba    || 0;
    sum.naklady  += d.naklady  || 0;
    sum.poukazky += d.poukazky || 0;
    return `
      <tr style="${mame ? 'cursor:pointer' : 'color:var(--txt2)'}" onclick="${mame ? `toggleMesicDetail('${rok}','${d.mesic}',this)` : ''}">
        <td><strong>${MCZ[mInt]}</strong> ${mame ? '<span style="font-size:.7rem;color:var(--txt2)">▶</span>' : ''}</td>
        <td style="text-align:right">${mame ? czInt(d.karty||0) : '—'}</td>
        <td style="text-align:right">${mame ? czInt(d.hotovost||0) : '—'}</td>
        <td style="text-align:right">${mame ? '<strong>'+czInt(d.trzba||0)+'</strong>' : '—'}</td>
        <td style="text-align:right">${mame ? czInt(d.naklady||0) : '—'}</td>
        <td style="text-align:right">${mame ? czInt(d.poukazky||0) : '—'}</td>
      </tr>
      <tr id="detail-${rok}-${d.mesic}" style="display:none">
        <td colspan="6" style="padding:0;background:var(--bg)">
          <div id="detail-inner-${rok}-${d.mesic}" style="padding:.5rem 1rem"></div>
        </td>
      </tr>`;
  }).join("");

  el.innerHTML = `
    <div class="card">
      <div class="card-title">📋 Měsíční přehled – ${rok} ${firma ? '· '+firma : ''}</div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Měsíc</th>
          <th style="text-align:right">Karty</th>
          <th style="text-align:right">Hotovost</th>
          <th style="text-align:right">Tržba</th>
          <th style="text-align:right">Náklady</th>
          <th style="text-align:right">Poukazky</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="border-top:2px solid var(--border);font-weight:600">
          <td>Celkem</td>
          <td style="text-align:right">${czInt(sum.karty)}</td>
          <td style="text-align:right">${czInt(sum.hotovost)}</td>
          <td style="text-align:right"><strong>${czInt(sum.trzba)}</strong></td>
          <td style="text-align:right">${czInt(sum.naklady)}</td>
          <td style="text-align:right">${czInt(sum.poukazky)}</td>
        </tr></tfoot>
      </table></div>
    </div>`;
}

async function toggleMesicDetail(rok, mesic, tr) {
  const firma = document.getElementById("sFirma")?.value || "";
  const detailTr    = document.getElementById(`detail-${rok}-${mesic}`);
  const detailInner = document.getElementById(`detail-inner-${rok}-${mesic}`);
  const arrow = tr.querySelector("span");
  if (!detailTr) return;

  // Zavřít
  if (detailTr.style.display !== "none") {
    detailTr.style.display = "none";
    if (arrow) arrow.textContent = "▶";
    return;
  }

  // Otevřít + načíst
  detailTr.style.display = "";
  if (arrow) arrow.textContent = "▼";
  detailInner.innerHTML = `<div class="loading-center"><span class="spinner"></span></div>`;

  let dny;
  try {
    dny = await api(`/api/statistiky/mesic-detail?rok=${rok}&mesic=${mesic}&firma=${encodeURIComponent(firma)}`);
  } catch { detailInner.innerHTML = "Chyba načítání"; return; }

  if (!dny.length) { detailInner.innerHTML = `<em style="color:var(--txt2);font-size:.85rem">Žádné záznamy</em>`; return; }

  const DNY = {"Monday":"Po","Tuesday":"Út","Wednesday":"St","Thursday":"Čt","Friday":"Pá","Saturday":"So","Sunday":"Ne"};
  const dRows = dny.map(d => `
    <tr onclick="editReport(${d.id || 0})" style="cursor:pointer">
      <td style="font-size:.82rem">${d.datum} <span style="color:var(--txt2)">${d.den||''}</span></td>
      <td style="font-size:.82rem;color:var(--txt2)">${escHtml(d.smena||'')}</td>
      <td style="text-align:right;font-size:.82rem">${czInt(d.karty||0)}</td>
      <td style="text-align:right;font-size:.82rem">${czInt(d.hotovost||0)}</td>
      <td style="text-align:right;font-size:.82rem"><strong>${czInt(d.trzba||0)}</strong></td>
      <td style="text-align:right;font-size:.82rem">${czInt(d.pk_celkem||0)}</td>
      <td style="text-align:center;font-size:.82rem">${d.burger||0}/${d.burtgulas||0}/${d.pizza_cela||0}+${d.pizza_ctvrt||0}</td>
    </tr>`).join("");

  detailInner.innerHTML = `
    <table style="width:100%;font-size:.82rem">
      <thead><tr style="font-size:.75rem;color:var(--txt2)">
        <th>Datum</th><th>Směna</th>
        <th style="text-align:right">Karty</th>
        <th style="text-align:right">Hotovost</th>
        <th style="text-align:right">Tržba</th>
        <th style="text-align:right">PK</th>
        <th style="text-align:center">🍔/🍲/🍕</th>
      </tr></thead>
      <tbody>${dRows}</tbody>
    </table>`;
}

async function loadMesicniStatistiky() {
  const firma = document.getElementById("sFirma")?.value || "";
  let mesice, roky;
  try {
    mesice = await api("/api/statistiky/mesice?firma=" + encodeURIComponent(firma));
    roky   = await api("/api/statistiky/roky");
  } catch { return; }
  const el = document.getElementById("statReporty");
  if (!el) return;
  const MCZ = ["","Leden","Únor","Březen","Duben","Květen","Červen","Červenec","Srpen","Září","Říjen","Listopad","Prosinec"];
  const rd = {}; const rs = new Set();
  roky.forEach(r => { rs.add(r.rok); if(!rd[r.mesic]) rd[r.mesic]={}; rd[r.mesic][r.rok]=r.prumer_den; });
  const ra = [...rs].sort();
  const srovRows = Object.entries(rd).sort((a,b)=>a[0].localeCompare(b[0])).map(([m,v])=>
    `<tr><td><strong>${MCZ[parseInt(m)]}</strong></td>${ra.map(r=>`<td style="text-align:right">${v[r]?czMoney(v[r]):"—"}</td>`).join("")}</tr>`).join("");
  const mRows = mesice.map(m=>
    `<tr>
      <td><strong>${m.rok}/${m.mesic}</strong></td>
      <td style="text-align:right">${m.dni}</td>
      <td style="text-align:right"><strong>${czMoney(m.trzba_vcpk_sum)}</strong></td>
      <td style="text-align:right">${czMoney(m.trzba_vcpk_avg)}</td>
      <td style="text-align:right">${czMoney(m.karty_sum)}</td>
      <td style="text-align:right">${czMoney(m.karty_avg)}</td>
      <td style="text-align:right">${czMoney(m.hotovost_sum)}</td>
      <td style="text-align:right">${czMoney(m.vydaje_sum)}</td>
      <td style="text-align:center">${m.pizza_cela_sum}/${m.pizza_cela_avg}/d</td>
      <td style="text-align:center">${m.burger_sum}/${m.burger_avg}/d</td>
      <td style="text-align:center">${m.burtgulas_sum}/${m.burtgulas_avg}/d</td>
      <td style="text-align:center">${m.talire_sum}/${m.talire_avg}/d</td>
    </tr>`).join("");
  el.innerHTML =
    `<div class="card" style="margin-bottom:1rem">
      <div class="card-title">📅 Průměrná denní tržba vč. PK – srovnání let</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Měsíc</th>${ra.map(r=>`<th style="text-align:right">${r}</th>`).join("")}</tr></thead>
        <tbody>${srovRows}</tbody>
      </table></div>
    </div>
    <div class="card">
      <div class="card-title">📊 Měsíční statistiky (Σ součet / ø průměr na den)</div>
      <div class="table-wrap" style="overflow-x:auto"><table style="min-width:900px">
        <thead><tr>
          <th>Měsíc</th><th>Dní</th>
          <th>Tržba Σ</th><th>ø/den</th>
          <th>Karty Σ</th><th>ø/den</th>
          <th>Hotovost Σ</th><th>Výdaje Σ</th>
          <th>🍕 Celá</th><th>🍔 Burger</th><th>🍲 Guláš</th><th>🍽 Talíře</th>
        </tr></thead>
        <tbody>${mRows}</tbody>
      </table></div>
    </div>`;
}

function escHtml(s) {
  return String(s||"")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// ═══════════════════════════════════════════════════════════════
//  REPORTY – Denní výkazy
// ═══════════════════════════════════════════════════════════════

const KARTY_LIMIT = 1500000;

function renderKartaStatNastenka(stats) {
  const firmy = Object.keys(stats);
  if (!firmy.length) return "";
  const ulozeneFirma = localStorage.getItem("aktivni_firma");
  const nekteraAktivni = firmy.some(f => stats[f].aktivni);

  let aktivniFirma = firmy.find(f => stats[f].aktivni);
  if (!aktivniFirma && ulozeneFirma && firmy.includes(ulozeneFirma)) aktivniFirma = ulozeneFirma;
  if (!aktivniFirma) aktivniFirma = firmy[0];

  // Vrátí dva samostatné cardy (Celkem + aktivní firma) bez flex wrapperu
  const statsFiltered = {};
  statsFiltered[aktivniFirma] = { ...stats[aktivniFirma], aktivni: true };

  const souhrn = _kartaSouhrn(stats);
  const aktivniCard = _kartaFirmaCard(aktivniFirma, statsFiltered[aktivniFirma], true);
  return souhrn + aktivniCard;
}

function _kartaSouhrn(stats) {
  const firmy = Object.keys(stats);
  const czInt = v => Math.round(v||0).toLocaleString("cs-CZ");
  const sumKartyM = firmy.reduce((s,f) => s+(stats[f].karty_mesic||0), 0);
  const sumHotM   = firmy.reduce((s,f) => s+(stats[f].hot_mesic||0), 0);
  const sumTrzbaM = firmy.reduce((s,f) => s+(stats[f].trzba_mesic||0), 0);
  const sumKartyR = firmy.reduce((s,f) => s+(stats[f].rocni||0), 0);
  const sumHotR   = firmy.reduce((s,f) => s+(stats[f].hot_rok||0), 0);
  const sumTrzbaR = firmy.reduce((s,f) => s+(stats[f].trzba_rok||0), 0);
  const r = (lbl, m, ro) => `
    <div style="padding:.5rem 0;border-bottom:1px solid var(--border)">
      <div style="font-size:.8rem;color:var(--txt2);margin-bottom:.2rem">${lbl}</div>
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <strong style="font-size:1.15rem">${czInt(m)}</strong>
        <span style="font-size:.85rem;color:var(--txt2)">/ ${czInt(ro)}</span>
      </div>
    </div>`;
  return `<div style="background:#ffffff;border:1px solid var(--border);border-radius:10px;padding:1rem 1.1rem">
    <div style="font-weight:700;font-size:1rem;margin-bottom:.3rem">Celkem</div>
    <div style="display:flex;justify-content:flex-end;font-size:.72rem;color:var(--txt2);margin-bottom:.1rem">měsíc / rok</div>
    ${r('💳 Karty', sumKartyM, sumKartyR)}
    ${r('💵 Hotovost', sumHotM, sumHotR)}
    ${r('📈 Tržba', sumTrzbaM, sumTrzbaR)}
  </div>`;
}

function _kartaFirmaCard(firma, d, jeAktivni) {
  const czInt = v => Math.round(v||0).toLocaleString("cs-CZ");
  const mPct = Math.min(Math.round((d.mesicni||0) / (d.terminal_limit||100000) * 100), 100);
  const rPct = Math.min(Math.round((d.rocni||0)   / (d.dph_limit||2000000)    * 100), 100);
  const mCol = mPct >= 100 ? "#ef4444" : mPct >= 80 ? "#f59e0b" : "#9ca3af";
  const rCol = rPct >= 100 ? "#ef4444" : rPct >= 75 ? "#f59e0b" : "#9ca3af";
  const od   = d.terminal_od ? new Date(d.terminal_od).toLocaleDateString("cs-CZ") : "—";
  const bord = jeAktivni ? '2px solid #16a34a' : '1px solid var(--border)';
  const bar  = (pct,col) => `<div style="background:#e5e7eb;border-radius:3px;height:4px;margin-bottom:.3rem"><div style="background:${col};height:4px;border-radius:3px;width:${pct}%"></div></div>`;
  const r    = (lbl,m,ro) => `<div style="display:flex;justify-content:space-between;font-size:.82rem;padding:.2rem 0;border-bottom:1px solid var(--border)"><span style="color:var(--txt2)">${lbl}</span><span><strong>${czInt(m)}</strong> <span style="color:var(--txt2);font-size:.75rem">/ ${czInt(ro)}</span></span></div>`;
  return `<div style="background:#ffffff;border:${bord};border-radius:10px;padding:.85rem">
    <div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.2rem">
      <span style="font-weight:700;font-size:.95rem">${escHtml(firma)}</span>
      <span style="background:#dcfce7;color:#166534;font-size:.65rem;padding:.1rem .4rem;border-radius:99px;font-weight:600">● kasíruje</span>
    </div>
    <div style="font-size:.7rem;color:var(--txt2);margin-bottom:.4rem">od ${od}</div>
    <div style="display:flex;justify-content:flex-end;font-size:.68rem;color:var(--txt2);margin-bottom:.15rem">měsíc / rok</div>
    ${r('💳 Karty', d.karty_mesic||0, d.rocni||0)}
    ${r('💵 Hotovost', d.hot_mesic||0, d.hot_rok||0)}
    ${r('📈 Tržba', d.trzba_mesic||0, d.trzba_rok||0)}
    <div style="margin-top:.5rem">
      <div style="display:flex;justify-content:space-between;font-size:.75rem;margin-bottom:.1rem">
        <span style="color:var(--txt2)">Terminál</span>
        <strong style="color:${mCol}">${czInt(d.mesicni||0)} / ${czInt(d.terminal_limit||100000)}</strong>
      </div>
      ${bar(mPct,mCol)}
      <div style="display:flex;justify-content:space-between;font-size:.75rem;margin-bottom:.1rem">
        <span style="color:var(--txt2)">DPH rok</span>
        <strong style="color:${rCol}">${czInt(d.rocni||0)} / ${czInt(d.dph_limit||2000000)}</strong>
      </div>
      ${bar(rPct,rCol)}
    </div>
    ${mPct >= 100 ? '<div style="font-size:.72rem;color:#991b1b;font-weight:700">🚨 Limit překročen!</div>' : mPct >= 90 ? '<div style="font-size:.72rem;color:#b45309">⚠️ Blíží se limit</div>' : ''}
  </div>`;
}

function renderKartaStatHtml(stats) {
  const firmy = Object.keys(stats);
  if (!firmy.length) return "";
  const rok = new Date().getFullYear();
  // Použít localStorage jako fallback pro aktivní firmu
  const ulozeneFirma = localStorage.getItem("aktivni_firma");
  const nekteraAktivni = firmy.some(f => stats[f].aktivni);
  if (!nekteraAktivni && ulozeneFirma && firmy.includes(ulozeneFirma)) {
    // Označit uloženou firmu jako aktivní vizuálně
    firmy.forEach(f => { stats[f]._lokalneAktivni = (f === ulozeneFirma); });
  }

  // řádek: label | měsíc / rok
  const r = (lbl, mesic, rocni) => `
    <div style="display:flex;justify-content:space-between;align-items:center;font-size:.82rem;padding:.2rem 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--txt2)">${lbl}</span>
      <span><strong>${czInt(mesic)}</strong> <span style="color:var(--txt2);font-size:.75rem">/ ${czInt(rocni)} Kč</span></span>
    </div>`;
  const bar = (pct, col) => `<div style="background:#e5e7eb;border-radius:3px;height:4px;margin-bottom:.3rem"><div style="background:${col};height:4px;border-radius:3px;width:${pct}%;transition:.3s"></div></div>`;
  const header = () => `<div style="display:flex;justify-content:flex-end;font-size:.68rem;color:var(--txt2);margin-bottom:.15rem">měsíc / rok</div>`;

  // Souhrnný boxík
  const sumKartyM = firmy.reduce((s,f) => s+(stats[f].karty_mesic||0), 0);
  const sumHotM   = firmy.reduce((s,f) => s+(stats[f].hot_mesic||0), 0);
  const sumTrzbaM = firmy.reduce((s,f) => s+(stats[f].trzba_mesic||0), 0);
  const sumKartyR = firmy.reduce((s,f) => s+(stats[f].rocni||0), 0);
  const sumHotR   = firmy.reduce((s,f) => s+(stats[f].hot_rok||0), 0);
  const sumTrzbaR = firmy.reduce((s,f) => s+(stats[f].trzba_rok||0), 0);

  const souhrn = `<div style="background:var(--card-bg);border:1px solid var(--border);border-radius:10px;padding:.85rem;flex:1;min-width:150px">
    <div style="font-weight:700;font-size:.95rem;margin-bottom:.4rem">Celkem</div>
    ${header()}
    ${r('💳 Karty', sumKartyM, sumKartyR)}
    ${r('💵 Hotovost', sumHotM, sumHotR)}
    ${r('📈 Tržba', sumTrzbaM, sumTrzbaR)}
  </div>`;

  const card = (firma, d, jeAktivni) => {
    const mPct = Math.min(Math.round(d.mesicni / d.terminal_limit * 100), 100);
    const rPct = Math.min(Math.round(d.rocni   / d.dph_limit      * 100), 100);
    const mCol = mPct >= 100 ? "#ef4444" : mPct >= 80 ? "#f59e0b" : "#9ca3af";
    const rCol = rPct >= 100 ? "#ef4444" : rPct >= 75 ? "#f59e0b" : "#9ca3af";
    const od   = d.terminal_od ? new Date(d.terminal_od).toLocaleDateString("cs-CZ") : "—";
    const bord = jeAktivni ? '2px solid #16a34a' : '1px solid var(--border)';
    return `<div style="background:var(--card-bg);border:${bord};border-radius:10px;padding:.85rem;flex:1;min-width:150px">
      <div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.2rem">
        <span style="font-weight:700;font-size:.95rem">${escHtml(firma)}</span>
        ${jeAktivni
          ? '<span style="background:#dcfce7;color:#166534;font-size:.65rem;padding:.1rem .4rem;border-radius:99px;font-weight:600">● kasíruje</span>'
          : '<span style="background:#f3f4f6;color:#9ca3af;font-size:.65rem;padding:.1rem .4rem;border-radius:99px">○ neaktivní</span>'}
      </div>
      <div style="font-size:.7rem;color:var(--txt2);margin-bottom:.4rem">od ${od}</div>
      ${header()}
      ${r('💳 Karty', d.karty_mesic||0, d.rocni||0)}
      ${r('💵 Hotovost', d.hot_mesic||0, d.hot_rok||0)}
      ${r('📈 Tržba', d.trzba_mesic||0, d.trzba_rok||0)}
      <div style="margin-top:.5rem">
        <div style="display:flex;justify-content:space-between;font-size:.75rem;margin-bottom:.1rem">
          <span style="color:var(--txt2)">Terminál</span>
          <strong style="color:${mCol}">${czInt(d.mesicni)} / ${czInt(d.terminal_limit)} Kč</strong>
        </div>
        ${bar(mPct, mCol)}
        <div style="display:flex;justify-content:space-between;font-size:.75rem;margin-bottom:.1rem">
          <span style="color:var(--txt2)">DPH rok</span>
          <strong style="color:${rCol}">${czInt(d.rocni)} / ${czInt(d.dph_limit)} Kč</strong>
        </div>
        ${bar(rPct, rCol)}
      </div>
      ${mPct >= 100 ? '<div style="font-size:.72rem;color:#991b1b;font-weight:700">🚨 Limit překročen!</div>' : mPct >= 90 ? '<div style="font-size:.72rem;color:#b45309">⚠️ Blíží se limit</div>' : ''}
      ${rPct >= 90 ? '<div style="font-size:.72rem;color:#b45309">⚠️ Blíží se DPH limit</div>' : ''}
      <button onclick="prepnoutTerminal('${firma}')"
        style="margin-top:.5rem;width:100%;padding:.28rem;border-radius:6px;border:1px solid var(--border);cursor:pointer;font-size:.75rem;background:var(--bg);color:var(--txt2)">
        🔄 Přepnout
      </button>
    </div>`;
  };

  return `<div style="display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem">
    ${souhrn}
    ${firmy.map((f,i) => card(f, stats[f], stats[f].aktivni || (!nekteraAktivni && stats[f]._lokalneAktivni))).join("")}
  </div>`;
}

async function prepnoutTerminal(firma) {
  if (!confirm("Přepnout terminál pro " + firma + "? Měsíční čítač karet se vynuluje od dneška.")) return;
  await api("/api/config", { method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ terminal_prepnout: firma }) });
  localStorage.setItem("aktivni_firma", firma);
  toast("Terminál přepnut ✓");
  renderReporty();
}

async function renderReporty() {
  let karty_stats = {};
  try { karty_stats = await api("/api/reporty/karty-stats"); } catch {}

  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Denní reporty</h1>
      <div class="btn-group">
        <button class="btn btn-primary btn-sm" onclick="openNovyReport()">+ Nový report</button>
        <button class="btn btn-secondary btn-sm" onclick="openImportXlsx()">📥 Import xlsx</button>
        <button class="btn btn-secondary btn-sm" onclick="smazBudouciReporty()">🗑 Smazat budoucí</button>
        <button class="btn btn-secondary btn-sm" onclick="exportReporty('xlsx')">⬇ Excel</button>
        <button class="btn btn-secondary btn-sm" onclick="exportReporty('csv')">⬇ CSV</button>
      </div>
    </div>
    ${renderKartaStatHtml(karty_stats)}
    <div class="filters">
      <label>Rok:</label>
      <select id="rRok" onchange="aplikujRokFiltr('rRok','rOd','rDo',loadReporty)">
        ${rokOptions(new Date().getFullYear())}
      </select>
      <label>Od:</label><input type="date" id="rOd">
      <label>Do:</label><input type="date" id="rDo">
      <button class="btn btn-primary btn-sm" onclick="loadReporty()">Zobrazit</button>
    </div>
    <div class="card">
      <div class="table-wrap" id="reportyList"><div class="loading-center"><span class="spinner"></span></div></div>
    </div>`;

  aplikujRokFiltr('rRok','rOd','rDo', null);
  setTimeout(loadReporty, 50);}

function nastavRokFiltr() {
  const rok = document.getElementById("rRok")?.value;
  const rOd = document.getElementById("rOd");
  const rDo = document.getElementById("rDo");
  if (rok) {
    rOd.value = `${rok}-01-01`;
    rDo.value = `${rok}-12-31`;
  } else {
    rOd.value = "";
    rDo.value = "";
  }
  loadReporty();
}

async function loadReporty() {
  const params = new URLSearchParams({
    od: document.getElementById("rOd")?.value || "",
    do: document.getElementById("rDo")?.value || "",
  });
  let rows;
  try { rows = await api(`/api/reporty?${params}`); } catch { return; }
  App._reportyData = rows;
  if (!App._reportySort) App._reportySort = { col: "datum", asc: false };
  renderReportyTable(rows);
}

function sortReporty(col) {
  const s = App._reportySort;
  if (s.col === col) s.asc = !s.asc;
  else { s.col = col; s.asc = false; }
  const rows = [...(App._reportyData || [])];
  rows.sort((a, b) => {
    let va = a[col] ?? "", vb = b[col] ?? "";
    // Číselné sloupce
    if (typeof va === "number" || !isNaN(parseFloat(va))) {
      va = parseFloat(va) || 0; vb = parseFloat(vb) || 0;
    }
    if (va < vb) return s.asc ? -1 : 1;
    if (va > vb) return s.asc ? 1 : -1;
    return 0;
  });
  renderReportyTable(rows);
}

async function smazBudouciReporty() {
  if (!confirm("Smazat všechny záznamy s datem v budoucnosti?")) return;
  const r = await api("/api/reporty/smaz-budouci", { method: "POST" });
  toast(`Smazáno ${r.smazano} záznamů`);
  loadReporty();
}

function renderReportyTable(rows) {
  const el = document.getElementById("reportyList");
  if (!el) return;
  const s = App._reportySort || { col: "datum", asc: false };
  const arr = col => s.col === col ? (s.asc ? " ▲" : " ▼") : "";
  const th = (col, label) => `<th style="cursor:pointer;user-select:none" onclick="sortReporty('${col}')">${label}${arr(col)}</th>`;

  if (!rows.length) {
    el.innerHTML = `<div style="text-align:center;color:var(--txt2);padding:3rem">
      Žádné reporty. <button class="btn btn-primary btn-sm" onclick="openNovyReport()">+ Přidat první</button>
    </div>`;
    return;
  }

  // Součty
  const sumy = rows.reduce((s, r) => {
    s.trzba_vcpk += r.trzba_vcpk || 0;
    s.karty      += r.karty || 0;
    s.hotovost   += r.hotovost || 0;
    s.vydaje     += r.vydaje || 0;
    s.pk_celkem  += r.pk_celkem || 0;
    s.pizza_cela += r.pizza_cela || 0;
    s.pizza_ctvrt+= r.pizza_ctvrt || 0;
    s.burger     += r.burger || 0;
    s.talire     += r.talire || 0;
    s.burtgulas  += r.burtgulas || 0;
    return s;
  }, {trzba_vcpk:0,karty:0,hotovost:0,vydaje:0,pk_celkem:0,pizza_cela:0,pizza_ctvrt:0,burger:0,talire:0,burtgulas:0});

  el.innerHTML = `
    <div style="overflow-x:auto">
    <table style="min-width:900px">
      <thead><tr>
        ${th("datum","Datum")}${th("den","Den")}
        <th style="background:var(--primary-bg,#e8f4fd)">Celkem tržba</th>
        ${th("trzba_vcpk","Tržba vč.PK")}${th("karty","Karty")}${th("hotovost","Hotovost")}${th("vydaje","Výdaje")}
        ${th("pk_celkem","Poukázky")}
        ${th("pizza_cela","Pizza")}${th("pizza_ctvrt","1/4\nPizza")}${th("burger","Burger")}${th("burtgulas","B-guláš")}${th("talire","Talíře")}
        <th>Firma</th><th>Směna</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map(r => {
          const celkem_trzba = (r.karty||0) + (r.hotovost||0) + (r.vydaje||0);
          return `
          <tr style="cursor:pointer;${r.duplicita_id ? 'background:#fff7ed;border-left:3px solid #f59e0b' : ''}" onclick="editReport(${r.id})">
            <td style="white-space:nowrap"><strong>${czDateShort(r.datum)}</strong>${r.duplicita_id ? ` <small style="color:#f59e0b">⚠️ dup</small>` : ''}</td>
            <td style="color:var(--txt2);font-size:.82rem">${escHtml(r.den||"")}</td>
            <td style="text-align:right;background:var(--primary-bg,#e8f4fd)"><strong>${czInt(celkem_trzba)}</strong></td>
            <td style="text-align:right"><strong>${czInt(r.trzba_vcpk)}</strong></td>
            <td style="text-align:right">${czInt(r.karty)}</td>
            <td style="text-align:right">${czInt(r.hotovost)}</td>
            <td style="text-align:right">${r.vydaje ? czInt(r.vydaje) : "—"}</td>
            <td style="text-align:right">${r.pk_celkem ? czInt(r.pk_celkem) : "—"}</td>
            <td style="text-align:center">${r.pizza_cela || "—"}</td>
            <td style="text-align:center">${r.pizza_ctvrt || "—"}</td>
            <td style="text-align:center">${r.burger || "—"}</td>
            <td style="text-align:center">${r.burtgulas || "—"}</td>
            <td style="text-align:center">${r.talire || "—"}</td>
            <td style="font-size:.82rem"><strong>${escHtml(r.firma_zkratka||"")}</strong></td>
            <td style="font-size:.82rem;color:var(--txt2)">${escHtml(r.smena||"")}</td>
            <td style="white-space:nowrap">
              ${r.soubor_url ? `<button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();window.open('${r.soubor_url}','_blank')" title="Originál">📎</button>` : ''}
              <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();editReport(${r.id})" title="Upravit">✏️</button>
              ${r.duplicita_id ? `<button class="btn btn-sm" style="background:#f59e0b;color:#fff;border:none" onclick="event.stopPropagation();reportNeniDuplicita(${r.id})" title="Není duplicita">✅</button>` : ''}
              <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deleteReport(${r.id})" title="Smazat">🗑</button>
            </td>
          </tr>`;}).join("")}
      </tbody>
      <tfoot>
        <tr class="table-footer">
          <td colspan="2">Celkem (${rows.length} dní)</td>
          <td style="text-align:right;background:var(--primary-bg,#e8f4fd)"><strong>${czInt(sumy.karty+sumy.hotovost+sumy.vydaje)}</strong></td>
          <td style="text-align:right"><strong>${czInt(sumy.trzba_vcpk)}</strong></td>
          <td style="text-align:right"><strong>${czInt(sumy.karty)}</strong></td>
          <td style="text-align:right"><strong>${czInt(sumy.hotovost)}</strong></td>
          <td style="text-align:right"><strong>${czInt(sumy.vydaje)}</strong></td>
          <td style="text-align:right"><strong>${czInt(sumy.pk_celkem)}</strong></td>
          <td style="text-align:center"><strong>${sumy.pizza_cela}</strong></td>
          <td style="text-align:center"><strong>${sumy.pizza_ctvrt}</strong></td>
          <td style="text-align:center"><strong>${sumy.burger}</strong></td>
          <td style="text-align:center"><strong>${sumy.burtgulas}</strong></td>
          <td style="text-align:center"><strong>${sumy.talire}</strong></td>
          <td colspan="3"></td>
        </tr>
      </tfoot>
    </table>
    </div>`;
}

// ── Formulář reportu ────────────────────────────────────────────
function reportFormHtml(r = {}) {
  const dnes = r.datum || (()=>{const _x=new Date();return `${_x.getFullYear()}-${String(_x.getMonth()+1).padStart(2,"0")}-${String(_x.getDate()).padStart(2,"0")}`;})() ;
  return `
    <div class="form-group" style="margin-bottom:.8rem">
      <label class="form-label">Firma</label>
      <select id="rfFirma" class="form-control">
        <option value="">— bez firmy —</option>
        ${App.config.firmy.map(f=>`<option value="${f}" ${(r.firma_zkratka||App._lastReportFirma||App._aktivniFirma||"")==f?"selected":""}>${f}</option>`).join("")}
      </select>
    </div>
    ${r.soubor_url ? `<div style="margin-bottom:.8rem"><a href="${r.soubor_url}" target="_blank" class="btn btn-secondary btn-sm">📎 Zobrazit originál fotku</a></div>` : ""}
    <div style="display:flex;gap:.4rem;margin-bottom:1rem;border-bottom:2px solid var(--border);padding-bottom:0">
      <button id="rtabFoto"  class="tab-btn tab-active" onclick="switchRTab('foto')">📷 Fotka</button>
      <button id="rtabText"  class="tab-btn" onclick="switchRTab('text')">📋 Vložit text</button>
      <button id="rtabRucni" class="tab-btn" onclick="switchRTab('rucni')">✏️ Ruční</button>
    </div>

    <div id="rtabPanelFoto">
      <div class="dropzone" id="reportDropzone" style="padding:1rem">
        <div class="dropzone-icon" style="font-size:2rem">📷</div>
        <div class="dropzone-text">
          <strong>Přetáhněte fotku lístku</strong> nebo klikněte<br>
          <small>Claude přečte rukopis automaticky</small>
        </div>
        <input type="file" id="reportFileInput" accept="image/*">
      </div>
      <div id="reportFotoStatus" style="margin-top:.5rem;font-size:.9rem;color:var(--txt2)"></div>
    </div>

    <div id="rtabPanelText" style="display:none">
      <p style="color:var(--txt2);font-size:.88rem;margin-bottom:.5rem">
        Zkopírujte text ze zprávy (WhatsApp, SMS) a vložte sem (Ctrl+V):
      </p>
      <textarea id="reportTextInput" class="form-control" rows="6"
        placeholder="Např: Datum: 1.3, Den: neděle, Směna: Vali/Renata&#10;Karty: 5500, KOV: 211, Papír: 3800&#10;Tržba: 9664, Pizza celá: 6x, čtvrt: 4x..."></textarea>
      <button class="btn btn-primary btn-sm" style="margin-top:.5rem" onclick="zpracovatReportText()">
        🔍 Zpracovat
      </button>
      <div id="reportTextStatus" style="margin-top:.4rem;font-size:.9rem;color:var(--txt2)"></div>
    </div>

    <div id="rtabPanelRucni" style="display:none">
      <p style="color:var(--txt2);font-size:.88rem">Vyplňte hodnoty ručně nebo opravte načtené.</p>
    </div>

    <div id="reportFormFields" style="margin-top:1rem">
      <div class="grid-2" style="gap:.8rem">
        <div class="form-group">
          <label class="form-label">Datum *</label>
          <input type="date" id="rfDatum" class="form-control" value="${dnes}" onchange="rfDatumZmenaDne(this.value)">
        </div>
        <div class="form-group">
          <label class="form-label">Den</label>
          <input id="rfDen" class="form-control" value="${escHtml(r.den||'')}" placeholder="Pondělí...">
        </div>
        <div class="form-group">
          <label class="form-label">Směna (jména)</label>
          <input id="rfSmena" class="form-control" value="${escHtml(r.smena||'')}" placeholder="Radek, Věrka">
        </div>
        <div class="form-group" style="grid-column:span 1"></div>
      </div>
      <hr style="margin:.8rem 0;border-color:var(--border)">
      <div class="grid-2" style="gap:.8rem">
        <div class="form-group">
          <label class="form-label">💳 Karty</label>
          <input type="number" id="rfKarty" class="form-control" value="${r.karty||0}" oninput="rfRecalc()">
        </div>
        <div class="form-group">
          <label class="form-label">🔩 KOV (cash registr)</label>
          <input type="number" id="rfKov" class="form-control" value="${r.kov||0}" oninput="rfRecalc()">
        </div>
        <div class="form-group">
          <label class="form-label">💵 Papír</label>
          <input type="number" id="rfPapir" class="form-control" value="${r.papir||0}" oninput="rfRecalc()">
        </div>
        <div class="form-group">
          <label class="form-label">📦 Výdaje</label>
          <input type="number" id="rfVydaje" class="form-control" value="${r.vydaje||0}" oninput="rfRecalc()">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:.8rem;margin-top:.5rem">
        <div class="form-group">
          <label class="form-label">🎟 PK 50 Kč (kusů)</label>
          <input type="number" id="rfPk50" class="form-control" value="${r.pk50_ks||0}" oninput="rfRecalc()">
        </div>
        <div class="form-group">
          <label class="form-label">🎟 PK 100 Kč (kusů)</label>
          <input type="number" id="rfPk100" class="form-control" value="${r.pk100_ks||0}" oninput="rfRecalc()">
        </div>
        <div class="form-group">
          <label class="form-label">🎟 PK Celkem (Kč)</label>
          <div id="rfPkCelkemDisp" style="padding:.5rem .75rem;background:var(--green-pale);border-radius:6px;font-weight:600;font-size:.95rem;min-height:2.2rem;display:flex;align-items:center">${czMoney((r.pk50_ks||0)*50+(r.pk100_ks||0)*100)} Kč</div>
        </div>
      </div>
      <div id="rfVypocty" style="background:var(--green-pale);border-radius:8px;padding:.6rem 1rem;margin:.8rem 0;font-size:.9rem">
        <span id="rfHotovostDisp">Hotovost: 0 Kč</span> &nbsp;|&nbsp;
        <span id="rfTrzbaDisp">Tržba: 0 Kč</span> &nbsp;|&nbsp;
        <span id="rfPkDisp">PK: 0 Kč</span> &nbsp;|&nbsp;
        <strong id="rfTrzbaVcPkDisp">Tržba vč. PK: 0 Kč</strong>
      </div>
      <hr style="margin:.8rem 0;border-color:var(--border)">
      <div class="grid-2" style="gap:.8rem">
        <div class="form-group">
          <label class="form-label">🍕 Pizza celá</label>
          <input type="number" id="rfPizzaCela" class="form-control" value="${r.pizza_cela||0}">
        </div>
        <div class="form-group">
          <label class="form-label">🍕 Pizza čtvrt</label>
          <input type="number" id="rfPizzaCtvrt" class="form-control" value="${r.pizza_ctvrt||0}">
        </div>
        <div class="form-group">
          <label class="form-label">🍔 Burger</label>
          <input type="number" id="rfBurger" class="form-control" value="${r.burger||0}">
        </div>
        <div class="form-group">
          <label class="form-label">🍲 Buřtguláš</label>
          <input type="number" id="rfBurtgulas" class="form-control" value="${r.burtgulas||0}">
        </div>
        <div class="form-group">
          <label class="form-label">🍽 Počet talířů</label>
          <input type="number" id="rfTalire" class="form-control" value="${r.talire||0}">
        </div>
      </div>
    </div>

    <div class="btn-group" style="margin-top:1rem">
      <button class="btn btn-primary" onclick="ulozitReport()">💾 Uložit report</button>
    </div>`;
}

function switchRTab(tab) {
  ["foto","text","rucni"].forEach(t => {
    const panel = document.getElementById("rtabPanel" + t.charAt(0).toUpperCase() + t.slice(1));
    const btn   = document.getElementById("rtab" + t.charAt(0).toUpperCase() + t.slice(1));
    if (panel) panel.style.display = t === tab ? "" : "none";
    if (btn)   btn.classList.toggle("tab-active", t === tab);
  });
}

function rfRecalc() {
  const karty   = parseFloat(document.getElementById("rfKarty")?.value  || 0);
  const kov     = parseFloat(document.getElementById("rfKov")?.value    || 0);
  const papir   = parseFloat(document.getElementById("rfPapir")?.value  || 0);
  const vydaje  = parseFloat(document.getElementById("rfVydaje")?.value || 0);
  const pk50    = parseInt(document.getElementById("rfPk50")?.value     || 0);
  const pk100   = parseInt(document.getElementById("rfPk100")?.value    || 0);
  const hotovost  = kov + papir;
  const trzba     = karty + hotovost + vydaje;
  const pkKc      = pk50 * 50 + pk100 * 100;
  const trzbaVcPk = trzba + pkKc;
  const el = (id) => document.getElementById(id);
  if (el("rfHotovostDisp"))  el("rfHotovostDisp").textContent  = "Hotovost: " + czMoney(hotovost);
  if (el("rfTrzbaDisp"))     el("rfTrzbaDisp").textContent     = "Tržba: " + czMoney(trzba);
  if (el("rfPkDisp"))        el("rfPkDisp").textContent        = "PK: " + czMoney(pkKc);
  if (el("rfPkCelkemDisp"))  el("rfPkCelkemDisp").textContent  = czMoney(pkKc) + " Kč";
  if (el("rfTrzbaVcPkDisp")) el("rfTrzbaVcPkDisp").textContent = "Tržba vč. PK: " + czMoney(trzbaVcPk);
}

function naplnReportFormular(data) {
  const fields = {
    rfDatum: data.datum || "", rfDen: data.den || "", rfSmena: data.smena || "",
    rfKarty: data.karty || 0, rfKov: data.kov || 0, rfPapir: data.papir || 0,
    rfVydaje: data.vydaje || 0, rfPk50: data.pk50_ks || 0, rfPk100: data.pk100_ks || 0,
    rfPizzaCela: data.pizza_cela || 0, rfPizzaCtvrt: data.pizza_ctvrt || 0,
    rfBurger: data.burger || 0, rfTalire: data.talire || 0, rfBurtgulas: data.burtgulas || 0,
  };
  Object.entries(fields).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
  rfRecalc();
}

function openNovyReport() {
  openModal("Nový denní report", reportFormHtml());
  setupReportDropzone();
  rfRecalc();
}

function rfDatumZmenaDne(val) {
  const dny = ["pondělí","úterý","středa","čtvrtek","pátek","sobota","neděle"];
  const el = document.getElementById("rfDen");
  if (!el || !val) return;
  try {
    const d = new Date(val);
    el.value = dny[d.getDay() === 0 ? 6 : d.getDay() - 1];
  } catch {}
}

async function editReport(id) {
  let r;
  try { r = await api("/api/reporty/" + id); } catch { return; }
  if (!r || r.error) { toast("Report nenalezen", true); return; }
  App._reportEditId = id;
  App._reportSouborUrl = null;
  App._reportSouborUrlExisting = r.soubor_url || null;
  openModal("Upravit report – " + czDate(r.datum), reportFormHtml(r));
  setupReportDropzone();
  rfRecalc();
}

async function deleteReport(id) {
  if (!confirm("Opravdu smazat tento report?")) return;
  await api(`/api/reporty/${id}`, { method: "DELETE" });
  toast("Report smazán");
  loadReporty();
}

async function reportNeniDuplicita(id) {
  await api(`/api/reporty/${id}`, {
    method: "PUT",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ _jen_duplicita_id: true, duplicita_id: null })
  });
  toast("Označení duplicity odstraněno ✓");
  loadReporty();
}

function setupReportDropzone() {
  const dz  = document.getElementById("reportDropzone");
  const inp = document.getElementById("reportFileInput");
  if (!dz) return;
  dz.addEventListener("click", () => inp.click());
  inp.addEventListener("change", () => { if (inp.files[0]) uploadReportFoto(inp.files[0]); });
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", e => {
    e.preventDefault(); dz.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) uploadReportFoto(e.dataTransfer.files[0]);
  });

  document.addEventListener("paste", function reportPasteHandler(e) {
    const modal = document.getElementById("modalOverlay");
    if (!modal || modal.style.display === "none") return;
    // Pokud uživatel upravuje ruční záložku, NENAHRAZUJ data novým OCR
    const rucniPanel = document.getElementById("rtabPanelRucni");
    if (rucniPanel && rucniPanel.style.display !== "none") return;
    // Foto panel — při editaci existujícího reportu nemusí existovat, pak paste povolíme
    const fotaPanel = document.getElementById("rtabPanelFoto");
    if (fotaPanel && fotaPanel.style.display === "none") return;
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          const statusEl = document.getElementById("reportFotoStatus");
          if (statusEl) statusEl.innerHTML = `<span class="spinner"></span> Načítám obrázek ze schránky...`;
          uploadReportFoto(file);
        }
        break;
      }
    }
  });
}

async function uploadReportFoto(file) {
  const statusEl = document.getElementById("reportFotoStatus");
  statusEl.innerHTML = `<span class="spinner"></span> Čtu lístek přes AI...`;
  const fd = new FormData();
  fd.append("soubor", file);
  try {
    const r = await fetch("/api/reporty/nahrat-foto", { method: "POST", body: fd });
    const data = await r.json();
    if (data.error) {
      statusEl.textContent = "❌ " + data.error;
      return;
    }
    if (data.soubor_url) App._reportSouborUrl = data.soubor_url;
    // Při editaci existujícího reportu jen ulož fotku, nepřepisuj data
    if (App._reportEditId) {
      statusEl.textContent = "✅ Fotka uložena";
      const fotoEl = document.getElementById("reportFotoNahled");
      if (fotoEl && data.soubor_url) fotoEl.innerHTML = `<img src="${data.soubor_url}" style="max-width:100%;border-radius:6px;margin-top:.5rem">`;
    } else {
      statusEl.textContent = "✅ Lístek přečten – zkontrolujte a uložte";
      naplnReportFormular(data);
      switchRTab("rucni");
    }
  } catch (e) {
    statusEl.textContent = "❌ Chyba: " + e.message;
  }
}

async function zpracovatReportText() {
  const text = document.getElementById("reportTextInput")?.value.trim();
  if (!text) return;
  const statusEl = document.getElementById("reportTextStatus");
  statusEl.innerHTML = `<span class="spinner"></span> Zpracovávám...`;
  try {
    const r = await fetch("/api/reporty/nahrat-text", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({text})
    });
    const data = await r.json();
    if (data.error) { statusEl.textContent = "❌ " + data.error; return; }
    statusEl.textContent = "✅ Zpracováno";
    naplnReportFormular(data);
    switchRTab("rucni");
  } catch(e) {
    statusEl.textContent = "❌ " + e.message;
  }
}

async function ulozitReport() {
  const datum = document.getElementById("rfDatum")?.value;
  if (!datum) { toast("Vyplňte datum", true); return; }
  const payload = {
    datum,
    den:         document.getElementById("rfDen")?.value || "",
    smena:       document.getElementById("rfSmena")?.value || "",
    karty:       parseFloat(document.getElementById("rfKarty")?.value || 0),
    kov:         parseFloat(document.getElementById("rfKov")?.value || 0),
    papir:       parseFloat(document.getElementById("rfPapir")?.value || 0),
    vydaje:      parseFloat(document.getElementById("rfVydaje")?.value || 0),
    pk50_ks:     parseInt(document.getElementById("rfPk50")?.value || 0),
    pk100_ks:    parseInt(document.getElementById("rfPk100")?.value || 0),
    pizza_cela:  parseInt(document.getElementById("rfPizzaCela")?.value || 0),
    pizza_ctvrt: parseInt(document.getElementById("rfPizzaCtvrt")?.value || 0),
    burger:      parseInt(document.getElementById("rfBurger")?.value || 0),
    talire:      parseInt(document.getElementById("rfTalire")?.value || 0),
    burtgulas:   parseInt(document.getElementById("rfBurtgulas")?.value || 0),
    firma_zkratka: document.getElementById("rfFirma")?.value || "",
  };
  App._lastReportFirma = document.getElementById("rfFirma")?.value || "";

  // Foto: nově nahrané má přednost, jinak zachovat existující
  if (App._reportSouborUrl) {
    payload.soubor_url = App._reportSouborUrl;
    App._reportSouborUrl = null;
  } else if (App._reportSouborUrlExisting) {
    payload.soubor_url = App._reportSouborUrlExisting;
  }

  const editId = App._reportEditId || null;
  App._reportEditId = null;
  App._reportSouborUrlExisting = null;

  if (editId) {
    await api(`/api/reporty/${editId}`, {
      method: "PUT",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    toast("Report uložen ✓");
  } else {
    const resp = await api("/api/reporty", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    if (resp && resp.duplicita) {
      toast("⚠️ Report uložen – duplicitní datum!");
    } else {
      toast("Report uložen ✓");
    }
  }
  closeModal();
  renderReporty();
}

// ── Import xlsx ─────────────────────────────────────────────────
function openImportXlsx() {
  openModal("Import historických dat (xlsx)", `
    <p style="color:var(--txt2);font-size:.9rem;margin-bottom:1rem">
      Nahrajte soubor <strong>CLAUDE_vykaz_2025_2026.xlsx</strong> nebo libovolný soubor
      ve stejném formátu. Data budou importována do databáze.<br>
      <small>Záznamy, které již existují (stejné datum), budou přeskočeny.</small>
    </p>
    <div class="dropzone" id="importDropzone" style="padding:1rem">
      <div class="dropzone-icon">📥</div>
      <div class="dropzone-text"><strong>Přetáhněte xlsx soubor</strong> nebo klikněte</div>
      <input type="file" id="importFileInput" accept=".xlsx,.xls">
    </div>
    <div id="importStatus" style="margin-top:1rem;font-size:.9rem"></div>
  `);

  const dz  = document.getElementById("importDropzone");
  const inp = document.getElementById("importFileInput");
  inp.style.display = "none";
  dz.addEventListener("click", () => inp.click());
  inp.addEventListener("change", () => { if (inp.files[0]) doImportXlsx(inp.files[0]); });
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", e => {
    e.preventDefault(); dz.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) doImportXlsx(e.dataTransfer.files[0]);
  });
}

async function doImportXlsx(file) {
  const statusEl = document.getElementById("importStatus");
  statusEl.innerHTML = `<span class="spinner"></span> Importuji data...`;
  const fd = new FormData();
  fd.append("soubor", file);
  try {
    const r = await fetch("/api/reporty/import-xlsx", { method: "POST", body: fd });
    const data = await r.json();
    if (data.error) {
      statusEl.innerHTML = `❌ Chyba: ${escHtml(data.error)}`;
      return;
    }
    statusEl.innerHTML = `
      <div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:6px;padding:.7rem 1rem;color:#065f46">
        ✅ Import dokončen!<br>
        <strong>${data.imported}</strong> záznamů importováno,
        <strong>${data.skipped}</strong> přeskočeno (prázdné nebo existující)
        ${data.errors?.length ? `<br><small style="color:#991b1b">⚠ ${data.errors.join("; ")}</small>` : ""}
      </div>`;
    setTimeout(() => { closeModal(); renderReporty(); }, 2000);
  } catch(e) {
    statusEl.innerHTML = `❌ ${e.message}`;
  }
}

function exportReporty(fmt) {
  const params = new URLSearchParams({
    format: fmt,
    od: document.getElementById("rOd")?.value || "",
    do: document.getElementById("rDo")?.value || "",
  });
  window.location.href = `/api/export/reporty?${params}`;
}

// ═══════════════════════════════════════════════════════════════
//  BANKY – Bankovní výpisy
// ═══════════════════════════════════════════════════════════════

// Hlavní stránka – výběr firmy
function renderBanky() {
  const soukromeCard = maPravo("banky_soukrome") ? `
    <div class="card" style="flex:1;min-width:200px;max-width:280px;cursor:pointer;text-align:center;padding:2rem;transition:box-shadow .2s;border:2px solid #e0d8cc"
         onclick="renderBankySoukrome()"
         onmouseover="this.style.boxShadow='0 4px 24px rgba(0,0,0,.13)'"
         onmouseout="this.style.boxShadow=''">
      <div style="font-size:3rem">👤</div>
      <div style="font-size:1.2rem;font-weight:700;margin-top:.5rem">Radek — osobní</div>
      <div style="color:var(--txt2);font-size:.9rem;margin-top:.3rem">Osobní banky →</div>
    </div>` : "";
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header"><h1 class="page-title">Bankovní výpisy</h1></div>
    <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-top:1rem">
      ${App.config.firmy.map(f => `
      <div class="card" style="flex:1;min-width:200px;max-width:280px;cursor:pointer;text-align:center;padding:2rem;transition:box-shadow .2s"
           onclick="renderBankyFirma('${f}')"
           onmouseover="this.style.boxShadow='0 4px 24px rgba(0,0,0,.13)'"
           onmouseout="this.style.boxShadow=''">
        <div style="font-size:3rem">🏢</div>
        <div style="font-size:1.2rem;font-weight:700;margin-top:.5rem">${f}</div>
        <div style="color:var(--txt2);font-size:.9rem;margin-top:.3rem">Vybrat banku →</div>
      </div>`).join("")}
      ${soukromeCard}
    </div>`;
}

// Výběr osobní banky Radek
function renderBankySoukrome() {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">
        <span style="cursor:pointer;color:var(--txt2);font-weight:400" onclick="renderBanky()">Banky</span>
        <span style="margin:0 .4rem">›</span>Radek — osobní
      </h1>
    </div>
    <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-top:1rem">
      <div class="card" style="flex:1;min-width:200px;max-width:280px;cursor:pointer;text-align:center;padding:2rem;transition:box-shadow .2s"
           onclick="renderBankaDetail('AirBank','_soukrome')"
           onmouseover="this.style.boxShadow='0 4px 24px rgba(0,0,0,.13)'"
           onmouseout="this.style.boxShadow=''">
        <div style="font-size:3rem">🏦</div>
        <div style="font-size:1.2rem;font-weight:700;margin-top:.5rem">Air Bank</div>
        <div style="color:var(--txt2);font-size:.9rem;margin-top:.3rem">Osobní účet →</div>
      </div>
      <div class="card" style="flex:1;min-width:200px;max-width:280px;cursor:pointer;text-align:center;padding:2rem;transition:box-shadow .2s"
           onclick="renderBankaDetail('RB','_soukrome')"
           onmouseover="this.style.boxShadow='0 4px 24px rgba(0,0,0,.13)'"
           onmouseout="this.style.boxShadow=''">
        <div style="font-size:3rem">🏛</div>
        <div style="font-size:1.2rem;font-weight:700;margin-top:.5rem">Raiffeisenbank</div>
        <div style="color:var(--txt2);font-size:.9rem;margin-top:.3rem">Osobní účet →</div>
      </div>
      <div class="card" style="flex:1;min-width:200px;max-width:280px;cursor:pointer;text-align:center;padding:2rem;transition:box-shadow .2s"
           onclick="renderBankaDetail('KB','_soukrome')"
           onmouseover="this.style.boxShadow='0 4px 24px rgba(0,0,0,.13)'"
           onmouseout="this.style.boxShadow=''">
        <div style="font-size:3rem">🏦</div>
        <div style="font-size:1.2rem;font-weight:700;margin-top:.5rem">Komerční banka</div>
        <div style="color:var(--txt2);font-size:.9rem;margin-top:.3rem">Hypotéka, energie →</div>
      </div>
    </div>`;
}

// Výběr banky pro danou firmu
function renderBankyFirma(firma) {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">
        <span style="cursor:pointer;color:var(--txt2);font-weight:400" onclick="renderBanky()">Banky</span>
        <span style="margin:0 .4rem">›</span>${firma}
      </h1>
    </div>
    <div style="display:flex;gap:1.5rem;flex-wrap:wrap;margin-top:1rem">
      <div class="card" style="flex:1;min-width:200px;max-width:280px;cursor:pointer;text-align:center;padding:2rem;transition:box-shadow .2s"
           onclick="renderBankaDetail('AirBank','${firma}')"
           onmouseover="this.style.boxShadow='0 4px 24px rgba(0,0,0,.13)'"
           onmouseout="this.style.boxShadow=''">
        <div style="font-size:3rem">🏦</div>
        <div style="font-size:1.2rem;font-weight:700;margin-top:.5rem">Air Bank</div>
        <div style="color:var(--txt2);font-size:.9rem;margin-top:.3rem">Zobrazit výpisy →</div>
      </div>
      <div class="card" style="flex:1;min-width:200px;max-width:280px;cursor:pointer;text-align:center;padding:2rem;transition:box-shadow .2s"
           onclick="renderBankaDetail('RB','${firma}')"
           onmouseover="this.style.boxShadow='0 4px 24px rgba(0,0,0,.13)'"
           onmouseout="this.style.boxShadow=''">
        <div style="font-size:3rem">🏛</div>
        <div style="font-size:1.2rem;font-weight:700;margin-top:.5rem">Raiffeisenbank</div>
        <div style="color:var(--txt2);font-size:.9rem;margin-top:.3rem">Zobrazit výpisy →</div>
      </div>
    </div>`;
}

// Detail banky – accordion po měsících
async function renderBankaDetail(banka, firma) {
  const nazevBanky = banka === "AirBank" ? "Air Bank" : banka === "RB" ? "Raiffeisenbank" : "Komerční banka";
  const jeSoukrome = firma === "_soukrome";
  const breadcrumbBack = jeSoukrome
    ? `<span style="cursor:pointer;color:var(--txt2);font-weight:400" onclick="renderBankySoukrome()">Radek — osobní</span>`
    : `<span style="cursor:pointer;color:var(--txt2);font-weight:400" onclick="renderBankyFirma('${firma}')">${firma}</span>`;
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">
        <span style="cursor:pointer;color:var(--txt2);font-weight:400" onclick="renderBanky()">Banky</span>
        <span style="margin:0 .4rem">›</span>
        ${breadcrumbBack}
        <span style="margin:0 .4rem">›</span>${nazevBanky}
      </h1>
      <button class="btn btn-primary btn-sm" onclick="openImportBanky('${banka}','${firma}')">📥 Importovat výpis</button>
    </div>
    <div id="bankaAccordion"><div class="loading-center"><span class="spinner"></span></div></div>`;
  await loadBankaAccordion(banka, firma);
}

async function loadBankaAccordion(banka, firma) {
  const el = document.getElementById("bankaAccordion");
  if (!el) return;
  let data;
  try { data = await api(`/api/banky/pohyby?banka=${banka}&firma=${encodeURIComponent(firma||"")}`); } catch { return; }

  // Seskup po měsících
  const mesice = {};
  for (const p of data.pohyby) {
    const klic = p.datum.substring(0, 7); // YYYY-MM
    if (!mesice[klic]) mesice[klic] = [];
    mesice[klic].push(p);
  }

  const klice = Object.keys(mesice).sort().reverse();
  if (!klice.length) {
    el.innerHTML = `<div class="card" style="text-align:center;color:var(--txt2);padding:2rem">
      Žádné transakce — importuj výpis z banky pomocí tlačítka výše.</div>`;
    return;
  }

  el.innerHTML = klice.map((klic, idx) => {
    const pohyby = mesice[klic];
    const [rok, mes] = klic.split("-");
    const nazevMesice = new Date(rok, mes-1, 1).toLocaleDateString("cs-CZ", {month:"long", year:"numeric"});
    const prichozi = pohyby.filter(p=>p.castka>0).reduce((s,p)=>s+p.castka,0);
    const odchozi  = pohyby.filter(p=>p.castka<0).reduce((s,p)=>s+p.castka,0);
    const saldo    = prichozi + odchozi;
    const open = false; // vše zavřené, rozbalí se kliknutím
    return `
    <div class="card" style="margin-bottom:.75rem;padding:0;overflow:hidden">
      <div style="display:flex;align-items:center;padding:.9rem 1.2rem;cursor:pointer;gap:1rem"
           onclick="toggleBankaMonth('bm_${klic}', this)">
        <span style="font-size:1.1rem;font-weight:700;flex:1">${nazevMesice}</span>
        <span style="color:#16a34a;font-size:.9rem">↑ ${czMoneyFull(prichozi)}</span>
        <span style="color:#dc2626;font-size:.9rem">↓ ${czMoneyFull(Math.abs(odchozi))}</span>
        <span style="font-weight:600;font-size:.9rem;color:${saldo>=0?'#16a34a':'#dc2626'}">= ${czMoneyFull(saldo)}</span>
        <span style="color:var(--txt2);font-size:.85rem">${pohyby.length} trans.</span>
        <div style="display:flex;gap:.4rem" onclick="event.stopPropagation()">
          <button class="btn btn-sm" style="font-size:.75rem;padding:.2rem .5rem" onclick="exportBankaMonth('${banka}','${klic}','csv')">CSV</button>
          <button class="btn btn-sm" style="font-size:.75rem;padding:.2rem .5rem" onclick="exportBankaMonth('${banka}','${klic}','pdf')">PDF</button>
        </div>
        <span class="accordion-arrow" style="transition:transform .2s;${open?'transform:rotate(180deg)':''}">▼</span>
      </div>
      <div id="bm_${klic}" style="display:${open?'block':'none'};border-top:1px solid var(--border)">
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Datum</th><th>Protistrana</th><th>Typ</th><th>Zpráva</th>
              <th style="text-align:right">Částka</th><th></th>
            </tr></thead>
            <tbody>
              ${pohyby.map(p=>`
              <tr>
                <td>${czDate(p.datum)}</td>
                <td><strong>${escHtml(p.nazev_protiucet||"—")}</strong>${p.protiucet?`<br><small style="color:var(--txt2)">${escHtml(p.protiucet)}</small>`:""}</td>
                <td style="font-size:.85rem;color:var(--txt2)">${escHtml(p.typ_transakce||"")}</td>
                <td style="font-size:.85rem;color:var(--txt2);max-width:180px">${escHtml(p.zprava||"")}</td>
                <td style="text-align:right;font-weight:600;color:${p.castka>=0?'#16a34a':'#dc2626'}">${czMoneyFull(p.castka)}</td>
                <td><button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border:none;padding:.2rem .4rem;border-radius:4px" onclick="smazatBankovniPohyb(${p.id},'${banka}','${firma}')">🗑</button></td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
  }).join("");
}

function toggleBankaMonth(id, header) {
  const el = document.getElementById(id);
  if (!el) return;
  const open = el.style.display !== "none";
  el.style.display = open ? "none" : "block";
  const arrow = header.querySelector(".accordion-arrow");
  if (arrow) arrow.style.transform = open ? "" : "rotate(180deg)";
}

function exportBankaMonth(banka, mesic, fmt) {
  window.location.href = `/api/banky/export?banka=${banka}&mesic=${mesic}&format=${fmt}`;
}

function openImportBanky(banka, firma) {
  const nazev = banka === "AirBank" ? "Air Bank" : banka === "RB" ? "Raiffeisenbank" : "Komerční banka";
  openModal(`Importovat výpis – ${nazev} / ${firma||""}`, `
    <p style="color:var(--txt2);font-size:.85rem;margin-bottom:1rem">
      Nahraj CSV výpis z <strong>${nazev}</strong>.
      Duplicitní transakce budou automaticky přeskočeny.
    </p>
    <div class="dropzone" id="bankyDropzone" style="padding:1.5rem;margin-top:.5rem">
      <div class="dropzone-icon">🏦</div>
      <div class="dropzone-text"><strong>Přetáhněte CSV soubor</strong> nebo klikněte</div>
      <input type="file" id="bankyFileInput" accept=".csv,.pdf">
    </div>
    <div id="bankyImportStatus" style="margin-top:1rem;font-size:.9rem"></div>
  `);
  const dz  = document.getElementById("bankyDropzone");
  const inp = document.getElementById("bankyFileInput");
  inp.style.display = "none";
  dz.addEventListener("click", () => inp.click());
  inp.addEventListener("change", () => { if (inp.files[0]) doImportBanky(inp.files[0], banka, firma); });
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", e => {
    e.preventDefault(); dz.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) doImportBanky(e.dataTransfer.files[0], banka, firma);
  });
}

async function doImportBanky(file, banka, firma) {
  const statusEl = document.getElementById("bankyImportStatus");
  statusEl.innerHTML = `<span class="spinner"></span> Importuji...`;
  const fd = new FormData();
  fd.append("soubor", file);
  fd.append("firma_zkratka", firma || "");
  fd.append("banka_hint", banka || "");
  try {
    const data = await api("/api/banky/import", { method: "POST", body: fd });
    statusEl.innerHTML = `
      <div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:6px;padding:.7rem 1rem;color:#065f46">
        ✅ Import dokončen! Banka: <strong>${data.banka}</strong><br>
        Naimportováno: <strong>${data.naimportovano}</strong> transakcí
        ${data.duplicity ? `, přeskočeno duplicit: <strong>${data.duplicity}</strong>` : ""}
      </div>`;
    setTimeout(() => { closeModal(); loadBankaAccordion(banka, firma); }, 2000);
  } catch(e) {
    statusEl.innerHTML = `❌ Chyba: ${e.message}`;
  }
}

async function smazatBankovniPohyb(id, banka, firma) {
  if (!confirm("Opravdu smazat tento pohyb?")) return;
  await api(`/api/banky/pohyby/${id}`, { method: "DELETE" });
  toast("Pohyb smazán ✓");
  loadBankaAccordion(banka, firma);
}

// stará renderBanky (prázdná placeholder aby nedošlo k chybě při náhodném zavolání)
async function _renderBankyOld() {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Bankovní výpisy</h1>
      <div class="btn-group">
        <button class="btn btn-primary btn-sm" onclick="openImportBanky()">📥 Importovat výpis</button>
      </div>
    </div>
    <div class="filters">
      <label>Banka:</label>
      <select id="bBanka" onchange="loadBanky()">
        <option value="">Všechny</option>
        <option value="AirBank">Air Bank</option>
        <option value="RB">Raiffeisenbank</option>
      </select>
      <label>Firma:</label>
      <select id="bFirma" class="firma-select" onchange="loadBanky()">
        <option value="">Všechny</option>
        ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
      </select>
      <label>Typ:</label>
      <select id="bTyp" onchange="loadBanky()">
        <option value="">Vše</option>
        <option value="prichozi">Příchozí</option>
        <option value="odchozi">Odchozí</option>
      </select>
      <label>Rok:</label>
      <select id="bRok" onchange="aplikujRokFiltr('bRok','bOd','bDo',loadBanky)">
        ${rokOptions(new Date().getFullYear())}
      </select>
      <label>Od:</label><input type="date" id="bOd" onchange="loadBanky()">
      <label>Do:</label><input type="date" id="bDo" onchange="loadBanky()">
    </div>
    <div class="card">
      <div class="table-wrap" id="bankyList"><div class="loading-center"><span class="spinner"></span></div></div>
    </div>`;
  aplikujRokFiltr('bRok','bOd','bDo', null);
  loadBanky();
}

async function loadBanky() {
  const params = new URLSearchParams({
    banka: document.getElementById("bBanka")?.value || "",
    firma: document.getElementById("bFirma")?.value || "",
    typ:   document.getElementById("bTyp")?.value || "",
    od:    document.getElementById("bOd")?.value || "",
    do:    document.getElementById("bDo")?.value || "",
  });
  let data;
  try { data = await api(`/api/banky/pohyby?${params}`); } catch { return; }
  const el = document.getElementById("bankyList");
  if (!el) return;

  el.innerHTML = `
    <table>
      <thead><tr>
        <th>Datum</th>
        <th>Banka</th>
        <th>Protistrana</th>
        <th>Typ</th>
        <th>Zpráva</th>
        <th style="text-align:right">Částka</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${data.pohyby.length ? data.pohyby.map(p => `
          <tr>
            <td>${czDate(p.datum)}</td>
            <td><span class="badge" style="background:${p.banka==='AirBank'?'#dbeafe':'#dcfce7'}">${escHtml(p.banka)}</span></td>
            <td><strong>${escHtml(p.nazev_protiucet||"—")}</strong>${p.protiucet ? `<br><small style="color:var(--txt2)">${escHtml(p.protiucet)}</small>` : ""}</td>
            <td style="font-size:.85rem;color:var(--txt2)">${escHtml(p.typ_transakce||"")}</td>
            <td style="font-size:.85rem;color:var(--txt2);max-width:200px">${escHtml(p.zprava||"")}</td>
            <td style="text-align:right;font-weight:600;color:${p.castka>=0?'#16a34a':'#dc2626'}">${czMoney(p.castka)}</td>
            <td><button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border:none;padding:.2rem .5rem;border-radius:4px" onclick="smazatBankovniPohyb(${p.id})">🗑</button></td>
          </tr>`).join("")
          : "<tr><td colspan='7' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné transakce — importuj výpis z banky</td></tr>"}
      </tbody>
      ${data.pohyby.length ? `
      <tfoot>
        <tr class="table-footer">
          <td colspan="5">Celkem (${data.pohyby.length} transakcí)</td>
          <td style="text-align:right"><strong style="color:${data.celkem>=0?'#16a34a':'#dc2626'}">${czMoneyFull(data.celkem)}</strong></td>
          <td></td>
        </tr>
      </tfoot>` : ""}
    </table>`;
}





async function smazatBankovniPohyb(id) {
  if (!confirm("Opravdu smazat tento pohyb?")) return;
  await api(`/api/banky/pohyby/${id}`, { method: "DELETE" });
  toast("Pohyb smazán ✓");
  loadBanky();
}

// ═══════════════════════════════════════════════════════════════
//  VÝDAJE
// ═══════════════════════════════════════════════════════════════
async function renderVydaje(typ = "provozni") {
  const jeSoukrome = typ === "soukrome";
  const nazev = jeSoukrome ? "Soukromé výdaje" : "Výdaje";
  const pravoUpravit = jeSoukrome ? "soukrome_vydaje_upravit" : "vydaje_upravit";
  const tlacitka = maPravo(pravoUpravit)
    ? jeSoukrome
      ? `<button class="btn btn-primary btn-sm" onclick="renderSoukromeNahrat()">📷 Nahrát doklad</button>
         <button class="btn btn-sm" onclick="openVydajRucni()">✏️ Ruční zadání</button>`
      : `<button class="btn btn-primary btn-sm" onclick="openVydajNahrat('${typ}')">📷 Nahrát doklad</button>
         <button class="btn btn-sm" onclick="openVydajRucni()">✏️ Ruční zadání</button>`
    : "";
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${nazev}</h1>
      <div class="btn-group">${tlacitka}</div>
    </div>
    <div id="vydajeNezaplacene"></div>
    <div class="filters">
      <label>${jeSoukrome ? "Lokace:" : "Firma:"}</label>
      <select id="vFirma" class="${jeSoukrome ? "" : "firma-select"}" onchange="loadVydaje()">
        <option value="">${jeSoukrome ? "Všechny lokace" : "Všechny firmy"}</option>
        ${jeSoukrome
          ? ["Praha","Třebovle","UNI"].map(l=>`<option>${l}</option>`).join("")
          : App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
      </select>
      <label>Stav:</label>
      <select id="vStav" onchange="loadVydaje()">
        <option value="">Vše</option>
        <option value="nezaplaceno">Nezaplaceno</option>
        <option value="zaplaceno">Zaplaceno</option>
      </select>
      <label>Rok:</label>
      <select id="vRok" onchange="aplikujRokFiltr('vRok','vOd','vDo',loadVydaje)">
        ${rokOptions(new Date().getFullYear())}
      </select>
      <label>Od:</label><input type="date" id="vOd" onchange="loadVydaje()">
      <label>Do:</label><input type="date" id="vDo" onchange="loadVydaje()">
    </div>
    <div class="card">
      <div class="table-wrap" id="vydajeList"><div class="loading-center"><span class="spinner"></span></div></div>
    </div>`;
  // Uložit aktuální typ pro loadVydaje
  window._vydajTyp = typ;
  aplikujRokFiltr('vRok','vOd','vDo', null);
  loadVydajeNezaplacene();
  loadVydaje();
}

async function loadVydajeNezaplacene() {
  const el = document.getElementById("vydajeNezaplacene");
  if (!el) return;
  const typ = window._vydajTyp || "provozni";
  const data = await api(`/api/vydaje?stav=nezaplaceno&typ=${typ}`).catch(()=>({vydaje:[]}));
  if (!data.vydaje.length) { el.innerHTML = ""; return; }
  const dnes = new Date().toISOString().slice(0,10);
  // Seřadit: nejdříve po splatnosti, pak podle data splatnosti
  const serazene = [...data.vydaje].sort((a,b) => {
    const aOver = a.datum_splatnosti && a.datum_splatnosti < dnes;
    const bOver = b.datum_splatnosti && b.datum_splatnosti < dnes;
    if (aOver && !bOver) return -1;
    if (!aOver && bOver) return 1;
    return (a.datum_splatnosti||"9999") < (b.datum_splatnosti||"9999") ? -1 : 1;
  });
  const pocetPoSplatnosti = serazene.filter(v => v.datum_splatnosti && v.datum_splatnosti < dnes).length;
  el.innerHTML = `
    <div class="card" style="margin-bottom:1rem;border-left:4px solid #f59e0b">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.7rem">
        <div>
          <strong style="color:#92400e">⚠️ Nezaplacené výdaje (${data.vydaje.length})</strong>
          ${pocetPoSplatnosti ? `<span style="margin-left:.7rem;background:#fee2e2;color:#991b1b;border-radius:4px;padding:.1rem .5rem;font-size:.8rem;font-weight:700">${pocetPoSplatnosti} po splatnosti</span>` : ""}
        </div>
        <span style="font-weight:700;color:#dc2626">${czMoneyFull(data.celkem)}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th></th><th>Datum FA</th><th>Splatnost</th><th>Firma</th><th>Dodavatel</th><th>Popis / účel</th><th style="text-align:right">Částka</th></tr></thead>
          <tbody>
            ${serazene.map(v => {
              const poSplatnosti = v.datum_splatnosti && v.datum_splatnosti < dnes;
              const dnesJeSplatnost = v.datum_splatnosti === dnes;
              const rowStyle = poSplatnosti ? "background:#fff5f5" : dnesJeSplatnost ? "background:#fffbeb" : "";
              let splatnostHtml = "—";
              if (v.datum_splatnosti) {
                if (poSplatnosti) {
                  const dnu = Math.round((new Date(dnes)-new Date(v.datum_splatnosti))/(1000*86400));
                  splatnostHtml = `<span style="color:#dc2626;font-weight:700">${czDate(v.datum_splatnosti)}<br><small>po ${dnu} d</small></span>`;
                } else if (dnesJeSplatnost) {
                  splatnostHtml = `<span style="color:#d97706;font-weight:700">Dnes!</span>`;
                } else {
                  const dnu = Math.round((new Date(v.datum_splatnosti)-new Date(dnes))/(1000*86400));
                  splatnostHtml = `${czDate(v.datum_splatnosti)}<br><small style="color:var(--txt2)">za ${dnu} d</small>`;
                }
              }
              return `
            <tr style="${rowStyle}">
              <td><input type="checkbox" title="Označit jako zaplaceno"
                onchange="toggleVydajStav(${v.id}, this.checked, 'nezaplacene')"></td>
              <td>${czDate(v.datum)}</td>
              <td style="font-size:.85rem;white-space:nowrap">${splatnostHtml}</td>
              <td><span class="badge">${escHtml(v.firma_zkratka)}</span></td>
              <td>${escHtml(v.dodavatel||"—")}</td>
              <td>${escHtml(v.popis||v.poznamka||"")}</td>
              <td style="text-align:right;font-weight:600;color:#dc2626">${czMoneyFull(v.castka)}</td>
            </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function toggleVydajStav(id, zaplaceno, reload) {
  const stav = zaplaceno ? "zaplaceno" : "nezaplaceno";
  if (zaplaceno) {
    // Otevřít mini dialog pro datum úhrady a banku
    openModal("Označit jako zaplaceno", `
      <div class="form-group">
        <label class="form-label">Datum úhrady</label>
        <input type="date" id="uhradaDatum" class="form-control" value="${new Date().toISOString().split('T')[0]}">
      </div>
      <div class="form-group">
        <label class="form-label">Banka / způsob platby</label>
        <select id="uhradaBanka" class="form-control">
          <option value="">— nevyplněno —</option>
          <option value="AirBank">AirBank</option>
          <option value="RB">Raiffeisenbank</option>
          <option value="hotovost">Hotovost</option>
        </select>
      </div>
      <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:1rem">
        <button class="btn btn-secondary" onclick="closeModal()">Zrušit</button>
        <button class="btn btn-primary" onclick="_potvrdUhradu(${id},'${reload}')">✓ Potvrdit úhradu</button>
      </div>`);
  } else {
    await api(`/api/vydaje/${id}/stav`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({stav:"nezaplaceno", datum_uhrady:"", banka_uhrady:""})});
    toast("Označeno jako nezaplaceno");
    if (reload === "nezaplacene") { loadVydajeNezaplacene(); loadVydaje(); }
    else loadVydaje();
  }
}

async function _potvrdUhradu(id, reload) {
  const datum_uhrady = document.getElementById("uhradaDatum")?.value || "";
  const banka_uhrady = document.getElementById("uhradaBanka")?.value || "";
  await api(`/api/vydaje/${id}/stav`, {method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({stav:"zaplaceno", datum_uhrady, banka_uhrady})});
  closeModal();
  toast("Označeno jako zaplaceno ✓");
  if (reload === "nezaplacene") { loadVydajeNezaplacene(); loadVydaje(); }
  else loadVydaje();
}

async function loadVydaje() {
  const params = new URLSearchParams({
    firma: document.getElementById("vFirma")?.value || "",
    stav:  document.getElementById("vStav")?.value || "",
    od:    document.getElementById("vOd")?.value || "",
    do:    document.getElementById("vDo")?.value || "",
    typ:   window._vydajTyp || "provozni",
  });
  const data = await api(`/api/vydaje?${params}`);
  const el = document.getElementById("vydajeList");
  if (!el) return;
  const typ = window._vydajTyp || "provozni";
  const jeSoukrome = typ === "soukrome";
  const mozeUpravit = maPravo(jeSoukrome ? "soukrome_vydaje_upravit" : "vydaje_upravit");
  const mozeSmazat  = maPravo(jeSoukrome ? "soukrome_vydaje_smazat"  : "vydaje_smazat");
  el.innerHTML = `
    <table>
      <thead><tr>
        <th>Stav</th><th>Datum</th><th>${jeSoukrome ? "Lokace" : "Firma"}</th><th>Dodavatel</th>
        <th>Popis / účel</th><th>Položky</th>
        <th>Způsob úhrady</th><th>Uhrazeno</th><th style="text-align:right">Částka</th><th>Doklad</th><th></th>
      </tr></thead>
      <tbody>
        ${data.vydaje.length ? data.vydaje.map(v=>`
        <tr style="cursor:${mozeUpravit?'pointer':'default'};opacity:${v.stav==='zaplaceno'?'.7':'1'}"
            onclick="${mozeUpravit?`openVydajEdit(${v.id})`:''}">
          <td onclick="event.stopPropagation()">
            <input type="checkbox" ${v.stav==='zaplaceno'?'checked':''} title="Zaplaceno"
              onchange="toggleVydajStav(${v.id}, this.checked, 'list')">
          </td>
          <td>${czDate(v.datum)}</td>
          <td><span class="badge">${escHtml(v.firma_zkratka)}</span></td>
          <td>${escHtml(v.dodavatel||"—")}</td>
          <td style="font-size:.9rem">
            ${v.popis?`<strong>${escHtml(v.popis)}</strong>`:""} 
            ${v.poznamka?`<small style="color:var(--txt2)">${escHtml(v.poznamka)}</small>`:""}
          </td>
          <td style="font-size:.82rem;color:var(--txt2)">
            ${(v.polozky||[]).map(p=>`${escHtml(p.nazev)} ${czMoneyFull(p.castka)}`).join("<br>")||"—"}
          </td>
          <td><span class="badge" style="background:#f3f4f6">${escHtml(v.zpusob_uhrady||"")}</span></td>
          <td style="font-size:.85rem;color:var(--txt2)">
            ${v.datum_uhrady ? `${czDate(v.datum_uhrady)}${v.banka_uhrady ? `<br><small>${escHtml(v.banka_uhrady)}</small>` : ""}` : "—"}
          </td>
          <td style="text-align:right;font-weight:600;color:${v.stav==='zaplaceno'?'var(--txt2)':'#dc2626'}">${czMoneyFull(v.castka)}</td>
          <td>${v.soubor_url?`<a href="${v.soubor_url}" target="_blank" onclick="event.stopPropagation()" style="font-size:.85rem">📎</a>`:""}</td>
          <td onclick="event.stopPropagation()">
            ${mozeSmazat?`<button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border:none;padding:.2rem .4rem;border-radius:4px" onclick="smazatVydaj(${v.id})">🗑</button>`:""}
          </td>
        </tr>`).join("")
        : "<tr><td colspan='10' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné výdaje</td></tr>"}
      </tbody>
      ${data.vydaje.length ? `
      <tfoot><tr class="table-footer">
        <td colspan="8">Celkem (${data.vydaje.length} výdajů)</td>
        <td style="text-align:right"><strong style="color:#dc2626">${czMoneyFull(data.celkem)}</strong></td>
        <td colspan="2"></td>
      </tr></tfoot>` : ""}
    </table>`;
}

function _vydajModal(titul, v, onSave, typ) {
  const jeSoukrome = typ === "soukrome";
  const lokace = ["Praha","Třebovle","UNI"];
  const polozkyHtml = (v.polozky||[]).map((p,i)=>`
    <tr id="vp_${i}">
      <td><input class="form-control vp-nazev" style="font-size:.85rem" value="${escHtml(p.nazev||'')}" placeholder="Název položky"></td>
      <td><input type="number" step="0.01" class="form-control vp-castka" style="font-size:.85rem;width:110px" value="${p.castka||''}"></td>
      <td><button type="button" onclick="this.closest('tr').remove()" style="background:none;border:none;cursor:pointer;color:#dc2626">✕</button></td>
    </tr>`).join("");

  openModal(titul, `
    <div class="grid-2" style="gap:1rem">
      <div class="form-group"><label class="form-label">${jeSoukrome ? "Lokace *" : "Firma *"}</label>
        <select id="evFirma" class="form-control">
          ${jeSoukrome
            ? lokace.map(l=>`<option ${v.firma_zkratka===l?'selected':''}>${l}</option>`).join("")
            : App.config.firmy.map(f=>`<option ${v.firma_zkratka===f?'selected':''}>${f}</option>`).join("")}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Dodavatel</label>
        <input id="evDodavatel" class="form-control" value="${escHtml(v.dodavatel||'')}" placeholder="Název obchodu / firmy">
      </div>
      <div class="form-group"><label class="form-label">Datum</label>
        <input type="date" id="evDatum" class="form-control" value="${v.datum||''}">
      </div>
      <div class="form-group"><label class="form-label">Datum splatnosti</label>
        <input type="date" id="evDatumSpl" class="form-control" value="${v.datum_splatnosti||''}">
      </div>
      <div class="form-group"><label class="form-label">Částka (Kč) *</label>
        <input type="number" step="0.01" id="evCastka" class="form-control" value="${v.castka||''}">
      </div>
      <div class="form-group"><label class="form-label">Způsob úhrady</label>
        <select id="evUhrada" class="form-control">
          ${["hotovost","karta","převodem"].map(u=>`<option ${(v.zpusob_uhrady||'hotovost')===u?'selected':''}>${u}</option>`).join("")}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Stav</label>
        <select id="evStav" class="form-control">
          <option value="nezaplaceno" ${(v.stav||'nezaplaceno')==='nezaplaceno'?'selected':''}>Nezaplaceno</option>
          <option value="zaplaceno"   ${v.stav==='zaplaceno'?'selected':''}>Zaplaceno</option>
        </select>
      </div>
      <div class="form-group"><label class="form-label">Datum úhrady</label>
        <input type="date" id="evDatumUhrady" class="form-control" value="${v.datum_uhrady||''}">
      </div>
      <div class="form-group"><label class="form-label">Banka / způsob platby</label>
        <select id="evBankaUhrady" class="form-control">
          <option value="" ${!v.banka_uhrady?'selected':''}>— nevyplněno —</option>
          <option value="AirBank" ${v.banka_uhrady==='AirBank'?'selected':''}>AirBank</option>
          <option value="RB" ${v.banka_uhrady==='RB'?'selected':''}>Raiffeisenbank</option>
          <option value="hotovost" ${v.banka_uhrady==='hotovost'?'selected':''}>Hotovost</option>
        </select>
      </div>
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">Popis / účel</label>
        <input id="evPopis" class="form-control" value="${escHtml(v.popis||'')}" placeholder="např. nájem 1Q 2026, oprava lednice...">
      </div>
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">Poznámka</label>
        <input id="evPoznamka" class="form-control" value="${escHtml(v.poznamka||'')}" placeholder="Interní poznámka...">
      </div>
    </div>
    <div style="margin-top:1rem">
      <label class="form-label">Položky</label>
      <table style="width:100%;margin-bottom:.5rem" id="evPolozkyTbl">
        <thead><tr><th style="font-size:.8rem">Název</th><th style="font-size:.8rem">Částka</th><th></th></tr></thead>
        <tbody>${polozkyHtml}</tbody>
      </table>
      <button type="button" class="btn btn-sm" onclick="vydajPridatPolozku()">+ Přidat položku</button>
    </div>
    <div style="text-align:right;margin-top:1rem">
      <button class="btn btn-primary" onclick="App._vydajOnSave&&App._vydajOnSave()">💾 Uložit</button>
    </div>`);
  App._vydajOnSave = onSave;
}

function vydajPridatPolozku() {
  const tbody = document.querySelector("#evPolozkyTbl tbody");
  if (!tbody) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="form-control vp-nazev" style="font-size:.85rem" placeholder="Název položky"></td>
    <td><input type="number" step="0.01" class="form-control vp-castka" style="font-size:.85rem;width:110px" placeholder="0"></td>
    <td><button type="button" onclick="this.closest('tr').remove()" style="background:none;border:none;cursor:pointer;color:#dc2626">✕</button></td>`;
  tbody.appendChild(tr);
}

function _vydajGetPayload() {
  const polozky = [];
  document.querySelectorAll("#evPolozkyTbl tbody tr").forEach(tr => {
    const nazev = tr.querySelector(".vp-nazev")?.value.trim();
    const castka = parseFloat(tr.querySelector(".vp-castka")?.value||0);
    if (nazev) polozky.push({nazev, castka});
  });
  return {
    firma_zkratka:    document.getElementById("evFirma").value,
    dodavatel:        document.getElementById("evDodavatel").value,
    datum:            document.getElementById("evDatum").value,
    datum_splatnosti: document.getElementById("evDatumSpl").value,
    castka:           parseFloat(document.getElementById("evCastka").value||0),
    zpusob_uhrady:    document.getElementById("evUhrada").value,
    stav:             document.getElementById("evStav").value,
    datum_uhrady:     document.getElementById("evDatumUhrady")?.value || "",
    banka_uhrady:     document.getElementById("evBankaUhrady")?.value || "",
    popis:            document.getElementById("evPopis").value,
    poznamka:         document.getElementById("evPoznamka").value,
    polozky,
  };
}

function openVydajRucni() {
  const typ = window._vydajTyp || "provozni";
  const jeSoukrome = typ === "soukrome";
  const defaultFirma = jeSoukrome ? "Praha" : (App.config.firmy[0]||"");
  _vydajModal("Nový výdaj", { firma_zkratka: defaultFirma, polozky:[] }, async function() {
    const payload = { ..._vydajGetPayload(), zdroj:"rucni", typ };
    if (!payload.firma_zkratka || !payload.castka) { toast("Vyplň lokaci a částku"); return; }
    await api("/api/vydaje", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
    toast("Výdaj uložen ✓"); closeModal(); loadVydaje(); loadVydajeNezaplacene();
  }, typ);
}

async function openVydajEdit(id) {
  const typ = window._vydajTyp || "provozni";
  const data = await api(`/api/vydaje?typ=${typ}`);
  const v = data.vydaje.find(x=>x.id===id);
  if (!v) return;
  _vydajModal("Upravit výdaj", v, async function() {
    const payload = _vydajGetPayload();
    await api(`/api/vydaje/${id}`, { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
    toast("Uloženo ✓"); closeModal(); loadVydaje(); loadVydajeNezaplacene();
  }, typ);
}

function openVydajNahrat(typ = null) {
  const t = typ || window._vydajTyp || "provozni";
  const jeSoukromeNahrat = t === "soukrome";
  const lokaceNahrat = ["Praha","Třebovle","UNI"];
  openModal("Nahrát doklad výdaje", `
    <div class="form-group" style="margin-bottom:1rem">
      <label class="form-label">${jeSoukromeNahrat ? "Lokace" : "Firma"}</label>
      <select id="vNahratFirma" class="form-control">
        ${jeSoukromeNahrat
          ? lokaceNahrat.map(l=>`<option>${l}</option>`).join("")
          : App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
      </select>
    </div>
    <div class="dropzone" id="vydajDropzone" style="padding:1.5rem">
      <div class="dropzone-icon">🧾</div>
      <div class="dropzone-text"><strong>Přetáhněte foto nebo PDF dokladu</strong> nebo klikněte</div>
      <input type="file" id="vydajFileInput" accept="image/*,.pdf">
    </div>
    <div style="margin-top:.75rem;text-align:center">
      <button class="btn btn-secondary btn-sm" onclick="openDrivePicker(drivePickerVydaj)">📂 Vybrat z Google Drive</button>
    </div>
    <div id="vydajNahratStatus" style="margin-top:1rem;font-size:.9rem"></div>
    <div id="vydajNahratForm" style="display:none;margin-top:1rem"></div>`);

  const dz  = document.getElementById("vydajDropzone");
  const inp = document.getElementById("vydajFileInput");
  inp.style.display = "none";
  dz.addEventListener("click", () => inp.click());
  inp.addEventListener("change", () => { if (inp.files[0]) doVydajNahrat(inp.files[0]); });
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", e => {
    e.preventDefault(); dz.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) doVydajNahrat(e.dataTransfer.files[0]);
  });
}

async function drivePickerVydaj(res) {
  const statusEl = document.getElementById("vydajNahratStatus");
  if (statusEl) statusEl.innerHTML = `<span class="spinner"></span> Zpracovávám z Google Drive...`;
  const fd = new FormData();
  fd.append("firma_zkratka", document.getElementById("vNahratFirma")?.value || "");
  fd.append("soubor_url", res.soubor_url || "");
  fd.append("from_drive_path", res.tmp_path || "");
  try {
    const data = await api("/api/vydaje/nahrat-path", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ path: res.tmp_path, soubor_url: res.soubor_url, filename: res.filename, firma_zkratka: document.getElementById("vNahratFirma")?.value || "" })
    });
    if (statusEl) statusEl.innerHTML = "✅ Doklad rozpoznán z Drive";
    const formEl = document.getElementById("vydajNahratForm");
    if (formEl) { formEl.style.display = "block"; _renderVydajForm(formEl, data); }
  } catch(e) { if (statusEl) statusEl.innerHTML = "❌ Chyba: " + e.message; }
}

async function doVydajNahrat(file) {
  const statusEl = document.getElementById("vydajNahratStatus");
  statusEl.innerHTML = `<span class="spinner"></span> Zpracovávám doklad...`;
  const fd = new FormData();
  fd.append("soubor", file);
  fd.append("firma_zkratka", document.getElementById("vNahratFirma")?.value || "");
  try {
    const data = await api("/api/vydaje/nahrat", { method:"POST", body:fd });
    statusEl.innerHTML = `✅ Doklad rozpoznán`;
    const formEl = document.getElementById("vydajNahratForm");
    formEl.style.display = "block";
    _renderVydajForm(formEl, data);
  } catch(e) {
    statusEl.innerHTML = `❌ Chyba: ${e.message}`;
  }
}

function _renderVydajForm(formEl, data) {
  formEl.innerHTML = `
    <div class="grid-2" style="gap:1rem">
      <div class="form-group"><label class="form-label">Dodavatel</label>
        <input id="vnDodavatel" class="form-control" value="${escHtml(data.dodavatel||'')}">
      </div>
      <div class="form-group"><label class="form-label">Datum</label>
        <input type="date" id="vnDatum" class="form-control" value="${data.datum||''}">
      </div>
      <div class="form-group"><label class="form-label">Částka (Kč)</label>
        <input type="number" step="0.01" id="vnCastka" class="form-control" value="${data.castka||''}">
      </div>
      <div class="form-group"><label class="form-label">Způsob úhrady</label>
        <select id="vnUhrada" class="form-control">
          <option>hotovost</option><option>karta</option><option>převodem</option>
        </select>
      </div>
      <div class="form-group" style="grid-column:1/-1"><label class="form-label">Popis / účel</label>
        <input id="vnPopis" class="form-control" value="${escHtml(data.poznamka||'')}">
      </div>
    </div>
    <div style="text-align:right;margin-top:1rem">
      <button class="btn btn-primary" onclick="ulozitVydajZDokladu('${data.soubor_cesta}','${data.soubor_gcs_url}')">💾 Uložit výdaj</button>
    </div>`;
}

async function ulozitVydajZDokladu(soubor_cesta, soubor_url) {
  const typ = window._vydajTyp || "provozni";
  const jeSoukrome = typ === "soukrome";
  const firma_zkratka = jeSoukrome
    ? (document.getElementById("soukrNahratLokace")?.value || "Praha")
    : (document.getElementById("vNahratFirma")?.value || "");
  const payload = {
    firma_zkratka,
    dodavatel:     document.getElementById("vnDodavatel").value,
    datum:         document.getElementById("vnDatum").value,
    castka:        parseFloat(document.getElementById("vnCastka").value||0),
    zpusob_uhrady: document.getElementById("vnUhrada").value,
    popis:         document.getElementById("vnPopis").value,
    stav:          "zaplaceno",
    soubor_cesta, soubor_url,
    zdroj: "ocr",
    typ,
    polozky: [],
  };
  if (!payload.firma_zkratka || !payload.castka) { toast("Vyplň lokaci a částku"); return; }
  await api("/api/vydaje", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
  toast("Výdaj uložen ✓");
  if (jeSoukrome) { renderVydaje("soukrome"); } else { closeModal(); loadVydaje(); loadVydajeNezaplacene(); }
}

async function smazatVydaj(id) {
  if (!confirm("Opravdu smazat tento výdaj?")) return;
  await api(`/api/vydaje/${id}`, { method:"DELETE" });
  toast("Výdaj smazán ✓"); loadVydaje(); loadVydajeNezaplacene();
}

// ═══════════════════════════════════════════════════════════════
//  VYSTAVENÉ FAKTURY
// ═══════════════════════════════════════════════════════════════

const VYST_ODBERATELE = ["Bauhaus"];
let _vystSort = { col: "datum", dir: "desc" };

function vystSort(col) {
  if (_vystSort.col === col) _vystSort.dir = _vystSort.dir === "asc" ? "desc" : "asc";
  else { _vystSort.col = col; _vystSort.dir = "asc"; }
  loadVystavene();
}

async function renderVystavene() {
  const muzeEditovat = App.role === "admin";
  const tlacitka = muzeEditovat
    ? `<button class="btn btn-primary btn-sm" onclick="openVystNahrat()">📄 Nahrát PDF</button>
       <button class="btn btn-sm" onclick="openVystRucni()">✏️ Ruční zadání</button>`
    : "";
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Vystavené faktury</h1>
      <div class="btn-group">${tlacitka}</div>
    </div>
    <div class="row" style="gap:0.5rem;margin-bottom:1rem;display:flex;flex-wrap:wrap">
      <div class="card" style="flex:1;min-width:130px;padding:0.75rem;text-align:center">
        <div class="text-muted" style="font-size:0.8rem">Celkem faktur</div>
        <div class="fw-bold" id="vyst-pocet">—</div>
      </div>
      <div class="card" style="flex:1;min-width:130px;padding:0.75rem;text-align:center">
        <div class="text-muted" style="font-size:0.8rem">Celková částka</div>
        <div class="fw-bold" id="vyst-celkem">—</div>
      </div>
      <div class="card" style="flex:1;min-width:130px;padding:0.75rem;text-align:center">
        <div class="text-muted" style="font-size:0.8rem">Nezaplaceno</div>
        <div class="fw-bold" style="color:var(--danger)" id="vyst-nezapl">—</div>
      </div>
      <div class="card" style="flex:1;min-width:130px;padding:0.75rem;text-align:center">
        <div class="text-muted" style="font-size:0.8rem">Zaplaceno</div>
        <div class="fw-bold" style="color:var(--success)" id="vyst-zapl">—</div>
      </div>
    </div>
    <div class="filters">
      <label>Firma:</label>
      <select id="vystFirmaFilter" class="firma-select" onchange="loadVystavene()">
        <option value="">Všechny firmy</option>
        ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
      </select>
      <label>Rok:</label>
      <select id="vystRok" onchange="aplikujRokFiltr('vystRok','vystOd','vystDo',loadVystavene)">
        ${rokOptions(new Date().getFullYear())}
      </select>
      <label>Od:</label><input type="date" id="vystOd" onchange="loadVystavene()">
      <label>Do:</label><input type="date" id="vystDo" onchange="loadVystavene()">
    </div>
    <div class="card">
      <div class="table-wrap" id="vystList"><div class="loading-center"><span class="spinner"></span></div></div>
    </div>`;
  aplikujRokFiltr('vystRok','vystOd','vystDo', null);
  loadVystavene();
}

async function loadVystavene() {
  const el = document.getElementById("vystList");
  if (!el) return;
  const params = new URLSearchParams({
    firma: document.getElementById("vystFirmaFilter")?.value || "",
    od:    document.getElementById("vystOd")?.value || "",
    do:    document.getElementById("vystDo")?.value || "",
  });
  const data = await api(`/api/vystavene-faktury?${params}`).catch(() => []);
  // souhrn
  let celkem = 0, nezapl = 0, zapl = 0;
  data.forEach(f => {
    celkem += f.castka;
    if (f.stav === "zaplaceno") zapl += f.castka; else nezapl += f.castka;
  });
  const p = document.getElementById("vyst-pocet");  if (p) p.textContent = data.length;
  const c = document.getElementById("vyst-celkem"); if (c) c.textContent = czMoneyFull(celkem) + " Kč";
  const n = document.getElementById("vyst-nezapl"); if (n) n.textContent = czMoneyFull(nezapl) + " Kč";
  const z = document.getElementById("vyst-zapl");   if (z) z.textContent = czMoneyFull(zapl) + " Kč";

  if (!data.length) { el.innerHTML = "<p style='padding:1rem;color:var(--text-muted)'>Žádné vystavené faktury.</p>"; return; }

  // Sortování
  const sortFns = {
    firma_zkratka:    (a,b) => (a.firma_zkratka||"").localeCompare(b.firma_zkratka||""),
    cislo_faktury:    (a,b) => (a.cislo_faktury||"").localeCompare(b.cislo_faktury||""),
    datum:            (a,b) => (a.datum||"").localeCompare(b.datum||""),
    datum_splatnosti: (a,b) => (a.datum_splatnosti||"").localeCompare(b.datum_splatnosti||""),
    odberatel:        (a,b) => (a.odberatel||"").localeCompare(b.odberatel||""),
    castka:           (a,b) => (a.castka||0) - (b.castka||0),
  };
  if (sortFns[_vystSort.col]) {
    data.sort((a,b) => { const r = sortFns[_vystSort.col](a,b); return _vystSort.dir === "asc" ? r : -r; });
  }
  const arrow = (col) => _vystSort.col === col ? (_vystSort.dir === "asc" ? " ▲" : " ▼") : " ⇅";
  const th = (col, label) => `<th style="cursor:pointer;user-select:none" onclick="vystSort('${col}')">${label}${arrow(col)}</th>`;
  const muzeEditovat = App.role === "admin";
  el.innerHTML = `<table class="data-table">
    <thead><tr>
      ${th("firma_zkratka","Firma")}${th("cislo_faktury","Číslo faktury")}
      ${th("datum","Datum vystavení")}${th("datum_splatnosti","Datum splatnosti")}
      ${th("odberatel","Odběratel")}<th>Popis</th>
      ${th("castka","Částka")}<th class="text-center">Stav</th>
      ${muzeEditovat ? "<th class='text-center'>Akce</th>" : ""}
    </tr></thead>
    <tbody>${data.map(f => {
      const odkaz = f.soubor_url
        ? `<a href="${f.soubor_url}" target="_blank" title="Zobrazit originál">🔗 ${f.cislo_faktury||"—"}</a>`
        : (f.cislo_faktury||"—");
      const dupBadge = f.duplicita_id
        ? ` <small style="color:orange">⚠️ dup #${f.duplicita_id}</small>` : "";
      const stavBtn = f.duplicita_id
        ? `<span class="badge" style="background:#0d6efd;color:#fff">🔗 Duplikát #${f.duplicita_id}</span>`
        : muzeEditovat
          ? `<button class="btn btn-xs ${f.stav==="zaplaceno"?"btn-success":"btn-outline"}"
               onclick="toggleVystStav(${f.id},'${f.stav}')">${f.stav==="zaplaceno"?"✓ Zaplaceno":"✗ Nezaplaceno"}</button>`
          : `<span class="badge ${f.stav==="zaplaceno"?"badge-success":"badge-danger"}">${f.stav==="zaplaceno"?"Zaplaceno":"Nezaplaceno"}</span>`;
      const akce = muzeEditovat
        ? `<td class="text-center">
             <button class="btn btn-xs btn-outline" onclick="openVystEdit(${f.id})" title="Upravit">✏️</button>
             <button class="btn btn-xs btn-danger" onclick="smazatVystavenu(${f.id})" title="Smazat">🗑</button>
           </td>` : "";
      return `<tr style="opacity:${f.duplicita_id ? '0.55' : '1'}">
        <td><span class="badge">${f.firma_zkratka}</span></td>
        <td>${odkaz}${dupBadge}</td><td>${f.datum||"—"}</td><td>${f.datum_splatnosti||"—"}</td>
        <td>${f.odberatel||"—"}</td>
        <td style="color:var(--text-muted);font-size:0.85rem">${f.popis||"—"}</td>
        <td class="text-right fw-bold">${czMoneyFull(f.castka)} Kč</td>
        <td class="text-center">${stavBtn}</td>${akce}
      </tr>`;
    }).join("")}</tbody></table>`;
}

function vystFormHtml(f = {}) {
  const jeZnamy = f.odberatel && VYST_ODBERATELE.includes(f.odberatel);
  return `
    <div class="form-row">
      <div class="form-group">
        <label>Firma</label>
        <select id="vystFirma" class="form-control firma-select">
          ${App.config.firmy.map(fi=>`<option ${fi===(f.firma_zkratka||"")?"selected":""}>${fi}</option>`).join("")}
        </select>
      </div>
      <div class="form-group">
        <label>Číslo faktury</label>
        <input type="text" id="vystCislo" class="form-control" value="${f.cislo_faktury||""}" placeholder="např. 2025001">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Datum vystavení</label>
        <input type="date" id="vystDatum" class="form-control" value="${f.datum||""}">
      </div>
      <div class="form-group">
        <label>Datum splatnosti</label>
        <input type="date" id="vystDatumSpl" class="form-control" value="${f.datum_splatnosti||""}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Částka (Kč)</label>
        <input type="number" id="vystCastka" class="form-control" step="0.01" min="0" value="${f.castka||""}">
      </div>
    </div>
    <div class="form-group">
      <label>Odběratel</label>
      <select id="vystOdbSel" class="form-control" onchange="toggleVystOdb()">
        ${VYST_ODBERATELE.map(o=>`<option ${o===(f.odberatel||"")?"selected":""}>${o}</option>`).join("")}
        <option value="__jiny__" ${!jeZnamy&&f.odberatel?"selected":""}>— zadat ručně —</option>
      </select>
      <input type="text" id="vystOdbRucne" class="form-control" style="margin-top:0.4rem;${jeZnamy||!f.odberatel?"display:none":""}"
             value="${!jeZnamy?f.odberatel||"":""}" placeholder="Název odběratele">
    </div>
    <div class="form-group">
      <label>Popis plnění</label>
      <input type="text" id="vystPopis" class="form-control" value="${f.popis||""}" placeholder="Stručný popis">
    </div>
    <div class="form-group">
      <label>Stav</label>
      <select id="vystStav" class="form-control">
        <option value="nezaplaceno" ${(f.stav||"nezaplaceno")==="nezaplaceno"?"selected":""}>Nezaplaceno</option>
        <option value="zaplaceno" ${f.stav==="zaplaceno"?"selected":""}>Zaplaceno</option>
      </select>
    </div>
    <input type="hidden" id="vystSouborUrl" value="${f.soubor_url||""}">`;
}

function toggleVystOdb() {
  const sel = document.getElementById("vystOdbSel").value;
  const m = document.getElementById("vystOdbRucne");
  if (m) m.style.display = sel === "__jiny__" ? "" : "none";
}

function openVystNahrat() {
  openModal("📄 Nahrát vystavenou fakturu", `
    <div class="form-group">
      <label>PDF / foto</label>
      <input type="file" id="vystSoubor" accept=".pdf,image/*" class="form-control">
    </div>
    <button class="btn btn-primary" onclick="spustVystOCR()">🔍 Rozpoznat z PDF</button>
    <button class="btn btn-secondary" onclick="openDrivePicker(drivePickerVyst)" style="margin-left:.5rem">📂 Z Google Drive</button>
    <span id="vystOcrStatus" style="margin-left:0.5rem;font-size:0.85rem;color:var(--text-muted)"></span>
    <hr>
    <div id="vystFormFields" style="display:none">
      <div id="vystDuplikátWarning" style="display:none;margin-bottom:1rem;padding:.75rem 1rem;border-radius:8px;background:#fff3cd;border:1px solid #ffc107;color:#856404"></div>
      ${vystFormHtml()}
      <div style="margin-top:1rem;display:flex;gap:0.5rem;justify-content:flex-end">
        <button class="btn btn-secondary" onclick="closeModal()">Zrušit</button>
        <button class="btn btn-primary" onclick="saveVystavena()">💾 Uložit</button>
      </div>
    </div>`);
  fillFirmaSelects();
}

function openVystRucni() {
  openModal("✏️ Ruční zadání vystavené faktury", `
    ${vystFormHtml()}
    <div style="margin-top:1rem;display:flex;gap:0.5rem;justify-content:flex-end">
      <button class="btn btn-secondary" onclick="closeModal()">Zrušit</button>
      <button class="btn btn-primary" onclick="saveVystavena()">💾 Uložit</button>
    </div>`);
  fillFirmaSelects();
}

async function openVystEdit(id) {
  const data = await api("/api/vystavene-faktury").catch(()=>[]);
  const f = data.find(x => x.id === id);
  if (!f) return;
  openModal("✏️ Upravit vystavenou fakturu", `
    ${vystFormHtml(f)}
    <div style="margin-top:1rem;display:flex;gap:0.5rem;justify-content:flex-end">
      <button class="btn btn-secondary" onclick="closeModal()">Zrušit</button>
      <button class="btn btn-primary" onclick="saveVystavena(${id})">💾 Uložit</button>
    </div>`);
  fillFirmaSelects();
  document.getElementById("vystFirma").value = f.firma_zkratka || "";
}

async function drivePickerVyst(res) {
  // Zavolá OCR na soubor stažený z Drive
  const status = document.getElementById("vystOcrStatus");
  if (status) status.textContent = "⏳ Rozpoznávám…";
  document.getElementById("vystFormFields").style.display = "";
  if (res.soubor_url) document.getElementById("vystSouborUrl").value = res.soubor_url;
  try {
    const data = await api("/api/vystavene-faktury/nahrat-path", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ path: res.tmp_path, soubor_url: res.soubor_url, filename: res.filename })
    });
    if (data.error) { if (status) status.textContent = "Chyba: " + data.error; return; }
    if (data.cislo_faktury) document.getElementById("vystCislo").value = data.cislo_faktury;
    if (data.datum)         document.getElementById("vystDatum").value = data.datum;
    if (data.datum_splatnosti) document.getElementById("vystDatumSpl").value = data.datum_splatnosti;
    if (data.castka)        document.getElementById("vystCastka").value = data.castka;
    if (data.popis)         document.getElementById("vystPopis").value = data.popis;
    if (data.soubor_url)    document.getElementById("vystSouborUrl").value = data.soubor_url;
    if (status) status.textContent = "✓ Rozpoznáno z Drive";
    await _zkontrolujVystDuplicit(data);
  } catch(e) { if (status) status.textContent = "Chyba OCR"; }
}

async function _zkontrolujVystDuplicit(data) {
  const dupWarnEl = document.getElementById("vystDuplikátWarning");
  if (!data.cislo_faktury || !data.datum || !dupWarnEl) return;
  try {
    const dup = await api("/api/vystavene-faktury/zkontroluj", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ cislo_faktury: data.cislo_faktury, datum: data.datum, castka: data.castka || 0 })
    });
    if (dup.duplicita) {
      dupWarnEl.style.display = "";
      dupWarnEl.innerHTML = `⚠️ <strong>Možný duplikát!</strong> Faktura s číslem <strong>${escHtml(data.cislo_faktury)}</strong> již existuje jako FA #${dup.duplicita.id} (${escHtml(dup.duplicita.firma)}, ${czDate(dup.duplicita.datum)}, ${czMoney(dup.duplicita.castka)}). Faktura bude uložena a označena jako duplikát.`;
    } else {
      dupWarnEl.style.display = "none";
      dupWarnEl.innerHTML = "";
    }
  } catch(e) {}
}

async function spustVystOCR() {
  const fi = document.getElementById("vystSoubor");
  if (!fi?.files.length) { toast("Vyberte soubor."); return; }
  const status = document.getElementById("vystOcrStatus");
  status.textContent = "Rozpoznávám…";
  const fd = new FormData();
  fd.append("soubor", fi.files[0]);
  try {
    const data = await api("/api/vystavene-faktury/nahrat", {method:"POST", body: fd});
    if (data.error) { status.textContent = "Chyba: " + data.error; return; }
    document.getElementById("vystFormFields").style.display = "";
    if (data.cislo_faktury) document.getElementById("vystCislo").value = data.cislo_faktury;
    if (data.datum)         document.getElementById("vystDatum").value = data.datum;
    if (data.datum_splatnosti) document.getElementById("vystDatumSpl").value = data.datum_splatnosti;
    if (data.castka)        document.getElementById("vystCastka").value = data.castka;
    if (data.popis)         document.getElementById("vystPopis").value = data.popis;
    if (data.soubor_url)    document.getElementById("vystSouborUrl").value = data.soubor_url;
    if (data.odberatel) {
      const sel = document.getElementById("vystOdbSel");
      if (VYST_ODBERATELE.includes(data.odberatel)) { sel.value = data.odberatel; }
      else { sel.value = "__jiny__"; toggleVystOdb(); document.getElementById("vystOdbRucne").value = data.odberatel; }
    }
    status.textContent = "✓ Rozpoznáno";
    await _zkontrolujVystDuplicit(data);
  } catch(e) { status.textContent = "Chyba OCR"; }
}

async function saveVystavena(editId = null) {
  const sel = document.getElementById("vystOdbSel").value;
  const odberatel = sel === "__jiny__"
    ? (document.getElementById("vystOdbRucne").value||"").trim() : sel;
  const payload = {
    firma_zkratka:    document.getElementById("vystFirma").value,
    cislo_faktury:    document.getElementById("vystCislo").value.trim(),
    datum:            document.getElementById("vystDatum").value,
    datum_splatnosti: document.getElementById("vystDatumSpl").value,
    odberatel,
    popis:            document.getElementById("vystPopis").value.trim(),
    castka:           parseFloat(document.getElementById("vystCastka").value)||0,
    stav:             document.getElementById("vystStav").value,
    soubor_url:       document.getElementById("vystSouborUrl").value,
  };
  const url    = editId ? `/api/vystavene-faktury/${editId}` : "/api/vystavene-faktury";
  const method = editId ? "PUT" : "POST";
  const res = await api(url, {method, headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload)});
  if (res.duplicita) {
    toast(`⚠️ Možný duplikát! Faktura č. ${res.duplicita.id} (${res.duplicita.firma}, ${res.duplicita.datum}, ${czMoney(res.duplicita.castka)}) již existuje.`, 6000);
  } else {
    toast(editId ? "Faktura upravena ✓" : "Faktura uložena ✓");
  }
  closeModal(); loadVystavene();
}

async function toggleVystStav(id,  stavNyni) {
  const novy = stavNyni === "zaplaceno" ? "nezaplaceno" : "zaplaceno";
  await api(`/api/vystavene-faktury/${id}/stav`, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({stav: novy})});
  loadVystavene();
}

async function smazatVystavenu(id) {
  if (!confirm("Opravdu smazat tuto fakturu?")) return;
  await api(`/api/vystavene-faktury/${id}`, {method:"DELETE"});
  toast("Faktura smazána ✓"); loadVystavene(); 
}




// ═══════════════════════════════════════════════════════════════
//  PENĚŽENKA — hotovostní kasa
// ═══════════════════════════════════════════════════════════════

const PW_NOMINALY = [5000,2000,1000,500,200,100,50,20,10,5,2,1];

const PW_BANKY = [
  { key:"rb_fp",    label:"RB — FP" },
  { key:"rb_mr",    label:"RB — MR" },
  { key:"rb_cff",   label:"RB — CFF" },
  { key:"rb_radek", label:"RB — Radek" },
  { key:"air_fp",   label:"Air — FP" },
  { key:"air_mr",   label:"Air — MR" },
  { key:"air_cff",  label:"Air — CFF" },
  { key:"air_radek",label:"Air — Radek" },
  { key:"kb_radek", label:"KB — Radek" },
];

const PW_BROKERI = [
  { key:"xtb_czk", label:"XTB — CZK" },
  { key:"xtb_eur", label:"XTB — EUR", eur:true },
  { key:"t212",    label:"Trading 212" },
  { key:"etoro",   label:"eToro" },
];

let _pwEurKurz = null;

async function _pwNacistKurz() {
  if (_pwEurKurz) return _pwEurKurz;
  try {
    const d = await api("/api/eur-kurz");
    _pwEurKurz = d.kurz || 25;
  } catch {
    _pwEurKurz = 25;
  }
  return _pwEurKurz;
}

async function renderPenezenka() {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">💵 Peněženka</h1>
    </div>
    <div id="penezenkaObs"><div class="loading-center"><span class="spinner"></span></div></div>`;
  loadPenezenka();
}

async function loadPenezenka() {
  const el = document.getElementById("penezenkaObs");
  if (!el) return;
  let data;
  try { data = await api("/api/penezenka"); } catch { return; }

  const teoreticky = data.teoreticky_stav || 0;
  const zaznamy    = data.zaznamy || [];
  const z0 = zaznamy[0] || null;
  const z1 = zaznamy[1] || null;

  const hotovost = z0 ? (z0.hotovost||0) : null;
  const banky    = z0 ? PW_BANKY.reduce((s,b)=>s+(z0[b.key]||0),0) : null;
  const akcie    = z0 ? PW_BROKERI.reduce((s,b)=>s+(z0[b.key]||0),0) : null;
  const sporeni  = z0 ? (z0.sporeni||0) : null;
  const extras   = z0 ? (() => { try { return JSON.parse(z0.extras||"[]"); } catch { return []; } })() : [];
  const extrasSum = extras.reduce((s,e)=>s+(e.castka||0),0);
  const celkem   = hotovost !== null ? hotovost + banky : null;  // jen hotovost + banky
  const celkemVse = hotovost !== null ? hotovost + banky + akcie + sporeni + extrasSum : null;
  const rozdil   = celkem !== null ? celkem - teoreticky : null;

  const zm = (klic) => {
    if (!z0 || !z1) return null;
    const ex0 = (() => { try { return JSON.parse(z0.extras||"[]"); } catch { return []; } })().reduce((s,e)=>s+(e.castka||0),0);
    const ex1 = (() => { try { return JSON.parse(z1.extras||"[]"); } catch { return []; } })().reduce((s,e)=>s+(e.castka||0),0);
    if (klic==="banky")  return PW_BANKY.reduce((s,b)=>s+(z0[b.key]||0)-(z1[b.key]||0),0);
    if (klic==="akcie")  return PW_BROKERI.reduce((s,b)=>s+(z0[b.key]||0)-(z1[b.key]||0),0);
    if (klic==="akcie_sporeni") return (PW_BROKERI.reduce((s,b)=>s+(z0[b.key]||0),0)+(z0.sporeni||0))
                                      -(PW_BROKERI.reduce((s,b)=>s+(z1[b.key]||0),0)+(z1.sporeni||0));
    if (klic==="celkem") return ((z0.hotovost||0)+PW_BANKY.reduce((s,b)=>s+(z0[b.key]||0),0))
                               -((z1.hotovost||0)+PW_BANKY.reduce((s,b)=>s+(z1[b.key]||0),0));
    return (z0[klic]||0)-(z1[klic]||0);
  };

  const zmHtml = (v) => {
    if (v===null) return "";
    const c = v>=0?"#16a34a":"#dc2626";
    return `<div style="font-size:.75rem;font-weight:600;color:${c};margin-top:.2rem">${v>=0?"+":""}${czInt(v)} Kč</div>`;
  };

  const boxik = (ikona,nazev,hodnota,zmena,bg,border,tc,sub) => `
    <div style="background:${bg};border:1.5px solid ${border};border-radius:10px;padding:.9rem 1rem">
      <div style="font-size:.73rem;color:${tc};font-weight:600;opacity:.7;margin-bottom:.15rem">${ikona} ${nazev}</div>
      <div style="font-size:1.45rem;font-weight:700;color:${tc}">${hodnota!==null?czInt(hodnota)+" Kč":"—"}</div>
      ${sub?`<div style="font-size:.68rem;color:${tc};opacity:.6;margin-top:.1rem">${sub}</div>`:""}
      ${zmHtml(zmena)}
    </div>`;

  // Speciální boxík Akcie / Spoření
  const boxikAkcieSporeni = () => {
    const tc = "#166534";
    const akcieSporeniCelkem = akcie !== null ? akcie + sporeni : null;
    return `<div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:.9rem 1rem">
      <div style="font-size:.73rem;color:${tc};font-weight:600;opacity:.7;margin-bottom:.4rem">📈 Akcie / Spoření</div>
      <div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:.2rem">
        <span style="color:${tc};opacity:.8">Akcie</span>
        <span style="font-weight:600;color:${tc}">${akcie!==null?czInt(akcie)+" Kč":"—"}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:.4rem;padding-bottom:.4rem;border-bottom:1px solid #86efac">
        <span style="color:${tc};opacity:.8">Spoření</span>
        <span style="font-weight:600;color:${tc}">${sporeni!==null?czInt(sporeni)+" Kč":"—"}</span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:.75rem;color:${tc};opacity:.7">Celkem</span>
        <span style="font-size:1.2rem;font-weight:700;color:${tc}">${akcieSporeniCelkem!==null?czInt(akcieSporeniCelkem)+" Kč":"—"}</span>
      </div>
      ${zmHtml(zm("akcie_sporeni"))}
    </div>`;
  };

  const datD = z0?czDate(z0.datum):"žádný záznam";

  // Levá strana — boxíky, pravá strana — zadávací panel
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 340px;gap:1.25rem;align-items:start;min-width:0">

      <!-- LEVÁ: boxíky + tabulka -->
      <div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.75rem;margin-bottom:1.25rem">
          ${boxik("💵","Hotovost",hotovost,zm("hotovost"),"#fefce8","#fcd34d","#92400e",datD)}
          ${boxik("🏦","Banky celkem",banky,zm("banky"),"#eff6ff","#93c5fd","#1e40af","")}          ${boxikAkcieSporeni()}
          ${boxik("💰","Celkem (hotovost + banky)",celkem,zm("celkem"),"#faf5ff","#c084fc","#7e22ce","")}
          ${boxik("🧮","Teoretický stav",teoreticky,null,"#f9fafb","var(--border)","var(--txt)","z Reportů od "+data.od_data)}
          ${boxik("⚖️","Rozdíl",rozdil,null,rozdil===null?"#f9fafb":rozdil>=0?"#f0fdf4":"#fee2e2",rozdil===null?"var(--border)":rozdil>=0?"#86efac":"#fca5a5",rozdil===null?"var(--txt)":rozdil>=0?"#166534":"#991b1b","hotovost+banky − teoretický")}
        </div>

        <div id="dluhyRozbalenoPanel" style="display:none;margin-bottom:1rem">
          <div class="card">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
              <div class="card-title" style="margin:0">💸 Náklady</div>
              <button class="btn btn-primary btn-sm" onclick="openNovaDluhOsoba()">+ Nová osoba</button>
            </div>
            <div id="dluhyObs2"></div>
          </div>
        </div>

        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.75rem">
            <div class="card-title" style="margin:0">Historie záznamů</div>
          </div>
          ${zaznamy.length ? `<div><table style="width:100%;font-size:.83rem">
            <thead><tr style="font-size:.75rem;color:var(--txt2)">
              <th>Datum</th>
              <th style="text-align:right">💵 Hotovost</th>
              <th style="text-align:right">🏦 Banky</th>
              <th style="text-align:right">📈 Akcie</th>
              <th style="text-align:right">Spoření</th>
              <th style="text-align:right">Ostatní</th>
              <th style="text-align:right;font-weight:700">Celkem</th>
              <th></th>
            </tr></thead>
            <tbody>
              ${zaznamy.map((z,idx)=>{
                const prev = zaznamy[idx+1]||null;
                const ex = (()=>{try{return JSON.parse(z.extras||"[]");}catch{return [];}})().reduce((s,e)=>s+(e.castka||0),0);
                const zB = PW_BANKY.reduce((s,b)=>s+(z[b.key]||0),0);
                const zA = PW_BROKERI.reduce((s,b)=>s+(z[b.key]||0),0);
                const zC = (z.hotovost||0)+zB+zA+(z.sporeni||0)+ex;
                const prevEx = prev?(()=>{try{return JSON.parse(prev.extras||"[]");}catch{return [];}})().reduce((s,e)=>s+(e.castka||0),0):0;
                const prevC = prev?(prev.hotovost||0)+PW_BANKY.reduce((s,b)=>s+(prev[b.key]||0),0)+PW_BROKERI.reduce((s,b)=>s+(prev[b.key]||0),0)+(prev.sporeni||0)+prevEx:null;
                const diff = prevC!==null?zC-prevC:null;
                const dc = diff===null?"":`color:${diff>=0?"#16a34a":"#dc2626"}`;
                return `<tr>
                  <td style="white-space:nowrap"><strong>${czDate(z.datum)}</strong>${diff!==null?`<br><small style="${dc}">${diff>=0?"+":""}${czInt(diff)}</small>`:""}
                  </td>
                  <td style="text-align:right">${czInt(z.hotovost||0)}</td>
                  <td style="text-align:right">${czInt(zB)}</td>
                  <td style="text-align:right">${czInt(zA)}</td>
                  <td style="text-align:right">${czInt(z.sporeni||0)}</td>
                  <td style="text-align:right;color:var(--txt2)">${ex>0?czInt(ex):"—"}</td>
                  <td style="text-align:right;font-weight:700">${czInt(zC)}</td>
                  <td style="white-space:nowrap">
                    <button class="btn btn-secondary btn-sm" onclick="editZaznamPenezenka(${z.id})">✏️</button>
                    <button class="btn btn-danger btn-sm" onclick="smazatZaznamPenezenka(${z.id})">🗑</button>
                  </td>
                </tr>`;
              }).join("")}
            </tbody>
          </table></div>`
          : `<div style="color:var(--txt2);padding:1rem;text-align:center">Žádné záznamy</div>`}
        </div>
      </div>

      <!-- PRAVÁ: zadávací panel -->
      <div id="pwPanel" style="display:flex;flex-direction:column;gap:.65rem"></div>
    </div>`;

  // Sestavit pravý panel
  _pwRenderPanel();
}

function _pwSekce(id, ikona, nazev, obsah, otevrena=false) {
  return `
    <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:.7rem 1rem;cursor:pointer;background:var(--bg2)"
           onclick="_pwToggle('${id}')">
        <span style="font-weight:600;font-size:.9rem">${ikona} ${nazev}</span>
        <span id="pwArr_${id}" style="transition:transform .2s;display:inline-block;font-size:.8rem">${otevrena?"▼":"▶"}</span>
      </div>
      <div id="pwSek_${id}" style="display:${otevrena?"block":"none"};padding:.75rem 1rem;background:var(--card-bg,#fff)">
        ${obsah}
      </div>
    </div>`;
}

function _pwToggle(id) {
  const el = document.getElementById("pwSek_"+id);
  const arr = document.getElementById("pwArr_"+id);
  const open = el.style.display!=="none";
  el.style.display = open?"none":"block";
  arr.textContent = open?"▶":"▼";
  if (id === "dluhy") {
    const panel = document.getElementById("dluhyRozbalenoPanel");
    if (panel) panel.style.display = open ? "none" : "block";
    if (!open) loadDluhy();
  }
}

function _pwRenderPanel() {
  const el = document.getElementById("pwPanel");
  if (!el) return;

  const _d = new Date();
  const dnes = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;

  // Sekce 1: Hotovost — kalkulačka
  const kalkulacka = PW_NOMINALY.map(n=>`
    <div style="display:grid;grid-template-columns:70px 1fr 80px;gap:.4rem;align-items:center;margin-bottom:.3rem">
      <div style="font-size:.85rem;font-weight:600;text-align:right">${czInt(n)} Kč</div>
      <input type="number" min="0" id="pw_nom_${n}" class="form-control" placeholder="0" style="font-size:.85rem"
        oninput="_pwKalcUpdate()">
      <div id="pw_nom_val_${n}" style="font-size:.82rem;color:var(--txt2);text-align:right">= 0</div>
    </div>`).join("")+`
    <div style="border-top:2px solid var(--border);margin-top:.5rem;padding-top:.5rem;display:flex;justify-content:space-between;align-items:center">
      <span style="font-weight:600">Celkem hotovost:</span>
      <span id="pwKalcCelkem" style="font-size:1.1rem;font-weight:700;color:#92400e">0 Kč</span>
    </div>`;

  // Sekce 2: Banky
  const bankyForm = PW_BANKY.map(b=>`
    <div class="form-group" style="margin-bottom:.4rem">
      <label style="font-size:.78rem;color:var(--txt2)">${b.label}</label>
      <input type="number" id="pw_${b.key}" class="form-control" placeholder="0" style="font-size:.85rem" oninput="_pwSouctUpdate()">
    </div>`).join("")+`
    <div style="border-top:2px solid var(--border);margin-top:.5rem;padding-top:.5rem;display:flex;justify-content:space-between">
      <span style="font-weight:600">Celkem banky:</span>
      <span id="pwBankyCelkem" style="font-weight:700;color:#1e40af">0 Kč</span>
    </div>`;

  // Sekce 3: Akcie — brokeři + EUR kurz
  const akcieFrm = `
    <div id="pwEurKurzInfo" style="font-size:.75rem;color:var(--txt2);margin-bottom:.5rem">⏳ Načítám kurz EUR/CZK...</div>
    ${PW_BROKERI.map(b=>`
    <div class="form-group" style="margin-bottom:.4rem">
      <label style="font-size:.78rem;color:var(--txt2)">${b.label}${b.eur?' <span style="color:#2563eb">(EUR)</span>':''}</label>
      <div style="display:flex;gap:.4rem;align-items:center">
        <input type="number" id="pw_${b.key}" class="form-control" placeholder="0" style="font-size:.85rem" oninput="_pwSouctUpdate()">
        ${b.eur?`<span id="pw_eur_czk" style="font-size:.75rem;color:var(--txt2);white-space:nowrap">= 0 Kč</span>`:""}
      </div>
    </div>`).join("")}
    <div style="border-top:2px solid var(--border);margin-top:.5rem;padding-top:.5rem;display:flex;justify-content:space-between">
      <span style="font-weight:600">Celkem akcie:</span>
      <span id="pwAkcieCelkem" style="font-weight:700;color:#166534">0 Kč</span>
    </div>`;

  // Sekce 4: Shrnutí + uložit
  const shrnuti = `
    <div style="margin-bottom:.5rem">
      <label style="font-size:.78rem;color:var(--txt2)">📅 Datum</label>
      <input type="date" id="pwDatum" class="form-control" value="${dnes}" style="font-size:.85rem;max-width:180px">
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.4rem;margin-bottom:.5rem">
      <div>
        <div style="font-size:.75rem;color:var(--txt2)">💵 Hotovost</div>
        <div id="pwSumHotovost" style="font-weight:600">0 Kč</div>
      </div>
      <div>
        <div style="font-size:.75rem;color:var(--txt2)">🏦 Banky</div>
        <div id="pwSumBanky" style="font-weight:600">0 Kč</div>
      </div>
      <div>
        <div style="font-size:.75rem;color:var(--txt2)">📈 Akcie</div>
        <div id="pwSumAkcie" style="font-weight:600">0 Kč</div>
      </div>
      <div>
        <div style="font-size:.75rem;color:var(--txt2)">💰 Spoření</div>
        <input type="number" id="pwSporeni" class="form-control" placeholder="0" style="font-size:.85rem" oninput="_pwSouctUpdate()">
      </div>
    </div>
    <div id="pwExtrasWrap" style="margin-bottom:.5rem"></div>
    <button class="btn btn-secondary btn-sm" onclick="_pwPridatExtra()" style="margin-bottom:.75rem;width:100%">+ Přidat položku</button>
    <div style="border-top:2px solid var(--border);padding-top:.6rem;display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem">
      <span style="font-weight:700">Celkem vše:</span>
      <span id="pwSumCelkem" style="font-size:1.2rem;font-weight:700;color:#7e22ce">0 Kč</span>
    </div>
    <div class="form-group">
      <label style="font-size:.78rem;color:var(--txt2)">Poznámka</label>
      <input id="pwPoznamka" class="form-control" placeholder="Volitelná poznámka" style="font-size:.85rem">
    </div>
    <button class="btn btn-primary" style="width:100%;margin-top:.75rem" onclick="ulozitZaznamPenezenka()">💾 Uložit záznam</button>`;

  el.innerHTML =
    _pwSekce("hotovost","💵","Hotovost — kalkulačka", kalkulacka) +
    _pwSekce("banky","🏦","Bankovní účty", bankyForm) +
    _pwSekce("akcie","📈","Akcie & brokeři", akcieFrm) +
    _pwSekce("shrnuti","💰","Shrnutí & Uložit", shrnuti, true) +
    _pwSekce("dluhy","💸","Náklady", `<div style="color:var(--txt2);font-size:.85rem">Rozbaleno vlevo ↙</div>`);

  // Načíst EUR kurz
  _pwNacistKurz().then(kurz => {
    const el2 = document.getElementById("pwEurKurzInfo");
    if (el2) el2.textContent = `Kurz EUR/CZK: ${kurz.toFixed(2)} Kč`;
    _pwSouctUpdate();
  });
}

function _pwKalcUpdate() {
  let celkem = 0;
  PW_NOMINALY.forEach(n => {
    const ks = parseInt(document.getElementById(`pw_nom_${n}`)?.value || 0) || 0;
    const val = ks * n;
    celkem += val;
    const el = document.getElementById(`pw_nom_val_${n}`);
    if (el) el.textContent = val > 0 ? `= ${czInt(val)}` : "= 0";
  });
  const el = document.getElementById("pwKalcCelkem");
  if (el) el.textContent = czInt(celkem) + " Kč";
  // Propsat do shrnutí
  const sh = document.getElementById("pwSumHotovost");
  if (sh) sh.textContent = czInt(celkem) + " Kč";
  _pwSouctUpdate();
}

function _pwSouctUpdate() {
  // Hotovost z kalkulačky
  let hotovost = 0;
  PW_NOMINALY.forEach(n => {
    hotovost += (parseInt(document.getElementById(`pw_nom_${n}`)?.value||0)||0) * n;
  });

  // Banky
  let banky = 0;
  PW_BANKY.forEach(b => { banky += parseFloat(document.getElementById(`pw_${b.key}`)?.value||0)||0; });

  // Akcie (EUR přepočet)
  let akcie = 0;
  const kurz = _pwEurKurz || 25;
  PW_BROKERI.forEach(b => {
    const val = parseFloat(document.getElementById(`pw_${b.key}`)?.value||0)||0;
    const czk = b.eur ? Math.round(val * kurz) : val;
    akcie += czk;
    if (b.eur) {
      const eurEl = document.getElementById("pw_eur_czk");
      if (eurEl) eurEl.textContent = `= ${czInt(czk)} Kč`;
    }
  });

  // Spoření
  const sporeni = parseFloat(document.getElementById("pwSporeni")?.value||0)||0;

  // Extras
  let extras = 0;
  document.querySelectorAll(".pw-extra-castka").forEach(inp => { extras += parseFloat(inp.value||0)||0; });

  const celkem = hotovost + banky + akcie + sporeni + extras;

  const _s = (id,v) => { const e=document.getElementById(id); if(e) e.textContent=czInt(v)+" Kč"; };
  _s("pwSumHotovost", hotovost);
  _s("pwSumBanky", banky);
  _s("pwSumAkcie", akcie);
  _s("pwSumCelkem", celkem);
  _s("pwBankyCelkem", banky);
  _s("pwAkcieCelkem", akcie);
  _s("pwKalcCelkem", hotovost);
}

let _pwExtraIdx = 0;
function _pwPridatExtra() {
  const wrap = document.getElementById("pwExtrasWrap");
  if (!wrap) return;
  const idx = ++_pwExtraIdx;
  const div = document.createElement("div");
  div.style.cssText = "display:grid;grid-template-columns:1fr 100px auto;gap:.4rem;align-items:center;margin-bottom:.4rem";
  div.innerHTML = `
    <input class="form-control pw-extra-nazev" placeholder="Popis položky" style="font-size:.85rem">
    <input type="number" class="form-control pw-extra-castka" placeholder="Kč" style="font-size:.85rem" oninput="_pwSouctUpdate()">
    <button onclick="this.closest('div').remove();_pwSouctUpdate()" style="background:none;border:none;cursor:pointer;color:#dc2626;font-size:1rem">✕</button>`;
  wrap.appendChild(div);
}

async function ulozitZaznamPenezenka() {
  const datum = document.getElementById("pwDatum")?.value;
  if (!datum) { toast("Vyplň datum", true); return; }

  const kurz = _pwEurKurz || 25;
  const payload = { datum, poznamka: document.getElementById("pwPoznamka")?.value||"" };

  // Hotovost z kalkulačky
  let hotovost = 0;
  PW_NOMINALY.forEach(n => { hotovost += (parseInt(document.getElementById(`pw_nom_${n}`)?.value||0)||0)*n; });
  payload.hotovost = hotovost;

  // Banky
  PW_BANKY.forEach(b => { payload[b.key] = parseFloat(document.getElementById(`pw_${b.key}`)?.value||0)||0; });

  // Akcie (XTB EUR → přepočteno na CZK)
  PW_BROKERI.forEach(b => {
    const val = parseFloat(document.getElementById(`pw_${b.key}`)?.value||0)||0;
    payload[b.key] = b.eur ? Math.round(val * kurz) : val;
  });

  // Spoření
  payload.sporeni = parseFloat(document.getElementById("pwSporeni")?.value||0)||0;

  // Extras
  const extras = [];
  document.querySelectorAll("#pwExtrasWrap > div").forEach(div => {
    const nazev = div.querySelector(".pw-extra-nazev")?.value?.trim();
    const castka = parseFloat(div.querySelector(".pw-extra-castka")?.value||0)||0;
    if (nazev && castka > 0) extras.push({nazev, castka});
  });
  payload.extras = extras;

  await api("/api/penezenka", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
  toast("Záznam uložen ✓");
  loadPenezenka();
}

async function editZaznamPenezenka(id) {
  // Načíst data záznamu
  let data;
  try { data = await api("/api/penezenka"); } catch { return; }
  const z = data.zaznamy.find(x => x.id === id);
  if (!z) { toast("Záznam nenalezen", true); return; }

  // Předvyplnit formulář
  const extras = (() => { try { return JSON.parse(z.extras||"[]"); } catch { return []; } })();

  // Otevřít modal s formulářem
  openModal(`Upravit záznam — ${czDate(z.datum)}`, `
    <div style="margin-bottom:.5rem">
      <label class="form-label">Datum</label>
      <input type="date" id="pwEditDatum" class="form-control" value="${z.datum}" style="max-width:200px">
    </div>
    <hr style="margin:.5rem 0;border-color:var(--border)">
    <div style="font-size:.82rem;font-weight:600;color:var(--txt2);margin-bottom:.4rem">💵 Hotovost</div>
    <input type="number" id="pwEditHotovost" class="form-control" value="${z.hotovost||0}" style="margin-bottom:.75rem">
    <div style="font-size:.82rem;font-weight:600;color:var(--txt2);margin-bottom:.4rem">🏦 Bankovní účty</div>
    <div class="grid-2" style="gap:.4rem;margin-bottom:.75rem">
      ${PW_BANKY.map(b=>`<div>
        <label style="font-size:.75rem;color:var(--txt2)">${b.label}</label>
        <input type="number" id="pwEdit_${b.key}" class="form-control" value="${z[b.key]||0}" style="font-size:.85rem">
      </div>`).join("")}
    </div>
    <div style="font-size:.82rem;font-weight:600;color:var(--txt2);margin-bottom:.4rem">📈 Akcie & brokeři</div>
    <div class="grid-2" style="gap:.4rem;margin-bottom:.75rem">
      ${PW_BROKERI.map(b=>`<div>
        <label style="font-size:.75rem;color:var(--txt2)">${b.label}</label>
        <input type="number" id="pwEdit_${b.key}" class="form-control" value="${z[b.key]||0}" style="font-size:.85rem">
      </div>`).join("")}
    </div>
    <div style="font-size:.82rem;font-weight:600;color:var(--txt2);margin-bottom:.4rem">💰 Spoření</div>
    <input type="number" id="pwEditSporeni" class="form-control" value="${z.sporeni||0}" style="margin-bottom:.75rem">
    ${extras.length ? `
    <div style="font-size:.82rem;font-weight:600;color:var(--txt2);margin-bottom:.4rem">Ostatní položky</div>
    <div id="pwEditExtras">
      ${extras.map(e=>`<div style="display:grid;grid-template-columns:1fr 100px auto;gap:.4rem;margin-bottom:.3rem">
        <input class="form-control pw-edit-extra-nazev" value="${escHtml(e.nazev)}" style="font-size:.85rem">
        <input type="number" class="form-control pw-edit-extra-castka" value="${e.castka}" style="font-size:.85rem">
        <button onclick="this.closest('div').remove()" style="background:none;border:none;cursor:pointer;color:#dc2626">✕</button>
      </div>`).join("")}
    </div>` : '<div id="pwEditExtras"></div>'}
    <button class="btn btn-secondary btn-sm" onclick="_pwEditPridatExtra()" style="margin-bottom:.75rem">+ Přidat položku</button>
    <div class="form-group">
      <label class="form-label">Poznámka</label>
      <input id="pwEditPoznamka" class="form-control" value="${escHtml(z.poznamka||'')}">
    </div>
    <div style="text-align:right;margin-top:1rem">
      <button class="btn btn-primary" onclick="ulozitEditPenezenka(${id})">💾 Uložit změny</button>
    </div>`);
}

function _pwEditPridatExtra() {
  const wrap = document.getElementById("pwEditExtras");
  if (!wrap) return;
  const div = document.createElement("div");
  div.style.cssText = "display:grid;grid-template-columns:1fr 100px auto;gap:.4rem;margin-bottom:.3rem";
  div.innerHTML = `
    <input class="form-control pw-edit-extra-nazev" placeholder="Popis" style="font-size:.85rem">
    <input type="number" class="form-control pw-edit-extra-castka" placeholder="Kč" style="font-size:.85rem">
    <button onclick="this.closest('div').remove()" style="background:none;border:none;cursor:pointer;color:#dc2626">✕</button>`;
  wrap.appendChild(div);
}

async function ulozitEditPenezenka(id) {
  const datum = document.getElementById("pwEditDatum")?.value;
  if (!datum) { toast("Vyplň datum", true); return; }
  const payload = {
    datum,
    hotovost: parseFloat(document.getElementById("pwEditHotovost")?.value||0)||0,
    sporeni:  parseFloat(document.getElementById("pwEditSporeni")?.value||0)||0,
    poznamka: document.getElementById("pwEditPoznamka")?.value||"",
  };
  PW_BANKY.forEach(b => { payload[b.key] = parseFloat(document.getElementById(`pwEdit_${b.key}`)?.value||0)||0; });
  PW_BROKERI.forEach(b => { payload[b.key] = parseFloat(document.getElementById(`pwEdit_${b.key}`)?.value||0)||0; });
  const extras = [];
  document.querySelectorAll("#pwEditExtras > div").forEach(div => {
    const nazev = div.querySelector(".pw-edit-extra-nazev")?.value?.trim();
    const castka = parseFloat(div.querySelector(".pw-edit-extra-castka")?.value||0)||0;
    if (nazev && castka > 0) extras.push({nazev, castka});
  });
  payload.extras = extras;
  await api(`/api/penezenka/${id}`, { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
  toast("Záznam upraven ✓");
  closeModal();
  loadPenezenka();
}

async function smazatZaznamPenezenka(id) {
  if (!confirm("Opravdu smazat tento záznam?")) return;
  await api(`/api/penezenka/${id}`, { method:"DELETE" });
  toast("Smazáno ✓");
  loadPenezenka();
}

// ═══════════════════════════════════════════════════════════════
//  DLUHY — půjčky kamarádům
// ═══════════════════════════════════════════════════════════════

function _dluhTogglePanel() {
  const panel = document.getElementById("dluhyPanel");
  const arr   = document.getElementById("dluhPanelArr");
  if (!panel) return;
  const open = panel.style.display !== "none";
  panel.style.display = open ? "none" : "block";
  if (arr) arr.textContent = open ? "▶" : "▼";
  if (!open) loadDluhy();
}

async function loadDluhy() {
  const el = document.getElementById("dluhyObs2") || document.getElementById("dluhyObs");
  if (!el) return;
  let data;
  try { data = await api("/api/dluhy"); } catch { return; }

  if (!data.length) {
    el.innerHTML = `<div style="color:var(--txt2);font-size:.88rem;padding:.5rem 0">Žádné záznamy — přidej první osobu tlačítkem výše.</div>`;
    return;
  }

  el.innerHTML = `<table style="width:100%;font-size:.88rem">
    <thead><tr style="font-size:.75rem;color:var(--txt2)">
      <th>Jméno</th>
      <th style="text-align:right">První půjčka</th>
      <th style="text-align:right">Celkový dluh</th>
      <th style="text-align:center">Stav</th>
      <th></th>
    </tr></thead>
    <tbody>
      ${data.map(o => {
        const splaceno = o.celkem <= 0;
        const stavColor = splaceno ? "#16a34a" : "#dc2626";
        return `<tr style="cursor:pointer;border-top:1px solid var(--border)" onclick="_dluhToggle(${o.id})">
          <td style="padding:.5rem .4rem;font-weight:600">
            <span id="dluhArr_${o.id}" style="font-size:.7rem;margin-right:.3rem">▶</span>
            ${escHtml(o.jmeno)}
          </td>
          <td style="text-align:right;color:var(--txt2);padding:.5rem .4rem">${o.prvni_pujcka ? czDate(o.prvni_pujcka) : "—"}</td>
          <td style="text-align:right;font-weight:700;color:${stavColor};padding:.5rem .4rem">${czInt(Math.abs(o.celkem))} Kč</td>
          <td style="text-align:center;padding:.5rem .4rem">
            ${splaceno ? `<span style="font-size:.75rem;font-weight:600;color:#16a34a">✓ Splaceno</span>` : ""}
          </td>
          <td style="padding:.5rem .4rem;white-space:nowrap" onclick="event.stopPropagation()">
            <button class="btn btn-primary btn-sm" onclick="openPridatTransakci(${o.id},'${escHtml(o.jmeno)}')">+ Splátka / půjčka</button>
            <button class="btn btn-danger btn-sm" onclick="smazatDluhOsobu(${o.id},'${escHtml(o.jmeno)}')">🗑</button>
          </td>
        </tr>
        <tr id="dluhDetail_${o.id}" style="display:none">
          <td colspan="5" style="padding:0 0 .5rem 1.5rem;background:var(--bg2)">
            ${_dluhHistorieHtml(o.transakce)}
          </td>
        </tr>`;
      }).join("")}
    </tbody>
  </table>`;
}

function _dluhHistorieHtml(transakce) {
  if (!transakce.length) return `<div style="color:var(--txt2);font-size:.82rem;padding:.5rem">Žádné transakce</div>`;
  let zustatek = 0;
  const radky = transakce.map(t => {
    zustatek += t.castka;
    const c = t.castka > 0 ? "#dc2626" : "#16a34a";
    const sign = t.castka > 0 ? "+" : "";
    return `<tr style="font-size:.82rem;border-top:1px solid var(--border)">
      <td style="padding:.3rem .4rem;color:var(--txt2)">${czDate(t.datum)}</td>
      <td style="padding:.3rem .4rem">${escHtml(t.poznamka||"—")}</td>
      <td style="padding:.3rem .4rem;text-align:right;font-weight:600;color:${c}">${sign}${czInt(t.castka)} Kč</td>
      <td style="padding:.3rem .4rem;text-align:right;color:var(--txt2)">${czInt(zustatek)} Kč</td>
      <td style="padding:.3rem .4rem">
        <button class="btn btn-danger btn-sm" onclick="smazatDluhTransakci(${t.id})" title="Smazat">🗑</button>
      </td>
    </tr>`;
  }).join("");
  return `<table style="width:100%;border-collapse:collapse">
    <thead><tr style="font-size:.72rem;color:var(--txt2)">
      <th style="padding:.3rem .4rem">Datum</th>
      <th style="padding:.3rem .4rem">Poznámka</th>
      <th style="text-align:right;padding:.3rem .4rem">Částka</th>
      <th style="text-align:right;padding:.3rem .4rem">Zůstatek</th>
      <th></th>
    </tr></thead>
    <tbody>${radky}</tbody>
  </table>`;
}

function _dluhToggle(id) {
  const det = document.getElementById(`dluhDetail_${id}`);
  const arr = document.getElementById(`dluhArr_${id}`);
  if (!det) return;
  const open = det.style.display !== "none";
  det.style.display = open ? "none" : "";
  if (arr) arr.textContent = open ? "▶" : "▼";
}

function openNovaDluhOsoba() {
  const dnes = (()=>{const _x=new Date();return `${_x.getFullYear()}-${String(_x.getMonth()+1).padStart(2,"0")}-${String(_x.getDate()).padStart(2,"0")}`;})();
  openModal("Nová osoba + první půjčka", `
    <div class="grid-2" style="gap:.75rem">
      <div class="form-group">
        <label class="form-label">Jméno *</label>
        <input id="dluhJmeno" class="form-control" placeholder="Jméno nebo přezdívka">
      </div>
      <div class="form-group">
        <label class="form-label">Datum půjčky *</label>
        <input type="date" id="dluhDatum" class="form-control" value="${dnes}">
      </div>
      <div class="form-group">
        <label class="form-label">Půjčená částka (Kč) *</label>
        <input type="number" id="dluhCastka" class="form-control" placeholder="0">
      </div>
      <div class="form-group">
        <label class="form-label">Poznámka</label>
        <input id="dluhPoznamka" class="form-control" placeholder="Na co, proč...">
      </div>
    </div>
    <div style="text-align:right;margin-top:1rem">
      <button class="btn btn-primary" onclick="ulozitNovuDluhOsobu()">💾 Uložit</button>
    </div>`);
  setTimeout(() => document.getElementById("dluhJmeno")?.focus(), 100);
}

async function ulozitNovuDluhOsobu() {
  const jmeno  = document.getElementById("dluhJmeno")?.value.trim();
  const datum  = document.getElementById("dluhDatum")?.value;
  const castka = parseFloat(document.getElementById("dluhCastka")?.value || 0);
  const pozn   = document.getElementById("dluhPoznamka")?.value || "";
  if (!jmeno || !datum || !castka) { toast("Vyplň jméno, datum a částku", true); return; }
  const res = await api("/api/dluhy/osoby", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({jmeno}) });
  await api("/api/dluhy/transakce", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({osoba_id: res.id, datum, castka: Math.abs(castka), poznamka: pozn}) });
  toast("Uloženo ✓");
  closeModal();
  loadDluhy();
}

function openPridatTransakci(osobaId, jmeno) {
  const dnes = (()=>{const _x=new Date();return `${_x.getFullYear()}-${String(_x.getMonth()+1).padStart(2,"0")}-${String(_x.getDate()).padStart(2,"0")}`;})();
  openModal(`${escHtml(jmeno)} — přidat záznam`, `
    <div class="grid-2" style="gap:.75rem">
      <div class="form-group">
        <label class="form-label">Typ</label>
        <select id="dluhTyp" class="form-control">
          <option value="pujcka">💸 Půjčuji (+ dluh)</option>
          <option value="splatka">✅ Splátka (− dluh)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Datum *</label>
        <input type="date" id="dluhTDatum" class="form-control" value="${dnes}">
      </div>
      <div class="form-group">
        <label class="form-label">Částka (Kč) *</label>
        <input type="number" id="dluhTCastka" class="form-control" placeholder="0">
      </div>
      <div class="form-group">
        <label class="form-label">Poznámka</label>
        <input id="dluhTPoznamka" class="form-control" placeholder="Volitelná poznámka">
      </div>
    </div>
    <div style="text-align:right;margin-top:1rem">
      <button class="btn btn-primary" onclick="ulozitTransakciDluhu(${osobaId})">💾 Uložit</button>
    </div>`);
  setTimeout(() => document.getElementById("dluhTCastka")?.focus(), 100);
}

async function ulozitTransakciDluhu(osobaId) {
  const typ    = document.getElementById("dluhTyp")?.value;
  const datum  = document.getElementById("dluhTDatum")?.value;
  const castka = parseFloat(document.getElementById("dluhTCastka")?.value || 0);
  const pozn   = document.getElementById("dluhTPoznamka")?.value || "";
  if (!datum || !castka) { toast("Vyplň datum a částku", true); return; }
  const finalCastka = typ === "splatka" ? -Math.abs(castka) : Math.abs(castka);
  await api("/api/dluhy/transakce", { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({osoba_id: osobaId, datum, castka: finalCastka, poznamka: pozn}) });
  toast("Uloženo ✓");
  closeModal();
  loadDluhy();
}

async function smazatDluhTransakci(tid) {
  if (!confirm("Opravdu smazat tento záznam?")) return;
  await api(`/api/dluhy/transakce/${tid}`, { method:"DELETE" });
  toast("Smazáno ✓");
  loadDluhy();
}

async function smazatDluhOsobu(oid, jmeno) {
  if (!confirm(`Smazat ${jmeno} a všechny záznamy?`)) return;
  await api(`/api/dluhy/osoby/${oid}`, { method:"DELETE" });
  toast("Smazáno ✓");
  loadDluhy();
}

// ═══════════════════════════════════════════════════════════════
//  RADEK — rozcestník
// ═══════════════════════════════════════════════════════════════
function renderRadek() {
  document.getElementById("mainContent").innerHTML = `
    <h2>👤 Radek</h2>
    <div class="radek-grid">
      <div class="radek-box" onclick="navigateTo('soukrome_vydaje')">
        <div class="radek-box-icon">🏠</div>
        Soukromé výdaje
      </div>
      <div class="radek-box" onclick="navigateTo('penezenka')">
        <div class="radek-box-icon">💵</div>
        Peněženka
      </div>
      <div class="radek-box" onclick="navigateTo('dokumenty')">
        <div class="radek-box-icon">🗂️</div>
        Dokumenty
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
//  DOKUMENTY
// ═══════════════════════════════════════════════════════════════
let _dokData = [];

async function renderDokumenty() {
  document.getElementById("mainContent").innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.8rem">
      <h2>🗂️ Dokumenty</h2>
      <button class="btn btn-primary" onclick="dokModalNovy()">＋ Přidat dokument</button>
    </div>
    <div id="dok-list" style="margin-top:1rem">Načítám…</div>

    <!-- Modal nový/edit -->
    <div id="dok-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:900;align-items:center;justify-content:center">
      <div style="background:var(--card-bg);border-radius:14px;padding:1.8rem 2rem;width:min(480px,95vw);position:relative">
        <h3 id="dok-modal-title" style="margin-bottom:1.2rem">Nový dokument</h3>
        <input type="hidden" id="dok-id">
        <div style="display:flex;flex-direction:column;gap:.8rem">
          <label>Datum
            <input type="date" id="dok-datum" class="form-control" style="margin-top:.3rem">
          </label>
          <label>Název
            <input type="text" id="dok-nazev" class="form-control" placeholder="např. Pojistná smlouva auto" style="margin-top:.3rem">
          </label>
          <label>Místo
            <select id="dok-misto" class="form-control" style="margin-top:.3rem">
              <option value="Praha">Praha</option>
              <option value="Třebovle">Třebovle</option>
              <option value="Oboje">Oboje</option>
            </select>
          </label>
          <label id="dok-soubor-wrap">Soubor (PDF nebo JPG)
            <input type="file" id="dok-soubor" accept=".pdf,.jpg,.jpeg,.png" style="margin-top:.3rem">
          </label>
        </div>
        <div style="display:flex;gap:.7rem;justify-content:flex-end;margin-top:1.4rem">
          <button class="btn btn-secondary" onclick="dokModalZavrit()">Zrušit</button>
          <button class="btn btn-primary" onclick="dokUlozit()">Uložit</button>
        </div>
      </div>
    </div>
  `;
  // Nastav dnešní datum
  document.getElementById("dok-datum").value = new Date().toISOString().slice(0,10);
  await dokNacist();
}

async function dokNacist() {
  const res = await fetch("/api/dokumenty");
  _dokData = await res.json();
  dokRenderList();
}

function dokRenderList() {
  const el = document.getElementById("dok-list");
  if (!el) return;
  if (!_dokData.length) {
    el.innerHTML = `<p style="color:var(--text-muted)">Žádné dokumenty.</p>`;
    return;
  }
  el.innerHTML = `<div class="dokumenty-grid">${_dokData.map(d => `
    <div class="dok-card">
      <div class="dok-card-title">${d.nazev}</div>
      <div class="dok-card-meta">${d.datum} &nbsp;·&nbsp; ${d.misto}</div>
      <div class="dok-card-actions">
        ${d.soubor_cesta ? `<button class="btn btn-sm btn-secondary" onclick="dokNahled(${d.id})">👁 Náhled</button>` : ''}
        <button class="btn btn-sm btn-secondary" onclick="dokEditModal(${d.id})">✏️ Upravit</button>
        <button class="btn btn-sm btn-danger" onclick="dokSmazat(${d.id})">🗑</button>
      </div>
    </div>
  `).join("")}</div>`;
}

function dokModalNovy() {
  document.getElementById("dok-id").value = "";
  document.getElementById("dok-modal-title").textContent = "Nový dokument";
  document.getElementById("dok-nazev").value = "";
  document.getElementById("dok-datum").value = new Date().toISOString().slice(0,10);
  document.getElementById("dok-misto").value = "Praha";
  document.getElementById("dok-soubor-wrap").style.display = "";
  document.getElementById("dok-modal").style.display = "flex";
}

function dokEditModal(id) {
  const d = _dokData.find(x => x.id === id);
  if (!d) return;
  document.getElementById("dok-id").value = id;
  document.getElementById("dok-modal-title").textContent = "Upravit dokument";
  document.getElementById("dok-nazev").value = d.nazev;
  document.getElementById("dok-datum").value = d.datum;
  document.getElementById("dok-misto").value = d.misto || "Praha";
  document.getElementById("dok-soubor-wrap").style.display = "none";
  document.getElementById("dok-modal").style.display = "flex";
}

function dokModalZavrit() {
  document.getElementById("dok-modal").style.display = "none";
}

async function dokUlozit() {
  const id    = document.getElementById("dok-id").value;
  const nazev = document.getElementById("dok-nazev").value.trim();
  const datum = document.getElementById("dok-datum").value;
  const misto = document.getElementById("dok-misto").value;
  if (!nazev) { alert("Zadej název dokumentu"); return; }

  if (id) {
    // Úprava
    await fetch(`/api/dokumenty/${id}`, {
      method: "PUT",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({datum, nazev, misto})
    });
  } else {
    // Nový
    const fd = new FormData();
    fd.append("datum", datum);
    fd.append("nazev", nazev);
    fd.append("misto", misto);
    const soubor = document.getElementById("dok-soubor").files[0];
    if (soubor) fd.append("soubor", soubor);
    await fetch("/api/dokumenty", {method:"POST", body:fd});
  }
  dokModalZavrit();
  await dokNacist();
}

async function dokSmazat(id) {
  if (!confirm("Smazat dokument?")) return;
  await fetch(`/api/dokumenty/${id}`, {method:"DELETE"});
  await dokNacist();
}

async function dokNahled(id) {
  const res = await fetch(`/api/dokumenty/${id}/url`);
  const data = await res.json();
  if (data.url) window.open(data.url, "_blank");
  else alert("Soubor není dostupný");
}

