-- ╔══════════════════════════════════════════════════════════╗
-- ║         نظام العائلة v1 — Supabase Schema               ║
-- ║  شغّل هذا في SQL Editor في Supabase                     ║
-- ╚══════════════════════════════════════════════════════════╝

-- ══════════════════════════════════════════════════════════
--  المستخدمون والجلسات
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  username    TEXT PRIMARY KEY,
  password    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  name        TEXT DEFAULT '',
  telegram_id TEXT DEFAULT '',
  last_login  TEXT DEFAULT '',
  alert_time  TEXT DEFAULT '08:00',
  member_id   TEXT DEFAULT ''
);

INSERT INTO users (username, password, role, name)
VALUES ('admin', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9', 'admin', 'المدير')
ON CONFLICT (username) DO NOTHING;

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  username   TEXT NOT NULL,
  role       TEXT NOT NULL,
  name       TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- ══════════════════════════════════════════════════════════
--  أفراد العائلة
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS family_members (
  id         BIGINT PRIMARY KEY,
  name       TEXT NOT NULL,
  relation   TEXT DEFAULT '',   -- أب، أم، ابن، ابنة، جد...
  birthdate  TEXT DEFAULT '',
  phone      TEXT DEFAULT '',
  blood_type TEXT DEFAULT '',
  notes      TEXT DEFAULT '',
  avatar     TEXT DEFAULT '',   -- emoji أو رابط صورة
  created_at TEXT DEFAULT ''
);

-- ══════════════════════════════════════════════════════════
--  المخزون المنزلي
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS inventory (
  id           BIGINT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT DEFAULT 'أخرى',
  quantity     NUMERIC DEFAULT 0,
  unit         TEXT DEFAULT 'قطعة',
  min_stock    NUMERIC DEFAULT 1,
  location     TEXT DEFAULT '',    -- المطبخ، الحمام، المخزن...
  expiry       TEXT DEFAULT '',
  notes        TEXT DEFAULT '',
  date_added   TEXT DEFAULT ''
);

-- ══════════════════════════════════════════════════════════
--  المالية العائلية
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS budget_categories (
  id     BIGINT PRIMARY KEY,
  name   TEXT NOT NULL,
  budget NUMERIC DEFAULT 0,   -- الميزانية الشهرية
  icon   TEXT DEFAULT '💰',
  color  TEXT DEFAULT '#6b7280'
);

-- فئات افتراضية
INSERT INTO budget_categories (id, name, budget, icon, color) VALUES
  (1, 'مواصلات',   500,  '🚗', '#3b82f6'),
  (2, 'طعام',      2000, '🍽️', '#10b981'),
  (3, 'فواتير',    800,  '📄', '#f59e0b'),
  (4, 'ترفيه',     400,  '🎮', '#8b5cf6'),
  (5, 'تعليم',     600,  '📚', '#06b6d4'),
  (6, 'صحة',       500,  '🏥', '#ef4444'),
  (7, 'ملابس',     300,  '👗', '#ec4899'),
  (8, 'أخرى',      200,  '📦', '#6b7280')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS expenses (
  id          BIGINT PRIMARY KEY,
  amount      NUMERIC NOT NULL,
  category_id BIGINT,
  description TEXT DEFAULT '',
  member_id   BIGINT DEFAULT 0,  -- من دفع
  member_name TEXT DEFAULT '',
  date        TEXT DEFAULT '',
  date_full   TIMESTAMPTZ DEFAULT NOW(),
  notes       TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS income (
  id          BIGINT PRIMARY KEY,
  amount      NUMERIC NOT NULL,
  source      TEXT DEFAULT '',
  member_id   BIGINT DEFAULT 0,
  member_name TEXT DEFAULT '',
  date        TEXT DEFAULT '',
  notes       TEXT DEFAULT ''
);

-- ══════════════════════════════════════════════════════════
--  المهام والجدول العائلي
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tasks (
  id          BIGINT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  assigned_to BIGINT DEFAULT 0,   -- member_id
  assigned_name TEXT DEFAULT '',
  due_date    TEXT DEFAULT '',
  due_time    TEXT DEFAULT '',
  priority    TEXT DEFAULT 'متوسط',  -- عالي، متوسط، منخفض
  status      TEXT DEFAULT 'قيد التنفيذ',  -- مكتمل، قيد التنفيذ، معلق
  category    TEXT DEFAULT 'عام',
  created_by  TEXT DEFAULT '',
  created_at  TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  id          BIGINT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT DEFAULT '',
  date        TEXT NOT NULL,
  time        TEXT DEFAULT '',
  end_time    TEXT DEFAULT '',
  type        TEXT DEFAULT 'عام',   -- مدرسي، طبي، اجتماعي، ديني، عام
  member_id   BIGINT DEFAULT 0,
  member_name TEXT DEFAULT '',
  location    TEXT DEFAULT '',
  reminder    BOOLEAN DEFAULT TRUE,
  created_at  TEXT DEFAULT ''
);

-- ══════════════════════════════════════════════════════════
--  الصحة
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS medications (
  id          BIGINT PRIMARY KEY,
  member_id   BIGINT NOT NULL,
  member_name TEXT DEFAULT '',
  name        TEXT NOT NULL,
  dose        TEXT DEFAULT '',
  frequency   TEXT DEFAULT '',   -- مرة يومياً، مرتين...
  start_date  TEXT DEFAULT '',
  end_date    TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  active      BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS medical_appointments (
  id          BIGINT PRIMARY KEY,
  member_id   BIGINT NOT NULL,
  member_name TEXT DEFAULT '',
  doctor      TEXT DEFAULT '',
  specialty   TEXT DEFAULT '',
  date        TEXT NOT NULL,
  time        TEXT DEFAULT '',
  location    TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  done        BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS health_records (
  id          BIGINT PRIMARY KEY,
  member_id   BIGINT NOT NULL,
  member_name TEXT DEFAULT '',
  type        TEXT DEFAULT '',   -- وزن، ضغط، سكر، طول...
  value       TEXT DEFAULT '',
  unit        TEXT DEFAULT '',
  date        TEXT DEFAULT '',
  notes       TEXT DEFAULT ''
);

-- ══════════════════════════════════════════════════════════
--  قوائم التسوق
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS shopping_lists (
  id         BIGINT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT '',
  done       BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS shopping_items (
  id       BIGINT PRIMARY KEY,
  list_id  BIGINT NOT NULL,
  name     TEXT NOT NULL,
  quantity TEXT DEFAULT '1',
  unit     TEXT DEFAULT '',
  category TEXT DEFAULT '',
  bought   BOOLEAN DEFAULT FALSE,
  notes    TEXT DEFAULT ''
);

-- ══════════════════════════════════════════════════════════
--  الوجبات والطبخ
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS recipes (
  id           BIGINT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT DEFAULT 'رئيسي',  -- فطور، غداء، عشاء، حلويات، سلطة
  ingredients  TEXT DEFAULT '',   -- JSON نص
  instructions TEXT DEFAULT '',
  prep_time    INT  DEFAULT 0,    -- دقائق
  cook_time    INT  DEFAULT 0,
  servings     INT  DEFAULT 4,
  notes        TEXT DEFAULT '',
  favorite     BOOLEAN DEFAULT FALSE,
  image        TEXT DEFAULT '',
  added_by     TEXT DEFAULT '',
  created_at   TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS meal_plan (
  id        BIGINT PRIMARY KEY,
  date      TEXT NOT NULL,
  meal_type TEXT NOT NULL,    -- فطور، غداء، عشاء
  recipe_id BIGINT DEFAULT 0,
  recipe_name TEXT DEFAULT '',
  custom    TEXT DEFAULT '',  -- وجبة غير موجودة في الوصفات
  notes     TEXT DEFAULT ''
);

-- ══════════════════════════════════════════════════════════
--  الوثائق والملاحظات
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS documents (
  id          BIGINT PRIMARY KEY,
  title       TEXT NOT NULL,
  type        TEXT DEFAULT 'ملاحظة',  -- وثيقة، ملاحظة، رقم مهم
  content     TEXT DEFAULT '',
  member_id   BIGINT DEFAULT 0,
  member_name TEXT DEFAULT '',
  tags        TEXT DEFAULT '',
  created_by  TEXT DEFAULT '',
  created_at  TEXT DEFAULT ''
);

-- ══════════════════════════════════════════════════════════
--  الأطفال — المتابعة المدرسية
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS school_records (
  id          BIGINT PRIMARY KEY,
  member_id   BIGINT NOT NULL,
  member_name TEXT DEFAULT '',
  subject     TEXT DEFAULT '',
  grade       TEXT DEFAULT '',
  semester    TEXT DEFAULT '',
  year        TEXT DEFAULT '',
  notes       TEXT DEFAULT '',
  date        TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS activities (
  id          BIGINT PRIMARY KEY,
  member_id   BIGINT NOT NULL,
  member_name TEXT DEFAULT '',
  name        TEXT NOT NULL,
  day         TEXT DEFAULT '',
  time        TEXT DEFAULT '',
  location    TEXT DEFAULT '',
  fee         NUMERIC DEFAULT 0,
  active      BOOLEAN DEFAULT TRUE,
  notes       TEXT DEFAULT ''
);

-- ══════════════════════════════════════════════════════════
--  Indexes
-- ══════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_expenses_date      ON expenses (date);
CREATE INDEX IF NOT EXISTS idx_expenses_category  ON expenses (category_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned     ON tasks (assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status       ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_events_date        ON events (date);
CREATE INDEX IF NOT EXISTS idx_medications_member ON medications (member_id);
CREATE INDEX IF NOT EXISTS idx_shopping_list      ON shopping_items (list_id);
CREATE INDEX IF NOT EXISTS idx_meal_plan_date     ON meal_plan (date);
CREATE INDEX IF NOT EXISTS idx_school_member      ON school_records (member_id);
