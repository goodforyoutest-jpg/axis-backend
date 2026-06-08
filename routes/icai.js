// FILE: routes/icai.js
import express from 'express';
const router = express.Router();
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import * as cheerio from 'cheerio';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── Cache Helpers ───────────────────────────────────────────────────────────

async function getCached(key) {
  try {
    const { data } = await supabase
      .from('settings')
      .select('value, updated_at')
      .eq('key', key)
      .single();
    if (!data) return null;
    return { value: JSON.parse(data.value), updated_at: data.updated_at };
  } catch {
    return null;
  }
}

async function setCache(key, value) {
  await supabase.from('settings').upsert(
    { key, value: JSON.stringify(value), updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
}

function isCacheExpired(updatedAt, ttlHours) {
  if (!updatedAt) return true;
  const now = Date.now();
  const updated = new Date(updatedAt).getTime();
  return (now - updated) > ttlHours * 3600 * 1000;
}

// ─── Scraper Headers ─────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Oppo A3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Referer': 'https://www.icai.org/'
};

// ─── Fallback Data ───────────────────────────────────────────────────────────

const FALLBACK_SYLLABUS = {
  source: 'fallback',
  last_updated: '2024-01',
  papers: [
    {
      paper: 'Paper 1',
      title: 'Principles and Practice of Accounting',
      marks: 100,
      type: 'Subjective',
      chapters: [
        { no: 1, title: 'Theoretical Framework', topics: ['Meaning and Scope of Accounting', 'Accounting Concepts, Principles and Conventions', 'Accounting Standards', 'Accounting Policies', 'Accounting as Measurement Discipline'] },
        { no: 2, title: 'Accounting Process', topics: ['Vouchers and Transactions', 'Journal', 'Ledger', 'Trial Balance', 'Subsidiary Books', 'Cash Book'] },
        { no: 3, title: 'Bank Reconciliation Statement', topics: ['Causes of differences', 'Preparation of BRS'] },
        { no: 4, title: 'Inventories', topics: ['FIFO Method', 'Weighted Average Method', 'Accounting for inventory'] },
        { no: 5, title: 'Concept and Accounting of Depreciation', topics: ['SLM Method', 'WDV Method', 'Change in depreciation method', 'Provision for depreciation'] },
        { no: 6, title: 'Accounting for Special Transactions', topics: ['Bills of Exchange', 'Consignment', 'Joint Venture', 'Sale on Approval or Return Basis'] },
        { no: 7, title: 'Final Accounts of Sole Proprietors', topics: ['Manufacturing Account', 'Trading Account', 'Profit and Loss Account', 'Balance Sheet with adjustments'] },
        { no: 8, title: 'Partnership Accounts', topics: ['Introduction', 'Admission of Partner', 'Retirement of Partner', 'Death of a Partner', 'Dissolution of Partnership Firm'] },
        { no: 9, title: 'Financial Statements of Not-for-Profit Organisations', topics: ['Receipts and Payments Account', 'Income and Expenditure Account', 'Balance Sheet', 'Fund-based Accounting'] },
        { no: 10, title: 'Company Accounts', topics: ['Issue of Shares', 'Forfeiture and Reissue of Shares', 'Issue of Debentures', 'Redemption of Debentures'] },
        { no: 11, title: 'Basic Accounting Ratios', topics: ['Liquidity Ratios', 'Profitability Ratios', 'Activity Ratios', 'Solvency Ratios'] },
        { no: 12, title: 'Computers in Accounting', topics: ['Introduction to computers', 'Accounting software', 'Computerised accounting system'] }
      ]
    },
    {
      paper: 'Paper 2A',
      title: 'Business Laws',
      marks: 60,
      type: 'Objective + Subjective',
      chapters: [
        { no: 1, title: 'Indian Contract Act, 1872', topics: ['Nature of Contract', 'Offer and Acceptance', 'Consideration', 'Capacity to Contract', 'Free Consent', 'Legality of Object', 'Performance of Contract', 'Breach of Contract', 'Quasi Contracts'] },
        { no: 2, title: 'Sale of Goods Act, 1930', topics: ['Conditions and Warranties', 'Transfer of Property in Goods', 'Unpaid Seller and his Rights', 'Auction Sales'] },
        { no: 3, title: 'Indian Partnership Act, 1932', topics: ['Nature of Partnership', 'Rights and Duties of Partners', 'Reconstitution of Firm', 'Dissolution of Firm'] },
        { no: 4, title: 'Limited Liability Partnership Act, 2008', topics: ['LLP Agreement', 'Extent and Limitation of Liability', 'Winding up of LLP'] },
        { no: 5, title: 'Companies Act, 2013', topics: ['Essential elements of Company', 'Types of Companies', 'Incorporation process', 'Memorandum and Articles of Association'] },
        { no: 6, title: 'The Negotiable Instruments Act, 1881', topics: ['Cheques', 'Promissory Note', 'Bill of Exchange', 'Crossing of Cheques', 'Dishonour of Cheque'] }
      ]
    },
    {
      paper: 'Paper 2B',
      title: 'Business Correspondence and Reporting',
      marks: 40,
      type: 'Subjective',
      chapters: [
        { no: 1, title: 'Communication', topics: ['Basics of Communication', 'Types of Communication', 'Barriers to Communication', 'Effective Communication Skills'] },
        { no: 2, title: 'Sentence Types and Word Power', topics: ['Types of Sentences', 'Vocabulary Enhancement', 'Common Errors'] },
        { no: 3, title: 'Comprehension Passages', topics: ['Reading Comprehension', 'Précis Writing'] },
        { no: 4, title: 'Business Correspondence', topics: ['Business Letters', 'Circulars', 'Tenders', 'Enquiry Letters', 'Order Letters', 'Complaint Letters', 'Adjustment Letters'] },
        { no: 5, title: 'Writing Skills', topics: ['Notice', 'Agenda', 'Minutes', 'Reports', 'Executive Summary', 'Press Release'] },
        { no: 6, title: 'E-Correspondence', topics: ['E-mail', 'Social Media Communication', 'Blogs', 'Video Conferencing Etiquette'] },
        { no: 7, title: 'Presentation', topics: ['Formal Presentations', 'Interview Skills', 'Group Discussions'] }
      ]
    },
    {
      paper: 'Paper 3',
      title: 'Business Mathematics, Logical Reasoning and Statistics',
      marks: 100,
      type: 'Objective',
      chapters: [
        { no: 1, title: 'Ratio and Proportion, Indices, Logarithms', topics: ['Ratio and Proportion', 'Laws of Indices', 'Logarithms — Common and Natural'] },
        { no: 2, title: 'Equations', topics: ['Simple Equations', 'Simultaneous Equations', 'Quadratic Equations', 'Cubic Equations'] },
        { no: 3, title: 'Linear Inequalities', topics: ['Linear Inequalities with one variable', 'Linear Inequalities with two variables', 'Linear Programming'] },
        { no: 4, title: 'Time Value of Money', topics: ['Simple Interest', 'Compound Interest', 'Effective Rate of Interest', 'Present Value', 'Net Present Value', 'Future Value', 'Perpetuity', 'Annuities', 'Sinking Funds', 'Calculating EMI'] },
        { no: 5, title: 'Permutations and Combinations', topics: ['Fundamental Principle of Counting', 'Permutations', 'Circular Permutations', 'Combinations'] },
        { no: 6, title: 'Sequence and Series', topics: ['Arithmetic Progression', 'Geometric Progression', 'Sum of AP and GP'] },
        { no: 7, title: 'Sets, Relations and Functions', topics: ['Sets and Subsets', 'Operations on Sets', 'Relations', 'Functions'] },
        { no: 8, title: 'Basic Concepts of Differential and Integral Calculus', topics: ['Differentiation Rules', 'Derivatives of standard functions', 'Maxima and Minima', 'Integration Basics'] },
        { no: 9, title: 'Logical Reasoning', topics: ['Number Series', 'Letter Series', 'Coding-Decoding', 'Odd Man Out', 'Blood Relations', 'Seating Arrangement', 'Direction Tests', 'Syllogisms', 'Venn Diagrams'] },
        { no: 10, title: 'Statistical Description of Data', topics: ['Diagrammatic and Graphic Representation', 'Frequency Distribution', 'Histograms', 'Ogives'] },
        { no: 11, title: 'Measures of Central Tendency and Dispersion', topics: ['Arithmetic Mean', 'Geometric Mean', 'Harmonic Mean', 'Median', 'Mode', 'Range', 'Quartile Deviation', 'Mean Deviation', 'Standard Deviation', 'Coefficient of Variation'] },
        { no: 12, title: 'Correlation and Regression', topics: ["Karl Pearson's Correlation", "Spearman's Rank Correlation", 'Regression Lines', 'Regression Equations'] },
        { no: 13, title: 'Index Numbers', topics: ["Laspeyres' Index", "Paasche's Index", "Fisher's Ideal Index", 'Consumer Price Index', 'Wholesale Price Index'] },
        { no: 14, title: 'Probability', topics: ['Classical and Empirical Definition', 'Addition and Multiplication Theorem', 'Conditional Probability', "Bayes' Theorem"] },
        { no: 15, title: 'Theoretical Distributions', topics: ['Binomial Distribution', 'Poisson Distribution', 'Normal Distribution'] }
      ]
    },
    {
      paper: 'Paper 4A',
      title: 'Business Economics',
      marks: 60,
      type: 'Objective + Subjective',
      chapters: [
        { no: 1, title: 'Introduction to Business Economics', topics: ['Meaning and Scope', 'Micro vs Macro Economics', 'Economic Systems', 'Basic Economic Problems'] },
        { no: 2, title: 'Theory of Demand and Supply', topics: ['Law of Demand', 'Elasticity of Demand — Price, Income, Cross', 'Demand Forecasting', 'Law of Supply', 'Elasticity of Supply', 'Market Equilibrium'] },
        { no: 3, title: 'Theory of Production and Cost', topics: ['Factors of Production', 'Law of Variable Proportions', 'Returns to Scale', 'Producer Equilibrium', 'Cost Concepts — TC, MC, AC, AFC, AVC', 'Short Run and Long Run Costs'] },
        { no: 4, title: 'Price Determination in Different Markets', topics: ['Perfect Competition', 'Monopoly', 'Monopolistic Competition', 'Oligopoly'] },
        { no: 5, title: 'Business Cycles', topics: ['Phases of Business Cycle', 'Causes of Business Cycles', 'Measures to control Business Cycles'] },
        { no: 6, title: 'Determination of National Income', topics: ['Concepts of GDP, GNP, NDP, NNP', 'Methods of National Income Measurement', 'Circular Flow of Income'] },
        { no: 7, title: 'Public Finance', topics: ['Government Revenue', 'Government Expenditure', 'Fiscal Policy', 'Budget — Types and Significance'] },
        { no: 8, title: 'Money Market', topics: ['Functions of Money', 'Money Supply', 'Banking System', 'Functions of RBI', 'Monetary Policy — CRR, SLR, Repo, Reverse Repo'] },
        { no: 9, title: 'International Trade', topics: ['Theories of International Trade', 'Balance of Payments', 'Foreign Exchange', 'WTO'] },
        { no: 10, title: 'Indian Economy', topics: ['Pre-1991 Economy', 'LPG Reforms 1991', 'Current Economic Scenario'] }
      ]
    },
    {
      paper: 'Paper 4B',
      title: 'Business and Commercial Knowledge',
      marks: 40,
      type: 'Objective',
      chapters: [
        { no: 1, title: 'Introduction to Business', topics: ['Business Objectives', 'Forms of Business Organisation', 'Sole Proprietorship', 'Partnership', 'Company', 'Co-operative Society'] },
        { no: 2, title: 'Business Environment', topics: ['Political Environment', 'Economic Environment', 'Social Environment', 'Technological Environment', 'Legal Environment', 'PESTLE Analysis'] },
        { no: 3, title: 'Business Organisation', topics: ['Departmentation', 'Delegation', 'Decentralisation', 'Span of Control', 'MBO'] },
        { no: 4, title: 'Government Policies for Business Growth', topics: ['MSME Policy', 'Make in India', 'Startup India', 'Digital India', 'FDI Policy'] },
        { no: 5, title: 'Money and Banking', topics: ['Commercial Banks', 'Credit Creation', 'Types of Bank Accounts', 'Digital Banking', 'NEFT, RTGS, IMPS, UPI'] },
        { no: 6, title: 'Infrastructure and Business', topics: ['Energy Sector', 'Transport Sector', 'Communication Sector', 'Banking Sector'] },
        { no: 7, title: 'International Business', topics: ['Modes of International Business', 'FDI and FII', 'EXIM Policy', 'Special Economic Zones'] }
      ]
    }
  ]
};

const FALLBACK_EXAMS = {
  source: 'fallback',
  upcoming: [
    {
      exam: 'CA Foundation',
      session: 'May 2027',
      registration_deadline: '2027-01-31',
      dates: [
        { paper: 'Paper 1 — Principles and Practice of Accounting', date: '2027-05-08', day: 'Friday', time: '2:00 PM – 5:00 PM' },
        { paper: 'Paper 2 — Business Laws & Business Correspondence', date: '2027-05-10', day: 'Sunday', time: '2:00 PM – 5:00 PM' },
        { paper: 'Paper 3 — Business Mathematics, LR & Statistics', date: '2027-05-12', day: 'Tuesday', time: '2:00 PM – 5:00 PM' },
        { paper: 'Paper 4 — Business Economics & BCK', date: '2027-05-14', day: 'Thursday', time: '2:00 PM – 5:00 PM' }
      ],
      notes: 'Tentative dates — Check ICAI website for official announcement'
    },
    {
      exam: 'CA Foundation',
      session: 'November 2026',
      registration_deadline: '2026-07-31',
      dates: [
        { paper: 'Paper 1 — Principles and Practice of Accounting', date: '2026-11-07', day: 'Saturday', time: '2:00 PM – 5:00 PM' },
        { paper: 'Paper 2 — Business Laws & Business Correspondence', date: '2026-11-09', day: 'Monday', time: '2:00 PM – 5:00 PM' },
        { paper: 'Paper 3 — Business Mathematics, LR & Statistics', date: '2026-11-11', day: 'Wednesday', time: '2:00 PM – 5:00 PM' },
        { paper: 'Paper 4 — Business Economics & BCK', date: '2026-11-13', day: 'Friday', time: '2:00 PM – 5:00 PM' }
      ],
      notes: 'Tentative dates — Check ICAI website for official announcement'
    }
  ],
  pass_percentage: {
    'May 2024': '17.87%',
    'November 2023': '25.6%',
    'May 2023': '22.3%'
  }
};

const FALLBACK_UPDATES = {
  source: 'fallback',
  announcements: [
    { title: 'CA Foundation Study Material Updated for 2024-25', date: '2024-07-01', category: 'Study Material', url: 'https://www.icai.org/post/foundation' },
    { title: 'New Mock Test Series Available for CA Foundation', date: '2024-06-15', category: 'Mock Tests', url: 'https://www.icai.org/post/mock-tests' },
    { title: 'Registration Open for November 2026 Exam', date: '2026-04-01', category: 'Registration', url: 'https://www.icai.org/post/examinations' },
    { title: 'ICAI Releases Result for May 2024 CA Foundation', date: '2024-08-10', category: 'Results', url: 'https://www.icai.org/post/result' },
    { title: 'Revision Test Papers for CA Foundation Released', date: '2024-09-01', category: 'Study Material', url: 'https://www.icai.org/post/rtp' }
  ],
  important_links: [
    { title: 'ICAI Official Website', url: 'https://www.icai.org' },
    { title: 'CA Foundation Registration', url: 'https://eservices.icai.org' },
    { title: 'Study Material Download', url: 'https://www.icai.org/post/foundation' },
    { title: 'Exam Form Submission', url: 'https://icaiexam.icai.org' },
    { title: 'Mock Test Portal', url: 'https://icaiknowledgeportal.icai.org' },
    { title: 'Admit Card', url: 'https://icaiexam.icai.org' }
  ]
};

// ─── Scrapers ────────────────────────────────────────────────────────────────

async function scrapeSyllabus() {
  try {
    const { data: html } = await axios.get('https://www.icai.org/post/foundation', {
      headers: HEADERS,
      timeout: 10000
    });
    const $ = cheerio.load(html);
    const items = [];

    // Try to extract structured content
    $('h2, h3, h4, li, p').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 10 && text.length < 500) {
        items.push(text);
      }
    });

    if (items.length < 5) throw new Error('Insufficient scraped data');

    return {
      source: 'scraped',
      scraped_at: new Date().toISOString(),
      raw_content: items.slice(0, 100),
      structured: FALLBACK_SYLLABUS.papers // Always return structured from fallback
    };
  } catch (err) {
    console.error('Syllabus scrape failed:', err.message);
    return null;
  }
}

