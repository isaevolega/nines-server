// src/game/Room.ts
import { Card, Player, RoomState, Suit, PlayerStatus } from '../types';
import { createDeck, shuffleDeck } from './Deck';
import { getValidMoves, isValidMove } from './Validator';

export class Room {
  public id: string;
  public state: RoomState;
  private timerInterval: NodeJS.Timeout | null = null;
  private skipTimerInterval: NodeJS.Timeout | null = null;
  private disconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private roomTimeout: NodeJS.Timeout | null = null;
  private eliminationOrder: string[] = [];
  
  // 🔥 Callback'и для отправки данных клиентам (передаются из server.ts)
  private onGameStateUpdate: (room: Room) => void;
  private onNotificationBroadcast: (room: Room, message: string, severity: string) => void;

  constructor(
    id: string, 
    organizer: Player,
    onGameStateUpdate: (room: Room) => void,
    onNotificationBroadcast: (room: Room, message: string, severity: string) => void
  ) {
    this.id = id;
    this.onGameStateUpdate = onGameStateUpdate;
    this.onNotificationBroadcast = onNotificationBroadcast;
    this.state = {
      roomId: id,
      players: [organizer],
      piles: { diamonds: [], hearts: [], spades: [], clubs: [] },
      turnIndex: 0,
      timer: 30,
      gameOver: false,
      firstMoveAutoPlayed: false,
      createdAt: Date.now(),
    };

    this.startRoomTimeout();
  }

  private startRoomTimeout(): void {
    const ONE_HOUR = 60 * 60 * 1000;
    this.roomTimeout = setTimeout(() => {
      this.forceEndGame();
    }, ONE_HOUR);
  }

  private forceEndGame(): void {
    if (this.state.gameOver) return;
    
    this.state.gameOver = true;
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.skipTimerInterval) clearInterval(this.skipTimerInterval);
    if (this.roomTimeout) clearTimeout(this.roomTimeout);
    
