require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

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

cron.schedule('15 15 * * *', async () => {
  console.log('Afternoon briefing for', process.env.USER_NAME);
  try {
    const { data: topics } = await supabase.from('daily_topics').select('*').eq('date', new Date().toISOString().split('T')[0]).eq('completed', false);
    console.log('Pending topics today:', topics?.length || 0);
  } catch (err) {
    console.error('Cron error:', err.message);
  }
});

cron.schedule('0 21 * * *', async () => {
  console.log('Evening check-in triggered');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AXIS Backend running on port ${PORT}`);
  console.log(`User: ${process.env.USER_NAME}`);
});
