const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json({ limit: '2mb' }));

// 1. Explicit Root & Dedicated Route Endpoints (/host, /screen, /play, /)
app.get(['/host', '/host.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get(['/screen', '/screen.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'screen.html'));
});

app.get(['/', '/play'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve static assets from /public
app.use(express.static(path.join(__dirname, 'public')));

// Create a completely empty initial board (Single Jeopardy, optional Double Jeopardy, Final Jeopardy)
function createEmptyGameSchema() {
  const singlePoints = [200, 400, 600, 800, 1000];
  const doublePoints = [400, 800, 1200, 1600, 2000];

  const buildCategories = (ptsArray, roundPrefix) =>
    Array.from({ length: 5 }, (_, cIdx) => ({
      title: '',
      clues: ptsArray.map((pts, qIdx) => ({
        id: `${roundPrefix}_c${cIdx}_q${qIdx}`,
        points: pts,
        question: '',
        answer: '',
        used: false
      }))
    }));

  return {
    title: 'Custom Jeopardy! Game',
    enableDoubleJeopardy: false,
    jeopardy: {
      name: 'Single Jeopardy',
      categories: buildCategories(singlePoints, 'r0')
    },
    doubleJeopardy: {
      name: 'Double Jeopardy',
      categories: buildCategories(doublePoints, 'r1')
    },
    finalJeopardy: {
      category: '',
      question: '',
      answer: '',
      timerDuration: 30
    }
  };
}

function isRoundComplete(round) {
  if (!round || !Array.isArray(round.categories) || round.categories.length === 0) return false;
  for (const cat of round.categories) {
    if (!cat.title || !String(cat.title).trim()) return false;
    if (!Array.isArray(cat.clues) || cat.clues.length === 0) return false;
    for (const clue of cat.clues) {
      if (!clue.question || !String(clue.question).trim()) return false;
      if (!clue.answer || !String(clue.answer).trim()) return false;
      if (Number.isNaN(Number(clue.points)) || Number(clue.points) <= 0) return false;
    }
  }
  return true;
}

// Convert unified { enableDoubleJeopardy, jeopardy, doubleJeopardy, finalJeopardy } into internal room structure
function normalizeGamePayload(payload = {}) {
  const empty = createEmptyGameSchema();

  let singleCats = null;
  let doubleCats = null;

  if (payload.jeopardy && Array.isArray(payload.jeopardy.categories)) {
    singleCats = payload.jeopardy.categories;
  } else if (Array.isArray(payload.jeopardy)) {
    singleCats = payload.jeopardy;
  } else if (Array.isArray(payload.rounds) && payload.rounds[0]) {
    singleCats = payload.rounds[0].categories;
  } else if (Array.isArray(payload.categories)) {
    singleCats = payload.categories;
  }

  if (payload.doubleJeopardy && Array.isArray(payload.doubleJeopardy.categories)) {
    doubleCats = payload.doubleJeopardy.categories;
  } else if (Array.isArray(payload.doubleJeopardy)) {
    doubleCats = payload.doubleJeopardy;
  } else if (Array.isArray(payload.rounds) && payload.rounds[1]) {
    doubleCats = payload.rounds[1].categories;
  }

  const sanitizeCategories = (cats, defaultBasePts, prefix) => {
    const source =
      Array.isArray(cats) && cats.length > 0
        ? cats
        : empty[prefix === 'r0' ? 'jeopardy' : 'doubleJeopardy'].categories;
    return source.map((cat, cIdx) => ({
      title: String(cat?.title ?? cat?.name ?? '').trim(),
      clues: (Array.isArray(cat?.clues) && cat.clues.length > 0 ? cat.clues : [0, 1, 2, 3, 4]).map(
        (clue, qIdx) => ({
          id: `${prefix}_c${cIdx}_q${qIdx}`,
          points: Number(clue?.points ?? clue?.value) || (qIdx + 1) * defaultBasePts,
          question: String(clue?.question ?? clue?.clue ?? clue?.prompt ?? '').trim(),
          answer: String(clue?.answer ?? clue?.response ?? '').trim(),
          used: Boolean(clue?.used)
        })
      )
    }));
  };

  const singleRound = {
    key: 'jeopardy',
    name: 'Single Jeopardy',
    categories: sanitizeCategories(singleCats, 200, 'r0')
  };

  const doubleRound = {
    key: 'doubleJeopardy',
    name: 'Double Jeopardy',
    categories: sanitizeCategories(doubleCats, 400, 'r1')
  };

  // Determine whether Double Jeopardy is enabled:
  // If explicitly passed as boolean, honor it; otherwise auto-enable if doubleRound has any filled content
  let enableDoubleJeopardy = false;
  if (typeof payload.enableDoubleJeopardy === 'boolean') {
    enableDoubleJeopardy = payload.enableDoubleJeopardy;
  } else {
    enableDoubleJeopardy = isRoundComplete(doubleRound);
  }

  const rounds = [singleRound, doubleRound];

  const fjRaw = payload.finalJeopardy || {};
  const dur = Number(fjRaw.timerDuration);
  const finalJeopardy = {
    category: String(fjRaw.category ?? '').trim(),
    question: String(fjRaw.question ?? fjRaw.clue ?? fjRaw.prompt ?? '').trim(),
    answer: String(fjRaw.answer ?? fjRaw.response ?? '').trim(),
    timerDuration: !Number.isNaN(dur) && dur >= 5 && dur <= 300 ? dur : 30
  };

  return {
    title: String(payload.title || 'Custom Jeopardy! Game').trim(),
    enableDoubleJeopardy,
    rounds,
    finalJeopardy
  };
}

// Active rooms map (uncapped player capacity)
const rooms = new Map();

function generateRandomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms.has(code));
  return code;
}

