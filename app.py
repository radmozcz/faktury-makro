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

# Google Cloud Storage
try:
    from google.cloud import storage as gcs_storage
    from google.oauth2 import service_account
    GCS_SUPPORT = True
except ImportError:
    GCS_SUPPORT = False
    print("⚠  google-cloud-storage není nainstalován – GCS nebude fungovat")
from datetime import datetime, date, timedelta
from flask import Flask, render_template, request, jsonify, send_file, redirect, url_for, send_from_directory, session
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
    _tess_path = r"C:\Program Files\Tesseract-OCR\	esseract.exe"
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

def get_gcs_client():
    """Vrátí GCS bucket nebo None pokud není nakonfigurováno."""
    if not GCS_SUPPORT:
        return None
    creds_json = os.environ.get("GCS_CREDENTIALS_JSON", "")
    bucket_name = os.environ.get("GCS_BUCKET_NAME", "")
    if not creds_json or not bucket_name:
        return None
    try:
        creds_info = json.loads(creds_json)
        creds = service_account.Credentials.from_service_account_info(creds_info)
        client = gcs_storage.Client(credentials=creds, project=creds_info.get("project_id"))
        return client.bucket(bucket_name)
    except Exception as e:
        print(f"⚠  GCS init error: {e}")
        return None

def upload_to_gcs(local_path, filename):
    """Nahraje soubor do GCS a vrátí signed URL (platné 7 dní) nebo None."""
    bucket = get_gcs_client()
    if not bucket:
        return None
    try:
        blob = bucket.blob(f"faktury/{filename}")
        blob.upload_from_filename(local_path)
        # Signed URL platné 7 dní
        url = blob.generate_signed_url(
            expiration=timedelta(days=7),
            method="GET",
            version="v4"
        )
        return url
    except Exception as e:
        print(f"⚠  GCS upload error: {e}")
        return None

def get_gcs_url(filename):
    """Vrátí čerstvé signed URL pro existující soubor v GCS."""
    bucket = get_gcs_client()
    if not bucket:
        return None
    try:
        blob = bucket.blob(f"faktury/{filename}")
        if not blob.exists():
            return None
        return blob.generate_signed_url(
            expiration=timedelta(days=7),
            method="GET",
            version="v4"
        )
    except Exception as e:
        print(f"⚠  GCS url error: {e}")
        return None

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024
app.secret_key = os.environ.get("SECRET_KEY", "bistro-tajny-klic-2024-zmen-me")

# ── Přihlašování ────────────────────────────────────────────────────────────────
# Role: admin, verunka, ucetni
ROLE_NAMES = {
    "admin":   "ADMIN",
    "verunka": "VERUNKA",
    "ucetni":  "UCETNI",
}

# Výchozí oprávnění (co smí kdo vidět/dělat)
# Klíče odpovídají sekcím v aplikaci
DEFAULT_PRAVA = {
    "verunka": {
        "faktury_zobrazit":  True,
        "faktury_upravit":   True,
        "faktury_smazat":    False,
        "faktury_export":    True,
        "reporty_zobrazit":  True,
        "reporty_upravit":   True,
        "vyplaty_zobrazit":  True,
        "vyplaty_upravit":   False,
        "zbozi_zobrazit":    True,
        "vydaje_zobrazit":              True,
        "vydaje_upravit":               True,
        "vydaje_smazat":                False,
        "soukrome_vydaje_zobrazit":     False,
        "soukrome_vydaje_upravit":      False,
        "soukrome_vydaje_smazat":       False,
        "naklady_zobrazit":             False,
        "bankovni_vypisy":              False,
        "statistiky":                   False,
        "nastaveni":                    False,
        "vystavene_zobrazit":           False,
        "vystavene_upravit":            False,
    },
    "ucetni": {
        "faktury_zobrazit":  True,
        "faktury_upravit":   False,
        "faktury_smazat":    False,
        "faktury_export":    True,
        "reporty_zobrazit":  False,
        "reporty_upravit":   False,
        "vyplaty_zobrazit":  False,
        "vyplaty_upravit":   False,
        "zbozi_zobrazit":    False,
        "vydaje_zobrazit":              True,
        "vydaje_upravit":               False,
        "vydaje_smazat":                False,
        "soukrome_vydaje_zobrazit":     False,
        "soukrome_vydaje_upravit":      False,
        "soukrome_vydaje_smazat":       False,
        "naklady_zobrazit":             True,
        "bankovni_vypisy":              True,
        "statistiky":                   False,
        "nastaveni":                    False,
        "vystavene_zobrazit":           True,
        "vystavene_upravit":            False,
    },
}

def get_prava_z_db():
    """Načte matici oprávnění z databáze, nebo vrátí výchozí."""
    try:
        with get_db() as conn:
            cur = conn.execute("SELECT role, sekce, povoleno FROM prava")
            rows = cur.fetchall()
        if not rows:
            return DEFAULT_PRAVA.copy()
        prava = {"verunka": {}, "ucetni": {}}
        for r in rows:
            role = r["role"] if isinstance(r, dict) else r[0]
            sekce = r["sekce"] if isinstance(r, dict) else r[1]
            povoleno = r["povoleno"] if isinstance(r, dict) else r[2]
            if role in prava:
                prava[role][sekce] = bool(povoleno)
        # Doplnit chybějící klíče výchozími hodnotami
        for role in ["verunka", "ucetni"]:
            for sekce, val in DEFAULT_PRAVA[role].items():
                if sekce not in prava[role]:
                    prava[role][sekce] = val
        return prava
    except Exception:
        return DEFAULT_PRAVA.copy()

def ma_pravo(sekce):
    """Zkontroluje zda přihlášený uživatel má právo na danou sekci."""
    role = session.get("role", "")
    if role == "admin":
        return True
    prava = get_prava_z_db()
    return prava.get(role, {}).get(sekce, False)

def vyzaduj_prihlaseni(f):
    """Dekorátor – vrátí 401 pokud uživatel není přihlášen."""
    from functools import wraps
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("role"):
            return jsonify({"error": "Nejsi přihlášen", "login_required": True}), 401
        return f(*args, **kwargs)
    return wrapper

