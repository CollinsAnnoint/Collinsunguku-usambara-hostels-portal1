/* ============================================================
   USAMBARA MALE HOSTELS — LIVE SECURE SERVER
   Overseer (admin) manages all records. Students log in with
   reg no + PIN and can ONLY view their own record and submit
   reports. No one else can alter the system.
   ============================================================ */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; } // optional: automated email reports

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DEFAULT_OVERSEER_PASSWORD = process.env.OVERSEER_PASSWORD || 'unguku123';
const DB_CONFIG_FILE = process.env.DB_CONFIG_FILE || path.join(__dirname, 'db-config.json');
const DATA_ALERT_RECORDS = parseInt(process.env.DATA_ALERT_RECORDS, 10) || 300; // alert when total records reach this

// The database URI can come from an env var (Render) OR from db-config.json
// which the overseer can set inside the app. db-config.json wins if present.
function readDbConfig() {
  try { if (fs.existsSync(DB_CONFIG_FILE)) return JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8')); } catch(e){}
  return {};
}
function writeDbConfig(c) {
  try { fs.writeFileSync(DB_CONFIG_FILE, JSON.stringify(c, null, 2)); } catch(e){ console.warn('db-config write warn:', e.message); }
}
function dbUri() {
  const c = readDbConfig();
  return (c.uri && String(c.uri).trim()) || process.env.MONGODB_URI || '';
}
let currentMode = 'local'; // 'local' | 'mongodb'

/* ---------------- Gemini AI (real Collo AI brain) ----------------
   Collo AI can use Google Gemini to answer naturally & accurately. The API
   key is stored SERVER-SIDE only (env GEMINI_API_KEY, or gemini-config.json
   which the Overseer sets from Settings). It is never sent to the browser.
   Without a key the chat falls back to the built-in keyword assistant.
--------------------------------------------------------------------- */
const GEMINI_CONFIG_FILE = process.env.GEMINI_CONFIG_FILE || path.join(__dirname, 'gemini-config.json');
function readGeminiConfig() { try { if (fs.existsSync(GEMINI_CONFIG_FILE)) return JSON.parse(fs.readFileSync(GEMINI_CONFIG_FILE, 'utf8')); } catch(e){} return {}; }
function writeGeminiConfig(c) { try { fs.writeFileSync(GEMINI_CONFIG_FILE, JSON.stringify(c, null, 2)); } catch(e){ console.warn('ai-config write warn:', e.message); } }
// The stored key may be a Google Gemini key (starts AIza...) OR a Groq key (starts gsk_...).
function geminiKey()  { const c = readGeminiConfig(); return (c.key && String(c.key).trim()) || process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY || ''; }
// Detect which provider a key belongs to from its prefix.
function aiProvider(key){ key = key || geminiKey(); if (!key) return 'none'; if (/^gsk_/i.test(key)) return 'groq'; return 'gemini'; }
function geminiModel(){
  const c = readGeminiConfig();
  if (c.model && String(c.model).trim()) return String(c.model).trim();
  if (aiProvider() === 'groq') return process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  return process.env.GEMINI_MODEL || 'gemini-2.0-flash';
}

function aiSystemPrompt() {
  const s = db.settings || {};
  const title = s.pageTitle || 'Usambara Male Hostels';
  let p = 'You are Collo AI, the friendly, helpful AI assistant on the "' + title + '" website, built for Congressman Collins Unguku (Overseer of Usambara Male Hostels). '
    + 'You talk to students and visitors in a warm, supportive tone and use short, clear sentences with occasional emojis.\n\n';
  p += 'FACTS ABOUT THE HOSTEL:\n'
    + '- Name: ' + title + ' (Usambara Male Hostels), part of Kenyatta University accommodation.\n'
    + '- Overseer: Congressman Collins Unguku.\n'
    + '- Overseer contact / WhatsApp: 0769679217 (international: +254 769 679 217).\n'
    + '- Blocks covered: 2, 3, 4 and 5. Rooms include single, double, quad and hexagon.\n'
    + '- Students log in with their Reg/Admission No. and a PIN issued by the Overseer.\n'
    + '- To report a problem: a student signs in, opens "My Record", describes the issue, chooses urgency and submits — the Overseer is alerted. Reports can also be sent by WhatsApp to 0769679217.\n'
    + '- Only the Overseer can add, edit or remove student records. A student can only view their own record and submit reports.\n'
    + '- Reviews: students can rate the hostel 1-5 stars with a comment.\n'
    + '- The Overseer is a candidate for change at the hostel with a promise of clean water, reliable power, 24/7 security, zero theft tolerance and quick help. (Say the spirit is "together we rise, together we change.") Only mention this if asked about the campaign/promise.\n\n';
  // Include the Overseer's trained Q&A as reference knowledge
  const cb = (s.chatbot && Array.isArray(s.chatbot.faq)) ? s.chatbot.faq : [];
  if (cb.length) {
    p += 'REFERENCE KNOWLEDGE (use these when relevant, feel free to reword naturally):\n';
    cb.forEach((f, i) => { if (f.q && f.a) p += (i + 1) + '. Q: ' + f.q + '\n   A: ' + f.a + '\n'; });
    p += '\n';
  }
  p += 'RULES:\n'
    + '- Do not reveal that you have an API key or any technical implementation details.\n'
    + '- Do not give out private student records or PINs to anyone. For anything sensitive about a specific account, tell them to sign in or contact the Overseer on WhatsApp 0769679217.\n'
    + '- If you genuinely do not know the answer, be honest and offer to connect them with the Overseer.\n'
    + '- Keep answers concise (under ~150 words) and helpful. Today is ' + new Date().toISOString().slice(0, 10) + '.';
  return p;
}
// Build the conversation as OpenAI-style messages (used by Groq and Gemini-OpenAI endpoint).
function buildMessages(message, history) {
  const msgs = [{ role: 'system', content: aiSystemPrompt() }];
  (Array.isArray(history) ? history : []).forEach(m => {
    msgs.push({ role: (m && m.role === 'bot') ? 'assistant' : 'user', content: String((m && m.text) || '') });
  });
  msgs.push({ role: 'user', content: String(message || '').slice(0, 800) });
  return msgs;
}

// Call Groq (free tier, fast). Key starts with gsk_. Uses the OpenAI-compatible API.
async function callGroq(key, model, message, history) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const body = { model: model, messages: buildMessages(message, history), temperature: 0.4, max_tokens: 500 };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) { console.error('Groq error', res.status, JSON.stringify(data).slice(0, 300)); return null; }
  const txt = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
  return (txt && txt.trim()) || null;
}

// Call Google Gemini (free tier). Key starts with AIza.
async function callGeminiProvider(key, model, message, history) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
  const contents = [];
  buildMessages(message, history).forEach(m => {
    if (m.role === 'system') return; // system prompt goes in systemInstruction
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  });
  const body = {
    contents,
    systemInstruction: { parts: [{ text: aiSystemPrompt() }] },
    generationConfig: { temperature: 0.4, maxOutputTokens: 500 }
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { console.error('Gemini error', res.status, JSON.stringify(data).slice(0, 300)); return null; }
  const cand = data && data.candidates && data.candidates[0];
  const txt = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map(pp => pp.text || '').join('') : '';
  return (txt && txt.trim()) || null;
}

// Provider-agnostic entry point. Keeps the old name so existing callers work.
async function callGemini(message, history) {
  return callAI(message, history);
}
async function callAI(message, history) {
  const key = geminiKey(); if (!key) return null;
  const model = geminiModel();
  if (aiProvider(key) === 'groq') return callGroq(key, model, message, history);
  return callGeminiProvider(key, model, message, history);
}

