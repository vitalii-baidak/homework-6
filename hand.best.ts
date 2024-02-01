import {
  CardGroup,
  OddsCalculator,
  type Card as PokerToolsCard,
} from "poker-tools";

// Готовая функция для перемешивания колоды
export function shuffle<T>(array: Array<T>) {
  let currentIndex = array.length,
    randomIndex;

  while (currentIndex != 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // @ts-expect-error This is fine.
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex],
      array[currentIndex],
    ];
  }

  return array;
}

// Функция сна
// Спать надо
// * на 1 секунду - после раздачи карт игрокам
// * на 1 секунду - после раздачи 3х карт на стол
// * на 1 секунду - после раздачи 4й карты на стол
// * на 1 секунду - после раздачи 5й карты на стол
// * на 1 секунду - после раздачи каждого выигрыша
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Card = string;
type PlayerAction =
  | {
      type: "fold";
    }
  | {
      type: "bet";
      amount: number;
    };

// Функция генерации новой колоды
// Возвращает массив из 52 карт
// Каждая карта - строка из 2х символов
// Первый символ - номер карты
// Второй символ - масть карты
function generateNewDeck() {
  const suits = "hdcs";
  const numbers = "A23456789TJQK";

  const deck = [...suits]
    .map((suit) => [...numbers].map((number) => `${number}${suit}`))
    .flat();

  return shuffle(deck);
}

type PlayerId = string;
type GameConfigType = {
  smallBlind: number;
  bigBlind: number;
  antes: number;
  timeLimit: number;
};
type Pot = {
  potId: string;
  amount: number;
  eligiblePlayers: Set<PlayerId>;
};
type Seat = {
  playerId: PlayerId;
  stack: number;
};
type CurrencyType = number;

export interface HandInterface {
  getState(): {
    // Карты на столе
    communityCards: Card[];
    // Карты игроков
    holeCards: Record<PlayerId, [Card, Card]>;
    // Банки на столе. potId - произвольный уникальный идентификатор
    pots: { potId: string; amount: number }[];
    // Ставки игроков в текущем раунде
    bets: Record<PlayerId, number>;
    // На сколько игроки должны поднять ставку, чтобы сделать минимальный рейз
    minRaise: CurrencyType;
  };
  start(): void;
  // Генерирует исключение если игрок пробует походить не в свой ход
  act(playerId: PlayerId, action: PlayerAction): void;
  isValidBet(playerId: PlayerId, amount: number): boolean;
  getSeatByPlayerId(playerId: PlayerId): Seat | undefined;
}

export class Hand implements HandInterface {
  private seats: Seat[];
  private gameConfig: GameConfigType;
  private sleep: (ms: number) => Promise<unknown>;
  private givePots: (winners: {
    playerIds: PlayerId[];
    winningCards: Card[];
    potId: string;
  }) => void;
  
  // Колода карт
  private deck: string[];
  // Карты на столе
  private communityCards: Card[];
  // Карты игроков
  private holeCards: Record<PlayerId, [Card, Card]>;
  // Банки на столе. potId - произвольный уникальный идентификатор
  private pots: Pot[];
  // Ставки игроков в текущем раунде
  private bets: Record<PlayerId, number> = {};
  // На сколько игроки должны поднять ставку, чтобы сделать минимальный рейз
  private minRaise: CurrencyType;
  private actQueue: SeatNodeList;
  private currentPlayer: PlayerId = '';

  constructor(
    // Игроки за столом. Первый игрок - дилер
    // Можете считать что у всех игроков есть хотя бы 1 фишка
    seats: Seat[],
    gameConfig: GameConfigType,
    injections: {
      // Функция генерации колоды, значение по умолчанию - generateNewDeck
      makeDeck?: () => string[];
      // Функция сна, значение по умолчанию - sleep
      sleep?: (ms: number) => Promise<unknown>;
      // Функция вызываемая когда надо выдать банк игрокам
      givePots?: (winners: {
        // Идентификаторы игроков которые выиграли этот банк
        playerIds: PlayerId[];
        // Карты, благодаря которым банк выигран (они подсвечиваются при выигрыше)
        winningCards: Card[];
        // Уникальный идентификатор банка
        potId: string;
      }) => void;
    } = {}
  ) {
    this.seats = seats;
    this.gameConfig = gameConfig;
    this.deck = (injections.makeDeck || generateNewDeck)(),
    this.sleep = injections.sleep || sleep,
    this.givePots = injections.givePots || (() => {}),
    this.communityCards = [];
    this.holeCards = {};
    this.pots = [{
      potId: "0",
      amount: 0,
      eligiblePlayers: new Set()
    }];
    this.minRaise = gameConfig.bigBlind;
    this.actQueue = new SeatNodeList(this.seats.map((seat) => seat.playerId));
  }

