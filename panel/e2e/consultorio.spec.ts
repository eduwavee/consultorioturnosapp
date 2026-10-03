import { expect, test, type Page } from '@playwright/test';

/** Entra al panel con uno de los botones de usuarios de demo. */
async function entrar(page: Page, rol: 'Secretaría' | 'Médica' | 'Administración') {
  await page.goto('/panel/');
  await page.getByRole('button', { name: new RegExp(`^${rol}`) }).click();
  // exact: el título del login también dice "agenda"
  await expect(page.getByRole('heading', { name: 'Agenda', level: 1, exact: true })).toBeVisible();
}

/** Turnos que se pueden mover y todavía no se cobraron (los tests de otro navegador pueden haber cobrado algunos). */
const LIBRE = '.tb[draggable="true"]:not(.cobrado)';

/** Avanza la agenda hasta un día que tenga turnos que se puedan mover. */
async function irADiaConTurnos(page: Page) {
  for (let i = 0; i < 6; i++) {
    await page.getByRole('button', { name: 'Día siguiente' }).click();
    const hay = await page.locator(LIBRE).first().waitFor({ timeout: 3000 }).then(() => true, () => false);
    if (hay) return;
  }
  throw new Error('No hay turnos en los próximos días');
}

test.describe('Paciente', () => {
  test('reserva online y después gestiona el turno con su link', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.dev summary em')).toHaveText('API en vivo');

    const reserva = page.locator('#turnos');
    await reserva.scrollIntoViewIfNeeded();
    await reserva.getByRole('button', { name: /^Consulta/ }).click();
    await reserva.locator('.slot').first().click();
    await expect(page.locator('#hold')).toHaveClass(/on/);

    await page.getByLabel('Nombre y apellido').fill('Prueba Ede');
    await page.getByLabel('DNI').fill('42123456');
    await page.getByLabel('WhatsApp').fill('381 555 4242');
    await page.getByRole('button', { name: 'Confirmar turno' }).click();
    await expect(page.getByRole('heading', { name: 'Listo, te esperamos.' })).toBeVisible();

    // El link de gestión (el mismo que va en el WhatsApp)
    await page.getByRole('link', { name: 'Guardá este link' }).click();
    await expect(page.getByRole('heading', { name: /Hola, Prueba/ })).toBeVisible();
    await page.getByRole('button', { name: 'Confirmo que voy' }).click();
    await expect(page.getByText('Tu turno quedó confirmado')).toBeVisible();
    await expect(page.locator('#estado')).toHaveText('Confirmado');

    await page.getByRole('button', { name: 'Cambiar día u horario' }).click();
    await page.locator('.slot').nth(1).click();
    await page.getByRole('button', { name: 'Cambiar a este horario' }).click();
    await expect(page.getByText('Listo, cambiamos tu turno')).toBeVisible();
    await expect(page.locator('#estado')).toHaveText('Reservado');

    await page.getByRole('button', { name: 'Cancelar el turno' }).click();
    await page.getByRole('button', { name: 'Sí, cancelar' }).click();
    await expect(page.getByRole('heading', { name: 'Turno cancelado' })).toBeVisible();
  });

  test('los estudios y los datos de contacto salen de la configuración', async ({ page }) => {
    const tipos = await (await page.request.get('/api/public/tipos')).json();
    await page.goto('/');
    await expect(page.locator('#svcList .svc')).toHaveCount(tipos.length);
    await expect(page.locator('#svcList')).toContainText('Topografía corneal');
    const c = await (await page.request.get('/api/public/consultorio')).json();
    await expect(page.locator('.info')).toContainText(c.telefono);
  });
});

