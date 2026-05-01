const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();
const PDFDocument = require('pdfkit');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = 8000;
const JWT_SECRET = process.env.JWT_SECRET || 'invoicegenie-dev-secret';

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json());

// --- Database setup ---
const db = new Database('invoicegenie.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    business_name TEXT DEFAULT '',
    currency TEXT DEFAULT 'USD',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    company TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    client_id INTEGER NOT NULL,
    invoice_number TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    due_date TEXT,
    items TEXT DEFAULT '[]',
    subtotal REAL DEFAULT 0,
    tax_rate REAL DEFAULT 0,
    total REAL DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    category TEXT DEFAULT 'other',
    description TEXT DEFAULT '',
    date TEXT DEFAULT (date('now')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    invoice_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT DEFAULT 'bank_transfer',
    date TEXT DEFAULT (date('now')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (invoice_id) REFERENCES invoices(id)
  );
`);

try { db.exec("ALTER TABLE users ADD COLUMN currency TEXT DEFAULT 'USD'"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT DEFAULT ''"); } catch (e) {}

// --- Auth middleware ---
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);

    // Check trial expiry
    const user = db.prepare('SELECT plan, created_at FROM users WHERE id = ?').get(req.user.id);
    if (user && user.plan === 'trial') {
      const created = new Date(user.created_at);
      const now = new Date();
      const daysSinceSignup = (now - created) / (1000 * 60 * 60 * 24);
      if (daysSinceSignup > 14) {
        db.prepare("UPDATE users SET plan = 'free' WHERE id = ?").run(req.user.id);
      }
    }

    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Auth routes ---
app.post('/api/auth/signup', (req, res) => {
  const { name, email, password, business_name } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (exists) return res.status(400).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (name, email, password, business_name, plan) VALUES (?, ?, ?, ?, ?)').run(name, email, hash, business_name || '', 'trial');

  const token = jwt.sign({ id: result.lastInsertRowid, email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: result.lastInsertRowid, name, email, business_name, plan: 'trial' } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, business_name: user.business_name, plan: user.plan || 'free' } });
});

// --- Health ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'InvoiceGenie API' });
});


// --- Client routes ---
app.get('/api/clients', auth, (req, res) => {
  const clients = db.prepare('SELECT * FROM clients WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(clients);
});

app.post('/api/clients', auth, checkLimit('clients'), (req, res) => {
  const { name, email, phone, company } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name is required' });

  const result = db.prepare('INSERT INTO clients (user_id, name, email, phone, company) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, name, email || '', phone || '', company || '');

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(result.lastInsertRowid);
  res.json(client);
});

app.put('/api/clients/:id', auth, (req, res) => {
  const { name, email, phone, company } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name is required' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  db.prepare('UPDATE clients SET name = ?, email = ?, phone = ?, company = ? WHERE id = ?')
    .run(name, email || '', phone || '', company || '', req.params.id);

  const updated = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.delete('/api/clients/:id', auth, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Invoice routes ---
app.get('/api/invoices', auth, (req, res) => {
  const invoices = db.prepare(`
    SELECT invoices.*, clients.name as client_name 
    FROM invoices 
    JOIN clients ON invoices.client_id = clients.id 
    WHERE invoices.user_id = ? 
    ORDER BY invoices.created_at DESC
  `).all(req.user.id);
  invoices.forEach(inv => { inv.items = JSON.parse(inv.items) });
  res.json(invoices);
});

app.post('/api/invoices', auth, checkLimit('invoices'), (req, res) => {
  const { client_id, due_date, items, tax_rate, notes } = req.body;
  if (!client_id || !items || items.length === 0) return res.status(400).json({ error: 'Client and at least one item required' });

  const count = db.prepare('SELECT COUNT(*) as c FROM invoices WHERE user_id = ?').get(req.user.id).c;
  const invoice_number = 'INV-' + String(count + 1).padStart(4, '0');

  const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
  const rate = tax_rate || 0;
  const total = subtotal + (subtotal * rate / 100);

  const result = db.prepare(`
    INSERT INTO invoices (user_id, client_id, invoice_number, due_date, items, subtotal, tax_rate, total, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, client_id, invoice_number, due_date || '', JSON.stringify(items), subtotal, rate, total, notes || '');

  const invoice = db.prepare(`
    SELECT invoices.*, clients.name as client_name 
    FROM invoices 
    JOIN clients ON invoices.client_id = clients.id 
    WHERE invoices.id = ?
  `).get(result.lastInsertRowid);
  invoice.items = JSON.parse(invoice.items);
  res.json(invoice);
});

