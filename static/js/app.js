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
    "statistiky": "statistiky",
    "nastaveni":  "nastaveni",
    "banky":      "bankovni_vypisy",
    "vydaje":          "vydaje_zobrazit",
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
  App.currentPage = page;
  document.querySelectorAll(".nav-item").forEach(a => {
    a.classList.toggle("active", a.dataset.page === page);
  });
  const pages = {
    dashboard:  renderDashboard,
    faktury:    renderFaktury,
    nahrat:     renderNahrat,
    rucni:      renderRucni,
    polozky:    renderPolozky,
    vyplaty:    renderVyplaty,
    reporty:    renderReporty,
    statistiky: renderStatistiky,
    nastaveni:  renderNastaveni,
    banky:      renderBanky,
    vydaje:        renderVydaje,
    vystavene:     renderVystavene,
  };
  if (pages[page]) pages[page]();
}

// ═══════════════════════════════════════════════════════════════
//  Téma
// ═══════════════════════════════════════════════════════════════
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
  document.getElementById("todayDate").textContent =
    new Date().toLocaleDateString("cs-CZ", { day:"2-digit", month:"long", year:"numeric" });
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
  const d = new Date(s);
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
  const m = { zaplaceno: "Zaplaceno", ceka: "Čeká", po_splatnosti: "Po splatnosti" };
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
  const firma = document.getElementById("globalFirmaFilter")?.value || "";
  const qs = firma ? `?firma=${firma}` : "";
  document.getElementById("mainContent").innerHTML = `<div class="loading-center"><span class="spinner"></span></div>`;

  let data;
  try { data = await api(`/api/dashboard${qs}`); } catch { return; }

  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Dashboard</h1>
    </div>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-label">Výdaje tento měsíc</div>
        <div class="stat-value">${czMoney(data.vydaje_mesic)}</div>
        <div class="stat-sub">${data.pocet_mesic} faktur</div>
      </div>
      <div class="stat-card ${data.pocet_po_splatnosti > 0 ? 'danger' : ''}">
        <div class="stat-label">Po splatnosti</div>
        <div class="stat-value">${data.pocet_po_splatnosti}</div>
        <div class="stat-sub">${czMoney(data.castka_po_splatnosti)}</div>
      </div>
    </div>
    <div class="grid-2" style="gap:1rem; margin-bottom:1rem;">
      <div class="card">
        <div class="card-title">Výdaje po měsících</div>
        <div class="chart-wrap"><canvas id="barChart"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">Poslední faktury</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Dodavatel</th><th>Datum</th><th>Částka</th><th>Stav</th></tr></thead>
            <tbody>
              ${data.posledni_faktury.map(f => `
                <tr data-id="${f.id}" class="faktura-row">
                  <td>${f.dodavatel}</td>
                  <td>${czDate(f.datum_vystaveni)}</td>
                  <td><strong>${czMoney(f.celkem_s_dph)}</strong></td>
                  <td>${stavBadge(f.stav)}</td>
                </tr>`).join("") || "<tr><td colspan='4' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné faktury</td></tr>"}
            </tbody>
          </table>
        </div>
        <div style="margin-top:.8rem;text-align:right">
          <button class="btn btn-secondary btn-sm" onclick="navigateTo('faktury')">Všechny faktury →</button>
        </div>
      </div>
    </div>`;

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
            <tr class="faktura-row" data-id="${f.id}" style="${f.duplicita_id ? 'opacity:0.55' : ''}">
              <td><span class="badge badge-zaplaceno" style="background:var(--green-pale)">${f.firma_zkratka}</span></td>
              <td>${escHtml(f.dodavatel)}</td>
              <td>${escHtml(f.cislo_faktury||"–")}${f.duplicita_id ? " <small style='color:orange'>⚠️ dup #" + f.duplicita_id + "</small>" : ""}</td>
              <td>${czDate(f.datum_vystaveni)}</td>
              <td><strong>${czMoney(f.celkem_s_dph)}</strong></td>
              <td>${f.duplicita_id ? '<span class="badge" style="background:#0d6efd;color:#fff;cursor:pointer" onclick="event.stopPropagation();openFakturaDetail(' + f.duplicita_id + ')">🔗 Duplikát</span>' : stavBadge(f.stav)}</td>
              ${maPravo("faktury_smazat") ? `<td onclick="event.stopPropagation()"><button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border:none;padding:.2rem .5rem;border-radius:4px;cursor:pointer" onclick="smazatFakturu(${f.id})">🗑</button></td>` : ""}
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
      <button class="btn btn-danger btn-sm" onclick="deleteFaktura(${f.id})">🗑 Smazat</button>
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

