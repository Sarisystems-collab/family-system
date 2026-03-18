// ╔══════════════════════════════════════════════════════════╗
// ║       نظام المخزن v8 — Node.js + Supabase Backend       ║
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

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Supabase Client ───────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── الإعدادات ─────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const GROQ_API_KEY   = process.env.GROQ_API_KEY   || '';

const PERMISSIONS = {
  admin:  ['view','reports','add','edit','delete','users','telegram_notify','suppliers','ai','movements','backup'],
  مراجع:  ['view','reports','telegram_notify','ai','movements'],
  محضر:   ['view','add','edit_qty','movements']
};


// ══════════════════════════════════════════════════════════
//  أدوات مساعدة
// ══════════════════════════════════════════════════════════

function hashPassword(p) {
  return crypto.createHash('sha256').update(p).digest('hex');
}

function can(user, perm) {
  return (PERMISSIONS[user.role] || []).includes(perm);
}

function nowAr() {
  return new Date().toLocaleString('ar-SA');
}

async function sendTg(chatId, text) {
  if (!TELEGRAM_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'Markdown' })
    });
  } catch (e) { /* تجاهل */ }
}

async function notifyAllTg(msg) {
  const { data: users } = await supabase
    .from('users')
    .select('telegram_id, role')
    .neq('telegram_id', '');
  if (!users) return;
  for (const u of users) {
    if (u.telegram_id && (PERMISSIONS[u.role] || []).includes('telegram_notify')) {
      await sendTg(u.telegram_id, msg);
    }
  }
}

async function logAction(user, action, item, details) {
  await supabase.from('action_log').insert({
    date_time: nowAr(),
    username:  user.username,
    role:      user.role,
    action, item, details
  });
}

async function logSecurity(username, type, details) {
  await supabase.from('security_log').insert({
    date_time: nowAr(), username, type, details
  });
}

async function logMovement(itemId, itemName, type, qty, before, after, user) {
  await supabase.from('movements').insert({
    date_time: nowAr(),
    item_id:   itemId,
    item_name: itemName,
    type, quantity: qty, before_qty: before, after_qty: after,
    user_name: typeof user === 'object' ? user.name : user
  });
}


// ══════════════════════════════════════════════════════════
//  Middleware — التحقق من التوكن
// ══════════════════════════════════════════════════════════

async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.json({ error: 'غير مصرح' });

  const { data } = await supabase
    .from('sessions')
    .select('*')
    .eq('token', token)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (!data) return res.json({ error: 'انتهت الجلسة، سجّل دخول مجدداً' });

  req.user = { username: data.username, role: data.role, name: data.name };
  next();
}


// ══════════════════════════════════════════════════════════
//  تسجيل الدخول والخروج
// ══════════════════════════════════════════════════════════

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, error: 'بيانات ناقصة' });

  const { data: user } = await supabase
    .from('users').select('*').eq('username', username).maybeSingle();
  if (!user) return res.json({ success: false, error: 'اسم المستخدم غير موجود' });

  // تحقق من كلمة المرور
  if (user.password !== hashPassword(password)) {
    await logSecurity(username, 'محاولة دخول فاشلة', 'كلمة مرور خاطئة');
    return res.json({ success: false, error: 'كلمة المرور غير صحيحة' });
  }

  // دخول ناجح
  const now     = new Date();
  const token   = crypto.randomUUID();
  const expires = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();

  await supabase.from('sessions').insert({
    token, username, role: user.role, name: user.name,
    created_at: now.toISOString(), expires_at: expires
  });
  await supabase.from('users').update({ last_login: nowAr() }).eq('username', username);
  await logSecurity(username, 'دخول ناجح', 'الدور: ' + user.role);

  return res.json({
    success: true, token,
    user: { username, role: user.role, name: user.name, telegramId: user.telegram_id, alertTime: user.alert_time || '08:00' }
  });
});

app.post('/api/logout', auth, async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  await supabase.from('sessions').delete().eq('token', token);
  res.json({ success: true });
});


// ══════════════════════════════════════════════════════════
//  إدارة المستخدمين
// ══════════════════════════════════════════════════════════

app.get('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ error: 'غير مصرح' });
  const { data } = await supabase.from('users')
    .select('username, role, name, telegram_id, last_login, alert_time');
  res.json((data || []).map(u => ({
    username:       u.username,
    role:           u.role,
    name:           u.name,
    telegramId:     u.telegram_id,
    lastLogin:      u.last_login,

    alertTime:      u.alert_time || '08:00'
  })));
});

app.post('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ error: 'غير مصرح' });
  const u = req.body;
  const { error } = await supabase.from('users').insert({
    username:         u.username,
    password:         hashPassword(u.password),
    role:             u.role,
    name:             u.name,
    telegram_id:      u.telegramId || '',
    alert_time:       u.alertTime  || '08:00',
  });
  if (error) return res.json({ error: error.code === '23505' ? 'موجود مسبقاً' : error.message });
  res.json({ success: true });
});

app.delete('/api/users/:username', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ error: 'غير مصرح' });
  if (req.params.username === 'admin') return res.json({ error: 'لا يمكن حذف admin' });
  await supabase.from('users').delete().eq('username', req.params.username);
  res.json({ success: true });
});



app.get('/api/sessions', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ error: 'غير مصرح' });
  const { data } = await supabase.from('sessions').select('username, role, name, created_at').gt('expires_at', new Date().toISOString());
  res.json((data || []).map(s => ({ username: s.username, role: s.role, name: s.name, since: s.created_at })));
});

app.post('/api/users/me/telegram', auth, async (req, res) => {
  await supabase.from('users').update({ telegram_id: req.body.chatId }).eq('username', req.user.username);
  res.json({ success: true });
});