DEFAULT_CONFIG = {
    "firmy": ["FP", "MR", "CFF"],
    "app_nazev": "Správa faktur",
    "ico_map": {},
    "terminal_limit": 100000,
    "dph_limit": 2000000,
    "terminal_aktivni": {},
    "terminal_od": {}
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
        # datum_vystaveni a datum jsou TEXT sloupce – při porovnání s datem je nutný cast
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
            soubor_url      TEXT,
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
        ("prava", """CREATE TABLE IF NOT EXISTS prava (
            id      SERIAL PRIMARY KEY,
            role    TEXT NOT NULL,
            sekce   TEXT NOT NULL,
            povoleno INTEGER DEFAULT 0,
            UNIQUE(role, sekce)
        )"""),
        ("pausalni_odvody", """CREATE TABLE IF NOT EXISTS pausalni_odvody (
            id      SERIAL PRIMARY KEY,
            jmeno   TEXT NOT NULL,
            nazev   TEXT NOT NULL,
            castka  REAL NOT NULL DEFAULT 0,
            poradi  INTEGER DEFAULT 0,
            UNIQUE(jmeno, nazev)
        )"""),
        ("bankovni_pohyby", """CREATE TABLE IF NOT EXISTS bankovni_pohyby (
            id              SERIAL PRIMARY KEY,
            banka           TEXT NOT NULL,
            datum           TEXT NOT NULL,
            castka          REAL NOT NULL DEFAULT 0,
            protiucet       TEXT DEFAULT '',
            nazev_protiucet TEXT DEFAULT '',
            typ_transakce   TEXT DEFAULT '',
            zprava          TEXT DEFAULT '',
            id_transakce    TEXT UNIQUE,
            firma_zkratka   TEXT DEFAULT '',
            created_at      TEXT DEFAULT NOW()
        )"""),
        ("vydaje", """CREATE TABLE IF NOT EXISTS vydaje (
            id              SERIAL PRIMARY KEY,
            firma_zkratka   TEXT NOT NULL,
            dodavatel       TEXT DEFAULT '',
            datum           TEXT DEFAULT '',
            datum_splatnosti TEXT DEFAULT '',
            castka          REAL NOT NULL DEFAULT 0,
            zpusob_uhrady   TEXT DEFAULT 'hotovost',
            stav            TEXT DEFAULT 'nezaplaceno',
            popis           TEXT DEFAULT '',
            poznamka        TEXT DEFAULT '',
            soubor_cesta    TEXT DEFAULT '',
            soubor_url      TEXT DEFAULT '',
            zdroj           TEXT DEFAULT 'rucni',
            typ             TEXT DEFAULT 'provozni',
            created_at      TEXT DEFAULT NOW()
        )"""),
        ("vydaje_polozky", """CREATE TABLE IF NOT EXISTS vydaje_polozky (
            id          SERIAL PRIMARY KEY,
            vydaj_id    INTEGER NOT NULL,
            nazev       TEXT NOT NULL,
            castka      REAL NOT NULL DEFAULT 0
        )"""),
        ("vystavene_faktury", """CREATE TABLE IF NOT EXISTS vystavene_faktury (
            id                SERIAL PRIMARY KEY,
            firma_zkratka     TEXT    NOT NULL,
            cislo_faktury     TEXT    DEFAULT '',
            datum             TEXT    DEFAULT '',
            datum_splatnosti  TEXT    DEFAULT '',
            odberatel         TEXT    DEFAULT '',
            popis             TEXT    DEFAULT '',
            castka            REAL    NOT NULL DEFAULT 0,
            stav              TEXT    DEFAULT 'nezaplaceno',
            soubor_url        TEXT    DEFAULT '',
            duplicita_id      INTEGER DEFAULT NULL,
            created_at        TEXT    DEFAULT NOW()
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
    # Migrace: obdobi_od, obdobi_do ve vyplatach
    with get_db() as conn:
        if _USE_PG:
            cur = conn.execute("SELECT column_name FROM information_schema.columns WHERE table_name='vyplaty'")
            vypl_cols = [r["column_name"] for r in cur.fetchall()]
        else:
            vypl_cols = [row[1] for row in conn.execute("PRAGMA table_info(vyplaty)").fetchall()]
        for col, typ in [("obdobi_od","TEXT"), ("obdobi_do","TEXT")]:
            if col not in vypl_cols:
                try: conn.execute(f"ALTER TABLE vyplaty ADD COLUMN {col} {typ}")
                except Exception: pass

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
            ("soubor_url","TEXT"),
        ]:
            if col not in existing:
                try: conn.execute(f"ALTER TABLE reporty ADD COLUMN {col} {typ}")
                except Exception: pass
        if _USE_PG:
            cur2 = conn.execute("SELECT column_name FROM information_schema.columns WHERE table_name='faktury'")
            fakt_cols = [r["column_name"] for r in cur2.fetchall()]
        else:
            fakt_cols = [row[1] for row in conn.execute("PRAGMA table_info(faktury)").fetchall()]
        if "duplicita_id" not in fakt_cols:
            try: conn.execute("ALTER TABLE faktury ADD COLUMN duplicita_id INTEGER")
            except Exception: pass
        if "soubor_url" not in fakt_cols:
            try: conn.execute("ALTER TABLE faktury ADD COLUMN soubor_url TEXT")
            except Exception: pass
        # Migrace vydaje
        if _USE_PG:
            cur3 = conn.execute("SELECT column_name FROM information_schema.columns WHERE table_name='vydaje'")
            vydaj_cols = [r["column_name"] for r in cur3.fetchall()]
        else:
            vydaj_cols = [row[1] for row in conn.execute("PRAGMA table_info(vydaje)").fetchall()]
        if "popis" not in vydaj_cols:
            try: conn.execute("ALTER TABLE vydaje ADD COLUMN popis TEXT DEFAULT ''")
            except Exception: pass
        if "stav" not in vydaj_cols:
            try: conn.execute("ALTER TABLE vydaje ADD COLUMN stav TEXT DEFAULT 'nezaplaceno'")
            except Exception: pass
        if "datum_splatnosti" not in vydaj_cols:
            try: conn.execute("ALTER TABLE vydaje ADD COLUMN datum_splatnosti TEXT DEFAULT ''")
            except Exception: pass
        if "datum_uhrady" not in vydaj_cols:
            try: conn.execute("ALTER TABLE vydaje ADD COLUMN datum_uhrady TEXT DEFAULT ''")
            except Exception: pass
        if "banka_uhrady" not in vydaj_cols:
            try: conn.execute("ALTER TABLE vydaje ADD COLUMN banka_uhrady TEXT DEFAULT ''")
            except Exception: pass
        if "typ" not in vydaj_cols:
            try: conn.execute("ALTER TABLE vydaje ADD COLUMN typ TEXT DEFAULT 'provozni'")
            except Exception: pass
    # Migrace vystavene_faktury
    with get_db() as conn:
        if _USE_PG:
            cur4 = conn.execute("SELECT column_name FROM information_schema.columns WHERE table_name='vystavene_faktury'")
            vyst_cols = [r["column_name"] for r in cur4.fetchall()]
        else:
            vyst_cols = [row[1] for row in conn.execute("PRAGMA table_info(vystavene_faktury)").fetchall()]
        if "datum_splatnosti" not in vyst_cols:
            try: conn.execute("ALTER TABLE vystavene_faktury ADD COLUMN datum_splatnosti TEXT DEFAULT ''")
            except Exception: pass
        if "duplicita_id" not in vyst_cols:
            try: conn.execute("ALTER TABLE vystavene_faktury ADD COLUMN duplicita_id INTEGER DEFAULT NULL")
            except Exception: pass
    # Drive tabulky
    with get_db() as conn:
        conn.execute("DROP TABLE IF EXISTS drive_channels")
        conn.execute("DROP TABLE IF EXISTS drive_zpracovane")
        conn.execute("""CREATE TABLE IF NOT EXISTS drive_zpracovane (
            id SERIAL PRIMARY KEY, file_id TEXT UNIQUE, zpracovano_at TEXT)""")
        conn.execute("""CREATE TABLE IF NOT EXISTS drive_channels (
            id SERIAL PRIMARY KEY, channel_id TEXT, resource_id TEXT, expiration TEXT)""")
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

            # Pokud PDF neobsahuje MAKRO text, předej rovnou Claude
            makro_keywords = ["MAKRO", "makro", "Cash & Carry"]
            if not any(kw in first_text for kw in makro_keywords):
                return None, "Není MAKRO faktura"

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


def parse_faktura_claude(filepath):
    """Univerzální parser faktur a účtenek přes Claude API – funguje pro PDF i obrázky."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return None, "ANTHROPIC_API_KEY není nastaven"

    try:
        ext = filepath.rsplit(".", 1)[-1].lower()
        with open(filepath, "rb") as f:
            raw = f.read()
        b64 = base64.standard_b64encode(raw).decode("utf-8")

        if ext == "pdf":
            media_type = "application/pdf"
            source_type = "base64"
            content_block = {
                "type": "document",
                "source": {"type": "base64", "media_type": media_type, "data": b64}
            }
        else:
            media_map = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
                         "bmp": "image/bmp", "tiff": "image/tiff", "webp": "image/webp"}
            media_type = media_map.get(ext, "image/jpeg")
            content_block = {
                "type": "image",
                "source": {"type": "base64", "media_type": media_type, "data": b64}
            }

        prompt = """Jsi expert na čtení faktur a účtenek. Přečti tento doklad VELMI PEČLIVĚ.
Odpověz POUZE platným JSON objektem, žádný jiný text, žádné backticky, žádné komentáře.

Formát odpovědi:
{
  "dodavatel": "název dodavatele nebo obchodu",
  "cislo_faktury": "číslo faktury nebo variabilní symbol nebo číslo účtenky, nebo null",
  "datum_vystaveni": "YYYY-MM-DD nebo null",
  "datum_splatnosti": "YYYY-MM-DD nebo null",
  "zpusob_uhrady": "hotově/kartou/převodem nebo null",
  "celkem_s_dph": číslo (celková částka včetně DPH),
  "polozky": [
    {
      "nazev": "název položky",
      "mnozstvi": číslo,
      "jednotka": "ks/kg/l/...",
      "cena_za_jednotku_s_dph": číslo,
      "celkem_s_dph": číslo
    }
  ]
}

PRAVIDLA:
- Všechny částky jsou v Kč, piš jen číslo bez symbolu Kč
- Desetinná čárka nebo tečka = desetinné místo (475,55 = 475.55)
- Pokud není datum splatnosti, vrať null
- Pokud není číslo faktury/VS, vrať null
- Způsob úhrady: pokud vidíš "karta", "card", "kartou" → "kartou"; "cash", "hotov" → "hotově"
- Položky: zahrň všechny položky které vidíš na dokladu
- celkem_s_dph u položky = množství × cena za jednotku
"""

        client = anthropic.Anthropic(api_key=api_key)
        message = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2000,
            messages=[{
                "role": "user",
                "content": [content_block, {"type": "text", "text": prompt}]
            }]
        )

        text = message.content[0].text.strip()
        text = re.sub(r"^```json\s*", "", text)
        text = re.sub(r"```$", "", text).strip()
        parsed = json.loads(text)

        # Normalizace výstupu
        result = {
            "dodavatel":        parsed.get("dodavatel", ""),
            "cislo_faktury":    parsed.get("cislo_faktury") or "",
            "datum_vystaveni":  parsed.get("datum_vystaveni") or "",
            "datum_splatnosti": parsed.get("datum_splatnosti") or "",
            "zpusob_uhrady":    parsed.get("zpusob_uhrady") or "",
            "celkem_s_dph":     float(parsed.get("celkem_s_dph") or 0),
            "polozky": [
                {
                    "nazev":                   p.get("nazev", ""),
                    "mnozstvi":                float(p.get("mnozstvi", 1) or 1),
                    "jednotka":                p.get("jednotka", "ks"),
                    "cena_za_jednotku_s_dph":  float(p.get("cena_za_jednotku_s_dph", 0) or 0),
                    "celkem_s_dph":            float(p.get("celkem_s_dph", 0) or 0),
                }
                for p in parsed.get("polozky", [])
                if p.get("nazev", "").strip()
            ]
        }
        return result, None

    except Exception as e:
        return None, str(e)


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


JMENA_MAP = {
    "rada": "Ráďa", "radek": "Ráďa", "ráďa": "Ráďa", "radi": "Ráďa",
    "verka": "Věrka", "vera": "Věrka", "věra": "Věrka", "věrka": "Věrka",
    "renča": "Renča", "renata": "Renča", "renca": "Renča",
    "vendy": "Vendy", "wendy": "Vendy",
    "vali": "Vali",
}

def normalize_jmena(text):
    if not text:
        return ""
    parts = re.split(r"[,/\s]+", text.strip())
    result = []
    for p in parts:
        p = p.strip().lower().rstrip(".,")
        if not p:
            continue
        canonical = JMENA_MAP.get(p, p.capitalize())
        result.append(canonical)
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
- Tečka nebo čárka UVNITŘ čísla = VŽDY oddělovač tisíců, NIKDY desetinná čárka
- Příklady: 6.888 = 6888, 6.600 = 6600, 13.541 = 13541, 5.100 = 5100
- Čísla zapisuj jako celá čísla bez teček a čárek
- Pomlčka nebo lomítko za číslem (6.888,- nebo 6.888/) = ignoruj, je to jen styl zápisu
- Číslo před "x" nebo "X" = počet kusů (6x = 6, 5X = 5) — "x" NENÍ číslice!
- PK zápis: "6x/600" nebo "6x 100" znamená 6 kusů poukazek — zapiš jako pk50_ks nebo pk100_ks podle hodnoty
- POZOR na záměnu číslic: "5" a "3" jsou si podobné při ručním psaní — čti kontext (53 je reálná hodnota KOV)
- Pokud číslo vypadá jako "33" ale kontext říká KOV nebo KARTY → přečti znovu, může být "53" nebo "83"
- BURGER: hledej slovo BURGER nebo BURGR na reportu a číslo za ním nebo před ním — nezapisuj 0 pokud tam číslo je

PRAVIDLA PRO JMÉNA (SMĚNA):
- Jména jsou oddělena čárkou nebo mezerou
- Ráďa, Rádá, Rada, Rado, Radi → "Ráďa"
- Věrka, Verka, Věra, Vera → "Věrka" — POUZE pokud jméno začíná VĚ nebo VE a druhé písmeno je E nebo Ě
- Renča, Renata, Renca → "Renča"
- Vendy, Wendy, Vendi, Vendu, Vendy → "Vendy" — jméno začíná VEN nebo WEN
- Vali, Valy → "Vali"
- KRITICKÉ: "VENDY" a "Věrka" jsou RŮZNÉ osoby! Pokud vidíš VEN → VENDY. Pokud vidíš VĚR nebo VER → Věrka.
- Na směně mohou být najednou: Ráďa, Vendy, Vali, Věrka, Renča — přečti KAŽDÉ jméno samostatně

PRAVIDLA PRO DATUM:
- Hledej datum ve formátu "D.M" nebo "D/M" nahoře na lístku
- Pokud chybí, vrať dnešní datum: "{today}"

PRAVIDLA PRO PIZZU A BURGERY:
- "CELÁ" nebo "CELÉ" u pizzy = pizza_cela
- "ČTVRT" nebo "1/4" u pizzy = pizza_ctvrt  
- Číslo za názvem s "x" = počet kusů (5x = 5)
- BURTGULÁŠ, BURTGULAS, BURGULÁŠ → burtgulas
- BURGER, BURGR → burger
- TALÍŘ, TALIRE, POČET TALÍŘŮ → talire
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


# ═══════════════════════════════════════════════════════════════════════════════
#  ROUTES
# ═══════════════════════════════════════════════════════════════════════════════


# ── Login / Logout ──────────────────────────────────────────────────────────────
@app.route("/api/login", methods=["POST"])
def api_login():
    heslo = (request.json or {}).get("heslo", "")
    admin_pwd   = os.environ.get("PASSWORD_ADMIN", "")
    verunka_pwd = os.environ.get("PASSWORD_VERUNKA", "")
    ucetni_pwd  = os.environ.get("PASSWORD_UCETNI", "")

    if heslo and heslo == admin_pwd:
        session["role"] = "admin"
    elif heslo and heslo == verunka_pwd:
        session["role"] = "verunka"
    elif heslo and heslo == ucetni_pwd:
        session["role"] = "ucetni"
    else:
        return jsonify({"ok": False, "chyba": "Špatné heslo"}), 401

    role = session["role"]
    return jsonify({
        "ok": True,
        "role": role,
        "jmeno": ROLE_NAMES[role],
        "prava": get_prava_z_db().get(role, {}) if role != "admin" else "vse",
    })

@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"ok": True})

@app.route("/api/me")
def api_me():
    """Vrátí info o přihlášeném uživateli."""
    role = session.get("role")
    if not role:
        return jsonify({"prihlasen": False})
    return jsonify({
        "prihlasen": True,
        "role": role,
        "jmeno": ROLE_NAMES.get(role, role),
        "prava": get_prava_z_db().get(role, {}) if role != "admin" else "vse",
    })

@app.route("/api/prava", methods=["GET"])
@vyzaduj_prihlaseni
def api_prava_get():
    if session.get("role") != "admin":
        return jsonify({"error": "Pouze admin"}), 403
    return jsonify(get_prava_z_db())