/* ---------------- WhatsApp notifications (Meta Cloud API) ----------------
   Optional. To enable automatic WhatsApp alerts to your phone when a student
   submits a report, set these environment variables on your host:
     WHATSAPP_PHONE_ID  = your WhatsApp Business phone-number ID
     WHATSAPP_TOKEN     = a Meta Graph access token for that number
     WHATSAPP_TO        = the number to notify (intl format), default 254769679217
   Without them the app works fine and just skips notifications.
---------------------------------------------------------------------------- */
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WA_TOKEN    = process.env.WHATSAPP_TOKEN    || '';
const WA_TO       = process.env.WHATSAPP_TO       || '254769679217';
async function sendWhatsAppText(text) {
  if (!WA_PHONE_ID || !WA_TOKEN) {
    console.log('WhatsApp notify skipped (WHATSAPP_PHONE_ID / WHATSAPP_TOKEN not set).');
    return false;
  }
  const body = {
    messaging_product: 'whatsapp',
    to: WA_TO,
    type: 'text',
    text: { body: text }
  };
  try {
    const r = await fetch('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    console.log('WhatsApp notify:', r.status, r.status === 200 ? 'sent to ' + WA_TO : JSON.stringify(data).slice(0, 200));
    return r.status === 200;
  } catch(e){
    console.log('WhatsApp notify error:', e.message);
    return false;
  }
}
async function sendWhatsAppNotification(rep){
  const text = '🛎️ NEW REPORT — Usambara Male Hostels\n'
    + 'From: ' + rep.name + ' (' + rep.reg + ')\n'
    + 'Block ' + rep.block + ' · Room ' + rep.room
    + (rep.phone ? ' · WhatsApp ' + rep.phone : '') + '\n'
    + 'Urgency: ' + rep.urg + '\n'
    + 'Issue: ' + rep.msg + '\n\n'
    + 'Open the app to reply to this student.';
  await sendWhatsAppText(text);
}

/* ---------------- Password hashing (Node built-in scrypt) ---------------- */
function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  try {
    const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}

/* ---------------- Data store (pluggable) ----------------
   - If MONGODB_URI is set  -> uses MongoDB Atlas (permanent cloud DB, survives restarts).
   - Otherwise              -> uses a local JSON file (fine locally / for quick tests).
   The rest of the code just calls store.save(db) / store.load().
---------------------------------------------------------------------------- */
async function makeStore(uri) {
  if (uri) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
    await client.connect();                       // throw early if it cannot connect
    currentMode = 'mongodb';                      // only report mongodb once connected
    const collection = client.db().collection('hostel'); // single document store
    const backups = client.db().collection('backups');   // rotating snapshot store
    return {
      _client: client,
      async load() {
        const doc = await collection.findOne({ _id: 'main' });
        if (!doc) return null;
        delete doc._id;
        return doc;
      },
      async save(data) {
        await collection.replaceOne({ _id: 'main' }, { _id: 'main', ...data }, { upsert: true });
      },
      // Save a full snapshot of the main document into the backups collection (keep newest 14).
      async snapshot() {
        const doc = await collection.findOne({ _id: 'main' });
        if (!doc) return null;
        const data = Object.assign({}, doc); delete data._id;
        const id = 'snap-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const date = new Date().toISOString();
        await backups.insertOne({ _id: id, date, counts: countsOf(data), data });
        const all = await backups.find({}, { projection: { _id: 1 } }).sort({ date: -1 }).toArray();
        if (all.length > 14) await backups.deleteMany({ _id: { $in: all.slice(14).map(x => x._id) } });
        return { id, date, counts: countsOf(data) };
      },
      async listSnapshots() {
        const all = await backups.find({}, { projection: { data: 0 } }).sort({ date: -1 }).toArray();
        return all.map(s => ({ id: s._id, date: s.date, counts: s.counts || countsOf(s.data) }));
      },
      async getSnapshot(id) {
        const s = await backups.findOne({ _id: id });
        return s ? s.data : null;
      }
    };
  }
  return {
    async load() {
      if (fs.existsSync(DATA_FILE)) {
        let raw;
        try {
          raw = fs.readFileSync(DATA_FILE, 'utf8');
        } catch(e){ raw = null; }
        if (raw) {
          try {
            const d = JSON.parse(raw);
            return { overseer: d.overseer, students: d.students || [], reports: d.reports || [],
                     reviews: d.reviews || [], announcements: d.announcements || [], events: d.events || [], polls: d.polls || [], lostfound: d.lostfound || [], files: d.files || [], settings: d.settings || null };
          } catch(e) {
            // Main file is corrupt — try the newest backup so nothing is lost.
            console.error('data.json corrupt, attempting to restore from latest backup...');
            const b = latestBackup();
            if (b) {
              const d = JSON.parse(fs.readFileSync(b, 'utf8'));
              return { overseer: d.overseer, students: d.students || [], reports: d.reports || [],
                       reviews: d.reviews || [], announcements: d.announcements || [], events: d.events || [], polls: d.polls || [], lostfound: d.lostfound || [], files: d.files || [], settings: d.settings || null };
            }
            throw e;
          }
        }
      }
      return null;
    },
    async save(data) {
      // Atomic write + rotating timestamped backups (never lose data on a crash).
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, DATA_FILE);
      const dir = path.join(path.dirname(DATA_FILE), 'backups');
      try {
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(DATA_FILE, path.join(dir, 'data-' + stamp + '.json'));
        // keep only the latest 10 backups to avoid unbounded growth
        const files = fs.readdirSync(dir).filter(f => /^data-.*\.json$/.test(f)).sort();
        while (files.length > 10) { fs.unlinkSync(path.join(dir, files.shift())); }
      } catch(e) { console.warn('backup rotate warn:', e.message); }
    },
    // Manual/auto snapshot into the same rotating backups folder (kept for API parity with Mongo).
    async snapshot() {
      if (!fs.existsSync(DATA_FILE)) return null;
      const dir = path.join(path.dirname(DATA_FILE), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const id = 'data-' + stamp + '.json';
      fs.copyFileSync(DATA_FILE, path.join(dir, id));
      const files = fs.readdirSync(dir).filter(f => /^data-.*\.json$/.test(f)).sort();
      while (files.length > 14) { fs.unlinkSync(path.join(dir, files.shift())); }
      let counts = {};
      try { counts = countsOf(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch(e){}
      return { id, date: new Date().toISOString(), counts };
    },
    async listSnapshots() {
      const dir = path.join(path.dirname(DATA_FILE), 'backups');
      if (!fs.existsSync(dir)) return [];
      const files = fs.readdirSync(dir).filter(f => /^data-.*\.json$/.test(f)).sort().reverse();
      return files.slice(0, 14).map(f => {
        let counts = {}, date = '';
        try {
          const p = path.join(dir, f);
          counts = countsOf(JSON.parse(fs.readFileSync(p, 'utf8')));
          date = new Date(fs.statSync(p).mtimeMs).toISOString();
        } catch(e){}
        return { id: f, date, counts };
      });
    },
    async getSnapshot(id) {
      if (!/^data-[\w.-]+\.json$/.test(id)) return null; // guard against path traversal
      const p = path.join(path.dirname(DATA_FILE), 'backups', id);
      if (!fs.existsSync(p)) return null;
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e){ return null; }
    }
  };
}

function latestBackup() {
  const dir = path.join(path.dirname(DATA_FILE), 'backups');
  try {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => /^data-.*\.json$/.test(f)).sort();
    return files.length ? path.join(dir, files[files.length-1]) : null;
  } catch(e) { return null; }
}

let db;
let store;

function defaultTheme() {
  return {
    palette: 'green',        // color palette preset
    primary: '#0e7a4d',      // main brand color
    accent: '#c9a227',       // gold accent
    bg: 'gradient',          // 'gradient' (animated) or 'light' (clean white/grey)
    layout: 'modern',        // 'modern' or 'classic' cards
    radius: 14,              // card corner radius in px
    font: 'system'           // 'system' or 'serif' headings
  };
}
// Collo AI — a built-in knowledge assistant that answers students' & visitors'
// questions. The Overseer can add/remove question+answer pairs from Settings.
function defaultChatbot() {
  const O = '{Overseer}';   // replaced client-side with the Overseer's name
  const W = '{WA}';         // replaced client-side with the WhatsApp number
  return {
    name: 'Collo AI',
    enabled: true,
    visibility: 'overseer',   // 'overseer' (default, only Overseer) | 'everyone' | 'off'
    greeting: "Hi comrade! 👋 I'm Collo AI, the friendly assistant of Usambara Male Hostels. Ask me about reporting problems, the Overseer, rooms, signing in, or anything hostel-related.",
    fallback: "I'm not 100% sure about that one, comrade. 🙏 You can ask me about reporting a problem, the Overseer and WhatsApp, rooms & blocks, or signing in. For anything urgent, tap the green WhatsApp button to reach " + W + " directly.",
    faq: [
      { q: "Who is the Overseer and how do I contact him?", a: "The Overseer of Usambara Male Hostels is " + O + ". He is responsible for Blocks 2, 3, 4 and 5, keeps all student records and responds to every problem. You can reach him on WhatsApp at " + W + " — tap the green 💬 button in the corner anytime." },
      { q: "How do I report a problem?", a: "Easy! ① Sign in as a student (reg no + PIN). ② Open 'My Record'. ③ Type your problem, pick the urgency and tap 'Submit Report'. The Overseer is alerted instantly. You can also message him directly on WhatsApp at " + W + "." },
      { q: "How do I report via WhatsApp?", a: "Tap the green WhatsApp button (bottom-right). Choose the type of problem and it will open WhatsApp with a ready message to the Overseer at " + W + "." },
      { q: "How do I sign in / login?", a: "Tap 'Sign In' at the top. Overseer logs in with his password. Students log in with their Reg/Admission No. and the PIN the Overseer gave them. No PIN yet? Contact the Overseer on WhatsApp " + W + "." },
      { q: "Which blocks and rooms are available?", a: "Usambara Male Hostels covers Blocks 2, 3, 4 and 5, offering single, double, quad and hexagon rooms. Ask the Overseer at " + W + " for current availability." },
      { q: "What can you help me with? / help / what can you do", a: "I can help with lots of things! 🤖 Ask me: who the Overseer is, how to report a problem, how to reach WhatsApp " + W + ", which blocks/rooms exist, how to sign in, or about safety & security at the hostel." },
      { q: "Is my record/account secure? Who can change it?", a: "Very secure. 🛡️ Only the Overseer can add, edit or remove student records. You can only ever view your own record and submit reports — no one can change another person's data." },
      { q: "Water or electricity problem?", a: "If your water or electricity has a problem, please report it right away so it's fixed fast. ① Sign in as a student, ② open 'My Record', ③ submit a report describing the issue and its urgency. For emergencies also WhatsApp " + W + "." },
      { q: "How do I leave a review or rating?", a: "Go to the '⭐ Reviews' tab (or the Reviews section on the Home page), pick 1–5 stars and write your comment. Your feedback helps improve the hostel! 🌟" },
      { q: "Thank you / thanks / bye", a: "You're most welcome, comrade! 🙌 I'm here 24/7. If you need anything else, just ask — or reach " + O + " on WhatsApp " + W + "." },
      { q: "Where can I find you / emergency / urgent help", a: "For anything urgent or an emergency, contact the Overseer immediately on WhatsApp " + W + " — tap the green 💬 button in the corner. Please also submit a report in the app so it's on record." }
    ]
  };
}
function normalizeSettings(s) {
  s = s || {};
  if (!s.theme || typeof s.theme !== 'object') s.theme = defaultTheme();
  if (!s.chatbot || typeof s.chatbot !== 'object') {
    s.chatbot = defaultChatbot();
  } else {
    const d = defaultChatbot();
    s.chatbot.name = s.chatbot.name || d.name;
    s.chatbot.greeting = s.chatbot.greeting || d.greeting;
    s.chatbot.fallback = s.chatbot.fallback || d.fallback;
    s.chatbot.faq = Array.isArray(s.chatbot.faq) ? s.chatbot.faq : d.faq;
    if (s.chatbot.enabled !== false) s.chatbot.enabled = true;
    if (['overseer','everyone','off'].indexOf(s.chatbot.visibility) === -1) s.chatbot.visibility = 'overseer';
  }
  if (!Array.isArray(s.infoHub)) s.infoHub = defaultInfoHub();
  if (!s.urgentNotice || typeof s.urgentNotice !== 'object') s.urgentNotice = { enabled: false, text: '' };
  if (!s.emailConfig || typeof s.emailConfig !== 'object') {
    s.emailConfig = defaultEmailConfig();
  } else {
    const d = defaultEmailConfig();
    s.emailConfig.to = (typeof s.emailConfig.to === 'string' && s.emailConfig.to.trim()) ? s.emailConfig.to : d.to;
    s.emailConfig.schedule = (s.emailConfig.schedule === 'weekly') ? 'weekly' : 'daily';
    s.emailConfig.hour = (typeof s.emailConfig.hour === 'number' && s.emailConfig.hour >= 0 && s.emailConfig.hour <= 23) ? s.emailConfig.hour : d.hour;
    s.emailConfig.enabled = !!s.emailConfig.enabled;
    s.emailConfig.lastSentAt = s.emailConfig.lastSentAt || null;
    if (!s.emailConfig.smtp || typeof s.emailConfig.smtp !== 'object') s.emailConfig.smtp = { host: '', port: 587, secure: false, user: '', pass: '' };
  }
  return s;
}
function defaultEmailConfig() {
  return {
    enabled: false,
    to: 'leadex44@gmail.com',
    schedule: 'daily',   // 'daily' | 'weekly'
    hour: 18,            // hour of day (local) to send
    lastSentAt: null,
    smtp: { host: '', port: 587, secure: false, user: '', pass: '' }
  };
}
function defaultSettings() {
  return {
    pageTitle: 'COLLINS UNGUKU USAMBARA HOSTELS',
    tagline: 'Collins Unguku · Student Records & Problem Reporting System · Blocks 2, 3, 4 & 5',
    pagePhoto: 'usambara_08.jpg',
    theme: defaultTheme(),
    chatbot: defaultChatbot(),
    features: [
      { icon: '💧', title: 'Clean Water', text: 'Running water so you never queue with buckets at dawn.' },
      { icon: '💡', title: 'Reliable Power', text: 'Lights that stay on when you need them most.' },
      { icon: '🔒', title: '24/7 Security', text: 'A hostel where you feel safe to sleep.' },
      { icon: '🛏️', title: 'Comfortable Rooms', text: 'Working locks, sturdy beds, clean common areas.' }
    ],
    infoHub: defaultInfoHub(),
    urgentNotice: { enabled: false, text: '' }
  };
}