app.post('/api/users/me/password', auth, async (req, res) => {
  const { oldPass, newPass } = req.body;
  const { data } = await supabase.from('users').select('password').eq('username', req.user.username).maybeSingle();
  if (!data || data.password !== hashPassword(oldPass)) return res.json({ error: 'كلمة المرور الحالية خاطئة' });
  await supabase.from('users').update({ password: hashPassword(newPass) }).eq('username', req.user.username);
  res.json({ success: true });
});

app.post('/api/users/me/alert-time', auth, async (req, res) => {
  await supabase.from('users').update({ alert_time: req.body.time }).eq('username', req.user.username);
  res.json({ success: true });
});


// ══════════════════════════════════════════════════════════
//  المخزون
// ══════════════════════════════════════════════════════════

app.get('/api/items', auth, async (req, res) => {
  const { data } = await supabase.from('items').select('*').order('id', { ascending: false });
  res.json((data || []).map(r => ({
    id:          r.id,
    name:        r.name,
    category:    r.category,
    quantity:    r.quantity,
    price:       r.price,
    minStock:    r.min_stock,
    date:        r.date_added,
    expiry:      r.expiry      || '',
    supplierId:  r.supplier_id || '',
    image:       r.image       || '',
    warehouseId: r.warehouse_id|| ''
  })));
});

