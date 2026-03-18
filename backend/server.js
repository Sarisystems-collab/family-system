// ╔══════════════════════════════════════════════════════════╗
// ║          نظام العائلة v1 — Node.js Backend              ║
// ╚══════════════════════════════════════════════════════════╝

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const cron    = require('node-cron');
const fetch   = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const GROQ_API_KEY   = process.env.GROQ_API_KEY   || '';

const ROLES = {
  admin:  ['all'],
  member: ['view','add','edit'],
  child:  ['view']
};

// ══════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════

function hash(p) { return crypto.createHash('sha256').update(p).digest('hex'); }
function nowAr() { return new Date().toLocaleString('ar-SA'); }
function todayStr() { return new Date().toISOString().split('T')[0]; }

async function sendTg(chatId, text) {
  if (!TELEGRAM_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'Markdown' })
    });
  } catch(e) {}
}

async function notifyAll(msg) {
  const { data } = await supabase.from('users').select('telegram_id').neq('telegram_id', '');
  for (const u of (data || [])) if (u.telegram_id) await sendTg(u.telegram_id, msg);
}

// ══════════════════════════════════════════════════════════
//  Auth Middleware
// ══════════════════════════════════════════════════════════

async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.json({ error: 'غير مصرح' });
  const { data } = await supabase.from('sessions').select('*')
    .eq('token', token).gt('expires_at', new Date().toISOString()).maybeSingle();
  if (!data) return res.json({ error: 'انتهت الجلسة' });
  req.user = { username: data.username, role: data.role, name: data.name };
  next();
}

// ══════════════════════════════════════════════════════════
//  Login / Logout
// ══════════════════════════════════════════════════════════

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, error: 'بيانات ناقصة' });
  const { data: user } = await supabase.from('users').select('*').eq('username', username).maybeSingle();
  if (!user) return res.json({ success: false, error: 'المستخدم غير موجود' });
  if (user.password !== hash(password)) return res.json({ success: false, error: 'كلمة المرور خاطئة' });
  const token   = crypto.randomUUID();
  const expires = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
  await supabase.from('sessions').insert({ token, username, role: user.role, name: user.name, expires_at: expires });
  await supabase.from('users').update({ last_login: nowAr() }).eq('username', username);
  res.json({ success: true, token, user: { username, role: user.role, name: user.name, telegramId: user.telegram_id } });
});

app.post('/api/logout', auth, async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  await supabase.from('sessions').delete().eq('token', token);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
//  المستخدمون
// ══════════════════════════════════════════════════════════

app.get('/api/users', auth, async (req, res) => {
  const { data } = await supabase.from('users').select('username, role, name, telegram_id, last_login, member_id');
  res.json(data || []);
});

app.post('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ error: 'غير مصرح' });
  const u = req.body;
  const { error } = await supabase.from('users').insert({
    username: u.username, password: hash(u.password), role: u.role || 'member',
    name: u.name, telegram_id: u.telegramId || '', member_id: u.memberId || ''
  });
  if (error) return res.json({ error: error.code === '23505' ? 'موجود مسبقاً' : error.message });
  res.json({ success: true });
});

app.delete('/api/users/:username', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ error: 'غير مصرح' });
  await supabase.from('users').delete().eq('username', req.params.username);
  res.json({ success: true });
});

app.post('/api/users/me/telegram', auth, async (req, res) => {
  await supabase.from('users').update({ telegram_id: req.body.chatId }).eq('username', req.user.username);
  res.json({ success: true });
});

