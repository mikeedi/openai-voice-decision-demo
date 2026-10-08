const $ = (selector) => document.querySelector(selector);
const optionsElement = $('#options');
let options = [], history = [], dismissed = [], result = null;
let revision = 0, resultRevision = -1, generation = 0, configured = false, chosen = null, final = false;
let evaluationTimer, evaluation, evaluationAbort, pending = false, finalizing = false, typed = false, voice = null;
const emptyOptions = () => [1, 2].map((n) => ({ id: `option_${n}`, label: '', excluded: false }));
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const topic = () => $('#topic').value.trim();
const context = () => $('#context').value.trim();
const snapshot = () => ({ topic: topic(), options: options.filter((o) => o.label.trim()).map((o) => ({ ...o, label: o.label.trim() })), context: context(), history: history.slice(-20).map(({ role, text }) => ({ role, text: text.slice(-1000) })), dismissed });

function status(text, error = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', error);
}

function controls() {
  const valid = Boolean(topic()) && options.filter((o) => o.label.trim()).length >= 2;
  $('#talk').disabled = !configured || (!voice && !valid) || voice?.closing;
  $('#talk').classList.toggle('live', Boolean(voice));
  $('#talk span').textContent = voice?.closing ? 'Ending conversation…' : voice?.started ? 'Stop' : voice ? 'Cancel connection' : 'Talk';
  $('#finalize').disabled = !configured || !valid || voice?.closing || final || finalizing;
  $('#finalize').textContent = finalizing ? 'Summing up…' : final ? 'Summary ready' : 'Wrap up ↗';
  $('#add').disabled = options.length >= 8;
  $('#example').hidden = Boolean(voice);
}

function renderOptions() {
  optionsElement.innerHTML = options.map((o, i) => `<div class="option" data-id="${o.id}">
    <div class="option-top"><label class="number" for="${o.id}">${String(i + 1).padStart(2, '0')}</label><input id="${o.id}" aria-label="Option ${i + 1}" value="${escape(o.label)}" maxlength="160" placeholder="${i ? 'Or…' : 'One option…'}"><button class="icon exclude" data-action="exclude" aria-label="Exclude option ${i + 1}" aria-pressed="${o.excluded}" title="Exclude / restore">−</button><button class="icon" data-action="remove" aria-label="Remove option ${i + 1}" title="Remove">×</button></div>
    <div class="score" hidden><div class="score-top"><span class="share"></span><div class="track"><span class="fill"></span></div><button class="choose" data-action="choose">Choose</button></div><p class="reason"></p></div></div>`).join('');
  renderResult();
}

function renderResult() {
  for (const row of optionsElement.children) {
    const option = options.find((o) => o.id === row.dataset.id);
    if (!option) continue;
    const score = result?.options.find((o) => o.id === option.id);
    row.classList.toggle('excluded', option.excluded || Boolean(score?.excluded));
    row.classList.toggle('chosen', chosen === option.id);
    row.querySelector('.exclude').setAttribute('aria-pressed', option.excluded);
    row.querySelector('.score').hidden = !score || !option.label.trim() || (!result.ready && !score.reason);
    row.querySelector('.share').textContent = score?.share == null ? '—' : `${score.share}%`;
    row.querySelector('.fill').style.transform = `scaleX(${(score?.share || 0) / 100})`;
    row.querySelector('.reason').textContent = score?.excluded ? `Excluded: ${score.reason}` : score?.reason || '';
    row.querySelector('.choose').disabled = !result?.ready || option.excluded || Boolean(score?.excluded);
    row.querySelector('.choose').textContent = chosen === option.id ? 'Chosen' : 'Choose';
    row.querySelector('.choose').setAttribute('aria-pressed', chosen === option.id);
    row.querySelector('[data-action="remove"]').disabled = options.length <= 2;
  }
  $('#question').hidden = !result?.question;
  $('#question').textContent = result?.question || '';
  $('#suggestion').hidden = !result?.suggestion || options.length >= 8;
  if (result?.suggestion) {
    $('#suggestion strong').textContent = result.suggestion.label;
    $('.suggestion-reason').textContent = result.suggestion.reason;
  }
  const leaders = result?.ready ? result.options.filter((o) => !o.excluded).sort((a, b) => b.share - a.share) : [];
  const selected = chosen && options.find((o) => o.id === chosen);
  $('#result').hidden = !selected && !(final && leaders.length);
  if (selected) $('#result').innerHTML = `<p class="eyebrow">YOUR CHOICE</p><strong>${escape(selected.label)}</strong><p>You decide. The scores help explain why.</p>`;
  else if (final && leaders.length) {
    const close = leaders.length > 1 && leaders[0].share - leaders[1].share <= 5;
    $('#result').innerHTML = `<p class="eyebrow">${close ? 'CLOSE CALL' : 'BEST FIT FOR NOW'}</p><strong>${escape(close ? `${leaders[0].label} or ${leaders[1].label}` : leaders[0].label)}</strong><p>${escape(close ? 'The scores are close. Go with the option that feels right to you.' : leaders[0].reason)}</p>`;
  }
  controls();
}

