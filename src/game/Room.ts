// src/game/Room.ts
import { Card, Player, RoomState, Suit, PlayerStatus } from '../types';
import { createDeck, shuffleDeck } from './Deck';
import { getValidMoves, isValidMove } from './Validator';

export class Room {
  public id: string;
  public state: RoomState;
  private timerInterval: NodeJS.Timeout | null = null;
  private disconnectTimers: Map<string, NodeJS.Timeout> = new Map();
  private roomTimeout: NodeJS.Timeout | null = null; // Таймер жизни комнаты (1 час)
  private eliminationOrder: string[] = []; // Порядок выбывания игроков (для ранжирования)

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

    // Запускаем таймер удаления комнаты через 1 час
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
    if (this.roomTimeout) clearTimeout(this.roomTimeout);

    // Формируем ранжирование по текущему состоянию
    const rankings = this.calculateRankings();
    
    // Сервер должен отправить game_over (вызывается из server.ts через callback)
    // Здесь только логика
  }

  public getRankings(): { playerId: string; place: number }[] {
    return this.calculateRankings();
  }

  private calculateRankings(): { playerId: string; place: number }[] {
    const activePlayers = this.state.players.filter(p => p.status !== 'left');
    
    // Сортировка: сначала по количеству карт (меньше = лучше), затем по порядку выбывания
    const sorted = [...activePlayers].sort((a, b) => {
      if (a.cardCount !== b.cardCount) {
        return a.cardCount - b.cardCount;
      }
      // При равенстве карт: кто раньше выбыл (меньше индекс в eliminationOrder) — тот лучше
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
    this.eliminationOrder = []; // Сброс порядка выбывания

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
        // Ход переходит к следующему игроку после авто-хода 9♦
        this.state.turnIndex = (playerIndex + 1) % this.state.players.length;
      }
    } else {
      this.state.firstMoveAutoPlayed = true;
      this.state.turnIndex = 0;
    }
    
    this.startTurnTimer();
  }

  // 🔥 НОВЫЙ метод: найти текущего активного игрока
  private getCurrentActivePlayer(): Player | undefined {
    let attempts = 0;
    while (attempts < this.state.players.length) {
      const player = this.state.players[this.state.turnIndex];
      if (player && player.status === 'active') {
        return player;
      }
      // Пропускаем неактивного
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

    // Проверка победы
    if (currentPlayer.cardCount === 0) {
      console.log('[PLAY] Победа!', playerId);
      this.eliminationOrder.push(playerId); // Фиксируем победителя первым
      this.endGame(currentPlayer.id);
      return { success: true };
    }

    // Передаём ход следующему игроку
    this.advanceTurn();

    return { success: true };
  }

  skipTurn(playerId: string): { success: boolean; message?: string } {
    const currentPlayer = this.getCurrentActivePlayer();

    if (!currentPlayer || currentPlayer.id !== playerId) {
      return { success: false, message: 'Сейчас не ваш ход' };
    }

    // Проверка: можно пропускать только если нет валидных ходов
    const validMoves = getValidMoves(currentPlayer.hand, this.state.piles);
    if (validMoves.length > 0) {
      return { success: false, message: 'Есть доступные ходы' };
    }

    console.log('[SKIP] Игрок пропустил ход:', playerId);
    this.advanceTurn();
    return { success: true };
  }

  private startTurnTimer(): void {
    if (this.timerInterval) {
      console.log('[TIMER] Очищаем старый таймер');
      clearInterval(this.timerInterval);
    }

    const currentPlayer = this.getCurrentActivePlayer();

    if (!currentPlayer || this.state.gameOver) {
      this.state.timer = 0;
      return;
    }

    const validMoves = getValidMoves(currentPlayer.hand, this.state.piles);
    
    console.log(`[TIMER] Игрок ${currentPlayer.name}, ходов: ${validMoves.length}`);
    
    if (validMoves.length === 0) {
      console.log('[TIMER] Нет ходов — мгновенный пропуск');
      this.state.timer = 0;
      this.advanceTurn(); // 🔥 Не рекурсия, а один вызов
      return;
    }

    this.state.timer = 30;
    console.log('[TIMER] Запускаем таймер на 30 сек');
    
    this.timerInterval = setInterval(() => {
      if (this.state.timer > 0) {
        this.state.timer--;
      } else {
        console.log('[TIMER] Таймер истёк');
        this.handleTimerEnd();
      }
    }, 1000);
  }

  // 🔥 ИСПРАВЛЕННЫЙ метод: turnIndex теперь индекс в полном массиве
  private advanceTurn(): void {
    console.log('[TURN] До переключения: turnIndex =', this.state.turnIndex);
    
    // Переключаем на следующего игрока в полном массиве
    this.state.turnIndex = (this.state.turnIndex + 1) % this.state.players.length;
    
    // Пропускаем неактивных игроков
    let attempts = 0;
    while (attempts < this.state.players.length) {
      const player = this.state.players[this.state.turnIndex];
      if (player && player.status === 'active') {
        console.log('[TURN] Найден активный игрок:', player.name);
        break; // Нашли активного
      }
      console.log('[TURN] Пропускаем неактивного:', player?.name || 'undefined');
      this.state.turnIndex = (this.state.turnIndex + 1) % this.state.players.length;
      attempts++;
    }
    
    console.log('[TURN] После переключения: turnIndex =', this.state.turnIndex);
    
    // Запускаем таймер для следующего игрока
    this.startTurnTimer();
  }

  private handleTimerEnd(): void {
    if (this.timerInterval) clearInterval(this.timerInterval);
    
    const currentPlayer = this.getCurrentActivePlayer();

    if (!currentPlayer) return;

    const validMoves = getValidMoves(currentPlayer.hand, this.state.piles);
    if (validMoves.length > 0) {
      // Авто-ход случайной картой
      const randomCard = validMoves[Math.floor(Math.random() * validMoves.length)];
      console.log('[AUTO] Автоматический ход:', randomCard);
      this.playCard(currentPlayer.id, randomCard); // playCard вызовет advanceTurn()
    } else {
      // Авто-пропуск
      console.log('[AUTO] Автоматический пропуск');
      this.advanceTurn();
    }
  }

  private endGame(winnerId: string): void {
    console.log('[GAME] Игра завершена, победитель:', winnerId);
    this.state.gameOver = true;
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.roomTimeout) clearTimeout(this.roomTimeout);
  }

  getCurrentPlayer(): Player | undefined {
    return this.getCurrentActivePlayer();
  }

  removePlayer(playerId: string): void {
    const player = this.state.players.find(p => p.id === playerId);
    if (!player) return;

    player.status = 'left';
    
    // Фиксируем порядок выбывания для ранжирования
    if (!this.eliminationOrder.includes(playerId)) {
      this.eliminationOrder.push(playerId);
    }

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
        // Если текущий игрок вышел — сразу переключаем ход
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
  }

  // Очистка таймеров при удалении комнаты
  destroy(): void {
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.roomTimeout) clearTimeout(this.roomTimeout);
    this.disconnectTimers.forEach(timer => clearTimeout(timer));
    this.disconnectTimers.clear();
  }
}