async function deleteFaktura(id) {
  if (!confirm("Opravdu smazat tuto fakturu?")) return;
  await api(`/api/faktury/${id}`, { method: "DELETE" });
  toast("Faktura smazána");
  closeModal();
  loadFaktury();
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
    <div class="page-header"><h1 class="page-title">Nahrát fakturu (MAKRO)</h1></div>
    <div class="card" style="max-width:900px">
      <div class="form-group">
        <label class="form-label">Firma</label>
        <select id="nahratFirma" class="form-control" style="max-width:200px">
          ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
        </select>
      </div>

      <div style="display:flex;gap:.5rem;margin-bottom:1rem;border-bottom:2px solid var(--border);padding-bottom:0">
        <button id="tabPdf" class="tab-btn tab-active" onclick="switchTab('pdf')">📄 PDF soubor</button>
        <button id="tabText" class="tab-btn" onclick="switchTab('text')">📋 Vložit text</button>
        <button id="tabHromadne" class="tab-btn" onclick="switchTab('hromadne')">📦 Hromadné nahrání</button>
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
        <p style="color:var(--txt2);font-size:.9rem;margin-bottom:.7rem">
          Zkopírujte text faktury z PDF prohlížeče nebo e-mailu a vložte ho sem (Ctrl+V):
        </p>
        <textarea id="textInput" class="form-control" rows="10" style="font-family:monospace;font-size:.8rem"
          placeholder="Sem vložte zkopírovaný text faktury MAKRO (Ctrl+V)..."></textarea>
        <button class="btn btn-primary" style="margin-top:.7rem" onclick="zpracovatText()">🔍 Zpracovat text</button>
        <div id="textStatus" style="margin-top:.5rem;color:var(--txt2);font-size:.9rem"></div>
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
    </div>`;

  setupDropzone();
  setupDropzoneHromadne();
}

function switchTab(tab) {
  ['pdf','text','hromadne'].forEach(t => {
    document.getElementById('tabPanel' + t.charAt(0).toUpperCase() + t.slice(1)).style.display = t === tab ? '' : 'none';
    document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle('tab-active', t === tab);
  });
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
          row.innerHTML = `⚠️ ${file.name} – <span style="color:orange">duplikát faktury #${data.duplicita.id} (${data.duplicita.firma}, ${czDate(data.duplicita.datum)}, ${czMoney(data.duplicita.celkem)}) — uloženo jako duplikát</span>`;
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
      row.innerHTML = `✅ ${file.name} – uloženo (${(data.polozky||[]).length} položek, ${czMoney(data.celkem_s_dph)})`;
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
    statusDiv.innerHTML = `🚨 <strong>DUPLIKÁT uložen!</strong> Faktura č. <strong>${data.cislo_faktury}</strong> je duplikát faktury #${data.duplicita.id} (${data.duplicita.firma}, ${czDate(data.duplicita.datum)}, ${czMoney(data.duplicita.celkem)}). Uložena s označením duplikátu.`;
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
      div.innerHTML = `✅ <strong>Vše sedí!</strong> Součet ${czMoney(suma)} odpovídá faktuře (bez DPH: ${czMoney(ocr_bez)})`;
    } else {
      div.style.cssText += "background:#fef3c7;border:1px solid #fbbf24;color:#92400e";
      div.innerHTML = `⚠️ <strong>Zkontroluj!</strong> Součet položek: <strong>${czMoney(suma)}</strong> &nbsp;|&nbsp; Faktura bez DPH: <strong>${czMoney(ocr_bez)}</strong>
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
      k.innerHTML = `⚠️ <strong>Zkontroluj!</strong> Součet: <strong>${czMoney(t)}</strong> &nbsp;|&nbsp; Faktura bez DPH: <strong>${czMoney(ocr_bez)}</strong>`;
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
  // Skupiny vždy nahoře, pak položky bez skupiny
  const allRows = [...skupinyRows, ...bezSkupiny];

  const arrow = (c) => col === c ? (asc ? " ▲" : " ▼") : " ⇅";
  const th = (c, label) =>
    `<th style="cursor:pointer;user-select:none" onclick="sortPolozky('${c}')">${label}${arrow(c)}</th>`;

  const renderRow = (r, indent) => {
    if (r._skupina) {
      return `
        <tr class="zbozi-skupina" style="background:var(--green-pale);cursor:pointer" onclick="toggleSkupina('${escHtml(r.zbozi_nazev)}')">
          <td><strong>📦 ${escHtml(r.zbozi_nazev)}</strong> <small style="color:var(--txt2)">(${r._pocet_polozek} položek)</small></td>
          <td style="text-align:center">${r.pocet_nakupu}</td>
          <td>${Number(r.celkove_mnozstvi).toLocaleString("cs-CZ")}</td>
          <td>${r.jednotka}</td>
          <td>${czMoney(r.prumerna_cena)}</td>
          <td><strong>${czMoney(r.celkem_utraceno)}</strong></td>
          <td style="font-size:.82rem;color:var(--txt2)">${escHtml(r.dodavatele||"")}</td>
        </tr>
        ${r._items.map(item => `
        <tr class="zbozi-row zbozi-child-${escHtml(r.zbozi_nazev).replace(/\s+/g,'_')}" data-id="${item.zbozi_id||""}" data-nazev="${escHtml(item.zbozi_nazev)}" style="display:none">
          <td style="padding-left:2rem;color:var(--txt2)">↳ ${escHtml(item.zbozi_nazev)}</td>
          <td style="text-align:center">${item.pocet_nakupu}</td>
          <td>${Number(item.celkove_mnozstvi).toLocaleString("cs-CZ")}</td>
          <td>${item.jednotka}</td>
          <td>${czMoney(item.prumerna_cena)}</td>
          <td>${czMoney(item.celkem_utraceno)}</td>
          <td style="font-size:.82rem;color:var(--txt2)">${escHtml(item.dodavatele||"")}</td>
        </tr>`).join("")}`;
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

async function openZboziDetail(zbozi_id, nazev) {
  let data;
  try { data = await api(`/api/polozky/detail/${zbozi_id}`); } catch { return; }

  const body = `
    <h4 style="margin-bottom:.5rem">${escHtml(data.zbozi.nazev_canonical)}</h4>
    <div class="alias-list" id="aliasContainer">
      ${data.aliasy.map(a => `<span class="alias-tag">${escHtml(a)}</span>`).join("")}
    </div>
    <div style="margin-top:1rem; display:flex; gap:.5rem; flex-wrap:wrap;">
      <input id="newAlias" class="form-control" style="max-width:250px" placeholder="Nový alias (alternativní název)">
      <button class="btn btn-secondary btn-sm" onclick="addAlias(${zbozi_id})">+ Přidat alias</button>
    </div>
    <hr style="margin:1rem 0; border-color:var(--border)">
    <h4 style="font-family:var(--font-head);margin-bottom:.7rem">Historie nákupů</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Datum</th><th>Dodavatel</th><th>Firma</th><th>Množství</th><th>Cena/jedn.</th><th>Celkem</th></tr></thead>
        <tbody>
          ${data.nakupy.map(n => `
            <tr style="cursor:pointer" onclick="closeModal();openFakturaDetail(${n.faktura_id})" title="Zobrazit fakturu">
              <td>${czDate(n.datum_vystaveni)}</td>
              <td>${escHtml(n.dodavatel)}</td>
              <td>${n.firma_zkratka}</td>
              <td>${Number(n.mnozstvi).toLocaleString("cs-CZ")} ${n.jednotka}</td>
              <td>${czMoney(n.cena_za_jednotku_s_dph)}</td>
              <td><strong>${czMoney(n.celkem_s_dph)}</strong> <span style="color:var(--txt2);font-size:.8rem">→</span></td>
            </tr>`).join("") || "<tr><td colspan='6' style='text-align:center;color:var(--txt2)'>Žádné nákupy</td></tr>"}
        </tbody>
      </table>
    </div>`;

  openModal(`Detail zboží: ${escHtml(nazev)}`, body);
}

async function addAlias(zbozi_id) {
  const alias = document.getElementById("newAlias").value.trim();
  if (!alias) { toast("Vyplňte alias", true); return; }
  await api("/api/zbozi/alias", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ zbozi_id, alias })
  });
  toast("Alias přidán");
  const el = document.getElementById("aliasContainer");
  el.innerHTML += `<span class="alias-tag">${escHtml(alias)}</span>`;
  document.getElementById("newAlias").value = "";
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
    </div>
    <div class="filters" style="margin-bottom:1rem">
      <label>Rok:</label>
      <select id="vyplRok" onchange="loadVyplatyKarty()">
        ${rokOptions(new Date().getFullYear())}
      </select>
    </div>
    <div id="vyplatyKarty"><div class="loading-center"><span class="spinner"></span></div></div>`;
  loadVyplatyKarty();
}