  getState() {
    return {
      communityCards: this.communityCards,
      holeCards: this.holeCards,
      pots: this.pots,
      bets: this.bets,
      minRaise: this.minRaise,
    }
  }

  start() {
    if (this.seats.length < 2) {
      throw new Error("Not enough players");
    }
    // TODO: take antes
    // Get blinds
    if (this.seats.length === 2) {
      this.getBlind(this.seats[0]!.playerId, this.gameConfig.smallBlind)
      this.getBlind(this.seats[1]!.playerId, this.gameConfig.bigBlind)
    } else {
      this.getBlind(this.seats[1]!.playerId, this.gameConfig.smallBlind)
      this.getBlind(this.seats[2]!.playerId, this.gameConfig.bigBlind)
    }

    // Deal cards
    this.seats.forEach((seat) => {
      this.holeCards[seat.playerId] = [this.getNextCardFromDeck(), this.getNextCardFromDeck()]
    })
    this.startRound()
  }

  act(playerId: PlayerId, action: PlayerAction) {
    if (playerId !== this.currentPlayer) {
      throw new Error("Not your turn");
    }
    if (action.type !== 'fold' && action.type !== 'bet') {
      throw new Error("Invalid action");
    }
    if (action.type === "fold") {
      this.fold(playerId)
    } else {
      this.placeBet(playerId, action.amount)
    }
  }

  isValidBet(playerId: PlayerId, amount: number) {
    const playerStack = this.getSeatByPlayerId(playerId)!.stack
    if (playerStack - amount === 0) {
      return true;
    }
    const currentBet = this.getPlayerBet(playerId)
    const maxBet = this.getMaxBet()
    const nextBet = currentBet + amount
    if (maxBet === 0 && (nextBet === 0 || nextBet > this.minRaise)) {
      return true
    }
    if (maxBet < this.minRaise && nextBet >= this.minRaise) {
      return true
    }
    if (maxBet >= this.minRaise && (nextBet === maxBet || nextBet >= maxBet + this.minRaise)) {
      return true;
    }
    return false
  }

  getSeatByPlayerId(playerId: PlayerId) {
    return this.seats.find((seat) => seat.playerId === playerId);
  }

  private getBlind(playerId: PlayerId, amount: number) {
    let amountToBet = amount
    const seat = this.getSeatByPlayerId(playerId);
    if (seat === undefined) {
      throw new Error("Player not found");
    }
    if (seat.stack < amountToBet) {
      amountToBet = seat.stack;
    }
    const nextBet = this.getPlayerBet(playerId) + amountToBet;
    this.bets[playerId] = nextBet;
    seat.stack -= amountToBet;
  }

  private placeBet(playerId: PlayerId, amount: number) {
    let amountToBet = amount
    const seat = this.getSeatByPlayerId(playerId);
    if (seat === undefined) {
      throw new Error("Player not found");
    }
    if (!this.isValidBet(playerId, amountToBet)) {
      throw new Error("Invalid bet");
    }
    if (seat.stack < amountToBet) {
      amountToBet = seat.stack;
    }
    const nextBet = this.getPlayerBet(playerId) + amountToBet;
    const maxBet = this.getMaxBet()
    // player raised
    if (nextBet > maxBet) {
      // not all-in
      if (nextBet - maxBet >= this.minRaise) {
        this.minRaise = nextBet - maxBet
      }
      this.actQueue.setAllUnacted()
    }
    this.bets[playerId] = nextBet;
    seat.stack -= amountToBet;
    this.playerActed(playerId)
  }

  private getNextCardFromDeck() {
    return this.deck.shift()!;
  }

  private fold(playerId: string) {
    this.actQueue.fold(playerId)
    if (this.actQueue.getNotFolded().length === 1) {
      this.calcPots()
      this.showdown()
    } else {
      this.playerActed(playerId)
    }
  }

