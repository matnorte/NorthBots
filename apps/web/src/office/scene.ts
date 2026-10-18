import { AnimatedSprite, Application, Assets, Container, Graphics, Sprite, Text, Texture, type FederatedPointerEvent } from "pixi.js";
import type { Avatar, OfficeAgent, OfficeState, OfficeView, Zone } from "@northbot/shared";
import { deskTile, FLOOR, iso, LAYOUT, standTile, zoneAtWorld } from "./layout.js";
import { catFrames, eyesFor, FPS, frames, H, paint, type Anim, type Frame } from "./pixels.js";

export type BubbleDial = "all" | "important" | "none";

export interface SceneOptions {
  bubbles: BubbleDial;
  /** Topic-only privacy mode: bubbles say what it is about, not what was said. */
  topicOnly: boolean;
  calm: boolean;
  reducedMotion: boolean;
  /** Mobile single-room view: the camera frames one room. */
  focus: Zone | null;
  t: (key: string, vars?: Record<string, unknown>) => string;
}

export interface SceneCallbacks {
  lift(agentId: string): void;
  drop(agentId: string, zone: Zone): void;
  shake(agentId: string): void;
  poke(agentId: string, x: number, y: number): void;
  openChat(agentId: string): void;
  menu(agentId: string, x: number, y: number): void;
  assignLetter(letterId: string, agentId: string): void;
}

const SCALE = 3;
const SPEED = 140; // world pixels per second when walking
const LONG_PRESS_MS = 600;
const DOUBLE_CLICK_MS = 350;
const NIGHT: Record<OfficeView["dayPhase"], { color: number; alpha: number }> = {
  dawn: { color: 0xff9eb5, alpha: 0.08 },
  day: { color: 0x000000, alpha: 0 },
  dusk: { color: 0xff8a3d, alpha: 0.12 },
  night: { color: 0x0a1030, alpha: 0.38 },
};
const STATUS_ICON: Record<string, string> = { working: "⚙", waiting: "⏳", resting: "💤", blocked: "⛔" };

const textures = new Map<string, Texture[]>();
function texturesOf(key: string, make: () => Frame[]): Texture[] {
  let t = textures.get(key);
  if (!t) {
    t = make().map((f) => {
      const canvas = document.createElement("canvas");
      paint(f, canvas, 1);
      const tex = Texture.from(canvas);
      tex.source.scaleMode = "nearest";
      return tex;
    });
    textures.set(key, t);
  }
  return t;
}
const agentTextures = (look: Avatar, anim: Anim, mood: string) => texturesOf(`${look.shape}/${look.color}/${anim}/${eyesFor(mood)}`, () => frames(look, anim, eyesFor(mood)));

/** Which animation an agent plays, from its state and whether it is walking. */
function animOf(a: OfficeAgent, walking: boolean, reaction: string | null): Anim {
  if (a.held) return "held";
  if (reaction === "dizzy") return "dizzy";
  if (reaction === "hearts" || reaction === "cookie") return "bounce";
  if (walking) return a.carrying ? "carry" : "walk";
  if (a.carrying) return "carry";
  switch (a.activity) {
    case "typing":
      return "typing";
    case "browsing":
      return "browsing";
    case "sleeping":
      return "sleep";
    case "waiting":
      return "wait";
    case "talking":
    case "listening":
      return "talk";
    case "presenting":
      return "present";
    case "blocked":
      return "blocked";
    default:
      return a.zone === "break_room" && a.hibernated ? "sleep" : "idle";
  }
}

class Actor {
  root = new Container();
  sprite: AnimatedSprite;
  label: Text;
  icon: Text;
  bubble = new Container();
  bubbleBg = new Graphics();
  bubbleText: Text;
  pos: { x: number; y: number };
  target: { x: number; y: number };
  key = "";
  dragging = false;