function changed() {
  revision++;
  result = null; chosen = null; final = false;
  renderResult();
  clearTimeout(evaluationTimer);
  if (!voice?.closing) evaluationTimer = setTimeout(() => evaluate(), 500);
}

async function post(path, data, signal) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not reach OpenAI. Try again.');
  return body;
}

// One request at a time; edits made during a request are evaluated next.
function evaluate(force = false) {
  clearTimeout(evaluationTimer);
  if (!configured || voice?.closing) return Promise.resolve(null);
  if (!force && resultRevision === revision && result) return Promise.resolve(result);
  pending = true;
  if (!evaluation) evaluation = drain().finally(() => { evaluation = null; });
  return evaluation;
}

async function drain() {
  while (pending) {
    pending = false;
    if (typed && context()) history.push({ role: 'user', text: context() });
    typed = false;
    const version = revision, state = snapshot();
    if (!state.topic) { status('Add a topic above first.'); return null; }
    if (state.options.length < 2) { status('Add at least two options above first.'); return null; }
    if (state.context.length > 12000) { status('Your story is too long. Start over.', true); return null; }
    evaluationAbort = new AbortController();
    const timeout = setTimeout(() => evaluationAbort.abort(), 45000);
    status('Comparing options…');
    try {
      const next = await post('/api/evaluate', state, evaluationAbort.signal);
      if (voice?.closing) { pending = false; continue; }
      if (version !== revision) { pending = true; continue; }
      result = next; resultRevision = version;
      if (next.question && history.at(-1)?.text !== next.question) history.push({ role: 'assistant', text: next.question });
      transcript();
      renderResult();
      status(next.options.every((o) => o.excluded) ? 'All options are excluded. Restore one or add another.' : next.ready ? (voice?.started ? 'Listening. Scores update as we talk.' : 'Add more detail or wrap up.') : 'Tell me a little more about what matters.');
      send(voice, { type: 'session.thinking.append', delegation_id: null, content: summary(next) });
    } catch (error) {
      if (version === revision) status(error.name === 'AbortError' ? 'The comparison timed out. Try again.' : error.message, true);
    } finally { clearTimeout(timeout); evaluationAbort = null; }
  }
  return result;
}

function summary(value) {
  const leaders = value?.options.filter((o) => !o.excluded).sort((a, b) => (b.share || 0) - (a.share || 0)).slice(0, 2) || [];
  const text = value ? `Topic: ${topic().slice(0, 64)}. ${value.ready ? 'Scores' : 'Not enough detail'}: ${leaders.map((o) => `${o.label.slice(0, 64)}: ${o.share == null ? 'not scored' : `${o.share}%`}`).join('; ') || 'all options excluded'}. ${value.question || leaders[0]?.reason.slice(0, 60) || ''}${value.suggestion ? ` Suggestion: ${value.suggestion.label.slice(0, 32)}.` : ''}` : 'Comparison failed. Ask the user to try again.';
  const chars = Array.from(text), encoder = new TextEncoder();
  while (encoder.encode(chars.join('')).length > 480) chars.pop();
  return chars.length < Array.from(text).length ? chars.join('').replace(/\s+\S*$/, '') + '…' : text;
}

function send(session, event) {
  if (session === voice && session?.started && !session.closing && session.channel.readyState === 'open') session.channel.send(JSON.stringify(event));
}

function transcript() {
  const turns = [...history, ...(voice?.fragment ? [voice.fragment] : [])];
  $('#transcript').innerHTML = turns.length ? turns.map((t) => `<p><b>${t.role === 'user' ? 'YOU' : 'AI'}</b>${escape(t.text)}</p>`).join('') : 'Your conversation will appear here.';
}

