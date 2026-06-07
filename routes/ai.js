const express = require('express');
const router = express.Router();
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const SYSTEM_PROMPT = `You are AXIS, a strict personal AI assistant for Gajanan, a CA Foundation student preparing for May 2027 exam. You are like a strict teacher - direct, no sugarcoating, real accountability. When he completes study targets call him 'Gaju' as appreciation.

You have FULL CONTROL of the app. When the user asks you to do something in the app, respond with a JSON action block alongside your message.

Available actions:
- add_task: {"action":"add_task","title":"...","type":"study|general|email|personal","priority":"high|medium|low","due_date":"YYYY-MM-DD"}
- set_app_limit: {"action":"set_app_limit","app_name":"...","daily_limit_minutes":30,"is_timepass":true}
- update_coaching: {"action":"update_coaching","days":["Mon","Tue"],"start_time":"07:00","end_time":"15:00"}
- generate_timetable: {"action":"generate_timetable","hours_per_day":2}
- lock_apps: {"action":"lock_apps"}

When performing an action, include it in your response like this:
[ACTION:{"action":"add_task","title":"Study Accounting Chapter 1","type":"study","priority":"high"}]

Be strict, caring, and always focused on CA Foundation preparation. Never let Gajanan slack off.`;

router.post('/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: context ? `App Context: ${JSON.stringify(context)}\n\nUser: ${message}` : message }
      ],
      max_tokens: 1000,
    });

    const reply = response.choices[0].message.content;
    const actionMatch = reply.match(/\[ACTION:(.*?)\]/s);
    let action = null;
    let cleanReply = reply;

    if (actionMatch) {
      try {
        action = JSON.parse(actionMatch[1]);
        cleanReply = reply.replace(/\[ACTION:.*?\]/s, '').trim();

        if (action.action === 'add_task') {
          await supabase.from('tasks').insert({
            title: action.title, type: action.type || 'general',
            priority: action.priority || 'medium', due_date: action.due_date || null
          });
        } else if (action.action === 'set_app_limit') {
          await supabase.from('app_limits').upsert({
            app_name: action.app_name, daily_limit_minutes: action.daily_limit_minutes, is_timepass: action.is_timepass
          });
        } else if (action.action === 'update_coaching') {
          await supabase.from('settings').upsert({
            key: 'coaching', value: JSON.stringify({ days: action.days, start_time: action.start_time, end_time: action.end_time })
          });
        }
      } catch (e) {
        console.error('Action error:', e.message);
      }
    }

    res.json({ success: true, reply: cleanReply, action });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/analyse', async (req, res) => {
  try {
    const { type, data } = req.body;
    let prompt = '';
    if (type === 'email') prompt = `Analyse these emails and categorise as urgent/study-related/ignore. Prioritise ICAI emails. Emails: ${JSON.stringify(data)}`;
    if (type === 'progress') prompt = `Analyse this study progress and give strict honest feedback. Data: ${JSON.stringify(data)}`;
    if (type === 'timetable') prompt = `Review this timetable for CA Foundation preparation. Data: ${JSON.stringify(data)}`;
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }],
      max_tokens: 1500,
    });
    res.json({ success: true, analysis: response.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
