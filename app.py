"""
Aplikace pro správu přijatých faktur
Spuštění: python app.py
"""

import os
import json
import sqlite3
try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    psycopg2 = None
import csv
import io
import re
import base64
import anthropic
from datetime import datetime, date, timedelta
from flask import Flask, render_template, request, jsonify, send_file, redirect, url_for, send_from_directory
from werkzeug.utils import secure_filename
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

try:
    import pdfplumber
    PDF_SUPPORT = True
except ImportError:
    PDF_SUPPORT = False
    print("⚠  pdfplumber není nainstalován – PDF parsing nebude fungovat")

try:
    import pytesseract
    from PIL import Image
    import os as _os
    _tess_path = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
    if _os.path.exists(_tess_path):
        pytesseract.pytesseract.tesseract_cmd = _tess_path
    OCR_SUPPORT = True
except ImportError:
    OCR_SUPPORT = False
    print("⚠  pytesseract/Pillow není nainstalován – OCR obrázků nebude fungovat")

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
DB_PATH     = os.path.join(BASE_DIR, "faktury.db")
UPLOAD_DIR  = os.path.join(BASE_DIR, "uploads")
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
ALLOWED_EXT = {"pdf", "png", "jpg", "jpeg", "tiff", "bmp"}

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024

DEFAULT_CONFIG = {
    "firmy": ["FP", "MR", "CFF"],
    "app_nazev": "Správa faktur",
    "ico_map": {}
}

def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return DEFAULT_CONFIG.copy()

def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
_USE_PG = bool(DATABASE_URL)


def _first_val(row):
    """Vrátí první hodnotu z řádku – funguje pro dict (PG) i tuple/Row (SQLite)."""
    if row is None:
        return 0
    if isinstance(row, dict):
        v = list(row.values())[0]
    else:
        v = row[0]
    return v if v is not None else 0


class _PgCursor:
    def __init__(self, cur, is_insert=False):
        self._cur = cur
        self._lastrowid = None
        if is_insert:
            try:
                r = self._cur.fetchone()
                self._lastrowid = r["id"] if r else None
            except Exception:
                self._lastrowid = None

    def __iter__(self): return iter(self._cur)
    def fetchall(self): return [dict(r) for r in self._cur.fetchall()]
    def fetchone(self):
        r = self._cur.fetchone()
        return dict(r) if r else None

    @property
    def lastrowid(self):
        return self._lastrowid

    @property
    def rowcount(self): return self._cur.rowcount

class _PgConn:
    def __init__(self, conn): self._conn = conn
    def __enter__(self): return self
    def __exit__(self, exc_type, *_):
        if exc_type: self._conn.rollback()
        else: self._conn.commit()
        self._conn.close()
    def commit(self): self._conn.commit()
    def rollback(self): self._conn.rollback()
    def close(self): self._conn.close()
    @staticmethod
    def _adapt(sql):
        import re as _re
        sql = sql.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
        sql = sql.replace("DEFAULT (datetime('now','localtime'))", "DEFAULT NOW()")
        sql = sql.replace("datetime('now','localtime')", "NOW()")
        sql = sql.replace("date('now','-12 months')", "(CURRENT_DATE - INTERVAL '12 months')")
        sql = sql.replace("date('now')", "CURRENT_DATE::text")
        sql = _re.sub(r"\bdatum_vystaveni\b(\s*)(>=|<=|>|<)", r"datum_vystaveni::date\1\2", sql)
        sql = _re.sub(r"\bdatum\b(\s*)(>=|<=|>|<)", r"datum::date\1\2", sql)
        sql = _re.sub(r"strftime\('%Y',\s*([^,)]+)\)", r"TO_CHAR(NULLIF(\1,'')::date, 'YYYY')", sql)
        sql = _re.sub(r"strftime\('%m',\s*([^,)]+)\)", r"TO_CHAR(NULLIF(\1,'')::date, 'MM')", sql)
        sql = _re.sub(r"strftime\('%Y-%m',\s*([^,)]+)\)", r"TO_CHAR(NULLIF(\1,'')::date, 'YYYY-MM')", sql)
        return sql
    def execute(self, sql, params=()):
        if sql.strip().upper().startswith("PRAGMA"):
            class _D:
                lastrowid=None; rowcount=0
                def fetchone(self): return None
                def fetchall(self): return []
                def __iter__(self): return iter([])
            return _D()
        sql = self._adapt(sql)
        sql_pg = sql.replace("?", "%s")
        cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        is_insert = sql_pg.strip().upper().startswith("INSERT")
        if is_insert and "RETURNING" not in sql_pg.upper():
            sql_pg = sql_pg.rstrip().rstrip(";") + " RETURNING id"
        cur.execute(sql_pg, params if params else None)
        return _PgCursor(cur, is_insert=is_insert)
    def executescript(self, sql):
        sql = self._adapt(sql)
        sql = sql.replace("PRAGMA journal_mode=WAL;", "").replace("PRAGMA foreign_keys=ON;", "")
        cur = self._conn.cursor()
        cur.execute(sql)
        self._conn.commit()

def get_db():
    if _USE_PG:
        conn = psycopg2.connect(DATABASE_URL)
        conn.autocommit = False
        return _PgConn(conn)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    TABLES = [
        ("zbozi", """CREATE TABLE IF NOT EXISTS zbozi (
            id               SERIAL PRIMARY KEY,
            nazev_canonical  TEXT    NOT NULL UNIQUE,
            poznamka         TEXT
        )"""),
        ("zbozi_aliasy", """CREATE TABLE IF NOT EXISTS zbozi_aliasy (
            id        SERIAL PRIMARY KEY,
            zbozi_id  INTEGER NOT NULL REFERENCES zbozi(id) ON DELETE CASCADE,
            alias     TEXT    NOT NULL UNIQUE
        )"""),
        ("faktury", """CREATE TABLE IF NOT EXISTS faktury (
            id              SERIAL PRIMARY KEY,
            firma_zkratka   TEXT    NOT NULL,
            dodavatel       TEXT    NOT NULL,
            cislo_faktury   TEXT,
            datum_vystaveni TEXT,
            datum_splatnosti TEXT,
            zpusob_uhrady   TEXT,
            stav            TEXT    DEFAULT 'ceka',
            celkem_s_dph    REAL    DEFAULT 0,
            soubor_cesta    TEXT,
            zdroj           TEXT    DEFAULT 'rucni',
            created_at      TEXT    DEFAULT NOW()
        )"""),
        ("polozky", """CREATE TABLE IF NOT EXISTS polozky (
            id                    SERIAL PRIMARY KEY,
            faktura_id            INTEGER NOT NULL REFERENCES faktury(id) ON DELETE CASCADE,
            nazev                 TEXT    NOT NULL,
            mnozstvi              REAL    DEFAULT 1,
            jednotka              TEXT    DEFAULT 'ks',
            cena_za_jednotku_s_dph REAL   DEFAULT 0,
            celkem_s_dph          REAL    DEFAULT 0,
            zbozi_id              INTEGER REFERENCES zbozi(id) ON DELETE SET NULL
        )"""),
        ("vyplaty", """CREATE TABLE IF NOT EXISTS vyplaty (
            id          SERIAL PRIMARY KEY,
            jmeno       TEXT    NOT NULL,
            datum       TEXT    NOT NULL,
            castka      REAL    NOT NULL DEFAULT 0,
            poznamka    TEXT,
            firma_zkratka TEXT  DEFAULT '',
            created_at  TEXT    DEFAULT NOW()
        )"""),
        ("reporty", """CREATE TABLE IF NOT EXISTS reporty (
            id            SERIAL PRIMARY KEY,
            datum         TEXT    NOT NULL UNIQUE,
            den           TEXT,
            smena         TEXT,
            karty         REAL    DEFAULT 0,
            kov           REAL    DEFAULT 0,
            papir         REAL    DEFAULT 0,
            hotovost      REAL    DEFAULT 0,
            vydaje        REAL    DEFAULT 0,
            trzba         REAL    DEFAULT 0,
            trzba_vcpk    REAL    DEFAULT 0,
            pk50_ks       INTEGER DEFAULT 0,
            pk100_ks      INTEGER DEFAULT 0,
            pk_celkem     REAL    DEFAULT 0,
            pizza_cela    INTEGER DEFAULT 0,
            pizza_ctvrt   INTEGER DEFAULT 0,
            burger        INTEGER DEFAULT 0,
            talire        INTEGER DEFAULT 0,
            burtgulas     INTEGER DEFAULT 0,
            hotdog        INTEGER DEFAULT 0,
            snidane       INTEGER DEFAULT 0,
            nakupy        INTEGER DEFAULT 0,
            foto_cesta    TEXT,
            firma_zkratka TEXT    DEFAULT '',
            poznamka      TEXT,
            created_at    TEXT    DEFAULT NOW()
        )"""),
    ]
    with get_db() as conn:
        for name, sql in TABLES:
            if not _USE_PG:
                sql = sql.replace('SERIAL PRIMARY KEY', 'INTEGER PRIMARY KEY AUTOINCREMENT')
                sql = sql.replace('DEFAULT NOW()', "DEFAULT (datetime('now','localtime'))")
            conn.execute(sql)
    print("init_db OK")


