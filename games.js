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
      currentTurn: p1.id,
      lastDice: null,
      rollHistory: [],
    };
  }
  if (gameId === 'chess') {
    const state = {
      fen: new Chess().fen(),
      moves: [],
      moveCount: 0,
      clock: {
        white: CHESS_CLOCK_SECONDS,
        black: CHESS_CLOCK_SECONDS,
        activeColor: 'w',
        lastTickAt: null,
        running: false,
      },
    };
    console.log('[clock] initialized:', state.clock);
    return state;
  }
  return null;
}

function rollDice(state, playerIds, playerId, username) {
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

  console.log('[s&l] dice:', {
    player: username,
    from: oldPosition,
    roll,
    landedOn,
    final: newPosition,
    trigger:
      landedOn !== newPosition
        ? LADDERS[landedOn]
          ? 'ladder'
          : 'snake'
        : 'none',
  });

  state.positions[playerId] = newPosition;
  const winner = newPosition === FINAL_SQUARE ? playerId : null;
  const otherId = playerIds.find((id) => id !== playerId);
  const nextTurn = winner ? null : otherId;
  state.turn = nextTurn;
  state.currentTurn = nextTurn;
  state.lastDice = { roll, by: playerId, newPosition, winner };

  state.rollHistory = state.rollHistory || [];
  state.rollHistory.push({
    player: username,
    roll,
    from: oldPosition,
    final: newPosition,
  });
  while (state.rollHistory.length > 30) state.rollHistory.shift();

  if (winner) {
    console.log(
      '[s&l] game ended, roll history:',
      JSON.stringify(state.rollHistory)
    );
  }

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
  state.moveCount = (state.moveCount || 0) + 1;

  let clock = null;
  let timedOut = null;
  if (state.clock) {
    const moverColor = state.clock.activeColor;

    if (state.moveCount === 1) {
      state.clock.activeColor = chess.turn();
      state.clock.lastTickAt = Date.now();
      state.clock.running = true;
    } else {
      const moverKey = moverColor === 'w' ? 'white' : 'black';
      const elapsed = (Date.now() - state.clock.lastTickAt) / 1000;
      state.clock[moverKey] = Math.max(0, state.clock[moverKey] - elapsed);
      state.clock.activeColor = chess.turn();
      state.clock.lastTickAt = Date.now();
      state.clock.running = true;
      if (state.clock[moverKey] <= 0) {
        timedOut = moverColor;
      }
    }

    clock = { ...state.clock };
    console.log('[clock] after move:', {
      movedColor: moverColor,
      newActiveColor: state.clock.activeColor,
      white: state.clock.white,
      black: state.clock.black,
    });
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
