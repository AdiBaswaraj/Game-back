require('dotenv').config();

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FRONTEND_URL'];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.warn(`[startup] missing env vars: ${missingEnv.join(', ')}`);
}

const http = require('http');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const supabase = require('./supabase');
const rooms = require('./rooms');
const presence = require('./presence');
const games = require('./games');
const queues = require('./queues');

const allowedOrigin = process.env.FRONTEND_URL;

const corsOptions = {
  origin: [
    'https://game-front-peach.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-requested-with'],
  credentials: true,
  optionsSuccessStatus: 200,
};

const app = express();
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setTimeout(10000, () => {
    console.error('[timeout] route timed out:', req.method, req.path);
    if (!res.headersSent) {
      res.status(503).json({ error: 'Request timed out' });
    }
  });
  next();
});

app.use((req, res, next) => {
  console.log(
    `[http] ${req.method} ${req.path} origin:${req.headers.origin}`
  );
  next();
});

app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

app.use((req, res, next) => {
  if (req.method === 'POST') {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      return res
        .status(400)
        .json({ error: 'Content-Type must be application/json' });
    }
  }
  next();
});

app.use(express.json());

app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  next(err);
});

const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const roomCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' },
});

const scoresLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down' },
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/cors-test', (req, res) => {
  const origin = req.headers.origin;
  res.json({
    ok: true,
    origin,
    corsAllowed: corsOptions.origin.includes(origin),
  });
});

app.post('/api/scores', scoresLimiter, ah(async (req, res) => {
  const { user_id, game_id, score, completed_at } = req.body || {};

  if (
    !user_id ||
    !game_id ||
    score === undefined ||
    score === null ||
    !completed_at
  ) {
    return res.status(400).json({
      error: 'user_id, game_id, score, and completed_at are required',
    });
  }

  const { data, error } = await supabase
    .from('scores')
    .insert({ user_id, game_id, score, completed_at })
    .select()
    .single();

  if (error) {
    console.error('[scores] insert error:', error);
    return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, data });
}));

app.get('/api/scores/leaderboard/:gameId', ah(async (req, res) => {
  const { gameId } = req.params;

  const { data, error } = await supabase
    .from('scores')
    .select('score, completed_at, profiles ( username )')
    .eq('game_id', gameId)
    .order('score', { ascending: false })
    .limit(10);

  if (error) {
    console.error('[leaderboard] fetch error:', error);
    return res.status(500).json({ error: error.message });
  }

  const leaderboard = (data || []).map((row) => ({
    username: row.profiles?.username ?? null,
    score: row.score,
    completed_at: row.completed_at,
  }));

  res.json(leaderboard);
}));

