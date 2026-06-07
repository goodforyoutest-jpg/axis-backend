const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

router.get('/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase.from('timetable').select('*').eq('date', today);
    if (error) throw error;
    res.json({ success: true, topics: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/complete/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('timetable').update({ completed: true }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/timetable', async (req, res) => {
  try {
    const { data, error } = await supabase.from('timetable').select('*').order('date', { ascending: true });
    if (error) throw error;
    res.json({ success: true, timetable: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/checkin', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { completed } = req.body;
    const { data: topics } = await supabase.from('timetable').select('*').eq('date', today);
    const total = topics?.length || 0;
    const done = topics?.filter(t => t.completed).length || 0;
    const { error } = await supabase.from('checkins').upsert(
      { date: today, completed, topics_total: total, topics_done: done, apps_locked: !completed },
      { onConflict: 'date' }
    );
    if (error) throw error;
    res.json({ success: true, message: completed ? 'Great work today!' : 'Apps locked for today.', topics_done: done, topics_total: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/coaching', async (req, res) => {
  try {
    const { days, start_time, end_time } = req.body;
    const { error } = await supabase.from('settings').upsert(
      { key: 'coaching', value: JSON.stringify({ days, start_time, end_time }) },
      { onConflict: 'key' }
    );
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/generate', async (req, res) => {
  try {
    const { hours_per_day } = req.body;
    const subjects = [
      { name: 'Accounting', topics: ['Introduction to Accounting','Accounting Process','Bank Reconciliation','Inventories','Depreciation','Bills of Exchange','Final Accounts','Partnership Accounts','Company Accounts'] },
      { name: 'Business Laws', topics: ['Indian Contract Act','Sale of Goods Act','Indian Partnership Act','LLP Act','Companies Act Basics','Negotiable Instruments Act','GST Basics'] },
      { name: 'Quantitative Aptitude', topics: ['Ratio & Proportion','Indices & Surds','Linear Equations','Quadratic Equations','Sequence & Series','Sets & Functions','Limits','Basic Statistics','Probability','Theoretical Distributions'] },
      { name: 'Business Economics', topics: ['Introduction to Economics','Demand & Supply','Elasticity','Production Function','Cost & Revenue','Market Structures','Indian Economy Overview','Money & Banking','Business Cycles'] }
    ];
    const records = [];
    let currentDate = new Date();
    let weekNum = 1;
    let dayCount = 0;
    for (const subject of subjects) {
      for (const topic of subject.topics) {
        if (dayCount > 0 && dayCount % 7 === 0) weekNum++;
        const duration = Math.round(((hours_per_day || 1) / subjects.length) * 60);
        records.push({ date: currentDate.toISOString().split('T')[0], subject: subject.name, topic, duration_minutes: duration, week_number: weekNum, completed: false });
        currentDate.setDate(currentDate.getDate() + 1);
        dayCount++;
      }
    }
    const { error } = await supabase.from('timetable').insert(records);
    if (error) throw error;
    res.json({ success: true, message: `Generated ${records.length} topics` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/tasks', async (req, res) => {
  try {
    const { data, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, tasks: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/tasks', async (req, res) => {
  try {
    const { title, description, type, priority, due_date } = req.body;
    const { error } = await supabase.from('tasks').insert({ title, description, type, priority, due_date: due_date || null });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/tasks/:id/complete', async (req, res) => {
  try {
    const { error } = await supabase.from('tasks').update({ completed: true }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