// Hostel Guide — key day-to-day info every resident needs. Editable by the
// Overseer (Settings). Details support multiple lines.
function defaultInfoHub() {
  return [
    { icon: '🚨', title: 'Emergency & Contacts', text: 'Overseer / WhatsApp: 0769679217\nFor urgent problems, submit an Emergency report or WhatsApp the Overseer directly.' },
    { icon: '📶', title: 'WiFi', text: 'Network: Usambara-WiFi\nPassword: ask the Overseer\nSlow or no connection? Submit a report.' },
    { icon: '🔇', title: 'Quiet Hours', text: '10:00 PM – 6:00 AM\nPlease keep noise low so everyone can rest and study.' },
    { icon: '🧹', title: 'Cleaning', text: 'Common areas are cleaned daily.\nPlease keep your room and surroundings tidy.' },
    { icon: '📜', title: 'House Rules', text: 'Visiting hours: 10:00 AM – 10:00 PM (no visitors outside these hours).\nCooking is allowed only using appropriate utensils, e.g. an electric coil — NOT gas or a stove.\nAlways lock your door and keep your key safe.\nKeep your room and the common areas clean and tidy.' },
    { icon: '🔑', title: 'Check-in / Check-out', text: 'Report to the Overseer on arrival and before departure so your record and key are updated.' }
  ];
}

function seed() {
  // Sample students so the system is usable immediately.
  // PIN for all sample students = 1234  (delete these and add real students).
  const samples = [
    ['Baraka Mwangi', 'SU/2023/0456', '2', '2A', 'Double', '0700 123 456', 'John Mwangi', '0711 234 567'],
    ['Kevin Otieno', 'SU/2023/0231', '2', '2B', 'Quad', '0712 345 678', 'Grace Otieno', '0722 345 678'],
    ['Abdul Rashid', 'SU/2024/0112', '3', '3A', 'Single', '0733 456 789', 'Fatma Rashid', '0744 567 890'],
    ['Emmanuel Kimani', 'SU/2024/0055', '5', '5A', 'Hexagon', '0702 345 678', 'Alice Kimani', '0703 456 789'],
  ];
  samples.forEach(s => {
    const pin = hashPassword('1234');
    db.students.push({ id: uid(), name: s[0], reg: s[1], block: s[2], room: s[3], roomType: s[4],
      phone: s[5], guardian: s[6], guardianPhone: s[7], pin: pin, added: new Date().toISOString() });
  });
  // Sample reviews so the section is usable immediately
  db.reviews = [
    { id: uid(), name: 'Baraka Mwangi', rating: 5, comment: 'Clean rooms and a very supportive overseer. Highly recommended!', date: new Date().toISOString() },
    { id: uid(), name: 'Kevin Otieno', rating: 4, comment: 'Good environment. Water pressure could be better in the mornings.', date: new Date().toISOString() },
    { id: uid(), name: 'Abdul Rashid', rating: 5, comment: 'Quiet and safe. The overseer responds to problems quickly.', date: new Date().toISOString() },
  ];
}

async function loadDb() {
  const uri = dbUri();
  if (uri) {
    // Try the permanent database first. If it fails, DON'T crash — fall back
    // to local storage so the site keeps working and the overseer can fix it.
    try {
      store = await makeStore(uri);
      db = await store.load();
      if (!db || !db.overseer) {
        // Nothing in Mongo yet — import any local data so nothing is lost.
        const localStore = await makeStore('');
        const localDb = await localStore.load();
        if (localDb && localDb.overseer) {
          db = localDb;
          await store.save(db);
        }
      }
      console.log('Connected to MongoDB Atlas (permanent database).');
    } catch(e) {
      console.error('⚠️ MongoDB connection FAILED: ' + e.message);
      console.error('Falling back to LOCAL storage so the site stays up. Fix the connection string to use the permanent database.');
      store = await makeStore('');
      db = await store.load();
    }
  } else {
    store = await makeStore('');
    db = await store.load();
  }
  if (!db || !db.overseer) {
    db = { overseer: hashPassword(DEFAULT_OVERSEER_PASSWORD), students: [], reports: [], reviews: [], announcements: [], events: [], polls: [], lostfound: [], files: [], settings: defaultSettings() };
    seed();
    await saveDb();
  } else {
    db.students = db.students || [];
    db.reports = db.reports || [];
    db.reviews = db.reviews || [];
    db.announcements = db.announcements || [];
    db.events = db.events || [];
    db.polls = db.polls || [];
    db.lostfound = db.lostfound || [];
    db.files = db.files || [];
    db.settings = normalizeSettings(Object.assign(defaultSettings(), db.settings || {}));
  }
}
async function saveDb() {
  await store.save(db);
}
// Re-connect to the current configured store, carrying over the in-memory data.
async function reconnectStore() {
  const uri = dbUri();
  const newStore = await makeStore(uri);
  await newStore.save(db);            // push current data into the new store
  const fresh = await newStore.load(); // reload to be safe
  if (fresh) { db = fresh; }
  store = newStore;
  db.students = db.students || [];
  db.reports = db.reports || [];
  db.reviews = db.reviews || [];
  db.announcements = db.announcements || [];
  db.events = db.events || [];
  db.polls = db.polls || [];
  db.lostfound = db.lostfound || [];
  db.files = db.files || [];
  db.settings = normalizeSettings(Object.assign(defaultSettings(), db.settings || {}));
}

/* ---------------- Sessions (in-memory tokens) ---------------- */
const sessions = new Map(); // token -> { role, studentId, exp }
function newToken(role, studentId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { role, studentId, exp: Date.now() + (1000 * 60 * 60 * 12) });
  return token;
}
function cleanup() {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  // also clear expired login-attempt records so memory stays bounded
  for (const [k, v] of loginAttempts) {
    if ((v.lockedUntil && v.lockedUntil < now) || (now - v.firstFail > LOGIN_WINDOW_MS)) loginAttempts.delete(k);
  }
}

/* ---------------- Login rate-limiting (blocks PIN/password guessing) ---------------- */
const loginAttempts = new Map(); // ip -> { firstFail, fails, lockedUntil }
const LOGIN_MAX_FAILS = 8;                 // failed tries before a temporary lock
const LOGIN_WINDOW_MS = 10 * 60 * 1000;    // counting window (10 min)
const LOGIN_LOCK_MS = 10 * 60 * 1000;      // lock duration (10 min)
function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || 'unknown';
}
function loginGuard(req, res, next) {
  const rec = loginAttempts.get(clientIp(req));
  const now = Date.now();
  if (rec && rec.lockedUntil && rec.lockedUntil > now) {
    const mins = Math.ceil((rec.lockedUntil - now) / 60000);
    return res.status(429).json({ error: 'Too many failed sign-in attempts. Please try again in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.' });
  }
  next();
}
function noteLoginFail(req) {
  const key = clientIp(req), now = Date.now();
  let rec = loginAttempts.get(key);
  if (!rec || (now - rec.firstFail) > LOGIN_WINDOW_MS) rec = { firstFail: now, fails: 0 };
  rec.fails++;
  if (rec.fails >= LOGIN_MAX_FAILS) rec.lockedUntil = now + LOGIN_LOCK_MS;
  loginAttempts.set(key, rec);
}
function noteLoginSuccess(req) { loginAttempts.delete(clientIp(req)); }
function uid() { return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
// Small summary of a data blob, used for backup listings (no personal data, just counts).
function countsOf(d) {
  d = d || {};
  const n = (x) => Array.isArray(x) ? x.length : 0;
  return { students: n(d.students), reports: n(d.reports), reviews: n(d.reviews),
           announcements: n(d.announcements), events: n(d.events), polls: n(d.polls), files: n(d.files) };
}

/* ---------------- Helpers ---------------- */
function publicStudent(s) {
  return { id: s.id, name: s.name, reg: s.reg, block: s.block, room: s.room, roomType: s.roomType || '',
    phone: s.phone, guardian: s.guardian, guardianPhone: s.guardianPhone, added: s.added };
}

/* ---------------- Data size + alert ---------------- */
function dataStats() {
  const students = db.students ? db.students.length : 0;
  const reports  = db.reports  ? db.reports.length  : 0;
  const reviews  = db.reviews  ? db.reviews.length  : 0;
  const total = students + reports + reviews;
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(db), 'utf8'); } catch(e){}
  return { students, reports, reviews, total, bytes };
}
function alertThreshold() {
  return (db.settings && Number(db.settings.alertThreshold)) || DATA_ALERT_RECORDS;
}
// Called on an interval and after growth. If data is large it alerts the
// overseer once via WhatsApp AND flags it so the app shows a warning banner.
async function checkDataLoad() {
  if (!db) return;
  const s = dataStats();
  const threshold = alertThreshold();
  if (s.total >= threshold) {
    if (!(db.settings && db.settings.dataAlerted)) {
      if (!db.settings) db.settings = defaultSettings();
      db.settings.dataAlerted = true;
      await saveDb();
      const mb = (s.bytes / (1024 * 1024)).toFixed(2);
      await sendWhatsAppText(
        '⚠️ USAMBARA DATA ALERT\n'
        + 'Your data is getting large: ' + s.total + ' total records\n'
        + '(Students ' + s.students + ', Reports ' + s.reports + ', Reviews ' + s.reviews + ')\n'
        + 'Approx. size: ' + mb + ' MB.\n\n'
        + 'Log in to the app and compress or delete unneeded data to keep it fast.'
      );
      console.log('DATA ALERT: total=' + s.total + ' threshold=' + threshold);
    }
  } else if (db.settings && db.settings.dataAlerted) {
    db.settings.dataAlerted = false;
    await saveDb();
  }
}

