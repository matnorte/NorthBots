import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api.js";

interface Note {
  id: string;
  body: string;
  read: boolean;
}

/** A small bell with the agents' notes. Quiet hours are handled by the server. */
export function Notifications() {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<Note[]>([]);
  const [open, setOpen] = useState(false);

  const load = async () => setNotes((await api<{ notifications: Note[] }>("GET", "/notifications")).notifications);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, []);

  const unread = notes.filter((n) => !n.read);
  const markRead = async () => {
    await Promise.all(unread.map((n) => api("POST", `/notifications/${n.id}/read`).catch(() => {})));
    await load();
  };

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={t("notes.label", { count: unread.length })}
        onClick={() => {
          setOpen(!open);
          if (!open) void markRead();
        }}
        className="rounded-blob bg-butter px-3 py-1 text-sm font-bold text-ink shadow-soft"
      >
        {t("notes.button")} {unread.length > 0 && <span className="rounded-full bg-rainbow px-2">{unread.length}</span>}
      </button>
      {open && (
        <ul className="absolute right-0 z-10 mt-2 w-72 rounded-blob bg-panel p-3 text-ink shadow-soft">
          {notes.length === 0 && <li>{t("notes.empty")}</li>}
          {notes.map((n) => (
            <li key={n.id} className="border-b border-cream py-2 text-sm last:border-0">
              {n.body}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
