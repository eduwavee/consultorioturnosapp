const env = process.env;

export const config = {
  env: env.NODE_ENV ?? 'development',
  port: Number(env.PORT ?? 3000),
  databaseUrl: env.DATABASE_URL ?? 'postgres://consultorio:consultorio@localhost:5432/consultorio',
  databaseSsl: env.DATABASE_SSL === 'true',
  runWorker: env.RUN_WORKER === 'true',
  tz: 'America/Argentina/Tucuman',
  holdMinutes: 5,
  sessionDays: 7,
  /** URL pública del sitio, para los links que van por WhatsApp. Render la define sola. */
  publicUrl: (env.PUBLIC_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/$/, ''),
  whatsappToken: env.WHATSAPP_TOKEN ?? '',
  whatsappPhoneId: env.WHATSAPP_PHONE_ID ?? '',
  /** Token que se carga en Meta al configurar el webhook (verificación GET). */
  whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN ?? '',
  /** "App secret" de la app de Meta: firma X-Hub-Signature-256 de cada webhook. */
  whatsappAppSecret: env.WHATSAPP_APP_SECRET ?? '',
  /**
   * Plantilla aprobada en Meta para el recordatorio. Fuera de la ventana de 24 h
   * Meta solo acepta plantillas. Parámetros del cuerpo, en orden:
   * {{1}} nombre, {{2}} estudio, {{3}} fecha y hora, {{4}} link para gestionar el turno.
   */
  whatsappPlantillaRecordatorio: env.WHATSAPP_TEMPLATE_RECORDATORIO ?? '',
  /** Plantilla para avisar a la lista de espera: {{1}} nombre, {{2}} estudio, {{3}} fecha y hora, {{4}} link. */
  whatsappPlantillaListaEspera: env.WHATSAPP_TEMPLATE_LISTA_ESPERA ?? '',
  whatsappIdioma: env.WHATSAPP_TEMPLATE_LANG ?? 'es_AR',
  webhookSecret: env.WEBHOOK_SECRET ?? 'cambiame',
  /** Para despertar el servidor y correr el worker desde un cron externo. */
  cronSecret: env.CRON_SECRET ?? '',
  get isProd() { return this.env === 'production'; },
  /** Usuarios de demo con contraseña pública. En producción hay que pedirlos explícitamente. */
  get demo() { return env.SEED_DEMO === 'true' || !this.isProd; },
};