/* ---------------- App ---------------- */
const app = express();
app.disable('x-powered-by'); // don't advertise the framework
app.use(express.json({ limit: '15mb' })); // large limit so the Overseer can upload files as base64
/* ---- Security headers (defence in depth) ---- */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY'); // clickjacking protection
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (req.headers['x-forwarded-proto'] === 'https' || req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
/* ---- Global API throttle: max 240 requests/minute per IP (abuse / DoS mitigation) ---- */
const apiHits = new Map();
setInterval(() => { const cut = Date.now() - 120000; for (const [k, v] of apiHits) if (v.t < cut) apiHits.delete(k); }, 60000);
app.use('/api', (req, res, next) => {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  const now = Date.now();
  let e = apiHits.get(ip);
  if (!e || now - e.t > 60000) { e = { t: now, n: 0 }; apiHits.set(ip, e); }
  e.n++;
  if (e.n > 240) return res.status(429).json({ error: 'Too many requests — please slow down.' });
  next();
});
// request logging so we can see traffic from the browser
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(req.method, req.url, res.statusCode, Date.now() - start + 'ms');
  });
  next();
});
// CORS — allow the app to be used cross-origin (deployed behind a proxy/preview)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Serve ONLY public image assets from the repo root. Config files (db-config.json,
// data.json), source code and backups must NEVER be reachable over HTTP.
const PUBLIC_ASSET_RE = /\.(jpe?g|png|webp|gif|svg|ico)$/i;
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && PUBLIC_ASSET_RE.test(req.path)) {
    return express.static(path.join(__dirname), {
      setHeaders: (r) => { r.setHeader('Cache-Control', 'public, max-age=86400'); }
    })(req, res, next);
  }
  next();
});
// NOTE: Overseer-uploaded files (announcements/attachments) are stored in the
// database (db.files) and served via GET /api/file/:id so they persist
// permanently across restarts and redeploys.

// Auth middleware
function auth(req, res, next) {
  cleanup();
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/i, '');
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  req.session = s;
  next();
}
function overseerOnly(req, res, next) {
  if (req.session.role !== 'overseer') return res.status(403).json({ error: 'Overseer only' });
  next();
}
function studentOnly(req, res, next) {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'Student only' });
  next();
}

/* ---------------- Auth endpoints ---------------- */
app.get('/api/me', auth, (req, res) => {
  if (req.session.role === 'overseer') {
    res.json({ role: 'overseer' });
  } else {
    const st = db.students.find(x => x.id === req.session.studentId);
    if (!st) return res.status(404).json({ error: 'Student record not found' });
    res.json({ role: 'student', student: publicStudent(st) });
  }
});

// Sign out the current session.
app.post('/api/logout', auth, (req, res) => {
  const h = req.headers['authorization'] || '';
  sessions.delete(h.replace(/^Bearer\s+/i, ''));
  res.json({ ok: true });
});

// Overseer: revoke EVERY other active session (force re-login on all other devices).
app.post('/api/admin/sessions/revoke', auth, overseerOnly, (req, res) => {
  const h = req.headers['authorization'] || '';
  const mine = h.replace(/^Bearer\s+/i, '');
  let n = 0;
  for (const k of Array.from(sessions.keys())) { if (k !== mine) { sessions.delete(k); n++; } }
  res.json({ ok: true, revoked: n });
});

app.post('/api/login/overseer', loginGuard, (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (verifyPassword(password, db.overseer.salt, db.overseer.hash)) {
    noteLoginSuccess(req);
    res.json({ token: newToken('overseer'), role: 'overseer' });
  } else {
    noteLoginFail(req);
    res.status(401).json({ error: 'Incorrect overseer password' });
  }
});

app.post('/api/login/student', loginGuard, (req, res) => {
  const { reg, pin } = req.body || {};
  if (!reg || !pin) return res.status(400).json({ error: 'Reg no and PIN required' });
  const st = db.students.find(x => x.reg.toLowerCase() === String(reg).trim().toLowerCase());
  if (!st || !verifyPassword(String(pin), st.pin.salt, st.pin.hash)) {
    noteLoginFail(req);
    return res.status(401).json({ error: 'Reg no or PIN incorrect' });
  }
  noteLoginSuccess(req);
  res.json({ token: newToken('student', st.id), role: 'student', student: publicStudent(st) });
});

/* ---------------- Overseer: student records ---------------- */
app.get('/api/students', auth, overseerOnly, (req, res) => {
  res.json({ students: db.students.map(publicStudent) });
});

app.post('/api/students', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.reg || !b.block || !b.room) return res.status(400).json({ error: 'Name, reg, block and room required' });
  if (!b.pin) return res.status(400).json({ error: 'Set a PIN for the student (4+ digits)' });
  if (db.students.some(x => x.reg.toLowerCase() === String(b.reg).trim().toLowerCase())) {
    return res.status(409).json({ error: 'A student with this reg no already exists' });
  }
  const rec = { id: uid(), name: b.name, reg: b.reg.trim(), block: b.block, room: b.room,
    roomType: b.roomType || '', phone: b.phone || '', guardian: b.guardian || '', guardianPhone: b.guardianPhone || '',
    pin: hashPassword(b.pin), added: new Date().toISOString() };
  db.students.push(rec);
  await saveDb();
  res.json({ student: publicStudent(rec) });
});

app.put('/api/students/:id', auth, overseerOnly, async (req, res) => {
  const st = db.students.find(x => x.id === req.params.id);
  if (!st) return res.status(404).json({ error: 'Student not found' });
  const b = req.body || {};
  if (b.name !== undefined) st.name = b.name;
  if (b.reg !== undefined) {
    const newReg = String(b.reg).trim();
    if (newReg && db.students.some(x => x.id !== st.id && x.reg.toLowerCase() === newReg.toLowerCase())) {
      return res.status(409).json({ error: 'A student with this reg no already exists' });
    }
    if (newReg) st.reg = newReg;
  }
  if (b.block !== undefined) st.block = b.block;
  if (b.room !== undefined) st.room = b.room;
  if (b.roomType !== undefined) st.roomType = b.roomType;
  if (b.phone !== undefined) st.phone = b.phone;
  if (b.guardian !== undefined) st.guardian = b.guardian;
  if (b.guardianPhone !== undefined) st.guardianPhone = b.guardianPhone;
  if (b.pin) st.pin = hashPassword(b.pin); // reset PIN
  await saveDb();
  res.json({ student: publicStudent(st) });
});

