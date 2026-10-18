import type { ChatMessage } from "./types.js";

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

interface Rule {
  label: string;
  re: RegExp;
  accept?: (match: string) => boolean;
}

// Order matters: the more specific number formats run before the generic phone rule.
const RULES: Rule[] = [
  { label: "EMAIL", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { label: "CNPJ", re: /\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g },
  { label: "CPF", re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g },
  {
    label: "CARD",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (m) => luhn(m.replace(/\D/g, "")),
  },
  // Needs a "-" or "." before the last 4 digits, so plain digit groups (order ids) are left alone.
  {
    label: "PHONE",
    re: /(?<![\w])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,3}\)|\d{2,3})[ .-]?\d{4,5}[-.]\d{4}\b/g,
  },
];

/**
 * Replaces PII with stable placeholders like `[EMAIL_1]` before a cloud call and puts the
 * originals back in the reply. One Redactor per call keeps numbering consistent across messages.
 */
export class Redactor {
  private byValue = new Map<string, string>();
  private byToken = new Map<string, string>();
  private counts = new Map<string, number>();

  redactText(text: string): string {
    let out = text;
    for (const rule of RULES) {
      out = out.replace(rule.re, (m) => {
        if (rule.accept && !rule.accept(m)) return m;
        let token = this.byValue.get(m);
        if (!token) {
          const n = (this.counts.get(rule.label) ?? 0) + 1;
          this.counts.set(rule.label, n);
          token = `[${rule.label}_${n}]`;
          this.byValue.set(m, token);
          this.byToken.set(token, m);
        }
        return token;
      });
    }
    return out;
  }

  redactMessages(messages: ChatMessage[]): ChatMessage[] {
    // Raw provider turns are dropped when redacting: they hold unredacted text.
    return messages.map((m) =>
      m.role === "assistant"
        ? { role: "assistant", content: this.redactText(m.content), toolCalls: m.toolCalls }
        : { ...m, content: this.redactText(m.content) },
    );
  }

  restore(text: string): string {
    return text.replace(/\[(EMAIL|CNPJ|CPF|CARD|PHONE)_\d+\]/g, (t) => this.byToken.get(t) ?? t);
  }

  get count(): number {
    return this.byToken.size;
  }
}

/** Restores placeholders in a stream, holding back a possibly split `[TOKEN_n]` at a chunk end. */
export class StreamRestorer {
  private carry = "";
  constructor(private readonly r: Redactor) {}

  push(chunk: string): string {
    const text = this.carry + chunk;
    const open = text.lastIndexOf("[");
    if (open !== -1 && !text.includes("]", open) && text.length - open <= 24) {
      this.carry = text.slice(open);
      return this.r.restore(text.slice(0, open));
    }
    this.carry = "";
    return this.r.restore(text);
  }

  flush(): string {
    const rest = this.r.restore(this.carry);
    this.carry = "";
    return rest;
  }
}