@app.route("/api/prava", methods=["POST"])
@vyzaduj_prihlaseni
def api_prava_set():
    if session.get("role") != "admin":
        return jsonify({"error": "Pouze admin"}), 403
    data = request.json or {}
    # data = {"verunka": {"faktury_zobrazit": true, ...}, "ucetni": {...}}
    try:
        with get_db() as conn:
            for role, sekce_dict in data.items():
                if role not in ("verunka", "ucetni"):
                    continue
                for sekce, povoleno in sekce_dict.items():
                    conn.execute("""
                        INSERT INTO prava (role, sekce, povoleno)
                        VALUES (?, ?, ?)
                        ON CONFLICT (role, sekce) DO UPDATE SET povoleno = excluded.povoleno
                    """, (role, sekce, 1 if povoleno else 0))
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "chyba": str(e)}), 500

@app.route("/")
def index():
    update_stav_po_splatnosti()
    return render_template("index.html", config=load_config())



@app.route("/api/config", methods=["GET", "POST"])
@vyzaduj_prihlaseni
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
    if "terminal_limit" in data:
        cfg["terminal_limit"] = int(data["terminal_limit"] or 100000)
    if "dph_limit" in data:
        cfg["dph_limit"] = int(data["dph_limit"] or 2000000)
    if "terminal_prepnout" in data:
        # Přepnutí aktivní firmy - nastaví datum od
        firma = data["terminal_prepnout"]
        if not cfg.get("terminal_od"):
            cfg["terminal_od"] = {}
        from datetime import date as _date
        cfg["terminal_od"][firma] = _date.today().isoformat()
        # Označit tuto firmu jako aktivní (ostatní deaktivovat)
        cfg["terminal_aktivni"] = {f: (f == firma) for f in cfg.get("firmy", [])}
    save_config(cfg)
    return jsonify({"ok": True})

@app.route("/api/reporty/karty-stats")
@vyzaduj_prihlaseni
def api_karty_stats():
    """Statistiky karet pro info panel - měsíční a roční součty per firma."""
    import datetime as _dt
    cfg = load_config()
    firmy = cfg.get("firmy", [])
    terminal_od = cfg.get("terminal_od", {})
    terminal_limit = cfg.get("terminal_limit", 100000)
    dph_limit = cfg.get("dph_limit", 2000000)
    rok = str(_dt.date.today().year)
    result = {}
    with get_db() as conn:
        for firma in firmy:
            # Roční karty (od 1.1. aktuálního roku)
            row = conn.execute("""
                SELECT COALESCE(SUM(karty),0) as total
                FROM reporty
                WHERE firma_zkratka=? AND datum>=?
            """, (firma, f"{rok}-01-01")).fetchone()
            rocni = float((row or {}).get("total", 0))

            # Měsíční karty (od data přepnutí na tuto firmu)
            od = terminal_od.get(firma, f"{rok}-01-01")
            row2 = conn.execute("""
                SELECT COALESCE(SUM(karty),0) as total
                FROM reporty
                WHERE firma_zkratka=? AND datum>=?
            """, (firma, od)).fetchone()
            mesicni = float((row2 or {}).get("total", 0))

            aktivni = cfg.get("terminal_aktivni", {}).get(firma, False)
            result[firma] = {
                "rocni": rocni,
                "mesicni": mesicni,
                "terminal_od": od,
                "terminal_limit": terminal_limit,
                "dph_limit": dph_limit,
                "aktivni": aktivni,
            }
    return jsonify(result)

@app.route("/api/dashboard")
@vyzaduj_prihlaseni
def api_dashboard():
    update_stav_po_splatnosti()
    firma = request.args.get("firma", "")
    with get_db() as conn:
        mesic = date.today().strftime("%Y-%m")
        where_firma = "AND firma_zkratka=?" if firma else ""
        params_base = (firma,) if firma else ()

        # ── OPRAVA: pojmenované sloupce místo indexů [0],[1]
        # ── OPRAVA2: PostgreSQL potřebuje cast pro LIKE na textovém sloupci
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
@vyzaduj_prihlaseni
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
                   datum_vystaveni, datum_splatnosti, celkem_s_dph, stav, zdroj, duplicita_id
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
@vyzaduj_prihlaseni
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
    faktura_dict = dict(f)
    # Pokud nemáme uloženou URL, vygeneruj čerstvou GCS URL
    if not faktura_dict.get("soubor_url") and faktura_dict.get("soubor_cesta"):
        gcs_url = get_gcs_url(faktura_dict["soubor_cesta"])
        if gcs_url:
            faktura_dict["soubor_url"] = gcs_url
    return jsonify({"faktura": faktura_dict, "polozky": [dict(p) for p in polozky]})

@app.route("/api/faktury/<int:fid>/stav", methods=["POST"])
@vyzaduj_prihlaseni
def api_faktura_stav(fid):
    stav = request.json.get("stav")
    if stav not in ("ceka", "zaplaceno", "po_splatnosti"):
        return jsonify({"error": "Neplatný stav"}), 400
    with get_db() as conn:
        conn.execute("UPDATE faktury SET stav=? WHERE id=?", (stav, fid))
    return jsonify({"ok": True})

@app.route("/api/faktury/<int:fid>", methods=["DELETE"])
@vyzaduj_prihlaseni
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
@vyzaduj_prihlaseni
def api_faktura_update(fid):
    data = request.json
    fields = ["firma_zkratka","dodavatel","cislo_faktury","datum_vystaveni",
              "datum_splatnosti","zpusob_uhrady","stav","celkem_s_dph"]
    set_parts = [f"{f}=?" for f in fields if f in data]
    vals = [data[f] for f in fields if f in data]
    if set_parts:
        vals.append(fid)
        with get_db() as conn:
            conn.execute(f"UPDATE faktury SET {','.join(set_parts)} WHERE id=?", vals)

    # Zpracovat položky pokud jsou v datech
    polozky = data.get("polozky")
    if polozky is not None:
        with get_db() as conn:
            # Smazat staré položky a vložit nové
            conn.execute("DELETE FROM polozky WHERE faktura_id=?", (fid,))
            for p in polozky:
                nazev = (p.get("nazev") or "").strip()
                if not nazev: continue
                mnozstvi = float(p.get("mnozstvi") or 1)
                celkem   = float(p.get("celkem_s_dph") or 0)
                cena_j   = float(p.get("cena_za_jednotku_s_dph") or 0)
                if cena_j == 0 and mnozstvi:
                    cena_j = celkem / mnozstvi
                jed = (p.get("jednotka") or "").strip()
                zbozi_id = _get_or_create_zbozi(conn, nazev)
                conn.execute("""
                    INSERT INTO polozky (faktura_id, nazev, mnozstvi, jednotka,
                        cena_za_jednotku_s_dph, celkem_s_dph, zbozi_id)
                    VALUES (?,?,?,?,?,?,?)
                """, (fid, nazev, mnozstvi, jed, round(cena_j,4), round(celkem,2), zbozi_id))
            recalc_faktura_total(conn, fid)
    return jsonify({"ok": True})

# ── API: výplaty ──────────────────────────────────────────────────────────────
@app.route("/api/vyplaty/zamestnanci", methods=["GET"])
@vyzaduj_prihlaseni
def api_vyplaty_zamestnanci():
    with get_db() as conn:
        rows = conn.execute("SELECT DISTINCT jmeno FROM vyplaty ORDER BY jmeno").fetchall()
    return jsonify({"jmena": [r["jmeno"] for r in rows]})

@app.route("/api/vyplaty", methods=["GET"])
@vyzaduj_prihlaseni
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
            # ── OPRAVA: pojmenovaný sloupec – funguje v PG i SQLite
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
@vyzaduj_prihlaseni
def api_vyplata_ulozit():
    try:
        data = request.json
        if not data.get("jmeno") or not data.get("datum") or data.get("castka") is None:
            return jsonify({"error": "Chybí povinná pole"}), 400
        with get_db() as conn:
            cur = conn.execute("""
                INSERT INTO vyplaty (jmeno, datum, castka, poznamka, firma_zkratka, obdobi_od, obdobi_do)
                VALUES (?,?,?,?,?,?,?)
            """, (
                data["jmeno"],
                data["datum"],
                float(data["castka"]),
                data.get("poznamka", ""),
                data.get("firma_zkratka", ""),
                data.get("obdobi_od") or None,
                data.get("obdobi_do") or None,
            ))
        return jsonify({"ok": True, "id": cur.lastrowid})
    except Exception as e:
        import traceback
        app.logger.error(f"api_vyplata_ulozit error: {traceback.format_exc()}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/vyplaty/<int:vid>", methods=["DELETE"])
@vyzaduj_prihlaseni
def api_vyplata_delete(vid):
    with get_db() as conn:
        conn.execute("DELETE FROM vyplaty WHERE id=?", (vid,))
    return jsonify({"ok": True})

@app.route("/api/vyplaty/<int:vid>", methods=["PUT"])
@vyzaduj_prihlaseni
def api_vyplata_update(vid):
    data = request.json
    fields = ["jmeno", "datum", "castka", "poznamka", "firma_zkratka", "obdobi_od", "obdobi_do"]
    set_parts = [f"{f}=?" for f in fields if f in data]
    vals = [data[f] for f in fields if f in data]
    if not set_parts:
        return jsonify({"ok": True})
    vals.append(vid)
    with get_db() as conn:
        conn.execute(f"UPDATE vyplaty SET {','.join(set_parts)} WHERE id=?", vals)
    return jsonify({"ok": True})

@app.route("/api/vyplaty/souhrn/<jmeno>")
@vyzaduj_prihlaseni
def api_vyplaty_souhrn(jmeno):
    """Vrátí součet výplat za aktuální měsíc a rok pro daného zaměstnance."""
    from datetime import date as _date
    dnes = _date.today()
    mesic_od = f"{dnes.year}-{dnes.month:02d}-01"
    rok_od   = f"{dnes.year}-01-01"
    rok_do   = f"{dnes.year}-12-31"
    with get_db() as conn:
        r_mesic = conn.execute(
            "SELECT COALESCE(SUM(castka),0) as total FROM vyplaty WHERE jmeno=? AND datum>=?",
            (jmeno, mesic_od)
        ).fetchone()
        r_rok = conn.execute(
            "SELECT COALESCE(SUM(castka),0) as total FROM vyplaty WHERE jmeno=? AND datum>=? AND datum<=?",
            (jmeno, rok_od, rok_do)
        ).fetchone()
        odvody = conn.execute(
            "SELECT nazev, castka FROM pausalni_odvody WHERE jmeno=? ORDER BY poradi, nazev",
            (jmeno,)
        ).fetchall()
    celkem_mesic = _first_val(r_mesic)
    celkem_rok   = _first_val(r_rok)
    odvody_list  = [dict(r) for r in odvody]
    odvody_suma  = sum(float(r["castka"]) for r in odvody_list)
    return jsonify({
        "celkem_mesic": round(celkem_mesic, 2),
        "celkem_rok":   round(celkem_rok, 2),
        "odvody":       odvody_list,
        "odvody_suma":  round(odvody_suma, 2),
    })

@app.route("/api/pausalni-odvody/<jmeno>", methods=["GET"])
@vyzaduj_prihlaseni
def api_pausalni_get(jmeno):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, nazev, castka FROM pausalni_odvody WHERE jmeno=? ORDER BY poradi, nazev",
            (jmeno,)
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/pausalni-odvody/<jmeno>", methods=["POST"])
@vyzaduj_prihlaseni
def api_pausalni_save(jmeno):
    """Uloží seznam paušálních odvodů pro zaměstnance (replace all)."""
    data = request.json or []
    with get_db() as conn:
        conn.execute("DELETE FROM pausalni_odvody WHERE jmeno=?", (jmeno,))
        for i, item in enumerate(data):
            nazev  = str(item.get("nazev","")).strip()
            castka = float(item.get("castka", 0) or 0)
            if nazev:
                conn.execute(
                    "INSERT INTO pausalni_odvody (jmeno, nazev, castka, poradi) VALUES (?,?,?,?)",
                    (jmeno, nazev, castka, i)
                )
    return jsonify({"ok": True})


