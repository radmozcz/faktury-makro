"""
Aplikace pro správu přijatých faktur
Spuštění: python app.py
"""

import os
import json
import sqlite3
import csv
import io
import re
from datetime import datetime, date, timedelta
from flask import Flask, render_template, request, jsonify, send_file, redirect, url_for, send_from_directory
from werkzeug.utils import secure_filename
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

# ── Pokus o načtení OCR knihoven (nepovinné) ──────────────────────────────────
try:
    import pdfplumber
    PDF_SUPPORT = True
except ImportError:
    PDF_SUPPORT = False
    print("⚠  pdfplumber není nainstalován – PDF parsing nebude fungovat")

try:
    import pytesseract
    from PIL import Image
    # Nastav cestu k Tesseract pro Windows
    import os as _os
    _tess_path = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    if _os.path.exists(_tess_path):
        pytesseract.pytesseract.tesseract_cmd = _tess_path
    OCR_SUPPORT = True
except ImportError:
    OCR_SUPPORT = False
    print("⚠  pytesseract/Pillow není nainstalován – OCR obrázků nebude fungovat")

# ── Konfigurace ──────────────────────────────────────────────────────────────
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
DB_PATH     = os.path.join(BASE_DIR, "faktury.db")
UPLOAD_DIR  = os.path.join(BASE_DIR, "uploads")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
ALLOWED_EXT = {"pdf", "png", "jpg", "jpeg", "tiff", "bmp"}

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB

# ── Výchozí konfigurace ───────────────────────────────────────────────────────
DEFAULT_CONFIG = {
    "firmy": ["FP", "MR", "CFF"],
    "app_nazev": "Správa faktur",
    "ico_map": {}   # IČO -> zkratka firmy, např. {"19436521": "FP"}
}

def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return DEFAULT_CONFIG.copy()

def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