app.get('/api/stats', auth, async (req, res) => {
  try {
    const { data: items } = await supabase.from('items')
      .select('name, category, quantity, price, min_stock, expiry');

    if (!items || !items.length) {
      return res.json({ total: 0, count: 0, low: [], expired: [], expiringSoon: [], byCategory: {}, top: [] });
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const soon  = new Date(today); soon.setDate(soon.getDate() + 7);

    let total = 0;
    const low = [], expired = [], expSoon = [], allForTop = [];
    const byCategory = {};

    items.forEach(i => {
      const qty   = +i.quantity  || 0;
      const price = +i.price     || 0;
      const min   = +i.min_stock || 0;
      const value = qty * price;

      total += value;

      if (qty <= min) low.push({ name: i.name, category: i.category, quantity: qty, minStock: min });

      if (i.expiry) {
        const d = new Date(i.expiry); d.setHours(0, 0, 0, 0);
        if      (d < today)  expired.push({ name: i.name, expiry: i.expiry });
        else if (d <= soon)  expSoon.push({ name: i.name, expiry: i.expiry });
      }

      const cat = i.category || 'أخرى';
      if (!byCategory[cat]) byCategory[cat] = { count: 0, value: 0, qty: 0 };
      byCategory[cat].count++;
      byCategory[cat].value += value;
      byCategory[cat].qty   += qty;

      allForTop.push({ name: i.name, category: i.category, quantity: qty, price });
    });

    const top = allForTop
      .sort((a, b) => (b.quantity * b.price) - (a.quantity * a.price))
      .slice(0, 5);

    res.json({ total, count: items.length, low, expired, expiringSoon: expSoon, byCategory, top });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.post('/api/items', auth, async (req, res) => {
  if (!can(req.user, 'add')) return res.json({ error: 'غير مصرح' });
  const item = req.body;
  const id   = Date.now();

  const { error } = await supabase.from('items').insert({
    id,
    name:         item.name,
    category:     item.category,
    quantity:     +item.quantity,
    price:        +item.price,
    min_stock:    +(item.minStock || 1),
    date_added:   new Date().toLocaleDateString('ar-SA'),
    expiry:       item.expiry      || '',
    supplier_id:  item.supplierId  || '',
    image:        item.image       || '',
    warehouse_id: item.warehouseId || ''
  });

  if (error) return res.json({ error: error.message });

  await logMovement(id, item.name, 'إضافة', +item.quantity, 0, +item.quantity, req.user);
  await logAction(req.user, 'إضافة', item.name, 'الكمية: ' + item.quantity);
  await notifyAllTg(`✅ *إضافة*\n📦 ${item.name}\nالكمية: ${item.quantity}\n👤 ${req.user.name}`);

  res.json({ success: true, newItem: { id, ...item, quantity: +item.quantity, price: +item.price } });
});

app.put('/api/items/:id', auth, async (req, res) => {
  if (!can(req.user, 'edit') && !can(req.user, 'edit_qty')) return res.json({ error: 'غير مصرح' });

  const item    = req.body;
  const qtyOnly = can(req.user, 'edit_qty') && !can(req.user, 'edit');

  const { data: old } = await supabase.from('items').select('quantity, name').eq('id', req.params.id).maybeSingle();
  const oldQty = old ? +old.quantity : 0;

  if (qtyOnly) {
    await supabase.from('items').update({ quantity: +item.quantity }).eq('id', req.params.id);
  } else {
    await supabase.from('items').update({
      name:         item.name,
      category:     item.category,
      quantity:     +item.quantity,
      price:        +item.price,
      min_stock:    +(item.minStock || 1),
      expiry:       item.expiry      || '',
      supplier_id:  item.supplierId  || '',
      image:        item.image       || '',
      warehouse_id: item.warehouseId || ''
    }).eq('id', req.params.id);
  }

  if (+item.quantity !== oldQty) {
    const mvType = +item.quantity > oldQty ? 'إدخال' : 'صرف';
    await logMovement(req.params.id, item.name, mvType, Math.abs(+item.quantity - oldQty), oldQty, +item.quantity, req.user);
  }
  await logAction(req.user, qtyOnly ? 'تعديل كمية' : 'تعديل', item.name, 'الكمية: ' + item.quantity);
  await notifyAllTg(`✏️ *تعديل*\n📦 ${item.name}\nالكمية: ${item.quantity}\n👤 ${req.user.name}`);
  res.json({ success: true });
});

app.delete('/api/items/:id', auth, async (req, res) => {
  if (!can(req.user, 'delete')) return res.json({ error: 'غير مصرح' });

  const { data: item } = await supabase.from('items').select('name, quantity').eq('id', req.params.id).maybeSingle();
  if (!item) return res.json({ error: 'غير موجود' });

  await supabase.from('items').delete().eq('id', req.params.id);
  await logMovement(req.params.id, item.name, 'حذف', item.quantity, item.quantity, 0, req.user);
  await logAction(req.user, 'حذف', item.name, 'تم الحذف');
  await notifyAllTg(`🗑️ *حذف*\n📦 ${item.name}\n👤 ${req.user.name}`);
  res.json({ success: true });
});

app.post('/api/items/import', auth, async (req, res) => {
  if (!can(req.user, 'add')) return res.json({ error: 'غير مصرح' });
  const items = req.body.items || [];
  let added = 0;
  for (const item of items) {
    const id = Date.now() + added;
    await supabase.from('items').insert({
      id, name: item.name, category: item.category || 'أخرى',
      quantity: +item.quantity || 0, price: +item.price || 0,
      min_stock: +(item.minStock || 1), date_added: new Date().toLocaleDateString('ar-SA'),
      expiry: item.expiry || '', supplier_id: '', image: '', warehouse_id: item.warehouseId || ''
    });
    await logMovement(id, item.name, 'استيراد', +item.quantity || 0, 0, +item.quantity || 0, req.user);
    added++;
  }
  await logAction(req.user, 'استيراد', added + ' منتج', 'CSV');
  res.json({ success: true, added });
});

app.post('/api/search', auth, async (req, res) => {
  const f = req.body;
  let query = supabase.from('items').select('*');

  if (f.name)        query = query.ilike('name', `%${f.name}%`);
  if (f.category)    query = query.eq('category', f.category);
  if (f.warehouseId) query = query.eq('warehouse_id', f.warehouseId);
  if (f.supplierId)  query = query.eq('supplier_id', f.supplierId);
  if (f.minPrice != null) query = query.gte('price', +f.minPrice);
  if (f.maxPrice != null) query = query.lte('price', +f.maxPrice);
  if (f.minQty   != null) query = query.gte('quantity', +f.minQty);
  if (f.maxQty   != null) query = query.lte('quantity', +f.maxQty);

  const { data } = await query;
  let items = (data || []).map(r => ({
    id: r.id, name: r.name, category: r.category, quantity: r.quantity,
    price: r.price, minStock: r.min_stock, expiry: r.expiry || '',
    supplierId: r.supplier_id || '', image: r.image || '', warehouseId: r.warehouse_id || ''
  }));

  if (f.lowStock)     items = items.filter(i => i.quantity <= i.minStock);
  if (f.expiringSoon) {
    const s = new Date(); s.setDate(s.getDate() + 7);
    items = items.filter(i => i.expiry && new Date(i.expiry) <= s);
  }

  res.json(items);
});


// ══════════════════════════════════════════════════════════
//  الموردون
// ══════════════════════════════════════════════════════════

app.get('/api/suppliers', auth, async (req, res) => {
  const { data } = await supabase.from('suppliers').select('*').order('id', { ascending: false });
  res.json(data || []);
});

app.post('/api/suppliers', auth, async (req, res) => {
  if (!can(req.user, 'suppliers')) return res.json({ error: 'غير مصرح' });
  const s  = req.body;
  const id = Date.now();
  await supabase.from('suppliers').insert({
    id, name: s.name, category: s.category || '', phone: s.phone || '',
    email: s.email || '', notes: s.notes || '', date_added: new Date().toLocaleDateString('ar-SA')
  });
  await logAction(req.user, 'إضافة مورد', s.name, '');
  res.json({ success: true, id });
});

app.delete('/api/suppliers/:id', auth, async (req, res) => {
  if (!can(req.user, 'suppliers')) return res.json({ error: 'غير مصرح' });
  await supabase.from('suppliers').delete().eq('id', req.params.id);
  res.json({ success: true });
});

app.post('/api/suppliers/request', auth, async (req, res) => {
  if (!can(req.user, 'suppliers')) return res.json({ error: 'غير مصرح' });
  const { supplierId, items } = req.body;
  const { data: supplier } = await supabase.from('suppliers').select('name').eq('id', supplierId).maybeSingle();
  if (!supplier) return res.json({ error: 'المورد غير موجود' });
  const list = items.map(i => `• ${i.name}: ${i.qty}`).join('\n');
  await notifyAllTg(`📦 *طلب توريد*\nالمورد: *${supplier.name}*\n${list}`);
  await logAction(req.user, 'طلب توريد', supplier.name, items.length + ' أصناف');
  res.json({ success: true, message: 'تم الإرسال ✅' });
});

app.post('/api/suppliers/:id/rate', auth, async (req, res) => {
  const { supplierId, supplierName, rating, comment } = req.body;
  await supabase.from('supplier_ratings').insert({
    id: Date.now(), supplier_id: supplierId, supplier_name: supplierName,
    rating: +rating, comment: comment || '', user_name: req.user.name, date_time: nowAr()
  });
  res.json({ success: true });
});

app.get('/api/suppliers/:id/ratings', auth, async (req, res) => {
  const { data } = await supabase.from('supplier_ratings')
    .select('*').eq('supplier_id', req.params.id).order('id', { ascending: false });
  const rows = data || [];
  const avg  = rows.length ? rows.reduce((s, r) => s + +r.rating, 0) / rows.length : 0;
  res.json({
    avg:     Math.round(avg * 10) / 10,
    count:   rows.length,
    ratings: rows.map(r => ({ rating: r.rating, comment: r.comment, user: r.user_name, date: r.date_time }))
  });
});


// ══════════════════════════════════════════════════════════
//  المستودعات
// ══════════════════════════════════════════════════════════

app.get('/api/warehouses', auth, async (req, res) => {
  const { data } = await supabase.from('warehouses').select('*');
  res.json(data || []);
});

app.get('/api/warehouses/stats', auth, async (req, res) => {
  const { data: items }      = await supabase.from('items').select('warehouse_id, quantity, price');
  const { data: warehouses } = await supabase.from('warehouses').select('id, name');

  const stats = {};
  (warehouses || []).forEach(w => { stats[w.id] = { name: w.name, count: 0, value: 0, qty: 0 }; });
  stats[''] = { name: 'غير محدد', count: 0, value: 0, qty: 0 };

  (items || []).forEach(i => {
    const k = i.warehouse_id || '';
    if (!stats[k]) stats[k] = { name: 'غير محدد', count: 0, value: 0, qty: 0 };
    stats[k].count++;
    stats[k].value += (+i.quantity) * (+i.price);
    stats[k].qty   += +i.quantity;
  });

  res.json(Object.entries(stats).filter(([, v]) => v.count > 0).map(([id, v]) => ({ id, ...v })));
});

app.post('/api/warehouses', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ error: 'غير مصرح' });
  const id = Date.now();
  const w  = req.body;
  await supabase.from('warehouses').insert({
    id, name: w.name, location: w.location || '', manager: w.manager || '', notes: w.notes || ''
  });
  res.json({ success: true, id });
});

app.delete('/api/warehouses/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ error: 'غير مصرح' });
  await supabase.from('warehouses').delete().eq('id', req.params.id);
  res.json({ success: true });
});