async function scrapeExams() {
  try {
    const { data: html } = await axios.get('https://www.icai.org/post/examinations', {
      headers: HEADERS,
      timeout: 10000
    });
    const $ = cheerio.load(html);
    const items = [];

    $('table tr, .exam-date, h2, h3, li').each((i, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text.length > 5 && text.length < 300) items.push(text);
    });

    if (items.length < 3) throw new Error('Insufficient exam data');

    return {
      source: 'scraped',
      scraped_at: new Date().toISOString(),
      raw_content: items.slice(0, 50),
      structured: FALLBACK_EXAMS
    };
  } catch (err) {
    console.error('Exam scrape failed:', err.message);
    return null;
  }
}

async function scrapeUpdates() {
  try {
    const { data: html } = await axios.get('https://www.icai.org/announcement', {
      headers: HEADERS,
      timeout: 10000
    });
    const $ = cheerio.load(html);
    const announcements = [];

    // Try various selectors
    $('a[href], .announcement-item, .news-item, li a').each((i, el) => {
      const title = $(el).text().trim();
      const href = $(el).attr('href') || '';
      if (title.length > 10 && title.length < 300 &&
          (title.toLowerCase().includes('foundation') ||
           title.toLowerCase().includes('exam') ||
           title.toLowerCase().includes('result') ||
           title.toLowerCase().includes('registration'))) {
        announcements.push({
          title,
          url: href.startsWith('http') ? href : `https://www.icai.org${href}`,
          date: new Date().toISOString().split('T')[0]
        });
      }
    });

    if (announcements.length < 2) throw new Error('Insufficient updates');

    return {
      source: 'scraped',
      scraped_at: new Date().toISOString(),
      announcements: announcements.slice(0, 10),
      important_links: FALLBACK_UPDATES.important_links
    };
  } catch (err) {
    console.error('Updates scrape failed:', err.message);
    return null;
  }
}