app.post('/api/users/me/password', auth, async (req, res) => {
  const { oldPass, newPass } = req.body;
  const { data } = await supabase.from('users').select('password').eq('username', req.user.username).maybeSingle();
  if (!data || data.password !== hash(oldPass)) return res.json({ error: 'كلمة المرور الحالية خاطئة' });
  await supabase.from('users').update({ password: hash(newPass) }).eq('username', req.user.username);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
//  أفراد العائلة
// ══════════════════════════════════════════════════════════

app.get('/api/members', auth, async (req, res) => {
  const { data } = await supabase.from('family_members').select('*').order('id');
  res.json(data || []);
});

app.post('/api/members', auth, async (req, res) => {
  const m = req.body;
  const id = Date.now();
  const { error } = await supabase.from('family_members').insert({
    id, name: m.name, relation: m.relation || '', birthdate: m.birthdate || '',
    phone: m.phone || '', blood_type: m.bloodType || '', notes: m.notes || '',
    avatar: m.avatar || '👤', created_at: nowAr()
  });
  if (error) return res.json({ error: error.message });
  res.json({ success: true, id });
});

app.put('/api/members/:id', auth, async (req, res) => {
  const m = req.body;
  await supabase.from('family_members').update({
    name: m.name, relation: m.relation || '', birthdate: m.birthdate || '',
    phone: m.phone || '', blood_type: m.bloodType || '', notes: m.notes || '',
    avatar: m.avatar || '👤'
  }).eq('id', req.params.id);
  res.json({ success: true });
});

app.delete('/api/members/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ error: 'غير مصرح' });
  await supabase.from('family_members').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
//  المخزون المنزلي
// ══════════════════════════════════════════════════════════

app.get('/api/inventory', auth, async (req, res) => {
  const { data } = await supabase.from('inventory').select('*').order('category');
  res.json(data || []);
});

app.get('/api/inventory/stats', auth, async (req, res) => {
  const { data } = await supabase.from('inventory').select('category, quantity, min_stock, expiry, unit');
  const items = data || [];
  const total = items.length;
  const low   = items.filter(i => +i.quantity <= +i.min_stock).length;
  const today = new Date(); today.setHours(0,0,0,0);
  const soon  = new Date(today); soon.setDate(soon.getDate()+7);
  const exp   = items.filter(i => i.expiry && new Date(i.expiry) <= soon).length;
  const byLoc = {};
  items.forEach(i => { const l = i.location||'غير محدد'; if(!byLoc[l])byLoc[l]=0; byLoc[l]++; });
  res.json({ total, low, exp, byLoc });
});

app.post('/api/inventory', auth, async (req, res) => {
  const item = req.body;
  const id   = Date.now();
  const { error } = await supabase.from('inventory').insert({
    id, name: item.name, category: item.category||'أخرى', quantity: +item.quantity||0,
    unit: item.unit||'قطعة', min_stock: +item.minStock||1, location: item.location||'',
    expiry: item.expiry||'', notes: item.notes||'', date_added: nowAr()
  });
  if (error) return res.json({ error: error.message });
  res.json({ success: true, id });
});

app.put('/api/inventory/:id', auth, async (req, res) => {
  const item = req.body;
  await supabase.from('inventory').update({
    name: item.name, category: item.category||'أخرى', quantity: +item.quantity||0,
    unit: item.unit||'قطعة', min_stock: +item.minStock||1, location: item.location||'',
    expiry: item.expiry||'', notes: item.notes||''
  }).eq('id', req.params.id);
  res.json({ success: true });
});

app.delete('/api/inventory/:id', auth, async (req, res) => {
  await supabase.from('inventory').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
//  المالية
// ══════════════════════════════════════════════════════════

app.get('/api/budget/categories', auth, async (req, res) => {
  const { data } = await supabase.from('budget_categories').select('*').order('id');
  res.json(data || []);
});

app.put('/api/budget/categories/:id', auth, async (req, res) => {
  await supabase.from('budget_categories').update({ budget: +req.body.budget }).eq('id', req.params.id);
  res.json({ success: true });
});

app.get('/api/expenses', auth, async (req, res) => {
  const month = req.query.month || todayStr().substring(0, 7);
  const { data } = await supabase.from('expenses').select('*')
    .like('date', month + '%').order('date', { ascending: false });
  res.json(data || []);
});

app.post('/api/expenses', auth, async (req, res) => {
  const e  = req.body;
  const id = Date.now();
  await supabase.from('expenses').insert({
    id, amount: +e.amount, category_id: +e.categoryId||0,
    description: e.description||'', member_id: +e.memberId||0,
    member_name: e.memberName||req.user.name, date: e.date||todayStr(), notes: e.notes||''
  });
  res.json({ success: true, id });
});

app.delete('/api/expenses/:id', auth, async (req, res) => {
  await supabase.from('expenses').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.get('/api/income', auth, async (req, res) => {
  const month = req.query.month || todayStr().substring(0, 7);
  const { data } = await supabase.from('income').select('*')
    .like('date', month + '%').order('date', { ascending: false });
  res.json(data || []);
});

app.post('/api/income', auth, async (req, res) => {
  const inc = req.body;
  const id  = Date.now();
  await supabase.from('income').insert({
    id, amount: +inc.amount, source: inc.source||'', member_id: +inc.memberId||0,
    member_name: inc.memberName||req.user.name, date: inc.date||todayStr(), notes: inc.notes||''
  });
  res.json({ success: true, id });
});

app.delete('/api/income/:id', auth, async (req, res) => {
  await supabase.from('income').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.get('/api/budget/summary', auth, async (req, res) => {
  const month = req.query.month || todayStr().substring(0, 7);
  const [expRes, incRes, catRes] = await Promise.all([
    supabase.from('expenses').select('amount, category_id').like('date', month + '%'),
    supabase.from('income').select('amount').like('date', month + '%'),
    supabase.from('budget_categories').select('*')
  ]);
  const totalExp = (expRes.data || []).reduce((s, e) => s + +e.amount, 0);
  const totalInc = (incRes.data || []).reduce((s, i) => s + +i.amount, 0);
  const byCategory = {};
  (catRes.data || []).forEach(c => { byCategory[c.id] = { name: c.name, budget: +c.budget, spent: 0, icon: c.icon, color: c.color }; });
  (expRes.data || []).forEach(e => { if (byCategory[e.category_id]) byCategory[e.category_id].spent += +e.amount; });
  res.json({ totalExp, totalInc, balance: totalInc - totalExp, byCategory: Object.values(byCategory) });
});

// ══════════════════════════════════════════════════════════
//  المهام
// ══════════════════════════════════════════════════════════

app.get('/api/tasks', auth, async (req, res) => {
  const { data } = await supabase.from('tasks').select('*').order('due_date');
  res.json(data || []);
});

app.post('/api/tasks', auth, async (req, res) => {
  const t  = req.body;
  const id = Date.now();
  await supabase.from('tasks').insert({
    id, title: t.title, description: t.description||'',
    assigned_to: +t.assignedTo||0, assigned_name: t.assignedName||'',
    due_date: t.dueDate||'', due_time: t.dueTime||'',
    priority: t.priority||'متوسط', status: 'قيد التنفيذ',
    category: t.category||'عام', created_by: req.user.name, created_at: nowAr()
  });
  await notifyAll(`📋 *مهمة جديدة*\n${t.title}\nلـ: ${t.assignedName||'الجميع'}`);
  res.json({ success: true, id });
});

app.put('/api/tasks/:id', auth, async (req, res) => {
  const t = req.body;
  await supabase.from('tasks').update({
    title: t.title, description: t.description||'', assigned_to: +t.assignedTo||0,
    assigned_name: t.assignedName||'', due_date: t.dueDate||'', priority: t.priority||'متوسط',
    status: t.status||'قيد التنفيذ', category: t.category||'عام'
  }).eq('id', req.params.id);
  res.json({ success: true });
});

app.post('/api/tasks/:id/complete', auth, async (req, res) => {
  await supabase.from('tasks').update({ status: 'مكتمل' }).eq('id', req.params.id);
  res.json({ success: true });
});

app.delete('/api/tasks/:id', auth, async (req, res) => {
  await supabase.from('tasks').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
//  الأحداث والجدول
// ══════════════════════════════════════════════════════════

app.get('/api/events', auth, async (req, res) => {
  const { from, to } = req.query;
  let q = supabase.from('events').select('*');
  if (from) q = q.gte('date', from);
  if (to)   q = q.lte('date', to);
  const { data } = await q.order('date').order('time');
  res.json(data || []);
});

app.post('/api/events', auth, async (req, res) => {
  const e  = req.body;
  const id = Date.now();
  await supabase.from('events').insert({
    id, title: e.title, description: e.description||'', date: e.date,
    time: e.time||'', end_time: e.endTime||'', type: e.type||'عام',
    member_id: +e.memberId||0, member_name: e.memberName||'',
    location: e.location||'', reminder: e.reminder!==false, created_at: nowAr()
  });
  res.json({ success: true, id });
});

app.delete('/api/events/:id', auth, async (req, res) => {
  await supabase.from('events').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.get('/api/events/today', auth, async (req, res) => {
  const today = todayStr();
  const { data } = await supabase.from('events').select('*').eq('date', today).order('time');
  res.json(data || []);
});

// ══════════════════════════════════════════════════════════
//  الصحة — الأدوية
// ══════════════════════════════════════════════════════════

app.get('/api/medications', auth, async (req, res) => {
  const { data } = await supabase.from('medications').select('*').eq('active', true).order('member_name');
  res.json(data || []);
});

app.post('/api/medications', auth, async (req, res) => {
  const m  = req.body;
  const id = Date.now();
  await supabase.from('medications').insert({
    id, member_id: +m.memberId, member_name: m.memberName||'',
    name: m.name, dose: m.dose||'', frequency: m.frequency||'',
    start_date: m.startDate||todayStr(), end_date: m.endDate||'',
    notes: m.notes||'', active: true
  });
  res.json({ success: true, id });
});

app.delete('/api/medications/:id', auth, async (req, res) => {
  await supabase.from('medications').update({ active: false }).eq('id', req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
//  الصحة — المواعيد الطبية
// ══════════════════════════════════════════════════════════

app.get('/api/appointments', auth, async (req, res) => {
  const { data } = await supabase.from('medical_appointments').select('*')
    .eq('done', false).order('date');
  res.json(data || []);
});

app.post('/api/appointments', auth, async (req, res) => {
  const a  = req.body;
  const id = Date.now();
  await supabase.from('medical_appointments').insert({
    id, member_id: +a.memberId, member_name: a.memberName||'',
    doctor: a.doctor||'', specialty: a.specialty||'',
    date: a.date, time: a.time||'', location: a.location||'',
    notes: a.notes||'', done: false
  });
  res.json({ success: true, id });
});

app.post('/api/appointments/:id/done', auth, async (req, res) => {
  await supabase.from('medical_appointments').update({ done: true }).eq('id', req.params.id);
  res.json({ success: true });
});

app.delete('/api/appointments/:id', auth, async (req, res) => {
  await supabase.from('medical_appointments').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
//  قوائم التسوق
// ══════════════════════════════════════════════════════════

app.get('/api/shopping', auth, async (req, res) => {
  const { data: lists } = await supabase.from('shopping_lists').select('*')
    .eq('done', false).order('id', { ascending: false });
  if (!lists || !lists.length) return res.json([]);
  const ids = lists.map(l => l.id);
  const { data: items } = await supabase.from('shopping_items').select('*').in('list_id', ids);
  res.json(lists.map(l => ({
    ...l,
    items: (items || []).filter(i => i.list_id === l.id)
  })));
});

app.post('/api/shopping/lists', auth, async (req, res) => {
  const id = Date.now();
  await supabase.from('shopping_lists').insert({
    id, name: req.body.name, created_by: req.user.name, created_at: nowAr(), done: false
  });
  res.json({ success: true, id });
});

app.post('/api/shopping/items', auth, async (req, res) => {
  const item = req.body;
  const id   = Date.now();
  await supabase.from('shopping_items').insert({
    id, list_id: +item.listId, name: item.name,
    quantity: item.quantity||'1', unit: item.unit||'', category: item.category||'',
    bought: false, notes: item.notes||''
  });
  res.json({ success: true, id });
});

app.post('/api/shopping/items/:id/toggle', auth, async (req, res) => {
  const { data } = await supabase.from('shopping_items').select('bought').eq('id', req.params.id).maybeSingle();
  await supabase.from('shopping_items').update({ bought: !data?.bought }).eq('id', req.params.id);
  res.json({ success: true });
});

app.delete('/api/shopping/items/:id', auth, async (req, res) => {
  await supabase.from('shopping_items').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.delete('/api/shopping/lists/:id', auth, async (req, res) => {
  await supabase.from('shopping_items').delete().eq('list_id', req.params.id);
  await supabase.from('shopping_lists').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
//  الوصفات والوجبات
// ══════════════════════════════════════════════════════════

app.get('/api/recipes', auth, async (req, res) => {
  const { data } = await supabase.from('recipes').select('*').order('name');
  res.json(data || []);
});

app.post('/api/recipes', auth, async (req, res) => {
  const r  = req.body;
  const id = Date.now();
  await supabase.from('recipes').insert({
    id, name: r.name, category: r.category||'رئيسي',
    ingredients: JSON.stringify(r.ingredients||[]),
    instructions: r.instructions||'', prep_time: +r.prepTime||0,
    cook_time: +r.cookTime||0, servings: +r.servings||4,
    notes: r.notes||'', favorite: !!r.favorite,
    added_by: req.user.name, created_at: nowAr()
  });
  res.json({ success: true, id });
});

app.delete('/api/recipes/:id', auth, async (req, res) => {
  await supabase.from('recipes').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.get('/api/meals', auth, async (req, res) => {
  const week = req.query.week || todayStr();
  const end  = new Date(week); end.setDate(end.getDate() + 7);
  const { data } = await supabase.from('meal_plan').select('*')
    .gte('date', week).lte('date', end.toISOString().split('T')[0]).order('date');
  res.json(data || []);
});

app.post('/api/meals', auth, async (req, res) => {
  const m  = req.body;
  const id = Date.now();
  // احذف لو موجود لنفس اليوم والوجبة
  await supabase.from('meal_plan').delete().eq('date', m.date).eq('meal_type', m.mealType);
  await supabase.from('meal_plan').insert({
    id, date: m.date, meal_type: m.mealType,
    recipe_id: +m.recipeId||0, recipe_name: m.recipeName||'',
    custom: m.custom||'', notes: m.notes||''
  });
  res.json({ success: true, id });
});

app.delete('/api/meals/:id', auth, async (req, res) => {
  await supabase.from('meal_plan').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// AI اقتراح وجبات
app.post('/api/meals/suggest', auth, async (req, res) => {
  if (!GROQ_API_KEY) return res.json({ error: 'GROQ_API_KEY غير محدد' });
  const { data: recipes } = await supabase.from('recipes').select('name, category').limit(30);
  const { data: inv }     = await supabase.from('inventory').select('name, quantity').gt('quantity', 0).limit(20);
  const invList = (inv||[]).map(i => i.name).join('، ');
  const recList = (recipes||[]).map(r => r.name).join('، ');
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', max_tokens: 500,
        messages: [{ role: 'user', content: `اقترح وجبات لهذا الأسبوع (فطور وغداء وعشاء) بناءً على:\nما في المخزن: ${invList}\nوصفاتنا: ${recList}\nاجعل الاقتراح عملياً ومتنوعاً. بالعربية.` }]
      })
    });
    const json = await r.json();
    res.json({ success: true, suggestion: json.choices[0].message.content });
  } catch(e) { res.json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  الوثائق والملاحظات
// ══════════════════════════════════════════════════════════

app.get('/api/documents', auth, async (req, res) => {
  const { data } = await supabase.from('documents').select('*').order('id', { ascending: false });
  res.json(data || []);
});

app.post('/api/documents', auth, async (req, res) => {
  const d  = req.body;
  const id = Date.now();
  await supabase.from('documents').insert({
    id, title: d.title, type: d.type||'ملاحظة', content: d.content||'',
    member_id: +d.memberId||0, member_name: d.memberName||'',
    tags: d.tags||'', created_by: req.user.name, created_at: nowAr()
  });
  res.json({ success: true, id });
});

app.put('/api/documents/:id', auth, async (req, res) => {
  const d = req.body;
  await supabase.from('documents').update({
    title: d.title, type: d.type||'ملاحظة', content: d.content||'',
    member_id: +d.memberId||0, member_name: d.memberName||'', tags: d.tags||''
  }).eq('id', req.params.id);
  res.json({ success: true });
});

app.delete('/api/documents/:id', auth, async (req, res) => {
  await supabase.from('documents').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
//  الأطفال — المدرسة والأنشطة
// ══════════════════════════════════════════════════════════

app.get('/api/school/:memberId', auth, async (req, res) => {
  const { data } = await supabase.from('school_records').select('*')
    .eq('member_id', req.params.memberId).order('date', { ascending: false });
  res.json(data || []);
});

app.post('/api/school', auth, async (req, res) => {
  const s  = req.body;
  const id = Date.now();
  await supabase.from('school_records').insert({
    id, member_id: +s.memberId, member_name: s.memberName||'',
    subject: s.subject||'', grade: s.grade||'', semester: s.semester||'',
    year: s.year||'', notes: s.notes||'', date: s.date||todayStr()
  });
  res.json({ success: true, id });
});

app.get('/api/activities', auth, async (req, res) => {
  const { data } = await supabase.from('activities').select('*').eq('active', true).order('member_name');
  res.json(data || []);
});

app.post('/api/activities', auth, async (req, res) => {
  const a  = req.body;
  const id = Date.now();
  await supabase.from('activities').insert({
    id, member_id: +a.memberId, member_name: a.memberName||'',
    name: a.name, day: a.day||'', time: a.time||'',
    location: a.location||'', fee: +a.fee||0, active: true, notes: a.notes||''
  });
  res.json({ success: true, id });
});

app.delete('/api/activities/:id', auth, async (req, res) => {
  await supabase.from('activities').update({ active: false }).eq('id', req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
//  لوحة التحكم — ملخص سريع
// ══════════════════════════════════════════════════════════

app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const today = todayStr();
    const month = today.substring(0, 7);
    const [tasks, events, meds, appts, invLow, shopping, meals] = await Promise.all([
      supabase.from('tasks').select('id, title, priority, assigned_name, due_date').eq('status', 'قيد التنفيذ').limit(5),
      supabase.from('events').select('id, title, time, type, member_name').eq('date', today),
      supabase.from('medications').select('id, name, member_name, dose, frequency').eq('active', true).limit(5),
      supabase.from('medical_appointments').select('id, doctor, date, member_name').eq('done', false).gte('date', today).order('date').limit(3),
      supabase.from('inventory').select('id, name, quantity, min_stock').filter('quantity', 'lte', supabase.raw('min_stock')).limit(5),
      supabase.from('shopping_lists').select('id, name').eq('done', false).limit(3),
      supabase.from('meal_plan').select('meal_type, recipe_name, custom').eq('date', today)
    ]);
    res.json({
      tasks:       tasks.data       || [],
      events:      events.data      || [],
      medications: meds.data        || [],
      appointments:appts.data       || [],
      lowInventory:invLow.data      || [],
      shopping:    shopping.data    || [],
      todayMeals:  meals.data       || []
    });
  } catch(e) { res.json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
//  تيليجرام
// ══════════════════════════════════════════════════════════

app.post('/api/tg/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body.message;
    if (!msg) return;
    const chatId = String(msg.chat.id);
    const text   = (msg.text || '').trim();
    if (text === '/start') {
      await sendTg(chatId, '👋 *أهلاً في نظام العائلة!*\n\n📊 /summary\n📋 /tasks\n🛒 /shopping\n🍽️ /meals\n💊 /meds');
      return;
    }
    if (text === '/summary') {
      const today = todayStr();
      const [evRes, taskRes, medRes] = await Promise.all([
        supabase.from('events').select('title, time').eq('date', today),
        supabase.from('tasks').select('title').eq('status', 'قيد التنفيذ').limit(5),
        supabase.from('medications').select('name, member_name, frequency').eq('active', true).limit(5)
      ]);
      let m = `📅 *ملخص اليوم — ${today}*\n\n`;
      if (evRes.data?.length) { m += `*أحداث اليوم:*\n`; evRes.data.forEach(e => { m += `• ${e.title} ${e.time?'('+e.time+')':''}\n`; }); }
      if (taskRes.data?.length) { m += `\n*المهام:*\n`; taskRes.data.forEach(t => { m += `• ${t.title}\n`; }); }
      if (medRes.data?.length) { m += `\n*الأدوية:*\n`; medRes.data.forEach(m2 => { m += `💊 ${m2.name} — ${m2.member_name}\n`; }); }
      await sendTg(chatId, m);
    }
    if (text === '/tasks') {
      const { data } = await supabase.from('tasks').select('title, assigned_name, due_date').eq('status', 'قيد التنفيذ').limit(10);
      let m = `📋 *المهام الحالية:*\n\n`;
      (data||[]).forEach(t => { m += `• ${t.title}${t.assigned_name?' ('+t.assigned_name+')':''}\n`; });
      if (!data?.length) m = '✅ لا توجد مهام معلقة';
      await sendTg(chatId, m);
    }
    if (text === '/shopping') {
      const { data } = await supabase.from('shopping_lists').select('name').eq('done', false);
      let m = `🛒 *قوائم التسوق:*\n\n`;
      (data||[]).forEach(l => { m += `• ${l.name}\n`; });
      if (!data?.length) m = '✅ لا توجد قوائم تسوق';
      await sendTg(chatId, m);
    }
    if (text === '/meals') {
      const { data } = await supabase.from('meal_plan').select('meal_type, recipe_name, custom').eq('date', todayStr());
      let m = `🍽️ *وجبات اليوم:*\n\n`;
      (data||[]).forEach(me => { m += `• ${me.meal_type}: ${me.recipe_name||me.custom||'غير محدد'}\n`; });
      if (!data?.length) m = '🍽️ لم تحدد وجبات اليوم بعد';
      await sendTg(chatId, m);
    }
    if (text === '/meds') {
      const { data } = await supabase.from('medications').select('name, member_name, dose, frequency').eq('active', true);
      let m = `💊 *الأدوية الحالية:*\n\n`;
      (data||[]).forEach(me => { m += `• *${me.member_name}*: ${me.name} ${me.dose} — ${me.frequency}\n`; });
      if (!data?.length) m = '✅ لا توجد أدوية مسجلة';
      await sendTg(chatId, m);
    }
  } catch(e) { console.error(e); }
});

app.post('/api/tg/set-webhook', auth, async (req, res) => {
  const url = `${process.env.APP_URL}/api/tg/webhook`;
  const r   = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url })
  });
  res.json(await r.json());
});

// ══════════════════════════════════════════════════════════
//  Cron — تذكيرات يومية
// ══════════════════════════════════════════════════════════

cron.schedule('0 7 * * *', async () => {
  const today = todayStr();
  const [events, appts] = await Promise.all([
    supabase.from('events').select('title, time, member_name').eq('date', today),
    supabase.from('medical_appointments').select('doctor, time, member_name').eq('date', today).eq('done', false)
  ]);
  let msg = `☀️ *صباح الخير! ملخص اليوم ${today}*\n\n`;
  if (events.data?.length) { msg += `📅 *أحداث اليوم:*\n`; events.data.forEach(e => { msg += `• ${e.title}${e.member_name?' ('+e.member_name+')':''}\n`; }); }
  if (appts.data?.length)  { msg += `\n🏥 *مواعيد طبية:*\n`;  appts.data.forEach(a  => { msg += `• د. ${a.doctor} — ${a.member_name} ${a.time?'الساعة '+a.time:''}\n`; }); }
  if (events.data?.length || appts.data?.length) await notifyAll(msg);
});

// ══════════════════════════════════════════════════════════
//  Health Check
// ══════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0', system: 'family', time: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`🏠 نظام العائلة v1 يعمل على المنفذ ${PORT}`));
