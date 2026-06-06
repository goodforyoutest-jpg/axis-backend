const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

router.get('/settings', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*');
    if (error) throw error;
    const settings = {};
    data.forEach(row => { settings[row.key] = JSON.parse(row.value); });
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    const { error } = await supabase.from('settings').upsert({ key, value: JSON.stringify(value) });
    if (error) throw error;
    res.json({ success: true, message: 'Setting updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/appsettings', async (req, res) => {
  try {
    const { data, error } = await supabase.from('app_limits').select('*');
    if (error) throw error;
    res.json({ success: true, apps: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/appsettings', async (req, res) => {
  try {
    const { app_name, daily_limit_minutes, is_timepass } = req.body;
    const { error } = await supabase.from('app_limits').upsert({ app_name, daily_limit_minutes, is_timepass });
    if (error) throw error;
    res.json({ success: true, message: 'App limit saved' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
