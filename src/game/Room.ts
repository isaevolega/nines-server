// src/game/Room.ts
import { v4 as uuidv4 } from 'uuid';
import { Card, Player, RoomState, Suit, PlayerStatus } from '../types';
import { createDeck, shuffleDeck } from './Deck';
import { getValidMoves, isValidMove } from './Validator';

export class Room {
  public id: string;
  public state: RoomState;
  private timerInterval: NodeJS.Timeout | null = null;
  private disconnectTimers: Map<string, NodeJS.Timeout> = new Map(); // playerId -> timeout

  constructor(id: string, organizer: Player) {
    this.id = id;
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
  }

  addPlayer(player: Player): boolean {
    if (this.state.players.length >= 4) return false;
    if (this.state.gameOver) return false;

    const existing = this.state.players.find(p => p.id === player.id);
    if (existing) {
      existing.status = 'active';
      existing.socketId = player.socketId;
      // Отменяем таймер дисконнекта
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
      // Запускаем таймер на 10 сек (упрощенно, в реальности можно удалять позже)
      // По ТЗ: через 10 сек помечает как «Не в сети». Авто-ходы работают.
    }
  }

  scheduleDisconnect(playerId: string, callback: () => void): void {
    // Если уже есть таймер — сбрасываем
    if (this.disconnectTimers.has(playerId)) {
      clearTimeout(this.disconnectTimers.get(playerId)!);
    }
    const timer = setTimeout(() => {
      this.markDisconnected(playerId);
      callback();
      this.disconnectTimers.delete(playerId);
    }, 10000); // 10 секунд по ТЗ
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

    // Авто-ход 9♦
    this.executeFirstAutoMove();
    
    return true;
  }

  private executeFirstAutoMove(): void {
    const activePlayers = this.state.players.filter(p => p.status === 'active');
    const playerWith9Diamonds = activePlayers.find(p => 
      p.hand.some(c => c.suit === 'diamonds' && c.rank === '9')
    );

    if (playerWith9Diamonds) {
      const playerIndex = activePlayers.findIndex(p => p.id === playerWith9Diamonds.id);
      const cardIndex = playerWith9Diamonds.hand.findIndex(c => c.suit === 'diamonds' && c.rank === '9');
      
      if (cardIndex > -1) {
        const card = playerWith9Diamonds.hand.splice(cardIndex, 1)[0];
        this.state.piles.diamonds.push(card);
        playerWith9Diamonds.cardCount = playerWith9Diamonds.hand.length;
        
        this.state.firstMoveAutoPlayed = true;
        this.state.turnIndex = (playerIndex + 1) % activePlayers.length;
      }
    } else {
      this.state.firstMoveAutoPlayed = true;
      this.state.turnIndex = 0;
    }
    
    this.startTurnTimer();
  }

  playCard(playerId: string, card: Card): { success: boolean; message?: string } {
    const activePlayers = this.state.players.filter(p => p.status === 'active');
    const currentPlayer = activePlayers[this.state.turnIndex];

    if (!currentPlayer || currentPlayer.id !== playerId) {
      return { success: false, message: 'Сейчас не ваш ход' };
    }

    const pile = this.state.piles[card.suit];
    if (!isValidMove(card, pile || [])) {
      return { success: false, message: 'Неверный ход' };
    }

    // Удаляем из руки
    const cardIndex = currentPlayer.hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (cardIndex === -1) return { success: false, message: 'Карты нет в руке' };

    currentPlayer.hand.splice(cardIndex, 1);
    currentPlayer.cardCount = currentPlayer.hand.length;

    // Кладем в стопку
    this.state.piles[card.suit].push(card);

    // Проверка победы
    if (currentPlayer.cardCount === 0) {
      this.endGame(currentPlayer.id);
      return { success: true };
    }

    // Передача хода
    this.state.turnIndex = (this.state.turnIndex + 1) % activePlayers.length;
    this.startTurnTimer();

    return { success: true };
  }