test.describe('Secretaría', () => {
  test('cambia a vista semanal y ve la agenda de un profesional', async ({ page }) => {
    await entrar(page, 'Secretaría');
    await page.getByRole('button', { name: 'Semana', exact: true }).click();
    await expect(page.getByText(/^Semana del/)).toBeVisible();
    await expect(page.locator('.agenda .colhead')).toHaveCount(6); // lunes a sábado
    await expect(page.locator('.tb').first()).toBeVisible();
    await page.getByRole('button', { name: 'Día', exact: true }).click();
  });

  test('arrastrar un turno pide confirmación antes de moverlo', async ({ page }) => {
    await entrar(page, 'Secretaría');
    await irADiaConTurnos(page);
    const turno = page.locator(LIBRE).first();
    const caja = (await turno.boundingBox())!;
    // Lo soltamos 40 minutos más abajo en la misma columna
    await turno.dragTo(page.locator('.agenda .col').first(), {
      sourcePosition: { x: 10, y: 5 },
      targetPosition: { x: 20, y: caja.y - (await page.locator('.agenda .col').first().boundingBox())!.y + 5 + 40 * 2.1 },
    });
    const modal = page.getByRole('dialog', { name: 'Mover turno' });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Antes');
    await modal.getByRole('button', { name: 'Cancelar' }).click();
    await expect(modal).toBeHidden();
  });

  test('pone a un paciente en lista de espera y cobra el turno con el precio del estudio', async ({ page }) => {
    await entrar(page, 'Secretaría');
    // Lista de espera vacía, así el paciente que elijamos no está anotado de antes
    for (const e of await (await page.request.get('/api/lista-espera')).json()) await page.request.post(`/api/lista-espera/${e.id}/resolver`);
    await irADiaConTurnos(page);
    await page.locator(LIBRE).first().click();
    const detalle = page.getByRole('dialog');
    const paciente = (await detalle.getByRole('heading', { level: 2 }).textContent())!.trim();

    await detalle.getByRole('button', { name: 'Quiere venir antes' }).click();
    await expect(detalle.getByText('Quedó en la lista de espera')).toBeVisible();

    await detalle.getByRole('button', { name: 'Cobrar' }).click();
    await expect(page.getByRole('heading', { name: 'Caja del día' })).toBeVisible();
    await expect(page.getByLabel('Paciente')).toHaveValue(paciente);
    const monto = await page.getByLabel('Monto').inputValue();
    expect(Number(monto)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Cobrar', exact: true }).click();
    await expect(page.locator('.table')).toContainText(paciente);

    await page.getByRole('button', { name: 'Lista de espera' }).click();
    await expect(page.getByRole('heading', { name: 'Lista de espera' })).toBeVisible();
    await expect(page.locator('.table')).toContainText(paciente);
  });
});

test.describe('Médica', () => {
  test('carga una consulta y emite una receta de medicación', async ({ page, context }) => {
    await entrar(page, 'Médica');
    await page.getByRole('button', { name: 'Pacientes' }).click();
    await page.locator('tr.click').first().click();
    await page.getByRole('button', { name: 'Nueva consulta' }).click();
    await page.getByLabel('Diagnóstico').fill('Glaucoma de ángulo abierto');
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(page.getByText('Guardado.')).toBeVisible();

    await page.getByRole('button', { name: 'Nueva receta' }).click();
    const modal = page.getByRole('dialog', { name: 'Nueva receta' });
    await modal.getByRole('button', { name: 'Medicación' }).click();
    await modal.getByLabel('Medicación e indicaciones').fill('Latanoprost 0,005 % · 1 gota por noche');
    const [receta] = await Promise.all([context.waitForEvent('page'), modal.getByRole('button', { name: 'Emitir e imprimir' }).click()]);
    await receta.waitForLoadState();
    await expect(receta.locator('body')).toContainText('Latanoprost');
    await expect(receta.locator('body')).toContainText('Médica oftalmóloga');
    await expect(page.getByRole('link', { name: /Medicación/ })).toBeVisible();
  });
});

test.describe('Administración', () => {
  test('crea un estudio y aparece en la web', async ({ page }) => {
    await entrar(page, 'Administración');
    await page.getByRole('button', { name: 'Configuración' }).click();
    await page.getByRole('tab', { name: 'Estudios' }).click();
    await page.getByRole('button', { name: 'Nuevo estudio' }).click();
    const modal = page.getByRole('dialog', { name: 'Nuevo estudio' });
    await modal.getByLabel('Nombre').fill('Retinografía');
    await modal.getByLabel('Duración (minutos)').fill('15');
    await modal.getByLabel('Atiende (reserva online)').selectOption({ label: 'Téc. Martín Díaz' });
    await modal.getByLabel('Descripción para el paciente').fill('Foto del fondo de ojo.');
    await modal.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.locator('.table')).toContainText('Retinografía');

    await page.goto('/');
    await expect(page.locator('#svcList')).toContainText('Retinografía');
    await expect(page.locator('#svcList')).toContainText('Foto del fondo de ojo.');
  });

  test('cambia el teléfono del consultorio y la web lo muestra', async ({ page }) => {
    await entrar(page, 'Administración');
    await page.getByRole('button', { name: 'Configuración' }).click();
    await page.getByLabel('Teléfono').fill('(0381) 123-4567');
    await page.getByRole('button', { name: 'Guardar' }).click();
    await expect(page.getByText('Guardado.')).toBeVisible();
    await page.goto('/');
    await expect(page.locator('.info')).toContainText('(0381) 123-4567');
  });

  test('descarga el reporte por obra social', async ({ page }) => {
    await entrar(page, 'Administración');
    await page.getByRole('button', { name: 'Reportes' }).click();
    await expect(page.getByRole('heading', { name: 'Reportes' })).toBeVisible();
    const [descarga] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Descargar CSV' }).click()]);
    expect(descarga.suggestedFilename()).toMatch(/^prestaciones_.*\.csv$/);
  });
});
