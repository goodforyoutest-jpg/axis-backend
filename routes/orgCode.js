// FILE: routes/orgCode.js

import express from "express";
import Groq from "groq-sdk";
import twilio from "twilio";
import admin from "firebase-admin";

const router = express.Router();

// ─── Clients ──────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─── Firebase Admin (bypasses Firestore rules) ────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FB_ADMIN_PROJECT_ID,
      clientEmail: process.env.FB_ADMIN_CLIENT_EMAIL,
      privateKey:  (process.env.FB_ADMIN_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}
const db = admin.firestore();

// ─── Firestore helpers ────────────────────────────────────────────────────────
async function fsGet(collection, docId) {
  const snap = await db.collection(collection).doc(docId).get();
  return snap.exists ? snap.data() : null;
}

async function fsSet(collection, docId, data) {
  await db.collection(collection).doc(docId).set(data);
}

// ─── Firebase Auth ────────────────────────────────────────────────────────────

/**
 * Create a Firebase Auth account via Admin SDK.
 * Returns { uid, email }
 */
async function createFirebaseAuthAccount(email, password, displayName) {
  try {
    const user = await admin.auth().createUser({ email, password, displayName });
    return { uid: user.uid, email };
  } catch (e) {
    if (e.code === "auth/email-already-exists") throw new Error("This email is already registered.");
    throw new Error(`Auth creation failed: ${e.message}`);
  }
}

// ─── AI Org Code Generator ────────────────────────────────────────────────────
async function generateCandidateCodes(orgName) {
  const prompt = `You are generating short, unique organisation codes for a coaching institute management system.

Institute name: "${orgName}"

Rules:
- Generate exactly 5 different codes
- Each code must be 4–8 characters, uppercase letters and numbers only
- Derive codes from the institute name (abbreviations, initials, combinations)
- Make them memorable and related to the name
- Examples: "Agrawal Classes" -> AGRCLA, AGRTEST, AGRCLS, AGRAWL, AGRCL25
- Examples: "Sharma Coaching" -> SHRMCO, SHARMA, SHRCOA, SHRCO, SHRMCLA

Return ONLY a JSON array of 5 strings. No explanation, no markdown, just the array.
Example output: ["AGRCLA","AGRTEST","AGRCLS","AGRAWL","AGRCL25"]`;

  const completion = await groq.chat.completions.create({
    model:       "llama3-8b-8192",
    messages:    [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens:  150,
  });

  const raw     = completion.choices[0]?.message?.content?.trim() || "[]";
  const cleaned = raw.replace(/```json|```/gi, "").trim();

  let codes = [];
  try {
    codes = JSON.parse(cleaned);
  } catch {
    codes = cleaned.match(/[A-Z0-9]{4,8}/g) || [];
  }

  return codes
    .map((c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))
    .filter((c) => c.length >= 4)
    .slice(0, 5);
}

async function pickUniqueCode(candidates, orgName) {
  for (const code of candidates) {
    const existing = await fsGet("organisations", code);
    if (!existing) return code;
  }
  const base     = orgName.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  const suffix   = String(Date.now()).slice(-4);
  const fallback = `${base}${suffix}`;
  const existing = await fsGet("organisations", fallback);
  if (!existing) return fallback;
  return `ORG${Date.now().toString().slice(-5)}`;
}

// ─── AI Password Generator ────────────────────────────────────────────────────
async function generatePassword(orgName) {
  // Extract first meaningful word, capitalise it
  const word = orgName.trim().split(/\s+/)[0];
  const base = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

  // Random 3-digit number + special char
  const num     = Math.floor(100 + Math.random() * 900);
  const specials = ["@", "#", "$", "&"];
  const special  = specials[Math.floor(Math.random() * specials.length)];

  return `GFY${special}${base}${num}`;
  // e.g. GFY@Agrawal472 — strong, memorable, 12+ chars
}

// ─── EmailJS ──────────────────────────────────────────────────────────────────
async function sendEmailJS({ toEmail, toName, orgCode, orgName, subjects, strength, city }) {
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id:  process.env.EMAILJS_SERVICE_ID  || "service_sboo63a",
      template_id: process.env.EMAILJS_TEMPLATE_ID || "template_0nlxu6o",
      user_id:     process.env.EMAILJS_PUBLIC_KEY  || "YyKc38WbGwlYNOBRP",
      template_params: {
        to_name:   toName,
        to_email:  toEmail,
        org_code:  orgCode,
        org_name:  orgName,
        subjects:  subjects,
        strength:  strength,
        city:      city || "Not specified",
        login_url: "https://goodforyoutest.netlify.app",
        reply_to:  "gajanandhoble5@gmail.com",
      },
    }),
  });
  if (!res.ok) throw new Error(`EmailJS failed: ${res.status}`);
  return true;
}

