import express from 'express';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// GET /api/schedule/appsettings
router.get('/appsettings', async (req, res) => {
  try {
    const { data, error } = await supabase.from('app_limits').select('*').order('app_name');
    if (error) throw error;
    res.json({ success: true, apps: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/schedule/appsettings
router.post('/appsettings', async (req, res) => {
  try {
    const { app_name, daily_limit_minutes, is_timepass } = req.body;
    const { error } = await supabase.from('app_limits').upsert(
      { app_name, daily_limit_minutes, is_timepass },
      { onConflict: 'app_name' }
    );
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/schedule/settings
router.get('/settings', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*');
    if (error) throw error;
    const settings = {};
    (data || []).forEach(row => {
      try { settings[row.key] = JSON.parse(row.value); }
      catch { settings[row.key] = row.value; }
    });
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/schedule/settings
router.post('/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    const { error } = await supabase.from('settings').upsert(
      { key, value: typeof value === 'string' ? value : JSON.stringify(value) },
      { onConflict: 'key' }
    );
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