def migrate_db():
    with get_db() as conn:
        if _USE_PG:
            cur = conn.execute("SELECT column_name FROM information_schema.columns WHERE table_name='reporty'")
            existing = [r["column_name"] for r in cur.fetchall()]
        else:
            existing = [row[1] for row in conn.execute("PRAGMA table_info(reporty)").fetchall()]
        for col, typ in [
            ("burtgulas","INTEGER DEFAULT 0"),("hotdog","INTEGER DEFAULT 0"),
            ("snidane","INTEGER DEFAULT 0"),("nakupy","INTEGER DEFAULT 0"),
            ("foto_cesta","TEXT"),("firma_zkratka","TEXT DEFAULT ''"),
        ]:
            if col not in existing:
                try: conn.execute(f"ALTER TABLE reporty ADD COLUMN {col} {typ}")
                except Exception: pass
    print("migrate_db OK")


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXT

def update_stav_po_splatnosti():
    today = date.today().isoformat()
    with get_db() as conn:
        conn.execute("""
            UPDATE faktury SET stav = 'po_splatnosti'
            WHERE stav = 'ceka'
              AND datum_splatnosti IS NOT NULL
              AND datum_splatnosti < ?
        """, (today,))

def recalc_faktura_total(conn, faktura_id):
    row = conn.execute("SELECT COALESCE(SUM(celkem_s_dph),0) as total FROM polozky WHERE faktura_id=?", (faktura_id,)).fetchone()
    total = _first_val(row)
    conn.execute("UPDATE faktury SET celkem_s_dph=? WHERE id=?", (total, faktura_id))


# ── MAKRO parser ───────────────────────────────────────────────────────────────
def parse_makro_pdf(filepath):
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
            first_text = pdf.pages[0].extract_text() or ""
            first_despaced = _re.sub(r"(?<=\S) (?=\S)", "", first_text)
            if "Súpistovaru" in first_despaced and "FAKTURA" not in first_despaced:
                return None, "Tento soubor je 'Súpis tovaru' (interní doklad MAKRO) – není to daňová faktura. Soubor nebyl nahrán."

            for page in pdf.pages:
                full_text_lines += (page.extract_text() or "").splitlines()
                words = page.extract_words(x_tolerance=1, y_tolerance=2)

                rows = defaultdict(list)
                for w in words:
                    y = round(w["top"] / 2) * 2
                    rows[y].append(w)

                for y, ws in sorted(rows.items()):
                    ws = sorted(ws, key=lambda w: w["x0"])

                    left_digits = "".join(
                        w["text"] for w in ws
                        if w["x0"] < 95 and len(w["text"]) == 1 and w["text"].isdigit()
                    )
                    if len(left_digits) < 6:
                        left_tokens = "".join(
                            w["text"] for w in ws if w["x0"] < 95
                        ).replace("*", "").strip()
                        if re.match(r"^\d{6,}", left_tokens):
                            left_digits = left_tokens[:14]

                    unit_chars = "".join(
                        w["text"] for w in ws
                        if 230 <= w["x0"] <= 275 and len(w["text"]) == 1
                        and w["text"].upper() in "PCGKBSLXAW"
                    ).upper()
                    if   unit_chars.startswith("PC"): jed = "PC"
                    elif unit_chars.startswith("KG"): jed = "KG"
                    elif unit_chars.startswith("BG"): jed = "BG"
                    elif unit_chars.startswith("BX"): jed = "BX"
                    elif unit_chars.startswith("KS"): jed = "KS"
                    elif unit_chars.startswith("CA"): jed = "CA"
                    elif unit_chars.startswith("SW"): jed = "SW"
                    elif unit_chars.startswith("WA"): jed = "SW"
                    elif unit_chars.startswith("L"):  jed = "L"
                    else:                              jed = ""

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

                    nazev_ws = [w for w in ws if 90 <= w["x0"] <= 237]
                    nazev = _rekonstruuj_nazev(nazev_ws)

                    right_ws = sorted([w for w in ws if w["x0"] > 265], key=lambda w: w["x0"])
                    cf = _makro_reconstruct_numbers(right_ws)

                    if len(cf) < 2:
                        continue

                    idx_dph      = len(cf)
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

        def despace(s):
            return re.sub(r"(?<=\S) (?=\S)", "", s)

        ico_odberatele = ""
        for line in full_text_lines:
            dl = despace(line)
            if not result["cislo_faktury"]:
                m = re.search(r"Faktura.*?VS.*?:?\s*(\d{7,12})", dl, re.IGNORECASE)
                if m: result["cislo_faktury"] = m.group(1)
            if not result["cislo_faktury"]:
                m = re.search(r"Súpistovaru\s*(\d{7,12})", dl, re.IGNORECASE)
                if m: result["cislo_faktury"] = m.group(1)
            if not result["cislo_faktury"]:
                m = re.search(r"TechnickéID.*?/(\d{7,12})\)", dl, re.IGNORECASE)
                if m: result["cislo_faktury"] = m.group(1)
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

            dl_line = despace(line)
            if "Celkov" in dl_line and "stka" in dl_line:
                nums = re.findall(r"(\d{1,3}(?:\s\d{3})*[,\.]\d{2})", line)
                if nums:
                    result["celkem_s_dph"] = _parse_money(nums[-1])

        if result["celkem_s_dph"] == 0 and all_items:
            result["celkem_s_dph"] = round(sum(p["celkem_s_dph"] for p in all_items), 2)

        result["zpusob_uhrady"] = "Hotovost"
        result["stav"] = "zaplaceno"
        result["ico_odberatele"] = ico_odberatele
        result["firma_zkratka"] = _ico_na_firmu(ico_odberatele)

        for p in result["polozky"]:
            p["nazev"] = _format_nazev(p["nazev"])

    except Exception as e:
        return None, str(e)

    return result, None


def _makro_reconstruct_numbers(ws_sorted):
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

    DPH_SAZBY = {6.0, 10.0, 15.0, 21.0, 23.0}

    parsed = []
    for g in groups:
        token = "".join(w["text"] for w in g).replace(",", ".")
        x0 = g[0]["x0"]
        if re.match(r"^\d{5,}$", token):
            continue
        if re.match(r"^[A-Za-z]+$", token):
            continue
        try:
            val = float(token)
            parsed.append((x0, val))
        except Exception:
            pass

    dph_idx = None
    for i, (x0, val) in enumerate(parsed):
        if val in DPH_SAZBY and val == int(val) and x0 > 480:
            dph_idx = i
            break

    if dph_idx is not None:
        parsed = parsed[:dph_idx]

    return [val for _, val in parsed]


def _rekonstruuj_nazev(nazev_ws):
    if not nazev_ws:
        return ""
    result = ""
    for i, w in enumerate(nazev_ws):
        if i > 0:
            gap = w["x0"] - nazev_ws[i-1]["x1"]
            if gap > 3.5:
                result += " "
        result += w["text"]
    result = re.sub(r" {2,}", " ", result)
    return result.lstrip("*").strip()


def _format_nazev(nazev):
    result = re.sub(r"  +", " ", nazev).strip()
    return result


def _ico_na_firmu(ico):
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
    s = s.replace("-", ".")
    try:
        return datetime.strptime(s, "%d.%m.%Y").strftime("%Y-%m-%d")
    except Exception:
        return s


def _parse_makro_items(lines):
    return []