# ── API: VÝDAJE ───────────────────────────────────────────────────────────────
@app.route("/api/vydaje")
@vyzaduj_prihlaseni
def api_vydaje_list():
    firma = request.args.get("firma", "")
    od    = request.args.get("od", "")
    do_   = request.args.get("do", "")
    stav  = request.args.get("stav", "")
    typ   = request.args.get("typ", "provozni")
    clauses, params = [], []
    if firma: clauses.append("firma_zkratka=?"); params.append(firma)
    if od:    clauses.append("datum>=?"); params.append(od)
    if do_:   clauses.append("datum<=?"); params.append(do_)
    if stav:  clauses.append("stav=?"); params.append(stav)
    clauses.append("COALESCE(typ,'provozni')=?"); params.append(typ)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT * FROM vydaje {where} ORDER BY datum DESC, id DESC", params
        ).fetchall()
        total = conn.execute(
            f"SELECT COALESCE(SUM(castka),0) as t FROM vydaje {where}", params
        ).fetchone()
        # Přidat položky ke každému výdaji
        result = []
        for r in rows:
            d = dict(r)
            polozky = conn.execute(
                "SELECT * FROM vydaje_polozky WHERE vydaj_id=? ORDER BY nazev", (d["id"],)
            ).fetchall()
            d["polozky"] = [dict(p) for p in polozky]
            result.append(d)
    return jsonify({"vydaje": result, "celkem": round(_first_val(total), 2)})

@app.route("/api/vydaje", methods=["POST"])
@vyzaduj_prihlaseni
def api_vydaje_ulozit():
    data = request.json
    if not data.get("firma_zkratka"):
        return jsonify({"error": "Chybí firma"}), 400
    polozky = data.pop("polozky", [])
    with get_db() as conn:
        cur = conn.execute("""
            INSERT INTO vydaje (firma_zkratka, dodavatel, datum, datum_splatnosti, castka, zpusob_uhrady, stav, popis, poznamka, soubor_cesta, soubor_url, zdroj, typ)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            data.get("firma_zkratka"),
            data.get("dodavatel", ""),
            data.get("datum", ""),
            data.get("datum_splatnosti", ""),
            float(data.get("castka", 0)),
            data.get("zpusob_uhrady", "hotovost"),
            data.get("stav", "nezaplaceno"),
            data.get("popis", ""),
            data.get("poznamka", ""),
            data.get("soubor_cesta", ""),
            data.get("soubor_url", ""),
            data.get("zdroj", "rucni"),
            data.get("typ", "provozni"),
        ))
        vid = cur.lastrowid
        for p in polozky:
            nazev = (p.get("nazev") or "").strip()
            if not nazev: continue
            conn.execute("INSERT INTO vydaje_polozky (vydaj_id, nazev, castka) VALUES (?,?,?)",
                (vid, nazev, float(p.get("castka", 0))))
    return jsonify({"ok": True, "id": vid})

@app.route("/api/vydaje/<int:vid>", methods=["PUT"])
@vyzaduj_prihlaseni
def api_vydaje_edit(vid):
    data = request.json
    polozky = data.pop("polozky", None)
    with get_db() as conn:
        conn.execute("""
            UPDATE vydaje SET dodavatel=?, datum=?, datum_splatnosti=?, castka=?,
                zpusob_uhrady=?, stav=?, popis=?, poznamka=?, firma_zkratka=?,
                datum_uhrady=?, banka_uhrady=?
            WHERE id=?
        """, (
            data.get("dodavatel", ""),
            data.get("datum", ""),
            data.get("datum_splatnosti", ""),
            float(data.get("castka", 0)),
            data.get("zpusob_uhrady", "hotovost"),
            data.get("stav", "nezaplaceno"),
            data.get("popis", ""),
            data.get("poznamka", ""),
            data.get("firma_zkratka", ""),
            data.get("datum_uhrady", ""),
            data.get("banka_uhrady", ""),
            vid,
        ))
        if polozky is not None:
            conn.execute("DELETE FROM vydaje_polozky WHERE vydaj_id=?", (vid,))
            for p in polozky:
                nazev = (p.get("nazev") or "").strip()
                if not nazev: continue
                conn.execute("INSERT INTO vydaje_polozky (vydaj_id, nazev, castka) VALUES (?,?,?)",
                    (vid, nazev, float(p.get("castka", 0))))
    return jsonify({"ok": True})

@app.route("/api/vydaje/<int:vid>/stav", methods=["POST"])
@vyzaduj_prihlaseni
def api_vydaje_stav(vid):
    """Rychlá změna stavu zaplaceno/nezaplaceno."""
    d = request.json or {}
    stav = d.get("stav", "zaplaceno")
    datum_uhrady = d.get("datum_uhrady", "")
    banka_uhrady = d.get("banka_uhrady", "")
    with get_db() as conn:
        conn.execute(
            "UPDATE vydaje SET stav=?, datum_uhrady=?, banka_uhrady=? WHERE id=?",
            (stav, datum_uhrady, banka_uhrady, vid)
        )
    return jsonify({"ok": True})

@app.route("/api/vydaje/<int:vid>", methods=["DELETE"])
@vyzaduj_prihlaseni
def api_vydaje_delete(vid):
    with get_db() as conn:
        conn.execute("DELETE FROM vydaje_polozky WHERE vydaj_id=?", (vid,))
        conn.execute("DELETE FROM vydaje WHERE id=?", (vid,))
    return jsonify({"ok": True})

@app.route("/api/vydaje/nahrat", methods=["POST"])
@vyzaduj_prihlaseni
def api_vydaje_nahrat():
    """Nahraje doklad výdaje (foto/PDF) přes OCR."""
    if "soubor" not in request.files:
        return jsonify({"error": "Žádný soubor"}), 400
    f = request.files["soubor"]
    firma = request.form.get("firma_zkratka", "")
    fname = secure_filename(f.filename or "vydaj")
    fpath = os.path.join(UPLOAD_DIR, fname)
    f.save(fpath)
    gcs_url = upload_to_gcs(fpath, f"vydaje/{fname}")
    return _vydaje_ocr(fpath, fname, gcs_url or "", firma)

@app.route("/api/vydaje/nahrat-path", methods=["POST"])
@vyzaduj_prihlaseni
def api_vydaje_nahrat_path():
    """OCR na souboru již uloženém (z Drive Picker)."""
    d = request.json or {}
    fpath = d.get("path", "")
    soubor_url = d.get("soubor_url", "")
    filename = d.get("filename", "vydaj.pdf")
    firma = d.get("firma_zkratka", "")
    if not fpath or not os.path.exists(fpath):
        return jsonify({"error": "Soubor nenalezen"}), 400
    return _vydaje_ocr(fpath, filename, soubor_url, firma)

def _vydaje_ocr(fpath, fname, gcs_url, firma):
    """Spustí OCR na souboru výdaje."""
    try:
        with open(fpath, "rb") as fh:
            raw = fh.read()
        b64 = base64.b64encode(raw).decode()
        ext = fname.rsplit(".", 1)[-1].lower()
        mt = "application/pdf" if ext == "pdf" else f"image/{ext if ext in ['jpeg','jpg','png','gif','webp'] else 'jpeg'}"
        if mt == "image/jpg": mt = "image/jpeg"
        msg_content = [
            {"type": "image" if not mt.startswith("application") else "document",
             "source": {"type": "base64", "media_type": mt, "data": b64}},
            {"type": "text", "text": """Analyzuj tento doklad/účtenku a extrahuj:
- dodavatel: název obchodu/firmy
- datum: datum nákupu ve formátu YYYY-MM-DD
- castka: celková částka v Kč (číslo bez měny)
- poznamka: krátký popis co bylo nakoupeno (max 80 znaků)
Odpověz POUZE jako JSON: {"dodavatel":"...","datum":"...","castka":0,"poznamka":"..."}"""}
        ]
        resp = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY","")).messages.create(
            model="claude-sonnet-4-20250514", max_tokens=300,
            messages=[{"role": "user", "content": msg_content}]
        )
        import json as _json
        text = resp.content[0].text.strip()
        text = text.replace("```json","").replace("```","").strip()
        parsed = _json.loads(text)
    except Exception as e:
        parsed = {}
    return jsonify({
        "dodavatel":      parsed.get("dodavatel", ""),
        "datum":          parsed.get("datum", ""),
        "castka":         parsed.get("castka", 0),
        "poznamka":       parsed.get("poznamka", ""),
        "soubor_cesta":   fname,
        "soubor_gcs_url": gcs_url,
        "firma_zkratka":  firma,
    })

# ── API: VYSTAVENÉ FAKTURY ────────────────────────────────────────────────────

@app.route("/api/vystavene-faktury")
@vyzaduj_prihlaseni
def api_vystavene_list():
    if session.get("role") == "verunka":
        return jsonify({"error": "Přístup zamítnut"}), 403
    firma = request.args.get("firma", "")
    od    = request.args.get("od", "")
    do_   = request.args.get("do", "")
    clauses, params = [], []
    if firma: clauses.append("firma_zkratka=?"); params.append(firma)
    if od:    clauses.append("datum>=?"); params.append(od)
    if do_:   clauses.append("datum<=?"); params.append(do_)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT * FROM vystavene_faktury {where} ORDER BY datum DESC, id DESC", params
        ).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/vystavene-faktury/zkontroluj", methods=["POST"])
@vyzaduj_prihlaseni
def api_vystavene_zkontroluj():
    """Zkontroluje duplicitu bez uložení — volá se po OCR."""
    d = request.json or {}
    duplicita = None
    if d.get("cislo_faktury") and d.get("datum"):
        with get_db() as conn:
            row = conn.execute(
                """SELECT id, firma_zkratka, datum, castka FROM vystavene_faktury
                   WHERE cislo_faktury=? AND datum=? AND ABS(castka-?)<0.01""",
                (d.get("cislo_faktury"), d.get("datum"), float(d.get("castka", 0)))
            ).fetchone()
            if row:
                duplicita = {"id": row["id"], "firma": row["firma_zkratka"],
                             "datum": row["datum"], "castka": row["castka"]}
    return jsonify({"duplicita": duplicita})

@app.route("/api/vystavene-faktury", methods=["POST"])
@vyzaduj_prihlaseni
def api_vystavene_ulozit():
    if session.get("role") != "admin":
        return jsonify({"error": "Přístup zamítnut"}), 403
    d = request.json or {}
    # Kontrola duplicity
    duplicita = None
    if d.get("cislo_faktury") and d.get("datum"):
        with get_db() as conn:
            row = conn.execute(
                """SELECT id, firma_zkratka, datum, castka FROM vystavene_faktury
                   WHERE cislo_faktury=? AND datum=? AND ABS(castka-?)< 0.01""",
                (d.get("cislo_faktury"), d.get("datum"), float(d.get("castka",0)))
            ).fetchone()
            if row:
                duplicita = {"id": row["id"], "firma": row["firma_zkratka"],
                             "datum": row["datum"], "castka": row["castka"]}
    with get_db() as conn:
        conn.execute(
            """INSERT INTO vystavene_faktury
               (firma_zkratka, cislo_faktury, datum, datum_splatnosti, odberatel, popis, castka, stav, soubor_url, duplicita_id)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (d.get("firma_zkratka",""), d.get("cislo_faktury",""),
             d.get("datum",""), d.get("datum_splatnosti",""),
             d.get("odberatel",""), d.get("popis",""),
             float(d.get("castka",0)),
             "duplikat" if duplicita else d.get("stav","nezaplaceno"),
             d.get("soubor_url",""),
             duplicita["id"] if duplicita else None)
        )
    return jsonify({"ok": True, "duplicita": duplicita})