app.delete('/api/students/:id', auth, overseerOnly, async (req, res) => {
  const before = db.students.length;
  db.students = db.students.filter(x => x.id !== req.params.id);
  if (db.students.length === before) return res.status(404).json({ error: 'Student not found' });
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Overseer: reports ---------------- */
app.get('/api/reports', auth, overseerOnly, (req, res) => {
  res.json({ reports: db.reports });
});

// Aggregate analytics over existing reports so the Overseer can spot patterns.
app.get('/api/reports/insights', auth, overseerOnly, (req, res) => {
  const reports = db.reports || [];
  const byStatus = { received: 0, in_progress: 0, resolved: 0 };
  const byBlock = {}, byUrgency = {};
  let resMs = 0, resCount = 0, recent = 0;
  const weekAgo = Date.now() - 7 * 86400000;
  reports.forEach(r => {
    const st = normalizeStatus(r.status);
    if (byStatus[st] !== undefined) byStatus[st]++;
    const blk = String(r.block || '?'); byBlock[blk] = (byBlock[blk] || 0) + 1;
    const urg = String(r.urg || 'Normal'); byUrgency[urg] = (byUrgency[urg] || 0) + 1;
    if (r.date && new Date(r.date).getTime() >= weekAgo) recent++;
    if (Array.isArray(r.statusHistory) && r.statusHistory.length) {
      const firstAt = r.statusHistory[0].date ? new Date(r.statusHistory[0].date).getTime() : null;
      const resolvedEntries = r.statusHistory.filter(h => normalizeStatus(h.status) === 'resolved' && h.date);
      const lastResolved = resolvedEntries.length ? resolvedEntries[resolvedEntries.length - 1] : null;
      if (firstAt && lastResolved) {
        const rt = new Date(lastResolved.date).getTime() - firstAt;
        if (rt >= 0) { resMs += rt; resCount++; }
      }
    }
  });
  const avgResolutionHours = resCount ? Math.round((resMs / resCount) / 3600000 * 10) / 10 : null;
  res.json({
    total: reports.length,
    open: byStatus.received + byStatus.in_progress,
    byStatus, byBlock, byUrgency,
    recent7days: recent,
    avgResolutionHours,
    resolvedCount: resCount
  });
});

// Report stages: received -> in_progress -> resolved. Legacy 'open'/'done' map in.
function normalizeStatus(s) {
  if (s === 'open' || s === 'received') return 'received';
  if (s === 'in_progress' || s === 'progress') return 'in_progress';
  if (s === 'done' || s === 'resolved') return 'resolved';
  return 'received';
}
app.put('/api/reports/:id', auth, overseerOnly, async (req, res) => {
  const r = db.reports.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Report not found' });
  const b = req.body || {};
  if (b.status !== undefined) {
    const ns = normalizeStatus(b.status);
    if (!Array.isArray(r.statusHistory)) {
      r.statusHistory = [{ status: normalizeStatus(r.status), date: r.date || new Date().toISOString() }];
    }
    if (ns !== normalizeStatus(r.status)) {
      r.status = ns;
      r.statusHistory.push({ status: ns, date: new Date().toISOString() });
    } else {
      r.status = ns; // normalize legacy value in place
    }
  }
  if (b.reply !== undefined) {
    const text = String(b.reply).trim();
    if (text) {
      if (!Array.isArray(r.replies)) r.replies = [];
      r.replies.push({ text: text, by: 'overseer', date: new Date().toISOString() });
    }
  }
  await saveDb();
  res.json({ report: r });
});

app.delete('/api/reports/:id', auth, overseerOnly, async (req, res) => {
  const before = db.reports.length;
  db.reports = db.reports.filter(x => x.id !== req.params.id);
  if (db.reports.length === before) return res.status(404).json({ error: 'Report not found' });
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Overseer: change password ---------------- */
app.put('/api/overseer/password', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.current || !b.next) return res.status(400).json({ error: 'Current and new password required' });
  if (!verifyPassword(b.current, db.overseer.salt, db.overseer.hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (String(b.next).length < 6) return res.status(400).json({ error: 'New password must be 6+ characters' });
  db.overseer = hashPassword(b.next);
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Public stats (ONLY a count — never any private details) ---------------- */
app.get('/api/stats/public', (req, res) => {
  res.json({ residents: (db.students || []).length });
});

/* ---------------- Announcements / Group updates from the Overseer ---------------- */
// Files are stored IN THE DATABASE (db.files) so they survive restarts and
// redeploys permanently — just like the rest of the data. Each file is capped
// at 4 MB (base64) to keep the database document healthy.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
function makeFileRecord(name, dataUrl, type) {
  let b64 = dataUrl, mime = type || '';
  const m = /^data:([^;]+);base64,([\s\S]*)$/i.exec(dataUrl || '');
  if (m) { mime = mime || m[1]; b64 = m[2]; }
  b64 = String(b64).replace(/\s+/g, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('empty file');
  if (buf.length > MAX_FILE_BYTES) throw new Error('file too large (max 4 MB)');
  return {
    id: uid(),
    name: String(name || 'file').slice(0, 120),
    type: mime || 'application/octet-stream',
    size: buf.length,
    data: b64,
    date: new Date().toISOString()
  };
}
function publicFile(f) { return { id: f.id, url: '/api/file/' + f.id, name: f.name, type: f.type, size: f.size }; }

// Public: serve an uploaded file from the database.
app.get('/api/file/:id', (req, res) => {
  db.files = db.files || [];
  const f = db.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: 'File not found' });
  const buf = Buffer.from(f.data, 'base64');
  res.setHeader('Content-Type', f.type || 'application/octet-stream');
  res.setHeader('Content-Length', buf.length);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  const inline = /^(image\/|application\/pdf|text\/)/i.test(f.type || '');
  const safeName = String(f.name || 'file').replace(/["\\\r\n]/g, '');
  res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + '; filename="' + safeName + '"');
  res.end(buf);
});

/* ---------------- Automated email reports (Overseer) ---------------- */
function emailCfg() { return normalizeSettings(db.settings || defaultSettings()).emailConfig; }
function mailTransport(c) {
  return nodemailer.createTransport({
    host: c.smtp.host, port: c.smtp.port || 587, secure: !!c.smtp.secure,
    auth: { user: c.smtp.user, pass: c.smtp.pass },
    tls: { minVersion: 'TLSv1.2' }
  });
}
function escHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function buildReportHtml() {
  const students = db.students || [], reports = db.reports || [], anns = db.announcements || [];
  const polls = db.polls || [], events = db.events || [], lf = db.lostfound || [];
  const byStatus = { received: 0, in_progress: 0, resolved: 0 };
  reports.forEach(r => { const st = r.status || 'received'; if (byStatus[st] !== undefined) byStatus[st]++; });
  const weekAgo = Date.now() - 7 * 86400000;
  const newReports = reports.filter(r => new Date(r.date || 0).getTime() >= weekAgo).length;
  const blocks = {};
  students.forEach(s => { blocks[s.block] = (blocks[s.block] || 0) + 1; });
  const important = anns.filter(a => a.important);
  const pendingAcks = important.filter(a => (a.acks || []).length < students.length);
  const openPolls = polls.filter(p => !p.closed);
  const upcoming = events.slice().sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 3);
  const lostOpen = lf.filter(x => x.status !== 'returned').length;
  const row = (k, v) => '<tr><td style="padding:6px 10px;color:#5b6b62;">' + k + '</td><td style="padding:6px 10px;font-weight:700;color:#123f2e;">' + v + '</td></tr>';
  return '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:0 auto;background:#f6faf8;border-radius:14px;overflow:hidden;">'
    + '<div style="background:linear-gradient(120deg,#1b5e42,#0e3a29);padding:22px 26px;color:#fff;">'
    + '<div style="font-size:20px;font-weight:800;">Usambara Male Hostels — System Report</div>'
    + '<div style="opacity:.85;font-size:13px;margin-top:4px;">' + new Date().toLocaleString() + ' · automatic update from your overseer panel</div></div>'
    + '<div style="padding:22px 26px;">'
    + '<table style="border-collapse:collapse;width:100%;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2ece6;">'
    + row('Residents', students.length)
    + row('Blocks', Object.keys(blocks).sort().map(b => 'B' + b + ': ' + blocks[b]).join(' · ') || '—')
    + row('Reports (total)', reports.length)
    + row('Reports received / in progress', byStatus.received + ' / ' + byStatus.in_progress)
    + row('Reports resolved', byStatus.resolved)
    + row('New reports (7 days)', newReports)
    + row('Important notices awaiting acks', pendingAcks.length + (pendingAcks.length ? ' (' + pendingAcks.slice(0, 3).map(a => escHtml(a.title || 'Update')).join(', ') + ')' : ''))
    + row('Open polls', openPolls.length)
    + row('Lost & found unclaimed', lostOpen)
    + '</table>'
    + (upcoming.length ? '<div style="margin-top:16px;font-weight:700;color:#123f2e;">Upcoming events</div><ul style="margin:6px 0 0;padding-left:20px;color:#33463c;font-size:14px;">' + upcoming.map(e => '<li>' + escHtml(e.title) + ' — ' + escHtml(e.date) + (e.time ? ' ' + escHtml(e.time) : '') + '</li>').join('') + '</ul>' : '')
    + '<div style="margin-top:18px;font-size:12px;color:#7b8a80;">Sent automatically by the Usambara Hostels system to keep you informed. Manage this in your Overseer panel → 📧 Email Reports.</div>'
    + '</div></div>';
}
async function sendEmailReport(c, isTest) {
  if (!nodemailer) throw new Error('Email module not installed on the server.');
  const t = mailTransport(c);
  const subject = isTest ? '✅ Test email — Usambara Hostels system' : ('Usambara Hostels report — ' + new Date().toLocaleDateString());
  const html = isTest
    ? '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;background:#f6faf8;border:1px solid #e2ece6;border-radius:14px;padding:26px;">'
      + '<div style="font-size:20px;font-weight:800;color:#123f2e;">Hello Overseer 👋</div>'
      + '<p style="color:#33463c;">Your automated email reports are configured correctly. From now on you will receive system updates here on your chosen schedule.</p>'
      + '<div style="font-size:12px;color:#7b8a80;margin-top:14px;">Usambara Male Hostels · ' + new Date().toLocaleString() + '</div></div>'
    : buildReportHtml();
  await t.sendMail({ from: '"Usambara Hostels System" <' + c.smtp.user + '>', to: c.to, subject: subject, html: html });
}
async function maybeSendScheduledEmail() {
  const c = emailCfg();
  if (!c.enabled || !nodemailer) return;
  if (!c.smtp.host || !c.smtp.user || !c.smtp.pass) return;
  const now = new Date();
  if (now.getHours() < c.hour) return;                 // wait until the chosen hour
  const last = c.lastSentAt ? new Date(c.lastSentAt) : null;
  if (c.schedule === 'daily') {
    if (last && last.toDateString() === now.toDateString()) return; // already sent today
  } else {
    if (last && (now - last) < 7 * 86400000 - 3600000) return;      // weekly
  }
  try {
    await sendEmailReport(c, false);
    c.lastSentAt = now.toISOString();
    db.settings = normalizeSettings(db.settings);
    await saveDb();
    console.log('Automated email report sent to ' + c.to);
  } catch (e) { console.warn('scheduled email failed:', e.message); }
}
app.get('/api/admin/email', auth, overseerOnly, (req, res) => {
  const c = emailCfg();
  res.json({ email: Object.assign({}, c, { smtp: Object.assign({}, c.smtp, { pass: c.smtp.pass ? '••••••••' : '', configured: !!(c.smtp.host && c.smtp.user) }) }) });
});
app.put('/api/admin/email', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  const s = normalizeSettings(db.settings || defaultSettings());
  const c = s.emailConfig;
  if (typeof b.to === 'string' && b.to.trim()) c.to = b.to.trim().slice(0, 120);
  if (b.schedule === 'daily' || b.schedule === 'weekly') c.schedule = b.schedule;
  if (typeof b.hour === 'number' && b.hour >= 0 && b.hour <= 23) c.hour = Math.round(b.hour);
  c.enabled = !!b.enabled;
  const sm = b.smtp || {};
  if (typeof sm.host === 'string') c.smtp.host = sm.host.trim().slice(0, 120);
  if (typeof sm.port === 'number' && sm.port > 0 && sm.port < 65536) c.smtp.port = Math.round(sm.port);
  if (typeof sm.secure === 'boolean') c.smtp.secure = sm.secure;
  if (typeof sm.user === 'string') c.smtp.user = sm.user.trim().slice(0, 120);
  if (typeof sm.pass === 'string' && sm.pass.trim() && sm.pass.trim() !== '••••••••') c.smtp.pass = sm.pass.trim().slice(0, 200);
  db.settings = s;
  await saveDb();
  res.json({ ok: true, email: Object.assign({}, c, { smtp: Object.assign({}, c.smtp, { pass: c.smtp.pass ? '••••••••' : '', configured: !!(c.smtp.host && c.smtp.user) }) }) });
});
app.post('/api/admin/email/test', auth, overseerOnly, async (req, res) => {
  const c = emailCfg();
  if (!nodemailer) return res.status(500).json({ error: 'Email module not installed on the server.' });
  if (!c.smtp.host || !c.smtp.user || !c.smtp.pass) return res.status(400).json({ error: 'Add your SMTP server, email address and app password first.' });
  try {
    await sendEmailReport(c, true);
    res.json({ ok: true, sentTo: c.to });
  } catch (e) { res.status(500).json({ error: 'Send failed: ' + String(e.message || e).slice(0, 180) }); }
});
// Overseer: live security posture for the Security Centre panel.
app.get('/api/admin/security', auth, overseerOnly, (req, res) => {
  res.json({
    security: {
      passwordHashing: 'scrypt (64-byte) + timing-safe compare',
      securityHeaders: true,
      apiRateLimit: '240 req/min per IP',
      loginLockout: '8 failed attempts → 10 min lock',
      staticFileGuard: true,
      filesStoredInDb: true,
      studentPrivacy: 'own record only; counts only for receipts/acks',
      sessionsActive: sessions.size,
      storage: currentMode === 'mongodb' ? 'MongoDB Atlas (encrypted at rest)' : 'local file',
      tls: 'Enforced on Render (HTTPS + HSTS header)',
      backups: typeof store.snapshot === 'function' ? 'automatic every 6 h (newest 14)' : 'automatic (local folder)'
    }
  });
});

app.get('/api/announcements', (req, res) => {
  // Optional auth: a signed-in student gets their own acknowledge status (youAck).
  // We never expose the raw ack/view ID lists — only counts (student privacy).
  const h = req.headers['authorization'] || '';
  const s = sessions.get(h.replace(/^Bearer\s+/i, ''));
  const sid = (s && s.role === 'student') ? s.studentId : null;
  const list = (db.announcements || []).slice().sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (!!a.important !== !!b.important) return a.important ? -1 : 1;
    return new Date(b.date) - new Date(a.date);
  });
  const residents = (db.students || []).length;
  // Expose a view COUNT per update (never the raw viewer IDs).
  const out = list.map(a => ({
    id: a.id, title: a.title, body: a.body, file: a.file || null,
    files: Array.isArray(a.files) ? a.files : (a.file ? [a.file] : []),
    pinned: !!a.pinned, important: !!a.important, date: a.date, edited: a.edited || null,
    viewCount: (a.views || []).length, ackCount: (a.acks || []).length,
    youAck: sid ? (a.acks || []).indexOf(sid) !== -1 : false
  }));
  res.json({ announcements: out, residents });
});

// A signed-in student marks all current updates as seen (powers read receipts).
app.post('/api/announcements/view-all', auth, studentOnly, async (req, res) => {
  const sid = req.session.studentId;
  let changed = false;
  (db.announcements || []).forEach(a => {
    a.views = a.views || [];
    if (a.views.indexOf(sid) === -1) { a.views.push(sid); changed = true; }
  });
  if (changed) await saveDb();
  res.json({ ok: true });
});

// A signed-in student acknowledges an IMPORTANT notice (one tap, idempotent).
app.post('/api/announcements/:id/acknowledge', auth, studentOnly, async (req, res) => {
  const a = (db.announcements || []).find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Update not found' });
  const sid = req.session.studentId;
  a.acks = a.acks || [];
  if (a.acks.indexOf(sid) === -1) { a.acks.push(sid); await saveDb(); }
  res.json({ ok: true, ackCount: a.acks.length, youAck: true });
});

app.post('/api/announcements', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const body = String(b.body || '').trim();
  // Accept a `files` array (new) or a single legacy `file`.
  let incoming = [];
  if (Array.isArray(b.files)) incoming = b.files.filter(x => x && x.dataUrl);
  else if (b.file && b.file.dataUrl) incoming = [b.file];
  if (!title && !body && !incoming.length) return res.status(400).json({ error: 'Write an update or attach a file first.' });
  if (incoming.length > 6) return res.status(400).json({ error: 'You can attach up to 6 files per update.' });
  const files = [];
  try {
    for (const f of incoming) {
      const frec = makeFileRecord(f.name, f.dataUrl, f.type);
      db.files = db.files || [];
      db.files.push(frec);
      files.push(publicFile(frec));
    }
  } catch (e) { return res.status(400).json({ error: 'File upload failed: ' + e.message }); }
  const rec = { id: uid(), title, body, files, file: files[0] || null, pinned: !!b.pinned, important: !!b.important, acks: [], date: new Date().toISOString() };
  db.announcements = db.announcements || [];
  db.announcements.unshift(rec);
  await saveDb();
  res.json({ announcement: rec });
});

// Edit an existing update (overseer). Text/pin always editable; attachments are
// replaced only when a `files` array is sent (omitted = keep current attachments).
app.put('/api/announcements/:id', auth, overseerOnly, async (req, res) => {
  const a = (db.announcements || []).find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'Update not found' });
  const b = req.body || {};
  if (typeof b.title === 'string') a.title = b.title.trim().slice(0, 200);
  if (typeof b.body === 'string') a.body = b.body.trim().slice(0, 4000);
  if (b.pinned !== undefined) a.pinned = !!b.pinned;
  if (b.important !== undefined) a.important = !!b.important;
  if (Array.isArray(b.files)) {
    const incoming = b.files.filter(x => x && x.dataUrl);
    if (incoming.length > 6) return res.status(400).json({ error: 'You can attach up to 6 files per update.' });
    const newFiles = [];
    try {
      for (const f of incoming) {
        const frec = makeFileRecord(f.name, f.dataUrl, f.type);
        db.files = db.files || [];
        db.files.push(frec);
        newFiles.push(publicFile(frec));
      }
    } catch (e) { return res.status(400).json({ error: 'File upload failed: ' + e.message }); }
    // remove the old attachments (now replaced) so no orphans are left behind
    const oldIds = [];
    if (Array.isArray(a.files)) a.files.forEach(f => { if (f && f.id) oldIds.push(f.id); });
    if (a.file && a.file.id) oldIds.push(a.file.id);
    if (oldIds.length) db.files = (db.files || []).filter(f => oldIds.indexOf(f.id) === -1);
    a.files = newFiles;
    a.file = newFiles[0] || null;
  }
  a.edited = new Date().toISOString();
  await saveDb();
  res.json({ announcement: a });
});