def _ocr_best_orientation(img):
    best_text = ""
    best_score = 0
    for angle in [0, 90, 180, 270]:
        rotated = img.rotate(angle, expand=True) if angle else img
        for lang in ["ces+eng", "ces", "eng"]:
            try:
                text = pytesseract.image_to_string(rotated, lang=lang, config="--psm 6 --oem 3")
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
    if not OCR_SUPPORT:
        return None, "pytesseract/Pillow není nainstalován"
    try:
        img = Image.open(filepath)
        img = img.convert("L")
        w, h = img.size
        needs_rotation_check = (w > h * 1.2) or (h > w * 1.2)
        if w < 1200:
            scale = 1200 / w
            img = img.resize((int(w*scale), int(h*scale)), Image.LANCZOS)

        if needs_rotation_check:
            text = _ocr_best_orientation(img)
        else:
            for lang in ["ces+eng", "ces", "eng"]:
                try:
                    text = pytesseract.image_to_string(img, lang=lang, config="--psm 6 --oem 3")
                    break
                except Exception:
                    continue

        lines = text.splitlines()
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

        for line in lines:
            ls = line.strip()
            if not result["cislo_faktury"]:
                m = re.search(r"Faktura.*?[Vv][Ss]\s*[;:,.]?\s*([\d\s]{7,15})", ls, re.IGNORECASE)
                if m:
                    vs = re.sub(r"\s+", "", m.group(1))[:12]
                    if vs.isdigit() and len(vs) >= 7: result["cislo_faktury"] = vs
            m = re.search(r"(\d{2})[.\-](\d{2})[.\-](\d{4})", ls)
            if m:
                den, mes, rok = m.group(1), m.group(2), m.group(3)
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
            if not result["firma_zkratka"]:
                m = re.search(r"IČ\s*:\s*(\d{8})", ls)
                if m: result["firma_zkratka"] = _ico_na_firmu(m.group(1))
            m = re.search(r"Celkov[aá]\s+[čc][aá]stka\s+([\d\s]{1,10}[,.]\d{2})", ls, re.IGNORECASE)
            if m: result["celkem_s_dph"] = _parse_money(m.group(1))
            m2 = re.search(r"[Ss]trana.{0,10}celkem.{0,10}bez.{0,5}DPH.{0,5}([\d\s]+[,.]\d{2})", ls, re.IGNORECASE)
            if m2 and not result.get("ocr_strana_celkem_bez_dph"):
                result["ocr_strana_celkem_bez_dph"] = _parse_money(m2.group(1))
            m3 = re.search(r"celkem\s+bez\s+DPH\s+([\d\s]+[,.]\d{2})", ls, re.IGNORECASE)
            if m3 and not result.get("ocr_strana_celkem_bez_dph"):
                result["ocr_strana_celkem_bez_dph"] = _parse_money(m3.group(1))

        result["polozky"] = _parse_ocr_items(lines)
        suma_polozek = round(sum(p["celkem_s_dph"] for p in result["polozky"]), 2)
        if result["celkem_s_dph"] == 0:
            result["celkem_s_dph"] = suma_polozek

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
    items = []
    sleva_kw = ["urceno pro konecnou", "určeno pro konečnou", "kup vice", "kup více"]
    jednotky = {"PC", "KG", "BG", "KS", "BX", "CA", "SW", "BT",
                "B6", "86", "PG", "6G", "BQ", "BC", "2B", "CA"}
    jednotka_map = {"B6": "BG", "86": "BG", "PG": "PC", "6G": "BG",
                    "BQ": "BG", "BC": "BX", "2B": "BG"}

    for line in lines:
        ls = line.strip()
        if not ls: continue
        ll = ls.lower()

        is_sleva = any(kw in ll for kw in sleva_kw)
        if is_sleva and items:
            nums = re.findall(r"-\s*(\d[\d\s]*[,.]\d{2})", ls)
            if nums:
                sleva = _parse_money(nums[-1])
                items[-1]["celkem_s_dph"] = round(max(0, items[-1]["celkem_s_dph"] - sleva), 2)
                mn = items[-1]["mnozstvi"]
                if mn: items[-1]["cena_za_jednotku_s_dph"] = round(items[-1]["celkem_s_dph"] / mn, 4)
            continue

        ls_clean = re.sub(r"^[Ss|lIG]+(?=\d)", "", ls)
        ls_clean = re.sub(r"^[|l]\s+", "", ls_clean)
        m = re.match(r"^(\d{6,14})\s+[\*\-—–|]*\s*(.+)", ls_clean)
        if not m: continue

        rest_after_mm = m.group(2).strip().lstrip("*").strip()

        jednotka = ""
        nazev = rest_after_mm
        cisla_str = ""

        for jed in jednotky:
            pat = r"^(.+?)\s+" + jed + r"\s+(.+)$"
            mj = re.match(pat, rest_after_mm, re.IGNORECASE)
            if mj:
                nazev    = mj.group(1).strip().rstrip("*").strip()
                jednotka = jednotka_map.get(jed, jed)
                cisla_str = mj.group(2)
                break

        if not jednotka:
            mj = re.search(r"\s(PC|KG|BG|KS|BX|CA|SW|BT)\s", rest_after_mm, re.IGNORECASE)
            if mj:
                jednotka = mj.group(1).upper()
                nazev    = rest_after_mm[:mj.start()].strip().rstrip("*")
                cisla_str = rest_after_mm[mj.end():]

        if not cisla_str:
            cisla_str = rest_after_mm

        cisla_str = re.sub(r"(\d+)[,\.](\s+)(\d+)", r"\1.\3", cisla_str)
        cisla_raw = re.findall(r"\d+[,.]\d+|\d+", cisla_str)
        cf = []
        for c in cisla_raw:
            try:
                val = float(c.replace(",", "."))
                if val == int(val) and val >= 10000:
                    continue
                cf.append(val)
            except:
                pass

        if len(cf) < 2: continue

        idx_dph = None
        for i in range(len(cf)-1, -1, -1):
            if cf[i] in (6.0, 10.0, 15.0, 23.0):
                idx_dph = i
                break
        if idx_dph is None: idx_dph = len(cf)

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
    try:
        return datetime.strptime(s, "%d.%m.%Y").strftime("%Y-%m-%d")
    except Exception:
        return s

def _parse_money(s):
    s = str(s).replace(" ", "").replace(".", "").replace(",", ".")
    try:
        return float(s)
    except Exception:
        return 0.0

def _map_unit(u):
    mapping = {"PC": "ks", "KS": "ks", "KG": "kg", "BG": "bal", "BX": "bal", "CA": "bal", "SW": "bal", "L": "l"}
    return mapping.get(u.upper(), u.lower())


# ── JMÉNA – mapa pro normalizaci ──────────────────────────────────────────────
# OPRAVA: Ráďa místo Radek, přidány překlepy z OCR, Verča = Věrka
JMENA_MAP = {
    "rada": "Ráďa", "radek": "Ráďa", "ráďa": "Ráďa", "radi": "Ráďa",
    "žaďa": "Ráďa", "žada": "Ráďa", "řaďa": "Ráďa", "zaďa": "Ráďa",
    "verka": "Věrka", "vera": "Věrka", "věra": "Věrka", "věrka": "Věrka",
    "verca": "Věrka",
    "verča": "Verča", "věrča": "Verča",
    "renča": "Renča", "renata": "Renča", "renca": "Renča",
    "vendy": "Vendy", "wendy": "Vendy",
    "vali": "Vali",
}

def normalize_jmena(text):
    if not text:
        return ""
    # Odstraň číslice – AI je někdy namíchá ke jménům
    text = re.sub(r'\b\d+\b', '', text)
    parts = re.split(r"[,/\s]+", text.strip())
    result = []
    for p in parts:
        p = p.strip().lower().rstrip(".,")
        if not p or len(p) < 2:
            continue
        canonical = JMENA_MAP.get(p)
        if canonical:
            result.append(canonical)
        else:
            result.append(p.capitalize())
    return ", ".join(result)


def parse_report_image_claude(filepath):
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None, "ANTHROPIC_API_KEY není nastaven"

    try:
        with open(filepath, "rb") as f:
            img_data = base64.standard_b64encode(f.read()).decode("utf-8")

        ext = filepath.rsplit(".", 1)[-1].lower()
        media_map = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                     "bmp": "image/bmp", "tiff": "image/tiff"}
        media_type = media_map.get(ext, "image/jpeg")

        client = anthropic.Anthropic(api_key=api_key)

        _t = date.today()
        today = f"{_t.day}.{_t.month}"

        # OPRAVA: lepší prompt – přeskrtnutá nula, jména bez čísel
        prompt = f"""Jsi expert na čtení ručně psaných restauračních reportů. Přečti tento denní report VELMI PEČLIVĚ.
Odpověz POUZE platným JSON objektem, žádný jiný text, žádné backticky.

Formát odpovědi:
{{
  "datum": "D.M" nebo null,
  "den": "název dne česky" nebo null,
  "smena": "jména oddělená čárkou" nebo null,
  "karty": číslo nebo 0,
  "kov": číslo nebo 0,
  "papir": číslo nebo 0,
  "vydaje": číslo nebo 0,
  "pk50_ks": celé číslo nebo 0,
  "pk100_ks": celé číslo nebo 0,
  "pizza_cela": celé číslo nebo 0,
  "pizza_ctvrt": celé číslo nebo 0,
  "burger": celé číslo nebo 0,
  "talire": celé číslo nebo 0,
  "burtgulas": celé číslo nebo 0
}}

PRAVIDLA PRO ČÍSLA:
- Tečka nebo čárka uvnitř čísla = ODDĚLOVAČ TISÍCŮ (6.696 = 6696, 5.100 = 5100, 12.327 = 12327)
- NIKDY neinterpretuj tečku jako desetinnou čárku u celých částek v Kč
- Čísla zapisuj jako celá čísla bez teček a čárek
- Přeškrtnutá nula (nula s čarou přes střed, symbol Ø) = ČÍSLO 0, ne písmeno

PRAVIDLA PRO JMÉNA (pole "smena"):
- Do pole "smena" patří POUZE jména osob – nikdy číslice ani čísla
- Ráďa, Rada, Radek, Rádi → "Ráďa"
- Věrka, Verka, Věra, Verca → "Věrka"
- Verča, Věrča → "Verča" (jiná osoba než Věrka!)
- Renča, Renata → "Renča"
- Vendy, Wendy → "Vendy"
- Vali → "Vali"
- Neznámá jména přidej jak jsou napsána, ale nikdy nepřidávej číslice

PRAVIDLA PRO DATUM:
- Hledej datum ve formátu "D.M" nahoře na lístku
- Pokud chybí, vrať dnešní datum: "{today}"
"""

        message = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": img_data
                        }
                    },
                    {"type": "text", "text": prompt}
                ]
            }]
        )

        text = message.content[0].text.strip()
        text = re.sub(r"^```json\s*", "", text)
        text = re.sub(r"```$", "", text).strip()

        parsed = json.loads(text)
        return parsed, None

    except Exception as e:
        return None, str(e)


