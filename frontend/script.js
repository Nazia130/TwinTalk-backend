// frontend/script.js
(() => {
  const socket = io();

  // DOM
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');
  const nameFromQuery = params.get('name') || '';
  const avatarUrlFromQuery = params.get('avatarUrl') || '';

  const meetingIdLabel = document.getElementById('meetingIdLabel');
  const inviteLink = document.getElementById('inviteLink');
  const copyInviteBtn = document.getElementById('copyInviteBtn');
  const muteBtn = document.getElementById('muteBtn');
  const videoBtn = document.getElementById('videoBtn');
  const avatarBtn = document.getElementById('avatarBtn');
  const leaveBtn = document.getElementById('leaveBtn');
  const endBtn = document.getElementById('endBtn');
  const participantsList = document.getElementById('participantsList');
  const chatBox = document.getElementById('chatBox');
  const chatInput = document.getElementById('chatInput');
  const sendChat = document.getElementById('sendChat');

  const localVideo = document.getElementById('localVideo');
  const videoGrid = document.getElementById('videoGrid');

  if (!roomId) {
    alert('No room id found. Go to home and join a meeting.');
    window.location.href = '/';
  }

  meetingIdLabel.innerText = roomId;
  const link = `${location.origin}/join.html?room=${encodeURIComponent(roomId)}`;
  inviteLink.href = link;
  inviteLink.innerText = link;

  // state
  let localStream = null;
  let audioEnabled = true;
  let videoEnabled = true;
  let isAvatar = false;
  let displayName = nameFromQuery || `User-${Math.floor(Math.random() * 1000)}`;
  let avatarUrl = avatarUrlFromQuery || null;

  const pcs = {}; // peerSocketId -> RTCPeerConnection
  const remoteVideoElements = {}; // peerSocketId -> HTML element

  // STUN config (use free Google STUN)
  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  // helper: create silent audio (avatar)
  async function createSilentAudioStream() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = ctx.createOscillator();
      const dst = oscillator.connect(ctx.createMediaStreamDestination());
      oscillator.start();
      const track = dst.stream.getAudioTracks()[0];
      return new MediaStream([track]);
    } catch (e) {
      console.warn('silent audio failed', e);
      return null;
    }
  }

  async function startLocalMedia(asAvatar = false) {
    try {
      if (asAvatar) {
        const s = await createSilentAudioStream();
        localStream = s;
        localVideo.style.display = 'none';
      } else {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        localVideo.style.display = 'block';
      }
      audioEnabled = localStream && localStream.getAudioTracks().length > 0;
      videoEnabled = localStream && localStream.getVideoTracks().length > 0;
    } catch (err) {
      console.warn('getUserMedia failed', err);
      // fallback to avatar
      const s = await createSilentAudioStream();
      localStream = s;
      localVideo.style.display = 'none';
      isAvatar = true;
      avatarBtn.innerText = 'Avatar Mode (On)';
    }
  }

  function toggleAudio() {
    if (!localStream) return;
    const tracks = localStream.getAudioTracks();
    if (tracks.length === 0) return;
    audioEnabled = !audioEnabled;
    tracks.forEach(t => (t.enabled = audioEnabled));
    muteBtn.innerText = audioEnabled ? 'Mute' : 'Unmute';
  }

  function toggleVideo() {
    if (!localStream) return;
    const tracks = localStream.getVideoTracks();
    if (!tracks || tracks.length === 0) {
      alert('No camera available.');
      return;
    }
    videoEnabled = !videoEnabled;
    tracks.forEach(t => (t.enabled = videoEnabled));
    videoBtn.innerText = videoEnabled ? 'Stop Video' : 'Start Video';
    localVideo.style.filter = videoEnabled ? 'none' : 'grayscale(80%)';
  }

  // UI helpers for video tiles
  function createRemoteTile(peerId, name, isAvatarFlag, avatarUrlLocal) {
    // container
    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${peerId}`;

    // media element: video or avatar img
    const mediaContainer = document.createElement('div');
    mediaContainer.style.width = '100%';
    mediaContainer.style.height = '260px';
    mediaContainer.style.position = 'relative';
    mediaContainer.style.overflow = 'hidden';

    // default element placeholder
    const videoEl = document.createElement('video');
    videoEl.setAttribute('autoplay', true);
    videoEl.setAttribute('playsinline', true);
    videoEl.id = `video-${peerId}`;

    const avatarImg = document.createElement('img');
    avatarImg.className = 'avatar';
    avatarImg.id = `avatar-${peerId}`;

    // label
    const label = document.createElement('div');
    label.className = 'label';
    label.innerText = name;

    tile.appendChild(mediaContainer);
    mediaContainer.appendChild(videoEl);
    mediaContainer.appendChild(avatarImg);
    tile.appendChild(label);

    videoGrid.appendChild(tile);

    // initially hide avatar or video depending on isAvatarFlag
    if (isAvatarFlag) {
      videoEl.style.display = 'none';
      avatarImg.style.display = 'block';
      if (avatarUrlLocal) avatarImg.src = avatarUrlLocal;
      else avatarImg.src = '/default-avatar.png'; // fallback; you can add default image
    } else {
      videoEl.style.display = 'block';
      avatarImg.style.display = 'none';
    }

    remoteVideoElements[peerId] = { tile, videoEl, avatarImg, label };
    return { tile, videoEl, avatarImg, label };
  }

  function removeRemoteTile(peerId) {
    const el = document.getElementById(`tile-${peerId}`);
    if (el) el.remove();
    if (remoteVideoElements[peerId]) delete remoteVideoElements[peerId];
  }

  // update participants list UI
  function renderParticipants(list) {
    participantsList.innerHTML = '';
    list.forEach(p => {
      const li = document.createElement('li');
      li.innerHTML = `<div>${p.name} ${p.isAvatar ? '<span style="font-size:12px;color:#888;">(Avatar)</span>' : ''}</div>
                      <div><small>${p.socketId === socket.id ? '(You)' : ''}</small></div>`;
      participantsList.appendChild(li);
    });
  }

  // Chat
  sendChat.addEventListener('click', () => {
    const msg = chatInput.value.trim();
    if (!msg) return;
    socket.emit('chat-message', { roomId, name: displayName, message: msg });
    chatInput.value = '';
  });

  socket.on('chat-message', ({ name, message, time }) => {
    const div = document.createElement('div');
    div.className = 'chat-message';
    const t = new Date(time || Date.now());
    div.innerHTML = `<span class="who">${name}:</span> <span class="what">${message}</span> <div style="font-size:11px;color:#888">${t.toLocaleTimeString()}</div>`;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  // participants events
  socket.on('participants-updated', (list) => {
    renderParticipants(list);
  });

  socket.on('user-joined', async ({ socketId, name, isAvatar: isAv, avatarUrl: avUrl }) => {
    // existing participants will wait for newcomer to initiate offers.
    // But if someone else joined while we are here, ensure UI shows their tile placeholder
    if (!remoteVideoElements[socketId]) {
      createRemoteTile(socketId, name, isAv, avUrl);
    }
    const note = document.createElement('div');
    note.className = 'chat-message';
    note.innerHTML = `<em>${name} joined</em>`;
    chatBox.appendChild(note);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on('user-left', ({ socketId }) => {
    removeRemoteTile(socketId);
    if (pcs[socketId]) {
      pcs[socketId].close();
      delete pcs[socketId];
    }
    const note = document.createElement('div');
    note.className = 'chat-message';
    note.innerHTML = `<em>A participant left</em>`;
    chatBox.appendChild(note);
    chatBox.scrollTop = chatBox.scrollHeight;
  });

  socket.on('meeting-ended', () => {
    alert('Meeting has been ended by the organizer.');
    window.location.href = '/';
  });

  // Signaling handlers
  socket.on('offer', async ({ fromSocketId, sdp, name, isAvatar: peerIsAvatar, avatarUrl: peerAvatarUrl }) => {
    // we received an offer from a peer; create PC, setRemoteDescription and answer
    console.log('Received offer from', fromSocketId);
    if (pcs[fromSocketId]) {
      console.warn('PC already exists for', fromSocketId);
      return;
    }
    const pc = createPeerConnection(fromSocketId, peerIsAvatar, peerAvatarUrl, false);
    pcs[fromSocketId] = pc;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socket.emit('answer', { toSocketId: fromSocketId, fromSocketId: socket.id, sdp: pc.localDescription });
    } catch (e) {
      console.error('Error handling offer', e);
    }
  });

  socket.on('answer', async ({ fromSocketId, sdp }) => {
    console.log('Received answer from', fromSocketId);
    const pc = pcs[fromSocketId];
    if (!pc) {
      console.warn('No PC for', fromSocketId);
      return;
    }
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  socket.on('ice-candidate', async ({ fromSocketId, candidate }) => {
    const pc = pcs[fromSocketId];
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn('Error adding ICE candidate', e);
    }
  });

  // create RTCPeerConnection and wire events
  function createPeerConnection(peerId, peerIsAvatar = false, peerAvatarUrl = null, isInitiator) {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    // add local tracks
    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        socket.emit('ice-candidate', { toSocketId: peerId, fromSocketId: socket.id, candidate: ev.candidate });
      }
    };

    pc.ontrack = (ev) => {
      // attach the remote stream to remote video element
      const remote = remoteVideoElements[peerId];
      if (remote) {
        // show video and hide avatar image
        remote.videoEl.style.display = 'block';
        remote.avatarImg.style.display = 'none';
        if (remote.videoEl.srcObject !== ev.streams[0]) {
          remote.videoEl.srcObject = ev.streams[0];
        }
      } else {
        // create tile if not exists
        const r = createRemoteTile(peerId, peerId, peerIsAvatar, peerAvatarUrl);
        r.videoEl.srcObject = ev.streams[0];
        r.videoEl.style.display = 'block';
        r.avatarImg.style.display = 'none';
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('PC connectionState for', peerId, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        removeRemoteTile(peerId);
        try { pc.close(); } catch (e) {}
        delete pcs[peerId];
      }
    };

    return pc;
  }

  // When we join we will:
  // - request current participants list from server (via participants-updated event which will be sent)
  // - create offer to each existing participant (newcomer-initiates)
  socket.on('connect', async () => {
    console.log('socket connected', socket.id);
  });

  // When participants-updated arrives, if we are the newcomer, initiate offers to everyone else.
  socket.on('participants-updated', async (list) => {
    renderParticipants(list);

    // ensure tiles exist for each participant (except us)
    list.forEach((p) => {
      if (p.socketId === socket.id) return;
      if (!remoteVideoElements[p.socketId]) createRemoteTile(p.socketId, p.name, p.isAvatar, p.avatarUrl);
    });

    // If we have local stream and there are peers we need to create offers to peers that don't have PCs yet
    for (const p of list) {
      if (p.socketId === socket.id) continue;
      if (!pcs[p.socketId]) {
        // create pc and make offer (we are newcomer or existing, both ok)
        const pc = createPeerConnection(p.socketId, p.isAvatar, p.avatarUrl, true);
        pcs[p.socketId] = pc;

        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('offer', { toSocketId: p.socketId, fromSocketId: socket.id, sdp: pc.localDescription, name: displayName, isAvatar, avatarUrl });
        } catch (e) {
          console.error('Error creating offer to', p.socketId, e);
        }
      }
    }
  });

  // UI actions: copy invite, leave, end, mute, video, avatar
  copyInviteBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(inviteLink.href);
      copyInviteBtn.innerText = 'Copied!';
      setTimeout(() => (copyInviteBtn.innerText = 'Copy Invite'), 2000);
    } catch (e) {
      alert('Copy failed');
    }
  });

  leaveBtn.addEventListener('click', () => {
    socket.emit('leave-room', { roomId });
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    // close PCs
    Object.values(pcs).forEach(pc => pc.close());
    window.location.href = '/';
  });

  endBtn.addEventListener('click', () => {
    if (!confirm('End meeting for everyone?')) return;
    socket.emit('end-meeting', { roomId });
    window.location.href = '/';
  });

  muteBtn.addEventListener('click', () => toggleAudio());
  videoBtn.addEventListener('click', () => toggleVideo());

  avatarBtn.addEventListener('click', async () => {
    if (isAvatar) {
      // switch back to camera if possible
      if (localStream) localStream.getTracks().forEach(t => t.stop());
      await startLocalMedia(false);
      isAvatar = false;
      avatarBtn.innerText = 'Avatar Mode';
      avatarUrl = null;
      // re-emit join to update server record
      socket.emit('join-room', { roomId, name: displayName, isAvatar: false, avatarUrl: null });
    } else {
      // switch to avatar (silent audio)
      if (localStream) localStream.getTracks().forEach(t => t.stop());
      await startLocalMedia(true);
      isAvatar = true;
      avatarBtn.innerText = 'Avatar Mode (On)';
      // ask user for avatar URL or keep existing
      const u = prompt('Paste avatar image URL (Ready Player Me or any image). Leave blank for default avatar:');
      if (u) avatarUrl = u;
      socket.emit('join-room', { roomId, name: displayName, isAvatar: true, avatarUrl: avatarUrl });
      // hide local video
      localVideo.style.display = 'none';
    }
  });

  // init: start local media and join
  (async function init() {
    await startLocalMedia(false);
    // show label
    const localLabel = document.getElementById('localLabel');
    localLabel.innerText = displayName + (isAvatar ? ' (Avatar)' : ' (You)');

    // show local video in tile (already set by startLocalMedia)
    if (localStream && localStream.getVideoTracks().length > 0) {
      localVideo.srcObject = localStream;
      localVideo.play().catch(() => {});
    }

    // emit join-room with avatar info
    socket.emit('join-room', { roomId, name: displayName, isAvatar: !!avatarUrlFromQuery || isAvatar, avatarUrl: avatarUrlFromQuery || avatarUrl });
  })();
})();