@app.route("/api/vystavene-faktury/<int:fid>", methods=["PUT"])
@vyzaduj_prihlaseni
def api_vystavene_edit(fid):
    if session.get("role") != "admin":
        return jsonify({"error": "Přístup zamítnut"}), 403
    d = request.json or {}
    with get_db() as conn:
        conn.execute(
            """UPDATE vystavene_faktury SET firma_zkratka=?, cislo_faktury=?, datum=?,
               datum_splatnosti=?, odberatel=?, popis=?, castka=?, stav=?, soubor_url=? WHERE id=?""",
            (d.get("firma_zkratka",""), d.get("cislo_faktury",""),
             d.get("datum",""), d.get("datum_splatnosti",""),
             d.get("odberatel",""), d.get("popis",""),
             float(d.get("castka",0)), d.get("stav","nezaplaceno"), d.get("soubor_url",""), fid)
        )
    return jsonify({"ok": True})

@app.route("/api/vystavene-faktury/<int:fid>", methods=["DELETE"])
@vyzaduj_prihlaseni
def api_vystavene_delete(fid):
    if session.get("role") != "admin":
        return jsonify({"error": "Přístup zamítnut"}), 403
    with get_db() as conn:
        conn.execute("DELETE FROM vystavene_faktury WHERE id=?", (fid,))
    return jsonify({"ok": True})

@app.route("/api/vystavene-faktury/<int:fid>/stav", methods=["POST"])
@vyzaduj_prihlaseni
def api_vystavene_stav(fid):
    if session.get("role") != "admin":
        return jsonify({"error": "Přístup zamítnut"}), 403
    stav = request.json.get("stav", "zaplaceno")
    with get_db() as conn:
        conn.execute("UPDATE vystavene_faktury SET stav=? WHERE id=?", (stav, fid))
    return jsonify({"ok": True})

@app.route("/api/vystavene-faktury/nahrat-path", methods=["POST"])
@vyzaduj_prihlaseni
def api_vystavene_nahrat_path():
    """OCR na souboru již uloženém (z Drive Picker)."""
    if session.get("role") != "admin":
        return jsonify({"error": "Přístup zamítnut"}), 403
    d = request.json or {}
    fpath = d.get("path", "")
    soubor_url = d.get("soubor_url", "")
    if not fpath or not os.path.exists(fpath):
        return jsonify({"error": "Soubor nenalezen"}), 400
    return _vystavene_ocr(fpath, soubor_url)

def _vystavene_ocr(fpath, soubor_url=""):
    """Spustí OCR na souboru a vrátí data vystavené faktury."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return jsonify({"error": "ANTHROPIC_API_KEY není nastaven", "soubor_url": soubor_url}), 200
    try:
        ext = fpath.rsplit(".", 1)[-1].lower()
        with open(fpath, "rb") as fh:
            raw = fh.read()
        b64 = base64.standard_b64encode(raw).decode("utf-8")
        if ext == "pdf":
            content_block = {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64}}
        else:
            media_map = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
            content_block = {"type": "image", "source": {"type": "base64", "media_type": media_map.get(ext, "image/jpeg"), "data": b64}}
        client = anthropic.Anthropic(api_key=api_key)
        msg = client.messages.create(
            model="claude-sonnet-4-20250514", max_tokens=500,
            messages=[{"role": "user", "content": [
                content_block,
                {"type": "text", "text": """Analyzuj tuto vystavenou fakturu a extrahuj tyto hodnoty.
Odpověz POUZE platným JSON objektem, žádný jiný text ani backticky.
{
  "cislo_faktury": "číslo faktury (text)",
  "datum": "datum vystavení YYYY-MM-DD nebo null",
  "datum_splatnosti": "datum splatnosti YYYY-MM-DD nebo null",
  "castka": číslo (celková částka v Kč bez symbolu),
  "odberatel": "název odběratele",
  "popis": "stručný popis předmětu plnění max 100 znaků"
}"""}
            ]}]
        )
        text = msg.content[0].text.strip()
        text = re.sub(r"^```json\s*", "", text)
        text = re.sub(r"```$", "", text).strip()
        parsed = json.loads(text)
    except Exception as e:
        app.logger.warning(f"OCR vystavene failed: {e}")
        return jsonify({"error": str(e), "soubor_url": soubor_url}), 200
    return jsonify({
        "cislo_faktury":    parsed.get("cislo_faktury") or "",
        "datum":            parsed.get("datum") or "",
        "datum_splatnosti": parsed.get("datum_splatnosti") or "",
        "castka":           float(parsed.get("castka") or 0),
        "odberatel":        parsed.get("odberatel") or "",
        "popis":            parsed.get("popis") or "",
        "soubor_url":       soubor_url,
    })

@app.route("/api/vystavene-faktury/nahrat", methods=["POST"])
@vyzaduj_prihlaseni
def api_vystavene_nahrat():
    if session.get("role") != "admin":
        return jsonify({"error": "Přístup zamítnut"}), 403
    if "soubor" not in request.files:
        return jsonify({"error": "Žádný soubor"}), 400
    f = request.files["soubor"]
    fname = secure_filename(f.filename or "faktura.pdf")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S_")
    fname = ts + fname
    fpath = os.path.join(UPLOAD_DIR, fname)
    f.save(fpath)
    gcs_url = upload_to_gcs(fpath, f"vystavene/{fname}")
    return _vystavene_ocr(fpath, gcs_url or "")


# ── API: BANKOVNÍ VÝPISY ──────────────────────────────────────────────────────
def parse_csv_airbank(content_bytes):
    """Parsuje CSV výpis z Air Bank (cp1250, ; oddělovač, datum DD/MM/YYYY)."""
    import csv, io
    text = content_bytes.decode("cp1250")
    reader = csv.DictReader(io.StringIO(text), delimiter=";")
    pohyby = []
    for row in reader:
        datum_raw = row.get("Datum provedení", "").strip().strip('"')
        castka_raw = row.get("Částka v měně účtu", "").strip().strip('"').replace(",", ".")
        id_transakce = row.get("Referenční číslo", "").strip().strip('"')
        if not datum_raw or not castka_raw:
            continue
        try:
            # DD/MM/YYYY → YYYY-MM-DD
            d, m, y = datum_raw.split("/")
            datum = f"{y}-{m.zfill(2)}-{d.zfill(2)}"
            castka = float(castka_raw)
        except:
            continue
        pohyby.append({
            "banka":           "AirBank",
            "datum":           datum,
            "castka":          castka,
            "protiucet":       row.get("Číslo účtu protistrany", "").strip().strip('"'),
            "nazev_protiucet": row.get("Název protistrany", "").strip().strip('"'),
            "typ_transakce":   row.get("Typ úhrady", "").strip().strip('"'),
            "zprava":          row.get("Obchodní místo", "").strip().strip('"') or row.get("Zpráva pro příjemce", "").strip().strip('"'),
            "id_transakce":    f"AIR_{id_transakce}" if id_transakce else None,
        })
    return pohyby

def parse_csv_rb(content_bytes):
    """Parsuje CSV výpis z Raiffeisenbank (utf-8 BOM, ; oddělovač, datum DD.MM.YYYY)."""
    import csv, io
    text = content_bytes.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text), delimiter=";")
    pohyby = []
    for row in reader:
        datum_raw = row.get("Datum provedení", "").strip().strip('"')
        castka_raw = row.get("Zaúčtovaná částka", "").strip().strip('"').replace(",", ".")
        id_transakce = row.get("Id transakce", "").strip().strip('"')
        if not datum_raw or not castka_raw:
            continue
        try:
            # DD.MM.YYYY → YYYY-MM-DD
            d, m, y = datum_raw.split(".")
            datum = f"{y}-{m.zfill(2)}-{d.zfill(2)}"
            castka = float(castka_raw)
        except:
            continue
        pohyby.append({
            "banka":           "RB",
            "datum":           datum,
            "castka":          castka,
            "protiucet":       row.get("Číslo protiúčtu", "").strip().strip('"'),
            "nazev_protiucet": row.get("Název protiúčtu", "").strip().strip('"') or row.get("Název obchodníka", "").strip().strip('"'),
            "typ_transakce":   row.get("Typ transakce", "").strip().strip('"'),
            "zprava":          row.get("Zpráva", "").strip().strip('"') or row.get("Poznámka", "").strip().strip('"'),
            "id_transakce":    f"RB_{id_transakce}" if id_transakce else None,
        })
    return pohyby

@app.route("/api/banky/import", methods=["POST"])
@vyzaduj_prihlaseni
def api_banky_import():
    """Importuje CSV výpis z banky."""
    if "soubor" not in request.files:
        return jsonify({"error": "Žádný soubor"}), 400
    f = request.files["soubor"]
    firma = request.form.get("firma_zkratka", "")
    banka_hint = request.form.get("banka_hint", "")
    content = f.read()
    fname = (f.filename or "").lower()

    # Detekce banky podle hintu, názvu souboru nebo BOM
    try:
        if banka_hint == "AirBank" or "airbank" in fname or "air_bank" in fname:
            pohyby = parse_csv_airbank(content)
            banka = "AirBank"
        elif banka_hint == "RB" or "pohyby_" in fname:
            pohyby = parse_csv_rb(content)
            banka = "RB"
        else:
            if content[:3] == b'\xef\xbb\xbf':
                pohyby = parse_csv_rb(content)
                banka = "RB"
            else:
                pohyby = parse_csv_airbank(content)
                banka = "AirBank"
    except Exception as e:
        return jsonify({"error": f"Chyba parsování: {str(e)}"}), 400

    naimportovano = 0
    duplicity = 0
    with get_db() as conn:
        for p in pohyby:
            try:
                conn.execute("""
                    INSERT INTO bankovni_pohyby
                        (banka, datum, castka, protiucet, nazev_protiucet, typ_transakce, zprava, id_transakce, firma_zkratka)
                    VALUES (?,?,?,?,?,?,?,?,?)
                """, (
                    p["banka"], p["datum"], p["castka"],
                    p["protiucet"], p["nazev_protiucet"],
                    p["typ_transakce"], p["zprava"],
                    p["id_transakce"], firma
                ))
                naimportovano += 1
            except Exception:
                duplicity += 1  # UNIQUE constraint = duplikát
    return jsonify({"ok": True, "banka": banka, "naimportovano": naimportovano, "duplicity": duplicity})

@app.route("/api/banky/pohyby")
@vyzaduj_prihlaseni
def api_banky_pohyby():
    """Vrátí seznam bankovních pohybů s filtry."""
    banka  = request.args.get("banka", "")
    firma  = request.args.get("firma", "")
    od     = request.args.get("od", "")
    do_    = request.args.get("do", "")
    typ    = request.args.get("typ", "")
    clauses, params = [], []
    if banka: clauses.append("banka=?"); params.append(banka)
    if firma: clauses.append("firma_zkratka=?"); params.append(firma)
    if od:    clauses.append("datum>=?"); params.append(od)
    if do_:   clauses.append("datum<=?"); params.append(do_)
    if typ == "prichozi":  clauses.append("castka>0")
    if typ == "odchozi":   clauses.append("castka<0")
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    with get_db() as conn:
        rows = conn.execute(
            f"SELECT * FROM bankovni_pohyby {where} ORDER BY datum DESC, id DESC",
            params
        ).fetchall()
        total_row = conn.execute(
            f"SELECT COALESCE(SUM(castka),0) as total FROM bankovni_pohyby {where}", params
        ).fetchone()
    return jsonify({
        "pohyby": [dict(r) for r in rows],
        "celkem": round(_first_val(total_row), 2)
    })

@app.route("/api/banky/export")
@vyzaduj_prihlaseni
def api_banky_export():
    """Export měsíčního výpisu jako CSV nebo PDF."""
    banka  = request.args.get("banka", "")
    mesic  = request.args.get("mesic", "")   # YYYY-MM
    fmt    = request.args.get("format", "csv")
    if not banka or not mesic:
        return jsonify({"error": "Chybí parametry"}), 400
    od = mesic + "-01"
    import calendar
    rok, mes = int(mesic[:4]), int(mesic[5:7])
    posledni = calendar.monthrange(rok, mes)[1]
    do_ = f"{mesic}-{posledni:02d}"
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM bankovni_pohyby WHERE banka=? AND datum>=? AND datum<=? ORDER BY datum",
            (banka, od, do_)
        ).fetchall()
    if fmt == "csv":
        import csv, io
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["Datum","Protistrana","Číslo účtu","Typ transakce","Zpráva","Částka"])
        for r in rows:
            w.writerow([r["datum"], r["nazev_protiucet"], r["protiucet"], r["typ_transakce"], r["zprava"], r["castka"]])
        resp = make_response(out.getvalue().encode("utf-8-sig"))
        resp.headers["Content-Type"] = "text/csv; charset=utf-8"
        resp.headers["Content-Disposition"] = f'attachment; filename="{banka}_{mesic}.csv"'
        return resp
    else:
        # Skutečné PDF přes reportlab
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
        from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        import io as _io

        nazev_banky = "Air Bank" if banka == "AirBank" else "Raiffeisenbank"
        prichozi = sum(r["castka"] for r in rows if r["castka"] > 0)
        odchozi  = sum(r["castka"] for r in rows if r["castka"] < 0)
        saldo    = prichozi + odchozi

        buf = _io.BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=A4,
            leftMargin=15*mm, rightMargin=15*mm,
            topMargin=15*mm, bottomMargin=15*mm)
        styles = getSampleStyleSheet()
        story = []

        # Nadpis
        story.append(Paragraph(f"<b>{nazev_banky}</b> – výpis {mesic}", styles["Title"]))
        story.append(Spacer(1, 4*mm))

        # Souhrn
        souhrn = [
            ["Příchozí", "Odchozí", "Saldo"],
            [f"{prichozi:,.2f} Kč", f"{abs(odchozi):,.2f} Kč", f"{saldo:,.2f} Kč"],
        ]
        ts = TableStyle([
            ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#f0f0f0")),
            ("FONTNAME",   (0,0), (-1,0), "Helvetica-Bold"),
            ("ALIGN",      (0,0), (-1,-1), "CENTER"),
            ("GRID",       (0,0), (-1,-1), 0.5, colors.grey),
            ("FONTSIZE",   (0,0), (-1,-1), 9),
            ("TEXTCOLOR",  (0,1), (0,1), colors.HexColor("#16a34a")),
            ("TEXTCOLOR",  (1,1), (1,1), colors.HexColor("#dc2626")),
            ("FONTNAME",   (0,1), (-1,1), "Helvetica-Bold"),
        ])
        t = Table(souhrn, colWidths=[55*mm, 55*mm, 55*mm])
        t.setStyle(ts)
        story.append(t)
        story.append(Spacer(1, 5*mm))

        # Tabulka transakcí
        hlavicka = ["Datum", "Protistrana", "Typ transakce", "Zpráva", "Částka"]
        data_rows = [hlavicka] + [
            [r["datum"], (r["nazev_protiucet"] or "")[:35],
             (r["typ_transakce"] or "")[:25], (r["zprava"] or "")[:30],
             f"{r['castka']:,.2f}"]
            for r in rows
        ]
        col_w = [22*mm, 55*mm, 38*mm, 40*mm, 25*mm]
        tbl = Table(data_rows, colWidths=col_w, repeatRows=1)
        tbl_style = TableStyle([
            ("BACKGROUND",  (0,0), (-1,0), colors.HexColor("#1e3a2f")),
            ("TEXTCOLOR",   (0,0), (-1,0), colors.white),
            ("FONTNAME",    (0,0), (-1,0), "Helvetica-Bold"),
            ("FONTSIZE",    (0,0), (-1,-1), 8),
            ("ALIGN",       (4,0), (4,-1), "RIGHT"),
            ("GRID",        (0,0), (-1,-1), 0.3, colors.HexColor("#dddddd")),
            ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#f9f9f9")]),
            ("TOPPADDING",  (0,0), (-1,-1), 3),
            ("BOTTOMPADDING",(0,0), (-1,-1), 3),
        ])
        # Obarvit záporné částky červeně
        for i, r in enumerate(rows, start=1):
            if r["castka"] < 0:
                tbl_style.add("TEXTCOLOR", (4,i), (4,i), colors.HexColor("#dc2626"))
            else:
                tbl_style.add("TEXTCOLOR", (4,i), (4,i), colors.HexColor("#16a34a"))
        tbl.setStyle(tbl_style)
        story.append(tbl)

        doc.build(story)
        buf.seek(0)
        resp = make_response(buf.read())
        resp.headers["Content-Type"] = "application/pdf"
        resp.headers["Content-Disposition"] = f'attachment; filename="{banka}_{mesic}.pdf"'
        return resp

@app.route("/api/banky/pohyby/<int:pid>", methods=["DELETE"])
@vyzaduj_prihlaseni
def api_banky_pohyb_delete(pid):
    with get_db() as conn:
        conn.execute("DELETE FROM bankovni_pohyby WHERE id=?", (pid,))
    return jsonify({"ok": True})

# ── API: REPORTY ──────────────────────────────────────────────────────────────
@app.route("/api/reporty/nahrat-foto", methods=["POST"])
@vyzaduj_prihlaseni
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

    # Nahrát fotku do GCS
    gcs_url = None
    try:
        gcs_url = upload_to_gcs(fpath, f"reporty/{fname}")
    except Exception as e:
        app.logger.warning(f"GCS upload reportu selhal: {e}")

    report["soubor_url"] = gcs_url
    return jsonify(report)


@app.route("/api/reporty/nahrat-text", methods=["POST"])
@vyzaduj_prihlaseni
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
@vyzaduj_prihlaseni
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
@vyzaduj_prihlaseni
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
        soubor_url = data.get("soubor_url") or None
        if existing:
            conn.execute("""
                UPDATE reporty SET den=?,smena=?,karty=?,kov=?,papir=?,hotovost=?,
                vydaje=?,trzba=?,trzba_vcpk=?,pk50_ks=?,pk100_ks=?,pk_celkem=?,
                pizza_cela=?,pizza_ctvrt=?,burger=?,talire=?,burtgulas=?,poznamka=?,firma_zkratka=?,
                soubor_url=COALESCE(?,soubor_url)
                WHERE datum=?
            """, (
                data.get("den",""), data.get("smena",""),
                karty, kov, papir, hotovost, vydaje, trzba, trzba_vcpk,
                pk50_ks, pk100_ks, pk_celkem,
                int(data.get("pizza_cela",0) or 0), int(data.get("pizza_ctvrt",0) or 0),
                int(data.get("burger",0) or 0), int(data.get("talire",0) or 0),
                int(data.get("burtgulas",0) or 0),
                data.get("poznamka",""), firma,
                soubor_url, data["datum"]
            ))
            rid = existing["id"]
        else:
            cur = conn.execute("""
                INSERT INTO reporty (datum,den,smena,karty,kov,papir,hotovost,vydaje,
                trzba,trzba_vcpk,pk50_ks,pk100_ks,pk_celkem,
                pizza_cela,pizza_ctvrt,burger,talire,burtgulas,poznamka,firma_zkratka,soubor_url)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                data["datum"], data.get("den",""), data.get("smena",""),
                karty, kov, papir, hotovost, vydaje, trzba, trzba_vcpk,
                pk50_ks, pk100_ks, pk_celkem,
                int(data.get("pizza_cela",0) or 0), int(data.get("pizza_ctvrt",0) or 0),
                int(data.get("burger",0) or 0), int(data.get("talire",0) or 0),
                int(data.get("burtgulas",0) or 0),
                data.get("poznamka",""), firma, soubor_url
            ))
            rid = cur.lastrowid

    return jsonify({"ok": True, "id": rid})