def parse_report_text(text):
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None, "ANTHROPIC_API_KEY není nastaven"

    try:
        client = anthropic.Anthropic(api_key=api_key)

        prompt = f"""Přečti tento text denního reportu z restaurace a extrahuj údaje.
Odpověz POUZE platným JSON objektem, žádný jiný text.

Text reportu:
{text}

Formát odpovědi:
{{
  "datum": "DD.M" nebo null,
  "den": "název dne česky" nebo null,
  "smena": "jména oddělená čárkou" nebo null,
  "karty": číslo nebo 0,
  "kov": číslo nebo 0,
  "papir": číslo nebo 0,
  "vydaje": číslo nebo 0,
  "trzba": číslo nebo 0,
  "pk50_ks": počet kusů PK50 nebo 0,
  "pk100_ks": počet kusů PK100 nebo 0,
  "pizza_cela": číslo nebo 0,
  "pizza_ctvrt": číslo nebo 0,
  "burger": číslo nebo 0,
  "talire": číslo nebo 0,
  "burtgulas": číslo nebo 0
}}
"""

        message = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
            messages=[{"role": "user", "content": prompt}]
        )

        text_resp = message.content[0].text.strip()
        text_resp = re.sub(r"^```json\s*", "", text_resp)
        text_resp = re.sub(r"```$", "", text_resp).strip()
        parsed = json.loads(text_resp)
        return parsed, None

    except Exception as e:
        return None, str(e)


def datum_to_iso(datum_str, year=None):
    if not datum_str:
        return None
    datum_str = str(datum_str).strip()
    for sep in ["/", ".", "-"]:
        parts = datum_str.split(sep)
        if len(parts) == 2:
            try:
                d, m = int(parts[0]), int(parts[1])
                if year is None:
                    year = date.today().year
                return date(year, m, d).isoformat()
            except Exception:
                pass
    return None


def build_report_from_parsed(parsed, year=None):
    datum_iso = datum_to_iso(parsed.get("datum"), year)

    karty   = float(parsed.get("karty", 0) or 0)
    kov     = float(parsed.get("kov", 0) or 0)
    papir   = float(parsed.get("papir", 0) or 0)
    vydaje  = float(parsed.get("vydaje", 0) or 0)
    hotovost = kov + papir
    trzba    = karty + hotovost + vydaje

    pk50_ks  = int(parsed.get("pk50_ks", 0) or 0)
    pk100_ks = int(parsed.get("pk100_ks", 0) or 0)
    pk_celkem = pk50_ks * 50 + pk100_ks * 100
    trzba_vcpk = trzba + pk_celkem

    if parsed.get("trzba") and float(parsed.get("trzba")) > 0:
        trzba = float(parsed["trzba"])
        trzba_vcpk = trzba + pk_celkem

    smena = normalize_jmena(parsed.get("smena", ""))

    return {
        "datum":       datum_iso,
        "den":         parsed.get("den", ""),
        "smena":       smena,
        "karty":       karty,
        "kov":         kov,
        "papir":       papir,
        "hotovost":    hotovost,
        "vydaje":      vydaje,
        "trzba":       trzba,
        "trzba_vcpk":  trzba_vcpk,
        "pk50_ks":     pk50_ks,
        "pk100_ks":    pk100_ks,
        "pk_celkem":   pk_celkem,
        "pizza_cela":  int(parsed.get("pizza_cela", 0) or 0),
        "pizza_ctvrt": int(parsed.get("pizza_ctvrt", 0) or 0),
        "burger":      int(parsed.get("burger", 0) or 0),
        "talire":      int(parsed.get("talire", 0) or 0),
        "burtgulas":   int(parsed.get("burtgulas", 0) or 0),
    }


# ── Univerzální parser dokladů (Claude AI) ────────────────────────────────────
def parse_doklad_claude(filepath):
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None, "ANTHROPIC_API_KEY není nastaven"

    try:
        ext = filepath.rsplit(".", 1)[-1].lower()

        if ext == "pdf" and PDF_SUPPORT:
            text_pages = []
            with pdfplumber.open(filepath) as pdf:
                for page in pdf.pages:
                    t = page.extract_text()
                    if t:
                        text_pages.append(t)
            doklad_text = "\n".join(text_pages)
            content = [{"type": "text", "text": doklad_text}]
        else:
            with open(filepath, "rb") as f:
                img_data = base64.standard_b64encode(f.read()).decode("utf-8")
            media_map = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                         "bmp": "image/bmp", "tiff": "image/tiff"}
            media_type = media_map.get(ext, "image/jpeg")
            content = [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": img_data}}
            ]

        client = anthropic.Anthropic(api_key=api_key)

        prompt_text = """Jsi expert na čtení účtenek a faktur. Přečti přiložený doklad a extrahuj data.
Odpověz POUZE platným JSON objektem – žádný jiný text, žádné backticky.

Formát:
{
  "dodavatel": "název obchodu/firmy (napiš přesně jak stojí na dokladu)",
  "cislo_faktury": "číslo dokladu/pokladního bloku nebo null",
  "datum_vystaveni": "YYYY-MM-DD nebo null",
  "celkem_s_dph": číslo s desetinnými místy (celková částka k zaplacení),
  "polozky": [
    {
      "nazev": "název položky",
      "mnozstvi": číslo,
      "jednotka": "ks nebo kg nebo l nebo bal",
      "cena_za_jednotku_s_dph": číslo,
      "celkem_s_dph": číslo
    }
  ]
}

PRAVIDLA:
- dodavatel: celý název obchodu (Globus, Penny Market, Albert, Lidl, atd.)
- datum_vystaveni: převeď na YYYY-MM-DD, pokud chybí dej null
- celkem_s_dph: CELKOVÁ částka k zaplacení (hledej CELKEM nebo TOTAL nebo K ÚHRADĚ)
- u váhového zboží: jednotka "kg", množství v kg
- u kusového: jednotka "ks", množství počet kusů
- cislo_faktury: číslo dokladu, účtenky nebo null pokud není"""

        content.append({"type": "text", "text": prompt_text})

        message = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2000,
            messages=[{"role": "user", "content": content}]
        )

        text_resp = message.content[0].text.strip()
        text_resp = re.sub(r"^```json\s*", "", text_resp)
        text_resp = re.sub(r"```$", "", text_resp).strip()

        parsed = json.loads(text_resp)

        result = {
            "dodavatel":        parsed.get("dodavatel", "Neznámý dodavatel"),
            "cislo_faktury":    parsed.get("cislo_faktury") or "",
            "datum_vystaveni":  parsed.get("datum_vystaveni") or "",
            "datum_splatnosti": "",
            "zpusob_uhrady":    "Hotovost",
            "stav":             "zaplaceno",
            "celkem_s_dph":     float(parsed.get("celkem_s_dph", 0) or 0),
            "firma_zkratka":    "",
            "polozky":          []
        }

        for p in parsed.get("polozky", []):
            nazev = str(p.get("nazev", "")).strip()
            if not nazev:
                continue
            mnozstvi = float(p.get("mnozstvi", 1) or 1)
            celkem   = float(p.get("celkem_s_dph", 0) or 0)
            cena_j   = float(p.get("cena_za_jednotku_s_dph", 0) or 0)
            if cena_j == 0 and mnozstvi and celkem:
                cena_j = round(celkem / mnozstvi, 4)
            result["polozky"].append({
                "nazev":                  nazev,
                "mnozstvi":               mnozstvi,
                "jednotka":               p.get("jednotka", "ks"),
                "cena_za_jednotku_s_dph": cena_j,
                "celkem_s_dph":           round(celkem, 2)
            })

        if result["celkem_s_dph"] == 0 and result["polozky"]:
            result["celkem_s_dph"] = round(sum(p["celkem_s_dph"] for p in result["polozky"]), 2)

        return result, None

    except Exception as e:
        return None, str(e)

