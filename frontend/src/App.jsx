import { useState, useEffect } from 'react'
import './style.css'

function App() {
  const [token, setToken] = useState(localStorage.getItem('token'))
  const [user, setUser] = useState(null)
  const [page, setPage] = useState('dashboard')

  // Auth form state
  const [authMode, setAuthMode] = useState('login')
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '', business_name: '' })
  const [authError, setAuthError] = useState('')
  // Clients state
  const [clients, setClients] = useState([])
  const [showClientForm, setShowClientForm] = useState(false)
  const [clientForm, setClientForm] = useState({ name: '', email: '', phone: '', company: '' })
  const [editingClient, setEditingClient] = useState(null)

  // Invoices state
  const [invoices, setInvoices] = useState([])
  const [showInvoiceForm, setShowInvoiceForm] = useState(false)
  const [invoiceForm, setInvoiceForm] = useState({
    client_id: '', due_date: '', tax_rate: 0, notes: '',
    items: [{ description: '', quantity: 1, price: 0 }]
  })
  const [editingInvoice, setEditingInvoice] = useState(null)

  // Expenses state
  const [expenses, setExpenses] = useState([])
  const [showExpenseForm, setShowExpenseForm] = useState(false)
  const [expenseForm, setExpenseForm] = useState({ amount: '', category: 'other', description: '', date: '' })
  const [editingExpense, setEditingExpense] = useState(null)

  // Dashboard state
  const [stats, setStats] = useState(null)
  const [insights, setInsights] = useState([])
  const [loadingInsights, setLoadingInsights] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // Profile state
  const [profile, setProfile] = useState(null)
  const [profileForm, setProfileForm] = useState({ name: '', email: '', business_name: '', currency: 'USD' })
  const [profileMsg, setProfileMsg] = useState('')
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '', confirm_password: '' })
  const [passwordMsg, setPasswordMsg] = useState('')
  // Subscription state
  const [subscription, setSubscription] = useState({ plan: 'free' })
 
  async function handleAuth(e) {
    e.preventDefault()
    setAuthError('')
    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/signup'
    const res = await fetch('http://localhost:8000' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authForm)
    })
    const data = await res.json()
    if (data.error) return setAuthError(data.error)
    localStorage.setItem('token', data.token)
    setToken(data.token)
    setUser(data.user)
  }

  // --- API helper ---
  function api(path, options = {}) {
    return fetch('http://localhost:8000' + path, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, ...options.headers }
    }).then(r => r.json())
  }

  // --- Clients ---
  function loadClients() {
    api('/api/clients').then(data => { if (Array.isArray(data)) setClients(data) })
  }

  async function addClient(e) {
    e.preventDefault()
    const data = await api('/api/clients', { method: 'POST', body: JSON.stringify(clientForm) })
    if (data.error) return alert(data.error)
    setClients(prev => [data, ...prev])
    setClientForm({ name: '', email: '', phone: '', company: '' })
    setShowClientForm(false)
  }

  async function updateClient(e) {
    e.preventDefault()
    const data = await api('/api/clients/' + editingClient.id, {
      method: 'PUT',
      body: JSON.stringify(clientForm)
    })
    if (data.error) return alert(data.error)
    setClients(prev => prev.map(c => c.id === data.id ? data : c))
    setEditingClient(null)
    setClientForm({ name: '', email: '', phone: '', company: '' })
    setShowClientForm(false)
  }

  function startEditClient(client) {
    setEditingClient(client)
    setClientForm({ name: client.name, email: client.email, phone: client.phone, company: client.company })
    setShowClientForm(true)
  }

  function cancelClientForm() {
    setShowClientForm(false)
    setEditingClient(null)
    setClientForm({ name: '', email: '', phone: '', company: '' })
  }

  async function deleteClient(id) {
    if (!confirm('Delete this client?')) return
    await api('/api/clients/' + id, { method: 'DELETE' })
    setClients(prev => prev.filter(c => c.id !== id))
  }

  // --- Invoices ---
  function loadInvoices() {
    api('/api/invoices').then(data => { if (Array.isArray(data)) setInvoices(data) })
  }

  function addInvoiceItem() {
    setInvoiceForm(prev => ({
      ...prev,
      items: [...prev.items, { description: '', quantity: 1, price: 0 }]
    }))
  }

  function updateInvoiceItem(index, field, value) {
    setInvoiceForm(prev => {
      const items = [...prev.items]
      items[index] = { ...items[index], [field]: field === 'description' ? value : Number(value) }
      return { ...prev, items }
    })
  }

  function removeInvoiceItem(index) {
    setInvoiceForm(prev => ({
      ...prev,
      items: prev.items.filter((_, i) => i !== index)
    }))
  }

  async function createInvoice(e) {
    e.preventDefault()
    const data = await api('/api/invoices', {
      method: 'POST',
      body: JSON.stringify({
        ...invoiceForm,
        client_id: Number(invoiceForm.client_id),
        tax_rate: Number(invoiceForm.tax_rate)
      })
    })
    if (data.error) return alert(data.error)
    setInvoices(prev => [data, ...prev])
    setInvoiceForm({ client_id: '', due_date: '', tax_rate: 0, notes: '', items: [{ description: '', quantity: 1, price: 0 }] })
    setShowInvoiceForm(false)
  }

  async function updateInvoiceStatus(id, status) {
    await api('/api/invoices/' + id + '/status', { method: 'PATCH', body: JSON.stringify({ status }) })
    loadInvoices()
  }

  function startEditInvoice(inv) {
    setEditingInvoice(inv)
    setInvoiceForm({
      client_id: inv.client_id.toString(),
      due_date: inv.due_date || '',
      tax_rate: inv.tax_rate || 0,
      notes: inv.notes || '',
      items: inv.items.length > 0 ? inv.items : [{ description: '', quantity: 1, price: 0 }]
    })
    setShowInvoiceForm(true)
  }

  async function updateInvoice(e) {
    e.preventDefault()
    const data = await api('/api/invoices/' + editingInvoice.id, {
      method: 'PUT',
      body: JSON.stringify({
        ...invoiceForm,
        client_id: Number(invoiceForm.client_id),
        tax_rate: Number(invoiceForm.tax_rate)
      })
    })
    if (data.error) return alert(data.error)
    setInvoices(prev => prev.map(inv => inv.id === data.id ? data : inv))
    cancelInvoiceForm()
  }

  function cancelInvoiceForm() {
    setShowInvoiceForm(false)
    setEditingInvoice(null)
    setInvoiceForm({ client_id: '', due_date: '', tax_rate: 0, notes: '', items: [{ description: '', quantity: 1, price: 0 }] })
  }

  async function deleteInvoice(id) {
    if (!confirm('Delete this invoice?')) return
    await api('/api/invoices/' + id, { method: 'DELETE' })
    setInvoices(prev => prev.filter(inv => inv.id !== id))
  }

  async function downloadPDF(id, invoiceNumber) {
    try {
      const res = await fetch(`http://localhost:8000/api/invoices/${id}/pdf?token=${token}`)
      if (!res.ok) {
        const err = await res.json()
        alert(err.error || 'Failed to download PDF')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${invoiceNumber}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      alert('Failed to download PDF')
    }
  }

  function getSubtotal() {
    return invoiceForm.items.reduce((sum, item) => sum + (item.quantity * item.price), 0)
  }

  // --- Filtering ---
  function filterClients() {
    if (!searchQuery.trim()) return clients
    const q = searchQuery.toLowerCase()
    return clients.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.company && c.company.toLowerCase().includes(q)) ||
      (c.email && c.email.toLowerCase().includes(q))
    )
  }

  function filterInvoices() {
    if (!searchQuery.trim()) return invoices
    const q = searchQuery.toLowerCase()
    return invoices.filter(inv =>
      inv.invoice_number.toLowerCase().includes(q) ||
      inv.client_name.toLowerCase().includes(q) ||
      inv.status.toLowerCase().includes(q)
    )
  }

  function filterExpenses() {
    if (!searchQuery.trim()) return expenses
    const q = searchQuery.toLowerCase()
    return expenses.filter(exp =>
      (exp.description && exp.description.toLowerCase().includes(q)) ||
      exp.category.toLowerCase().includes(q)
    )
  }

  // --- Expenses ---
  function loadExpenses() {
    api('/api/expenses').then(data => { if (Array.isArray(data)) setExpenses(data) })
  }

  async function addExpense(e) {
    e.preventDefault()
    const data = await api('/api/expenses', {
      method: 'POST',
      body: JSON.stringify({ ...expenseForm, amount: Number(expenseForm.amount) })
    })
    if (data.error) return alert(data.error)
    setExpenses(prev => [data, ...prev])
    setExpenseForm({ amount: '', category: 'other', description: '', date: '' })
    setShowExpenseForm(false)
    loadDashboard()
  }

  async function deleteExpense(id) {
    if (!confirm('Delete this expense?')) return
    await api('/api/expenses/' + id, { method: 'DELETE' })
    setExpenses(prev => prev.filter(e => e.id !== id))
    loadDashboard()
  }

  function startEditExpense(exp) {
    setEditingExpense(exp)
    setExpenseForm({
      amount: exp.amount.toString(),
      category: exp.category,
      description: exp.description || '',
      date: exp.date || ''
    })
    setShowExpenseForm(true)
  }

  async function updateExpense(e) {
    e.preventDefault()
    const data = await api('/api/expenses/' + editingExpense.id, {
      method: 'PUT',
      body: JSON.stringify({ ...expenseForm, amount: Number(expenseForm.amount) })
    })
    if (data.error) return alert(data.error)
    setExpenses(prev => prev.map(ex => ex.id === data.id ? data : ex))
    cancelExpenseForm()
    loadDashboard()
  }

  function cancelExpenseForm() {
    setShowExpenseForm(false)
    setEditingExpense(null)
    setExpenseForm({ amount: '', category: 'other', description: '', date: '' })
  }

  // --- Dashboard ---
  function loadDashboard() {
    api('/api/dashboard').then(data => { if (data && !data.error) setStats(data) })
  }

  function loadProfile() {
    api('/api/user/profile').then(data => {
      if (data && !data.error) {
        setProfile(data)
        setProfileForm({ name: data.name, email: data.email, business_name: data.business_name || '', currency: data.currency || 'USD' })
      }
    })
  }

  function loadSubscription() {
    api('/api/subscription').then(data => { if (data && !data.error) setSubscription(data) })
  }

  async function upgradeToPro() {
    const data = await api('/api/subscription/checkout', { method: 'POST' })
    if (data.url) window.location.href = data.url
    else alert(data.error || 'Failed to start checkout')
  }

  async function manageSubscription() {
    const data = await api('/api/subscription/portal', { method: 'POST' })
    if (data.url) window.location.href = data.url
    else alert(data.error || 'Failed to open portal')
  }

  async function updateProfile(e) {
    e.preventDefault()
    setProfileMsg('')
    const data = await api('/api/user/profile', { method: 'PUT', body: JSON.stringify(profileForm) })
    if (data.error) return setProfileMsg(data.error)
    setProfile(data)
    setUser(data)
    setProfileMsg('Profile updated!')
    setTimeout(() => setProfileMsg(''), 3000)
  }

  async function changePassword(e) {
    e.preventDefault()
    setPasswordMsg('')
    if (passwordForm.new_password !== passwordForm.confirm_password) return setPasswordMsg('Passwords do not match')
    const data = await api('/api/user/password', {
      method: 'PUT',
      body: JSON.stringify({ current_password: passwordForm.current_password, new_password: passwordForm.new_password })
    })

    if (data.error) return setPasswordMsg(data.error)
    setPasswordMsg('Password updated!')
    setPasswordForm({ current_password: '', new_password: '', confirm_password: '' })
    setTimeout(() => setPasswordMsg(''), 3000)
  }

  async function loadInsights() {
    if (subscription.plan !== 'pro' && subscription.plan !== 'trial') {
      if (confirm('AI Insights is a Pro feature. Upgrade to Pro for $9/mo?')) {
        upgradeToPro()
      }
      return
    }
    setLoadingInsights(true)
    const data = await api('/api/ai/insights')
    if (Array.isArray(data)) setInsights(data)
    setLoadingInsights(false)
  }

  async function autoCategorize() {
    if (!expenseForm.description || !expenseForm.amount) return
    const data = await api('/api/ai/categorize', {
      method: 'POST',
      body: JSON.stringify({ description: expenseForm.description, amount: Number(expenseForm.amount) })
    })
    if (data.category) setExpenseForm(prev => ({ ...prev, category: data.category }))
  }

  useEffect(() => {
    if (token) {
      loadClients()
      loadInvoices()
      loadExpenses()
      loadDashboard()
      loadProfile()
      loadSubscription()
    }
  }, [token])

  function logout() {
    localStorage.removeItem('token')
    setToken(null)
    setUser(null)
  }

  if (!token) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1 className="auth-logo">InvoiceGenie</h1>
          <p className="auth-sub">AI-powered invoicing for freelancers</p>
          <form onSubmit={handleAuth} className="auth-form">
            {authMode === 'signup' && (
              <>
                <input placeholder="Your name" value={authForm.name}
                  onChange={e => setAuthForm({ ...authForm, name: e.target.value })} />
                <input placeholder="Business name (optional)" value={authForm.business_name}
                  onChange={e => setAuthForm({ ...authForm, business_name: e.target.value })} />
              </>
            )}
            <input type="email" placeholder="Email" value={authForm.email}
              onChange={e => setAuthForm({ ...authForm, email: e.target.value })} />
            <input type="password" placeholder="Password" value={authForm.password}
              onChange={e => setAuthForm({ ...authForm, password: e.target.value })} />
            {authError && <p className="auth-error">{authError}</p>}
            <button type="submit" className="auth-btn">
              {authMode === 'login' ? 'Log in' : 'Create account'}
            </button>
          </form>
          <p className="auth-switch">
            {authMode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <span onClick={() => { setAuthMode(authMode === 'login' ? 'signup' : 'login'); setAuthError('') }}>
              {authMode === 'login' ? 'Sign up' : 'Log in'}
            </span>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="sidebar">
        <div className="logo">InvoiceGenie</div>
        <nav className="nav">
          <div className={`nav-item ${page === 'dashboard' ? 'active' : ''}`} onClick={() => { setPage('dashboard'); setSearchQuery('') }}>Dashboard</div>
          <div className={`nav-item ${page === 'invoices' ? 'active' : ''}`} onClick={() => { setPage('invoices'); setSearchQuery('') }}>Invoices</div>
          <div className={`nav-item ${page === 'expenses' ? 'active' : ''}`} onClick={() => { setPage('expenses'); setSearchQuery('') }}>Expenses</div>
          <div className={`nav-item ${page === 'clients' ? 'active' : ''}`} onClick={() => { setPage('clients'); setSearchQuery('') }}>Clients</div>
          <div className={`nav-item ${page === 'profile' ? 'active' : ''}`} onClick={() => { setPage('profile'); setSearchQuery('') }}>Profile</div>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-bottom-row">
            <div className="user-info">
              {user?.business_name || user?.name || 'User'}
              <span className={`plan-badge ${subscription.plan}`}>{subscription.plan}</span>
            </div>
            <button className="logout-btn" onClick={logout}>Log out</button>
          </div>
          {subscription.plan === 'free' && (
            <button className="upgrade-btn" onClick={upgradeToPro}>Upgrade to Pro — $9/mo</button>
          )}
          {subscription.plan === 'pro' && (
            <button className="manage-btn" onClick={manageSubscription} style={{ width: '100%' }}>Manage subscription</button>
          )}
        </div>
      </div>
      <div className="main">
        <div className="main-header">
          <h2 className="page-title">
            {page === 'dashboard' ? 'Dashboard' : page === 'invoices' ? 'Invoices' : page === 'expenses' ? 'Expenses' : page === 'clients' ? 'Clients' : 'Profile'}
          </h2>
          <p className="page-sub">
            {page === 'dashboard' ? 'Your financial overview' : page === 'invoices' ? clients.length + ' clients · ' + invoices.length + ' invoices' : page === 'expenses' ? expenses.length + ' expenses tracked' : page === 'clients' ? clients.length + ' clients' : 'Manage your account'}
          </p>
        </div>
        <div className="main-content">
          {page !== 'dashboard' && page !== 'profile' && (
            <input className="search-bar" placeholder={`Search ${page}...`} value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)} />
          )}
          {page === 'clients' && (
            <>
              <button className="add-btn" onClick={() => {
                if (showClientForm) cancelClientForm()
                else setShowClientForm(true)
              }}>
                {showClientForm ? 'Cancel' : '+ New client'}
              </button>

              {showClientForm && (
                <form className="form-card" onSubmit={editingClient ? updateClient : addClient}>
                  <input placeholder="Client name *" value={clientForm.name}
                    onChange={e => setClientForm({ ...clientForm, name: e.target.value })} />
                  <input placeholder="Email" value={clientForm.email}
                    onChange={e => setClientForm({ ...clientForm, email: e.target.value })} />
                  <input placeholder="Phone" value={clientForm.phone}
                    onChange={e => setClientForm({ ...clientForm, phone: e.target.value })} />
                  <input placeholder="Company" value={clientForm.company}
                    onChange={e => setClientForm({ ...clientForm, company: e.target.value })} />
                  <button type="submit" className="save-btn">{editingClient ? 'Update client' : 'Save client'}</button>
                </form>
              )}

              {filterClients().length === 0 && !showClientForm && (
                <p className="placeholder">No clients yet — add your first one</p>
              )}

              <div className="card-list">
                {filterClients().map(c => (
                  <div key={c.id} className="card">
                    <div className="card-top">
                      <div>
                        <div className="card-title">{c.name}</div>
                        {c.company && <div className="card-sub">{c.company}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="edit-btn" onClick={() => startEditClient(c)}>edit</button>
                        <button className="delete-btn" onClick={() => deleteClient(c.id)}>x</button>
                      </div>
                    </div>
                    <div className="card-details">
                      {c.email && <span>{c.email}</span>}
                      {c.phone && <span>{c.phone}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {page === 'invoices' && (
            <>
              <button className="add-btn" onClick={() => {
                if (showInvoiceForm) cancelInvoiceForm()
                else setShowInvoiceForm(true)
              }}>
                {showInvoiceForm ? 'Cancel' : '+ New invoice'}
              </button>

              {showInvoiceForm && (
                <form className="form-card invoice-form" onSubmit={editingInvoice ? updateInvoice : createInvoice}>
                  <select value={invoiceForm.client_id}
                    onChange={e => setInvoiceForm({ ...invoiceForm, client_id: e.target.value })}>
                    <option value="">Select client *</option>
                    {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <input type="date" placeholder="Due date" value={invoiceForm.due_date}
                    onChange={e => setInvoiceForm({ ...invoiceForm, due_date: e.target.value })} />

                  <div className="items-section">
                    <div className="items-header">
                      <span>Line items</span>
                      <button type="button" className="add-item-btn" onClick={addInvoiceItem}>+ Add item</button>
                    </div>
                    {invoiceForm.items.map((item, i) => (
                      <div key={i} className="item-row">
                        <input placeholder="Description" value={item.description}
                          onChange={e => updateInvoiceItem(i, 'description', e.target.value)} />
                        <input type="number" placeholder="Qty" value={item.quantity} min="1"
                          onChange={e => updateInvoiceItem(i, 'quantity', e.target.value)} style={{ width: 70 }} />
                        <input type="number" placeholder="Price" value={item.price} min="0" step="0.01"
                          onChange={e => updateInvoiceItem(i, 'price', e.target.value)} style={{ width: 100 }} />
                        <span className="item-total">${(item.quantity * item.price).toFixed(2)}</span>
                        {invoiceForm.items.length > 1 && (
                          <button type="button" className="delete-btn" onClick={() => removeInvoiceItem(i)}>x</button>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="invoice-totals">
                    <div className="total-row">
                      <span>Subtotal</span><span>${getSubtotal().toFixed(2)}</span>
                    </div>
                    <div className="total-row">
                      <span>Tax %</span>
                      <input type="number" value={invoiceForm.tax_rate} min="0" step="0.5"
                        onChange={e => setInvoiceForm({ ...invoiceForm, tax_rate: e.target.value })}
                        style={{ width: 60, textAlign: 'right' }} />
                    </div>
                    <div className="total-row total-final">
                      <span>Total</span><span>${(getSubtotal() * (1 + Number(invoiceForm.tax_rate) / 100)).toFixed(2)}</span>
                    </div>
                  </div>

                  <textarea placeholder="Notes (optional)" value={invoiceForm.notes} rows={2}
                    onChange={e => setInvoiceForm({ ...invoiceForm, notes: e.target.value })} />
                  <button type="submit" className="save-btn">{editingInvoice ? 'Update invoice' : 'Create invoice'}</button>
                </form>
              )}

              {filterInvoices().length === 0 && !showInvoiceForm && (
                <p className="placeholder">No invoices yet — create your first one</p>
              )}

              <div className="card-list">
                {filterInvoices().map(inv => (
                  <div key={inv.id} className="card">
                    <div className="card-top">
                      <div>
                        <div className="card-title">{inv.invoice_number}</div>
                        <div className="card-sub">{inv.client_name} · Due {inv.due_date || 'N/A'}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <select className="status-select" value={inv.status}
                          onChange={e => updateInvoiceStatus(inv.id, e.target.value)}>
                          <option value="draft">Draft</option>
                          <option value="sent">Sent</option>
                          <option value="paid">Paid</option>
                          <option value="overdue">Overdue</option>
                          <option value="cancelled">Cancelled</option>
                        </select>
                        <button className="edit-btn" onClick={() => downloadPDF(inv.id, inv.invoice_number)}>PDF</button>
                        <button className="edit-btn" onClick={() => startEditInvoice(inv)}>edit</button>
                        <button className="delete-btn" onClick={() => deleteInvoice(inv.id)}>x</button>
                      </div>
                    </div>
                    <div className="card-details">
                      <span>{inv.items.length} item{inv.items.length !== 1 ? 's' : ''}</span>
                      {inv.tax_rate > 0 && <span>Tax: {inv.tax_rate}%</span>}
                      <span className="invoice-total">${inv.total.toFixed(2)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {page === 'expenses' && (
            <>
              <button className="add-btn" onClick={() => {
                if (showExpenseForm) cancelExpenseForm()
                else setShowExpenseForm(true)
              }}>
                {showExpenseForm ? 'Cancel' : '+ New expense'}
              </button>

              {showExpenseForm && (
                <form className="form-card" onSubmit={editingExpense ? updateExpense : addExpense}>
                  <input type="number" placeholder="Amount *" step="0.01" value={expenseForm.amount}
                    onChange={e => setExpenseForm({ ...expenseForm, amount: e.target.value })} />
                  <select value={expenseForm.category}
                    onChange={e => setExpenseForm({ ...expenseForm, category: e.target.value })}>
                    <option value="other">Other</option>
                    <option value="software">Software</option>
                    <option value="hardware">Hardware</option>
                    <option value="travel">Travel</option>
                    <option value="food">Food & Meals</option>
                    <option value="office">Office Supplies</option>
                    <option value="marketing">Marketing</option>
                    <option value="utilities">Utilities</option>
                    <option value="rent">Rent</option>
                  </select>
                  <input placeholder="Description" value={expenseForm.description}
                    onChange={e => setExpenseForm({ ...expenseForm, description: e.target.value })}
                    onBlur={autoCategorize} />
                  <input type="date" value={expenseForm.date}
                    onChange={e => setExpenseForm({ ...expenseForm, date: e.target.value })} />
                  <button type="submit" className="save-btn">{editingExpense ? 'Update expense' : 'Save expense'}</button>
                </form>
              )}

              {filterExpenses().length === 0 && !showExpenseForm && (
                <p className="placeholder">No expenses yet — track your first one</p>
              )}

              <div className="card-list">
                {filterExpenses().map(exp => (
                  <div key={exp.id} className="card">
                    <div className="card-top">
                      <div>
                        <div className="card-title">${Number(exp.amount).toFixed(2)}</div>
                        <div className="card-sub">{exp.description || 'No description'} · {exp.date}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="category-badge">{exp.category}</span>
                        <button className="edit-btn" onClick={() => startEditExpense(exp)}>edit</button>
                        <button className="delete-btn" onClick={() => deleteExpense(exp.id)}>x</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {page === 'profile' && profile && (
            <div className="profile-page">
              <div className="profile-section">
                <h3 className="section-title">Account details</h3>
                <form className="form-card" onSubmit={updateProfile}>
                  <label className="form-label">Full name</label>
                  <input value={profileForm.name}
                    onChange={e => setProfileForm({ ...profileForm, name: e.target.value })} />
                  <label className="form-label">Email</label>
                  <input type="email" value={profileForm.email}
                    onChange={e => setProfileForm({ ...profileForm, email: e.target.value })} />
                  <label className="form-label">Business name</label>
                  <input value={profileForm.business_name}
                    onChange={e => setProfileForm({ ...profileForm, business_name: e.target.value })} />
                  <label className="form-label">Currency</label>
                  <select value={profileForm.currency}
                    onChange={e => setProfileForm({ ...profileForm, currency: e.target.value })}>
                    <option value="USD">USD ($)</option>
                    <option value="EUR">EUR (€)</option>
                    <option value="GBP">GBP (£)</option>
                    <option value="INR">INR (₹)</option>
                    <option value="CAD">CAD (C$)</option>
                    <option value="AUD">AUD (A$)</option>
                    <option value="JPY">JPY (¥)</option>
                  </select>
                  {profileMsg && <p className={profileMsg.includes('updated') ? 'success-msg' : 'auth-error'}>{profileMsg}</p>}
                  <button type="submit" className="save-btn">Save changes</button>
                </form>
              </div>

              <div className="profile-section">
                <h3 className="section-title">Change password</h3>
                <form className="form-card" onSubmit={changePassword}>
                  <label className="form-label">Current password</label>
                  <input type="password" value={passwordForm.current_password}
                    onChange={e => setPasswordForm({ ...passwordForm, current_password: e.target.value })} />
                  <label className="form-label">New password</label>
                  <input type="password" value={passwordForm.new_password}
                    onChange={e => setPasswordForm({ ...passwordForm, new_password: e.target.value })} />
                  <label className="form-label">Confirm new password</label>
                  <input type="password" value={passwordForm.confirm_password}
                    onChange={e => setPasswordForm({ ...passwordForm, confirm_password: e.target.value })} />
                  {passwordMsg && <p className={passwordMsg.includes('updated') ? 'success-msg' : 'auth-error'}>{passwordMsg}</p>}
                  <button type="submit" className="save-btn">Update password</button>
                </form>
              </div>

              <div className="profile-section">
                <h3 className="section-title">Subscription</h3>
                <div className="plan-card">
                  <div className="plan-card-header">
                    <div>
                      <div className="plan-name">{subscription.plan === 'pro' ? 'Pro Plan' : subscription.plan === 'trial' ? 'Pro Trial' : 'Free Plan'}</div>
                      <div className="plan-price">{subscription.plan === 'pro' ? '$9/month' : subscription.plan === 'trial' ? 'Free for 14 days' : '$0/month'}</div>
                    </div>
                    <span className={`plan-badge large ${subscription.plan}`}>{subscription.plan}</span>
                  </div>
                  <div className="plan-features">
                    <div className="plan-feature">{subscription.plan !== 'free' ? '✓ Unlimited' : '5'} invoices</div>
                    <div className="plan-feature">{subscription.plan !== 'free' ? '✓ Unlimited' : '3'} clients</div>
                    <div className="plan-feature">{subscription.plan !== 'free' ? '✓ Unlimited' : '10'} expenses</div>
                    <div className="plan-feature">{subscription.plan !== 'free' ? '✓' : '✗'} PDF invoice export</div>
                    <div className="plan-feature">{subscription.plan !== 'free' ? '✓' : '✗'} AI financial insights</div>
                  </div>
                  {(subscription.plan === 'free' || subscription.plan === 'trial') && (
                    <button className="save-btn" onClick={upgradeToPro} style={{ marginTop: 12 }}>
                      {subscription.plan === 'trial' ? 'Subscribe now — $9/mo' : 'Upgrade to Pro — $9/mo'}
                    </button>
                  )}
                  {subscription.plan === 'pro' && (
                    <button className="manage-btn" onClick={manageSubscription} style={{ marginTop: 12, width: '100%' }}>Manage subscription</button>
                  )}
                </div>
              </div>

              <div className="profile-section">
                <h3 className="section-title">Account info</h3>
                <div className="info-card">
                  <div className="info-row"><span className="info-label">Member since</span><span>{profile.created_at?.split('T')[0]}</span></div>
                  <div className="info-row"><span className="info-label">Total invoices</span><span>{invoices.length}</span></div>
                  <div className="info-row"><span className="info-label">Total clients</span><span>{clients.length}</span></div>
                  <div className="info-row"><span className="info-label">Total expenses</span><span>{expenses.length}</span></div>
                </div>
              </div>
            </div>
          )}

          {page === 'dashboard' && (
            <>
              {!stats ? (
                <p className="placeholder">Loading...</p>
              ) : (
                <>
                  <div style={{ marginBottom: 20, display: 'flex', gap: 10 }}>
                    <button className="add-btn" onClick={loadInsights} disabled={loadingInsights}>
                      {loadingInsights ? 'Analyzing...' : 'Get AI insights'}
                    </button>
                  </div>

                  {insights.length > 0 && (
                    <div className="insights-section">
                      {insights.map((ins, i) => (
                        <div key={i} className="insight-card">
                          <div className="insight-title">{ins.title}</div>
                          <div className="insight-body">{ins.body}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {stats.overdueCount > 0 && (
                    <div className="overdue-banner">
                      ⚠️ You have {stats.overdueCount} overdue invoice{stats.overdueCount !== 1 ? 's' : ''}
                      <button className="overdue-link" onClick={() => setPage('invoices')}>View invoices →</button>
                    </div>
                  )}
                  <div className="stats-grid">
                    <div className="stat-card">
                      <div className="stat-label">Total invoiced</div>
                      <div className="stat-value">${stats.totalInvoiced.toFixed(2)}</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Total paid</div>
                      <div className="stat-value green">${stats.totalPaid.toFixed(2)}</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Unpaid</div>
                      <div className="stat-value orange">${stats.unpaid.toFixed(2)}</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Expenses</div>
                      <div className="stat-value red">${stats.totalExpenses.toFixed(2)}</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Profit</div>
                      <div className={'stat-value ' + (stats.profit >= 0 ? 'green' : 'red')}>${stats.profit.toFixed(2)}</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Clients</div>
                      <div className="stat-value">{stats.clientCount}</div>
                    </div>
                  </div>

                  {stats.recentInvoices.length > 0 && (
                    <div className="dashboard-section">
                      <h3 className="section-title">Recent invoices</h3>
                      <div className="card-list">
                        {stats.recentInvoices.map((inv, i) => (
                          <div key={i} className="card">
                            <div className="card-top">
                              <div>
                                <div className="card-title">{inv.invoice_number}</div>
                                <div className="card-sub">{inv.client_name}</div>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span className={'status-badge status-' + inv.status}>{inv.status}</span>
                                <span className="invoice-total">${inv.total.toFixed(2)}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {stats.monthlyData && stats.monthlyData.some(m => m.income > 0 || m.expense > 0) && (
                    <div className="dashboard-section">
                      <h3 className="section-title">Income vs Expenses (6 months)</h3>
                      <div className="chart-container">
                        {(() => {
                          const max = Math.max(...stats.monthlyData.map(m => Math.max(m.income, m.expense)), 1)
                          return stats.monthlyData.map((m, i) => (
                            <div key={i} className="chart-col">
                              <div className="chart-bars">
                                <div className="chart-bar income" style={{ height: (m.income / max * 140) + 'px' }}
                                  title={'Income: $' + m.income.toFixed(2)}>
                                  {m.income > 0 && <span className="bar-label">${m.income >= 1000 ? (m.income/1000).toFixed(1)+'k' : m.income.toFixed(0)}</span>}
                                </div>
                                <div className="chart-bar expense" style={{ height: (m.expense / max * 140) + 'px' }}
                                  title={'Expenses: $' + m.expense.toFixed(2)}>
                                  {m.expense > 0 && <span className="bar-label">${m.expense >= 1000 ? (m.expense/1000).toFixed(1)+'k' : m.expense.toFixed(0)}</span>}
                                </div>
                              </div>
                              <div className="chart-label">{m.label}</div>
                            </div>
                          ))
                        })()}
                      </div>
                      <div className="chart-legend">
                        <span className="legend-item"><span className="legend-dot income-dot"></span>Income</span>
                        <span className="legend-item"><span className="legend-dot expense-dot"></span>Expenses</span>
                      </div>
                    </div>
                  )}
                  
                  {stats.expensesByCategory.length > 0 && (
                    <div className="dashboard-section">
                      <h3 className="section-title">Expenses by category</h3>
                      <div className="category-list">
                        {stats.expensesByCategory.map((cat, i) => (
                          <div key={i} className="category-row">
                            <span className="category-badge">{cat.category}</span>
                            <span className="category-amount">${cat.total.toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default App