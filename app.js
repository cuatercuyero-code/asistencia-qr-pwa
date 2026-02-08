const LS_CFG = 'aqr_cfg_v1';
const LS_Q   = 'aqr_queue_v1';

let html5Qr = null;

// Scanner persistente (se cierra SOLO con botón "Cerrar")
let scanBusy = false;           // evita llamadas concurrentes
let scanCooldownUntil = 0;      // tiempo (ms) hasta permitir otro registro
let lastTokenSeen = '';         // evita repetir el mismo QR mientras se está viendo
const SCAN_COOLDOWN_MS = 1500;  // ajusta: 1000–2500 según tu cámara

function loadCfg(){ try { return JSON.parse(localStorage.getItem(LS_CFG) || '{}'); } catch { return {}; } }
function saveCfg(cfg){ localStorage.setItem(LS_CFG, JSON.stringify(cfg)); }

function loadQ(){ try { return JSON.parse(localStorage.getItem(LS_Q) || '[]'); } catch { return []; } }
function saveQ(q){ localStorage.setItem(LS_Q, JSON.stringify(q)); updateQueueInfo(); }

function deviceLabel(){ return `PWA:${navigator.userAgent.slice(0,60)}`; }

function setMsg(s){ document.getElementById('msg').textContent = s || ''; }
function setManualMsg(s){ document.getElementById('manualMsg').textContent = s || ''; }

function show(id, v){ document.getElementById(id).style.display = v ? '' : 'none'; }

function netUI(){
  document.getElementById('netStatus').textContent = navigator.onLine ? 'Online' : 'Offline';
}

async function api(action, body){
  const cfg = loadCfg();
  if (!cfg.webapp || !cfg.pin) throw new Error('Configura WEBAPP_URL y PIN.');
  const payload = { action, pin: cfg.pin, ...body };
  const r = await fetch(cfg.webapp, { method:'POST', body: JSON.stringify(payload) });
  return await r.json();
}

function enqueue(item){
  const q = loadQ();
  q.push(item);
  saveQ(q);
}

function updateQueueInfo(){
  const q = loadQ();
  document.getElementById('queueInfo').textContent = `${q.length} pendientes`;
}

async function syncQueue(){
  const q = loadQ();
  if (!q.length) { setMsg('Sin pendientes.'); return; }

  let ok = 0;
  const rest = [];
  for (const it of q){
    try{
      const res = await api(it.action, it.data);
      if (!res.ok) throw new Error(res.msg || res.error || 'Error');
      ok++;
    }catch(e){
      rest.push(it);
    }
  }
  saveQ(rest);
  setMsg(`Sincronizados: ${ok}. Pendientes: ${rest.length}.`);
}

async function loadGroups(){
  const sel = document.getElementById('grupo');
  sel.innerHTML = '';
  const res = await api('listGroups', {});
  if (!res.ok) throw new Error(res.msg || res.error || 'Error');
  (res.groups||[]).forEach(g=>{
    const opt = document.createElement('option');
    opt.value = g.grupoId;
    opt.textContent = `${g.grupoId} – ${g.materia || ''}`;
    sel.appendChild(opt);
  });
}