app.put('/api/invoices/:id', auth, (req, res) => {
  const { client_id, due_date, items, tax_rate, notes } = req.body;
  if (!client_id || !items || items.length === 0) return res.status(400).json({ error: 'Client and at least one item required' });

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.price), 0);
  const rate = tax_rate || 0;
  const total = subtotal + (subtotal * rate / 100);

  db.prepare(`UPDATE invoices SET client_id = ?, due_date = ?, items = ?, subtotal = ?, tax_rate = ?, total = ?, notes = ? WHERE id = ?`)
    .run(client_id, due_date || '', JSON.stringify(items), subtotal, rate, total, notes || '', req.params.id);

  const updated = db.prepare(`
    SELECT invoices.*, clients.name as client_name 
    FROM invoices JOIN clients ON invoices.client_id = clients.id 
    WHERE invoices.id = ?
  `).get(req.params.id);
  updated.items = JSON.parse(updated.items);
  res.json(updated);
});

app.patch('/api/invoices/:id/status', auth, (req, res) => {
  const { status } = req.body;
  const valid = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, req.params.id);

  if (status === 'paid') {
    const existing = db.prepare('SELECT * FROM payments WHERE invoice_id = ?').get(req.params.id);
    if (!existing) {
      db.prepare('INSERT INTO payments (user_id, invoice_id, amount, method, date) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, req.params.id, invoice.total, 'bank_transfer', new Date().toISOString().split('T')[0]);
    }
  }

  res.json({ success: true, status });
});

app.delete('/api/invoices/:id', auth, (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  db.prepare('DELETE FROM payments WHERE invoice_id = ?').run(req.params.id);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Expense routes ---
app.get('/api/expenses', auth, (req, res) => {
  const expenses = db.prepare('SELECT * FROM expenses WHERE user_id = ? ORDER BY date DESC').all(req.user.id);
  res.json(expenses);
});

app.post('/api/expenses', auth, checkLimit('expenses'), (req, res) => {
  const { amount, category, description, date } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount is required' });

  const result = db.prepare('INSERT INTO expenses (user_id, amount, category, description, date) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, amount, category || 'other', description || '', date || new Date().toISOString().split('T')[0]);

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid);
  res.json(expense);
});

app.put('/api/expenses/:id', auth, (req, res) => {
  const { amount, category, description, date } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount is required' });

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });

  db.prepare('UPDATE expenses SET amount = ?, category = ?, description = ?, date = ? WHERE id = ?')
    .run(amount, category || 'other', description || '', date || expense.date, req.params.id);

  const updated = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  res.json(updated);
});

app.delete('/api/expenses/:id', auth, (req, res) => {
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!expense) return res.status(404).json({ error: 'Expense not found' });

  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --- Auto-detect overdue invoices ---
app.post('/api/invoices/check-overdue', auth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const result = db.prepare(`
    UPDATE invoices SET status = 'overdue' 
    WHERE user_id = ? AND status IN ('draft', 'sent') AND due_date != '' AND due_date < ?
  `).run(req.user.id, today);
  res.json({ updated: result.changes });
});

// --- Dashboard stats ---
app.get('/api/dashboard', auth, (req, res) => {
  const totalInvoiced = db.prepare('SELECT COALESCE(SUM(total), 0) as val FROM invoices WHERE user_id = ?').get(req.user.id).val;
  const totalPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) as val FROM payments WHERE user_id = ?').get(req.user.id).val;
  const totalExpenses = db.prepare('SELECT COALESCE(SUM(amount), 0) as val FROM expenses WHERE user_id = ?').get(req.user.id).val;
  const invoiceCount = db.prepare('SELECT COUNT(*) as val FROM invoices WHERE user_id = ?').get(req.user.id).val;
  const clientCount = db.prepare('SELECT COUNT(*) as val FROM clients WHERE user_id = ?').get(req.user.id).val;
  // Auto-mark overdue
  const today = new Date().toISOString().split('T')[0];
  db.prepare(`UPDATE invoices SET status = 'overdue' WHERE user_id = ? AND status IN ('draft', 'sent') AND due_date != '' AND due_date < ?`).run(req.user.id, today);

  const overdueCount = db.prepare("SELECT COUNT(*) as val FROM invoices WHERE user_id = ? AND status = 'overdue'").get(req.user.id).val;
  const unpaid = db.prepare("SELECT COALESCE(SUM(total), 0) as val FROM invoices WHERE user_id = ? AND status != 'paid' AND status != 'cancelled'").get(req.user.id).val;

  const recentInvoices = db.prepare(`
    SELECT invoices.invoice_number, invoices.total, invoices.status, clients.name as client_name 
    FROM invoices JOIN clients ON invoices.client_id = clients.id 
    WHERE invoices.user_id = ? ORDER BY invoices.created_at DESC LIMIT 5
  `).all(req.user.id);

  const expensesByCategory = db.prepare(`
    SELECT category, SUM(amount) as total FROM expenses WHERE user_id = ? GROUP BY category ORDER BY total DESC
  `).all(req.user.id);

  // Monthly income vs expenses (last 6 months)
  const monthlyData = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const label = d.toLocaleString('default', { month: 'short' });
    const prefix = `${year}-${month}`;

    const income = db.prepare(`SELECT COALESCE(SUM(amount), 0) as val FROM payments WHERE user_id = ? AND date LIKE ?`).get(req.user.id, prefix + '%').val;
    const expense = db.prepare(`SELECT COALESCE(SUM(amount), 0) as val FROM expenses WHERE user_id = ? AND date LIKE ?`).get(req.user.id, prefix + '%').val;

    monthlyData.push({ label, income, expense });
  }

  res.json({
    totalInvoiced, totalPaid, totalExpenses, invoiceCount, clientCount, unpaid, overdueCount,
    profit: totalPaid - totalExpenses,
    recentInvoices, expensesByCategory, monthlyData
  });
});