function flush(session) {
  clearTimeout(session.fragmentTimer);
  const fragment = session.fragment;
  if (!fragment?.text.trim()) return;
  history.push(fragment);
  session.fragment = null;
  if (fragment.role === 'user') { $('#context').value = [$('#context').value, fragment.text].filter(Boolean).join('\n'); changed(); }
  transcript();
}

function receive(session, event) {
  if (voice !== session) return;
  if (event.type === 'session.started') {
    session.started = true; clearTimeout(session.startTimer);
    status('Listening. Tell me about your choice.'); controls();
  } else if (event.type === 'session.closed') {
    flush(session); session.confirmed = true; session.closed?.();
    if (!session.closing) finishVoice(session);
  } else if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
    const role = event.type.includes('input') ? 'user' : 'assistant';
    if (session.fragment?.role !== role) flush(session);
    session.fragment ||= { role, text: '', start_ms: event.start_ms, end_ms: event.end_ms };
    session.fragment.text += event.delta; session.fragment.end_ms = event.end_ms;
    clearTimeout(session.fragmentTimer);
    session.fragmentTimer = setTimeout(() => flush(session), 1000);
    transcript();
  } else if (event.type === 'session.delegation.created' && event.delegation.target === 'client' && !session.closing) {
    const id = event.delegation.id;
    if (session.delegations.has(id)) return;
    session.delegations.add(id); flush(session);
    evaluate().then((value) => send(session, { type: 'session.commentary.append', delegation_id: id, content: summary(value) }));
  } else if (event.type === 'error') status(event.error?.message || 'Voice interrupted. Try again.', true);
}

function cleanup(session) {
  clearTimeout(session.startTimer); clearTimeout(session.fragmentTimer);
  if (voice === session) { voice = null; $('#audio').srcObject = null; controls(); }
  session.abort.abort(); session.stream?.getTracks().forEach((t) => t.stop());
  session.channel?.close(); session.peer?.close();
  session.closed?.();
}

async function startVoice() {
  const session = { abort: new AbortController(), delegations: new Set(), started: false, closing: false };
  voice = session; controls(); status('Allow microphone access…');
  $('#audio').play().catch(() => {});
  session.startTimer = setTimeout(() => {
    if (voice === session && !session.started) { cleanup(session); status('Voice did not connect. Check your connection and try again.', true); }
  }, 45000);
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error('Open this app on localhost in a modern browser to use voice. You can also type.');
    session.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (voice !== session) return session.stream.getTracks().forEach((t) => t.stop());
    session.peer = new RTCPeerConnection();
    session.peer.ontrack = (event) => { if (voice === session) { $('#audio').srcObject = event.streams[0]; $('#audio').play().catch(() => status('Press Stop and reconnect to enable audio.', true)); } };
    session.stream.getTracks().forEach((t) => session.peer.addTrack(t, session.stream));
    session.channel = session.peer.createDataChannel('oai-events');
    session.channel.onmessage = (event) => { try { receive(session, JSON.parse(event.data)); } catch { status('Could not read the voice response.', true); } };
    session.channel.onclose = () => { if (voice === session && !session.confirmed && !session.closing) finishVoice(session, false); };
    session.peer.onconnectionstatechange = () => { if (voice === session && session.peer.connectionState === 'failed') finishVoice(session, false); };
    await session.peer.setLocalDescription(await session.peer.createOffer());
    if (session.peer.iceGatheringState !== 'complete') await new Promise((resolve) => {
      const done = () => { clearTimeout(timeout); session.peer.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (session.peer.iceGatheringState === 'complete') done(); };
      const timeout = setTimeout(done, 6000);
      session.peer.addEventListener('icegatheringstatechange', check); check();
    });
    if (voice !== session) return;
    status('Connecting voice…');
    const answer = await post('/api/session', { ...snapshot(), sdp: session.peer.localDescription.sdp }, session.abort.signal);
    if (voice !== session) return;
    await session.peer.setRemoteDescription({ type: 'answer', sdp: answer.transport.sdp });
  } catch (error) {
    if (voice !== session) return;
    cleanup(session);
    status(error.name === 'NotAllowedError' ? 'Allow the microphone in your browser settings, then press Talk again.' : error.name === 'NotFoundError' ? 'Microphone not found. Connect one or type instead.' : error.message, true);
  }
}

