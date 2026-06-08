// FILE: routes/ai.js
import express from 'express';
const router = express.Router();
import { createClient } from '@supabase/supabase-js';
import Groq from 'groq-sdk';
import axios from 'axios';
import webpush from 'web-push';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ─── Helpers ────────────────────────────────────────────────────────────────

function getISTDateTime() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  return {
    date: ist.toISOString().split('T')[0],
    time: ist.toTimeString().split(' ')[0].slice(0, 5),
    day: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][ist.getDay()],
    full: ist.toISOString().replace('T', ' ').slice(0, 19) + ' IST'
  };
}

async function getMemory(limit = 40) {
  const { data, error } = await supabase
    .from('ai_memory')
    .select('role, content')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) return [];
  return data || [];
}

async function saveMemory(role, content) {
  const ist = getISTDateTime();
  await supabase.from('ai_memory').insert({
    role,
    content,
    timestamp: ist.full,
    created_at: new Date().toISOString()
  });
}

async function getAIContext() {
  const { data } = await supabase.from('ai_context').select('key, value');
  const ctx = {};
  if (data) data.forEach(r => { ctx[r.key] = r.value; });
  return ctx;
}

async function setAIContext(key, value) {
  await supabase.from('ai_context').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
}

async function webSearch(query) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
    const { data } = await axios.get(url, { timeout: 6000 });
    const results = [];
    if (data.AbstractText) results.push(`Summary: ${data.AbstractText}`);
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      data.RelatedTopics.slice(0, 5).forEach(t => {
        if (t.Text) results.push(`• ${t.Text}`);
      });
    }
    if (data.Answer) results.push(`Direct Answer: ${data.Answer}`);
    return results.length ? results.join('\n') : 'No results found.';
  } catch (err) {
    return `Web search failed: ${err.message}`;
  }
}

async function getTodayContext() {
  const ist = getISTDateTime();
  const { data: todayTopics } = await supabase
    .from('timetable')
    .select('subject, topic, duration_minutes, completed')
    .eq('date', ist.date);
  const { data: checkin } = await supabase
    .from('checkins')
    .select('*')
    .eq('date', ist.date)
    .single();
  const { data: tasks } = await supabase
    .from('tasks')
    .select('*')
    .eq('completed', false)
    .order('priority', { ascending: true })
    .limit(10);
  const { data: appLimits } = await supabase
    .from('app_limits')
    .select('*');
  return { todayTopics: todayTopics || [], checkin, tasks: tasks || [], appLimits: appLimits || [] };
}

// ─── Action Executor ────────────────────────────────────────────────────────

async function executeAction(action) {
  try {
    switch (action.action) {
      case 'add_task': {
        await supabase.from('tasks').insert({
          title: action.title,
          description: action.description || '',
          type: action.type || 'general',
          priority: action.priority || 'medium',
          completed: false,
          due_date: action.due_date || null,
          created_at: new Date().toISOString()
        });
        return 'Task added.';
      }
      case 'delete_task': {
        await supabase.from('tasks').delete().eq('id', action.id);
        return 'Task deleted.';
      }
      case 'complete_task': {
        await supabase.from('tasks').update({ completed: true }).eq('id', action.id);
        return 'Task marked complete.';
      }
      case 'set_app_limit': {
        await supabase.from('app_limits').upsert({
          app_name: action.app_name,
          daily_limit_minutes: action.daily_limit_minutes,
          is_timepass: action.is_timepass || false,
          created_at: new Date().toISOString()
        }, { onConflict: 'app_name' });
        return `App limit set for ${action.app_name}.`;
      }
      case 'update_coaching': {
        await setAIContext('coaching_days', JSON.stringify(action.days));
        await setAIContext('coaching_start', action.start_time);
        await setAIContext('coaching_end', action.end_time);
        return 'Coaching schedule updated.';
      }
      case 'generate_timetable': {
        // Trigger timetable generation (handled separately via POST /api/study/generate)
        return 'Timetable generation queued.';
      }
      case 'send_notification': {
        const { data: subs } = await supabase.from('push_subscriptions').select('subscription');
        if (subs && subs.length > 0) {
          const payload = JSON.stringify({ title: action.title, body: action.body });
          for (const row of subs) {
            try {
              await webpush.sendNotification(row.subscription, payload);
            } catch (e) { /* skip failed subs */ }
          }
        }
        return 'Notification sent.';
      }
      case 'lock_apps': {
        await setAIContext('apps_locked', 'true');
        return 'Apps locked.';
      }
      case 'unlock_apps': {
        await setAIContext('apps_locked', 'false');
        return 'Apps unlocked.';
      }
      case 'web_search': {
        return await webSearch(action.query);
      }
      case 'set_timer': {
        await supabase.from('tasks').insert({
          title: `⏱ Timer: ${action.label}`,
          description: `${action.duration_minutes} minute timer`,
          type: 'timer',
          priority: 'high',
          completed: false,
          due_date: null,
          created_at: new Date().toISOString()
        });
        return `Timer set for ${action.duration_minutes} minutes: ${action.label}`;
      }
      case 'create_note': {
        await supabase.from('tasks').insert({
          title: action.title,
          description: action.content,
          type: 'note',
          priority: 'low',
          completed: false,
          due_date: null,
          created_at: new Date().toISOString()
        });
        return 'Note created.';
      }
      case 'create_calendar_event': {
        await supabase.from('timetable').insert({
          date: action.date,
          subject: 'Event',
          topic: action.title,
          duration_minutes: action.duration_minutes || 60,
          week_number: 0,
          completed: false,
          created_at: new Date().toISOString()
        });
        return `Calendar event created: ${action.title}`;
      }
      case 'update_memory': {
        await setAIContext(action.key, action.value);
        return `Memory updated: ${action.key}`;
      }
      default:
        return `Unknown action: ${action.action}`;
    }
  } catch (err) {
    return `Action failed: ${err.message}`;
  }
}

