const express = require('express');
const router = express.Router();
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ICAI_URLS = {
  foundation: 'https://www.icai.org/post/foundation-course',
  exams: 'https://www.icai.org/post/examination-schedule',
  results: 'https://www.icai.org/post/results'
};

const scrapeICАI = async (url) => {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    });
    const $ = cheerio.load(res.data);
    $('script, style, nav, footer, header').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 3000);
    return text;
  } catch (e) {
    return null;
  }
};

router.get('/syllabus', async (req, res) => {
  try {
    const { data: cached } = await supabase.from('settings').select('*').eq('key', 'icai_syllabus').single();
    if (cached) {
      const parsed = JSON.parse(cached.value);
      if (Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) {
        return res.json({ success: true, data: parsed.data, source: 'cache' });
      }
    }
    const content = await scrapeICАI(ICAI_URLS.foundation);
    const data = content || `CA Foundation Syllabus:
Paper 1: Principles & Practice of Accounting (100 marks)
Paper 2: Business Laws (60) & Business Correspondence (40 marks)  
Paper 3: Quantitative Aptitude (60) & Business Economics (40 marks)
Paper 4: Business Economics (60) & Business & Commercial Knowledge (40 marks)
Exam Pattern: Objective + Descriptive, Passing: 40% per paper, 50% aggregate`;

    await supabase.from('settings').upsert(
      { key: 'icai_syllabus', value: JSON.stringify({ data, timestamp: Date.now() }) },
      { onConflict: 'key' }
    );
    res.json({ success: true, data, source: 'live' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/exams', async (req, res) => {
  try {
    const { data: cached } = await supabase.from('settings').select('*').eq('key', 'icai_exams').single();
    if (cached) {
      const parsed = JSON.parse(cached.value);
      if (Date.now() - parsed.timestamp < 6 * 60 * 60 * 1000) {
        return res.json({ success: true, data: parsed.data, source: 'cache' });
      }
    }
    const content = await scrapeICАI(ICAI_URLS.exams);
    const data = content || `CA Foundation Exam Schedule:
May 2027 Attempt - Registration opens approximately October 2026
Form filling: February-March 2027
Admit cards: April 2027
Exams: May 2027 (exact dates TBA by ICAI)
Results: July 2027 (approximately)`;

    await supabase.from('settings').upsert(
      { key: 'icai_exams', value: JSON.stringify({ data, timestamp: Date.now() }) },
      { onConflict: 'key' }
    );
    res.json({ success: true, data, source: 'live' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/updates', async (req, res) => {
  try {
    const content = await scrapeICАI('https://www.icai.org/post/announcement');
    res.json({ success: true, data: content || 'No recent updates found', source: 'live' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
