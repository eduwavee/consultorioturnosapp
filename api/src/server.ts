import { crearApp } from './app.js';
import { config } from './lib/config.js';
import { proveedor } from './lib/whatsapp.js';
import { iniciarWorker } from './worker.js';

const app = crearApp();
app.listen(config.port, () => {
  console.log(`Consultorio escuchando en http://localhost:${config.port}`);
  console.log(`  Landing: /   ·   Panel: /panel   ·   API: /api`);
  if (config.runWorker) {
    iniciarWorker();
    console.log(`  Worker activo · WhatsApp: ${proveedor().nombre}`);
  }
});
