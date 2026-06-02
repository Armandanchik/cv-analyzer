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
  return `Tu esi profesionalus karjeros konsultantas ir CV analizuotojas.
Isanalizuok si CV ir pateik strukturuota ivertinima.

ZMOGAUS DOMINANCIOS SRITYS: ${role}

CV TURINYS:
${cvText}

Graizink TIKTAI JSON objekta (be jokio papildomo teksto, be markdown backtick'u) tokia struktura:

{
  "overallScore": <skaicius 0-100>,
  "scoreLabel": "<Silpnas | Vidutinis | Geras | Puikus>",
  "currentField": "<nustatyta dabartine profesija/sritis>",
  "shouldChangeCareer": <true arba false>,
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
  "aiReadinessComment": "<1-2 sakiniai apie pasirengima skaitmeninei darbo rinkai>",
  "vcsRecommendations": [
    {
      "type": "<career_change | skill_upgrade>",
      "title": "<trumpas pavadinimas>",
      "reason": "<kodel sis kursas tinka butent siam zmogui, 1-2 sakiniai>",
      "courseUrl": "<VCS kurso URL>"
    }
  ]
}

Naudok tik sias VCS kursu nuorodas:
- AI irankiai: https://www.vilniuscoding.lt/mokymai/68-val-svarbiausi-di-irankiai-nuo-turinio-generavimo-iki-automatizavimo/
- Web programavimas su AI: https://www.vilniuscoding.lt/mokymai/120-val-web-programavimas-su-ai-next-js-cursor/
- AI inzinerija / Python / LLM: https://www.vilniuscoding.lt/mokymai/260-val-ai-inzinerija-python-programavimas-llm-integracija-ir-ismaniu-agentu-kurimas/
- El. parduotuve: https://www.vilniuscoding.lt/mokymai/72-val-tavo-el-parduotuve-per-6-savaites-praktinis-kursas/
- Skaitmenine rinkodara: https://www.vilniuscoding.lt/mokymai/160-val-skaitmenine-rinkodara-ir-analitika-google-ir-meta-reklamos-seo-cro/
- Power BI pazengusieji: https://www.vilniuscoding.lt/mokymai/24-val-power-bi-pazengusiems/
- Power BI + AI: https://www.vilniuscoding.lt/mokymai/powerbi-duomenu-vizualizacija/
- SQL + AI: https://www.vilniuscoding.lt/mokymai/sql-duomenu-baziu-valdymas/
- Excel + AI: https://www.vilniuscoding.lt/mokymai/ms-excel-ir-vba/
- Duomenu analize: https://www.vilniuscoding.lt/mokymai/duomenu-analizes-pagrindai-su-sql-power-bi-ir-ai-irankiais/
- Duomenu analitika ir Python: https://www.vilniuscoding.lt/mokymai/duomenu-analitika/
- Kibernetinis saugumas: https://www.vilniuscoding.lt/mokymai/kibernetinio-saugumo-pagrindai/
- DevOps: https://www.vilniuscoding.lt/mokymai/160-val-devops-pagrindai-procesu-automatizavimas-ir-efektyvus-vystymas/
- UX/UI dizainas: https://www.vilniuscoding.lt/mokymai/web-dizainas-ux-ui-pasitelkiant-ai-irankius/
- Projektu valdymas: https://www.vilniuscoding.lt/mokymai/66-val-projektu-valdymas-agile-metodologija/
- Python: https://www.vilniuscoding.lt/mokymai/python-programavimo-pagrindai/
- RPA + AI: https://www.vilniuscoding.lt/mokymai/robotiniu-procesu-automatizavimas-rpa/
- Full Stack JavaScript: https://www.vilniuscoding.lt/mokymai/full-stack-programavimas/
- Rankinis Testavimas: https://www.vilniuscoding.lt/mokymai/96-val-rankinis-testavimas-testavimo-pagrindai-jira-postman-ir-dirbtinis-intelektas/
- Automatinis Testavimas: https://www.vilniuscoding.lt/mokymai/96-val-rankinis-testavimas-testavimo-pagrindai-jira-postman-ir-dirbtinis-intelektas/

Rekomenduok 2-3 kursus. Visos reiksmes turi buti lietuviu kalba.`;
}
