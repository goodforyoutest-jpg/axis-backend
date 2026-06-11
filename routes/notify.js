// FILE: routes/notify.js

import express from "express";
import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";
import Groq from "groq-sdk";
import cron from "node-cron";

const router = express.Router();

// ─── VAPID Config ─────────────────────────────────────────────────────────────
webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ─── Clients ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── In-memory cron job registry ──────────────────────────────────────────────
const scheduledJobs = new Map(); // id -> node-cron task

// ─── Notification type configs ────────────────────────────────────────────────
const NOTIFICATION_CONTEXTS = {
  morning: {
    timeHint: "morning (6–10 AM)",
    tone: "energetic, motivational, focused",
    emoji: "🌅",
  },
  afternoon: {
    timeHint: "afternoon (12–4 PM)",
    tone: "grounding, productive, calm",
    emoji: "☀️",
  },
  evening: {
    timeHint: "evening (6–9 PM)",
    tone: "reflective, wind-down, accomplished",
    emoji: "🌙",
  },
  random: {
    timeHint: "any time",
    tone: "spontaneous, witty, surprising",
    emoji: "⚡",
  },
  lock: {
    timeHint: "any time",
    tone: "strict, no-nonsense, disciplined",
    emoji: "🔒",
  },
  reminder: {
    timeHint: "any time",
    tone: "gentle, nudging, helpful",
    emoji: "🔔",
  },
  study: {
    timeHint: "study session",
    tone: "focused, academic, encouraging",
    emoji: "📚",
  },
  custom: {
    timeHint: "any time",
    tone: "contextual, adaptive",
    emoji: "✨",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fetch all active subscriptions from Supabase.
 */
async function getAllSubscriptions() {
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, subscription");

  if (error) throw new Error(`Supabase fetch error: ${error.message}`);
  return data || [];
}

/**
 * Fetch subscriptions belonging to a specific org code.
 */
async function getSubscriptionsByOrg(orgCode) {
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, subscription")
    .eq("org_code", orgCode);

  if (error) throw new Error(`Supabase fetch error: ${error.message}`);
  return data || [];
}

/**
 * Remove a dead subscription from Supabase by endpoint.
 */
async function removeSubscription(endpoint) {
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint);

  if (error) {
    console.error(`[AXIS Notify] Failed to remove dead sub: ${error.message}`);
  } else {
    console.log(`[AXIS Notify] Removed dead subscription: ${endpoint}`);
  }
}

/**
 * Send a notification payload to all subscribers.
 * Returns { sent, failed, removed }.
 */
async function broadcastNotification(payload, subscribers = null) {
  const subs = subscribers || (await getAllSubscriptions());
  if (!subs.length) return { sent: 0, failed: 0, removed: 0 };

  const payloadStr =
    typeof payload === "string" ? payload : JSON.stringify(payload);

  let sent = 0;
  let failed = 0;
  let removed = 0;

  const tasks = subs.map(async (row) => {
    let subscription;
    try {
      subscription =
        typeof row.subscription === "string"
          ? JSON.parse(row.subscription)
          : row.subscription;
    } catch {
      console.error(`[AXIS Notify] Invalid subscription JSON for id=${row.id}`);
      failed++;
      return;
    }

    try {
      await webpush.sendNotification(subscription, payloadStr);
      sent++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await removeSubscription(row.endpoint);
        removed++;
      } else {
        console.error(
          `[AXIS Notify] Push failed for id=${row.id}: ${err.message}`
        );
        failed++;
      }
    }
  });

  await Promise.allSettled(tasks);
  return { sent, failed, removed };
}

/**
 * Generate notification content via Groq AI.
 */
