/**
 * run on windows
 * environment
 */

import { Device } from 'mediasoup-client';
import { io } from 'socket.io-client';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3000';
const TOKEN_KEY = 'rtc_access_token';

const loginForm = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const btnLogin = document.getElementById('btnLogin');
const btnLogout = document.getElementById('btnLogout');
const btnRefreshUsers = document.getElementById('btnRefreshUsers');
const btnConnect = document.getElementById('btnConnect');
const btnPublish = document.getElementById('btnPublish');
const btnLeaveRoom = document.getElementById('btnLeaveRoom');
const btnEndRoom = document.getElementById('btnEndRoom');
const btnToggleMic = document.getElementById('btnToggleMic');
const btnToggleCamera = document.getElementById('btnToggleCamera');
const roomInput = document.getElementById('roomId');
const currentRoomDiv = document.getElementById('currentRoom');
const onlineUsersDiv = document.getElementById('onlineUsers');
const incomingInvitesDiv = document.getElementById('incomingInvites');
const roomMembersDiv = document.getElementById('roomMembers');
const statusDiv = document.getElementById('status');
const mediaStateDiv = document.getElementById('mediaState');
const localVideo = document.getElementById('localVideo');
const remoteContainer = document.getElementById('remoteContainer');

let socket = null;
let authToken = localStorage.getItem(TOKEN_KEY) || '';
let currentUser = null;
let currentRoomId = '';
let joinedRoomId = '';
let isJoinedRoomCreator = false;
let roomMembers = [];
let isTogglingMic = false;
let isTogglingCamera = false;

let device;
let sendTransport;
let localStream = null;

const recvTransports = new Map();
const producers = new Map();
const consumers = new Map();
const consumedProducerIds = new Set();
const consumersByProducer = new Map();
const pendingProducerIds = new Set();
let isFlushingPendingProducers = false;

function setStatus(text) {
  statusDiv.innerText = text;
}

function getLocalProducerByKind(kind) {
  for (const producer of producers.values()) {
    if (producer.kind === kind && !producer.closed) {
      return producer;
    }
  }

  return null;
}

function refreshMediaControls() {
  const audioTrack = localStream?.getAudioTracks()[0];
  const videoTrack = localStream?.getVideoTracks()[0];
  const audioProducer = getLocalProducerByKind('audio');
  const videoProducer = getLocalProducerByKind('video');
  const isMicPaused = Boolean(audioProducer?.paused);
  const isCameraPaused = Boolean(videoProducer?.paused);

  btnToggleMic.disabled = !audioProducer || isTogglingMic;
  btnToggleCamera.disabled = !videoProducer || isTogglingCamera;
  btnToggleMic.textContent = isMicPaused ? 'Unmute Mic' : 'Mute Mic';
  btnToggleCamera.textContent = isCameraPaused ? 'Turn Camera On' : 'Turn Camera Off';

  if (!localStream) {
    mediaStateDiv.innerText = 'Local media not started';
    return;
  }

  mediaStateDiv.innerText =
    `Microphone: ${audioProducer ? (isMicPaused ? 'muted' : 'on') : (audioTrack ? 'ready' : 'off')} | ` +
    `Camera: ${videoProducer ? (isCameraPaused ? 'off' : 'on') : (videoTrack ? 'ready' : 'off')}`;
}

function renderRoomMembers(members = []) {
  roomMembersDiv.innerHTML = '';

  if (!members.length) {
    roomMembersDiv.innerHTML = '<div>No room members</div>';
    return;
  }

  for (const member of members) {
    const row = document.createElement('div');
    row.className = 'member-row';

    const name = document.createElement('div');
    const isCurrentUser = String(member.id) === String(currentUser?.id || '');
    name.textContent = isCurrentUser ? `${member.username} (You)` : member.username;

    const meta = document.createElement('div');
    meta.className = 'member-meta';

    if (member.isCreator) {
      const creatorBadge = document.createElement('span');
      creatorBadge.className = 'member-badge';
      creatorBadge.textContent = 'Host';
      meta.appendChild(creatorBadge);
    }

    const state = document.createElement('span');
    state.className = 'member-state';
    state.textContent = member.isJoined ? 'In room' : 'Invited';
    meta.appendChild(state);

    row.appendChild(name);
    row.appendChild(meta);
    roomMembersDiv.appendChild(row);
  }
}

