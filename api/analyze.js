// api/analyze.js - Vercel Serverless Function

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { cvText, targetFields, careerGoal, name, email, phone } = req.body;

    const role = Array.isArray(targetFields) && targetFields.length > 0
      ? targetFields.join(', ')
      : 'IT / technologijų sritis';

    if (!cvText || cvText.length < 30) {
      return res.status(400).json({ error: 'CV text is too short' });
    }

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'API key not configured' });

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(cvText, role) }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 8000 }
        })
      }
    );

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      console.error('Gemini error:', geminiResponse.status, errText);
      throw new Error(`Gemini API error: ${geminiResponse.status}`);
    }

    const geminiData = await geminiResponse.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Empty response from Gemini');

    console.log('Gemini response received, parsing...');

    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    let analysis;
    try {
      analysis = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON parse failed:', rawText.slice(0, 300));
      throw new Error('Failed to parse Gemini JSON');
    }

    // ── GOOGLE SHEETS ──
    try {
      await saveToSheets({
        date:         new Date().toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius' }),
        name:         name         || '',
        email:        email        || '',
        phone:        phone        || '',
        segment:      careerGoal   || '',
        fields:       role,
        overallScore: analysis.overallScore      ?? '',
        aiScore:      analysis.aiReadinessScore  ?? ''
      });
    } catch (sheetsErr) {
      console.error('Sheets error:', sheetsErr.message);
      // Nereiksmingas klaida — grazinamas rezultatas vis tiek
    }

    return res.status(200).json({ success: true, analysis });

  } catch (error) {
    console.error('Analysis error:', error.message);
    return res.status(500).json({ error: 'Analysis failed', message: error.message });
  }
}

// ── GOOGLE SHEETS ──
async function saveToSheets(data) {
  const SPREADSHEET_ID = '13sSTO7sniHphcIVDhik2rxNU3rR7EsSGcG133d7iqD8';
  const SHEET_NAME = 'CV_Leads_Analyzer';

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const token = await getGoogleToken(serviceAccount);

  const row = [
    data.date, data.name, data.email, data.phone,
    data.segment, data.fields, data.overallScore, data.aiScore
  ];

  console.log('Sheets: appending row...');

  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(SHEET_NAME)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: [row] })
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Sheets API error: ' + err);
  }

  console.log('Sheets: row saved successfully');
}

