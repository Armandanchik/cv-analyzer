// api/track.js - Vercel Serverless Function
// Lengvas funnel event tracking. Front-end'as "fire-and-forget" siunčia
// įvykius (landed, step1_completed, step2_choice_made, submit_clicked)
// kiekvienam puslapio apsilankymui (sessionId generuojamas kliento puse).
// Įrašai keliauja į atskirą "Funnel_Events" lapą tame pačiame Sheet'e,
// kurį naudoja api/analyze.js - kad galėtume palyginti, kiek žmonių
// pasiekia kiekvieną žingsnį vs kiek baigia analizę.

const ALLOWED_EVENTS = new Set([
  'landed',
  'step1_completed',
  'step2_choice_made',
  'submit_clicked'
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { event, sessionId, meta } = req.body || {};

    if (!ALLOWED_EVENTS.has(event)) {
      return res.status(400).json({ error: 'Unknown event' });
    }

    await appendToSheet({
      date: new Date().toLocaleString('lt-LT', { timeZone: 'Europe/Vilnius' }),
      event,
      sessionId: typeof sessionId === 'string' ? sessionId.slice(0, 100) : '',
      meta: meta ? JSON.stringify(meta).slice(0, 500) : ''
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    // Tracking nėra kritinis kelias - klaida čia NETURI sugadinti vartotojo patirties,
    // tad logginame serverio puse, bet vis tiek grąžiname 200.
    console.error('Track error:', error.message);
    return res.status(200).json({ success: false });
  }
}

// ── GOOGLE SHEETS ──
async function appendToSheet(data) {
  const SPREADSHEET_ID = '13sSTO7sniHphcIVDhik2rxNU3rR7EsSGcG133d7iqD8';
  const SHEET_NAME = 'Funnel_Events';

  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const token = await getGoogleToken(serviceAccount);

  const row = [data.date, data.event, data.sessionId, data.meta];

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
}

// ── GOOGLE AUTH ──
// Pastaba: ši logika dubliuoja api/analyze.js, kad track.js būtų pilnai
// savarankiška, nepriklausoma funkcija (mažiau rizikos deploy'inant).
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