async function finishVoice(session, confirmed = session.confirmed) {
  if (voice !== session) return;
  const epoch = generation;
  flush(session); cleanup(session);
  await evaluate(true);
  if (!confirmed && epoch === generation) status('The conversation ended early. Your last phrase may be incomplete.', true);
}

async function stopVoice() {
  const session = voice;
  if (!session || session.closing) return;
  if (!session.started) { cleanup(session); status('Connection cancelled.'); return evaluate(true); }
  session.closing = true; pending = false; clearTimeout(evaluationTimer); controls(); status('Saving your last phrase…');
  // Keep the receiver and microphone alive until the final transcripts arrive.
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 15000);
    session.closed = () => { clearTimeout(timeout); resolve(); };
    if (session.channel.readyState === 'open') session.channel.send(JSON.stringify({ type: 'session.close' }));
  });
  if (voice === session) await finishVoice(session);
}

optionsElement.addEventListener('input', (event) => {
  const option = options.find((o) => o.id === event.target.closest('.option')?.dataset.id);
  if (option) { option.label = event.target.value; changed(); }
});
optionsElement.addEventListener('click', (event) => {
  const action = event.target.dataset.action, row = event.target.closest('.option');
  if (!action || !row) return;
  const option = options.find((o) => o.id === row.dataset.id);
  if (action === 'choose') { chosen = option.id; renderResult(); return; }
  if (action === 'exclude') option.excluded = !option.excluded;
  if (action === 'remove' && options.length > 2) {
    if (option.label.trim()) dismissed = [...new Set([...dismissed, option.label.trim()])].slice(-30);
    options = options.filter((o) => o !== option);
  }
  changed(); renderOptions();
});
$('#add').onclick = () => { if (options.length >= 8) return; options.push({ id: `option_${crypto.randomUUID().slice(0, 8)}`, label: '', excluded: false }); changed(); renderOptions(); optionsElement.lastElementChild.querySelector('input').focus(); };
$('#topic').oninput = changed;
$('#context').oninput = () => { typed = true; changed(); };
$('#talk').onclick = () => voice ? stopVoice() : startVoice();
$('#finalize').onclick = async () => {
  if (finalizing) return;
  const epoch = generation; finalizing = true; controls();
  if (voice) await stopVoice(); else await evaluate(true);
  if (epoch !== generation) return;
  finalizing = false;
  if (result?.ready && resultRevision === revision) final = true;
  renderResult();
};
$('#accept').onclick = () => { const suggestion = result?.suggestion; if (!suggestion || options.length >= 8) return; options.push({ id: `option_${crypto.randomUUID().slice(0, 8)}`, label: suggestion.label, excluded: false }); history.push({ role: 'assistant', text: `One option to consider: ${suggestion.label}` }, { role: 'user', text: 'Add that option.' }); changed(); renderOptions(); };
$('#dismiss').onclick = () => { if (result?.suggestion) dismissed = [...new Set([...dismissed, result.suggestion.label])].slice(-30); changed(); };
function reset() {
  generation++; revision++; pending = false; clearTimeout(evaluationTimer); evaluationAbort?.abort();
  if (voice) cleanup(voice);
  options = emptyOptions(); history = []; dismissed = []; result = null; chosen = null; final = false; finalizing = false; typed = false;
  $('#topic').value = ''; $('#context').value = ''; transcript(); renderOptions();
  status(configured ? 'Add a topic and two options to enable Talk.' : 'Add your OpenAI key to .env and restart the app.', !configured);
}
$('#reset').onclick = reset;
$('#example').onclick = () => { reset(); $('#topic').value = 'How should I spend the evening?'; options[0].label = 'Stay home'; options[1].label = 'Go for a walk'; $('#context').value = 'I feel tired after work, but I spent all day at my desk. The weather is nice. I want to rest and clear my head.'; changed(); renderOptions(); };
window.addEventListener('pagehide', () => { if (voice) cleanup(voice); evaluationAbort?.abort(); });
options = emptyOptions(); renderOptions();
fetch('/api/health').then((r) => r.json()).then((health) => { configured = health.configured; controls(); status(configured ? 'Add a topic and two options to enable Talk.' : 'Add your OpenAI key to .env and restart the app.', !configured); }).catch(() => status('The local app is unavailable. Restart it and refresh this page.', true));
