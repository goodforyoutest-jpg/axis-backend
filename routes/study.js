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
