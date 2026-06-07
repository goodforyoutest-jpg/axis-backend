const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const sendPushToAll = async (title, body) => {
  const { data: subs } = await supabase.from('push_subscriptions').select('*');
  if (!subs || subs.length === 0) return;
  const payload = JSON.stringify({ title, body });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(JSON.parse(sub.subscription), payload);
    } catch (e) {
      if (e.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      }
    }
  }
};

router.post('/subscribe', async (req, res) => {
  try {
    const subscription = req.body;
    const { error } = await supabase.from('push_subscriptions').upsert(
      { endpoint: subscription.endpoint, subscription: JSON.stringify(subscription) },
      { onConflict: 'endpoint' }
    );
    if (error) throw error;
    await sendPushToAll('AXIS Activated', 'Notifications are now enabled. I will keep you accountable, Gajanan.');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.post('/send', async (req, res) => {
  try {
    const { title, body } = req.body;
    await sendPushToAll(title, body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/ai-notify', async (req, res) => {
  try {
    const { type } = req.body;
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffset);
    const timeStr = ist.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    const { data: checkin } = await supabase.from('checkins').select('*').eq('date', now.toISOString().split('T')[0]).single();
    const { data: topics } = await supabase.from('timetable').select('*').eq('date', now.toISOString().split('T')[0]);
    const done = topics?.filter(t => t.completed).length || 0;
    const total = topics?.length || 0;

    const prompts = {
      morning: `Generate a strict morning study briefing for Gajanan. Current time: ${timeStr}. Today has ${total} topics scheduled. Be motivating but strict. Under 80 words.`,
      afternoon: `Generate a post-coaching study reminder for Gajanan. Time: ${timeStr}. Coaching just ended. ${total} topics to cover today. Push him to start immediately. Under 70 words.`,
      evening: `Generate evening check-in for Gajanan. Time: ${timeStr}. He completed ${done}/${total} topics today. ${done < total ? 'Be strict about incomplete work.' : 'Appreciate him as Gaju.'} Under 70 words.`,
      random: `Generate a random strict CA Foundation study reminder for Gajanan. Time: ${timeStr}. Can mention specific topics, exam pressure, or accountability. Punchy and direct. Under 50 words.`,
      lock: `Generate app lock warning for Gajanan. Time: ${timeStr}. Study not complete. ${done}/${total} topics done. Apps being locked now. Strict and direct. Under 40 words.`
    };

    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: `You are AXIS, strict CA Foundation accountability AI for Gajanan.` },
        { role: 'user', content: prompts[type] || prompts.random }
      ],
      max_tokens: 150,
    });

    const message = response.choices[0].message.content;
    const titles = {
      morning: '☀️ Good Morning, Gajanan',
      afternoon: '📚 Time to Study',
      evening: done >= total ? '⭐ Evening Check-in' : '⚠️ Study Incomplete',
      random: '📌 AXIS Reminder',
      lock: '🔒 Apps Locked'
    };

    await sendPushToAll(titles[type] || 'AXIS', message);
    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