// ══════════════════════════════════════════════════════════
//  التعليقات
// ══════════════════════════════════════════════════════════

app.get('/api/comments/:itemId', auth, async (req, res) => {
  const { data } = await supabase.from('comments')
    .select('*').eq('item_id', req.params.itemId).order('id', { ascending: false });
  res.json((data || []).map(r => ({
    id: r.id, itemId: r.item_id, itemName: r.item_name, text: r.text, user: r.user_name, date: r.date_time
  })));
});

app.post('/api/comments', auth, async (req, res) => {
  const { itemId, itemName, text } = req.body;
  if (!text?.trim()) return res.json({ error: 'التعليق فارغ' });
  const id   = Date.now();
  const date = nowAr();
  await supabase.from('comments').insert({
    id, item_id: itemId, item_name: itemName, text: text.trim(), user_name: req.user.name, date_time: date
  });
  res.json({ success: true, comment: { id, itemId, itemName, text: text.trim(), user: req.user.name, date } });
});

app.delete('/api/comments/:id', auth, async (req, res) => {
  const { data } = await supabase.from('comments').select('user_name').eq('id', req.params.id).maybeSingle();
  if (data && data.user_name !== req.user.name && req.user.role !== 'admin') {
    return res.json({ error: 'لا تملك صلاحية' });
  }
  await supabase.from('comments').delete().eq('id', req.params.id);
  res.json({ success: true });
});


// ══════════════════════════════════════════════════════════
//  التذكيرات
// ══════════════════════════════════════════════════════════

app.get('/api/reminders', auth, async (req, res) => {
  let query = supabase.from('reminders').select('*').eq('done', false);
  if (req.user.role !== 'admin') query = query.eq('username', req.user.username);
  const { data } = await query.order('due_date', { ascending: true });
  res.json((data || []).map(r => ({
    id: r.id, itemId: r.item_id, itemName: r.item_name,
    text: r.text, date: r.due_date, user: r.username, done: r.done
  })));
});

app.post('/api/reminders', auth, async (req, res) => {
  const { itemId, itemName, text, date } = req.body;
  await supabase.from('reminders').insert({
    id: Date.now(), item_id: itemId, item_name: itemName, text, due_date: date, username: req.user.username, done: false
  });
  res.json({ success: true });
});

app.post('/api/reminders/:id/done', auth, async (req, res) => {
  await supabase.from('reminders').update({ done: true }).eq('id', req.params.id);
  res.json({ success: true });
});


// ══════════════════════════════════════════════════════════
//  السجلات وحركة المخزون
// ══════════════════════════════════════════════════════════

app.get('/api/movements', auth, async (req, res) => {
  if (!can(req.user, 'movements') && !can(req.user, 'reports')) return res.json({ error: 'غير مصرح' });
  const { data } = await supabase.from('movements').select('*').order('id', { ascending: false }).limit(100);
  res.json((data || []).map(r => ({
    date: r.date_time, name: r.item_name, type: r.type, qty: r.quantity, balance: r.after_qty, user: r.user_name
  })));
});

app.get('/api/movements/stats', auth, async (req, res) => {
  if (!can(req.user, 'movements') && !can(req.user, 'reports')) return res.json({ error: 'غير مصرح' });
  const { data } = await supabase.from('movements').select('type, quantity, date_time').order('id', { ascending: false }).limit(500);
  const inTypes = ['إضافة', 'استيراد', 'إدخال'];
  let totalIn = 0, totalOut = 0;
  const byDay = {};
  (data || []).forEach(r => {
    const day = (r.date_time || '').split(' ')[0];
    if (!byDay[day]) byDay[day] = { in: 0, out: 0 };
    if (inTypes.includes(r.type)) { totalIn += +r.quantity; byDay[day].in  += +r.quantity; }
    else                          { totalOut += +r.quantity; byDay[day].out += +r.quantity; }
  });
  const byDayArr = Object.entries(byDay).slice(-14).map(([date, v]) => ({ date, in: v.in, out: v.out }));
  res.json({ byDay: byDayArr, totalIn, totalOut });
});

app.get('/api/log', auth, async (req, res) => {
  if (!can(req.user, 'reports')) return res.json({ error: 'غير مصرح' });
  const { data } = await supabase.from('action_log').select('*').order('id', { ascending: false }).limit(30);
  res.json((data || []).map(r => ({
    date: r.date_time, userName: r.username, role: r.role, action: r.action, name: r.item, details: r.details
  })));
});

app.get('/api/security-log', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ error: 'غير مصرح' });
  const { data } = await supabase.from('security_log').select('*').order('id', { ascending: false }).limit(50);
  res.json((data || []).map(r => ({ date: r.date_time, username: r.username, type: r.type, details: r.details })));
});


