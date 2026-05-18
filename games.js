const { Chess } = require('chess.js');

const LADDERS = {
  4: 25,
  13: 46,
  33: 52,
  42: 63,
  50: 69,
  57: 76,
  62: 81,
  71: 92,
};
const SNAKES = {
  17: 3,
  35: 14,
  54: 28,
  63: 37,
  72: 51,
  88: 24,
  93: 45,
  97: 61,
  98: 6,
};
const FINAL_SQUARE = 100;
const CHESS_CLOCK_SECONDS = 600;

function logBoardMap() {
  console.log('[s&l] ladders:', LADDERS);
  console.log('[s&l] snakes:', SNAKES);
}

function initGameState(gameId, players) {
  if (gameId === 'snake-and-ladder') {
    const [p1, p2] = players;
    return {
      positions: { [p1.id]: 1, [p2.id]: 1 },
      turn: p1.id,
      lastDice: null,
    };
  }
  if (gameId === 'chess') {
    return {
      fen: new Chess().fen(),
      moves: [],
      clock: {
        white: CHESS_CLOCK_SECONDS,
        black: CHESS_CLOCK_SECONDS,
        activeColor: 'w',
        lastTickAt: Date.now(),
      },
    };
  }
  return null;
}

function rollDice(state, playerIds, playerId) {
  if (state.turn !== playerId) {
    return { error: 'Not your turn' };
  }
  const roll = Math.floor(Math.random() * 6) + 1;
  const oldPosition = state.positions[playerId];
  const landedOn = oldPosition + roll;
  let newPosition = landedOn;

  if (landedOn > FINAL_SQUARE) {
    console.log(`[s&l] overshoot ${FINAL_SQUARE}, staying at ${oldPosition}`);
    newPosition = oldPosition;
  } else {
    if (LADDERS[newPosition]) {
      const dest = LADDERS[newPosition];
      console.log(`[s&l] ladder triggered: from ${newPosition} to ${dest}`);
      newPosition = dest;
    }
    if (SNAKES[newPosition]) {
      const dest = SNAKES[newPosition];
      console.log(`[s&l] snake triggered: from ${newPosition} to ${dest}`);
      newPosition = dest;
    }
  }

  console.log('[s&l] move resolved:', {
    from: oldPosition,
    roll,
    landedOn,
    final: newPosition,
  });

  state.positions[playerId] = newPosition;
  const winner = newPosition === FINAL_SQUARE ? playerId : null;
  const otherId = playerIds.find((id) => id !== playerId);
  const nextTurn = winner ? null : otherId;
  state.turn = nextTurn;
  state.lastDice = { roll, by: playerId, newPosition, winner };

  return { roll, newPosition, nextTurn, winner };
}

function applyChessMove(state, move) {
  const chess = new Chess(state.fen);
  let result;
  try {
    result = chess.move(move);
  } catch {
    return { error: 'Invalid move' };
  }
  if (!result) return { error: 'Invalid move' };

  state.fen = chess.fen();
  state.moves = state.moves || [];
  state.moves.push(result.san);

  let clock = null;
  let timedOut = null;
  if (state.clock) {
    const moverColor = state.clock.activeColor;
    const moverKey = moverColor === 'w' ? 'white' : 'black';
    const elapsed = (Date.now() - state.clock.lastTickAt) / 1000;
    state.clock[moverKey] = Math.max(0, state.clock[moverKey] - elapsed);
    state.clock.activeColor = moverColor === 'w' ? 'b' : 'w';
    state.clock.lastTickAt = Date.now();
    clock = { ...state.clock };
    if (state.clock[moverKey] <= 0) {
      timedOut = moverColor;
    }
  }

  return {
    move: result,
    fen: chess.fen(),
    turn: chess.turn(),
    isCheck: chess.inCheck(),
    isCheckmate: chess.isCheckmate(),
    clock,
    timedOut,
  };
}

function buildPgn(moves) {
  if (!moves || moves.length === 0) return '';
  const c = new Chess();
  for (const san of moves) {
    try {
      c.move(san);
    } catch {
      break;
    }
  }
  return c.pgn();
}

module.exports = { initGameState, rollDice, applyChessMove, buildPgn, logBoardMap };