// ─── Action Parser ──────────────────────────────────────────────────────────

function parseAndStripActions(text) {
  const actions = [];
  const pattern = /\[ACTION:\{([^}]+(?:\{[^}]*\}[^}]*)*)\}\]/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    try {
      const jsonStr = '{' + match[1] + '}';
      const action = JSON.parse(jsonStr);
      actions.push(action);
    } catch (e) {
      try {
        const full = match[0].slice(8, -1);
        const action = JSON.parse(full);
        actions.push(action);
      } catch (e2) { /* skip malformed */ }
    }
  }
  const cleaned = text.replace(/\[ACTION:\{[^}]+(?:\{[^}]*\}[^}]*)*\}\]/g, '').trim();
  return { actions, cleaned };
}

// ─── System Prompt ──────────────────────────────────────────────────────────

function buildSystemPrompt(ist, todayCtx, userContext) {
  const { todayTopics, checkin, tasks, appLimits } = todayCtx;
  const completedTopics = todayTopics.filter(t => t.completed).length;
  const totalTopics = todayTopics.length;

  return `You are AXIS — a highly intelligent, disciplined personal AI assistant built exclusively for Gajanan Dhobale, a CA Foundation student preparing for the May 2027 exam. You are not a general chatbot. You are Gajanan's study partner, productivity enforcer, and life organizer.

═══════════════════════════════════════
CURRENT DATE & TIME: ${ist.full} (${ist.day})
═══════════════════════════════════════

YOUR PERSONALITY:
- Direct, motivating, no-nonsense
- Use simple Hindi phrases occasionally (e.g., "Chalo bhai", "Ekdum sahi")
- Sound like a strict but caring mentor
- Never flatter unnecessarily — give honest assessments
- Format responses like ChatGPT: numbered lists, bullet points, clear paragraphs

═══════════════════════════════════════
ABOUT GAJANAN:
${userContext.about_gajanan || 'CA Foundation student, solo builder at Good for You (growforyou.in), preparing for May 2027 exam'}
${userContext.coaching_days ? `Coaching Days: ${userContext.coaching_days}` : ''}
${userContext.coaching_start ? `Coaching Time: ${userContext.coaching_start} - ${userContext.coaching_end}` : ''}
${userContext.extra_context || ''}
═══════════════════════════════════════

TODAY'S STATUS:
- Topics Scheduled: ${totalTopics}
- Topics Completed: ${completedTopics}/${totalTopics}
- Check-in Done: ${checkin ? 'Yes' : 'No'}
- Apps Locked: ${userContext.apps_locked === 'true' ? 'YES' : 'No'}

TODAY'S SCHEDULE:
${todayTopics.length > 0 ? todayTopics.map(t => `  ${t.completed ? '✓' : '○'} ${t.subject}: ${t.topic} (${t.duration_minutes} min)`).join('\n') : '  No topics scheduled today'}

PENDING TASKS:
${tasks.length > 0 ? tasks.map(t => `  [${t.priority.toUpperCase()}] ${t.title} — ${t.type}`).join('\n') : '  No pending tasks'}

APP LIMITS CONFIGURED:
${appLimits.length > 0 ? appLimits.map(a => `  ${a.app_name}: ${a.daily_limit_minutes} min/day ${a.is_timepass ? '(timepass)' : ''}`).join('\n') : '  None set'}

═══════════════════════════════════════
CA FOUNDATION SYLLABUS:

PAPER 1: PRINCIPLES & PRACTICE OF ACCOUNTING (100 marks)
1. Theoretical Framework — Accounting Concepts, Accounting Standards
2. Accounting Process — Journal, Ledger, Trial Balance
3. Bank Reconciliation Statement
4. Inventories — FIFO, Weighted Average
5. Concept & Accounting of Depreciation
6. Accounting for Special Transactions — Bills, Consignment, Joint Venture, SOP
7. Final Accounts of Sole Proprietors
8. Partnership Accounts — Admission, Retirement, Death, Dissolution
9. Financial Statements of Not-for-Profit Organisations
10. Company Accounts — Issue of Shares & Debentures
11. Basic Accounting Ratios
12. Computers in Accounting

PAPER 2: BUSINESS LAW (60 marks) + BUSINESS CORRESPONDENCE (40 marks)
Business Law:
1. Indian Contract Act 1872 — Essentials, Types, Consideration, Performance, Breach
2. Sale of Goods Act 1930
3. Indian Partnership Act 1932
4. Limited Liability Partnership Act 2008
5. Companies Act 2013 — Introduction
6. Negotiable Instruments Act 1881

Business Correspondence:
1. Communication — Basics, Types, Barriers
2. Business Letters — Inquiry, Order, Complaint, Adjustment
3. Report Writing
4. Précis Writing
5. E-Correspondence

PAPER 3: BUSINESS MATHEMATICS & LOGICAL REASONING & STATISTICS (100 marks)
Business Mathematics:
1. Ratio & Proportion, Indices, Logarithms
2. Equations — Linear, Quadratic, Simultaneous
3. Linear Inequalities
4. Time Value of Money — SI, CI, Annuity, EMI, NPV
5. Permutations & Combinations
6. Sets & Functions
7. Basic Calculus — Differentiation, Integration

Logical Reasoning:
1. Number Series, Coding-Decoding
2. Direction Tests, Seating Arrangement
3. Blood Relations
4. Syllogism

Statistics:
1. Statistical Description of Data
2. Measures of Central Tendency — AM, GM, HM, Median, Mode
3. Measures of Dispersion — Range, QD, MD, SD, CV
4. Correlation & Regression
5. Index Numbers
6. Probability
7. Theoretical Distributions — Binomial, Poisson, Normal

PAPER 4: BUSINESS ECONOMICS (60 marks) + BUSINESS & COMMERCIAL KNOWLEDGE (40 marks)
Business Economics:
1. Introduction to Business Economics
2. Theory of Demand & Supply
3. Theory of Production & Cost
4. Price Determination in Different Markets
5. Business Cycles
6. Money Market — Banking System, RBI
7. Indian Economy (Pre & Post 1991)

Business & Commercial Knowledge:
1. Introduction to Business
2. Business Environment
3. Money & Finance
4. Infrastructure & Business
5. International Business

═══════════════════════════════════════
ACTIONS YOU CAN PERFORM:
When you need to take an action, embed it in your response as [ACTION:{...}].
IMPORTANT: Actions are parsed and executed silently — NEVER show raw action tags to user.
Format them as: [ACTION:{"action":"action_name", ...other fields...}]

Available actions:
- add_task: {"action":"add_task","title":"...","description":"...","type":"study|general|reminder|timer|note","priority":"high|medium|low","due_date":"YYYY-MM-DD"}
- delete_task: {"action":"delete_task","id":123}
- complete_task: {"action":"complete_task","id":123}
- set_app_limit: {"action":"set_app_limit","app_name":"Instagram","daily_limit_minutes":30,"is_timepass":true}
- update_coaching: {"action":"update_coaching","days":["Monday","Wednesday","Friday"],"start_time":"16:00","end_time":"18:00"}
- send_notification: {"action":"send_notification","title":"Study Time!","body":"Chapter 5 revision now"}
- lock_apps: {"action":"lock_apps"}
- unlock_apps: {"action":"unlock_apps"}
- web_search: {"action":"web_search","query":"CA Foundation exam date 2027"}
- set_timer: {"action":"set_timer","duration_minutes":25,"label":"Pomodoro - Accounting"}
- create_note: {"action":"create_note","title":"Key Formula","content":"..."}
- create_calendar_event: {"action":"create_calendar_event","title":"Mock Test","date":"2027-02-15","time":"09:00","duration_minutes":180}
- update_memory: {"action":"update_memory","key":"weak_subjects","value":"Statistics, Partnership Accounts"}

RESPONSE FORMAT RULES:
1. Always structured — use numbered lists or bullets for multiple items
2. Never show [ACTION:{...}] tags in visible response
3. Be specific, not vague
4. When done performing an action, briefly confirm it (e.g., "Done — I've added that task for you.")
5. Keep study advice subject-specific (use actual CA Foundation syllabus terms)
6. If today's schedule is incomplete, motivate Gajanan to finish

═══════════════════════════════════════`;
}