  skipTurn(playerId: string): { success: boolean; message?: string } {
    const activePlayers = this.state.players.filter(p => p.status === 'active');
    const currentPlayer = activePlayers[this.state.turnIndex];

    if (!currentPlayer || currentPlayer.id !== playerId) {
      return { success: false, message: 'Сейчас не ваш ход' };
    }

    // Проверка: можно пропускать только если нет валидных ходов
    const validMoves = getValidMoves(currentPlayer.hand, this.state.piles);
    if (validMoves.length > 0) {
      return { success: false, message: 'Есть доступные ходы' };
    }

    this.state.turnIndex = (this.state.turnIndex + 1) % activePlayers.length;
    this.startTurnTimer();
    return { success: true };
  }

  private startTurnTimer(): void {
    if (this.timerInterval) clearInterval(this.timerInterval);

    const activePlayers = this.state.players.filter(p => p.status === 'active');
    const currentPlayer = activePlayers[this.state.turnIndex];

    if (!currentPlayer || this.state.gameOver) {
      this.state.timer = 0;
      return;
    }

    // Проверка на доступные ходы
    const validMoves = getValidMoves(currentPlayer.hand, this.state.piles);
    
    if (validMoves.length === 0) {
      // Если ходов нет — мгновенный пропуск
      this.state.timer = 0;
      this.skipTurn(currentPlayer.id);
      return;
    }

    // Запуск таймера
    this.state.timer = 30;
    this.timerInterval = setInterval(() => {
      if (this.state.timer > 0) {
        this.state.timer--;
      } else {
        this.handleTimerEnd();
      }
    }, 1000);
  }

  private handleTimerEnd(): void {
    if (this.timerInterval) clearInterval(this.timerInterval);
    
    const activePlayers = this.state.players.filter(p => p.status === 'active');
    const currentPlayer = activePlayers[this.state.turnIndex];

    if (!currentPlayer) return;

    const validMoves = getValidMoves(currentPlayer.hand, this.state.piles);
    if (validMoves.length > 0) {
      // Авто-ход случайной картой
      const randomCard = validMoves[Math.floor(Math.random() * validMoves.length)];
      this.playCard(currentPlayer.id, randomCard);
      // Уведомление об авто-ходе отправляется через сервер
    } else {
      // Авто-пропуск
      this.skipTurn(currentPlayer.id);
    }
  }

  private endGame(winnerId: string): void {
    this.state.gameOver = true;
    if (this.timerInterval) clearInterval(this.timerInterval);
    // Логика ранжирования остальных игроков по количеству карт
  }

  getCurrentPlayer(): Player | undefined {
    const activePlayers = this.state.players.filter(p => p.status === 'active');
    return activePlayers[this.state.turnIndex];
  }

  removePlayer(playerId: string): void {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return;

    // Помечаем как вышедшего
    player.status = 'left';

    // Если организатор вышел — передаем права первому активному игроку
    if (player.isOrganizer) {
      const activePlayers = this.state.players.filter(
        p => p.id !== playerId && p.status === 'active'
      );
      if (activePlayers.length > 0) {
        activePlayers[0].isOrganizer = true;
      }
    }

    // Если текущий ход этого игрока — передаем ход следующему
    const activePlayers = this.state.players.filter(p => p.status === 'active');
    if (activePlayers.length > 0) {
      const currentPlayer = activePlayers[this.state.turnIndex];
      if (currentPlayer?.id === playerId) {
        this.state.turnIndex = (this.state.turnIndex + 1) % activePlayers.length;
        this.startTurnTimer();
      }
    }

    // Отменяем таймер дисконнекта если был
    if (this.disconnectTimers.has(playerId)) {
      clearTimeout(this.disconnectTimers.get(playerId)!);
      this.disconnectTimers.delete(playerId);
    }
  }
}