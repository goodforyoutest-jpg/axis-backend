// FILE: routes/study.js
const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const Groq = require('groq-sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getISTDate() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().split('T')[0];
}

function getWeekNumber(dateStr) {
  const start = new Date();
  const target = new Date(dateStr);
  const diff = (target - start) / (7 * 24 * 3600 * 1000);
  return Math.max(1, Math.ceil(diff));
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ─── CA Foundation Subject Pool for Timetable Generation ──────────────────

const CA_SUBJECT_POOL = {
  Accounting: [
    'Theoretical Framework — Accounting Concepts & Standards',
    'Journal Entries & Ledger Posting',
    'Trial Balance & Rectification of Errors',
    'Bank Reconciliation Statement',
    'Inventories — FIFO & Weighted Average',
    'Depreciation — SLM & WDV Methods',
    'Bills of Exchange',
    'Consignment Accounts',
    'Joint Venture Accounts',
    'Sale on Approval or Return Basis',
    'Final Accounts of Sole Proprietors — No Adjustments',
    'Final Accounts — With Adjustments',
    'Partnership — Fundamentals & Profit Sharing',
    'Partnership — Admission of Partner',
    'Partnership — Retirement & Death of Partner',
    'Partnership — Dissolution',
    'Not-for-Profit Organisations — Receipts & Payments',
    'Not-for-Profit Organisations — Income & Expenditure',
    'Company Accounts — Issue of Shares',
    'Company Accounts — Forfeiture & Reissue of Shares',
    'Company Accounts — Issue of Debentures',
    'Company Accounts — Redemption of Debentures',
    'Basic Accounting Ratios',
    'Computers in Accounting',
    'Accounting Revision — Paper 1 Full',
    'Mock Practice — Accounting Paper'
  ],
  'Business Laws': [
    'Indian Contract Act — Nature & Offer/Acceptance',
    'Indian Contract Act — Consideration & Capacity',
    'Indian Contract Act — Free Consent',
    'Indian Contract Act — Performance & Breach',
    'Sale of Goods Act — Conditions & Warranties',
    'Sale of Goods Act — Unpaid Seller',
    'Indian Partnership Act — Fundamentals',
    'Indian Partnership Act — Dissolution',
    'LLP Act 2008',
    'Companies Act 2013 — Basics',
    'Negotiable Instruments Act 1881',
    'Business Laws Full Revision'
  ],
  'Business Correspondence': [
    'Communication Basics & Types',
    'Business Letters — Inquiry & Order',
    'Business Letters — Complaint & Adjustment',
    'Report Writing',
    'Précis Writing & Comprehension',
    'Notice, Agenda & Minutes',
    'E-Correspondence & Digital Communication',
    'Presentation & Interview Skills'
  ],
  'Business Maths': [
    'Ratio, Proportion & Indices',
    'Logarithms',
    'Linear Equations',
    'Quadratic & Simultaneous Equations',
    'Linear Inequalities',
    'Time Value of Money — SI & CI',
    'Annuities & EMI Calculation',
    'Permutations',
    'Combinations',
    'Arithmetic & Geometric Progressions',
    'Sets, Relations & Functions',
    'Differentiation Basics',
    'Integration Basics'
  ],
  'Logical Reasoning': [
    'Number & Letter Series',
    'Coding-Decoding',
    'Blood Relations',
    'Direction Tests',
    'Seating Arrangement',
    'Syllogisms & Venn Diagrams',
    'LR Practice Set — Mixed'
  ],
  Statistics: [
    'Statistical Description — Frequency Distribution',
    'Histograms, Ogives & Diagrams',
    'Arithmetic Mean, Geometric Mean, Harmonic Mean',
    'Median and Mode',
    'Range, QD, MD, Standard Deviation',
    'Coefficient of Variation',
    'Correlation — Karl Pearson',
    "Spearman's Rank Correlation",
    'Regression Lines & Equations',
    'Index Numbers — Laspeyres, Paasche, Fisher',
    'Probability — Classical & Conditional',
    "Bayes' Theorem",
    'Binomial Distribution',
    'Poisson Distribution',
    'Normal Distribution',
    'Statistics Full Revision'
  ],
  'Business Economics': [
    'Introduction to Business Economics',
    'Theory of Demand — Elasticity',
    'Theory of Supply & Market Equilibrium',
    'Theory of Production — Laws',
    'Cost Concepts — Short Run & Long Run',
    'Perfect Competition',
    'Monopoly & Monopolistic Competition',
    'Oligopoly',
    'Business Cycles',
    'National Income — Concepts & Measurement',
    'Public Finance & Fiscal Policy',
    'Money Market & RBI Monetary Policy',
    'International Trade & WTO',
    'Indian Economy — Pre & Post 1991 Reforms',
    'Business Economics Full Revision'
  ],
  BCK: [
    'Forms of Business Organisation',
    'Business Environment — PESTLE',
    'Government Policies — MSMEs, Startup India',
    'Money, Banking & Digital Finance',
    'Infrastructure & Business',
    'International Business & FDI',
    'BCK Full Revision'
  ]
};

// Subject weights (marks) → used for time allocation
const SUBJECT_WEIGHTS = {
  'Accounting': 100,
  'Business Laws': 60,
  'Business Correspondence': 40,
  'Business Maths': 40,
  'Logical Reasoning': 20,
  'Statistics': 40,
  'Business Economics': 60,
  'BCK': 40
};

const TOTAL_MARKS = Object.values(SUBJECT_WEIGHTS).reduce((a, b) => a + b, 0); // 400

// ─── Timetable Generator ─────────────────────────────────────────────────────

async function generateTimetableWithAI(params) {
  const { hours_per_day, subjects_focus, coaching_days, start_date } = params;

  const totalDays = 120; // 4 months
  const topicsPerDay = Math.max(2, Math.min(6, Math.floor(hours_per_day / 1.5)));
  const minutesPerTopic = Math.floor((hours_per_day * 60) / topicsPerDay);

  // Build subject topic queues with weight-based allocation
  const subjectQueues = {};
  const focusBoost = subjects_focus || [];

  for (const [subject, topics] of Object.entries(CA_SUBJECT_POOL)) {
    const weight = SUBJECT_WEIGHTS[subject] || 30;
    const boost = focusBoost.includes(subject) ? 1.5 : 1;
    const days_allocated = Math.round((weight / TOTAL_MARKS) * totalDays * boost);
    // Create a queue with topics repeated proportionally
    const queue = [];
    let i = 0;
    while (queue.length < days_allocated) {
      queue.push(topics[i % topics.length]);
      i++;
    }
    subjectQueues[subject] = queue;
  }

  // Flatten all topics into daily slots with revision cycles
  const allEntries = [];
  const subjectNames = Object.keys(subjectQueues);
  let subjectIndex = 0;
  let weekCounter = 0;

  for (let day = 0; day < totalDays; day++) {
    const currentDate = addDays(start_date, day);
    const dayOfWeek = new Date(currentDate).toLocaleDateString('en-US', { weekday: 'long' });
    const isCoachingDay = coaching_days && coaching_days.includes(dayOfWeek);
    const week = Math.floor(day / 7) + 1;
    const isRevisionWeek = week % 4 === 0;
    const isMockWeek = week >= 16; // Last 2 weeks = mock tests

    const topicsForToday = isCoachingDay
      ? Math.max(1, Math.floor(topicsPerDay * 0.5))
      : topicsPerDay;

    for (let slot = 0; slot < topicsForToday; slot++) {
      let subject = subjectNames[subjectIndex % subjectNames.length];
      let topic;

      if (isMockWeek) {
        subject = slot % 2 === 0 ? 'Accounting' : 'Business Maths';
        topic = `Mock Test Practice — ${subject}`;
      } else if (isRevisionWeek) {
        topic = `Revision — ${CA_SUBJECT_POOL[subject][0]}`;
      } else {
        const queue = subjectQueues[subject];
        topic = queue.length > 0 ? queue.shift() : `${subject} — Practice Problems`;
      }

      allEntries.push({
        date: currentDate,
        subject,
        topic,
        duration_minutes: minutesPerTopic,
        week_number: week,
        completed: false,
        created_at: new Date().toISOString()
      });

      subjectIndex++;
    }
  }

  return allEntries;
}

// ─── GET /api/study/today ────────────────────────────────────────────────────

router.get('/today', async (req, res) => {
  try {
    const today = getISTDate();

    const { data: topics, error } = await supabase
      .from('timetable')
      .select('*')
      .eq('date', today)
      .order('id', { ascending: true });

    if (error) throw error;

    const { data: checkin } = await supabase
      .from('checkins')
      .select('*')
      .eq('date', today)
      .single();

    const completed = topics ? topics.filter(t => t.completed).length : 0;
    const total = topics ? topics.length : 0;

    res.json({
      date: today,
      topics: topics || [],
      checkin: checkin || null,
      summary: { completed, total, remaining: total - completed, progress_pct: total > 0 ? Math.round((completed / total) * 100) : 0 }
    });

  } catch (err) {
    console.error('Get today error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/study/timetable ────────────────────────────────────────────────

router.get('/timetable', async (req, res) => {
  try {
    const { from, to, week } = req.query;
    let query = supabase.from('timetable').select('*').order('date', { ascending: true });

    if (from) query = query.gte('date', from);
    if (to) query = query.lte('date', to);
    if (week) query = query.eq('week_number', parseInt(week));
    if (!from && !to && !week) {
      const today = getISTDate();
      query = query.gte('date', today).limit(60);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Group by date
    const grouped = {};
    (data || []).forEach(entry => {
      if (!grouped[entry.date]) grouped[entry.date] = [];
      grouped[entry.date].push(entry);
    });

    res.json({ timetable: data || [], grouped, total: data?.length || 0 });

  } catch (err) {
    console.error('Get timetable error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/study/generate ────────────────────────────────────────────────

router.post('/generate', async (req, res) => {
  try {
    const { hours_per_day = 6, subjects_focus = [], coaching_days = [], clear_existing = false } = req.body;

    const start_date = getISTDate();

    if (clear_existing) {
      await supabase.from('timetable').delete().gte('date', start_date);
    }

    const entries = await generateTimetableWithAI({
      hours_per_day,
      subjects_focus,
      coaching_days,
      start_date
    });

    // Batch insert in chunks of 500
    const CHUNK = 500;
    let inserted = 0;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const { error } = await supabase.from('timetable').insert(chunk);
      if (error) throw error;
      inserted += chunk.length;
    }

    res.json({
      success: true,
      message: `Timetable generated: ${inserted} sessions over 4 months`,
      total_entries: inserted,
      start_date,
      end_date: addDays(start_date, 119),
      hours_per_day,
      subjects_focus,
      coaching_days
    });

  } catch (err) {
    console.error('Generate timetable error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/study/complete/:id ────────────────────────────────────────────

router.post('/complete/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('timetable')
      .update({ completed: true, completed_at: ist })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Topic not found' });

    // Update today's checkin topics_done count
    const today = getISTDate();
    const { data: todayTopics } = await supabase
      .from('timetable')
      .select('id, completed')
      .eq('date', today);

    const done = todayTopics ? todayTopics.filter(t => t.completed).length : 0;
    const total = todayTopics ? todayTopics.length : 0;

    await supabase.from('checkins').upsert({
      date: today,
      topics_done: done,
      topics_total: total,
      updated_at: new Date().toISOString()
    }, { onConflict: 'date' });

    res.json({ success: true, topic: data, progress: { done, total } });

  } catch (err) {
    console.error('Complete topic error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/study/checkin ─────────────────────────────────────────────────

router.post('/checkin', async (req, res) => {
  try {
    const { completed = true, apps_locked = false } = req.body;
    const today = getISTDate();

    const { data: todayTopics } = await supabase
      .from('timetable')
      .select('id, completed')
      .eq('date', today);

    const topics_done = todayTopics ? todayTopics.filter(t => t.completed).length : 0;
    const topics_total = todayTopics ? todayTopics.length : 0;

    const { data, error } = await supabase
      .from('checkins')
      .upsert({
        date: today,
        completed,
        topics_total,
        topics_done,
        apps_locked,
        created_at: new Date().toISOString()
      }, { onConflict: 'date' })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, checkin: data });

  } catch (err) {
    console.error('Checkin error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/study/checkin-status ──────────────────────────────────────────

router.get('/checkin-status', async (req, res) => {
  try {
    const today = getISTDate();
    const sevenDaysAgo = addDays(today, -7);

    const [todayCheckin, recentCheckins, todayTopics] = await Promise.all([
      supabase.from('checkins').select('*').eq('date', today).single(),
      supabase.from('checkins').select('*').gte('date', sevenDaysAgo).order('date', { ascending: false }),
      supabase.from('timetable').select('id, completed, subject').eq('date', today)
    ]);

    const topics = todayTopics.data || [];
    const done = topics.filter(t => t.completed).length;

    res.json({
      today: {
        date: today,
        checkin: todayCheckin.data || null,
        topics_done: done,
        topics_total: topics.length,
        checked_in: !!todayCheckin.data
      },
      streak: calculateStreak(recentCheckins.data || []),
      last_7_days: recentCheckins.data || []
    });

  } catch (err) {
    console.error('Checkin status error:', err);
    res.status(500).json({ error: err.message });
  }
});

function calculateStreak(checkins) {
  if (!checkins || checkins.length === 0) return 0;
  const sorted = [...checkins].sort((a, b) => new Date(b.date) - new Date(a.date));
  let streak = 0;
  let checkDate = new Date(getISTDate());

  for (const c of sorted) {
    const cDate = new Date(c.date);
    const diffDays = Math.round((checkDate - cDate) / (24 * 3600 * 1000));
    if (diffDays <= 1 && c.completed) {
      streak++;
      checkDate = cDate;
    } else {
      break;
    }
  }
  return streak;
}

// ─── GET /api/study/tasks ────────────────────────────────────────────────────

router.get('/tasks', async (req, res) => {
  try {
    const { type, priority, completed } = req.query;
    let query = supabase.from('tasks').select('*').order('created_at', { ascending: false });

    if (type) query = query.eq('type', type);
    if (priority) query = query.eq('priority', priority);
    if (completed !== undefined) query = query.eq('completed', completed === 'true');

    const { data, error } = await query;
    if (error) throw error;

    res.json({ tasks: data || [], total: data?.length || 0 });

  } catch (err) {
    console.error('Get tasks error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/study/tasks ───────────────────────────────────────────────────

router.post('/tasks', async (req, res) => {
  try {
    const { title, description, type, priority, due_date } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        title: title.trim(),
        description: description || '',
        type: type || 'general',
        priority: priority || 'medium',
        completed: false,
        due_date: due_date || null,
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ success: true, task: data });

  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/study/tasks/:id ─────────────────────────────────────────────

router.delete('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: existing } = await supabase
      .from('tasks')
      .select('id')
      .eq('id', id)
      .single();

    if (!existing) return res.status(404).json({ error: 'Task not found' });

    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) throw error;

    res.json({ success: true, message: 'Task deleted' });

  } catch (err) {
    console.error('Delete task error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/study/tasks/:id ────────────────────────────────────────────────

router.put('/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, type, priority, completed, due_date } = req.body;

    const updates = {};
    if (title !== undefined) updates.title = title.trim();
    if (description !== undefined) updates.description = description;
    if (type !== undefined) updates.type = type;
    if (priority !== undefined) updates.priority = priority;
    if (completed !== undefined) updates.completed = completed;
    if (due_date !== undefined) updates.due_date = due_date;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Task not found' });

    res.json({ success: true, task: data });

  } catch (err) {
    console.error('Update task error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/study/coaching ────────────────────────────────────────────────

router.post('/coaching', async (req, res) => {
  try {
    const { days, start_time, end_time, institute_name } = req.body;

    if (!days || !Array.isArray(days)) {
      return res.status(400).json({ error: 'days must be an array' });
    }

    const coaching = { days, start_time, end_time, institute_name: institute_name || '' };

    const upserts = [
      { key: 'coaching_schedule', value: JSON.stringify(coaching), updated_at: new Date().toISOString() },
      { key: 'coaching_days', value: JSON.stringify(days), updated_at: new Date().toISOString() },
      { key: 'coaching_start', value: start_time || '', updated_at: new Date().toISOString() },
      { key: 'coaching_end', value: end_time || '', updated_at: new Date().toISOString() }
    ];

    for (const row of upserts) {
      await supabase.from('settings').upsert(row, { onConflict: 'key' });
    }

    res.json({ success: true, coaching });

  } catch (err) {
    console.error('Save coaching error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/study/settings ─────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  try {
    const { key } = req.query;
    let query = supabase.from('settings').select('*').order('key', { ascending: true });
    if (key) query = query.eq('key', key);

    const { data, error } = await query;
    if (error) throw error;

    // Return as flat key-value map
    const map = {};
    (data || []).forEach(row => {
      try { map[row.key] = JSON.parse(row.value); }
      catch { map[row.key] = row.value; }
    });

    res.json({ settings: map, raw: data || [] });

  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/study/settings ────────────────────────────────────────────────

router.post('/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });

    const { data, error } = await supabase
      .from('settings')
      .upsert({
        key,
        value: typeof value === 'string' ? value : JSON.stringify(value),
        updated_at: new Date().toISOString()
      }, { onConflict: 'key' })
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, setting: data });

  } catch (err) {
    console.error('Save setting error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