async function loadVyplatyKarty() {
  const dnes = new Date();
  const zvolenyRok = parseInt(document.getElementById("vyplRok")?.value || dnes.getFullYear());
  const mesicOd = `${dnes.getFullYear()}-${String(dnes.getMonth()+1).padStart(2,"0")}-01`;
  const rokOd   = `${zvolenyRok}-01-01`;
  const rokDo   = `${zvolenyRok}-12-31`;

  let dataMesic, dataRok, dataNaklady;
  try { dataMesic   = await api(`/api/vyplaty?od=${mesicOd}`); } catch { dataMesic = {vyplaty:[]}; }
  try { dataRok     = await api(`/api/vyplaty?od=${rokOd}&do=${rokDo}`); } catch { dataRok = {vyplaty:[]}; }

  // Seskupit podle jména
  const zam = {};
  // Všechny výplaty pro poslední výplatu
  const vsechny = await api("/api/vyplaty?od=2000-01-01").catch(()=>({vyplaty:[]}));
  vsechny.vyplaty.forEach(v => {
    if (!zam[v.jmeno]) zam[v.jmeno] = { posledni: null, celkem_mesic: 0, celkem_rok: 0, naklady_mesic: 0, naklady_rok: 0 };
    if (!zam[v.jmeno].posledni || v.datum > zam[v.jmeno].posledni.datum)
      zam[v.jmeno].posledni = v;
  });
  dataMesic.vyplaty.forEach(v => {
    if (!zam[v.jmeno]) zam[v.jmeno] = { posledni: null, celkem_mesic: 0, celkem_rok: 0, naklady_mesic: 0, naklady_rok: 0 };
    zam[v.jmeno].celkem_mesic += v.castka || 0;
  });
  dataRok.vyplaty.forEach(v => {
    if (!zam[v.jmeno]) zam[v.jmeno] = { posledni: null, celkem_mesic: 0, celkem_rok: 0, naklady_mesic: 0, naklady_rok: 0 };
    zam[v.jmeno].celkem_rok += v.castka || 0;
  });

  // Načíst odvody pro každého zaměstnance
  for (const jmeno of Object.keys(zam)) {
    try {
      const od = await api(`/api/pausalni-odvody/${encodeURIComponent(jmeno)}`);
      const sumOdvody = (od.odvody||[]).reduce((s,o)=>s+o.castka,0);
      zam[jmeno].naklady_mesic = zam[jmeno].celkem_mesic + sumOdvody;
      zam[jmeno].naklady_rok   = zam[jmeno].celkem_rok   + sumOdvody * 12;
    } catch {}
  }

  const el = document.getElementById("vyplatyKarty");
  if (!el) return;
  const poradi = ["Ráďa","Věrka","Vali","Vendy","Renča"];
  const jmena = Object.keys(zam).sort((a,b) => {
    const ia = poradi.indexOf(a), ib = poradi.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1; if (ib >= 0) return 1;
    return a.localeCompare(b,"cs");
  });

  const mesicLabel = new Date(mesicOd).toLocaleDateString("cs-CZ",{month:"long",year:"numeric"});
  el.innerHTML = `
    <div style="font-size:.85rem;color:var(--txt2);margin-bottom:1rem">Aktuální měsíc: <strong>${mesicLabel}</strong> &nbsp;·&nbsp; Rok ${zvolenyRok}</div>
    <div style="display:flex;flex-wrap:wrap;gap:1rem">
      ${jmena.map(jmeno => {
        const z = zam[jmeno];
        return `
        <div class="card" style="flex:1;min-width:220px;max-width:300px;cursor:pointer;transition:box-shadow .2s;padding:1.2rem"
             onclick="renderZamestnanecDetail('${escHtml(jmeno)}')"
             onmouseover="this.style.boxShadow='0 4px 24px rgba(0,0,0,.13)'"
             onmouseout="this.style.boxShadow=''">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.8rem">
            <strong style="font-size:1.1rem">${escHtml(jmeno)}</strong>
            <button class="btn btn-secondary btn-sm" style="font-size:.75rem;padding:.2rem .5rem"
                    onclick="event.stopPropagation();openPausalni('${escHtml(jmeno)}')">⚙️ Odvody</button>
          </div>
          <div style="font-size:.8rem;color:var(--txt2);margin-bottom:.6rem">
            Poslední: <strong>${czMoney(z.posledni?.castka)}</strong>
            ${z.posledni?.datum ? `<span style="margin-left:.4rem">${czDate(z.posledni.datum)}</span>` : ""}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:.4rem;font-size:.85rem">
            <div style="background:var(--bg);border-radius:6px;padding:.4rem .6rem">
              <div style="color:var(--txt2);font-size:.75rem">Měsíc</div>
              <div style="font-weight:700">${czMoney(z.celkem_mesic)}</div>
            </div>
            <div style="background:var(--bg);border-radius:6px;padding:.4rem .6rem">
              <div style="color:var(--txt2);font-size:.75rem">Náklady měsíc</div>
              <div style="font-weight:700;color:#dc2626">${czMoney(z.naklady_mesic)}</div>
            </div>
            <div style="background:var(--bg);border-radius:6px;padding:.4rem .6rem">
              <div style="color:var(--txt2);font-size:.75rem">Rok ${zvolenyRok}</div>
              <div style="font-weight:700">${czMoney(z.celkem_rok)}</div>
            </div>
            <div style="background:var(--bg);border-radius:6px;padding:.4rem .6rem">
              <div style="color:var(--txt2);font-size:.75rem">Náklady rok</div>
              <div style="font-weight:700;color:#dc2626">${czMoney(z.naklady_rok)}</div>
            </div>
          </div>
        </div>`;
      }).join("")}
    </div>`;
}

