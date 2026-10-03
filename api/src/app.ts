import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { cambiarPassword, loadUser, login, logout, requireAuth, setSessionCookie } from './lib/auth.js';
import { config } from './lib/config.js';
import { q } from './lib/db.js';
import { errorHandler, HttpError } from './lib/errors.js';
import { adminRouter } from './routes/admin.js';
import { agendaRouter } from './routes/agenda.js';
import { cajaRouter } from './routes/caja.js';
import { clinicaRouter } from './routes/clinica.js';
import { publicRouter } from './routes/public.js';
import { webhooksRouter } from './routes/webhooks.js';
import { ciclo } from './worker.js';

/** Busca la raíz del repo (donde está web/landing), funcione desde src o desde dist. */
function raiz() {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(d, 'web', 'landing'))) return d;
    d = path.dirname(d);
  }
  return process.cwd();
}

export function crearApp() {
  const app = express();
  app.set('trust proxy', 1); // Render/Railway ponen un proxy adelante
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https://images.pexels.com'],
        connectSrc: ["'self'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        // Solo en producción (HTTPS): Safari la aplica también en localhost y pide todo por https://
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    strictTransportSecurity: config.isProd,
  }));
  // Guardamos el cuerpo crudo: la firma de los webhooks de Meta se calcula sobre los bytes exactos
  // Lo interno no se indexa: panel, API y la página de gestión del turno (lleva un token en la URL)
  app.use(['/panel', '/api', '/turno'], (_req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next(); });
  app.use(express.json({ limit: '200kb', verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  app.use(cookieParser());
  app.use(loadUser);

  const api = express.Router();
  api.get('/salud', (_req, res) => { res.json({ ok: true, demo: config.demo }); });

  // Freno contra fuerza bruta: solo cuentan los intentos fallidos, por IP
  const limiteLogin = rateLimit({
    windowMs: 15 * 60_000,
    limit: Number(process.env.LOGIN_RATE_LIMIT ?? 10),
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Demasiados intentos fallidos. Esperá unos minutos.' },
  });

  api.post('/auth/login', limiteLogin, async (req, res) => {
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    setSessionCookie(res, await login(email, password));
    res.status(204).end();
  });
  api.post('/auth/logout', async (req, res) => { await logout(req, res); res.status(204).end(); });
  api.get('/auth/yo', requireAuth, (req, res) => { res.json(req.user); });
  api.post('/auth/password', requireAuth, limiteLogin, async (req, res) => {
    const { actual, nueva } = z.object({
      actual: z.string().min(1),
      nueva: z.string().min(8, 'La contraseña nueva tiene que tener al menos 8 caracteres'),
    }).parse(req.body);
    await cambiarPassword(req, actual, nueva);
    res.status(204).end();
  });

  /**
   * Corre el ciclo del worker a pedido. Sirve para planes que duermen el
   * servidor (Render free): un cron externo llama acá cada pocos minutos,
   * lo despierta y procesa vencimientos, lista de espera y recordatorios.
   */
  api.post('/interno/ciclo', async (req, res) => {
    const secreto = String(req.get('x-cron-secret') ?? '');
    if (!config.cronSecret || secreto.length !== config.cronSecret.length
      || !crypto.timingSafeEqual(Buffer.from(secreto), Buffer.from(config.cronSecret))) throw new HttpError(401, 'No autorizado');
    res.json(await ciclo());
  });

  api.use('/public', publicRouter);
  api.use('/webhooks', webhooksRouter);
  api.use(agendaRouter);
  api.use(clinicaRouter);
  api.use(cajaRouter);
  api.use('/admin', adminRouter);
  api.use((_req, _res) => { throw new HttpError(404, 'Ruta inexistente'); });
  app.use('/api', api);

  // Archivos estáticos: landing en / y panel (build de Vite) en /panel
  const root = raiz();
  app.use(express.static(path.join(root, 'web', 'landing'), { extensions: ['html'] }));
  const panel = path.join(root, 'panel', 'dist');
  if (fs.existsSync(panel)) {
    // La app instalada lleva el nombre del consultorio cargado en Configuración
    app.get('/panel/manifest.webmanifest', async (_req, res, next) => {
      try {
        const base = JSON.parse(fs.readFileSync(path.join(panel, 'manifest.webmanifest'), 'utf8'));
        const [c] = await q<{ marca: string; especialidad: string }>('SELECT marca, especialidad FROM consultorio');
        if (c) Object.assign(base, { name: `${c.marca} · Panel`, short_name: c.marca.slice(0, 15), description: `Panel del consultorio de ${c.especialidad.toLowerCase()}: agenda, pacientes, historia clínica y caja.` });
        res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify(base));
      } catch (e) { next(e); }
    });
    // El service worker se revisa siempre, así las actualizaciones llegan enseguida
    app.get('/panel/sw.js', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(panel, 'sw.js')));
    app.use('/panel', express.static(panel));
    app.get(/^\/panel(\/.*)?$/, (_req, res) => res.sendFile(path.join(panel, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
