const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Get today's topics
router.get('/today', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { data, error } = await supabase.from('daily_topics').select('*').eq('date', today);
    if (error) throw error;
    res.json({ success: true, topics: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mark topic complete
router.post('/complete/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('daily_topics').update({ completed: true, completed_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true, message: 'Topic marked complete' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get full timetable
router.get('/timetable', async (req, res) => {
  try {
    const { data, error } = await supabase.from('timetable').select('*').order('date', { ascending: true });
    if (error) throw error;
    res.json({ success: true, timetable: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Check-in for today
router.post('/checkin', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const { completed } = req.body;
    const { data: topics } = await supabase.from('daily_topics').select('*').eq('date', today);
    const total = topics?.length || 0;
    const done = topics?.filter(t => t.completed).length || 0;
    const { error } = await supabase.from('checkins').upsert({ date: today, completed: completed, topics_total: total, topics_done: done });
    if (error) throw error;
    res.json({ success: true, message: completed ? 'Great work today!' : 'Apps locked for today.', topics_done: done, topics_total: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update coaching schedule
router.post('/coaching', async (req, res) => {
  try {
    const { days, start_time, end_time } = req.body;
    const { error } = await supabase.from('settings').upsert({ key: 'coaching', value: JSON.stringify({ days, start_time, end_time }) });
    if (error) throw error;
    res.json({ success: true, message: 'Coaching schedule updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

// Generate timetable
router.post('/generate', async (req, res) => {
  try {
    const { hours_per_day } = req.body;
    const subjects = [
      { name: 'Accounting', topics: ['Introduction to Accounting','Accounting Process','Bank Reconciliation','Inventories','Depreciation','Bills of Exchange','Final Accounts','Partnership Accounts','Company Accounts'] },
      { name: 'Business Laws', topics: ['Indian Contract Act','Sale of Goods Act','Indian Partnership Act','LLP Act','Companies Act Basics','Negotiable Instruments Act','GST Basics'] },
      { name: 'Quantitative Aptitude', topics: ['Ratio & Proportion','Indices & Surds','Linear Equations','Quadratic Equations','Sequence & Series','Sets & Functions','Limits','Basic Statistics','Probability','Theoretical Distributions'] },
      { name: 'Business Economics', topics: ['Introduction to Economics','Demand & Supply','Elasticity','Production Function','Cost & Revenue','Market Structures','Indian Economy Overview','Money & Banking','Business Cycles'] }
    ];

    const startDate = new Date();
    const records = [];
    let currentDate = new Date(startDate);
    let weekNum = 1;
    let dayCount = 0;

    for (const subject of subjects) {
      for (const topic of subject.topics) {
        if (dayCount > 0 && dayCount % 7 === 0) weekNum++;
        const studyHours = Math.min(weekNum, hours_per_day || 1);
        const duration = Math.round((studyHours / subjects.length) * 60);
        records.push({
          date: currentDate.toISOString().split('T')[0],
          subject: subject.name,
          topic: topic,
          duration_minutes: duration,
          week_number: weekNum,
          completed: false
        });
        currentDate.setDate(currentDate.getDate() + 1);
        dayCount++;
      }
    }

    const { error } = await supabase.from('timetable').insert(records);
    if (error) throw error;

    // Also populate daily_topics for today
    const today = new Date().toISOString().split('T')[0];
    const todayRecords = records.filter(r => r.date === today);
    if (todayRecords.length > 0) {
      await supabase.from('daily_topics').insert(todayRecords);
    }

    res.json({ success: true, message: `Generated ${records.length} topics` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get tasks
router.get('/tasks', async (req, res) => {
  try {
    const { data, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, tasks: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add task
router.post('/tasks', async (req, res) => {
  try {
    const { title, description, type, priority, due_date } = req.body;
    const { error } = await supabase.from('tasks').insert({ title, description, type, priority, due_date });
    if (error) throw error;
    res.json({ success: true, message: 'Task added' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Complete task
router.post('/tasks/:id/complete', async (req, res) => {
  try {
    const { error } = await supabase.from('tasks').update({ completed: true }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