function sanitizeRoomCode(raw) {
  if (!raw) return '';
  return String(raw).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12);
}

// Board completeness check: Double Jeopardy is only required when room.enableDoubleJeopardy is true
function isBoardComplete(rounds, enableDoubleJeopardy = false) {
  if (!Array.isArray(rounds) || !rounds[0]) return false;
  if (!isRoundComplete(rounds[0])) return false;
  if (enableDoubleJeopardy) {
    return Boolean(rounds[1] && isRoundComplete(rounds[1]));
  }
  return true;
}

function isCurrentRoundExhausted(round) {
  if (!round || !Array.isArray(round.categories) || round.categories.length === 0) return false;
  return round.categories.every((c) => c.clues.every((q) => Boolean(q.used)));
}

function areAllActiveCluesUsed(room) {
  if (!room || !Array.isArray(room.rounds) || !room.rounds[0]) return false;
  if (!isCurrentRoundExhausted(room.rounds[0])) return false;
  if (room.enableDoubleJeopardy && room.rounds[1]) {
    return isCurrentRoundExhausted(room.rounds[1]);
  }
  return true;
}

function createRoom(requestedCustomCode) {
  const cleanCustom = sanitizeRoomCode(requestedCustomCode);
  const code = cleanCustom && !rooms.has(cleanCustom) ? cleanCustom : generateRandomCode();
  const normalized = normalizeGamePayload(createEmptyGameSchema());

  const room = {
    code,
    hostSocketId: null,
    title: normalized.title,
    enableDoubleJeopardy: normalized.enableDoubleJeopardy,
    gameStarted: false,
    rounds: normalized.rounds,
    currentRoundIndex: 0, // 0 = Single Jeopardy, 1 = Double Jeopardy (if enabled)
    players: new Map(), // Uncapped Map of connected teams/players
    activeClue: null,
    buzzerOpen: false,
    buzzedPlayerId: null,
    buzzedPlayerName: null,
    lockedOutPlayerIds: new Set(),
    finalJeopardy: {
      active: false,
      stage: 'setup', // 'setup' | 'wager' | 'clue' | 'grading'
      category: normalized.finalJeopardy.category,
      question: normalized.finalJeopardy.question,
      answer: normalized.finalJeopardy.answer,
      timerDuration: normalized.finalJeopardy.timerDuration,
      timeLeft: normalized.finalJeopardy.timerDuration,
      timerInterval: null,
      answerRevealed: false,
      wagers: {},
      responses: {},
      judged: {}
    },
    lastActionMessage: 'Lobby open with 0 players. Configure Single Jeopardy (and optional Double / Final Jeopardy) to start.',
    gameEnded: false,
    podium: []
  };

  rooms.set(code, room);
  return room;
}

function clearFinalTimer(room) {
  if (room && room.finalJeopardy && room.finalJeopardy.timerInterval) {
    clearInterval(room.finalJeopardy.timerInterval);
    room.finalJeopardy.timerInterval = null;
  }
}