function setRoomMembers(members = []) {
  roomMembers = Array.isArray(members) ? members : [];

  if (joinedRoomId && currentUser) {
    const me = roomMembers.find((member) => String(member.id) === String(currentUser.id));
    isJoinedRoomCreator = Boolean(me?.isCreator);
  }

  renderRoomMembers(roomMembers);
  refreshRoomActionButtons();
}

function refreshRoomActionButtons() {
  const hasCurrentRoom = Boolean(currentRoomId);
  const hasJoinedRoom = Boolean(joinedRoomId);

  btnConnect.disabled = !authToken || !hasCurrentRoom || joinedRoomId === currentRoomId;
  btnPublish.disabled = !hasJoinedRoom || !sendTransport;
  btnLeaveRoom.disabled = !hasJoinedRoom;
  btnEndRoom.disabled = !hasJoinedRoom || !isJoinedRoomCreator;
}

function setCurrentRoom(roomId) {
  currentRoomId = roomId || '';
  if (!currentRoomId) {
    isJoinedRoomCreator = false;
    setRoomMembers([]);
  }
  roomInput.value = currentRoomId;
  currentRoomDiv.innerText = currentRoomId
    ? `Current room: ${currentRoomId}`
    : 'Current room: (none)';
  refreshRoomActionButtons();
}

function clearInvites() {
  incomingInvitesDiv.innerHTML = '';
}

function stopLocalStream() {
  if (!localStream) return;
  for (const track of localStream.getTracks()) {
    track.stop();
  }
  localStream = null;
  refreshMediaControls();
}

function setLoggedInUI(loggedIn) {
  btnLogout.disabled = !loggedIn;
  btnLogin.disabled = false;
  btnRefreshUsers.disabled = !loggedIn;

  if (!loggedIn) {
    setCurrentRoom('');
    onlineUsersDiv.innerHTML = '<div>No online users</div>';
    clearInvites();
  } else {
    refreshRoomActionButtons();
  }
}

function resetMediaState() {
  for (const consumer of consumers.values()) {
    try {
      consumer.close();
    } catch {}
  }

  for (const producer of producers.values()) {
    try {
      producer.close();
    } catch {}
  }

  for (const transport of recvTransports.values()) {
    try {
      transport.close();
    } catch {}
  }

  if (sendTransport) {
    try {
      sendTransport.close();
    } catch {}
  }

  consumers.clear();
  producers.clear();
  recvTransports.clear();
  consumersByProducer.clear();
  consumedProducerIds.clear();
  pendingProducerIds.clear();

  stopLocalStream();

  device = undefined;
  sendTransport = undefined;
  joinedRoomId = '';
  isJoinedRoomCreator = false;
  isTogglingMic = false;
  isTogglingCamera = false;
  localVideo.srcObject = null;
  remoteContainer.innerHTML = '';
  setRoomMembers([]);
  refreshRoomActionButtons();
  refreshMediaControls();
}

function closeRoomLocally(roomId = currentRoomId) {
  const shouldClearCurrentRoom =
    !roomId || currentRoomId === roomId || joinedRoomId === roomId;

  resetMediaState();

  if (shouldClearCurrentRoom) {
    setCurrentRoom('');
    return;
  }

  refreshRoomActionButtons();
}

