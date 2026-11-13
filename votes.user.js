// ==UserScript==
// @name         e6ai to floof vote transfer
// @namespace    local.vote-transfer
// @version      1.5
// @description  Copies your own up/down votes from e6ai.net to floofgens.net. Not affiliated with either site.
// @match        https://floofgens.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      e6ai.net
// @connect      floofgens.net
// @run-at       document-idle
// ==/UserScript==

// Unofficial tool. Not affiliated with e6ai or floof.

(function () {
  'use strict';

  const SOURCE = 'https://e6ai.net';
  const GAP_MS = 1100;          // floof asks for at most one request per second
  const PAGE_SIZE = 320;
  const MAX_REJECT_STREAK = 10; // stop if the site keeps refusing votes
  const MAX_RETRIES = 6;

  const me = document.body.dataset.userName || 'Anonymous';
  const client = 'e6ai-vote-transfer/1.0 (by ' + me + ')';
  const token = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';

  let queue = JSON.parse(GM_getValue('queue', '[]'));
  let busy = false;
  let stopRequested = false;
  const stats = { ok: 0, missing: 0, rejected: 0 };
  let lastOk = 0;
  let startedAt = 0;
  let sentThisRun = 0;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 30000, anonymous: false,
        onload: resolve,
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timed out')),
      });
    });
  }

  async function getWithRetry(url) {
    for (let attempt = 0; ; attempt++) {
      let r = null;
      try { r = await gmGet(url); } catch (e) { r = null; }
      if (r && r.status >= 200 && r.status < 300) return r;
      const retryable = !r || r.status === 429 || r.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) {
        throw new Error('Read failed' + (r ? ' with HTTP ' + r.status : ' (network)') + '.');
      }
      setStatus('Site is busy, waiting before retrying...');
      await sleep(Math.min(300000, 15000 * 2 ** attempt));
    }
  }

  async function e6aiUser() {
    const r = await getWithRetry(SOURCE + '/posts?limit=1');
    const m = /data-user-name="([^"]*)"/.exec(r.responseText);
    return m ? m[1] : '';
  }

  async function readVotes(host, tag, label, alreadyFound = 0) {
    const ids = [];
    let before = 0;
    for (;;) {
      if (stopRequested) throw new Error('Stopped. Press Start to begin again.');
      const url = host + '/posts.json?limit=' + PAGE_SIZE +
        '&tags=' + encodeURIComponent(tag + ':me status:any') +
        '&_client=' + encodeURIComponent(client) +
        (before ? '&page=b' + before : '');
      const r = await getWithRetry(url);
      const posts = JSON.parse(r.responseText).posts || [];
      if (!posts.length) return ids;
      for (const p of posts) ids.push(p.id);
      before = Math.min(...posts.map(p => p.id));
      setStatus(label + ' ' + (alreadyFound + ids.length) + ' found');
      await sleep(GAP_MS);
    }
  }

  // Returns true when there are votes ready to send
  async function readAll() {
    try {
      if (me === 'Anonymous') throw new Error('Log in to floof first.');
      setStatus('Gathering e6ai votes...');
      const source = await e6aiUser();
      if (!source || source === 'Anonymous') {
        throw new Error('Not logged in to e6ai.net in this browser. Log in there, then press Start.');
      }
      const ups = await readVotes(SOURCE, 'votedup', 'Gathering e6ai votes...');
      const downs = await readVotes(SOURCE, 'voteddown', 'Gathering e6ai votes...', ups.length);
      setStatus('Checking floof votes...');
      const have = new Set(await readVotes(location.origin, 'voted', 'Checking floof votes...'));
      queue = ups.map(id => [id, 1]).concat(downs.map(id => [id, -1]))
        .filter(item => !have.has(item[0]));
      saveQueue();
      if (!queue.length) setStatus('Nothing to transfer. All your e6ai votes are on floof.');
      return queue.length > 0;
    } catch (e) {
      setStatus(e.message);
      return false;
    }
  }

  function saveQueue() {
    GM_setValue('queue', JSON.stringify(queue));
  }

  async function sendVote(id, score) {
    return fetch('/posts/' + id + '/votes.json?_client=' + encodeURIComponent(client), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'X-CSRF-Token': token,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      // no_unvote keeps a repeated send from toggling the vote back off
      body: 'score=' + score + '&no_unvote=true',
    });
  }

  async function start() {
    if (busy) return;
    busy = true;
    stopRequested = false;
    sentThisRun = 0;
    render();
    if (queue.length || await readAll()) await run();
    busy = false;
    render();
  }

  async function run() {
    startedAt = Date.now();
    let streak = 0;
    let retries = 0;
    let halted = false;
    setStatus('Transferring e6ai votes...');
    render();
    while (queue.length && !stopRequested && !halted) {
      const id = queue[0][0];
      const score = queue[0][1];
      const sentAt = Date.now();
      let r = null;
      try { r = await sendVote(id, score); } catch (e) { r = null; }

      if (!r || r.status === 429 || r.status >= 500) {
        retries++;
        if (retries > MAX_RETRIES) {
          setStatus('Stopped: the site kept refusing (' + (r ? 'HTTP ' + r.status : 'network') +
            '). Press Start later to continue.');
          halted = true;
          break;
        }
        const wait = Math.min(300000, 15000 * 2 ** (retries - 1));
        setStatus('Slowing down, waiting ' + Math.round(wait / 1000) + ' seconds...');
        await sleep(wait);
        continue;
      }
      retries = 0;

      if (r.status === 401 || r.status === 403) {
        setStatus('Stopped: floof refused the vote (HTTP ' + r.status +
          '). Reload the page, check you are logged in, then press Start.');
        halted = true;
        break;
      }

      queue.shift();
      sentThisRun++;
      if (r.ok) {
        stats.ok++;
        lastOk = id;
        streak = 0;
        setStatus('Transferring e6ai votes...');
      } else if (r.status === 404) {
        stats.missing++;
      } else {
        stats.rejected++;
        streak++;
        let why = 'HTTP ' + r.status;
        try { why = (await r.json()).message || why; } catch (e) { /* keep status */ }
        setStatus('Post ' + id + ' refused: ' + why);
        if (streak >= MAX_REJECT_STREAK) {
          setStatus('Stopped after ' + streak + ' refusals in a row. Last: ' + why);
          halted = true;
        }
      }
      if (sentThisRun % 10 === 0) saveQueue();
      render();
      // GAP_MS is the time between sends, so the request itself counts toward it
      if (!halted) await sleep(Math.max(0, GAP_MS - (Date.now() - sentAt)));
    }
    saveQueue();
    if (!halted) {
      if (queue.length) setStatus('Paused. Press Start to continue.');
      else if (stats.rejected) setStatus('Finished. Press Start to retry the refused votes.');
      else setStatus('Finished.');
    }
  }

  // Panel

  function el(tag, css, text) {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text) node.textContent = text;
    return node;
  }

  const btnCss = 'margin:6px 6px 0 0;padding:4px 10px;cursor:pointer;';
  const panel = el('div', 'position:fixed;right:12px;top:100px;z-index:99999;width:300px;' +
    'padding:12px;background:#152f56;color:#fff;border:1px solid #fff4;border-radius:6px;' +
    'font:13px/1.4 sans-serif;display:none;');
  const statusLine = el('div', 'min-height:3em;overflow-wrap:anywhere;',
    queue.length ? 'Press Start to continue.' : 'Press Start to begin.');
  const countLine = el('div', 'margin-top:6px;');
  const link = el('a', 'display:block;margin-top:6px;color:#9cf;');
  link.target = '_blank';
  const startBtn = el('button', btnCss, 'Start');
  const stopBtn = el('button', btnCss, 'Stop');
  const notice = el('div', 'margin-top:8px;font-size:11px;opacity:.7;',
    'Not affiliated with e6ai or floof.');
  const toggle = el('button', 'padding:4px 10px;cursor:pointer;white-space:nowrap;', 'Vote transfer');

  function setStatus(text) { statusLine.textContent = text; }

  function render() {
    let line = queue.length + ' left | ' + stats.ok + ' sent | ' +
      stats.missing + ' not on floof | ' + stats.rejected + ' refused';
    if (busy && sentThisRun > 2) {
      const rate = sentThisRun / ((Date.now() - startedAt) / 1000);
      const mins = Math.round(queue.length / rate / 60);
      line += ' | ' + (mins < 60 ? mins + ' min' : Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm') + ' left';
    }
    countLine.textContent = line;
    link.textContent = lastOk ? 'Last vote: post ' + lastOk : '';
    link.href = lastOk ? '/posts/' + lastOk : '#';
    startBtn.disabled = busy;
    stopBtn.disabled = !busy;
  }

  startBtn.onclick = start;
  stopBtn.onclick = () => { stopRequested = true; };
  toggle.onclick = () => {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  };

  panel.append(statusLine, countLine, link, startBtn, stopBtn, notice);
  document.body.append(panel);

  // Sits with the header icons under the username; fixed to the top if they are hidden
  const tools = document.querySelector('.nav-tools');
  if (tools && tools.getClientRects().length) {
    const slot = el('li', 'display:flex;align-items:center;');
    slot.append(toggle);
    tools.prepend(slot);
  } else {
    toggle.style.cssText += 'position:fixed;right:12px;top:60px;z-index:99999;';
    document.body.append(toggle);
  }
  render();
})();