app.post('/api/rooms/create', roomCreateLimiter, (req, res) => {
  console.log('[room/create] received request:', req.body);

  try {
    console.log('[room/create] validating body...');
    const { gameId, username } = req.body || {};
    if (!gameId || !username) {
      console.log('[room/create] missing fields');
      return res.status(400).json({ error: 'gameId and username are required' });
    }

    console.log('[room/create] creating room...');
    const room = rooms.createRoom(gameId);
    console.log('[room/create] room created:', room.code);

    console.log('[room/create] sending response...');
    return res.json({ code: room.code, room: rooms.toPublicRoom(room) });
  } catch (err) {
    console.error('[room/create] error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(rooms.toPublicRoom(room));
});

app.get('/api/queue/:gameId', (req, res) => {
  const { gameId } = req.params;
  res.json({ gameId, waiting: queues.getQueueLength(gameId) });
});

async function fetchAcceptedFriendIds(userId) {
  const { data, error } = await supabase
    .from('friendships')
    .select('requester_id, addressee_id')
    .eq('status', 'accepted')
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
  if (error) {
    console.error('[friends] fetch error:', error);
    return [];
  }
  return (data || []).map((f) =>
    f.requester_id === userId ? f.addressee_id : f.requester_id
  );
}

app.post('/api/friends/request', ah(async (req, res) => {
  const { requesterId, addresseeUsername } = req.body || {};
  if (!requesterId || !addresseeUsername) {
    return res
      .status(400)
      .json({ error: 'requesterId and addresseeUsername are required' });
  }

  const { data: addressee, error: lookupErr } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', addresseeUsername)
    .maybeSingle();
  if (lookupErr) {
    console.error('[friends] lookup error:', lookupErr);
    return res.status(500).json({ error: lookupErr.message });
  }
  if (!addressee) return res.status(404).json({ error: 'User not found' });
  if (addressee.id === requesterId) {
    return res.status(400).json({ error: 'Cannot friend yourself' });
  }

  const { data: existing, error: existingErr } = await supabase
    .from('friendships')
    .select('id')
    .or(
      `and(requester_id.eq.${requesterId},addressee_id.eq.${addressee.id}),and(requester_id.eq.${addressee.id},addressee_id.eq.${requesterId})`
    )
    .maybeSingle();
  if (existingErr) {
    console.error('[friends] existing check error:', existingErr);
    return res.status(500).json({ error: existingErr.message });
  }
  if (existing)
    return res.status(409).json({ error: 'Friendship already exists' });

  const { data, error } = await supabase
    .from('friendships')
    .insert({
      requester_id: requesterId,
      addressee_id: addressee.id,
      status: 'pending',
    })
    .select()
    .single();
  if (error) {
    console.error('[friends] insert error:', error);
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true, friendship: data });
}));

app.post('/api/friends/accept', ah(async (req, res) => {
  const { userId, friendshipId } = req.body || {};
  if (!userId || !friendshipId) {
    return res
      .status(400)
      .json({ error: 'userId and friendshipId are required' });
  }

  const { data: friendship, error: fetchErr } = await supabase
    .from('friendships')
    .select('id, addressee_id')
    .eq('id', friendshipId)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!friendship)
    return res.status(404).json({ error: 'Friendship not found' });
  if (friendship.addressee_id !== userId) {
    return res.status(403).json({ error: 'Only the addressee can accept' });
  }

  const { error } = await supabase
    .from('friendships')
    .update({ status: 'accepted' })
    .eq('id', friendshipId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
}));

app.post('/api/friends/remove', ah(async (req, res) => {
  const { userId, friendshipId } = req.body || {};
  if (!userId || !friendshipId) {
    return res
      .status(400)
      .json({ error: 'userId and friendshipId are required' });
  }

  const { data: friendship, error: fetchErr } = await supabase
    .from('friendships')
    .select('id, requester_id, addressee_id')
    .eq('id', friendshipId)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!friendship)
    return res.status(404).json({ error: 'Friendship not found' });
  if (
    friendship.requester_id !== userId &&
    friendship.addressee_id !== userId
  ) {
    return res
      .status(403)
      .json({ error: 'You are not part of this friendship' });
  }

  const { error } = await supabase
    .from('friendships')
    .delete()
    .eq('id', friendshipId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
}));

app.get('/api/friends/search', ah(async (req, res) => {
  const username = (req.query.username || '').toString().trim();
  if (!username) {
    return res.status(400).json({ error: 'username query param is required' });
  }
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url')
    .ilike('username', `%${username}%`)
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });
  res.json(
    (data || []).map((p) => ({
      userId: p.id,
      username: p.username,
      avatar_url: p.avatar_url,
    }))
  );
}));

app.get('/api/friends/:userId/pending', ah(async (req, res) => {
  const { userId } = req.params;
  const { data, error } = await supabase
    .from('friendships')
    .select(
      'id, created_at, requester:profiles!requester_id ( id, username, avatar_url )'
    )
    .eq('addressee_id', userId)
    .eq('status', 'pending');
  if (error) return res.status(500).json({ error: error.message });
  const pending = (data || []).map((f) => ({
    friendshipId: f.id,
    requesterId: f.requester?.id,
    username: f.requester?.username,
    avatar_url: f.requester?.avatar_url,
    created_at: f.created_at,
  }));
  res.json(pending);
}));

app.get('/api/friends/:userId/outgoing', ah(async (req, res) => {
  const { userId } = req.params;
  const { data, error } = await supabase
    .from('friendships')
    .select('id, addressee:profiles!addressee_id ( id, username )')
    .eq('requester_id', userId)
    .eq('status', 'pending');
  if (error) return res.status(500).json({ error: error.message });
  res.json(
    (data || []).map((f) => ({
      friendshipId: f.id,
      userId: f.addressee?.id,
      username: f.addressee?.username,
    }))
  );
}));