// ══════════════════════════════════════════════════════════
//  التصدير
// ══════════════════════════════════════════════════════════

app.get('/api/export/pdf', auth, async (req, res) => {
  if (!can(req.user, 'reports')) return res.json({ error: 'غير مصرح' });
  const { data: items } = await supabase.from('items').select('*');
  const total = (items || []).reduce((s, i) => s + (+i.quantity) * (+i.price), 0);
  const rows  = (items || []).map(i =>
    `<tr><td>${i.name}</td><td>${i.category}</td><td>${i.quantity}</td>
     <td>${i.price} ر.س</td><td>${((+i.quantity)*(+i.price)).toLocaleString('ar-SA')} ر.س</td>
     <td>${i.expiry || '—'}</td></tr>`
  ).join('');
  const html = `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"><title>تقرير المخزون</title>
    <style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #ddd;padding:8px;text-align:right}th{background:#1e293b;color:white}
    .total{margin-top:16px;font-size:18px;font-weight:bold}</style></head>
    <body><h2>📦 تقرير المخزون — ${new Date().toLocaleDateString('ar-SA')}</h2>
    <table><thead><tr><th>المنتج</th><th>الفئة</th><th>الكمية</th><th>السعر</th><th>القيمة</th><th>الصلاحية</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="total">💰 الإجمالي: ${total.toLocaleString('ar-SA')} ر.س | 📦 ${(items || []).length} صنف</div>
    </body></html>`;
  res.json({ html });
});


// ══════════════════════════════════════════════════════════
//  الذكاء الاصطناعي
// ══════════════════════════════════════════════════════════

app.post('/api/ai/analyze', auth, async (req, res) => {
  if (!can(req.user, 'ai')) return res.json({ error: 'غير مصرح' });
  const { data: items } = await supabase.from('items')
    .select('name, quantity, price, min_stock, expiry').limit(30);
  const summary = (items || []).map(i =>
    `${i.name}: الكمية=${i.quantity}, السعر=${i.price}, الحد=${i.min_stock}, الصلاحية=${i.expiry || 'لا يوجد'}`
  ).join('\n');
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { Authorization: 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model: 'llama-3.3-70b-versatile', max_tokens: 1000,
        messages: [{ role: 'user', content: 'أنت خبير إدارة مخازن. حلّل:\n1. ملاحظات\n2. توصيات\n3. تحذيرات\n\n' + summary }]
      })
    });
    const json = await r.json();
    res.json({ success: true, analysis: json.choices[0].message.content });
  } catch (e) {
    res.json({ error: e.message });
  }
});


// ══════════════════════════════════════════════════════════
//  تيليجرام
// ══════════════════════════════════════════════════════════

async function sendDailyReport() {
  const { data: items } = await supabase.from('items').select('name, quantity, price, min_stock, expiry');
  const total = (items || []).reduce((s, i) => s + (+i.quantity) * (+i.price), 0);
  const low   = (items || []).filter(i => +i.quantity <= +i.min_stock);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const soon  = new Date(today); soon.setDate(soon.getDate() + 7);
  const exp   = (items || []).filter(i => i.expiry && new Date(i.expiry) <= soon);

  let msg = `📊 *تقرير المخزون*\n📅 ${new Date().toLocaleDateString('ar-SA')}\n\n📦 ${(items||[]).length} صنف | 💰 *${total.toLocaleString('ar-SA')} ر.س*\n`;
  if (low.length) { msg += `\n⚠️ *منخفض (${low.length})*\n`; low.forEach(i => { msg += `🔴 ${i.name}: ${i.quantity}/${i.min_stock}\n`; }); }
  if (exp.length) { msg += `\n⏰ *تنتهي قريباً (${exp.length})*\n`; exp.forEach(i => { msg += `🟡 ${i.name}: ${i.expiry}\n`; }); }
  await notifyAllTg(msg);
}

app.post('/api/tg/send-report', auth, async (req, res) => {
  await sendDailyReport();
  res.json({ success: true });
});

app.post('/api/tg/webhook', async (req, res) => {
  res.sendStatus(200); // رد فوري لتيليجرام
  try {
    const msg    = req.body.message;
    if (!msg)    return;
    const chatId = String(msg.chat.id);
    const text   = (msg.text || '').trim();

    if (text === '/start') {
      await sendTg(chatId, '👋 *أهلاً في المخزن v8!*\n\n📊 /report\n⚠️ /lowstock\n⏰ /expiring\n🔍 /search اسم');
      return;
    }

    const { data: userData } = await supabase.from('users')
      .select('username, role, name').eq('telegram_id', chatId).maybeSingle();
    if (!userData) { await sendTg(chatId, '⛔ غير مصرح.'); return; }

    if (text === '/report')   { await sendDailyReport(); return; }

    if (text === '/lowstock') {
      const { data: items } = await supabase.from('items').select('name, quantity, min_stock');
      const low = (items || []).filter(i => +i.quantity <= +i.min_stock);
      if (!low.length) { await sendTg(chatId, '✅ المخزون ممتاز!'); return; }
      let m = `⚠️ *منخفض (${low.length})*\n\n`;
      low.forEach(i => { m += `🔴 *${i.name}*: ${i.quantity}/${i.min_stock}\n`; });
      await sendTg(chatId, m); return;
    }

    if (text === '/expiring') {
      const today = new Date(); today.setHours(0,0,0,0);
      const soon  = new Date(today); soon.setDate(soon.getDate()+7);
      const { data: items } = await supabase.from('items').select('name, expiry').not('expiry', 'eq', '');
      const exp = (items||[]).filter(i => i.expiry && new Date(i.expiry) <= soon);
      if (!exp.length) { await sendTg(chatId, '✅ لا توجد منتهية قريباً.'); return; }
      let m = `⏰ *تنتهي قريباً (${exp.length})*\n\n`;
      exp.forEach(i => { m += `🟡 *${i.name}*: ${i.expiry}\n`; });
      await sendTg(chatId, m); return;
    }

    if (text.startsWith('/search ')) {
      const q = text.replace('/search ', '');
      const { data: items } = await supabase.from('items').select('name, quantity, price').ilike('name', `%${q}%`);
      if (!items?.length) { await sendTg(chatId, `🔍 لا نتائج لـ "${q}"`); return; }
      let m = `🔍 *"${q}"*\n\n`;
      items.forEach(i => { m += `📦 *${i.name}* | ${i.quantity} | ${i.price} ر.س\n`; });
      await sendTg(chatId, m);
    }
  } catch (e) { console.error('Webhook error:', e); }
});