# ═══════════════════════════════════════════════════════════════════════════════
#  ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    update_stav_po_splatnosti()
    return render_template("index.html", config=load_config())

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

@app.route("/api/dashboard")
def api_dashboard():
    update_stav_po_splatnosti()
    firma = request.args.get("firma", "")
    with get_db() as conn:
        mesic = date.today().strftime("%Y-%m")
        where_firma = "AND firma_zkratka=?" if firma else ""
        params_base = (firma,) if firma else ()

        like_cond = "AND datum_vystaveni::text LIKE ?" if _USE_PG else "AND datum_vystaveni LIKE ?"
        row = conn.execute(f"""
            SELECT COUNT(*) as pocet, COALESCE(SUM(celkem_s_dph),0) as vydaje
            FROM faktury
            WHERE 1=1 {like_cond} {where_firma}
        """, (mesic + "%",) + params_base).fetchone()
        pocet_mesic  = row["pocet"]  if isinstance(row, dict) else row[0]
        vydaje_mesic = row["vydaje"] if isinstance(row, dict) else row[1]

        row2 = conn.execute(f"""
            SELECT COUNT(*) as pocet, COALESCE(SUM(celkem_s_dph),0) as castka
            FROM faktury WHERE stav='po_splatnosti' {where_firma}
        """, params_base).fetchone()
        pocet_po_spl  = row2["pocet"]  if isinstance(row2, dict) else row2[0]
        castka_po_spl = row2["castka"] if isinstance(row2, dict) else row2[1]

        datum_filter = "AND datum_vystaveni::date >= CURRENT_DATE - INTERVAL '12 months'" if _USE_PG else "AND datum_vystaveni >= date('now','-12 months')"
        graf = conn.execute(f"""
            SELECT strftime('%Y-%m', datum_vystaveni) as m, COALESCE(SUM(celkem_s_dph),0) as castka
            FROM faktury
            WHERE datum_vystaveni IS NOT NULL AND datum_vystaveni != '' {datum_filter} {where_firma}
            GROUP BY m ORDER BY m
        """, params_base).fetchall()

        posledni = conn.execute(f"""
            SELECT id, dodavatel, cislo_faktury, firma_zkratka, datum_vystaveni,
                   datum_splatnosti, celkem_s_dph, stav
            FROM faktury {('WHERE firma_zkratka=?' if firma else '')}
            ORDER BY created_at DESC LIMIT 5
        """, params_base).fetchall()

        karty_row = conn.execute("""
            SELECT COALESCE(SUM(karty),0) as karty
            FROM reporty
            WHERE datum >= date('now','-12 months')
        """).fetchone()
        karty_12m = karty_row["karty"] if isinstance(karty_row, dict) else karty_row[0]

    def graf_row(r):
        if isinstance(r, dict):
            return {"mesic": r["m"], "castka": round(r["castka"], 2)}
        return {"mesic": r[0], "castka": round(r[1], 2)}

    return jsonify({
        "vydaje_mesic": round(vydaje_mesic, 2),
        "pocet_mesic": pocet_mesic,
        "pocet_po_splatnosti": pocet_po_spl,
        "castka_po_splatnosti": round(castka_po_spl, 2),
        "graf": [graf_row(r) for r in graf],
        "posledni_faktury": [dict(r) for r in posledni],
        "karty_12m": round(karty_12m, 2),
        "karty_limit": 1500000,
    })

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
        total_row = conn.execute(f"SELECT COALESCE(SUM(celkem_s_dph),0) as total FROM faktury {where}", params).fetchone()
        total = _first_val(total_row)

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

# ── API: výplaty ──────────────────────────────────────────────────────────────
@app.route("/api/vyplaty/zamestnanci", methods=["GET"])
def api_vyplaty_zamestnanci():
    with get_db() as conn:
        rows = conn.execute("SELECT DISTINCT jmeno FROM vyplaty ORDER BY jmeno").fetchall()
    return jsonify({"jmena": [r["jmeno"] for r in rows]})

@app.route("/api/vyplaty", methods=["GET"])
def api_vyplaty():
    try:
        firma = request.args.get("firma", "")
        jmeno = request.args.get("jmeno", "")
        od    = request.args.get("od", "")
        do_   = request.args.get("do", "")
        clauses, params = [], []
        if firma: clauses.append("firma_zkratka=?"); params.append(firma)
        if jmeno: clauses.append("jmeno=?"); params.append(jmeno)
        if od:    clauses.append("datum>=?"); params.append(od)
        if do_:   clauses.append("datum<=?"); params.append(do_)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        with get_db() as conn:
            rows = conn.execute(f"""
                SELECT * FROM vyplaty {where} ORDER BY datum DESC, created_at DESC
            """, params).fetchall()
            total_row = conn.execute(
                f"SELECT COALESCE(SUM(castka),0) as total FROM vyplaty {where}", params
            ).fetchone()
            total = _first_val(total_row)
        return jsonify({"vyplaty": [dict(r) for r in rows], "celkem": round(total, 2)})
    except Exception as e:
        import traceback
        app.logger.error(f"api_vyplaty GET error: {traceback.format_exc()}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/vyplaty", methods=["POST"])
def api_vyplata_ulozit():
    try:
        data = request.json
        if not data.get("jmeno") or not data.get("datum") or data.get("castka") is None:
            return jsonify({"error": "Chybí povinná pole"}), 400
        with get_db() as conn:
            cur = conn.execute("""
                INSERT INTO vyplaty (jmeno, datum, castka, poznamka, firma_zkratka)
                VALUES (?,?,?,?,?)
            """, (
                data["jmeno"],
                data["datum"],
                float(data["castka"]),
                data.get("poznamka", ""),
                data.get("firma_zkratka", "")
            ))
        return jsonify({"ok": True, "id": cur.lastrowid})
    except Exception as e:
        import traceback
        app.logger.error(f"api_vyplata_ulozit error: {traceback.format_exc()}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/vyplaty/<int:vid>", methods=["DELETE"])
def api_vyplata_delete(vid):
    with get_db() as conn:
        conn.execute("DELETE FROM vyplaty WHERE id=?", (vid,))
    return jsonify({"ok": True})

@app.route("/api/vyplaty/<int:vid>", methods=["PUT"])
def api_vyplata_update(vid):
    data = request.json
    fields = ["jmeno", "datum", "castka", "poznamka", "firma_zkratka"]
    set_parts = [f"{f}=?" for f in fields if f in data]
    vals = [data[f] for f in fields if f in data]
    if not set_parts:
        return jsonify({"ok": True})
    vals.append(vid)
    with get_db() as conn:
        conn.execute(f"UPDATE vyplaty SET {','.join(set_parts)} WHERE id=?", vals)
    return jsonify({"ok": True})


# ── API: REPORTY ──────────────────────────────────────────────────────────────
@app.route("/api/reporty/nahrat-foto", methods=["POST"])
def api_report_nahrat_foto():
    if "soubor" not in request.files:
        return jsonify({"error": "Žádný soubor"}), 400
    f = request.files["soubor"]
    if not f.filename:
        return jsonify({"error": "Prázdný soubor"}), 400

    fname = secure_filename(f.filename)
    ts    = datetime.now().strftime("%Y%m%d_%H%M%S_")
    fname = "report_" + ts + fname
    fpath = os.path.join(UPLOAD_DIR, fname)
    f.save(fpath)

    parsed, err = parse_report_image_claude(fpath)
    if err:
        return jsonify({"error": err}), 200

    report = build_report_from_parsed(parsed)
    return jsonify(report)


@app.route("/api/reporty/nahrat-text", methods=["POST"])
def api_report_nahrat_text():
    text = request.json.get("text", "").strip()
    if not text:
        return jsonify({"error": "Prázdný text"}), 400

    parsed, err = parse_report_text(text)
    if err:
        return jsonify({"error": err}), 200

    report = build_report_from_parsed(parsed)
    return jsonify(report)


