GitHub Copilot Chat Assistant

Segue o arquivo backend.js completo e atualizado — copie/cole no seu projeto como backend.js:

// OAABET - backend.js (updated game logic)
// Backend Node.js para plataforma OAABET
// - Express + Socket.IO
// - Gerenciamento de salas (lobby, sala de jogo)
// - Lógica de jogo: turnos, apostas, rondas, pontuação, timers
// - Armazenamento em memória (substituir por Redis/Mongo/Postgres em produção)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ========== Estruturas de dados em memória ==========
// rooms:
//  id, name, hostId, players: { socketId: { id, name, ready, score, balance, lastBet } },
//  state: 'waiting' | 'betting' | 'playing' | 'scoring' | 'finished',
//  game: { round, maxRounds, pot, phase, turnOrder, currentTurnIndex, turnTimerId, roundTimerId, config }
const rooms = {};
const playersIndex = {};

// Config padrão do jogo
const DEFAULT_CONFIG = {
  maxRounds: 5,
  startingBalance: 1000, // saldo inicial para apostas
  minBet: 10,
  maxBet: 500,
  turnTimeSec: 20, // tempo por jogada
  bettingTimeSec: 30, // tempo para fase de apostas antes da rodada começar
  targetScore: null // se definido, quem atingir vence
};

function createRoom({ name = 'Sala', hostId, metadata = {}, config = {} } = {}) {
  const id = uuidv4();
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  rooms[id] = {
    id,
    name,
    hostId,
    players: {},
    state: 'waiting',
    createdAt: Date.now(),
    metadata,
    config: cfg
  };
  return rooms[id];
}

function getPublicRoomInfo(room) {
  return {
    id: room.id,
    name: room.name,
    playerCount: Object.keys(room.players).length,
    state: room.state,
    metadata: room.metadata,
    config: room.config
  };
}

