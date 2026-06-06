const express = require('express');
const router = express.Router();
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM_PROMPT = `You are AXIS, a strict personal AI assistant for ${process.env.USER_NAME || 'Gajanan'}, a CA Foundation student preparing for May 2027 exam. You are like a strict teacher - no sugarcoating, real accountability. When he completes his study targets, call him 'Gaju' as appreciation. You help with study planning, email drafting, task management, and analysis. Be direct, strict but caring. Never let him slack off.`;

router.post('/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    const messages = [{ role: 'user', content: context ? `Context: ${JSON.stringify(context)}\n\nMessage: ${message}` : message }];
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      max_tokens: 1000,
    });
    res.json({ success: true, reply: response.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/analyse', async (req, res) => {
  try {
    const { type, data } = req.body;
    let prompt = '';
    if (type === 'email') prompt = `Analyse these emails and categorise as urgent/study-related/ignore. Prioritise ICAI emails first. Emails: ${JSON.stringify(data)}`;
    if (type === 'progress') prompt = `Analyse this study progress and give strict feedback. Be brutally honest. Data: ${JSON.stringify(data)}`;
    if (type === 'timetable') prompt = `Review this timetable and suggest improvements for CA Foundation preparation. Data: ${JSON.stringify(data)}`;
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