function ensureSocket() {
  if (!authToken) throw new Error('Please login first');

  if (socket) {
    if (!socket.connected) socket.connect();
    return socket;
  }

  socket = io(SERVER_URL, {
    autoConnect: false,
    auth: { token: authToken }
  });

  socket.on('connect_error', (err) => {
    const message = String(err.message || '');
    console.error('socket connect error:', message);
    if (message.startsWith('UNAUTHORIZED')) {
      doLogout('Login expired, please login again');
      return;
    }
    if (message.startsWith('ALREADY_ONLINE')) {
      doLogout('This account is already online on another page');
      return;
    }
    setStatus(`Connection error: ${message}`);
  });

  socket.on('onlineUsers', ({ users }) => {
    renderOnlineUsers(users || []);
  });

  socket.on('incomingInvite', (invite) => {
    renderIncomingInvite(invite);
  });

  socket.on('inviteResponded', ({ accepted, roomId, by }) => {
    if (accepted) {
      setCurrentRoom(roomId);
      setStatus(`${by.username} accepted your invite. You can connect now.`);
      return;
    }
    setStatus(`${by.username} rejected your invite`);
  });

  socket.on('inviteCanceled', ({ reason, roomId }) => {
    removeInviteCardByRoom(roomId);
    if (currentRoomId === roomId && !joinedRoomId) {
      setCurrentRoom('');
    }
    setStatus(reason || 'Invite canceled');
  });

  socket.on('peerLeft', ({ roomId, user, reason }) => {
    if (joinedRoomId && roomId !== joinedRoomId) return;
    setStatus(`${user.username} ${reason || 'left the room'}`);
  });

  socket.on('roomEnded', ({ roomId, reason }) => {
    closeRoomLocally(roomId);
    setStatus(reason || 'The room has ended');
  });

  socket.on('roomMembersUpdate', ({ roomId, members }) => {
    if (roomId !== currentRoomId && roomId !== joinedRoomId) return;
    setRoomMembers(members);
  });

  socket.on('newProducer', ({ producerId }) => {
    enqueueProducerForConsume(producerId);
  });

  socket.on('producerClosed', ({ producerId }) => {
    const consumer = consumersByProducer.get(producerId);
    if (consumer) {
      try {
        consumer.close();
      } catch {}
      consumers.delete(consumer.id);
      consumersByProducer.delete(producerId);
    }
    consumedProducerIds.delete(producerId);
    pendingProducerIds.delete(producerId);
    removeRemoteMedia(producerId);
  });

  socket.on('forceLogout', ({ reason }) => {
    doLogout(reason || 'You have been logged out');
  });

  socket.on('disconnect', () => {
    closeRoomLocally();
    setStatus('Disconnected from server');
  });

  socket.connect();
  return socket;
}

async function waitForSocketConnected() {
  const s = ensureSocket();
  if (s.connected) return;

  await new Promise((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      s.off('connect', onConnect);
      s.off('connect_error', onError);
    };

    s.on('connect', onConnect);
    s.on('connect_error', onError);
  });
}