// ========== REST endpoints ==========
app.get('/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));
app.get('/rooms', (req, res) => res.json(Object.values(rooms).map(getPublicRoomInfo)));
app.get('/rooms/:id', (req, res) => {
  const room = rooms[req.params.id];
  if (!room) return res.status(404).json({ error: 'room_not_found' });
  res.json({ ...getPublicRoomInfo(room), players: Object.values(room.players), game: room.game });
});

app.post('/rooms', (req, res) => {
  const { name, hostName, metadata, config } = req.body || {};
  const hostId = uuidv4();
  const room = createRoom({ name, hostId, metadata, config });
  room.players[hostId] = {
    id: hostId,
    name: hostName || 'Host',
    ready: false,
    score: 0,
    balance: room.config.startingBalance,
    isHost: true
  };

  // important: add playersIndex for host so REST-created rooms can be used with sockets (if you map UUID -> socket later)
  playersIndex[hostId] = { roomId: room.id };

  res.status(201).json(getPublicRoomInfo(room));
});

// ========== Game helpers ==========
function startBettingPhase(room) {
  room.state = 'betting';
  room.game = {
    round: (room.game && room.game.round) ? room.game.round + 1 : 1,
    maxRounds: room.config.maxRounds,
    pot: 0,
    phase: 'betting',
    turnOrder: Object.keys(room.players),
    currentTurnIndex: 0,
    resolvedActions: {},
    startedAt: Date.now()
  };

  // reset lastBet for players
  for (const pid of Object.keys(room.players)) {
    room.players[pid].lastBet = 0;
  }

  io.to(room.id).emit('phase_change', { phase: 'betting', game: room.game, players: Object.values(room.players) });

  // inicia timer para encerrar apostas automaticamente
  clearTimeout(room.game.roundTimerId);
  room.game.roundTimerId = setTimeout(() => {
    // se algum jogador não apostou, assume zero
    proceedToPlayingPhase(room.id);
  }, room.config.bettingTimeSec * 1000);
}

function proceedToPlayingPhase(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (!room.game) return;

  clearTimeout(room.game.roundTimerId);
  room.state = 'playing';
  room.game.phase = 'playing';
  room.game.currentTurnIndex = 0;
  room.game.pot = room.game.pot || 0;

  // quem apostou contribuiu para o pote
  for (const pid of Object.keys(room.players)) {
    const bet = room.players[pid].lastBet || 0;
    room.game.pot += bet;
    room.players[pid].balance -= bet;
  }

  // notifica início da fase de jogadas
  io.to(room.id).emit('phase_change', { phase: 'playing', game: room.game, players: Object.values(room.players) });

  // iniciar turno do primeiro jogador
  startTurnForCurrentPlayer(room);
}

function startTurnForCurrentPlayer(room) {
  if (!room || !room.game) return;

  const playerIds = room.game.turnOrder;
  if (playerIds.length === 0) return;

  // remover jogadores que saíram
  room.game.turnOrder = room.game.turnOrder.filter(pid => !!room.players[pid]);
  if (room.game.turnOrder.length === 0) return endRound(room);

  if (room.game.currentTurnIndex >= room.game.turnOrder.length) {
    // fim da volta completa -> scoring
    return endRound(room);
  }

  const currentPlayerId = room.game.turnOrder[room.game.currentTurnIndex];
  io.to(room.id).emit('turn_start', { playerId: currentPlayerId, turnIndex: room.game.currentTurnIndex, game: room.game });

  // inicia timer para o turno
  clearTimeout(room.game.turnTimerId);
  room.game.turnTimerId = setTimeout(() => {
    // se jogador não agir no tempo, executa ação default (pass)
    handlePlayerAction(room.id, currentPlayerId, { action: 'pass' });
  }, room.config.turnTimeSec * 1000);
}

function handlePlayerAction(roomId, playerId, payload = {}) {
  const room = rooms[roomId];
  if (!room || room.state !== 'playing' || !room.game) return { error: 'invalid_state' };

  const turnPlayerId = room.game.turnOrder[room.game.currentTurnIndex];
  if (playerId !== turnPlayerId) return { error: 'not_your_turn' };

  clearTimeout(room.game.turnTimerId);

  const action = payload.action; // ações possíveis: 'pass', 'play_card' (ou 'bet' durante playing, etc.), 'score'
  // aqui implementamos: 'play' aumenta score aleatoriamente (exemplo), 'pass' pula
  if (action === 'play') {
    // exemplo: ganha entre 10 a 100 pontos, multiplicado pela aposta
    const base = Math.floor(Math.random() * 91) + 10; // 10..100
    const multiplier = 1 + ((room.players[playerId].lastBet || 0) / room.config.minBet) * 0.1;
    const gained = Math.round(base * multiplier);
    room.players[playerId].score = (room.players[playerId].score || 0) + gained;
    io.to(room.id).emit('action_result', { playerId, action, gained, newScore: room.players[playerId].score });
  } else if (action === 'pass') {
    io.to(room.id).emit('action_result', { playerId, action });
  } else if (action === 'fold') {
    // exemplo: jogador sai da rodada (fica sem pontuar)
    room.players[playerId].folded = true;
    io.to(room.id).emit('action_result', { playerId, action });
  } else if (action === 'custom') {
    // permitir ações customizadas definidas por payload.data
    io.to(room.id).emit('action_result', { playerId, action, data: payload.data });
  } else {
    return { error: 'unknown_action' };
  }

  // avança turno
  room.game.currentTurnIndex += 1;
  // se todos jogaram, finalizar round
  if (room.game.currentTurnIndex >= room.game.turnOrder.length) return endRound(room);

  // caso contrário, iniciar próximo turno
  startTurnForCurrentPlayer(room);
  return { ok: true };
}

function endRound(room) {
  if (!room || !room.game) return;
  clearTimeout(room.game.turnTimerId);

  room.state = 'scoring';
  room.game.phase = 'scoring';

  // exemplo de distribuição do pote: jogador com maior score desta rodada ganha tudo
  // para simplificação, usamos scores totais — em jogo real usar scores desta rodada
  let winnerId = null;
  let bestScore = -Infinity;
  for (const pid of Object.keys(room.players)) {
    if (room.players[pid].folded) continue; // ignorar quem foldou
    const sc = room.players[pid].score || 0;
    if (sc > bestScore) {
      bestScore = sc;
      winnerId = pid;
    }
  }

  if (winnerId) {
    room.players[winnerId].balance += room.game.pot;
    io.to(room.id).emit('round_result', { winnerId, pot: room.game.pot, players: Object.values(room.players) });
  } else {
    io.to(room.id).emit('round_result', { winnerId: null, pot: room.game.pot, players: Object.values(room.players) });
  }

  // reset per-round fields
  for (const pid of Object.keys(room.players)) {
    delete room.players[pid].lastBet;
    delete room.players[pid].folded;
  }

  // condição de término
  const reachedMaxRounds = room.game.round >= room.game.maxRounds;
  const someoneReachedTarget = room.config.targetScore && Object.values(room.players).some(p => (p.score || 0) >= room.config.targetScore);

  if (reachedMaxRounds || someoneReachedTarget) {
    finishGame(room);
    return;
  }

  // caso contrário, prepara próxima rodada (voltar para betting)
  // mantém pontuação acumulada
  room.game.phase = 'between_rounds';
  io.to(room.id).emit('between_rounds', { nextRoundInSec: 5, game: room.game, players: Object.values(room.players) });

  // pequeno delay antes de próxima fase
  setTimeout(() => startBettingPhase(room), 5000);
}

function finishGame(room) {
  if (!room || !room.game) return;
  room.state = 'finished';
  room.game.phase = 'finished';

  // decidir vencedor final por score total (ou por balance)
  let winnerId = null;
  let bestScore = -Infinity;
  for (const pid of Object.keys(room.players)) {
    const sc = room.players[pid].score || 0;
    if (sc > bestScore) {
      bestScore = sc;
      winnerId = pid;
    }
  }

  io.to(room.id).emit('game_finished', { winnerId, players: Object.values(room.players) });

  // opcional: persistir resultado em DB aqui
}

// ========== Socket.IO events ==========
io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('join_room', (payload = {}, cb) => {
    try {
      const { roomId, playerName } = payload;
      let room;

      if (roomId) {
        room = rooms[roomId];
        if (!room) return cb && cb({ error: 'room_not_found' });
      } else {
        room = createRoom({ name: `${playerName || 'Player'}'s room`, hostId: socket.id });
      }

      const playerId = socket.id;
      const player = {
        id: playerId,
        name: playerName || `Player-${playerId.slice(0, 4)}`,
        ready: false,
        score: 0,
        balance: room.config.startingBalance,
        connectedAt: Date.now()
      };

      // se este socket é o host da sala, marca isHost
      if (room.hostId === playerId) {
        player.isHost = true;
      }

      room.players[playerId] = player;
      playersIndex[playerId] = { roomId: room.id };

      socket.join(room.id);
      io.to(room.id).emit('room_update', { room: getPublicRoomInfo(room), players: Object.values(room.players) });
      cb && cb({ ok: true, room: getPublicRoomInfo(room), player });
    } catch (err) {
      console.error('join_room error', err);
      cb && cb({ error: 'internal_error' });
    }
  });

  socket.on('place_bet', (payload = {}, cb) => {
    // payload: { amount }
    const idx = playersIndex[socket.id];
    if (!idx) return cb && cb({ error: 'not_in_room' });
    const room = rooms[idx.roomId];
    if (!room) return cb && cb({ error: 'room_not_found' });
    if (room.state !== 'betting') return cb && cb({ error: 'not_betting_phase' });

    const amount = Number(payload.amount) || 0;
    const player = room.players[socket.id];
    if (!player) return cb && cb({ error: 'player_not_found' });

    if (amount < room.config.minBet || amount > room.config.maxBet) return cb && cb({ error: 'invalid_bet_amount' });
    if (player.balance < amount) return cb && cb({ error: 'insufficient_balance' });

    player.lastBet = amount;
    io.to(room.id).emit('bet_placed', { playerId: socket.id, amount, players: Object.values(room.players) });
    cb && cb({ ok: true });
  });

  socket.on('start_game', (payload = {}, cb) => {
    const idx = playersIndex[socket.id];
    if (!idx) return cb && cb({ error: 'not_in_room' });
    const room = rooms[idx.roomId];
    if (!room) return cb && cb({ error: 'room_not_found' });

    // somente host pode iniciar o jogo
    if (room.hostId !== socket.id) {
      return cb && cb({ error: 'not_host' });
    }

    // requer pelo menos 2 jogadores prontos
    const playersList = Object.values(room.players);
    if (playersList.length < 2) return cb && cb({ error: 'not_enough_players' });

    // inicializa game e inicia fase de apostas
    room.game = room.game || {};
    room.game.round = 0;
    startBettingPhase(room);
    cb && cb({ ok: true });
  });

  socket.on('player_action', (payload = {}, cb) => {
    // during playing phase: payload { action: 'play'|'pass'|'fold'|'custom', data }
    const idx = playersIndex[socket.id];
    if (!idx) return cb && cb({ error: 'not_in_room' });
    const roomId = idx.roomId;
    const res = handlePlayerAction(roomId, socket.id, payload);
    cb && cb(res);
  });

  socket.on('leave_room', (payload = {}, cb) => {
    const idx = playersIndex[socket.id];
    if (!idx) return cb && cb({ error: 'not_in_room' });
    const room = rooms[idx.roomId];
    if (!room) return cb && cb({ error: 'room_not_found' });

    delete room.players[socket.id];
    delete playersIndex[socket.id];
    socket.leave(room.id);

    if (Object.keys(room.players).length === 0) {
      delete rooms[room.id];
    } else {
      if (room.hostId === socket.id) {
        // reatribui host para o primeiro jogador conectado
        const newHostId = Object.keys(room.players)[0];
        room.hostId = newHostId;
        room.players[newHostId].isHost = true;
      }
      io.to(room.id).emit('room_update', { room: getPublicRoomInfo(room), players: Object.values(room.players) });
    }

    cb && cb({ ok: true });
  });

  socket.on('disconnect', (reason) => {
    console.log('socket disconnect', socket.id, reason);
    const idx = playersIndex[socket.id];
    if (!idx) return;
    const room = rooms[idx.roomId];
    if (!room) return;

    // Remove player imediatamente (poderíamos manter para reconexão)
    delete room.players[socket.id];
    delete playersIndex[socket.id];
    io.to(room.id).emit('player_disconnected', { playerId: socket.id, players: Object.values(room.players) });

    if (Object.keys(room.players).length === 0) delete rooms[room.id];
  });

  socket.on('ping_server', (cb) => {
    cb && cb({ time: Date.now() });
  });
});

// limpeza periódica
setInterval(() => {
  const now = Date.now();
  const maxAge = 1000 * 60 * 60 * 6; // 6 horas
  for (const id of Object.keys(rooms)) {
    const room = rooms[id];
    if (now - room.createdAt > maxAge) {
      console.log('removing old room', id);
      delete rooms[id];
    }
  }
}, 1000 * 60 * 30);

server.listen(PORT, () => {
  console.log(`OAABET backend rodando na porta ${PORT}`);
});

module.exports = { app, server, io, rooms, playersIndex };