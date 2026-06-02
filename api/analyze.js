// api/analyze.js - Vercel Serverless Function

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { cvText, targetFields, careerGoal, name, email, phone } = req.body;

    const role = Array.isArray(targetFields) && targetFields.length > 0
      ? targetFields.join(', ')
      : 'IT / technologijų sritis';

    if (!cvText || cvText.length < 30) {
      return res.status(400).json({ error: 'CV text is too short' });
    }

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    const prompt = buildPrompt(cvText, role);

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 8000 }
        })
      }
    );

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      console.error('Gemini error:', geminiResponse.status, errText);
      throw new Error(`Gemini API error: ${geminiResponse.status} - ${errText}`);
    }

    const geminiData = await geminiResponse.json();
    console.log('Gemini response received, parsing...');
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Empty response from Gemini');

    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    let analysis;
    try {
      analysis = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('JSON parse failed. Raw text:', rawText.slice(0, 500));
      throw new Error('Failed to parse Gemini response as JSON');
    }

    appendToSheets({
      name:         name        || '',
      email:        email       || '',
      phone:        phone       || '',
      segment:      careerGoal  || '',
      fields:       role,
      overallScore: analysis.overallScore     ?? '',
      aiScore:      analysis.aiReadinessScore ?? '',
      date:         new Date().toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius' })
    }).catch(err => console.error('Sheets error:', err));

    return res.status(200).json({ success: true, analysis });

  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ error: 'Analysis failed', message: error.message });
  }
};

// ── SHEETS APPEND via Apps Script Webhook ──
async function appendToSheets(data) {
  const WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbyZ0K-9FRq7wVZPBLuN0GquMBWIsSQNOlCrqISvf0f95c3fSsR838JV4SQ61orE14Gy/exec';

  const payload = {
    date:         data.date,
    name:         data.name,
    email:        data.email,
    phone:        data.phone,
    segment:      data.segment,
    fields:       data.fields,
    overallScore: data.overallScore,
    aiScore:      data.aiScore
  };

  console.log('Sheets: sending to webhook...');

  const response = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });

  const text = await response.text();
  console.log('Sheets: webhook response:', response.status, text);
}

