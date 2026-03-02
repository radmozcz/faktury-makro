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
};

// ═══════════════════════════════════════════════════════════════
//  Inicializace
// ═══════════════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", async () => {
  loadTheme();
  showDate();
  await loadConfig();
  setupNav();
  setupThemeSwitch();
  setupMobileMenu();
  navigateTo("dashboard");
});

async function loadConfig() {
  const cfg = await api("/api/config");
  App.config = cfg;
  document.getElementById("appNazev").textContent = cfg.app_nazev;
  document.title = cfg.app_nazev;
  fillFirmaSelects();
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
    statistiky: renderStatistiky,
    nastaveni:  renderNastaveni,
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
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
    return r.json();
  } catch (e) {
    toast("Chyba: " + e.message, true);
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
function czDate(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString("cs-CZ");
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
      </select>
      <label>Od:</label><input type="date" id="fOd">
      <label>Do:</label><input type="date" id="fDo">
      <input type="text" id="fQ" placeholder="Hledat dodavatele/č. faktury..." style="min-width:200px">
    </div>
    <div class="card">
      <div class="table-wrap" id="fakturyTable"><div class="loading-center"><span class="spinner"></span></div></div>
    </div>`;

  loadFaktury();

  ["fFirma","fStav","fOd","fDo"].forEach(id => {
    document.getElementById(id)?.addEventListener("change", loadFaktury);
  });
  let qdeb;
  document.getElementById("fQ")?.addEventListener("input", () => {
    clearTimeout(qdeb); qdeb = setTimeout(loadFaktury, 350);
  });
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

  tbl.innerHTML = `
    <table>
      <thead><tr>
        <th>Firma</th><th>Dodavatel</th><th>Č. faktury</th>
        <th>Vystavení</th><th>Splatnost</th><th>Celkem s DPH</th><th>Stav</th>
      </tr></thead>
      <tbody>
        ${data.faktury.map(f => `
          <tr class="faktura-row" data-id="${f.id}">
            <td><span class="badge badge-zaplaceno" style="background:var(--green-pale)">${f.firma_zkratka}</span></td>
            <td>${escHtml(f.dodavatel)}</td>
            <td>${escHtml(f.cislo_faktury||"—")}</td>
            <td>${czDate(f.datum_vystaveni)}</td>
            <td>${czDate(f.datum_splatnosti)}</td>
            <td><strong>${czMoney(f.celkem_s_dph)}</strong></td>
            <td>${stavBadge(f.stav)}</td>
          </tr>`).join("") ||
          "<tr><td colspan='7' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné faktury</td></tr>"}
      </tbody>
      ${data.faktury.length ? `
      <tfoot>
        <tr class="table-footer">
          <td colspan="5">Celkem (${data.faktury.length} faktur)</td>
          <td colspan="2"><strong>${czMoney(data.celkem)}</strong></td>
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
        <div class="form-group"><div class="form-label">Dodavatel</div><strong>${escHtml(f.dodavatel)}</strong></div>
        <div class="form-group"><div class="form-label">Číslo faktury</div>${escHtml(f.cislo_faktury||"—")}</div>
        <div class="form-group"><div class="form-label">Firma</div>${f.firma_zkratka}</div>
        <div class="form-group"><div class="form-label">Zdroj</div>${f.zdroj === "makro" ? "MAKRO (automaticky)" : "Ruční zadání"}</div>
      </div>
      <div>
        <div class="form-group"><div class="form-label">Datum vystavení</div>${czDate(f.datum_vystaveni)}</div>
        <div class="form-group"><div class="form-label">Datum splatnosti</div>${czDate(f.datum_splatnosti)}</div>
        <div class="form-group"><div class="form-label">Způsob úhrady</div>${escHtml(f.zpusob_uhrady||"—")}</div>
        <div class="form-group">
          <div class="form-label">Stav</div>
          <select id="detailStav" class="form-control" style="max-width:200px">
            <option value="ceka" ${f.stav==="ceka"?"selected":""}>Čeká na zaplacení</option>
            <option value="zaplaceno" ${f.stav==="zaplaceno"?"selected":""}>Zaplaceno</option>
            <option value="po_splatnosti" ${f.stav==="po_splatnosti"?"selected":""}>Po splatnosti</option>
          </select>
        </div>
      </div>
    </div>
    ${f.soubor_cesta ? `<div style="margin-bottom:1rem"><a href="/uploads/${f.soubor_cesta}" target="_blank" class="btn btn-secondary btn-sm">📎 Zobrazit originál</a></div>` : ""}
    <h4 style="font-family:var(--font-head);margin-bottom:.7rem">Položky</h4>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Název</th><th>Množství</th><th>Jednotka</th><th>Cena/jedn.</th><th>Celkem s DPH</th></tr></thead>
        <tbody>
          ${polozky.map(p => `
            <tr>
              <td>${escHtml(p.zbozi_nazev || p.nazev)}</td>
              <td>${Number(p.mnozstvi).toLocaleString("cs-CZ")}</td>
              <td>${p.jednotka}</td>
              <td>${czMoney(p.cena_za_jednotku_s_dph)}</td>
              <td><strong>${czMoney(p.celkem_s_dph)}</strong></td>
            </tr>`).join("") || "<tr><td colspan='5' style='text-align:center;color:var(--txt2)'>Žádné položky</td></tr>"}
        </tbody>
        ${polozky.length ? `
        <tfoot>
          <tr class="table-footer">
            <td colspan="4">Celkem s DPH</td>
            <td><strong>${czMoney(f.celkem_s_dph)}</strong></td>
          </tr>
        </tfoot>` : ""}
      </table>
    </div>
    <div class="btn-group" style="margin-top:1rem">
      <button class="btn btn-primary" onclick="saveStav(${f.id})">💾 Uložit stav</button>
      <button class="btn btn-danger btn-sm" onclick="deleteFaktura(${f.id})">🗑 Smazat</button>
    </div>`;

  openModal(`Faktura – ${escHtml(f.dodavatel)} ${czDate(f.datum_vystaveni)}`, body);
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
  dz.addEventListener('click', () => inp.click());
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

  dz.addEventListener("click", () => inp.click());
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

function naplnFormular(data, appendMode = false) {
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
    const warn = document.createElement("div");
    warn.id = "duplicitaWarning";
    warn.style.cssText = "background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:.7rem 1rem;margin-bottom:1rem;color:#856404;font-size:.9rem";
    warn.innerHTML = `⚠️ <strong>Tato faktura již existuje!</strong> Faktura č. ${data.cislo_faktury} byla již nahrána (firma ${data.duplicita.firma}, ${data.duplicita.datum}, ${data.duplicita.celkem} Kč). Opravdu chceš uložit znovu?`;
    document.getElementById("parsedForm").insertAdjacentElement("afterbegin", warn);
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
//  ZBOŽÍ / POLOŽKY – se sortováním
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
    </div>
    <div class="card">
      <div class="table-wrap" id="polozkyList"><div class="loading-center"><span class="spinner"></span></div></div>
    </div>`;

  loadPolozky();
  ["pFirma","pOd","pDo"].forEach(id => {
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
  const sorted = [...App.polozkyData].sort((a, b) => {
    let va = a[col], vb = b[col];
    if (typeof va === "string") va = va.toLowerCase();
    if (typeof vb === "string") vb = vb.toLowerCase();
    if (va < vb) return asc ? -1 : 1;
    if (va > vb) return asc ? 1 : -1;
    return 0;
  });

  const arrow = (c) => col === c ? (asc ? " ▲" : " ▼") : " ⇅";
  const th = (c, label) =>
    `<th style="cursor:pointer;user-select:none" onclick="sortPolozky('${c}')">${label}${arrow(c)}</th>`;

  el.innerHTML = `
    <table>
      <thead><tr>
        ${th("zbozi_nazev","Zboží")}
        ${th("jednotka","Jedn.")}
        ${th("celkove_mnozstvi","Celk. množství")}
        ${th("celkem_utraceno","Celkem s DPH")}
        ${th("prumerna_cena","Průměrná cena/jedn.")}
        ${th("pocet_nakupu","Nákupů")}
        <th>Dodavatelé</th>
      </tr></thead>
      <tbody>
        ${sorted.map(r => `
          <tr class="zbozi-row" data-id="${r.zbozi_id||""}" data-nazev="${escHtml(r.zbozi_nazev)}">
            <td><strong>${escHtml(r.zbozi_nazev)}</strong></td>
            <td>${r.jednotka}</td>
            <td>${Number(r.celkove_mnozstvi).toLocaleString("cs-CZ")}</td>
            <td><strong>${czMoney(r.celkem_utraceno)}</strong></td>
            <td>${czMoney(r.prumerna_cena)}</td>
            <td style="text-align:center"><span class="badge badge-zaplaceno">${r.pocet_nakupu}</span></td>
            <td style="font-size:.82rem;color:var(--txt2)">${escHtml(r.dodavatele||"")}</td>
          </tr>`).join("") ||
          "<tr><td colspan='7' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné položky</td></tr>"}
      </tbody>
    </table>`;

  document.querySelectorAll(".zbozi-row").forEach(r => {
    r.addEventListener("click", () => {
      if (r.dataset.id) openZboziDetail(r.dataset.id, r.dataset.nazev);
    });
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
            <tr>
              <td>${czDate(n.datum_vystaveni)}</td>
              <td>${escHtml(n.dodavatel)}</td>
              <td>${n.firma_zkratka}</td>
              <td>${Number(n.mnozstvi).toLocaleString("cs-CZ")} ${n.jednotka}</td>
              <td>${czMoney(n.cena_za_jednotku_s_dph)}</td>
              <td><strong>${czMoney(n.celkem_s_dph)}</strong></td>
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
      <div class="btn-group">
        <button class="btn btn-primary btn-sm" onclick="openNovVyplata()">+ Nová výplata</button>
        <button class="btn btn-secondary btn-sm" onclick="exportVyplaty('xlsx')">⬇ Excel</button>
        <button class="btn btn-secondary btn-sm" onclick="exportVyplaty('csv')">⬇ CSV</button>
      </div>
    </div>
    <div class="filters">
      <label>Firma:</label>
      <select id="vFirma" class="firma-select">
        <option value="">Všechny</option>
        ${App.config.firmy.map(f=>`<option>${f}</option>`).join("")}
      </select>
      <label>Od:</label><input type="date" id="vOd">
      <label>Do:</label><input type="date" id="vDo">
    </div>
    <div class="card">
      <div class="table-wrap" id="vyplatyList"><div class="loading-center"><span class="spinner"></span></div></div>
    </div>`;

  loadVyplaty();
  ["vFirma","vOd","vDo"].forEach(id => {
    document.getElementById(id)?.addEventListener("change", loadVyplaty);
  });
}

async function loadVyplaty() {
  const params = new URLSearchParams({
    firma: document.getElementById("vFirma")?.value||"",
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
            <td><span class="badge badge-zaplaceno" style="background:var(--green-pale)">${escHtml(v.firma_zkratka||"—")}</span></td>
            <td><strong>${escHtml(v.jmeno)}</strong></td>
            <td>${czDate(v.datum)}</td>
            <td><strong>${czMoney(v.castka)}</strong></td>
            <td style="color:var(--txt2);font-size:.88rem">${escHtml(v.poznamka||"")}</td>
            <td>
              <button class="btn btn-secondary btn-sm" onclick="editVyplata(${v.id},'${escHtml(v.jmeno)}','${v.datum}',${v.castka},'${escHtml(v.poznamka||"")}','${escHtml(v.firma_zkratka||"")}')">✏️</button>
              <button class="btn btn-danger btn-sm" onclick="deleteVyplata(${v.id})">🗑</button>
            </td>
          </tr>`).join("") ||
          "<tr><td colspan='6' style='text-align:center;color:var(--txt2);padding:2rem'>Žádné výplaty</td></tr>"}
      </tbody>
      ${data.vyplaty.length ? `
      <tfoot>
        <tr class="table-footer">
          <td colspan="3">Celkem (${data.vyplaty.length} výplat)</td>
          <td colspan="3"><strong>${czMoney(data.celkem)}</strong></td>
        </tr>
      </tfoot>` : ""}
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
        <input id="vJmeno" class="form-control" value="${escHtml(v.jmeno||"")}" placeholder="Jméno zaměstnance">
      </div>
      <div class="form-group"><label class="form-label">Datum *</label>
        <input type="date" id="vDatum" class="form-control" value="${v.datum||new Date().toISOString().split('T')[0]}">
      </div>
      <div class="form-group"><label class="form-label">Částka (Kč) *</label>
        <input type="number" step="0.01" id="vCastka" class="form-control" value="${v.castka||""}">
      </div>
    </div>
    <div class="form-group"><label class="form-label">Poznámka</label>
      <input id="vPoznamka" class="form-control" value="${escHtml(v.poznamka||"")}" placeholder="Volitelná poznámka">
    </div>`;
}

function openNovVyplata() {
  openModal("Nová výplata", `
    ${vyplataFormHtml()}
    <div class="btn-group" style="margin-top:1rem">
      <button class="btn btn-primary" onclick="ulozitVyplatu()">💾 Uložit</button>
    </div>`);
}

function editVyplata(id, jmeno, datum, castka, poznamka, firma_zkratka) {
  openModal("Upravit výplatu", `
    ${vyplataFormHtml({jmeno, datum, castka, poznamka, firma_zkratka})}
    <div class="btn-group" style="margin-top:1rem">
      <button class="btn btn-primary" onclick="ulozitVyplatuEdit(${id})">💾 Uložit změny</button>
    </div>`);
}

async function ulozitVyplatu() {
  const jmeno  = document.getElementById("vJmeno").value.trim();
  const datum  = document.getElementById("vDatum").value;
  const castka = parseFloat(document.getElementById("vCastka").value);
  if (!jmeno || !datum || isNaN(castka)) { toast("Vyplňte jméno, datum a částku", true); return; }

  await api("/api/vyplaty", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      jmeno, datum, castka,
      poznamka: document.getElementById("vPoznamka").value,
      firma_zkratka: document.getElementById("vFirmaF").value,
    })
  });
  toast("Výplata uložena ✓");
  closeModal();
  loadVyplaty();
}

async function ulozitVyplatuEdit(id) {
  const jmeno  = document.getElementById("vJmeno").value.trim();
  const datum  = document.getElementById("vDatum").value;
  const castka = parseFloat(document.getElementById("vCastka").value);
  if (!jmeno || !datum || isNaN(castka)) { toast("Vyplňte jméno, datum a částku", true); return; }

  await api(`/api/vyplaty/${id}`, {
    method:"PUT", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      jmeno, datum, castka,
      poznamka: document.getElementById("vPoznamka").value,
      firma_zkratka: document.getElementById("vFirmaF").value,
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
      <label>Od:</label><input type="date" id="sOd" value="${odStr}">
      <label>Do:</label><input type="date" id="sDo" value="${doStr}">
      <button class="btn btn-primary btn-sm" onclick="loadStatistiky()">Zobrazit</button>
    </div>
    <div id="statContent"><div class="loading-center"><span class="spinner"></span></div></div>`;

  loadStatistiky();
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
      <button class="btn btn-primary" onclick="saveConfig()">💾 Uložit nastavení</button>
    </div>`;
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
    body: JSON.stringify({ app_nazev: nazev, firmy, ico_map })
  });
  await loadConfig();
  toast("Nastavení uloženo ✓");
}

// ═══════════════════════════════════════════════════════════════
//  Util
// ═══════════════════════════════════════════════════════════════
function escHtml(s) {
  return String(s||"")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