// --- AI routes ---
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_KEY = process.env.GROQ_API_KEY;

app.get('/api/ai/insights', auth, async (req, res) => {
  const planCheck = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.id);
  if (planCheck.plan !== 'pro' && planCheck.plan !== 'trial') return res.status(403).json({ error: 'AI insights is a Pro feature. Upgrade to unlock.' });
  try {
    const invoices = db.prepare('SELECT invoices.*, clients.name as client_name FROM invoices JOIN clients ON invoices.client_id = clients.id WHERE invoices.user_id = ?').all(req.user.id);
    const expenses = db.prepare('SELECT * FROM expenses WHERE user_id = ?').all(req.user.id);
    const payments = db.prepare('SELECT * FROM payments WHERE user_id = ?').all(req.user.id);

    const totalInvoiced = invoices.reduce((s, i) => s + i.total, 0);
    const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
    const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

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

// --- PDF export ---
app.get('/api/invoices/:id/pdf', (req, res) => {
  const token = req.query.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ error: 'Invalid token' }); }

  const planCheck = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.id);
  if (planCheck.plan !== 'pro' && planCheck.plan !== 'trial') {
    const pdfCount = db.prepare("SELECT COUNT(*) as c FROM invoices WHERE user_id = ? AND id <= ?").get(req.user.id, req.params.id).c;
    if (pdfCount > 10) return res.status(403).json({ error: 'Free plan: 10 PDF exports. Upgrade to Pro for unlimited.' });
  }

  const invoice = db.prepare(`
    SELECT invoices.*, clients.name as client_name, clients.email as client_email, 
    clients.company as client_company, clients.phone as client_phone
    FROM invoices JOIN clients ON invoices.client_id = clients.id 
    WHERE invoices.id = ? AND invoices.user_id = ?
  `).get(req.params.id, req.user.id);

  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const items = JSON.parse(invoice.items);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=${invoice.invoice_number}.pdf`);
  doc.pipe(res);

  // Header
  doc.fontSize(24).font('Helvetica-Bold').fillColor('#635bff')
    .text(user.business_name || user.name, 50, 50);
  doc.fontSize(10).font('Helvetica').fillColor('#888')
    .text(user.email, 50, 80);

  // Invoice title
  doc.fontSize(28).font('Helvetica-Bold').fillColor('#1b1f36')
    .text('INVOICE', 400, 50, { align: 'right' });
  doc.fontSize(11).font('Helvetica').fillColor('#5a607a')
    .text(invoice.invoice_number, 400, 85, { align: 'right' });

  // Divider
  doc.moveTo(50, 110).lineTo(545, 110).strokeColor('#e0e4ef').lineWidth(1).stroke();

  // Bill To
  let y = 130;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#8e94ad').text('BILL TO', 50, y);
  y += 18;
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1b1f36').text(invoice.client_name, 50, y);
  y += 18;
  if (invoice.client_company) { doc.fontSize(10).font('Helvetica').fillColor('#5a607a').text(invoice.client_company, 50, y); y += 16; }
  if (invoice.client_email) { doc.fontSize(10).font('Helvetica').fillColor('#5a607a').text(invoice.client_email, 50, y); y += 16; }
  if (invoice.client_phone) { doc.fontSize(10).font('Helvetica').fillColor('#5a607a').text(invoice.client_phone, 50, y); y += 16; }

  // Invoice details (right side)
  let yd = 130;
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#8e94ad').text('INVOICE DETAILS', 350, yd, { align: 'right' });
  yd += 18;
  doc.fontSize(10).font('Helvetica').fillColor('#5a607a')
    .text(`Date: ${invoice.created_at.split('T')[0]}`, 350, yd, { align: 'right' });
  yd += 16;
  if (invoice.due_date) {
    doc.text(`Due: ${invoice.due_date}`, 350, yd, { align: 'right' });
    yd += 16;
  }
  doc.text(`Status: ${invoice.status.toUpperCase()}`, 350, yd, { align: 'right' });

  // Table header
  let ty = Math.max(y, yd) + 30;
  doc.rect(50, ty, 495, 28).fill('#f0f2f8');
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#5a607a');
  doc.text('DESCRIPTION', 60, ty + 9);
  doc.text('QTY', 340, ty + 9, { width: 50, align: 'center' });
  doc.text('PRICE', 400, ty + 9, { width: 60, align: 'right' });
  doc.text('TOTAL', 475, ty + 9, { width: 60, align: 'right' });
  ty += 28;

  // Table rows
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

  // Divider
  doc.moveTo(350, ty + 10).lineTo(545, ty + 10).strokeColor('#e0e4ef').lineWidth(1).stroke();

  // Totals
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

  // Notes
  if (invoice.notes) {
    ty += 40;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#8e94ad').text('NOTES', 50, ty);
    ty += 16;
    doc.fontSize(10).font('Helvetica').fillColor('#5a607a').text(invoice.notes, 50, ty, { width: 300 });
  }

  // Footer
  doc.fontSize(9).font('Helvetica').fillColor('#8e94ad')
    .text('Generated by InvoiceGenie', 50, 770, { align: 'center', width: 495 });

  doc.end();
});

// --- User profile routes ---
app.get('/api/user/profile', auth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, business_name, currency, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.put('/api/user/profile', auth, (req, res) => {
  const { name, email, business_name, currency } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
  if (name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email format' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.user.id);
  if (existing) return res.status(400).json({ error: 'Email already in use by another account' });

  db.prepare('UPDATE users SET name = ?, email = ?, business_name = ?, currency = ? WHERE id = ?')
    .run(name, email, business_name || '', currency || 'USD', req.user.id);

  const user = db.prepare('SELECT id, name, email, business_name, currency, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

app.put('/api/user/password', auth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both fields required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ success: true, message: 'Password updated' });
});

// --- Subscription routes ---
app.get('/api/subscription', auth, (req, res) => {
  const user = db.prepare('SELECT plan, stripe_customer_id FROM users WHERE id = ?').get(req.user.id);
  res.json({ plan: user.plan || 'free', stripe_customer_id: user.stripe_customer_id || '' });
});

app.post('/api/subscription/checkout', auth, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: 'http://localhost:5173?upgrade=success',
      cancel_url: 'http://localhost:5173?upgrade=cancelled',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/api/subscription/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const event = req.body;
  try {
    const parsed = JSON.parse(event);
    if (parsed.type === 'checkout.session.completed') {
      const customerId = parsed.data.object.customer;
      db.prepare("UPDATE users SET plan = 'pro' WHERE stripe_customer_id = ?").run(customerId);
    }
    if (parsed.type === 'customer.subscription.deleted') {
      const customerId = parsed.data.object.customer;
      db.prepare("UPDATE users SET plan = 'free' WHERE stripe_customer_id = ?").run(customerId);
    }
  } catch (e) { console.error('Webhook error:', e); }
  res.json({ received: true });
});

app.post('/api/subscription/portal', auth, async (req, res) => {
  try {
    const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.user.id);
    if (!user.stripe_customer_id) return res.status(400).json({ error: 'No subscription found' });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: 'http://localhost:5173',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    res.status(500).json({ error: 'Failed to open portal' });
  }
});

// --- Plan limits middleware ---
function checkLimit(type) {
  return (req, res, next) => {
    const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(req.user.id);
    if (user.plan === 'pro' || user.plan === 'trial') return next();

    const limits = { clients: 3, invoices: 5, expenses: 10 };
    const counts = {
      clients: db.prepare('SELECT COUNT(*) as c FROM clients WHERE user_id = ?').get(req.user.id).c,
      invoices: db.prepare('SELECT COUNT(*) as c FROM invoices WHERE user_id = ?').get(req.user.id).c,
      expenses: db.prepare('SELECT COUNT(*) as c FROM expenses WHERE user_id = ?').get(req.user.id).c,
    };

    if (counts[type] >= limits[type]) {
      return res.status(403).json({ error: `Free plan limit: ${limits[type]} ${type}. Upgrade to Pro for unlimited.` });
    }
    next();
  };
}

app.listen(PORT, () => {
  console.log(`InvoiceGenie backend running on http://localhost:${PORT}`);
});