async function generateAINotification(type = "random", userContext = "") {
  const ctx = NOTIFICATION_CONTEXTS[type] || NOTIFICATION_CONTEXTS.random;

  // Pull recent AI memory for context
  const { data: memories } = await supabase
    .from("ai_memory")
    .select("role, content")
    .order("created_at", { ascending: false })
    .limit(10);

  const memoryContext =
    memories && memories.length
      ? memories
          .reverse()
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")
      : "No prior context.";

  // Pull today's checkin status
  const today = new Date().toISOString().split("T")[0];
  const { data: checkin } = await supabase
    .from("checkins")
    .select("*")
    .eq("date", today)
    .single();

  const checkinContext = checkin
    ? `Today's study progress: ${checkin.topics_done}/${checkin.topics_total} topics done. Apps locked: ${checkin.apps_locked}.`
    : "No check-in data for today.";

  const systemPrompt = `You are AXIS, a personal AI productivity assistant. 
Generate a SHORT, punchy push notification for a CA student.
Time context: ${ctx.timeHint}
Tone: ${ctx.tone}
Notification type: ${type}
${userContext ? `Extra context: ${userContext}` : ""}

Recent AI memory:\n${memoryContext}
${checkinContext}

Return ONLY valid JSON with this shape:
{
  "title": "Short title (max 50 chars)",
  "body": "Notification body (max 120 chars)",
  "url": "/dashboard"
}
No markdown, no explanation, just JSON.`;

  const completion = await groq.chat.completions.create({
    model: "llama3-8b-8192",
    messages: [{ role: "user", content: systemPrompt }],
    temperature: 0.85,
    max_tokens: 200,
  });

  const raw = completion.choices[0]?.message?.content?.trim() || "{}";

  // Strip possible markdown fences
  const cleaned = raw.replace(/```json|```/gi, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = {
      title: `${ctx.emoji} AXIS`,
      body: "Time to check in on your goals.",
      url: "/dashboard",
    };
  }

  return {
    title: parsed.title || `${ctx.emoji} AXIS`,
    body: parsed.body || "Keep going.",
    url: parsed.url || "/dashboard",
    type,
    emoji: ctx.emoji,
  };
}

/**
 * Build the full webpush payload object.
 */
function buildPushPayload({ title, body, url, icon, badge, tag, actions }) {
  return {
    title: title || "AXIS",
    body: body || "",
    icon: icon || "/icons/icon-192x192.png",
    badge: badge || "/icons/badge-72x72.png",
    vibrate: [100, 50, 100, 50, 200],
    tag: tag || `axis-${Date.now()}`,
    url: url || "/",
    actions: actions || [
      { action: "open", title: "Open AXIS" },
      { action: "snooze", title: "Snooze 10m" },
      { action: "dismiss", title: "Dismiss" },
    ],
    timestamp: Date.now(),
  };
}

// ─── Boot: Restore scheduled jobs from DB ─────────────────────────────────────
async function restoreScheduledJobs() {
  const { data, error } = await supabase
    .from("settings")
    .select("*")
    .eq("key", "scheduled_notification")
    .order("created_at", { ascending: true });

  if (error) {
    console.warn("[AXIS Notify] Could not restore scheduled jobs:", error.message);
    return;
  }

  for (const row of data || []) {
    try {
      const job = JSON.parse(row.value);
      if (!job.cronExpr || !cron.validate(job.cronExpr)) continue;

      const task = cron.schedule(job.cronExpr, async () => {
        try {
          const content =
            job.ai
              ? await generateAINotification(job.type, job.context)
              : { title: job.title, body: job.body, url: job.url };

          const payload = buildPushPayload(content);
          await broadcastNotification(payload);
          console.log(`[AXIS Notify] Scheduled job ${row.id} fired.`);
        } catch (e) {
          console.error(`[AXIS Notify] Scheduled job ${row.id} error:`, e.message);
        }
      });

      scheduledJobs.set(row.id, task);
      console.log(`[AXIS Notify] Restored scheduled job id=${row.id}`);
    } catch {
      // skip malformed rows
    }
  }
}

restoreScheduledJobs().catch(console.error);

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/notify/vapid-public-key
 * Returns VAPID public key for frontend subscription.
 */
router.get("/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

/**
 * POST /api/notify/subscribe
 * Body: { subscription: PushSubscription }
 * Saves or updates subscription in Supabase.
 */
router.post("/subscribe", async (req, res) => {
  const { subscription, org_code } = req.body;

  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Invalid subscription object." });
  }

  const subscriptionStr =
    typeof subscription === "string"
      ? subscription
      : JSON.stringify(subscription);

  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      endpoint: subscription.endpoint,
      subscription: subscriptionStr,
      org_code: org_code || null,
    },
    { onConflict: "endpoint" }
  );

  if (error) {
    console.error("[AXIS Notify] Subscribe error:", error.message);
    return res.status(500).json({ error: "Failed to save subscription." });
  }

  return res.json({ success: true, message: "Subscribed successfully." });
});

/**
 * POST /api/notify/notify-live-test
 * Body: { orgCode, testTitle }
 * Notifies only subscribers belonging to the given org that a test just went live.
 */
