// FILE: routes/orgCode.js

import express from "express";
import Groq from "groq-sdk";
import twilio from "twilio";

const router = express.Router();

// ─── Clients ──────────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─── Firebase REST helpers ────────────────────────────────────────────────────
const FB_PROJECT = process.env.FIREBASE_PROJECT_ID;
const FB_API_KEY  = process.env.FIREBASE_API_KEY;
const FB_BASE     = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

/**
 * GET a Firestore document.
 * Returns parsed fields object or null if not found.
 */
async function fsGet(collection, docId) {
  const url = `${FB_BASE}/${collection}/${encodeURIComponent(docId)}?key=${FB_API_KEY}`;
  const res  = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET failed: ${res.status}`);
  const json = await res.json();
  return parseFirestoreDoc(json.fields || {});
}

/**
 * SET (create/overwrite) a Firestore document.
 */
async function fsSet(collection, docId, data) {
  const url  = `${FB_BASE}/${collection}/${encodeURIComponent(docId)}?key=${FB_API_KEY}`;
  const body = { fields: toFirestoreFields(data) };
  const res  = await fetch(url, {
    method:  "PATCH",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore SET failed: ${res.status} — ${err}`);
  }
  return await res.json();
}

/** Convert plain JS object → Firestore REST field format */
function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      fields[k] = { nullValue: null };
    } else if (typeof v === "boolean") {
      fields[k] = { booleanValue: v };
    } else if (typeof v === "number") {
      fields[k] = Number.isInteger(v)
        ? { integerValue: String(v) }
        : { doubleValue: v };
    } else if (typeof v === "string") {
      fields[k] = { stringValue: v };
    } else if (v instanceof Date) {
      fields[k] = { timestampValue: v.toISOString() };
    } else if (Array.isArray(v)) {
      fields[k] = { arrayValue: { values: v.map((i) => toFirestoreValue(i)) } };
    } else if (typeof v === "object") {
      fields[k] = { mapValue: { fields: toFirestoreFields(v) } };
    }
  }
  return fields;
}

function toFirestoreValue(v) {
  if (typeof v === "string")  return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number")  return { doubleValue: v };
  return { stringValue: String(v) };
}

/** Convert Firestore REST field format → plain JS object */
function parseFirestoreDoc(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    obj[k] = parseFirestoreValue(v);
  }
  return obj;
}

function parseFirestoreValue(v) {
  if (v.stringValue  !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
  if (v.doubleValue  !== undefined) return v.doubleValue;
  if (v.nullValue    !== undefined) return null;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue?.values)         return v.arrayValue.values.map(parseFirestoreValue);
  if (v.mapValue?.fields)           return parseFirestoreDoc(v.mapValue.fields);
  return null;
}

// ─── AI Org Code Generator ────────────────────────────────────────────────────

/**
 * Use Groq to generate candidate org codes from an institute name.
 * Returns array of 5 uppercase alphanumeric codes (4–8 chars).
 */