// ─── GET /api/icai/syllabus ──────────────────────────────────────────────────

router.get('/syllabus', async (req, res) => {
  try {
    const CACHE_KEY = 'icai_syllabus_cache';
    const TTL_HOURS = 24;

    const cached = await getCached(CACHE_KEY);
    if (cached && !isCacheExpired(cached.updated_at, TTL_HOURS)) {
      return res.json({ ...cached.value, from_cache: true });
    }

    const scraped = await scrapeSyllabus();
    const result = scraped || { ...FALLBACK_SYLLABUS, source: 'fallback' };

    await setCache(CACHE_KEY, result);
    res.json({ ...result, from_cache: false });

  } catch (err) {
    console.error('Syllabus route error:', err);
    res.json({ ...FALLBACK_SYLLABUS, source: 'fallback', error: err.message });
  }
});

// ─── GET /api/icai/exams ─────────────────────────────────────────────────────

router.get('/exams', async (req, res) => {
  try {
    const CACHE_KEY = 'icai_exams_cache';
    const TTL_HOURS = 6;

    const cached = await getCached(CACHE_KEY);
    if (cached && !isCacheExpired(cached.updated_at, TTL_HOURS)) {
      return res.json({ ...cached.value, from_cache: true });
    }

    const scraped = await scrapeExams();
    const result = scraped || { ...FALLBACK_EXAMS, source: 'fallback' };

    await setCache(CACHE_KEY, result);
    res.json({ ...result, from_cache: false });

  } catch (err) {
    console.error('Exams route error:', err);
    res.json({ ...FALLBACK_EXAMS, source: 'fallback', error: err.message });
  }
});