app.post('/api/tg/set-webhook', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.json({ error: 'غير مصرح' });
  const url = `${process.env.APP_URL}/api/tg/webhook`;
  const r   = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url })
  });
  res.json(await r.json());
});


// ══════════════════════════════════════════════════════════
//  التنبيهات التلقائية (Cron Jobs)
// ══════════════════════════════════════════════════════════

// تقرير يومي الساعة 8 صباحاً
cron.schedule('0 8 * * *', async () => {
  console.log('[cron] إرسال التقرير اليومي...');
  await sendDailyReport();
});

// فحص التذكيرات الساعة 7 صباحاً
cron.schedule('0 7 * * *', async () => {
  console.log('[cron] فحص التذكيرات...');
  const today = new Date().toISOString().split('T')[0];
  const { data: rems } = await supabase.from('reminders')
    .select('*').eq('done', false).lte('due_date', today);
  for (const rem of (rems || [])) {
    const { data: u } = await supabase.from('users')
      .select('telegram_id').eq('username', rem.username).maybeSingle();
    if (u?.telegram_id) {
      await sendTg(u.telegram_id, `📅 *تذكير!*\n📦 ${rem.item_name}\n📝 ${rem.text}`);
    }
  }
});


// ══════════════════════════════════════════════════════════
//  1 — تقارير متقدمة (مقارنة شهرية)
// ══════════════════════════════════════════════════════════

app.get('/api/stats/advanced', auth, async (req, res) => {
  try {
    const { data: items } = await supabase.from('items')
      .select('category, quantity, price, min_stock, expiry, date_added');
    if (!items || !items.length) return res.json({ monthly: [], categoryTrend: [], valueHistory: [] });

    // توزيع القيمة حسب الفئة مرتّبة تنازلياً
    const catMap = {};
    items.forEach(i => {
      const cat = i.category || 'أخرى';
      if (!catMap[cat]) catMap[cat] = { value: 0, count: 0, qty: 0 };
      catMap[cat].value += (+i.quantity) * (+i.price);
      catMap[cat].count++;
      catMap[cat].qty   += +i.quantity;
    });
    const categoryTrend = Object.entries(catMap)
      .sort((a, b) => b[1].value - a[1].value)
      .map(([cat, d]) => ({ cat, ...d }));

    // حركة الأشهر الستة الأخيرة
    const { data: movements } = await supabase.from('movements')
      .select('type, quantity, date_time')
      .order('id', { ascending: false })
      .limit(1000);

    const monthMap = {};
    const inTypes  = ['إضافة', 'استيراد', 'إدخال'];
    const now      = new Date();
    for (let m = 5; m >= 0; m--) {
      const d   = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthMap[key] = { month: key, in: 0, out: 0 };
    }
    (movements || []).forEach(r => {
      const key = (r.date_time || '').substring(0, 7);
      if (!monthMap[key]) return;
      if (inTypes.includes(r.type)) monthMap[key].in  += +r.quantity;
      else                          monthMap[key].out += +r.quantity;
    });
    const monthly = Object.values(monthMap);

    // توقع النفاد — المنتجات التي ستنفد خلال 30 يوم بناءً على معدل الصرف
    const { data: recentMov } = await supabase.from('movements')
      .select('item_id, item_name, type, quantity, date_time')
      .order('id', { ascending: false }).limit(500);

    const consumption = {};
    (recentMov || []).forEach(r => {
      if (inTypes.includes(r.type)) return;
      if (!consumption[r.item_id]) consumption[r.item_id] = { name: r.item_name, total: 0, days: 30 };
      consumption[r.item_id].total += +r.quantity;
    });
    const itemsMap = {};
    items.forEach((i, idx) => { itemsMap[idx] = i; });

    // منتجات ستنفد — مقارنة الكمية الحالية مع معدل الصرف اليومي
    const { data: allItems } = await supabase.from('items').select('id, name, quantity, min_stock');
    const predictions = (allItems || [])
      .filter(i => consumption[i.id])
      .map(i => {
        const dailyRate = consumption[i.id].total / 30;
        const daysLeft  = dailyRate > 0 ? Math.floor(+i.quantity / dailyRate) : 999;
        return { name: i.name, quantity: +i.quantity, dailyRate: Math.round(dailyRate * 10) / 10, daysLeft };
      })
      .filter(i => i.daysLeft < 30)
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 10);

    res.json({ monthly, categoryTrend, predictions });
  } catch (e) {
    res.json({ error: e.message });
  }
});


// ══════════════════════════════════════════════════════════
//  2 — ذكاء اصطناعي: اقتراح طلبات الشراء
// ══════════════════════════════════════════════════════════