router.post("/notify-live-test", async (req, res) => {
  const { orgCode, testTitle } = req.body;

  if (!orgCode) {
    return res.status(400).json({ error: "orgCode is required." });
  }

  try {
    const subscribers = await getSubscriptionsByOrg(orgCode);
    if (!subscribers.length) {
      return res.json({ success: true, sent: 0, failed: 0, removed: 0, message: "No subscribers for this org." });
    }

    const payload = buildPushPayload({
      title: "🔥 Your Test is Live! Hurry Up",
      body: testTitle ? `"${testTitle}" is now live. Attempt it now!` : "A new test just went live. Attempt it now!",
      url: "/dashboard.html",
      tag: `live-test-${orgCode}-${Date.now()}`,
      actions: [
        { action: "open", title: "Open Test" },
        { action: "dismiss", title: "Dismiss" },
      ],
    });

    const result = await broadcastNotification(payload, subscribers);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("[AXIS Notify] notify-live-test error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/notify/send
 * Body: { title, body, url, icon, badge, tag, actions }
 * Sends a custom notification to all subscribers.
 */
router.post("/send", async (req, res) => {
  const { title, body, url, icon, badge, tag, actions } = req.body;

  if (!title || !body) {
    return res.status(400).json({ error: "title and body are required." });
  }

  try {
    const payload = buildPushPayload({ title, body, url, icon, badge, tag, actions });
    const result = await broadcastNotification(payload);
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("[AXIS Notify] Send error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/notify/ai-notify
 * Body: { type, context }
 * Generates AI content then broadcasts to all subscribers.
 */
router.post("/ai-notify", async (req, res) => {
  const { type = "random", context = "" } = req.body;

  if (!NOTIFICATION_CONTEXTS[type]) {
    return res.status(400).json({
      error: `Invalid type. Must be one of: ${Object.keys(NOTIFICATION_CONTEXTS).join(", ")}`,
    });
  }

  try {
    const content = await generateAINotification(type, context);
    const payload = buildPushPayload(content);
    const result = await broadcastNotification(payload);

    // Store AI interaction in memory
    await supabase.from("ai_memory").insert({
      role: "assistant",
      content: `[${type} notification] ${content.title}: ${content.body}`,
      timestamp: new Date().toISOString(),
    });

    return res.json({ success: true, content, ...result });
  } catch (err) {
    console.error("[AXIS Notify] AI notify error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/notify/schedule
 * Body: { cronExpr, type, context, ai, title, body, url, label }
 * Schedules a recurring or one-time notification.
 */
router.post("/schedule", async (req, res) => {
  const {
    cronExpr,
    type = "random",
    context = "",
    ai = true,
    title,
    body,
    url,
    label = "Scheduled Notification",
  } = req.body;

  if (!cronExpr) {
    return res.status(400).json({ error: "cronExpr is required." });
  }

  if (!cron.validate(cronExpr)) {
    return res.status(400).json({ error: "Invalid cron expression." });
  }

  if (!ai && (!title || !body)) {
    return res.status(400).json({
      error: "title and body required when ai=false.",
    });
  }

  const jobData = { cronExpr, type, context, ai, title, body, url, label };

  // Persist to settings table
  const { data, error } = await supabase
    .from("settings")
    .insert({ key: "scheduled_notification", value: JSON.stringify(jobData) })
    .select("id")
    .single();

  if (error) {
    console.error("[AXIS Notify] Schedule insert error:", error.message);
    return res.status(500).json({ error: "Failed to persist schedule." });
  }

  const id = data.id;

  const task = cron.schedule(cronExpr, async () => {
    try {
      const content = ai
        ? await generateAINotification(type, context)
        : { title, body, url };

      const payload = buildPushPayload(content);
      await broadcastNotification(payload);
      console.log(`[AXIS Notify] Scheduled job ${id} fired.`);
    } catch (e) {
      console.error(`[AXIS Notify] Scheduled job ${id} error:`, e.message);
    }
  });

  scheduledJobs.set(id, task);
  console.log(`[AXIS Notify] Scheduled job id=${id} with cron: ${cronExpr}`);

  return res.json({ success: true, id, cronExpr, label });
});

/**
 * GET /api/notify/scheduled
 * Returns all scheduled notifications.
 */
router.get("/scheduled", async (req, res) => {
  const { data, error } = await supabase
    .from("settings")
    .select("id, value, created_at")
    .eq("key", "scheduled_notification")
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const jobs = (data || []).map((row) => {
    let parsed = {};
    try {
      parsed = JSON.parse(row.value);
    } catch {}
    return {
      id: row.id,
      created_at: row.created_at,
      active: scheduledJobs.has(row.id),
      ...parsed,
    };
  });

  return res.json({ jobs });
});

/**
 * DELETE /api/notify/scheduled/:id
 * Cancels and removes a scheduled notification.
 */
router.delete("/scheduled/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ error: "Invalid id." });
  }

  const task = scheduledJobs.get(id);
  if (task) {
    task.stop();
    scheduledJobs.delete(id);
  }

  const { error } = await supabase
    .from("settings")
    .delete()
    .eq("id", id)
    .eq("key", "scheduled_notification");

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json({ success: true, id, cancelled: !!task });
});

export default router;