// ─── GET /api/icai/updates ───────────────────────────────────────────────────

router.get('/updates', async (req, res) => {
  try {
    const CACHE_KEY = 'icai_updates_cache';
    const TTL_HOURS = 6;

    const cached = await getCached(CACHE_KEY);
    if (cached && !isCacheExpired(cached.updated_at, TTL_HOURS)) {
      return res.json({ ...cached.value, from_cache: true });
    }

    const scraped = await scrapeUpdates();
    const result = scraped || { ...FALLBACK_UPDATES, source: 'fallback' };

    await setCache(CACHE_KEY, result);
    res.json({ ...result, from_cache: false });

  } catch (err) {
    console.error('Updates route error:', err);
    res.json({ ...FALLBACK_UPDATES, source: 'fallback', error: err.message });
  }
});

// ─── GET /api/icai/all ───────────────────────────────────────────────────────

router.get('/all', async (req, res) => {
  try {
    const [syllabusCache, examsCache, updatesCache] = await Promise.all([
      getCached('icai_syllabus_cache'),
      getCached('icai_exams_cache'),
      getCached('icai_updates_cache')
    ]);

    const results = await Promise.allSettled([
      syllabusCache && !isCacheExpired(syllabusCache.updated_at, 24)
        ? Promise.resolve(syllabusCache.value)
        : scrapeSyllabus(),
      examsCache && !isCacheExpired(examsCache.updated_at, 6)
        ? Promise.resolve(examsCache.value)
        : scrapeExams(),
      updatesCache && !isCacheExpired(updatesCache.updated_at, 6)
        ? Promise.resolve(updatesCache.value)
        : scrapeUpdates()
    ]);

    const syllabus = results[0].status === 'fulfilled' && results[0].value
      ? results[0].value : { ...FALLBACK_SYLLABUS, source: 'fallback' };
    const exams = results[1].status === 'fulfilled' && results[1].value
      ? results[1].value : { ...FALLBACK_EXAMS, source: 'fallback' };
    const updates = results[2].status === 'fulfilled' && results[2].value
      ? results[2].value : { ...FALLBACK_UPDATES, source: 'fallback' };

    // Cache all
    await Promise.allSettled([
      setCache('icai_syllabus_cache', syllabus),
      setCache('icai_exams_cache', exams),
      setCache('icai_updates_cache', updates)
    ]);

    res.json({ syllabus, exams, updates, fetched_at: new Date().toISOString() });

  } catch (err) {
    console.error('ICAI all route error:', err);
    res.json({
      syllabus: { ...FALLBACK_SYLLABUS, source: 'fallback' },
      exams: { ...FALLBACK_EXAMS, source: 'fallback' },
      updates: { ...FALLBACK_UPDATES, source: 'fallback' },
      error: err.message
    });
  }
});

export default router;