const request = (type, data = {}) => {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      reject(new Error('socket not connected'));
      return;
    }

    socket.emit(type, data, (response) => {
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
};

function removeInviteCardById(inviteId) {
  const card = document.getElementById(`invite-${inviteId}`);
  if (card) card.remove();
}

function removeInviteCardByRoom(roomId) {
  const card = document.querySelector(`[data-room-id="${roomId}"]`);
  if (card) card.remove();
}

function renderIncomingInvite(invite) {
  if (!invite || !invite.inviteId) return;
  if (document.getElementById(`invite-${invite.inviteId}`)) return;

  const card = document.createElement('div');
  card.id = `invite-${invite.inviteId}`;
  card.dataset.roomId = invite.roomId;
  card.style.border = '1px solid #3a3a3a';
  card.style.borderRadius = '8px';
  card.style.padding = '10px';
  card.style.marginBottom = '8px';
  card.style.display = 'flex';
  card.style.justifyContent = 'space-between';
  card.style.alignItems = 'center';
  card.style.gap = '10px';

  const text = document.createElement('div');
  text.textContent = `${invite.fromUser.username} invited you to room ${invite.roomId}`;

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';

  const btnAccept = document.createElement('button');
  btnAccept.textContent = 'Accept';

  const btnReject = document.createElement('button');
  btnReject.textContent = 'Reject';

  btnAccept.addEventListener('click', async () => {
    btnAccept.disabled = true;
    btnReject.disabled = true;
    try {
      const result = await request('respondRoomInvite', {
        inviteId: invite.inviteId,
        accept: true
      });
      if (result.accepted) {
        setCurrentRoom(result.roomId);
        setStatus(`Invite accepted. Room ready: ${result.roomId}`);
      }
    } catch (err) {
      setStatus(`Accept invite failed: ${err.message}`);
    } finally {
      removeInviteCardById(invite.inviteId);
    }
  });

  btnReject.addEventListener('click', async () => {
    btnAccept.disabled = true;
    btnReject.disabled = true;
    try {
      await request('respondRoomInvite', {
        inviteId: invite.inviteId,
        accept: false
      });
      setStatus('Invite rejected');
    } catch (err) {
      setStatus(`Reject invite failed: ${err.message}`);
    } finally {
      removeInviteCardById(invite.inviteId);
    }
  });

  actions.appendChild(btnAccept);
  actions.appendChild(btnReject);

  card.appendChild(text);
  card.appendChild(actions);
  incomingInvitesDiv.appendChild(card);
}

function renderOnlineUsers(users) {
  onlineUsersDiv.innerHTML = '';

  if (!users.length) {
    onlineUsersDiv.innerHTML = '<div>No online users</div>';
    return;
  }

  for (const user of users) {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.alignItems = 'center';
    row.style.border = '1px solid #313131';
    row.style.padding = '8px 10px';
    row.style.borderRadius = '8px';
    row.style.marginBottom = '8px';

    const name = document.createElement('span');
    name.textContent = user.username;

    const btnInvite = document.createElement('button');
    btnInvite.textContent = 'Invite';
    btnInvite.addEventListener('click', async () => {
      btnInvite.disabled = true;
      try {
        const inviteRoomId = joinedRoomId || currentRoomId;
        const result = await request('createRoomInvite', {
          targetUserId: user.id,
          roomId: inviteRoomId || undefined
        });
        setCurrentRoom(result.roomId);
        setStatus(`Invite sent to ${user.username}, room ${result.roomId}`);
      } catch (err) {
        setStatus(`Invite failed: ${err.message}`);
      } finally {
        btnInvite.disabled = false;
      }
    });

    row.appendChild(name);
    row.appendChild(btnInvite);
    onlineUsersDiv.appendChild(row);
  }
}

async function refreshOnlineUsers() {
  try {
    await waitForSocketConnected();
    const { users } = await request('getOnlineUsers');
    renderOnlineUsers(users || []);
  } catch (err) {
    setStatus(`Load users failed: ${err.message}`);
  }
}

async function doLogin(event) {
  event?.preventDefault();
  btnLogin.disabled = true;

  try {
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      throw new Error('Username and password are required');
    }

    const resp = await fetch(`${SERVER_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || 'Login failed');
    }

    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem(TOKEN_KEY, authToken);

    await waitForSocketConnected();
    setLoggedInUI(true);
    await refreshOnlineUsers();
    setStatus(`Logged in as ${currentUser.username}`);
  } catch (err) {
    console.error(err);
    doLogout(`Login failed: ${err.message}`);
  } finally {
    btnLogin.disabled = false;
  }
}

function doLogout(message = 'Logged out') {
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  authToken = '';
  currentUser = null;
  localStorage.removeItem(TOKEN_KEY);
  resetMediaState();
  clearInvites();
  setLoggedInUI(false);
  setStatus(message);
}

loginForm.addEventListener('submit', doLogin);
btnLogout.addEventListener('click', () => doLogout());
btnRefreshUsers.addEventListener('click', refreshOnlineUsers);
btnToggleMic.addEventListener('click', async () => {
  const audioProducer = getLocalProducerByKind('audio');
  if (!audioProducer || isTogglingMic) return;

  isTogglingMic = true;
  refreshMediaControls();

  try {
    if (audioProducer.paused) {
      audioProducer.resume();
      await request('resumeProducer', { producerId: audioProducer.id });
      setStatus('Microphone unmuted');
    } else {
      audioProducer.pause();
      await request('pauseProducer', { producerId: audioProducer.id });
      setStatus('Microphone muted');
    }
  } catch (err) {
    console.error(err);

    if (audioProducer.paused) {
      audioProducer.resume();
    } else {
      audioProducer.pause();
    }

    setStatus(`Microphone toggle failed: ${err.message}`);
  } finally {
    isTogglingMic = false;
    refreshMediaControls();
  }
});

btnToggleCamera.addEventListener('click', async () => {
  const videoProducer = getLocalProducerByKind('video');
  if (!videoProducer || isTogglingCamera) return;

  isTogglingCamera = true;
  refreshMediaControls();

  try {
    if (videoProducer.paused) {
      videoProducer.resume();
      await request('resumeProducer', { producerId: videoProducer.id });
      setStatus('Camera turned on');
    } else {
      videoProducer.pause();
      await request('pauseProducer', { producerId: videoProducer.id });
      setStatus('Camera turned off');
    }
  } catch (err) {
    console.error(err);

    if (videoProducer.paused) {
      videoProducer.resume();
    } else {
      videoProducer.pause();
    }

    setStatus(`Camera toggle failed: ${err.message}`);
  } finally {
    isTogglingCamera = false;
    refreshMediaControls();
  }
});

btnConnect.addEventListener('click', async () => {
  try {
    await waitForSocketConnected();
    if (!currentRoomId) {
      throw new Error('No room selected. Create or accept an invite first.');
    }

    if (joinedRoomId && joinedRoomId !== currentRoomId) {
      resetMediaState();
    }

    setStatus(`Joining room ${currentRoomId}...`);
    const { rtpCapabilities, existingProducers, isCreator, members } = await request('joinRoom', {
      roomId: currentRoomId
    });

    device = new Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    await createSendTransport();

    joinedRoomId = currentRoomId;
    isJoinedRoomCreator = Boolean(isCreator);
    setRoomMembers(members);
    refreshRoomActionButtons();
    setStatus(`Joined room ${currentRoomId}`);

    for (const { producerId } of existingProducers) {
      enqueueProducerForConsume(producerId);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Join failed: ${err.message}`);
  }
});