    // Отправляем финальное состояние
    this.broadcastGameState();
  }

  public getRankings(): { playerId: string; place: number }[] {
    return this.calculateRankings();
  }

  private calculateRankings(): { playerId: string; place: number }[] {
    const activePlayers = this.state.players.filter(p => p.status !== 'left');
    
    const sorted = [...activePlayers].sort((a, b) => {
      if (a.cardCount !== b.cardCount) {
        return a.cardCount - b.cardCount;
      }
      const aIndex = this.eliminationOrder.indexOf(a.id);
      const bIndex = this.eliminationOrder.indexOf(b.id);
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      if (aIndex !== -1) return 1;
      if (bIndex !== -1) return -1;
      return 0;
    });

    return sorted.map((player, index) => ({
      playerId: player.id,
      place: index + 1
    }));
  }

  addPlayer(player: Player): boolean {
    if (this.state.players.length >= 4) return false;
    if (this.state.gameOver) return false;

    const existing = this.state.players.find(p => p.id === player.id);
    if (existing) {
      existing.status = 'active';
      existing.socketId = player.socketId;
      if (this.disconnectTimers.has(player.id)) {
        clearTimeout(this.disconnectTimers.get(player.id)!);
        this.disconnectTimers.delete(player.id);
      }
      return true;
    }
    this.state.players.push(player);
    return true;
  }

  markDisconnected(playerId: string): void {
    const player = this.state.players.find(p => p.id === playerId);
    if (player) {
      player.status = 'offline';
      this.broadcastGameState(); // Обновляем статус для всех
    }
  }

  scheduleDisconnect(playerId: string, callback: () => void): void {
    if (this.disconnectTimers.has(playerId)) {
      clearTimeout(this.disconnectTimers.get(playerId)!);
    }
    const timer = setTimeout(() => {
      this.markDisconnected(playerId);
      callback();
      this.disconnectTimers.delete(playerId);
    }, 10000);
    this.disconnectTimers.set(playerId, timer);
  }

  cancelDisconnect(playerId: string): void {
    if (this.disconnectTimers.has(playerId)) {
      clearTimeout(this.disconnectTimers.get(playerId)!);
      this.disconnectTimers.delete(playerId);
    }
  }

  startGame(): boolean {
    const activePlayers = this.state.players.filter(p => p.status === 'active');
    if (activePlayers.length < 2) return false;

    const deck = shuffleDeck(createDeck());
    const cardsPerPlayer = 36 / activePlayers.length;

    activePlayers.forEach((player, index) => {
      player.hand = deck.slice(index * cardsPerPlayer, (index + 1) * cardsPerPlayer);
      player.cardCount = player.hand.length;
    });

    this.state.gameOver = false;
    this.state.firstMoveAutoPlayed = false;
    this.state.turnIndex = 0;
    this.eliminationOrder = [];

    this.executeFirstAutoMove();
    
    return true;
  }

  private executeFirstAutoMove(): void {
    const activePlayers = this.state.players.filter(p => p.status === 'active');
    const playerWith9Diamonds = activePlayers.find(p => 
      p.hand.some(c => c.suit === 'diamonds' && c.rank === '9')
    );

    if (playerWith9Diamonds) {
      const playerIndex = this.state.players.findIndex(p => p.id === playerWith9Diamonds.id);
      const cardIndex = playerWith9Diamonds.hand.findIndex(c => c.suit === 'diamonds' && c.rank === '9');
      
      if (cardIndex > -1) {
        const card = playerWith9Diamonds.hand.splice(cardIndex, 1)[0];
        this.state.piles.diamonds.push(card);
        playerWith9Diamonds.cardCount = playerWith9Diamonds.hand.length;
        
        this.state.firstMoveAutoPlayed = true;
        this.state.turnIndex = (playerIndex + 1) % this.state.players.length;
        
        console.log(`[AUTO] Первый ход: ${playerWith9Diamonds.name} сыграл 9♦`);
      }
    } else {
      this.state.firstMoveAutoPlayed = true;
      this.state.turnIndex = 0;
    }
    
    // Отправляем состояние после авто-хода
    this.broadcastGameState();
    
    // Запускаем таймер для следующего игрока
    this.startTurnTimer();
  }

  private getCurrentActivePlayer(): Player | undefined {
    let attempts = 0;
    while (attempts < this.state.players.length) {
      const player = this.state.players[this.state.turnIndex];
      if (player && player.status === 'active') {
        return player;
      }
      this.state.turnIndex = (this.state.turnIndex + 1) % this.state.players.length;
      attempts++;
    }
    return undefined;
  }

  playCard(playerId: string, card: Card): { success: boolean; message?: string } {
    console.log('[PLAY] playCard', playerId, card);
    
    const currentPlayer = this.getCurrentActivePlayer();

    if (!currentPlayer || currentPlayer.id !== playerId) {
      console.log('[PLAY] Не ваш ход:', currentPlayer?.id, playerId);
      return { success: false, message: 'Сейчас не ваш ход' };
    }

    const pile = this.state.piles[card.suit];
    if (!isValidMove(card, pile || [])) {
      console.log('[PLAY] Неверный ход');
      return { success: false, message: 'Неверный ход' };
    }

    const cardIndex = currentPlayer.hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (cardIndex === -1) return { success: false, message: 'Карты нет в руке' };

    currentPlayer.hand.splice(cardIndex, 1);
    currentPlayer.cardCount = currentPlayer.hand.length;

    this.state.piles[card.suit].push(card);

    console.log('[PLAY] Ход успешен, карт осталось:', currentPlayer.cardCount);

    // 🔥 Проверка победы
    if (currentPlayer.cardCount === 0) {
      console.log('[PLAY] Победа!', playerId);
      this.eliminationOrder.push(playerId);
      this.endGame(currentPlayer.id);
      return { success: true };
    }

    // 🔥 Передаём ход и отправляем обновление
    this.advanceTurn();
    return { success: true };
  }

  skipTurn(playerId: string): { success: boolean; message?: string } {
    const currentPlayer = this.getCurrentActivePlayer();

    if (!currentPlayer || currentPlayer.id !== playerId) {
      return { success: false, message: 'Сейчас не ваш ход' };
    }

    const validMoves = getValidMoves(currentPlayer.hand, this.state.piles);
    if (validMoves.length > 0) {
      return { success: false, message: 'Есть доступные ходы' };
    }

    console.log(`[SKIP] Игрок ${currentPlayer.name} нажал кнопку пропуска`);
    this.handleSkipTurn(playerId);
    return { success: true };
  }

  private startTurnTimer(): void {
    // Очищаем старые таймеры
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.skipTimerInterval) {
      clearInterval(this.skipTimerInterval);
      this.skipTimerInterval = null;
    }

    const currentPlayer = this.getCurrentActivePlayer();
    if (!currentPlayer || this.state.gameOver) {
      this.state.timer = 0;
      return;
    }

    const validMoves = getValidMoves(currentPlayer.hand, this.state.piles);
    
    console.log(`[TIMER] Игрок ${currentPlayer.name}, валидных ходов: ${validMoves.length}`);
    
    if (validMoves.length === 0) {
      // 🔥 НЕТ ВАЛИДНЫХ ХОДОВ — таймер 10 секунд + кнопка «Пропустить»
      console.log('[TIMER] Нет ходов — запускаем таймер пропуска (10 сек)');
      this.state.timer = 10;
      
      this.skipTimerInterval = setInterval(() => {
        if (this.state.timer > 0) {
          this.state.timer--;
          console.log(`[SKIP_TIMER] ${currentPlayer.name}: ${this.state.timer} сек до пропуска`);
          
          this.broadcastGameState();
        } else {
          console.log('[SKIP_TIMER] Таймер пропуска истёк — автоматический пропуск');
          this.handleSkipTurn(currentPlayer.id);
        }
      }, 1000);
      
      this.broadcastGameState();
    } else {
      // 🔥 ЕСТЬ ВАЛИДНЫЕ ХОДЫ — таймер 30 секунд + авто-ход
      console.log('[TIMER] Есть ходы — запускаем таймер хода (30 сек)');
      this.state.timer = 30;
      
      this.timerInterval = setInterval(() => {
        if (this.state.timer > 0) {
          this.state.timer--;
          console.log(`[TIMER] ${currentPlayer.name}: ${this.state.timer} сек`);
          
          this.broadcastGameState();
        } else {
          console.log('[TIMER] Таймер хода истёк — автоматический ход');
          this.handleTimerEnd();
        }
      }, 1000);
      
      this.broadcastGameState();
    }
  }

  private handleSkipTurn(playerId: string): void {
    if (this.skipTimerInterval) {
      clearInterval(this.skipTimerInterval);
      this.skipTimerInterval = null;
    }

    const currentPlayer = this.getCurrentActivePlayer();
    if (!currentPlayer || currentPlayer.id !== playerId) {
      console.log('[SKIP] Неверный игрок для пропуска');
      return;
    }

    console.log(`[SKIP] Игрок ${currentPlayer.name} пропустил ход`);
    
    // 🔥 Уведомление всем игрокам о пропуске
    this.broadcastNotification(`${currentPlayer.name}: нет доступных ходов`, 'info');
    
    // Передаём ход следующему
    this.advanceTurn();
  }

  private broadcastGameState(): void {
    console.log('[BROADCAST] Вызов callback для отправки game_state');
    this.onGameStateUpdate(this);
  }

  private advanceTurn(): void {
    console.log('[TURN] До переключения: turnIndex =', this.state.turnIndex);
    
    this.state.turnIndex = (this.state.turnIndex + 1) % this.state.players.length;
    
    let attempts = 0;
    while (attempts < this.state.players.length) {
      const player = this.state.players[this.state.turnIndex];
      if (player && player.status === 'active') {
        console.log('[TURN] Найден активный игрок:', player.name);
        break;
      }
      console.log('[TURN] Пропускаем неактивного:', player?.name || 'undefined');
      this.state.turnIndex = (this.state.turnIndex + 1) % this.state.players.length;
      attempts++;
    }
    
    console.log('[TURN] После переключения: turnIndex =', this.state.turnIndex);
    
    // 🔥 Отправляем обновление перед запуском таймера
    this.broadcastGameState();
    
    this.startTurnTimer();
  }

  private handleTimerEnd(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    
    const currentPlayer = this.getCurrentActivePlayer();
    if (!currentPlayer) return;

    const validMoves = getValidMoves(currentPlayer.hand, this.state.piles);
    
    if (validMoves.length > 0) {
      // Авто-ход случайной картой
      const randomIndex = Math.floor(Math.random() * validMoves.length);
      const randomCard = validMoves[randomIndex];
      
      console.log(`[AUTO] Автоматический ход: ${randomCard.rank}${randomCard.suit}`);
      
      const cardIndex = currentPlayer.hand.findIndex(
        c => c.suit === randomCard.suit && c.rank === randomCard.rank
      );
      
      if (cardIndex > -1) {
        currentPlayer.hand.splice(cardIndex, 1);
        currentPlayer.cardCount = currentPlayer.hand.length;
        this.state.piles[randomCard.suit].push(randomCard);
        
        if (currentPlayer.cardCount === 0) {
          this.eliminationOrder.push(currentPlayer.id);
          this.endGame(currentPlayer.id);
          return;
        }
      }
      
      // 🔥 Уведомление об авто-ходе
      this.broadcastNotification(`${currentPlayer.name}: автоматический ход`, 'info');
      
      this.advanceTurn();
    } else {
      // Если вдруг ходов нет — пропускаем
      this.handleSkipTurn(currentPlayer.id);
    }
  }

  private broadcastNotification(message: string, severity: 'info' | 'error' | 'success' = 'info'): void {
    console.log(`[NOTIFICATION] ${message} (${severity})`);
    this.onNotificationBroadcast(this, message, severity);
  }

  private endGame(winnerId: string): void {
    console.log('[GAME] Игра завершена, победитель:', winnerId);
    this.state.gameOver = true;
    
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.skipTimerInterval) {
      clearInterval(this.skipTimerInterval);
      this.skipTimerInterval = null;
    }
    if (this.roomTimeout) clearTimeout(this.roomTimeout);
    
    // 🔥 Отправляем game_over всем игрокам
    this.broadcastGameState();
  }

  getCurrentPlayer(): Player | undefined {
    return this.getCurrentActivePlayer();
  }

  removePlayer(playerId: string): void {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return;

    player.status = 'left';
    
    if (!this.eliminationOrder.includes(playerId)) {
      this.eliminationOrder.push(playerId);
    }

    // Уведомление об выходе
    this.broadcastNotification(`${player.name} покинул игру`, 'info');

    if (player.isOrganizer) {
      const activePlayers = this.state.players.filter(
        p => p.id !== playerId && p.status === 'active'
      );
      if (activePlayers.length > 0) {
        activePlayers[0].isOrganizer = true;
      }
    }

    const activePlayers = this.state.players.filter(p => p.status === 'active');
    if (activePlayers.length > 0) {
      const currentPlayer = this.getCurrentActivePlayer();
      if (currentPlayer?.id === playerId) {
        this.advanceTurn();
      }
    }

    if (this.disconnectTimers.has(playerId)) {
      clearTimeout(this.disconnectTimers.get(playerId)!);
      this.disconnectTimers.delete(playerId);
    }

    // Если остался 1 игрок — объявляем победителем
    if (activePlayers.length === 1 && this.state.players.some(p => p.hand.length > 0)) {
      const lastPlayer = activePlayers[0];
      if (!this.state.gameOver) {
        this.eliminationOrder.push(lastPlayer.id);
        this.endGame(lastPlayer.id);
      }
    }
    
    // Отправляем обновление после удаления игрока
    this.broadcastGameState();
  }

  destroy(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.skipTimerInterval) {
      clearInterval(this.skipTimerInterval);
      this.skipTimerInterval = null;
    }
    if (this.roomTimeout) clearTimeout(this.roomTimeout);
    this.disconnectTimers.forEach(timer => clearTimeout(timer));
    this.disconnectTimers.clear();
  }
}