// ── GOOGLE AUTH ──
async function getGoogleToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const jwt = await createJWT(payload, serviceAccount.private_key);

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) throw new Error('Token error: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ── JWT ──
async function createJWT(payload, privateKeyPem) {
  const header = { alg: 'RS256', typ: 'JWT' };

  const b64Header  = btoa(JSON.stringify(header)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const b64Payload = btoa(JSON.stringify(payload)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const signingInput = b64Header + '.' + b64Payload;

  const pemBody = privateKeyPem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const binaryKey = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const b64Sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  return signingInput + '.' + b64Sig;
}

function buildPrompt(cvText, role) {
  return `Tu esi griežtas, bet sąžiningas karjeros konsultantas. Tavo tikslas - duoti REALŲ įvertinimą, ne komplimentus.

SVARBIAUSIOS TAISYKLĖS:
1. Jei CV tekstas tuščias, per trumpas (<50 žodžių) arba neinformatyvus - overallScore TURI būti 0-25. Negalima išgalvoti informacijos.
2. Jokių išgalvotų faktų. Jei informacijos nėra - rašyk apie trūkumą, ne apie privalumus.
3. overallScore: tuščias/silpnas CV = 0-30, vidutinis = 31-60, geras = 61-80, puikus = 81-100.

PROFILIŲ LOGIKA:

SILPNAS profilis (0-40 balų, mažai patirties, nori keisti karjerą):
→ vcsRecommendations: 2-3 kursai (pagrindinė rekomendacija)
→ selfGrowthTips: [] (tuščias)

STIPRUS profilis (61+ balų, patyręs specialistas dominančioje srityje):
→ vcsRecommendations: 1-2 kursai TIK jei yra konkrečių įgūdžių spragų kurių dar neturi
→ selfGrowthTips: 3-4 tekstinės gairės kaip augti savarankiškai (be URL nuorodų - tik tekstas)

TUŠČIAS/NEINFORMATYVUS CV:
→ vcsRecommendations: [] (tuščias)
→ selfGrowthTips: [] (tuščias)
→ tik sąžiningas summary

DOMINANČIOS SRITYS: ${role}

CV TURINYS:
${cvText}

Grąžink TIKTAI JSON objektą (be markdown, be backtickų):

{
  "overallScore": <0-100>,
  "scoreLabel": "<Silpnas | Vidutinis | Geras | Puikus>",
  "currentField": "<dabartinė profesija arba Nenurodyta>",
  "experienceLevel": "<Pradedantysis | Vidutinis | Patyręs | Ekspertas>",
  "shouldChangeCareer": <true arba false>,
  "isStrongCandidate": <true jei 61+ balų ir patyręs dominančioje srityje>,
  "summary": "<2-3 sakiniai sąžiningas įvertinimas>",
  "strengths": ["<tik realios stiprybės iš CV>"],
  "weaknesses": ["<konkrečios silpnybės>"],
  "improvements": [
    {"title": "<pavadinimas>", "description": "<konkretus patarimas>"}
  ],
  "missingSkills": ["<trūkstami įgūdžiai pagal dominančią sritį>"],
  "aiReadinessScore": <0-100>,
  "aiReadinessComment": "<realus komentaras apie skaitmeninę brandą>",
  "vcsRecommendations": [
    {
      "type": "<career_change | skill_upgrade>",
      "title": "<kurso pavadinimas>",
      "reason": "<kodėl tinka BŪTENT šiam žmogui>",
      "courseUrl": "<URL>"
    }
  ],
  "selfGrowthTips": [
    {
      "title": "<žingsnis>",
      "description": "<tekstinė gairė kaip augti - konkretūs žingsniai, sertifikatai, praktika. BEZ URL nuorodų>"
    }
  ]
}

VCS kursų nuorodos (naudok tik šias):
- AI įrankiai: https://www.vilniuscoding.lt/mokymai/68-val-svarbiausi-di-irankiai-nuo-turinio-generavimo-iki-automatizavimo/
- Web programavimas su AI: https://www.vilniuscoding.lt/mokymai/120-val-web-programavimas-su-ai-next-js-cursor/
- AI inžinerija / Python / LLM: https://www.vilniuscoding.lt/mokymai/260-val-ai-inzinerija-python-programavimas-llm-integracija-ir-ismaniu-agentu-kurimas/
- El. parduotuvė: https://www.vilniuscoding.lt/mokymai/72-val-tavo-el-parduotuve-per-6-savaites-praktinis-kursas/
- Skaitmeninė rinkodara: https://www.vilniuscoding.lt/mokymai/160-val-skaitmenine-rinkodara-ir-analitika-google-ir-meta-reklamos-seo-cro/
- Power BI pažengusiems: https://www.vilniuscoding.lt/mokymai/24-val-power-bi-pazengusiems/
- Power BI + AI: https://www.vilniuscoding.lt/mokymai/powerbi-duomenu-vizualizacija/
- SQL + AI: https://www.vilniuscoding.lt/mokymai/sql-duomenu-baziu-valdymas/
- Excel + AI: https://www.vilniuscoding.lt/mokymai/ms-excel-ir-vba/
- Duomenų analizė: https://www.vilniuscoding.lt/mokymai/duomenu-analizes-pagrindai-su-sql-power-bi-ir-ai-irankiais/
- Duomenų analitika ir Python: https://www.vilniuscoding.lt/mokymai/duomenu-analitika/
- Kibernetinis saugumas: https://www.vilniuscoding.lt/mokymai/kibernetinio-saugumo-pagrindai/
- DevOps: https://www.vilniuscoding.lt/mokymai/160-val-devops-pagrindai-procesu-automatizavimas-ir-efektyvus-vystymas/
- UX/UI dizainas: https://www.vilniuscoding.lt/mokymai/web-dizainas-ux-ui-pasitelkiant-ai-irankiais/
- Projektų valdymas: https://www.vilniuscoding.lt/mokymai/66-val-projektu-valdymas-agile-metodologija/
- Python: https://www.vilniuscoding.lt/mokymai/python-programavimo-pagrindai/
- RPA + AI: https://www.vilniuscoding.lt/mokymai/robotiniu-procesu-automatizavimas-rpa/
- Full Stack JavaScript: https://www.vilniuscoding.lt/mokymai/full-stack-programavimas/
- Rankinis testavimas: https://www.vilniuscoding.lt/mokymai/96-val-rankinis-testavimas-testavimo-pagrindai-jira-postman-ir-dirbtinis-intelektas/

Visos reikšmės lietuvių kalba.`;
}