// Zero-Spoiler Policy: When isHost is false (for /screen and /play), secret answers are strictly stripped
function serializeRoom(room, isHost = false) {
  const rounds = room.rounds.map((round, rIdx) => ({
    key: round.key || (rIdx === 0 ? 'jeopardy' : 'doubleJeopardy'),
    name: round.name || (rIdx === 0 ? 'Single Jeopardy' : 'Double Jeopardy'),
    categories: round.categories.map((cat, cIdx) => ({
      title: cat.title || '',
      clues: cat.clues.map((clue, qIdx) => ({
        id: clue.id || `r${rIdx}_c${cIdx}_q${qIdx}`,
        points: Number(clue.points) || (rIdx === 0 ? 200 : 400) * (qIdx + 1),
        question: isHost ? clue.question : '',
        answer: isHost ? clue.answer : undefined,
        used: Boolean(clue.used)
      }))
    }))
  }));

  const playersList = Array.from(room.players.values()).sort((a, b) => b.score - a.score);
  const fj = room.finalJeopardy;
  const currentRound = room.rounds[room.currentRoundIndex];

  return {
    code: room.code,
    title: room.title,
    enableDoubleJeopardy: Boolean(room.enableDoubleJeopardy),
    gameStarted: room.gameStarted,
    boardComplete: isBoardComplete(room.rounds, room.enableDoubleJeopardy),
    currentRoundExhausted: room.gameStarted && isCurrentRoundExhausted(currentRound),
    allCluesExhausted: room.gameStarted && areAllActiveCluesUsed(room),
    rounds,
    jeopardy: { categories: rounds[0]?.categories || [] },
    doubleJeopardy: { categories: rounds[1]?.categories || [] },
    currentRoundIndex: room.currentRoundIndex,
    players: playersList,
    activeClue: room.activeClue
      ? {
          roundIndex: room.activeClue.roundIndex,
          catIndex: room.activeClue.catIndex,
          clueIndex: room.activeClue.clueIndex,
          category: room.activeClue.category,
          points: room.activeClue.points,
          question: room.activeClue.question,
          answer: isHost ? room.activeClue.answer : undefined
        }
      : null,
    buzzerOpen: room.buzzerOpen,
    buzzedPlayerId: room.buzzedPlayerId,
    buzzedPlayerName: room.buzzedPlayerName,
    lockedOutPlayerIds: Array.from(room.lockedOutPlayerIds),
    finalJeopardy: {
      active: fj.active,
      stage: fj.stage,
      category: fj.category,
      question: isHost || fj.stage === 'clue' || fj.stage === 'grading' ? fj.question : '',
      answer: isHost || fj.answerRevealed ? fj.answer : undefined,
      timerDuration: fj.timerDuration,
      timeLeft: fj.timeLeft,
      answerRevealed: fj.answerRevealed,
      wagers: isHost || fj.stage === 'grading' ? fj.wagers : {},
      responses: isHost || fj.stage === 'grading' ? fj.responses : {},
      submittedWagerPlayerIds: Object.keys(fj.wagers),
      submittedResponsePlayerIds: Object.keys(fj.responses),
      judged: fj.judged
    },
    lastActionMessage: room.lastActionMessage,
    gameEnded: room.gameEnded,
    podium: room.podium
  };
}

function broadcastRoomState(room) {
  const hostState = serializeRoom(room, true);
  const publicState = serializeRoom(room, false);

  io.to(`host_${room.code}`).emit('room_state', hostState);
  io.to(`screens_${room.code}`).emit('room_state', publicState);
  io.to(`players_${room.code}`).emit('room_state', publicState);
}

function emitRoomEvent(room, eventName, payload = {}) {
  io.to(`host_${room.code}`)
    .to(`screens_${room.code}`)
    .to(`players_${room.code}`)
    .emit(eventName, payload);
}

