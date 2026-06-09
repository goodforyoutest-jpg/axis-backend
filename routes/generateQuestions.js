import express from 'express';
import Groq from 'groq-sdk';
import { tavily } from '@tavily/core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/question_generator.txt'),
  'utf-8'
);

// Robustly extract a JSON array from any string Groq returns
// Also handles truncated arrays by trimming to last complete object
function extractJsonArray(text) {
  // 1. Strip markdown fences
  let cleaned = text
    .replace(/```json[\s\S]*?```/gi, m => m.replace(/```json\s*/i, '').replace(/```/g, ''))
    .replace(/```[\s\S]*?```/gi, m => m.replace(/```\s*/g, ''))
    .trim();

  // 2. Try parsing cleaned string directly
  try { return JSON.parse(cleaned); } catch (_) {}

  // 3. Find first [ ... ] block
  const start = text.indexOf('[');
  let end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
  }

  // 4. Truncated JSON — find last complete object and close the array
  if (start !== -1) {
    const fragment = text.slice(start);
    // Walk backwards from end to find last complete } before truncation
    let lastClose = fragment.lastIndexOf('},');
    if (lastClose === -1) lastClose = fragment.lastIndexOf('}');
    if (lastClose !== -1) {
      const repaired = fragment.slice(0, lastClose + 1) + ']';
      try { return JSON.parse(repaired); } catch (_) {}
    }
  }

  return null;
}

// POST /api/generate-questions
router.post('/generate-questions', async (req, res) => {
  const { subject, topic, exam, count, difficulty } = req.body;

  if (!subject || !topic || !exam || !count || !difficulty) {
    return res.status(400).json({ success: false, error: 'All fields are required.' });
  }

  const numQuestions = Math.min(Math.max(parseInt(count) || 10, 1), 50);

  // Scale max_tokens based on question count
  // ~200 tokens per question is a safe estimate for full JSON with explanation
  const maxTokens = Math.min(Math.max(numQuestions * 220 + 512, 2048), 8000);

  try {
    // ── STEP 1: Tavily web search ────────────────────────────────────────
    let searchContext = '';
    try {
      const searchQuery = `${exam} ${subject} ${topic} MCQ questions pattern syllabus 2025`;
      const tavilyRes = await tvly.search(searchQuery, {
        searchDepth: 'basic',
        maxResults: 5,
        includeAnswer: true,
      });
      const results = tavilyRes.results || [];
      const answer  = tavilyRes.answer  || '';
      const snippets = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`).join('\n\n');
      searchContext = `WEB SEARCH RESULTS for "${searchQuery}":\n${answer ? `Summary: ${answer}\n\n` : ''}${snippets}`.trim();
    } catch (searchErr) {
      console.warn('Tavily search failed:', searchErr.message);
      searchContext = 'No web context available. Use training knowledge.';
    }

    // ── STEP 2: Groq call ────────────────────────────────────────────────
    const userMessage = `Generate exactly ${numQuestions} MCQ questions.

Subject: ${subject}
Topic: ${topic}
Exam/Course: ${exam}
Count: ${numQuestions}
Difficulty: ${difficulty}

CURRENT EXAM CONTEXT:
${searchContext}

CRITICAL: Your entire response must be ONLY a raw JSON array starting with [ and ending with ]. No text before [. No text after ]. No markdown. No code fences. No explanation. All ${numQuestions} questions must be included.`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userMessage },
      ],
      temperature: 0.7,
      max_tokens: maxTokens,
    });

    const rawText = completion.choices[0]?.message?.content?.trim() || '';
    const finishReason = completion.choices[0]?.finish_reason;
    console.log(`Groq finish_reason: ${finishReason} | max_tokens used: ${maxTokens}`);
    console.log('Groq raw (first 300):', rawText.substring(0, 300));

    // ── STEP 3: Parse ────────────────────────────────────────────────────
    const parsed = extractJsonArray(rawText);

    if (!parsed || !Array.isArray(parsed)) {
      console.error('Could not extract JSON array. Full response:', rawText);
      return res.status(500).json({ success: false, error: 'AI returned malformed data. Please try again.' });
    }

    const questions = parsed
      .map(q => ({
        section: q.section || topic,
        q:       q.q || q.question || q.text || q.stem || '',
        opts:    q.opts || q.options || q.choices || [],
        ans:     typeof q.ans === 'number' ? q.ans : parseInt(q.ans ?? q.answer ?? q.correct ?? 0),
        exp:     q.exp || q.explanation || q.explain || q.note || '',
      }))
      .filter(q => q.q && Array.isArray(q.opts) && q.opts.length >= 2);

    if (questions.length === 0) {
      console.error('All questions filtered out. Parsed:', JSON.stringify(parsed).substring(0, 300));
      return res.status(500).json({ success: false, error: 'AI generated questions in unexpected format. Please try again.' });
    }

    console.log(`Requested: ${numQuestions} | Returned: ${questions.length}`);
    return res.json({ success: true, questions, count: questions.length, subject, topic, exam, difficulty });

  } catch (err) {
    console.error('generate-questions error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to generate questions. Please try again.' });
  }
});

export default router;
