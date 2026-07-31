'use strict';

var CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ]
};
var ICE_TIMEOUT = 800;
var CHUNK_SIZE_BASE = 65536;
var CHUNK_SIZE_MIN = 16384;
var CHUNK_SIZE_MAX = 4194304;
var BUF_TARGET = 1048576;
var BUF_LOW = 131072;
var NUM_DATA_CHANNELS = 4;
var SCAN_DELAY = 500;
var ADAPT_EMA_ALPHA = 0.3;

var state = 'home';
var pc = null;
var ctrlDC = null;
var dataDCs = [];
var isHost = false;
var mediaStream = null;
var scanTimer = null;
var fileQueue = [];
var qrHost = null;
var qrAnswer = null;
var recvStreams = {};
var pendingChunks = {};
var autoConnected = false;
var avgThroughput = 0;
var currentChunkSize = CHUNK_SIZE_BASE;
var saveFolderHandle = null;
var saveFolderName = '';
var _txTotalBytes = 0;
var _txSentBytes = 0;
var _rxTotalBytes = 0;
var _rxReceivedBytes = 0;
var _receivedCount = 0;
var _receivedBytes = 0;
var _txStart = 0;
var _rxBatchStart = 0;
var _lastPct = -1;
var _throttleTimer = 0;

function $(id) { return document.getElementById(id); }

function showScreen(id) {
    var screens = document.querySelectorAll('.screen');
    for (var i = 0; i < screens.length; i++) {
        screens[i].classList.remove('active');
    }
    var el = $('screen-' + id);
    if (el) el.classList.add('active');
    state = id;
}

function waitForIceGathering(p) {
    if (p.iceGatheringState === 'complete') return Promise.resolve();
    return Promise.race([
        new Promise(function(resolve) {
            p.onicegatheringstatechange = function() {
                if (p.iceGatheringState === 'complete') {
                    p.onicegatheringstatechange = null;
                    resolve();
                }
            };
        }),
        new Promise(function(resolve) {
            setTimeout(function() { resolve(); }, ICE_TIMEOUT);
        })
    ]);
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function fmtSpeed(bps) {
    if (bps < 1e6) return (bps / 1e3).toFixed(0) + ' Kbps';
    if (bps < 1e9) return (bps / 1e6).toFixed(1) + ' Mbps';
    return (bps / 1e9).toFixed(2) + ' Gbps';
}

function fmtDuration(sec) {
    if (sec < 1) return (sec * 1000).toFixed(0) + 'ms';
    if (sec < 60) return sec.toFixed(1) + 's';
    var m = Math.floor(sec / 60);
    var s = (sec % 60).toFixed(0);
    return m + 'm ' + s + 's';
}

function playSound(name) {
    try {
        var a = new Audio('sound/' + name + '.mp3');
        a.volume = 0.6;
        a.play().catch(function() {});
    } catch (e) {}
}

function updateThroughput(fileSizeBytes, elapsedMs) {
    if (elapsedMs <= 0) return;
    var fileBps = (fileSizeBytes * 8) / (elapsedMs / 1000);
    if (avgThroughput === 0) {
        avgThroughput = fileBps;
    } else {
        avgThroughput = avgThroughput * (1 - ADAPT_EMA_ALPHA) + fileBps * ADAPT_EMA_ALPHA;
    }
    if (avgThroughput > 200e6) currentChunkSize = CHUNK_SIZE_MAX;
    else if (avgThroughput > 50e6) currentChunkSize = 1048576;
    else if (avgThroughput > 10e6) currentChunkSize = 262144;
    else currentChunkSize = CHUNK_SIZE_BASE;
}

// ===================== QR CODE RENDERING =====================

function renderQR(elementId, text) {
    var el = $(elementId);
    el.innerHTML = '';
    if (typeof qrcode === 'undefined') {
        el.innerHTML = '<div style="color:#333;padding:20px;text-align:center">QR library not loaded.</div>';
        console.error('qrcode library not found');
        return;
    }
    try {
        var qr = qrcode(0, 'L');
        qr.addData(text);
        qr.make();
        var count = qr.getModuleCount();
        var margin = 4;
        var cellSize = Math.max(4, Math.floor(440 / count));
        var px = (count + margin * 2) * cellSize;
        var c = document.createElement('canvas');
        c.width = px;
        c.height = px;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, px, px);
        ctx.fillStyle = '#000000';
        for (var r = 0; r < count; r++) {
            for (var col = 0; col < count; col++) {
                if (qr.isDark(r, col)) {
                    ctx.fillRect((col + margin) * cellSize, (r + margin) * cellSize, cellSize, cellSize);
                }
            }
        }
        var img = document.createElement('img');
        img.src = c.toDataURL();
        img.style.cssText = 'display:block;width:100%;height:auto;max-width:' + px + 'px';
        el.appendChild(img);
        el.style.cssText = 'background:#fff;padding:16px;display:flex;align-items:center;justify-content:center';
    } catch (e) {
        console.error('QR render error:', e);
        el.innerHTML = '<div style="color:#333;padding:16px;font-size:10px;word-break:break-all;max-width:256px">Data: ' + text.substring(0, 60) + '...</div>';
    }
}

