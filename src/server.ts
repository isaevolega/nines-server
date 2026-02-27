// src/server.ts
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Room } from './game/Room';
import { ClientMessage, Player, RoomState, Suit } from './types';
import { v4 as uuidv4 } from 'uuid';

const PORT = process.env.PORT || 10000;
const rooms = new Map<string, Room>();
const wsClients = new Map<WebSocket, string>(); // ws -> playerId

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('OK');
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('New connection');

  ws.on('message', (data) => {
    try {
      const msg: ClientMessage = JSON.parse(data.toString());
      handleMessage(ws, msg);
    } catch (e) {
      console.error('Invalid JSON', e);
    }
  });

  ws.on('close', () => {
    const playerId = wsClients.get(ws);
    if (playerId) {
      console.log(`Player ${playerId} disconnected`);
      // Здесь будет логика дисконнекта (10 сек на реконнект)
    }
    wsClients.delete(ws);
  });
});

function handleMessage(ws: WebSocket, msg: ClientMessage) {
  if (msg.type === 'join') {
    handleJoin(ws, msg);
  } else if (msg.type === 'start_game') {
    handleStartGame(ws, msg);
  }
  // play_card, skip_turn, leave - добавим следующим шагом
}

function handleJoin(ws: WebSocket, msg: ClientMessage) {
  if (!msg.roomId || !msg.playerName) return;

  let room = rooms.get(msg.roomId);
  const playerId = msg.playerId || uuidv4();
  
  wsClients.set(ws, playerId);

  if (!room) {
    // Создаем новую комнату
    const organizer: Player = {
      id: playerId,
      name: msg.playerName,
      socketId: '',
      hand: [],
      status: 'active',
      isOrganizer: true,
      cardCount: 0
    };
    room = new Room(msg.roomId, organizer);
    rooms.set(msg.roomId, room);
  } else {
    // Присоединение к существующей
    if (room.state.gameOver || room.state.players.length >= 4) {
      send(ws, {
        type: 'notification',
        message: room.state.gameOver ? 'Игра уже началась' : 'Комната заполнена',
        severity: 'error'
      });
      return;
    }

    const existingPlayer = room.state.players.find(p => p.id === playerId);
    if (!existingPlayer) {
      const player: Player = {
        id: playerId,
        name: msg.playerName,
        socketId: '',
        hand: [],
        status: 'active',
        isOrganizer: false,
        cardCount: 0
      };
      room.addPlayer(player);
    } else {
      // Реконнект
      existingPlayer.status = 'active';
      existingPlayer.socketId = ''; // Обновим при необходимости
    }
  }

  // Отправляем join_success
  send(ws, {
    type: 'join_success',
    playerId: playerId,
    roomState: sanitizeState(room!.state, playerId)
  });
  
  // Уведомляем остальных в комнате
  broadcast(room!, {
    type: 'notification',
    message: `${msg.playerName} присоединился`,
    severity: 'info'
  }, playerId);
}

function handleStartGame(ws: WebSocket, msg: ClientMessage) {
  const playerId = wsClients.get(ws);
  if (!playerId) return;

  const room = Array.from(rooms.values()).find(r => 
    r.state.players.some(p => p.id === playerId && p.isOrganizer)
  );

  if (room) {
    const activePlayers = room.state.players.filter(p => p.status === 'active');
    if (activePlayers.length >= 2) {
      room.startGame();
      // Рассылаем game_state всем игрокам комнаты
      broadcast(room, {
        type: 'game_state',
        data: {} // Данные подставляются внутри broadcast для каждого игрока
      });
    } else {
      send(ws, {
        type: 'notification',
        message: 'Нужно минимум 2 игрока',
        severity: 'error'
      });
    }
  }
}

// Универсальная функция отправки
function send(ws: WebSocket, msg: any) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Рассылка всем игрокам в комнате
function broadcast(room: Room, msg: any, excludeId?: string) {
  wss.clients.forEach(client => {
    const pId = wsClients.get(client);
    const player = room.state.players.find(p => p.id === pId);
    
    if (client.readyState === WebSocket.OPEN && player && pId !== excludeId) {
      if (msg.type === 'game_state') {
        // Для game_state формируем индивидуальное состояние для каждого игрока
        send(client, {
          type: 'game_state',
          data: sanitizeState(room.state, pId!)
        });
      } else {
        send(client, msg);
      }
    }
  });
}

// Скрываем карты других игроков, оставляем только cardCount
function sanitizeState(state: RoomState, viewerId: string): any {
  const activePlayers = state.players.filter(p => p.status === 'active');
  const currentPlayer = activePlayers[state.turnIndex];

  return {
    roomId: state.roomId,
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      cardCount: p.cardCount,
      isCurrentTurn: currentPlayer?.id === p.id,
      status: p.status,
      isOrganizer: p.isOrganizer
    })),
    centerPiles: Object.fromEntries(
      Object.entries(state.piles).map(([suit, cards]) => [
        suit,
        cards.map(c => c.rank) // Отправляем только ранги для отображения
      ])
    ),
    timer: state.timer,
    gameOver: state.gameOver,
    firstMoveAutoPlayed: state.firstMoveAutoPlayed
  };
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});