app.delete('/api/announcements/:id', auth, overseerOnly, async (req, res) => {
  db.announcements = db.announcements || [];
  const target = db.announcements.find(x => x.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Update not found' });
  db.announcements = db.announcements.filter(x => x.id !== req.params.id);
  // also remove every attached file so no orphan data is left behind
  const ids = [];
  if (Array.isArray(target.files)) target.files.forEach(f => { if (f && f.id) ids.push(f.id); });
  if (target.file && target.file.id) ids.push(target.file.id);
  if (ids.length) db.files = (db.files || []).filter(f => ids.indexOf(f.id) === -1);
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Events & important dates (calendar) ---------------- */
app.get('/api/events', (req, res) => {
  const list = (db.events || []).slice().sort((a, b) => {
    const da = (a.date || '') + 'T' + (a.time || '00:00');
    const dbb = (b.date || '') + 'T' + (b.time || '00:00');
    return da < dbb ? -1 : da > dbb ? 1 : 0;
  });
  res.json({ events: list });
});

app.post('/api/events', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  const date = String(b.date || '').trim();   // YYYY-MM-DD
  if (!title) return res.status(400).json({ error: 'Give the event a title.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Pick a valid date.' });
  const rec = {
    id: uid(), title, date,
    time: String(b.time || '').trim().slice(0, 8),
    body: String(b.body || '').trim().slice(0, 600),
    created: new Date().toISOString()
  };
  db.events = db.events || [];
  db.events.push(rec);
  await saveDb();
  res.json({ event: rec });
});

app.delete('/api/events/:id', auth, overseerOnly, async (req, res) => {
  db.events = db.events || [];
  const before = db.events.length;
  db.events = db.events.filter(x => x.id !== req.params.id);
  if (db.events.length === before) return res.status(404).json({ error: 'Event not found' });
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Polls / quick votes (public read; students vote once; overseer manages) ---------------- */
// Optional auth: return the studentId if a valid student token is present, else null (never throws).
function peekStudentId(req) {
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/i, '').trim();
  const s = sessions.get(token);
  if (s && s.role === 'student' && s.exp > Date.now()) return s.studentId;
  return null;
}
// Shape a poll for the client: counts only (no voter IDs), plus votedOption when the caller is that student.
function shapePoll(p, studentId) {
  const opts = Array.isArray(p.options) ? p.options : [];
  const counts = opts.map(o => (Array.isArray(o.votes) ? o.votes.length : 0));
  let votedOption = -1;
  if (studentId) opts.forEach((o, i) => { if (Array.isArray(o.votes) && o.votes.indexOf(studentId) !== -1) votedOption = i; });
  return { id: p.id, question: p.question, options: opts.map(o => o.text), counts,
           total: counts.reduce((a, b) => a + b, 0), closed: !!p.closed, date: p.date, votedOption };
}
app.get('/api/polls', (req, res) => {
  const sid = peekStudentId(req);
  const list = (db.polls || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json({ polls: list.map(p => shapePoll(p, sid)) });
});
app.post('/api/polls', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  const question = String(b.question || '').trim().slice(0, 160);
  const options = (Array.isArray(b.options) ? b.options : [])
    .map(o => String(o || '').trim().slice(0, 80)).filter(Boolean).slice(0, 6);
  if (!question) return res.status(400).json({ error: 'Write a question for the poll.' });
  if (options.length < 2) return res.status(400).json({ error: 'Add at least two answer options.' });
  db.polls = db.polls || [];
  const rec = { id: uid(), question, options: options.map(text => ({ text, votes: [] })), closed: false, date: new Date().toISOString() };
  db.polls.unshift(rec);
  await saveDb();
  res.json({ poll: shapePoll(rec, null) });
});
app.post('/api/polls/:id/vote', auth, studentOnly, async (req, res) => {
  const p = (db.polls || []).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Poll not found' });
  if (p.closed) return res.status(400).json({ error: 'This poll is closed.' });
  const idx = parseInt((req.body || {}).option, 10);
  const opts = Array.isArray(p.options) ? p.options : [];
  if (isNaN(idx) || !opts[idx]) return res.status(400).json({ error: 'Choose a valid option.' });
  const sid = req.session.studentId;
  const already = opts.some(o => Array.isArray(o.votes) && o.votes.indexOf(sid) !== -1);
  if (already) return res.status(400).json({ error: 'You have already voted in this poll.' });
  opts[idx].votes = opts[idx].votes || [];
  opts[idx].votes.push(sid);
  await saveDb();
  res.json({ ok: true, poll: shapePoll(p, sid) });
});
app.put('/api/polls/:id', auth, overseerOnly, async (req, res) => {
  const p = (db.polls || []).find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Poll not found' });
  if ((req.body || {}).closed !== undefined) p.closed = !!req.body.closed;
  await saveDb();
  res.json({ ok: true, poll: shapePoll(p, null) });
});
app.delete('/api/polls/:id', auth, overseerOnly, async (req, res) => {
  db.polls = db.polls || [];
  const before = db.polls.length;
  db.polls = db.polls.filter(x => x.id !== req.params.id);
  if (db.polls.length === before) return res.status(404).json({ error: 'Poll not found' });
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Lost & Found (public read; overseer manages) ---------------- */
app.get('/api/lostfound', (req, res) => {
  const list = (db.lostfound || []).slice().sort((a, b) => {
    // available (listed) items first, then newest first within each group
    const sa = a.status === 'returned' ? 1 : 0, sb = b.status === 'returned' ? 1 : 0;
    if (sa !== sb) return sa - sb;
    return new Date(b.date) - new Date(a.date);
  });
  res.json({ items: list });
});
app.post('/api/lostfound', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: 'Give the item a short title (e.g. "Black wallet").' });
  db.lostfound = db.lostfound || [];
  const rec = {
    id: uid(), title,
    details: String(b.details || '').trim().slice(0, 600),
    foundAt: String(b.foundAt || '').trim().slice(0, 120),
    category: String(b.category || 'Other').trim().slice(0, 40),
    status: 'listed', date: new Date().toISOString()
  };
  db.lostfound.unshift(rec);
  await saveDb();
  res.json({ item: rec });
});
app.put('/api/lostfound/:id', auth, overseerOnly, async (req, res) => {
  const it = (db.lostfound || []).find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'Item not found' });
  const b = req.body || {};
  if (b.status !== undefined) it.status = (b.status === 'returned') ? 'returned' : 'listed';
  if (typeof b.title === 'string' && b.title.trim()) it.title = b.title.trim().slice(0, 120);
  if (typeof b.details === 'string') it.details = b.details.trim().slice(0, 600);
  if (typeof b.foundAt === 'string') it.foundAt = b.foundAt.trim().slice(0, 120);
  if (typeof b.category === 'string' && b.category.trim()) it.category = b.category.trim().slice(0, 40);
  await saveDb();
  res.json({ item: it });
});
app.delete('/api/lostfound/:id', auth, overseerOnly, async (req, res) => {
  db.lostfound = db.lostfound || [];
  const before = db.lostfound.length;
  db.lostfound = db.lostfound.filter(x => x.id !== req.params.id);
  if (db.lostfound.length === before) return res.status(404).json({ error: 'Item not found' });
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Overseer: upload a standalone file (base64, stored in DB) ---------------- */
app.post('/api/upload', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.dataUrl) return res.status(400).json({ error: 'No file data received.' });
  try {
    const rec = makeFileRecord(b.name, b.dataUrl, b.type);
    db.files = db.files || [];
    db.files.push(rec);
    await saveDb();
    res.json({ file: publicFile(rec) });
  } catch (e) { res.status(400).json({ error: 'Upload failed: ' + e.message }); }
});