// ===================== WEBRTC =====================

function setupCtrlDC(channel) {
    ctrlDC = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = function(e) {
        if (typeof e.data === 'string') handleCtrlMsg(e.data);
    };
    channel.onopen = function() {
        if (!autoConnected) tryConnect();
    };
    channel.onerror = function(e) { console.error('CTRL DC error', e); };
    channel.onclose = function() {
        if (state === 'connected') {
            disconnect();
        }
    };
}

function setupDataDC(channel, index) {
    dataDCs[index] = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = function(e) {
        if (e.data instanceof ArrayBuffer) handleDataMsg(e.data, index);
    };
    channel.onopen = function() {
        console.log('Data channel ' + index + ' open');
        if (!autoConnected) tryConnect();
    };
    channel.onerror = function(e) { console.warn('Data DC ' + index + ' error', e); };
    channel.onclose = function() {
        console.log('Data channel ' + index + ' closed');
    };
}

function tryConnect() {
    if (!ctrlDC || ctrlDC.readyState !== 'open') return;
    if (!pc || (pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed')) return;
    if (autoConnected) return;
    autoConnected = true;
    playSound('granted');
    showScreen('connected');
    if ('showDirectoryPicker' in window) {
        $('btn-save-folder').classList.remove('hidden');
    }
}

async function startHosting() {
    if (!window.RTCPeerConnection) { alert('WebRTC not supported in this browser.'); return; }
    isHost = true;
    autoConnected = false;
    dataDCs = [];
    pendingChunks = {};
    recvStreams = {};
    showScreen('hosting');
    $('host-status').textContent = 'Setting up...';
    $('btn-scan-answer').classList.add('hidden');
    if (qrHost) { qrHost.clear(); qrHost = null; }

    try {
        pc = new RTCPeerConnection(CONFIG);
        pc.oniceconnectionstatechange = function() { tryConnect(); };

        ctrlDC = pc.createDataChannel('control');
        setupCtrlDC(ctrlDC);
        for (var i = 0; i < NUM_DATA_CHANNELS; i++) {
            var ch = pc.createDataChannel('data-' + i);
            setupDataDC(ch, i);
            dataDCs[i] = ch;
        }

        var offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);

        var sdp = pc.localDescription.sdp;
        var data = JSON.stringify({ t: 'o', s: sdp });
        renderQR('qrcode-host', data);

        $('host-status').textContent = 'Ask your friend to scan this QR code';
        $('btn-scan-answer').classList.remove('hidden');
    } catch (err) {
        console.error('Hosting error:', err);
        $('host-status').textContent = 'Error: ' + err.message;
    }
}

async function startJoining() {
    if (!navigator.mediaDevices) { alert('Camera access not supported in this browser.'); return; }
    if (!window.RTCPeerConnection) { alert('WebRTC not supported in this browser.'); return; }
    isHost = false;
    autoConnected = false;
    dataDCs = [];
    recvStreams = {};
    pendingChunks = {};
    showScreen('scanning');
    $('scan-status').textContent = 'Scan the QR code from the host device';
    try { await initCamera(); } catch (e) {
        console.error('Camera init failed:', e);
        alert('Could not open camera: ' + e.message);
        showScreen('home');
    }
}

async function hostScanAnswer() {
    showScreen('scanning');
    $('scan-status').textContent = 'Scan the reply QR from your friend\'s device';
    try { await initCamera(); } catch (e) {
        console.error('Camera init failed:', e);
        alert('Could not open camera: ' + e.message);
        showScreen('home');
    }
}

// ===================== CAMERA =====================

async function initCamera() {
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
        });
        const video = $('camera-view');
        video.srcObject = mediaStream;
        await video.play();
        startScanLoop();
    } catch (err) {
        alert('Camera access is required to scan QR codes.\nPlease grant permission and try again.');
        showScreen('home');
    }
}

