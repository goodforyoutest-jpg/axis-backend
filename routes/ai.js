const express = require('express');
const router = express.Router();
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const getSystemPrompt = () => {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  const dateStr = ist.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const timeStr = ist.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  return `You are AXIS, a strict personal AI assistant for Gajanan, a CA Foundation student.

CURRENT DATE & TIME (IST): ${dateStr}, ${timeStr}

CA FOUNDATION COMPLETE SYLLABUS:
Paper 1 - Principles & Practice of Accounting (100 marks):
- Theoretical Framework, Accounting Process, Bank Reconciliation
- Inventories, Depreciation, Bills of Exchange, Final Accounts
- Partnership Accounts, Company Accounts, Basic Computerised Accounting

Paper 2 - Business Laws (60 marks) & Business Correspondence (40 marks):
- Indian Contract Act 1872, Sale of Goods Act 1930
- Indian Partnership Act 1932, LLP Act 2008
- Companies Act 2013 Basics, Negotiable Instruments Act
- Business Letters, Reports, Emails, Communication Skills

Paper 3 - Quantitative Aptitude (60 marks) & Business Economics (40 marks):
- Ratio, Proportion, Indices, Logarithms
- Equations, Inequalities, Matrices, Determinants
- Sequence & Series, Sets, Relations, Functions
- Statistics, Probability, Theoretical Distributions
- Demand & Supply, Elasticity, Production, Cost
- Market Structures, Indian Economy, Money & Banking

Paper 4 - Business Economics (60 marks) & Business & Commercial Knowledge (40 marks):
- Nature & Scope of Economics, Micro & Macro
- Business Cycles, National Income, Fiscal Policy
- Business Environment, Forms of Business Organisation
- Government Policies, International Trade Basics

EXAM DETAILS:
- Next Exam: May 2027 (approximately 11 months away)
- Pattern: 4 papers, all objective + descriptive
- Passing: 40% per paper, 50% aggregate
- Negative marking applies in objective sections

GAJANAN'S SCHEDULE:
- Coaching: Monday to Saturday, 7AM to 3PM
- Self study: Evenings after 3PM
- Current study hours ramp: Week 1=1hr, Week 2=2hr... up to 6hr/day
- Started: June 2026

YOU HAVE FULL APP CONTROL. Available actions (include in response as [ACTION:{...}]):
- add_task: {"action":"add_task","title":"...","type":"study|general|email|personal","priority":"high|medium|low","due_date":"YYYY-MM-DD"}
- set_app_limit: {"action":"set_app_limit","app_name":"...","daily_limit_minutes":30,"is_timepass":true}
- update_coaching: {"action":"update_coaching","days":["Mon","Tue"],"start_time":"07:00","end_time":"15:00"}
- generate_timetable: {"action":"generate_timetable","hours_per_day":2}
- send_notification: {"action":"send_notification","title":"...","body":"..."}
- lock_apps: {"action":"lock_apps"}
- delete_task: {"action":"delete_task","id":"..."}
- complete_task: {"action":"complete_task","id":"..."}

PERSONALITY:
- Strict teacher, no sugarcoating
- Call him 'Gaju' only when he completes targets
- Always push him to study more
- Never let him slack off
- Be direct and specific about CA Foundation topics
- Give topic-specific advice based on syllabus above`;
};

router.post('/chat', async (req, res) => {
  try {
    const { message, context } = req.body;

    // Get live app data to give AI full context
    const [tasksRes, timetableRes, appLimitsRes, checkinRes] = await Promise.all([
      supabase.from('tasks').select('*').eq('completed', false),
      supabase.from('timetable').select('*').eq('date', new Date().toISOString().split('T')[0]),
      supabase.from('app_limits').select('*'),
      supabase.from('checkins').select('*').eq('date', new Date().toISOString().split('T')[0])
    ]);

    const appContext = {
      pending_tasks: tasksRes.data || [],
      todays_topics: timetableRes.data || [],
      app_limits: appLimitsRes.data || [],
      todays_checkin: checkinRes.data?.[0] || null,
      user_context: context || {}
    };

    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: getSystemPrompt() },
        { role: 'user', content: `Live App Data: ${JSON.stringify(appContext)}\n\nUser: ${message}` }
      ],
      max_tokens: 1200,
    });

    const reply = response.choices[0].message.content;
    const actionMatch = reply.match(/\[ACTION:(.*?)\]/s);
    let action = null;
    let cleanReply = reply.replace(/\[ACTION:.*?\]/s, '').trim();

    if (actionMatch) {
      try {
        action = JSON.parse(actionMatch[1]);

        if (action.action === 'add_task') {
          await supabase.from('tasks').insert({ title: action.title, type: action.type || 'general', priority: action.priority || 'medium', due_date: action.due_date || null });
        } else if (action.action === 'set_app_limit') {
          await supabase.from('app_limits').upsert({ app_name: action.app_name, daily_limit_minutes: action.daily_limit_minutes, is_timepass: action.is_timepass !== false });
        } else if (action.action === 'update_coaching') {
          await supabase.from('settings').upsert({ key: 'coaching', value: JSON.stringify({ days: action.days, start_time: action.start_time, end_time: action.end_time }) }, { onConflict: 'key' });
        } else if (action.action === 'delete_task') {
          await supabase.from('tasks').delete().eq('id', action.id);
        } else if (action.action === 'complete_task') {
          await supabase.from('tasks').update({ completed: true }).eq('id', action.id);
        } else if (action.action === 'lock_apps') {
          await supabase.from('checkins').upsert({ date: new Date().toISOString().split('T')[0], apps_locked: true, completed: false }, { onConflict: 'date' });
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
    if (type === 'email') prompt = `Analyse these emails for Gajanan. Categorise as urgent/study-related/ignore. Flag any ICAI emails immediately. Emails: ${JSON.stringify(data)}`;
    if (type === 'progress') prompt = `Analyse Gajanan's study progress. Be brutally honest. Give specific advice on weak areas. Data: ${JSON.stringify(data)}`;
    if (type === 'timetable') prompt = `Review this CA Foundation timetable. Suggest improvements based on exam pattern and marks weightage. Data: ${JSON.stringify(data)}`;
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: getSystemPrompt() }, { role: 'user', content: prompt }],
      max_tokens: 1500,
    });
    res.json({ success: true, analysis: response.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/notify', async (req, res) => {
  try {
    const { type } = req.body;
    const prompts = {
      morning: `Generate a strict morning study briefing for Gajanan. Include today's topics, motivational push, and warning about app locks if study not done. Keep it under 100 words.`,
      evening: `Generate an evening check-in message for Gajanan. Ask if he completed his study targets. Be strict. Under 80 words.`,
      random: `Generate a random strict study reminder for Gajanan. Can be about any CA Foundation topic, exam pressure, or accountability. Make it punchy. Under 60 words.`,
      lock: `Generate a strict app lock warning for Gajanan. He hasn't completed his study target. Apps are being locked. Under 50 words.`
    };
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: getSystemPrompt() }, { role: 'user', content: prompts[type] || prompts.random }],
      max_tokens: 200,
    });
    res.json({ success: true, message: response.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