// ─── Twilio WhatsApp ──────────────────────────────────────────────────────────
function normalisePhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith("+")) return phone.replace(/\s/g, "");
  return `+${digits}`;
}

async function sendWhatsApp({ phone, orgCode, orgName, contactName }) {
  const to = `whatsapp:${normalisePhone(phone)}`;
  const message =
    `Your Organisation Code is Ready!\n\n` +
    `Hello ${contactName},\n\n` +
    `Your org code for Good for You Test Engine has been created.\n\n` +
    `Institute: ${orgName}\n` +
    `Org Code: ${orgCode}\n\n` +
    `Share this code with your teachers and students when they sign up at:\n` +
    `https://goodforyoutest.netlify.app\n\n` +
    `For help, reply to this message or contact us.\n` +
    `— Good for You Team`;

  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886",
    to,
    body: message,
  });
  return true;
}

// ─── Main Route ───────────────────────────────────────────────────────────────

/**
 * POST /api/org/request
 * Body: { orgName, strength, subjects, contact, email, city }
 *
 * 1. AI generates org code
 * 2. Pick unique code from Firestore
 * 3. AI generates secure password
 * 4. Save org to Firestore organisations collection
 * 5. Create Firebase Auth account
 * 6. Save user doc to Firestore users collection
 * 7. Send email + WhatsApp (non-fatal)
 * 8. Return { success, orgCode, password, email }
 */
router.post("/request", async (req, res) => {
  const { orgName, strength, subjects, contact, email, city } = req.body;

  if (!orgName || !strength || !contact || !email) {
    return res.status(400).json({
      error: "orgName, strength, contact and email are required.",
    });
  }

  const subjectsStr = Array.isArray(subjects)
    ? subjects.join(", ")
    : subjects || "Not specified";

  try {
    // Step 1 — Generate org code candidates
    let candidates = [];
    try {
      candidates = await generateCandidateCodes(orgName);
    } catch {
      const words = orgName.trim().toUpperCase().split(/\s+/);
      candidates = [
        words.map((w) => w.slice(0, 2)).join("").slice(0, 8),
        words.map((w) => w.slice(0, 3)).join("").slice(0, 8),
        words[0]?.slice(0, 6) || "ORG",
      ].filter((c) => c.length >= 3);
    }

    // Step 2 — Pick unique code
    const orgCode = await pickUniqueCode(candidates, orgName);

    // Step 3 — Generate password
    const password = await generatePassword(orgName);

    // Step 4 — Save organisation to Firestore
    await fsSet("organisations", orgCode, {
      code:      orgCode,
      name:      orgName,
      course:    "",
      active:    true,
      strength:  strength,
      subjects:  subjectsStr,
      contact:   contact,
      email:     email,
      city:      city || "",
      createdAt: new Date().toISOString(),
      source:    "ai-auto",
    });

    console.log(`[OrgCode] Org saved: ${orgCode} for "${orgName}"`);

    // Step 5 — Create Firebase Auth account
    const { uid } = await createFirebaseAuthAccount(email, password, orgName);
    console.log(`[OrgCode] Auth account created: ${uid}`);

    // Step 6 — Save user doc to Firestore
    await fsSet("users", uid, {
      uid,
      username:  orgName,
      email,
      role:      "admin",
      orgCode,
      createdAt: new Date().toISOString(),
      photoURL:  "",
    });

    console.log(`[OrgCode] User doc saved for uid: ${uid}`);

    // Step 7 — Send notifications (non-fatal)
    let emailSent = false;
    let whatsappSent = false;

    try {
      await sendEmailJS({ toEmail: email, toName: orgName, orgCode, orgName, subjects: subjectsStr, strength, city });
      emailSent = true;
    } catch (e) {
      console.error("[OrgCode] Email error:", e.message);
    }

    try {
      await sendWhatsApp({ phone: contact, orgCode, orgName, contactName: orgName });
      whatsappSent = true;
    } catch (e) {
      console.error("[OrgCode] WhatsApp error:", e.message);
    }

    // Step 8 — Return all credentials
    return res.json({
      success: true,
      orgCode,
      orgName,
      email,
      password,
      emailSent,
      whatsappSent,
    });

  } catch (err) {
    console.error("[OrgCode] Fatal error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/org/check/:code
 */
router.get("/check/:code", async (req, res) => {
  const code = req.params.code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!code || code.length < 3) {
    return res.status(400).json({ error: "Invalid code." });
  }
  try {
    const existing = await fsGet("organisations", code);
    return res.json({ exists: !!existing, code });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export default router;