function stopCamera() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(function(t) { t.stop(); });
        mediaStream = null;
    }
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    $('camera-view').srcObject = null;
}

function startScanLoop() {
    const video = $('camera-view');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function scan() {
        if (state !== 'scanning') return;
        if (video.readyState === 4) {
            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 480;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height);
            if (code && code.data) {
                try {
                    const parsed = JSON.parse(code.data);
                    handleScan(parsed);
                    return;
                } catch (e) {}
            }
        }
        scanTimer = setTimeout(scan, SCAN_DELAY);
    }
    scanTimer = setTimeout(scan, SCAN_DELAY);
}

async function handleScan(data) {
    stopCamera();
    playSound('scan');

    if (data.t === 'o' && !isHost) {
        showScreen('connecting');
        $('connect-status').textContent = 'Connecting...';

        try {
            pc = new RTCPeerConnection(CONFIG);
            pc.oniceconnectionstatechange = function() { tryConnect(); };
            pc.ondatachannel = function(ev) {
                var label = ev.channel.label;
                if (label === 'control') {
                    setupCtrlDC(ev.channel);
                } else if (label.startsWith('data-')) {
                    var idx = parseInt(label.split('-')[1], 10);
                    setupDataDC(ev.channel, idx);
                }
            };

            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: data.s }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await waitForIceGathering(pc);

            var answerData = JSON.stringify({ t: 'a', s: pc.localDescription.sdp });
            showScreen('show-answer');
            renderQR('qrcode-answer', answerData);
            $('answer-status').textContent = 'Show this to the host device';
        } catch (err) {
            $('connect-status').textContent = 'Error: ' + err.message;
            setTimeout(function() { showScreen('home'); }, 2500);
        }

    } else if (data.t === 'a' && isHost) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.s }));
            $('host-status').textContent = 'Connected!';
            setTimeout(function() { tryConnect(); }, 500);
        } catch (err) {
            $('host-status').textContent = 'Connection failed: ' + err.message;
            setTimeout(function() { showScreen('home'); }, 2500);
        }
    }
}

// ===================== FILE SELECTION =====================

function selectFiles() { $('file-input').click(); }

function onFilesSelected(e) {
    const files = Array.from(e.target.files);
    fileQueue.push.apply(fileQueue, files);
    renderSummary();
}

function renderSummary() {
    var el = $('file-summary');
    var countEl = $('file-count');
    var sizeEl = $('file-total-size');
    if (fileQueue.length === 0) {
        el.classList.add('hidden');
        $('btn-send').classList.add('hidden');
        return;
    }
    var total = fileQueue.reduce(function(s, f) { return s + f.size; }, 0);
    countEl.textContent = fileQueue.length + ' file' + (fileQueue.length !== 1 ? 's' : '');
    sizeEl.textContent = '· ' + formatSize(total);
    el.classList.remove('hidden');
    $('btn-send').classList.remove('hidden');
}

function clearFiles() {
    fileQueue = [];
    renderSummary();
}

// ===================== SAVE FOLDER (FILE SYSTEM ACCESS API) =====================

async function chooseSaveFolder() {
    if (!('showDirectoryPicker' in window)) return;
    try {
        saveFolderHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        saveFolderName = saveFolderHandle.name;
        $('btn-save-folder').classList.add('hidden');
        var st = $('save-folder-status');
        st.textContent = 'Saving to: ' + saveFolderName;
        st.classList.remove('hidden');
    } catch (e) {
        // User cancelled or API not available
    }
}

// ===================== SEND ENGINE =====================