async function renderZamestnanecDetail(jmeno) {
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">
        <span style="cursor:pointer;color:var(--txt2);font-weight:400" onclick="renderVyplaty()">Výplaty</span>
        <span style="margin:0 .4rem">›</span>${escHtml(jmeno)}
      </h1>
      <button class="btn btn-primary btn-sm" onclick="openNovVyplata('${escHtml(jmeno)}')">+ Nová výplata</button>
    </div>
    <div id="zamDetail"><div class="loading-center"><span class="spinner"></span></div></div>`;

  const data = await api(`/api/vyplaty?od=2000-01-01&jmeno=${encodeURIComponent(jmeno)}`).catch(()=>({vyplaty:[]}));

  // Seskupit po měsících
  const mesice = {};
  data.vyplaty.forEach(v => {
    const klic = (v.datum||"").substring(0,7);
    if (!mesice[klic]) mesice[klic] = [];
    mesice[klic].push(v);
  });

  const klice = Object.keys(mesice).sort().reverse();
  const el = document.getElementById("zamDetail");
  if (!el) return;

  if (!klice.length) {
    el.innerHTML = `<div class="card" style="text-align:center;color:var(--txt2);padding:2rem">Žádné výplaty</div>`;
    return;
  }

  el.innerHTML = klice.map((klic, idx) => {
    const vyplaty = mesice[klic];
    const [rok, mes] = klic.split("-");
    const nazevMesice = new Date(rok, mes-1, 1).toLocaleDateString("cs-CZ",{month:"long",year:"numeric"});
    const celkem = vyplaty.reduce((s,v)=>s+(v.castka||0),0);
    return `
    <div class="card" style="margin-bottom:.75rem;padding:0;overflow:hidden">
      <div style="display:flex;align-items:center;padding:.9rem 1.2rem;cursor:pointer;gap:1rem"
           onclick="toggleBankaMonth('zm_${klic}',this)">
        <span style="font-size:1rem;font-weight:700;flex:1">${nazevMesice}</span>
        <span style="font-weight:600;color:#16a34a">${czMoney(celkem)}</span>
        <span style="color:var(--txt2);font-size:.85rem">${vyplaty.length} zázn.</span>
        <span class="accordion-arrow" style="transition:transform .2s">▼</span>
      </div>
      <div id="zm_${klic}" style="display:none;border-top:1px solid var(--border)">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Datum</th><th>Firma</th><th>Částka</th><th>Poznámka</th><th></th></tr></thead>
            <tbody>
              ${vyplaty.map(v=>`
              <tr>
                <td>${czDate(v.datum)}</td>
                <td><span class="badge">${escHtml(v.firma_zkratka||"")}</span></td>
                <td><strong style="color:#16a34a">${czMoney(v.castka)}</strong></td>
                <td style="color:var(--txt2);font-size:.9rem">${escHtml(v.poznamka||"")}</td>
                <td>
                  <button class="btn btn-sm" style="font-size:.8rem" onclick="openVyplataEdit(${v.id})">✏️</button>
                  <button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border:none;border-radius:4px;padding:.2rem .4rem;margin-left:.2rem" onclick="smazatVyplatu(${v.id},'${escHtml(jmeno)}')">🗑</button>
                </td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
  }).join("");
}

async function loadVyplatyPrehled(mesicOd) {
  const el = document.getElementById("vyplatyPrehled");
  if (!el) return;

  const dnes = new Date();
  const rokOd = `${dnes.getFullYear()}-01-01`;
  const rokDo = `${dnes.getFullYear()}-12-31`;

  let dataMesic, dataRok;
  try { dataMesic = await api(`/api/vyplaty?od=${mesicOd}`); } catch { return; }
  try { dataRok   = await api(`/api/vyplaty?od=${rokOd}&do=${rokDo}`); } catch { dataRok = {vyplaty:[]}; }

  // Seskupit podle jména — měsíc
  const zamestnanci = {};
  dataMesic.vyplaty.forEach(v => {
    if (!zamestnanci[v.jmeno]) zamestnanci[v.jmeno] = { posledni: null, celkem_mesic: 0, pocet: 0, celkem_rok: 0 };
    zamestnanci[v.jmeno].celkem_mesic += v.castka || 0;
    zamestnanci[v.jmeno].pocet++;
    if (!zamestnanci[v.jmeno].posledni || v.datum > zamestnanci[v.jmeno].posledni.datum)
      zamestnanci[v.jmeno].posledni = v;
  });
  // Přidat roční součty
  dataRok.vyplaty.forEach(v => {
    if (!zamestnanci[v.jmeno]) zamestnanci[v.jmeno] = { posledni: null, celkem_mesic: 0, pocet: 0, celkem_rok: 0 };
    zamestnanci[v.jmeno].celkem_rok += v.castka || 0;
  });

  const mesicLabel = new Date(mesicOd).toLocaleDateString("cs-CZ", {month:"long", year:"numeric"});
  el.innerHTML = `
    <div style="font-size:.85rem;color:var(--txt2);margin-bottom:.5rem">Přehled za <strong>${mesicLabel}</strong> — kliknutím na jméno zobrazíte celou historii</div>
    <table>
      <thead><tr>
        <th>Zaměstnanec</th>
        <th>Poslední výplata</th>
        <th>Datum</th>
        <th>Celkem tento měsíc</th>
        <th>Náklady měsíc</th>
        <th>Rok ${dnes.getFullYear()}</th>
        <th>Náklady rok</th>
        <th></th>
      </tr></thead>
      <tbody>
        ${Object.entries(zamestnanci).length ? Object.entries(zamestnanci).sort((a,b)=>a[0].localeCompare(b[0],"cs")).map(([jmeno, z]) => `
          <tr style="cursor:pointer" onclick="zobrazHistoriiZamestnance('${escHtml(jmeno)}')">
            <td><strong>${escHtml(jmeno)}</strong></td>
            <td>${czMoney(z.posledni?.castka)}</td>
            <td>${czDate(z.posledni?.datum)}</td>
            <td><strong>${czMoney(z.celkem_mesic)}</strong></td>
            <td id="naklady-mesic-${escHtml(jmeno)}" style="color:var(--txt2)">…</td>
            <td><strong>${czMoney(z.celkem_rok)}</strong></td>
            <td id="naklady-rok-${escHtml(jmeno)}" style="color:var(--txt2)">…</td>
            <td onclick="event.stopPropagation()">
              <button class="btn btn-secondary btn-sm" onclick="openPausalni('${escHtml(jmeno)}')">⚙️ Odvody</button>
            </td>
          </tr>`).join("")
          : "<tr><td colspan='8' style='text-align:center;color:var(--txt2);padding:1.5rem'>Žádné výplaty tento měsíc</td></tr>"}
      </tbody>
      ${Object.keys(zamestnanci).length ? `
      <tfoot>
        <tr class="table-footer">
          <td colspan="3">Celkem za měsíc</td>
          <td><strong>${czMoney(Object.values(zamestnanci).reduce((s,z)=>s+z.celkem_mesic,0))}</strong></td>
          <td colspan="4"></td>
        </tr>
      </tfoot>` : ""}
    </table>`;

  // Načíst paušální odvody pro každého zaměstnance asynchronně
  for (const jmeno of Object.keys(zamestnanci)) {
    try {
      const s = await api(`/api/vyplaty/souhrn/${encodeURIComponent(jmeno)}`);
      const elM = document.getElementById(`naklady-mesic-${jmeno}`);
      const elR = document.getElementById(`naklady-rok-${jmeno}`);
      if (elM) elM.innerHTML = s.odvody_suma > 0
        ? `<span title="výplata + odvody">${czMoney(s.celkem_mesic + s.odvody_suma)}</span>`
        : `<span style="color:#aaa">—</span>`;
      if (elR) elR.innerHTML = s.odvody_suma > 0
        ? `<span title="výplata + odvody×12">${czMoney(s.celkem_rok + s.odvody_suma * 12)}</span>`
        : `<span style="color:#aaa">—</span>`;
    } catch {}
  }
}

async function openPausalni(jmeno) {
  let odvody = [];
  try { odvody = await api(`/api/pausalni-odvody/${encodeURIComponent(jmeno)}`); } catch {}

  const renderRadky = (seznam) => seznam.map((o, i) => `
    <tr>
      <td><input class="form-control po-nazev" data-i="${i}" value="${escHtml(o.nazev)}" placeholder="Název (VZP, PSSZ...)" style="min-width:120px"></td>
      <td><input type="number" class="form-control po-castka" data-i="${i}" value="${o.castka}" style="max-width:110px"></td>
      <td><button class="btn btn-sm" style="background:#fee2e2;color:#991b1b" onclick="removePausalniRadek(${i})">✕</button></td>
    </tr>`).join("");

  openModal(`Paušální odvody — ${escHtml(jmeno)}`, `
    <p style="color:var(--txt2);font-size:.85rem;margin-bottom:1rem">
      Pevné měsíční platby (VZP, PSSZ, exekuce, daň...). Zobrazují se jako "Náklady" v přehledu.
    </p>
    <table id="pausalniTable" style="width:100%;margin-bottom:.5rem">
      <thead><tr><th>Název</th><th>Částka / měsíc (Kč)</th><th></th></tr></thead>
      <tbody id="pausalniBody">${renderRadky(odvody)}</tbody>
    </table>
    <button class="btn btn-secondary btn-sm" onclick="addPausalniRadek()">+ Přidat řádek</button>
    <hr style="margin:1rem 0">
    <button class="btn btn-primary" onclick="ulozitPausalni('${escHtml(jmeno)}')">💾 Uložit odvody</button>
  `);
  // Ulož aktuální seznam do dočasné proměnné
  window._pausalniData = odvody.map(o => ({...o}));
  window._pausalniJmeno = jmeno;
}

function addPausalniRadek() {
  window._pausalniData = window._pausalniData || [];
  window._pausalniData.push({nazev: "", castka: 0});
  const tbody = document.getElementById("pausalniBody");
  if (!tbody) return;
  const i = window._pausalniData.length - 1;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="form-control po-nazev" data-i="${i}" value="" placeholder="Název (VZP, PSSZ...)" style="min-width:120px"></td>
    <td><input type="number" class="form-control po-castka" data-i="${i}" value="0" style="max-width:110px"></td>
    <td><button class="btn btn-sm" style="background:#fee2e2;color:#991b1b" onclick="removePausalniRadek(${i})">✕</button></td>`;
  tbody.appendChild(tr);
}

function removePausalniRadek(i) {
  window._pausalniData.splice(i, 1);
  openPausalni(window._pausalniJmeno);
}

async function ulozitPausalni(jmeno) {
  // Sesbírej aktuální hodnoty z inputů
  const nazvy   = document.querySelectorAll(".po-nazev");
  const castky  = document.querySelectorAll(".po-castka");
  const seznam  = [];
  nazvy.forEach((el, i) => {
    const nazev  = el.value.trim();
    const castka = parseFloat(castky[i]?.value || 0) || 0;
    if (nazev) seznam.push({nazev, castka});
  });
  await api(`/api/pausalni-odvody/${encodeURIComponent(jmeno)}`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(seznam)
  });
  toast("Odvody uloženy ✓");
  closeModal();
  // Obnov přehled
  const dnes = new Date();
  const mesicOd = `${dnes.getFullYear()}-${String(dnes.getMonth()+1).padStart(2,"0")}-01`;
  loadVyplatyPrehled(mesicOd);
}

function zobrazHistoriiZamestnance(jmeno) {
  const sel = document.getElementById("vJmeno");
  if (sel) {
    // Najít nebo přidat option
    let found = false;
    for (let o of sel.options) { if (o.value === jmeno) { o.selected = true; found = true; break; } }
    if (!found) { const o = new Option(jmeno, jmeno, true, true); sel.add(o); }
  }
  loadVyplaty();
  document.getElementById("vyplatyList")?.scrollIntoView({behavior:"smooth"});
}

async function nacistZamestnance() {
  try {
    const data = await api("/api/vyplaty/zamestnanci");
    const sel = document.getElementById("vJmeno");
    if (!sel) return;
    data.jmena.forEach(j => {
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
      <thead><tr><th>Firma</th><th>Jméno</th><th>Datum</th><th>Částka</th><th>Období</th><th>Poznámka</th><th></th></tr></thead>
      <tbody>
        ${data.vyplaty.map(v => `
          <tr>
            <td><span class="badge" style="background:var(--green-pale)">${escHtml(v.firma_zkratka||"—")}</span></td>
            <td><strong>${escHtml(v.jmeno)}</strong></td>
            <td>${czDate(v.datum)}</td>
            <td><strong>${czMoney(v.castka)}</strong></td>
            <td style="color:var(--txt2);font-size:.88rem">${v.obdobi_od||v.obdobi_do ? (czDate(v.obdobi_od)||"—") + " – " + (czDate(v.obdobi_do)||"—") : "—"}</td>
            <td style="color:var(--txt2);font-size:.88rem">${escHtml(v.poznamka||"")}</td>
            <td>
              <button class="btn btn-secondary btn-sm" onclick="editVyplata(${v.id},'${escHtml(v.jmeno)}','${v.datum}',${v.castka},'${escHtml(v.poznamka||"")}','${escHtml(v.firma_zkratka||"")}','${v.obdobi_od||""}','${v.obdobi_do||""}')">✏️</button>
              <button class="btn btn-danger btn-sm" onclick="deleteVyplata(${v.id})">🗑</button>
            </td>
          </tr>`).join("") ||
          "<tr><td colspan='7' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné výplaty</td></tr>"}
      </tbody>
      ${data.vyplaty.length ? `
      <tfoot>
        <tr class="table-footer">
          <td colspan="3">Celkem (${data.vyplaty.length} výplat)</td>
          <td><strong>${czMoney(data.celkem)}</strong></td>
          <td colspan="3"></td>
        </tr>
      </tfoot>` : ""}
    </table>`;
}

function vyplataFormHtml(v = {}) {
  return `
    <div class="grid-2" style="gap:1rem">
      <div class="form-group"><label class="form-label">Firma</label>
        <select id="fvFirma" class="form-control">
          <option value="">—</option>
          ${App.config.firmy.map(f=>`<option value="${f}" ${v.firma_zkratka===f?"selected":""}>${f}</option>`).join("")}
        </select>
      </div>
      <div class="form-group"><label class="form-label">Jméno *</label>
        <input id="fvJmeno" class="form-control" value="${escHtml(v.jmeno||"")}" placeholder="Jméno zaměstnance">
      </div>
      <div class="form-group"><label class="form-label">Datum *</label>
        <input type="date" id="fvDatum" class="form-control" value="${v.datum||new Date().toISOString().split('T')[0]}">
      </div>
      <div class="form-group"><label class="form-label">Částka (Kč) *</label>
        <input type="number" step="0.01" id="fvCastka" class="form-control" value="${v.castka||""}">
      </div>
    </div>
    <div class="grid-2" style="gap:1rem">
      <div class="form-group"><label class="form-label">Období od</label>
        <input type="date" id="fvOd" class="form-control" value="${v.obdobi_od||""}">
      </div>
      <div class="form-group"><label class="form-label">Období do</label>
        <input type="date" id="fvDo" class="form-control" value="${v.obdobi_do||""}">
      </div>
    </div>
    <div class="form-group"><label class="form-label">Poznámka</label>
      <input id="fvPoznamka" class="form-control" value="${escHtml(v.poznamka||"")}" placeholder="Volitelná poznámka">
    </div>`;
}

function openNovVyplata(jmeno) {
  openModal("Nová výplata", `
    ${vyplataFormHtml(jmeno ? {jmeno} : {})}
    <div class="btn-group" style="margin-top:1rem">
      <button class="btn btn-primary" onclick="ulozitVyplatu()">💾 Uložit</button>
    </div>`);
}

async function openVyplataEdit(id) {
  const data = await api(`/api/vyplaty?od=2000-01-01`).catch(()=>({vyplaty:[]}));
  const v = data.vyplaty.find(x=>x.id===id);
  if (!v) return;
  editVyplata(v.id, v.jmeno, v.datum, v.castka, v.poznamka, v.firma_zkratka, v.obdobi_od, v.obdobi_do);
}

async function smazatVyplatu(id, jmeno) {
  if (!confirm("Opravdu smazat tuto výplatu?")) return;
  await api(`/api/vyplaty/${id}`, { method:"DELETE" });
  toast("Výplata smazána ✓");
  renderZamestnanecDetail(jmeno);
}

function editVyplata(id, jmeno, datum, castka, poznamka, firma_zkratka, obdobi_od='', obdobi_do='') {
  openModal("Upravit výplatu", `
    ${vyplataFormHtml({jmeno, datum, castka, poznamka, firma_zkratka, obdobi_od, obdobi_do})}
    <div class="btn-group" style="margin-top:1rem">
      <button class="btn btn-primary" onclick="ulozitVyplatuEdit(${id})">💾 Uložit změny</button>
    </div>`);
}

async function ulozitVyplatu() {
  const jmeno  = document.getElementById("fvJmeno").value.trim();
  let datum    = document.getElementById("fvDatum").value;
  const castka = parseFloat(document.getElementById("fvCastka").value);
  if (!jmeno || !datum || isNaN(castka)) { toast("Vyplnte jmeno, datum a castku", true); return; }
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(datum)) {
    const [d, m, y] = datum.split(".");
    datum = `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }
  try {
    await api("/api/vyplaty", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        jmeno, datum, castka,
        poznamka: document.getElementById("fvPoznamka").value,
        firma_zkratka: document.getElementById("fvFirma").value,
        obdobi_od: document.getElementById("fvOd").value || null,
        obdobi_do: document.getElementById("fvDo").value || null,
      })
    });
    toast("Výplata uložena ✓");
    closeModal();
    // Refresh — pokud jsme na detailu zaměstnance, vrátíme se tam
    const jmenoVal = jmeno;
    if (document.querySelector(".page-title")?.textContent?.includes(jmenoVal)) {
      renderZamestnanecDetail(jmenoVal);
    } else {
      renderVyplaty();
    }
  } catch(e) {
    toast("Chyba: " + e.message, true);
  }
}