@app.route("/api/reporty", methods=["GET"])
def api_reporty_list():
    od  = request.args.get("od", "")
    do_ = request.args.get("do", "")
    clauses, params = [], []
    if od:  clauses.append("datum>=?"); params.append(od)
    if do_: clauses.append("datum<=?"); params.append(do_)
    else:
        clauses.append("datum<=?"); params.append(date.today().isoformat())
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT * FROM reporty {where} ORDER BY datum DESC
        """, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/reporty", methods=["POST"])
def api_report_ulozit():
    data = request.json
    if not data.get("datum"):
        return jsonify({"error": "Chybí datum"}), 400

    karty    = float(data.get("karty", 0) or 0)
    kov      = float(data.get("kov", 0) or 0)
    papir    = float(data.get("papir", 0) or 0)
    vydaje   = float(data.get("vydaje", 0) or 0)
    hotovost = kov + papir
    trzba    = karty + hotovost + vydaje
    pk50_ks  = int(data.get("pk50_ks", 0) or 0)
    pk100_ks = int(data.get("pk100_ks", 0) or 0)
    pk_celkem  = pk50_ks * 50 + pk100_ks * 100
    trzba_vcpk = trzba + pk_celkem

    firma = data.get("firma_zkratka", "")
    with get_db() as conn:
        existing = conn.execute("SELECT id FROM reporty WHERE datum=?", (data["datum"],)).fetchone()
        if existing:
            conn.execute("""
                UPDATE reporty SET den=?,smena=?,karty=?,kov=?,papir=?,hotovost=?,
                vydaje=?,trzba=?,trzba_vcpk=?,pk50_ks=?,pk100_ks=?,pk_celkem=?,
                pizza_cela=?,pizza_ctvrt=?,burger=?,talire=?,burtgulas=?,poznamka=?,firma_zkratka=?
                WHERE datum=?
            """, (
                data.get("den",""), data.get("smena",""),
                karty, kov, papir, hotovost, vydaje, trzba, trzba_vcpk,
                pk50_ks, pk100_ks, pk_celkem,
                int(data.get("pizza_cela",0) or 0), int(data.get("pizza_ctvrt",0) or 0),
                int(data.get("burger",0) or 0), int(data.get("talire",0) or 0),
                int(data.get("burtgulas",0) or 0),
                data.get("poznamka",""), firma,
                data["datum"]
            ))
            rid = existing["id"]
        else:
            cur = conn.execute("""
                INSERT INTO reporty (datum,den,smena,karty,kov,papir,hotovost,vydaje,
                trzba,trzba_vcpk,pk50_ks,pk100_ks,pk_celkem,
                pizza_cela,pizza_ctvrt,burger,talire,burtgulas,poznamka,firma_zkratka)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                data["datum"], data.get("den",""), data.get("smena",""),
                karty, kov, papir, hotovost, vydaje, trzba, trzba_vcpk,
                pk50_ks, pk100_ks, pk_celkem,
                int(data.get("pizza_cela",0) or 0), int(data.get("pizza_ctvrt",0) or 0),
                int(data.get("burger",0) or 0), int(data.get("talire",0) or 0),
                int(data.get("burtgulas",0) or 0),
                data.get("poznamka",""), firma
            ))
            rid = cur.lastrowid

    return jsonify({"ok": True, "id": rid})


@app.route("/api/reporty/<int:rid>", methods=["DELETE"])
def api_report_delete(rid):
    with get_db() as conn:
        conn.execute("DELETE FROM reporty WHERE id=?", (rid,))
    return jsonify({"ok": True})


@app.route("/api/reporty/smaz-budouci", methods=["POST"])
def api_reporty_smaz_budouci():
    dnes = date.today().isoformat()
    with get_db() as conn:
        cur = conn.execute("DELETE FROM reporty WHERE datum > ?", (dnes,))
        smazano = cur.rowcount
    return jsonify({"ok": True, "smazano": smazano})


@app.route("/api/reporty/import-xlsx", methods=["POST"])
def api_report_import_xlsx():
    if "soubor" not in request.files:
        return jsonify({"error": "Žádný soubor"}), 400
    f = request.files["soubor"]
    fname = secure_filename(f.filename)
    fpath = os.path.join(UPLOAD_DIR, "import_" + fname)
    f.save(fpath)

    try:
        wb = openpyxl.load_workbook(fpath, data_only=True)
        imported = 0
        skipped  = 0
        updated  = 0
        errors   = []

        den_map = {
            "po": "Pondělí", "út": "Úterý", "st": "Středa",
            "čt": "Čtvrtek", "pá": "Pátek", "so": "Sobota", "ne": "Neděle"
        }
        mesic_map = {
            "LEDEN": 1, "ÚNOR": 2, "BŘEZEN": 3, "DUBEN": 4,
            "KVĚTEN": 5, "ČERVEN": 6, "ČERVENEC": 7, "SRPEN": 8,
            "ZÁŘÍ": 9, "ŘÍJEN": 10, "LISTOPAD": 11, "PROSINEC": 12
        }

        rows_to_insert = []
        dnes = date.today()

        for sheet_name in wb.sheetnames:
            # Zpracuj pouze listy s roky (číselné názvy)
            try:
                year = int(sheet_name)
            except ValueError:
                continue
            if year < 2020 or year > 2030:
                continue

            ws = wb[sheet_name]

            for row in ws.iter_rows(min_row=2, values_only=True):
                if not row or row[0] is None:
                    continue

                # Přeskoč souhrnné řádky
                if str(row[0]).upper().strip() in ("SOUČET", "DNÍ", "PRŮMĚR", "DATUM", "CELKEM"):
                    continue

                # Sloupec A musí být číslo dne
                try:
                    den_cislo = int(row[0])
                    if den_cislo < 1 or den_cislo > 31:
                        continue
                except (TypeError, ValueError):
                    continue

                # Sloupec B = název měsíce
                mesic_str = str(row[1] or "").upper().strip()
                mesic = mesic_map.get(mesic_str)
                if not mesic:
                    continue

                # Sestav datum
                try:
                    d = date(year, mesic, den_cislo)
                except ValueError:
                    errors.append(f"Neplatné datum: {year}-{mesic}-{den_cislo}")
                    continue

                # Budoucí datumy přeskočíme
                if d > dnes:
                    skipped += 1
                    continue

                datum_iso   = d.isoformat()
                den_str     = den_map.get(str(row[2] or "").lower().strip(), str(row[2] or ""))
                trzba_vcpk  = float(row[3] or 0)
                karty       = float(row[4] or 0)
                hotovost    = float(row[5] or 0)
                vydaje      = float(row[6] or 0)
                trzba       = float(row[7] or 0)
                pk50_ks     = int(row[8] or 0)
                pk100_ks    = int(row[9] or 0)
                pk_celkem   = float(row[10] or 0)
                pizza_cela  = int(row[11] or 0)
                pizza_ctvrt = int(row[12] or 0)
                burger      = int(row[13] or 0)
                talire      = int(row[14] or 0)
                burtgulas   = int(row[15] or 0)
                smena       = normalize_jmena(str(row[16] or ""))
                kov         = 0
                papir       = hotovost

                rows_to_insert.append((
                    datum_iso, den_str, smena, karty, kov, papir, hotovost,
                    vydaje, trzba, trzba_vcpk, pk50_ks, pk100_ks, pk_celkem,
                    pizza_cela, pizza_ctvrt, burger, talire, burtgulas
                ))

        with get_db() as conn:
            for params in rows_to_insert:
                datum_iso = params[0]
                existing = conn.execute("SELECT id FROM reporty WHERE datum=?", (datum_iso,)).fetchone()
                if existing:
                    # Aktualizuj existující záznam (přepíše data z xlsx)
                    conn.execute("""
                        UPDATE reporty SET den=?,smena=?,karty=?,kov=?,papir=?,hotovost=?,
                        vydaje=?,trzba=?,trzba_vcpk=?,pk50_ks=?,pk100_ks=?,pk_celkem=?,
                        pizza_cela=?,pizza_ctvrt=?,burger=?,talire=?,burtgulas=?
                        WHERE datum=?
                    """, (
                        params[1], params[2], params[3], params[4], params[5], params[6],
                        params[7], params[8], params[9], params[10], params[11], params[12],
                        params[13], params[14], params[15], params[16], params[17],
                        datum_iso
                    ))
                    updated += 1
                else:
                    conn.execute("""
                        INSERT INTO reporty (datum,den,smena,karty,kov,papir,hotovost,vydaje,
                        trzba,trzba_vcpk,pk50_ks,pk100_ks,pk_celkem,
                        pizza_cela,pizza_ctvrt,burger,talire,burtgulas)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """, params)
                    imported += 1

        return jsonify({
            "ok": True,
            "imported": imported,
            "updated": updated,
            "skipped": skipped,
            "errors": errors[:10]
        })

    except Exception as e:
        import traceback
        app.logger.error(f"import_xlsx error: {traceback.format_exc()}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/reporty/karty-alert")
