import { useEffect, useState } from 'react';
import { Modal } from './ui';

/** Evento de Chrome, Edge y Android para ofrecer la instalación (no está en los tipos del DOM). */
interface PedidoInstalacion extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

const yaInstalada = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const esSafariMac = () => /safari/i.test(navigator.userAgent) && !/chrome|chromium|crios|edg|firefox|fxios|opr/i.test(navigator.userAgent) && !esIOS();

// El navegador puede avisar antes de que se dibuje el botón: lo guardamos apenas llega
let pedidoGuardado: PedidoInstalacion | null = null;
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  pedidoGuardado = e as PedidoInstalacion;
  dispatchEvent(new Event('panel:instalable'));
});

/**
 * "Instalar app": deja el panel como un ícono en el escritorio o en el celular,
 * que abre directo en su propia ventana. Donde el navegador no tiene instalador
 * (iPhone, Safari en Mac) muestra los pasos.
 */
export function InstalarApp({ className = 'btn ghost sm' }: { className?: string }) {
  const [pedido, setPedido] = useState(pedidoGuardado);
  const [instalada, setInstalada] = useState(yaInstalada);
  const [ayuda, setAyuda] = useState<'ios' | 'mac' | null>(null);

  useEffect(() => {
    const disponible = () => setPedido(pedidoGuardado);
    const lista = () => { setInstalada(true); setPedido(null); };
    addEventListener('panel:instalable', disponible);
    addEventListener('appinstalled', lista);
    return () => { removeEventListener('panel:instalable', disponible); removeEventListener('appinstalled', lista); };
  }, []);

  const manual = esIOS() ? 'ios' : esSafariMac() ? 'mac' : null;
  if (instalada || (!pedido && !manual)) return null;

  const instalar = async () => {
    if (!pedido) { setAyuda(manual); return; }
    await pedido.prompt();
    const { outcome } = await pedido.userChoice;
    pedidoGuardado = null; setPedido(null);
    if (outcome === 'accepted') setInstalada(true);
  };

  return (
    <>
      <button type="button" className={className} onClick={instalar}>Instalar app</button>
      {ayuda && (
        <Modal titulo="Instalar el panel" onClose={() => setAyuda(null)}>
          <div style={{ display: 'grid', gap: 14 }}>
            {ayuda === 'ios' ? (
              <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 8 }}>
                <li>Tocá el botón <b>Compartir</b> de Safari (el cuadrado con la flecha hacia arriba).</li>
                <li>Elegí <b>Agregar a inicio</b>.</li>
                <li>Tocá <b>Agregar</b>. Queda el ícono <b>Consultorio</b> en la pantalla de inicio.</li>
              </ol>
            ) : (
              <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 8 }}>
                <li>En la barra de menú de Safari, abrí <b>Archivo</b>.</li>
                <li>Elegí <b>Agregar al Dock</b> y confirmá.</li>
                <li>El panel queda en el Dock y se abre en su propia ventana.</li>
              </ol>
            )}
            <p className="muted" style={{ fontSize: 13 }}>Entrás una vez con tu usuario y la sesión queda abierta 7 días en ese dispositivo.</p>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={() => setAyuda(null)}>Entendido</button></div>
          </div>
        </Modal>
      )}
    </>
  );
}