app.post('/api/ai/purchase-suggestions', auth, async (req, res) => {
  if (!can(req.user, 'ai')) return res.json({ error: 'غير مصرح' });
  try {
    const { data: items }    = await supabase.from('items').select('name, quantity, min_stock, price, category, supplier_id').limit(50);
    const { data: suppliers }= await supabase.from('suppliers').select('id, name, category');
    const { data: movements }= await supabase.from('movements').select('item_id, item_name, type, quantity').order('id', { ascending: false }).limit(300);

    // احسب معدل الاستهلاك لكل منتج
    const consumption = {};
    const inTypes = ['إضافة', 'استيراد', 'إدخال'];
    (movements || []).forEach(r => {
      if (inTypes.includes(r.type)) return;
      if (!consumption[r.item_id]) consumption[r.item_id] = 0;
      consumption[r.item_id] += +r.quantity;
    });

    const lowItems = (items || []).filter(i => +i.quantity <= +i.min_stock * 1.5);
    const summary  = lowItems.map(i => {
      const sup = (suppliers || []).find(s => String(s.id) === String(i.supplier_id));
      return `${i.name} (${i.category}): الكمية=${i.quantity}, الحد=${i.min_stock}, المورد=${sup?.name || 'غير محدد'}, الاستهلاك/شهر≈${consumption[i.id] || 0}`;
    }).join('\n');

    if (!summary) return res.json({ success: true, suggestions: 'جميع المنتجات بمستوى جيد ✅' });

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', max_tokens: 800,
        messages: [{
          role: 'user',
          content: `أنت مدير مشتريات خبير. بناءً على هذه البيانات اقترح طلبات الشراء:\n${summary}\n\nاعطني قائمة مرتبة بالأولوية: المنتج، الكمية المقترحة للطلب، السبب. بالعربية وبشكل مختصر.`
        }]
      })
    });
    const json = await r.json();
    res.json({ success: true, suggestions: json.choices[0].message.content });
  } catch (e) {
    res.json({ error: e.message });
  }
});


// ══════════════════════════════════════════════════════════
//  3 — فاتورة PDF احترافية
// ══════════════════════════════════════════════════════════