async function ulozitVyplatuEdit(id) {
  const jmeno  = document.getElementById("fvJmeno").value.trim();
  const datum  = document.getElementById("fvDatum").value;
  const castka = parseFloat(document.getElementById("fvCastka").value);
  if (!jmeno || !datum || isNaN(castka)) { toast("Vyplňte jméno, datum a částku", true); return; }

  await api(`/api/vyplaty/${id}`, {
    method:"PUT", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      jmeno, datum, castka,
      poznamka: document.getElementById("fvPoznamka").value,
      firma_zkratka: document.getElementById("fvFirma").value,
      obdobi_od: document.getElementById("fvOd").value || null,
      obdobi_do: document.getElementById("fvDo").value || null,
    })
  });
  toast("Výplata upravena ✓");
  closeModal();
  loadVyplaty();
}

async function deleteVyplata(id) {
  if (!confirm("Opravdu smazat tuto výplatu?")) return;
  await api(`/api/vyplaty/${id}`, { method: "DELETE" });
  toast("Výplata smazána");
  loadVyplaty();
}

function exportVyplaty(fmt) {
  const params = new URLSearchParams({
    format: fmt,
    firma: document.getElementById("vFirma")?.value||"",
    od:    document.getElementById("vOd")?.value||"",
    do:    document.getElementById("vDo")?.value||"",
  });
  window.location.href = `/api/export/vyplaty?${params}`;
}

// ═══════════════════════════════════════════════════════════════
//  STATISTIKY
// ═══════════════════════════════════════════════════════════════
async function renderStatistiky() {
  const od = new Date(); od.setFullYear(od.getFullYear()-1);
  const odStr = od.toISOString().split("T")[0];
  const doStr = new Date().toISOString().split("T")[0];

  document.getElementById("mainContent").innerHTML = `
    <div class="page-header"><h1 class="page-title">Statistiky</h1></div>
    <div class="filters" style="margin-bottom:1rem">
      <label>Firma:</label>
      <select id="sFirma" class="firma-select">
        <option value="">Všechny</option>
        ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
      </select>
      <label>Rok:</label>
      <select id="sRok" onchange="aplikujRokFiltr('sRok','sOd','sDo',loadStatistiky)">
        ${rokOptions("")}
      </select>
      <label>Od:</label><input type="date" id="sOd" value="${odStr}">
      <label>Do:</label><input type="date" id="sDo" value="${doStr}">
      <button class="btn btn-primary btn-sm" onclick="loadStatistiky()">Zobrazit</button>
    </div>
    <div id="statContent"><div class="loading-center"><span class="spinner"></span></div></div>
    <div id="statReporty" style="margin-top:1.5rem"></div>`;

  loadStatistiky();
  loadMesicniStatistiky();
}