app.get('/api/friends/:userId', ah(async (req, res) => {
  const { userId } = req.params;
  const { data, error } = await supabase
    .from('friendships')
    .select(
      `
      id,
      requester_id,
      addressee_id,
      requester:profiles!requester_id ( id, username, avatar_url ),
      addressee:profiles!addressee_id ( id, username, avatar_url )
    `
    )
    .eq('status', 'accepted')
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
  if (error) return res.status(500).json({ error: error.message });
  const friends = (data || []).map((f) => {
    const friend = f.requester_id === userId ? f.addressee : f.requester;
    return {
      friendshipId: f.id,
      userId: friend?.id,
      username: friend?.username,
      avatar_url: friend?.avatar_url,
      isOnline: friend ? presence.isOnline(friend.id) : false,
    };
  });
  res.json(friends);
}));

app.get('/api/users/:userId/stats', ah(async (req, res) => {
  const { userId } = req.params;
  const { data, error } = await supabase
    .from('scores')
    .select('game_id, score, completed_at')
    .eq('user_id', userId);
  if (error) return res.status(500).json({ error: error.message });

  const byGame = new Map();
  for (const row of data || []) {
    let stat = byGame.get(row.game_id);
    if (!stat) {
      stat = {
        gameId: row.game_id,
        bestScore: row.score,
        totalPlays: 0,
        lastPlayed: row.completed_at,
        wins: 0,
        losses: 0,
      };
      byGame.set(row.game_id, stat);
    }
    if (row.score > stat.bestScore) stat.bestScore = row.score;
    if (row.completed_at > stat.lastPlayed) stat.lastPlayed = row.completed_at;
    stat.totalPlays++;
    if (row.score > 0) stat.wins++;
    else stat.losses++;
  }

  res.json(Array.from(byGame.values()));
}));

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

const DISCONNECT_TIMEOUT_MS =
  parseInt(process.env.DISCONNECT_TIMEOUT_MS, 10) || 60 * 1000;
const disconnectTimers = new Map();

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigin || '*',
    methods: ['GET', 'POST'],
  },
});

async function finishGame(roomCode, winnerId, loserId, options = {}) {
  const { winnerScore = 1, reason = null } = options;
  const room = rooms.getRoom(roomCode);
  if (!room) {
    console.log('[finishGame] room not found:', roomCode);
    return;
  }

  const pending = disconnectTimers.get(roomCode);
  if (pending) {
    clearTimeout(pending);
    disconnectTimers.delete(roomCode);
  }

  rooms.updateStatus(roomCode, 'finished');

  const completed_at = new Date().toISOString();
  try {
    const { error } = await supabase.from('scores').insert([
      { user_id: winnerId, game_id: room.gameId, score: winnerScore, completed_at },
      { user_id: loserId, game_id: room.gameId, score: 0, completed_at },
    ]);
    if (error) console.error('[finishGame] score insert error:', error);
  } catch (e) {
    console.error('[finishGame] score insert threw:', e.message);
  }

  const payload = { winnerId, loserId };
  if (reason) payload.reason = reason;
  console.log('[game_over] emitting match_result to room:', roomCode);
  io.to(roomCode).emit('match_result', payload);
}

function buildStateSync(room) {
  if (!room?.gameState) return null;
  if (room.gameId === 'chess') {
    const chess = new Chess(room.gameState.fen);
    const turnColor = chess.turn();
    const currentTurn =
      turnColor === 'w' ? room.players[0]?.id : room.players[1]?.id;
    return {
      fen: room.gameState.fen,
      turn: turnColor,
      currentTurn,
      clock: room.gameState.clock,
      pgn: games.buildPgn(room.gameState.moves || []),
    };
  }
  if (room.gameId === 'snake-and-ladder') {
    return {
      positions: room.gameState.positions,
      currentTurn: room.gameState.turn,
      diceResult: room.gameState.lastDice || null,
      rollHistory: room.gameState.rollHistory || [],
    };
  }
  return room.gameState;
}