async function sendFiles() {
    if (!ctrlDC || ctrlDC.readyState !== 'open') return alert('Not connected to any device.');
    var openDCs = dataDCs.filter(function(c) { return c && c.readyState === 'open'; });
    if (openDCs.length === 0) return alert('No data channels available.');

    if (fileQueue.length === 0) return;

    const files = [...fileQueue];
    fileQueue = [];
    renderSummary();
    $('btn-send').classList.add('hidden');
    $('progress-section').classList.remove('hidden');
    resetProgressDisplay();
    setProgressRole(true);

    var sFill = $('liquid-sender'), rFill = $('liquid-receiver');
    if (sFill) sFill.style.height = '100%';
    if (rFill) rFill.style.height = '0%';
    var ps = $('pct-sender'), pr = $('pct-receiver');
    if (ps) ps.textContent = '0%';
    if (pr) pr.textContent = '0%';
    _lastPct = -1;
    _throttleTimer = 0;
    var fs = $('file-summary');
    if (fs) fs.classList.add('hidden');

    _txTotalBytes = files.reduce(function(s, f) { return s + f.size; }, 0);
    _txSentBytes = 0;
    _txStart = Date.now();
    $('progress-label').textContent = 'Sending ' + files.length + ' file' + (files.length !== 1 ? 's' : '') + '...';

    var fileIndex = 0;
    var numWorkers = Math.min(openDCs.length, files.length);

    function assignNext(chanIdx) {
        if (fileIndex >= files.length) return Promise.resolve();
        var file = files[fileIndex++];
        return sendSingleFile(file, chanIdx).then(function() {
            var cur = _txSentBytes;
            updateProgress(cur / _txTotalBytes);
            return assignNext(chanIdx);
        });
    }

    var workers = [];
    for (var i = 0; i < numWorkers; i++) {
        workers.push(assignNext(i));
    }
    await Promise.all(workers);

    var elapsed = (Date.now() - _txStart) / 1000;
    var speed = elapsed > 0 ? (_txTotalBytes * 8) / elapsed : 0;
    ctrlDC.send(JSON.stringify({ type: 'transfer-complete', elapsed: elapsed, speed: speed }));
    playSound('sent');
    showSuccess(elapsed, speed);
}

async function sendSingleFile(file, channelIndex) {
    var dc = dataDCs[channelIndex];
    if (!dc || dc.readyState !== 'open') return;

    var chunkSize = currentChunkSize;
    var totalChunks = Math.ceil(file.size / chunkSize);
    var fileId = Date.now() + '-' + Math.random().toString(36).substr(2, 6);

    ctrlDC.send(JSON.stringify({
        type: 'file-start', fileId: fileId, channelIndex: channelIndex,
        name: file.name, size: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks: totalChunks
    }));

    var fileStartTime = Date.now();
    var offset = 0;

    for (var i = 0; i < totalChunks; i++) {
        var end = Math.min(offset + chunkSize, file.size);
        var blob = file.slice(offset, end);
        var buf = await blob.arrayBuffer();
        dc.send(buf);
        _txSentBytes += buf.byteLength;
        offset = end;
        if (dc.bufferedAmount >= BUF_TARGET) await waitBufferDrain(dc);
    }

    ctrlDC.send(JSON.stringify({ type: 'file-end', fileId: fileId, name: file.name, channelIndex: channelIndex }));

    var fileElapsed = Date.now() - fileStartTime;
    updateThroughput(file.size, fileElapsed);
}

async function waitBufferDrain(dataDC) {
    if (!dataDC || dataDC.readyState !== 'open') return;
    if (dataDC.bufferedAmount <= BUF_LOW) return;
    return new Promise(function(resolve) {
        dataDC.bufferedAmountLowThreshold = BUF_LOW;
        dataDC.onbufferedamountlow = function() {
            dataDC.onbufferedamountlow = null;
            if (pollTimer) clearTimeout(pollTimer);
            resolve();
        };
        var pollTimer = setTimeout(function poll() {
            if (!dataDC || dataDC.readyState !== 'open') { resolve(); return; }
            if (dataDC.bufferedAmount <= BUF_LOW) {
                dataDC.onbufferedamountlow = null;
                resolve();
            } else {
                pollTimer = setTimeout(poll, 50);
            }
        }, 100);
    });
}

// ===================== RECEIVE ENGINE =====================

async function handleCtrlMsg(data) {
    try {
        var msg = JSON.parse(data);
    } catch (_) { return; }

    switch (msg.type) {
        case 'transfer-complete':
            if (_rxBatchStart) {
                var rxElapsed = (Date.now() - _rxBatchStart) / 1000;
                var rxSpeed = rxElapsed > 0 ? (_rxReceivedBytes * 8) / rxElapsed : 0;
                showSuccess(rxElapsed, rxSpeed);
            }
            _rxBatchStart = 0;
            playSound('sent');
            break;

        case 'file-start':
            if (!_rxBatchStart) _rxBatchStart = Date.now();
            await setupRecvStream(msg);
            break;

        case 'file-end':
            finalizeRecvStream(msg);
            break;
    }
}