# ── Databáze ──────────────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    """Vytvoří databázové tabulky pokud neexistují."""
    with get_db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS faktury (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            firma_zkratka   TEXT    NOT NULL,
            dodavatel       TEXT    NOT NULL,
            cislo_faktury   TEXT,
            datum_vystaveni TEXT,
            datum_splatnosti TEXT,
            zpusob_uhrady   TEXT,
            stav            TEXT    DEFAULT 'ceka',   -- ceka / zaplaceno / po_splatnosti
            celkem_s_dph    REAL    DEFAULT 0,
            soubor_cesta    TEXT,
            zdroj           TEXT    DEFAULT 'rucni',  -- makro / rucni
            created_at      TEXT    DEFAULT (datetime('now','localtime'))
        );

        CREATE TABLE IF NOT EXISTS polozky (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            faktura_id            INTEGER NOT NULL REFERENCES faktury(id) ON DELETE CASCADE,
            nazev                 TEXT    NOT NULL,
            mnozstvi              REAL    DEFAULT 1,
            jednotka              TEXT    DEFAULT 'ks',
            cena_za_jednotku_s_dph REAL   DEFAULT 0,
            celkem_s_dph          REAL    DEFAULT 0,
            zbozi_id              INTEGER REFERENCES zbozi(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS zbozi (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            nazev_canonical  TEXT    NOT NULL UNIQUE,
            poznamka         TEXT
        );

        CREATE TABLE IF NOT EXISTS zbozi_aliasy (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            zbozi_id  INTEGER NOT NULL REFERENCES zbozi(id) ON DELETE CASCADE,
            alias     TEXT    NOT NULL UNIQUE
        );
        """)
    print("✓ Databáze inicializována")

# ── Pomocné funkce ────────────────────────────────────────────────────────────
def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXT

def update_stav_po_splatnosti():
    """Automaticky přepne faktury 'ceka' na 'po_splatnosti' pokud datum splatnosti uplynul."""
    today = date.today().isoformat()
    with get_db() as conn:
        conn.execute("""
            UPDATE faktury SET stav = 'po_splatnosti'
            WHERE stav = 'ceka'
              AND datum_splatnosti IS NOT NULL
              AND datum_splatnosti < ?
        """, (today,))

def recalc_faktura_total(conn, faktura_id):
    """Přepočítá celkovou sumu faktury z položek."""
    row = conn.execute("SELECT SUM(celkem_s_dph) FROM polozky WHERE faktura_id=?", (faktura_id,)).fetchone()
    total = row[0] or 0
    conn.execute("UPDATE faktury SET celkem_s_dph=? WHERE id=?", (total, faktura_id))

# ── MAKRO parser ───────────────────────────────────────────────────────────────
def parse_makro_pdf(filepath):
    """
    Extrahuje data z PDF faktury MAKRO pomocí pdfplumber.
    Faktury MAKRO mají 'spaced' text (mezery mezi každým znakem).
    Parser používá x/y souřadnice slov pro správné oddělení sloupců a čísel.
    """
    if not PDF_SUPPORT:
        return None, "pdfplumber není nainstalován"

    result = {
        "cislo_faktury":   "",
        "datum_vystaveni": "",
        "datum_splatnosti":"",
        "zpusob_uhrady":   "",
        "dodavatel":       "MAKRO Cash & Carry ČR s.r.o.",
        "celkem_s_dph":    0,
        "polozky":         []
    }

    try:
        from collections import defaultdict
        import re as _re

        all_items      = []
        full_text_lines = []

        with pdfplumber.open(filepath) as pdf:
            # Zkontroluj první stránku - odmítni "Súpis tovaru" (interní doklad MAKRO)
            first_text = pdf.pages[0].extract_text() or ""
            first_despaced = _re.sub(r"(?<=\S) (?=\S)", "", first_text)
            if "Súpistovaru" in first_despaced and "FAKTURA" not in first_despaced:
                return None, "Tento soubor je 'Súpis tovaru' (interní doklad MAKRO) – není to daňová faktura. Soubor nebyl nahrán."

            for page in pdf.pages:
                full_text_lines += (page.extract_text() or "").splitlines()
                words = page.extract_words(x_tolerance=1, y_tolerance=2)

                # Seskup slova do řádků
                rows = defaultdict(list)
                for w in words:
                    y = round(w["top"] / 2) * 2
                    rows[y].append(w)

                for y, ws in sorted(rows.items()):
                    ws = sorted(ws, key=lambda w: w["x0"])

                    # MM číslo: jednoznakové číslice v oblasti x < 95
                    left_digits = "".join(
                        w["text"] for w in ws
                        if w["x0"] < 95 and len(w["text"]) == 1 and w["text"].isdigit()
                    )

                    # Jednotka: spaced znaky v oblasti x 238–265
                    unit_chars = "".join(
                        w["text"] for w in ws
                        if 238 <= w["x0"] <= 265 and len(w["text"]) == 1
                        and w["text"].upper() in "PCGKBSL"
                    ).upper()
                    if   unit_chars.startswith("PC"): jed = "PC"
                    elif unit_chars.startswith("KG"): jed = "KG"
                    elif unit_chars.startswith("BG"): jed = "BG"
                    elif unit_chars.startswith("KS"): jed = "KS"
                    elif unit_chars.startswith("L"):  jed = "L"
                    else:                              jed = ""

                    # Sleva
                    all_text_j = "".join(w["text"] for w in ws).lower()
                    is_sleva = "urcenopro" in all_text_j or "kupvice" in all_text_j or "kupvíce" in all_text_j
                    if is_sleva and all_items:
                        right_text = "".join(w["text"] for w in sorted(
                            [w for w in ws if w["x0"] > 265], key=lambda w: w["x0"]
                        ))
                        neg = re.findall(r"-?(\d+,\d{2})", right_text)
                        if neg:
                            sleva = _parse_money(neg[-1])
                            all_items[-1]["celkem_s_dph"] = round(max(0, all_items[-1]["celkem_s_dph"] - sleva), 2)
                            mn = all_items[-1]["mnozstvi"]
                            if mn:
                                all_items[-1]["cena_za_jednotku_s_dph"] = round(all_items[-1]["celkem_s_dph"] / mn, 4)
                        continue

                    if len(left_digits) < 6 or not jed:
                        continue

                    # Název: spaced znaky x 90–237, mezera mezi slovy = gap ~3.6px
                    nazev_ws = [w for w in ws if 90 <= w["x0"] <= 237]
                    nazev = _rekonstruuj_nazev(nazev_ws)

                    # Číselné hodnoty z pravé části x > 265
                    right_ws = sorted([w for w in ws if w["x0"] > 265], key=lambda w: w["x0"])
                    cf = _makro_reconstruct_numbers(right_ws)

                    if len(cf) < 2:
                        continue

                    # DPH sazba = poslední celé číslo <= 25
                    if cf and cf[-1] == int(cf[-1]) and cf[-1] <= 25:
                        idx_dph = len(cf) - 1
                    else:
                        idx_dph = len(cf)

                    idx_celkem_s = idx_dph - 1
                    idx_pocet    = idx_dph - 3

                    celkem_s_dph = cf[idx_celkem_s] if 0 <= idx_celkem_s < len(cf) else 0
                    pocet        = cf[idx_pocet]    if 0 <= idx_pocet    < len(cf) else 1.0
                    if pocet <= 0 or pocet > 10000:
                        pocet = 1.0
                    cena_j = round(celkem_s_dph / pocet, 4) if pocet else celkem_s_dph

                    if not nazev or celkem_s_dph <= 0:
                        continue

                    all_items.append({
                        "nazev":                  nazev,
                        "mnozstvi":               pocet,
                        "jednotka":               _map_unit(jed),
                        "cena_za_jednotku_s_dph": cena_j,
                        "celkem_s_dph":           round(celkem_s_dph, 2)
                    })

        result["polozky"] = all_items

        # Parsování hlavičky
        def despace(s):
            return re.sub(r"(?<=\S) (?=\S)", "", s)

        ico_odberatele = ""
        for line in full_text_lines:
            dl = despace(line)
            if not result["cislo_faktury"]:
                # Typ B: "Faktura č. / VS : 0415000258"
                m = re.search(r"Faktura.*?VS.*?:?\s*(\d{7,12})", dl, re.IGNORECASE)
                if m: result["cislo_faktury"] = m.group(1)
            if not result["cislo_faktury"]:
                # Typ A: "Súpis tovaru 0418907791" - hotovostní nákup bez VS
                m = re.search(r"Súpistovaru\s*(\d{7,12})", dl, re.IGNORECASE)
                if m: result["cislo_faktury"] = m.group(1)
            if not result["cislo_faktury"]:
                # Technické ID jako záloha: (189-020343 7/0/0189/007791)
                m = re.search(r"TechnickéID.*?/(\d{7,12})\)", dl, re.IGNORECASE)
                if m: result["cislo_faktury"] = m.group(1)
            # IČO odběratele
            if not ico_odberatele:
                m = re.search(r"IČ\s*:\s*(\d{8})", dl)
                if m: ico_odberatele = m.group(1)
            if not result["datum_vystaveni"]:
                m = re.search(r"vystavení.*?(\d{2}-\d{2}-\d{4})", dl, re.IGNORECASE)
                if m: result["datum_vystaveni"] = _makro_date(m.group(1))
            if not result["datum_splatnosti"]:
                m = re.search(r"splatnosti.*?(\d{2}-\d{2}-\d{4})", dl, re.IGNORECASE)
                if m: result["datum_splatnosti"] = _makro_date(m.group(1))
            if not result["zpusob_uhrady"]:
                m = re.search(r"Způsobúhrady:?\s*([A-Za-záéíóúýžšČřďťňÁÉÍÓÚÝŽŠČŘĎŤŇ]+(?:\s+[A-Za-záéíóúýžšČřďťňÁÉÍÓÚÝŽŠČŘĎŤŇ]+)?)", dl, re.IGNORECASE)
                if m:
                    u = m.group(1).strip()
                    if u and u.lower() not in ("praha", "pruhonice", "chudenicka", ""):
                        result["zpusob_uhrady"] = u
            if "Celková" in line and "částka" in line:
                nums = re.findall(r"[\d ]+,\d{2}", line)
                if nums: result["celkem_s_dph"] = _parse_money(nums[-1])
            # "Celková částka 2 172,08" formát
            m_celk = re.search(r"Celkováčástka\s+([\d\s]+[,\.][\d]{2})", despace(line))
            if m_celk and result["celkem_s_dph"] == 0:
                result["celkem_s_dph"] = _parse_money(m_celk.group(1))

        if result["celkem_s_dph"] == 0 and all_items:
            result["celkem_s_dph"] = round(sum(p["celkem_s_dph"] for p in all_items), 2)

        # MAKRO faktury jsou vždy placeny hotovostí na místě
        result["zpusob_uhrady"] = "Hotovost"
        result["stav"] = "zaplaceno"

        # Auto-rozpoznání firmy podle IČO odběratele
        result["ico_odberatele"] = ico_odberatele
        result["firma_zkratka"] = _ico_na_firmu(ico_odberatele)

        # Přidej mezery do názvů položek
        for p in result["polozky"]:
            p["nazev"] = _format_nazev(p["nazev"])

    except Exception as e:
        return None, str(e)

    return result, None


def _makro_reconstruct_numbers(ws_sorted):
    """Ze spaced znaků rekonstruuje čísla. Skupiny oddělené mezerou > 8px jsou různá čísla."""
    if not ws_sorted:
        return []
    groups = []
    current = [ws_sorted[0]]
    for prev, curr in zip(ws_sorted, ws_sorted[1:]):
        gap = curr["x0"] - prev["x0"] - 3.5
        if gap > 8:
            groups.append(current)
            current = [curr]
        else:
            current.append(curr)
    groups.append(current)
    numbers = []
    for g in groups:
        token = "".join(w["text"] for w in g).replace(",", ".")
        # Přeskoč kódy akcí (5+ číslic bez desetinné tečky, např. 38392, 90224, 62892)
        if re.match(r"^\d{5,}$", token):
            continue
        # Přeskoč písmena (P, X, S) a kombinace jako "PX"
        if re.match(r"^[A-Za-z]+$", token):
            continue
        try:
            numbers.append(float(token))
        except Exception:
            pass
    return numbers


def _rekonstruuj_nazev(nazev_ws):
    """
    Rekonstruuje název z jednotlivých znaků pomocí x-souřadnic.
    Mezera mezi slovy v MAKRO PDF = gap ~3.6px mezi koncem znaku a začátkem dalšího.
    """
    if not nazev_ws:
        return ""
    result = ""
    for i, w in enumerate(nazev_ws):
        if i > 0:
            gap = w["x0"] - nazev_ws[i-1]["x1"]
            if gap > 2.5:   # mezera mezi slovy
                result += " "
        result += w["text"]
    return result.lstrip("*").strip()


def _format_nazev(nazev):
    """Fallback pro text parsovaný bez souřadnic (Ctrl+V text)."""
    result = re.sub(r"  +", " ", nazev).strip()
    return result


def _ico_na_firmu(ico):
    """Vrátí zkratku firmy podle IČO odběratele. Doplň IČO svých firem v config.json."""
    try:
        import json, os
        cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
        with open(cfg_path) as f:
            cfg = json.load(f)
        ico_map = cfg.get("ico_map", {})
        return ico_map.get(ico, "")
    except Exception:
        return ""


def _makro_date(s):
    """Převede DD-MM-YYYY → YYYY-MM-DD."""
    s = s.replace("-", ".")
    try:
        return datetime.strptime(s, "%d.%m.%Y").strftime("%Y-%m-%d")
    except Exception:
        return s


def _parse_makro_items(lines):
    """Záložní funkce – parse_makro_pdf nyní používá word extraction."""
    return []



def _ocr_best_orientation(img):
    """Zkusí 4 rotace a vrátí text s nejvíce rozpoznanými slovy (nejvyšší důvěryhodnost)."""
    best_text = ""
    best_score = 0
    for angle in [0, 90, 180, 270]:
        rotated = img.rotate(angle, expand=True) if angle else img
        for lang in ["ces+eng", "ces", "eng"]:
            try:
                text = pytesseract.image_to_string(rotated, lang=lang,
                    config="--psm 6 --oem 3")
                # Skóre = počet výskytů klíčových MAKRO slov
                score = sum(text.count(kw) for kw in [
                    "MAKRO", "Faktura", "Datum", "DPH", "Kč", "PC", "KG", "BG",
                    "splatnosti", "vystavení", "Food Plus", "Odběratel"
                ])
                if score > best_score:
                    best_score = score
                    best_text = text
                break
            except Exception:
                continue
    return best_text


def parse_makro_image(filepath):
    """OCR obrázku faktury / účtenky pomocí Tesseract s automatickou rotací."""
    if not OCR_SUPPORT:
        return None, "pytesseract/Pillow není nainstalován"
    try:
        img = Image.open(filepath)

        # Preprocessing: převed na šedotón a zvětši pro lepší OCR
        img = img.convert("L")
        w, h = img.size
        # Pokud je obrázek na šířku (fotka otočená), zkus automatickou rotaci
        needs_rotation_check = (w > h * 1.2) or (h > w * 1.2)
        if w < 1200:
            scale = 1200 / w
            img = img.resize((int(w*scale), int(h*scale)), Image.LANCZOS)

        if needs_rotation_check:
            text = _ocr_best_orientation(img)
        else:
            for lang in ["ces+eng", "ces", "eng"]:
                try:
                    text = pytesseract.image_to_string(img, lang=lang,
                        config="--psm 6 --oem 3")
                    break
                except Exception:
                    continue

        lines = text.splitlines()
        # DEBUG: vypiš OCR text do konzole
        print("="*60)
        print("OCR TEXT:")
        for l in lines:
            if l.strip(): print(repr(l))
        print("="*60)
        result = {
            "cislo_faktury":   "",
            "datum_vystaveni": "",
            "datum_splatnosti":"",
            "zpusob_uhrady":   "Hotovost",
            "stav":            "zaplaceno",
            "dodavatel":       "MAKRO Cash & Carry ČR s.r.o.",
            "celkem_s_dph":    0,
            "firma_zkratka":   "",
            "polozky":         []
        }

        # Parsuj hlavičku z OCR textu
        for line in lines:
            ls = line.strip()
            if not result["cislo_faktury"]:
                # Normalizuj OCR text: odstraň mezery v číslici VS
                # Tesseract čte ":" jako ";" nebo vynechá
                m = re.search(r"Faktura.*?[Vv][Ss]\s*[;:,.]?\s*([\d\s]{7,15})", ls, re.IGNORECASE)
                if m:
                    vs = re.sub(r"\s+", "", m.group(1))[:12]
                    if vs.isdigit() and len(vs) >= 7: result["cislo_faktury"] = vs
            m = re.search(r"(\d{2})[.\-](\d{2})[.\-](\d{4})", ls)
            if m:
                den, mes, rok = m.group(1), m.group(2), m.group(3)
                # Oprav typické OCR záměny v měsíci (8→0, musí být 01-12)
                if int(mes) > 12:
                    mes = mes.replace("8", "0")
                try:
                    from datetime import datetime
                    datetime(int(rok), int(mes), int(den))
                    d = f"{rok}-{mes}-{den}"
                    if not result["datum_vystaveni"]: result["datum_vystaveni"] = d
                    elif not result["datum_splatnosti"]: result["datum_splatnosti"] = d
                except Exception:
                    pass
            if not result["zpusob_uhrady"] or result["zpusob_uhrady"] == "Hotovost":
                if "Platba kartou" in ls or "platba kartou" in ls:
                    result["zpusob_uhrady"] = "Platba kartou"
            # IČO odběratele pro auto-firmu
            if not result["firma_zkratka"]:
                m = re.search(r"IČ\s*:\s*(\d{8})", ls)
                if m: result["firma_zkratka"] = _ico_na_firmu(m.group(1))
            # Celková částka (s DPH)
            m = re.search(r"Celkov[aá]\s+[čc][aá]stka\s+([\d\s]+[,.]\d{2})", ls, re.IGNORECASE)
            if m: result["celkem_s_dph"] = _parse_money(m.group(1))
            # "Strana celkem bez DPH X" -> přepočítej na s DPH (orientačně, pro kontrolu)
            # "Strana celkem bez DPH" - různé OCR varianty
            m2 = re.search(r"[Ss]trana.{0,10}celkem.{0,10}bez.{0,5}DPH.{0,5}([\d\s]+[,.]\d{2})", ls, re.IGNORECASE)
            if m2 and not result.get("ocr_strana_celkem_bez_dph"):
                result["ocr_strana_celkem_bez_dph"] = _parse_money(m2.group(1))
            # Alternativa: "celkem bez DPH X" na konci řádku
            m3 = re.search(r"celkem\s+bez\s+DPH\s+([\d\s]+[,.]\d{2})", ls, re.IGNORECASE)
            if m3 and not result.get("ocr_strana_celkem_bez_dph"):
                result["ocr_strana_celkem_bez_dph"] = _parse_money(m3.group(1))

        # Parsuj položky z OCR textu
        result["polozky"] = _parse_ocr_items(lines)

        # Spočítej součet položek
        suma_polozek = round(sum(p["celkem_s_dph"] for p in result["polozky"]), 2)

        if result["celkem_s_dph"] == 0:
            result["celkem_s_dph"] = suma_polozek

        # Vždy přidej ocr_kontrola pro zobrazení stavu v UI
        ocr_bez = result.get("ocr_strana_celkem_bez_dph", 0)
        podezrele = [i for i, p in enumerate(result["polozky"])
                     if p["celkem_s_dph"] == 0 or p["mnozstvi"] > 500]
        result["ocr_kontrola"] = {
            "suma_polozek": suma_polozek,
            "ocr_bez_dph": ocr_bez,
            "ma_celkem": ocr_bez > 0,
            "podezrele_indexy": podezrele,
        }

        return result, None
    except Exception as e:
        return None, str(e)


def _parse_ocr_items(lines):
    """
    Parsuje položky z OCR textu MAKRO faktury (z fotky).
    Formát řádku: MM_číslo NÁZEV JEDNOTKA cena_j počet_bal celkem_bal počet_MU celkem_bez celkem_s_DPH DPH
    """
    items = []
    sleva_kw = ["urceno pro konecnou", "určeno pro konečnou", "kup vice", "kup více"]
    # Rozšíř sadu jednotek o typické OCR záměny
    jednotky = {"PC", "KG", "BG", "KS", "BX", "CA", "SW", "BT",
                "B6", "86", "PG", "6G", "BQ", "BC", "2B", "CA"}
    # Mapa OCR záměn -> správná jednotka
    jednotka_map = {"B6": "BG", "86": "BG", "PG": "PC", "6G": "BG",
                    "BQ": "BG", "BC": "BX", "2B": "BG"}

    for line in lines:
        ls = line.strip()
        if not ls: continue
        ll = ls.lower()

        # Sleva - řádek bez MM čísla, obsahuje záporné číslo
        is_sleva = any(kw in ll for kw in sleva_kw)
        if is_sleva and items:
            # Najdi zápornou hodnotu celkem s DPH (předposlední nebo poslední číslo)
            nums = re.findall(r"-\s*(\d[\d\s]*[,.]\d{2})", ls)
            if nums:
                sleva = _parse_money(nums[-1])
                items[-1]["celkem_s_dph"] = round(max(0, items[-1]["celkem_s_dph"] - sleva), 2)
                mn = items[-1]["mnozstvi"]
                if mn: items[-1]["cena_za_jednotku_s_dph"] = round(items[-1]["celkem_s_dph"] / mn, 4)
            continue

        # Hledej řádek položky - musí začínat MM číslem (6-14 číslic)
        # Tesseract občas přečte 9->S, 0->O, 1->|, přidá pomlčku před název
        ls_clean = re.sub(r"^[Ss|lIG]+(?=\d)", "", ls)   # S/s/|/l/I/G na začátku před číslicí
        ls_clean = re.sub(r"^[|l]\s+", "", ls_clean)      # | nebo l na začátku s mezerou
        m = re.match(r"^(\d{6,14})\s+[\*\-—–|]*\s*(.+)", ls_clean)
        if not m: continue

        # Odstraň | z názvu (OCR artefakt)
        # zpracujeme dále

        rest_after_mm = m.group(2).strip().lstrip("*").strip()

        # Najdi jednotku (PC/KG/BG atd.) - je za názvem
        jednotka = ""
        nazev = rest_after_mm
        cisla_str = ""

        for jed in jednotky:
            # Hledej jednotku obklopenou mezerami
            pat = r"^(.+?)\s+" + jed + r"\s+(.+)$"
            mj = re.match(pat, rest_after_mm, re.IGNORECASE)
            if mj:
                nazev    = mj.group(1).strip().rstrip("*").strip()
                jednotka = jednotka_map.get(jed, jed)
                cisla_str = mj.group(2)
                break

        if not jednotka:
            # Zkus najít jednotku kdekoliv v řádku
            mj = re.search(r"\s(PC|KG|BG|KS|BX|CA|SW|BT)\s", rest_after_mm, re.IGNORECASE)
            if mj:
                jednotka = mj.group(1).upper()
                nazev    = rest_after_mm[:mj.start()].strip().rstrip("*")
                cisla_str = rest_after_mm[mj.end():]

        if not cisla_str:
            cisla_str = rest_after_mm

        # Extrahuj čísla - ignoruj kódy akcí (5+ číslic celé číslo)
        # Oprav OCR záměnu: "4, 684" nebo "4 ,684" -> "4,684"
        cisla_str = re.sub(r"(\d+)[,\.](\s+)(\d+)", r"\1.\3", cisla_str)
        cisla_raw = re.findall(r"\d+[,.]\d+|\d+", cisla_str)
        cf = []
        for c in cisla_raw:
            try:
                val = float(c.replace(",", "."))
                if val == int(val) and val >= 10000:
                    continue  # kód akce
                cf.append(val)
            except:
                pass

        if len(cf) < 2: continue

        # Najdi DPH sazbu (6, 10, 15, 23) od konce
        idx_dph = None
        for i in range(len(cf)-1, -1, -1):
            if cf[i] in (6.0, 10.0, 15.0, 23.0):
                idx_dph = i
                break
        if idx_dph is None: idx_dph = len(cf)

        # Detekce tisícového čísla: "1 258,07" → cf[idx_dph-2]=1, cf[idx_dph-1]=258.07
        # Podmínka: předposledního >= 100 A ante-předposledního je celé číslo 1-9
        if (idx_dph >= 2 and
                cf[idx_dph-1] >= 100 and
                cf[idx_dph-2] == int(cf[idx_dph-2]) and
                1 <= cf[idx_dph-2] <= 9):
            celkem = round(cf[idx_dph-2] * 1000 + cf[idx_dph-1], 2)
            pocet  = cf[idx_dph-5] if idx_dph >= 5 else 1.0
        else:
            celkem = cf[idx_dph-1] if idx_dph >= 1 else 0
            pocet  = cf[idx_dph-3] if idx_dph >= 3 else 1.0

        if pocet <= 0 or pocet > 10000: pocet = 1.0
        cena_j = round(celkem / pocet, 4) if pocet else celkem

        nazev = re.sub(r"^[|\-—–\s]+", "", nazev).strip()
        if not nazev or celkem <= 0: continue

        items.append({
            "nazev":                  _format_nazev(nazev),
            "mnozstvi":               pocet,
            "jednotka":               _map_unit(jednotka) if jednotka else "ks",
            "cena_za_jednotku_s_dph": cena_j,
            "celkem_s_dph":           round(celkem, 2)
        })
    return items


def _cz_date(s):
    """Převede DD.MM.YYYY → YYYY-MM-DD pro uložení do DB."""
    try:
        return datetime.strptime(s, "%d.%m.%Y").strftime("%Y-%m-%d")
    except Exception:
        return s

def _parse_money(s):
    """Převede '1 234,56' nebo '1234.56' → float."""
    s = str(s).replace(" ", "").replace(".", "").replace(",", ".")
    try:
        return float(s)
    except Exception:
        return 0.0

def _map_unit(u):
    mapping = {"PC": "ks", "KS": "ks", "KG": "kg", "BG": "bal", "L": "l", "BG": "bal"}
    return mapping.get(u.upper(), u.lower())


# ═══════════════════════════════════════════════════════════════════════════════
#  ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    update_stav_po_splatnosti()
    return render_template("index.html", config=load_config())

# ── API: konfigurace ──────────────────────────────────────────────────────────
@app.route("/api/config", methods=["GET", "POST"])
def api_config():
    if request.method == "GET":
        return jsonify(load_config())
    data = request.json
    cfg = load_config()
    if "firmy" in data:
        cfg["firmy"] = [f.strip().upper() for f in data["firmy"] if f.strip()]
    if "ico_map" in data:
        cfg["ico_map"] = data["ico_map"]
    if "app_nazev" in data:
        cfg["app_nazev"] = data["app_nazev"]
    save_config(cfg)
    return jsonify({"ok": True})

# ── API: dashboard ────────────────────────────────────────────────────────────
@app.route("/api/dashboard")
def api_dashboard():
    update_stav_po_splatnosti()
    firma = request.args.get("firma", "")
    with get_db() as conn:
        # Tento měsíc
        mesic = date.today().strftime("%Y-%m")
        where_firma = "AND firma_zkratka=?" if firma else ""
        params_base = (firma,) if firma else ()

        row = conn.execute(f"""
            SELECT COUNT(*), COALESCE(SUM(celkem_s_dph),0)
            FROM faktury
            WHERE datum_vystaveni LIKE ? {where_firma}
        """, (mesic + "%",) + params_base).fetchone()
        pocet_mesic, vydaje_mesic = row[0], row[1]

        # Po splatnosti
        row2 = conn.execute(f"""
            SELECT COUNT(*), COALESCE(SUM(celkem_s_dph),0)
            FROM faktury WHERE stav='po_splatnosti' {where_firma}
        """, params_base).fetchone()
        pocet_po_spl, castka_po_spl = row2[0], row2[1]

        # Graf – posledních 12 měsíců
        graf = conn.execute(f"""
            SELECT strftime('%Y-%m', datum_vystaveni) as m, COALESCE(SUM(celkem_s_dph),0)
            FROM faktury
            WHERE datum_vystaveni >= date('now','-12 months') {where_firma}
            GROUP BY m ORDER BY m
        """, params_base).fetchall()

        # Poslední faktury
        posledni = conn.execute(f"""
            SELECT id, dodavatel, cislo_faktury, firma_zkratka, datum_vystaveni,
                   datum_splatnosti, celkem_s_dph, stav
            FROM faktury {('WHERE firma_zkratka=?' if firma else '')}
            ORDER BY created_at DESC LIMIT 5
        """, params_base).fetchall()

    return jsonify({
        "vydaje_mesic": round(vydaje_mesic, 2),
        "pocet_mesic": pocet_mesic,
        "pocet_po_splatnosti": pocet_po_spl,
        "castka_po_splatnosti": round(castka_po_spl, 2),
        "graf": [{"mesic": r[0], "castka": round(r[1], 2)} for r in graf],
        "posledni_faktury": [dict(r) for r in posledni]
    })

# ── API: faktury ──────────────────────────────────────────────────────────────
@app.route("/api/faktury")
def api_faktury():
    firma   = request.args.get("firma", "")
    stav    = request.args.get("stav", "")
    od      = request.args.get("od", "")
    do_     = request.args.get("do", "")
    hledat  = request.args.get("q", "")

    clauses = []
    params  = []
    if firma:
        clauses.append("firma_zkratka=?"); params.append(firma)
    if stav:
        clauses.append("stav=?"); params.append(stav)
    if od:
        clauses.append("datum_vystaveni>=?"); params.append(od)
    if do_:
        clauses.append("datum_vystaveni<=?"); params.append(do_)
    if hledat:
        clauses.append("(dodavatel LIKE ? OR cislo_faktury LIKE ?)")
        params += [f"%{hledat}%", f"%{hledat}%"]

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT id, firma_zkratka, dodavatel, cislo_faktury,
                   datum_vystaveni, datum_splatnosti, celkem_s_dph, stav, zdroj
            FROM faktury {where}
            ORDER BY datum_vystaveni DESC, created_at DESC
        """, params).fetchall()
        total = conn.execute(f"SELECT COALESCE(SUM(celkem_s_dph),0) FROM faktury {where}", params).fetchone()[0]

    return jsonify({
        "faktury": [dict(r) for r in rows],
        "celkem": round(total, 2)
    })

@app.route("/api/faktury/<int:fid>")
def api_faktura_detail(fid):
    with get_db() as conn:
        f = conn.execute("SELECT * FROM faktury WHERE id=?", (fid,)).fetchone()
        if not f:
            return jsonify({"error": "Nenalezeno"}), 404
        polozky = conn.execute("""
            SELECT p.*, z.nazev_canonical as zbozi_nazev
            FROM polozky p
            LEFT JOIN zbozi z ON z.id = p.zbozi_id
            WHERE p.faktura_id=?
        """, (fid,)).fetchall()
    return jsonify({"faktura": dict(f), "polozky": [dict(p) for p in polozky]})

@app.route("/api/faktury/<int:fid>/stav", methods=["POST"])
def api_faktura_stav(fid):
    stav = request.json.get("stav")
    if stav not in ("ceka", "zaplaceno", "po_splatnosti"):
        return jsonify({"error": "Neplatný stav"}), 400
    with get_db() as conn:
        conn.execute("UPDATE faktury SET stav=? WHERE id=?", (stav, fid))
    return jsonify({"ok": True})

@app.route("/api/faktury/<int:fid>", methods=["DELETE"])
def api_faktura_delete(fid):
    with get_db() as conn:
        row = conn.execute("SELECT soubor_cesta FROM faktury WHERE id=?", (fid,)).fetchone()
        conn.execute("DELETE FROM faktury WHERE id=?", (fid,))
    if row and row["soubor_cesta"]:
        path = os.path.join(UPLOAD_DIR, row["soubor_cesta"])
        if os.path.exists(path):
            os.remove(path)
    return jsonify({"ok": True})

@app.route("/api/faktury/<int:fid>", methods=["PUT"])
def api_faktura_update(fid):
    data = request.json
    fields = ["firma_zkratka","dodavatel","cislo_faktury","datum_vystaveni",
              "datum_splatnosti","zpusob_uhrady","stav"]
    set_parts = [f"{f}=?" for f in fields if f in data]
    vals = [data[f] for f in fields if f in data]
    if not set_parts:
        return jsonify({"ok": True})
    vals.append(fid)
    with get_db() as conn:
        conn.execute(f"UPDATE faktury SET {','.join(set_parts)} WHERE id=?", vals)
    return jsonify({"ok": True})

# ── API: nahrání souboru (MAKRO) ─────────────────────────────────────────────
@app.route("/api/nahrat-text", methods=["POST"])
def api_nahrat_text():
    """Parsuje text vložený přes Ctrl+V – hledá strukturu MAKRO faktury."""
    text = request.json.get("text", "")
    if not text.strip():
        return jsonify({"error": "Prázdný text"}), 400

    data = _parse_makro_text(text)
    return jsonify(data)


def _parse_makro_text(text):
    """Parsuje text faktury MAKRO vložený přes schránku."""
    lines = text.splitlines()
    result = {
        "cislo_faktury":   "",
        "datum_vystaveni": "",
        "datum_splatnosti":"",
        "zpusob_uhrady":   "Hotovost",
        "stav":            "zaplaceno",
        "dodavatel":       "MAKRO Cash & Carry ČR s.r.o.",
        "celkem_s_dph":    0,
        "polozky":         []
    }

    items = []
    sleva_kw = ["urceno pro konecnou", "kup vice", "kup více", "věrnostní"]

    for line in lines:
        ls = line.strip()
        if not ls:
            continue
        ll = ls.lower()

        # Hlavička
        m = re.search(r"Faktura\s*[čc\.]\s*/\s*VS\s*:\s*(\S+)", ls, re.IGNORECASE)
        if m and not result["cislo_faktury"]: result["cislo_faktury"] = m.group(1)
        m = re.search(r"Datum\s+vystavení\s*:\s*(\d{2}[-\.]\d{2}[-\.]\d{4})", ls, re.IGNORECASE)
        if m and not result["datum_vystaveni"]: result["datum_vystaveni"] = _makro_date(m.group(1).replace(".", "-") if "." in m.group(1) else m.group(1))
        m = re.search(r"Datum\s+splatnosti\s*:\s*(\d{2}[-\.]\d{2}[-\.]\d{4})", ls, re.IGNORECASE)
        if m and not result["datum_splatnosti"]: result["datum_splatnosti"] = _makro_date(m.group(1).replace(".", "-") if "." in m.group(1) else m.group(1))
        m = re.search(r"Celková\s+částka\s+([\d\s]+[,\.]\d{2})", ls, re.IGNORECASE)
        if m: result["celkem_s_dph"] = _parse_money(m.group(1))

        # Sleva
        is_sleva = any(kw in ll for kw in sleva_kw)
        if is_sleva and items:
            neg = re.findall(r"-\s*(\d[\d\s]*[,\.]\d{2})", ls)
            if neg:
                sleva = _parse_money(neg[-1])
                items[-1]["celkem_s_dph"] = round(max(0, items[-1]["celkem_s_dph"] - sleva), 2)
                mn = items[-1]["mnozstvi"]
                if mn: items[-1]["cena_za_jednotku_s_dph"] = round(items[-1]["celkem_s_dph"] / mn, 4)
            continue

        # Položka - začíná MM číslem
        mm = re.match(r"^(\d{6,14})\s+\*?(.+?)\s+(PC|KG|BG|KS)\s+(.+)$", ls, re.IGNORECASE)
        if not mm: continue

        nazev    = mm.group(2).strip().rstrip("*")
        jednotka = mm.group(3).upper()
        rest     = mm.group(4)

        cisla = re.findall(r"\d+[,\.]\d+|\d+", rest)
        cf = [_parse_money(c) for c in cisla]
        cf = [c for c in cf if c > 0]

        if len(cf) < 2: continue

        if cf[-1] == int(cf[-1]) and cf[-1] <= 25:
            idx_dph = len(cf) - 1
        else:
            idx_dph = len(cf)

        idx_cs  = idx_dph - 1
        idx_mn  = idx_dph - 3
        celkem  = cf[idx_cs] if 0 <= idx_cs < len(cf) else 0
        pocet   = cf[idx_mn] if 0 <= idx_mn < len(cf) else 1.0
        if pocet <= 0 or pocet > 10000: pocet = 1.0
        cena_j  = round(celkem / pocet, 4) if pocet else celkem

        if not nazev or celkem <= 0: continue
        items.append({
            "nazev":                  _format_nazev(nazev),
            "mnozstvi":               pocet,
            "jednotka":               _map_unit(jednotka),
            "cena_za_jednotku_s_dph": cena_j,
            "celkem_s_dph":           round(celkem, 2)
        })

    result["polozky"] = items
    if result["celkem_s_dph"] == 0 and items:
        result["celkem_s_dph"] = round(sum(p["celkem_s_dph"] for p in items), 2)
    return result


@app.route("/api/nahrat", methods=["POST"])
def api_nahrat():
    if "soubor" not in request.files:
        return jsonify({"error": "Žádný soubor"}), 400
    f = request.files["soubor"]
    if not f.filename or not allowed_file(f.filename):
        return jsonify({"error": "Nepodporovaný formát"}), 400

    fname  = secure_filename(f.filename)
    ts     = datetime.now().strftime("%Y%m%d_%H%M%S_")
    fname  = ts + fname
    fpath  = os.path.join(UPLOAD_DIR, fname)
    f.save(fpath)

    ext = fname.rsplit(".", 1)[1].lower()
    if ext == "pdf":
        data, err = parse_makro_pdf(fpath)
    else:
        data, err = parse_makro_image(fpath)

    if err:
        return jsonify({"error": err, "soubor_cesta": fname}), 200

    data["soubor_cesta"] = fname

    # Kontrola duplicit - stejné číslo faktury + dodavatel
    if data.get("cislo_faktury"):
        with get_db() as conn:
            row = conn.execute("""
                SELECT id, firma_zkratka, datum_vystaveni, celkem_s_dph
                FROM faktury
                WHERE cislo_faktury = ? AND dodavatel LIKE '%MAKRO%'
            """, (data["cislo_faktury"],)).fetchone()
            if row:
                data["duplicita"] = {
                    "id": row["id"],
                    "firma": row["firma_zkratka"],
                    "datum": row["datum_vystaveni"],
                    "celkem": row["celkem_s_dph"]
                }

    return jsonify(data)

# ── API: uložení faktury (MAKRO nebo ruční) ───────────────────────────────────
@app.route("/api/faktury", methods=["POST"])
def api_faktura_ulozit():
    data = request.json
    required = ["firma_zkratka", "dodavatel"]
    for r in required:
        if not data.get(r):
            return jsonify({"error": f"Chybí pole: {r}"}), 400

    polozky = data.pop("polozky", [])

    with get_db() as conn:
        cur = conn.execute("""
            INSERT INTO faktury (firma_zkratka, dodavatel, cislo_faktury, datum_vystaveni,
                datum_splatnosti, zpusob_uhrady, stav, celkem_s_dph, soubor_cesta, zdroj)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (
            data.get("firma_zkratka"),
            data.get("dodavatel"),
            data.get("cislo_faktury",""),
            data.get("datum_vystaveni",""),
            data.get("datum_splatnosti",""),
            data.get("zpusob_uhrady",""),
            data.get("stav","ceka"),
            data.get("celkem_s_dph", 0),
            data.get("soubor_cesta",""),
            data.get("zdroj","rucni")
        ))
        faktura_id = cur.lastrowid

        for p in polozky:
            nazev = p.get("nazev","").strip()
            if not nazev:
                continue
            mnozstvi = float(p.get("mnozstvi", 1) or 1)
            celkem   = float(p.get("celkem_s_dph", 0) or 0)
            cena_j   = float(p.get("cena_za_jednotku_s_dph", 0) or 0)
            if cena_j == 0 and mnozstvi:
                cena_j = celkem / mnozstvi
            jed = p.get("jednotka","ks")

            # Slučování zboží – přesná shoda názvu
            zbozi_id = _get_or_create_zbozi(conn, nazev)

            conn.execute("""
                INSERT INTO polozky (faktura_id, nazev, mnozstvi, jednotka,
                    cena_za_jednotku_s_dph, celkem_s_dph, zbozi_id)
                VALUES (?,?,?,?,?,?,?)
            """, (faktura_id, nazev, mnozstvi, jed, round(cena_j,4), round(celkem,2), zbozi_id))

        recalc_faktura_total(conn, faktura_id)

    return jsonify({"ok": True, "id": faktura_id})


def _get_or_create_zbozi(conn, nazev):
    """Vrátí zbozi_id pro daný název (přes alias nebo canonical). Vytvoří nové pokud neexistuje."""
    # Zkus alias
    row = conn.execute("SELECT zbozi_id FROM zbozi_aliasy WHERE alias=?", (nazev,)).fetchone()
    if row:
        return row[0]
    # Zkus canonical
    row = conn.execute("SELECT id FROM zbozi WHERE nazev_canonical=?", (nazev,)).fetchone()
    if row:
        return row[0]
    # Vytvoř nové
    cur = conn.execute("INSERT INTO zbozi (nazev_canonical) VALUES (?)", (nazev,))
    return cur.lastrowid

# ── API: položky / zboží ──────────────────────────────────────────────────────
@app.route("/api/polozky")
def api_polozky():
    firma = request.args.get("firma", "")
    od    = request.args.get("od", "")
    do_   = request.args.get("do", "")

    f_cond = "AND f.firma_zkratka=?" if firma else ""
    od_c   = "AND f.datum_vystaveni>=?" if od else ""
    do_c   = "AND f.datum_vystaveni<=?" if do_ else ""
    params = tuple(v for v in [firma, od, do_] if v)

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT
                COALESCE(z.nazev_canonical, p.nazev) AS zbozi_nazev,
                z.id AS zbozi_id,
                p.jednotka,
                ROUND(SUM(p.mnozstvi),3)            AS celkove_mnozstvi,
                ROUND(SUM(p.celkem_s_dph),2)        AS celkem_utraceno,
                ROUND(AVG(p.cena_za_jednotku_s_dph),4) AS prumerna_cena,
                COUNT(DISTINCT p.faktura_id)        AS pocet_nakupu,
                GROUP_CONCAT(DISTINCT f.dodavatel)  AS dodavatele
            FROM polozky p
            JOIN faktury f ON f.id = p.faktura_id
            LEFT JOIN zbozi z ON z.id = p.zbozi_id
            WHERE 1=1 {f_cond} {od_c} {do_c}
            GROUP BY COALESCE(z.id, p.nazev)
            ORDER BY celkem_utraceno DESC
        """, params).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/polozky/detail/<int:zbozi_id>")
def api_zbozi_detail(zbozi_id):
    with get_db() as conn:
        zbozi = conn.execute("SELECT * FROM zbozi WHERE id=?", (zbozi_id,)).fetchone()
        if not zbozi:
            return jsonify({"error": "Nenalezeno"}), 404
        aliasy = conn.execute("SELECT alias FROM zbozi_aliasy WHERE zbozi_id=?", (zbozi_id,)).fetchall()
        nakupy = conn.execute("""
            SELECT p.*, f.dodavatel, f.datum_vystaveni, f.firma_zkratka, f.id as faktura_id
            FROM polozky p
            JOIN faktury f ON f.id = p.faktura_id
            WHERE p.zbozi_id=?
            ORDER BY f.datum_vystaveni DESC
        """, (zbozi_id,)).fetchall()
    return jsonify({
        "zbozi": dict(zbozi),
        "aliasy": [r["alias"] for r in aliasy],
        "nakupy": [dict(r) for r in nakupy]
    })

@app.route("/api/zbozi")
def api_zbozi_list():
    with get_db() as conn:
        rows = conn.execute("SELECT id, nazev_canonical FROM zbozi ORDER BY nazev_canonical").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/zbozi/alias", methods=["POST"])
def api_zbozi_alias():
    """Přiřadí položku (název nebo polozka_id) ke zboží."""
    data = request.json
    zbozi_id   = data.get("zbozi_id")
    alias_text = data.get("alias", "").strip()
    polozka_id = data.get("polozka_id")

    if not zbozi_id or not alias_text:
        return jsonify({"error": "Chybí zbozi_id nebo alias"}), 400

    with get_db() as conn:
        # Přidej alias
        try:
            conn.execute("INSERT INTO zbozi_aliasy (zbozi_id, alias) VALUES (?,?)", (zbozi_id, alias_text))
        except sqlite3.IntegrityError:
            conn.execute("UPDATE zbozi_aliasy SET zbozi_id=? WHERE alias=?", (zbozi_id, alias_text))

        # Přepiš zbozi_id na všech položkách s tímto názvem
        conn.execute("UPDATE polozky SET zbozi_id=? WHERE nazev=?", (zbozi_id, alias_text))

        # Pokud máme konkrétní polozka_id
        if polozka_id:
            conn.execute("UPDATE polozky SET zbozi_id=? WHERE id=?", (zbozi_id, polozka_id))

    return jsonify({"ok": True})

@app.route("/api/zbozi", methods=["POST"])
def api_zbozi_create():
    nazev = request.json.get("nazev_canonical", "").strip()
    if not nazev:
        return jsonify({"error": "Chybí název"}), 400
    with get_db() as conn:
        try:
            cur = conn.execute("INSERT INTO zbozi (nazev_canonical) VALUES (?)", (nazev,))
            return jsonify({"ok": True, "id": cur.lastrowid})
        except sqlite3.IntegrityError:
            row = conn.execute("SELECT id FROM zbozi WHERE nazev_canonical=?", (nazev,)).fetchone()
            return jsonify({"ok": True, "id": row["id"]})

# ── API: statistiky ───────────────────────────────────────────────────────────
@app.route("/api/statistiky")
def api_statistiky():
    firma = request.args.get("firma", "")
    od    = request.args.get("od", date.today().replace(day=1).isoformat())
    do_   = request.args.get("do", date.today().isoformat())

    f_cond  = "AND firma_zkratka=?" if firma else ""
    f_params = (firma,) if firma else ()

    with get_db() as conn:
        # Výdaje po měsících
        mesice = conn.execute(f"""
            SELECT strftime('%Y-%m', datum_vystaveni) m, ROUND(SUM(celkem_s_dph),2) castka
            FROM faktury
            WHERE datum_vystaveni>=? AND datum_vystaveni<=? {f_cond}
            GROUP BY m ORDER BY m
        """, (od, do_) + f_params).fetchall()

        # Top dodavatelé
        dodavatele = conn.execute(f"""
            SELECT dodavatel, ROUND(SUM(celkem_s_dph),2) castka, COUNT(*) pocet
            FROM faktury
            WHERE datum_vystaveni>=? AND datum_vystaveni<=? {f_cond}
            GROUP BY dodavatel ORDER BY castka DESC LIMIT 10
        """, (od, do_) + f_params).fetchall()

        # Top zboží
        zbozi_top = conn.execute(f"""
            SELECT COALESCE(z.nazev_canonical, p.nazev) zbozi, ROUND(SUM(p.celkem_s_dph),2) castka,
                   ROUND(SUM(p.mnozstvi),2) mnozstvi, p.jednotka
            FROM polozky p
            JOIN faktury f ON f.id=p.faktura_id
            LEFT JOIN zbozi z ON z.id=p.zbozi_id
            WHERE f.datum_vystaveni>=? AND f.datum_vystaveni<=? {f_cond}
            GROUP BY COALESCE(z.id, p.nazev) ORDER BY castka DESC LIMIT 20
        """, (od, do_) + f_params).fetchall()

        # Vývoj ceny vybraného zboží
        zbozi_id = request.args.get("zbozi_id")
        cena_vyvoj = []
        if zbozi_id:
            cena_vyvoj = conn.execute(f"""
                SELECT f.datum_vystaveni dat, ROUND(p.cena_za_jednotku_s_dph,4) cena, f.dodavatel
                FROM polozky p JOIN faktury f ON f.id=p.faktura_id
                WHERE p.zbozi_id=? AND f.datum_vystaveni>=? AND f.datum_vystaveni<=? {f_cond}
                ORDER BY f.datum_vystaveni
            """, (zbozi_id, od, do_) + f_params).fetchall()

    return jsonify({
        "mesice": [dict(r) for r in mesice],
        "dodavatele": [dict(r) for r in dodavatele],
        "zbozi_top": [dict(r) for r in zbozi_top],
        "cena_vyvoj": [dict(r) for r in cena_vyvoj]
    })

# ── API: export ───────────────────────────────────────────────────────────────
@app.route("/api/export/faktury")
def export_faktury():
    fmt   = request.args.get("format", "xlsx")
    firma = request.args.get("firma", "")
    stav  = request.args.get("stav", "")
    od    = request.args.get("od", "")
    do_   = request.args.get("do", "")

    clauses, params = [], []
    if firma: clauses.append("firma_zkratka=?"); params.append(firma)
    if stav:  clauses.append("stav=?"); params.append(stav)
    if od:    clauses.append("datum_vystaveni>=?"); params.append(od)
    if do_:   clauses.append("datum_vystaveni<=?"); params.append(do_)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT firma_zkratka, dodavatel, cislo_faktury, datum_vystaveni,
                   datum_splatnosti, zpusob_uhrady, stav, celkem_s_dph
            FROM faktury {where} ORDER BY datum_vystaveni DESC
        """, params).fetchall()

    headers = ["Firma", "Dodavatel", "Číslo faktury", "Datum vystavení",
               "Datum splatnosti", "Způsob úhrady", "Stav", "Celkem s DPH"]

    if fmt == "csv":
        buf = io.StringIO()
        w   = csv.writer(buf, delimiter=";")
        w.writerow(headers)
        for r in rows:
            w.writerow(list(r))
        buf.seek(0)
        return send_file(io.BytesIO(buf.getvalue().encode("utf-8-sig")),
                         mimetype="text/csv",
                         download_name="faktury.csv",
                         as_attachment=True)
    else:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "Faktury"
        _xlsx_header(ws, headers)
        for r in rows:
            ws.append(list(r))
        buf = io.BytesIO()
        wb.save(buf); buf.seek(0)
        return send_file(buf, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                         download_name="faktury.xlsx", as_attachment=True)

@app.route("/api/export/polozky")
def export_polozky():
    fmt   = request.args.get("format", "xlsx")
    firma = request.args.get("firma", "")
    od    = request.args.get("od", "")
    do_   = request.args.get("do", "")

    f_cond = "AND f.firma_zkratka=?" if firma else ""
    od_c   = "AND f.datum_vystaveni>=?" if od else ""
    do_c   = "AND f.datum_vystaveni<=?" if do_ else ""
    params = tuple(v for v in [firma, od, do_] if v)

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT COALESCE(z.nazev_canonical, p.nazev), p.jednotka,
                   ROUND(SUM(p.mnozstvi),3), ROUND(SUM(p.celkem_s_dph),2),
                   ROUND(AVG(p.cena_za_jednotku_s_dph),4),
                   COUNT(DISTINCT p.faktura_id),
                   GROUP_CONCAT(DISTINCT f.dodavatel)
            FROM polozky p JOIN faktury f ON f.id=p.faktura_id
            LEFT JOIN zbozi z ON z.id=p.zbozi_id
            WHERE 1=1 {f_cond} {od_c} {do_c}
            GROUP BY COALESCE(z.id, p.nazev)
            ORDER BY SUM(p.celkem_s_dph) DESC
        """, params).fetchall()

    headers = ["Zboží", "Jednotka", "Celkové množství", "Celkem s DPH",
               "Průměrná cena/jedn.", "Počet nákupů", "Dodavatelé"]

    if fmt == "csv":
        buf = io.StringIO()
        w   = csv.writer(buf, delimiter=";")
        w.writerow(headers)
        for r in rows: w.writerow(list(r))
        buf.seek(0)
        return send_file(io.BytesIO(buf.getvalue().encode("utf-8-sig")),
                         mimetype="text/csv", download_name="polozky.csv", as_attachment=True)
    else:
        wb = openpyxl.Workbook()
        ws = wb.active; ws.title = "Položky"
        _xlsx_header(ws, headers)
        for r in rows: ws.append(list(r))
        buf = io.BytesIO(); wb.save(buf); buf.seek(0)
        return send_file(buf, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                         download_name="polozky.xlsx", as_attachment=True)

def _xlsx_header(ws, headers):
    green = "2D6A4F"
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=green)
        cell.alignment = Alignment(horizontal="center")

# ── Statické soubory faktur ───────────────────────────────────────────────────
@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_DIR, filename)

# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    init_db()
    print("=" * 55)
    print("  Správa faktur – spouštím server")
    print("  Otevři prohlížeč na: http://localhost:5000")
    print("=" * 55)
    app.run(host="0.0.0.0", port=5000, debug=False)
