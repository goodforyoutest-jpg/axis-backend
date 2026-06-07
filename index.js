require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const studyRoutes = require('./routes/study');
const aiRoutes = require('./routes/ai');
const scheduleRoutes = require('./routes/schedule');
const notifyRoutes = require('./routes/notify');

app.use('/api/study', studyRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/notify', notifyRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'AXIS is running', user: process.env.USER_NAME, time: new Date().toISOString() });
});

const triggerNotification = async (type) => {
  try {
    const BASE = `http://localhost:${process.env.PORT || 3000}`;
    await axios.post(`${BASE}/api/notify/ai-notify`, { type });
    console.log(`Notification sent: ${type}`);
  } catch (e) {
    console.error('Notification error:', e.message);
  }
};

// Morning briefing - 7:00 AM IST (1:30 AM UTC)
cron.schedule('30 1 * * *', () => triggerNotification('morning'));

// After coaching ends - 3:15 PM IST (9:45 AM UTC)
cron.schedule('45 9 * * 1-6', () => triggerNotification('afternoon'));

// Evening check-in - 9:00 PM IST (3:30 PM UTC)
cron.schedule('30 15 * * *', () => triggerNotification('evening'));

// Random study reminders - every 2 hours between 3PM-10PM IST
cron.schedule('0 10,12,14 * * *', () => triggerNotification('random'));

// App lock check - 10:00 PM IST (4:30 PM UTC)
cron.schedule('30 16 * * *', async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: checkin } = await supabase.from('checkins').select('*').eq('date', today).single();
    if (!checkin || !checkin.completed) {
      await triggerNotification('lock');
    }
  } catch (e) {
    console.error('Lock check error:', e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AXIS Backend running on port ${PORT}`);
  console.log(`User: ${process.env.USER_NAME}`);
  console.log(`Notifications: Scheduled`);
});