async function generateCandidateCodes(orgName) {
  const prompt = `You are generating short, unique organisation codes for a coaching institute management system.

Institute name: "${orgName}"

Rules:
- Generate exactly 5 different codes
- Each code must be 4–8 characters, uppercase letters and numbers only
- Derive codes from the institute name (abbreviations, initials, combinations)
- Make them memorable and related to the name
- Examples: "Agrawal Classes" → AGRCLA, AGRTEST, AGRCLS, AGRAWL, AGRCL25
- Examples: "Sharma Coaching" → SHRMCO, SHARMA, SHRCOA, SHRCO, SHRMCLA

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
    // Fallback: extract uppercase tokens manually
    codes = cleaned.match(/[A-Z0-9]{4,8}/g) || [];
  }

  // Sanitise: uppercase, alphanumeric only, 4–8 chars
  return codes
    .map((c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))
    .filter((c) => c.length >= 4)
    .slice(0, 5);
}

/**
 * Find the first code from candidates that doesn't exist in Firestore.
 * If all taken, generate a numeric-suffixed fallback.
 */
async function pickUniqueCode(candidates, orgName) {
  for (const code of candidates) {
    const existing = await fsGet("organisations", code);
    if (!existing) return code;
  }

  // All taken — generate fallback with timestamp suffix
  const base     = orgName.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  const suffix   = String(Date.now()).slice(-4);
  const fallback = `${base}${suffix}`;
  const existing = await fsGet("organisations", fallback);
  if (!existing) return fallback;

  // Absolute last resort
  return `ORG${Date.now().toString().slice(-5)}`;
}

// ─── EmailJS trigger via REST ─────────────────────────────────────────────────
async function sendEmailJS({ toEmail, toName, orgCode, orgName, subjects, strength, city }) {
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id:  process.env.EMAILJS_SERVICE_ID  || "service_sboo63a",
      template_id: process.env.EMAILJS_TEMPLATE_ID || "template_0nlxu6o",
      user_id:     process.env.EMAILJS_PUBLIC_KEY  || "YyKc38WbGwlYNOBRP",
      template_params: {
        to_name:      toName,
        to_email:     toEmail,
        org_code:     orgCode,
        org_name:     orgName,
        subjects:     subjects,
        strength:     strength,
        city:         city || "Not specified",
        login_url:    "https://goodforyoutest.netlify.app",
        reply_to:     "gajanandhoble5@gmail.com",
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`EmailJS failed: ${res.status} — ${text}`);
  }
  return true;
}

// ─── Twilio WhatsApp ──────────────────────────────────────────────────────────

/** Normalise Indian phone number to E.164 */
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
    `🎉 *Your Organisation Code is Ready!*\n\n` +
    `Hello *${contactName}*,\n\n` +
    `Your org code for *Good for You Test Engine* has been created.\n\n` +
    `🏫 *Institute:* ${orgName}\n` +
    `🔑 *Org Code:* \`${orgCode}\`\n\n` +
    `Share this code with your teachers and students when they sign up at:\n` +
    `👉 https://goodforyoutest.netlify.app\n\n` +
    `For help, reply to this message or contact us.\n` +
    `— *Good for You Team*`;

  await twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886",
    to,
    body: message,
  });

  return true;
}

// ─── Route ────────────────────────────────────────────────────────────────────

/**
 * POST /api/org/request
 * Body: { orgName, strength, subjects, contact, email, city }
 *
 * 1. AI generates org code candidates
 * 2. Pick first unique code from Firestore
 * 3. Save org to Firestore organisations collection
 * 4. Send email via EmailJS
 * 5. Send WhatsApp via Twilio
 * 6. Return { success, orgCode }
 */
router.post("/request", async (req, res) => {
  const {
    orgName,
    strength,
    subjects,
    contact,
    email,
    city,
  } = req.body;

  // ── Validation ──
  if (!orgName || !strength || !contact || !email) {
    return res.status(400).json({
      error: "orgName, strength, contact and email are required.",
    });
  }

  const subjectsStr = Array.isArray(subjects)
    ? subjects.join(", ")
    : subjects || "Not specified";

  const contactName = orgName; // use org name as addressee

  try {
    // ── Step 1: Generate candidate codes via AI ──
    let candidates = [];
    try {
      candidates = await generateCandidateCodes(orgName);
    } catch (aiErr) {
      console.error("[OrgCode] Groq error:", aiErr.message);
      // Fallback: simple abbreviation
      const words = orgName.trim().toUpperCase().split(/\s+/);
      candidates = [
        words.map((w) => w.slice(0, 2)).join("").slice(0, 8),
        words.map((w) => w.slice(0, 3)).join("").slice(0, 8),
        words[0]?.slice(0, 6) || "ORG",
      ].filter((c) => c.length >= 3);
    }

    // ── Step 2: Pick unique code ──
    const orgCode = await pickUniqueCode(candidates, orgName);

    // ── Step 3: Save to Firestore ──
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

    console.log(`[OrgCode] Created org: ${orgCode} for "${orgName}"`);

    // ── Step 4: Send email ──
    let emailSent = false;
    try {
      await sendEmailJS({
        toEmail:  email,
        toName:   contactName,
        orgCode,
        orgName,
        subjects: subjectsStr,
        strength,
        city,
      });
      emailSent = true;
      console.log(`[OrgCode] Email sent to ${email}`);
    } catch (emailErr) {
      console.error("[OrgCode] Email error:", emailErr.message);
      // Non-fatal — org is already created
    }

    // ── Step 5: Send WhatsApp ──
    let whatsappSent = false;
    try {
      await sendWhatsApp({
        phone:       contact,
        orgCode,
        orgName,
        contactName,
      });
      whatsappSent = true;
      console.log(`[OrgCode] WhatsApp sent to ${contact}`);
    } catch (waErr) {
      console.error("[OrgCode] WhatsApp error:", waErr.message);
      // Non-fatal
    }

    return res.json({
      success:      true,
      orgCode,
      orgName,
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
 * Check if an org code already exists.
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