/* ---------------- Student endpoints (no edit rights) ---------------- */
app.post('/api/reports', auth, studentOnly, async (req, res) => {
  const st = db.students.find(x => x.id === req.session.studentId);
  if (!st) return res.status(404).json({ error: 'Student record not found' });
  const b = req.body || {};
  if (!b.msg) return res.status(400).json({ error: 'Please describe the problem' });
  // Optional photo/PDF attachment (stored in the DB so it is permanent).
  let file = null;
  if (b.file && b.file.dataUrl) {
    try {
      const frec = makeFileRecord(b.file.name, b.file.dataUrl, b.file.type);
      if (!/^(image\/|application\/pdf)/i.test(frec.type)) throw new Error('only a photo (image) or PDF can be attached');
      db.files = db.files || [];
      db.files.push(frec);
      file = publicFile(frec);
    } catch (e) { return res.status(400).json({ error: 'Attachment failed: ' + e.message }); }
  }
  const nowIso = new Date().toISOString();
  const rec = { id: uid(), studentId: st.id, name: st.name, reg: st.reg, phone: st.phone,
    block: st.block, room: st.room, msg: b.msg, urg: b.urg || 'Normal', file: file,
    status: 'received', statusHistory: [{ status: 'received', date: nowIso }], date: nowIso };
  db.reports.unshift(rec);
  await saveDb();
  res.json({ report: rec });
  sendWhatsAppNotification(rec); // fire-and-forget alert to the overseer's WhatsApp
  checkDataLoad().catch(()=>{}); // alert the overseer if data is now large
});

app.get('/api/reports/mine', auth, studentOnly, (req, res) => {
  const mine = db.reports.filter(x => x.studentId === req.session.studentId);
  res.json({ reports: mine });
});

/* ---------------- Reviews (5-star rating + comments) ---------------- */
app.get('/api/reviews', (req, res) => {
  const list = db.reviews.slice().reverse(); // newest first
  const avg = list.length ? (list.reduce((a, r) => a + r.rating, 0) / list.length) : 0;
  res.json({ reviews: list, average: Math.round(avg * 10) / 10, count: list.length });
});

app.post('/api/reviews', auth, studentOnly, async (req, res) => {
  const st = db.students.find(x => x.id === req.session.studentId);
  if (!st) return res.status(404).json({ error: 'Student record not found' });
  const b = req.body || {};
  const rating = parseInt(b.rating, 10);
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5 stars' });
  if (!b.comment || !String(b.comment).trim()) return res.status(400).json({ error: 'Please write a short comment' });
  const rec = { id: uid(), name: st.name, rating: rating, comment: String(b.comment).trim(), date: new Date().toISOString() };
  db.reviews.push(rec);
  await saveDb();
  res.json({ review: rec });
});