async function loadStatistiky() {
  const params = new URLSearchParams({
    firma: document.getElementById("sFirma")?.value||"",
    od:    document.getElementById("sOd")?.value||"",
    do:    document.getElementById("sDo")?.value||"",
  });
  let data;
  try { data = await api(`/api/statistiky?${params}`); } catch { return; }

  const el = document.getElementById("statContent");
  if (!el) return;

  el.innerHTML = `
    <div class="grid-2" style="gap:1rem; margin-bottom:1rem">
      <div class="card">
        <div class="card-title">Výdaje po měsících</div>
        <div class="chart-wrap"><canvas id="sBarChart" style="width:100%;height:100%"></canvas></div>
      </div>
      <div class="card">
        <div class="card-title">Top dodavatelé</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Dodavatel</th><th>Faktur</th><th>Celkem</th></tr></thead>
            <tbody>
              ${data.dodavatele.map(d=>`
                <tr><td>${escHtml(d.dodavatel)}</td><td>${d.pocet}</td><td><strong>${czMoney(d.castka)}</strong></td></tr>
              `).join("") || "<tr><td colspan='3' style='text-align:center;color:var(--txt2)'>Žádná data</td></tr>"}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Nejnakupovanější zboží (dle výdajů)</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Zboží</th><th>Celkem s DPH</th><th>Množství</th><th>Jedn.</th></tr></thead>
          <tbody>
            ${data.zbozi_top.map(z=>`
              <tr>
                <td>${escHtml(z.zbozi)}</td>
                <td><strong>${czMoney(z.castka)}</strong></td>
                <td>${Number(z.mnozstvi).toLocaleString("cs-CZ")}</td>
                <td>${z.jednotka}</td>
              </tr>`).join("") || "<tr><td colspan='4' style='text-align:center;color:var(--txt2)'>Žádná data</td></tr>"}
          </tbody>
        </table>
      </div>
    </div>`;

  requestAnimationFrame(() => {
    drawBarChart("sBarChart", data.mesice.map(m=>m.mesic), data.mesice.map(m=>m.castka));
  });
}

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
    { klic: "vydaje_zobrazit",   label: "Výdaje — zobrazit" },
    { klic: "vydaje_upravit",    label: "Výdaje — přidat/upravit" },
    { klic: "vydaje_smazat",     label: "Výdaje — mazat" },
    { klic: "naklady_zobrazit",  label: "Náklady — zobrazit" },
    { klic: "bankovni_vypisy",   label: "Bankovní výpisy" },
    { klic: "statistiky",        label: "Statistiky" },
    { klic: "nastaveni",         label: "Nastavení" },
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
        <button class="btn" style="background:var(--accent);color:#fff" onclick="opravDuplicity()">🔍 Zkontrolovat duplicity</button>
        <button class="btn" style="background:#6c757d;color:#fff" onclick="normalizujNazvy()">🧹 Odstranit ARO/MC/FL prefixy</button>
      </div>

      <hr style="margin:1.5rem 0">

      <!-- MATICE OPRÁVNĚNÍ -->
      <div>
        <h3 style="margin:0 0 .75rem;font-size:1rem">👥 Oprávnění uživatelů</h3>
        <p style="color:var(--txt2);font-size:.85rem;margin-bottom:1rem">
          Admin má vždy vše. Kliknutím na čtvereček povoluješ nebo zakazuješ přístup.
        </p>
        <table style="width:100%;border-collapse:collapse">
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
        <div style="font-weight:600;margin-bottom:.5rem">💾 Záloha databáze</div>
        <div style="color:var(--txt2);font-size:.9rem;margin-bottom:.75rem">
          Stáhne kompletní SQL dump celé databáze (PostgreSQL). Doporučujeme zálohovat pravidelně.
        </div>
        <button class="btn btn-primary" onclick="stahnoutZalohu()">⬇ Stáhnout zálohu (.sql)</button>
        <span id="zalohaStatus" style="margin-left:.75rem;font-size:.9rem;color:var(--txt2)"></span>
      </div>

      <hr style="margin:1.5rem 0">
      <div style="border:1px solid #e55;border-radius:8px;padding:1rem;background:#fff5f5">
        <div style="font-weight:600;color:#c00;margin-bottom:.5rem">⚠️ Nebezpečná zóna</div>
        <div style="color:var(--txt2);font-size:.9rem;margin-bottom:.75rem">Smaže všechny faktury a položky. Akce je nevratná!</div>
        <button class="btn" style="background:#c00;color:#fff" onclick="smazatVseFaktury()">🗑️ Smazat všechny faktury</button>
      </div>
    </div>`;
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

async function stahnoutZalohu() {
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
  } catch(e) {
    if (statusEl) statusEl.textContent = "❌ " + e.message;
    toast("Záloha selhala: " + e.message, true);
  }
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

function renderKartaStatHtml(stats) {
  const firmy = Object.keys(stats);
  if (!firmy.length) return "";
  const card = (firma, d) => {
    const mPct = Math.min(Math.round(d.mesicni / d.terminal_limit * 100), 100);
    const rPct = Math.min(Math.round(d.rocni / d.dph_limit * 100), 100);
    const mColor = mPct >= 100 ? "#ef4444" : mPct >= 80 ? "#f59e0b" : "#16a34a";
    const rColor = rPct >= 100 ? "#ef4444" : rPct >= 75 ? "#f59e0b" : "#16a34a";
    const od = d.terminal_od ? new Date(d.terminal_od).toLocaleDateString("cs-CZ") : "—";
    return `
      <div style="background:var(--card-bg);border:${d.aktivni ? '2px solid #16a34a' : '1px solid var(--border)'};border-radius:10px;padding:1rem;flex:1;min-width:200px">
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.6rem">
          <span style="font-weight:700;font-size:1.1rem;font-family:var(--font-head)">${escHtml(firma)}</span>
          ${d.aktivni ? '<span style="background:#16a34a;color:#fff;font-size:.7rem;padding:.1rem .5rem;border-radius:99px;font-weight:600">● aktivní</span>' : ''}
        </div>
        <div style="font-size:.8rem;color:var(--txt2);margin-bottom:.3rem">💳 Terminál od ${od}</div>
        <div style="display:flex;justify-content:space-between;font-size:.88rem;margin-bottom:.2rem">
          <span>Měsíční karty</span>
          <strong style="color:${mColor}">${czInt(d.mesicni)} / ${czInt(d.terminal_limit)} Kč</strong>
        </div>
        <div style="background:#e5e7eb;border-radius:4px;height:8px;margin-bottom:.7rem">
          <div style="background:${mColor};height:8px;border-radius:4px;width:${mPct}%;transition:.3s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:.88rem;margin-bottom:.2rem">
          <span>DPH rok ${new Date().getFullYear()}</span>
          <strong style="color:${rColor}">${czInt(d.rocni)} / ${czInt(d.dph_limit)} Kč</strong>
        </div>
        <div style="background:#e5e7eb;border-radius:4px;height:8px">
          <div style="background:${rColor};height:8px;border-radius:4px;width:${rPct}%;transition:.3s"></div>
        </div>
        ${mPct >= 90 ? '<div style="margin-top:.5rem;font-size:.8rem;color:#b45309;font-weight:600">⚠️ Blíží se limit terminálu!</div>' : ''}
        ${mPct >= 100 ? '<div style="margin-top:.5rem;font-size:.8rem;color:#991b1b;font-weight:700">🚨 Limit terminálu překročen! Přepni firmu.</div>' : ''}
        ${rPct >= 90 ? '<div style="margin-top:.3rem;font-size:.8rem;color:#b45309;font-weight:600">⚠️ Blíží se DPH limit!</div>' : ''}
        <button class="btn btn-secondary btn-sm" style="margin-top:.7rem;font-size:.75rem" onclick="prepnoutTerminal('${firma}')">🔄 Přepnout — nulovat měsíční</button>
      </div>`;
  };
  return `<div style="display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1rem">${firmy.map(f => card(f, stats[f])).join("")}</div>`;
}

async function prepnoutTerminal(firma) {
  if (!confirm("Přepnout terminál pro " + firma + "? Měsíční čítač karet se vynuluje od dneška.")) return;
  await api("/api/config", { method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ terminal_prepnout: firma }) });
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
    const va = a[col] ?? "", vb = b[col] ?? "";
    if (va < vb) return s.asc ? -1 : 1;
    if (va > vb) return s.asc ? 1 : -1;
    return 0;
  });
  renderReportyTable(rows);
  loadReporty();
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
        ${th("trzba_vcpk","Tržba vč.PK")}${th("karty","Karty")}${th("hotovost","Hotovost")}${th("vydaje","Výdaje")}
        ${th("pk_celkem","Poukázky")}
        ${th("pizza_cela","Pizza")}${th("pizza_ctvrt","1/4\nPizza")}${th("burger","Burger")}${th("burtgulas","B-guláš")}${th("talire","Talíře")}
        <th>Firma</th><th>Směna</th><th></th>
      </tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr style="cursor:pointer" onclick="editReport(${r.id})">
            <td style="white-space:nowrap"><strong>${czDateShort(r.datum)}</strong></td>
            <td style="color:var(--txt2);font-size:.82rem">${escHtml(r.den||"")}</td>
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
              <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();deleteReport(${r.id})" title="Smazat">🗑</button>
            </td>
          </tr>`).join("")}
      </tbody>
      <tfoot>
        <tr class="table-footer">
          <td colspan="2">Celkem (${rows.length} dní)</td>
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
  const dnes = r.datum || new Date().toISOString().split("T")[0];
  return `
    <div class="form-group" style="margin-bottom:.8rem">
      <label class="form-label">Firma</label>
      <select id="rfFirma" class="form-control">
        <option value="">— bez firmy —</option>
        ${App.config.firmy.map(f=>`<option value="${f}" ${(r.firma_zkratka||App._lastReportFirma||"")==f?"selected":""}>${f}</option>`).join("")}
      </select>
    </div>
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
          <input type="date" id="rfDatum" class="form-control" value="${dnes}">
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
      <div class="grid-2" style="gap:.8rem;margin-top:.5rem">
        <div class="form-group">
          <label class="form-label">🎟 PK 50 Kč (kusů)</label>
          <input type="number" id="rfPk50" class="form-control" value="${r.pk50_ks||0}" oninput="rfRecalc()">
        </div>
        <div class="form-group">
          <label class="form-label">🎟 PK 100 Kč (kusů)</label>
          <input type="number" id="rfPk100" class="form-control" value="${r.pk100_ks||0}" oninput="rfRecalc()">
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

async function editReport(id) {
  let r;
  try { r = await api("/api/reporty/" + id); } catch { return; }
  if (!r || r.error) { toast("Report nenalezen", true); return; }
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
    const fotaPanel = document.getElementById("rtabPanelFoto");
    if (!fotaPanel || fotaPanel.style.display === "none") return;
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
    statusEl.textContent = "✅ Lístek přečten – zkontrolujte a uložte";
    if (data.soubor_url) App._reportSouborUrl = data.soubor_url;
    naplnReportFormular(data);
    switchRTab("rucni");
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
  // Přidat soubor_url pokud bylo nahráno foto
  if (App._reportSouborUrl) {
    payload.soubor_url = App._reportSouborUrl;
    App._reportSouborUrl = null;
  }
  await api("/api/reporty", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  toast("Report uložen ✓");
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
  const nazevBanky = banka === "AirBank" ? "Air Bank" : "Raiffeisenbank";
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">
        <span style="cursor:pointer;color:var(--txt2);font-weight:400" onclick="renderBanky()">Banky</span>
        <span style="margin:0 .4rem">›</span>
        <span style="cursor:pointer;color:var(--txt2);font-weight:400" onclick="renderBankyFirma('${firma}')">${firma}</span>
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
        <span style="color:#16a34a;font-size:.9rem">↑ ${czMoney(prichozi)}</span>
        <span style="color:#dc2626;font-size:.9rem">↓ ${czMoney(Math.abs(odchozi))}</span>
        <span style="font-weight:600;font-size:.9rem;color:${saldo>=0?'#16a34a':'#dc2626'}">= ${czMoney(saldo)}</span>
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
                <td style="text-align:right;font-weight:600;color:${p.castka>=0?'#16a34a':'#dc2626'}">${czMoney(p.castka)}</td>
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
  const nazev = banka === "AirBank" ? "Air Bank" : "Raiffeisenbank";
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
          <td style="text-align:right"><strong style="color:${data.celkem>=0?'#16a34a':'#dc2626'}">${czMoney(data.celkem)}</strong></td>
          <td></td>
        </tr>
      </tfoot>` : ""}
    </table>`;
}

function openImportBanky() {
  openModal("Importovat bankovní výpis", `
    <p style="color:var(--txt2);font-size:.85rem;margin-bottom:1rem">
      Nahraj CSV výpis z <strong>Air Bank</strong> nebo <strong>Raiffeisenbank</strong>.
      Duplicitní transakce budou automaticky přeskočeny.
    </p>
    <div class="form-group">
      <label class="form-label">Firma</label>
      <select id="bImportFirma" class="form-control">
        <option value="">— nevybráno —</option>
        ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
      </select>
    </div>
    <div class="dropzone" id="bankyDropzone" style="padding:1.5rem;margin-top:.5rem">
      <div class="dropzone-icon">🏦</div>
      <div class="dropzone-text"><strong>Přetáhněte CSV soubor</strong> nebo klikněte</div>
      <input type="file" id="bankyFileInput" accept=".csv">
    </div>
    <div id="bankyImportStatus" style="margin-top:1rem;font-size:.9rem"></div>
  `);
  const dz  = document.getElementById("bankyDropzone");
  const inp = document.getElementById("bankyFileInput");
  inp.style.display = "none";
  dz.addEventListener("click", () => inp.click());
  inp.addEventListener("change", () => { if (inp.files[0]) doImportBanky(inp.files[0]); });
  dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag-over"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag-over"));
  dz.addEventListener("drop", e => {
    e.preventDefault(); dz.classList.remove("drag-over");
    if (e.dataTransfer.files[0]) doImportBanky(e.dataTransfer.files[0]);
  });
}

async function doImportBanky(file) {
  const statusEl = document.getElementById("bankyImportStatus");
  statusEl.innerHTML = `<span class="spinner"></span> Importuji...`;
  const fd = new FormData();
  fd.append("soubor", file);
  fd.append("firma_zkratka", document.getElementById("bImportFirma")?.value || "");
  try {
    const data = await api("/api/banky/import", { method: "POST", body: fd });
    statusEl.innerHTML = `
      <div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:6px;padding:.7rem 1rem;color:#065f46">
        ✅ Import dokončen! Banka: <strong>${data.banka}</strong><br>
        Naimportováno: <strong>${data.naimportovano}</strong> transakcí
        ${data.duplicity ? `, přeskočeno duplicit: <strong>${data.duplicity}</strong>` : ""}
      </div>`;
    setTimeout(() => { closeModal(); loadBanky(); }, 2000);
  } catch(e) {
    statusEl.innerHTML = `❌ Chyba: ${e.message}`;
  }
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
async function renderVydaje() {
  const tlacitka = maPravo("vydaje_upravit")
    ? `<button class="btn btn-primary btn-sm" onclick="openVydajNahrat()">📷 Nahrát doklad</button>
       <button class="btn btn-sm" onclick="openVydajRucni()">✏️ Ruční zadání</button>`
    : "";
  document.getElementById("mainContent").innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Výdaje</h1>
      <div class="btn-group">${tlacitka}</div>
    </div>
    <div id="vydajeNezaplacene"></div>
    <div class="filters">
      <label>Firma:</label>
      <select id="vFirma" class="firma-select" onchange="loadVydaje()">
        <option value="">Všechny firmy</option>
        ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
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
  aplikujRokFiltr('vRok','vOd','vDo', null);
  loadVydajeNezaplacene();
  loadVydaje();
}

async function loadVydajeNezaplacene() {
  const el = document.getElementById("vydajeNezaplacene");
  if (!el) return;
  const data = await api("/api/vydaje?stav=nezaplaceno").catch(()=>({vydaje:[]}));
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
        <span style="font-weight:700;color:#dc2626">${czMoney(data.celkem)}</span>
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
              <td style="text-align:right;font-weight:600;color:#dc2626">${czMoney(v.castka)}</td>
            </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function toggleVydajStav(id, zaplaceno, reload) {
  const stav = zaplaceno ? "zaplaceno" : "nezaplaceno";
  await api(`/api/vydaje/${id}/stav`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({stav})});
  toast(zaplaceno ? "Označeno jako zaplaceno ✓" : "Označeno jako nezaplaceno");
  if (reload === "nezaplacene") {
    loadVydajeNezaplacene();
    loadVydaje();
  } else {
    loadVydaje();
  }
}

async function loadVydaje() {
  const params = new URLSearchParams({
    firma: document.getElementById("vFirma")?.value || "",
    stav:  document.getElementById("vStav")?.value || "",
    od:    document.getElementById("vOd")?.value || "",
    do:    document.getElementById("vDo")?.value || "",
  });
  const data = await api(`/api/vydaje?${params}`);
  const el = document.getElementById("vydajeList");
  if (!el) return;
  const mozeUpravit = maPravo("vydaje_upravit");
  const mozeSmazat  = maPravo("vydaje_smazat");
  el.innerHTML = `
    <table>
      <thead><tr>
        <th>Stav</th><th>Datum</th><th>Firma</th><th>Dodavatel</th>
        <th>Popis / účel</th><th>Položky</th>
        <th>Způsob úhrady</th><th style="text-align:right">Částka</th><th>Doklad</th><th></th>
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
            ${(v.polozky||[]).map(p=>`${escHtml(p.nazev)} ${czMoney(p.castka)}`).join("<br>")||"—"}
          </td>
          <td><span class="badge" style="background:#f3f4f6">${escHtml(v.zpusob_uhrady||"")}</span></td>
          <td style="text-align:right;font-weight:600;color:${v.stav==='zaplaceno'?'var(--txt2)':'#dc2626'}">${czMoney(v.castka)}</td>
          <td>${v.soubor_url?`<a href="${v.soubor_url}" target="_blank" onclick="event.stopPropagation()" style="font-size:.85rem">📎</a>`:""}</td>
          <td onclick="event.stopPropagation()">
            ${mozeSmazat?`<button class="btn btn-sm" style="background:#fee2e2;color:#991b1b;border:none;padding:.2rem .4rem;border-radius:4px" onclick="smazatVydaj(${v.id})">🗑</button>`:""}
          </td>
        </tr>`).join("")
        : "<tr><td colspan='10' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné výdaje</td></tr>"}
      </tbody>
      ${data.vydaje.length ? `
      <tfoot><tr class="table-footer">
        <td colspan="7">Celkem (${data.vydaje.length} výdajů)</td>
        <td style="text-align:right"><strong style="color:#dc2626">${czMoney(data.celkem)}</strong></td>
        <td colspan="2"></td>
      </tr></tfoot>` : ""}
    </table>`;
}

