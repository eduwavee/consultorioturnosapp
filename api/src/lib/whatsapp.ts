import { config } from './config.js';

/**
 * Un mensaje saliente. `texto` siempre está (se usa sin credenciales, en logs y
 * dentro de la ventana de 24 h). Si viene `plantilla`, con Meta se manda la
 * plantilla aprobada, que es lo único que Meta acepta fuera de esa ventana.
 */
export interface Mensaje {
  telefono: string;
  texto: string;
  plantilla?: { nombre: string; parametros: string[] };
}
export interface ProveedorWhatsApp { nombre: string; enviar(m: Mensaje): Promise<void> }

/**
 * Número en el formato que pide WhatsApp para Argentina: 54 9 + característica + número.
 * Acepta lo que carga la gente: "381 555 1234", "0381 15 555-1234", "+54 9 381 5551234".
 */
export function aWhatsApp(telefono: string): string {
  let d = telefono.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('54')) d = d.slice(2);
  if (d.startsWith('9')) d = d.slice(1);
  if (d.startsWith('0')) d = d.slice(1);
  // "381 15 5551234": el 15 de celular va después de la característica (2 a 4 dígitos)
  if (d.length === 12) {
    for (const largo of [2, 3, 4]) {
      if (d.slice(largo, largo + 2) === '15') { d = d.slice(0, largo) + d.slice(largo + 2); break; }
    }
  }
  return d.length === 10 ? `549${d}` : telefono.replace(/\D/g, '');
}

/** Sin credenciales: el mensaje se loguea. Sirve para desarrollo y para la demo. */
const consola: ProveedorWhatsApp = {
  nombre: 'consola',
  async enviar(m) { console.log(`[whatsapp → ${m.telefono}] ${m.texto}`); },
};

/** WhatsApp Cloud API de Meta (requiere número verificado y token). */
const meta: ProveedorWhatsApp = {
  nombre: 'meta',
  async enviar(m) {
    const to = aWhatsApp(m.telefono);
    const cuerpo = m.plantilla
      ? {
          type: 'template',
          template: {
            name: m.plantilla.nombre,
            language: { code: config.whatsappIdioma },
            components: [{ type: 'body', parameters: m.plantilla.parametros.map(text => ({ type: 'text', text })) }],
          },
        }
      : { type: 'text', text: { body: m.texto } };
    const r = await fetch(`https://graph.facebook.com/v21.0/${config.whatsappPhoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsappToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, ...cuerpo }),
    });
    if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${await r.text()}`);
  },
};

let override: ProveedorWhatsApp | null = null;
/** Para tests: reemplaza el proveedor. */
export const usarProveedor = (p: ProveedorWhatsApp | null) => { override = p; };
export const proveedor = () => override ?? (config.whatsappToken && config.whatsappPhoneId ? meta : consola);