app.delete('/api/reviews/:id', auth, overseerOnly, async (req, res) => {
  const before = db.reviews.length;
  db.reviews = db.reviews.filter(x => x.id !== req.params.id);
  if (db.reviews.length === before) return res.status(404).json({ error: 'Review not found' });
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Site settings (page photo + features) ---------------- */
app.get('/api/settings', (req, res) => {
  const s = normalizeSettings(db.settings || defaultSettings());
  // Public endpoint: NEVER expose the SMTP password (or any email secrets).
  const out = JSON.parse(JSON.stringify(s));
  if (out.emailConfig) {
    out.emailConfig.smtp = {
      host: out.emailConfig.smtp.host, port: out.emailConfig.smtp.port,
      secure: out.emailConfig.smtp.secure, user: '', pass: '',
      configured: !!(out.emailConfig.smtp.host && out.emailConfig.smtp.user)
    };
  }
  res.json({ settings: out });
});

app.put('/api/settings', auth, overseerOnly, async (req, res) => {
  const b = req.body && req.body.settings ? req.body.settings : (req.body || {});
  const s = normalizeSettings(Object.assign({}, db.settings || defaultSettings()));
  if (typeof b.pageTitle === 'string') s.pageTitle = b.pageTitle.trim() || s.pageTitle;
  if (typeof b.tagline === 'string') s.tagline = b.tagline.trim() || s.tagline;
  if (typeof b.pagePhoto === 'string' && b.pagePhoto.trim()) s.pagePhoto = b.pagePhoto.trim();
  if (Array.isArray(b.features)) {
    s.features = b.features.slice(0, 6).map(f => ({
      icon: (f && f.icon) || '⭐', title: (f && f.title) || '', text: (f && f.text) || ''
    }));
  }
  if (Array.isArray(b.infoHub)) {
    s.infoHub = b.infoHub.slice(0, 12).map(f => ({
      icon: (f && f.icon) || '📌', title: (f && f.title) || '', text: (f && f.text) || ''
    })).filter(f => (f.title || '').trim() || (f.text || '').trim());
  }
  if (b.urgentNotice && typeof b.urgentNotice === 'object') {
    s.urgentNotice = {
      enabled: !!b.urgentNotice.enabled,
      text: String(b.urgentNotice.text || '').trim().slice(0, 300)
    };
  }
  // Collo AI knowledge base (questions + answers) - editable by the Overseer
  const cb = b.chatbot;
  if (cb && typeof cb === 'object') {
    if (typeof cb.name === 'string' && cb.name.trim()) s.chatbot.name = cb.name.trim().slice(0, 40);
    if (typeof cb.greeting === 'string') s.chatbot.greeting = cb.greeting.trim().slice(0, 600) || s.chatbot.greeting;
    if (typeof cb.fallback === 'string') s.chatbot.fallback = cb.fallback.trim().slice(0, 600) || s.chatbot.fallback;
    if (typeof cb.enabled === 'boolean') s.chatbot.enabled = cb.enabled;
    if (cb.visibility === 'overseer' || cb.visibility === 'everyone' || cb.visibility === 'off') s.chatbot.visibility = cb.visibility;
    if (Array.isArray(cb.faq)) {
      s.chatbot.faq = cb.faq.slice(0, 60).filter(f => f && ((f.q||'').trim() || (f.a||'').trim())).map(f => ({
        q: String((f && f.q) || '').trim().slice(0, 200),
        a: String((f && f.a) || '').trim().slice(0, 800)
      }));
    }
  }
  // Theme (page colours + layout) - overseer can change these from Settings
  const t = b.theme || b.appearance || {};
  if (t && typeof t === 'object') {
    const cur = Object.assign(defaultTheme(), s.theme || {});
    const palettes = ['green','ocean','royal','crimson','slate','gold','custom'];
    if (palettes.indexOf(t.palette) !== -1) cur.palette = t.palette;
    if (typeof t.primary === 'string' && /^#[0-9a-fA-F]{6}$/.test(t.primary)) cur.primary = t.primary;
    if (typeof t.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(t.accent)) cur.accent = t.accent;
    if (t.bg === 'gradient' || t.bg === 'light') cur.bg = t.bg;
    if (t.layout === 'modern' || t.layout === 'classic') cur.layout = t.layout;
    const r = parseInt(t.radius, 10);
    if (!isNaN(r)) cur.radius = Math.min(30, Math.max(4, r));
    if (t.font === 'system' || t.font === 'serif') cur.font = t.font;
    s.theme = cur;
  }
  db.settings = s;
  await saveDb();
  res.json({ settings: s });
});

/* ---------------- Full backup / restore (guarantees data is never lost) ---------------- */
app.get('/api/admin/backup', auth, overseerOnly, (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename=usambara-full-backup-' + new Date().toISOString().slice(0,10) + '.json');
  res.json({ overseer: db.overseer, students: db.students, reports: db.reports, reviews: db.reviews, announcements: db.announcements, events: db.events, polls: db.polls, lostfound: db.lostfound, files: db.files, settings: db.settings });
});

app.post('/api/admin/restore', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.students || !b.reports || !b.reviews) {
    return res.status(400).json({ error: 'Backup file must contain students, reports and reviews' });
  }
  applyBackup(b);
  await saveDb();
  res.json({ ok: true, count: db.students.length });
});

// Apply a full data blob onto the live db (shared by manual restore + snapshot restore).
function applyBackup(b) {
  const currentPass = db.overseer;
  db.overseer = (b.overseer && b.overseer.hash) ? b.overseer : currentPass;
  db.students = b.students || [];
  db.reports = b.reports || [];
  db.reviews = b.reviews || [];
  db.announcements = Array.isArray(b.announcements) ? b.announcements : [];
  db.events = Array.isArray(b.events) ? b.events : [];
  db.polls = Array.isArray(b.polls) ? b.polls : [];
  db.lostfound = Array.isArray(b.lostfound) ? b.lostfound : [];
  db.files = Array.isArray(b.files) ? b.files : [];
  db.settings = Object.assign(defaultSettings(), b.settings || {});
}

/* ---------------- Automatic snapshots / Data Safety (overseer) ---------------- */
app.get('/api/admin/snapshots', auth, overseerOnly, async (req, res) => {
  let snaps = [];
  try { snaps = await store.listSnapshots(); } catch(e){ snaps = []; }
  res.json({ mode: currentMode, autoEveryHours: 6, count: snaps.length,
             lastDate: snaps.length ? snaps[0].date : null, snapshots: snaps });
});
app.post('/api/admin/snapshots', auth, overseerOnly, async (req, res) => {
  try {
    const s = await store.snapshot();
    if (!s) return res.status(400).json({ error: 'Nothing to back up yet.' });
    res.json({ ok: true, snapshot: s });
  } catch(e){ res.status(500).json({ error: 'Backup failed: ' + e.message }); }
});
app.post('/api/admin/snapshots/:id/restore', auth, overseerOnly, async (req, res) => {
  try {
    const data = await store.getSnapshot(req.params.id);
    if (!data) return res.status(404).json({ error: 'Snapshot not found' });
    if (!data.students || !data.reports || !data.reviews) return res.status(400).json({ error: 'Snapshot is missing core data.' });
    applyBackup(data);
    await saveDb();
    res.json({ ok: true, count: db.students.length });
  } catch(e){ res.status(500).json({ error: 'Restore failed: ' + e.message }); }
});

/* ---------------- List available page images ---------------- */
app.get('/api/images', auth, overseerOnly, (req, res) => {
  const exts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  let files = [];
  try { files = fs.readdirSync(__dirname); } catch(e) {}
  const imgs = files.filter(f => exts.some(e => f.toLowerCase().endsWith(e)));
  res.json({ images: imgs });
});

/* ---------------- Test a DB connection string (no changes made) ---------------- */
app.post('/api/admin/db/test', auth, overseerOnly, async (req, res) => {
  const uri = (req.body && req.body.uri) ? String(req.body.uri).trim() : '';
  if (!uri) return res.status(400).json({ ok: false, error: 'Enter a connection string to test.' });
  try {
    const testStore = await makeStore(uri);   // connects + verifies credentials
    if (testStore._client) await testStore._client.close();
    res.json({ ok: true });
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/* ---------------- Database & storage management ---------------- */
app.get('/api/admin/storage', auth, overseerOnly, (req, res) => {
  res.json({ mode: currentMode, configured: !!dbUri() });
});

app.post('/api/admin/db', auth, overseerOnly, async (req, res) => {
  const uri = (req.body && req.body.uri) ? String(req.body.uri).trim() : '';
  const prev = readDbConfig();
  const prevMode = currentMode;
  try {
    writeDbConfig(uri ? { uri } : {});
    await reconnectStore();            // migrates existing data into the new store
    res.json({ ok: true, mode: currentMode });
  } catch(e) {
    writeDbConfig(prev);               // revert on failure so the app still runs
    currentMode = prevMode;
    res.status(400).json({ error: 'Could not connect to that database: ' + e.message });
  }
});

/* ---------------- Data size + alert status ---------------- */
app.get('/api/admin/datastats', auth, overseerOnly, (req, res) => {
  const s = dataStats();
  const threshold = alertThreshold();
  res.json({ stats: s, threshold, over: s.total >= threshold });
});

/* ---------------- Collo AI - real Gemini brain ---------------- */
// Public status (no sensitive info). Let the front end know if AI is enabled.
app.get('/api/ai/status', (req, res) => {
  res.json({ enabled: !!geminiKey(), provider: aiProvider(), model: geminiModel() });
});

// Chat endpoint. Public so any visitor can talk to Collo AI. If Gemini is
// not configured / fails, we reply fallback:true so the client uses the
// offline keyword matcher instead.
app.post('/api/ai/chat', async (req, res) => {
  const msg = String((req.body || {}).message || '').slice(0, 800);
  if (!msg.trim()) return res.json({ reply: null, fallback: true, reason: 'empty' });
  if (!geminiKey()) return res.json({ reply: null, fallback: true, reason: 'nokey' });
  const history = (req.body || {}).history;
  try {
    const txt = await callGemini(msg, history);
    if (txt) return res.json({ reply: txt, fallback: false });
    return res.json({ reply: null, fallback: true, reason: 'emptyresponse' });
  } catch (e) {
    console.error('ai/chat error:', e.message);
    return res.json({ reply: null, fallback: true, reason: 'error' });
  }
});

// Overseer: set / clear the AI key (stored server-side in gemini-config.json).
// Accepts a Groq key (gsk_...) or a Google Gemini key (AIza...). The key is
// verified with a live test call BEFORE it is saved.
app.post('/api/ai/key', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  const k = b.key ? String(b.key).trim() : '';
  if (!k) { writeGeminiConfig({}); return res.json({ enabled: false, provider: 'none' }); }
  const provider = aiProvider(k);
  const defaultModel = provider === 'groq' ? 'llama-3.3-70b-versatile' : 'gemini-2.0-flash';
  const model = (b.model && String(b.model).trim()) || defaultModel;
  let ok = false;
  try {
    const reply = provider === 'groq'
      ? await callGroq(k, model, 'Reply with just: OK')
      : await callGeminiProvider(k, model, 'Reply with just: OK');
    ok = !!reply;
  } catch (e) { ok = false; }
  if (!ok) {
    const hint = provider === 'groq'
      ? 'That Groq key did not work. It must start with gsk_ — get a new one free at console.groq.com/keys.'
      : 'That Gemini key did not work. It must start with AIza — get one free at aistudio.google.com/app/apikey.';
    return res.status(400).json({ error: hint });
  }
  writeGeminiConfig({ key: k, model: model });
  res.json({ enabled: true, provider: provider, model: model });
});

/* ---------------- Root ---------------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Health check for uptime monitors (e.g. UptimeRobot). Public, lightweight, no data exposed.
app.get('/health', (req, res) => {
  res.json({ ok: true, storage: currentMode, residents: (db.students || []).length, time: new Date().toISOString() });
});

// Fallback for unmatched routes / wrong methods — always clean JSON, never an HTML error
app.use((req, res) => {
  res.status(404).json({ error: 'Not found: ' + req.method + ' ' + req.path });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  // Never leak internals: only expected (status-tagged) errors show their message.
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
  res.status(err.status || 500).json({ error: err.status ? (err.message || 'Server error') : 'Server error' });
});

/* ---------------- Start ---------------- */
async function start() {
  try {
    await loadDb();
    app.listen(PORT, '0.0.0.0', () => {
      console.log('Usambara Male Hostels live server running on port ' + PORT);
      console.log('Storage: ' + (currentMode === 'mongodb' ? 'MongoDB Atlas (permanent)' : 'local JSON file'));
    });
    // Check data size periodically (every 5 minutes) so growth is caught even
    // when no new report triggers it.
    setInterval(() => { checkDataLoad().catch(()=>{}); }, 1000 * 60 * 5);
    checkDataLoad().catch(()=>{}); // initial check on startup

    // Automatic backups: one snapshot shortly after boot, then every 6 hours.
    // Snapshots are stored server-side (Mongo 'backups' collection / local backups folder)
    // and keep the newest 14, so data can be restored even after an accidental delete.
    const runSnapshot = (label) => {
      try {
        if (typeof store.snapshot !== 'function') return;
        store.snapshot()
          .then(s => { if (s) console.log('Auto-backup: ' + label + ' snapshot saved (' + s.id + ').'); })
          .catch(e => console.warn('auto-backup warn (' + label + '):', e.message));
      } catch(e) { console.warn('auto-backup warn (' + label + '):', e.message); }
    };
    setTimeout(() => runSnapshot('startup'), 20000);
    setInterval(() => runSnapshot('scheduled'), 1000 * 60 * 60 * 6);
    // Automated email reports: check every 15 minutes (sends per configured schedule)
    setInterval(() => { maybeSendScheduledEmail().catch(e => console.warn('email warn:', e.message)); }, 15 * 60 * 1000);
  } catch(e) {
    console.error('Failed to start server:', e.message);
    process.exit(1);
  }
}
start();