io.on('connection', (socket) => {
  // --- HOST EVENTS (/host) ---
  socket.on('host_create_or_join', ({ roomCode }, callback) => {
    const cleanCode = sanitizeRoomCode(roomCode);
    let room = cleanCode ? rooms.get(cleanCode) : null;
    if (!room) {
      room = createRoom(cleanCode || undefined);
    }
    room.hostSocketId = socket.id;
    socket.data.role = 'host';
    socket.data.roomCode = room.code;
    socket.join(`host_${room.code}`);

    broadcastRoomState(room);
    if (typeof callback === 'function') {
      callback({ ok: true, roomCode: room.code, state: serializeRoom(room, true) });
    }
  });

  socket.on('host_set_room_code', ({ currentCode, newCode }, callback) => {
    const oldCode = sanitizeRoomCode(currentCode || socket.data.roomCode);
    const room = rooms.get(oldCode);
    if (!room) {
      return callback && callback({ ok: false, error: 'Current room not found.' });
    }

    const desiredCode = sanitizeRoomCode(newCode) || generateRandomCode();
    if (desiredCode !== oldCode && rooms.has(desiredCode)) {
      return callback && callback({ ok: false, error: `Room code "${desiredCode}" is already in use.` });
    }

    if (desiredCode !== oldCode) {
      rooms.delete(oldCode);
      room.code = desiredCode;
      rooms.set(desiredCode, room);

      socket.leave(`host_${oldCode}`);
      socket.join(`host_${desiredCode}`);
      socket.data.roomCode = desiredCode;

      io.in(`players_${oldCode}`).socketsJoin(`players_${desiredCode}`);
      io.in(`players_${oldCode}`).socketsLeave(`players_${oldCode}`);
      io.in(`screens_${oldCode}`).socketsJoin(`screens_${desiredCode}`);
      io.in(`screens_${oldCode}`).socketsLeave(`screens_${oldCode}`);
    }

    room.lastActionMessage = `Room code set to ${room.code}.`;
    broadcastRoomState(room);
    if (typeof callback === 'function') {
      callback({ ok: true, roomCode: room.code, state: serializeRoom(room, true) });
    }
  });

  // --- AUDIENCE / TV DISPLAY SCREEN EVENTS (/screen) ---
  socket.on('screen_join', ({ roomCode }, callback) => {
    const code = sanitizeRoomCode(roomCode);
    if (!code) {
      return callback && callback({ ok: false, error: 'Please enter a valid Room Code.' });
    }
    const room = rooms.get(code);
    if (!room) {
      return callback && callback({ ok: false, error: `Room "${code}" not found. Verify the Room Code on /host.` });
    }

    socket.data.role = 'screen';
    socket.data.roomCode = code;
    socket.join(`screens_${code}`);

    if (typeof callback === 'function') {
      callback({
        ok: true,
        roomCode: code,
        state: serializeRoom(room, false)
      });
    }
  });

  // Host Player Moderation: Kick / Remove Player
  socket.on('host_kick_player', ({ roomCode, playerId }, callback) => {
    const code = sanitizeRoomCode(roomCode || socket.data.roomCode);
    const room = rooms.get(code);
    if (!room) {
      return callback && callback({ ok: false, error: 'Room not found.' });
    }

    const player = room.players.get(playerId);
    if (!player) {
      return callback && callback({ ok: false, error: 'Player not found.' });
    }

    const kickedName = player.name;
    const targetSocketId = player.socketId;

    room.players.delete(playerId);
    room.lockedOutPlayerIds.delete(playerId);
    delete room.finalJeopardy.wagers[playerId];
    delete room.finalJeopardy.responses[playerId];
    delete room.finalJeopardy.judged[playerId];

    if (room.buzzedPlayerId === playerId) {
      room.buzzedPlayerId = null;
      room.buzzedPlayerName = null;
      if (room.activeClue) {
        room.buzzerOpen = true;
      }
    }

    if (targetSocketId) {
      io.to(targetSocketId).emit('player_kicked', {
        roomCode: room.code,
        playerId,
        message: 'You have been removed from the game room by the host.'
      });
      io.in(targetSocketId).socketsLeave(`players_${room.code}`);
    }

    room.lastActionMessage = `Removed player "${kickedName}" from the room.`;
    broadcastRoomState(room);
    emitRoomEvent(room, 'score_updated', { players: serializeRoom(room, false).players });

    if (typeof callback === 'function') {
      callback({ ok: true, removedName: kickedName });
    }
  });

  // Save unified board (Double Jeopardy is optional)
  socket.on('host_save_board', (payload, callback) => {
    const roomCode = payload?.roomCode || socket.data.roomCode;
    const room = rooms.get(sanitizeRoomCode(roomCode));
    if (!room) return callback && callback({ ok: false, error: 'Room not found.' });

    try {
      const normalized = normalizeGamePayload(payload);
      room.title = normalized.title;
      room.enableDoubleJeopardy = Boolean(normalized.enableDoubleJeopardy);
      room.rounds = normalized.rounds;
      if (!room.enableDoubleJeopardy && room.currentRoundIndex === 1) {
        room.currentRoundIndex = 0;
      }
      room.finalJeopardy.category = normalized.finalJeopardy.category;
      room.finalJeopardy.question = normalized.finalJeopardy.question;
      room.finalJeopardy.answer = normalized.finalJeopardy.answer;
      room.finalJeopardy.timerDuration = normalized.finalJeopardy.timerDuration;
      if (!room.finalJeopardy.active) {
        room.finalJeopardy.timeLeft = normalized.finalJeopardy.timerDuration;
      }

      room.lastActionMessage = room.enableDoubleJeopardy
        ? 'Game board saved (Single Jeopardy + Double Jeopardy enabled).'
        : 'Game board saved (Single Jeopardy mode; Double Jeopardy disabled).';
      broadcastRoomState(room);
      if (typeof callback === 'function') {
        callback({
          ok: true,
          boardComplete: isBoardComplete(room.rounds, room.enableDoubleJeopardy),
          state: serializeRoom(room, true)
        });
      }
    } catch (err) {
      if (typeof callback === 'function') {
        callback({ ok: false, error: err.message });
      }
    }
  });

  socket.on('host_start_game', ({ roomCode }, callback) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room) return callback && callback({ ok: false, error: 'Room not found.' });

    if (!isBoardComplete(room.rounds, room.enableDoubleJeopardy)) {
      return (
        callback &&
        callback({
          ok: false,
          error: room.enableDoubleJeopardy
            ? 'Please fill out all Single Jeopardy and Double Jeopardy slots (or uncheck Double Jeopardy) before starting.'
            : 'Please fill out all Single Jeopardy category titles, questions, and answers before starting.'
        })
      );
    }

    room.gameStarted = true;
    room.gameEnded = false;
    room.currentRoundIndex = 0;
    room.lastActionMessage = 'Game started in Single Jeopardy! Select the first clue on the board.';
    broadcastRoomState(room);
    emitRoomEvent(room, 'round_changed', {
      currentRoundIndex: 0,
      roundName: room.rounds[0].name
    });
    if (typeof callback === 'function') {
      callback({ ok: true, state: serializeRoom(room, true) });
    }
  });

  // Switch or advance between Single Jeopardy (0) and Double Jeopardy (1)
  socket.on('host_change_round', ({ roomCode, roundIndex }, callback) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room) return callback && callback({ ok: false, error: 'Room not found.' });

    const idx = Number(roundIndex);
    if (idx === 1 && !room.enableDoubleJeopardy) {
      return (
        callback &&
        callback({
          ok: false,
          error: 'Double Jeopardy is currently disabled for this game.'
        })
      );
    }

    if (idx >= 0 && idx < room.rounds.length) {
      room.currentRoundIndex = idx;
      room.activeClue = null;
      room.buzzerOpen = false;
      room.buzzedPlayerId = null;
      room.buzzedPlayerName = null;
      room.lockedOutPlayerIds.clear();
      room.lastActionMessage = `Advanced to ${room.rounds[idx].name}! All team scores carried over.`;
      broadcastRoomState(room);
      emitRoomEvent(room, 'round_changed', {
        currentRoundIndex: idx,
        roundName: room.rounds[idx].name
      });
      if (typeof callback === 'function') {
        callback({ ok: true, currentRoundIndex: idx, state: serializeRoom(room, true) });
      }
    }
  });

  socket.on('host_select_clue', ({ roomCode, roundIndex, catIndex, clueIndex }) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room || !room.gameStarted || room.gameEnded) return;

    const rIdx = roundIndex ?? room.currentRoundIndex;
    const round = room.rounds[rIdx];
    const cat = round?.categories?.[catIndex];
    const clue = cat?.clues?.[clueIndex];
    if (!cat || !clue) return;

    room.activeClue = {
      roundIndex: rIdx,
      catIndex,
      clueIndex,
      category: cat.title,
      points: Number(clue.points),
      question: clue.question,
      answer: clue.answer
    };
    room.buzzerOpen = false;
    room.buzzedPlayerId = null;
    room.buzzedPlayerName = null;
    room.lockedOutPlayerIds.clear();
    room.lastActionMessage = `[${round.name}] ${cat.title} for $${clue.points}. Waiting for host to open buzzer...`;

    broadcastRoomState(room);
    emitRoomEvent(room, 'clue_selected', {
      roundIndex: rIdx,
      catIndex,
      clueIndex,
      category: cat.title,
      points: Number(clue.points),
      question: clue.question
    });
  });

  socket.on('host_open_buzzer', ({ roomCode }) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room || !room.activeClue) return;

    room.buzzerOpen = true;
    room.buzzedPlayerId = null;
    room.buzzedPlayerName = null;
    room.lastActionMessage = 'Buzzer is OPEN! Players can buzz in now!';

    broadcastRoomState(room);
    emitRoomEvent(room, 'buzzer_opened', {
      category: room.activeClue.category,
      points: room.activeClue.points
    });
  });

  socket.on('host_judge_answer', ({ roomCode, correct }) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room || !room.activeClue || !room.buzzedPlayerId) return;

    const player = room.players.get(room.buzzedPlayerId);
    const { roundIndex, catIndex, clueIndex, points } = room.activeClue;
    const clueObj = room.rounds[roundIndex]?.categories?.[catIndex]?.clues?.[clueIndex];

    if (correct) {
      if (player) player.score += Number(points);
      if (clueObj) clueObj.used = true;
      const winnerName = player ? player.name : 'Player';
      room.activeClue = null;
      room.buzzerOpen = false;
      room.buzzedPlayerId = null;
      room.buzzedPlayerName = null;
      room.lockedOutPlayerIds.clear();

      const currentRound = room.rounds[room.currentRoundIndex];
      if (areAllActiveCluesUsed(room)) {
        room.lastActionMessage = `Correct! ${winnerName} earned +$${points}. All board clues complete — ready for Final Jeopardy!`;
      } else if (room.enableDoubleJeopardy && room.currentRoundIndex === 0 && isCurrentRoundExhausted(currentRound)) {
        room.lastActionMessage = `Correct! ${winnerName} earned +$${points}. Single Jeopardy complete — click "Advance to Double Jeopardy"!`;
      } else {
        room.lastActionMessage = `Correct! ${winnerName} earned +$${points}.`;
      }

      broadcastRoomState(room);
      emitRoomEvent(room, 'clue_resolved', {
        correct: true,
        playerId: player ? player.id : null,
        playerName: winnerName,
        points
      });
      emitRoomEvent(room, 'score_updated', { players: serializeRoom(room, false).players });
    } else {
      if (player) {
        player.score -= Number(points);
        room.lockedOutPlayerIds.add(player.id);
      }
      const penalizedName = player ? player.name : 'Player';
      room.buzzedPlayerId = null;
      room.buzzedPlayerName = null;

      const connectedPlayers = Array.from(room.players.values()).filter((p) => p.connected);
      const eligibleRemaining = connectedPlayers.filter((p) => !room.lockedOutPlayerIds.has(p.id));

      if (eligibleRemaining.length > 0 || connectedPlayers.length === 0) {
        room.buzzerOpen = true;
        room.lastActionMessage = `Incorrect! ${penalizedName} lost -$${points}. Buzzer RE-OPENED for remaining players!`;
      } else {
        room.buzzerOpen = false;
        room.lastActionMessage = `Incorrect! ${penalizedName} lost -$${points}. All connected players have attempted this clue.`;
      }

      broadcastRoomState(room);
      emitRoomEvent(room, 'clue_resolved', {
        correct: false,
        playerId: player ? player.id : null,
        playerName: penalizedName,
        points,
        buzzerReopened: room.buzzerOpen
      });
      emitRoomEvent(room, 'score_updated', { players: serializeRoom(room, false).players });
    }
  });

  socket.on('host_close_clue', ({ roomCode, markUsed }) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room || !room.activeClue) return;

    if (markUsed) {
      const { roundIndex, catIndex, clueIndex } = room.activeClue;
      const clueObj = room.rounds[roundIndex]?.categories?.[catIndex]?.clues?.[clueIndex];
      if (clueObj) clueObj.used = true;
    }

    room.activeClue = null;
    room.buzzerOpen = false;
    room.buzzedPlayerId = null;
    room.buzzedPlayerName = null;
    room.lockedOutPlayerIds.clear();

    const currentRound = room.rounds[room.currentRoundIndex];
    if (areAllActiveCluesUsed(room)) {
      room.lastActionMessage = 'All regular clues finished! Launch Final Jeopardy when ready.';
    } else if (room.enableDoubleJeopardy && room.currentRoundIndex === 0 && isCurrentRoundExhausted(currentRound)) {
      room.lastActionMessage = 'Single Jeopardy complete! Click "Advance to Double Jeopardy" to continue.';
    } else {
      room.lastActionMessage = 'Clue closed by host.';
    }

    broadcastRoomState(room);
    emitRoomEvent(room, 'clue_resolved', { closedByHost: true });
  });

  socket.on('host_adjust_score', ({ roomCode, playerId, delta }) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room) return;
    const player = room.players.get(playerId);
    if (!player) return;
    player.score += Number(delta) || 0;
    room.lastActionMessage = `Adjusted ${player.name}'s score by ${delta >= 0 ? '+' : ''}$${delta}.`;
    broadcastRoomState(room);
    emitRoomEvent(room, 'score_updated', { players: serializeRoom(room, false).players });
  });

  // --- FINAL JEOPARDY HOST EVENTS ---
  socket.on('host_start_final_jeopardy', ({ roomCode, category, question, answer, timerDuration }, callback) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room) return callback && callback({ ok: false, error: 'Room not found.' });

    clearFinalTimer(room);
    if (category !== undefined) room.finalJeopardy.category = String(category).trim();
    if (question !== undefined) room.finalJeopardy.question = String(question).trim();
    if (answer !== undefined) room.finalJeopardy.answer = String(answer).trim();
    const dur = Number(timerDuration) || room.finalJeopardy.timerDuration || 30;
    room.finalJeopardy.timerDuration = Math.max(5, Math.min(300, dur));
    room.finalJeopardy.timeLeft = room.finalJeopardy.timerDuration;

    if (!room.finalJeopardy.category || !room.finalJeopardy.question || !room.finalJeopardy.answer) {
      return (
        callback &&
        callback({
          ok: false,
          error: 'Please enter the Final Jeopardy Category, Clue, and Answer before launching.'
        })
      );
    }

    room.activeClue = null;
    room.buzzerOpen = false;
    room.buzzedPlayerId = null;
    room.finalJeopardy.active = true;
    room.finalJeopardy.stage = 'wager';
    room.finalJeopardy.answerRevealed = false;
    room.finalJeopardy.wagers = {};
    room.finalJeopardy.responses = {};
    room.finalJeopardy.judged = {};
    room.lastActionMessage = `Final Jeopardy! Category: "${room.finalJeopardy.category}". Teams are placing their wagers...`;

    broadcastRoomState(room);
    emitRoomEvent(room, 'final_jeopardy_phase', {
      stage: 'wager',
      category: room.finalJeopardy.category,
      timerDuration: room.finalJeopardy.timerDuration
    });
    if (typeof callback === 'function') callback({ ok: true });
  });

  socket.on('host_start_final_timer', ({ roomCode, timerDuration }) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room || !room.finalJeopardy.active) return;

    clearFinalTimer(room);
    if (timerDuration) {
      const dur = Number(timerDuration);
      if (!Number.isNaN(dur) && dur >= 5 && dur <= 300) {
        room.finalJeopardy.timerDuration = dur;
      }
    }

    room.finalJeopardy.stage = 'clue';
    room.finalJeopardy.timeLeft = room.finalJeopardy.timerDuration;
    room.lastActionMessage = `Final Jeopardy clue revealed! ${room.finalJeopardy.timeLeft}s countdown started!`;
    broadcastRoomState(room);
    emitRoomEvent(room, 'final_jeopardy_phase', {
      stage: 'clue',
      category: room.finalJeopardy.category,
      question: room.finalJeopardy.question,
      timeLeft: room.finalJeopardy.timeLeft
    });

    room.finalJeopardy.timerInterval = setInterval(() => {
      room.finalJeopardy.timeLeft = Math.max(0, room.finalJeopardy.timeLeft - 1);
      emitRoomEvent(room, 'final_timer_tick', { timeLeft: room.finalJeopardy.timeLeft });

      if (room.finalJeopardy.timeLeft <= 0) {
        clearFinalTimer(room);
        room.finalJeopardy.stage = 'grading';
        room.lastActionMessage = 'Time is up! Host can now reveal the Final Jeopardy answer and grade responses.';
        broadcastRoomState(room);
        emitRoomEvent(room, 'final_jeopardy_phase', {
          stage: 'grading',
          category: room.finalJeopardy.category,
          question: room.finalJeopardy.question,
          timeLeft: 0
        });
      }
    }, 1000);
  });

  socket.on('host_reveal_final_answer', ({ roomCode }) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room || !room.finalJeopardy.active) return;

    clearFinalTimer(room);
    room.finalJeopardy.stage = 'grading';
    room.finalJeopardy.answerRevealed = true;
    room.lastActionMessage = `Final Jeopardy Answer Revealed: ${room.finalJeopardy.answer}`;
    broadcastRoomState(room);
    emitRoomEvent(room, 'final_jeopardy_phase', {
      stage: 'grading',
      answerRevealed: true,
      answer: room.finalJeopardy.answer
    });
  });

  socket.on('host_judge_final', ({ roomCode, playerId, correct }) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room || !room.finalJeopardy.active) return;

    const player = room.players.get(playerId);
    if (!player) return;

    if (room.finalJeopardy.judged[playerId]) return;

    const wager = Math.max(0, Number(room.finalJeopardy.wagers[playerId]) || 0);
    room.finalJeopardy.judged[playerId] = correct ? 'correct' : 'incorrect';

    if (correct) {
      player.score += wager;
      room.lastActionMessage = `${player.name} was CORRECT in Final Jeopardy (+$${wager})!`;
    } else {
      player.score -= wager;
      room.lastActionMessage = `${player.name} was INCORRECT in Final Jeopardy (-$${wager}).`;
    }

    broadcastRoomState(room);
    emitRoomEvent(room, 'score_updated', { players: serializeRoom(room, false).players });
  });

  socket.on('host_end_game', ({ roomCode }) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room) return;

    clearFinalTimer(room);
    room.gameEnded = true;
    room.activeClue = null;
    room.buzzerOpen = false;
    room.buzzedPlayerId = null;
    room.buzzedPlayerName = null;
    room.lockedOutPlayerIds.clear();
    room.finalJeopardy.active = false;

    const sorted = Array.from(room.players.values()).sort((a, b) => b.score - a.score);
    room.podium = sorted;
    const topWinner = sorted[0];
    room.lastActionMessage = topWinner
      ? `Game Over! Congratulations to ${topWinner.name} with $${topWinner.score}!`
      : 'Game Over!';

    broadcastRoomState(room);
    emitRoomEvent(room, 'game_over', { podium: room.podium });
  });

  socket.on('host_reset_game', ({ roomCode }) => {
    const room = rooms.get(sanitizeRoomCode(roomCode || socket.data.roomCode));
    if (!room) return;

    clearFinalTimer(room);
    room.rounds.forEach((r) => r.categories.forEach((c) => c.clues.forEach((q) => (q.used = false))));
    room.players.forEach((p) => (p.score = 0));
    room.currentRoundIndex = 0;
    room.activeClue = null;
    room.buzzerOpen = false;
    room.buzzedPlayerId = null;
    room.buzzedPlayerName = null;
    room.lockedOutPlayerIds.clear();
    room.finalJeopardy.active = false;
    room.finalJeopardy.stage = 'setup';
    room.finalJeopardy.answerRevealed = false;
    room.finalJeopardy.wagers = {};
    room.finalJeopardy.responses = {};
    room.finalJeopardy.judged = {};
    room.finalJeopardy.timeLeft = room.finalJeopardy.timerDuration;
    room.gameEnded = false;
    room.podium = [];
    room.lastActionMessage = 'Game reset to Single Jeopardy! Scores and used tiles cleared.';

    broadcastRoomState(room);
    emitRoomEvent(room, 'round_changed', {
      currentRoundIndex: 0,
      roundName: room.rounds[0].name
    });
  });

  // --- PLAYER EVENTS (/play) ---
  socket.on('player_join', ({ roomCode, playerName, playerId }, callback) => {
    const code = sanitizeRoomCode(roomCode);
    const cleanName = String(playerName || '').trim();

    if (!code || !cleanName) {
      return callback && callback({ ok: false, error: 'Room Code and Player/Team Name are required.' });
    }

    const room = rooms.get(code);
    if (!room) {
      return callback && callback({ ok: false, error: `Room "${code}" not found. Check the Room Code with your Host.` });
    }

    let existingPlayer = null;
    if (playerId && room.players.has(playerId)) {
      existingPlayer = room.players.get(playerId);
    } else {
      for (const p of room.players.values()) {
        if (p.name.toLowerCase() === cleanName.toLowerCase()) {
          existingPlayer = p;
          break;
        }
      }
    }

    const id = existingPlayer ? existingPlayer.id : `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const playerRecord = existingPlayer
      ? { ...existingPlayer, name: cleanName, socketId: socket.id, connected: true }
      : { id, socketId: socket.id, name: cleanName, score: 0, connected: true };

    room.players.set(id, playerRecord);
    socket.data.role = 'player';
    socket.data.roomCode = code;
    socket.data.playerId = id;
    socket.join(`players_${code}`);

    room.lastActionMessage = `${cleanName} joined Room ${code}! (${room.players.size} team${room.players.size === 1 ? '' : 's'} connected)`;
    broadcastRoomState(room);
    emitRoomEvent(room, 'score_updated', { players: serializeRoom(room, false).players });

    if (typeof callback === 'function') {
      callback({
        ok: true,
        playerId: id,
        roomCode: code,
        state: serializeRoom(room, false)
      });
    }
  });

  socket.on('player_buzz', ({ roomCode, playerId }, callback) => {
    const code = sanitizeRoomCode(roomCode || socket.data.roomCode);
    const pid = playerId || socket.data.playerId;
    const room = rooms.get(code);

    if (!room || !room.activeClue) {
      return callback && callback({ ok: false, error: 'No active clue.' });
    }
    if (!room.buzzerOpen || room.buzzedPlayerId) {
      return callback && callback({ ok: false, error: 'Buzzer is locked.' });
    }
    if (room.lockedOutPlayerIds.has(pid)) {
      return callback && callback({ ok: false, error: 'You already attempted this clue.' });
    }

    const player = room.players.get(pid);
    if (!player) {
      return callback && callback({ ok: false, error: 'Player not found in room.' });
    }

    room.buzzerOpen = false;
    room.buzzedPlayerId = player.id;
    room.buzzedPlayerName = player.name;
    room.lastActionMessage = `🔔 ${player.name} buzzed in first!`;

    broadcastRoomState(room);
    emitRoomEvent(room, 'player_buzzed', {
      playerId: player.id,
      playerName: player.name
    });
    if (typeof callback === 'function') callback({ ok: true });
  });

  socket.on('player_submit_wager', ({ roomCode, playerId, wager }, callback) => {
    const code = sanitizeRoomCode(roomCode || socket.data.roomCode);
    const pid = playerId || socket.data.playerId;
    const room = rooms.get(code);
    if (!room || !room.finalJeopardy.active || room.finalJeopardy.stage !== 'wager') {
      return callback && callback({ ok: false, error: 'Wager phase is not active.' });
    }

    const player = room.players.get(pid);
    if (!player) return callback && callback({ ok: false, error: 'Player not found.' });

    const maxAllowed = Math.max(0, player.score);
    const numWager = Math.floor(Number(wager));
    if (Number.isNaN(numWager) || numWager < 0 || numWager > maxAllowed) {
      return callback && callback({ ok: false, error: `Wager must be between $0 and $${maxAllowed}.` });
    }

    room.finalJeopardy.wagers[pid] = numWager;
    room.lastActionMessage = `${player.name} locked in their Final Jeopardy wager.`;
    broadcastRoomState(room);
    if (typeof callback === 'function') callback({ ok: true, wager: numWager });
  });

  socket.on('player_submit_final_answer', ({ roomCode, playerId, response }, callback) => {
    const code = sanitizeRoomCode(roomCode || socket.data.roomCode);
    const pid = playerId || socket.data.playerId;
    const room = rooms.get(code);
    if (
      !room ||
      !room.finalJeopardy.active ||
      room.finalJeopardy.stage !== 'clue' ||
      room.finalJeopardy.timeLeft <= 0
    ) {
      return callback && callback({ ok: false, error: 'Answer submission window is closed.' });
    }

    const player = room.players.get(pid);
    if (!player) return callback && callback({ ok: false, error: 'Player not found.' });

    room.finalJeopardy.responses[pid] = String(response || '').trim();
    room.lastActionMessage = `${player.name} submitted their Final Jeopardy response.`;
    broadcastRoomState(room);
    if (typeof callback === 'function') callback({ ok: true });
  });

  socket.on('disconnect', () => {
    const { role, roomCode, playerId } = socket.data || {};
    if (!roomCode || !rooms.has(roomCode)) return;
    const room = rooms.get(roomCode);

    if (role === 'player' && playerId && room.players.has(playerId)) {
      const player = room.players.get(playerId);
      player.connected = false;
      broadcastRoomState(room);
    }
  });
});

// Catch-all fallback route to prevent 404 errors on direct navigation or refresh
app.get('*', (req, res) => {
  const p = (req.path || '').toLowerCase();
  if (p.startsWith('/host')) {
    return res.sendFile(path.join(__dirname, 'public', 'host.html'));
  }
  if (p.startsWith('/screen')) {
    return res.sendFile(path.join(__dirname, 'public', 'screen.html'));
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🎯 Jeopardy! Real-Time Trivia Server Running`);
  console.log(`📺 Private Host   : http://localhost:${PORT}/host`);
  console.log(`📽️ TV Projector   : http://localhost:${PORT}/screen`);
  console.log(`📱 Player Buzzer  : http://localhost:${PORT}/play`);
  console.log(`=================================================`);
});