btnLeaveRoom.addEventListener('click', async () => {
  if (!joinedRoomId) return;

  const roomId = joinedRoomId;
  btnLeaveRoom.disabled = true;

  try {
    await request('leaveRoom');
    closeRoomLocally(roomId);
    setStatus(`Left room ${roomId}`);
  } catch (err) {
    console.error(err);
    setStatus(`Leave room failed: ${err.message}`);
    refreshRoomActionButtons();
  }
});

btnEndRoom.addEventListener('click', async () => {
  if (!joinedRoomId) return;

  const roomId = joinedRoomId;
  btnEndRoom.disabled = true;

  try {
    await request('endRoom');
    closeRoomLocally(roomId);
    setStatus(`Ended room ${roomId}`);
  } catch (err) {
    console.error(err);
    setStatus(`End call failed: ${err.message}`);
    refreshRoomActionButtons();
  }
});

async function createSendTransport() {
  const params = await request('createWebRtcTransport', { direction: 'send' });
  sendTransport = device.createSendTransport(params);

  sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    try {
      await request('connectTransport', {
        transportId: sendTransport.id,
        dtlsParameters
      });
      callback();
    } catch (err) {
      errback(err);
    }
  });

  sendTransport.on('produce', async (parameters, callback, errback) => {
    try {
      const { id } = await request('produce', {
        transportId: sendTransport.id,
        kind: parameters.kind,
        rtpParameters: parameters.rtpParameters
      });
      callback({ id });
    } catch (err) {
      errback(err);
    }
  });
}

btnPublish.addEventListener('click', async () => {
  try {
    if (!sendTransport) {
      throw new Error('Please connect room first');
    }

    if (localStream) {
      setStatus('Already publishing');
      return;
    }

    setStatus('Publishing audio/video...');

    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    localVideo.srcObject = localStream;
    localVideo.muted = true;
    await localVideo.play();

    const videoTrack = localStream.getVideoTracks()[0];
    const audioTrack = localStream.getAudioTracks()[0];

    if (videoTrack) {
      const videoProducer = await sendTransport.produce({ track: videoTrack });
      producers.set(videoProducer.id, videoProducer);

      videoProducer.observer.on('pause', refreshMediaControls);
      videoProducer.observer.on('resume', refreshMediaControls);

      videoProducer.on('trackended', () => {
        producers.delete(videoProducer.id);
        refreshMediaControls();
      });

      videoProducer.on('transportclose', () => {
        producers.delete(videoProducer.id);
        refreshMediaControls();
      });
    }

    if (audioTrack) {
      const audioProducer = await sendTransport.produce({ track: audioTrack });
      producers.set(audioProducer.id, audioProducer);

      audioProducer.observer.on('pause', refreshMediaControls);
      audioProducer.observer.on('resume', refreshMediaControls);

      audioProducer.on('trackended', () => {
        producers.delete(audioProducer.id);
        refreshMediaControls();
      });

      audioProducer.on('transportclose', () => {
        producers.delete(audioProducer.id);
        refreshMediaControls();
      });
    }

    setStatus('Publishing audio/video');
    refreshMediaControls();
  } catch (err) {
    console.error(err);
    stopLocalStream();
    localVideo.srcObject = null;
    setStatus(`Publish failed: ${err.message}`);
  }
});