def api_karty_alert():
    with get_db() as conn:
        total_row = conn.execute("""
            SELECT COALESCE(SUM(karty),0) as total
            FROM reporty
            WHERE datum >= date('now','-12 months')
        """).fetchone()
        total = _first_val(total_row)
        per_firma = conn.execute("""
            SELECT firma_zkratka, COALESCE(SUM(karty),0) as karty_12m
            FROM reporty
            WHERE datum >= date('now','-12 months')
            GROUP BY firma_zkratka
            ORDER BY karty_12m DESC
        """).fetchall()
    LIMIT = 1500000
    firmy_alert = []
    for r in per_firma:
        firma = r["firma_zkratka"] or "—"
        k = round(r["karty_12m"], 2)
        firmy_alert.append({
            "firma": firma,
            "karty_12m": k,
            "procent": round(k / LIMIT * 100, 1),
            "alert": k >= LIMIT,
            "varovani": k >= 1200000,
        })
    return jsonify({
        "karty_12m": round(total, 2),
        "limit": LIMIT,
        "procent": round(total / LIMIT * 100, 1),
        "alert": total >= LIMIT,
        "varovani": total >= 1200000,
        "per_firma": firmy_alert,
    })


@app.route("/api/statistiky/mesice")
def api_statistiky_mesice():
    firma = request.args.get("firma", "")
    clauses = ["datum <= ?"]
    params  = [date.today().isoformat()]
    if firma:
        clauses.append("firma_zkratka=?")
        params.append(firma)
    where = "WHERE " + " AND ".join(clauses)
    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT
                strftime('%Y', datum) as rok,
                strftime('%m', datum) as mesic,
                COUNT(*) as dni,
                ROUND(SUM(trzba_vcpk),2)  as trzba_vcpk_sum,
                ROUND(AVG(trzba_vcpk),2)  as trzba_vcpk_avg,
                ROUND(SUM(karty),2)       as karty_sum,
                ROUND(AVG(karty),2)       as karty_avg,
                ROUND(SUM(hotovost),2)    as hotovost_sum,
                ROUND(AVG(hotovost),2)    as hotovost_avg,
                ROUND(SUM(vydaje),2)      as vydaje_sum,
                ROUND(SUM(pk_celkem),2)   as pk_celkem_sum,
                SUM(pizza_cela)           as pizza_cela_sum,
                SUM(pizza_ctvrt)          as pizza_ctvrt_sum,
                SUM(burger)               as burger_sum,
                SUM(talire)               as talire_sum,
                SUM(burtgulas)            as burtgulas_sum,
                ROUND(AVG(pizza_cela),1)  as pizza_cela_avg,
                ROUND(AVG(pizza_ctvrt),1) as pizza_ctvrt_avg,
                ROUND(AVG(burger),1)      as burger_avg,
                ROUND(AVG(talire),1)      as talire_avg,
                ROUND(AVG(burtgulas),1)   as burtgulas_avg
            FROM reporty {where}
            AND trzba_vcpk > 0
            GROUP BY rok, mesic
            ORDER BY rok DESC, mesic DESC
        """, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/statistiky/roky")
def api_statistiky_roky():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                strftime('%Y', datum) as rok,
                strftime('%m', datum) as mesic,
                ROUND(AVG(trzba_vcpk),0) as prumer_den,
                firma_zkratka
            FROM reporty
            WHERE datum <= ? AND trzba_vcpk > 0
            GROUP BY rok, mesic
            ORDER BY rok, mesic
        """, (date.today().isoformat(),)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/export/reporty")
def export_reporty():
    fmt = request.args.get("format", "xlsx")
    od  = request.args.get("od", "")
    do_ = request.args.get("do", "")
    clauses, params = [], []
    if od:  clauses.append("datum>=?"); params.append(od)
    if do_: clauses.append("datum<=?"); params.append(do_)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    with get_db() as conn:
        rows = conn.execute(f"""
            SELECT datum,den,trzba_vcpk,karty,hotovost,vydaje,trzba,
                   pk50_ks,pk100_ks,pk_celkem,pizza_cela,pizza_ctvrt,
                   burger,talire,burtgulas,smena
            FROM reporty {where} ORDER BY datum
        """, params).fetchall()

    headers = ["datum","měsíc","den","TRŽBA vč. PK","karty","hotovost","výdaje","tržba",
               "pk50 ks","pk100 ks","poukaz Kč","pizza celá","čtvrt","burger","talíře","buřtguláš","KDO"]

    def r_val(r, key, idx):
        return r[key] if isinstance(r, dict) else r[idx]

    if fmt == "csv":
        buf = io.StringIO()
        w   = csv.writer(buf, delimiter=";")
        w.writerow(headers)
        for r in rows:
            d = date.fromisoformat(r_val(r,"datum",0)) if r_val(r,"datum",0) else None
            mesic = d.strftime("%B").upper() if d else ""
            w.writerow([d.day if d else "", mesic, r_val(r,"den",1), r_val(r,"trzba_vcpk",2),
                        r_val(r,"karty",3), r_val(r,"hotovost",4), r_val(r,"vydaje",5),
                        r_val(r,"trzba",6), r_val(r,"pk50_ks",7), r_val(r,"pk100_ks",8),
                        r_val(r,"pk_celkem",9), r_val(r,"pizza_cela",10), r_val(r,"pizza_ctvrt",11),
                        r_val(r,"burger",12), r_val(r,"talire",13), r_val(r,"burtgulas",14),
                        r_val(r,"smena",15)])
        buf.seek(0)
        return send_file(io.BytesIO(buf.getvalue().encode("utf-8-sig")),
                         mimetype="text/csv", download_name="reporty.csv", as_attachment=True)
    else:
        wb_out = openpyxl.Workbook()
        ws_out = wb_out.active; ws_out.title = str(date.today().year)
        _xlsx_header(ws_out, headers)
        mesice_cs = ["","LEDEN","ÚNOR","BŘEZEN","DUBEN","KVĚTEN","ČERVEN",
                     "ČERVENEC","SRPEN","ZÁŘÍ","ŘÍJEN","LISTOPAD","PROSINEC"]
        for r in rows:
            d = date.fromisoformat(r_val(r,"datum",0)) if r_val(r,"datum",0) else None
            mesic = mesice_cs[d.month] if d else ""
            ws_out.append([d.day if d else "", mesic, r_val(r,"den",1), r_val(r,"trzba_vcpk",2),
                           r_val(r,"karty",3), r_val(r,"hotovost",4), r_val(r,"vydaje",5),
                           r_val(r,"trzba",6), r_val(r,"pk50_ks",7), r_val(r,"pk100_ks",8),
                           r_val(r,"pk_celkem",9), r_val(r,"pizza_cela",10), r_val(r,"pizza_ctvrt",11),
                           r_val(r,"burger",12), r_val(r,"talire",13), r_val(r,"burtgulas",14),
                           r_val(r,"smena",15)])
        buf = io.BytesIO(); wb_out.save(buf); buf.seek(0)
        return send_file(buf, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                         download_name="reporty.xlsx", as_attachment=True)


# ── API: nahrání souboru ──────────────────────────────────────────────────────
@app.route("/api/nahrat-text", methods=["POST"])
def api_nahrat_text():
    text = request.json.get("text", "")
    if not text.strip():
        return jsonify({"error": "Prázdný text"}), 400
    data = _parse_makro_text(text)
    return jsonify(data)