  constructor(
    readonly id: string,
    at: { x: number; y: number },
  ) {
    this.pos = { ...at };
    this.target = { ...at };
    this.sprite = new AnimatedSprite([Texture.EMPTY]);
    this.sprite.anchor.set(0.5, 26 / H);
    this.sprite.scale.set(SCALE);
    this.sprite.eventMode = "static";
    this.sprite.cursor = "grab";
    this.label = new Text({ text: "", style: { fontFamily: "Nunito, sans-serif", fontSize: 11, fill: 0xe9e9ee, fontWeight: "700" } });
    this.label.anchor.set(0.5, 0);
    this.label.y = 6;
    this.icon = new Text({ text: "", style: { fontSize: 14 } });
    this.icon.anchor.set(0.5, 1);
    this.icon.position.set(26, -70);
    this.bubbleText = new Text({ text: "", style: { fontFamily: "Nunito, sans-serif", fontSize: 11, fill: 0x2e2a40, wordWrap: true, wordWrapWidth: 150, breakWords: true } });
    this.bubble.addChild(this.bubbleBg, this.bubbleText);
    this.root.addChild(this.sprite, this.label, this.icon, this.bubble);
  }
}

/**
 * The Cozy Office canvas. It draws an `OfficeState` (a pure function of the event log) and
 * turns pointer gestures into callbacks; it never changes state on its own.
 */
export class OfficeScene {
  readonly app = new Application();
  private world = new Container();
  private floor = new Graphics();
  private labels = new Container();
  private things = new Container();
  private fx = new Container();
  private night = new Graphics();
  private glow = new Graphics();
  private papers = new Graphics();
  private boardText = new Text({ text: "", style: { fontFamily: "Nunito, sans-serif", fontSize: 10, fill: 0x2e2a40, lineHeight: 13 } });
  private breakText = new Text({ text: "", style: { fontFamily: "Nunito, sans-serif", fontSize: 11, fill: 0xe9e9ee, lineHeight: 14 } });
  private desks = new Map<number, Container>();
  private actors = new Map<string, Actor>();
  private letters = new Map<string, { g: Graphics; pos: { x: number; y: number }; target: { x: number; y: number }; to: string | null; draggable: boolean }>();
  private cat: AnimatedSprite | null = null;
  private catMood = "";
  private furniture = new Map<string, Texture>();
  private opts: SceneOptions | null = null;
  private state: OfficeState | null = null;
  private view: OfficeView | null = null;
  private press: { id: string; x: number; y: number; t: number; moved: boolean; lifted: boolean; timer: number; lastDx: number; turns: number; turnT: number; shaken: boolean } | null = null;
  private letterDrag: { id: string; g: Graphics } | null = null;
  private pan: { x: number; y: number; wx: number; wy: number } | null = null;
  private pinch = new Map<number, { x: number; y: number }>();
  private pinchStart: { d: number; zoom: number } | null = null;
  private lastClick: { id: string; t: number } | null = null;
  private zoom = 1;
  private destroyed = false;
  private initialized = false;
  /** Set once the furniture art has loaded; updates before that are replayed. */
  private ready = false;
  private queued: [OfficeState, OfficeView, SceneOptions] | null = null;