// ─── POST /api/ai/chat ──────────────────────────────────────────────────────

router.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const ist = getISTDateTime();
    const [memory, todayCtx, userContext] = await Promise.all([
      getMemory(40),
      getTodayContext(),
      getAIContext()
    ]);

    const systemPrompt = buildSystemPrompt(ist, todayCtx, userContext);

    // Build messages array
    const messages = [
      { role: 'system', content: systemPrompt },
      ...memory,
      { role: 'user', content: message }
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.7,
      max_tokens: 1500
    });

    const rawResponse = completion.choices[0]?.message?.content || 'No response generated.';

    // Parse and execute actions
    const { actions, cleaned } = parseAndStripActions(rawResponse);

    const actionResults = [];
    for (const action of actions) {
      // Handle web_search specially — inject results into response
      if (action.action === 'web_search') {
        const searchResults = await webSearch(action.query);
        actionResults.push({ action: 'web_search', result: searchResults });
      } else {
        const result = await executeAction(action);
        actionResults.push({ action: action.action, result });
      }
    }

    // If web search was performed, append results to response
    let finalResponse = cleaned;
    const searchResult = actionResults.find(r => r.action === 'web_search');
    if (searchResult) {
      finalResponse += `\n\n**Web Search Results:**\n${searchResult.result}`;
    }

    // Save to memory
    await saveMemory('user', message);
    await saveMemory('assistant', finalResponse);

    res.json({
      response: finalResponse,
      actions_executed: actionResults.map(r => ({ action: r.action, status: 'done' })),
      timestamp: ist.full
    });

  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/analyse ───────────────────────────────────────────────────