app.post('/api/export/invoice', auth, async (req, res) => {
  if (!can(req.user, 'reports')) return res.json({ error: 'غير مصرح' });
  const { items: invoiceItems, supplierName, notes, invoiceNumber } = req.body;
  if (!invoiceItems || !invoiceItems.length) return res.json({ error: 'لا توجد أصناف' });

  const total    = invoiceItems.reduce((s, i) => s + (+i.qty) * (+i.price), 0);
  const date     = new Date().toLocaleDateString('ar-SA');
  const invNum   = invoiceNumber || ('INV-' + Date.now());
  const rows     = invoiceItems.map((i, idx) => `
    <tr>
      <td>${idx + 1}</td><td>${i.name}</td><td>${i.qty}</td>
      <td>${Number(i.price).toLocaleString('ar-SA')} ر.س</td>
      <td>${(+i.qty * +i.price).toLocaleString('ar-SA')} ر.س</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html dir="rtl" lang="ar">
<head><meta charset="UTF-8"><title>فاتورة ${invNum}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Arial,sans-serif;padding:40px;color:#1e293b;font-size:14px}
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:40px;padding-bottom:20px;border-bottom:3px solid #1e293b}
  .title{font-size:32px;font-weight:900;color:#1e293b}
  .inv-info{text-align:left}
  .inv-info p{margin:4px 0;font-size:13px}
  .inv-num{font-size:18px;font-weight:700;color:#f59e0b}
  .section-title{font-size:13px;font-weight:700;color:#64748b;margin:20px 0 8px;text-transform:uppercase}
  table{width:100%;border-collapse:collapse;margin:20px 0}
  th{background:#1e293b;color:white;padding:10px 12px;text-align:right;font-size:13px}
  td{padding:10px 12px;border-bottom:1px solid #e2e8f0;font-size:13px}
  tr:nth-child(even) td{background:#f8fafc}
  .total-row{background:#f1f5f9!important}
  .total-row td{font-weight:700;font-size:15px;border-top:2px solid #1e293b}
  .total-val{color:#f59e0b;font-size:18px;font-weight:900}
  .footer{margin-top:40px;padding-top:20px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;text-align:center}
  .notes{background:#fefce8;border:1px solid #fde68a;padding:12px;border-radius:8px;margin-top:20px;font-size:13px}
  @media print{body{padding:20px}}
</style></head>
<body>
<div class="header">
  <div>
    <div class="title">📦 نظام المخزن</div>
    <div style="color:#64748b;margin-top:6px">فاتورة ضريبية مبسطة</div>
  </div>
  <div class="inv-info">
    <div class="inv-num">${invNum}</div>
    <p>التاريخ: ${date}</p>
    ${supplierName ? `<p>المورد: ${supplierName}</p>` : ''}
    <p>الموظف: ${req.user.name}</p>
  </div>
</div>
<div class="section-title">تفاصيل الأصناف</div>
<table>
  <thead><tr><th>#</th><th>الصنف</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>
  <tbody>
    ${rows}
    <tr class="total-row">
      <td colspan="4" style="text-align:left">الإجمالي الكلي</td>
      <td class="total-val">${total.toLocaleString('ar-SA')} ر.س</td>
    </tr>
  </tbody>
</table>
${notes ? `<div class="notes">📝 ملاحظات: ${notes}</div>` : ''}
<div class="footer">
  <p>نظام المخزن v8 — تم الإنشاء بتاريخ ${date}</p>
  <p>هذه الفاتورة صادرة إلكترونياً وصالحة بدون توقيع</p>
</div>
</body></html>`;

  res.json({ html, invoiceNumber: invNum });
});


// ══════════════════════════════════════════════════════════
//  4 — باركود: بحث بالرقم
// ══════════════════════════════════════════════════════════

app.get('/api/items/barcode/:code', auth, async (req, res) => {
  const code = req.params.code;
  // ابحث في الاسم أو الـ ID
  const { data } = await supabase.from('items')
    .select('*')
    .or(`id.eq.${isNaN(code) ? 0 : code},name.ilike.%${code}%`)
    .limit(5);
  if (!data || !data.length) return res.json({ found: false });
  res.json({
    found: true,
    items: data.map(r => ({
      id: r.id, name: r.name, category: r.category,
      quantity: r.quantity, price: r.price, minStock: r.min_stock
    }))
  });
});


// ══════════════════════════════════════════════════════════
//  5 — صلاحيات أدق: المستودع لكل مستخدم
// ══════════════════════════════════════════════════════════

app.post('/api/users/me/warehouse', auth, async (req, res) => {
  const { warehouseId } = req.body;
  await supabase.from('users').update({ default_warehouse: warehouseId }).eq('username', req.user.username);
  res.json({ success: true });
});


// ══════════════════════════════════════════════════════════
//  6 — مزامنة Excel: رفع وتحليل
// ══════════════════════════════════════════════════════════

app.post('/api/import/excel-json', auth, async (req, res) => {
  // الفرونت يحوّل Excel لـ JSON ويرسله هنا
  if (!can(req.user, 'add')) return res.json({ error: 'غير مصرح' });
  const { rows } = req.body;
  if (!rows || !rows.length) return res.json({ error: 'لا توجد بيانات' });

  let added = 0, updated = 0, errors = [];
  for (const row of rows) {
    if (!row.name) continue;
    try {
      // لو موجود — حدّث الكمية والسعر
      const { data: existing } = await supabase.from('items').select('id, quantity').ilike('name', row.name).maybeSingle();
      if (existing) {
        await supabase.from('items').update({ quantity: +row.quantity || existing.quantity, price: +row.price || 0 }).eq('id', existing.id);
        await logMovement(existing.id, row.name, 'مزامنة Excel', +row.quantity || 0, existing.quantity, +row.quantity || 0, req.user);
        updated++;
      } else {
        const id = Date.now() + added;
        await supabase.from('items').insert({
          id, name: row.name, category: row.category || 'أخرى',
          quantity: +row.quantity || 0, price: +row.price || 0,
          min_stock: +row.min_stock || 1, date_added: new Date().toLocaleDateString('ar-SA'),
          expiry: row.expiry || '', supplier_id: '', image: '', warehouse_id: row.warehouse_id || ''
        });
        added++;
      }
    } catch (e) { errors.push(row.name + ': ' + e.message); }
  }
  await logAction(req.user, 'مزامنة Excel', `${added} جديد + ${updated} محدّث`, '');
  res.json({ success: true, added, updated, errors });
});



// ══════════════════════════════════════════════════════════
//  AI Chat للمخزن
// ══════════════════════════════════════════════════════════

app.post('/api/ai/chat', auth, async (req, res) => {
  if (!GROQ_API_KEY) return res.json({ error: 'GROQ_API_KEY غير محدد' });
  const { message, history } = req.body;
  if (!message) return res.json({ error: 'الرسالة فارغة' });
  try {
    const [items, suppliers, movements] = await Promise.all([
      supabase.from('items').select('name, category, quantity, price, min_stock, expiry').limit(30),
      supabase.from('suppliers').select('name, category').limit(10),
      supabase.from('movements').select('item_name, type, quantity').order('id', { ascending: false }).limit(20)
    ]);
    const total   = (items.data||[]).reduce((s,i)=>s+(+i.quantity)*(+i.price),0);
    const low     = (items.data||[]).filter(i=>+i.quantity<=+i.min_stock).map(i=>i.name);
    const today   = new Date(); today.setHours(0,0,0,0);
    const soon    = new Date(today); soon.setDate(soon.getDate()+7);
    const expired = (items.data||[]).filter(i=>i.expiry&&new Date(i.expiry)<today).map(i=>i.name);
    const context = `أنت مساعد ذكي لنظام مخزن. البيانات:
إجمالي المخزون: ${total.toLocaleString('ar-SA')} ر.س
عدد الأصناف: ${(items.data||[]).length}
مخزون منخفض: ${low.join('، ')||'لا يوجد'}
منتهي الصلاحية: ${expired.join('، ')||'لا يوجد'}
الموردون: ${(suppliers.data||[]).map(s=>s.name).join('، ')}
أجب بالعربية بشكل مختصر ومفيد.`;
    const messages = [
      { role: 'system', content: context },
      ...(history||[]).slice(-6),
      { role: 'user', content: message }
    ];
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + GROQ_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 400, messages })
    });
    const json = await r.json();
    res.json({ success: true, reply: json.choices[0].message.content });
  } catch(e) { res.json({ error: e.message }); }
});

// إشعار أسبوعي بتقرير شامل
cron.schedule('0 9 * * 0', async () => {
  const { data: items } = await supabase.from('items').select('name, quantity, price, min_stock, expiry');
  const total = (items||[]).reduce((s,i)=>s+(+i.quantity)*(+i.price),0);
  const low   = (items||[]).filter(i=>+i.quantity<=+i.min_stock);
  const today = new Date(); today.setHours(0,0,0,0);
  const soon  = new Date(today); soon.setDate(soon.getDate()+7);
  const exp   = (items||[]).filter(i=>i.expiry&&new Date(i.expiry)<=soon);
  let msg = `📊 *التقرير الأسبوعي للمخزن*

`;
  msg += `💰 القيمة الإجمالية: *${total.toLocaleString('ar-SA')} ر.س*
`;
  msg += `📦 عدد الأصناف: ${(items||[]).length}
`;
  if (low.length) { msg += '\n⚠️ *منخفض (' + low.length + '):*\n'; low.forEach(i=>{ msg += '• ' + i.name + ': ' + i.quantity + '/' + i.min_stock + '\n'; }); }
  if (exp.length) { msg += '\n⏰ *تنتهي قريباً (' + exp.length + '):*\n'; exp.forEach(i=>{ msg += '• ' + i.name + ': ' + i.expiry + '\n'; }); }
  await notifyAllMsg(msg);
});

// ══════════════════════════════════════════════════════════
//  Health Check
// ══════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '10.0.0', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 نظام المخزن v10 يعمل على المنفذ ${PORT}`);
});
