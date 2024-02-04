import assert from "node:assert";

import {
  CardGroup,
  OddsCalculator,
  type Card as PokerToolsCard,
} from "poker-tools";

import { randomUUID } from "node:crypto";

const DELAY_AFTER_DEALING_COMMUNITY_CARDS = 1000;
const DELAY_AFTER_DEALING_HOLE_CARDS = 1000;

export function shuffle<T>(array: Array<T>) {
  let currentIndex = array.length,
    randomIndex;

  while (currentIndex != 0) {a
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

const stages = [
  "start",
  "preflop",
  "flop",
  "turn",
  "river",
  "showdown",
] as const;

function generateNewDeck() {
  const suits = "hdcs";
  const numbers = "A23456789TJQK";

  const deck = [...suits]
    .map((suit) => [...numbers].map((number) => `${number}${suit}`))
    .flat();

  return shuffle(deck);
}

const areSetsEqual = <T>(a: Set<T>, b: Set<T>) =>
  a.size === b.size && [...a].every((value) => b.has(value));

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

const handsSet = new Set<Hand>();

export interface HandInterface {
  getState(): {
    communityCards: Card[];
    holeCards: Record<PlayerId, [Card, Card]>;
    pots: { potId: string; amount: number }[];
    bets: Record<PlayerId, number>;
    minRaise: CurrencyType;
  };
  start(): void;
  act(playerId: PlayerId, action: PlayerAction): void;
  isValidBet(playerId: PlayerId, amount: number): boolean;
  getSeatByPlayerId(playerId: PlayerId): Seat | undefined;
  destroy(): void;
}

export class Hand implements HandInterface {
  #id = Math.random().toString(36).substring(2);
  #gameConfig: GameConfigType;
  #holeCards: Record<PlayerId, [Card, Card]> = {};
  #seats: Seat[];
  #stage: (typeof stages)[number] = "start";
  #bets: Record<PlayerId, number> = {};
  #communityCards: Card[] = [];
  #pots: Pot[] = [];
  #activePlayerId: PlayerId | null = null;
  #deck: string[];
  #sleep: (ms: number) => Promise<unknown>;
  #givePots: (winners: {
    playerIds: PlayerId[];
    winningCards: Card[];
    potId: string;
  }) => void;

  #currentPlayerTimeout: ReturnType<typeof setTimeout> | null = null;
  #activeTimeout: number = 0;

  #lastRaise: CurrencyType = 0;
  #lastRaisedPlayer: PlayerId | null = null;
  #firstPlayerToActInRound: PlayerId | null = null;

  #playersInGame = 0;
  #cardsShown = false;
  #showdownInProgress = false;
  #destroyed = false;

  constructor(
    seats: Seat[],
    gameConfig: GameConfigType,
    injections: {
      makeDeck?: () => string[];
      sleep?: (ms: number) => Promise<unknown>;
      givePots?: (winners: {
        playerIds: PlayerId[];
        winningCards: Card[];
        potId: string;
      }) => void;
    } = {}
  ) {
    handsSet.add(this);

    this.#seats = seats;
    this.#gameConfig = gameConfig;
    this.#deck = (injections.makeDeck ?? generateNewDeck)();
    this.#sleep = injections.sleep ?? sleep;
    this.#givePots = injections.givePots ?? (() => {});
  }

  getState() {
    return {
      communityCards: this.#communityCards,
      holeCards: this.#holeCards,
      pots: this.#pots.map((pot) => ({
        potId: pot.potId,
        amount: pot.amount,
      })),
      bets: this.#bets,
      minRaise: this.#lastRaise,
    };
  }

  #getSmallBlindPlayer() {
    return this.#seats.length > 2
      ? this.#nextPlayerAfter(this.#seats[0]!.playerId)!
      : this.#seats[0]!.playerId;
  }

  #getBigBlindPlayer() {
    return this.#nextPlayerAfter(this.#getSmallBlindPlayer())!;
  }

  #dealHoleCards() {
    this.#seats.forEach((seat) => {
      const cards = this.#deck.splice(0, 2);

      assert(cards.length === 2, "Not enough cards in deck");
      this.#holeCards[seat.playerId] = cards as [Card, Card];
    });
  }

  #dealCommunityCards(amount: number) {
    const cards = this.#deck.splice(0, amount);
    this.#communityCards.push(...cards);
    return this.#sleep(DELAY_AFTER_DEALING_COMMUNITY_CARDS);
  }

  start() {
    assert(this.#seats.length >= 2, "Not enough players");
    assert(this.#stage === "start", "Hand already started");

    this.#playersInGame = this.#seats.length;

    void this.#startNextStage();
  }

  #ensureCardsAreShown() {
    if (this.getPlayersWithCardsCount() <= 1 || this.#cardsShown) {
      return;
    }

    this.#cardsShown = true;
  }

  async #showdown() {
    this.#ensureCardsAreShown();
    await this.#sleep(1000);

    await this.#giveWins();
    await this.#sleep(1000);
  }

  getSeatByPlayerId(playerId: PlayerId) {
    return this.#seats.find((seat) => seat.playerId === playerId);
  }

  async #preflop() {
    const { smallBlind, bigBlind } = this.#gameConfig;

    this.#dealHoleCards();
    const sbPlayer = this.#getSmallBlindPlayer();
    const bbPlayer = this.#getBigBlindPlayer();

    this.#makeBet({
      playerId: sbPlayer,
      amount: Math.min(smallBlind, this.getSeatByPlayerId(sbPlayer)!.stack),
    });

    this.#makeBet({
      playerId: bbPlayer,
      amount: Math.min(bigBlind, this.getSeatByPlayerId(bbPlayer)!.stack),
    });

    if (this.#gameConfig.antes > 0) {
      this.#seats.forEach((seat) => {
        if (seat.playerId !== sbPlayer && seat.playerId !== bbPlayer) {
          this.#makeBet({
            playerId: seat.playerId,
            amount: Math.min(this.#gameConfig.antes, seat.stack),
          });
        }
      });
    }

    await this.#sleep(DELAY_AFTER_DEALING_HOLE_CARDS);

    this.#lastRaise = bigBlind;
    this.#firstPlayerToActInRound = this.#nextPlayerAfter(bbPlayer)!;
  }

  async #turnOrRiver() {
    if (this.getPlayersWithCardsCount() > 1) {
      await this.#dealCommunityCards(1);
    }
  }

  async #flop() {
    if (this.getPlayersWithCardsCount() > 1) {
      await this.#dealCommunityCards(3);
    }
  }

  getPlayersWithCardsCount() {
    return Object.keys(this.#holeCards).length;
  }

  async #startNextStage() {
    if (this.#destroyed) {
      return;
    }

    if (Object.values(this.#bets).length > 0) {
      this.#moveBetsToPots();
      await this.#sleep(1000);
    }

    if (this.#stage === "showdown") {
      throw new Error("wtf");
    }

    this.#stage = stages[stages.indexOf(this.#stage) + 1]!;
    assert(this.#stage !== "start");

    this.#lastRaise = 0;
    this.#lastRaisedPlayer = null;

    // Will be overridden in preflop
    this.#firstPlayerToActInRound = this.#nextPlayerAfter(
      this.#seats[0]!.playerId
    )!;

    const stageHandlers = {
      preflop: () => this.#preflop(),
      flop: () => this.#flop(),
      turn: () => this.#turnOrRiver(),
      river: () => this.#turnOrRiver(),
      showdown: () => this.#showdown(),
    } as const;

    await stageHandlers[this.#stage]();
    if (this.#playersInGame <= 1 && this.#stage !== "showdown") {
      this.#showdownInProgress = true;
      setTimeout(() => {
        void this.#startNextStage();
      });
    }

    if (this.#stage !== "showdown" && this.#playersInGame > 1) {
      this.#waitForPlayerToAct(this.#firstPlayerToActInRound);
    }
  }

  async #giveWins() {
    const playerCards = this.#seats
      .filter((seat) => this.#holeCards[seat.playerId])
      .map(
        (seat) =>
          ({
            playerId: seat.playerId,
            cards: CardGroup.fromString(
              this.#holeCards[seat.playerId]!.join("")
            ),
          } as {
            playerId: PlayerId;
            cards: [PokerToolsCard, PokerToolsCard];
          })
      );

    const communityCards = CardGroup.fromString(this.#communityCards.join(""));

    if (this.getPlayersWithCardsCount() === 1) {
      for (const pot of this.#pots) {
        const seat = this.#seats.find(
          (seat) => seat && this.#holeCards[seat.playerId]
        );
        if (!seat) {
          continue;
        }

        this.#givePots({
          playerIds: [seat.playerId],
          potId: pot.potId,
          winningCards: [],
        });

        // FIXME: better way
        if (this.#destroyed) {
          return;
        }

        seat.stack += pot.amount;
        await this.#sleep(1000);
      }
    } else {
      for (const pot of this.#pots) {
        const players = playerCards.filter((p) =>
          pot.eligiblePlayers.has(p.playerId)
        );

        if (players.length === 0) {
          continue;
        }

        const [winners] = OddsCalculator.calculateWinner(
          players.map((p) => p.cards),
          communityCards
        );

        const winnerIds = winners!.map((w) => players[w.index]!.playerId);

        const winningCards = new Set(
          winners!
            .map((w) => w.handrank.highcards.cards.map((c) => c.toString()))
            .flat()
        );

        this.#givePots({
          playerIds: winnerIds,
          potId: pot.potId,
          winningCards: [...winningCards.values()].sort(),
        });

        let extra = pot.amount % winnerIds.length;

        // FIXME: better way
        if (this.#destroyed) {
          return;
        }

        for (const playerId of winnerIds) {
          const seat = this.#seats.find((seat) => seat.playerId === playerId)!;
          seat.stack += Math.floor(pot.amount / winnerIds.length) + extra;
          extra = 0;
        }
        await this.#sleep(1000);
      }
    }
  }

  #makeBet({ playerId, amount }: { playerId: PlayerId; amount: number }) {
    assert(amount >= 0, "Amount must be positive");

    const seat = this.#seats.find((seat) => seat.playerId === playerId)!;
    assert(seat.stack >= amount, "Not enough money");

    // FIXME: better way
    if (this.#destroyed) {
      return;
    }
    seat.stack -= amount;

    this.#bets[playerId] = (this.#bets[playerId] || 0) + amount;

    if (seat.stack === 0) {
      this.#playersInGame -= 1;
    }
  }

  #nextPlayerAfter(playerId: PlayerId) {
    const index = this.#seats.findIndex((seat) => seat.playerId === playerId);
    for (let i = 1; i <= this.#seats.length; i++) {
      const nextSeat = this.#seats[(index + i) % this.#seats.length]!;
      if (this.#holeCards[nextSeat.playerId] && nextSeat.stack > 0) {
        return nextSeat.playerId;
      }
    }

    return null;
  }

  #runActiveTimeout() {
    if (this.#activeTimeout === 0) {
      if (this.isValidBet(this.#activePlayerId!, 0)) {
        this.act(this.#activePlayerId!, { type: "bet", amount: 0 });
      } else {
        this.act(this.#activePlayerId!, { type: "fold" });
      }
    } else {
      if (this.#currentPlayerTimeout) {
        clearTimeout(this.#currentPlayerTimeout);
      }

      this.#currentPlayerTimeout = setTimeout(() => {
        this.#activeTimeout -= 1;
        this.#runActiveTimeout();
      }, 1000);
    }
  }

  #waitForPlayerToAct(playerId: PlayerId) {
    this.#activePlayerId = playerId;
    this.#activeTimeout = this.#gameConfig.timeLimit;
    this.#runActiveTimeout();
  }

  #getMaxBet() {
    return Math.max(0, ...Object.values(this.#bets));
  }

  isValidBet(playerId: PlayerId, amount: number) {
    const currentBet = this.#bets[playerId] || 0;
    const stack = this.#seats.find((seat) => seat.playerId === playerId)!.stack;

    if (amount === stack) {
      // All-in is always permitted
      return true;
    }

    const maxCallIn = Math.max(
      ...this.#seats
        .filter((seat) => seat.stack === 0)
        .map((seat) => this.#bets[seat.playerId] || 0)
    );

    if (amount + currentBet === maxCallIn) {
      // Matching biggest call-in on the table is always allowed
      return true;
    }

    if (amount + currentBet === this.#getMaxBet()) {
      // This is either check or call
      return true;
    }

    if (currentBet + amount >= this.#getMaxBet() + this.#lastRaise) {
      // Normal raise
      return true;
    }

    return false;
  }

  #canAct(playerId: PlayerId) {
    if (
      this.#stage === "showdown" ||
      this.#showdownInProgress ||
      !this.#holeCards[playerId]
    ) {
      return false;
    }
    return true;
  }

  act(playerId: PlayerId, action: PlayerAction) {
    if (this.#activePlayerId !== playerId) {
      throw new Error(
        `Not your turn, ${playerId} to do ${action.type}, expected ${
          this.#activePlayerId
        }`
      );
    }

    if (!this.#canAct(playerId)) {
      return;
    }

    if (this.#currentPlayerTimeout) clearTimeout(this.#currentPlayerTimeout);

    switch (action.type) {
      case "fold": {
        this.#playersInGame -= 1;
        delete this.#holeCards[playerId];

        this.#pots.forEach((pot) => {
          pot.eligiblePlayers.delete(playerId);
        });

        break;
      }
      case "bet": {
        const maxBet = this.#getMaxBet();
        const minAllowedRaise = maxBet + this.#lastRaise;

        const currentBet = this.#bets[playerId] || 0;

        if (!this.isValidBet(playerId, action.amount)) {
          throw new Error(`Invalid bet: ${playerId}, ${action.amount}`);
        }

        if (currentBet + action.amount >= minAllowedRaise) {
          this.#lastRaise = action.amount + currentBet - maxBet;
          this.#lastRaisedPlayer = playerId;
        }

        this.#makeBet({ playerId, amount: action.amount });
      }
    }

    const nextPlayer = this.#nextPlayerAfter(playerId);
    if (
      (this.getSeatByPlayerId(playerId)!.stack === 0 ||
        !this.#holeCards[playerId]) &&
      this.#firstPlayerToActInRound === playerId
    ) {
      this.#firstPlayerToActInRound = nextPlayer;
    }

    if (this.#isReadyToStartNextStage(nextPlayer)) {
      setTimeout(() => void this.#startNextStage());
    } else {
      this.#waitForPlayerToAct(nextPlayer!);
    }
  }

  #isReadyToStartNextStage(nextPlayer: PlayerId | null) {
    if (
      !nextPlayer ||
      this.#activePlayerId === nextPlayer ||
      nextPlayer === this.#lastRaisedPlayer
    ) {
      return true;
    }

    if (this.isValidBet(nextPlayer, 0) && this.#playersInGame <= 1) {
      // No need to wait for useless check
      return true;
    }

    const maxBet = this.#getMaxBet();

    const allPlayersContributedEqually = this.#seats.every(
      (seat) =>
        !this.#holeCards[seat.playerId] ||
        this.#bets[seat.playerId] === maxBet ||
        seat.stack === 0
    );

    return (
      allPlayersContributedEqually &&
      nextPlayer === this.#firstPlayerToActInRound
    );
  }

  #moveBetsToPots() {
    let betsToProcess = Object.entries(this.#bets)
      .sort(([, amount1], [, amount2]) => amount1 - amount2)
      .filter(([, amount]) => amount > 0);

    while (betsToProcess.length) {
      const eligiblePlayers = new Set<PlayerId>(
        betsToProcess.map(([id]) => id).filter((id) => this.#holeCards[id])
      );

      const bet = betsToProcess[0]![1]!;
      const amount = betsToProcess.length * bet;

      const pot = this.#pots.find((pot) =>
        areSetsEqual(pot.eligiblePlayers, eligiblePlayers)
      );
      if (!pot) {
        this.#pots.push({
          potId: randomUUID(),
          amount,
          eligiblePlayers,
        });
      } else {
        pot.amount += amount;
      }

      [...betsToProcess.values()].forEach((pendingBet) => {
        pendingBet[1] -= bet;
      });
      betsToProcess = betsToProcess.filter(([, amount]) => amount > 0);
    }

    this.#bets = {};
  }

  destroy() {
    this.#destroyed = true;
    handsSet.delete(this);
    if (this.#currentPlayerTimeout) {
      clearTimeout(this.#currentPlayerTimeout);
    }
  }
}