function _vydajModal(titul, v, onSave) {
  const polozkyHtml = (v.polozky||[]).map((p,i)=>`
    <tr id="vp_${i}">
      <td><input class="form-control vp-nazev" style="font-size:.85rem" value="${escHtml(p.nazev||'')}" placeholder="Název položky"></td>
      <td><input type="number" step="0.01" class="form-control vp-castka" style="font-size:.85rem;width:110px" value="${p.castka||''}"></td>
      <td><button type="button" onclick="this.closest('tr').remove()" style="background:none;border:none;cursor:pointer;color:#dc2626">✕</button></td>
    </tr>`).join("");

  openModal(titul, `
    <div class="grid-2" style="gap:1rem">
      <div class="form-group"><label class="form-label">Firma *</label>
        <select id="evFirma" class="form-control">
          ${App.config.firmy.map(f=>`<option ${v.firma_zkratka===f?'selected':''}>${f}</option>`).join("")}
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
      <button class="btn btn-primary" onclick="(${onSave.toString()})()">💾 Uložit</button>
    </div>`);
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
    popis:            document.getElementById("evPopis").value,
    poznamka:         document.getElementById("evPoznamka").value,
    polozky,
  };
}

function openVydajRucni() {
  _vydajModal("Nový výdaj", { firma_zkratka: App.config.firmy[0]||"", polozky:[] }, async function() {
    const payload = { ..._vydajGetPayload(), zdroj:"rucni" };
    if (!payload.firma_zkratka || !payload.castka) { toast("Vyplň firmu a částku"); return; }
    await api("/api/vydaje", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
    toast("Výdaj uložen ✓"); closeModal(); loadVydaje(); loadVydajeNezaplacene();
  });
}

async function openVydajEdit(id) {
  const data = await api("/api/vydaje");
  const v = data.vydaje.find(x=>x.id===id);
  if (!v) return;
  _vydajModal("Upravit výdaj", v, async function() {
    const payload = _vydajGetPayload();
    await api(`/api/vydaje/${id}`, { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
    toast("Uloženo ✓"); closeModal(); loadVydaje(); loadVydajeNezaplacene();
  });
}

function openVydajNahrat() {
  openModal("Nahrát doklad výdaje", `
    <div class="form-group" style="margin-bottom:1rem">
      <label class="form-label">Firma</label>
      <select id="vNahratFirma" class="form-control">
        ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
      </select>
    </div>
    <div class="dropzone" id="vydajDropzone" style="padding:1.5rem">
      <div class="dropzone-icon">🧾</div>
      <div class="dropzone-text"><strong>Přetáhněte foto nebo PDF dokladu</strong> nebo klikněte</div>
      <input type="file" id="vydajFileInput" accept="image/*,.pdf">
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
  } catch(e) {
    statusEl.innerHTML = `❌ Chyba: ${e.message}`;
  }
}

async function ulozitVydajZDokladu(soubor_cesta, soubor_url) {
  const payload = {
    firma_zkratka: document.getElementById("vNahratFirma")?.value || "",
    dodavatel:     document.getElementById("vnDodavatel").value,
    datum:         document.getElementById("vnDatum").value,
    castka:        parseFloat(document.getElementById("vnCastka").value||0),
    zpusob_uhrady: document.getElementById("vnUhrada").value,
    popis:         document.getElementById("vnPopis").value,
    stav:          "nezaplaceno",
    soubor_cesta, soubor_url,
    zdroj: "ocr",
    polozky: [],
  };
  if (!payload.firma_zkratka || !payload.castka) { toast("Vyplň firmu a částku"); return; }
  await api("/api/vydaje", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
  toast("Výdaj uložen ✓"); closeModal(); loadVydaje(); loadVydajeNezaplacene();
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
  const c = document.getElementById("vyst-celkem"); if (c) c.textContent = czMoney(celkem) + " Kč";
  const n = document.getElementById("vyst-nezapl"); if (n) n.textContent = czMoney(nezapl) + " Kč";
  const z = document.getElementById("vyst-zapl");   if (z) z.textContent = czMoney(zapl) + " Kč";

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
        <td class="text-right fw-bold">${czMoney(f.castka)} Kč</td>
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
    <span id="vystOcrStatus" style="margin-left:0.5rem;font-size:0.85rem;color:var(--text-muted)"></span>
    <hr>
    <div id="vystFormFields" style="display:none">
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

async function toggleVystStav(id, stavNyni) {
  const novy = stavNyni === "zaplaceno" ? "nezaplaceno" : "zaplaceno";
  await api(`/api/vystavene-faktury/${id}/stav`, {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({stav: novy})});
  loadVystavene();
}

async function smazatVystavenu(id) {
  if (!confirm("Opravdu smazat tuto fakturu?")) return;
  await api(`/api/vystavene-faktury/${id}`, {method:"DELETE"});
  toast("Faktura smazána ✓"); loadVystavene();
}