function buildPrompt(cvText, role) {
  return `Tu esi profesionalus karjeros konsultantas ir CV analizuotojas.
Isanalizuok si CV ir pateik strukturuota ivertinima.

ZMOGAUS DOMINANCIOS SRITYS: ${role}

CV TURINYS:
${cvText}

Graizink TIKTAI JSON objekta (be jokio papildomo teksto, be markdown backtick'u) tokia struktura:

{
  "overallScore": <skaicius 0-100>,
  "scoreLabel": "<Silpnas | Vidutinis | Geras | Puikus>",
  "currentField": "<nustatyta dabartine profesija/sritis pvz: Media Buyer, Java Programuotojas, Duomenu Analitikas, Vadybininkas ir t.t.>",
  "shouldChangeCareer": <true jei reiketu keisti profesija, false jei geriau gilintis esamoje srityje>,
  "summary": "<2-3 sakiniai bendras ivertinimas lietuviu kalba>",
  "strengths": ["<stiprybe 1>", "<stiprybe 2>", "<stiprybe 3>"],
  "weaknesses": ["<silpnybe 1>", "<silpnybe 2>", "<silpnybe 3>"],
  "improvements": [
    {"title": "<pavadinimas>", "description": "<konkretus patarimas>"},
    {"title": "<pavadinimas>", "description": "<konkretus patarimas>"},
    {"title": "<pavadinimas>", "description": "<konkretus patarimas>"}
  ],
  "missingSkills": ["<igudis 1>", "<igudis 2>", "<igudis 3>"],
  "aiReadinessScore": <skaicius 0-100>,
  "aiReadinessComment": "<1-2 sakiniai natūraliai paaiskinant zmogaus pasirengima AI erai>",
  "vcsRecommendations": [
    {
      "type": "<career_change | skill_upgrade>",
      "title": "<trumpas pavadinimas>",
      "reason": "<kodel sis kursas tinka butent siam zmogui, 1-2 sakiniai>",
      "courseUrl": "<VCS kurso URL>"
    }
  ]
}

SVARBU del vcsRecommendations:
- Jei shouldChangeCareer = false: rekomenduok konkrecius irankius/kursus ESAMAI profesijai gilinti (skill_upgrade).
- Jei shouldChangeCareer = true: rekomenduok karjeros keitimo kursus (career_change).

Naudok tik sias VCS kursu nuorodas pagal tematika:
- AI irankiai (bendrai): https://www.vilniuscoding.lt/mokymai/68-val-svarbiausi-di-irankiai-nuo-turinio-generavimo-iki-automatizavimo/
- Web programavimas su AI: https://www.vilniuscoding.lt/mokymai/120-val-web-programavimas-su-ai-next-js-cursor/
- AI inzinerija / Python / LLM: https://www.vilniuscoding.lt/mokymai/260-val-ai-inzinerija-python-programavimas-llm-integracija-ir-ismaniu-agentu-kurimas/
- El. parduotuve / e-komercija: https://www.vilniuscoding.lt/mokymai/72-val-tavo-el-parduotuve-per-6-savaites-praktinis-kursas/
- Skaitmenine rinkodara: https://www.vilniuscoding.lt/mokymai/160-val-skaitmenine-rinkodara-ir-analitika-google-ir-meta-reklamos-seo-cro/
- Power BI pazengusieji: https://www.vilniuscoding.lt/mokymai/24-val-power-bi-pazengusiems/
- Power BI + AI (pagrindai): https://www.vilniuscoding.lt/mokymai/powerbi-duomenu-vizualizacija/
- SQL + AI: https://www.vilniuscoding.lt/mokymai/sql-duomenu-baziu-valdymas/
- Excel + AI: https://www.vilniuscoding.lt/mokymai/ms-excel-ir-vba/
- Duomenu analize SQL+PowerBI+AI: https://www.vilniuscoding.lt/mokymai/duomenu-analizes-pagrindai-su-sql-power-bi-ir-ai-irankiais/
- Duomenu analitika ir Python: https://www.vilniuscoding.lt/mokymai/duomenu-analitika/
- Kibernetinis saugumas: https://www.vilniuscoding.lt/mokymai/kibernetinio-saugumo-pagrindai/
- DevOps: https://www.vilniuscoding.lt/mokymai/160-val-devops-pagrindai-procesu-automatizavimas-ir-efektyvus-vystymas/
- UX/UI dizainas: https://www.vilniuscoding.lt/mokymai/web-dizainas-ux-ui-pasitelkiant-ai-irankius/
- Projektu valdymas Agile: https://www.vilniuscoding.lt/mokymai/66-val-projektu-valdymas-agile-metodologija/
- Python programavimas: https://www.vilniuscoding.lt/mokymai/python-programavimo-pagrindai/
- RPA + AI: https://www.vilniuscoding.lt/mokymai/robotiniu-procesu-automatizavimas-rpa/
- Full Stack JavaScript: https://www.vilniuscoding.lt/mokymai/full-stack-programavimas/
- AI Inzinerija: https://www.vilniuscoding.lt/mokymai/260-val-ai-inzinerija-python-programavimas-llm-integracija-ir-ismaniu-agentu-kurimas/
- Rankinis Testavimas: https://www.vilniuscoding.lt/mokymai/96-val-rankinis-testavimas-testavimo-pagrindai-jira-postman-ir-dirbtinis-intelektas/
- Automatinis Testavimas: https://www.vilniuscoding.lt/mokymai/96-val-rankinis-testavimas-testavimo-pagrindai-jira-postman-ir-dirbtinis-intelektas/

Rekomenduok 2-3 kursus. Visos reiksmes turi buti lietuviu kalba.`;
}
