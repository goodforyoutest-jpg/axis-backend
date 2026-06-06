const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

router.post('/subscribe', async (req, res) => {
  try {
    const subscription = req.body;
    const { error } = await supabase.from('push_subscriptions').upsert({ endpoint: subscription.endpoint, subscription: JSON.stringify(subscription) });
    if (error) throw error;
    res.json({ success: true, message: 'Subscribed to notifications' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/send', async (req, res) => {
  try {
    const { title, body } = req.body;
    const { data: subs } = await supabase.from('push_subscriptions').select('*');
    const payload = JSON.stringify({ title, body });
    for (const sub of subs || []) {
      await webpush.sendNotification(JSON.parse(sub.subscription), payload);
    }
    res.json({ success: true, message: 'Notification sent' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