def _parse_makro_text(text):
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
        if not ls: continue
        ll = ls.lower()

        m = re.search(r"Faktura\s*[čc\.]\s*/\s*VS\s*:\s*(\S+)", ls, re.IGNORECASE)
        if m and not result["cislo_faktury"]: result["cislo_faktury"] = m.group(1)
        m = re.search(r"Datum\s+vystavení\s*:\s*(\d{2}[-\.]\d{2}[-\.]\d{4})", ls, re.IGNORECASE)
        if m and not result["datum_vystaveni"]: result["datum_vystaveni"] = _makro_date(m.group(1).replace(".", "-") if "." in m.group(1) else m.group(1))
        m = re.search(r"Datum\s+splatnosti\s*:\s*(\d{2}[-\.]\d{2}[-\.]\d{4})", ls, re.IGNORECASE)
        if m and not result["datum_splatnosti"]: result["datum_splatnosti"] = _makro_date(m.group(1).replace(".", "-") if "." in m.group(1) else m.group(1))
        m = re.search(r"Celková\s+částka\s+([\d\s]{1,10}[,\.]\d{2})", ls, re.IGNORECASE)
        if m: result["celkem_s_dph"] = _parse_money(m.group(1))

        is_sleva = any(kw in ll for kw in sleva_kw)
        if is_sleva and items:
            neg = re.findall(r"-\s*(\d[\d\s]*[,\.]\d{2})", ls)
            if neg:
                sleva = _parse_money(neg[-1])
                items[-1]["celkem_s_dph"] = round(max(0, items[-1]["celkem_s_dph"] - sleva), 2)
                mn = items[-1]["mnozstvi"]
                if mn: items[-1]["cena_za_jednotku_s_dph"] = round(items[-1]["celkem_s_dph"] / mn, 4)
            continue

        mm = re.match(r"^(\d{6,14})\s+\*?(.+?)\s+(PC|KG|BG|KS|BX|CA|SW)\s+(.+)$", ls, re.IGNORECASE)
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

    typ_dokladu = request.form.get("typ_dokladu", "makro")

    ext = fname.rsplit(".", 1)[1].lower()
    if typ_dokladu == "doklad":
        data, err = parse_doklad_claude(fpath)
    elif ext == "pdf":
        data, err = parse_makro_pdf(fpath)
    else:
        data, err = parse_makro_image(fpath)

    if err:
        return jsonify({"error": err, "soubor_cesta": fname}), 200

    data["soubor_cesta"] = fname

    if data.get("cislo_faktury") and typ_dokladu == "makro":
        with get_db() as conn:
            row = conn.execute("""
                SELECT id, firma_zkratka, datum_vystaveni, celkem_s_dph
                FROM faktury
                WHERE cislo_faktury = ? AND dodavatel LIKE ?
                AND ABS(celkem_s_dph - ?) < 0.01
            """, (data["cislo_faktury"], "%MAKRO%", float(data.get("celkem_s_dph", 0)))).fetchone()
            if row:
                data["duplicita"] = {
                    "id": row["id"],
                    "firma": row["firma_zkratka"],
                    "datum": row["datum_vystaveni"],
                    "celkem": row["celkem_s_dph"]
                }

    return jsonify(data)

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
            if not nazev: continue
            mnozstvi = float(p.get("mnozstvi", 1) or 1)
            celkem   = float(p.get("celkem_s_dph", 0) or 0)
            cena_j   = float(p.get("cena_za_jednotku_s_dph", 0) or 0)
            if cena_j == 0 and mnozstvi:
                cena_j = celkem / mnozstvi
            jed = p.get("jednotka","ks")
            zbozi_id = _get_or_create_zbozi(conn, nazev)
            conn.execute("""
                INSERT INTO polozky (faktura_id, nazev, mnozstvi, jednotka,
                    cena_za_jednotku_s_dph, celkem_s_dph, zbozi_id)
                VALUES (?,?,?,?,?,?,?)
            """, (faktura_id, nazev, mnozstvi, jed, round(cena_j,4), round(celkem,2), zbozi_id))

        recalc_faktura_total(conn, faktura_id)

    return jsonify({"ok": True, "id": faktura_id})


def _get_or_create_zbozi(conn, nazev):
    row = conn.execute("SELECT zbozi_id FROM zbozi_aliasy WHERE alias=?", (nazev,)).fetchone()
    if row: return row["zbozi_id"]
    row = conn.execute("SELECT id FROM zbozi WHERE nazev_canonical=?", (nazev,)).fetchone()
    if row: return row["id"]
    cur = conn.execute("INSERT INTO zbozi (nazev_canonical) VALUES (?)", (nazev,))
    return cur.lastrowid

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
    data = request.json
    zbozi_id   = data.get("zbozi_id")
    alias_text = data.get("alias", "").strip()
    polozka_id = data.get("polozka_id")
    if not zbozi_id or not alias_text:
        return jsonify({"error": "Chybí zbozi_id nebo alias"}), 400
    with get_db() as conn:
        try:
            conn.execute("INSERT INTO zbozi_aliasy (zbozi_id, alias) VALUES (?,?)", (zbozi_id, alias_text))
        except Exception:
            conn.execute("UPDATE zbozi_aliasy SET zbozi_id=? WHERE alias=?", (zbozi_id, alias_text))
        conn.execute("UPDATE polozky SET zbozi_id=? WHERE nazev=?", (zbozi_id, alias_text))
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
        except Exception:
            row = conn.execute("SELECT id FROM zbozi WHERE nazev_canonical=?", (nazev,)).fetchone()
            return jsonify({"ok": True, "id": row["id"]})

@app.route("/api/statistiky")
def api_statistiky():
    firma = request.args.get("firma", "")
    od    = request.args.get("od", date.today().replace(day=1).isoformat())
    do_   = request.args.get("do", date.today().isoformat())

    f_cond  = "AND firma_zkratka=?" if firma else ""
    f_params = (firma,) if firma else ()

    with get_db() as conn:
        mesice = conn.execute(f"""
            SELECT strftime('%Y-%m', datum_vystaveni) m, ROUND(SUM(celkem_s_dph),2) castka
            FROM faktury
            WHERE datum_vystaveni>=? AND datum_vystaveni<=? {f_cond}
            GROUP BY m ORDER BY m
        """, (od, do_) + f_params).fetchall()

        dodavatele = conn.execute(f"""
            SELECT dodavatel, ROUND(SUM(celkem_s_dph),2) castka, COUNT(*) pocet
            FROM faktury
            WHERE datum_vystaveni>=? AND datum_vystaveni<=? {f_cond}
            GROUP BY dodavatel ORDER BY castka DESC LIMIT 10
        """, (od, do_) + f_params).fetchall()

        zbozi_top = conn.execute(f"""
            SELECT COALESCE(z.nazev_canonical, p.nazev) zbozi, ROUND(SUM(p.celkem_s_dph),2) castka,
                   ROUND(SUM(p.mnozstvi),2) mnozstvi, p.jednotka
            FROM polozky p
            JOIN faktury f ON f.id=p.faktura_id
            LEFT JOIN zbozi z ON z.id=p.zbozi_id
            WHERE f.datum_vystaveni>=? AND f.datum_vystaveni<=? {f_cond}
            GROUP BY COALESCE(z.id, p.nazev) ORDER BY castka DESC LIMIT 20
        """, (od, do_) + f_params).fetchall()

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
        for r in rows: w.writerow(list(r))
        buf.seek(0)
        return send_file(io.BytesIO(buf.getvalue().encode("utf-8-sig")),
                         mimetype="text/csv", download_name="faktury.csv", as_attachment=True)
    else:
        wb_out = openpyxl.Workbook()
        ws_out = wb_out.active; ws_out.title = "Faktury"
        _xlsx_header(ws_out, headers)
        for r in rows: ws_out.append(list(r))
        buf = io.BytesIO(); wb_out.save(buf); buf.seek(0)
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
        wb_out = openpyxl.Workbook()
        ws_out = wb_out.active; ws_out.title = "Položky"
        _xlsx_header(ws_out, headers)
        for r in rows: ws_out.append(list(r))
        buf = io.BytesIO(); wb_out.save(buf); buf.seek(0)
        return send_file(buf, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                         download_name="polozky.xlsx", as_attachment=True)

@app.route("/api/export/vyplaty")
def export_vyplaty():
    fmt   = request.args.get("format", "xlsx")
    firma = request.args.get("firma", "")
    od    = request.args.get("od", "")
    do_   = request.args.get("do", "")
    clauses, params = [], []
    if firma: clauses.append("firma_zkratka=?"); params.append(firma)
    if od:    clauses.append("datum>=?"); params.append(od)
    if do_:   clauses.append("datum<=?"); params.append(do_)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    with get_db() as conn:
        rows = conn.execute(f"SELECT firma_zkratka, jmeno, datum, castka, poznamka FROM vyplaty {where} ORDER BY datum DESC", params).fetchall()
    headers = ["Firma", "Jméno", "Datum", "Částka", "Poznámka"]
    if fmt == "csv":
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";")
        w.writerow(headers)
        for r in rows: w.writerow(list(r))
        buf.seek(0)
        return send_file(io.BytesIO(buf.getvalue().encode("utf-8-sig")), mimetype="text/csv", download_name="vyplaty.csv", as_attachment=True)
    else:
        wb_out = openpyxl.Workbook()
        ws_out = wb_out.active; ws_out.title = "Výplaty"
        _xlsx_header(ws_out, headers)
        for r in rows: ws_out.append(list(r))
        buf = io.BytesIO(); wb_out.save(buf); buf.seek(0)
        return send_file(buf, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", download_name="vyplaty.xlsx", as_attachment=True)

def _xlsx_header(ws, headers):
    green = "2D6A4F"
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor=green)
        cell.alignment = Alignment(horizontal="center")

@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_DIR, filename)


init_db()
migrate_db()

if __name__ == "__main__":
    print("=" * 55)
    print("  Správa faktur – spouštím server")
    print("  Otevři prohlížeč na: http://localhost:5000")
    print("=" * 55)
    app.run(host="0.0.0.0", port=5000, debug=False)