// --------- ESCÁNER: PERSISTENTE (no se apaga tras registrar) ---------
async function startScanner() {
  if (!window.Html5Qrcode) throw new Error('No se cargó html5-qrcode.');

  show('scanCard', true);
  setMsg('');

  // Si ya está corriendo, no reiniciar
  if (html5Qr) return;

  // Reset estados de sesión
  scanBusy = false;
  scanCooldownUntil = 0;
  lastTokenSeen = '';

  html5Qr = new Html5Qrcode('reader');

  await html5Qr.start(
    { facingMode: 'environment' },
    { fps: 8, qrbox: { width: 240, height: 240 } },
    async (decodedText) => {
      const now = Date.now();

      // Cooldown: ignorar todo mientras dura
      if (now < scanCooldownUntil) return;

      // Evitar concurrencia si el callback se dispara en paralelo
      if (scanBusy) return;
      scanBusy = true;

      try {
        let token = decodedText;

        // Si viene como URL ...?t=TOKEN, extraer TOKEN
        if (decodedText.includes('t=')) {
          try { token = new URL(decodedText).searchParams.get('t') || decodedText; } catch {}
        }

        // Si la cámara sigue viendo el mismo QR, no repetir
        if (token === lastTokenSeen) {
          scanBusy = false;
          return;
        }
        lastTokenSeen = token;

        const data = {
          token,
          device: deviceLabel(),
          offlineId: crypto.randomUUID(), // por intento; servidor deduplica por día
          notes: ''
        };

        if (!navigator.onLine) {
          enqueue({ action:'scan', data });
          setMsg('Registrado en cola offline (QR).');
        } else {
          const res = await api('scan', data);

          if (!res.ok) {
            enqueue({ action:'scan', data });
            throw new Error(res.msg || res.error || 'Error. Se guardó offline.');
          }

          if (res.result?.deduped) setMsg('Ya estaba registrado (deduplicado).');
          else setMsg(`OK: ${res.result?.alumno || ''}`);
        }

        // Cooldown para evitar múltiples registros por ráfaga
        scanCooldownUntil = Date.now() + SCAN_COOLDOWN_MS;

      } catch (e) {
        setMsg(String(e.message || e));
        // Cooldown corto en error para evitar spam
        scanCooldownUntil = Date.now() + 800;
      } finally {
        scanBusy = false;
      }
    },
    () => {} // onScanFailure: ignorar
  );
}

async function stopScanner(){
  try{ if (html5Qr) await html5Qr.stop(); }catch{}
  html5Qr = null;

  scanBusy = false;
  scanCooldownUntil = 0;
  lastTokenSeen = '';

  show('scanCard', false);
}

// --------- MANUAL ---------
async function registerManual(){
  const grupoId = document.getElementById('grupo').value;
  const boleta  = document.getElementById('boleta').value.trim();
  const notes   = document.getElementById('notes').value.trim();
  if (!grupoId || !boleta) { setManualMsg('Grupo y boleta requeridos.'); return; }

  const offlineId = crypto.randomUUID();
  const data = { grupoId, boleta, device: deviceLabel(), offlineId, notes };

  if (!navigator.onLine){
    enqueue({ action:'manual', data });
    setManualMsg('Registrado en cola offline (manual).');
    return;
  }
  const res = await api('manual', data);
  if (!res.ok){
    enqueue({ action:'manual', data });
    throw new Error(res.msg || res.error || 'Error. Se guardó offline.');
  }
  if (res.result?.deduped) setManualMsg('Ya estaba registrado (deduplicado).');
  else setManualMsg(`OK: ${res.result?.alumno || ''}`);
}

// --------- INIT ---------
function init(){
  netUI();
  window.addEventListener('online', ()=>{ netUI(); syncQueue().catch(()=>{}); });
  window.addEventListener('offline', netUI);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js');

  const cfg = loadCfg();
  document.getElementById('pin').value = cfg.pin || '';
  document.getElementById('webapp').value = cfg.webapp || '';

  document.getElementById('btnSaveCfg').onclick = ()=>{
    const pin = document.getElementById('pin').value.trim();
    const webapp = document.getElementById('webapp').value.trim();
    saveCfg({ pin, webapp });
    setMsg('Configuración guardada.');
  };

  document.getElementById('btnScan').onclick = ()=> startScanner().catch(e=>setMsg(String(e.message||e)));
  document.getElementById('btnStop').onclick = ()=> stopScanner();

  document.getElementById('btnManual').onclick = async ()=>{
    show('manualCard', true);
    setManualMsg('');
    try{ await loadGroups(); }catch(e){ setManualMsg(String(e.message||e)); }
  };
  document.getElementById('btnManualClose').onclick = ()=> show('manualCard', false);
  document.getElementById('btnManualSend').onclick = ()=> registerManual().catch(e=>setManualMsg(String(e.message||e)));

  document.getElementById('btnSync').onclick = ()=> syncQueue().catch(e=>setMsg(String(e.message||e)));

  updateQueueInfo();
}
init();
