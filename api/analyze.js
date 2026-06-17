// api/analyze.js - Vercel Serverless Function

// ── GEMINI KVIETIMAS SU RETRY ──
// gemini-2.5-flash-lite kartais grąžina 503 ("model overloaded") arba kitus
// laikinus errorus net be jokios mūsų kaltės. Vienas nesėkmingas request'as
// reiškia, kad realus žmogus pamato klaidą ir greičiausiai nebandys antrą
// kartą - tad bandome iki 3 kartų su trumpu backoff prieš grąžinant klaidą.
async function callGeminiWithRetry(prompt, apiKey, maxAttempts = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 8000 }
  });
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });

    if (resp.ok) return resp;

    const errText = await resp.text();

    if (!RETRYABLE.has(resp.status) || attempt === maxAttempts) {
      console.error('Gemini error:', resp.status, errText);
      throw new Error(`Gemini API error: ${resp.status}`);
    }

    console.warn(`Gemini ${resp.status} (bandymas ${attempt}/${maxAttempts}), bandoma vėl po ${attempt}s...`);
    await new Promise(r => setTimeout(r, attempt * 1000));
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { cvText, questionnaire, targetFields, careerGoal, name, email, phone } = req.body;

    const role = Array.isArray(targetFields) && targetFields.length > 0
      ? targetFields.join(', ')
      : 'IT / technologijų sritis';

    // ── INPUT ŠALTINIS: pilnas CV tekstas ARBA trumpa anketa (kai nėra CV) ──
    let profileText;
    let inputSource;

    if (typeof cvText === 'string' && cvText.trim().length >= 30) {
      profileText = cvText.trim();
      inputSource = 'cv';
    } else if (
      questionnaire &&
      typeof questionnaire === 'object' &&
      typeof questionnaire.currentTitle === 'string' &&
      questionnaire.currentTitle.trim().length > 0
    ) {
      profileText = buildProfileFromQuestionnaire(questionnaire, targetFields, careerGoal);
      inputSource = 'questionnaire';
    } else {
      return res.status(400).json({
        error: 'Nei CV tekstas, nei anketos duomenys nepateikti arba per trumpi. Pateikite CV (min. 30 simbolių) arba užpildytą anketą.'
      });
    }

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ error: 'API key not configured' });

    const geminiResponse = await callGeminiWithRetry(
      buildPrompt(profileText, role, inputSource),
      GEMINI_KEY
    );
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
      // Tobulinimo kryptys — tik pavadinimai (be aprašymų), kad sales matytų trumpai
      const improvementTitles = (analysis.improvements || [])
        .map(i => i.title)
        .filter(Boolean)
        .join(' | ');

      // Rekomenduojami VCS kursai — tik pavadinimai
      const courseNames = (analysis.vcsRecommendations || [])
        .map(r => r.title)
        .filter(Boolean)
        .join(' | ');

      await saveToSheets({
        date:               new Date().toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius' }),
        name:               name              || '',
        email:              email             || '',
        phone:              phone             || '',
        segment:            careerGoal        || '',
        fields:             role,
        overallScore:       analysis.overallScore     ?? '',
        aiScore:            analysis.aiReadinessScore ?? '',
        source:             inputSource,
        scoreLabel:         analysis.scoreLabel       || '',
        improvements:       improvementTitles,
        courses:            courseNames
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
    data.segment, data.fields, data.overallScore, data.aiScore,
    data.source || '', data.scoreLabel || '',
    data.improvements || '', data.courses || ''
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

// ── ANKETOS DUOMENYS → "SINTETINIS CV" TEKSTAS ──
// Naudojama, kai vartotojas neturi CV su savimi - 7 žingsnių anketos atsakymai
// paverčiami į trumpą struktūruotą profilį, kuris paduodamas TAI PAČIAI
// buildPrompt() funkcijai, kaip ir tikras CV tekstas.
//
// Tikimasi questionnaire formos:
// {
//   currentTitle:    "Pardavimų vadybininkė",          // 1 žingsnis, laisvas tekstas
//   experienceRange: "1-3 metai",                       // 2 žingsnis
//   roleLevel:       "Specialistas",                    // 3 žingsnis
//   competencies:    ["Loginis mąstymas", ...],         // 4 žingsnis, min. 3
//   tools:           ["Canva", "Google Analytics"],     // 5 žingsnis, tag-input
//   aiTools:         ["ChatGPT"],                        // 6 žingsnis (arba ["Nenaudoju AI įrankių"])
//   growthBlocker:   "Nežinau, į kurią pusę krypti"      // 7 žingsnis
// }
function buildProfileFromQuestionnaire(q, targetFields, careerGoal) {
  const lines = [];

  lines.push('Šis profilis sudarytas iš trumpos struktūruotos anketos, kurią užpildė vartotojas, neturėjęs CV su savimi - tai NE pilnas CV dokumentas.');
  lines.push('');

  if (q.currentTitle) {
    lines.push(`Dabartinės pareigos: ${q.currentTitle}.`);
  }
  if (q.experienceRange) {
    lines.push(`Patirtis šioje srityje: ${q.experienceRange}.`);
  }
  if (q.roleLevel) {
    lines.push(`Pareigų lygis: ${q.roleLevel}.`);
  }
  if (Array.isArray(q.competencies) && q.competencies.length > 0) {
    lines.push(`Stipriausios kompetencijos (paties nurodytos): ${q.competencies.join(', ')}.`);
  }
  if (Array.isArray(q.tools) && q.tools.length > 0) {
    lines.push(`Kasdien naudojami įrankiai: ${q.tools.join(', ')}.`);
  }
  if (Array.isArray(q.aiTools) && q.aiTools.length > 0) {
    const usesNone = q.aiTools.some(t => /nenaudoju/i.test(t));
    lines.push(
      usesNone
        ? 'AI įrankių šiuo metu darbe nenaudoja.'
        : `AI įrankiai, kuriuos naudoja: ${q.aiTools.join(', ')}.`
    );
  }
  if (q.growthBlocker) {
    lines.push(`Pagrindinis augimo stabdys (paties nurodytas): ${q.growthBlocker}.`);
  }

  if (q.additionalInfo && q.additionalInfo.trim().length > 0) {
    lines.push('');
    lines.push('Papildoma informacija, kurią vartotojas pats įrašė laisvu tekstu (neprivaloma anketos dalis):');
    lines.push(q.additionalInfo.trim());
  }

  lines.push('');
  if (Array.isArray(targetFields) && targetFields.length > 0) {
    lines.push(`Tikslinė sritis, kurią norėtų tobulinti: ${targetFields.join(', ')}.`);
  }
  if (careerGoal) {
    lines.push(`Karjeros etapas: ${careerGoal}.`);
  }

  return lines.join('\n');
}

function buildPrompt(profileText, role, inputSource) {
  const isQuestionnaire = inputSource === 'questionnaire';

  const rule1 = isQuestionnaire
    ? '1. Šiam profiliui overallScore SKAIČIAVIMAS vyksta pagal formulę, aprašytą žemiau skiltyje "PAPILDOMA INSTRUKCIJA ŠIAM PROFILIUI" - NE pagal bendrą CV pilnumo įspūdį. Gautas skaičius vis tiek atitinka taisyklės Nr.3 ribas (0-30/31-60/61-80/81-100) scoreLabel priskyrimui.'
    : '1. Jei CV tekstas tuščias, per trumpas (<50 žodžių) arba neinformatyvus - overallScore TURI būti 0-25. Negalima išgalvoti informacijos.';

  const questionnaireNote = isQuestionnaire
    ? `
PAPILDOMA INSTRUKCIJA ŠIAM PROFILIUI:
Vartotojas neturėjo CV su savimi, todėl atsakė į trumpą struktūruotą anketą. Anketa SAVO PRIGIMTIMI yra trumpa ir negali turėti tiek detalių (konkrečių projektų, datų, kiekybinių rezultatų), kiek pilnas CV - tai NE trūkumas ir NETURI mažinti overallScore.

- "weaknesses" skiltyje NERAŠYK pastabų apie CV formatą, struktūrą, aprašymų stilių ar bendrai trūkstamą informaciją, kurios anketa tiesiog nerinko (pvz. NERAŠYK "trūksta pasiekimų aprašymo" ar "CV neturi darbo patirties skilties").
- "strengths" ir "missingSkills" turėtų remtis konkrečiais paminėtais įrankiais/kompetencijomis/AI įrankiais, lyginant su tuo, ko paprastai reikia dirbant srityje "${role}" - ne spėjimais apie tai, ko anketa "neparodė".

overallScore SKAIČIAVIMO FORMULĖ (naudok ją, NE bendrą CV pilnumo skalę):
1. BAZINIS BALAS pagal "Patirtis šioje srityje":
   - 0-1 metai → bazė 30-40
   - 1-3 metai → bazė 40-55
   - 3-6 metai → bazė 50-65
   - 6+ metai → bazė 60-75
   Jei "Pareigų lygis" yra "Komandos / projekto vadovas" arba "Įmonės savininkas / direktorius" - prie bazės pridėk +5-10.
2. + BONUSAS (iki +20) pagal tai, kiek nurodytos kompetencijos ir įrankiai yra RELEVANTIŠKI sričiai "${role}": kiekvienas akivaizdžiai tinkantis įrankis ar kompetencija - apie +2-4. Jei nurodyti įrankiai/kompetencijos neturi nieko bendro su "${role}" - bonuso nededi, BET bazės dėl to NEMAŽINI.
3. + BONUSAS (iki +10) už AI įrankius: naudoja bent 1 sričiai "${role}" tinkamą AI įrankį → +5-10. Jei nurodyta "Nenaudoju AI įrankių" → +0 (tai NE bauda, tiesiog nėra bonuso).
4. "Pagrindinis augimo stabdys" (paties nurodytas atsakymas) NIEKADA nemažina overallScore - tai savirefleksijos klausimas, naudojamas TIK pasirenkant selfGrowthTips/vcsRecommendations kryptį.

Sudėk (1)+(2)+(3), apvalink iki 100 (negali viršyti 100). Pavyzdys: "1-3 metai", "Specialistas", 3 sričiai relevantiškos kompetencijos, 2-3 relevantiški įrankiai, naudoja 1 AI įrankį → orientacinis rezultatas apie 55-70 (Vidutinis/Geras), NE 20-30.

5. PAPILDOMA INFORMACIJA (laisvas tekstas, neprivaloma anketos dalis): jei profilyje yra skiltis "Papildoma informacija, kurią vartotojas pats įrašė laisvu tekstu" su konkrečiais pasiekimais, projektais ar kiekybiniais rezultatais - GALI pridėti papildomai +5 iki +15 balų prie (1)+(2)+(3) sumos, jei šis turinys realiai rodo aukštesnį lygį, nei numatytų vien struktūrizuoti atsakymai. Naudok šią informaciją ir "strengths" skiltyje. Jei šios skilties NĖRA arba ji bendro pobūdžio (be konkrečių rezultatų) - NEDEDI papildomo bonuso, bet TAI NĖRA bauda.
`
    : '';

  const contentLabel = isQuestionnaire ? 'PROFILIO TURINYS (sudarytas iš anketos)' : 'CV TURINYS';

  return `Tu esi griežtas, bet sąžiningas karjeros konsultantas. Tavo tikslas - duoti REALŲ įvertinimą, ne komplimentus.

SVARBIAUSIOS TAISYKLĖS:
${rule1}
2. Jokių išgalvotų faktų. Jei informacijos nėra - rašyk apie trūkumą, ne apie privalumus.
3. overallScore: tuščias/silpnas CV = 0-30, vidutinis = 31-60, geras = 61-80, puikus = 81-100.
${questionnaireNote}
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

${contentLabel}:
${profileText}

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