io.on('connection', (socket) => {
  console.log(`[socket.io] client connected: ${socket.id}`);
  io.emit('online_count', { count: io.sockets.sockets.size });

  socket.on('user_connected', async (payload = {}) => {
    const { userId, username } = payload;
    if (!userId || !username) return;
    presence.setOnline(userId, username, socket.id);

    const friendIds = await fetchAcceptedFriendIds(userId);
    for (const friendId of friendIds) {
      const friendSocketId = presence.getSocketId(friendId);
      if (friendSocketId) {
        io.to(friendSocketId).emit('friend_online', { userId, username });
      }
    }
  });

  socket.on('send_friend_invite', (payload = {}) => {
    const { toUserId, roomCode, gameId, fromUsername } = payload;
    const targetSocketId = presence.getSocketId(toUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('friend_invite_received', {
        roomCode,
        gameId,
        fromUsername,
      });
    } else {
      socket.emit('invite_failed', { message: 'Friend is offline' });
    }
  });

  socket.on('decline_friend_invite', (payload = {}) => {
    const { toUserId, fromUsername } = payload;
    const targetSocketId = presence.getSocketId(toUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('invite_declined', { fromUsername });
    }
  });

  socket.on('join_room', (payload = {}) => {
    const { roomCode, username } = payload;
    if (!roomCode || !username) {
      socket.emit('error', {
        message: 'roomCode and username are required',
      });
      return;
    }

    const existing = rooms.getRoom(roomCode);
    if (!existing) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    if (existing.players.length >= 2) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    const id = presence.getUserId(socket.id) || socket.id;
    const updated = rooms.addPlayer(roomCode, {
      id,
      username,
      socketId: socket.id,
    });
    if (!updated) {
      socket.emit('error', { message: 'Failed to join room' });
      return;
    }

    socket.join(roomCode);
    io.to(roomCode).emit('room_update', rooms.toPublicRoom(updated));
  });

  socket.on('player_ready', (payload = {}) => {
    const { roomCode } = payload;
    if (!roomCode) {
      socket.emit('error', { message: 'roomCode is required' });
      return;
    }

    const result = rooms.setReady(roomCode, socket.id);
    if (!result) {
      socket.emit('error', {
        message: 'Room not found or you are not in it',
      });
      return;
    }

    const { room, bothReady } = result;
    if (bothReady) {
      rooms.updateStatus(roomCode, 'in-progress');
      const initialState = games.initGameState(room.gameId, room.players);
      if (initialState) {
        rooms.setGameState(roomCode, initialState);
      }
    }
    io.to(roomCode).emit('room_update', rooms.toPublicRoom(room));
    if (bothReady) {
      const startPayload = { roomCode, gameId: room.gameId };
      if (room.gameState?.clock) startPayload.clock = room.gameState.clock;
      if (room.gameId === 'chess') {
        const [pW, pB] = room.players;
        if (pW?.socketId) {
          io.to(pW.socketId).emit('game_start', { ...startPayload, myColor: 'w' });
        }
        if (pB?.socketId) {
          io.to(pB.socketId).emit('game_start', { ...startPayload, myColor: 'b' });
        }
      } else {
        io.to(roomCode).emit('game_start', startPayload);
      }
    }
  });

  socket.on('roll_dice', (payload = {}) => {
    const { roomCode, playerId } = payload;
    if (!roomCode || !playerId) {
      socket.emit('error', {
        message: 'roomCode and playerId are required',
      });
      return;
    }
    const room = rooms.getRoom(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    if (!room.gameState) {
      socket.emit('error', { message: 'Game has not started' });
      return;
    }

    const playerIds = room.players.map((p) => p.id);
    const username = room.players.find((p) => p.id === playerId)?.username;
    const result = games.rollDice(room.gameState, playerIds, playerId, username);
    if (result.error) {
      socket.emit('error', { message: result.error });
      return;
    }

    io.to(roomCode).emit('dice_result', {
      roll: result.roll,
      newPosition: result.newPosition,
      nextTurn: result.nextTurn,
      winner: result.winner,
    });
  });

  socket.on('chess_move', async (payload = {}) => {
    const { roomCode, move } = payload;
    if (!roomCode || !move) {
      socket.emit('error', { message: 'roomCode and move are required' });
      return;
    }
    const room = rooms.getRoom(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    if (!room.gameState) {
      socket.emit('error', { message: 'Game has not started' });
      return;
    }

    const beforeFen = room.gameState.fen;
    console.log(
      `[chess_move] room=${roomCode} socket=${socket.id} move=${JSON.stringify(move)} before-fen=${beforeFen}`
    );

    const result = games.applyChessMove(room.gameState, move);
    if (result.error) {
      console.log(
        `[chess_move] rejected room=${roomCode} move=${JSON.stringify(move)} fen=${beforeFen}`
      );
      socket.emit('chess_move_error', {
        move,
        fen: beforeFen,
        error: result.error,
      });
      return;
    }

    console.log(`[chess_move] accepted room=${roomCode} after-fen=${result.fen}`);

    io.to(roomCode).emit('move_accepted', {
      move: result.move,
      fen: result.fen,
      turn: result.turn,
      isCheck: result.isCheck,
      isCheckmate: result.isCheckmate,
      clock: result.clock,
    });

    if (result.timedOut) {
      const flagged = result.timedOut;
      const loserPlayer = flagged === 'w' ? room.players[0] : room.players[1];
      const winnerPlayer = flagged === 'w' ? room.players[1] : room.players[0];
      await finishGame(room.code, winnerPlayer.id, loserPlayer.id, {
        reason: 'timeout',
      });
    }
  });

  socket.on('game_action', (payload = {}) => {
    const { roomCode, action } = payload;
    if (!roomCode) {
      socket.emit('error', { message: 'roomCode is required' });
      return;
    }
    socket.to(roomCode).emit('opponent_action', { action });
  });

  socket.on('game_state_sync', (payload = {}) => {
    const { roomCode, state } = payload;
    if (!roomCode) {
      socket.emit('error', { message: 'roomCode is required' });
      return;
    }
    io.to(roomCode).emit('state_sync', { state });
  });

  socket.on('game_over', async (payload = {}) => {
    console.log('[game_over] received:', payload);
    const { roomCode, winnerId, loserId, score, reason } = payload;
    if (!roomCode || !winnerId || !loserId) {
      socket.emit('error', {
        message: 'roomCode, winnerId, and loserId are required',
      });
      return;
    }
    const room = rooms.getRoom(roomCode);
    if (!room) {
      console.log('[game_over] room not found:', roomCode);
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    await finishGame(roomCode, winnerId, loserId, {
      winnerScore: score ?? 1,
      reason: reason || null,
    });
  });

  socket.on('reconnect_to_room', (payload = {}) => {
    const { roomCode, username } = payload;
    if (!roomCode || !username) {
      socket.emit('error', {
        message: 'roomCode and username are required',
      });
      return;
    }
    const room = rooms.getRoom(roomCode);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    const reattached = rooms.reattachPlayer(roomCode, username, socket.id);
    if (!reattached) {
      socket.emit('error', { message: 'Player was not in this room' });
      return;
    }

    socket.join(roomCode);

    const pendingTimer = disconnectTimers.get(roomCode);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      disconnectTimers.delete(roomCode);
      io.to(roomCode).emit('opponent_reconnected', { username });
    }

    io.to(roomCode).emit('room_update', rooms.toPublicRoom(room));

    const syncState = buildStateSync(room);
    if (syncState) {
      console.log('[turn] currentTurn userId:', syncState.currentTurn);
      io.to(roomCode).emit('state_sync', { state: syncState });
    }

    const other = room.players.find(
      (p) => p.username !== username && p.socketId
    );
    if (other) {
      io.to(other.socketId).emit('request_state_sync', { roomCode });
    }
  });

  socket.on('join_queue', (payload = {}) => {
    const { gameId, userId, username } = payload;
    if (!gameId || !userId || !username) {
      socket.emit('error', {
        message: 'gameId, userId, and username are required',
      });
      return;
    }
    if (!queues.isSupported(gameId)) {
      socket.emit('error', { message: 'Unsupported gameId' });
      return;
    }

    queues.leaveAllQueues(socket.id);
    queues.joinQueue(gameId, { userId, username, socketId: socket.id });

    const match = queues.findMatch(gameId);
    if (!match) {
      socket.emit('queue_waiting', {
        gameId,
        position: queues.getQueueLength(gameId),
      });
      return;
    }

    const [p1, p2] = match;
    const room = rooms.createRoom(gameId);
    rooms.addPlayer(room.code, {
      id: p1.userId,
      username: p1.username,
      socketId: p1.socketId,
    });
    rooms.addPlayer(room.code, {
      id: p2.userId,
      username: p2.username,
      socketId: p2.socketId,
    });
    rooms.updateStatus(room.code, 'in-progress');

    const initialState = games.initGameState(gameId, room.players);
    if (initialState) {
      rooms.setGameState(room.code, initialState);
    }

    io.sockets.sockets.get(p1.socketId)?.join(room.code);
    io.sockets.sockets.get(p2.socketId)?.join(room.code);

    const clockPayload = room.gameState?.clock
      ? { clock: room.gameState.clock }
      : {};
    const isChess = gameId === 'chess';
    io.to(p1.socketId).emit('queue_matched', {
      roomCode: room.code,
      gameId,
      opponentUsername: p2.username,
      ...clockPayload,
      ...(isChess ? { myColor: 'w' } : {}),
    });
    io.to(p2.socketId).emit('queue_matched', {
      roomCode: room.code,
      gameId,
      opponentUsername: p1.username,
      ...clockPayload,
      ...(isChess ? { myColor: 'b' } : {}),
    });

    io.to(room.code).emit('room_update', rooms.toPublicRoom(room));
  });

  socket.on('leave_queue', (payload = {}) => {
    const { gameId, userId } = payload;
    if (!gameId || !userId) {
      socket.emit('error', { message: 'gameId and userId are required' });
      return;
    }
    queues.leaveQueue(gameId, userId);
    socket.emit('queue_left', { gameId });
  });

  socket.on('queue_timeout', (payload = {}) => {
    const { gameId, userId } = payload;
    if (!gameId || !userId) {
      socket.emit('error', { message: 'gameId and userId are required' });
      return;
    }
    queues.leaveQueue(gameId, userId);
    socket.emit('queue_left', { gameId });
  });

  socket.on('disconnect', async (reason) => {
    console.log(`[socket.io] client disconnected: ${socket.id} (${reason})`);

    queues.leaveAllQueues(socket.id);

    const gameRoom = rooms.findRoomBySocketId(socket.id);
    if (gameRoom) {
      const leaver = gameRoom.players.find((p) => p.socketId === socket.id);
      if (gameRoom.status === 'in-progress') {
        rooms.markDisconnected(gameRoom.code, socket.id);
        const remaining = gameRoom.players.find((p) => p.id !== leaver.id);
        if (remaining?.socketId) {
          io.to(remaining.socketId).emit('opponent_disconnected', {
            username: leaver?.username,
            reconnectDeadline: Date.now() + DISCONNECT_TIMEOUT_MS,
          });
          const existingTimer = disconnectTimers.get(gameRoom.code);
          if (existingTimer) clearTimeout(existingTimer);
          const timerId = setTimeout(async () => {
            disconnectTimers.delete(gameRoom.code);
            await finishGame(gameRoom.code, remaining.id, leaver.id, {
              reason: 'disconnect_timeout',
            });
          }, DISCONNECT_TIMEOUT_MS);
          disconnectTimers.set(gameRoom.code, timerId);
        }
      } else {
        const updated = rooms.removePlayer(gameRoom.code, socket.id);
        if (updated) {
          io.to(gameRoom.code).emit('opponent_left', {
            userId: leaver?.id,
            username: leaver?.username,
          });
          io.to(gameRoom.code).emit('room_update', rooms.toPublicRoom(updated));
        }
      }
    }

    const userId = presence.setOffline(socket.id);
    if (userId) {
      const friendIds = await fetchAcceptedFriendIds(userId);
      for (const friendId of friendIds) {
        const friendSocketId = presence.getSocketId(friendId);
        if (friendSocketId) {
          io.to(friendSocketId).emit('friend_offline', { userId });
        }
      }
    }

    io.emit('online_count', { count: io.sockets.sockets.size });
  });
});

rooms.startCleanup();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('[cors] allowed origins:', corsOptions.origin);
  games.logBoardMap();
});
