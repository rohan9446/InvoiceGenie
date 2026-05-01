const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const Stripe = require('stripe');
require('dotenv').config();

const app = express();
const PORT = 8000;
const JWT_SECRET = process.env.JWT_SECRET || 'invoicegenie-dev-secret';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors({ origin: '*' }));
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

// --- Auth middleware ---
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    // Check trial expiry
    pool.query('SELECT plan, created_at FROM users WHERE id = $1', [req.user.id]).then(result => {
      const user = result.rows[0];
      if (user && user.plan === 'trial') {
        const created = new Date(user.created_at);
        const now = new Date();
        const daysSinceSignup = (now - created) / (1000 * 60 * 60 * 24);
        if (daysSinceSignup > 14) {
          pool.query("UPDATE users SET plan = 'free' WHERE id = $1", [req.user.id]);
        }
      }
      next();
    }).catch(() => next());
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Plan limits middleware ---
function checkLimit(type) {
  return async (req, res, next) => {
    const userResult = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];
    if (user.plan === 'pro' || user.plan === 'trial') return next();

    const limits = { clients: 3, invoices: 5, expenses: 10 };
    const countResult = await pool.query(`SELECT COUNT(*) as c FROM ${type} WHERE user_id = $1`, [req.user.id]);
    const count = parseInt(countResult.rows[0].c);

    if (count >= limits[type]) {
      return res.status(403).json({ error: `Free plan limit: ${limits[type]} ${type}. Upgrade to Pro for unlimited.` });
    }
    next();
  };
}

// --- Auth routes ---
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password, business_name } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) return res.status(400).json({ error: 'Email already registered' });

    const hash = bcrypt.hashSync(password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password, business_name, plan) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, email, hash, business_name || '', 'trial']
    );

    const token = jwt.sign({ id: result.rows[0].id, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: result.rows[0].id, name, email, business_name, plan: 'trial' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, business_name: user.business_name, plan: user.plan || 'free' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Health ---
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'InvoiceGenie API', database: 'connected' });
  } catch {
    res.json({ status: 'ok', service: 'InvoiceGenie API', database: 'error' });
  }
});

// --- Client routes ---
app.get('/api/clients', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM clients WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(result.rows);
});

app.post('/api/clients', auth, checkLimit('clients'), async (req, res) => {
  const { name, email, phone, company } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name is required' });

  const result = await pool.query(
    'INSERT INTO clients (user_id, name, email, phone, company) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [req.user.id, name, email || '', phone || '', company || '']
  );
  res.json(result.rows[0]);
});