function handleDataMsg(data, channelIndex) {
    var stream = recvStreams[channelIndex];
    if (stream) {
        stream.received += data.byteLength;
        _rxReceivedBytes += data.byteLength;
        writeChunk(stream, data);
        updateProgress(_rxReceivedBytes / _rxTotalBytes);
    } else {
        if (!pendingChunks[channelIndex]) pendingChunks[channelIndex] = [];
        pendingChunks[channelIndex].push(data);
    }
}

async function setupRecvStream(msg) {
    var ci = msg.channelIndex;
    if (recvStreams[ci]) {
        finalizeRecvStream({ channelIndex: ci, force: true });
    }

    var stream = {
        fileId: msg.fileId,
        name: msg.name,
        size: msg.size,
        mimeType: msg.mimeType,
        totalChunks: msg.totalChunks,
        received: 0,
        chunks: [],
        writable: null,
        streaming: false
    };

    _rxTotalBytes += msg.size;

    if (saveFolderHandle) {
        await trySaveToDisk(stream);
    }

    if (pendingChunks[ci] && pendingChunks[ci].length > 0) {
        var pend = pendingChunks[ci];
        delete pendingChunks[ci];
        for (var j = 0; j < pend.length; j++) {
            stream.received += pend[j].byteLength;
            _rxReceivedBytes += pend[j].byteLength;
            writeChunk(stream, pend[j]);
        }
    }

    recvStreams[ci] = stream;

    $('progress-section').classList.remove('hidden');
    resetProgressDisplay();
    setProgressRole(false);
    var rf = $('liquid-receiver');
    if (rf) rf.style.height = '0%';
    var pr = $('pct-receiver');
    if (pr) pr.textContent = '0%';
    _lastPct = -1;
    _throttleTimer = 0;
    $('progress-label').textContent = 'Receiving ' + msg.name;
    updateProgress(_rxTotalBytes > 0 ? _rxReceivedBytes / _rxTotalBytes : 0);
}

async function trySaveToDisk(stream) {
    try {
        var fh = await saveFolderHandle.getFileHandle(stream.name, { create: true });
        stream.writable = await fh.createWritable({ keepExistingData: false });
        stream.streaming = true;
    } catch (e) {
        console.warn('File System Access write failed, falling back to memory:', e);
    }
}

function writeChunk(stream, chunk) {
    if (stream.streaming && stream.writable) {
        try {
            stream.writable.write(chunk);
        } catch (e) {
            stream.streaming = false;
            stream.chunks.push(chunk);
        }
    } else {
        stream.chunks.push(chunk);
    }
}

function finalizeRecvStream(msg) {
    var ci = msg.channelIndex;
    var stream = recvStreams[ci];
    if (!stream) return;

    if (stream.streaming && stream.writable) {
        try { stream.writable.close(); } catch (e) {}
    } else {
        var blob = new Blob(stream.chunks, { type: stream.mimeType });
        dlBlob(blob, stream.name);
    }

    addReceived(stream.name, stream.size);
    delete recvStreams[ci];

    $('progress-label').textContent = 'Received ' + stream.name;
    updateProgress(_rxTotalBytes > 0 ? _rxReceivedBytes / _rxTotalBytes : 1);
}

function dlBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 30000);
}

function addReceived(name, size) {
    _receivedCount++;
    _receivedBytes += size;
    var empty = $('received-empty');
    var text = $('received-text');
    if (empty) empty.classList.add('hidden');
    if (text) {
        text.classList.remove('hidden');
        text.innerHTML = '<span class="hit">' + _receivedCount + '</span> ' + (_receivedCount === 1 ? 'item' : 'items') + ' received · ' + formatSize(_receivedBytes);
    }
}

// ===================== PROGRESS UI =====================

function updateProgress(fraction) {
    var pct = Math.min(100, Math.round(fraction * 100));
    if (pct === _lastPct) return;
    _lastPct = pct;
    if (pct > 0 && pct < 100 && Date.now() - _throttleTimer < 100) return;
    _throttleTimer = Date.now();
    var s = $('liquid-sender');
    if (s) s.style.height = (100 - pct) + '%';
    var ps = $('pct-sender');
    if (ps) ps.textContent = pct + '%';
    var r = $('liquid-receiver');
    if (r) r.style.height = pct + '%';
    var pr = $('pct-receiver');
    if (pr) pr.textContent = pct + '%';
}

