# 🧾 Správa faktur

Lokální webová aplikace pro správu a analýzu přijatých faktur.

## Rychlý start

### 1. Nainstalujte závislosti

```bash
pip install flask openpyxl
```

**Volitelně – pro automatické rozpoznávání faktur MAKRO:**
```bash
pip install pdfplumber          # PDF s textem
pip install pytesseract Pillow  # fotky a skeny (vyžaduje Tesseract v systému)
```

Tesseract instalace (Windows): https://github.com/UB-Mannheim/tesseract/wiki
Tesseract instalace (Mac): `brew install tesseract`
Tesseract instalace (Linux): `sudo apt install tesseract-ocr tesseract-ocr-ces`

### 2. Spuštění

```bash
python app.py
```

Otevřete prohlížeč na adrese: **http://localhost:5000**

### 3. Vzdálený přístup

Aplikace poslouchá na `0.0.0.0:5000` – přístupná z jiných zařízení v síti na adrese:
`http://<IP-počítače>:5000`

---

## Struktura souborů

```
faktury_app/
├── app.py              ← hlavní aplikace (Flask)
├── faktury.db          ← databáze SQLite (vytvoří se automaticky)
├── config.json         ← konfigurace firem (vytvoří se automaticky)
├── requirements.txt    ← seznam Python balíčků
├── uploads/            ← nahrané soubory faktur
├── templates/
│   └── index.html      ← HTML šablona
└── static/
    ├── css/style.css   ← styly
    └── js/app.js       ← JavaScript logika
```

## Funkce

- **Dashboard** – přehled výdajů, grafy, faktury po splatnosti
- **Faktury** – seznam s filtry, detail, změna stavu, smazání
- **Nahrát fakturu** – drag & drop PDF/fotky MAKRO, automatické parsování
- **Ruční zadání** – formulář pro ostatní dodavatele
- **Zboží** – přehled nakoupeného zboží, slučování aliasů
- **Statistiky** – grafy výdajů, top dodavatelé, top zboží
- **Nastavení** – konfigurace zkratek firem
- **Export** – Excel a CSV se zachovanými filtry
- **Light/Dark mode** – přepínač v sidebaru
