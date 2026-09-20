import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

// In-memory mock database for leads (preserves leads during container session)
const leadsStore = [];

const db = {
  prepare(sql) {
    return {
      bind(...params) {
        return {
          async first() {
            if (sql.includes('SELECT id FROM leads WHERE id = ?')) {
              const id = params[0];
              const match = leadsStore.find((l) => l.id === id);
              return match ? { id: match.id } : null;
            }
            if (sql.includes('SELECT COUNT(*) AS total FROM leads WHERE email = ? AND created_at > ?')) {
              const [email, minTime] = params;
              const count = leadsStore.filter((l) => l.email === email && l.created_at > minTime).length;
              return { total: count };
            }
            return null;
          },
          async run() {
            if (sql.includes('INSERT INTO leads')) {
              const [id, company, name, phone, email, created_at] = params;
              leadsStore.push({ id, company, name, phone, email, created_at });
              console.log(`[Lead received] ${company} (${name}, ${email}, ${phone})`);
              return { success: true };
            }
            return { success: true };
          }
        };
      }
    };
  }
};

// JSON parser with 4KB limit matching original logic
app.use(express.json({ limit: '4kb' }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Lead capture endpoint
app.post('/api/leads', async (req, res) => {
  const origin = req.get('origin');
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const host = req.get('host');
      const forwardedHost = req.get('x-forwarded-host');
      const allowedHosts = [host, forwardedHost, 'localhost', '127.0.0.1'].filter(Boolean);
      const isAllowed = allowedHosts.some((h) => originUrl.host === h) || originUrl.hostname.endsWith('.run.app');
      if (!isAllowed) {
        return res.status(403).json({ error: 'Origem inválida.' });
      }
    } catch {
      return res.status(403).json({ error: 'Origem inválida.' });
    }
  }

  const input = req.body;
  if (!input || typeof input !== 'object') {
    return res.status(400).json({ error: 'Pedido inválido.' });
  }

  // Honeypot check
  if (input.website) {
    return res.status(400).json({ error: 'Não foi possível enviar. Tente novamente.' });
  }

  const { id, company, name, phone, email } = input;

  if (
    typeof id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(id) ||
    [company, name, phone, email].some((v) => typeof v !== 'string') ||
    company.trim().length < 2 ||
    company.length > 120 ||
    name.trim().length < 2 ||
    name.length > 120 ||
    phone.length > 35 ||
    phone.replace(/\D/g, '').length < 7 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(400).json({ error: 'Verifique os campos e tente novamente.' });
  }

  try {
    // Idempotency check
    const existing = await db.prepare('SELECT id FROM leads WHERE id = ?').bind(id).first();
    if (existing) {
      return res.json({ ok: true });
    }

    // Rate limit check (max 3 leads per email within last hour)
    const recent = await db
      .prepare('SELECT COUNT(*) AS total FROM leads WHERE email = ? AND created_at > ?')
      .bind(email.trim().toLowerCase(), Date.now() - 3600000)
      .first();

    if (recent && recent.total >= 3) {
      return res.status(429).json({ error: 'Já recebemos os seus pedidos. Tente novamente mais tarde.' });
    }

    // Insert lead
    await db
      .prepare('INSERT INTO leads (id,company,name,phone,email,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, company.trim(), name.trim(), phone.trim(), email.trim().toLowerCase(), Date.now())
      .run();

    return res.status(201).json({ ok: true });
  } catch (error) {
    console.error('Lead storage failed:', error);
    return res.status(503).json({
      error: 'Não foi possível guardar o pedido. Os seus dados continuam no formulário; tente novamente.'
    });
  }
});

// Serve static files from dist directory
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

// Fallback to index.html for any unhandled routes
app.use((req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`MGL Growth server running on http://${HOST}:${PORT}`);
});