  private playerActed(playerId: PlayerId) {
    this.actQueue.act(playerId)
    if (this.actQueue.getNext(playerId).acted) {
      return this.endRound()
    }
    this.currentPlayer = this.actQueue.getNext(this.currentPlayer).playerId
    if (!this.canPlayerAct(this.currentPlayer)) {
      this.playerActed(this.currentPlayer)
    }
  }

  private startRound() {
    if (this.isPreflop()) {
      if (this.isTwoPlayers()) {
        this.currentPlayer = this.actQueue.getOnPosition(1).playerId;
      } else {
        this.currentPlayer = this.actQueue.getOnPosition(4).playerId;
      }
    } else {
      this.currentPlayer = this.actQueue.getOnPosition(2).playerId;
    }

    this.actQueue.setAllUnacted()
    if (!this.canPlayerAct(this.currentPlayer)) {
      this.playerActed(this.currentPlayer)
    }

    this.minRaise = this.gameConfig.bigBlind
  }

  private endRound() {
    this.calcPots()
    if (this.communityCards.length === 5) {
      return this.showdown()
    }
    if (this.isPreflop()) {
      this.communityCards = [
        this.getNextCardFromDeck(),
        this.getNextCardFromDeck(),
        this.getNextCardFromDeck(),
      ]
    } else if (this.communityCards.length < 5) {
      this.communityCards.push(this.getNextCardFromDeck())
    }
    if (this.doesTwoOrMorePlayersCanAct()) {
      this.startRound()
    } else {
      this.endRound()
    }
  }

  private calcPots() {
    // [playerId, bet][]
    const betsArr = Object.entries(this.bets)
    if (betsArr.length === 0) {
      return
    }
    const areEqual = betsArr.every((bet) => bet[1] === betsArr[0]![1])
    if (areEqual) {
      this.pots.at(-1)!.amount += betsArr.reduce((a, b) => a + b[1], 0)
      betsArr.forEach(([playerId]) => {
        this.pots.at(-1)!.eligiblePlayers.add(playerId)
      })
    } else {
      const sortedBets = betsArr.sort((a, b) => a[1] - b[1])
      for (let i = 0; i < sortedBets.length; i++) {
        const [_, amount] = sortedBets[i]!
        if (amount === 0) {
          continue
        }
        // if left bets are equal
        if (amount === sortedBets.at(-1)![1]) {
          const leftPlayers = sortedBets.slice(i).map((bet) => bet[0])
          this.createNewPot(leftPlayers)
          this.pots.at(-1)!.amount = amount * leftPlayers.length
          break
        }
        if (i !== 0)  {
          this.createNewPot()
        }
        for (let j = i; j < sortedBets.length; j++) {
          const [playerId] = sortedBets[j]!
          sortedBets[j]![1] -= amount
          this.pots.at(-1)!.amount += amount
          this.pots.at(-1)!.eligiblePlayers.add(playerId)
        }
      }
    }
    this.normalizePots()
    this.bets = {}
  }

  private normalizePots() {
    // remove folded players
    this.seats.forEach(({ playerId }) => {
      if (this.actQueue.isFolded(playerId)) {
        this.pots.forEach((pot) => {
          pot.eligiblePlayers.delete(playerId)
        })
      }
    })
    // concat pots with same eligible players
    for (let i = 0; i < this.pots.length; i++) {
      const pot = this.pots[i]!
      for (let j = i + 1; j < this.pots.length; j++) {
        const nextPot = this.pots[j]!
        if (eqSet(pot.eligiblePlayers, nextPot.eligiblePlayers)) {
          pot.amount += nextPot.amount
          this.pots.splice(j, 1)
          j--
        }
      }
    }
  }

