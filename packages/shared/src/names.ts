/**
 * Rules for agent names, used when an agent picks its own name and when a human renames it:
 * 2 to 12 characters, unique in the workspace (checked by the server), and not a brand, a real
 * person, a well-known character, or an offensive word.
 */
const BRANDS = [
  "google", "alphabet", "apple", "amazon", "alexa", "microsoft", "cortana", "copilot", "openai", "chatgpt", "gpt",
  "anthropic", "claude", "gemini", "bard", "meta", "facebook", "instagram", "whatsapp", "tiktok", "twitter", "xai",
  "grok", "siri", "tesla", "nvidia", "intel", "samsung", "netflix", "disney", "pixar", "marvel", "nike", "adidas",
  "cocacola", "pepsi", "mcdonalds", "starbucks", "shopify", "mercadolivre", "mercadopago", "nubank", "itau", "paypal",
  "stripe", "uber", "airbnb", "spotify", "youtube", "linkedin", "reddit", "slack", "zoom", "oracle", "ibm", "watson",
  "mistral", "llama", "deepseek", "perplexity", "northbot",
];
const PEOPLE = [
  "elon", "musk", "obama", "trump", "biden", "lula", "bolsonaro", "putin", "zuckerberg", "bezos", "gates", "jobs",
  "einstein", "newton", "darwin", "tesla", "beyonce", "rihanna", "taylorswift", "swift", "madonna", "pele", "messi",
  "ronaldo", "neymar", "shakira", "oprah", "altman", "amodei", "hinton", "lecun", "jesus", "buddha", "muhammad",
];
const CHARACTERS = [
  "mickey", "minnie", "donald", "goofy", "pikachu", "pokemon", "mario", "luigi", "yoshi", "zelda", "sonic", "yoda",
  "vader", "skywalker", "gandalf", "frodo", "gollum", "sherlock", "batman", "superman", "spiderman", "ironman",
  "jarvis", "ultron", "thanos", "hulk", "elsa", "olaf", "shrek", "simba", "garfield", "snoopy", "barbie", "kermit",
  "elmo", "homer", "bart", "walle", "eve", "r2d2", "c3po", "hal9000", "skynet", "terminator", "optimus", "bumblebee",
  "totoro", "kirby", "doraemon", "naruto", "goku", "harrypotter", "hermione", "dumbledore", "voldemort", "mulan",
];
const OFFENSIVE = [
  "fuck", "shit", "bitch", "cunt", "dick", "cock", "pussy", "asshole", "bastard", "slut", "whore", "nigger", "nigga",
  "faggot", "retard", "nazi", "hitler", "rape", "porn", "sex", "caralho", "porra", "merda", "puta", "buceta", "viado",
  "cacete", "mierda", "pendejo", "coño", "joder", "cabron", "kill", "suicide", "terror",
];

/** Short entries only match a whole word; longer ones match anywhere inside the name. */
const BLOCKED = [...BRANDS, ...PEOPLE, ...CHARACTERS, ...OFFENSIVE];

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/0/g, "o")
    .replace(/1/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/[@]/g, "a")
    .replace(/[$]/g, "s");

export type NameProblem = "length" | "characters" | "blocked" | "taken";

export interface NameCheck {
  ok: boolean;
  problem?: NameProblem;
  /** For "blocked": the word that matched (shown to the human, never to other agents). */
  match?: string;
}

/** Checks everything except uniqueness, which needs the database. */
export function checkAgentName(raw: string): NameCheck {
  const name = raw.trim();
  if ([...name].length < 2 || [...name].length > 12) return { ok: false, problem: "length" };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u.test(name)) return { ok: false, problem: "characters" };
  const norm = normalize(name);
  const squashed = norm.replace(/[^a-z0-9]/g, "");
  const words = norm.split(/[^a-z0-9]+/).filter(Boolean);
  for (const b of BLOCKED) {
    if (b.length <= 4 ? words.includes(b) || squashed === b : squashed.includes(b)) return { ok: false, problem: "blocked", match: b };
  }
  return { ok: true };
}