  constructor(private readonly cb: SceneCallbacks) {}

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({ resizeTo: host, background: 0x0b0b0e, antialias: true, autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2) });
    this.initialized = true;
    if (this.destroyed) {
      this.app.destroy(true, { children: true });
      return;
    }
    host.appendChild(this.app.canvas);
    this.app.canvas.style.touchAction = "none";
    const names = ["desk", "post_box", "mail_desk", "meeting_table", "stage", "sofa", "bin", "whiteboard", "browser_lab", "vault", "plant", "lamp", "sack"];
    const loaded = await Promise.all(names.map((n) => Assets.load<Texture>(`/office/${n}.svg`).catch(() => Texture.EMPTY)));
    if (this.destroyed) return;
    names.forEach((n, i) => this.furniture.set(n, loaded[i]!));
    this.things.sortableChildren = true;
    this.world.addChild(this.floor, this.labels, this.glow, this.papers, this.things, this.fx);
    this.app.stage.addChild(this.world, this.night);
    this.drawFloor();
    this.placeFurniture();
    this.fitView();
    this.app.stage.eventMode = "static";
    this.app.stage.hitArea = this.app.screen;
    this.app.stage.on("pointerdown", (e) => this.onStageDown(e));
    this.app.stage.on("pointermove", (e) => this.onMove(e));
    this.app.stage.on("pointerup", (e) => this.onUp(e));
    this.app.stage.on("pointerupoutside", (e) => this.onUp(e));
    this.app.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.app.ticker.add((tk) => this.tick(tk.deltaMS));
    this.app.renderer.on("resize", () => this.fitView());
    this.ready = true;
    if (this.queued) this.update(...this.queued);
  }

  destroy(): void {
    this.destroyed = true;
    // Pixi's canvas getter reads the renderer; it is unavailable until async init finishes.
    if (!this.initialized) return;
    try {
      this.app.canvas.removeEventListener("wheel", this.onWheel);
      this.app.destroy(true, { children: true });
    } catch {
      // Not fully initialised yet.
    }
  }

  // ---------- drawing ----------

  private drawFloor(): void {
    const g = this.floor;
    g.clear();
    for (let i = 0; i < FLOOR.cols; i++) {
      for (let j = 0; j < FLOOR.rows; j++) {
        const z = zoneAtWorld(iso(i + 0.5, j + 0.5).x, iso(i + 0.5, j + 0.5).y);
        const c = z ? LAYOUT[z].rug : 0x17151c;
        const p = [iso(i, j), iso(i + 1, j), iso(i + 1, j + 1), iso(i, j + 1)].flatMap((q) => [q.x, q.y]);
        g.poly(p).fill({ color: c }).stroke({ color: 0x0b0b0e, width: 1, alpha: 0.6 });
      }
    }
    // A low back wall along the far edges.
    const wall = (a: { x: number; y: number }, b: { x: number; y: number }) => g.poly([a.x, a.y, b.x, b.y, b.x, b.y - 40, a.x, a.y - 40]).fill({ color: 0x241f2e }).stroke({ color: 0x3a3048, width: 2 });
    wall(iso(0, FLOOR.rows), iso(0, 0));
    wall(iso(0, 0), iso(FLOOR.cols, 0));
  }

  private sprite(name: string, tile: [number, number], scale = 0.75): Container {
    const tex = this.furniture.get(name) ?? Texture.EMPTY;
    const c = new Container();
    const spr = new Sprite(tex);
    spr.anchor.set(0.5, 0.85);
    spr.scale.set(scale);
    c.addChild(spr);
    const p = iso(tile[0], tile[1]);
    c.position.set(p.x, p.y);
    c.zIndex = p.y;
    return c;
  }

  private placeFurniture(): void {
    for (const z of Object.keys(LAYOUT) as Zone[]) {
      const l = LAYOUT[z];
      if (l.furniture) this.things.addChild(this.sprite(l.furniture, l.at, z === "whiteboard" || z === "stage" ? 0.8 : 0.72));
    }
    this.things.addChild(this.sprite("plant", [0.6, 7.2], 0.7), this.sprite("plant", [15.3, 7.4], 0.7), this.sprite("lamp", [11.2, 11.4], 0.7), this.sprite("lamp", [0.8, 0.8], 0.7), this.sprite("sack", [10.9, 6.6], 0.6));
    const wb = iso(...LAYOUT.whiteboard.at);
    this.boardText.position.set(wb.x - 52, wb.y - 76);
    this.boardText.zIndex = wb.y + 1;
    this.things.addChild(this.boardText);
    const br = iso(LAYOUT.break_room.rect[2] - 0.2, LAYOUT.break_room.rect[3] - 0.2);
    this.breakText.position.set(br.x - 60, br.y - 10);
    this.labels.addChild(this.breakText);
  }

  private zoneLabels(): void {
    if (!this.opts || this.labels.children.length > 1) return;
    for (const z of Object.keys(LAYOUT) as Zone[]) {
      const [i0, j0, , j1] = LAYOUT[z].rect;
      const p = iso(i0 + 0.15, (j0 + j1) / 2);
      const t = new Text({ text: this.opts.t(`office.zones.${z}`), style: { fontFamily: "Nunito, sans-serif", fontSize: 10, fill: 0x9a9aa8, fontWeight: "700" } });
      t.anchor.set(0, 0.5);
      t.position.set(p.x + 4, p.y);
      t.alpha = 0.8;
      this.labels.addChild(t);
    }
  }

  /** Fits the floor to the screen (or frames the focused room). */
  fitView(): void {
    const w = this.app.screen?.width ?? 0;
    const h = this.app.screen?.height ?? 0;
    if (!w || !h) return;
    let box = { x0: iso(0, FLOOR.rows).x, x1: iso(FLOOR.cols, 0).x, y0: -60, y1: iso(FLOOR.cols, FLOOR.rows).y };
    if (this.opts?.focus) {
      const [i0, j0, i1, j1] = LAYOUT[this.opts.focus].rect;
      box = { x0: iso(i0, j1).x - 20, x1: iso(i1, j0).x + 20, y0: iso(i0, j0).y - 90, y1: iso(i1, j1).y + 20 };
    }
    this.zoom = Math.min(w / (box.x1 - box.x0), h / (box.y1 - box.y0)) * 0.95;
    this.world.scale.set(this.zoom);
    this.world.position.set(w / 2 - ((box.x0 + box.x1) / 2) * this.zoom, h / 2 - ((box.y0 + box.y1) / 2) * this.zoom);
    this.night.clear();
    if (this.view) this.drawNight(this.view.dayPhase);
  }

  private drawNight(phase: OfficeView["dayPhase"]): void {
    const n = NIGHT[phase];
    this.night.clear();
    if (n.alpha > 0) this.night.rect(0, 0, this.app.screen.width, this.app.screen.height).fill({ color: n.color, alpha: n.alpha });
    this.glow.clear();
    if (phase === "night" || phase === "dusk") {
      for (const t of [
        [11.2, 11.4],
        [0.8, 0.8],
      ] as [number, number][]) {
        const p = iso(...t);
        this.glow.circle(p.x, p.y - 30, 70).fill({ color: 0xf2d58a, alpha: phase === "night" ? 0.12 : 0.06 });
      }
    }
  }

  /** Where an agent stands now, given everyone's zones. */
  private targetOf(a: OfficeAgent, state: OfficeState): { x: number; y: number } {
    const peers = Object.values(state.agents)
      .filter((x) => x.zone === a.zone)
      .sort((x, y) => x.order - y.order);
    const k = peers.findIndex((x) => x.id === a.id);
    const [i, j] = standTile(a.zone, a.order, Math.max(0, k));
    return iso(i, j);
  }

  /** Draws the office for a state at a moment. Cheap to call often. */
  update(state: OfficeState, view: OfficeView, opts: SceneOptions): void {
    if (this.destroyed) return;
    if (!this.ready) {
      this.queued = [state, view, opts];
      return;
    }
    const refocus = this.opts?.focus !== opts.focus;
    this.opts = opts;
    this.state = state;
    this.view = view;
    this.zoneLabels();
    if (refocus) this.fitView();
    this.drawNight(view.dayPhase);
    const now = Date.now();

    // Desks: one per agent.
    for (const a of Object.values(state.agents)) {
      if (!this.desks.has(a.order)) {
        const d = this.sprite("desk", deskTile(a.order), 0.6);
        this.desks.set(a.order, d);
        this.things.addChild(d);
      }
    }

    // Agents.
    const seen = new Set<string>();
    for (const va of view.agents) {
      seen.add(va.id);
      let actor = this.actors.get(va.id);
      const target = this.targetOf(va, state);
      if (!actor) {
        actor = new Actor(va.id, target);
        actor.sprite.on("pointerdown", (e) => this.onActorDown(va.id, e));
        this.actors.set(va.id, actor);
        this.things.addChild(actor.root);
      }
      if (!actor.dragging) actor.target = target;
      if (opts.reducedMotion && !actor.dragging) actor.pos = { ...target };
      const walking = !opts.reducedMotion && Math.hypot(actor.target.x - actor.pos.x, actor.target.y - actor.pos.y) > 2;
      const reaction = opts.calm ? null : va.reactionNow;
      const anim = animOf({ ...va, held: va.held || actor.dragging }, walking, reaction);
      const key = `${va.avatar.shape}/${va.avatar.color}/${anim}/${va.mood}`;
      if (actor.key !== key) {
        actor.key = key;
        actor.sprite.textures = agentTextures(va.avatar, anim, va.mood);
        actor.sprite.animationSpeed = FPS[anim] / 60;
        if (opts.reducedMotion || state.killSwitch) actor.sprite.gotoAndStop(0);
        else actor.sprite.play();
      }
      actor.label.text = va.name;
      actor.icon.text = state.killSwitch ? "🛑" : (STATUS_ICON[va.status] ?? "");
      this.drawBubble(actor, va, now);
    }
    for (const [id, actor] of this.actors) {
      if (!seen.has(id)) {
        actor.root.destroy({ children: true });
        this.actors.delete(id);
      }
    }

    this.drawLetters(state);
    this.drawPapers(state);
    this.drawBoards(state, view);
    this.drawCat(view, opts);
  }

  private drawBubble(actor: Actor, a: OfficeView["agents"][number], now: number): void {
    const o = this.opts!;
    const b = a.bubble;
    const fresh = b ? now - Date.parse(b.ts) < 120_000 : false;
    const show = b && o.bubbles !== "none" && (b.important || (o.bubbles === "all" && fresh && !o.calm));
    actor.bubble.visible = Boolean(show);
    if (!b || !show) return;
    const text = o.topicOnly ? o.t("office.about", { topic: b.topic }) : `${b.text}${b.count > 1 ? ` (+${b.count - 1})` : ""}`;
    if (actor.bubbleText.text !== text) actor.bubbleText.text = text;
    const w = Math.min(160, actor.bubbleText.width) + 14;
    const h = actor.bubbleText.height + 10;
    actor.bubbleBg.clear();
    actor.bubbleBg
      .roundRect(-w / 2, -h, w, h, 8)
      .fill({ color: b.important ? 0xfff1c7 : 0xfbf7f0 })
      .stroke({ color: b.important ? 0xff6b8b : 0x3a3048, width: 1.5 });
    actor.bubbleBg.poly([-5, 0, 5, 0, 0, 7]).fill({ color: b.important ? 0xfff1c7 : 0xfbf7f0 });
    actor.bubbleText.position.set(-w / 2 + 7, -h + 5);
    actor.bubble.position.set(0, -92);
  }

  private letterTarget(l: OfficeState["letters"][string], state: OfficeState): { x: number; y: number } {
    if (l.at === "desk" && l.to && state.agents[l.to]) {
      const [i, j] = deskTile(state.agents[l.to]!.order);
      const p = iso(i + 0.1, j + 0.1);
      return { x: p.x, y: p.y - 26 };
    }
    const zone = l.at === "post_box" ? "post_box" : "mail_desk";
    const p = iso(...LAYOUT[zone].at);
    return { x: p.x + (l.at === "inbox" ? 10 : 0), y: p.y - 34 };
  }

  private drawLetters(state: OfficeState): void {
    const visible = Object.values(state.letters).filter((l) => ["new", "routed", "needs_human"].includes(l.status) || l.eventId >= state.lastEventId - 30);
    const ids = new Set(visible.map((l) => l.id));
    for (const l of visible) {
      let item = this.letters.get(l.id);
      const target = this.letterTarget(l, state);
      if (!item) {
        const g = new Graphics();
        g.rect(-7, -5, 14, 10).fill({ color: 0xfff7ec }).stroke({ color: 0xc9b79c, width: 1.5 });
        g.poly([-7, -5, 0, 1, 7, -5]).stroke({ color: 0xc9b79c, width: 1.5 });
        if (l.type === "urgent") g.circle(6, -5, 3).fill({ color: 0xff6b8b });
        // New letters start at the post box (replies at the mail desk) and travel to their stop.
        const start = this.letterTarget({ ...l, at: l.path[0] ?? "post_box" }, state);
        item = { g, pos: this.opts?.reducedMotion ? target : start, target, to: l.to, draggable: false };
        g.eventMode = "static";
        g.on("pointerdown", (e) => {
          if (!item?.draggable) return;
          e.stopPropagation();
          this.letterDrag = { id: l.id, g };
        });
        this.letters.set(l.id, item);
        this.fx.addChild(g);
      }
      item.target = target;
      item.to = l.to;
      item.draggable = l.at === "inbox";
      item.g.cursor = item.draggable ? "grab" : "default";
      if (this.opts?.reducedMotion) item.pos = { ...target };
    }
    for (const [id, item] of this.letters) {
      if (!ids.has(id)) {
        item.g.destroy();
        this.letters.delete(id);
      }
    }
  }

  private drawPapers(state: OfficeState): void {
    const g = this.papers;
    g.clear();
    const bin = iso(...LAYOUT.idea_bin.at);
    state.papers.slice(-10).forEach((_, k) => {
      const a = k * 2.1;
      const r = 14 + (k % 3) * 6;
      g.circle(bin.x + Math.cos(a) * r, bin.y + 8 + Math.sin(a) * r * 0.5, 4 + (k % 2)).fill({ color: 0xf3e3c3 }).stroke({ color: 0xa5844f, width: 1 });
    });
  }

  private drawBoards(state: OfficeState, view: OfficeView): void {
    const o = this.opts!;
    const icon = (s: string) => (s === "done" ? "✓" : s === "failed" || s === "blocked" ? "✗" : s === "killed" ? "■" : "…");
    this.boardText.text = state.board
      .slice(-5)
      .map((t) => `${icon(t.status)} ${(state.agents[t.agentId]?.name ?? "?").slice(0, 8)}: ${t.goal.slice(0, 18)}`)
      .join("\n");
    this.breakText.text = view.breakRoom.length
      ? [o.t("office.breakBoard"), ...view.breakRoom.map((r) => `${r.name}: ${r.why}${r.wakeAt ? ` · ${o.t("office.backAt", { time: new Date(r.wakeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}` : ""}`)].join("\n")
      : "";
  }

  private drawCat(view: OfficeView, opts: SceneOptions): void {
    if (opts.calm) {
      if (this.cat) this.cat.visible = false;
      return;
    }
    if (!this.cat) {
      this.cat = new AnimatedSprite([Texture.EMPTY]);
      this.cat.anchor.set(0.5, 28 / H);
      this.cat.scale.set(SCALE);
      this.things.addChild(this.cat);
    }
    this.cat.visible = true;
    if (this.catMood !== view.pet.mood) {
      this.catMood = view.pet.mood;
      this.cat.textures = texturesOf(`cat/${view.pet.mood}`, () => catFrames(view.pet.mood));
      this.cat.animationSpeed = (view.pet.mood === "napping" ? 1.5 : 2) / 60;
      if (opts.reducedMotion) this.cat.gotoAndStop(0);
      else this.cat.play();
    }
    const [, j0, i1, j1] = LAYOUT[view.pet.zone].rect;
    const p = iso(i1 - 0.7, (j0 + j1) / 2 + 0.6);
    this.cat.position.set(p.x, p.y);
    this.cat.zIndex = p.y;
  }

  // ---------- animation ----------

  private tick(dt: number): void {
    const step = (SPEED * dt) / 1000;
    for (const actor of this.actors.values()) {
      if (!actor.dragging) {
        const dx = actor.target.x - actor.pos.x;
        const dy = actor.target.y - actor.pos.y;
        const d = Math.hypot(dx, dy);
        if (d > step) {
          actor.pos.x += (dx / d) * step;
          actor.pos.y += (dy / d) * step;
          actor.sprite.scale.x = (dx < 0 ? -1 : 1) * SCALE;
        } else if (d > 0) {
          actor.pos = { ...actor.target };
          // Arrived: let the next update pick the resting animation.
          if (this.state && this.view && this.opts) this.update(this.state, this.view, this.opts);
        }
      }
      actor.root.position.set(actor.pos.x, actor.pos.y);
      actor.root.zIndex = actor.pos.y + (actor.dragging ? 10_000 : 0);
    }
    for (const item of this.letters.values()) {
      if (this.letterDrag?.g === item.g) continue;
      const dx = item.target.x - item.pos.x;
      const dy = item.target.y - item.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > step * 1.3) {
        item.pos.x += (dx / d) * step * 1.3;
        item.pos.y += (dy / d) * step * 1.3;
      } else item.pos = { ...item.target };
      item.g.position.set(item.pos.x, item.pos.y + (this.opts?.reducedMotion ? 0 : Math.sin(performance.now() / 300) * 1.5));
    }
  }

  // ---------- gestures ----------

  private toWorld(e: FederatedPointerEvent): { x: number; y: number } {
    const p = this.world.toLocal(e.global);
    return { x: p.x, y: p.y };
  }

  private onActorDown(id: string, e: FederatedPointerEvent): void {
    e.stopPropagation();
    const timer = window.setTimeout(() => {
      if (this.press && !this.press.moved && this.press.id === id) {
        this.cb.menu(id, e.clientX, e.clientY);
        this.press = null;
      }
    }, LONG_PRESS_MS);
    this.press = { id, x: e.global.x, y: e.global.y, t: performance.now(), moved: false, lifted: false, timer, lastDx: 0, turns: 0, turnT: performance.now(), shaken: false };
  }

  private onStageDown(e: FederatedPointerEvent): void {
    this.pinch.set(e.pointerId, { x: e.global.x, y: e.global.y });
    if (this.pinch.size === 2) {
      const [a, b] = [...this.pinch.values()];
      this.pinchStart = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: this.zoom };
      this.pan = null;
      return;
    }
    if (!this.press && !this.letterDrag) this.pan = { x: e.global.x, y: e.global.y, wx: this.world.x, wy: this.world.y };
  }

  private onMove(e: FederatedPointerEvent): void {
    if (this.pinch.has(e.pointerId)) this.pinch.set(e.pointerId, { x: e.global.x, y: e.global.y });
    if (this.pinchStart && this.pinch.size === 2) {
      const [a, b] = [...this.pinch.values()];
      this.zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, (this.pinchStart.zoom * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / this.pinchStart.d);
      return;
    }
    if (this.letterDrag) {
      const p = this.toWorld(e);
      this.letterDrag.g.position.set(p.x, p.y);
      return;
    }
    const press = this.press;
    if (press) {
      const dx = e.global.x - press.x;
      const dy = e.global.y - press.y;
      if (!press.moved && Math.hypot(dx, dy) > 6) {
        press.moved = true;
        window.clearTimeout(press.timer);
      }
      if (press.moved && !press.lifted) {
        press.lifted = true;
        const actor = this.actors.get(press.id);
        if (actor) actor.dragging = true;
        this.cb.lift(press.id);
        if (this.state && this.view && this.opts) this.update(this.state, this.view, this.opts);
      }
      if (press.lifted) {
        const actor = this.actors.get(press.id);
        const p = this.toWorld(e);
        if (actor) actor.pos = { x: p.x, y: p.y + 30 };
        // Shaking: the pointer turns back and forth quickly while holding the agent.
        const mx = e.movementX ?? 0;
        const now = performance.now();
        if (Math.abs(mx) > 3) {
          if (press.lastDx !== 0 && Math.sign(mx) !== Math.sign(press.lastDx)) {
            if (now - press.turnT > 900) press.turns = 0;
            press.turns += 1;
            press.turnT = now;
          }
          press.lastDx = mx;
        }
        if (press.turns >= 4 && !press.shaken) {
          press.shaken = true;
          this.cb.shake(press.id);
        }
      }
      return;
    }
    if (this.pan) this.world.position.set(this.pan.wx + e.global.x - this.pan.x, this.pan.wy + e.global.y - this.pan.y);
  }

  private onUp(e: FederatedPointerEvent): void {
    this.pinch.delete(e.pointerId);
    if (this.pinch.size < 2) this.pinchStart = null;
    if (this.letterDrag) {
      const drag = this.letterDrag;
      this.letterDrag = null;
      const hit = this.agentAt(e.global.x, e.global.y);
      if (hit) this.cb.assignLetter(drag.id, hit);
      return;
    }
    const press = this.press;
    this.press = null;
    this.pan = null;
    if (!press) return;
    window.clearTimeout(press.timer);
    if (press.lifted) {
      const actor = this.actors.get(press.id);
      const p = this.toWorld(e);
      const zone = zoneAtWorld(p.x, p.y + 20) ?? "desk";
      if (actor) actor.dragging = false;
      this.cb.drop(press.id, zone);
      return;
    }
    if (!press.moved) {
      const now = performance.now();
      if (this.lastClick && this.lastClick.id === press.id && now - this.lastClick.t < DOUBLE_CLICK_MS) {
        this.lastClick = null;
        this.cb.openChat(press.id);
      } else {
        this.lastClick = { id: press.id, t: now };
        this.cb.poke(press.id, e.clientX, e.clientY);
      }
    }
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.app.canvas.getBoundingClientRect();
    this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  };

  private zoomAt(sx: number, sy: number, zoom: number): void {
    const z = Math.min(4, Math.max(0.3, zoom));
    const wx = (sx - this.world.x) / this.zoom;
    const wy = (sy - this.world.y) / this.zoom;
    this.zoom = z;
    this.world.scale.set(z);
    this.world.position.set(sx - wx * z, sy - wy * z);
  }

  private agentAt(sx: number, sy: number): string | null {
    for (const [id, actor] of this.actors) {
      const b = actor.sprite.getBounds();
      if (sx >= b.x && sx <= b.x + b.width && sy >= b.y && sy <= b.y + b.height) return id;
    }
    return null;
  }

  // ---------- test hook helpers (client coordinates) ----------

  private client(x: number, y: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    return { x: rect.left + x, y: rect.top + y };
  }

  /** The middle of an agent's body on screen. */
  screenOf(agentId: string): { x: number; y: number } | null {
    const actor = this.actors.get(agentId);
    if (!actor) return null;
    const b = actor.sprite.getBounds();
    return this.client(b.x + b.width / 2, b.y + b.height * 0.55);
  }

  letterScreenOf(letterId: string): { x: number; y: number } | null {
    const item = this.letters.get(letterId);
    if (!item) return null;
    const p = this.world.toGlobal(item.target);
    return this.client(p.x, p.y);
  }

  zoneScreenOf(zone: Zone): { x: number; y: number } {
    const [i0, j0, i1, j1] = LAYOUT[zone].rect;
    const p = this.world.toGlobal(iso((i0 + i1) / 2, (j0 + j1) / 2));
    return this.client(p.x, p.y);
  }

  /** True when every agent has reached where it is going. */
  settled(): boolean {
    return [...this.actors.values()].every((a) => a.dragging || Math.hypot(a.target.x - a.pos.x, a.target.y - a.pos.y) < 1);
  }
}