  private showdown() {
    this.currentPlayer = ''
    const pots = this.pots.slice()
    pots.reverse()
    for (let i = 0; i < pots.length; i++) {
      const pot = pots[i]!
      const eligiblePlayers = [...pot.eligiblePlayers]
      const playersCards = eligiblePlayers.map(
        (playerId) => CardGroup.fromString(this.holeCards[playerId]!.join())
      ) as [PokerToolsCard, PokerToolsCard][]
      const board = CardGroup.fromString(this.communityCards.join())
      const result = OddsCalculator.calculateWinner(playersCards, board)
      const seatsArr = this.seats.map((seat) => seat.playerId)
      const winners = result[0]!.map((player) => eligiblePlayers[player.index]!)
      winners.sort((a, b) => seatsArr.indexOf(a) - seatsArr.indexOf(b))
      const winningCardsArr: PokerToolsCard[] = []
      for (let j = 0; j < result[0]!.length; j++) {
        const { handrank } = result[0]![j]!
        const winningCards = handrank.highcards.cards.slice().sort().map((card: PokerToolsCard) => card)
        winningCardsArr.push(...winningCards)
      }
      winningCardsArr.sort((cardA, cardB) => {
        // @ts-ignore
        if (cardA.rank !== cardB.rank) {
          // @ts-ignore
          return cardA.rank - cardB.rank
        }
        // @ts-ignore
        return cardA.suit - cardB.suit
      })
      const winningCards = new Set(winningCardsArr.map(card => card.toString()))
      this.givePots({
        playerIds: winners,
        winningCards: [...winningCards],
        potId: pot.potId,
      })
    }
  }

  private createNewPot(players: PlayerId[] = []) {
    this.pots.push({
      potId: this.pots.length.toString(),
      amount: 0,
      eligiblePlayers: new Set(players)
    })
  }

  private isPreflop() {
    return this.communityCards.length === 0;
  }

  private doesTwoOrMorePlayersCanAct() {
    const playersCanAct = this.seats.filter((seat) => this.canPlayerAct(seat.playerId))
    return playersCanAct.length > 1
  }

  private isTwoPlayers() {
    return this.seats.length === 2;
  }

  private getPlayerBet(playerId: PlayerId) {
    return this.bets[playerId] || 0
  }

  private getMaxBet() {
    if (Object.keys(this.bets).length === 0) {
      return 0
    }
    return Math.max(...Object.values(this.bets))
  }

  private canPlayerAct(playerId: PlayerId) {
    return this.getSeatByPlayerId(playerId)!.stack > 0 && !this.actQueue.isFolded(playerId)
  }
}

class SeatNode {
  playerId: string
  next: SeatNode
  acted: boolean = false
  folded: boolean = false

  constructor(playerId: string) {
    this.playerId = playerId;
    this.next = this
  }
}

class SeatNodeList {
  head: SeatNode

  constructor(players: PlayerId[]) {
    this.head = new SeatNode(players[0]!)
    for (let i = 1; i < players.length; i++) {
      this.insert(players[i]!)
    }
  }

  find(playerId: PlayerId) {
    let currentNode = this.head
    while (currentNode.playerId !== playerId) {
      currentNode = currentNode.next
    }
    return currentNode
  }

  insert(playerId: PlayerId) {
    let currentNode = this.head
    while (currentNode.next !== this.head) {
      currentNode = currentNode.next
    }
    currentNode.next = new SeatNode(playerId)
    currentNode.next.next = this.head
  }
  
  display() {
    let currentNode = this.head
    do {
      console.log(currentNode.playerId)
      currentNode = currentNode.next
    } while (currentNode.next !== this.head.next)
  }

  changeHead(playerId: PlayerId) {
    this.head = this.find(playerId)
  }

  getNext(playerId: PlayerId) {
    return this.find(playerId).next
  }

  getOnPosition(position: number) {
    let currentNode = this.head
    for (let i = 1; i < position; i++) {
      currentNode = currentNode.next
    }
    return currentNode
  }

  fold(playerId: PlayerId) {
    this.find(playerId).folded = true
  }

  act(playerId: PlayerId) {
    this.find(playerId).acted = true
  }

  isActed(playerId: PlayerId) {
    return this.find(playerId).acted
  }

  isFolded(playerId: PlayerId) {
    return this.find(playerId).folded
  }

  getNotFolded() {
    let currentNode = this.head
    const notFolded: PlayerId[] = []
    do {
      if (!currentNode.folded) {
        notFolded.push(currentNode.playerId)
      }
      currentNode = currentNode.next
    } while (currentNode.next !== this.head.next)
    return notFolded
  }

  setAllUnacted() {
    let currentNode = this.head
    do {
      currentNode.acted = false
      currentNode = currentNode.next
    } while (currentNode.next !== this.head.next)
  }
}

function eqSet(xs: Set<string>, ys: Set<string>) {
  return xs.size === ys.size && [...xs].every((x) => ys.has(x));
}