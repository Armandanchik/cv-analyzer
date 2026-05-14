# CV Analizatorius su AI 🤖
**Vilnius Coding School – Lead Magnet projektas**

Šis projektas yra puiki vieta mokytis full-stack web development su AI integracijom.

---

## Projekto struktūra

```
cv-analyzer/
├── index.html          ← Frontend (HTML + CSS + JS)
├── api/
│   └── analyze.js      ← Serverless Function (Vercel) – slepia API raktą
├── package.json        ← Node.js konfigūracija
├── vercel.json         ← Vercel deployment konfigūracija
├── .env.local          ← API raktai (NIEKADA nekopijuoti į GitHub!)
├── .gitignore          ← Apsaugo sekretu nuo GitHub
└── README.md           ← Šis failas
```

---

## Kaip paleisti lokaliai

### 1. Gauti Gemini API raktą (nemokama)
1. Eik į https://aistudio.google.com
2. Spausk "Get API key" → "Create API key"
3. Nukopijuok raktą

### 2. Sukonfigūruoti .env.local
```bash
GEMINI_API_KEY=tavo_raktas_cia
```

### 3. Instaliuoti ir paleisti
```bash
npm install
npx vercel dev
```

Atidaryk naršyklę: http://localhost:3000

---

## Deployment į Vercel (nemokama)

### 1. Sukurti GitHub repo
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/tavo-vardas/cv-analyzer.git
git push -u origin main
```

### 2. Sujungti su Vercel
1. Eik į https://vercel.com
2. "Add New Project" → importuok iš GitHub
3. Settings → Environment Variables → pridėk GEMINI_API_KEY
4. Deploy!

Kiekvieną kartą kai keitiesi kodą GitHub'e – Vercel automatiškai atnaujins.

---

## Kaip tai veikia (mokymosi tikslais)

```
Browser (index.html)
    │
    │  POST /api/analyze
    │  { cvText, targetRole, name, email }
    │
    ▼
Vercel Function (api/analyze.js)   ← Serveris
    │  - Gauna duomenis
    │  - Kviečia Gemini API su SECRET key
    │  - Grąžina analizę atgal
    │
    ▼
Gemini AI API
    │  - Analizuoja CV tekstą
    │  - Grąžina JSON su: score, strengths, weaknesses,
    │    improvements, missingSkills, aiReadiness
    │
    ▼
Browser
    │  - Rodo animuotus rezultatus
    │  - Rekomenduoja kursus
```

**Kodėl serverio funkcija, o ne tiesiai iš naršyklės?**
- API raktas naršyklėje = visi gali jį pavogti
- Serverio funkcijoje = raktas saugus, niekas jo nemato

---

## Tolesni mokymosi žingsniai (roadmap)

### Lygis 1 – Dabartinis (veikia!)
- [x] Frontend su drag & drop
- [x] Serverless API function
- [x] Gemini AI integracija
- [x] Animuoti rezultatai

### Lygis 2 – Tobulinimai
- [ ] PDF parsavimas (pdf-parse library)
- [ ] Word (.docx) parsavimas (mammoth library)
- [ ] Rate limiting (kad niekas neapkrautų API)
- [ ] Geriau atrodo mobiliame

### Lygis 3 – Duomenų bazė
- [ ] Supabase integracija (nemokama PostgreSQL)
- [ ] Saugoti lead'us į DB (ne tik Google Sheets)
- [ ] Peržiūrėti visus lead'us admin panelėje

### Lygis 4 – Email automatizacija
- [ ] Resend arba SendGrid integracija
- [ ] Automatinis el. laiškas su pilna ataskaita
- [ ] Follow-up sekos

### Lygis 5 – Next.js migracija
- [ ] Perkurti kaip Next.js aplikaciją
- [ ] TypeScript tipai
- [ ] Unit testai

---

## Naudingos nuorodos

- [Gemini API dokumentacija](https://ai.google.dev/docs)
- [Vercel Serverless Functions](https://vercel.com/docs/functions)
- [Supabase (nemokama DB)](https://supabase.com)
- [Resend (el. laiškai)](https://resend.com)

---

*Sukurta su Vilnius Coding School ❤️*