router.post('/analyse', async (req, res) => {
  try {
    const { type, data } = req.body;
    // type: 'progress' | 'timetable' | 'email' | 'custom'
    const ist = getISTDateTime();
    const userContext = await getAIContext();

    let analysisPrompt = '';

    if (type === 'progress') {
      const { data: weekTopics } = await supabase
        .from('timetable')
        .select('*')
        .gte('date', new Date(Date.now() - 7 * 24 * 3600000).toISOString().split('T')[0]);

      const { data: recentCheckins } = await supabase
        .from('checkins')
        .select('*')
        .order('date', { ascending: false })
        .limit(7);

      const totalThisWeek = weekTopics?.length || 0;
      const completedThisWeek = weekTopics?.filter(t => t.completed).length || 0;
      const checkinRate = recentCheckins?.filter(c => c.completed).length || 0;

      analysisPrompt = `Analyse Gajanan's study progress for this week.
Data:
- Topics this week: ${totalThisWeek}, Completed: ${completedThisWeek}
- Check-in completion this week: ${checkinRate}/7 days
- Recent timetable: ${JSON.stringify(weekTopics?.slice(0, 20))}
- Recent checkins: ${JSON.stringify(recentCheckins)}

Give a detailed analysis:
1. Overall performance score (out of 10)
2. Subject-wise breakdown
3. What's going well
4. What needs urgent attention
5. Specific action plan for next 7 days
Be direct and honest. Use CA Foundation subject names specifically.`;

    } else if (type === 'timetable') {
      const { data: upcoming } = await supabase
        .from('timetable')
        .select('*')
        .gte('date', ist.date)
        .order('date', { ascending: true })
        .limit(30);

      analysisPrompt = `Review and analyse Gajanan's upcoming timetable for the next 30 days.
Data: ${JSON.stringify(upcoming)}

Provide:
1. Is the subject distribution balanced? (based on CA Foundation weightage)
2. Are revision sessions included?
3. Suggestions to improve the schedule
4. Any bottlenecks or overloaded days
5. Recommended changes`;

    } else {
      analysisPrompt = `Analyse the following for Gajanan (CA Foundation student, May 2027 exam):
${data || 'No data provided'}

Current date: ${ist.full}
Give structured, actionable analysis.`;
    }

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: `You are AXIS, Gajanan's AI assistant. Current time: ${ist.full}. Be analytical, specific, and actionable.` },
        { role: 'user', content: analysisPrompt }
      ],
      temperature: 0.4,
      max_tokens: 2000
    });

    const analysis = completion.choices[0]?.message?.content || 'Analysis failed.';

    res.json({ analysis, type, timestamp: ist.full });

  } catch (err) {
    console.error('AI analyse error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/notify ────────────────────────────────────────────────────

router.post('/notify', async (req, res) => {
  try {
    const { trigger } = req.body;
    // trigger: 'morning' | 'evening' | 'break' | 'custom'
    const ist = getISTDateTime();
    const todayCtx = await getTodayContext();
    const { todayTopics, checkin } = todayCtx;
    const completedTopics = todayTopics.filter(t => t.completed).length;

    const notifyPrompts = {
      morning: `Generate a motivating morning notification for Gajanan.
Today: ${ist.day}, ${ist.date}
Topics scheduled today: ${todayTopics.length}
Respond with JSON: {"title":"...","body":"..."} — max 60 chars for title, 120 for body. Be punchy and motivating.`,
      evening: `Generate an evening review notification.
Topics completed: ${completedTopics}/${todayTopics.length}
Checkin done: ${checkin ? 'Yes' : 'No'}
Respond with JSON: {"title":"...","body":"..."}`,
      break: `Generate a "take a break" or "get back to study" notification.
Respond with JSON: {"title":"...","body":"..."}`,
      custom: `Generate a smart notification for Gajanan based on current context.
Time: ${ist.time}, Day: ${ist.day}
Progress: ${completedTopics}/${todayTopics.length} topics done
Respond with JSON: {"title":"...","body":"..."}`
    };

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'You generate push notifications. Respond with valid JSON only, no markdown.' },
        { role: 'user', content: notifyPrompts[trigger] || notifyPrompts.custom }
      ],
      temperature: 0.8,
      max_tokens: 200
    });

    let notifData = { title: 'AXIS', body: 'Stay focused, Gajanan!' };
    try {
      const raw = completion.choices[0]?.message?.content || '{}';
      notifData = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) { /* use default */ }

    // Send to all push subscribers
    const { data: subs } = await supabase.from('push_subscriptions').select('subscription');
    let sent = 0;
    if (subs && subs.length > 0) {
      const payload = JSON.stringify(notifData);
      for (const row of subs) {
        try {
          await webpush.sendNotification(row.subscription, payload);
          sent++;
        } catch (e) {
          if (e.statusCode === 410) {
            await supabase.from('push_subscriptions').delete().eq('endpoint', row.subscription.endpoint);
          }
        }
      }
    }

    res.json({ notification: notifData, sent, timestamp: ist.full });

  } catch (err) {
    console.error('AI notify error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/ai/search ────────────────────────────────────────────────────

router.post('/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });

    const results = await webSearch(query);
    const ist = getISTDateTime();

    // Ask AI to summarise search results in context of CA Foundation
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: `You are AXIS. Summarise search results for Gajanan (CA Foundation student). Be concise and relevant. Current time: ${ist.full}` },
        { role: 'user', content: `Query: "${query}"\n\nSearch Results:\n${results}\n\nProvide a clean, structured summary relevant to CA Foundation studies.` }
      ],
      temperature: 0.3,
      max_tokens: 800
    });

    const summary = completion.choices[0]?.message?.content || results;

    res.json({ query, raw_results: results, summary, timestamp: ist.full });

  } catch (err) {
    console.error('AI search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/ai/memory ─────────────────────────────────────────────────────

router.get('/memory', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const { data, error } = await supabase
      .from('ai_memory')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    const { data: contextData } = await supabase.from('ai_context').select('*');

    res.json({
      memory: data || [],
      context: contextData || [],
      total: data?.length || 0
    });
  } catch (err) {
    console.error('Get memory error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/ai/memory ──────────────────────────────────────────────────

router.delete('/memory', async (req, res) => {
  try {
    const { confirm } = req.body;
    if (confirm !== true) {
      return res.status(400).json({ error: 'Send { confirm: true } to clear memory' });
    }

    await supabase.from('ai_memory').delete().neq('id', 0);

    res.json({ success: true, message: 'AI memory cleared.' });
  } catch (err) {
    console.error('Delete memory error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
