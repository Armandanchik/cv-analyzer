// api/analyze.js
// Vercel Serverless Function - runs on the server, API key is NEVER exposed to browser
//
// HOW IT WORKS:
// 1. Browser sends CV text + job target to POST /api/analyze
// 2. This function receives it, calls Gemini API with your secret key
// 3. Returns analysis back to browser
// 4. Browser never sees your API key

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CORS headers - allow your frontend domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { cvText, targetAreas, name, email } = req.body;

    // Basic validation
    if (!cvText || cvText.length < 50) {
      return res.status(400).json({ error: 'CV text is too short' });
    }

    // ── GEMINI API CALL ──────────────────────────────────────
    // process.env.GEMINI_API_KEY is set in Vercel dashboard (never in code!)
    const GEMINI_KEY = process.env.GEMINI_API_KEY;

    const prompt = buildPrompt(cvText, targetAreas);

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json' // Ask Gemini to return JSON
          }
        })
      }
    );

    if (!geminiResponse.ok) {
      throw new Error(`Gemini API error: ${geminiResponse.status}`);
    }

    const geminiData = await geminiResponse.json();

    // Extract text from Gemini response
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Empty response from Gemini');

    // Parse JSON from Gemini
    const analysis = JSON.parse(rawText);

    // ── OPTIONAL: Save lead to Google Sheets ────────────────
    // Reuse your existing Apps Script webhook
    if (process.env.SHEETS_WEBHOOK_URL && email) {
      const params = new URLSearchParams({
        name: name || '',
        email: email,
        targetRole: targetRole || '',
        score: analysis.overallScore || '',
        date: new Date().toLocaleString('lt-LT')
      });
      // Fire and forget - don't wait for response
      fetch(process.env.SHEETS_WEBHOOK_URL + '?' + params.toString()).catch(() => {});
    }

    return res.status(200).json({ success: true, analysis });

  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({
      error: 'Analysis failed',
      message: error.message
    });
  }
}

// ── PROMPT BUILDER ───────────────────────────────────────────
// This is the most important part - good prompt = good results
function buildPrompt(cvText, targetAreas) {
  const areas = Array.isArray(targetAreas) && targetAreas.length > 0
    ? targetAreas.join(', ')
    : 'bendra darbo rinka';

  return `
Tu esi profesionalus karjeros konsultantas ir CV analizuotojas.
Išanalizuok šį CV ir pateik struktūruotą įvertinimą.

SRITYS, KURIOS DOMINA ŽMOGŲ: ${areas}

Atkreipk dėmesį: žmogus nebūtinai yra IT specialistas.
Analizė turi būti pritaikyta būtent šioms sritims ir prieinama ne IT žmonėms.

CV TURINYS:
${cvText}

Grąžink TIKTAI JSON objektą (be jokio papildomo teksto, be markdown) šia struktūra:

{
  "overallScore": <skaičius 0-100>,
  "scoreLabel": <"Silpnas" | "Vidutinis" | "Geras" | "Puikus">,
  "summary": "<2-3 sakiniai bendras įvertinimas lietuvių kalba>",
  "strengths": [
    "<stiprybė 1>",
    "<stiprybė 2>",
    "<stiprybė 3>"
  ],
  "weaknesses": [
    "<silpnybė 1>",
    "<silpnybė 2>",
    "<silpnybė 3>"
  ],
  "improvements": [
    {
      "title": "<trumpas pavadinimas>",
      "description": "<konkretus patarimas kaip pagerinti>"
    },
    {
      "title": "<trumpas pavadinimas>",
      "description": "<konkretus patarimas kaip pagerinti>"
    },
    {
      "title": "<trumpas pavadinimas>",
      "description": "<konkretus patarimas kaip pagerinti>"
    }
  ],
  "missingSkills": [
    "<trūkstamas įgūdis 1 ${role} srityje>",
    "<trūkstamas įgūdis 2>",
    "<trūkstamas įgūdis 3>"
  ],
  "aiReadiness": <skaičius 0-100, kiek šis CV parengtas AI eros darbo rinkai>,
  "recommendation": "<1 aiški rekomendacija ką daryti toliau>"
}

Visos reikšmės turi būti lietuvių kalba.
Būk konkretus ir praktiškas, ne abstraktus.
`;
}
