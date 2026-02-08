const LS_CFG = 'aqr_cfg_v1';
const LS_Q   = 'aqr_queue_v1';

let html5Qr;

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

async function registerScanToken(token){
  const offlineId = crypto.randomUUID();
  const data = { token, device: deviceLabel(), offlineId, notes:'' };

  if (!navigator.onLine){
    enqueue({ action:'scan', data });
    setMsg('Registrado en cola offline (QR).');
    return;
  }
  const res = await api('scan', data);
  if (!res.ok){
    enqueue({ action:'scan', data });
    throw new Error(res.msg || res.error || 'Error. Se guardó offline.');
  }
  setMsg(`OK: ${res.result?.alumno || ''}`);
}

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
  setManualMsg(`OK: ${res.result?.alumno || ''}`);
}

async function startScanner(){
  show('scanCard', true);
  setMsg('');
  if (!window.Html5Qrcode) throw new Error('No se cargó html5-qrcode.');
  html5Qr = new Html5Qrcode('reader');

  await html5Qr.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 240, height: 240 } },
    async (decodedText) => {
      try{
        let token = decodedText;
        if (decodedText.includes('t=')) {
          try { token = new URL(decodedText).searchParams.get('t') || decodedText; } catch {}
        }
        await registerScanToken(token);
        await html5Qr.stop();
        show('scanCard', false);
      }catch(e){
        setMsg(String(e.message || e));
      }
    },
    () => {}
  );
}

async function stopScanner(){
  try{ if (html5Qr) await html5Qr.stop(); }catch{}
  show('scanCard', false);
}

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