function showSuccess(elapsed, speed) {
    var wrap = document.querySelector('.liquid-wrap');
    if (wrap) wrap.classList.add('fade-out');
    var label = $('progress-label');
    if (label) label.textContent = '';
    var t = $('success-time'), sp = $('success-speed'), n = $('success-notification');
    if (t) t.textContent = fmtDuration(elapsed);
    if (sp) sp.textContent = fmtSpeed(speed);
    if (n) {
        n.classList.add('delayed');
        void n.offsetHeight;
        n.classList.add('show');
    }
}

function setProgressRole(sending) {
    var s = $('circle-sender'), r = $('circle-receiver'), a = document.querySelector('.liquid-arrow');
    if (!s || !r) return;
    if (sending) {
        s.style.display = ''; r.style.display = 'none';
        if (a) a.style.display = 'none';
    } else {
        s.style.display = 'none'; r.style.display = '';
        if (a) a.style.display = 'none';
    }
}

function resetProgressDisplay() {
    var wrap = document.querySelector('.liquid-wrap');
    if (wrap) { wrap.classList.remove('fade-out'); wrap.style.opacity = ''; wrap.style.transform = ''; }
    var notif = $('success-notification');
    if (notif) { notif.classList.remove('show', 'delayed'); }
    var s = $('circle-sender'), r = $('circle-receiver'), a = document.querySelector('.liquid-arrow');
    if (s) s.style.display = ''; if (r) r.style.display = ''; if (a) a.style.display = '';
}

// ===================== CONNECTION LIFECYCLE =====================

function disconnect() {
    if (ctrlDC) { try { ctrlDC.close(); } catch(_){} ctrlDC = null; }
    for (var i = 0; i < dataDCs.length; i++) {
        if (dataDCs[i]) { try { dataDCs[i].close(); } catch(_){} }
    }
    dataDCs = [];
    if (pc) { try { pc.close(); } catch(_){} pc = null; }
    isHost = false;
    autoConnected = false;
    fileQueue = [];
    recvStreams = {};
    pendingChunks = {};
    saveFolderHandle = null;
    saveFolderName = '';
    avgThroughput = 0;
    currentChunkSize = CHUNK_SIZE_BASE;
    _rxTotalBytes = 0;
    _rxReceivedBytes = 0;
    var fs = $('file-summary');
    if (fs) fs.classList.add('hidden');
    $('btn-send').classList.add('hidden');
    _receivedCount = 0;
    _receivedBytes = 0;
    _rxBatchStart = 0;
    resetProgressDisplay();
    if (qrHost) { qrHost.clear(); qrHost = null; }
    if (qrAnswer) { qrAnswer.clear(); qrAnswer = null; }
    stopCamera();
    $('progress-section').classList.add('hidden');
    $('file-input').value = '';
    var empty = $('received-empty'), text = $('received-text');
    if (empty) empty.classList.remove('hidden');
    if (text) text.classList.add('hidden');
    $('btn-save-folder').classList.add('hidden');
    $('save-folder-status').classList.add('hidden');
    showScreen('home');
}

// ===================== INIT =====================

function init() {
    $('btn-scan-answer').addEventListener('click', hostScanAnswer);
    $('btn-cancel-scan').addEventListener('click', function() { stopCamera(); showScreen('home'); });
    $('btn-back-host').addEventListener('click', disconnect);
    $('btn-select-files').addEventListener('click', selectFiles);
    $('file-input').addEventListener('change', onFilesSelected);
    $('btn-send').addEventListener('click', sendFiles);
    $('btn-clear-files').addEventListener('click', clearFiles);
    $('btn-disconnect').addEventListener('click', disconnect);
    var sfBtn = $('btn-save-folder');
    if (sfBtn && 'showDirectoryPicker' in window) {
        sfBtn.addEventListener('click', chooseSaveFolder);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        try { init(); } catch (e) { console.error('Init error:', e); }
    });
} else {
    try { init(); } catch (e) { console.error('Init error:', e); }
}

window.startHosting = startHosting;
window.startJoining = startJoining;
window.selectFiles = selectFiles;
window.sendFiles = sendFiles;
window.disconnect = disconnect;
window.chooseSaveFolder = chooseSaveFolder;

try {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(function() {});
    }
} catch (e) {}
