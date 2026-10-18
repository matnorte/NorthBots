import { AnimatedSprite, Application, Container, Graphics, Text, Texture, type FederatedPointerEvent } from "pixi.js";
import type { Avatar, OfficeAgent, OfficeState, OfficeView, Zone } from "@northbot/shared";
import { buildDecor, buildPartitions, drawWindows, glowSprite, makeDesk, WALL_H, windowGlows, type Decor, type Glow } from "./decor.js";
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
const NIGHT: Record<OfficeView["dayPhase"], { color: number; alpha: number; light: number }> = {
  dawn: { color: 0xff9eb5, alpha: 0.08, light: 0.6 },
  day: { color: 0x000000, alpha: 0, light: 0 },
  dusk: { color: 0xff8a3d, alpha: 0.14, light: 0.75 },
  night: { color: 0x0a1030, alpha: 0.42, light: 1 },
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
    // The name floats above the head (like a game character), so desks never hide it.
    this.label = new Text({ text: "", style: { fontFamily: "Nunito, sans-serif", fontSize: 12, fill: 0xffd9a0, fontWeight: "800", stroke: { color: 0x1a1218, width: 4 } } });
    this.label.anchor.set(0.5, 1);
    this.label.y = -66;
    this.icon = new Text({ text: "", style: { fontSize: 14 } });
    this.icon.anchor.set(0.5, 1);
    this.icon.position.set(30, -50);
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
  private floor = new Container();
  private labels = new Container();
  private things = new Container();
  private fx = new Container();
  private night = new Graphics();
  private glow = new Container();
  private papers = new Graphics();
  private windows = new Graphics();
  private signs = new Container();
  private breakText = new Text({ text: "", style: { fontFamily: "Nunito, sans-serif", fontSize: 11, fill: 0xf4ecdf, lineHeight: 14, fontWeight: "700", stroke: { color: 0x120d14, width: 3 } } });
  private decor: Decor | null = null;
  private deskGlows: Glow[] = [];
  private phase: OfficeView["dayPhase"] | null = null;
  private desks = new Map<number, Container>();
  private actors = new Map<string, Actor>();
  private letters = new Map<string, { g: Graphics; pos: { x: number; y: number }; target: { x: number; y: number }; to: string | null; draggable: boolean }>();
  private cat: AnimatedSprite | null = null;
  private catMood = "";
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
    await this.app.init({ resizeTo: host, background: 0x140e16, antialias: true, autoDensity: true, resolution: Math.min(window.devicePixelRatio || 1, 2) });
    this.initialized = true;
    if (this.destroyed) {
      this.app.destroy(true, { children: true });
      return;
    }
    host.appendChild(this.app.canvas);
    this.app.canvas.style.touchAction = "none";
    this.things.sortableChildren = true;
    // The night tint sits under the lights, so lamps and screens glow through the dark.
    this.world.addChild(this.floor, this.windows, this.labels, this.papers, this.things, this.night, this.glow, this.signs, this.fx);
    this.app.stage.addChild(this.world);
    this.buildOffice();
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

  /** Floor, walls, rugs and furniture: drawn once. */
  private buildOffice(): void {
    const d = buildDecor();
    this.decor = d;
    this.floor.addChild(d.floor);
    this.floor.addChild(d.clock, d.calendar, d.tv);
    for (const c of [...d.items, ...buildPartitions()]) this.things.addChild(c);
    // Who is resting, written beside the break room's outer edge.
    const br = iso(LAYOUT.break_room.rect[2] + 0.35, LAYOUT.break_room.rect[1] + 3.2);
    this.breakText.anchor.set(0, 0.5);
    this.breakText.position.set(br.x, br.y);
    this.labels.addChild(this.breakText);
  }

  /** A small sign on the floor at each room's front edge (made once the translations arrive). */
  private zoneLabels(): void {
    if (!this.opts || this.signs.children.length > 0) return;
    for (const z of Object.keys(LAYOUT) as Zone[]) {
      if (z === "idea_bin" || z === "post_box") continue;
      const [i0, , i1, j1] = LAYOUT[z].rect;
      // Walled rooms hang their sign above the front half-wall (the open office over its door);
      // the vault's front is behind the whiteboard, so its sign sits on the floor's outer edge.
      const over = (i: number, j: number) => ({ x: iso(i, j).x, y: iso(i, j).y - 34 });
      const SPOT: Partial<Record<Zone, { x: number; y: number }>> = {
        desk: over(4, 6),
        browser_lab: over(11, 4),
        vault: iso(15.6, 2.7),
        mail_desk: iso(11, j1 - 0.3),
      };
      const p = SPOT[z] ?? iso((i0 + i1) / 2, j1 - 0.3);
      const name = z === "mail_desk" ? this.opts.t("office.zones.post_box") : this.opts.t(`office.zones.${z}`);
      const t = new Text({ text: name.toUpperCase(), style: { fontFamily: "Nunito, sans-serif", fontSize: 9, fill: 0xf4ecdf, fontWeight: "800", letterSpacing: 1 } });
      t.anchor.set(0.5);
      const bg = new Graphics().roundRect(-t.width / 2 - 7, -t.height / 2 - 3, t.width + 14, t.height + 6, 6).fill({ color: 0x1a1218, alpha: 0.72 }).stroke({ color: 0xd6a35c, width: 1, alpha: 0.6 });
      const sign = new Container();
      sign.addChild(bg, t);
      sign.position.set(p.x, p.y);
      this.signs.addChild(sign);
    }
  }

  /** Fits the floor to the screen (or frames the focused room). */
  fitView(): void {
    const w = this.app.screen?.width ?? 0;
    const h = this.app.screen?.height ?? 0;
    if (!w || !h) return;
    let box = { x0: iso(0, FLOOR.rows).x - 10, x1: iso(FLOOR.cols, 0).x + 10, y0: -WALL_H - 10, y1: iso(FLOOR.cols, FLOOR.rows).y + 26 };
    if (this.opts?.focus) {
      const [i0, j0, i1, j1] = LAYOUT[this.opts.focus].rect;
      box = { x0: iso(i0, j1).x - 20, x1: iso(i1, j0).x + 20, y0: iso(i0, j0).y - 100, y1: iso(i1, j1).y + 20 };
    }
    this.zoom = Math.min(w / (box.x1 - box.x0), h / (box.y1 - box.y0)) * 0.97;
    this.world.scale.set(this.zoom);
    this.world.position.set(w / 2 - ((box.x0 + box.x1) / 2) * this.zoom, h / 2 - ((box.y0 + box.y1) / 2) * this.zoom);
  }

  /** Time-of-day tint, the sky in the windows, and every light (lamps, screens, windows). */
  private drawNight(phase: OfficeView["dayPhase"]): void {
    if (this.phase === phase) return;
    this.phase = phase;
    const n = NIGHT[phase];
    this.night.clear();
    if (n.alpha > 0) {
      const x0 = iso(0, FLOOR.rows).x - 2000;
      const x1 = iso(FLOOR.cols, 0).x + 2000;
      this.night.rect(x0, -WALL_H - 2000, x1 - x0, iso(FLOOR.cols, FLOOR.rows).y + WALL_H + 4000).fill({ color: n.color, alpha: n.alpha });
    }
    drawWindows(this.windows, phase);
    this.drawLights();
  }

  private drawLights(): void {
    if (!this.phase || !this.decor) return;
    const light = NIGHT[this.phase].light;
    for (const old of this.glow.removeChildren()) old.destroy();
    for (const l of [...this.decor.glows, ...this.deskGlows, ...windowGlows(this.phase)]) this.glow.addChild(glowSprite(l, Math.max(l.day, light)));
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
        const d = makeDesk(a.order);
        this.desks.set(a.order, d.desk);
        this.things.addChild(d.desk, d.chair);
        this.deskGlows.push(d.glow);
        this.drawLights();
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
      actor.icon.text = state.killSwitch ? "🛑" : `${STATUS_ICON[va.status] ?? ""}${va.wakeAt ? " ⏰" : ""}`;
      if (va.wakeAt && !va.bubble) actor.label.text += ` · ${opts.t("office.backAt", { time: new Date(va.wakeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}`;
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
    actor.bubble.position.set(0, -86);
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
    const d = this.decor;
    if (!d) return;
    d.clock.text = view.clock.slice(-5);
    d.calendar.text = [o.t("schedules.title"), ...view.calendar.slice(0, 3).map((r) => r.name.slice(0, 16))].join("\n");
    const icon = (s: string) => (s === "done" ? "✓" : s === "failed" || s === "blocked" ? "✗" : s === "killed" ? "■" : "…");
    d.board.text = state.board
      .slice(-5)
      .map((t) => `${icon(t.status)} ${(state.agents[t.agentId]?.name ?? "?").slice(0, 7)}: ${t.goal.slice(0, 12)}`)
      .join("\n");
    const agents = Object.values(state.agents);
    const busy = agents.filter((a) => a.activity === "typing" || a.activity === "browsing").length;
    const done = state.board.filter((t) => t.status === "done").length;
    d.tv.text = [`AGENTS ${agents.length}`, `BUSY   ${busy}`, `DONE   ${done}`, `MAIL   ${Object.keys(state.letters).length}`].join("\n");
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
    if (this.decor && !this.opts?.reducedMotion) {
      const t = performance.now() / 1000;
      this.decor.leds.forEach((g, k) => (g.alpha = 0.55 + 0.45 * Math.round((Math.sin(t * (3 + k * 1.7)) + 1) / 2)));
    }
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