app.put('/api/clients/:id', auth, async (req, res) => {
  const { name, email, phone, company } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name is required' });

  const check = await pool.query('SELECT * FROM clients WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (check.rows.length === 0) return res.status(404).json({ error: 'Client not found' });

  const result = await pool.query(
    'UPDATE clients SET name = $1, email = $2, phone = $3, company = $4 WHERE id = $5 RETURNING *',
    [name, email || '', phone || '', company || '', req.params.id]
  );
  res.json(result.rows[0]);
});

app.delete('/api/clients/:id', auth, async (req, res) => {
  const check = await pool.query('SELECT * FROM clients WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (check.rows.length === 0) return res.status(404).json({ error: 'Client not found' });

  await pool.query('DELETE FROM clients WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// --- Invoice routes ---
app.get('/api/invoices', auth, async (req, res) => {
  const result = await pool.query(
    'SELECT invoices.*, clients.name as client_name FROM invoices JOIN clients ON invoices.client_id = clients.id WHERE invoices.user_id = $1 ORDER BY invoices.created_at DESC',
    [req.user.id]
  );
  res.json(result.rows);
});

app.post('/api/invoices', auth, checkLimit('invoices'), async (req, res) => {
  const { client_id, due_date, items, tax_rate, notes } = req.body;
  if (!client_id || !items || items.length === 0) return res.status(400).json({ error: 'Client and at least one item required' });

  const countResult = await pool.query('SELECT COUNT(*) as c FROM invoices WHERE user_id = $1', [req.user.id]);
  const count = parseInt(countResult.rows[0].c);
  const invoice_number = 'INV-' + String(count + 1).padStart(4, '0');

  const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
  const rate = tax_rate || 0;
  const total = subtotal + (subtotal * rate / 100);

  const result = await pool.query(
    'INSERT INTO invoices (user_id, client_id, invoice_number, due_date, items, subtotal, tax_rate, total, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
    [req.user.id, client_id, invoice_number, due_date || '', JSON.stringify(items), subtotal, rate, total, notes || '']
  );

  const invoice = await pool.query(
    'SELECT invoices.*, clients.name as client_name FROM invoices JOIN clients ON invoices.client_id = clients.id WHERE invoices.id = $1',
    [result.rows[0].id]
  );
  res.json(invoice.rows[0]);
});

app.put('/api/invoices/:id', auth, async (req, res) => {
  const { client_id, due_date, items, tax_rate, notes } = req.body;
  if (!client_id || !items || items.length === 0) return res.status(400).json({ error: 'Client and at least one item required' });

  const check = await pool.query('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (check.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });

  const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
  const rate = tax_rate || 0;
  const total = subtotal + (subtotal * rate / 100);

  await pool.query(
    'UPDATE invoices SET client_id = $1, due_date = $2, items = $3, subtotal = $4, tax_rate = $5, total = $6, notes = $7 WHERE id = $8',
    [client_id, due_date || '', JSON.stringify(items), subtotal, rate, total, notes || '', req.params.id]
  );

  const invoice = await pool.query(
    'SELECT invoices.*, clients.name as client_name FROM invoices JOIN clients ON invoices.client_id = clients.id WHERE invoices.id = $1',
    [req.params.id]
  );
  res.json(invoice.rows[0]);
});

app.patch('/api/invoices/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  const valid = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const check = await pool.query('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (check.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
  const invoice = check.rows[0];

  await pool.query('UPDATE invoices SET status = $1 WHERE id = $2', [status, req.params.id]);

  if (status === 'paid') {
    const existing = await pool.query('SELECT * FROM payments WHERE invoice_id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      await pool.query(
        'INSERT INTO payments (user_id, invoice_id, amount, method, date) VALUES ($1, $2, $3, $4, $5)',
        [req.user.id, req.params.id, invoice.total, 'bank_transfer', new Date().toISOString().split('T')[0]]
      );
    }
  }

  res.json({ success: true, status });
});

app.delete('/api/invoices/:id', auth, async (req, res) => {
  const check = await pool.query('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (check.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });

  await pool.query('DELETE FROM payments WHERE invoice_id = $1', [req.params.id]);
  await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// --- PDF export ---
app.get('/api/invoices/:id/pdf', async (req, res) => {
  const token = req.query.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }

  const planCheck = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
  if (planCheck.rows[0].plan !== 'pro' && planCheck.rows[0].plan !== 'trial') {
    return res.status(403).json({ error: 'PDF export is a Pro feature. Upgrade to unlock.' });
  }

  const invoiceResult = await pool.query(
    `SELECT invoices.*, clients.name as client_name, clients.email as client_email,
    clients.company as client_company, clients.phone as client_phone
    FROM invoices JOIN clients ON invoices.client_id = clients.id
    WHERE invoices.id = $1 AND invoices.user_id = $2`,
    [req.params.id, req.user.id]
  );

  if (invoiceResult.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
  const invoice = invoiceResult.rows[0];

  const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = userResult.rows[0];
  const items = typeof invoice.items === 'string' ? JSON.parse(invoice.items) : invoice.items;

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${invoice.invoice_number}.pdf`);
  doc.pipe(res);

  doc.fontSize(24).font('Helvetica-Bold').fillColor('#635bff').text(user.business_name || user.name, 50, 50);
  doc.fontSize(10).font('Helvetica').fillColor('#888').text(user.email, 50, 80);
  doc.fontSize(28).font('Helvetica-Bold').fillColor('#1b1f36').text('INVOICE', 400, 50, { align: 'right' });
  doc.fontSize(11).font('Helvetica').fillColor('#5a607a').text(invoice.invoice_number, 400, 85, { align: 'right' });

  doc.moveTo(50, 110).lineTo(545, 110).strokeColor('#e0e4ef').lineWidth(1).stroke();

  let y = 130;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#8e94ad').text('BILL TO', 50, y);
  y += 18;
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1b1f36').text(invoice.client_name, 50, y);
  y += 18;
  if (invoice.client_company) { doc.fontSize(10).font('Helvetica').fillColor('#5a607a').text(invoice.client_company, 50, y); y += 16; }
  if (invoice.client_email) { doc.fontSize(10).font('Helvetica').fillColor('#5a607a').text(invoice.client_email, 50, y); y += 16; }
  if (invoice.client_phone) { doc.fontSize(10).font('Helvetica').fillColor('#5a607a').text(invoice.client_phone, 50, y); y += 16; }

  let yd = 130;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#8e94ad').text('INVOICE DETAILS', 350, yd, { align: 'right' });
  yd += 18;
  const createdDate = invoice.created_at instanceof Date ? invoice.created_at.toISOString().split('T')[0] : String(invoice.created_at).split('T')[0];
  doc.fontSize(10).font('Helvetica').fillColor('#5a607a').text(`Date: ${createdDate}`, 350, yd, { align: 'right' });
  yd += 16;
  if (invoice.due_date) { doc.text(`Due: ${invoice.due_date}`, 350, yd, { align: 'right' }); yd += 16; }
  doc.text(`Status: ${invoice.status.toUpperCase()}`, 350, yd, { align: 'right' });

  let ty = Math.max(y, yd) + 30;
  doc.rect(50, ty, 495, 28).fill('#f0f2f8');
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#5a607a');
  doc.text('DESCRIPTION', 60, ty + 9);
  doc.text('QTY', 340, ty + 9, { width: 50, align: 'center' });
  doc.text('PRICE', 400, ty + 9, { width: 60, align: 'right' });
  doc.text('TOTAL', 475, ty + 9, { width: 60, align: 'right' });
  ty += 28;

  items.forEach((item, i) => {
    const rowBg = i % 2 === 0 ? '#ffffff' : '#f8f9fc';
    doc.rect(50, ty, 495, 26).fill(rowBg);
    doc.fontSize(10).font('Helvetica').fillColor('#1b1f36');
    doc.text(item.description || 'Item', 60, ty + 8, { width: 270 });
    doc.text(String(item.quantity), 340, ty + 8, { width: 50, align: 'center' });
    doc.text('$' + Number(item.price).toFixed(2), 400, ty + 8, { width: 60, align: 'right' });
    doc.text('$' + (item.quantity * item.price).toFixed(2), 475, ty + 8, { width: 60, align: 'right' });
    ty += 26;
  });

  doc.moveTo(350, ty + 10).lineTo(545, ty + 10).strokeColor('#e0e4ef').lineWidth(1).stroke();
  ty += 20;
  doc.fontSize(10).font('Helvetica').fillColor('#5a607a');
  doc.text('Subtotal', 350, ty, { width: 100, align: 'right' });
  doc.text('$' + invoice.subtotal.toFixed(2), 475, ty, { width: 60, align: 'right' });
  ty += 20;

  if (invoice.tax_rate > 0) {
    doc.text(`Tax (${invoice.tax_rate}%)`, 350, ty, { width: 100, align: 'right' });
    doc.text('$' + (invoice.subtotal * invoice.tax_rate / 100).toFixed(2), 475, ty, { width: 60, align: 'right' });
    ty += 20;
  }

  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1b1f36');
  doc.text('Total', 350, ty, { width: 100, align: 'right' });
  doc.text('$' + invoice.total.toFixed(2), 460, ty, { width: 75, align: 'right' });

  if (invoice.notes) {
    ty += 40;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#8e94ad').text('NOTES', 50, ty);
    ty += 16;
    doc.fontSize(10).font('Helvetica').fillColor('#5a607a').text(invoice.notes, 50, ty, { width: 300 });
  }

  doc.fontSize(9).font('Helvetica').fillColor('#8e94ad').text('Generated by InvoiceGenie', 50, 770, { align: 'center', width: 495 });
  doc.end();
});

// --- Expense routes ---
app.get('/api/expenses', auth, async (req, res) => {
  const result = await pool.query('SELECT * FROM expenses WHERE user_id = $1 ORDER BY date DESC', [req.user.id]);
  res.json(result.rows);
});

app.post('/api/expenses', auth, checkLimit('expenses'), async (req, res) => {
  const { amount, category, description, date } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount is required' });

  const result = await pool.query(
    'INSERT INTO expenses (user_id, amount, category, description, date) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [req.user.id, amount, category || 'other', description || '', date || new Date().toISOString().split('T')[0]]
  );
  res.json(result.rows[0]);
});

app.put('/api/expenses/:id', auth, async (req, res) => {
  const { amount, category, description, date } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount is required' });

  const check = await pool.query('SELECT * FROM expenses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (check.rows.length === 0) return res.status(404).json({ error: 'Expense not found' });

  const result = await pool.query(
    'UPDATE expenses SET amount = $1, category = $2, description = $3, date = $4 WHERE id = $5 RETURNING *',
    [amount, category || 'other', description || '', date || check.rows[0].date, req.params.id]
  );
  res.json(result.rows[0]);
});

app.delete('/api/expenses/:id', auth, async (req, res) => {
  const check = await pool.query('SELECT * FROM expenses WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (check.rows.length === 0) return res.status(404).json({ error: 'Expense not found' });

  await pool.query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// --- Dashboard ---
app.get('/api/dashboard', auth, async (req, res) => {
  // Auto-mark overdue
  const today = new Date().toISOString().split('T')[0];
  await pool.query("UPDATE invoices SET status = 'overdue' WHERE user_id = $1 AND status IN ('draft', 'sent') AND due_date != '' AND due_date < $2", [req.user.id, today]);

  const totalInvoiced = (await pool.query('SELECT COALESCE(SUM(total), 0) as val FROM invoices WHERE user_id = $1', [req.user.id])).rows[0].val;
  const totalPaid = (await pool.query('SELECT COALESCE(SUM(amount), 0) as val FROM payments WHERE user_id = $1', [req.user.id])).rows[0].val;
  const totalExpenses = (await pool.query('SELECT COALESCE(SUM(amount), 0) as val FROM expenses WHERE user_id = $1', [req.user.id])).rows[0].val;
  const invoiceCount = (await pool.query('SELECT COUNT(*) as val FROM invoices WHERE user_id = $1', [req.user.id])).rows[0].val;
  const clientCount = (await pool.query('SELECT COUNT(*) as val FROM clients WHERE user_id = $1', [req.user.id])).rows[0].val;
  const unpaid = (await pool.query("SELECT COALESCE(SUM(total), 0) as val FROM invoices WHERE user_id = $1 AND status != 'paid' AND status != 'cancelled'", [req.user.id])).rows[0].val;
  const overdueCount = (await pool.query("SELECT COUNT(*) as val FROM invoices WHERE user_id = $1 AND status = 'overdue'", [req.user.id])).rows[0].val;

  const recentInvoices = (await pool.query(
    "SELECT invoices.invoice_number, invoices.total, invoices.status, clients.name as client_name FROM invoices JOIN clients ON invoices.client_id = clients.id WHERE invoices.user_id = $1 ORDER BY invoices.created_at DESC LIMIT 5",
    [req.user.id]
  )).rows;

  const expensesByCategory = (await pool.query(
    'SELECT category, SUM(amount) as total FROM expenses WHERE user_id = $1 GROUP BY category ORDER BY total DESC',
    [req.user.id]
  )).rows;

  const monthlyData = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const label = d.toLocaleString('default', { month: 'short' });
    const prefix = `${year}-${month}`;

    const income = (await pool.query("SELECT COALESCE(SUM(amount), 0) as val FROM payments WHERE user_id = $1 AND date LIKE $2", [req.user.id, prefix + '%'])).rows[0].val;
    const expense = (await pool.query("SELECT COALESCE(SUM(amount), 0) as val FROM expenses WHERE user_id = $1 AND date LIKE $2", [req.user.id, prefix + '%'])).rows[0].val;

    monthlyData.push({ label, income: parseFloat(income), expense: parseFloat(expense) });
  }

  res.json({
    totalInvoiced: parseFloat(totalInvoiced),
    totalPaid: parseFloat(totalPaid),
    totalExpenses: parseFloat(totalExpenses),
    invoiceCount: parseInt(invoiceCount),
    clientCount: parseInt(clientCount),
    unpaid: parseFloat(unpaid),
    overdueCount: parseInt(overdueCount),
    profit: parseFloat(totalPaid) - parseFloat(totalExpenses),
    recentInvoices,
    expensesByCategory,
    monthlyData
  });
});

// --- AI routes ---
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_KEY = process.env.GROQ_API_KEY;

app.get('/api/ai/insights', auth, async (req, res) => {
  const planCheck = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
  if (planCheck.rows[0].plan !== 'pro' && planCheck.rows[0].plan !== 'trial') {
    return res.status(403).json({ error: 'AI insights is a Pro feature. Upgrade to unlock.' });
  }
  try {
    const invoices = (await pool.query('SELECT invoices.*, clients.name as client_name FROM invoices JOIN clients ON invoices.client_id = clients.id WHERE invoices.user_id = $1', [req.user.id])).rows;
    const expenses = (await pool.query('SELECT * FROM expenses WHERE user_id = $1', [req.user.id])).rows;
    const payments = (await pool.query('SELECT * FROM payments WHERE user_id = $1', [req.user.id])).rows;

    const totalInvoiced = invoices.reduce((s, i) => s + parseFloat(i.total), 0);
    const totalPaid = payments.reduce((s, p) => s + parseFloat(p.amount), 0);
    const totalExpenses = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);

    const prompt = `You are a smart financial assistant for a freelancer/small business. Analyze this data and give 4-5 short, actionable insights. Be specific with numbers. Use a friendly, professional tone.

FINANCIAL DATA:
- Total invoiced: $${totalInvoiced.toFixed(2)}
- Total paid: $${totalPaid.toFixed(2)}
- Unpaid: $${(totalInvoiced - totalPaid).toFixed(2)}
- Total expenses: $${totalExpenses.toFixed(2)}
- Profit: $${(totalPaid - totalExpenses).toFixed(2)}
- Number of invoices: ${invoices.length}
- Invoice statuses: ${JSON.stringify(invoices.map(i => ({ number: i.invoice_number, client: i.client_name, total: i.total, status: i.status })))}
- Expenses by category: ${JSON.stringify(expenses.map(e => ({ amount: e.amount, category: e.category, description: e.description, date: e.date })))}

Respond with a JSON array of objects, each with "title" (short heading) and "body" (1-2 sentence insight). Nothing else, no markdown, no backticks.`;

    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 600
      })
    });

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '[]';
    const insights = JSON.parse(text);
    res.json(insights);
  } catch (err) {
    console.error('AI error:', err);
    res.json([{ title: 'AI unavailable', body: 'Could not generate insights right now. Try again later.' }]);
  }
});

app.post('/api/ai/categorize', auth, async (req, res) => {
  try {
    const { description, amount } = req.body;
    const prompt = `Categorize this business expense into exactly one of these categories: software, hardware, travel, food, office, marketing, utilities, rent, other.

Expense: "${description}" — $${amount}

Respond with just the category name, nothing else.`;

    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 20
      })
    });

    const data = await response.json();
    const category = data.choices?.[0]?.message?.content?.trim().toLowerCase() || 'other';
    res.json({ category });
  } catch (err) {
    console.error('AI categorize error:', err);
    res.json({ category: 'other' });
  }
});

// --- User profile routes ---
app.get('/api/user/profile', auth, async (req, res) => {
  const result = await pool.query('SELECT id, name, email, business_name, currency, created_at FROM users WHERE id = $1', [req.user.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
  res.json(result.rows[0]);
});

app.put('/api/user/profile', auth, async (req, res) => {
  const { name, email, business_name, currency } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });

  const existing = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email, req.user.id]);
  if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already in use by another account' });

  await pool.query('UPDATE users SET name = $1, email = $2, business_name = $3, currency = $4 WHERE id = $5',
    [name, email, business_name || '', currency || 'USD', req.user.id]);

  const result = await pool.query('SELECT id, name, email, business_name, currency, created_at FROM users WHERE id = $1', [req.user.id]);
  res.json(result.rows[0]);
});

app.put('/api/user/password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both fields required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const user = userResult.rows[0];
  if (!bcrypt.compareSync(current_password, user.password)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.user.id]);
  res.json({ success: true, message: 'Password updated' });
});

// --- Subscription routes ---
app.get('/api/subscription', auth, async (req, res) => {
  const result = await pool.query('SELECT plan, stripe_customer_id FROM users WHERE id = $1', [req.user.id]);
  const user = result.rows[0];
  res.json({ plan: user.plan || 'free', stripe_customer_id: user.stripe_customer_id || '' });
});

app.post('/api/subscription/checkout', auth, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = userResult.rows[0];

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, user.id]);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: 'http://invoicegenie-frontend-rohan.s3-website-us-east-1.amazonaws.com?upgrade=success',
      cancel_url: 'http://invoicegenie-frontend-rohan.s3-website-us-east-1.amazonaws.com?upgrade=cancelled',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/api/subscription/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const parsed = JSON.parse(req.body);
    if (parsed.type === 'checkout.session.completed') {
      await pool.query("UPDATE users SET plan = 'pro' WHERE stripe_customer_id = $1", [parsed.data.object.customer]);
    }
    if (parsed.type === 'customer.subscription.deleted') {
      await pool.query("UPDATE users SET plan = 'free' WHERE stripe_customer_id = $1", [parsed.data.object.customer]);
    }
  } catch (e) { console.error('Webhook error:', e); }
  res.json({ received: true });
});

app.post('/api/subscription/portal', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user.stripe_customer_id) return res.status(400).json({ error: 'No subscription found' });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: 'http://invoicegenie-frontend-rohan.s3-website-us-east-1.amazonaws.com',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Failed to open portal' });
  }
});

// --- Auto-detect overdue invoices ---
app.post('/api/invoices/check-overdue', auth, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const result = await pool.query(
    "UPDATE invoices SET status = 'overdue' WHERE user_id = $1 AND status IN ('draft', 'sent') AND due_date != '' AND due_date < $2",
    [req.user.id, today]
  );
  res.json({ updated: result.rowCount });
});

// --- Documents endpoint for backward compat ---
app.get('/api/documents/all', auth, async (req, res) => {
  res.json([]);
});

app.listen(PORT, () => {
  console.log(`InvoiceGenie backend running on http://localhost:${PORT}`);
});