async function consumeProducer(producerId) {
  if (!device) {
    throw new Error('Device not ready, please join room first');
  }

  if (consumedProducerIds.has(producerId)) return;
  consumedProducerIds.add(producerId);

  try {
    const data = await request('consume', {
      producerId,
      rtpCapabilities: device.rtpCapabilities
    });

    const { transportOptions, consumerOptions } = data;
    let recvTransport = recvTransports.get(transportOptions.id);

    if (!recvTransport) {
      recvTransport = device.createRecvTransport(transportOptions);
      recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          await request('connectTransport', {
            transportId: recvTransport.id,
            dtlsParameters
          });
          callback();
        } catch (err) {
          errback(err);
        }
      });

      recvTransports.set(transportOptions.id, recvTransport);
    }

    const consumer = await recvTransport.consume(consumerOptions);
    consumers.set(consumer.id, consumer);
    consumersByProducer.set(producerId, consumer);

    consumer.on('transportclose', () => {
      consumers.delete(consumer.id);
      consumersByProducer.delete(producerId);
      consumedProducerIds.delete(producerId);
      removeRemoteMedia(producerId);
    });

    consumer.on('producerclose', () => {
      consumers.delete(consumer.id);
      consumersByProducer.delete(producerId);
      consumedProducerIds.delete(producerId);
      removeRemoteMedia(producerId);
    });

    const stream = new MediaStream([consumer.track]);
    addRemoteMedia(stream, producerId, consumer.kind);

    await request('resume', { consumerId: consumer.id });
  } catch (err) {
    consumedProducerIds.delete(producerId);
    throw err;
  }
}

function enqueueProducerForConsume(producerId) {
  if (!producerId) return;
  if (consumedProducerIds.has(producerId) || pendingProducerIds.has(producerId)) return;

  pendingProducerIds.add(producerId);
  void flushPendingProducers();
}

async function flushPendingProducers() {
  if (isFlushingPendingProducers) return;
  if (!device || !joinedRoomId) return;

  isFlushingPendingProducers = true;

  try {
    for (const producerId of [...pendingProducerIds]) {
      try {
        await consumeProducer(producerId);
      } catch (err) {
        console.error('auto consume failed:', err.message);
        setStatus(`Auto consume failed: ${err.message}`);
      } finally {
        pendingProducerIds.delete(producerId);
      }
    }
  } finally {
    isFlushingPendingProducers = false;

    if (pendingProducerIds.size > 0 && device && joinedRoomId) {
      void flushPendingProducers();
    }
  }
}

function addRemoteMedia(stream, producerId, kind) {
  if (document.getElementById(`remote-${producerId}`)) return;

  const row = getOrCreateProducerRow(producerId);

  if (kind === 'audio') {
    const audio = document.createElement('audio');
    audio.id = `remote-${producerId}`;
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.controls = true;
    row.appendChild(audio);
    return;
  }

  const video = document.createElement('video');
  video.id = `remote-${producerId}`;
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = false;
  video.controls = true;
  video.style.width = '300px';
  video.style.margin = '5px';

  row.appendChild(video);
}

function removeRemoteMedia(producerId) {
  const media = document.getElementById(`remote-${producerId}`);
  if (media) media.remove();

  const row = document.getElementById(`row-${producerId}`);
  if (row && row.children.length === 0) row.remove();
}

function getOrCreateProducerRow(producerId) {
  const rowId = `row-${producerId}`;
  let row = document.getElementById(rowId);
  if (row) return row;

  row = document.createElement('div');
  row.id = rowId;
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  row.style.flexWrap = 'wrap';
  row.style.gap = '8px';
  row.style.margin = '6px 0';
  remoteContainer.appendChild(row);
  return row;
}

if (authToken) {
  waitForSocketConnected()
    .then(async () => {
      setLoggedInUI(true);
      await refreshOnlineUsers();
      setStatus('Token restored');
    })
    .catch(() => {
      doLogout('Stored login is invalid, please login again');
    });
} else {
  setLoggedInUI(false);
  setStatus('Please login');
}
