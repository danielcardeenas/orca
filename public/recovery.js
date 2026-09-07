/* Unbundled on purpose. No imports from the app, Vite, or its styles.
 * Wire contract: src/shared/protocol.ts v1; same auth/ceo:say as HubLink.
 * Delivery may be uncertain: never automatically send or replay a request.
 */
(() => {
  const standalone = document.currentScript.hasAttribute('data-recovery');
  const read = (key) => { try { return sessionStorage.getItem(key) || ''; } catch { return ''; } };
  const save = (key, value) => { try { sessionStorage.setItem(key, value); } catch { /* private mode */ } };
  let diagnostic = standalone ? read('orca.recovery.error') : '';
  let panel, root, socket, heartbeat, retry, pending, lastOverlay;
  let ready = false, attempt = 0;
  let uploading = false;
  const attachments = [];
  const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  const messages = new Map();
  const $ = (selector) => root.querySelector(selector);
  const status = (text) => { $('[role="status"]').textContent = text; };
  const controls = () => {
    $('button[type="submit"]').disabled = !ready || !!pending || uploading;
    $('#attach').disabled = !!pending || uploading;
    for (const b of $('#attachments').querySelectorAll('button')) b.disabled = !!pending || uploading;
    $('textarea').required = attachments.length === 0;
  };
  function renderAttachments() {
    $('#attachments').replaceChildren(...attachments.map((item) => {
      const row = document.createElement('div');
      const img = document.createElement('img');
      img.src = item.preview;
      img.alt = item.file.name;
      const name = document.createElement('span');
      name.textContent = item.file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', 'Remove ' + item.file.name);
      remove.onclick = () => {
        attachments.splice(attachments.indexOf(item), 1);
        URL.revokeObjectURL(item.preview);
        renderAttachments();
      };
      row.append(img, name, remove);
      return row;
    }));
    controls();
  }
  function addImages(files) {
    if (pending || uploading) { status('Wait for the current send before adding images.'); return; }
    const errors = [];
    for (const file of files) {
      if (!imageTypes.includes(file.type)) { errors.push(`${file.name}: use PNG, JPEG, WebP or GIF.`); continue; }
      if (!file.size || file.size > 8 * 1024 * 1024) { errors.push(`${file.name}: images must be between 1 byte and 8 MB.`); continue; }
      if (attachments.length >= 4) { errors.push('Attach up to 4 images per message.'); break; }
      attachments.push({ file, preview: URL.createObjectURL(file), path: null });
    }
    $('main').hidden = false;
    $('#fold').textContent = 'Minimize';
    $('#fold').setAttribute('aria-expanded', 'true');
    renderAttachments();
    status(errors.length ? errors.join(' ') : `${attachments.length} IMAGE(S) ATTACHED · Uploads when you send.`);
  }
  function authToken() {
    const url = new URL(location.href);
    let token = url.searchParams.get('k') || '';
    try {
      if (token) localStorage.setItem('orca.token', token);
      else token = localStorage.getItem('orca.token') || '';
    } catch { /* URL auth still works without storage. */ }
    if (url.searchParams.has('k')) {
      url.searchParams.delete('k');
      history.replaceState(null, '', url);
    }
    return token;
  }
  let token;
  function renderMessage(message) {
    if (!message || typeof message.text !== 'string') return;
    messages.set(message.id, message);
    while (messages.size > 80) messages.delete(messages.keys().next().value);
    const log = $('[role="log"]');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren(...Array.from(messages.values(), (m) => {
      const row = document.createElement('p');
      const label = document.createElement('b');
      label.textContent = m.role === 'human' ? 'YOU' : m.role === 'system' ? 'SYSTEM' : 'CAPCOM';
      row.append(label, document.createTextNode('\n' + m.text));
      return row;
    }));
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  function settle(text, success = false) {
    if (pending) {
      clearTimeout(pending.timer);
      if (success) {
        for (const item of attachments.splice(0)) URL.revokeObjectURL(item.preview);
        renderAttachments();
      }
      if (success && $('textarea').value === pending.draft) {
        $('textarea').value = '';
        save('orca.recovery.draft', '');
      }
      pending = null;
    }
    status(text);
    controls();
  }
  function connect() {
    clearTimeout(retry);
    status('CONNECTING TO HUB…');
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/console`);
    socket.onopen = () => {
      socket.send(JSON.stringify({ t: 'hello', v: 1, token }));
      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'beat' }));
      }, 10000);
    };
    socket.onmessage = (event) => {
      let f;
      try { f = JSON.parse(event.data); } catch { return; }
      if (f.t === 'world') {
        ready = true;
        attempt = 0;
        if (!pending) status('HUB CONNECTED · CAPCOM CHANNEL');
        controls();
        for (const m of (f.state?.ceo?.messages || []).slice(-80)) renderMessage(m);
      } else if (f.t === 'ceo:message') renderMessage(f.message);
      else if (f.t === 'ceo:delta') {
        const m = messages.get(f.id);
        renderMessage({ ...(m || { id: f.id, role: 'ceo' }), text: (m?.text || '') + f.text });
      } else if (f.t === 'ack' && f.cmdId === pending?.id) {
        const delivery = f.data?.delivery;
        settle(f.ok
          ? (delivery === 'queued' ? 'QUEUED · CAPCOM IS RESTARTING' : delivery === 'accepted' ? 'ACCEPTED BY HUB · DELIVERY TO CAPCOM NOT CONFIRMED' : 'DELIVERED · WAITING FOR CAPCOM')
          : `SEND FAILED · ${f.detail || 'Delivery not confirmed'}`, f.ok);
      } else if (f.t === 'error') status(`HUB ERROR · ${f.message}`);
    };
    socket.onclose = (event) => {
      ready = false;
      clearInterval(heartbeat);
      const uncertain = pending ? ' Delivery unconfirmed; draft retained. Check the conversation before resending.' : '';
      const denied = event.code === 4001 || event.code === 4002;
      settle((denied
        ? 'CONNECTION REJECTED · Open ORCA with a valid access link; check protocol version.'
        : 'HUB OFFLINE · Reconnecting. If it stays offline, restart ORCA from your terminal.') + uncertain);
      if (!denied) retry = setTimeout(connect, Math.min(20000, 1000 * 2 ** Math.min(attempt++, 5)));
    };
    socket.onerror = () => {}; // onclose reports the failure.
  }
  function show(detail) {
    if (detail) {
      diagnostic = String(detail).slice(0, 16000);
      save('orca.recovery.error', diagnostic);
    }
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => show(), { once: true });
      return;
    }
    if (!panel) {
      token = authToken();
      panel = document.createElement('orca-recovery');
      root = panel.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          @font-face { font-family:RecoveryMono; src:url('/fonts/geist-mono.woff2') format('woff2'); font-display:swap; }
          :host { all:initial; position:fixed; right:16px; bottom:16px; z-index:2147483647; width:min(520px, calc(100vw - 32px)); color:#e9e6ef; font:14px/1.5 RecoveryMono,monospace; color-scheme:dark; }
          * { box-sizing:border-box; cursor:auto; } [hidden] { display:none!important; }
          section { background:#121116; border:1px solid #706879; max-height:calc(100dvh - 32px); overflow:auto; }
          header { padding:12px 16px; background:#141318; display:flex; align-items:center; justify-content:space-between; gap:12px; }
          h2 { font:inherit; font-weight:bold; color:#c0f94a; margin:0; }
          main { padding:16px; } p { margin:0 0 12px; overflow-wrap:anywhere; }
          [role=status] { color:#f5a524; font-size:12px; margin:12px 0; }
          [role=log] { max-height:24dvh; overflow:auto; border-block:1px solid #393440; margin:16px 0; }
          [role=log] p { white-space:pre-wrap; padding-top:12px; } b { color:#c0f94a; font-size:12px; }
          pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:16dvh; overflow:auto; font:12px/1.5 monospace; }
          label { display:block; margin-bottom:8px; } textarea { width:100%; min-height:88px; resize:vertical; background:#17161c; border:1px solid #706879; color:inherit; padding:10px; font:16px/1.5 RecoveryMono,monospace; }
          button { font:inherit; min-height:40px; padding:8px 12px; border:1px solid #706879; background:#17161c; color:inherit; cursor:pointer; }
          button:hover { border-color:#c0f94a; } button:disabled { opacity:.5; cursor:default; }
          button[type=submit] { background:#c0f94a; color:#0b0a0d; border-color:#c0f94a; }
          :focus-visible { outline:2px solid #c0f94a; outline-offset:3px; } ::selection { background:#c0f94a; color:#0b0a0d; }
          nav { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; } summary { cursor:pointer; }
          section.dragging { outline:2px solid #c0f94a; outline-offset:-3px; }
          #attachments > div { display:flex; align-items:center; gap:10px; margin-top:10px; }
          #attachments img { width:56px; height:56px; object-fit:contain; background:#17161c; }
          #attachments span { flex:1; min-width:0; overflow-wrap:anywhere; font-size:12px; }
          .hint { font-size:12px; margin:8px 0; color:#b9b2c2; }
        </style>
        <section aria-label="CAPCOM recovery">
          <header><h2>CAPCOM · RECOVERY</h2><button id="fold" aria-expanded="true">Minimize</button></header>
          <main>
            <p>${standalone ? 'Independent access to CAPCOM while the console is unavailable.' : 'The console hit an error. Contact CAPCOM through this independent channel.'}</p>
            <details><summary>Error details · included with your message</summary><pre></pre></details>
            <div role="status" aria-live="polite"></div>
            <div role="log" aria-label="CAPCOM conversation" aria-live="polite"></div>
            <form><label for="message">Message CAPCOM</label><textarea id="message" maxlength="12000" required placeholder="Describe what to fix…"></textarea>
            <p class="hint">Drop images here · up to 4, 8 MB each. PNG, JPEG, WebP or GIF.</p>
            <input id="images" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
            <button type="button" id="attach">Attach images</button>
            <div id="attachments" aria-label="Attached images"></div>
            <nav><button type="submit" disabled>Send to CAPCOM</button><button type="button" id="reload">Reload console</button></nav></form>
          </main>
        </section>`;
      // The app's shortcuts must not intercept the emergency conversation.
      for (const type of ['keydown', 'keyup', 'keypress']) panel.addEventListener(type, (e) => e.stopPropagation());
      document.body.append(panel);
      $('#attach').onclick = () => $('#images').click();
      $('#images').onchange = () => { addImages($('#images').files); $('#images').value = ''; };
      panel.addEventListener('dragover', (e) => {
        if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        $('section').classList.add('dragging');
      });
      panel.addEventListener('dragleave', (e) => {
        if (!panel.contains(e.relatedTarget)) $('section').classList.remove('dragging');
      });
      panel.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        $('section').classList.remove('dragging');
        addImages(e.dataTransfer?.files || []);
      });
      $('textarea').value = read('orca.recovery.draft');
      $('textarea').oninput = () => save('orca.recovery.draft', $('textarea').value);
      $('#fold').onclick = () => {
        const hidden = !$('main').hidden;
        $('main').hidden = hidden;
        $('#fold').textContent = hidden ? 'Open' : 'Minimize';
        $('#fold').setAttribute('aria-expanded', String(!hidden));
      };
      $('#reload').onclick = () => {
        if ((pending || uploading || attachments.length) && !confirm('Reload? Unsent image attachments will be lost; any pending delivery remains unconfirmed.')) return;
        if (standalone) location.assign('/'); else location.reload();
      };
      $('form').onsubmit = async (event) => {
        event.preventDefault();
        const draft = $('textarea').value;
        if (!ready || pending || uploading || (!draft.trim() && !attachments.length)) return;
        uploading = true;
        controls();
        try {
          for (const [index, item] of attachments.entries()) {
            if (item.path) continue;
            status(`UPLOADING IMAGE ${index + 1} OF ${attachments.length}…`);
            const response = await fetch('/api/recovery-images', {
              method: 'POST', body: item.file,
              headers: { 'content-type': item.file.type, ...(token ? { authorization: 'Bearer ' + token } : {}) },
              signal: AbortSignal.timeout(30000),
            });
            const result = await response.json().catch(() => null);
            if (!response.ok || typeof result?.path !== 'string') throw new Error(result?.error || 'Image upload unavailable. Restart the ORCA hub to load the upload endpoint.');
            item.path = result.path;
          }
          if (!ready) throw new Error('Hub disconnected. Images and draft retained; reconnect before sending.');
        } catch (error) {
          status('SEND FAILED · ' + (error instanceof Error ? error.message : String(error)));
          return;
        } finally { uploading = false; controls(); }
        const id = 'recovery_' + crypto.randomUUID();
        const imageContext = attachments.length ? '\n\n[Attached images · saved on the ORCA hub machine. Open these image files to inspect them.]\n' + attachments.map((item) => item.path).join('\n') : '';
        const text = (draft.trim() || 'Please inspect the attached images.') + imageContext + (diagnostic ? '\n\n[ORCA console recovery · browser error]\n' + diagnostic : '');
        pending = { id, draft, timer: setTimeout(() => settle('DELIVERY UNCONFIRMED · Draft retained. Check the conversation before sending again.'), 35000) };
        controls();
        status('SENDING…');
        try { socket.send(JSON.stringify({ t: 'ceo:say', id, text })); }
        catch { settle('SEND FAILED · Connection lost. Draft retained.'); }
      };
      connect();
    }
    $('pre').textContent = diagnostic || 'No browser error captured. Describe the problem in your message.';
  }
  window.addEventListener('error', (e) => {
    if (e.target instanceof HTMLScriptElement) show('Failed to load script: ' + e.target.getAttribute('src'));
    else if (e.message) show(e.error?.stack || `${e.message}\n${e.filename}:${e.lineno}:${e.colno}`);
  }, true);
  window.addEventListener('unhandledrejection', (e) => show(e.reason?.stack || String(e.reason)));
  // Observe Vite's independent error overlay, without importing /@vite/client.
  new MutationObserver(() => {
    const overlay = document.querySelector('vite-error-overlay');
    if (!overlay || overlay === lastOverlay) return;
    lastOverlay = overlay;
    const parts = ['.message-body', '.file', '.frame', '.stack'].map((s) => overlay.shadowRoot?.querySelector(s)?.textContent || '');
    show(parts.join('\n').trim() || 'Vite could not compile the console.');
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (standalone) show();
})();
