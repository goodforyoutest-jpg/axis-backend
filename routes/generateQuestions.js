import express from 'express';
import Groq from 'groq-sdk';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

// Load system prompt once at startup
const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/question_generator.txt'),
  'utf-8'
);

// POST /api/generate-questions
router.post('/generate-questions', async (req, res) => {
  const { subject, topic, exam, count, difficulty } = req.body;

  // Basic validation
  if (!subject || !topic || !exam || !count || !difficulty) {
    return res.status(400).json({ success: false, error: 'All fields are required: subject, topic, exam, count, difficulty.' });
  }

  const numQuestions = Math.min(Math.max(parseInt(count) || 10, 1), 50);

  try {
    // ── STEP 1: Tavily web search for current patterns ──────────────────
    let searchContext = '';
    try {
      const searchQuery = `${exam} ${subject} ${topic} MCQ questions pattern syllabus 2025`;
      const tavilyRes = await axios.post(
        'https://api.tavily.com/search',
        {
          api_key: TAVILY_API_KEY,
          query: searchQuery,
          search_depth: 'basic',
          max_results: 5,
          include_answer: true,
        },
        { timeout: 10000 }
      );

      const results = tavilyRes.data?.results || [];
      const answer  = tavilyRes.data?.answer  || '';

      // Build a clean context string from search results
      const snippets = results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`)
        .join('\n\n');

      searchContext = `
WEB SEARCH RESULTS for "${searchQuery}":
${answer ? `Summary: ${answer}\n\n` : ''}${snippets}
`.trim();
    } catch (searchErr) {
      // Non-fatal: if Tavily fails, continue without web context
      console.warn('Tavily search failed, continuing without web context:', searchErr.message);
      searchContext = 'No web search context available. Use your training knowledge for this exam and topic.';
    }

    // ── STEP 2: Build user message ───────────────────────────────────────
    const userMessage = `
Generate exactly ${numQuestions} MCQ questions with the following parameters:

Subject: ${subject}
Topic: ${topic}
Exam/Course: ${exam}
Number of Questions: ${numQuestions}
Difficulty: ${difficulty}

---
CURRENT EXAM CONTEXT FROM WEB:
${searchContext}
---

Remember: Return ONLY the JSON array, nothing else.
`.trim();

    // ── STEP 3: Groq API call ────────────────────────────────────────────
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userMessage },
      ],
      temperature: 0.7,
      max_tokens: 4096,
    });

    const rawText = completion.choices[0]?.message?.content?.trim() || '';

    // ── STEP 4: Parse and validate JSON ──────────────────────────────────
    let questions;
    try {
      // Strip any accidental markdown fences if model adds them
      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

      questions = JSON.parse(cleaned);

      if (!Array.isArray(questions)) {
        throw new Error('Response is not a JSON array');
      }

      // Normalise and validate each question
      questions = questions
        .map(q => ({
          section: q.section || topic,
          q:       q.q       || q.question || q.text || '',
          opts:    q.opts    || q.options  || q.choices || [],
          ans:     typeof q.ans === 'number' ? q.ans : parseInt(q.ans) || 0,
          exp:     q.exp     || q.explanation || q.explain || '',
        }))
        .filter(q => q.q && Array.isArray(q.opts) && q.opts.length >= 2);

      if (questions.length === 0) {
        throw new Error('No valid questions in response');
      }
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr.message);
      console.error('Raw response:', rawText.substring(0, 500));
      return res.status(500).json({
        success: false,
        error: 'AI returned malformed data. Please try again.',
      });
    }

    // ── STEP 5: Return ───────────────────────────────────────────────────
    return res.json({
      success:   true,
      questions,
      count:     questions.length,
      subject,
      topic,
      exam,
      difficulty,
    });

  } catch (err) {
    console.error('generate-questions error:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to generate questions. Please try again.',
    });
  }
});

export default router;
