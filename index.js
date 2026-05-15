require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const supabase = require('./supabase');
const rooms = require('./rooms');
const presence = require('./presence');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/scores', async (req, res) => {
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
});

app.get('/api/scores/leaderboard/:gameId', async (req, res) => {
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
});

app.post('/api/rooms/create', (req, res) => {
  const { gameId, username } = req.body || {};
  if (!gameId || !username) {
    return res.status(400).json({ error: 'gameId and username are required' });
  }
  const room = rooms.createRoom(gameId);
  res.json({ code: room.code, room: rooms.toPublicRoom(room) });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = rooms.getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(rooms.toPublicRoom(room));
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

app.post('/api/friends/request', async (req, res) => {
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
});

app.post('/api/friends/accept', async (req, res) => {
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
});

app.post('/api/friends/remove', async (req, res) => {
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
});

app.get('/api/friends/:userId/pending', async (req, res) => {
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
});

app.get('/api/friends/:userId', async (req, res) => {
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
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  console.log(`[socket.io] client connected: ${socket.id}`);

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

  socket.on('disconnect', async (reason) => {
    console.log(`[socket.io] client disconnected: ${socket.id} (${reason})`);
    const userId = presence.setOffline(socket.id);
    if (!userId) return;

    const friendIds = await fetchAcceptedFriendIds(userId);
    for (const friendId of friendIds) {
      const friendSocketId = presence.getSocketId(friendId);
      if (friendSocketId) {
        io.to(friendSocketId).emit('friend_offline', { userId });
      }
    }
  });
});

rooms.startCleanup();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Arcadia backend listening on port ${PORT}`);
});