@app.route("/api/reporty/<int:rid>", methods=["GET"])
@vyzaduj_prihlaseni
def api_report_get(rid):
    with get_db() as conn:
        r = conn.execute("SELECT * FROM reporty WHERE id=?", (rid,)).fetchone()
    if not r:
        return jsonify({"error": "Nenalezen"}), 404
    return jsonify(dict(r))

@app.route("/api/reporty/<int:rid>", methods=["DELETE"])
@vyzaduj_prihlaseni
def api_report_delete(rid):
    with get_db() as conn:
        conn.execute("DELETE FROM reporty WHERE id=?", (rid,))
    return jsonify({"ok": True})


@app.route("/api/reporty/smaz-budouci", methods=["POST"])
@vyzaduj_prihlaseni
def api_reporty_smaz_budouci():
    dnes = date.today().isoformat()
    with get_db() as conn:
        cur = conn.execute("DELETE FROM reporty WHERE datum > ?", (dnes,))
        smazano = cur.rowcount
    return jsonify({"ok": True, "smazano": smazano})


@app.route("/api/reporty/import-xlsx", methods=["POST"])
@vyzaduj_prihlaseni
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
        for sheet_name in wb.sheetnames:
            if sheet_name not in ("2025", "2026"):
                continue
            year = int(sheet_name)
            ws = wb[sheet_name]

            current_mesic = None
            dnes = date.today()
            konec_import = date(dnes.year, dnes.month, dnes.day)
            for row in ws.iter_rows(min_row=2, values_only=True):
                if not row or row[0] is None:
                    continue
                if str(row[0]).upper() in ("SOUČET", "DNÍ", "PRŮMĚR", "SOU\ČET"):
                    continue
                if row[1] and str(row[1]).upper() in mesic_map:
                    current_mesic = mesic_map[str(row[1]).upper()]

                try:
                    den_cislo = int(row[0])
                except (TypeError, ValueError):
                    continue

                if not current_mesic:
                    continue

                try:
                    datum_test = date(year, current_mesic, den_cislo)
                    if datum_test > konec_import:
                        skipped += 1
                        continue
                except ValueError:
                    continue

                try:
                    datum_iso = date(year, current_mesic, den_cislo).isoformat()
                except ValueError:
                    errors.append(f"Neplatné datum: {year}-{current_mesic}-{den_cislo}")
                    continue

                den_str = den_map.get(str(row[2] or "").lower(), str(row[2] or ""))
                trzba_vcpk = float(row[3] or 0)
                karty      = float(row[4] or 0)
                hotovost   = float(row[5] or 0)
                vydaje     = float(row[6] or 0)
                trzba      = float(row[7] or 0)
                pk50_ks    = int(row[8] or 0)
                pk100_ks   = int(row[9] or 0)
                pk_celkem  = float(row[10] or 0)
                pizza_cela = int(row[11] or 0)
                pizza_ctvrt= int(row[12] or 0)
                burger     = int(row[13] or 0)
                talire     = int(row[14] or 0)
                burtgulas  = int(row[15] or 0)
                smena      = normalize_jmena(str(row[16] or ""))

                kov   = 0
                papir = hotovost

                rows_to_insert.append((
                    datum_iso, den_str, smena, karty, kov, papir, hotovost,
                    vydaje, trzba, trzba_vcpk, pk50_ks, pk100_ks, pk_celkem,
                    pizza_cela, pizza_ctvrt, burger, talire, burtgulas
                ))

        with get_db() as conn:
            for params in rows_to_insert:
                existing = conn.execute("SELECT id FROM reporty WHERE datum=?", (params[0],)).fetchone()
                if existing:
                    skipped += 1
                    continue
                conn.execute("""
                    INSERT INTO reporty (datum,den,smena,karty,kov,papir,hotovost,vydaje,
                    trzba,trzba_vcpk,pk50_ks,pk100_ks,pk_celkem,
                    pizza_cela,pizza_ctvrt,burger,talire,burtgulas)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, params)
                imported += 1

        return jsonify({"ok": True, "imported": imported, "skipped": skipped, "errors": errors[:10]})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/reporty/karty-alert")
@vyzaduj_prihlaseni
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
@vyzaduj_prihlaseni
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
                ROUND((SUM(trzba_vcpk))::numeric,2)  as trzba_vcpk_sum,
                ROUND((AVG(trzba_vcpk))::numeric,2)  as trzba_vcpk_avg,
                ROUND((SUM(karty))::numeric,2)       as karty_sum,
                ROUND((AVG(karty))::numeric,2)       as karty_avg,
                ROUND((SUM(hotovost))::numeric,2)    as hotovost_sum,
                ROUND((AVG(hotovost))::numeric,2)    as hotovost_avg,
                ROUND((SUM(vydaje))::numeric,2)      as vydaje_sum,
                ROUND((SUM(pk_celkem))::numeric,2)   as pk_celkem_sum,
                SUM(pizza_cela)           as pizza_cela_sum,
                SUM(pizza_ctvrt)          as pizza_ctvrt_sum,
                SUM(burger)               as burger_sum,
                SUM(talire)               as talire_sum,
                SUM(burtgulas)            as burtgulas_sum,
                ROUND((AVG(pizza_cela))::numeric,1)  as pizza_cela_avg,
                ROUND((AVG(pizza_ctvrt))::numeric,1) as pizza_ctvrt_avg,
                ROUND((AVG(burger))::numeric,1)      as burger_avg,
                ROUND((AVG(talire))::numeric,1)      as talire_avg,
                ROUND((AVG(burtgulas))::numeric,1)   as burtgulas_avg
            FROM reporty {where}
            AND trzba_vcpk > 0
            GROUP BY rok, mesic
            ORDER BY rok DESC, mesic DESC
        """, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/statistiky/roky")
@vyzaduj_prihlaseni
def api_statistiky_roky():
    with get_db() as conn:
        rows = conn.execute("""
            SELECT
                strftime('%Y', datum) as rok,
                strftime('%m', datum) as mesic,
                ROUND((AVG(trzba_vcpk))::numeric,0) as prumer_den,
                firma_zkratka
            FROM reporty
            WHERE datum <= ? AND trzba_vcpk > 0
            GROUP BY rok, mesic
            ORDER BY rok, mesic
        """, (date.today().isoformat(),)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/export/reporty")
@vyzaduj_prihlaseni
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
@vyzaduj_prihlaseni
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
@vyzaduj_prihlaseni
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

    # Nahrát do GCS (pokud je nakonfigurováno)
    gcs_url = upload_to_gcs(fpath, fname)

    ext = fname.rsplit(".", 1)[1].lower()
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if api_key:
        if ext == "pdf":
            data, err = parse_makro_pdf(fpath)
            if err or not data:
                data, err = parse_faktura_claude(fpath)
        else:
            data, err = parse_faktura_claude(fpath)
    else:
        if ext == "pdf":
            data, err = parse_makro_pdf(fpath)
        else:
            data, err = parse_makro_image(fpath)

    if err:
        return jsonify({"error": err, "soubor_cesta": fname}), 200

    data["soubor_cesta"] = fname
    if gcs_url:
        data["soubor_gcs_url"] = gcs_url

    if data.get("cislo_faktury"):
        with get_db() as conn:
            row = conn.execute("""
                SELECT id, firma_zkratka, datum_vystaveni, celkem_s_dph
                FROM faktury
                WHERE cislo_faktury = ?
                AND datum_vystaveni = ?
                AND ABS(celkem_s_dph - ?) < 0.01
            """, (data["cislo_faktury"], data.get("datum_vystaveni",""), float(data.get("celkem_s_dph", 0)))).fetchone()
            if row:
                data["duplicita"] = {
                    "id": row["id"],
                    "firma": row["firma_zkratka"],
                    "datum": row["datum_vystaveni"],
                    "celkem": row["celkem_s_dph"]
                }

    return jsonify(data)

@app.route("/api/faktury", methods=["POST"])
@vyzaduj_prihlaseni
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
                datum_splatnosti, zpusob_uhrady, stav, celkem_s_dph, soubor_cesta, soubor_url, zdroj, duplicita_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
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
            data.get("soubor_url",""),
            data.get("zdroj","rucni"),
            data.get("duplicita_id", None)
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
@vyzaduj_prihlaseni
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
                ROUND(CAST(SUM(p.mnozstvi) AS NUMERIC), 3)            AS celkove_mnozstvi,
                ROUND(CAST(SUM(p.celkem_s_dph) AS NUMERIC), 2)        AS celkem_utraceno,
                ROUND(CAST(AVG(p.cena_za_jednotku_s_dph) AS NUMERIC), 4) AS prumerna_cena,
                COUNT(DISTINCT p.faktura_id)        AS pocet_nakupu,
                STRING_AGG(DISTINCT f.dodavatel, ', ')  AS dodavatele,
                (SELECT a.alias FROM zbozi_aliasy a WHERE a.zbozi_id = z.id LIMIT 1) AS skupina
            FROM polozky p
            JOIN faktury f ON f.id = p.faktura_id
            LEFT JOIN zbozi z ON z.id = p.zbozi_id
            WHERE 1=1 {f_cond} {od_c} {do_c}
            GROUP BY z.id, COALESCE(z.nazev_canonical, p.nazev), p.jednotka
            ORDER BY celkem_utraceno DESC
        """, params).fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/polozky/detail/<int:zbozi_id>")
@vyzaduj_prihlaseni
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
@vyzaduj_prihlaseni
def api_zbozi_list():
    with get_db() as conn:
        rows = conn.execute("SELECT id, nazev_canonical FROM zbozi ORDER BY nazev_canonical").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/zbozi/alias", methods=["POST"])
@vyzaduj_prihlaseni
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
@vyzaduj_prihlaseni
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
@vyzaduj_prihlaseni
def api_statistiky():
    firma = request.args.get("firma", "")
    od    = request.args.get("od", date.today().replace(day=1).isoformat())
    do_   = request.args.get("do", date.today().isoformat())

    f_cond  = "AND firma_zkratka=?" if firma else ""
    f_params = (firma,) if firma else ()

    with get_db() as conn:
        mesice = conn.execute(f"""
            SELECT strftime('%Y-%m', datum_vystaveni) m, ROUND((SUM(celkem_s_dph))::numeric,2) castka
            FROM faktury
            WHERE datum_vystaveni>=? AND datum_vystaveni<=? {f_cond}
            GROUP BY m ORDER BY m
        """, (od, do_) + f_params).fetchall()

        dodavatele = conn.execute(f"""
            SELECT dodavatel, ROUND((SUM(celkem_s_dph))::numeric,2) castka, COUNT(*) pocet
            FROM faktury
            WHERE datum_vystaveni>=? AND datum_vystaveni<=? {f_cond}
            GROUP BY dodavatel ORDER BY castka DESC LIMIT 10
        """, (od, do_) + f_params).fetchall()

        zbozi_top = conn.execute(f"""
            SELECT COALESCE(z.nazev_canonical, p.nazev) zbozi, ROUND((SUM(p.celkem_s_dph))::numeric,2) castka,
                   ROUND((SUM(p.mnozstvi))::numeric,2) mnozstvi, p.jednotka
            FROM polozky p
            JOIN faktury f ON f.id=p.faktura_id
            LEFT JOIN zbozi z ON z.id=p.zbozi_id
            WHERE f.datum_vystaveni>=? AND f.datum_vystaveni<=? {f_cond}
            GROUP BY COALESCE(z.id::text, p.nazev) ORDER BY castka DESC LIMIT 20
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
@vyzaduj_prihlaseni
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
@vyzaduj_prihlaseni
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
                   ROUND((SUM(p.mnozstvi))::numeric,3), ROUND((SUM(p.celkem_s_dph))::numeric,2),
                   ROUND((AVG(p.cena_za_jednotku_s_dph))::numeric,4),
                   COUNT(DISTINCT p.faktura_id),
                   STRING_AGG(DISTINCT f.dodavatel, ', ')
            FROM polozky p JOIN faktury f ON f.id=p.faktura_id
            LEFT JOIN zbozi z ON z.id=p.zbozi_id
            WHERE 1=1 {f_cond} {od_c} {do_c}
            GROUP BY COALESCE(z.id::text, p.nazev)
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
@vyzaduj_prihlaseni
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


@app.route("/api/drive-config")
@vyzaduj_prihlaseni
def api_drive_config():
    """Vrátí Google OAuth Client ID pro Drive Picker."""
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    return jsonify({"client_id": client_id})

@app.route("/api/drive-download", methods=["POST"])
@vyzaduj_prihlaseni
def api_drive_download():
    """Stáhne soubor z Google Drive pomocí access tokenu a vrátí ho jako PDF."""
    import requests as _req
    d = request.json or {}
    file_id    = d.get("file_id", "")
    access_token = d.get("access_token", "")
    filename   = d.get("filename", "dokument.pdf")
    if not file_id or not access_token:
        return jsonify({"error": "Chybí file_id nebo access_token"}), 400
    # Stáhnout soubor z Drive
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media"
    headers = {"Authorization": f"Bearer {access_token}"}
    resp = _req.get(url, headers=headers, timeout=30)
    if resp.status_code != 200:
        return jsonify({"error": f"Chyba stahování z Drive: {resp.status_code}"}), 400
    # Uložit dočasně a zpracovat jako normální upload
    import tempfile, os as _os
    suffix = ".pdf" if filename.lower().endswith(".pdf") else ""
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(resp.content)
        tmp_path = tmp.name
    try:
        from flask import g
        # Simuluj FileStorage objekt pro stávající OCR logiku
        from werkzeug.datastructures import FileStorage
        import io
        fs = FileStorage(
            stream=io.BytesIO(resp.content),
            filename=filename,
            content_type="application/pdf"
        )
        # Uložit do upload adresáře
        safe = filename.replace(" ", "_")
        dest = os.path.join(UPLOAD_DIR, safe)
        fs.save(dest)
        gcs_url = upload_to_gcs(dest, safe)
        return jsonify({"ok": True, "tmp_path": dest, "soubor_url": gcs_url or "", "filename": safe})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        try: _os.unlink(tmp_path)
        except: pass


# ── GOOGLE DRIVE WEBHOOK ──────────────────────────────────────────────────────
DRIVE_FOLDER_ID = "1Oopnqi_IDwqWOKb--u9gGQ3ds1RwhjKh"
DRIVE_CHANNEL_ID = "faktury-makro-channel-1"

def get_drive_service():
    """Vrátí Google Drive service pomocí service account credentials."""
    creds_json = os.environ.get("GCS_CREDENTIALS_JSON", "")
    if not creds_json:
        return None
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        creds_info = json.loads(creds_json)
        scopes = ["https://www.googleapis.com/auth/drive.readonly"]
        creds = service_account.Credentials.from_service_account_info(creds_info, scopes=scopes)
        return build("drive", "v3", credentials=creds)
    except Exception as e:
        print(f"⚠ Drive service error: {e}")
        return None

@app.route("/api/drive-registruj", methods=["POST"])
@vyzaduj_prihlaseni
def api_drive_registruj():
    """Zaregistruje sledování složky faktury-nahrat u Google Drive."""
    if session.get("role") != "admin":
        return jsonify({"error": "Pouze admin"}), 403
    import uuid
    try:
        from googleapiclient.discovery import build
        service = get_drive_service()
        if not service:
            return jsonify({"error": "Drive service není dostupný"}), 500
        webhook_url = f"{os.environ.get('APP_URL', 'https://faktury-makro.onrender.com')}/api/drive-webhook"
        channel_id = str(uuid.uuid4())
        body = {
            "id": channel_id,
            "type": "web_hook",
            "address": webhook_url,
            "expiration": str(int((__import__("time").time() + 604800) * 1000))  # 7 dní
        }
        result = service.files().watch(
            fileId=DRIVE_FOLDER_ID,
            body=body
        ).execute()
        # Uložit channel info pro pozdější stop
        with get_db() as conn:
            try:
                conn.execute("""CREATE TABLE IF NOT EXISTS drive_channels (
                    id SERIAL PRIMARY KEY, channel_id TEXT, resource_id TEXT, expiration TEXT)""")
            except: pass
            conn.execute("INSERT INTO drive_channels (channel_id, resource_id, expiration) VALUES (?,?,?)",
                (channel_id, result.get("resourceId",""), result.get("expiration","")))
        return jsonify({"ok": True, "channel_id": channel_id, "expiration": result.get("expiration")})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/drive-webhook", methods=["POST"])
def api_drive_webhook():
    """Příjem notifikací od Google Drive — stáhne nové soubory ze složky."""
    resource_state = request.headers.get("X-Goog-Resource-State", "")
    if resource_state == "sync":
        return "", 200
    # Zpracovat synchronně
    try:
        _zpracuj_nove_faktury_z_drive()
    except Exception as e:
        print(f"⚠ Webhook zpracování error: {e}")
    return "", 200

def _zpracuj_nove_faktury_z_drive():
    """Stáhne nové PDF ze složky faktury-nahrat a zpracuje OCR."""
    try:
        service = get_drive_service()
        if not service:
            print("⚠ Drive service není dostupný")
            return
        # Načíst soubory ze složky
        result = service.files().list(
            q=f"'{DRIVE_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false",
            orderBy="createdTime desc",
            fields="files(id,name,createdTime)",
            pageSize=20
        ).execute()
        files = result.get("files", [])

        # Zjistit které soubory již byly zpracovány
        with get_db() as conn:
            try:
                conn.execute("""CREATE TABLE IF NOT EXISTS drive_zpracovane (
                    id SERIAL PRIMARY KEY, file_id TEXT UNIQUE, zpracovano_at TEXT)""")
            except: pass
            rows = conn.execute("SELECT file_id FROM drive_zpracovane").fetchall()
            zpracovane = {r[0] for r in rows}

        for f in files:
            if f["id"] in zpracovane:
                continue
            try:
                request_dl = service.files().get_media(fileId=f["id"])
                content = request_dl.execute()
                safe_name = f["name"].replace(" ", "_")
                ts = __import__("datetime").datetime.now().strftime("%Y%m%d_%H%M%S_")
                fname = ts + safe_name
                fpath = os.path.join(UPLOAD_DIR, fname)
                with open(fpath, "wb") as fh:
                    fh.write(content)
                gcs_url = upload_to_gcs(fpath, f"faktury/{fname}")
                ocr_data = _ocr_faktura(fpath)
                with get_db() as conn:
                    conn.execute("""
                        INSERT INTO faktury (firma_zkratka, dodavatel, cislo_faktury,
                            datum_vystaveni, datum_splatnosti, celkem_s_dph,
                            stav, soubor_cesta, soubor_url, zdroj)
                        VALUES (?,?,?,?,?,?,?,?,?,?)
                    """, (
                        ocr_data.get("firma_zkratka", ""),
                        ocr_data.get("dodavatel", ""),
                        ocr_data.get("cislo_faktury", ""),
                        ocr_data.get("datum_vystaveni", ""),
                        ocr_data.get("datum_splatnosti", ""),
                        float(ocr_data.get("celkem_s_dph", 0)),
                        "ke_zpracovani",
                        fname,
                        gcs_url or "",
                        "drive_auto"
                    ))
                    fid = conn.execute("SELECT id FROM faktury WHERE soubor_cesta=? ORDER BY id DESC LIMIT 1", (fname,)).fetchone()
                    if fid:
                        for p in ocr_data.get("polozky", []):
                            nazev = (p.get("nazev") or "").strip()
                            if not nazev: continue
                            conn.execute("""
                                INSERT INTO polozky (faktura_id, nazev, mnozstvi, jednotka,
                                    cena_za_jednotku_s_dph, celkem_s_dph)
                                VALUES (?,?,?,?,?,?)
                            """, (
                                fid[0],
                                nazev,
                                float(p.get("mnozstvi") or 1),
                                p.get("jednotka") or "ks",
                                float(p.get("cena_za_jednotku_s_dph") or 0),
                                float(p.get("celkem_s_dph") or 0),
                            ))
                    conn.execute(
                        "INSERT INTO drive_zpracovane (file_id, zpracovano_at) VALUES (?,?)",
                        (f["id"], __import__("datetime").datetime.now().isoformat())
                    )
                print(f"✅ Drive auto: zpracována FA {fname}")
            except Exception as e:
                print(f"⚠ Drive auto error pro {f['name']}: {e}")
    except Exception as e:
        print(f"⚠ Drive webhook error: {e}")

def _ocr_faktura(fpath):
    """OCR faktury — vrátí dict s daty."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {}
    try:
        ext = fpath.rsplit(".", 1)[-1].lower()
        with open(fpath, "rb") as fh:
            raw = fh.read()
        b64 = base64.standard_b64encode(raw).decode("utf-8")
        if ext == "pdf":
            block = {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64}}
        else:
            mt = {"jpg":"image/jpeg","jpeg":"image/jpeg","png":"image/png"}.get(ext,"image/jpeg")
            block = {"type": "image", "source": {"type": "base64", "media_type": mt, "data": b64}}
        client = anthropic.Anthropic(api_key=api_key)
        # Zjistit firmu z IČO
        ico_map = json.loads(os.environ.get("ICO_MAP_JSON", "{}"))
        msg = client.messages.create(
            model="claude-sonnet-4-20250514", max_tokens=2000,
            messages=[{"role": "user", "content": [block, {"type": "text", "text": f"""Analyzuj tuto MAKRO fakturu (daňový doklad).
Odpověz POUZE platným JSON, žádný jiný text.

Důležité pro číslo faktury: hledej pole "Faktura č." nebo "Faktura č. / VS" — to je správné číslo faktury (např. 0466005189). IGNORUJ číslo vpravo nahoře které vypadá jako 0066/0955 — to je číslo objednávky.

{{
  "dodavatel": "název dodavatele (obvykle MAKRO Cash & Carry ČR s.r.o.)",
  "cislo_faktury": "číslo z pole Faktura č. nebo Faktura č. / VS",
  "datum_vystaveni": "YYYY-MM-DD nebo null",
  "datum_splatnosti": "YYYY-MM-DD nebo null",
  "celkem_s_dph": číslo (celková částka včetně DPH),
  "ico_odberatele": "IČO odběratele nebo null",
  "polozky": [
    {{
      "nazev": "název zboží",
      "mnozstvi": číslo,
      "jednotka": "PC/CA/KG atd.",
      "cena_za_jednotku_s_dph": číslo,
      "celkem_s_dph": číslo
    }}
  ]
}}
Známá IČO firem: {json.dumps(ico_map)}"""
            }]}]
        )
        text = msg.content[0].text.strip()
        text = re.sub(r"^```json\s*", "", text); text = re.sub(r"```$", "", text).strip()
        parsed = json.loads(text)
        # Přiřadit firmu podle IČO
        ico_odb = parsed.get("ico_odberatele", "")
        firma = ico_map.get(str(ico_odb), "")
        parsed["firma_zkratka"] = firma
        return parsed
    except Exception as e:
        print(f"⚠ OCR error: {e}")
        return {}


@vyzaduj_prihlaseni
def api_zaloha_db():
    if session.get("role") != "admin":
        return jsonify({"error": "Pouze admin"}), 403
    import subprocess, tempfile, os as _os
    from datetime import datetime as _dt
    db_url = _os.environ.get("DATABASE_URL", "")
    if not db_url:
        return jsonify({"error": "DATABASE_URL není nastavena"}), 500
    ts = _dt.now().strftime("%Y%m%d_%H%M%S")
    filename = f"zaloha_{ts}.sql"
    try:
        result = subprocess.run(
            ["pg_dump", "--no-password", "--format=plain", "--encoding=UTF8", db_url],
            capture_output=True, timeout=60
        )
        if result.returncode != 0:
            return jsonify({"error": result.stderr.decode("utf-8", errors="replace")}), 500
        sql_data = result.stdout
    except FileNotFoundError:
        return jsonify({"error": "pg_dump není dostupný na serveru"}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Záloha trvá příliš dlouho"}), 500

    # Uložit do GCS (složka zalohy/)
    gcs_url = None
    try:
        bucket = get_gcs_client()
        if bucket:
            blob = bucket.blob(f"zalohy/{filename}")
            blob.upload_from_string(sql_data, content_type="application/sql")
            gcs_url = f"gs://{_os.environ.get('GCS_BUCKET_NAME','')}/zalohy/{filename}"
            print(f"✅ Záloha uložena do GCS: {gcs_url}")
    except Exception as e:
        print(f"⚠  GCS záloha error: {e}")

    from flask import Response
    resp = Response(
        sql_data,
        mimetype="application/sql",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )
    if gcs_url:
        resp.headers["X-GCS-URL"] = gcs_url
    return resp


@app.route("/api/smazat-vse-faktury", methods=["POST"])
@vyzaduj_prihlaseni
def api_smazat_vse_faktury():
    with get_db() as conn:
        conn.execute("DELETE FROM polozky")
        cur = conn.execute("DELETE FROM faktury")
        smazano = cur.rowcount if hasattr(cur, 'rowcount') else 0
    return jsonify({"ok": True, "smazano": smazano})

@app.route("/api/normalizuj-nazvy", methods=["POST"])
@vyzaduj_prihlaseni
def api_normalizuj_nazvy():
    """Odstraní prefixy ARO, MC, FL z nazev_canonical v tabulce zbozi.
    Názvy položek na fakturách zůstanou nedotčeny."""
    import re as _re
    prefix_re = _re.compile(r'^(ARO|MC|FL)\s+', _re.IGNORECASE)
    with get_db() as conn:
        zbozi = conn.execute("SELECT id, nazev_canonical FROM zbozi").fetchall()
        opraveno = 0
        for z in zbozi:
            nazev = z["nazev_canonical"] or ""
            novy = prefix_re.sub("", nazev).strip()
            if novy != nazev:
                conn.execute("UPDATE zbozi SET nazev_canonical=? WHERE id=?", (novy, z["id"]))
                opraveno += 1
    return jsonify({"ok": True, "opraveno": opraveno})
@app.route("/api/oprav-duplicity", methods=["POST"])
@vyzaduj_prihlaseni
def api_oprav_duplicity():
    """Jednorázový endpoint – doplní duplicita_id zpětně pro existující duplicitní faktury."""
    try:
        with get_db() as conn:
            faktury = conn.execute(
                "SELECT id, cislo_faktury, datum_vystaveni, celkem_s_dph FROM faktury ORDER BY id ASC"
            ).fetchall()

        opraveno = 0
        with get_db() as conn:
            for f in faktury:
                # Hledáme starší fakturu se stejným VS + datum + částka
                original = conn.execute(
                    """SELECT id FROM faktury
                       WHERE cislo_faktury = ? AND datum_vystaveni = ? AND celkem_s_dph = ?
                       AND id < ? AND (duplicita_id IS NULL OR duplicita_id = 0)
                       ORDER BY id ASC LIMIT 1""",
                    (f["cislo_faktury"], f["datum_vystaveni"], f["celkem_s_dph"], f["id"])
                ).fetchone()

                if original:
                    conn.execute(
                        "UPDATE faktury SET duplicita_id = ? WHERE id = ? AND (duplicita_id IS NULL OR duplicita_id = 0)",
                        (original["id"], f["id"])
                    )
                    opraveno += 1

        return jsonify({"ok": True, "opraveno": opraveno})
    except Exception as e:
        return jsonify({"ok": False, "chyba": str(e)}), 500


if __name__ == "__main__":
    print("=" * 55)
    print("  Správa faktur – spouštím server")
    print("  Otevři prohlížeč na: http://localhost:5000")
    print("=" * 55)
    app.run(host="0.0.0.0", port=5000, debug=False)
