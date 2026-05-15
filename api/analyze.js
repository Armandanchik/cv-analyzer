// api/analyze.js
// Vercel Serverless Function - API key is NEVER exposed to browser

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { cvText, targetFields, name, email } = req.body;

    // Build role string from targetFields array
    const role = Array.isArray(targetFields) && targetFields.length > 0
      ? targetFields.join(', ')
      : 'IT / technologijų sritis';

    if (!cvText || cvText.length < 50) {
      return res.status(400).json({ error: 'CV text is too short' });
    }

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    const prompt = buildPrompt(cvText, role);

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1500
          }
        })
      }
    );

    if (!geminiResponse.ok) {
      const errText = await geminiResponse.text();
      throw new Error(`Gemini API error: ${geminiResponse.status} - ${errText}`);
    }

    const geminiData = await geminiResponse.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) throw new Error('Empty response from Gemini');

    // Clean markdown if Gemini wraps in backticks
    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const analysis = JSON.parse(cleaned);

    // Optional: save to Google Sheets
    if (process.env.SHEETS_WEBHOOK_URL && email) {
      const params = new URLSearchParams({
        name: name || '',
        email: email,
        targetRole: role,
        score: analysis.overallScore || '',
        date: new Date().toLocaleString('lt-LT')
      });
      fetch(process.env.SHEETS_WEBHOOK_URL + '?' + params.toString()).catch(() => {});
    }

    return res.status(200).json({ success: true, analysis });

  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ error: 'Analysis failed', message: error.message });
  }
}

function buildPrompt(cvText, role) {
  return `Tu esi profesionalus karjeros konsultantas ir CV analizuotojas.
Isanalizuok si CV ir pateik strukturuota ivertinima.

TIKSLINE SRITIS: ${role}

CV TURINYS:
${cvText}

Graizink TIKTAI JSON objekta (be jokio papildomo teksto, be markdown) sia struktura:

{
  "overallScore": <skaicius 0-100>,
  "scoreLabel": "<Silpnas | Vidutinis | Geras | Puikus>",
  "summary": "<2-3 sakiniai bendras ivertinimas lietuviu kalba>",
  "strengths": ["<stiprybe 1>", "<stiprybe 2>", "<stiprybe 3>"],
  "weaknesses": ["<silpnybe 1>", "<silpnybe 2>", "<silpnybe 3>"],
  "improvements": [
    {"title": "<pavadinimas>", "description": "<konkretus patarimas>"},
    {"title": "<pavadinimas>", "description": "<konkretus patarimas>"},
    {"title": "<pavadinimas>", "description": "<konkretus patarimas>"}
  ],
  "missingSkills": ["<trukstamas igudis 1>", "<igudis 2>", "<igudis 3>"],
  "aiReadiness": <skaicius 0-100>,
  "recommendation": "<1 konkreti rekomendacija ka daryti toliau>"
}

Visos reiksmes turi buti lietuviu kalba. Buk konkretus ir praktiskas.`;
}
